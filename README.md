# Dosu Helm charts

Helm charts for Dosu's open-source servers.

| Chart | Runs | Install |
|---|---|---|
| [seshi](charts/seshi) | The [seshi](https://github.com/dosu-ai/seshi) session store server | `oci://ghcr.io/dosu-ai/charts/seshi` ([install](charts/seshi/README.md#install)) |

Each chart is published to `oci://ghcr.io/dosu-ai/charts/<chart>` when a change to it merges.
A chart's `version` is its own; its `appVersion` is the release of the software it runs.

## Working on a chart

Every change goes through a pull request, squash-merged into `main`, with a
[Conventional Commit](https://www.conventionalcommits.org) title. A pull request that changes a
chart bumps its `version` in `Chart.yaml`, and CI checks that it did: a patch for a fix, a
minor for a new value or behavior. Before 1.0, never a major.

The seshi chart's checks run locally with `helm`, `docker` and `bun`, and `kubeconform` when it
is on `PATH` (the check skips it otherwise). The kind tests also need `kind`, `kubectl`, `curl`,
and for `STORE=s3` the AWS CLI:

```sh
bun scripts/seshi-check.ts        # lint, render, seshi config check, refused values, kubeconform
kind create cluster --name seshi-chart
scripts/seshi-e2e.sh              # install against RustFS, bootstrap, upload, search, restart
STORE=az scripts/seshi-e2e.sh     # the same against Azurite, with the runtime config in the bucket
STORE=gs scripts/seshi-e2e.sh     # the same against fake-gcs-server
SEARCH=lance scripts/seshi-e2e.sh # with the shared LanceDB index in the bucket (s3 and az)
```

`seshi-check.ts` runs the chart's own seshi release (`ghcr.io/dosu-ai/seshi:<appVersion>`) on
every config the chart renders, laid out the way the pod sees it. To move the chart to a new
seshi release, change `appVersion`, bump `version`, and run both.

`seshi-bump.yml` does the first two by itself. Every 6 hours (or from the Actions tab) it
compares `appVersion` with the newest `x.y.z` image of `ghcr.io/dosu-ai/seshi`. When the image
is newer, it opens a pull request that sets `appVersion` to it and bumps `version` the same
way (a minor for a new seshi minor, else a patch), runs CI on it, and closes an older such
pull request. Read the seshi release notes before merging it: a new setting may need a change
to the chart or its README, pushed to the same branch. It needs the repository setting that
lets GitHub Actions create pull requests.
