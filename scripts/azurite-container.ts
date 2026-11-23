/** Creates a blob container in Azurite for scripts/seshi-e2e.sh (STORE=az): seshi needs the
 * container to exist, and Azurite makes none on its own. One Create Container request, signed
 * with Shared Key the way the Blob service documents it.
 *
 *   bun scripts/azurite-container.ts <blob endpoint> <account> <account key> <container>
 *
 * e.g. http://127.0.0.1:10010/devstoreaccount1 devstoreaccount1 <Azurite's key> seshi-e2e.
 * A container that exists already (409) is fine. */
import { createHmac } from "node:crypto";

const [endpoint, account, key, container] = process.argv.slice(2);
if (!endpoint || !account || !key || !container) {
  console.error("usage: bun scripts/azurite-container.ts <endpoint> <account> <key> <container>");
  process.exit(2);
}

const url = new URL(`${endpoint.replace(/\/+$/, "")}/${container}?restype=container`);
const date = new Date().toUTCString();
const version = "2023-11-03";
// VERB, eleven standard headers (all empty here), the x-ms-* headers, then the resource: the
// account, the URL's path, and each query parameter on its own line.
const toSign = [
  "PUT",
  ...Array(11).fill(""),
  `x-ms-date:${date}`,
  `x-ms-version:${version}`,
  `/${account}${url.pathname}\nrestype:container`,
].join("\n");
const signature = createHmac("sha256", Buffer.from(key, "base64")).update(toSign).digest("base64");

const response = await fetch(url, {
  method: "PUT",
  headers: {
    "x-ms-date": date,
    "x-ms-version": version,
    authorization: `SharedKey ${account}:${signature}`,
  },
});
if (response.status !== 201 && response.status !== 409) {
  console.error(`create ${container}: ${response.status} ${await response.text()}`);
  process.exit(1);
}
console.log(`container ${container}: ${response.status === 201 ? "created" : "exists"}`);
