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
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHART = join(ROOT, "charts/seshi");
const CI_VALUES = join(CHART, "ci");
const RELEASE = "seshi";

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

function run(cmd: string[], stdin?: string) {
  const proc = Bun.spawnSync(cmd, {
    cwd: ROOT,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function must(cmd: string[], what: string): string {
  const result = run(cmd);
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
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

function seshiRun(image: string, root: string, env: string[], command: string[]): string {
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

function checkValues(file: string, scratch: string): string {
  const values = join(CI_VALUES, file);
  must(["helm", "lint", CHART, "-f", values, "--strict"], `helm lint -f ${file}`);
  const rendered = must(
    ["helm", "template", RELEASE, CHART, "-f", values],
    `helm template -f ${file}`,
  );
  const docs = manifests(rendered);

  for (const doc of docs) {
    const spec = podSpec(doc);
    if (spec !== undefined && spec.enableServiceLinks !== false) {
      throw new Error(`${doc.kind} ${doc.metadata?.name} leaves service links on`);
    }
    if (spec !== undefined) checkMounts(doc, spec);
  }

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
  seshiRun(container.image, root, env, ["config", "check", "--config", config]);
  const shown = JSON.parse(
    seshiRun(container.image, root, env, [
      "config",
      "show",
      "--config",
      config,
      "--origin",
      "--json",
    ]),
  ) as { values: { path: string; origin?: { path?: string } }[] };
  const origins = new Set(shown.values.map((v) => v.origin?.path).filter(Boolean));
  for (const dropIn of dropIns) {
    if (!origins.has(dropIn)) throw new Error(`seshi never read the drop-in ${dropIn}`);
  }
  return rendered;
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

function checkRefused(): void {
  for (const refused of REFUSED) {
    const result = run(["helm", "template", RELEASE, CHART, ...refused.args]);
    if (result.code === 0) throw new Error(`${refused.name}: the chart rendered it`);
    if (!result.stderr.includes(refused.error)) {
      throw new Error(`${refused.name}: expected "${refused.error}" in:\n${result.stderr}`);
    }
  }
}

/** Release names Helm accepts that are easy to get wrong: one YAML reads as a boolean, and one
 * long enough that "<fullname>-<suffix>" would pass Kubernetes' 63 characters. */
const AWKWARD_RELEASES = ["true", "internal-platform-observability-staging-us-west-2"];

/** Renders the chart under awkward release names, and with a `$(NAME)` in the store URL, which
 * Kubernetes would expand in args and env unless the chart writes it as `$$(NAME)`. */
function checkAwkwardInputs(): string[] {
  const rendered: string[] = [];
  const values = join(CI_VALUES, "s3-values.yaml");
  for (const release of AWKWARD_RELEASES) {
    const out = must(["helm", "template", release, CHART, "-f", values], `release ${release}`);
    for (const doc of manifests(out)) {
      const name = doc.metadata?.name ?? "";
      if (name.length > 63) throw new Error(`release ${release}: ${doc.kind} ${name} is too long`);
    }
    rendered.push(out);
  }
  const url = "s3://seshi/prod/$(TEAM)";
  const out = must(
    ["helm", "template", RELEASE, CHART, "-f", values, "--set", `store.url=${url}`],
    "$ url",
  );
  const docs = manifests(out);
  const server = podSpec(docs.find((d) => d.kind === "Deployment") ?? {})?.containers[0];
  if (!server?.args?.includes("store.url=s3://seshi/prod/$$(TEAM)")) {
    throw new Error(`the server's --set store.url does not escape $: ${server?.args?.join(" ")}`);
  }
  const job = podSpec(docs.find((d) => d.kind === "Job") ?? {});
  for (const container of job?.initContainers ?? []) {
    const value = container.env?.find((e) => e.name === "STORE_URL")?.value;
    if (value !== undefined && value !== "s3://seshi/prod/$$(TEAM)") {
      throw new Error(`the bootstrap's STORE_URL does not escape $: ${value}`);
    }
  }
  // A ServiceAccount name YAML would read as a boolean, made by the chart or not.
  for (const create of ["true", "false"]) {
    const args = [...S3, "--set", `serviceAccount.create=${create}`];
    args.push("--set-string", "serviceAccount.name=true");
    rendered.push(must(["helm", "template", RELEASE, CHART, ...args], `account true (${create})`));
  }
  // Secret keys that YAML would read as numbers: kubeconform checks these render as strings.
  for (const [url, key] of [
    ["az://c/p", "accountKey"],
    ["gs://b/p", "serviceAccountKey"],
  ]) {
    const args = ["--set", `store.url=${url}`, "--set", "store.accountName=acct"];
    args.push("--set-string", "store.credentials.existingSecret=1234");
    args.push("--set-string", `store.credentials.keys.${key}=1234`);
    rendered.push(must(["helm", "template", RELEASE, CHART, ...args], `numeric ${key}`));
  }
  return rendered;
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
function fingerprint(setup: Setup, scratch: string): string {
  const what = setup.set.join(" ");
  const sets = setup.set.flatMap((v) => ["--set", v]);
  const docs = manifests(must(["helm", "template", RELEASE, CHART, ...sets], `template ${what}`));
  const config = docs.find((d) => d.kind === "ConfigMap")?.data?.["seshi.toml"];
  const job = podSpec(docs.find((d) => d.kind === "Job") ?? {});
  const store = job?.initContainers?.find((c) => c.name === "store");
  if (config === undefined || store === undefined) throw new Error("no bootstrap store step");
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
  const out = must(docker, `the store step for ${what}`);
  const id = /^store ([0-9a-f]{16}):/m.exec(out)?.[1];
  if (id === undefined) throw new Error(`the store step for ${what} printed no fingerprint`);
  return id;
}

function checkFingerprints(scratch: string): void {
  for (const pair of FINGERPRINTS) {
    const a = fingerprint(pair.a, scratch);
    const b = fingerprint(pair.b, scratch);
    if ((a === b) !== pair.same) {
      const want = pair.same ? "match" : "differ";
      throw new Error(`${pair.name}: fingerprints ${a} and ${b} should ${want}`);
    }
  }
}

function kubeconform(rendered: string[]): boolean {
  if (Bun.which("kubeconform") === null) return false;
  const result = run(["kubeconform", "-strict", "-summary", "-"], rendered.join("\n---\n"));
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
    const rendered: string[] = [];
    for (const file of readdirSync(CI_VALUES)
      .filter((f) => f.endsWith("-values.yaml"))
      .sort()) {
      rendered.push(checkValues(file, scratch));
      console.log(`ok ${file}: lint, template, config check, drop-ins read`);
    }
    checkRefused();
    console.log(`ok refused: ${REFUSED.length} value sets`);
    rendered.push(...checkAwkwardInputs());
    checkFingerprints(scratch);
    console.log(`ok store fingerprints: ${FINGERPRINTS.length} pairs`);
    console.log(`ok release names ${AWKWARD_RELEASES.join(", ")}; $ in store.url`);
    console.log(kubeconform(rendered) ? "ok kubeconform" : "skipped kubeconform: not on PATH");
  } catch (err) {
    console.error(`seshi-check: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
