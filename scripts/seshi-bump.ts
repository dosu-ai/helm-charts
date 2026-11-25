/**
 * Finds the newest seshi release image on ghcr.io and, with --write, moves the seshi chart to it:
 * appVersion becomes that release, and the chart's version gets the same kind of bump (a minor
 * for a new seshi minor or major, else a patch; never a major before 1.0). Prints what it found,
 * and writes `seshi`, `chart` and `kind` to $GITHUB_OUTPUT when there is a newer release
 * (.github/workflows/seshi-bump.yml).
 *
 *   bun scripts/seshi-bump.ts            # report only
 *   bun scripts/seshi-bump.ts --write    # also edit charts/seshi/Chart.yaml
 *
 * Only the image counts, not the GitHub release: a release whose image never published (as
 * 0.28.0) cannot be installed. */
import { appendFileSync } from "node:fs";

const CHART = "charts/seshi/Chart.yaml";
const IMAGE = "dosu-ai/seshi";
const write = process.argv.includes("--write");

/** Every tag of the image, following the registry's pagination. Anonymous: the image is public. */
async function tags(): Promise<string[]> {
  const auth = await fetch(`https://ghcr.io/token?scope=repository:${IMAGE}:pull`);
  if (!auth.ok) throw new Error(`ghcr.io token: ${auth.status}`);
  const { token } = (await auth.json()) as { token: string };
  const all: string[] = [];
  let next: string | null = `https://ghcr.io/v2/${IMAGE}/tags/list?n=1000`;
  while (next) {
    const page: Response = await fetch(next, { headers: { authorization: `Bearer ${token}` } });
    if (!page.ok) throw new Error(`ghcr.io tags: ${page.status}`);
    all.push(...(((await page.json()) as { tags?: string[] }).tags ?? []));
    const link = page.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    next = link ? new URL(link, "https://ghcr.io").toString() : null;
  }
  return all;
}

const text = await Bun.file(CHART).text();
const chart = Bun.YAML.parse(text) as { version: string; appVersion: string };
const current = String(chart.appVersion);

// Releases only: x.y.z, no pre-release; the x.y and latest tags move.
const releases = (await tags()).filter((tag) => /^\d+\.\d+\.\d+$/.test(tag));
const newest = releases.sort(Bun.semver.order).at(-1);
if (!newest) throw new Error(`no release tags on ghcr.io/${IMAGE}`);

if (Bun.semver.order(newest, current) <= 0) {
  console.log(`seshi ${current} is the newest image`);
  process.exit(0);
}

const [oldMajor, oldMinor] = current.split(".").map(Number);
const [newMajor, newMinor] = newest.split(".").map(Number);
const kind = newMajor !== oldMajor || newMinor !== oldMinor ? "minor" : "patch";
const [major, minor, patch] = String(chart.version).split(".").map(Number);
const version = kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
console.log(`seshi ${current} -> ${newest}; chart ${chart.version} -> ${version} (${kind})`);

if (write) {
  // Line edits, so the file's comments stay.
  let edited = text.replace(/^version: .*$/m, `version: ${version}`);
  edited = edited.replace(/^appVersion: .*$/m, `appVersion: "${newest}"`);
  const check = Bun.YAML.parse(edited) as { version: string; appVersion: string };
  if (String(check.version) !== version || String(check.appVersion) !== newest) {
    throw new Error(`${CHART}: could not set version and appVersion`);
  }
  await Bun.write(CHART, edited);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `seshi=${newest}\nchart=${version}\nkind=${kind}\n`);
}
