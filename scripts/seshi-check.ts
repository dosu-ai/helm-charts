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

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
		args: [
			"--set",
			"store.url=file:///tmp/store",
			"--set",
			"persistence.enabled=true",
		],
		error: "must be under /data",
	},
	{
		name: "a folder store climbing out of the claim",
		args: [
			"--set",
			"store.url=file:///data/../tmp",
			"--set",
			"persistence.enabled=true",
		],
		error: "must be under /data",
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
	containers: Container[];
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
		throw new Error(
			`${what} failed (exit ${result.code}):\n${result.stdout}${result.stderr}`,
		);
	}
	return result.stdout;
}

function manifests(rendered: string): Manifest[] {
	return rendered
		.split(/^---\s*$/m)
		.map((doc) => Bun.YAML.parse(doc) as Manifest | null)
		.filter(
			(doc): doc is Manifest =>
				doc !== null && typeof doc === "object" && "kind" in doc,
		);
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
function mountedFiles(
	docs: Manifest[],
	spec: PodSpec,
	container: Container,
): Mounted {
	const files = new Map<string, string>();
	const dropIns: string[] = [];
	for (const mount of container.volumeMounts ?? []) {
		const volume = spec.volumes?.find((v) => v.name === mount.name);
		if (volume?.configMap === undefined) continue;
		const configMap = docs.find(
			(d) =>
				d.kind === "ConfigMap" && d.metadata?.name === volume.configMap?.name,
		);
		if (configMap === undefined)
			throw new Error(`ConfigMap ${volume.configMap.name} not rendered`);
		const items =
			volume.configMap.items ??
			Object.keys(configMap.data ?? {}).map((key) => ({ key, path: key }));
		for (const item of items) {
			const content = configMap.data?.[item.key];
			if (content === undefined)
				throw new Error(`ConfigMap has no key ${item.key}`);
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

function seshiRun(
	image: string,
	root: string,
	env: string[],
	command: string[],
): string {
	return must(
		[
			"docker",
			"run",
			"--rm",
			"--network",
			"none",
			"--read-only",
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
	must(
		["helm", "lint", CHART, "-f", values, "--strict"],
		`helm lint -f ${file}`,
	);
	const rendered = must(
		["helm", "template", RELEASE, CHART, "-f", values],
		`helm template -f ${file}`,
	);
	const docs = manifests(rendered);

	for (const doc of docs) {
		const spec = podSpec(doc);
		if (spec !== undefined && spec.enableServiceLinks !== false) {
			throw new Error(
				`${doc.kind} ${doc.metadata?.name} leaves service links on`,
			);
		}
	}

	const deployment = docs.find((d) => d.kind === "Deployment");
	const spec = deployment && podSpec(deployment);
	const container = spec?.containers.find((c) => c.name === "seshi");
	if (spec === undefined || container === undefined)
		throw new Error("no seshi container");
	const { files, dropIns } = mountedFiles(docs, spec, container);
	const config = container.env?.find((e) => e.name === "SESHI_CONFIG")?.value;
	if (config === undefined || !files.has(config)) {
		throw new Error(`SESHI_CONFIG (${config}) is not a file the chart mounts`);
	}

	const root = join(scratch, file.replace(/\.yaml$/, ""));
	for (const [path, content] of files) {
		if (!path.startsWith("/etc/"))
			throw new Error(`${path}: the check mounts only /etc`);
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
	const origins = new Set(
		shown.values.map((v) => v.origin?.path).filter(Boolean),
	);
	for (const dropIn of dropIns) {
		if (!origins.has(dropIn))
			throw new Error(`seshi never read the drop-in ${dropIn}`);
	}
	return rendered;
}

function checkRefused(): void {
	for (const refused of REFUSED) {
		const result = run(["helm", "template", RELEASE, CHART, ...refused.args]);
		if (result.code === 0)
			throw new Error(`${refused.name}: the chart rendered it`);
		if (!result.stderr.includes(refused.error)) {
			throw new Error(
				`${refused.name}: expected "${refused.error}" in:\n${result.stderr}`,
			);
		}
	}
}

function kubeconform(rendered: string[]): boolean {
	if (Bun.which("kubeconform") === null) return false;
	const result = run(
		["kubeconform", "-strict", "-summary", "-"],
		rendered.join("\n---\n"),
	);
	if (result.code !== 0)
		throw new Error(`kubeconform:\n${result.stdout}${result.stderr}`);
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
		console.log(
			kubeconform(rendered)
				? "ok kubeconform"
				: "skipped kubeconform: not on PATH",
		);
	} catch (err) {
		console.error(`seshi-check: ${(err as Error).message}`);
		process.exitCode = 1;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
