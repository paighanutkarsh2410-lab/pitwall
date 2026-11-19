# Progressive delivery: canaries that roll themselves back

Every release of ingest, timing, strategy and the API goes out as a **canary** with
[Argo Rollouts](https://argoproj.github.io/rollouts/):

1. One pod of the new version starts next to the stable version.
2. A 20-second warm-up.
3. **Analysis**: about two and a half minutes of checks on the canary's own metrics, read from
   Prometheus. Every Pitwall metric carries the pod's `rollouts_pod_template_hash` label, and
   Argo Rollouts passes the canary's hash in, so each check reads the canary and nothing else.
4. Pass: the canary is promoted and replaces stable. Fail: it is **rolled back automatically**;
   stable never stopped serving. A canary that never becomes ready (a crash loop) is rolled
   back too, at the progress deadline.

The replayer is not canaried. It *is* the race, a single producer; it stays a one-at-a-time
Deployment.

## Canaries for a stream, not a website

A web canary splits requests. Stream services don't receive requests, so each kind gets the
equivalent:

| Service | The canary's share | How |
|---|---|---|
| **ingest** | A share of the partitions | Joins the `ingest` consumer group next to the two stable pods and is assigned partitions like any member |
| **timing**, **strategy** | A full copy, side by side | Each copy reads every partition itself (no group), rebuilds the race from the log, publishes only once caught up, and stamps each snapshot with its producer |
| **api** | A share of the browsers | The Service selects stable and canary pods alike |

Splitting partitions would break timing and strategy: each keeps the whole race in memory and
needs every car. Running full copies instead means two boards are published during a canary,
and that makes the best check possible: **compare them**.

## The checks

[`templates/analysis.yaml`](../deploy/charts/pitwall/templates/analysis.yaml):

| Check | Services | Passes when |
|---|---|---|
| restarts | all | the canary's containers never restarted |
| working | all | the canary is processing events (a stuck canary is not a healthy one) |
| freshness | all | the canary's p99 freshness meets its stage's SLO: 0.5 s (ingest, api), 1 s (timing), 3 s (strategy publishes once a second) |
| dead-letters | ingest | under 0.1% of the canary's events fail the schema |
| agreement | timing | under 1% of the canary's car gaps differ from the stable board |
| errors | api | under 1% of the canary's requests return a 5xx |

**Agreement** is exact, not statistical. pitwall-api compares each board with the other copy's,
car by car, but only for gaps that came from the same timing update (each car carries the race
time of its last interval event). Two correct copies therefore agree on every comparison,
however their publishing interleaves. A canary that is fast and stable but *wrong* is caught.

## The drills

Each bad release shipped the way a real one would: a commit to the local environment's values
(`services.<name>.defect`, [`deploy/env/local/pitwall.yaml`](../deploy/env/local/pitwall.yaml)),
deployed by Argo CD. `PITWALL_DEFECT` makes the build misbehave on purpose. Recovery was a
`git revert`.

| Bad release | What gave it away | Caught after the push | Other checks |
|---|---|---|---|
| **Slow ingest** (every batch waits 900 ms) | freshness p99 **4.96 s** against 0.5 s, twice | 1 min 48 s | restarts, dead letters and throughput (59 events/s) all fine |
| **Timing with silently wrong gaps** (50% too big) | **94%** of its gaps disagreed with the stable board, twice | 1 min 53 s | freshness (0.49 s) and restarts fine: only agreement could catch it |
| **Crashing strategy** (dies 20 s after starting) | **2 restarts** at the first check | 1 min 23 s | freshness was 4.91 s too: two signals |

In every case the canary pod was removed, the stable pods kept serving throughout, and the
revert brought the Rollout back to Healthy in about 10 seconds, with no new canary needed (the
spec matched stable again). The remaining 6% of "agreeing" gaps in the second drill are the
ones a 1.5x error leaves unchanged: the leader's 0.0 and the "+1 LAP" text gaps.

A good release goes through the same gate. The first real canary, the release that introduced
all this, passed every check on all four services and was promoted after 4 min 46 s.

## Run a drill

```bash
# In deploy/env/local/pitwall.yaml:
services:
  timing:
    defect: wrong-gaps     # or: slow, crash (any service)
```

Commit and push; Argo CD deploys it (CI skips environment-only commits). Watch:

```bash
kubectl -n pitwall get rollouts -w
kubectl -n pitwall get analysisruns
```

Then `git revert` the commit.

## What a canary costs

A canary limits the damage of a bad release; it doesn't remove it. While the slow ingest canary
was being analysed, the events on its partitions really were late (telemetry p99 peaked at
4.9 s) for about two minutes. After the three drills the freshness SLOs showed it: 3% of
telemetry and 2.4% of board updates late over six hours, enough to spend their three-day error
budgets (together with the previous day's alerting drill), and to open their *ticket* alerts,
the slow-burn kind. No page fired: the burn was short.

Ways to make a canary cheaper, at a price:

| Lever | Gain | Cost |
|---|---|---|
| Check sooner (shorter `initialDelay`, `interval`) | Bad releases caught faster | Noisier verdicts from less data |
| A smaller share (more stable replicas) | Fewer events exposed | More pods on a laptop |
| A shadow canary (the canary's output not shown) | No user impact at all | It no longer proves the release under real exposure |

## Found by running it

- **The first comparison had nothing to compare.** During the release that introduced producer
  stamps, the old stable version didn't stamp its boards, so the agreement check had no data
  and passed by default. It was only ever a one-off, but "passes when there is no data" is a
  design choice to be aware of: the *working* check exists so that "no data" can't hide a
  canary that does nothing.
- **A canary must not join a projector's consumer group.** Two members would split the
  partitions, and each would publish a board with half the cars. Hence: no group for
  projectors, and a copy publishes only once it has caught up on the log.
