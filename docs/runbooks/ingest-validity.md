# Ingest validity

**SLO:** 99.9% of events pass the event schema. The rest go to `pitwall.deadletter` with the
reason, and are missing from the pit wall.

**What it means.** Some cars' data, laps or flags are not being shown. One bad event never stops
the race, but many mean a producer and the schema disagree.

## Confirm

```bash
kubectl -n pitwall exec redpanda-0 -- rpk topic consume pitwall.deadletter -n 5 -f '%v\n'
kubectl -n pitwall logs deploy/ingest | grep Dead-lettered | tail
```

Each dead letter carries the field that failed and the original event.

## Likely causes and fixes

| Cause | Fix |
|---|---|
| A race file built by an older or newer replayer | `pitwall fetch <race> --force`, then `pitwall validate <race>` |
| A schema change shipped to ingest before the producer (or the reverse) | Roll back the newer side; change the schema compatibly ([events.md](../events.md)) |
| OpenF1 changed a field's type | Fix the converter in `pitwall/race.py`, add the case to the tests, re-fetch |
