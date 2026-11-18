# Service down

**Alerts:** `PitwallServiceDown` (Prometheus can't scrape a pod for a minute) and
`PitwallPodRestarting` (more than two restarts in 15 minutes).

## Confirm

```bash
kubectl -n pitwall get pods
kubectl -n pitwall describe pod <pod>        # events: OOMKilled, failed probes, image pulls
kubectl -n pitwall logs <pod> --previous     # the log of the crashed container
```

## Likely causes and fixes

| Sign | Cause | Fix |
|---|---|---|
| `OOMKilled` | Memory limit too low for the load | Raise the limit in `deploy/charts/pitwall/values.yaml`, through Git (Argo CD reverts manual edits) |
| Readiness failing; `/readyz` says the worker failed | Redpanda or TimescaleDB unreachable | Fix those first; services reconnect with backoff on their own |
| `ImagePullBackOff` | The promoted image isn't in GHCR | Check CI's image job for that commit |
| Trouble right after an Argo CD sync | A bad deploy | Revert the commit; Argo CD rolls it back |
