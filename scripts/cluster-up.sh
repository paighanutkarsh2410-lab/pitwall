#!/usr/bin/env bash
# Brings up Pitwall on this machine:
#   kind cluster -> Traefik -> database secret -> Argo CD -> the app of apps, which deploys
#   Redpanda, TimescaleDB and the services from this repository's deploy/ folder.
#
# Usage: ./scripts/cluster-up.sh [--no-gitops]
#   --no-gitops   stop before Argo CD takes over (to install the charts by hand while developing)
# Then open http://pitwall.localtest.me:8080 (Argo CD: http://argocd.pitwall.localtest.me:8080).
# Re-running is safe. Runs in Git Bash on Windows, and on macOS or Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"
CLUSTER=pitwall
HTTP_PORT="${PITWALL_HTTP_PORT:-8080}"
RACES_DIR="${PITWALL_HOME:-$HOME/.pitwall}"
LOGOS_DIR="$ROOT/assets/private"
GITOPS=1
[ "${1:-}" = "--no-gitops" ] && GITOPS=0

# Argo CD v3.5.7, pinned to the commit of its signed release tag and checked by SHA-256.
ARGOCD_COMMIT=6d732962f61a99c2a0f221fd26b9aac7c83bcf18
ARGOCD_SHA256=09bfbb9041b4a8503c6e4fa22cf41c403fa62be17526de353648a4551f5beb77
TRAEFIK_CHART_VERSION=42.3.2

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
# Docker on Windows wants C:/... paths, not Git Bash's /c/...
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

for tool in docker kind kubectl helm curl openssl; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install it and re-run." >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start it and re-run." >&2; exit 1; }

step "Cluster '$CLUSTER' (port $HTTP_PORT)"
mkdir -p "$RACES_DIR" "$LOGOS_DIR"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  cat <<YAML | kind create cluster --config - --wait 120s
apiVersion: kind.x-k8s.io/v1alpha4
kind: Cluster
name: $CLUSTER
nodes:
  - role: control-plane
    extraPortMappings:
      - { containerPort: 30080, hostPort: $HTTP_PORT, listenAddress: "127.0.0.1", protocol: TCP }
    extraMounts:
      # Races downloaded on the laptop are there for the replayer, and the other way round.
      - { hostPath: "$(host_path "$RACES_DIR")", containerPath: /pitwall-data }
      # Team logos for local use only (assets/private/ is ignored by Git).
      - { hostPath: "$(host_path "$LOGOS_DIR")", containerPath: /pitwall-logos, readOnly: true }
YAML
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

step "Traefik ingress (chart $TRAEFIK_CHART_VERSION)"
helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo update traefik >/dev/null
helm upgrade --install traefik traefik/traefik --version "$TRAEFIK_CHART_VERSION" \
  --namespace traefik --create-namespace -f "$DEPLOY/traefik/values.yaml" --wait --timeout 5m >/dev/null

step "Database credentials"
kubectl create namespace pitwall --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if ! kubectl -n pitwall get secret pitwall-db >/dev/null 2>&1; then
  PASSWORD="$(openssl rand -hex 24)"
  kubectl -n pitwall create secret generic pitwall-db \
    --from-literal=POSTGRES_PASSWORD="$PASSWORD" \
    --from-literal=PITWALL_DB_URL="postgresql://postgres:$PASSWORD@timescaledb:5432/postgres" >/dev/null
  echo "Created a random database password in the pitwall-db Secret (it is in no file)."
else
  echo "Keeping the existing pitwall-db Secret."
fi

if [ "$GITOPS" = 0 ]; then
  echo; echo "Stopping before Argo CD (--no-gitops). Install the charts in deploy/charts by hand."
  exit 0
fi

step "Argo CD"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/install.yaml" \
  "https://raw.githubusercontent.com/argoproj/argo-cd/$ARGOCD_COMMIT/manifests/install.yaml"
echo "$ARGOCD_SHA256  $WORK/install.yaml" | sha256sum --check --quiet
echo "Manifest verified"
cp "$DEPLOY/argocd/kustomization.yaml" "$DEPLOY/argocd/ingress.yaml" "$WORK/"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl kustomize "$WORK" | kubectl apply --server-side --force-conflicts -f - >/dev/null
for d in argocd-server argocd-repo-server argocd-redis; do
  kubectl -n argocd rollout status "deployment/$d" --timeout=300s >/dev/null
done
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=300s >/dev/null

step "GitOps: Argo CD deploys Pitwall from github.com/.../pitwall/deploy"
kubectl apply -f "$DEPLOY/argocd/root.yaml" >/dev/null
echo "Waiting for the platform to sync (Redpanda, TimescaleDB, then the services)…"
for _ in $(seq 1 90); do
  ready="$(kubectl -n pitwall get deploy -o jsonpath='{range .items[*]}{.status.readyReplicas}{" "}{end}' 2>/dev/null | wc -w)"
  [ "$ready" -ge 5 ] && break
  sleep 5
done
kubectl -n pitwall get pods

cat <<DONE

Pitwall:  http://pitwall.localtest.me:$HTTP_PORT
Argo CD:  http://argocd.pitwall.localtest.me:$HTTP_PORT  (admin; password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)
DONE
