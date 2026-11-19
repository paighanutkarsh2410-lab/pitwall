# Trackside link

**Alerts:** `PitwallLinkDown` (page: the factory has received nothing for a minute),
`PitwallEventsLost` (page: events never reached the factory), `PitwallUplinkBacklog` (ticket:
over 50,000 events waiting at the track for 5 minutes).

**What it means.** The trackside keeps streaming into its own Redpanda whatever the link does, so
a link outage loses nothing by itself: the backlog waits at the track and is sent when the link
returns. Meanwhile the factory's pit wall is frozen at the moment the link went down, and every
freshness SLO burns. `PitwallEventsLost` is different and worse: data is gone.

## Confirm

1. Grafana, **Race health**, row *Trackside link*: *Link*, *Waiting at the track*, *Through the
   link*, *Events lost*.
2. The link itself, as the uplink sees it:

   ```bash
   kubectl -n trackside port-forward svc/uplink 9002:8080 &
   curl -s localhost:9002/link     # Toxiproxy's state, toxics, and the last recovery
   ```

3. `kubectl -n trackside logs deploy/uplink --tail=30`: "lost the factory", "Link back after",
   "Caught up".

## Likely causes and fixes

| Cause | Sign | Fix |
|---|---|---|
| A drill cut the link | `/link` says `"enabled": false` | `curl -X POST localhost:9002/link -H 'Content-Type: application/json' -d '{"enabled": true}'` |
| A drill slowed or narrowed it | `/link` lists a `latency` or `bandwidth` toxic | The same: `{"enabled": true}` clears every toxic |
| The factory's Redpanda is down | `redpanda-0` in `pitwall` not ready | Fix the factory broker; the uplink reconnects by itself |
| The uplink is down | `deploy/uplink` not ready | Restart it; it resumes from the last position the factory confirmed |

## Events lost

The factory numbers every car's events and counts any gap. Gaps mean the trackside's retention
(2 hours for `pitwall.raw`) ran out before the link returned, or a topic was deleted. Check how
long the link was down; if outages that long are expected, raise `pitwall.raw`'s retention in
`pitwall/bus.py`. Lost events can't be recovered from the stream; for a replay, restart it.
