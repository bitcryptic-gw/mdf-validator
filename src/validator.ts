/**
 * validator.ts — fetch and validate /mdf.json against the MDF JSON Schema.
 *
 * Validation uses Ajv (draft 2020-12) against vendored copies of the spec
 * schemas, replacing a hand-rolled engine that silently ignored $ref/$defs,
 * additionalProperties-as-schema, format, minItems, uniqueItems and more
 * (see src/fixtures/BASELINE-OLD-ENGINE.md). Schemas are bundled — no network
 * fetch at runtime. Update them by copying from
 * https://github.com/bitcryptic-gw/mdf when the spec schema changes.
 */

import type { ValidationResult } from "./index.ts";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject } from "ajv";
import mdfSchema from "./schemas/mdf.schema.json";
import body402Schema from "./schemas/mdf-402.schema.json";

// Single Ajv instance, compiled once at startup.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const isMdfDoc = ajv.compile(mdfSchema);
const is402Body = ajv.compile(body402Schema);

// ---------------------------------------------------------------------------
// Pure validation helpers (used by the CLI and by tests)
// ---------------------------------------------------------------------------

/**
 * Validate a parsed /mdf.json document against the MDF site descriptor schema.
 * Returns an empty array when valid, otherwise one message per violation.
 */
export function validateMdfDocument(doc: unknown): string[] {
  if (isMdfDoc(doc)) return [];
  return formatErrors(isMdfDoc.errors ?? []);
}

/**
 * Validate a parsed 402 Payment Required response body against the
 * mdf-402.schema.json schema. Returns an empty array when valid, otherwise
 * one message per violation. The reference server's build402Response output is
 * the shape this is expected to accept.
 *
 * Nothing in the CLI exercises this against a live site yet — exercising a
 * paid flow would require the validator to submit or simulate a payment. The
 * path is wired and fixture-tested so a live 402 can be dropped in later.
 */
export function validate402Body(body: unknown): string[] {
  if (is402Body(body)) return [];
  return formatErrors(is402Body.errors ?? []);
}

function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map((e) => {
    const path = e.instancePath || "(root)";
    return `${path}: ${e.message ?? "invalid"}`;
  });
}

// ---------------------------------------------------------------------------
// CLI-facing fetch + validate
// ---------------------------------------------------------------------------

export async function validateMdfJson(
  baseUrl: string,
  timeout: number
): Promise<ValidationResult> {
  const mdfUrl = `${baseUrl}/mdf.json`;

  // Fetch
  let body: string;
  let status: number;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(mdfUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    status = res.status;
    body = await res.text();
  } catch (err: any) {
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message:
        err?.name === "AbortError"
          ? "timed out"
          : `fetch failed (${err?.message ?? "unknown error"})`,
    };
  }

  if (status !== 200) {
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message: `HTTP ${status}`,
    };
  }

  // Parse
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message: "response is not valid JSON",
    };
  }

  const errors = validateMdfDocument(doc);

  if (errors.length > 0) {
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message: "schema validation failed",
      errors,
    };
  }

  const typed = doc as Record<string, unknown>;
  return {
    pass: true,
    level: "info",
    label: mdfUrl,
    message: `valid (MDF v${typed.mdf_version})`,
    data: typed,
  };
}
