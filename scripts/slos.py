"""Pitwall's SLOs as code, and the Prometheus rules generated from them.

    python scripts/slos.py   writes deploy/charts/pitwall-observability/rules/pitwall.rules.yaml

A test fails if that file is out of date.

Each SLO is a ratio of bad events to all events. From it come:

- recording rules for the error ratio over 5m, 30m, 1h, 2h, 6h, 1d and 3d,
- the multi-window, multi-burn-rate alerts from Google's SRE workbook (chapter 5): page when the
  error budget burns 14.4x too fast over 1h (confirmed over 5m) or 6x over 6h (confirmed over
  30m); open a ticket at 3x over 1d (2h) or 1x over 3d (6h),
- the error budget left over the last 3 days (all a laptop's Prometheus keeps).

The short confirming window makes an alert stop soon after the problem does.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "deploy" / "charts" / "pitwall-observability" / "rules" / "pitwall.rules.yaml"
RUNBOOKS = "https://github.com/paighanutkarsh2410-lab/pitwall/blob/main/docs/runbooks"

WINDOWS = ("5m", "30m", "1h", "2h", "6h", "1d", "3d")
# (severity, burn rate, long window, short window)
BURNS = (
    ("page", 14.4, "1h", "5m"),
    ("page", 6.0, "6h", "30m"),
    ("ticket", 3.0, "1d", "2h"),
    ("ticket", 1.0, "3d", "6h"),
)


@dataclass(frozen=True)
class SLO:
    name: str
    objective: float
    description: str
    errors: str  # PromQL for bad events per second; $W is the window
    total: str  # PromQL for all events per second


def within(histogram: str, selector: str, seconds: float) -> tuple[str, str]:
    """Events slower than ``seconds`` (errors), and all events, from a latency histogram."""
    sel = f"{selector}," if selector else ""
    count = f"sum(rate({histogram}_count{{{selector}}}[$W]))"
    # Clients write the bound as "1.0" or "1"; match either.
    le = "|".join(sorted({f"{seconds:g}", str(float(seconds))}))
    fast = f'sum(rate({histogram}_bucket{{{sel}le=~"{le}"}}[$W]))'
    return f"({count} - {fast})", count


def freshness(stage: str, seconds: float) -> tuple[str, str]:
    return within("pitwall_event_freshness_seconds", f'stage="{stage}"', seconds)


SLOS = (
    SLO(
        "telemetry-freshness",
        0.99,
        "99% of car telemetry reaches the pit wall within 500 ms of being sent",
        *freshness("api", 0.5),
    ),
    SLO(
        "board-freshness",
        0.99,
        "99% of timing-board updates go out within 1 s of the oldest event in them",
        *freshness("timing", 1.0),
    ),
    SLO(
        "ingest-validity",
        0.999,
        "99.9% of events pass the schema (the rest are dead-lettered)",
        'sum(rate(pitwall_events_total{service="ingest",outcome="deadlettered"}[$W]))',
        'sum(rate(pitwall_events_total{service="ingest"}[$W]))',
    ),
    SLO(
        "api-availability",
        0.995,
        "99.5% of pit-wall API requests succeed",
        'sum(rate(pitwall_http_requests_total{service="api",code=~"5.."}[$W]))',
        'sum(rate(pitwall_http_requests_total{service="api"}[$W]))',
    ),
    SLO(
        "link-catch-up",
        0.99,
        "99% of trackside link outages are caught up within 60 s of the link returning",
        *within("pitwall_uplink_catchup_seconds", "", 60),
    ),
)


def ratio(slo: SLO, window: str) -> str:
    return f'pitwall:slo_error_ratio:rate{window}{{slo="{slo.name}"}}'


def slo_rules(slo: SLO) -> dict:
    budget = round(1 - slo.objective, 6)
    records = [
        {
            "record": f"pitwall:slo_error_ratio:rate{w}",
            # No errors at all means no error series: count that as zero, not as no data.
            "expr": f"(({slo.errors.replace('$W', w)}) or vector(0))"
            f" / ({slo.total.replace('$W', w)} > 0)",
            "labels": {"slo": slo.name},
        }
        for w in WINDOWS
    ]
    records += [
        {
            "record": "pitwall:slo_objective",
            "expr": f"vector({slo.objective})",
            "labels": {"slo": slo.name},
        },
        {
            "record": "pitwall:slo_error_budget_remaining:3d",
            "expr": f"1 - ({ratio(slo, '3d')} / {budget})",
            "labels": {"slo": slo.name},
        },
    ]
    alerts = []
    for severity in ("page", "ticket"):
        conditions = []
        for sev, burn, long, short in BURNS:
            if sev == severity:
                limit = f"{burn * budget:.6g}"
                conditions.append(
                    f"({ratio(slo, long)} > {limit} and {ratio(slo, short)} > {limit})"
                )
        title = "".join(part.capitalize() for part in slo.name.split("-"))
        alerts.append(
            {
                "alert": f"Pitwall{title}Budget{severity.capitalize()}",
                "expr": " or ".join(conditions),
                "labels": {"severity": severity, "slo": slo.name},
                "annotations": {
                    "summary": f"{slo.name}: error budget burning too fast ({severity})",
                    "description": f"SLO: {slo.description}. Objective {slo.objective:.1%}.",
                    "runbook_url": f"{RUNBOOKS}/{slo.name}.md",
                },
            }
        )
    return {"name": f"pitwall-slo-{slo.name}", "rules": records + alerts}


def symptom_alerts() -> dict:
    def alert(name: str, expr: str, wait: str, severity: str, summary: str, runbook: str) -> dict:
        return {
            "alert": name,
            "expr": expr,
            "for": wait,
            "labels": {"severity": severity},
            "annotations": {"summary": summary, "runbook_url": f"{RUNBOOKS}/{runbook}.md"},
        }

    return {
        "name": "pitwall-symptoms",
        "rules": [
            alert(
                "PitwallServiceDown",
                'up{namespace=~"pitwall|trackside"} == 0',
                "1m",
                "page",
                "{{ $labels.pod }} is not answering Prometheus",
                "service-down",
            ),
            alert(
                "PitwallConsumerLagHigh",
                "max by (service, topic) (pitwall_consumer_lag_messages) > 10000",
                "2m",
                "ticket",
                "{{ $labels.service }} is {{ $value }} messages behind on {{ $labels.topic }}",
                "consumer-lag",
            ),
            alert(
                "PitwallDeadLetters",
                'sum(increase(pitwall_events_total{outcome="deadlettered"}[5m])) > 0',
                "0m",
                "ticket",
                "Events are failing the schema and going to pitwall.deadletter",
                "ingest-validity",
            ),
            alert(
                "PitwallReplayBehind",
                "pitwall_replay_behind_seconds > 5",
                "2m",
                "ticket",
                "The replayer is {{ $value | humanizeDuration }} behind the race's schedule",
                "consumer-lag",
            ),
            alert(
                "PitwallLinkDown",
                "max(pitwall_uplink_link_up) == 0",
                "1m",
                "page",
                "The trackside link is down: the factory is getting no data (it is buffered)",
                "trackside-link",
            ),
            alert(
                "PitwallEventsLost",
                "sum(increase(pitwall_ingest_missing_events_total[10m])) > 0",
                "0m",
                "page",
                "{{ $value }} events never reached the factory: data was lost",
                "trackside-link",
            ),
            alert(
                "PitwallUplinkBacklog",
                "max(pitwall_uplink_backlog_messages) > 50000",
                "5m",
                "ticket",
                "{{ $value }} trackside events are waiting for the link",
                "trackside-link",
            ),
            alert(
                "PitwallPodRestarting",
                "increase(kube_pod_container_status_restarts_total"
                '{namespace=~"pitwall|trackside"}[15m]) > 2',
                "0m",
                "ticket",
                "{{ $labels.pod }} restarted {{ $value }} times in 15 minutes",
                "service-down",
            ),
        ],
    }


def render() -> str:
    groups = [slo_rules(slo) for slo in SLOS] + [symptom_alerts()]
    header = "# Generated by scripts/slos.py from the SLOs defined there. Do not edit by hand.\n"
    return header + yaml.safe_dump({"groups": groups}, sort_keys=False, width=1000)


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print(f"{OUTPUT} is out of date: run python scripts/slos.py", file=sys.stderr)
            return 1
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}: {len(SLOS)} SLOs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
