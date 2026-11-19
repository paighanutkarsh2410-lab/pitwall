from pitwall import bus
from pitwall.events import EVENT_TYPES
from pitwall.services.ingest import triage

GOOD = {
    "v": 1,
    "type": "pit.stop",
    "race": "r",
    "seq": 1,
    "t": 5,
    "at": "2024-11-03T16:00:00.000Z",
    "car": 1,
    "data": {"lap": 2, "pit_lane_ms": 24500, "stop_ms": 2600},
}


def test_a_valid_event_goes_to_its_topic_unchanged():
    assert triage(GOOD) == (bus.TIMING, GOOD)


def test_a_broken_event_is_dead_lettered_with_the_reason():
    broken = {**GOOD, "data": {"lap": "two", "pit_lane_ms": 1}}
    topic, value = triage(broken)
    assert topic == bus.DEADLETTER
    assert value["event"] == broken and "lap" in value["reason"]


def test_routing_keys_and_run_headers():
    assert bus.route({"type": "car.telemetry"}) == bus.TELEMETRY
    assert bus.route({"type": "race.control"}) == bus.RACE
    assert bus.route({"type": "mystery"}) == bus.DEADLETTER
    assert bus.key({"car": 44}) == b"44" and bus.key({"car": None}) == b"race"
    assert bus.run_of([("other", b"x"), (bus.RUN_HEADER, b"abc")]) == "abc"
    assert bus.run_of(None) is None


def test_cars_spread_evenly_over_the_partitions():
    from collections import Counter

    grid = [1, 4, 10, 11, 14, 16, 18, 22, 23, 24, 27, 30, 31, 43, 44, 50, 55, 63, 77, 81]
    partitions = list(range(6))
    spread = Counter(bus.by_car(str(c).encode(), partitions, partitions) for c in grid)
    spread[bus.by_car(b"race", partitions, partitions)] += 1
    assert sorted(spread) == partitions  # no partition left empty
    assert max(spread.values()) - min(spread.values()) <= 1
    assert bus.by_car(b"44", partitions, partitions) == 2  # always the same one for a car


def test_every_event_type_has_a_route():
    assert set(bus.ROUTES) == set(EVENT_TYPES)
