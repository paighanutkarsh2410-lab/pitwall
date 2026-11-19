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

    consumer = bus.consumer(group="ingest", auto_offset_reset="earliest")
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
    last_lag = 0.0
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
            if time.monotonic() - last_lag > 2:
                for topic, lag in (await bus.lag_by_topic(consumer)).items():
                    observe.CONSUMER_LAG.labels("ingest", topic).set(lag)
                last_lag = time.monotonic()
    finally:
        await consumer.stop()
        await producer.stop()


app = service_app("ingest", work)
