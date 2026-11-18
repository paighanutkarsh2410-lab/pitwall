from pitwall.strategy import Strategy, degradation


def ev(kind, t, car=None, **data):
    return {"type": kind, "t": t, "car": car, "data": data}


def lap(car, n, ms, t, out=False):
    data = {"lap": n, "lap_time_ms": ms, "sectors_ms": [None] * 3, "pit_out_lap": out}
    return ev("lap.completed", t, car, **data, speed_trap_kph=None)


def stint(car=1, compound="MEDIUM", start=1):
    return ev("tyre.stint", 0, car, stint=1, compound=compound, lap_start=start, lap_end=None,
              tyre_age=0)  # fmt: skip


def test_degradation_is_the_lap_time_trend():
    assert degradation([(2, 80_000), (3, 80_100), (4, 80_200), (5, 80_300)]) == 100.0
    assert degradation([(2, 80_000), (3, 80_100)]) is None  # too few laps for a trend


def test_a_stint_reports_pace_and_degradation():
    model = Strategy()
    model.apply(stint())
    for i, n in enumerate(range(2, 10)):
        model.apply(lap(1, n, 80_000 + i * 100, 1000 * n))
    car = model.snapshot()["cars"]["1"]
    assert car["compound"] == "MEDIUM" and car["deg_ms_per_lap"] == 100.0
    assert car["stints"][0]["clean_laps"] == 8 and car["stints"][0]["pace_ms"] == 80_350


def test_unclean_laps_are_left_out():
    model = Strategy()
    model.apply(stint(compound="SOFT"))
    model.apply(lap(1, 1, 95_000, 1))  # the stint's first lap: the start
    model.apply(lap(1, 2, 80_000, 2))
    model.apply(lap(1, 3, 80_100, 3, out=True))  # an out-lap
    model.apply(lap(1, 4, 99_000, 4))  # traffic: over 107% of the median
    model.apply(ev("lap.started", 5, None, lap=5))
    sc = {"category": "SafetyCar", "message": "SAFETY CAR DEPLOYED", "flag": None, "scope": "Track"}
    model.apply(ev("race.control", 5, None, **sc))
    model.apply(lap(1, 5, 120_000, 6))  # under the safety car
    model.apply(lap(1, 6, 80_200, 7))
    model.apply(ev("pit.stop", 8, 1, lap=6, pit_lane_ms=24_000, stop_ms=2_500))  # 6: an in-lap
    assert model.snapshot()["cars"]["1"]["stints"][0]["clean_laps"] == 1  # only lap 2
    assert model.snapshot()["neutralised_laps"] == [5]


def test_pit_loss_is_the_field_median_without_red_flag_stops():
    model = Strategy()
    for car, ms in ((1, 24_000), (4, 25_000), (16, 26_000), (44, 1_200_000)):
        model.apply(ev("pit.stop", 1, car, lap=10, pit_lane_ms=ms, stop_ms=2_500))
    assert model.snapshot()["pit_loss_ms"] == 25_000


def test_a_new_run_resets_and_stragglers_are_ignored():
    model = Strategy()
    model.apply(ev("pit.stop", 1, 1, lap=10, pit_lane_ms=24_000, stop_ms=2_500), "a")
    model.apply(ev("weather", 2), "b")
    assert model.snapshot()["pit_loss_ms"] is None
    stale = ev("pit.stop", 3, 1, lap=11, pit_lane_ms=24_000, stop_ms=2_500)
    assert model.apply(stale, "a") is False
