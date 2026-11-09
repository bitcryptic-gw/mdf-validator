#!/usr/bin/env node
/**
 * Regenerates src/vendor/defaultAssets.json from the vendored, verbatim copy of
 * upstream typescript/packages/mechanisms/evm/src/defaultAssets.ts.
 *
 * The upstream file is a TypeScript module (it imports types from @x402/core and
 * a constants module), so it cannot be imported by this repo. It is kept
 * verbatim as provenance; this script extracts the data it exports.
 *
 * Usage: node scripts/extract-default-assets.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC = "src/vendor/upstream/defaultAssets.ts";
const OUT = "src/vendor/defaultAssets.json";
const UPSTREAM = "x402-foundation/x402@513dd66d2b3eb2388065f9923d81aa496e626082:typescript/packages/mechanisms/evm/src/defaultAssets.ts";

const text = readFileSync(SRC, "utf8");
const sha256 = createHash("sha256").update(text).digest("hex");

// Top-level network blocks: `  "eip155:8453": [ ... ],` up to the matching `],`
const blockRe = /^ {2}"([-a-z0-9]+:[-_a-zA-Z0-9]+)": \[(.*?)^ {2}\],/gms;
const networks = {};
for (const m of text.matchAll(blockRe)) {
  const [, network, body] = m;
  const entries = [];
  for (const e of body.matchAll(/\{(.*?)\}/gs)) {
    const obj = {};
    for (const f of e[1].matchAll(/(\w+):\s*(?:"([^"]*)"|([0-9]+))/g)) {
      obj[f[1]] = f[2] !== undefined ? f[2] : Number(f[3]);
    }
    entries.push(obj);
  }
  if (entries.length) networks[network] = entries;
}

const doc = {
  _source: UPSTREAM,
  _source_sha256: sha256,
  _note: "Extracted by scripts/extract-default-assets.mjs. Do not edit by hand.",
  networks,
};
writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${OUT}: ${Object.keys(networks).length} networks, source sha256 ${sha256}`);
