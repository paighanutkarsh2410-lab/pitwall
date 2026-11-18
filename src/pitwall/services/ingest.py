"""ingest: the front door. Checks every raw event against the schema, routes it to its topic,
and records telemetry and laps in TimescaleDB.

An event that breaks the contract goes to pitwall.deadletter with the reason, so one bad event
never stops the race for everyone else.
"""

from __future__ import annotations

import logging

from pydantic import ValidationError

from pitwall import bus, history
from pitwall.events import validate
from pitwall.services import Health, service_app

log = logging.getLogger("pitwall.ingest")


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

    consumer = bus.consumer(bus.RAW, group="ingest", auto_offset_reset="earliest")
    producer = bus.producer()
    await consumer.start()
    await producer.start()
    health.ready, health.detail = True, "consuming pitwall.raw"
    log.info("ingest is consuming %s (history: %s)", bus.RAW, "on" if recorder else "off")
    try:
        while True:
            batches = await consumer.getmany(timeout_ms=250, max_records=2000)
            for messages in batches.values():
                for message in messages:
                    event = bus.decode(message.value)
                    topic, value = triage(event)
                    await producer.send(
                        topic, bus.encode(value), key=message.key, headers=list(message.headers)
                    )
                    health.count("events")
                    if topic == bus.DEADLETTER:
                        health.count("deadlettered")
                        log.warning("Dead-lettered seq %s: %s", event.get("seq"), value["reason"])
                    elif recorder:
                        recorder.add(bus.run_of(message.headers) or "unknown", event)
            if recorder and recorder.due():
                health.count("recorded", await recorder.flush())
    finally:
        await consumer.stop()
        await producer.stop()


app = service_app("ingest", work)
