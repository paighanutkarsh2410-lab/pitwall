"""A projector folds a stream of events into state and publishes snapshots of it.

The timing board and the strategy model are both projectors. They never commit offsets: on
start-up they read their topics from the beginning and rebuild their state from the log, so a
restarted pod (or a new canary) catches up on the race so far before publishing anything.
"""

from __future__ import annotations

import logging
import time
from typing import Protocol

from pitwall import bus, observe, tracing
from pitwall.services import Health, faults_of

log = logging.getLogger("pitwall.projector")


class Model(Protocol):
    run: str | None

    def apply(self, event: dict, run: str | None = None) -> bool: ...

    def snapshot(self) -> dict: ...


async def project(
    health: Health,
    model: Model,
    *,
    group: str,
    sources: tuple[str, ...],
    target: str,
    key: bytes,
    every: float,
) -> None:
    await bus.ensure_topics()
    consumer = bus.consumer(
        *sources, group=group, auto_offset_reset="earliest", enable_auto_commit=False
    )
    producer = bus.producer()
    # No committed offsets plus "earliest": every start reads the retained log from the top.
    await consumer.start()
    await producer.start()
    health.ready, health.detail = True, f"projecting {', '.join(sources)} into {target}"
    log.info("%s: %s", group, health.detail)
    dirty, last_sent, last_lag = False, 0.0, 0.0
    oldest: int | None = None  # send time of the oldest event not yet in a published snapshot
    faults = faults_of(group)
    try:
        while True:
            batches = await consumer.getmany(timeout_ms=100, max_records=5000)
            if batches:
                await faults.pause()
            for messages in batches.values():
                for message in messages:
                    event = bus.decode(message.value)
                    with tracing.span_from(message.headers, f"{group}.apply", event):
                        applied = model.apply(event, bus.run_of(message.headers))
                    if applied:
                        dirty = True
                        health.count("events")
                        observe.EVENTS.labels(group, event["type"], "applied").inc()
                        sent = observe.sent_of(message.headers)
                        if sent is not None and (oldest is None or sent < oldest):
                            oldest = sent
                    else:
                        health.count("stale")
                        observe.EVENTS.labels(group, event["type"], "stale").inc()
            now = time.monotonic()
            if dirty and now - last_sent >= every:
                headers = [(bus.RUN_HEADER, (model.run or "").encode()), observe.sent_header()]
                await producer.send(target, bus.encode(model.snapshot()), key=key, headers=headers)
                health.count("snapshots")
                observe.SNAPSHOTS.labels(group).inc()
                # How old the oldest event in this snapshot was when the snapshot went out.
                age = observe.age_seconds(oldest)
                if age is not None:
                    observe.FRESHNESS.labels(group).observe(age)
                dirty, last_sent, oldest = False, now, None
            if now - last_lag > 2:
                for topic, lag in (await bus.lag_by_topic(consumer)).items():
                    observe.CONSUMER_LAG.labels(group, topic).set(lag)
                last_lag = now
    finally:
        await consumer.stop()
        await producer.stop()
