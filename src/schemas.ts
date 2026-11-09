/**
 * schemas.ts — the compiled JSON Schemas, and shape detection.
 *
 * Two spec generations are vendored: 0.3.0 (the current one, in
 * `schemas/`) and 0.2.0 (`schemas/legacy-0.2/`, kept so older third-party
 * sites can still be read). Which one applies is decided by what the document
 * declares, never by what happens to validate.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject } from "ajv";

import mdfSchemaV3 from "./schemas/mdf.schema.json";
import schema402V3 from "./schemas/mdf-402.schema.json";
import mdfSchemaV2 from "./schemas/legacy-0.2/mdf.schema.json";
import schema402V2 from "./schemas/legacy-0.2/mdf-402.schema.json";

// One Ajv instance per spec generation: the 0.2.0 and 0.3.0 schemas declare
// the same `$id`, so they cannot share a registry.
function compileWith<T>(schema: object, get: (ajv: Ajv2020) => T): T {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return get(ajv);
}

const v2Doc = compileWith(mdfSchemaV2, (ajv) => ajv.compile(mdfSchemaV2));
const v2Body = compileWith(schema402V2, (ajv) => ajv.compile(schema402V2));
const v3Doc = compileWith(mdfSchemaV3, (ajv) => ajv.compile(mdfSchemaV3));
const v3Body = compileWith(schema402V3, (ajv) => ajv.compile(schema402V3));

/**
 * The x402 core profile of the 0.3.0 402 schema.
 *
 * MDF's schema is deliberately stricter than x402: it requires `extensions`
 * and requires the `mdf` key inside it, because every MDF 402 carries one.
 * A third-party x402 v2 site is under no such obligation — the ProofLines run
 * is the standing example — so applying MDF's profile to it would fail a
 * conformant site. This copy drops exactly those two requirements and nothing
 * else, so the closed-root / open-accepts / open-extensions profile still
 * applies to a non-MDF offer.
 */
const coreSchema402V3 = (() => {
  const clone = structuredClone(schema402V3) as Record<string, any>;
  clone.required = (clone.required as string[]).filter((k) => k !== "extensions");
  if (clone.properties?.extensions) delete clone.properties.extensions.required;
  return clone;
})();
const v3BodyCore = compileWith(coreSchema402V3, (ajv) => ajv.compile(coreSchema402V3));

export type SpecMajor = "0.2" | "0.3";

/** "0.3.0"/"0.3" → "0.3"; anything else, including a missing field, → "0.2". */
export function specMajorOf(version: unknown): SpecMajor {
  if (typeof version !== "string") return "0.2";
  return /^\s*0\.3(\.|$)/.test(version) ? "0.3" : "0.2";
}

export function validateMdfDocumentFor(doc: unknown, major: SpecMajor): string[] {
  const validate = major === "0.3" ? v3Doc : v2Doc;
  if (validate(doc)) return [];
  return format(validate.errors ?? []);
}

export function validate402For(doc: unknown, major: SpecMajor): string[] {
  const validate = major === "0.3" ? v3Body : v2Body;
  if (validate(doc)) return [];
  return format(validate.errors ?? []);
}

/**
 * Raw Ajv errors for a v2 PaymentRequired, so the caller can attribute each
 * one to a rail (`/accepts/<i>/...`) or to the envelope.
 */
export function validate402V2Errors(doc: unknown, mdfProfile = true): ErrorObject[] | null {
  const validate = mdfProfile ? v3Body : v3BodyCore;
  return validate(doc) ? null : (validate.errors ?? []);
}

function format(errors: ErrorObject[]): string[] {
  return errors.map((e) => `${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`);
}
