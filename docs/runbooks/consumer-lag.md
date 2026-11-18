# Consumer lag

**Alerts:** `PitwallConsumerLagHigh` (a service is over 10,000 messages behind for 2 minutes) and
`PitwallReplayBehind` (the replayer can't send at the requested speed).

**What it means.** A service can't keep up with the stream. The freshness SLOs will follow.

## Confirm

**Race health**, *Consumer lag* by service and topic, and *Events per second*. Lag that grows
steadily is a service too slow for the rate; lag that spikes and falls is a restart catching up.

## Likely causes and fixes

| Cause | Fix |
|---|---|
| Replay speed above what the laptop can process | Lower the speed; at `0` (flat out) lag is expected |
| An injected fault | `POST /faults {"delay_ms": 0}` |
| One slow service | Raise its resources in the chart; ingest can also take more replicas (they share partitions) |
| Redpanda short of memory | Raise `redpanda.memory` in `deploy/charts/pitwall-data/values.yaml` |
