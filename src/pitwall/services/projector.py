"""A projector folds a stream of events into state and publishes snapshots of it.

The timing board and the strategy model are both projectors. They never commit offsets: on
start-up they read their topics from the beginning and rebuild their state from the log, so a
restarted pod (or a new canary) catches up on the race so far before publishing anything.
"""

from __future__ import annotations

import logging
import time
from typing import Protocol

from pitwall import bus
from pitwall.services import Health

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
    dirty, last_sent = False, 0.0
    try:
        while True:
            batches = await consumer.getmany(timeout_ms=100, max_records=5000)
            for messages in batches.values():
                for message in messages:
                    if model.apply(bus.decode(message.value), bus.run_of(message.headers)):
                        dirty = True
                        health.count("events")
                    else:
                        health.count("stale")
            now = time.monotonic()
            if dirty and now - last_sent >= every:
                headers = [(bus.RUN_HEADER, (model.run or "").encode())]
                await producer.send(target, bus.encode(model.snapshot()), key=key, headers=headers)
                health.count("snapshots")
                dirty, last_sent = False, now
    finally:
        await consumer.stop()
        await producer.stop()
