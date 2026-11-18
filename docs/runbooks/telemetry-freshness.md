# Telemetry freshness

**SLO:** 99% of car telemetry reaches the pit wall (pitwall-api) within 500 ms of the replayer
sending it.

**What it means.** The pit wall's speed traces, gauges and car positions lag the race. Engineers
are looking at the past: a lock-up or a car slowing is seen late.

## Confirm

1. Grafana, **Race health**, *Freshness by stage*. If **ingest** is fresh and **api** is late, the
   delay is between them (Redpanda or the API). If **ingest** is already late, it is upstream (the
   replayer or Redpanda).
2. *Consumer lag*: a growing `pitwall.telemetry` lag for `api` means the API can't keep up.
3. Tempo: open a recent `replayer.send` trace and see which span is long.

## Likely causes and fixes

| Cause | Sign | Fix |
|---|---|---|
| An injected fault (a drill) | *Injected delay* panel is non-zero | `POST /faults {"delay_ms": 0}` on that service |
| The API is CPU-starved | `api` lag grows, CPU near its limit | Raise its CPU in `deploy/charts/pitwall/values.yaml`, or add a replica |
| Replay speed too high for the laptop | Trouble started with a speed change | Lower the speed; 20x and above is a stress test |
| Redpanda slow | Every stage late at once | Check `redpanda-0`'s log and memory |

Afterwards: the 5-minute window clears within minutes of the fix, and the page alert stops then.
