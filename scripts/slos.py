"""Pitwall's SLOs as code, and the Prometheus rules generated from them.

    python scripts/slos.py   writes deploy/charts/pitwall-observability/rules/pitwall.rules.yaml
                             and docs/slos.md, the page that explains them

A test fails if either file is out of date.

Each SLO is a ratio of bad events to all events. From it come:

- recording rules for the error ratio over 5m, 30m, 1h, 2h, 6h, 1d and 3d,
- the multi-window, multi-burn-rate alerts from Google's SRE workbook (chapter 5): page when the
  error budget burns 14.4x too fast over 1h (confirmed over 5m) or 6x over 6h (confirmed over
  30m); open a ticket at 3x over 1d (2h) or 1x over 3d (6h),
- the error budget left over the last 3 days (all a laptop's Prometheus keeps).

The short confirming window makes an alert stop soon after the problem does.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "deploy" / "charts" / "pitwall-observability" / "rules" / "pitwall.rules.yaml"
PAGE = ROOT / "docs" / "slos.md"
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
    # Burn-rate paging needs volume: an SLO over a handful of events a day (link outages) would
    # page on one slow event. Those get the ticket alerts only.
    page: bool = True


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
        page=False,  # rare events; the outage itself pages (PitwallLinkDown)
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
    for severity in ("page", "ticket") if slo.page else ("ticket",):
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
                'max(pitwall_uplink_link_up{app_kubernetes_io_name="uplink"}) == 0',
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
                'max(pitwall_uplink_backlog_messages{app_kubernetes_io_name="uplink"}) > 50000',
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


def budget(objective: float, days: int) -> str:
    """The error budget as time: how long every event could be bad."""
    minutes = (1 - objective) * days * 24 * 60
    return f"{minutes / 60:.1f} h" if minutes >= 120 else f"{minutes:.0f} min"


def placeholders(text: str) -> str:
    """Alertmanager templates as readable placeholders: {{ $labels.pod }} becomes {pod}."""
    text = re.sub(r"\{\{ \$labels\.(\w+) \}\}", r"{\1}", text)
    text = re.sub(r"\{\{ \$value \| humanizeDuration \}\}", "{time}", text)
    return re.sub(r"\{\{ \$value \}\}", "{n}", text)


def render_page() -> str:
    """docs/slos.md: every SLO and alert, from the same definitions as the rules."""
    alerts = [
        rule for group in yaml.safe_load(render())["groups"] for rule in group["rules"]
        if "alert" in rule
    ]  # fmt: skip
    lines = [
        "# SLOs and alerts",
        "",
        "<!-- Generated by scripts/slos.py from the SLOs defined there. Do not edit by hand. -->",
        "",
        "What Pitwall promises the people watching the pit wall, measured from the services' own",
        "metrics. Each SLO's error budget is what it may miss; the alerts fire on how fast that",
        "budget is being spent, not on single bad moments.",
        "",
        "| SLO | Objective | Promise | Error budget, 30 days | Pages |",
        "|---|---|---|---|---|",
    ]
    for slo in SLOS:
        lines.append(
            f"| [{slo.name}](runbooks/{slo.name}.md) | {slo.objective:.1%} | {slo.description} "
            f"| {budget(slo.objective, 30)} | {'yes' if slo.page else 'no, tickets only'} |"
        )
    lines += [
        "",
        "A budget is how long every event could be bad; it can as well be spent as a long stretch",
        "of a few late ones. A laptop's Prometheus keeps 3 days, so the dashboards show what is",
        "left of the budget over 3 days.",
        "",
        "## When the budget burns",
        "",
        "Google's SRE workbook, chapter 5: alert when the budget burns several times too fast over",
        "a long window, confirmed over a short one so the alert stops soon after the problem does.",
        "",
        "| Severity | Burn rate | Over | Confirmed over | Spends |",
        "|---|---|---|---|---|",
    ]
    hours = {"5m": 1 / 12, "30m": 0.5, "1h": 1, "2h": 2, "6h": 6, "1d": 24, "3d": 72}
    for severity, burn, long, short in BURNS:
        spent = burn * hours[long] / (30 * 24)
        lines.append(
            f"| {severity} | {burn:g}x | {long} | {short} | {spent:.0%} of a 30-day budget |"
        )
    lines += [
        "",
        "## Every alert",
        "",
        "| Alert | Severity | After | What it means | Runbook |",
        "|---|---|---|---|---|",
    ]
    for rule in alerts:
        annotations = rule["annotations"]
        runbook = annotations["runbook_url"].rsplit("/", 1)[-1]
        summary = placeholders(annotations["summary"]).replace("|", "\\|")
        after = {"0m": "at once"}.get(rule.get("for", ""), rule.get("for", "burn rate"))
        lines.append(
            f"| `{rule['alert']}` | {rule['labels']['severity']} | {after} "
            f"| {summary} | [{runbook[:-3]}](runbooks/{runbook}) |"
        )
    lines += [
        "",
        "Pages are for a person now; tickets are for the next working day. On a laptop neither",
        "goes anywhere: they show in Alertmanager and on Grafana's **Pitwall · Race health**.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    outputs = {OUTPUT: render(), PAGE: render_page()}
    if "--check" in sys.argv:
        stale = [
            path for path, text in outputs.items()
            if not path.exists() or path.read_text(encoding="utf-8") != text
        ]  # fmt: skip
        for path in stale:
            print(f"{path} is out of date: run python scripts/slos.py", file=sys.stderr)
        return 1 if stale else 0
    for path, text in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"Wrote {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
