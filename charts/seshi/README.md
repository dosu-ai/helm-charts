# seshi

Runs the [seshi](https://github.com/dosu-ai/seshi) server, `seshi serve`, on Kubernetes: one pod
with both roles (api and worker) against an S3-compatible bucket. `appVersion` is the seshi
release the chart runs; the chart's own `version` moves on its own.

## Install

seshi keeps sessions in a bucket ([server.md](https://github.com/dosu-ai/seshi/blob/main/docs/server.md#deploying)).
Put the bucket's keys in a Secret, then install:

```sh
kubectl create namespace seshi
kubectl -n seshi create secret generic seshi-store \
  --from-literal=access-key-id=AKIA… --from-literal=secret-access-key=…
helm install seshi oci://ghcr.io/dosu-ai/charts/seshi -n seshi \
  --set store.url=s3://acme-sessions/seshi --set store.region=us-east-1 \
  --set store.credentials.existingSecret=seshi-store \
  --set persistence.enabled=true
```

After the first install, the chart's bootstrap Job leaves the first admin token and the org key
in the Secret `seshi-initial-admin`:

```sh
kubectl -n seshi get secret seshi-initial-admin -o jsonpath='{.data.org-key}' | base64 -d
```

Members then run `seshi login --server https://seshi.example.com --key <org key>` and
`seshi capture install`.

## Values

[`values.yaml`](values.yaml) comments every value, and `values.schema.json` refuses unknown
keys. The ones most installs set:

| Value | What it sets |
|---|---|
| `store.url` | `[store] url`. Required. `s3://bucket/prefix`, `r2://bucket/prefix`, or `file:///data/store` with `persistence.enabled` |
| `store.region`, `store.endpoint`, `store.accountId`, `store.deploymentId`, `store.org` | The rest of `[store]` ([config.md](https://github.com/dosu-ai/seshi/blob/main/docs/config.md)) |
| `store.credentials.existingSecret` | A Secret with the bucket's keys, given to seshi as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` with `keys.sessionToken`). `store.credentials.keys` names its keys |
| `config` | The rest of `seshi.toml`, written as YAML: `auth`, `filter`, `limits`, `redaction`, `review`, `sources`, `search`, `worker`, `capture` and the others in [config.md](https://github.com/dosu-ai/seshi/blob/main/docs/config.md) |
| `dropIns` | Files for `seshi.d/`, by name ([below](#drop-ins-and-rule-packs)) |
| `redactionPacks` | Rule packs, by file name ([redaction.md](https://github.com/dosu-ai/seshi/blob/main/docs/redaction.md)) |
| `bootstrap.*` | The first admin token ([below](#first-tokens)) |
| `persistence.enabled` | `/data` on a PersistentVolumeClaim instead of an emptyDir ([below](#storage)) |
| `ingress.*`, `networkPolicy.*`, `resources`, `probes` | The usual Kubernetes settings |

The chart writes `seshi.toml` into a ConfigMap mounted at `/etc/seshi`, and sets
`SESHI_CONFIG=/etc/seshi/seshi.toml`, so `kubectl exec … seshi <command>` finds the config
without a flag. A change to the config restarts the pod. The chart sets `[store]`,
`server.listen` (`:7200`) and, unless `config.search.path` says otherwise, `search.path`
(`/data/search/index.sqlite`). It refuses `config.store`, `config.server.listen` and
`config.server.roles`, and starts seshi with `--listen :7200 --roles api,worker`, which win
over any `SESHI_SERVER__*` variable.

### Secrets

Keep secrets out of `config`. seshi reads a secret setting from a variable or a file, so give
the container one with `extraEnv`, `envFrom` or `extraVolumes`/`extraVolumeMounts`, and name
it in `config`:

```yaml
extraEnv:
  - name: OIDC_SESSION_KEY
    valueFrom: { secretKeyRef: { name: seshi-auth, key: session-key } }
config:
  auth:
    oidc: { issuer: https://acme.okta.com, client_id: seshi }
    session_keys: { k1: { env: OIDC_SESSION_KEY } }
```

A variable whose name starts with `SESHI_` must be a real setting (`SESHI_AUTH__ORG_KEY__ENABLED`),
because seshi refuses to start on one it does not know. For the same reason the chart turns
Kubernetes' service links off (`enableServiceLinks: false`). Otherwise a Service named `seshi`
in the namespace would give the pod `SESHI_SERVICE_HOST`, and seshi would not start.

## First tokens

With `bootstrap.enabled` (the default), a post-install Job runs `seshi admin init` against the
bucket once. It writes the first admin token (`admin-token`, owned by `bootstrap.owner`) and,
when `auth.org_key` is on (the default), the org key (`org-key`) into the Secret
`<release>-initial-admin`. Argo CD keeps its initial admin password the same way.

- The Job runs as a Helm hook with its own ServiceAccount and a Role that may create Secrets
  and ConfigMaps in the namespace, and may read and patch only the two it writes. Helm deletes
  the Job and its Role when it succeeds.
- The Secret is not part of the release. It outlives `helm uninstall`, like the bucket's admin it
  belongs to. seshi never reads it: copy the tokens to a password manager and delete it when you
  like.
- A bucket that already has an admin is left alone. On a reinstall, the Job's `admin init`
  exits 6 and the Job records `already-initialized` in the ConfigMap `<release>-bootstrap`.
- Admins make more tokens with `seshi tokens` or `POST /v1/tokens`. With an IdP, add
  `config.auth.oidc` and members sign in through it; the admin token still works.

`bootstrap.enabled: false` skips all of it. Then run `seshi admin init` yourself:

```sh
kubectl -n seshi exec deploy/seshi -- seshi admin init --json
```

## Storage

Sessions live in the bucket. `/data` holds the search index, and the sessions themselves only
for a folder store (`file:///data/…`).

- `persistence.enabled: false` (the default) puts `/data` on an emptyDir. Each new pod rebuilds
  the search index from the bucket's change feed. Until it has caught up, `GET /v1/search` and
  `GET /v1/changes/all` answer `503 index_building`; uploads and reads are unaffected.
- `persistence.enabled: true` puts `/data` on a claim (`persistence.size`, `storageClass`,
  `existingClaim`). The index survives restarts. Recommended for production, and for readers of
  `/v1/changes/all`.

A folder store must be under `/data` and needs `persistence.enabled`; the chart refuses
anything else. The chart keeps the claim when the release is uninstalled or persistence is
turned off (`helm.sh/resource-policy: keep`). Delete it by hand when you mean to.

## Drop-ins and rule packs

`dropIns` writes each entry to `seshi.d/<name>.toml` beside `seshi.toml`, loaded in name order.
A drop-in may add sources, `redaction.packs`, `capture.exclude` and `capture.redact_tool_calls`:

```yaml
dropIns:
  10-org:
    capture:
      exclude: [acme/secret-repo]
redactionPacks:
  acme.toml: |
    id = "acme"
    [[rules]]
    id = "acme-key"
    pattern = 'ACME-[0-9A-F]{32}'
```

Each pack is mounted at `/etc/seshi/packs/<file>` and added to `redaction.packs`. Both come from
the ConfigMap, so a change is a `helm upgrade` and a restart.

## One pod

The chart runs one replica with both roles. Exactly one instance may run the worker,
`POST /v1/admin/reload` reloads only the instance that answers it, and each API instance builds
its own search index, so there is no `replicas` value. Upgrades use the `Recreate` strategy:
the old pod stops before the new one starts, and uploaders retry through the gap. A pod deleted
by hand can overlap its replacement for the few seconds it takes to stop; seshi's checkpoints
and deduplication tolerate a second worker for that long.

## Ingress and network policy

`ingress.enabled` routes a host to the Service and needs at least one entry in `ingress.hosts`.
Set the controller's request timeout to 120 seconds or more and allow large bodies: a long
transcript takes that long to normalize, and clients send it gzipped. For ingress-nginx:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-body-size: 64m
  hosts:
    - host: seshi.example.com
      paths: [{ path: / }]
  tls:
    - hosts: [seshi.example.com]
      secretName: seshi-tls
```

`networkPolicy.enabled` admits traffic to the API port only from `networkPolicy.ingressFrom`
(pods in the namespace when empty) and from the release's own `helm test` pod. Egress is left
alone: seshi reaches its bucket and any sources it polls.
