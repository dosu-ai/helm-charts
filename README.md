# Dosu Helm charts

Helm charts for Dosu's open-source servers.

| Chart | Runs | Install |
|---|---|---|
| [seshi](charts/seshi) | The [seshi](https://github.com/dosu-ai/seshi) session store server | `helm install seshi oci://ghcr.io/dosu-ai/charts/seshi` |

Each chart is published to `oci://ghcr.io/dosu-ai/charts/<chart>` when a change to it merges.
A chart's `version` is its own; its `appVersion` is the release of the software it runs.

## Working on a chart

Every change goes through a pull request, squash-merged into `main`, with a
[Conventional Commit](https://www.conventionalcommits.org) title. A pull request that changes a
chart bumps its `version` in `Chart.yaml`, and CI checks that it did: a patch for a fix, a
minor for a new value or behavior. Before 1.0, never a major.

The seshi chart's checks run locally with `helm`, `docker` and `bun`:

```sh
bun scripts/seshi-check.ts        # lint, render, seshi config check, refused values, kubeconform
kind create cluster --name seshi-chart
scripts/seshi-e2e.sh              # install against RustFS, bootstrap, upload, search, restart
```

`seshi-check.ts` runs the chart's own seshi release (`ghcr.io/dosu-ai/seshi:<appVersion>`) on
every config the chart renders, laid out the way the pod sees it. To move the chart to a new
seshi release, change `appVersion`, bump `version`, and run both.
