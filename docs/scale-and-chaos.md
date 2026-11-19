# Race weekend at scale: autoscaling, load tests and chaos GameDays

A race weekend is the worst time for anything to break: thousands of people watching at once, a
stream that never pauses, and no second chance at lap 40. Phase 5 tests Pitwall the way a team
would before one: load it until something gives, then break it on purpose and check that it
heals, that nothing is lost, and that the right alerts fire.

Three of the four GameDay experiments disproved their hypothesis the first time, as did the load
test once. Each found a real defect; each defect is fixed and the experiment re-run. That is the
point of running them.

## Autoscaling on what matters

[KEDA](https://keda.sh) scales on the signals that mean "falling behind", not on CPU:

| What | Scales on | Range |
|---|---|---|
| ingest | Kafka consumer lag on `pitwall.raw`: one pod per 2,000 events behind | 2–4 (6 partitions) |
| pitwall-api | browsers connected (`pitwall_websocket_clients`): one pod per 100 | 1–3 |
| uplink (trackside) | consumer lag on the trackside `pitwall.raw`: one pod per 5,000 | 1–3 |

The ScaledObjects target the Argo Rollouts directly, and Argo CD ignores `spec.replicas`, so a
scale-up is neither a release nor drift. timing and strategy don't scale: each copy rebuilds the
whole board, and they are cheap.

**Partitioning had to change first.** Kafka's default partitioner hashes the key, and 20 car
numbers over 6 partitions came out as [6, 7, 0, 4, 2, 2]: one partition empty, one ingest pod
idle however many were added. `bus.by_car` puts car *n* on partition *n* mod 6 (race-wide events
on partition 0): [4, 4, 3, 3, 4, 3].

## The load test

[`deploy/load/viewers.js`](../deploy/load/viewers.js) is a [k6](https://k6.io) script run inside
the cluster by [`scripts/loadtest.sh`](../scripts/loadtest.sh). It starts a replay at 20× (about
3,100 events a second through ingest, a whole race in six minutes) and ramps to 200 browsers
over two minutes, holds them for four, and ramps down. Each browser watches two cars' telemetry
for a 60-second stint, then reconnects as someone new. It passes when:

- over 99% of browsers connect, and over 99% receive a timing board;
- frames arrive at 4 a second or more on average (the screen sends 5), and no browser's 5th
  percentile drops below 3;
- the gap between frames is under 400 ms at p95 and 1 s at p99.

```bash
./scripts/loadtest.sh 200 20 4m      # viewers, replay speed, hold
```

| Run | Release | Browsers connected | Frames/s | Gap p99 | API CPU per 100 browsers |
|---|---|---|---|---|---|
| 1 | before | 100% | 4.86 | 230 ms | 0.30–0.67 cores |
| 2 | `feee5d3` | **0 of 138,176** | – | – | (crash-looping) |
| 3 | `5c1f48c` | 1,182 of 1,182 | 4.89 | 205 ms | 0.30–0.38 cores |

Run 1 passed; KEDA took ingest from 2 to 4 pods and the API from 1 to 2, freshness at the
browser held at 0.24 s p99, and 200 browsers pulled 3.4 GB in seven and a half minutes (about
10 KB a frame). It also showed the API spending most of its CPU encoding the same timing board
to JSON for every browser, about 1,000 times a second.

Run 2 was the fix for that, and it refused every browser. Moving code around had left
`@api.websocket("/ws")` decorating a new class instead of the handler, so `/ws` answered HTTP
500. The worse finding: **the canary passed it.** Every check in the analysis was a metric the
canary reported about itself, and none of them opened a WebSocket. Fixed three ways:

- the decorator, with a test that opens `/ws` and expects a board;
- `pitwall probe`, which connects to a pit wall the way the screen does;
- a **browsers** check in the api canary: a job runs the probe against the canary pod through
  an `api-canary` Service ([progressive-delivery.md](progressive-delivery.md#the-checks)).

Run 3: every board, strategy, positions and track update is encoded once per version however
many browsers watch; only each browser's telemetry is encoded for it. API CPU dropped and
steadied. Frame rate didn't move: it is set by the 200 ms send loop, not by CPU.

## GameDays

Each experiment is a [Chaos Mesh](https://chaos-mesh.org) resource in
[`deploy/chaos`](../deploy/chaos), with its hypothesis written at the top before it was run.
[`scripts/gameday.py`](../scripts/gameday.py) runs one against a race in progress: a settled
baseline (the browsers fresh three samples in a row), the fault, then recovery, sampling freshness at every stage, lag and the history backlog every
10 seconds. Its report:

- **lost**: events that never arrived (gaps in the per-car sequence numbers);
- **resent / replays dropped**: events that arrived twice and were dropped, by ingest and by the
  projectors;
- **duplicate history rows**: telemetry written to TimescaleDB twice;
- **doubled pits**: cars whose board shows more pit stops than strategy counted;
- **alerts fired**, separately from those already firing, and how many paged;
- **recovery**: seconds from the end of the fault until the browsers' freshness is back.

It exits non-zero if a promise in its experiment table is broken, so CI can run it.

```bash
python scripts/gameday.py --list
python scripts/gameday.py pod-kill
```

### 1. Kill the factory broker mid-race

*Hypothesis:* the trackside uplink buffers as if the link were cut; every factory service
reconnects on its own; nothing is lost.

**Held.** The factory had no broker for about 90 seconds. The trackside buffered, `PitwallLinkDown`
paged as designed, and when the broker came back the uplink re-sent what it hadn't had
confirmed: ingest dropped 20 events it had seen, and the projectors dropped 6. Nothing lost,
browsers fresh again 50 s after the broker returned.

### 2. Processors crash mid-race

*Hypothesis:* ingest's other pods take over a dead pod's partitions, timing rebuilds from the
log, nothing is lost, and nothing is counted twice.

The first run found nothing, and that was the finding: Chaos Mesh's `pod-kill` deletes the pod,
Kubernetes sends SIGTERM, and ingest commits its offsets and leaves the group cleanly. A crash
doesn't. The experiment now SIGKILLs the ingest container (`container-kill`).

**Then it failed.** Ingest committed offsets automatically every 5 seconds, so the pod that took
over re-read up to 5 seconds of events and sent them on again: 1,251 telemetry rows written
twice. Nothing lost, but downstream the timing board adds one per `pit.stop` event, and a
re-sent stop would have counted twice.

- **Projectors drop what they have applied before.** The per-car sequence numbers that ingest
  already used against the trackside's re-sends travel on to the downstream topics, so timing
  and strategy compare them too (per topic and key: a car's numbers interleave across topics
  and have gaps within one). `pitwall_projector_replays_total` counts them.
- **Ingest commits by hand every 0.5 s**, once what it read has reached its topics, from a
  background task so a slow broker doesn't pause the loop.

Re-run: 10 duplicate rows instead of 1,251, and timing and strategy each dropped the one
re-sent event that reached them. While the dead pod's partitions waited for the group to notice
(about 10 s), freshness at the browser reached 9.5 s; nothing paged.

### 3. A slow network to the broker

*Hypothesis:* 200 ms on everything the factory broker sends; batching hides most of it,
freshness rises by a few hundred milliseconds, nothing pages.

The first version added 50 ms of jitter, and the pit wall fell 30 seconds behind and paged. The
median event reached ingest 4 s late and the browser over 30 s late, while the trackside link
stayed under a second behind. netem's jitter reorders packets, and reordering collapsed TCP
throughput on the busiest connections (the API's, which carry all the telemetry). With the same
200 ms and no jitter, freshness held at 2 s (ingest) and 3–4 s (browser), steady, and nothing
paged. Real links rarely reorder like netem does, so the experiment uses a steady delay; the
result above is worth knowing anyway: on a link that reorders, Kafka's throughput, not its
latency, is what fails.

Committing from a background task (the fix for experiment 2) helped here too: each commit no
longer paused ingest for a round trip to the slow broker. Re-run with both: **held.** Freshness
peaked at 1 s at ingest and 2 s at the browser, steady for the whole three minutes, nothing
paged, nothing was lost, and everything was fresh again 40 s after the delay ended.

### 4. A slow database disk

*Hypothesis:* every TimescaleDB file operation takes 300 ms (a stand-in for a filling disk;
kind's local volumes have no quota to fill). History falls behind; live timing doesn't notice.

**Failed, twice.**

1. Ingest wrote history inline, between reading events and sending them on. Each write took
   2.5 s, and the pit wall fell 30 s behind. And `pg_isready` missed the liveness probe's
   default 1-second timeout, so Kubernetes restarted the database, which then replayed its
   write-ahead log on the same slow disk.
2. History moved to a writer task of its own, with ingest committing only as far as the writer
   had stored. Live freshness held at 0.10 s for two minutes while 7,500 rows queued, and then
   KEDA stepped in: it scales on the *committed* lag, which now included the history backlog,
   so it added two ingest pods. The rebalance handed partitions to pods that re-read and re-sent
   everything since the last commit: 7,873 duplicate rows and 30-second-old frames.

The lesson of the second failure: history is a side output, and nothing on the live path should
wait for it, including commits. Ingest now commits what has reached its topics regardless of
history. The writer retries in order while the database is away; past 200,000 waiting rows it
gives up on the oldest, and on shutdown it gets 5 seconds to drain. Rows lost either way are
counted (`pitwall_history_dropped_rows_total`), and `pitwall_history_backlog_rows` shows how far
behind it is. History can now have a gap after a crash during a database outage; live timing
can't be held up by one. The liveness probe allows 5 s and six misses.

Re-run: **held.** For the three minutes of slow disk, freshness at the browser stayed at
0.10 s, exactly as before the fault, while history fell 7,400 rows behind. The database still
stopped answering for long enough to be restarted (`PitwallPodRestarting` raised a ticket, as
designed), and the writer drained the backlog when it came back: no rows lost, none written
twice. Restarting a database on a slow disk doesn't help it, but on a disk this slow, it no
longer answering at all is a fair reason.

(One run in between "failed" on a measurement: the first sample after the fault showed 3.3 s at
the browser, the tail of a release that had finished 30 s before the baseline started, still
inside Prometheus's one-minute window. The runner now waits for a settled baseline.)

## The nightly suite

[`.github/workflows/chaos.yml`](../.github/workflows/chaos.yml) runs every night (and on
demand) on a throwaway kind cluster: [`scripts/chaos-suite.sh`](../scripts/chaos-suite.sh)
installs what the experiments need from this repository's charts at the versions `deploy/apps`
pins (no Argo CD, Grafana, Loki or Tempo, to fit a CI runner), then runs the two kill
experiments. A broken hypothesis fails the workflow, and the reports are kept as artifacts.

```bash
./scripts/chaos-suite.sh                           # pod-kill broker-kill
./scripts/chaos-suite.sh db-io-latency             # or any of gameday.py --list
```

## Where this departs from the plan, and why

- **"Fill a disk" is a slow disk.** kind's local-path volumes have no size limit to fill, and a
  slow disk tests the same thing: what happens to live timing when the database struggles.
- **No hard-crash test of the API.** Browsers reconnect on their own; the interesting failures
  were all upstream of it.
- **History is at-least-once while ingest lives, best-effort across a crash during a database
  outage.** Exactly-once history would mean committing offsets in the same transaction as the
  rows, which ties the live path to the database again.
