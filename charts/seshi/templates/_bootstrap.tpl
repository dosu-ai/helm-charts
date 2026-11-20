{{/* The bootstrap Job's scripts (templates/bootstrap.yaml). Four steps hand state to each other
in /work, a memory-backed emptyDir that lives as long as the pod:

  store      (seshi) which store this is, as seshi resolves it: /work/store-id
  check      (curl)  is there anything to do, and is it safe?
  admin-init (seshi) make the tokens
  save       (curl)  keep them in the Secret

The curl steps talk to the Kubernetes API with the Job's ServiceAccount token. The store URL and
the owner reach the scripts as STORE_URL and BOOTSTRAP_OWNER, never inside the script text, so
the shell does not expand anything in them. */}}

{{- define "seshi.bootstrapStatusName" -}}
{{- printf "%s-bootstrap" (include "seshi.fullname" .) }}
{{- end }}

{{/* Step 0. The store's identity: the bucket URL, endpoint, account and deployment id seshi
ends up using, in seshi's own order (packages/ts/store/src/open.ts and s3.ts): the config's
endpoint; else S3_ENDPOINT when it is set at all, even empty; else R2's own endpoint for an
r2:// URL with an account; else AWS_ENDPOINT. The account is the config's, else R2_ACCOUNT_ID
when set. */}}
{{- define "seshi.bootstrapStore" -}}
set -u
seshi config show --set "store.url=$STORE_URL" >/work/config.txt || exit 1
has() { grep -q "^store\.$1 = " /work/config.txt; }
setting() { sed -n "s/^store\.$1 = \"\(.*\)\"\$/\1/p" /work/config.txt; }
url="$(setting url)"
if has account_id; then account="config:$(setting account_id)"
elif [ "${R2_ACCOUNT_ID+set}" = set ]; then account="config:$R2_ACCOUNT_ID"
else account=unset; fi
if has endpoint; then endpoint="$(setting endpoint)"
elif [ "${S3_ENDPOINT+set}" = set ]; then endpoint="$S3_ENDPOINT"
else
  case "$url:$account" in
    r2://*:config:?*) endpoint="https://${account#config:}.r2.cloudflarestorage.com" ;;
    *) if [ "${AWS_ENDPOINT+set}" = set ]; then endpoint="$AWS_ENDPOINT"; else endpoint="(default)"; fi ;;
  esac
fi
printf 'url=%s\nendpoint=%s\naccount=%s\ndeployment=%s\n' \
  "$url" "$endpoint" "$account" "$(setting deployment_id)" >/work/store.txt
sha256sum /work/store.txt | cut -c1-16 >/work/store-id
rm -f /work/config.txt
echo "store $(cat /work/store-id): $url"
{{- end }}

{{/* Shell functions the curl steps share. */}}
{{- define "seshi.bootstrapLib" -}}
set -u
sa=/var/run/secrets/kubernetes.io/serviceaccount
ns="$(cat "$sa/namespace")"
api="https://kubernetes.default.svc/api/v1/namespaces/$ns"
secret={{ include "seshi.bootstrapSecretName" . | quote }}
status_name={{ include "seshi.bootstrapStatusName" . | quote }}
store="$(cat /work/store-id)"
# kube <method> <path> [body file]: the HTTP status on stdout, the answer in /work/answer.json.
# A transfer that curl reports as failed (a cut-off answer, a dropped connection) is 000, never
# the status line it may have read first.
kube() {
  method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    set -- -H 'Content-Type: application/json' --data-binary "@$body"
  else
    set --
  fi
  status="$(curl -sS -o /work/answer.json -w '%{http_code}' --cacert "$sa/ca.crt" \
    -H "Authorization: Bearer $(cat "$sa/token")" -X "$method" "$@" "$api/$path")" || status=000
  printf '%s' "$status"
}
# The bootstrap's note on the Secret in /work/answer.json: "admin-token-lost" or nothing.
answer_note() { grep -o '"seshi\.dosu\.ai/bootstrap": *"[^"]*"' /work/answer.json | sed 's/.*: *"\(.*\)"/\1/'; }
# The store id recorded on the object in /work/answer.json, or nothing. The API pretty-prints
# for curl, so the patterns allow spaces.
answer_store() { grep -o '"seshi\.dosu\.ai/store": *"[^"]*"' /work/answer.json | sed 's/.*: *"\(.*\)"/\1/'; }
# Records the bootstrap's state in the status ConfigMap, creating it the first time.
set_status() {
  cat >/work/status.json <<JSON
{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"$status_name","annotations":{"seshi.dosu.ai/store":"$store"},"labels":{"app.kubernetes.io/instance":{{ .Release.Name | quote }},"app.kubernetes.io/component":"bootstrap"}},"data":{"status":"$1","secret":"$secret"}}
JSON
  for _ in $(seq 1 30); do
    code="$(kube PUT "configmaps/$status_name" /work/status.json)"
    [ "$code" = 404 ] && code="$(kube POST configmaps /work/status.json)"
    case "$code" in 200 | 201) return 0 ;; esac
    echo "recording status $1: the API answered $code; retrying" >&2
    sleep 2
  done
  echo "could not record status $1 in $status_name" >&2
  return 1
}
{{- end }}

{{/* The commands that make new tokens by hand, in the server pod, with STORE_URL as one
shell-quoted word. */}}
{{- define "seshi.bootstrapRecovery" -}}
word="'$(printf '%s' "store.url=$STORE_URL" | sed "s/'/'\\\\''/g")'"
printf '%s\n' \
  "Make new ones in the server pod and keep them yourself:" \
  "  kubectl -n {{ .Release.Namespace }} exec deploy/{{ include "seshi.fullname" . }} -- seshi admin init --force --json --set $word   # another admin token" \
  "  kubectl -n {{ .Release.Namespace }} exec deploy/{{ include "seshi.fullname" . }} -- seshi admin init --rotate-org-key --json --set $word   # a new org key; members sign in again" \
  "Then revoke the lost admin token (seshi tokens list, seshi tokens revoke)." >&2
{{- end }}

{{/* Step 1, before any token exists: is there anything to do, and is it safe? */}}
{{- define "seshi.bootstrapCheck" -}}
{{ include "seshi.bootstrapLib" . }}
code="$(kube GET "secrets/$secret")"
case "$code" in
  200)
    if [ "$(answer_store)" = "$store" ]; then
      if [ "$(answer_note)" = admin-token-lost ]; then
        echo "$secret holds only the org key: an earlier bootstrap lost the store's first admin token." >&2
        {{- include "seshi.bootstrapRecovery" . | nindent 8 }}
        exit 1
      fi
      echo "$secret already holds this store's first tokens"
      touch /work/done
      exit 0
    fi
    echo "$secret holds the first tokens of another store, or was not made by this chart. Move it aside, or set bootstrap.secretName, then reinstall." >&2
    exit 1
    ;;
  404) ;;
  *) echo "reading $secret: the API answered $code" >&2; exit 1 ;;
esac
code="$(kube GET "configmaps/$status_name")"
case "$code" in
  200)
    if [ "$(answer_store)" = "$store" ] && grep -q '"status": *"minting"' /work/answer.json; then
      touch /work/was-minting
    fi
    ;;
  404) ;;
  *) echo "reading $status_name: the API answered $code" >&2; exit 1 ;;
esac
set_status minting || exit 1
{{- end }}

{{/* Step 2, in the seshi image: make the tokens. A run that follows another attempt (an earlier
pod's, per the status ConfigMap, or this pod's own, restarted) may find tokens that attempt made
and never handed on. */}}
{{- define "seshi.bootstrapInit" -}}
set -u
[ -e /work/done ] && exit 0
[ -e /work/attempted ] && touch /work/was-minting
touch /work/attempted
seshi admin init --json --owner "$BOOTSTRAP_OWNER" --set "store.url=$STORE_URL" >/work/init.json 2>/work/init.err
code=$?
[ "$code" -eq 0 ] && exit 0
if grep -q 'already set up' /work/init.err; then
  if [ -e /work/was-minting ]; then
    echo "An earlier attempt made the store's first tokens but never saved them, so they are lost." >&2
    {{- include "seshi.bootstrapRecovery" . | nindent 4 }}
    exit 1
  fi
  echo "the store already has an admin, made outside this release; {{ include "seshi.bootstrapSecretName" . }} is not written"
  touch /work/already
  exit 0
fi
cat /work/init.err >&2
exit "$code"
{{- end }}

{{/* Step 3: keep the tokens in the Secret, and record that it is done. */}}
{{- define "seshi.bootstrapSave" -}}
{{ include "seshi.bootstrapLib" . }}
[ -e /work/done ] && exit 0
if [ -e /work/already ]; then
  set_status already-initialized || exit 1
  exit 0
fi
token() { sed -n "/\"$1\": {/,/}/s/^ *\"token\": \"\([A-Za-z0-9_-]*\)\".*/\1/p" /work/init.json; }
admin="$(token admin)"
org="$(token org_key)"
if [ -z "$admin" ] && [ -z "$org" ]; then
  echo "seshi admin init gave no token" >&2
  exit 1
fi
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
data=""
expect=""
add() { # add <key> <value>: into the Secret, and into what an existing one must hold
  [ -n "$2" ] || return 0
  data="$data${data:+,}\"$1\":\"$(b64 "$2")\""
  expect="$expect $1=$(b64 "$2")"
}
if [ -n "$admin" ]; then
  add admin-token "$admin"
  add admin-owner "$BOOTSTRAP_OWNER"
fi
add org-key "$org"
note=""
if [ -z "$admin" ] && [ -e /work/was-minting ]; then note=admin-token-lost; fi
cat >/work/secret.json <<JSON
{"apiVersion":"v1","kind":"Secret","type":"Opaque","metadata":{"name":"$secret","annotations":{"seshi.dosu.ai/store":"$store","seshi.dosu.ai/bootstrap":"$note"},"labels":{"app.kubernetes.io/instance":{{ .Release.Name | quote }},"app.kubernetes.io/component":"bootstrap"}},"data":{$data}}
JSON
# Is the Secret in /work/answer.json exactly the one this step would make: the same store, the
# same note, and the same data, key for key? The API pretty-prints, with .data at two spaces.
same_secret() {
  [ "$(answer_store)" = "$store" ] && [ "$(answer_note)" = "$note" ] || return 1
  got="$(sed -n '/^  "data": {/,/^  }/p' /work/answer.json | grep -o '"[^"]*": *"[^"]*"' |
    sed 's/": *"/=/; s/"//g' | LC_ALL=C sort)"
  want="$(printf '%s\n' $expect | LC_ALL=C sort)"
  [ "$got" = "$want" ]
}
saved=""
for _ in $(seq 1 30); do
  code="$(kube POST secrets /work/secret.json)"
  case "$code" in
    201) saved=yes; break ;;
    409)
      # Made already: by this step's own earlier try, whose answer was lost, or by someone else.
      code="$(kube GET "secrets/$secret")"
      if [ "$code" = 200 ] && same_secret; then saved=yes; break; fi
      [ "$code" = 200 ] && { echo "$secret appeared during the bootstrap with other contents" >&2; exit 1; }
      ;;
  esac
  echo "saving $secret: the API answered $code; retrying" >&2
  sleep 2
done
if [ -z "$saved" ]; then
  echo "could not save $secret; the Job retries this step in the same pod, which keeps the tokens in memory" >&2
  exit 1
fi
echo "saved the first tokens in $secret"
if [ "$note" = admin-token-lost ]; then
  set_status admin-token-lost || true
  echo "An earlier attempt made the store's first admin token but never saved it; $secret holds only the org key." >&2
  {{- include "seshi.bootstrapRecovery" . | nindent 2 }}
  exit 1
fi
set_status initialized || exit 1
{{- end }}
