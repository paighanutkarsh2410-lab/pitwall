"""ingest: the front door. Checks every raw event against the schema, routes it to its topic,
and records telemetry and laps in TimescaleDB.

An event that breaks the contract goes to pitwall.deadletter with the reason, so one bad event
never stops the race for everyone else.
"""

from __future__ import annotations

import asyncio
import logging
import time

from aiokafka import ConsumerRebalanceListener
from pydantic import ValidationError

from pitwall import bus, history, observe, tracing
from pitwall.delivery import Deduplicator, keyseq_of
from pitwall.events import validate
from pitwall.services import Health, faults_of, service_app

log = logging.getLogger("pitwall.ingest")


class ForgetOnRebalance(ConsumerRebalanceListener):
    def __init__(self, dedupe: Deduplicator) -> None:
        self.dedupe = dedupe

    async def on_partitions_revoked(self, revoked) -> None:
        self.dedupe.forget()

    async def on_partitions_assigned(self, assigned) -> None:
        self.dedupe.forget()


def triage(event: dict) -> tuple[str, dict]:
    """Where an event goes, and what goes there: the event itself, or a dead-letter record."""
    try:
        validate(event)
    except ValidationError as error:
        problem = error.errors()[0]
        reason = f"{'.'.join(map(str, problem['loc']))}: {problem['msg']}"
        return bus.DEADLETTER, {"reason": reason, "event": event}
    return bus.route(event), event


async def work(health: Health) -> None:
    await bus.ensure_topics()
    recorder = None
    if history.dsn():
        pool = await history.wait_for_db()
        await history.migrate(pool)
        recorder = history.Recorder(pool)

    # Offsets are committed by hand, only as far as what was read has been sent on and stored
    # (see checkpoint below). Auto-commit every 5 s meant a crashed pod's successor re-read up
    # to 5 s of events and handed them on twice: the GameDay's SIGKILL found 1,251 duplicates.
    consumer = bus.consumer(group="ingest", auto_offset_reset="earliest", enable_auto_commit=False)
    dedupe = Deduplicator()
    # When partitions move between ingest pods (a canary joining, a restart), the cars they
    # carry were last seen by another pod: forget their numbers rather than call the jump a gap.
    consumer.subscribe([bus.RAW], listener=ForgetOnRebalance(dedupe))
    producer = bus.producer()
    await consumer.start()
    await producer.start()
    health.ready, health.detail = True, "consuming pitwall.raw"
    log.info("ingest is consuming %s (history: %s)", bus.RAW, "on" if recorder else "off")
    faults = faults_of("ingest")
    last_lag = last_commit = 0.0
    read: dict = {}  # partition -> the offset after the last message handled
    writer = asyncio.create_task(recorder.run()) if recorder else None
    try:
        while True:
            batches = await consumer.getmany(timeout_ms=250, max_records=2000)
            if batches:
                await faults.pause()
            for tp, messages in batches.items():
                read[tp] = messages[-1].offset + 1
                for message in messages:
                    verdict = dedupe.check(
                        bus.run_of(message.headers), message.key, keyseq_of(message.headers)
                    )
                    if verdict.missing:
                        observe.INGEST_MISSING.inc(verdict.missing)
                        log.error("%d events missing before key %s", verdict.missing, message.key)
                    if verdict.duplicate:
                        observe.INGEST_DUPLICATES.inc()
                        health.count("duplicates")
                        continue  # re-sent after an outage: already handled
                    observe.observe_freshness("ingest", message.headers)
                    event = bus.decode(message.value)
                    headers = list(message.headers)
                    with tracing.span_from(headers, "ingest.route", event) as span:
                        topic, value = triage(event)
                        if span is not None:
                            span.set_attribute("pitwall.topic", topic)
                            headers = tracing.inject(headers)
                        await producer.send(
                            topic, bus.encode(value), key=message.key, headers=headers
                        )
                    health.count("events")
                    if topic == bus.DEADLETTER:
                        health.count("deadlettered")
                        kind = str(event.get("type"))
                        observe.EVENTS.labels("ingest", kind, "deadlettered").inc()
                        log.warning("Dead-lettered seq %s: %s", event.get("seq"), value["reason"])
                    else:
                        observe.EVENTS.labels("ingest", event["type"], "routed").inc()
                        if recorder:
                            recorder.add(bus.run_of(message.headers) or "unknown", event)
            if recorder:
                if recorder.due() or (batches and not recorder.backlog()):
                    dropped = recorder.hand_off(read)
                    observe.HISTORY_DROPPED.inc(dropped)
                observe.HISTORY_BACKLOG.set(recorder.backlog())
            if time.monotonic() - last_commit >= COMMIT_EVERY:
                done = recorder.durable if recorder else read
                if done:
                    await checkpoint(consumer, producer, dict(done))
                    done.clear()
                last_commit = time.monotonic()
            if time.monotonic() - last_lag > 2:
                for topic, lag in (await bus.lag_by_topic(consumer)).items():
                    observe.CONSUMER_LAG.labels("ingest", topic).set(lag)
                last_lag = time.monotonic()
    finally:
        if writer:
            writer.cancel()
        await consumer.stop()
        await producer.stop()


COMMIT_EVERY = 0.5  # seconds: at most this much is read twice after a crash


async def checkpoint(consumer, producer, offsets: dict) -> None:
    """Commit ``offsets``: everything before them has reached its topic and, when recording,
    the database. A crash re-reads from the last checkpoint (at least once, never lost)."""
    from aiokafka.errors import CommitFailedError, IllegalStateError

    await producer.flush()
    owned = consumer.assignment()
    offsets = {tp: offset for tp, offset in offsets.items() if tp in owned}
    if not offsets:
        return
    try:
        await consumer.commit(offsets)
    except (CommitFailedError, IllegalStateError) as error:  # partitions moved meanwhile
        log.warning("Commit skipped: %s", error)


app = service_app("ingest", work)
