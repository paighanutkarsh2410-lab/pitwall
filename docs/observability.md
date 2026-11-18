# Observability and SLOs

Pitwall measures itself the way a pit wall measures a car: what matters to the people watching is
how *fresh* the data on the screen is, so that is what the SLOs are about.

## What runs

| | |
|---|---|
| **Prometheus** + Alertmanager | Scrapes every pod (`prometheus.io/scrape` annotations), evaluates the SLO rules and alerts |
| **Grafana** | The **Pitwall · Race health** dashboard, with Prometheus, Loki and Tempo linked: a log line's trace id opens the trace |
| **Loki** | Every Pitwall pod's logs: JSON, one object per line, with the trace id when there is one |
| **Tempo** | Traces: one event followed from the replayer through ingest, timing or strategy, to the API |
| **OpenTelemetry Collector** | One per node: receives the services' traces over OTLP, reads the pods' logs from the node |

All five are pinned upstream Helm charts with values in [`deploy/observability`](../deploy/observability),
deployed by Argo CD like everything else. Pitwall's own rules and dashboards are a small chart,
[`pitwall-observability`](../deploy/charts/pitwall-observability), generated from code.

## The freshness clock

The replayer stamps every message with the time it sent it, in a `pitwall-sent` header that
every hop forwards. Each stage observes how old the data is when it handles it, in
`pitwall_event_freshness_seconds{stage=…}`:

| Stage | Measured when |
|---|---|
| `ingest` | a raw event is consumed |
| `timing`, `strategy` | a snapshot is published: the age of the oldest event in it |
| `api` | a car's telemetry reaches the API (from there, a browser frame within 200 ms) |

Events a projector replays from the log after a restart don't count: that is catching up on
history, not lateness.

## SLOs

Defined in code in [`scripts/slos.py`](../scripts/slos.py), which generates the Prometheus rules (a
test fails if the committed rules are out of date):

| SLO | Objective | Bad event |
|---|---|---|
| telemetry-freshness | 99% | telemetry reaching the API more than 500 ms after it was sent |
| board-freshness | 99% | a timing-board update going out more than 1 s after its oldest event |
| ingest-validity | 99.9% | an event failing the schema (dead-lettered) |
| api-availability | 99.5% | an API request answered with a 5xx |

Each gets the multi-window, multi-burn-rate alerts from Google's SRE workbook:

| Severity | Burn rate | Long window | Confirmed over |
|---|---|---|---|
| page | 14.4x | 1 h | 5 min |
| page | 6x | 6 h | 30 min |
| ticket | 3x | 1 d | 2 h |
| ticket | 1x | 3 d | 6 h |

Plus symptom alerts: a pod Prometheus can't scrape, consumer lag over 10,000 messages, any dead
letter, the replayer falling behind schedule, a pod restarting. Every alert links to a
[runbook](runbooks/README.md).

## The first drill

An 800 ms delay injected into pitwall-api's telemetry handling (`POST /faults`, enabled in the
local environment only and refused through the ingress):

- telemetry p99 went from about 0.1 s to 4.9 s;
- `PitwallTelemetryFreshnessBudgetPage` and `…Ticket` fired within a minute and reached
  Alertmanager with their runbook links;
- with the delay removed, p99 was back to 0.05 s at once and the 5-minute error ratio fell from
  0.25 to 0.08 over four minutes; the page cleared about 11 minutes after the fix, as the drill's
  errors left the 30-minute window;
- the two ticket alerts stayed open, as tickets should: their 6-hour window still holds the
  drill's errors, so they close within six hours. A slow burn is a ticket, not a page.

Why within a minute and not the textbook nine: Prometheus had been running for about 40 minutes,
so its "6-hour" window held only those 40 minutes and the 6x path tripped almost at once. On a
long-running system the 14.4x path takes about nine minutes of total failure to page.

## Found by running it

- **Grafana starved the race.** At a 384 MiB limit Grafana 13's garbage collector thrashed and used
  10.9 CPU cores; telemetry p99 rose to 4 s before any fault was injected. Now 768 MiB and a
  one-core limit, so a dashboard tool can never take the node again.
- **A rule that matched nothing.** The Python client labels a bucket `le="1.0"`, not `le="1"`;
  the board-freshness SLO matched no series. The rules now accept both spellings.
- **No errors looked like no data.** With no dead letters there is no dead-letter series, so the
  ingest-validity ratio was empty, not zero. Errors now default to 0.
- **Rules that never reloaded.** The config reloader watched only `/etc/config`; it now watches
  the rules too.

## Look at it

```bash
kubectl -n observability port-forward svc/grafana 3300:80      # http://localhost:3300
```

or http://grafana.pitwall.localtest.me:8080. Viewing needs no login; the admin password is in the
`grafana-admin` Secret. Prometheus is at http://prometheus.pitwall.localtest.me:8080.
