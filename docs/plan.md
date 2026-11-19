# Pitwall: the plan

**Goal:** a race-telemetry platform that replays real Grands Prix and streams them from a
trackside site to a factory site on Kubernetes, and that measures its own health, rolls back bad
deploys by itself and survives the failures thrown at it.

**The demo in one sentence:** lap 40, a broken release is caught at 5% of traffic and rolled back
automatically; then the trackside link is cut for 60 seconds and not one data point is lost.

## Ground rules

- **Free.** Everything runs on one laptop with kind; no cloud bill.
- **Sized for 8 GB of Docker memory.** The factory is a normal kind cluster, trackside a tiny
  second one. Stop other clusters while working on Pitwall.
- **Real data, replayed.** Historical races from [OpenF1](https://openf1.org), downloaded once.
  Replays are repeatable, which also makes them load tests.
- **No official branding in anything public.** Driver and team names appear as data. Team logos
  can be used locally from `assets/private/` (ignored by git); everything public shows
  team-colour badges instead.
- **The platform is the star.** The pit-wall screen is one strong page, not an app.
- **Every phase ends in something demonstrable.**

## Phase 0: Foundations and data ✅

- Repository layout, CI from day one (lint, tests, image build, Trivy, cosign-signed images)
- `pitwall fetch`: downloads a race from OpenF1 into time-ordered events, resumable
- `pitwall replay`: streams it at 1x, 10x, 50x or flat out, from any lap, filtered by type or car
- A versioned event format with a generated JSON Schema ([events.md](events.md))

*Done when* `pitwall replay 2024-sao-paulo --speed 10` streams a real race and CI is green.

## Phase 1: The pipeline on one cluster ✅

- Redpanda with topics for telemetry, timing and race control; the replayer gets a Kafka sink
- Services: **ingest** (validate, tag), **timing** (laps, gaps, positions), **strategy** (stints,
  pit loss, tyre-wear estimate), **pitwall-api** (live state over WebSocket)
- TimescaleDB for history
- The pit-wall screen: timing tower, track map, one car's telemetry traces; team-colour badges,
  or logos from `assets/private/` when present
- Helm charts, deployed by Argo CD from a GitOps repo

*Done when* a replayed race is live on the pit-wall screen, deployed by Argo CD.

## Phase 2: Observability and SLOs ✅

- OpenTelemetry tracing carried through every Kafka hop (one data point, car to screen)
- Prometheus, Loki, Tempo and Grafana
- SLOs as code: freshness (99% of telemetry on the pit wall within 500 ms), correctness (gaps
  match an offline calculation), API availability; multi-window burn-rate alerts
- A "Race health" dashboard; a runbook linked from every alert

*Done when* a slow point on a dashboard leads to its trace, and an injected delay fires the
right alert.

## Phase 3: Self-healing deploys ✅

- Argo Rollouts canaries for every service, analysed against the SLO metrics
- Canaries for stream consumers: canary pods join the consumer group, take a share of the
  partitions, and are compared with the stable version
- Three rehearsed bad releases: slow, silently wrong gaps, crashing

*Done when* each bad release is caught and rolled back with no human involved.

## Phase 4: Trackside and factory

- A minimal trackside cluster ingests and buffers in its own Redpanda; MirrorMaker 2 replicates
  to the factory
- The link runs through Toxiproxy: add latency, cap bandwidth, cut it
- Buffering, catch-up and no duplicates; catch-up time is a measured SLO

*Done when* a 60-second link cut mid-race loses nothing and the catch-up shows on a dashboard.

## Phase 5: Race weekend at scale

- KEDA scales processors on consumer lag
- k6 load tests: replays at 20x with hundreds of WebSocket viewers
- Chaos Mesh GameDays: kill a broker mid-race, delete pods, add latency, fill a disk
- A written postmortem per experiment; a trimmed chaos suite runs nightly in CI

*Done when* the GameDay runs every experiment and the SLOs hold or the alerts fire as designed.

## Phase 6: Polish and showcase

- README with architecture diagram, GIF and video; SLO and runbook pages
- The demo video: the lap-40 rollback and the trackside link cut
- A free public demo: a static page replaying a recorded race in the browser
- `./pitwall up`, one command to run it all

## If time runs short

Phases 0–3 plus 6 are the strong minimum: a real race streaming live, full tracing and SLOs,
and automatic rollback on video. Phases 4 and 5 make it exceptional.
