/**
 * validator.ts — fetch and validate `/mdf.json`.
 *
 * Two spec generations are supported. Which schema applies is decided by the
 * version the document *declares* (`mdf_version`), never by what happens to
 * validate: a 0.2.x document is checked against the 0.2.0 schema and reported
 * as legacy, so "valid" never silently means "valid against an older spec".
 */

import type { ValidationResult } from "./result.ts";
import { fail, pass, info, warn } from "./result.ts";
import { specMajorOf, validateMdfDocumentFor, validate402For } from "./schemas.ts";
import type { SpecMajor } from "./schemas.ts";
import { USER_AGENT } from "./user-agent.ts";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed /mdf.json document against the schema matching the version
 * it declares. Returns an empty array when valid.
 */
export function validateMdfDocument(doc: unknown): string[] {
  const declared = isObject(doc) ? doc.mdf_version : undefined;
  return validateMdfDocumentFor(doc, specMajorOf(declared));
}

/**
 * Validate a parsed 402 body. x402 v2 bodies are checked against the 0.3.0
 * schema; anything else falls back to the 0.2.0 schema (legacy).
 */
export function validate402Body(body: unknown): string[] {
  const major: SpecMajor = isObject(body) && body.x402Version === 2 ? "0.3" : "0.2";
  return validate402For(body, major);
}

export interface MdfJsonResult extends ValidationResult {
  /** Parsed document, present when the response parsed as JSON. */
  doc?: Record<string, unknown>;
  /** Spec generation the document declares. */
  major?: SpecMajor;
  /** The page was served as HTML — the D1 "SPA fallback" case. */
  htmlFallback?: boolean;
}

export async function validateMdfJson(baseUrl: string, timeout: number): Promise<MdfJsonResult> {
  const mdfUrl = `${baseUrl}/mdf.json`;

  let body: string;
  let status: number;
  let contentType: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(mdfUrl, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    status = res.status;
    contentType = res.headers.get("content-type") ?? "";
    body = await res.text();
  } catch (err: any) {
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message: err?.name === "AbortError" ? "timed out" : `fetch failed (${err?.message ?? "unknown error"})`,
    };
  }

  if (status === 404) {
    // No /mdf.json is not a defect: plenty of x402 publishers are not MDF
    // sites. The x402 checks still run below (finding B1) — this result is a
    // statement about MDF conformance, not a gate.
    return {
      pass: false,
      level: "warn",
      label: mdfUrl,
      message: "HTTP 404 — no MDF capability document; not an MDF site (x402 checks are independent)",
    };
  }

  if (status !== 200) {
    return { pass: false, level: "error", label: mdfUrl, message: `HTTP ${status}` };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    const html = /text\/html/i.test(contentType);
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message: html
        ? `response is not valid JSON (served as ${contentType} — likely an HTML page or SPA fallback, not a capability document)`
        : "response is not valid JSON",
      htmlFallback: html,
    };
  }

  if (!isObject(doc)) {
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message: "response is JSON but not an object",
    };
  }

  const declared = doc.mdf_version;
  const major = specMajorOf(declared);
  const errors = validateMdfDocumentFor(doc, major);

  if (errors.length > 0) {
    return {
      pass: false,
      level: "error",
      label: mdfUrl,
      message: `schema validation failed (checked against MDF ${major}.x)`,
      errors,
      doc,
      major,
    };
  }

  return {
    pass: true,
    level: "info",
    label: mdfUrl,
    message: `valid (MDF v${String(declared)})`,
    doc,
    major,
  };
}

/** A short, explicit line about which spec generation the site claims. */
export function declaredVersionResult(result: MdfJsonResult): ValidationResult | null {
  if (!result.doc || !result.major) return null;
  const declared = String(result.doc.mdf_version);
  if (result.major === "0.3") {
    return info(`${result.label} (version)`, `declares MDF ${declared} — checked as 0.3.x`);
  }
  return warn(
    `${result.label} (version)`,
    `not MDF 0.3.0 conformant: declares ${declared}; 0.3.0 requires 0.3.x and an x402 v2 402. Validated against the 0.2 schema so the rest of the report is still meaningful.`
  );
}
