"""Replays a race file as a live stream, at real speed or faster.

Each event is due at ``(t - start) / speed`` after the replay starts, measured on a monotonic
clock, so the pace stays right however long sending each event takes. Speed 0 sends everything as
fast as the sink takes it, which makes a repeatable load test.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Protocol

Emit = Callable[[dict], Awaitable[None]]

# Sent many times a second and only meaningful now: never part of a catch-up.
HIGH_RATE = frozenset({"car.telemetry", "car.position"})


class Clock(Protocol):
    def now(self) -> float: ...

    async def sleep(self, seconds: float) -> None: ...


class RealClock:
    def now(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


@dataclass
class Filter:
    """Which events to send. Types match by prefix: "car" means car.telemetry and car.position."""

    types: tuple[str, ...] = ()
    cars: frozenset[int] = frozenset()

    def __call__(self, event: dict) -> bool:
        if self.types and not any(
            event["type"] == t or event["type"].startswith(t + ".") for t in self.types
        ):
            return False
        return not (self.cars and event["car"] is not None and event["car"] not in self.cars)


class Pace:
    """A replay speed that can change while the replay runs (the pit wall's 1x / 10x buttons).

    The race clock stays continuous across a change: the replay carries on from the race time it
    had reached, at the new speed.
    """

    def __init__(self, speed: float = 1.0) -> None:
        self.speed = speed

    def __repr__(self) -> str:
        return f"Pace({self.speed:g})"


@dataclass
class Stats:
    sent: int = 0
    by_type: Counter[str] = field(default_factory=Counter)
    first_t: int | None = None
    last_t: int | None = None
    behind_s: float = 0.0  # the furthest the sink fell behind schedule
    caught_up: int = 0  # events sent at once to bring a mid-race joiner up to date


async def replay(
    events: Iterable[dict],
    emit: Emit,
    *,
    speed: float | Pace = 1.0,
    start_t: int | None = None,
    keep: Callable[[dict], bool] | None = None,
    limit: int | None = None,
    clock: Clock | None = None,
    stats: Stats | None = None,
    catch_up: bool = False,
) -> Stats:
    """Sends events to ``emit`` on the race's own schedule.

    The session.info header always goes first, whatever the start or filter, so a consumer
    joining mid-race still knows the race, the drivers and their teams.

    With ``catch_up``, a replay that starts mid-race first sends everything before the start
    except telemetry and positions, as fast as it can: grid order, tyre stints, earlier pit stops
    and flags only happen once, and a timing board needs them. Then it plays on at ``speed``.
    """
    pace = speed if isinstance(speed, Pace) else Pace(speed)
    live = isinstance(speed, Pace)  # may change mid-replay: wake up often enough to notice
    if pace.speed < 0:
        raise ValueError("speed must be 0 (as fast as possible) or more")
    clock = clock or RealClock()
    keep = keep or Filter()
    stats = stats or Stats()
    wall0: float | None = None
    t0 = start_t
    current = pace.speed

    for event in events:
        if event["type"] == "session.info":
            await emit(event)
            stats.sent += 1
            stats.by_type[event["type"]] += 1
            continue
        if start_t is not None and event["t"] < start_t:
            if catch_up and event["type"] not in HIGH_RATE and keep(event):
                await emit(event)
                stats.sent += 1
                stats.caught_up += 1
                stats.by_type[event["type"]] += 1
            continue
        if not keep(event):
            continue
        if limit is not None and stats.sent >= limit:
            break

        if wall0 is None:
            wall0 = clock.now()
            t0 = event["t"] if t0 is None else t0
        while True:
            if pace.speed != current:
                # Carry on from the race time reached so far, at the new speed.
                now = clock.now()
                reached = event["t"] if current == 0 else t0 + (now - wall0) * 1000 * current
                t0, wall0, current = min(reached, event["t"]), now, pace.speed
            if current <= 0:
                break
            delay = wall0 + (event["t"] - t0) / 1000 / current - clock.now()
            if delay <= 0.001:
                stats.behind_s = max(stats.behind_s, -delay)
                break
            await clock.sleep(min(delay, 0.25) if live else delay)
            if not live:
                break

        await emit(event)
        stats.sent += 1
        stats.by_type[event["type"]] += 1
        stats.first_t = event["t"] if stats.first_t is None else stats.first_t
        stats.last_t = event["t"]
    return stats
