/**
 * validator.ts — fetch and validate /mdf.json against the MDF JSON Schema
 */

import type { ValidationResult } from "./index.ts";

// Bundled schema — avoids network dependency at runtime.
// Update this when the spec schema changes.
// Source: https://github.com/bitcryptic-gw/mdf/blob/main/mdf.schema.json
const BUNDLED_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/bitcryptic-gw/mdf/blob/main/mdf.schema.json",
  title: "MDF Site Descriptor",
  description: "Schema for /mdf.json — the MDF site capability document",
  type: "object",
  required: ["mdf_version", "site", "pricing"],
  additionalProperties: false,
  properties: {
    mdf_version: {
      type: "string",
      description: "MDF spec version this document conforms to",
      pattern: "^\\d+\\.\\d+$",
    },
    site: {
      type: "string",
      format: "uri",
      description: "Canonical base URL of the site",
    },
    name: {
      type: "string",
      description: "Human-readable site name",
    },
    pricing: {
      type: "object",
      required: ["default"],
      additionalProperties: false,
      properties: {
        default: { $ref: "#/$defs/price_rule" },
        sections: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/price_rule" },
        },
      },
    },
    payment: {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: { type: "string" },
        accepted_chains: {
          type: "array",
          items: { type: "string" },
        },
        accepted_currencies: {
          type: "array",
          items: { type: "string" },
        },
        wallet: { type: "string" },
      },
    },
    auth: {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: { type: "string" },
        token_ttl_seconds: { type: "integer", minimum: 1 },
        price_threshold: { type: "string", pattern: "^\\d+(\\.\\d+)?$" },
      },
    },
    content_signals: {
      type: "object",
      additionalProperties: false,
      properties: {
        ai_train: { type: "boolean" },
        ai_input: { type: "boolean" },
        search: { type: "boolean" },
        human_only: { type: "boolean" },
      },
    },
    formats: {
      type: "object",
      additionalProperties: false,
      properties: {
        dialect: { type: "string", enum: ["commonmark", "gfm", "agnostic"] },
        frontmatter: { type: "boolean" },
        math: { type: "boolean" },
      },
    },
    feed: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        format: { type: "string", enum: ["rss", "atom"] },
        websub_hub: { type: "string", format: "uri" },
        change_types: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "content_update",
              "new_page",
              "retraction",
              "pricing_change",
              "signal_change",
              "mdf_capability",
            ],
          },
        },
      },
    },
    llms_txt: { type: "string", format: "uri" },
    contact: { type: "string" },
  },
  $defs: {
    price_rule: {
      type: "object",
      required: ["amount"],
      additionalProperties: false,
      properties: {
        amount: { type: "string", pattern: "^\\d+(\\.\\d+)?$" },
        currency: { type: ["string", "null"] },
        chain: { type: ["string", "null"] },
      },
    },
  },
};

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

  // Validate against bundled schema
  const errors = validateAgainstSchema(doc, BUNDLED_SCHEMA);

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

/**
 * Minimal structural validator — checks required fields, types, and patterns.
 * Does not implement full JSON Schema Draft 2020-12 (no $ref resolution, no
 * format validation beyond basic checks). Sufficient for MDF's flat schema.
 */
function validateAgainstSchema(
  doc: unknown,
  schema: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  validateObject(doc, schema, "", errors);
  return errors;
}

function validateObject(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path || "root"}: expected object`);
    return;
  }

  const obj = value as Record<string, unknown>;

  // Required fields
  const required = (schema.required as string[]) ?? [];
  for (const field of required) {
    if (!(field in obj)) {
      errors.push(`${path ? path + "." : ""}${field}: required field missing`);
    }
  }

  // Properties
  const properties = (schema.properties as Record<string, unknown>) ?? {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in obj)) continue;
    validateValue(
      obj[key],
      propSchema as Record<string, unknown>,
      path ? `${path}.${key}` : key,
      errors
    );
  }

  // additionalProperties: false
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in properties)) {
        errors.push(
          `${path ? path + "." : ""}${key}: additional property not allowed`
        );
      }
    }
  }
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
) {
  const types = Array.isArray(schema.type)
  ? (schema.type as string[])
  : schema.type
  ? [schema.type as string]
  : [];

if (types.length > 0 && !types.includes("null")) {
  const actualType = Array.isArray(value) ? "array" : typeof value;
  // JSON Schema: "integer" is a subtype of "number" — typeof returns "number" for both
  const typeMatch =
    value !== null &&
    (types.includes(actualType) ||
      (types.includes("integer") && typeof value === "number" && Number.isInteger(value)));
  if (!typeMatch) {
    errors.push(`${path}: expected ${types.join(" or ")}, got ${actualType}`);
    return;
  }
}

  if (schema.type === "object" || (schema.properties && typeof value === "object")) {
    validateObject(value, schema, path, errors);
    return;
  }

  if (schema.type === "array" && Array.isArray(value)) {
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (itemSchema) {
      value.forEach((item, i) => {
        validateValue(item, itemSchema, `${path}[${i}]`, errors);
      });
    }
    return;
  }

  if (schema.pattern && typeof value === "string") {
    const re = new RegExp(schema.pattern as string);
    if (!re.test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (schema.enum && !((schema.enum as unknown[]).includes(value))) {
    errors.push(
      `${path}: must be one of ${(schema.enum as unknown[]).join(", ")}`
    );
  }

  if (schema.minimum !== undefined && typeof value === "number") {
    if (value < (schema.minimum as number)) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
  }
}
