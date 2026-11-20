import itertools
import json

import pytest

from pitwall import race as races
from pitwall.events import validate

START_MS = 20 * 60 * 1000  # lap 1 began 20 minutes after the scheduled 15:30 start


@pytest.fixture
def built(api):
    path = races.fetch(api, "2024-sao-paulo", progress=lambda _: None)
    events = list(races.read_jsonl(path / "race.jsonl.gz"))
    summary = json.loads((path / "race.json").read_text("utf-8"))
    return events, summary


def of(events, kind, car=None):
    return [e for e in events if e["type"] == kind and (car is None or e["car"] == car)]


def test_slugs_drop_accents():
    assert races.slugify("São Paulo") == "sao-paulo"
    assert races.slugify("Mexico City") == "mexico-city"


@pytest.mark.parametrize("name", ["2024-sao-paulo", "2024-brazil", "2024-interlagos"])
def test_finds_a_race_by_place_country_or_circuit(api, name):
    assert races.find_race(api, name).id == "2024-sao-paulo"


def test_an_unknown_race_lists_the_real_ones(api):
    with pytest.raises(LookupError, match="2024-sao-paulo"):
        races.find_race(api, "2024-narnia")
    with pytest.raises(LookupError, match="YEAR-place"):
        races.find_race(api, "sao paulo")


def test_every_event_fits_the_schema_in_order(built):
    events, summary = built
    for event in events:
        validate(event)
    assert [e["seq"] for e in events] == list(range(len(events)))
    assert all(a["t"] <= b["t"] for a, b in itertools.pairwise(events))
    assert summary["events"] == len(events)
    assert sum(summary["by_type"].values()) == len(events)


def test_the_race_opens_with_the_session(built):
    events, _ = built
    info = events[0]
    assert info["type"] == "session.info" and info["seq"] == 0
    assert info["data"]["name"] == "São Paulo Grand Prix"
    assert info["data"]["laps"] == 3
    assert [d["code"] for d in info["data"]["drivers"]] == ["VER", "NOR"]  # by car number
    assert info["data"]["drivers"][0]["colour"] == "3671C6"


def test_time_counts_from_the_scheduled_start(built):
    events, summary = built
    assert summary["lap_starts"]["1"] == START_MS
    early = of(events, "race.control")[0]
    assert early["t"] == -10 * 60 * 1000  # 15:20, before the scheduled 15:30
    assert early["at"] == "2024-11-03T15:20:00.000Z"


def test_a_red_flag_lap_without_a_time_ends_when_the_next_begins(built):
    events, _ = built
    lap2 = next(e for e in of(events, "lap.completed", car=1) if e["data"]["lap"] == 2)
    assert lap2["data"]["lap_time_ms"] is None
    assert lap2["data"]["sectors_ms"] == [None, None, None]
    assert lap2["t"] == START_MS + (3 * 60 + 30) * 1000  # VER's lap 3 start


def test_a_timed_lap_ends_after_its_duration(built):
    events, _ = built
    lap1 = next(e for e in of(events, "lap.completed", car=1) if e["data"]["lap"] == 1)
    assert lap1["t"] == START_MS + 100_000
    assert lap1["data"] == {
        "lap": 1,
        "lap_time_ms": 100_000,
        "sectors_ms": [31_500, 49_500, 19_000],
        "pit_out_lap": False,
        "speed_trap_kph": 189,
    }


def test_a_lap_with_no_start_time_still_completes(built):
    events, _ = built
    nor = of(events, "lap.completed", car=4)
    assert [e["data"]["lap"] for e in nor] == [1, 2]
    assert of(events, "lap.started", car=4)[0]["data"]["lap"] == 2  # lap 1 has no start


def test_stints_are_announced_when_they_begin(built):
    events, _ = built
    ver = of(events, "tyre.stint", car=1)
    assert [(e["data"]["compound"], e["data"]["tyre_age"]) for e in ver] == [
        ("INTERMEDIATE", 0),
        ("WET", 2),
    ]
    assert ver[1]["t"] == START_MS + (3 * 60 + 30) * 1000
    # NOR's lap 1 has no start time, so his first stint is announced at the race start.
    assert of(events, "tyre.stint", car=4)[0]["t"] == START_MS


def test_pit_stops_gaps_and_weather_keep_their_detail(built):
    events, _ = built
    assert of(events, "pit.stop")[0]["data"] == {"lap": 2, "pit_lane_ms": 24_500, "stop_ms": 2_600}
    assert of(events, "race.interval", car=4)[0]["data"]["gap_to_leader"] == "+1 LAP"
    assert of(events, "weather")[0]["data"]["rainfall"] is True
    tel = of(events, "car.telemetry", car=1)
    assert [e["data"]["speed"] for e in tel] == [207, 212]
    assert tel[1]["data"]["drs"] == 12


def test_a_second_fetch_reuses_what_is_on_disk(api, fake, built):
    before = fake.requests.copy()
    races.fetch(api, "2024-sao-paulo", progress=lambda _: None)
    assert fake.requests["car_data"] == before["car_data"]
    assert fake.requests["stints"] == before["stints"]


def test_a_built_race_needs_no_api_at_all(api, fake, built):
    # OpenF1 locks everyone out during a live session; a race on disk must still load.
    before = sum(fake.requests.values())
    path = races.fetch(api, "2024-sao-paulo", progress=lambda _: None)
    assert sum(fake.requests.values()) == before
    assert (path / "race.json").exists()


def test_force_downloads_again(api, fake, built):
    before = fake.requests["car_data"]
    races.fetch(api, "2024-sao-paulo", progress=lambda _: None, force=True)
    assert fake.requests["car_data"] == before * 2


def test_a_race_is_free_half_an_hour_after_it_ends(api):
    from datetime import datetime, timedelta

    ref = races.find_race(api, "2024-sao-paulo")
    assert ref.free_from() == ref.starts_at + timedelta(hours=3, minutes=30)  # no end time known
    ended = races.RaceRef(
        **{**ref.__dict__, "ends_at": datetime.fromisoformat("2024-11-03T18:00:00+00:00")}
    )
    assert ended.free_from().isoformat() == "2024-11-03T18:30:00+00:00"
