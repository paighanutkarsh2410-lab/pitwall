#!/usr/bin/env bash
# The nightly chaos suite: a trimmed GameDay on a throwaway kind cluster.
#
# Installs what the experiments need straight from this repository's charts (no Argo CD, no
# Grafana, Loki or Tempo): Redpanda and TimescaleDB, the services as Argo Rollouts, the
# trackside site and its link, KEDA, Prometheus with Pitwall's SLO rules, and Chaos Mesh.
# Chart versions are read from deploy/apps, so the suite tests what the laptop runs.
# Then it runs scripts/gameday.py for each experiment and exits non-zero if any hypothesis fails.
#
# Usage: ./scripts/chaos-suite.sh [experiment...]     (default: pod-kill broker-kill)
# Needs docker, kind, kubectl, helm, python, and a downloaded race in ~/.pitwall/races
# (pitwall fetch 2024-sao-paulo). Reports go to $PITWALL_REPORTS (default: ./chaos-reports).
# PITWALL_KEEP_CLUSTER=1 leaves the cluster up afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"
CLUSTER="${PITWALL_CLUSTER:-pitwall-chaos}"
RACES_DIR="${PITWALL_HOME:-$HOME/.pitwall}"
REPORTS="${PITWALL_REPORTS:-$ROOT/chaos-reports}"
EXPERIMENTS=("$@")
[ ${#EXPERIMENTS[@]} -eq 0 ] && EXPERIMENTS=(pod-kill broker-kill)

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
# The version an Argo CD Application in deploy/apps pins for an upstream chart.
pinned() { awk -v chart="$1" '$1 == "chart:" && $2 == chart { found = 1 }
  found && $1 == "targetRevision:" { print $2; exit }' "$DEPLOY"/apps/*.yaml; }

for tool in docker kind kubectl helm python; do
  command -v "$tool" >/dev/null || { echo "Missing $tool." >&2; exit 1; }
done
[ -d "$RACES_DIR/races/2024-sao-paulo" ] || {
  echo "No race in $RACES_DIR/races: run 'pitwall fetch 2024-sao-paulo' first." >&2; exit 1; }

PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [ "${PITWALL_KEEP_CLUSTER:-0}" != 1 ]; then kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

step "kind cluster '$CLUSTER'"
cat <<YAML | kind create cluster --config - --wait 120s
apiVersion: kind.x-k8s.io/v1alpha4
kind: Cluster
name: $CLUSTER
nodes:
  - role: control-plane
    extraMounts:
      - { hostPath: "$(host_path "$RACES_DIR")", containerPath: /pitwall-data, readOnly: true }
YAML
kubectl config use-context "kind-$CLUSTER" >/dev/null

step "Platform: Argo Rollouts, KEDA, Chaos Mesh, Prometheus"
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null
helm repo add kedacore https://kedacore.github.io/charts >/dev/null
helm repo add chaos-mesh https://charts.chaos-mesh.org >/dev/null
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo update >/dev/null
helm install argo-rollouts argo/argo-rollouts --version "$(pinned argo-rollouts)" \
  -n argo-rollouts --create-namespace -f "$DEPLOY/platform/argo-rollouts.yaml" --wait
helm install keda kedacore/keda --version "$(pinned keda)" \
  -n keda --create-namespace -f "$DEPLOY/platform/keda.yaml" --wait
helm install chaos-mesh chaos-mesh/chaos-mesh --version "$(pinned chaos-mesh)" \
  -n chaos-mesh --create-namespace -f "$DEPLOY/platform/chaos-mesh.yaml" --wait
kubectl create namespace observability >/dev/null
helm install pitwall-observability "$DEPLOY/charts/pitwall-observability" -n observability
helm install prometheus prometheus-community/prometheus --version "$(pinned prometheus)" \
  -n observability -f "$DEPLOY/observability/prometheus.yaml" \
  --set server.ingress.enabled=false --set server.persistentVolume.enabled=false \
  --set alertmanager.enabled=false --wait

step "Pitwall: data, services, trackside"
kubectl create namespace pitwall >/dev/null
PASSWORD="$(python -c 'import secrets; print(secrets.token_hex(24))')"
kubectl -n pitwall create secret generic pitwall-db \
  --from-literal=POSTGRES_PASSWORD="$PASSWORD" \
  --from-literal=PITWALL_DB_URL="postgresql://postgres:$PASSWORD@timescaledb:5432/postgres" >/dev/null
unset PASSWORD
ENV="$DEPLOY/env/local"
helm install pitwall-data "$DEPLOY/charts/pitwall-data" -n pitwall -f "$ENV/data.yaml"
NO_OTEL=(--set observability.otlpEndpoint= --set logos.hostPath=)
helm install pitwall "$DEPLOY/charts/pitwall" -n pitwall -f "$ENV/pitwall.yaml" "${NO_OTEL[@]}"
helm install pitwall-trackside "$DEPLOY/charts/pitwall-trackside" -n trackside --create-namespace \
  -f "$ENV/pitwall.yaml" -f "$ENV/trackside.yaml" "${NO_OTEL[@]}"
for ns in pitwall trackside; do
  kubectl -n "$ns" wait --for=condition=ready pod --all --timeout=600s
done

step "Port-forwards to Prometheus and the pit wall"
kubectl -n observability port-forward svc/prometheus-server 9090:80 >/dev/null 2>&1 &
PIDS+=($!)
kubectl -n pitwall port-forward svc/api 8088:8080 >/dev/null 2>&1 &
PIDS+=($!)
export PITWALL_PROM=http://localhost:9090 PITWALL_URL=http://localhost:8088
for _ in $(seq 1 60); do
  curl -fs "$PITWALL_URL/api/state" >/dev/null && curl -fs "$PITWALL_PROM/-/ready" >/dev/null && break
  sleep 5
done
echo "Letting the race and the SLO rules warm up"
sleep 120

mkdir -p "$REPORTS"
failed=()
for experiment in "${EXPERIMENTS[@]}"; do
  step "GameDay: $experiment"
  if ! python "$ROOT/scripts/gameday.py" "$experiment" --json "$REPORTS/$experiment.json" \
      | tee "$REPORTS/$experiment.log"; then
    failed+=("$experiment")
  fi
done

step "Summary"
for experiment in "${EXPERIMENTS[@]}"; do
  if [[ " ${failed[*]} " == *" $experiment "* ]]; then echo "  FAILED  $experiment"; else echo "  held    $experiment"; fi
done
[ ${#failed[@]} -eq 0 ]
