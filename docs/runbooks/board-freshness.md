# Board freshness

**SLO:** 99% of timing events (laps, positions, gaps, pit stops, tyres) are on a published timing
board within 1 s of being sent.

**What it means.** The timing screen, gaps and the box-this-lap projection are stale. Strategy
calls would be made on old gaps: the most expensive kind of stale data on a pit wall.

## Confirm

1. **Race health**, *Freshness by stage*, the **timing** line. Compare with **ingest**: if ingest is
   fresh, the timing service is the bottleneck.
2. *Consumer lag* for `timing` on `pitwall.timing` and `pitwall.race`.
3. `kubectl -n pitwall logs deploy/timing --tail=50`.

## Likely causes and fixes

| Cause | Sign | Fix |
|---|---|---|
| An injected fault | *Injected delay* shows `timing` | `POST /faults {"delay_ms": 0}` on timing |
| timing restarted and is replaying the log | Lag spikes then falls; the pod is minutes old | Wait: it rebuilds the board from the topic, by design |
| Many old runs retained in `pitwall.timing` | Long catch-up after every restart | Lower the topic's retention in `pitwall/bus.py` |
| ingest is late too | The ingest line is also late | See [telemetry-freshness](telemetry-freshness.md) |
