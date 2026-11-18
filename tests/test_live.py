import math

from pitwall.live import Live, Outline


def circle(n=400, r=5000):
    points = [
        (r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)
    ]
    return [(round(x), round(y)) for x, y in points + points[:5]]


def test_the_outline_closes_when_the_car_gets_back_to_the_start():
    outline = Outline()
    closed = [outline.add(1, x, y) for x, y in circle()]
    assert outline.done and closed.count(True) == 1
    assert 150 < len(outline.points) <= 405


def test_the_outline_follows_one_car_and_restarts_after_a_jump():
    outline = Outline()
    outline.add(1, 0, 0)
    outline.add(44, 9000, 9000)  # another car: ignored
    outline.add(1, 100, 0)
    outline.add(1, 8000, 8000)  # a jump (pit lane, a reset): the trace starts again
    assert outline.points == [(8000, 8000)]


def board(run):
    return {"run": run, "session": {"race_id": "2024-sao-paulo"}, "cars": []}


def position(car, t, x, y):
    data = {"x": x, "y": y, "z": 0}
    return {"type": "car.position", "race": "2024-sao-paulo", "car": car, "t": t, "data": data}


def telemetry(car, t, speed):
    data = {"speed": speed, "throttle": 100, "brake": 0, "gear": 7, "rpm": 11000, "drs": 0}
    return {"type": "car.telemetry", "race": "2024-sao-paulo", "car": car, "t": t, "data": data}


def test_live_state_follows_the_newest_run():
    live = Live()
    live.on_board(board("run-2"))
    assert live.on_car(position(1, 10, 5, 6), "run-2")
    assert live.on_car(position(1, 11, 7, 8), "run-1") is False  # an older run's straggler
    assert live.positions_frame() == {"1": [5, 6]}
    assert live.on_car(position(1, 12, 9, 9), "run-3")  # a newer run's cars, before its board
    assert live.positions_frame() == {"1": [9, 9]}
    live.on_board(board("run-2"))  # the older run's board doesn't take over again
    assert live.run == "run-3"


def test_run_ids_sort_by_start_time():
    from pitwall import bus

    first = bus.new_run()
    assert len(first) == 16
    assert bus.is_newer(first, None) and bus.is_newer("0" * 16, first) is False


def test_telemetry_is_sent_once():
    live = Live()
    live.on_board(board("a"))
    for t, speed in ((1, 100), (2, 110), (3, 120)):
        live.on_car(telemetry(1, t, speed), "a")
    assert [s[1] for s in live.telemetry_since(1, None)] == [100, 110, 120]
    assert [s[1] for s in live.telemetry_since(1, 2)] == [120]
    assert live.telemetry_since(44, None) == []
