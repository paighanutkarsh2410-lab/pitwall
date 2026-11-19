"""Runs one GameDay experiment (deploy/chaos/<name>.yaml) against a race in progress and reports
what happened: freshness at every stage, lag, lost and duplicated events, restarts, the board's
consistency, and which alerts fired.

Usage: python scripts/gameday.py <experiment> [--observe 180] [--speed 1] [--json report.json]
       python scripts/gameday.py --list

Needs kubectl pointed at the cluster, and Prometheus and the pit wall reachable (PITWALL_PROM,
PITWALL_URL). Exits 1 if a check the experiment promises fails (its `expect` below), so the
nightly suite can run it in CI.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROM = os.environ.get("PITWALL_PROM", "http://prometheus.pitwall.localtest.me:8080")
URL = os.environ.get("PITWALL_URL", "http://localhost:8080")
NS = "pitwall"

# What each experiment promises. Seconds are p99 freshness at the browser (the api stage).
EXPERIMENTS = {
    "broker-kill": {"observe": 150, "expect": {"lost": 0, "recover_s": 240}},
    "pod-kill": {"observe": 120, "expect": {"lost": 0, "recover_s": 180, "doubled_pits": 0}},
    "broker-latency": {"observe": 200, "expect": {"lost": 0, "worst_api_s": 2.0}},
    "db-io-latency": {"observe": 200, "expect": {"lost": 0, "worst_api_s": 2.0}},
}

FRESH = (
    "histogram_quantile(0.99, sum by (le) "
    '(rate(pitwall_event_freshness_seconds_bucket{{stage="{}"}}[1m])))'
)


def prom(expr: str) -> list:
    url = f"{PROM}/api/v1/query?" + urllib.parse.urlencode({"query": expr})
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return json.load(response)["data"]["result"]
    except Exception as error:  # a missed sample is not a failed experiment
        print(f"  (prometheus: {error})", file=sys.stderr)
        return []


def value(expr: str) -> float | None:
    result = prom(expr)
    if not result:
        return None
    number = float(result[0]["value"][1])
    return None if number != number else number  # NaN: no data


def kubectl(*args: str, check: bool = True) -> str:
    done = subprocess.run(["kubectl", *args], capture_output=True, text=True)
    if check and done.returncode:
        raise SystemExit(f"kubectl {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout


def counters(seconds: float) -> dict[str, int]:
    """How much each counter grew over the last ``seconds``. increase() copes with pods that
    were replaced meanwhile (a plain sum would lose the dead pod's count)."""
    w = f"{max(60, int(seconds))}s"

    def grew(metric: str) -> int:
        return round(value(f"sum(increase({metric}[{w}]))") or 0)

    return {
        "lost": grew("pitwall_ingest_missing_events_total"),
        "resent_dropped": grew("pitwall_ingest_duplicates_total"),
        # Projectors are replaced in some experiments and rebuild from the log; increase() can't
        # see a new pod's first count, so this is their running total instead.
        "replays_dropped": round(
            value(f"sum(max_over_time(pitwall_projector_replays_total[{w}]))") or 0
        ),
        "restarts": grew(f'kube_pod_container_status_restarts_total{{namespace="{NS}"}}'),
        "history_rows": grew("pitwall_history_rows_total"),
        "history_dropped": grew("pitwall_history_dropped_rows_total"),
    }


def firing() -> set[str]:
    return {
        f"{r['metric']['alertname']} ({r['metric'].get('severity', '?')})"
        for r in prom('ALERTS{alertstate="firing"}')
    }


def sample() -> dict:
    return {
        "fresh_ingest": value(FRESH.format("ingest")),
        "fresh_board": value(FRESH.format("timing")),
        "fresh_api": value(FRESH.format("api")),
        "lag": value('sum(pitwall_consumer_lag_messages{service="ingest"})'),
        "history_s": value(
            "histogram_quantile(0.99, sum by (le) (rate(pitwall_history_write_seconds_bucket[1m])))"
        ),
        "history_backlog": value("sum(pitwall_history_backlog_rows)"),
        "events_s": value('sum(rate(pitwall_events_total{service="ingest",outcome="routed"}[1m]))'),
    }


def show(t: float, phase: str, s: dict) -> None:
    def f(x, digits=2):
        return "-" if x is None else f"{x:.{digits}f}"

    print(
        f"+{t:5.0f}s {phase:<9} fresh p99 ingest={f(s['fresh_ingest'])} board={f(s['fresh_board'])}"
        f" api={f(s['fresh_api'])} | lag={f(s['lag'], 0)} events/s={f(s['events_s'], 0)}"
        f" | history write p99={f(s['history_s'])} backlog={f(s['history_backlog'], 0)}",
        flush=True,
    )


def replay_running() -> bool:
    return (value("max(pitwall_replay_speed)") or 0) > 0


def start_replay(speed: float) -> None:
    body = json.dumps({"race": "2024-sao-paulo", "speed": speed, "from_lap": 1}).encode()
    request = urllib.request.Request(
        f"{URL}/api/replay", body, {"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        print(f"Started a replay at {speed:g}x ({response.status})")


def state() -> dict:
    with urllib.request.urlopen(f"{URL}/api/state", timeout=20) as response:
        return json.load(response)


def doubled_pits() -> int:
    """Cars whose board shows more pit stops than the strategy model counted. The board adds one
    per pit.stop event; strategy keeps a set of pit laps, so a repeated event can't inflate it.
    Read twice, a few seconds apart, so a stop that only one of them has seen yet doesn't count."""
    counts = []
    for attempt in range(2):
        now = state()
        strategy = (now.get("strategy") or {}).get("cars") or {}
        counts.append(sum(
            1 for car in (now.get("board") or {}).get("cars", [])
            if (car.get("pits") or 0) > (strategy.get(str(car["car"]), {}).get("pits") or 0)
        ))  # fmt: skip
        if attempt == 0:
            time.sleep(5)
    return min(counts)


def duplicate_rows(seconds: float) -> int | None:
    """Telemetry rows written twice during the experiment: the same run, car and moment again.
    Counted over the time window, not one run: a replay can end and another start meanwhile."""
    sql = (
        "SELECT count(*) - count(DISTINCT (run, car, t)) FROM telemetry "
        f"WHERE received > now() - interval '{int(seconds)} seconds'"
    )
    out = kubectl(
        "-n", NS, "exec", "timescaledb-0", "--",
        "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql, check=False,
    )  # fmt: skip
    try:
        return int(out.strip())
    except ValueError:
        return None


def alerts_since(seconds: float) -> set[str]:
    window = f"{max(60, int(seconds))}s"
    result = prom(
        f'max by (alertname, severity) (max_over_time(ALERTS{{alertstate="firing"}}[{window}]))'
    )
    return {f"{r['metric']['alertname']} ({r['metric'].get('severity', '?')})" for r in result}


def run(name: str, observe: float, speed: float) -> dict:
    spec = EXPERIMENTS[name]
    manifest = ROOT / "deploy" / "chaos" / f"{name}.yaml"
    print(f"GameDay: {name}\n" + "".join(
        f"  {line[2:]}\n" for line in manifest.read_text().splitlines() if line.startswith("# ")
    ))  # fmt: skip
    if not replay_running():
        start_replay(speed)
        time.sleep(30)
    began = time.time()
    already = firing()  # alerts from before the experiment aren't its doing
    base = []
    for _ in range(3):
        base.append(sample())
        show(time.time() - began, "baseline", base[-1])
        time.sleep(15)

    print(f"Injecting {manifest.relative_to(ROOT)}", flush=True)
    kubectl("apply", "-f", str(manifest))
    injected = time.time()
    worst: dict[str, float] = {}
    try:
        while time.time() - injected < observe:
            s = sample()
            show(time.time() - began, "chaos", s)
            for k, v in s.items():
                if v is not None and k.startswith(("fresh", "lag", "history")):
                    worst[k] = max(worst.get(k, 0), v)
            time.sleep(10)
    finally:
        kubectl("delete", "-f", str(manifest), "--ignore-not-found", "--wait=false", check=False)
    ended = time.time()
    print("Experiment over; waiting for recovery", flush=True)

    # Recovered: the browsers' freshness is back within 1.5x the baseline (and under 1 s).
    base_api = max((b["fresh_api"] or 0) for b in base) or 0.25
    target = max(1.0, 1.5 * base_api)
    recovered_after = None
    healthy = 0
    while time.time() - ended < 300:
        s = sample()
        show(time.time() - began, "recovery", s)
        healthy = healthy + 1 if s["fresh_api"] is not None and s["fresh_api"] <= target else 0
        if healthy >= 2:
            recovered_after = time.time() - ended
            break
        time.sleep(10)

    grew = counters(time.time() - began)
    report = {
        "experiment": name,
        "chaos_seconds": round(ended - injected),
        "recover_s": None if recovered_after is None else round(recovered_after),
        "worst": {k: round(v, 2) for k, v in worst.items()},
        "worst_api_s": round(worst.get("fresh_api", 0), 2),
        **grew,
        "duplicate_history_rows": duplicate_rows(time.time() - began),
        "doubled_pits": doubled_pits(),
        "alerts_fired": sorted(alerts_since(time.time() - began) - already),
        "alerts_already_firing": sorted(already),
    }
    failed = []
    for check, limit in spec["expect"].items():
        got = report.get(check)
        if got is None or got > limit:
            failed.append(f"{check}={got} (allowed {limit})")
    report["failed"] = failed
    print("\nReport\n" + json.dumps(report, indent=2))
    print("\nHypothesis " + ("HELD" if not failed else "FAILED: " + "; ".join(failed)))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("experiment", nargs="?", choices=sorted(EXPERIMENTS))
    parser.add_argument("--observe", type=float, help="seconds of chaos (default per experiment)")
    parser.add_argument("--speed", type=float, default=1.0, help="replay speed if none is running")
    parser.add_argument("--json", help="also write the report here")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if args.list or not args.experiment:
        for name, spec in EXPERIMENTS.items():
            print(f"{name:<15} observe {spec['observe']} s, expects {spec['expect']}")
        return 0
    report = run(
        args.experiment, args.observe or EXPERIMENTS[args.experiment]["observe"], args.speed
    )
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2))
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
