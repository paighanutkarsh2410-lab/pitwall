#!/usr/bin/env bash
# Runs the race-weekend load test inside the cluster: a k6 Job with deploy/load/viewers.js.
#
# Usage: ./scripts/loadtest.sh [viewers] [speed] [hold]     (defaults: 200 20 4m)
# Prints k6's summary at the end; the Job and its ConfigMap are removed afterwards.
# Watch Grafana's Race health dashboard while it runs: freshness, lag, scaling.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VIEWERS="${1:-200}"
SPEED="${2:-20}"
HOLD="${3:-4m}"
NS=load
K6_IMAGE=grafana/k6:2.3.0
NAME="viewers-$(date +%H%M%S)"

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" create configmap "$NAME" --from-file=viewers.js="$ROOT/deploy/load/viewers.js" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: $NAME
  namespace: $NS
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 12345
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: k6
          image: $K6_IMAGE
          args: [run, --quiet, /scripts/viewers.js]
          env:
            - { name: VIEWERS, value: "$VIEWERS" }
            - { name: SPEED, value: "$SPEED" }
            - { name: HOLD, value: "$HOLD" }
          resources:
            requests: { cpu: 500m, memory: 256Mi }
            limits: { memory: 768Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: scripts, mountPath: /scripts }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: scripts
          configMap: { name: $NAME }
        - name: tmp
          emptyDir: {}
YAML

echo "Load test $NAME: $VIEWERS viewers, replay at ${SPEED}x, holding $HOLD"
kubectl -n "$NS" wait --for=condition=ready pod -l job-name="$NAME" --timeout=180s >/dev/null || true
kubectl -n "$NS" logs -f "job/$NAME" || true
kubectl -n "$NS" wait --for=condition=complete --timeout=60s "job/$NAME" >/dev/null 2>&1 \
  && echo "k6 thresholds: PASSED" || echo "k6 thresholds: FAILED (see above)"
kubectl -n "$NS" delete configmap "$NAME" >/dev/null
