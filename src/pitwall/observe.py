"""Metrics every service exports on /metrics, and the freshness clock the SLOs are built on.

Freshness: the replayer stamps every message with the time it sent it (``pitwall-sent``, ms since
the epoch, in a header that every hop forwards). Each stage measures how old the data is when it
gets there:

    ingest  a raw event is consumed
    board   a timing event is reflected in a published board
    api     a car's telemetry reaches the API, five frames a second from the browsers

so "99% of telemetry reaches the pit wall within 500 ms" is a histogram query, not a guess.
"""

from __future__ import annotations

import time

from prometheus_client import Counter, Gauge, Histogram

SENT_HEADER = "pitwall-sent"

FRESHNESS_BUCKETS = (0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0)

EVENTS = Counter(
    "pitwall_events_total",
    "Events handled, by service, event type and what happened to them",
    ["service", "type", "outcome"],
)
FRESHNESS = Histogram(
    "pitwall_event_freshness_seconds",
    "Seconds from the replayer sending an event to this stage handling it",
    ["stage"],
    buckets=FRESHNESS_BUCKETS,
)
CONSUMER_LAG = Gauge(
    "pitwall_consumer_lag_messages",
    "Messages waiting to be consumed, by service and topic",
    ["service", "topic"],
)
SNAPSHOTS = Counter("pitwall_snapshots_total", "Snapshots published", ["service"])
HISTORY_WRITE = Histogram(
    "pitwall_history_write_seconds",
    "Seconds to write a batch to TimescaleDB",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5),
)
HISTORY_ROWS = Counter("pitwall_history_rows_total", "Rows written to TimescaleDB")
WEBSOCKETS = Gauge("pitwall_websocket_clients", "Browsers connected to the pit wall")
FRAMES = Counter("pitwall_frames_total", "WebSocket frames sent to browsers")
REPLAY_SPEED = Gauge("pitwall_replay_speed", "Current replay speed (0 when idle)")
REPLAY_BEHIND = Gauge("pitwall_replay_behind_seconds", "How far the replayer is behind schedule")
HTTP_REQUESTS = Counter(
    "pitwall_http_requests_total", "HTTP requests", ["service", "route", "code"]
)
HTTP_SECONDS = Histogram(
    "pitwall_http_request_seconds",
    "HTTP request duration",
    ["service", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
)
BOARD_CHECKS = Counter(
    "pitwall_board_checks_total",
    "Car gaps on a board compared with another copy's board for the same timing update",
    ["producer", "result"],
)
UPLINK_EVENTS = Counter("pitwall_uplink_events_total", "Events the factory confirmed receiving")
UPLINK_BACKLOG = Gauge(
    "pitwall_uplink_backlog_messages", "Trackside events the factory hasn't confirmed yet"
)
UPLINK_LINK_UP = Gauge("pitwall_uplink_link_up", "1 while the factory confirms what is sent")
LINK_ENABLED = Gauge("pitwall_link_enabled", "0 while a drill has cut the link")
UPLINK_OUTAGE = Histogram(
    "pitwall_uplink_outage_seconds",
    "How long each link outage lasted",
    buckets=(5, 10, 30, 60, 120, 300, 600, 1800),
)
UPLINK_CATCHUP = Histogram(
    "pitwall_uplink_catchup_seconds",
    "Seconds from the link coming back to the factory receiving current data again",
    buckets=(1, 2, 5, 10, 20, 30, 60, 120, 300),
)
INGEST_DUPLICATES = Counter(
    "pitwall_ingest_duplicates_total", "Events received twice (re-sent after an outage), dropped"
)
PROJECTOR_REPLAYS = Counter(
    "pitwall_projector_replays_total",
    "Events a projector had already applied (handed on twice by ingest), dropped",
    ["service"],
)
INGEST_MISSING = Counter(
    "pitwall_ingest_missing_events_total", "Events that never arrived (a gap in a key's numbers)"
)
FAULT_DELAY = Gauge(
    "pitwall_fault_delay_seconds", "Delay injected for a drill (0 normally)", ["service"]
)


def now_ms() -> int:
    return int(time.time() * 1000)


def sent_header() -> tuple[str, bytes]:
    return SENT_HEADER, str(now_ms()).encode()


def sent_of(headers) -> int | None:
    for name, value in headers or ():
        if name == SENT_HEADER:
            try:
                return int(value)
            except ValueError:
                return None
    return None


def age_seconds(sent_ms: int | None) -> float | None:
    if sent_ms is None:
        return None
    return max(0.0, (now_ms() - sent_ms) / 1000)


def observe_freshness(stage: str, headers) -> None:
    age = age_seconds(sent_of(headers))
    if age is not None:
        FRESHNESS.labels(stage).observe(age)
