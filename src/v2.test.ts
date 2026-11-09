/**
 * v2.test.ts — per-rail evaluation, header agreement, and the semantic checks
 * that a JSON Schema cannot express (spec 0.3.0 / x402 v2).
 *
 * Fixtures live in src/fixtures/v2/. Each is `{ note, url, body, headers,
 * headerBody?, mdf? }`; `"$BODY"` in a header value means "base64 of the body
 * (or of headerBody when the fixture is header-only)". No network here.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { evaluate402Response, evaluatePaidResponse, classifyRail } from "./evaluate.ts";
import type { Evaluate402Input, ResponseHeaders } from "./evaluate.ts";
import { encodePaymentRequiredHeader, firstDifference, decodePaymentRequiredHeader, MAX_HEADER_CHARS } from "./payment-required.ts";
import { parseNetwork, normaliseLegacyNetwork, isCaip2 } from "./network.ts";
import { expectedAsset, humanAmount } from "./assets.ts";
import { priceEntryForPath, tokenAccessWithoutAuth, allPriceEntries } from "./mdf.ts";
import { specMajorOf, validateMdfDocumentFor } from "./schemas.ts";
import { parseLlmsEntries, llmsNoteSaysPaid, wellKnownUrls, mdfPricedUrls } from "./discovery.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "v2");

interface Fixture {
  note: string;
  url: string;
  body: unknown;
  headers: Record<string, string | null>;
  headerBody?: unknown;
  mdf?: Record<string, unknown>;
  mdfMajor?: "0.2" | "0.3";
}

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function headerMap(f: Fixture): ResponseHeaders {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(f.headers ?? {})) {
    if (v === null) continue;
    map.set(k.toLowerCase(), v === "$BODY" ? encodePaymentRequiredHeader(f.body ?? f.headerBody) : v);
  }
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

/** Fixture with a header encoded from a *different* body (mismatch control). */
function evaluateMismatch(f: Fixture): ReturnType<typeof evaluate402Response> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(f.headers ?? {})) {
    if (v === "$BODY") continue;
    map.set(k.toLowerCase(), v === null ? encodePaymentRequiredHeader(f.headerBody) : v);
  }
  map.set("payment-required", encodePaymentRequiredHeader(f.headerBody));
  return evaluate402Response({
    url: f.url,
    body: f.body,
    headers: { get: (n: string) => map.get(n.toLowerCase()) ?? null },
    mdfDoc: f.mdf ?? null,
    mdfMajor: f.mdf ? specMajorOf(f.mdf.mdf_version) : undefined,
  });
}

function evaluate(f: Fixture, overrides: Partial<Evaluate402Input> = {}) {
  return evaluate402Response({
    url: f.url,
    body: f.body,
    headers: headerMap(f),
    mdfDoc: f.mdf ?? null,
    mdfMajor: f.mdf ? specMajorOf(f.mdf.mdf_version) : undefined,
    ...overrides,
  });
}

const errorsOf = (rs: ReturnType<typeof evaluate>) =>
  rs.filter((r) => !r.pass && r.level === "error");
const warnsOf = (rs: ReturnType<typeof evaluate>) =>
  rs.filter((r) => !r.pass && r.level === "warn");
const joined = (rs: ReturnType<typeof evaluate>) => rs.map((r) => `${r.label} — ${r.message}`).join("\n");

// ---------------------------------------------------------------------------
// Spec examples: the happy path
// ---------------------------------------------------------------------------

test("spec USDC-mainnet example has no failures (its asset is deliberately fabricated, so it warns)", () => {
  const rs = evaluate(load("402-spec-usdc-mainnet.json"));
  expect(errorsOf(rs)).toEqual([]);
  expect(rs.some((r) => r.message.includes("token not verifiable, not failed"))).toBe(true);
});

test("spec dual-rail example has no failures, and both rails are evaluated", () => {
  const rs = evaluate(load("402-spec-dual-rail.json"));
  expect(errorsOf(rs)).toEqual([]);
  const railLines = rs.filter((r) => r.label.includes("rail "));
  expect(railLines.length).toBe(2);
  // The Lightning rail passes outright; the EVM rail only warns, because the
  // example's asset address is deliberately fabricated (not the real USDC).
  expect(railLines.find((r) => r.label.includes("lnbtc"))?.pass).toBe(true);
  expect(railLines.find((r) => r.label.includes("eip155:8453"))?.level).toBe("warn");
});

test("spec dual-rail example matches its mdf.json one-to-one", () => {
  const dual = load("402-spec-dual-rail.json");
  const mdf = load("mdf-spec-dual-rail.json").body as Record<string, unknown>;
  const rs = evaluate(dual, { mdfDoc: mdf, mdfMajor: "0.3" });
  expect(errorsOf(rs)).toEqual([]);
  expect(joined(rs)).toContain("matches the 2 declared rails");
  // The only warnings are the fabricated-asset "not verifiable" notes.
  expect(warnsOf(rs).every((r) => r.message.includes("token not verifiable"))).toBe(true);
});

// ---------------------------------------------------------------------------
// ProofLines: known rail passes, non-standard rail warns and does not fail
// ---------------------------------------------------------------------------

test("ProofLines capture: USDC rail passes, monad-native-exact warns only", () => {
  const rs = evaluate(load("402-prooflines-redacted.json"));
  expect(errorsOf(rs)).toEqual([]);

  const usdc = rs.find((r) => r.label.includes("eip155:10143"));
  expect(usdc?.pass).toBe(true);

  const native = rs.find((r) => r.label.includes("monad-native-exact"));
  expect(native?.pass).toBe(false);
  expect(native?.level).toBe("warn");
  expect(native?.message).toContain("non-standard scheme");
  expect(native?.message).toContain("does not affect other rails");
});

test("ProofLines capture: the non-CAIP-2 network on the unknown rail is not counted as a failure", () => {
  const rs = evaluate(load("402-prooflines-redacted.json"));
  expect(joined(rs)).not.toContain("network is not a CAIP-2 identifier — \n");
  expect(errorsOf(rs)).toEqual([]);
  expect(rs.some((r) => r.label.includes("monad-native-exact") && r.pass)).toBe(false);
});

test("CORS without an expose list is a warning, not a failure (D4)", () => {
  const rs = evaluate(load("402-prooflines-redacted.json"));
  const cors = rs.find((r) => r.label.includes("(CORS)"));
  expect(cors?.level).toBe("warn");
  expect(cors?.message).toContain("Access-Control-Expose-Headers");
});

// ---------------------------------------------------------------------------
// Header handling (B4)
// ---------------------------------------------------------------------------

test("body/header mismatch is a distinct failure naming the path", () => {
  const rs = evaluateMismatch(load("402-body-header-mismatch.json"));
  const mismatch = rs.find((r) => r.label.includes("body/header agreement"));
  expect(mismatch?.level).toBe("error");
  expect(mismatch?.message).toContain("/accepts/0/amount");
});

test("malformed PAYMENT-REQUIRED is a distinct decode failure", () => {
  const rs = evaluate(load("402-malformed-header.json"));
  const hdr = rs.find((r) => r.label.includes("(PAYMENT-REQUIRED)"));
  expect(hdr?.level).toBe("error");
  expect(hdr?.message).toContain("base64");
});

test("header-only challenge: warning for a non-MDF site, failure for an MDF 0.3 site", () => {
  const f = load("402-header-only.json");
  const nonMdf = evaluate(f);
  expect(nonMdf.some((r) => r.label.includes("(402 body)") && r.level === "warn")).toBe(true);

  const mdfSite = evaluate(f, {
    mdfDoc: { mdf_version: "0.3.0", site: "https://example.com", pricing: { default: { rails: [] } } },
    mdfMajor: "0.3",
  });
  expect(mdfSite.some((r) => r.label.includes("(402 body)") && r.level === "error")).toBe(true);
});

test("decodePaymentRequiredHeader rejects oversize input before decoding", () => {
  const huge = "A".repeat(MAX_HEADER_CHARS + 1);
  const r = decodePaymentRequiredHeader(huge);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("over the");
});

test("firstDifference reports the first differing pointer", () => {
  expect(firstDifference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] })).toContain("/b/1");
  expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull();
});

// ---------------------------------------------------------------------------
// EIP-712 domain per network (B5 / decision 24)
// ---------------------------------------------------------------------------

test("mainnet USDC with extra.name \"USDC\" fails, explaining signature failure", () => {
  const rs = evaluate(load("402-mainnet-name-usdc.json"));
  const f = errorsOf(rs).find((r) => r.message.includes("EIP-712 domain mismatch"));
  expect(f).toBeDefined();
  expect(f?.message).toContain('"USD Coin"');
  expect(f?.message).toContain("verification fails on-chain");
});

test("the asset table encodes the per-network names", () => {
  expect(expectedAsset("eip155:8453")?.name).toBe("USD Coin");
  expect(expectedAsset("eip155:84532")?.name).toBe("USDC");
  expect(expectedAsset("eip155:8453")?.version).toBe("2");
});

test("unknown network on an exact rail warns instead of failing", () => {
  const f = load("402-spec-usdc-mainnet.json");
  const body = structuredClone(f.body) as any;
  body.accepts[0].network = "eip155:999999";
  const rs = evaluate({ ...f, body });
  expect(errorsOf(rs)).toEqual([]);
  expect(rs.some((r) => r.message.includes("not in the vendored asset table"))).toBe(true);
});

// ---------------------------------------------------------------------------
// mdf.json agreement and token access
// ---------------------------------------------------------------------------

test("an offered rail that mdf.json does not declare is a failure", () => {
  const rs = evaluate(load("402-extra-rail-vs-mdf.json"));
  const f = errorsOf(rs).find((r) => r.label.includes("(mdf.json agreement)"));
  expect(f).toBeDefined();
  expect(f?.errors?.join("\n")).toContain("offered but not declared");
});

test("a declared rail that is not offered is a warning (may be degraded)", () => {
  const dual = load("402-spec-dual-rail.json");
  const body = structuredClone(dual.body) as any;
  body.accepts = body.accepts.filter((a: any) => a.network !== "lnbtc:000000000019d6689c085ae165831e93");
  const mdf = load("mdf-spec-dual-rail.json").body as Record<string, unknown>;
  const rs = evaluate({ ...dual, body }, { mdfDoc: mdf, mdfMajor: "0.3" });
  const agreement = rs.find((r) => r.label.includes("(mdf.json agreement)"));
  expect(agreement?.level).toBe("warn");
  expect(agreement?.message).toContain("declared rails not all offered");
});

test("a mismatched declared amount is a failure", () => {
  const dual = load("402-spec-dual-rail.json");
  const body = structuredClone(dual.body) as any;
  body.accepts[0].amount = "2000";
  const mdf = load("mdf-spec-dual-rail.json").body as Record<string, unknown>;
  const rs = evaluate({ ...dual, body }, { mdfDoc: mdf, mdfMajor: "0.3" });
  const f = errorsOf(rs).find((r) => r.label.includes("(mdf.json agreement)"));
  expect(f?.errors?.join("\n")).toContain("does not match the declared 1000");
});

test("token access without auth.endpoint: the schema and the direct rule agree", () => {
  const doc = load("mdf-token-without-auth.json").body as Record<string, unknown>;
  const schemaErrors = validateMdfDocumentFor(doc, "0.3");
  expect(schemaErrors.length).toBeGreaterThan(0);

  const direct = tokenAccessWithoutAuth(doc);
  expect(direct).toEqual(["/private/**"]);
});

test("token access with auth.endpoint satisfies both", () => {
  const doc = {
    mdf_version: "0.3.0",
    site: "https://example.com",
    pricing: { default: { rails: [] }, sections: { "/private/**": { rails: [], access: "token" } } },
    auth: { endpoint: "https://example.com/mdf/auth" },
  };
  // Empty rails + token is itself invalid (a token entry needs a rail), so use one rail.
  const withRail = structuredClone(doc) as any;
  withRail.pricing.sections["/private/**"].rails = [
    { scheme: "exact", network: "eip155:8453", asset: "0x1111111111111111111111111111111111111111", amount: "100" },
  ];
  expect(validateMdfDocumentFor(withRail, "0.3")).toEqual([]);
  expect(tokenAccessWithoutAuth(withRail)).toEqual([]);
});

test("price_summary must state each rail's amount", () => {
  const dual = load("402-spec-dual-rail.json");
  const body = structuredClone(dual.body) as any;
  body.extensions.mdf.info.price_summary = "Pay us";
  const rs = evaluate({ ...dual, body });
  const f = errorsOf(rs).find((r) => r.label.includes("price_summary"));
  expect(f?.message).toContain("does not state the amount");
});

// ---------------------------------------------------------------------------
// v1 tolerance
// ---------------------------------------------------------------------------

test("x402 v1 from a non-MDF site is informational, rails still checked", () => {
  const rs = evaluate(load("402-x402-v1.json"));
  expect(errorsOf(rs)).toEqual([]);
  expect(joined(rs)).toContain("x402 v1 — legacy shape, reported not failed");
  // base-sepolia normalises to eip155:84532, so the USDC asset and name check runs.
  expect(joined(rs)).toContain("[base-sepolia ≡ eip155:84532]");
});

test("MDF 0.2 envelope from a 0.2 site is informational", () => {
  const rs = evaluate(load("402-v1-mdf-envelope.json"), { mdfMajor: "0.2" });
  expect(joined(rs)).toContain("MDF 0.2 envelope — legacy shape, reported not failed");
  // The demo's hardcoded "USDC" on Base mainnet is decision 24's latent bug.
  const nameFailure = errorsOf(rs).find((r) => r.message.includes("EIP-712 domain mismatch"));
  expect(nameFailure?.message).toContain('"USD Coin"');
});

test("an MDF 0.3 site serving v1 is a failure (hard cut)", () => {
  const rs = evaluate(load("402-v1-mdf-envelope.json"), {
    mdfDoc: { mdf_version: "0.3.0", site: "https://example.com", pricing: { default: { rails: [] } } },
    mdfMajor: "0.3",
  });
  const f = errorsOf(rs).find((r) => r.label.includes("402 body"));
  expect(f?.message).toContain("must serve x402 v2");
});

test("the spec 0.3.0 mdf.json examples validate under the 0.3 schema", () => {
  for (const name of ["mdf-spec-dual-rail.json", "mdf-spec-token-tier.json"]) {
    const doc = load(name).body as Record<string, unknown>;
    expect({ name, errors: validateMdfDocumentFor(doc, "0.3") }).toEqual({ name, errors: [] });
  }
});

// ---------------------------------------------------------------------------
// Network normalisation, mdf.json pricing, discovery
// ---------------------------------------------------------------------------

test("legacy chain names normalise to CAIP-2", () => {
  expect(normaliseLegacyNetwork("base")).toBe("eip155:8453");
  expect(normaliseLegacyNetwork("base-sepolia")).toBe("eip155:84532");
  expect(normaliseLegacyNetwork("base_sepolia")).toBe("eip155:84532");
  expect(normaliseLegacyNetwork("lightning")).toMatch(/^lnbtc:/);
  expect(parseNetwork("eip155:8453").kind).toBe("eip155");
  expect(parseNetwork("monad-testnet").kind).toBe("invalid");
  expect(isCaip2("eip155:8453")).toBe(true);
  expect(isCaip2("base")).toBe(true);
});

test("most specific pricing glob wins", () => {
  const doc = {
    pricing: {
      default: { rails: [] },
      sections: {
        "/docs/**": { rails: [{ scheme: "exact", network: "eip155:8453", asset: "0x1", amount: "1" }] },
        "/docs/deep/**": { rails: [] },
      },
    },
  };
  expect(priceEntryForPath("/docs/a", doc)?.key).toBe("/docs/**");
  expect(priceEntryForPath("/docs/deep/a", doc)?.key).toBe("/docs/deep/**");
  expect(priceEntryForPath("/other", doc)?.key).toBe("default");
});

test("0.2 pricing entries are read as one legacy rail", () => {
  const doc = { pricing: { default: { amount: "0.001", currency: "USDC", chain: "base" } } };
  const entries = allPriceEntries(doc);
  expect(entries[0].rails[0].network).toBe("eip155:8453");
  expect(entries[0].rails[0].legacy).toBe(true);
  expect(priceEntryForPath("/x", { pricing: { default: { amount: "0.0000", currency: null } } })?.rails).toEqual([]);
});

test("llms.txt entries: same-origin only, notes detected", () => {
  const text = [
    "- [Free](https://example.com/docs)",
    "- [Paid](https://example.com/premium) ; 0.003 USDC, HTTP 402, self-verified",
    "- [External](https://other.example/x)",
  ].join("\n");
  const entries = parseLlmsEntries("https://example.com", text);
  expect(entries.map((e) => new URL(e.url).pathname)).toEqual(["/docs", "/premium"]);
  expect(llmsNoteSaysPaid(entries[1].line)).toBe(true);
  expect(llmsNoteSaysPaid(entries[0].line)).toBe(false);
});

test("well-known resources are read, including relative URLs", () => {
  const urls = wellKnownUrls("https://example.com", {
    resources: [{ resource: "/a" }, { resource: { url: "https://example.com/b" } }],
  });
  expect(urls.map((u) => u.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
});

test("mdf priced URLs are only real llms.txt URLs", () => {
  const mdf = { pricing: { default: { rails: [] }, sections: { "/premium/**": { rails: [{ scheme: "exact", network: "eip155:8453", asset: "0x1", amount: "1" }] } } } };
  const found = mdfPricedUrls("https://example.com", mdf, [
    { url: "https://example.com/premium/x" },
    { url: "https://example.com/docs" },
    { url: "https://example.com/premium" },
  ]);
  // `/premium` itself does not match `/premium/**` — a glob root is not a page,
  // which is exactly why discovery never fabricates URLs from pricing.
  expect(found.map((f) => new URL(f.url).pathname)).toEqual(["/premium/x"]);
});

// ---------------------------------------------------------------------------
// Paid 200 capture
// ---------------------------------------------------------------------------

function headers(entries: Record<string, string>): ResponseHeaders {
  const m = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (n: string) => m.get(n.toLowerCase()) ?? null };
}

test("paid 200 with an lnbtc settlement carries no payer", () => {
  const settle = { success: true, transaction: "a".repeat(64), network: "lnbtc:000000000019d6689c085ae165831e93" };
  const rs = evaluatePaidResponse({
    url: "https://example.com/x",
    status: 200,
    headers: headers({
      "payment-response": Buffer.from(JSON.stringify(settle)).toString("base64"),
      "cache-control": "private, no-store",
    }),
    mdfMajor: "0.3",
  });
  expect(rs.filter((r) => !r.pass)).toEqual([]);
});

test("paid 200 with a payer on an lnbtc settlement fails", () => {
  const settle = { success: true, transaction: "a".repeat(64), network: "lnbtc:000000000019d6689c085ae165831e93", payer: "0xabc" };
  const rs = evaluatePaidResponse({
    url: "https://example.com/x",
    status: 200,
    headers: headers({
      "payment-response": Buffer.from(JSON.stringify(settle)).toString("base64"),
      "cache-control": "private, no-store",
    }),
    mdfMajor: "0.3",
  });
  expect(rs.some((r) => r.errors?.some((e) => e.includes("payer MUST be omitted")))).toBe(true);
});

test("paid 200 without PAYMENT-RESPONSE fails for an MDF 0.3 site", () => {
  const rs = evaluatePaidResponse({
    url: "https://example.com/x",
    status: 200,
    headers: headers({ "cache-control": "private, no-store" }),
    mdfMajor: "0.3",
  });
  expect(rs[0].level).toBe("error");
});

test("paid 200 settlement on a network no rail offered fails", () => {
  const settle = { success: true, transaction: "0x" + "b".repeat(64), network: "eip155:84532" };
  const rs = evaluatePaidResponse({
    url: "https://example.com/x",
    status: 200,
    headers: headers({
      "payment-response": Buffer.from(JSON.stringify(settle)).toString("base64"),
      "cache-control": "private, no-store",
    }),
    paymentRequired: load("402-spec-usdc-mainnet.json").body,
    mdfMajor: "0.3",
  });
  expect(rs.some((r) => r.errors?.some((e) => e.includes("no accepts[] entry offered")))).toBe(true);
});
