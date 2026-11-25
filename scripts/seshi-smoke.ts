/** The HTTP half of scripts/seshi-e2e.sh, against a seshi the chart installed.
 *
 *   bun scripts/seshi-smoke.ts <base url> <admin init JSON> upload
 *     uploads a synthetic Claude Code session with the org key, checks that an upload from
 *     the repository ci/kind-values.yaml excludes is refused, reads the trace back and waits
 *     for search to find the session
 *   bun scripts/seshi-smoke.ts <base url> <admin init JSON> search
 *     only waits for search to find it (after the pod is replaced) */

const [base, initFile, mode] = process.argv.slice(2);
if (base === undefined || initFile === undefined || !["upload", "search"].includes(mode ?? "")) {
  console.error("usage: bun scripts/seshi-smoke.ts <base url> <init.json> upload|search");
  process.exit(2);
}

const SESSION = "0b5e7a1c-5e5e-4c1a-9d1e-c4a27e2e0001";
const WORD = "Kubernetesdeploy";
const init = (await Bun.file(initFile).json()) as { org_key?: { token?: string } };
const key = init.org_key?.token;
if (key === undefined) throw new Error(`${initFile}: no org_key.token`);
const headers = {
  authorization: `Bearer ${key}`,
  "x-seshi-user": "chart-e2e",
  "content-type": "application/json",
};

/** A synthetic session, long enough to pass the server's 2000-character filter. */
function transcript(sessionId: string): string {
  const records = [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-11-01T00:00:00.000Z",
      cwd: "/work/widget",
      sessionId,
      message: { role: "user", content: `Run the ${WORD} steps for the widget service.` },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-11-01T00:00:05.000Z",
      sessionId,
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `On it. ${"Each step, in order. ".repeat(120)}` }],
      },
    },
  ];
  return records.map((r) => `${JSON.stringify(r)}\n`).join("");
}

async function upload(sessionId: string, repo: string): Promise<Response> {
  return fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      format: "claude-code",
      session_id: sessionId,
      transcript: transcript(sessionId),
      repo,
    }),
  });
}

function expect(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
  console.log(`ok ${what}`);
}

if (mode === "upload") {
  const stored = await upload(SESSION, "github.com/acme/widget");
  const body = (await stored.json()) as { status?: string };
  expect(stored.status === 201 && body.status === "stored", `upload stored (${stored.status})`);

  const excluded = await upload(`${SESSION}-x`, "github.com/acme/secret");
  const refusal = (await excluded.json()) as { error?: { code?: string } };
  expect(
    excluded.status === 403 && refusal.error?.code === "excluded",
    `upload from an excluded repository refused (${excluded.status})`,
  );

  const trace = await fetch(`${base}/v1/sessions/claude-code/${SESSION}/trace`, { headers });
  expect(trace.status === 200 && (await trace.text()).includes(WORD), "trace read back");
}

let found = false;
for (let attempt = 0; attempt < 90 && !found; attempt++) {
  const search = await fetch(`${base}/v1/search?q=${WORD}`, { headers });
  // 503 index_building while a new pod rebuilds the index from the bucket.
  if (search.status === 200) found = ((await search.json()) as { total: number }).total >= 1;
  if (!found) await Bun.sleep(1000);
}
expect(found, "search finds the session");
