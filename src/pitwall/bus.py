"""The event bus: topics, how events are routed and keyed, and Kafka clients for Redpanda.

    replayer ─▶ pitwall.raw ─▶ ingest ─┬▶ pitwall.telemetry  car.telemetry, car.position
                                       ├▶ pitwall.timing     laps, positions, gaps, pits, tyres
                                       ├▶ pitwall.race       session.info, race.control, weather
                                       └▶ pitwall.deadletter anything that breaks the schema

    timing   ─▶ pitwall.board     (compacted) the live timing board
    strategy ─▶ pitwall.strategy  (compacted) stints, degradation, pit loss

Events are keyed by car number, so one car's events stay in order on one partition; race-wide
events go to a single-partition topic, so they stay in order too.

Every message carries a ``pitwall-run`` header: one id per replay run. A new run means a new
race (or the same race again), and every service resets its state when it sees one. Run ids
sort by the time the run started, so a service reading several partitions can tell a newer run
from a straggler of an older one whatever order their messages arrive in.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from dataclasses import dataclass

RAW = "pitwall.raw"
TELEMETRY = "pitwall.telemetry"
TIMING = "pitwall.timing"
RACE = "pitwall.race"
DEADLETTER = "pitwall.deadletter"
BOARD = "pitwall.board"
STRATEGY = "pitwall.strategy"

RUN_HEADER = "pitwall-run"


HOUR = 3_600_000


@dataclass(frozen=True)
class Topic:
    name: str
    partitions: int
    retention_ms: int | None = None
    compacted: bool = False

    def configs(self) -> dict[str, str]:
        if self.compacted:
            return {"cleanup.policy": "compact"}
        return {"retention.ms": str(self.retention_ms)} if self.retention_ms else {}


# High-rate topics keep a couple of hours; the timing log keeps a day, because the timing and
# strategy services rebuild their state from it whenever they start.
TOPICS = (
    Topic(RAW, 6, retention_ms=2 * HOUR),
    Topic(TELEMETRY, 6, retention_ms=2 * HOUR),
    Topic(TIMING, 6, retention_ms=24 * HOUR),
    Topic(RACE, 1, retention_ms=24 * HOUR),
    Topic(DEADLETTER, 1, retention_ms=24 * HOUR),
    Topic(BOARD, 1, compacted=True),
    Topic(STRATEGY, 1, compacted=True),
)

ROUTES = {
    "car.telemetry": TELEMETRY,
    "car.position": TELEMETRY,
    "lap.started": TIMING,
    "lap.completed": TIMING,
    "race.position": TIMING,
    "race.interval": TIMING,
    "pit.stop": TIMING,
    "tyre.stint": TIMING,
    "session.info": RACE,
    "race.control": RACE,
    "weather": RACE,
}


def route(event: dict) -> str:
    return ROUTES.get(event.get("type", ""), DEADLETTER)


def key(event: dict) -> bytes:
    car = event.get("car")
    return b"race" if car is None else str(car).encode()


def encode(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def decode(value: bytes) -> dict:
    return json.loads(value)


def new_run() -> str:
    """A run id that sorts by start time: 12 hex digits of milliseconds, then 4 random ones."""
    return f"{int(time.time() * 1000):012x}{secrets.token_hex(2)}"


def is_newer(run: str, than: str | None) -> bool:
    return than is None or run > than


def run_of(headers: list[tuple[str, bytes]] | None) -> str | None:
    for name, value in headers or ():
        if name == RUN_HEADER:
            return value.decode()
    return None


def brokers() -> str:
    return os.environ.get("PITWALL_BROKERS", "localhost:9092")


def producer(**options):
    from aiokafka import AIOKafkaProducer

    return AIOKafkaProducer(
        bootstrap_servers=brokers(),
        linger_ms=options.pop("linger_ms", 10),
        acks=options.pop("acks", "all"),
        enable_idempotence=options.pop("enable_idempotence", True),
        **options,
    )


def consumer(*topics: str, group: str | None, **options):
    from aiokafka import AIOKafkaConsumer

    return AIOKafkaConsumer(
        *topics,
        bootstrap_servers=brokers(),
        group_id=group,
        auto_offset_reset=options.pop("auto_offset_reset", "latest"),
        enable_auto_commit=options.pop("enable_auto_commit", True),
        **options,
    )


async def lag_by_topic(consumer) -> dict[str, int]:
    """Messages not yet consumed, per topic, across this consumer's partitions."""
    lag: dict[str, int] = {}
    for tp in consumer.assignment():
        end = consumer.highwater(tp)
        if end is None:
            continue
        position = await consumer.position(tp)
        lag[tp.topic] = lag.get(tp.topic, 0) + max(0, end - position)
    return lag


async def ensure_topics(only: tuple[str, ...] | None = None) -> list[str]:
    """Creates any missing topics (all of them, or ``only`` these: the trackside needs just
    pitwall.raw). Safe to run from every service at start-up."""
    from aiokafka.admin import AIOKafkaAdminClient, NewTopic

    admin = AIOKafkaAdminClient(bootstrap_servers=brokers())
    await admin.start()
    try:
        existing = set(await admin.list_topics())
        wanted = [t for t in TOPICS if only is None or t.name in only]
        missing = [t for t in wanted if t.name not in existing]
        if missing:
            await admin.create_topics(
                [
                    NewTopic(
                        t.name,
                        num_partitions=t.partitions,
                        replication_factor=1,
                        topic_configs=t.configs(),
                    )
                    for t in missing
                ]
            )
        return [t.name for t in missing]
    finally:
        await admin.close()
