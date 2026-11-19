"""Race history in TimescaleDB: every telemetry sample and every lap, per replay run.

``telemetry`` is a hypertable partitioned by when Pitwall received the sample (not when the car
recorded it in 2024), so a retention policy can drop old replays without touching new ones.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime

log = logging.getLogger("pitwall.history")

RETENTION = os.environ.get("PITWALL_HISTORY_RETENTION", "3 days")

SCHEMA = f"""
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS telemetry (
    received  timestamptz NOT NULL,
    run       text        NOT NULL,
    race      text        NOT NULL,
    car       smallint    NOT NULL,
    t         integer     NOT NULL,
    at        timestamptz NOT NULL,
    speed     smallint, rpm integer, gear smallint,
    throttle  smallint, brake smallint, drs smallint
);
SELECT create_hypertable('telemetry', by_range('received', INTERVAL '1 hour'),
                         if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetry_run_car_t ON telemetry (run, car, t);
SELECT add_retention_policy('telemetry', INTERVAL '{RETENTION}', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS laps (
    run          text     NOT NULL,
    race         text     NOT NULL,
    car          smallint NOT NULL,
    lap          smallint NOT NULL,
    t            integer  NOT NULL,
    lap_time_ms  integer,
    s1_ms integer, s2_ms integer, s3_ms integer,
    pit_out_lap  boolean  NOT NULL DEFAULT false,
    received     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run, car, lap)
);
"""

TELEMETRY_COLUMNS = (
    "received", "run", "race", "car", "t", "at",
    "speed", "rpm", "gear", "throttle", "brake", "drs",
)  # fmt: skip


def dsn() -> str | None:
    return os.environ.get("PITWALL_DB_URL")


async def connect():
    import asyncpg

    return await asyncpg.create_pool(dsn(), min_size=1, max_size=4, command_timeout=30)


async def migrate(pool) -> None:
    async with pool.acquire() as conn:
        # One migrator at a time, even with several ingest replicas starting together.
        await conn.execute("SELECT pg_advisory_lock(424242)")
        try:
            await conn.execute(SCHEMA)
        finally:
            await conn.execute("SELECT pg_advisory_unlock(424242)")


@dataclass
class Batch:
    telemetry: list[tuple]
    laps: list[tuple]
    offsets: dict = field(default_factory=dict)  # where the source has been read up to

    @property
    def rows(self) -> int:
        return len(self.telemetry) + len(self.laps)


class Recorder:
    """Buffers rows and writes them in batches (COPY for telemetry, upserts for laps), from a
    writer task of its own, so live timing never waits for the database.

    The GameDay's slow-disk experiment found it did: ingest wrote history inline, each write
    took 2.5 s, and the pit wall fell 30 s behind. Now ingest hands batches over and carries
    on. ``durable`` tells it how far the source has been read *and* stored, which is as far as
    it may commit. If the database falls more than ``max_backlog`` rows behind, the oldest
    waiting batches are given up on and counted: history has a gap, live timing doesn't.
    """

    def __init__(
        self,
        pool,
        *,
        batch: int = 5000,
        every: float = 0.5,
        max_backlog: int = 200_000,
        retry: float = 1.0,
    ) -> None:
        self.pool = pool
        self.batch = batch
        self.every = every
        self.max_backlog = max_backlog
        self.retry = retry
        self.telemetry: list[tuple] = []
        self.laps: list[tuple] = []
        self.last_flush = time.monotonic()
        self.written = 0
        self.dropped = 0
        self.queue: deque[Batch] = deque()
        self.durable: dict = {}
        self.wake = asyncio.Event()

    def add(self, run: str, event: dict) -> None:
        kind = event["type"]
        if kind == "car.telemetry":
            d = event["data"]
            self.telemetry.append(
                (
                    datetime.now(UTC),
                    run,
                    event["race"],
                    event["car"],
                    event["t"],
                    datetime.fromisoformat(event["at"]),
                    d["speed"],
                    d["rpm"],
                    d["gear"],
                    d["throttle"],
                    d["brake"],
                    d["drs"],
                )
            )
        elif kind == "lap.completed":
            d = event["data"]
            s1, s2, s3 = (d["sectors_ms"] + [None, None, None])[:3]
            self.laps.append(
                (
                    run,
                    event["race"],
                    event["car"],
                    d["lap"],
                    event["t"],
                    d["lap_time_ms"],
                    s1,
                    s2,
                    s3,
                    d["pit_out_lap"],
                )
            )

    def backlog(self) -> int:
        """Rows read but not yet stored (buffered or waiting for the writer)."""
        return len(self.telemetry) + len(self.laps) + sum(b.rows for b in self.queue)

    def due(self) -> bool:
        pending = len(self.telemetry) + len(self.laps)
        return pending >= self.batch or bool(
            pending and time.monotonic() - self.last_flush >= self.every
        )

    def hand_off(self, offsets: dict) -> int:
        """Queues what is buffered for the writer, with how far the source has been read.
        Returns how many rows were given up on to keep the backlog bounded."""
        batch = Batch(self.telemetry, self.laps, dict(offsets))
        self.telemetry, self.laps = [], []
        self.last_flush = time.monotonic()
        if batch.rows:
            self.queue.append(batch)
        elif self.queue:
            self.queue[-1].offsets.update(batch.offsets)
        else:
            self.durable.update(batch.offsets)  # nothing to store: read is as good as stored
        dropped = 0
        # Never the first batch: the writer may be in the middle of it.
        while self.backlog() > self.max_backlog and len(self.queue) > 2:
            gone = self.queue[1]
            del self.queue[1]
            self.queue[0].offsets.update(gone.offsets)  # stored or not, it's been dealt with
            dropped += gone.rows
        if dropped:
            self.dropped += dropped
            log.error("TimescaleDB is %d rows behind: gave up on %d", self.backlog(), dropped)
        self.wake.set()
        return dropped

    async def run(self) -> None:
        """The writer: stores queued batches in order, retrying while the database is away."""
        from pitwall import observe

        while True:
            if not self.queue:
                self.wake.clear()
                await self.wake.wait()
                continue
            batch = self.queue[0]
            try:
                with observe.HISTORY_WRITE.time():
                    await self.write(batch.telemetry, batch.laps)
            except Exception as error:  # the database is down or slow: keep the batch, retry
                log.warning("History write failed (%s); retrying", error)
                await asyncio.sleep(self.retry)
                continue
            self.queue.popleft()
            self.durable.update(batch.offsets)
            self.written += batch.rows
            observe.HISTORY_ROWS.inc(batch.rows)

    async def write(self, telemetry: list[tuple], laps: list[tuple]) -> None:
        async with self.pool.acquire() as conn, conn.transaction():
            if telemetry:
                await conn.copy_records_to_table(
                    "telemetry", records=telemetry, columns=TELEMETRY_COLUMNS
                )
            if laps:
                await conn.executemany(
                    """INSERT INTO laps (run, race, car, lap, t, lap_time_ms, s1_ms, s2_ms,
                                         s3_ms, pit_out_lap)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                       ON CONFLICT (run, car, lap) DO UPDATE SET
                         t = EXCLUDED.t, lap_time_ms = EXCLUDED.lap_time_ms,
                         s1_ms = EXCLUDED.s1_ms, s2_ms = EXCLUDED.s2_ms,
                         s3_ms = EXCLUDED.s3_ms, pit_out_lap = EXCLUDED.pit_out_lap""",
                    laps,
                )


async def laps_of(pool, run: str, car: int) -> list[dict]:
    rows = await pool.fetch(
        """SELECT lap, t, lap_time_ms, s1_ms, s2_ms, s3_ms, pit_out_lap
           FROM laps WHERE run = $1 AND car = $2 ORDER BY lap""",
        run,
        car,
    )
    return [dict(r) for r in rows]


async def race_trace(pool, run: str) -> dict:
    """Gap to the leader at the end of every lap, for every car: the strategists' race trace."""
    rows = await pool.fetch("SELECT car, lap, t FROM laps WHERE run = $1 ORDER BY lap, t", run)
    leader: dict[int, int] = {}
    cars: dict[str, list] = {}
    for r in rows:
        leader.setdefault(r["lap"], r["t"])  # ordered by t: the first car to finish the lap
        gap = round((r["t"] - leader[r["lap"]]) / 1000, 3)
        cars.setdefault(str(r["car"]), []).append([r["lap"], gap])
    return {"laps": max(leader, default=0), "cars": cars}


async def wait_for_db(attempts: int = 30) -> object:
    for attempt in range(attempts):
        try:
            return await connect()
        except (OSError, Exception) as error:
            if attempt == attempts - 1:
                raise
            log.info("Waiting for the database: %s", error)
            await asyncio.sleep(2)
    raise RuntimeError("unreachable")
