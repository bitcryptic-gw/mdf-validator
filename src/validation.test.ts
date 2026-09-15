/**
 * validation.test.ts — schema validation regression tests.
 *
 * Fixture documents live in src/fixtures/. See BASELINE-OLD-ENGINE.md for the
 * pre-Ajv verdicts; every fixture the old engine wrongly passed is asserted
 * invalid here.
 *
 * Run with: bun test
 */

import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { validateMdfDocument, validate402Body } from "./validator.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

function loadDoc(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const cases: Array<{
  file: string;
  valid: boolean;
  expectErrorsContaining?: string[];
}> = [
  { file: "demo.json", valid: true },
  { file: "missing-amount.json", valid: false },
  { file: "format-uri.json", valid: false },
  { file: "minitems.json", valid: false },
  { file: "uniqueitems.json", valid: false },
  { file: "propertynames-valid.json", valid: true },
  { file: "minimum.json", valid: false },
  { file: "dialects-rss2.json", valid: true },
  { file: "dialect-other.json", valid: true },
];

for (const c of cases) {
  test(`mdf.json fixture ${c.file} is ${c.valid ? "valid" : "invalid"}`, () => {
    const errors = validateMdfDocument(loadDoc(c.file));
    if (c.valid) {
      expect(errors).toEqual([]);
    } else {
      expect(errors.length).toBeGreaterThan(0);
    }
  });
}

test("missing-amount: pricing.default must have required amount", () => {
  const errors = validateMdfDocument(loadDoc("missing-amount.json"));
  expect(errors.join("\n")).toContain("/pricing/default");
  expect(errors.join("\n")).toContain("must have required property 'amount'");
});

test("missing-amount: section amount 'abc' fails the decimal pattern", () => {
  const errors = validateMdfDocument(loadDoc("missing-amount.json"));
  expect(errors.join("\n")).toContain("/pricing/sections/");
  expect(errors.join("\n")).toContain("must match pattern");
});

test("format-uri: site must be a uri", () => {
  const errors = validateMdfDocument(loadDoc("format-uri.json"));
  expect(errors.join("\n")).toContain("/site");
  expect(errors.join("\n")).toContain("uri");
});

test("minitems: accepted_chains must have at least 1 item", () => {
  const errors = validateMdfDocument(loadDoc("minitems.json"));
  expect(errors.join("\n")).toContain("/payment/accepted_chains");
  expect(errors.join("\n")).toContain("fewer than 1");
});

test("uniqueitems: accepted_chains must not contain duplicates", () => {
  const errors = validateMdfDocument(loadDoc("uniqueitems.json"));
  expect(errors.join("\n")).toContain("/payment/accepted_chains");
  expect(errors.join("\n")).toContain("duplicate");
});

test("minimum: token_ttl_seconds must be >= 60", () => {
  const errors = validateMdfDocument(loadDoc("minimum.json"));
  expect(errors.join("\n")).toContain("/auth/token_ttl_seconds");
  expect(errors.join("\n")).toContain("60");
});

test("demo.json from the live site is valid", () => {
  expect(validateMdfDocument(loadDoc("demo.json"))).toEqual([]);
});

// ---------------------------------------------------------------------------
// 402 response bodies (mdf-402.schema.json)
// ---------------------------------------------------------------------------

const p402 = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, "402", name), "utf8"));

test("402 valid body passes", () => {
  expect(validate402Body(p402("valid.json"))).toEqual([]);
});

test("402 token_estimate without token_estimate_note violates dependentRequired", () => {
  const errors = validate402Body(p402("invalid-dependent-required.json"));
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.join("\n")).toContain("token_estimate_note");
});

// ---------------------------------------------------------------------------
// x402-superset fields conditional (MDF 0.2.0 — Vikunja #28)
//
// mdf-402.schema.json's payment.allOf/if/then requires pay_to, asset, scheme
// and max_timeout_seconds when rail is "x402". These fixtures were added
// when the vendored schema copy was synced with the spec's 0.2.0 update
// (previously stale since 2026-09-05, missing this entire conditional — see
// Vikunja #28). "402 valid body passes" above already covers the positive
// x402 case now that valid.json carries all four fields.
// ---------------------------------------------------------------------------

test("402 x402 offer missing the superset fields fails the conditional", () => {
  const errors = validate402Body(p402("invalid-x402-missing-superset-fields.json"));
  expect(errors.length).toBeGreaterThan(0);
  const joined = errors.join("\n");
  expect(joined).toContain("pay_to");
  expect(joined).toContain("asset");
  expect(joined).toContain("scheme");
  expect(joined).toContain("max_timeout_seconds");
});

test("402 l402 offer is not required to carry the x402-superset fields", () => {
  expect(validate402Body(p402("valid-l402-no-superset-fields-required.json"))).toEqual([]);
});
