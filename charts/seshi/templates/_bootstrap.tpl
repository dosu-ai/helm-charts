{{/* The bootstrap Job's scripts (templates/bootstrap.yaml). They talk to the Kubernetes API with
curl and the Job's ServiceAccount token, and hand state to each other in /work, a memory-backed
emptyDir that lives as long as the pod. */}}

{{/* Identifies the store a Secret's tokens belong to. */}}
{{- define "seshi.storeId" -}}
{{- $s := .Values.store }}
{{- printf "%s|%s|%s|%s" $s.url $s.endpoint $s.accountId $s.deploymentId | sha256sum | trunc 16 }}
{{- end }}

{{- define "seshi.bootstrapStatusName" -}}
{{- printf "%s-bootstrap" (include "seshi.fullname" .) }}
{{- end }}

{{/* Shell functions every curl step shares. */}}
{{- define "seshi.bootstrapLib" -}}
set -u
sa=/var/run/secrets/kubernetes.io/serviceaccount
ns="$(cat "$sa/namespace")"
api="https://kubernetes.default.svc/api/v1/namespaces/$ns"
secret={{ include "seshi.bootstrapSecretName" . | quote }}
status_name={{ include "seshi.bootstrapStatusName" . | quote }}
store={{ include "seshi.storeId" . | quote }}
# kube <method> <path> [body file]: the HTTP status on stdout, the answer in /work/answer.json.
kube() {
  set -- "$1" "$2" "${3:-}"
  if [ -n "$3" ]; then
    curl -sS -o /work/answer.json -w '%{http_code}' --cacert "$sa/ca.crt" \
      -H "Authorization: Bearer $(cat "$sa/token")" -H 'Content-Type: application/json' \
      -X "$1" --data-binary "@$3" "$api/$2"
  else
    curl -sS -o /work/answer.json -w '%{http_code}' --cacert "$sa/ca.crt" \
      -H "Authorization: Bearer $(cat "$sa/token")" -X "$1" "$api/$2"
  fi
}
# The store id recorded on the object in /work/answer.json, or nothing. The API pretty-prints
# for curl, so the patterns allow spaces.
answer_store() { grep -o '"seshi\.dosu\.ai/store": *"[0-9a-f]*"' /work/answer.json | sed 's/.*: *"\(.*\)"/\1/'; }
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
  return 1
}
{{- end }}

{{/* Step 1, before any token exists: is there anything to do, and is it safe? */}}
{{- define "seshi.bootstrapCheck" -}}
{{ include "seshi.bootstrapLib" . }}
code="$(kube GET "secrets/$secret")"
case "$code" in
  200)
    if [ "$(answer_store)" = "$store" ]; then
      echo "$secret already holds this store's first tokens"
      touch /work/done
      exit 0
    fi
    echo "$secret holds the first tokens of another store, or was not made by this chart. Move it aside, or set bootstrap.secretName, then reinstall." >&2
    exit 1
    ;;
  404) ;;
  *) echo "reading $secret: the API answered $code" >&2; cat /work/answer.json >&2; exit 1 ;;
esac
code="$(kube GET "configmaps/$status_name")"
if [ "$code" = 200 ] && [ "$(answer_store)" = "$store" ] && grep -q '"status": *"minting"' /work/answer.json; then
  touch /work/was-minting
fi
set_status minting || exit 1
{{- end }}

{{/* Step 2, in the seshi image: make the tokens. */}}
{{- define "seshi.bootstrapInit" -}}
set -u
[ -e /work/done ] && exit 0
seshi admin init --json --owner {{ .Values.bootstrap.owner | quote }} --set store.url={{ .Values.store.url | quote }} >/work/init.json 2>/work/init.err
code=$?
[ "$code" -eq 0 ] && exit 0
if grep -q 'already set up' /work/init.err; then
  if [ -e /work/was-minting ]; then
    cat >&2 <<'TEXT'
An earlier run of this Job made the store's first tokens but never saved them, so they are lost.
Make new ones in the server pod and keep them yourself:
  kubectl exec deploy/{{ include "seshi.fullname" . }} -- seshi admin init --force --json            # another admin token
  kubectl exec deploy/{{ include "seshi.fullname" . }} -- seshi admin init --rotate-org-key --json   # a new org key; members sign in again
Revoke the lost admin token afterwards (seshi tokens list, seshi tokens revoke).
TEXT
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
  set_status already-initialized
  exit 0
fi
token() { sed -n "/\"$1\": {/,/}/s/^ *\"token\": \"\([A-Za-z0-9_-]*\)\".*/\1/p" /work/init.json; }
admin="$(token admin)"
org="$(token org_key)"
if [ -z "$admin" ] && [ -z "$org" ]; then
  echo "seshi admin init gave no token" >&2
  exit 1
fi
data=""
add() { [ -n "$2" ] && data="$data${data:+,}\"$1\":\"$(printf '%s' "$2" | base64 | tr -d '\n')\""; return 0; }
if [ -n "$admin" ]; then
  add admin-token "$admin"
  add admin-owner {{ .Values.bootstrap.owner | quote }}
fi
add org-key "$org"
cat >/work/secret.json <<JSON
{"apiVersion":"v1","kind":"Secret","type":"Opaque","metadata":{"name":"$secret","annotations":{"seshi.dosu.ai/store":"$store"},"labels":{"app.kubernetes.io/instance":{{ .Release.Name | quote }},"app.kubernetes.io/component":"bootstrap"}},"data":{$data}}
JSON
saved=""
for _ in $(seq 1 30); do
  code="$(kube POST secrets /work/secret.json)"
  case "$code" in
    201) saved=yes; break ;;
    409)
      # Made already: by this pod's own earlier try whose answer was lost, if it is ours.
      code="$(kube GET "secrets/$secret")"
      if [ "$code" = 200 ] && [ "$(answer_store)" = "$store" ]; then
        code="$(kube PUT "secrets/$secret" /work/secret.json)"
        [ "$code" = 200 ] && { saved=yes; break; }
      else
        echo "$secret appeared during the bootstrap and is not this store's" >&2
        break
      fi
      ;;
  esac
  echo "saving $secret: the API answered $code; retrying" >&2
  sleep 2
done
if [ -z "$saved" ]; then
  echo "could not save $secret; the Job retries in this pod, which keeps the tokens in memory" >&2
  exit 1
fi
echo "saved the first tokens in $secret"
set_status initialized
{{- end }}
