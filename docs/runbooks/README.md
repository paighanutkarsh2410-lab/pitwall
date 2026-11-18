# Runbooks

Every Pitwall alert links to one of these. Each says what the alert means for the people watching
the pit wall, how to confirm it, and what to do.

| Runbook | Alerts |
|---|---|
| [telemetry-freshness](telemetry-freshness.md) | `PitwallTelemetryFreshnessBudgetPage`, `…Ticket` |
| [board-freshness](board-freshness.md) | `PitwallBoardFreshnessBudgetPage`, `…Ticket` |
| [ingest-validity](ingest-validity.md) | `PitwallIngestValidityBudget…`, `PitwallDeadLetters` |
| [api-availability](api-availability.md) | `PitwallApiAvailabilityBudget…` |
| [consumer-lag](consumer-lag.md) | `PitwallConsumerLagHigh`, `PitwallReplayBehind` |
| [service-down](service-down.md) | `PitwallServiceDown`, `PitwallPodRestarting` |

Useful everywhere:

```bash
kubectl -n pitwall get pods                          # what's running, what's restarting
kubectl -n pitwall logs deploy/<service> --tail=50   # a service's recent log
curl -s localhost:8080/api/replay                    # what the replayer is doing
```

Grafana's **Pitwall · Race health** dashboard shows every SLO, the freshness of each stage, the
consumer lag and the logs side by side. In Explore, pick Tempo and search for
`{ resource.service.namespace = "pitwall" }` to follow one event through every service.

## Drills

Every service accepts an injected delay (only where `PITWALL_FAULTS` is on, as in the local
environment), to rehearse these runbooks:

```bash
kubectl -n pitwall port-forward deploy/api 9001:8080 &
curl -X POST localhost:9001/faults -H 'Content-Type: application/json' -d '{"delay_ms": 800}'
curl -X POST localhost:9001/faults -H 'Content-Type: application/json' -d '{"delay_ms": 0}'
```
