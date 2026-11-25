# seshi

Runs the [seshi](https://github.com/dosu-ai/seshi) server, `seshi serve`, on Kubernetes: one pod
with both roles (api and worker) against a bucket in S3 (or an S3-compatible service), R2, Azure
Blob Storage or Google Cloud Storage. `appVersion` is the seshi
release the chart runs; the chart's own `version` moves on its own.

## Install

seshi keeps sessions in a bucket ([server.md](https://github.com/dosu-ai/seshi/blob/main/docs/server.md#deploying)).
Put the bucket's keys in a Secret (on Azure and Google Cloud, the pod's cloud identity also
works, [below](#buckets-and-keys)), then install:

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
chart keys. What goes under `config` and `dropIns` is seshi's own config, which the schema
passes through and seshi checks when it starts. The ones most installs set:

| Value | What it sets |
|---|---|
| `store.url` | `[store] url`. Required. `s3://bucket/prefix`, `r2://bucket/prefix`, `az://container/prefix`, `gs://bucket/prefix`, or `file:///data/store` with `persistence.enabled` |
| `store.region`, `store.endpoint`, `store.accountId`, `store.accountName`, `store.deploymentId`, `store.org` | The rest of `[store]` ([config.md](https://github.com/dosu-ai/seshi/blob/main/docs/config.md)) |
| `store.credentials.existingSecret` | A Secret with the bucket's keys ([below](#buckets-and-keys)). `store.credentials.keys` names its keys |
| `serviceAccount.annotations`, `podLabels` | Workload identity, in place of keys ([below](#buckets-and-keys)) |
| `config` | The rest of `seshi.toml`, written as YAML: `auth`, `filter`, `limits`, `redaction`, `review`, `sources`, `search`, `worker`, `capture` and the others in [config.md](https://github.com/dosu-ai/seshi/blob/main/docs/config.md) |
| `dropIns` | Files for `seshi.d/`, by name ([below](#drop-ins-and-rule-packs)) |
| `redactionPacks` | Rule packs, by file name ([redaction.md](https://github.com/dosu-ai/seshi/blob/main/docs/redaction.md)) |
| `bootstrap.*` | The first admin token ([below](#first-tokens)) |
| `persistence.enabled` | `/data` on a PersistentVolumeClaim instead of an emptyDir ([below](#storage)) |
| `api.replicas` | Several API pods and one worker pod, in place of one pod with both roles ([below](#several-api-pods)) |
| `api.drainSeconds` | With `api.replicas` above 1, how long a stopping API pod keeps serving before SIGTERM (5; 0 turns it off) |
| `ingress.*`, `networkPolicy.*`, `resources`, `probes` | The usual Kubernetes settings |

The chart writes `seshi.toml` into a ConfigMap mounted at `/etc/seshi`, and sets
`SESHI_CONFIG=/etc/seshi/seshi.toml`, so `kubectl exec … seshi <command>` finds the config
without a flag. A change to the config restarts the pod. The chart sets `[store]`,
`server.listen` (`:7200`) and, unless `config.search.path` says otherwise, `search.path`
(`/data/search/index.sqlite`). It refuses `config.store`, `config.server.listen` and
`config.server.roles`, and starts seshi with `--listen :7200`, `--roles` (`api,worker`, or
per pod with `api.replicas`) and `--set store.url=…`, which win over any `SESHI_*` variable.

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

With `bootstrap.enabled` (the default), a post-install Job makes the store's first admin token
and, when `auth.org_key` is on (the default), the org key, and saves them in the Secret
`<fullname>-initial-admin` (`admin-token`, `admin-owner`, `org-key`). Argo CD keeps its initial
admin password the same way. The Job has four steps:

1. **store** asks seshi which store the config and the pod's environment pick, and takes a
   fingerprint of it. The Secret records it as `seshi.dosu.ai/store`.
2. **check** reads the Secret. If it already holds this store's tokens, the Job is done. If it
   holds another store's, the Job stops before making any: move the Secret aside, or set
   `bootstrap.secretName`. Otherwise it records `minting` in the ConfigMap `<fullname>-bootstrap`.
3. **admin-init** runs `seshi admin init` against the bucket.
4. **save** creates the Secret and records `initialized`.

The tokens pass between the steps in a memory-backed volume. A failed step restarts in the same
pod, which keeps them, so a brief API outage does not lose them. A pod that is lost (a node
failure, or the Job giving up after its retries) loses them with it; the next run notices.

- **The store already had an admin**, made outside this release. The Secret is not written,
  and the ConfigMap says `already-initialized`. When that store has no org key yet and the org
  key is on, the Job makes one, saves a Secret that holds only `org-key`, and records
  `initialized`.
- **An earlier attempt made tokens and lost them.** `seshi admin init` says "already set up"
  after an attempt that never finished: one recorded as `minting`, or one in the same pod. The
  Job fails, and its log gives the commands that make new tokens in the server pod
  (`seshi admin init --force`, `--rotate-org-key`), and the one that marks the ConfigMap
  `already-initialized` so a reinstall does not stop at the same place. When only the admin
  token was lost, the Secret holds the org key and carries
  `seshi.dosu.ai/bootstrap: admin-token-lost`, and the Job refuses it on every later install.
  The log then gives `seshi admin init --force` and the `kubectl annotate` command that clears
  the note, after which the Secret counts as this store's.
- **Not on upgrade.** The Job runs on `helm install` only. Turning `bootstrap.enabled` on later
  does nothing; run `seshi admin init` in the server pod instead.
- **Not for a folder store.** The server pod holds the claim, so make the tokens there.

The Job runs as the ServiceAccount the chart makes for the server (`serviceAccount.create`, the
default), so workload identity gets `seshi admin init` into the bucket the same way it gets the
server in, and its pod carries `podLabels`. With an account the chart does not make
(`serviceAccount.create: false`), which other workloads may share, the Job gets an account of
its own instead: workload identity then does not reach it, so give it keys in
`store.credentials`, or set `bootstrap.enabled: false` and run `seshi admin init` in the server
pod. A Role bound to the Job's account while the hook runs may create Secrets and ConfigMaps in
the namespace, read its Secret, and read and replace its ConfigMap. Only the two curl steps
mount the Kubernetes API token; the seshi steps never see it. Helm deletes the Role and its
binding when the Job succeeds or fails, and the Job itself when it succeeds. Helm also counts
the Job as failed when `helm install --timeout` runs out first, and deletes the Role then, so
a Job still retrying cannot save its tokens. Give the install time for image pulls (the default
5m is usually enough). One case escapes
that: when the API refuses to create the Job at all (a ResourceQuota on Jobs, an admission
policy), Helm stops with the Role and binding in place, and the Job's own ServiceAccount when
it has one. Delete them by hand then, or the next install replaces them:

```sh
kubectl -n seshi delete role,rolebinding,serviceaccount \
  -l app.kubernetes.io/instance=seshi,app.kubernetes.io/component=bootstrap
```

Under an egress NetworkPolicy, the Job must reach the Kubernetes API as well as the bucket. The Secret and the ConfigMap are not part of the release: they outlive
`helm uninstall`, like the store's admin they belong to. seshi never reads the Secret: copy the
tokens to a password manager and delete it when you like.

`bootstrap.enabled: false` skips all of it. Then run `seshi admin init` yourself:

```sh
kubectl -n seshi exec deploy/seshi -- seshi admin init --json --set 'store.url=s3://acme-sessions/seshi'
```

`--set store.url` keeps the command on the chart's store even when the pod's environment says
otherwise. Admins make more tokens with `seshi tokens` or `POST /v1/tokens`. With an IdP, add
`config.auth.oidc` and members sign in through it; the admin token still works.

## Buckets and keys

seshi finds its way into the bucket the way each cloud's own tools do
([config.md](https://github.com/dosu-ai/seshi/blob/main/docs/config.md#store)). With
`store.credentials.existingSecret`, the chart hands seshi the Secret's keys for the URL's
scheme. Without a Secret, an Azure or Google Cloud store uses the pod's identity, which
`serviceAccount.annotations` sets up:

| `store.url` | From `existingSecret` (`store.credentials.keys` names the keys) | Without a Secret |
|---|---|---|
| `s3://`, `r2://` | `access-key-id` and `secret-access-key` as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; `keys.sessionToken` adds `AWS_SESSION_TOKEN` | None: seshi 0.27.0 reads only keys, not IRSA or EKS Pod Identity |
| `az://` with `store.accountName` | `account-key` as `AZURE_STORAGE_KEY`, else `sas-token` as `AZURE_STORAGE_SAS_TOKEN`: whichever the Secret has | AKS workload identity: `azure.workload.identity/client-id` on the ServiceAccount, `azure.workload.identity/use: "true"` in `podLabels`, and **Storage Blob Data Contributor** on the container |
| `gs://` | `service-account-key.json` mounted as the file `GOOGLE_APPLICATION_CREDENTIALS` names | GKE Workload Identity: `iam.gke.io/gcp-service-account` on the ServiceAccount, with **Storage Object User** on the bucket |

The container (Azure) or bucket must exist; seshi does not create it. `store.credentials.accessKeyId`
and `secretAccessKey` make the Secret for you, for `s3://` and `r2://` only.

```yaml
# Azure, with a SAS token in the Secret seshi-azure
store:
  url: az://sessions/seshi
  accountName: acmeseshi
  credentials:
    existingSecret: seshi-azure
    keys: { accountKey: "", sasToken: sas-token }
---
# Google Cloud, through GKE Workload Identity
store:
  url: gs://acme-seshi/prod
serviceAccount:
  annotations:
    iam.gke.io/gcp-service-account: seshi@acme.iam.gserviceaccount.com
```

## Storage

Sessions live in the bucket. `/data` holds the search index, and the sessions themselves only
for a folder store (`file:///data/…`).

- `persistence.enabled: false` (the default) puts `/data` on an emptyDir. Each new pod rebuilds
  the search index from the bucket's change feed. Until it has caught up, `GET /v1/search` and
  `GET /v1/changes/all` answer `503 index_building`; uploads and reads are unaffected.
- `persistence.enabled: true` puts `/data` on a claim (`persistence.size`, `storageClass`,
  `existingClaim`). The index survives restarts. Recommended for a single pod in production,
  and for readers of `/v1/changes/all`. With several API pods each keeps its own index on an
  emptyDir instead ([below](#several-api-pods)).

A folder store must be a plain path under `/data` (letters, digits, `.`, `_`, `-`; no `..`)
and needs `persistence.enabled`;
the chart refuses anything else. The chart passes `store.url` to seshi as a flag, so a
`SESHI_STORE__URL` in `extraEnv` or `envFrom` cannot point it elsewhere.

The chart keeps the claim when the release is uninstalled or persistence is turned off
(`helm.sh/resource-policy: keep`). Delete it by hand when you mean to.

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

### Runtime config in the bucket

With `config.server.runtime_config: store`, the data policy (`capture`, `redaction`, `filter`,
`review`, `records`, `default_visibility`) and sources can also live in the bucket, where the
admin API changes them without a `helm upgrade` (`PATCH /v1/admin/config`,
`PUT /v1/admin/sources/<id>`, `seshi admin config push`;
[config.md](https://github.com/dosu-ai/seshi/blob/main/docs/config.md#runtime-config-in-the-bucket-serverruntime_config--store)).
Those changes outlive the pod. What the chart's values set still wins and is locked against
the API, and a list such as `capture.exclude` adds the bucket's entries after the values'. A
source stored with secrets needs a sealing key in `config.secrets`, given as an `env` reference:

```yaml
config:
  server:
    runtime_config: store
  secrets:
    key_id: k1
    keys: { k1: { env: SEAL_KEY_1 } }
extraEnv:
  - name: SEAL_KEY_1   # openssl rand -hex 32, kept in a Secret
    valueFrom: { secretKeyRef: { name: seshi-sealing, key: k1 } }
```

The server does not start when it cannot read the bucket's runtime config.

## Several API pods

By default one pod runs both roles, the API and the worker. Upgrades use the `Recreate`
strategy: the old pod stops before the new one starts, and uploaders retry through the gap. A
pod deleted by hand can overlap its replacement for the few seconds it takes to stop; seshi's
checkpoints and deduplication tolerate a second worker for that long.

`api.replicas` above 1 splits the roles ([server.md](https://github.com/dosu-ai/seshi/blob/main/docs/server.md#roles-and-background-work)):

- **API pods.** `deploy/<fullname>` runs that many pods with `--roles api` behind the Service,
  and upgrades them one at a time (`RollingUpdate`, `maxUnavailable: 0`). They share nothing
  but the bucket. A stopping API pod keeps serving for `api.drainSeconds` (5) before seshi gets
  SIGTERM, because seshi closes its listener at once and the Service can still route to the pod
  for a moment.
- **One worker pod.** `deploy/<fullname>-worker` runs `--roles worker` (the pollers, the span
  assembler, retention, the sweep and the heartbeat) with `Recreate`, because seshi wants
  exactly one worker. It serves only `/healthz`, and the Service does not select it.

```yaml
api:
  replicas: 3
config:
  server:
    runtime_config: store
```

Each API pod keeps its own search index on an emptyDir and builds it from the bucket when it
starts. Until a pod has caught up, its `GET /v1/search` and `GET /v1/changes/all` answer
`503 index_building` with `Retry-After`, while the other pods answer normally; `/healthz`
does not wait for the index, so the new pod takes traffic at once. A session one pod stores is
searchable on the others within `search.interval`. Because one claim cannot hold an index for
every pod, the chart refuses `persistence.enabled` with more than one API pod, and a folder
store, which lives on a claim.

Files from the chart reach every pod on each `helm upgrade`, which restarts them. A change made
through the admin API is the one that needs `runtime_config: store`: without it the admin
API's write routes answer `409 runtime_config_off`, and `POST /v1/admin/reload` reloads only
the pod that answers it. With it, the pod that takes a change applies it at once and the others
within `server.config_poll` (10 seconds); `GET /v1/admin/config?wait=30s` waits until they all
run it. A revoked token stops at once on the pod that revoked it and within 30 seconds on the
others.

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
