"""Grafana dashboards as code.

    python scripts/dashboards.py   writes deploy/charts/pitwall-observability/dashboards/*.json

Grafana loads them from ConfigMaps (its dashboard sidecar), so a dashboard change is a commit
like any other, and a test fails if the committed JSON is out of date.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "deploy" / "charts" / "pitwall-observability" / "dashboards"

PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}
TEMPO = {"type": "tempo", "uid": "tempo"}

SLOS = ("telemetry-freshness", "board-freshness", "ingest-validity", "api-availability")


class Layout:
    """Places panels left to right on a 24-column grid, wrapping to new rows."""

    def __init__(self) -> None:
        self.x, self.y, self.row_h, self.next_id = 0, 0, 0, 1
        self.panels: list[dict] = []

    def add(self, panel: dict, w: int, h: int) -> None:
        if self.x + w > 24:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        panel.update(id=self.next_id, gridPos={"x": self.x, "y": self.y, "w": w, "h": h})
        self.next_id += 1
        self.x += w
        self.row_h = max(self.row_h, h)
        self.panels.append(panel)

    def row(self, title: str) -> None:
        if self.x:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        self.panels.append(
            {
                "type": "row",
                "title": title,
                "id": self.next_id,
                "collapsed": False,
                "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1},
                "panels": [],
            }
        )
        self.next_id += 1
        self.y += 1


def target(expr: str, legend: str = "", ref: str = "A") -> dict:
    return {"datasource": PROM, "expr": expr, "legendFormat": legend, "refId": ref}


def timeseries(title: str, targets: list[dict], unit: str = "short", **options) -> dict:
    defaults: dict = {"unit": unit, "custom": {"lineWidth": 2, "fillOpacity": 8}}
    if "thresholds" in options:
        defaults["thresholds"] = options.pop("thresholds")
        defaults["custom"]["thresholdsStyle"] = {"mode": "dashed"}
    if "max" in options:
        defaults["max"] = options.pop("max")
    panel = {
        "type": "timeseries",
        "title": title,
        "datasource": PROM,
        "targets": targets,
        "fieldConfig": {"defaults": defaults, "overrides": []},
        "options": {
            "legend": {"displayMode": "list", "placement": "bottom"},
            "tooltip": {"mode": "multi"},
        },
    }
    if "description" in options:
        panel["description"] = options.pop("description")
    return panel


def steps(*pairs: tuple[float | None, str]) -> dict:
    return {"mode": "absolute", "steps": [{"value": v, "color": c} for v, c in pairs]}


def stat(title: str, expr: str, unit: str, thresholds: dict, legend: str = "", **extra) -> dict:
    return {
        "type": "stat",
        "title": title,
        "datasource": PROM,
        "targets": [target(expr, legend)],
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "thresholds": thresholds,
                "decimals": extra.get("decimals", 1),
            }
        },
        "options": {
            "colorMode": "background",
            "graphMode": "area" if extra.get("spark") else "none",
            "textMode": "value_and_name" if legend else "value",
            "reduceOptions": {"calcs": ["lastNotNull"]},
        },
        **({"description": extra["description"]} if "description" in extra else {}),
    }


def race_health() -> dict:
    L = Layout()

    L.row("Service level objectives")
    for slo in SLOS:
        L.add(
            stat(
                f"{slo} · budget left (3d)",
                f'clamp_min(pitwall:slo_error_budget_remaining:3d{{slo="{slo}"}}, 0)',
                "percentunit",
                steps((None, "red"), (0.25, "orange"), (0.5, "green")),
                description=f"Share of the {slo} error budget not yet spent over the last 3 days.",
            ),
            6,
            4,
        )
    L.add(
        timeseries(
            "Burn rate (1h): how fast each budget is being spent",
            [
                target(
                    f'pitwall:slo_error_ratio:rate1h{{slo="{slo}"}} / on(slo) (1 - pitwall:slo_objective{{slo="{slo}"}})',
                    slo,
                    chr(65 + i),
                )
                for i, slo in enumerate(SLOS)
            ],
            "short",
            thresholds=steps((None, "green"), (6, "orange"), (14.4, "red")),
            description="1 = spending the budget exactly as fast as it allows. 14.4 over an hour pages.",
        ),
        24,
        7,
    )

    L.row("Freshness: from the replayer to each stage")
    L.add(
        timeseries(
            "Freshness by stage, p99",
            [
                target(
                    f'histogram_quantile(0.99, sum by (le) (rate(pitwall_event_freshness_seconds_bucket{{stage="{stage}"}}[1m])))',
                    stage,
                    chr(65 + i),
                )
                for i, stage in enumerate(("ingest", "timing", "strategy", "api"))
            ],
            "s",
            thresholds=steps((None, "green"), (0.5, "orange"), (1, "red")),
            description="The SLOs: api under 0.5 s, timing under 1 s, for 99% of events.",
        ),
        12,
        8,
    )
    L.add(
        timeseries(
            "Freshness by stage, median",
            [
                target(
                    f'histogram_quantile(0.5, sum by (le) (rate(pitwall_event_freshness_seconds_bucket{{stage="{stage}"}}[1m])))',
                    stage,
                    chr(65 + i),
                )
                for i, stage in enumerate(("ingest", "timing", "strategy", "api"))
            ],
            "s",
        ),
        12,
        8,
    )

    L.row("Throughput and backlog")
    L.add(
        timeseries(
            "Events per second, by service",
            [target("sum by (service) (rate(pitwall_events_total[1m]))", "{{service}}")],
            "ops",
        ),
        8,
        8,
    )
    L.add(
        timeseries(
            "Events per second into ingest, by type",
            [
                target(
                    'sum by (type) (rate(pitwall_events_total{service="ingest"}[1m]))', "{{type}}"
                )
            ],
            "ops",
        ),
        8,
        8,
    )
    L.add(
        timeseries(
            "Consumer lag",
            [
                target(
                    "max by (service, topic) (pitwall_consumer_lag_messages)",
                    "{{service}} · {{topic}}",
                )
            ],
            "short",
            thresholds=steps((None, "green"), (10000, "red")),
        ),
        8,
        8,
    )
    L.add(
        stat(
            "Dead letters (15m)",
            'sum(increase(pitwall_events_total{outcome="deadlettered"}[15m])) or vector(0)',
            "short",
            steps((None, "green"), (1, "red")),
            decimals=0,
        ),
        4,
        4,
    )
    L.add(
        stat(
            "Replay speed",
            "max(pitwall_replay_speed)",
            "x",
            steps((None, "blue")),
            decimals=0,
        ),
        4,
        4,
    )
    L.add(
        stat(
            "Pit-wall browsers",
            "sum(pitwall_websocket_clients)",
            "short",
            steps((None, "blue")),
            decimals=0,
        ),
        4,
        4,
    )
    L.add(
        stat(
            "Injected delay (drills)",
            "max(pitwall_fault_delay_seconds) or vector(0)",
            "s",
            steps((None, "green"), (0.001, "purple")),
            decimals=2,
            description="Non-zero only during a fault-injection drill (see docs/runbooks).",
        ),
        4,
        4,
    )
    L.add(
        stat(
            "Replayer behind schedule",
            "max(pitwall_replay_behind_seconds) or vector(0)",
            "s",
            steps((None, "green"), (1, "orange"), (5, "red")),
            decimals=2,
        ),
        4,
        4,
    )
    L.add(
        stat(
            "Snapshots per second",
            "sum(rate(pitwall_snapshots_total[1m]))",
            "ops",
            steps((None, "blue")),
        ),
        4,
        4,
    )

    L.row("History and API")
    L.add(
        timeseries(
            "TimescaleDB batch writes, p99",
            [
                target(
                    "histogram_quantile(0.99, sum by (le) (rate(pitwall_history_write_seconds_bucket[5m])))",
                    "p99",
                )
            ],
            "s",
        ),
        8,
        7,
    )
    L.add(
        timeseries(
            "Rows written per second",
            [target("rate(pitwall_history_rows_total[1m])", "rows/s")],
            "ops",
        ),
        8,
        7,
    )
    L.add(
        timeseries(
            "API requests, by route and status",
            [
                target(
                    'sum by (route, code) (rate(pitwall_http_requests_total{service="api"}[5m]))',
                    "{{code}} {{route}}",
                )
            ],
            "reqps",
        ),
        8,
        7,
    )

    L.row("Logs and traces")
    L.add(
        {
            "type": "logs",
            "title": "Warnings and errors from every service",
            "datasource": LOKI,
            "targets": [
                {
                    "datasource": LOKI,
                    "refId": "A",
                    "expr": '{k8s_namespace_name="pitwall"} | json | level=~"warning|error"',
                }
            ],
            "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending"},
        },
        14,
        10,
    )
    L.add(
        {
            "type": "table",
            "title": "Recent traces: one event, every hop",
            "datasource": TEMPO,
            "targets": [
                {
                    "datasource": TEMPO,
                    "refId": "A",
                    "queryType": "traceql",
                    "query": '{ resource.service.namespace = "pitwall" && name = "replayer.send" }',
                    "limit": 20,
                }
            ],
        },
        10,
        10,
    )

    return {
        "uid": "pitwall-race-health",
        "title": "Pitwall · Race health",
        "description": "SLOs, freshness, throughput and backlog for the race stream.",
        "tags": ["pitwall"],
        "timezone": "browser",
        "refresh": "10s",
        "time": {"from": "now-30m", "to": "now"},
        "schemaVersion": 41,
        "editable": True,
        "panels": L.panels,
        "templating": {"list": []},
        "annotations": {"list": []},
    }


DASHBOARDS = {"race-health.json": race_health}


def render() -> dict[str, str]:
    return {name: json.dumps(build(), indent=2) + "\n" for name, build in DASHBOARDS.items()}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in render().items():
        (OUT / name).write_text(text, encoding="utf-8", newline="\n")
        print(f"Wrote {(OUT / name).relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
