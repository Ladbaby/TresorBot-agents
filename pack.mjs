#!/usr/bin/env node
// Packs each adapter into a release bundle and writes the digest list.
//
//   node pack.mjs
//
// A bundle is one JSON file: {"files": {"agent.json": "...", "adapter.mjs": "..."}}.
// Earth verifies a bundle against its digest before writing anything, so the
// digest published here is what an operator passes to `agent install`.
//
// The digest scheme must match TresorBot's internal/adapters.SourceDigest:
// filenames sorted, each entry framed as <len(name)>:<name><len(body)>:<body>.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const adaptersDir = join(root, "adapters");
const distDir = join(root, "dist");

const MAX_FILES = 256;
const MAX_BYTES = 4 << 20;

function sourceDigest(files) {
  const names = Object.keys(files).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(`${name.length}:${name}${files[name].length}:${files[name]}`);
  }
  return hash.digest("hex");
}

/** Reads every file in an adapter directory, keyed by relative path. */
async function collect(dir, prefix = "") {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // node_modules is an install-time artefact, not part of the adapter source.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, await collect(full, rel));
      continue;
    }
    if (!entry.isFile()) continue;
    out[rel] = await readFile(full, "utf8");
  }
  return out;
}

await mkdir(distDir, { recursive: true });
const digests = [];
const entries = await readdir(adaptersDir, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = join(adaptersDir, entry.name);
  const files = await collect(dir);
  if (!files["agent.json"]) {
    console.error(`skip ${entry.name}: no agent.json`);
    continue;
  }
  if (Object.keys(files).length > MAX_FILES) {
    console.error(`skip ${entry.name}: too many files`);
    continue;
  }
  const manifest = JSON.parse(files["agent.json"]);
  const digest = sourceDigest(files);
  const asset = `${manifest.name.replaceAll("/", "-")}-${manifest.version}.json`;
  await writeFile(join(distDir, asset), JSON.stringify({ files }), "utf8");
  const size = (await stat(join(distDir, asset))).size;
  digests.push({ name: manifest.name, version: manifest.version, asset, digest, bytes: size });
  console.log(`packed ${manifest.name} ${manifest.version} -> dist/${asset} (${size} bytes)`);
  console.log(`  sha256 ${digest}`);
}

digests.sort((a, b) => a.name.localeCompare(b.name));
const lines = digests.map((d) => `${d.asset}  ${d.digest}  ${d.name}@${d.version}`);
await writeFile(join(distDir, "digests.txt"), lines.join("\n") + "\n", "utf8");
console.log(`\nwrote dist/digests.txt (${digests.length} adapter${digests.length === 1 ? "" : "s"})`);
