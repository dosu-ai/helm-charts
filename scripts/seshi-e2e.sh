#!/usr/bin/env bash
# Installs charts/seshi on the current Kubernetes context (a throwaway kind cluster) against a
# RustFS bucket, and checks it the way an operator would: the pod starts with service links
# off, `helm test` passes, the bootstrap Job leaves the first admin token and the org key in a
# Secret (and a second admin init is refused), the worker runs, and
# a session uploaded with the org key is stored, read back and found by search, before and
# after the pod is replaced. The chart's ci/kind-values.yaml adds an exclude drop-in, so an
# upload from that repository must be refused.
#
# Needs kubectl, helm, aws (the AWS CLI) and bun:
#   kind create cluster --name seshi-chart && scripts/seshi-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS="${NS:-seshi}"
RELEASE=seshi # on purpose: a Service named seshi is what service links would turn into SESHI_*
WORK="$(mktemp -d)"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "seshi-e2e: $*" >&2
  kubectl -n "$NS" get pods -o wide >&2 || true
  kubectl -n "$NS" logs "deploy/$RELEASE" --tail=50 >&2 || true
  exit 1
}

forward() { # forward <service> <local port> <remote port>
  kubectl -n "$NS" port-forward "svc/$1" "$2:$3" >/dev/null 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$2") 2>/dev/null; then return 0; fi
    sleep 1
  done
  fail "port-forward to $1 never answered"
}

echo "--- a bucket"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" apply -f "$ROOT/test/seshi/rustfs.yaml" >/dev/null
kubectl -n "$NS" rollout status deploy/rustfs --timeout=180s
forward rustfs 19000 9000
AWS_ACCESS_KEY_ID=rustfsadmin AWS_SECRET_ACCESS_KEY=rustfsadmin AWS_DEFAULT_REGION=us-east-1 \
  aws --endpoint-url http://127.0.0.1:19000 s3 mb s3://seshi-e2e
kubectl -n "$NS" create secret generic seshi-store \
  --from-literal=access-key-id=rustfsadmin --from-literal=secret-access-key=rustfsadmin

echo "--- install"
helm install "$RELEASE" "$ROOT/charts/seshi" -n "$NS" \
  -f "$ROOT/charts/seshi/ci/kind-values.yaml" "$@" --wait --timeout 5m ||
  fail "helm install did not become ready"
helm test "$RELEASE" -n "$NS" || fail "helm test failed"

echo "--- the pod's SESHI_* environment"
seshi_env="$(kubectl -n "$NS" exec "deploy/$RELEASE" -- sh -c 'env | grep ^SESHI_ | cut -d= -f1')"
[ "$seshi_env" = "SESHI_CONFIG" ] || fail "unexpected SESHI_* variables: $seshi_env"

echo "--- the bootstrap Job's Secret"
secret="$RELEASE-initial-admin"
kubectl -n "$NS" get secret "$secret" >/dev/null || fail "no Secret $secret after install"
[ "$(kubectl -n "$NS" get configmap "$RELEASE-bootstrap" -o jsonpath='{.data.status}')" = initialized ] ||
  fail "the bootstrap Job did not report initialized"
org_key="$(kubectl -n "$NS" get secret "$secret" -o jsonpath='{.data.org-key}' | base64 -d)"
[ -n "$org_key" ] || fail "$secret has no org-key"
printf '{"org_key":{"token":"%s"}}' "$org_key" >"$WORK/init.json"
kubectl -n "$NS" get job "$RELEASE-bootstrap" >/dev/null 2>&1 && fail "the bootstrap Job was left behind"
kubectl -n "$NS" get role "$RELEASE-bootstrap" >/dev/null 2>&1 && fail "the bootstrap Role was left behind"

echo "--- admin init by hand now refuses"
set +e
kubectl -n "$NS" exec "deploy/$RELEASE" -- seshi admin init --json >/dev/null 2>&1
again=$?
set -e
[ "$again" -eq 6 ] || fail "a second admin init exited $again, not 6"

echo "--- the worker"
for _ in $(seq 1 30); do
  if kubectl -n "$NS" exec "deploy/$RELEASE" -- seshi workers status --json |
    grep -q '"state": "running"'; then
    break
  fi
  sleep 1
done || true
kubectl -n "$NS" exec "deploy/$RELEASE" -- seshi workers status --json |
  grep -q '"state": "running"' || fail "the worker is not running"

echo "--- upload, read back, search"
forward "$RELEASE" 17200 7200
bun "$ROOT/scripts/seshi-smoke.ts" http://127.0.0.1:17200 "$WORK/init.json" upload ||
  fail "smoke test failed"

echo "--- a new pod"
kill "${PIDS[-1]}" 2>/dev/null || true
kubectl -n "$NS" rollout restart "deploy/$RELEASE" >/dev/null
kubectl -n "$NS" rollout status "deploy/$RELEASE" --timeout=180s
forward "$RELEASE" 17201 7200
bun "$ROOT/scripts/seshi-smoke.ts" http://127.0.0.1:17201 "$WORK/init.json" search ||
  fail "search after a restart failed"

echo "seshi-e2e: ok"
