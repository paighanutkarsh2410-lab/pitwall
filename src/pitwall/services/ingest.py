"""ingest: the front door. Checks every raw event against the schema, routes it to its topic,
and records telemetry and laps in TimescaleDB.

An event that breaks the contract goes to pitwall.deadletter with the reason, so one bad event
never stops the race for everyone else.
"""

from __future__ import annotations

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

    # Offsets are committed by hand, only once what was read has been sent on and recorded (see
    # checkpoint below). Auto-commit every 5 s meant a crashed pod's successor re-read up to 5 s
    # of events and handed them on twice: the GameDay's SIGKILL found 1,251 duplicate rows.
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
    uncommitted = False
    try:
        while True:
            batches = await consumer.getmany(timeout_ms=250, max_records=2000)
            if batches:
                await faults.pause()
            for messages in batches.values():
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
            if recorder and recorder.due():
                with observe.HISTORY_WRITE.time():
                    written = await recorder.flush()
                observe.HISTORY_ROWS.inc(written)
                health.count("recorded", written)
            uncommitted = uncommitted or bool(batches)
            if (
                uncommitted
                and time.monotonic() - last_commit >= COMMIT_EVERY
                and (recorder is None or not recorder.pending())  # right after a flush
            ):
                await checkpoint(consumer, producer)
                uncommitted, last_commit = False, time.monotonic()
            if time.monotonic() - last_lag > 2:
                for topic, lag in (await bus.lag_by_topic(consumer)).items():
                    observe.CONSUMER_LAG.labels("ingest", topic).set(lag)
                last_lag = time.monotonic()
    finally:
        await consumer.stop()
        await producer.stop()


COMMIT_EVERY = 0.5  # seconds: at most this much is read twice after a crash


async def checkpoint(consumer, producer) -> None:
    """Commit what has been read, once every event read so far has reached its topic (and,
    when recording, the database). A crash before this re-reads from the last checkpoint."""
    from aiokafka.errors import CommitFailedError

    await producer.flush()
    try:
        await consumer.commit()
    except CommitFailedError as error:  # partitions moved meanwhile; the new owner re-reads
        log.warning("Commit skipped: %s", error)


app = service_app("ingest", work)
