/** Checks charts/seshi without a cluster.
 *
 * For every values file in charts/seshi/ci/: `helm lint --strict` and `helm template`, then
 * the config the pod would see. The check reads the seshi container's volume mounts and the
 * ConfigMap volume's items from the rendered Deployment, writes those files where the pod would
 * see them, and runs the chart's own seshi release (ghcr.io/dosu-ai/seshi:<appVersion>) on
 * them with the container's environment. That run must pass `seshi config check`. Every
 * drop-in the chart mounts must also be an origin of the effective config, so a drop-in
 * mounted where seshi never looks fails here.
 *
 * It also checks that every pod spec turns Kubernetes' service links off, that the values the
 * chart must refuse fail to render, and, with kubeconform on PATH, the manifests against
 * Kubernetes' schemas.
 *
 * Needs helm and docker: bun scripts/seshi-check.ts */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHART = join(ROOT, "charts/seshi");
const CI_VALUES = join(CHART, "ci");
const RELEASE = "seshi";
const CONCURRENCY = Math.min(8, Math.max(2, availableParallelism()));

const S3 = ["--set", "store.url=s3://b/p"];

/** Values the chart must refuse, each with what its error must say. values.schema.json refuses
 * some before the templates do, and Helm 3 and 4 word that differently, so the expected text
 * is the part both share. */
const REFUSED: { name: string; args: string[]; error: string }[] = [
  { name: "no store", args: [], error: "store.url is required" },
  {
    name: "a file store without a claim",
    args: ["--set", "store.url=file:///data/store"],
    error: "persistence.enabled is false",
  },
  {
    name: "a bare-path store without a claim",
    args: ["--set", "store.url=/data/store"],
    error: "persistence.enabled is false",
  },
  {
    name: "a folder store outside the claim",
    args: ["--set", "store.url=file:///tmp/store", "--set", "persistence.enabled=true"],
    error: "must be under /data",
  },
  {
    name: "a folder store climbing out of the claim",
    args: ["--set", "store.url=file:///data/../tmp", "--set", "persistence.enabled=true"],
    error: "must be under /data",
  },
  {
    name: "a folder store escaping the claim with a percent escape",
    args: ["--set", "store.url=file:///data/%2e%2e/tmp/seshi", "--set", "persistence.enabled=true"],
    error: "must be under /data",
  },
  {
    name: "a folder store with a control character in its path",
    args: ["--set", "store.url=file:///data/.\t./tmp/seshi", "--set", "persistence.enabled=true"],
    error: "must be under /data",
  },
  {
    name: "a service owner for the first admin",
    args: [...S3, "--set", "bootstrap.owner=svc:thing"],
    error: "svc:thing",
  },
  {
    name: "a session token with inline keys",
    args: [
      ...S3,
      "--set",
      "store.credentials.accessKeyId=a",
      "--set",
      "store.credentials.secretAccessKey=b",
      "--set",
      "store.credentials.keys.sessionToken=session-token",
    ],
    error: "existingSecret",
  },
  {
    name: "inline keys for an az:// store",
    args: ["--set", "store.url=az://c/p", "--set", "store.credentials.accessKeyId=a"],
    error: "store.credentials.existingSecret",
  },
  {
    name: "inline keys for a gs:// store",
    args: ["--set", "store.url=gs://b/p", "--set", "store.credentials.accessKeyId=a"],
    error: "store.credentials.existingSecret",
  },
  {
    name: "a gs:// Secret with no key named for the service account key",
    args: [
      "--set",
      "store.url=gs://b/p",
      "--set",
      "store.credentials.existingSecret=s",
      "--set-string",
      "store.credentials.keys.serviceAccountKey=",
    ],
    error: "serviceAccountKey is empty",
  },
  {
    name: "a server account named like the bootstrap's own",
    args: [
      ...S3,
      "--set",
      "serviceAccount.create=false",
      "--set",
      "serviceAccount.name=seshi-bootstrap",
    ],
    error: "the bootstrap Job's own account",
  },
  {
    name: "several API pods with a claim",
    args: [...S3, "--set", "api.replicas=2", "--set", "persistence.enabled=true"],
    error: "persistence.enabled",
  },
  {
    name: "several API pods on a folder store",
    args: [
      "--set",
      "store.url=file:///data/store",
      "--set",
      "persistence.enabled=true",
      "--set",
      "api.replicas=2",
    ],
    error: "several API pods need a bucket",
  },
  {
    name: "an ingress with no hosts",
    args: [...S3, "--set", "ingress.enabled=true"],
    error: "ingress.hosts",
  },
  {
    name: "the store in config",
    args: [...S3, "--set", "config.store.url=s3://other"],
    error: "config.store",
  },
  {
    name: "a listen address in config",
    args: [...S3, "--set", "config.server.listen=:8080"],
    error: "config.server.listen",
  },
  {
    name: "roles in config",
    args: [...S3, "--set", "config.server.roles={api}"],
    error: "config.server.roles",
  },
  {
    name: "a drop-in name with a dot",
    args: [...S3, "--set-json", 'dropIns={"a.b":{}}'],
    error: "a.b",
  },
  {
    name: "inline secretAccessKey without accessKeyId",
    args: [...S3, "--set", "store.credentials.secretAccessKey=only-secret"],
    error: "accessKeyId is required",
  },
  {
    name: "inline keys for a folder store",
    args: [
      "--set",
      "store.url=file:///data/store",
      "--set",
      "persistence.enabled=true",
      "--set",
      "store.credentials.accessKeyId=a",
      "--set",
      "store.credentials.secretAccessKey=b",
    ],
    error: "a folder store takes no bucket keys",
  },
  {
    name: "an az:// Secret with both key names empty",
    args: [
      "--set",
      "store.url=az://c/p",
      "--set",
      "store.credentials.existingSecret=s",
      "--set-string",
      "store.credentials.keys.accountKey=",
      "--set-string",
      "store.credentials.keys.sasToken=",
    ],
    error: "accountKey and sasToken are both empty",
  },
  {
    name: "podLabels overriding a chart selector label",
    args: [...S3, "--set-json", 'podLabels={"app.kubernetes.io/component":"other"}'],
    error: "podLabels cannot override",
  },
  {
    name: "an invalid bootstrap.secretName",
    args: [...S3, "--set", "bootstrap.secretName=Bad_Name"],
    error: "Bad_Name",
  },
  {
    name: "an unknown key in ingress.hosts",
    args: [
      ...S3,
      "--set",
      "ingress.enabled=true",
      "--set-json",
      'ingress.hosts=[{"host":"a.b","paths":[{"path":"/","pathtype":"Prefix"}]}]',
    ],
    error: "pathtype",
  },
];

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}
interface Container {
  name: string;
  image: string;
  args?: string[];
  env?: EnvVar[];
  volumeMounts?: { name: string; mountPath: string; subPath?: string }[];
}
interface Volume {
  name: string;
  configMap?: { name: string; items?: { key: string; path: string }[] };
}
interface PodSpec {
  enableServiceLinks?: boolean;
  automountServiceAccountToken?: boolean;
  containers: Container[];
  initContainers?: Container[];
  volumes?: Volume[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  spec?: PodSpec & { template?: { spec?: PodSpec } };
}

async function run(cmd: string[], stdin?: string) {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function must(cmd: string[], what: string): Promise<string> {
  const result = await run(cmd);
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const pulledImages = new Map<string, Promise<void>>();

/** Pulls an image once before parallel containers start, so cold runners do not race on pulls. */
function ensureImage(image: string): Promise<void> {
  let pending = pulledImages.get(image);
  if (pending === undefined) {
    pending = (async () => {
      const present = await run(["docker", "image", "inspect", image]);
      if (present.code !== 0) await must(["docker", "pull", image], `docker pull ${image}`);
    })();
    pulledImages.set(image, pending);
  }
  return pending;
}

function manifests(rendered: string): Manifest[] {
  return rendered
    .split(/^---\s*$/m)
    .map((doc) => Bun.YAML.parse(doc) as Manifest | null)
    .filter((doc): doc is Manifest => doc !== null && typeof doc === "object" && "kind" in doc);
}

function podSpec(manifest: Manifest): PodSpec | undefined {
  if (manifest.kind === "Pod") return manifest.spec;
  return manifest.spec?.template?.spec;
}

interface Mounted {
  /** Absolute path in the pod -> contents. */
  files: Map<string, string>;
  /** The drop-ins among them, as paths in the pod. */
  dropIns: string[];
}

/** The files the seshi container sees from ConfigMaps, at the paths it sees them. */
function mountedFiles(docs: Manifest[], spec: PodSpec, container: Container): Mounted {
  const files = new Map<string, string>();
  const dropIns: string[] = [];
  for (const mount of container.volumeMounts ?? []) {
    const volume = spec.volumes?.find((v) => v.name === mount.name);
    if (volume?.configMap === undefined) continue;
    const configMap = docs.find(
      (d) => d.kind === "ConfigMap" && d.metadata?.name === volume.configMap?.name,
    );
    if (configMap === undefined) throw new Error(`ConfigMap ${volume.configMap.name} not rendered`);
    const items =
      volume.configMap.items ??
      Object.keys(configMap.data ?? {}).map((key) => ({ key, path: key }));
    for (const item of items) {
      const content = configMap.data?.[item.key];
      if (content === undefined) throw new Error(`ConfigMap has no key ${item.key}`);
      const path = posix.join(mount.mountPath, item.path);
      files.set(path, content);
      if (item.key.startsWith("dropin.")) dropIns.push(path);
    }
  }
  return { files, dropIns };
}

function containerEnv(container: Container): string[] {
  const args: string[] = [];
  for (const variable of container.env ?? []) {
    // A value from a Secret is a stand-in: config check only needs it to be set.
    args.push("-e", `${variable.name}=${variable.value ?? "check"}`);
  }
  return args;
}

async function seshiRun(
  image: string,
  root: string,
  env: string[],
  command: string[],
): Promise<string> {
  await ensureImage(image);
  return must(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      // The pod's /tmp is an emptyDir; seshi caches the bucket's runtime config there.
      "--tmpfs",
      "/tmp",
      "--user",
      "1000:999",
      ...env,
      // Each folder the chart mounts under /etc, so the image keeps the rest of its /etc.
      ...readdirSync(join(root, "etc")).flatMap((dir) => [
        "-v",
        `${join(root, "etc", dir)}:/etc/${dir}:ro`,
      ]),
      image,
      ...command,
    ],
    `seshi ${command.join(" ")}`,
  );
}

async function checkValues(file: string, scratch: string): Promise<string> {
  const values = join(CI_VALUES, file);
  const [, rendered] = await Promise.all([
    must(["helm", "lint", CHART, "-f", values, "--strict"], `helm lint -f ${file}`),
    must(["helm", "template", RELEASE, CHART, "-f", values], `helm template -f ${file}`),
  ]);
  const docs = manifests(rendered);

  for (const doc of docs) {
    const spec = podSpec(doc);
    if (spec !== undefined && spec.enableServiceLinks !== false) {
      throw new Error(`${doc.kind} ${doc.metadata?.name} leaves service links on`);
    }
    if (spec !== undefined) checkMounts(doc, spec);
  }

  checkRoles(file, docs);
  const deployment = docs.find((d) => d.kind === "Deployment");
  const spec = deployment && podSpec(deployment);
  const container = spec?.containers.find((c) => c.name === "seshi");
  if (spec === undefined || container === undefined) throw new Error("no seshi container");
  const { files, dropIns } = mountedFiles(docs, spec, container);
  // Every drop-in the chart renders must reach the pod, not only the ones it mounts.
  const renderedDropIns = docs
    .filter((d) => d.kind === "ConfigMap")
    .flatMap((d) => Object.keys(d.data ?? {}).filter((key) => key.startsWith("dropin.")));
  if (renderedDropIns.length !== dropIns.length) {
    throw new Error(
      `the chart renders ${renderedDropIns.length} drop-in(s) but mounts ${dropIns.length} into the seshi container`,
    );
  }
  const config = container.env?.find((e) => e.name === "SESHI_CONFIG")?.value;
  if (config === undefined || !files.has(config)) {
    throw new Error(`SESHI_CONFIG (${config}) is not a file the chart mounts`);
  }

  const root = join(scratch, file.replace(/\.yaml$/, ""));
  for (const [path, content] of files) {
    if (!path.startsWith("/etc/")) throw new Error(`${path}: the check mounts only /etc`);
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    chmodSync(target, 0o644);
  }
  const env = containerEnv(container);
  const [, shownRaw] = await Promise.all([
    seshiRun(container.image, root, env, ["config", "check", "--config", config]),
    seshiRun(container.image, root, env, [
      "config",
      "show",
      "--config",
      config,
      "--origin",
      "--json",
    ]),
  ]);
  const shown = JSON.parse(shownRaw) as { values: { path: string; origin?: { path?: string } }[] };
  const origins = new Set(shown.values.map((v) => v.origin?.path).filter(Boolean));
  for (const dropIn of dropIns) {
    if (!origins.has(dropIn)) throw new Error(`seshi never read the drop-in ${dropIn}`);
  }
  return rendered;
}

/** Exactly one pod runs the worker, and the pods the Service selects serve the API. */
function checkRoles(file: string, docs: Manifest[]): void {
  let workers = 0;
  for (const doc of docs.filter((d) => d.kind === "Deployment")) {
    const args = podSpec(doc)?.containers.find((c) => c.name === "seshi")?.args ?? [];
    const roles = (args[args.indexOf("--roles") + 1] ?? "").split(",");
    const replicas = (doc.spec as { replicas?: number } | undefined)?.replicas ?? 1;
    const component = (doc.spec?.template as { metadata?: { labels?: Record<string, string> } })
      ?.metadata?.labels?.["app.kubernetes.io/component"];
    if (roles.includes("worker")) workers += replicas;
    if (component === "server" && !roles.includes("api")) {
      throw new Error(`${file}: ${doc.metadata?.name} is behind the Service but runs no API`);
    }
  }
  if (workers !== 1) throw new Error(`${file}: ${workers} pods run the worker, not 1`);
}

const KUBE_API = "/var/run/secrets/kubernetes.io/serviceaccount";

/** A key file named in a container's env must be mounted in that container, and in the bootstrap
 * Job the Kubernetes API token reaches the curl steps only, never seshi. */
function checkMounts(doc: Manifest, spec: PodSpec): void {
  const what = `${doc.kind} ${doc.metadata?.name}`;
  const containers = [...(spec.initContainers ?? []), ...spec.containers];
  for (const container of containers) {
    const mounts = container.volumeMounts ?? [];
    const keyFile = container.env?.find((e) => e.name === "GOOGLE_APPLICATION_CREDENTIALS")?.value;
    if (keyFile !== undefined && !mounts.some((m) => keyFile.startsWith(`${m.mountPath}/`))) {
      throw new Error(`${what}: ${container.name} names ${keyFile} but mounts nothing there`);
    }
    const token = mounts.some((m) => m.mountPath === KUBE_API);
    if (doc.kind === "Job" && token === container.image.includes("/seshi")) {
      throw new Error(
        `${what}: ${container.name} ${token ? "gets" : "lacks"} the Kubernetes API token`,
      );
    }
  }
  if (doc.kind === "Job" && spec.automountServiceAccountToken !== false) {
    throw new Error(`${what} mounts the Kubernetes API token in every container`);
  }
}

async function checkRefused(): Promise<void> {
  await mapLimit(REFUSED, CONCURRENCY, async (refused) => {
    const result = await run(["helm", "template", RELEASE, CHART, ...refused.args]);
    if (result.code === 0) throw new Error(`${refused.name}: the chart rendered it`);
    if (!result.stderr.includes(refused.error)) {
      throw new Error(`${refused.name}: expected "${refused.error}" in:\n${result.stderr}`);
    }
  });
}

/** Release names Helm accepts that are easy to get wrong: one YAML reads as a boolean, and one
 * long enough that "<fullname>-<suffix>" would pass Kubernetes' 63 characters. */
const AWKWARD_RELEASES = ["true", "internal-platform-observability-staging-us-west-2"];

/** Renders the chart under awkward release names, and with a `$(NAME)` in the store URL, which
 * Kubernetes would expand in args and env unless the chart writes it as `$$(NAME)`. */
async function checkAwkwardInputs(): Promise<string[]> {
  const values = join(CI_VALUES, "s3-values.yaml");
  const tasks: Promise<string>[] = [
    ...AWKWARD_RELEASES.map(async (release) => {
      const out = await must(
        ["helm", "template", release, CHART, "-f", values],
        `release ${release}`,
      );
      for (const doc of manifests(out)) {
        const name = doc.metadata?.name ?? "";
        if (name.length > 63) {
          throw new Error(`release ${release}: ${doc.kind} ${name} is too long`);
        }
      }
      return out;
    }),
    (async () => {
      const url = "s3://seshi/prod/$(TEAM)";
      const out = await must(
        ["helm", "template", RELEASE, CHART, "-f", values, "--set", `store.url=${url}`],
        "$ url",
      );
      const docs = manifests(out);
      const server = podSpec(docs.find((d) => d.kind === "Deployment") ?? {})?.containers[0];
      if (!server?.args?.includes("store.url=s3://seshi/prod/$$(TEAM)")) {
        throw new Error(
          `the server's --set store.url does not escape $: ${server?.args?.join(" ")}`,
        );
      }
      const job = podSpec(docs.find((d) => d.kind === "Job") ?? {});
      for (const container of job?.initContainers ?? []) {
        const value = container.env?.find((e) => e.name === "STORE_URL")?.value;
        if (value !== undefined && value !== "s3://seshi/prod/$$(TEAM)") {
          throw new Error(`the bootstrap's STORE_URL does not escape $: ${value}`);
        }
      }
      return out;
    })(),
    // A ServiceAccount name YAML would read as a boolean, made by the chart or not.
    ...["true", "false"].map((create) =>
      must(
        [
          "helm",
          "template",
          RELEASE,
          CHART,
          ...S3,
          "--set",
          `serviceAccount.create=${create}`,
          "--set-string",
          "serviceAccount.name=true",
        ],
        `account true (${create})`,
      ),
    ),
    // Secret keys that YAML would read as numbers: kubeconform checks these render as strings.
    ...[
      ["az://c/p", "accountKey"],
      ["gs://b/p", "serviceAccountKey"],
    ].map(([url, key]) =>
      must(
        [
          "helm",
          "template",
          RELEASE,
          CHART,
          "--set",
          `store.url=${url}`,
          "--set",
          "store.accountName=acct",
          "--set-string",
          "store.credentials.existingSecret=1234",
          "--set-string",
          `store.credentials.keys.${key}=1234`,
        ],
        `numeric ${key}`,
      ),
    ),
    // YAML boolean/number words in names, claim, class, priorityClassName, and namespace, plus a
    // redaction pack whose first line starts with spaces (requires explicit YAML block indent).
    must(
      [
        "helm",
        "template",
        RELEASE,
        CHART,
        "-n",
        "true",
        ...S3,
        "--set-string",
        "fullnameOverride=true",
        "--set",
        "persistence.enabled=true",
        "--set-string",
        "persistence.existingClaim=1234",
        "--set-string",
        "priorityClassName=1234",
        "--set",
        "ingress.enabled=true",
        "--set-string",
        "ingress.className=true",
        "--set-json",
        'ingress.hosts=[{"host":"seshi.example.com","paths":[{"path":"/"}]}]',
        "--set",
        "networkPolicy.enabled=true",
        "--set-json",
        'redactionPacks={"indented.toml":"  # leading spaces on line 1\\nid = \\"acme\\"\\n"}',
      ],
      "awkward string fields and indented redaction pack",
    ),
  ];
  return Promise.all(tasks);
}

interface Setup {
  set: string[];
  env?: Record<string, string>;
}

const ACCT = ["store.url=az://c/p", "store.accountName=acct"];
const GOV = "AccountName=acct;EndpointSuffix=core.usgovcloudapi.net";

/** Pairs of setups that seshi resolves to the same store (same: true) or to different ones, so
 * the bootstrap's fingerprint must agree or differ. */
const FINGERPRINTS: { name: string; a: Setup; b: Setup; same: boolean }[] = [
  {
    name: "az:// account from config or AZURE_STORAGE_ACCOUNT",
    a: { set: ACCT },
    b: { set: ["store.url=az://c/p"], env: { AZURE_STORAGE_ACCOUNT: "acct" } },
    same: true,
  },
  {
    name: "az:// default endpoint, implicit or written out",
    a: { set: ACCT },
    b: { set: [...ACCT, "store.endpoint=https://acct.blob.core.windows.net/"] },
    same: true,
  },
  {
    name: "az:// a connection string for another account",
    a: { set: ACCT },
    b: {
      set: ACCT,
      env: { AZURE_STORAGE_CONNECTION_STRING: "AccountName=other;BlobEndpoint=http://other" },
    },
    same: true,
  },
  {
    name: "az:// an empty BlobEndpoint overrides EndpointSuffix",
    a: { set: ["store.url=az://c/p"], env: { AZURE_STORAGE_CONNECTION_STRING: GOV } },
    b: {
      set: ["store.url=az://c/p"],
      env: { AZURE_STORAGE_CONNECTION_STRING: `${GOV};BlobEndpoint=` },
    },
    same: false,
  },
  {
    name: "az:// a BlobEndpoint after a non-breaking space",
    a: { set: ACCT },
    b: {
      set: ACCT,
      env: {
        AZURE_STORAGE_CONNECTION_STRING:
          "AccountName=acct;\u00a0BlobEndpoint=http://127.0.0.1:10000/acct",
      },
    },
    same: false,
  },
  {
    name: "az:// another account",
    a: { set: ACCT },
    b: { set: ["store.url=az://c/p", "store.accountName=other"] },
    same: false,
  },
  {
    name: "gs:// emulator as host:port or as the endpoint",
    a: { set: ["store.url=gs://b/p"], env: { STORAGE_EMULATOR_HOST: "fake-gcs:4443" } },
    b: { set: ["store.url=gs://b/p", "store.endpoint=http://fake-gcs:4443/"] },
    same: true,
  },
  {
    name: "gs:// default endpoint, implicit or written out",
    a: { set: ["store.url=gs://b/p"] },
    b: { set: ["store.url=gs://b/p", "store.endpoint=https://storage.googleapis.com"] },
    same: true,
  },
  {
    name: "gs:// Cloud Storage or an emulator",
    a: { set: ["store.url=gs://b/p"] },
    b: { set: ["store.url=gs://b/p"], env: { STORAGE_EMULATOR_HOST: "fake-gcs:4443" } },
    same: false,
  },
  {
    name: "s3:// endpoint from config or S3_ENDPOINT",
    a: { set: ["store.url=s3://b/p", "store.endpoint=http://rustfs:9000"] },
    b: { set: ["store.url=s3://b/p"], env: { S3_ENDPOINT: "http://rustfs:9000" } },
    same: true,
  },
];

/** Runs the bootstrap's store step, as the chart renders it, in the chart's seshi image. */
async function fingerprint(setup: Setup, scratch: string): Promise<string> {
  const what = setup.set.join(" ");
  const sets = setup.set.flatMap((v) => ["--set", v]);
  const docs = manifests(
    await must(["helm", "template", RELEASE, CHART, ...sets], `template ${what}`),
  );
  const config = docs.find((d) => d.kind === "ConfigMap")?.data?.["seshi.toml"];
  const job = podSpec(docs.find((d) => d.kind === "Job") ?? {});
  const store = job?.initContainers?.find((c) => c.name === "store");
  if (config === undefined || store === undefined) throw new Error("no bootstrap store step");
  await ensureImage(store.image);
  const dir = mkdtempSync(join(scratch, "fingerprint-"));
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "seshi.toml"), config);
  chmodSync(join(dir, "seshi.toml"), 0o644);
  // The pod's own env, with Kubernetes' $$ escape undone, then the setup's.
  const env: Record<string, string> = {};
  for (const variable of store.env ?? []) {
    if (variable.value !== undefined) env[variable.name] = variable.value.replaceAll("$$", "$");
  }
  Object.assign(env, setup.env);
  const docker = ["docker", "run", "--rm", "--network", "none", "--read-only"];
  docker.push("--tmpfs", "/tmp", "--tmpfs", "/work:mode=1777", "--user", "1000:999");
  docker.push("-v", `${dir}:/etc/seshi:ro`);
  for (const [name, value] of Object.entries(env)) docker.push("-e", `${name}=${value}`);
  docker.push("--entrypoint", "/bin/sh", store.image, "-c", store.args?.[0] ?? "");
  const out = await must(docker, `the store step for ${what}`);
  const id = /^store ([0-9a-f]{16}):/m.exec(out)?.[1];
  if (id === undefined) throw new Error(`the store step for ${what} printed no fingerprint`);
  return id;
}

async function checkFingerprints(scratch: string): Promise<void> {
  // Deduplicate repeated setups across pairs (such as ACCT) before fanning out.
  const unique = new Map<string, Setup>();
  const keyOf = (setup: Setup) => JSON.stringify(setup);
  for (const pair of FINGERPRINTS) {
    unique.set(keyOf(pair.a), pair.a);
    unique.set(keyOf(pair.b), pair.b);
  }
  const entries = [...unique.entries()];
  const ids = await mapLimit(entries, CONCURRENCY, ([, setup]) => fingerprint(setup, scratch));
  const byKey = new Map(entries.map(([key], i) => [key, ids[i] as string]));
  for (const pair of FINGERPRINTS) {
    const a = byKey.get(keyOf(pair.a)) as string;
    const b = byKey.get(keyOf(pair.b)) as string;
    if ((a === b) !== pair.same) {
      const want = pair.same ? "match" : "differ";
      throw new Error(`${pair.name}: fingerprints ${a} and ${b} should ${want}`);
    }
  }
}

async function kubeconform(rendered: string[]): Promise<boolean> {
  if (Bun.which("kubeconform") === null) return false;
  const result = await run(["kubeconform", "-strict", "-summary", "-"], rendered.join("\n---\n"));
  if (result.code !== 0) throw new Error(`kubeconform:\n${result.stdout}${result.stderr}`);
  return true;
}

if (import.meta.main) {
  for (const tool of ["helm", "docker"]) {
    if (Bun.which(tool) === null) {
      console.error(`seshi-check: ${tool} is not on PATH`);
      process.exit(2);
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "seshi-chart-"));
  chmodSync(scratch, 0o755);
  try {
    const files = readdirSync(CI_VALUES)
      .filter((f) => f.endsWith("-values.yaml"))
      .sort();
    const [valuesRendered, awkwardRendered] = await Promise.all([
      mapLimit(files, CONCURRENCY, (file) => checkValues(file, scratch)),
      checkAwkwardInputs(),
      checkRefused(),
      checkFingerprints(scratch),
    ]);
    for (const file of files) {
      console.log(`ok ${file}: lint, template, config check, drop-ins read`);
    }
    console.log(`ok refused: ${REFUSED.length} value sets`);
    console.log(`ok store fingerprints: ${FINGERPRINTS.length} pairs`);
    console.log(`ok release names ${AWKWARD_RELEASES.join(", ")}; $ in store.url`);
    const rendered = [...valuesRendered, ...awkwardRendered];
    console.log(
      (await kubeconform(rendered)) ? "ok kubeconform" : "skipped kubeconform: not on PATH",
    );
  } catch (err) {
    console.error(`seshi-check: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
