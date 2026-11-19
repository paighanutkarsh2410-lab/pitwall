# Link catch-up

**SLO:** 99% of trackside link outages are caught up within 60 s of the link returning: the
factory is receiving current data again (the newest event forwarded is under a second old).

**What it means.** The link is back, but the backlog is draining too slowly: the pit wall shows
the race catching up instead of the race. A short outage that takes minutes to recover from
costs more than the outage itself.

## Confirm

**Race health**, row *Trackside link*: *Catch-up, worst (24h)*, and *Through the link* (events
confirmed per second against events produced at the track). The uplink's log says how long each
outage lasted and how long it took to catch up.

## Likely causes and fixes

| Cause | Sign | Fix |
|---|---|---|
| The link is still slow or narrow (a drill left a toxic) | `GET /link` lists a toxic | `POST /link {"enabled": true}` (see [trackside-link](trackside-link.md)) |
| The factory can't take the rate | ingest's consumer lag grows while the uplink catches up | Add ingest replicas (canaried) in `deploy/charts/pitwall/values.yaml` |
| A very long outage | The backlog was very large | Expected: catch-up time grows with the outage. Confirm with *Link downtime* |
