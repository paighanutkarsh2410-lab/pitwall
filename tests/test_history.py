import asyncio

from pitwall.history import Recorder


class SlowPool:
    """Stands in for asyncpg: each write takes ``delay``; ``fail`` makes the next ones fail."""

    def __init__(self, delay: float = 0.0) -> None:
        self.delay, self.fail, self.rows = delay, 0, []

    def acquire(self):
        pool = self

        class Conn:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def transaction(self):
                return self

            async def copy_records_to_table(self, table, records, columns):
                await asyncio.sleep(pool.delay)
                if pool.fail:
                    pool.fail -= 1
                    raise OSError("database away")
                pool.rows.extend(records)

            async def executemany(self, sql, rows):
                pool.rows.extend(rows)

        return Conn()


def lap(car: int, t: int) -> dict:
    data = {"speed": 300, "rpm": 11000, "gear": 7, "throttle": 100, "brake": 0, "drs": 0}
    return {
        "type": "car.telemetry",
        "race": "x",
        "car": car,
        "t": t,
        "at": "2024-11-03T15:00:00+00:00",
        "data": data,
    }


def test_a_slow_database_never_holds_up_the_caller():
    async def main():
        pool = SlowPool(delay=0.2)
        recorder = Recorder(pool, batch=1)
        writer = asyncio.create_task(recorder.run())
        started = asyncio.get_running_loop().time()
        for t in range(5):
            recorder.add("r", lap(1, t))
            recorder.hand_off({"p0": t + 1})
        handed = asyncio.get_running_loop().time() - started
        assert handed < 0.05  # five hand-offs, no waiting for five 0.2 s writes
        assert recorder.durable == {}  # nothing stored yet: nothing may be committed
        while recorder.queue:
            await asyncio.sleep(0.05)
        writer.cancel()
        assert len(pool.rows) == 5 and recorder.durable == {"p0": 5}

    asyncio.run(main())


def test_failed_writes_are_retried_in_order():
    async def main():
        pool = SlowPool()
        pool.fail = 2
        recorder = Recorder(pool, batch=1, retry=0.01)
        writer = asyncio.create_task(recorder.run())
        for t in range(3):
            recorder.add("r", lap(1, t))
            recorder.hand_off({"p0": t + 1})
        while recorder.queue:
            await asyncio.sleep(0.01)
        writer.cancel()
        assert [row[4] for row in pool.rows] == [0, 1, 2] and recorder.durable == {"p0": 3}

    asyncio.run(main())


def test_too_far_behind_gives_up_the_oldest_waiting_rows():
    recorder = Recorder(SlowPool(), batch=1, max_backlog=3)  # no writer running: all wait
    for t in range(6):
        recorder.add("r", lap(1, t))
        recorder.hand_off({"p0": t + 1})
    assert recorder.dropped == 3 and recorder.backlog() == 3
    # The first batch (maybe mid-write) stays and now covers what was given up on.
    assert recorder.queue[0].offsets == {"p0": 4}
