# API availability

**SLO:** 99.5% of pit-wall API requests succeed (no 5xx).

**What it means.** The race library, lap history, race trace or replay controls are failing. The
live WebSocket can still be fine.

## Confirm

1. **Race health**, *API errors by route* shows which route fails.
2. `kubectl -n pitwall logs deploy/api --tail=100`.

## Likely causes and fixes

| Route | Usual cause | Fix |
|---|---|---|
| `/api/replay`, `/api/races`, `/api/catalog/*` | The replayer is down or restarting (502) | See [service-down](service-down.md) for `replayer` |
| `/api/catalog/*` | OpenF1 unreachable or rate-limiting | Wait; a season is cached for 10 minutes once fetched |
| `/api/laps/*`, `/api/trace` | TimescaleDB down | Check `timescaledb-0`; the pool reconnects by itself |
