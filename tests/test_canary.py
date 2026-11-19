import asyncio

from pitwall import observe
from pitwall.live import Live, compare_boards
from pitwall.services import apply_defect, faults_of
from pitwall.services.timing import WrongGapsBoard
from pitwall.timing import Board


def car(number, gap, interval, gap_t):
    return {"car": number, "gap_to_leader": gap, "interval": interval, "gap_t": gap_t}


def board(producer, t, cars, run="run-1"):
    return {
        "run": run,
        "t": t,
        "session": {"race_id": "r"},
        "cars": cars,
        "producer": {"id": producer},
    }


def test_two_correct_copies_agree_exactly():
    a = board("stable", 1000, [car(1, 0.0, 0.0, 900), car(4, 1.234, 1.234, 900)])
    b = board("canary", 1100, [car(1, 0.0, 0.0, 900), car(4, 1.234, 1.234, 900)])
    assert compare_boards(a, b) == (4, 0)


def test_wrong_gaps_are_caught():
    a = board("canary", 1000, [car(4, 1.851, 1.851, 900)])
    b = board("stable", 1000, [car(4, 1.234, 1.234, 900)])
    assert compare_boards(a, b) == (0, 2)


def test_gaps_from_different_updates_are_not_compared():
    # One copy has already applied a newer interval event: not a disagreement, just timing.
    a = board("canary", 1000, [car(4, 1.5, 1.5, 4900)])
    b = board("stable", 1000, [car(4, 1.234, 1.234, 900)])
    assert compare_boards(a, b) == (0, 0)


def test_text_gaps_compare_as_text():
    a = board("a", 1, [car(19, "+1 LAP", 0.8, 5)])
    b = board("b", 1, [car(19, "+1 LAP", 0.8, 5)])
    assert compare_boards(a, b) == (2, 0)


def test_live_compares_producers_and_keeps_the_newest_board():
    live = Live()
    assert live.on_board(board("stable", 2000, [car(4, 1.0, 1.0, 1900)])) == []
    checks = live.on_board(board("canary", 1900, [car(4, 1.5, 1.5, 1900)]))
    assert checks == [("canary", 0, 2)]
    assert live.board["producer"]["id"] == "stable"  # the canary's board was older: not shown
    live.on_board(board("canary", 2100, [car(4, 1.5, 1.5, 1900)]))
    assert live.board["producer"]["id"] == "canary"  # newer: shown (that is what a canary is)


def test_the_wrong_gaps_build_is_wrong_only_in_its_gaps():
    events = [
        {
            "type": "race.interval",
            "t": 10,
            "car": 4,
            "data": {"gap_to_leader": 2.0, "interval": 1.0},
        },
        {
            "type": "race.interval",
            "t": 10,
            "car": 16,
            "data": {"gap_to_leader": "+1 LAP", "interval": 0.5},
        },
    ]
    good, bad = Board(), WrongGapsBoard()
    for e in events:
        good.apply(e)
        bad.apply(e)
    by_car = {c["car"]: c for c in bad.snapshot()["cars"]}
    assert by_car[4]["gap_to_leader"] == 3.0 and by_car[4]["interval"] == 1.5
    assert by_car[16]["gap_to_leader"] == "+1 LAP"  # text gaps are untouched
    assert compare_boards(bad.snapshot(), good.snapshot()) == (1, 3)


def test_the_slow_defect_delays_every_batch(monkeypatch):
    monkeypatch.setenv("PITWALL_DEFECT", "slow")
    assert apply_defect("drill-slow") is None
    assert faults_of("drill-slow").delay_ms == 900
    assert observe.FAULT_DELAY.labels("drill-slow")._value.get() == 0.9


def test_the_crash_defect_schedules_a_crash(monkeypatch):
    monkeypatch.setenv("PITWALL_DEFECT", "crash")

    async def check() -> None:
        task = apply_defect("drill-crash")
        assert task is not None and not task.done()
        task.cancel()  # in the test, never let it fire

    asyncio.run(check())


def test_no_defect_by_default(monkeypatch):
    monkeypatch.delenv("PITWALL_DEFECT", raising=False)
    assert apply_defect("drill-none") is None
    assert faults_of("drill-none").delay_ms == 0
