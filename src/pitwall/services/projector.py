"""A projector folds a stream of events into state and publishes snapshots of it.

The timing board and the strategy model are both projectors. Each copy reads every partition of
its topics itself, with no consumer group and no committed offsets: on start-up it reads the
retained log from the beginning, rebuilds the race so far, and only then starts publishing.

So any number of copies can run side by side, each with the whole board. That is what makes a
canary of a projector possible: the new version runs next to the old one, both publish, every
snapshot says which copy made it, and the boards can be compared car by car (pitwall-api does).
A copy reports ready only once it has caught up, so a new canary never shows a half-built board.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Protocol

from pitwall import bus, observe, tracing
from pitwall.delivery import Replays, keyseq_of
from pitwall.services import Health, faults_of

log = logging.getLogger("pitwall.projector")


class Model(Protocol):
    run: str | None

    def apply(self, event: dict, run: str | None = None) -> bool: ...

    def snapshot(self) -> dict: ...


def producer() -> dict:
    """Who made a snapshot: the pod's template hash (stable and canary differ) and version."""
    return {
        "id": os.environ.get("POD_TEMPLATE_HASH") or os.environ.get("HOSTNAME", "local"),
        "version": os.environ.get("PITWALL_VERSION", "dev"),
    }


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
    # No group: this copy reads every partition. "earliest": from the top of the retained log.
    consumer = bus.consumer(*sources, group=None, auto_offset_reset="earliest")
    producer_ = bus.producer()
    await consumer.start()
    await producer_.start()
    me = producer()
    health.ready, health.detail = False, "catching up on the log"
    log.info("%s (%s) is rebuilding from %s", group, me["id"], ", ".join(sources))
    caught_up = False
    dirty, last_sent, last_lag = False, 0.0, 0.0
    oldest: int | None = None  # send time of the oldest event not yet in a published snapshot
    # Rebuilding from the log replays history; only events sent since we started are "live" and
    # count towards freshness.
    started = observe.now_ms()
    faults = faults_of(group)
    replays = Replays()
    try:
        while True:
            batches = await consumer.getmany(timeout_ms=100, max_records=5000)
            if batches:
                await faults.pause()
            for messages in batches.values():
                for message in messages:
                    run = bus.run_of(message.headers)
                    if replays.seen(run, message.topic, message.key, keyseq_of(message.headers)):
                        health.count("replays")
                        observe.PROJECTOR_REPLAYS.labels(group).inc()
                        continue  # applied already: a pit stop must not count twice
                    event = bus.decode(message.value)
                    sent = observe.sent_of(message.headers)
                    live = sent is not None and sent >= started
                    # Trace live events only: re-reading the log after a restart would trace
                    # the same event again on every restart.
                    headers = message.headers if live else None
                    with tracing.span_from(headers, f"{group}.apply", event):
                        applied = model.apply(event, run)
                    if applied:
                        dirty = True
                        health.count("events")
                        observe.EVENTS.labels(group, event["type"], "applied").inc()
                        if live and (oldest is None or sent < oldest):
                            oldest = sent
                    else:
                        health.count("stale")
                        observe.EVENTS.labels(group, event["type"], "stale").inc()
            now = time.monotonic()
            if not caught_up:
                lags = await bus.lag_by_topic(consumer)
                if lags and set(lags) >= set(sources) and not any(lags.values()):
                    caught_up = True
                    health.ready, health.detail = True, f"publishing {target} as {me['id']}"
                    log.info("%s caught up; publishing %s", group, target)
            if caught_up and dirty and now - last_sent >= every:
                snapshot = {**model.snapshot(), "producer": me}
                headers = [(bus.RUN_HEADER, (model.run or "").encode()), observe.sent_header()]
                await producer_.send(target, bus.encode(snapshot), key=key, headers=headers)
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
        await producer_.stop()
