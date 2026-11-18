"""Race history in TimescaleDB: every telemetry sample and every lap, per replay run.

``telemetry`` is a hypertable partitioned by when Pitwall received the sample (not when the car
recorded it in 2024), so a retention policy can drop old replays without touching new ones.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
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


class Recorder:
    """Buffers rows and writes them in batches: COPY for telemetry, upserts for laps."""

    def __init__(self, pool, *, batch: int = 5000, every: float = 0.5) -> None:
        self.pool = pool
        self.batch = batch
        self.every = every
        self.telemetry: list[tuple] = []
        self.laps: list[tuple] = []
        self.last_flush = time.monotonic()
        self.written = 0

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

    def due(self) -> bool:
        pending = len(self.telemetry) + len(self.laps)
        return pending >= self.batch or (
            pending and time.monotonic() - self.last_flush >= self.every
        )

    async def flush(self) -> int:
        telemetry, laps = self.telemetry, self.laps
        self.telemetry, self.laps = [], []
        self.last_flush = time.monotonic()
        if not (telemetry or laps):
            return 0
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
        self.written += len(telemetry) + len(laps)
        return len(telemetry) + len(laps)


async def laps_of(pool, run: str, car: int) -> list[dict]:
    rows = await pool.fetch(
        """SELECT lap, t, lap_time_ms, s1_ms, s2_ms, s3_ms, pit_out_lap
           FROM laps WHERE run = $1 AND car = $2 ORDER BY lap""",
        run,
        car,
    )
    return [dict(r) for r in rows]


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
