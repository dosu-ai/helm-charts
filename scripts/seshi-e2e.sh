#!/usr/bin/env bash
# Installs charts/seshi on a throwaway kind cluster against a bucket in the cluster, and checks
# it the way an operator would: the pod starts with service links off, `helm test` passes, the
# bootstrap Job leaves the first admin token and the org key in a Secret (and a second admin
# init is refused), the worker runs, and a session uploaded with the org key is stored, read
# back and found by search, before and after the pod is replaced. The values add an exclude
# drop-in, so an upload from that repository must be refused.
#
# STORE picks the bucket:
#   s3 (default) RustFS, ci/kind-values.yaml; also the bootstrap's reinstall cases
#   az           Azurite, ci/kind-az-values.yaml; also the runtime config in the bucket, which
#                must outlive the pod
#   gs           fake-gcs-server, ci/kind-gs-values.yaml; also the mounted service account key
#
# Needs kubectl, helm, bun, curl, and for s3 aws (the AWS CLI). It works only in the kind
# cluster it names (CONTEXT, kind-seshi-chart by default), never in whatever context happens to
# be current:
#   kind create cluster --name seshi-chart && STORE=az scripts/seshi-e2e.sh
set -euo pipefail

STORE="${STORE:-s3}"
case "$STORE" in
  s3) VALUES=kind-values.yaml ;;
  az) VALUES=kind-az-values.yaml ;;
  gs) VALUES=kind-gs-values.yaml ;;
  *) echo "seshi-e2e: STORE must be s3, az or gs, not $STORE" >&2; exit 2 ;;
esac

CONTEXT="${CONTEXT:-kind-seshi-chart}"
case "$CONTEXT" in
  kind-*) ;;
  *) echo "seshi-e2e: CONTEXT must be a kind cluster's (kind-<name>), not $CONTEXT" >&2; exit 2 ;;
esac
kubectl config get-contexts "$CONTEXT" >/dev/null 2>&1 ||
  { echo "seshi-e2e: no context $CONTEXT; kind create cluster --name ${CONTEXT#kind-}" >&2; exit 2; }
k() { kubectl --context "$CONTEXT" "$@"; }
h() { helm --kube-context "$CONTEXT" "$@"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# A namespace for each store, so the three can run one after another in one cluster.
NS="${NS:-seshi-$STORE}"
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
  k -n "$NS" get pods -o wide >&2 || true
  k -n "$NS" logs "deploy/$RELEASE" --tail=50 >&2 || true
  exit 1
}

forward() { # forward <service> <local port> <remote port>
  if (exec 3<>"/dev/tcp/127.0.0.1/$2") 2>/dev/null; then
    fail "port $2 is already in use (a port-forward left from an earlier run?)"
  fi
  # exec, so $! is kubectl itself: killing a subshell would leave the forward running.
  (exec kubectl --context "$CONTEXT" -n "$NS" port-forward "svc/$1" "$2:$3" >/dev/null 2>&1) &
  PIDS+=("$!")
  for _ in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$2") 2>/dev/null; then return 0; fi
    sleep 1
  done
  fail "port-forward to $1 never answered"
}

echo "--- a bucket ($STORE)"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
case "$STORE" in
  s3)
    k -n "$NS" apply -f "$ROOT/test/seshi/rustfs.yaml" >/dev/null
    k -n "$NS" rollout status deploy/rustfs --timeout=180s
    forward rustfs 19000 9000
    AWS_ACCESS_KEY_ID=rustfsadmin AWS_SECRET_ACCESS_KEY=rustfsadmin AWS_DEFAULT_REGION=us-east-1 \
      aws --endpoint-url http://127.0.0.1:19000 s3 mb s3://seshi-e2e
    k -n "$NS" create secret generic seshi-store \
      --from-literal=access-key-id=rustfsadmin --from-literal=secret-access-key=rustfsadmin
    ;;
  az)
    # Azurite's well-known development account key, published by Microsoft: not a secret.
    key=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==
    k -n "$NS" apply -f "$ROOT/test/seshi/azurite.yaml" >/dev/null
    k -n "$NS" rollout status deploy/azurite --timeout=180s
    forward azurite 19010 10000
    bun "$ROOT/scripts/azurite-container.ts" http://127.0.0.1:19010/devstoreaccount1 \
      devstoreaccount1 "$key" seshi-e2e
    k -n "$NS" create secret generic seshi-store --from-literal=account-key="$key"
    ;;
  gs)
    k -n "$NS" apply -f "$ROOT/test/seshi/fake-gcs.yaml" >/dev/null
    k -n "$NS" rollout status deploy/fake-gcs --timeout=180s
    forward fake-gcs 19020 4443
    curl -sSf -X POST -H 'content-type: application/json' -d '{"name":"seshi-e2e"}' \
      http://127.0.0.1:19020/storage/v1/b >/dev/null
    k -n "$NS" create secret generic seshi-store \
      --from-literal=service-account-key.json='{"type":"service_account","project_id":"seshi-e2e"}'
    ;;
esac

echo "--- install"
h install "$RELEASE" "$ROOT/charts/seshi" -n "$NS" \
  -f "$ROOT/charts/seshi/ci/$VALUES" --wait --timeout 5m ||
  fail "h install did not become ready"
h test "$RELEASE" -n "$NS" || fail "h test failed"

echo "--- the pod's SESHI_* environment"
seshi_env="$(k -n "$NS" exec "deploy/$RELEASE" -- sh -c 'env | grep ^SESHI_ | cut -d= -f1')"
[ "$seshi_env" = "SESHI_CONFIG" ] || fail "unexpected SESHI_* variables: $seshi_env"
if [ "$STORE" = gs ]; then
  # shellcheck disable=SC2016 # expanded in the pod, from the pod's own env
  k -n "$NS" exec "deploy/$RELEASE" -- sh -c 'test -s "$GOOGLE_APPLICATION_CREDENTIALS"' ||
    fail "the service account key is not at GOOGLE_APPLICATION_CREDENTIALS"
fi

echo "--- the bootstrap Job's Secret"
secret="$RELEASE-initial-admin"
k -n "$NS" get secret "$secret" >/dev/null || fail "no Secret $secret after install"
[ "$(k -n "$NS" get configmap "$RELEASE-bootstrap" -o jsonpath='{.data.status}')" = initialized ] ||
  fail "the bootstrap Job did not report initialized"
org_key="$(k -n "$NS" get secret "$secret" -o jsonpath='{.data.org-key}' | base64 -d)"
[ -n "$org_key" ] || fail "$secret has no org-key"
printf '{"org_key":{"token":"%s"}}' "$org_key" >"$WORK/init.json"
k -n "$NS" get job "$RELEASE-bootstrap" >/dev/null 2>&1 && fail "the bootstrap Job was left behind"
k -n "$NS" get role "$RELEASE-bootstrap" >/dev/null 2>&1 && fail "the bootstrap Role was left behind"

echo "--- admin init by hand now refuses"
set +e
k -n "$NS" exec "deploy/$RELEASE" -- seshi admin init --json >/dev/null 2>&1
again=$?
set -e
[ "$again" -eq 6 ] || fail "a second admin init exited $again, not 6"

echo "--- the worker"
for _ in $(seq 1 30); do
  if k -n "$NS" exec "deploy/$RELEASE" -- seshi workers status --json |
    grep -q '"state": "running"'; then
    break
  fi
  sleep 1
done || true
k -n "$NS" exec "deploy/$RELEASE" -- seshi workers status --json |
  grep -q '"state": "running"' || fail "the worker is not running"

echo "--- upload, read back, search"
forward "$RELEASE" 17200 7200
bun "$ROOT/scripts/seshi-smoke.ts" http://127.0.0.1:17200 "$WORK/init.json" upload ||
  fail "smoke test failed"

admin_token="$(k -n "$NS" get secret "$secret" -o jsonpath='{.data.admin-token}' | base64 -d)"
admin() { # admin <port> <method> <path> [json body]: the admin API, with the bootstrap's token
  curl -sS --fail-with-body -X "$2" -H "authorization: Bearer $admin_token" \
    -H 'content-type: application/json' ${4:+-d "$4"} "http://127.0.0.1:$1$3"
}
if [ "$STORE" = az ]; then
  echo "--- runtime config in the bucket: an admin API change"
  admin 17200 PATCH /v1/admin/config '{"set":{"capture.exclude":["acme/runtime"]}}' >/dev/null ||
    fail "PATCH /v1/admin/config was refused"
fi

echo "--- a new pod"
kill "${PIDS[-1]}" 2>/dev/null || true
k -n "$NS" rollout restart "deploy/$RELEASE" >/dev/null
k -n "$NS" rollout status "deploy/$RELEASE" --timeout=180s
forward "$RELEASE" 17201 7200
bun "$ROOT/scripts/seshi-smoke.ts" http://127.0.0.1:17201 "$WORK/init.json" search ||
  fail "search after a restart failed"
if [ "$STORE" = az ]; then
  echo "--- runtime config in the bucket: the change outlived the pod"
  admin 17201 GET /v1/admin/config >"$WORK/config.json" || fail "GET /v1/admin/config failed"
  # The list in effect on the new pod: the values' entry, then the bucket's.
  # shellcheck disable=SC2016 # JavaScript, not shell
  exclude="$(bun -e '
    const status = await Bun.file(process.argv[1]).json();
    if (status.runtime_config !== "store") throw new Error(`runtime_config ${status.runtime_config}`);
    console.log(JSON.stringify(status.effective?.capture?.exclude ?? null));
  ' "$WORK/config.json")" || fail "GET /v1/admin/config did not say runtime_config store"
  [ "$exclude" = '["acme/secret","acme/runtime"]' ] ||
    fail "the new pod's capture.exclude is '$exclude', not the values' entry and the bucket's"
fi

echo "--- reinstall: the Secret is this store's, so it is kept"
created="$(k -n "$NS" get secret "$secret" -o jsonpath='{.metadata.creationTimestamp}')"
reinstall() { # reinstall <timeout>: uninstall, then install again; the exit status of the install
  h uninstall "$RELEASE" -n "$NS" --wait >/dev/null
  h install "$RELEASE" "$ROOT/charts/seshi" -n "$NS" \
    -f "$ROOT/charts/seshi/ci/$VALUES" "${@:2}" --wait --timeout "$1" >/dev/null 2>&1
}
reinstall 3m || fail "a reinstall with the store's own Secret failed"
[ "$(k -n "$NS" get secret "$secret" -o jsonpath='{.metadata.creationTimestamp}')" = "$created" ] ||
  fail "the reinstall replaced $secret"

if [ "$STORE" != s3 ]; then
  echo "seshi-e2e: ok ($STORE)"
  exit 0
fi

job_log() { k -n "$NS" logs "job/$RELEASE-bootstrap" -c "$1" 2>&1 || true; }
store="$(k -n "$NS" get secret "$secret" -o jsonpath='{.metadata.annotations.seshi\.dosu\.ai/store}')"

echo "--- reinstall: a Secret of another store stops the bootstrap before it makes tokens"
k -n "$NS" annotate secret "$secret" seshi.dosu.ai/store=0000000000000000 --overwrite >/dev/null
reinstall 60s && fail "the bootstrap overwrote another store's Secret"
job_log check | grep -q "another store" || fail "the bootstrap did not say why it stopped"
for object in role rolebinding; do
  k -n "$NS" get "$object" "$RELEASE-bootstrap" >/dev/null 2>&1 &&
    fail "the bootstrap's $object outlived the failed Job"
done
k -n "$NS" annotate secret "$secret" "seshi.dosu.ai/store=$store" --overwrite >/dev/null

echo "--- reinstall: tokens an earlier run made but never saved are reported, not ignored"
k -n "$NS" get secret "$secret" -o yaml >"$WORK/secret.yaml"
k -n "$NS" delete secret "$secret" >/dev/null
k -n "$NS" patch configmap "$RELEASE-bootstrap" --type merge -p '{"data":{"status":"minting"}}' >/dev/null
reinstall 60s && fail "the bootstrap succeeded although its tokens were lost"
job_log admin-init | grep -q "never saved them" || fail "the bootstrap did not explain the lost tokens"

echo "--- reinstall: a store whose admin was made elsewhere is recorded, not an error"
k -n "$NS" patch configmap "$RELEASE-bootstrap" --type merge -p '{"data":{"status":"initialized"}}' >/dev/null
reinstall 3m || fail "a reinstall over a store with an admin and no Secret failed"
[ "$(k -n "$NS" get configmap "$RELEASE-bootstrap" -o jsonpath='{.data.status}')" = already-initialized ] ||
  fail "the bootstrap did not record already-initialized"
k -n "$NS" get secret "$secret" >/dev/null 2>&1 && fail "the bootstrap wrote a Secret with no tokens"
k -n "$NS" apply -f "$WORK/secret.yaml" >/dev/null

echo "seshi-e2e: ok ($STORE)"
