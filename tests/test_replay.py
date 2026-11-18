import asyncio

import pytest

from pitwall.replay import Filter, replay


class FakeClock:
    """Time only moves when the replayer sleeps, so pacing is checked exactly and instantly."""

    def __init__(self) -> None:
        self.time = 100.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.time

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.time += seconds


def ev(seq: int, t: int, kind: str = "car.telemetry", car: int | None = 1) -> dict:
    return {"v": 1, "type": kind, "race": "r", "seq": seq, "t": t, "at": "", "car": car, "data": {}}


EVENTS = [
    ev(0, -5000, "session.info", None),
    ev(1, -5000, "race.control", None),
    ev(2, 0, "lap.started"),
    ev(3, 1000),
    ev(4, 1000, car=44),
    ev(5, 3000, "lap.completed"),
    ev(6, 7000, "race.control", None),
]


def run(events=EVENTS, **options):
    clock = FakeClock()
    sent: list[tuple[float, int]] = []

    async def emit(event: dict) -> None:
        sent.append((round(clock.now() - 100.0, 6), event["seq"]))

    stats = asyncio.run(replay(events, emit, clock=clock, **options))
    return sent, stats, clock


def test_events_keep_their_spacing_scaled_by_speed():
    sent, stats, _ = run(speed=10)
    assert sent == [(0, 0), (0, 1), (0.5, 2), (0.6, 3), (0.6, 4), (0.8, 5), (1.2, 6)]
    assert stats.sent == 7 and stats.first_t == -5000 and stats.last_t == 7000


def test_real_time_is_speed_one():
    sent, _, _ = run(speed=1)
    assert [when for when, _ in sent][-1] == 12.0


def test_speed_zero_never_waits():
    sent, _, clock = run(speed=0)
    assert clock.sleeps == []
    assert [seq for _, seq in sent] == [0, 1, 2, 3, 4, 5, 6]


def test_starting_mid_race_skips_earlier_events_but_keeps_the_header():
    sent, _, _ = run(speed=1, start_t=1000)
    assert sent == [(0, 0), (0, 3), (0, 4), (2.0, 5), (6.0, 6)]


def test_a_filter_matches_type_prefixes_and_cars():
    sent, _, _ = run(speed=0, keep=Filter(types=("lap",), cars=frozenset({1})))
    assert [seq for _, seq in sent] == [0, 2, 5]
    # Race-wide events have no car, so a car filter keeps them.
    sent, _, _ = run(speed=0, keep=Filter(cars=frozenset({44})))
    assert [seq for _, seq in sent] == [0, 1, 4, 6]


def test_limit_stops_the_stream():
    sent, stats, _ = run(speed=0, limit=3)
    assert [seq for _, seq in sent] == [0, 1, 2]
    assert stats.by_type["session.info"] == 1


def test_a_slow_sink_is_measured_not_hidden():
    clock = FakeClock()

    async def slow(event: dict) -> None:
        clock.time += 2.0  # every send takes two seconds

    stats = asyncio.run(replay(EVENTS[:4], slow, speed=1, clock=clock))
    assert stats.behind_s == pytest.approx(1.0)  # due at 108 s, sent at 109 s


def test_negative_speed_is_refused():
    with pytest.raises(ValueError, match="speed"):
        run(speed=-1)
