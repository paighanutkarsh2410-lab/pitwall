# Trackside and factory: a link that can fail

A team's data starts at the circuit: the cars stream to a small data centre in the garage, and
from there to the factory, over a long-haul link that can slow down or drop. Pitwall now has the
same shape.

```
 TRACKSIDE (namespace trackside)                 FACTORY (namespace pitwall)
 replayer ──▶ Redpanda ──▶ uplink ══▶ Toxiproxy ══▶ Redpanda ──▶ ingest ──▶ timing, strategy, api
 (the cars)   (the buffer)          (the link)     (uplink listener)
```

- **The trackside streams locally whatever the link does.** Its own Redpanda is the buffer:
  while the link is down, everything waits there (`pitwall.raw` keeps two hours).
- **The uplink** forwards every message unchanged: key, value and headers, so the replayer's send
  time still measures end-to-end freshness. It commits its trackside position only once the
  factory has confirmed a batch. When the link breaks, it rewinds to the last confirmed position
  and sends everything again when the link returns.
- **The link is Toxiproxy**, in front of a second listener on the factory's Redpanda. That
  listener advertises Toxiproxy's address, so a Kafka client that connects through the link is
  told to keep talking through it: there is no way round the link.

## Nothing lost, nothing twice

Re-sending after an outage is at-least-once: some events arrive twice. To make it exactly-once
*in effect*, the replayer numbers each key's events (a car, or `race`) per run, in a
`pitwall-keyseq` header. Factory ingest:

- **drops** any number it has already seen (a duplicate), and
- **counts** any jump in the numbers as missing events, so "nothing lost" is measured.

A key's events always land on one partition and so one ingest pod. When partitions move between
pods (a canary joining, a restart), the pod forgets its numbers for that moment rather than
calling the jump a gap.

## The drill: cut the link for 60 seconds mid-race

`POST /link {"enabled": false}` on the uplink (drill switch on, never through the ingress), 60
seconds, then `{"enabled": true}`. São Paulo 2024 at real speed, lap 3.

| | Result |
|---|---|
| Outage, as measured | 70.3 s (from the last confirmed batch to the first after the link returned) |
| What the factory saw | The pit wall froze at 23 min 35 s of race time, then jumped forward 75 s when the link returned |
| Waiting at the track | The backlog grew to about **10,200 events** |
| Catch-up | **1.1 s** from the link returning to the factory receiving current data |
| Events lost | **0** (18,309 events crossed the link during the drill) |
| Duplicates | Re-sent events were recognised and dropped (1 to 20 per drill run) |
| Alerts | `PitwallLinkDown` went pending but didn't fire: the uplink notices a cut within about 8 s, and the alert waits a minute, so a 60-second outage stays just under it. A longer one pages. |

It took four runs to get here; each found a measurement that lied:

| Run | What it got wrong | Fix |
|---|---|---|
| 1 | The backlog read 1 throughout the outage: the gauge only updated after a *successful* send | Report the backlog on its own clock |
| 2 | The backlog still froze: cached high-water marks only move when the consumer fetches, and during an outage it doesn't | Ask the trackside broker for its end offsets |
| 2 | Ingest had counted 24 (later about 3,000) "missing" events that were never lost: after a rebalance, a pod got cars back and compared against stale numbers | Forget the numbers whenever partitions move. Zero false gaps through every rollout since |
| 3 | Catch-up read 187 s for a backlog that drained in seconds: "nothing left unread" almost never holds on a live stream | Caught up = a confirmed batch with no event older than 2 s |
| 4 | Correct throughout | |

In every run, no event was lost.

## The link's SLO, and why it doesn't page

**link-catch-up:** 99% of outages are caught up within 60 s of the link returning. It has error
budget and ticket alerts but, unlike the freshness SLOs, **no page**. Burn-rate paging needs
volume: with three recoveries on record, the one bad (mis-measured) reading made up a third of all
events and paged. For rare events a single slow recovery shouldn't wake anyone, and the outage
itself already pages through `PitwallLinkDown`. That bad reading from run 3 stays in Prometheus
and burns this SLO's budget until it ages out of the windows (up to three days).

Alerts: `PitwallLinkDown` (page), `PitwallEventsLost` (page: data loss), `PitwallUplinkBacklog`
(ticket). Runbooks: [trackside-link](runbooks/trackside-link.md), [link-catch-up](runbooks/link-catch-up.md).
Grafana's *Race health* dashboard has a **Trackside link** row: link up, events lost, duplicates
dropped, downtime, worst catch-up, the backlog, throughput at each end, and the age of data
crossing the link.

## Run a drill

```bash
kubectl -n trackside port-forward svc/uplink 9002:8080 &
curl -s localhost:9002/link                                                   # state
curl -X POST localhost:9002/link -H 'Content-Type: application/json' -d '{"enabled": false}'     # cut
curl -X POST localhost:9002/link -H 'Content-Type: application/json' -d '{"latency_ms": 300}'    # slow
curl -X POST localhost:9002/link -H 'Content-Type: application/json' -d '{"bandwidth_kbps": 200}' # narrow
curl -X POST localhost:9002/link -H 'Content-Type: application/json' -d '{"enabled": true}'      # restore
```

## Where this departs from the plan, and why

| The plan said | What runs | Why |
|---|---|---|
| A second kind cluster for the trackside | A `trackside` namespace in the same cluster, with its own Redpanda | Docker has 7.5 GB and the cluster already used 5.3 GB; a second node plus its broker wouldn't fit. The two sites share nothing but the link: separate brokers, separate namespaces, and the factory reachable only through Toxiproxy |
| MirrorMaker 2 | A small Python uplink | MirrorMaker 2 runs on the JVM (half a gigabyte or more). The uplink is about 250 lines, and it measures what this phase is about: backlog, outages, catch-up |

With more memory, the trackside chart deploys unchanged into a second cluster: only the link's
upstream address (`link.factory`) changes.
