import pytest

from pitwall import race as races
from pitwall.timing import Board, track_status


@pytest.fixture
def events(api):
    path = races.fetch(api, "2024-sao-paulo", progress=lambda _: None)
    return list(races.read_jsonl(path / "race.jsonl.gz"))


def board_after(events, until_t=None, run="run-1") -> Board:
    board = Board()
    for e in events:
        if until_t is None or e["t"] <= until_t:
            board.apply(e, run)
    return board


def test_the_board_follows_the_race(events):
    snap = board_after(events).snapshot()
    assert snap["session"]["name"] == "São Paulo Grand Prix"
    assert snap["lap"] == 3 and snap["laps"] == 3
    assert [c["code"] for c in snap["cars"]] == ["VER", "NOR"]  # by position
    ver, nor = snap["cars"]
    assert ver["colour"] == "3671C6" and ver["team"] == "Red Bull Racing"
    assert ver["best_lap_ms"] == 90_000 and ver["fastest_lap"] is False
    assert nor["fastest_lap"] is True  # NOR's 1:28.5 beats VER's 1:30.0
    assert snap["fastest_lap"] == {"car": 4, "lap_time_ms": 88_500}
    assert nor["gap_to_leader"] == "+1 LAP" and nor["interval"] == 1.234
    assert (ver["compound"], ver["tyre_age"], ver["pits"]) == ("WET", 2, 1)
    assert ver["last_pit"] == {"lap": 2, "pit_lane_ms": 24_500, "stop_ms": 2_600}


def test_track_status_and_messages(events):
    snap = board_after(events).snapshot()
    assert snap["track"] == "RED"
    assert [m["message"] for m in snap["messages"]] == ["RED FLAG", "GREEN LIGHT - PIT EXIT OPEN"]
    assert snap["weather"]["rainfall"] is True


def test_a_car_is_in_the_pit_lane_until_it_comes_out(events):
    pit_t = next(e["t"] for e in events if e["type"] == "pit.stop")
    during = board_after(events, until_t=pit_t + 10_000).snapshot()
    assert next(c for c in during["cars"] if c["car"] == 1)["in_pit"] is True
    # The board's clock moves with the events; the next one here is VER's lap 3, 110 s later.
    after = board_after(events, until_t=pit_t + 110_000).snapshot()
    assert next(c for c in after["cars"] if c["car"] == 1)["in_pit"] is False


def test_a_new_run_starts_a_fresh_board_and_old_stragglers_are_ignored(events):
    board = board_after(events, run="first")
    assert board.apply(events[0], "second")
    assert board.snapshot()["lap"] == 0 and board.snapshot()["run"] == "second"
    straggler = next(e for e in events if e["type"] == "lap.started")
    assert board.apply(straggler, "first") is False
    assert board.snapshot()["lap"] == 0


@pytest.mark.parametrize(
    ("message", "flag", "expected"),
    [
        ("SAFETY CAR DEPLOYED", None, "SC"),
        ("VIRTUAL SAFETY CAR DEPLOYED", None, "VSC"),
        ("VIRTUAL SAFETY CAR ENDING", None, "VSC_ENDING"),
        ("SAFETY CAR IN THIS LAP", None, "SC_ENDING"),
        ("RED FLAG", "RED", "RED"),
        ("CHEQUERED FLAG", "CHEQUERED", "CHEQUERED"),
        ("GREEN LIGHT - PIT EXIT OPEN", "GREEN", "GREEN"),
        ("CAR 44 (HAM) TIME 1:21.3 DELETED", None, "SC"),  # other messages change nothing
    ],
)
def test_track_status_from_race_control(message, flag, expected):
    scope = "Track" if flag else None
    assert track_status("SC", {"message": message, "flag": flag, "scope": scope}, set()) == expected


def test_yellow_sectors_come_and_go():
    yellow: set[int] = set()
    sector = {"message": "YELLOW IN TRACK SECTOR 4", "scope": "Sector", "sector": 4}
    track_status("GREEN", {**sector, "flag": "YELLOW"}, yellow)
    assert yellow == {4}
    track_status("GREEN", {**sector, "flag": "CLEAR"}, yellow)
    assert yellow == set()
