/**
 * evaluate.ts — the pure core: given a 402 response (body + headers) and
 * optionally the site's `/mdf.json`, decide what is wrong with it.
 *
 * No network I/O lives here, which is what makes the per-rail rules testable
 * from fixtures.
 *
 * The shape being evaluated depends on what the response claims:
 *   - x402 v2 (`x402Version: 2`) — the MDF 0.3.0 shape, evaluated per rail
 *     against the strictness profile: closed root, open `accepts[]` entries,
 *     `extensions` open to other keys with only `mdf` strict.
 *   - x402 v1 (`x402Version: 1`) — normalised into the same per-rail model and
 *     reported as legacy. Informational for a third-party site; a failure for
 *     a site that declares MDF 0.3.x, which is a v2 hard cut.
 *   - MDF 0.2 (`payment` envelope, string `resource`) — same treatment.
 */

import type { ValidationResult } from "./result.ts";
import { fail, info, pass, warn } from "./result.ts";
import type { ErrorObject } from "ajv";
import { validate402V2Errors } from "./schemas.ts";
import type { SpecMajor } from "./schemas.ts";
import { normaliseRailNetwork, parseNetwork, railChainId } from "./network.ts";
import type { ParsedNetwork } from "./network.ts";
import { assetMatches, expectedAsset, humanAmount, isKnownNetwork } from "./assets.ts";
import { priceEntryForPath, tokenAccessWithoutAuth } from "./mdf.ts";
import type { DeclaredRail } from "./mdf.ts";
import { decodePaymentRequiredHeader, firstDifference } from "./payment-required.ts";

export interface ResponseHeaders {
  get(name: string): string | null;
}

export interface Evaluate402Input {
  url: string;
  /** Parsed JSON body, or null when the body was absent or unparseable. */
  body: unknown | null;
  /** Why the body could not be parsed, when it could not. */
  bodyError?: string | null;
  headers: ResponseHeaders;
  /** The site's /mdf.json, when it declares a version the validator understands. */
  mdfDoc?: Record<string, unknown> | null;
  mdfMajor?: SpecMajor;
  /** URL path, for the accepts[]↔/mdf.json comparison. Defaults from url. */
  path?: string;
}

export interface Rail {
  index: number;
  scheme: string;
  network: string;
  parsed: ParsedNetwork;
  amount: string | null;
  asset: string | null;
  /** `chainId` carried by the entry, which can normalise an alias network. */
  chainId?: unknown;
  payTo: string | null;
  maxTimeoutSeconds: number | null;
  extra: Record<string, unknown>;
  /** 0.2.x `payment.amount` is a decimal currency amount, not an atomic integer. */
  legacyDecimal?: boolean;
}

type Classification =
  | { kind: "evaluated"; expected: ReturnType<typeof expectedAsset> }
  | { kind: "unknown-scheme"; scheme: string }
  | { kind: "unknown-network"; network: string; reason: string };

// ---------------------------------------------------------------------------
// Rail extraction and classification
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRail(index: number, raw: unknown): Rail {
  const r = isObject(raw) ? raw : {};
  return {
    index,
    scheme: typeof r.scheme === "string" ? r.scheme : "",
    network: typeof r.network === "string" ? r.network : "",
    parsed: parseNetwork(r.network),
    amount: typeof r.amount === "string" ? r.amount : null,
    asset: typeof r.asset === "string" ? r.asset : null,
    chainId: railChainId(r),
    payTo: typeof r.payTo === "string" ? r.payTo : null,
    maxTimeoutSeconds: typeof r.maxTimeoutSeconds === "number" ? r.maxTimeoutSeconds : null,
    extra: isObject(r.extra) ? r.extra : {},
  };
}

/**
 * Which rails can be fully checked. `exact` on a network in the vendored asset
 * table is fully checkable; anything else is reported per rail and skipped,
 * never allowed to fail the offer as a whole (the bucket-C rule).
 */
export function classifyRail(rail: Rail): Classification {
  if (rail.scheme !== "exact") {
    return { kind: "unknown-scheme", scheme: rail.scheme || "(missing)" };
  }
  if (rail.parsed.kind === "eip155") {
    if (isKnownNetwork(rail.parsed.id)) {
      return { kind: "evaluated", expected: expectedAsset(rail.parsed.id) };
    }
    return {
      kind: "unknown-network",
      network: rail.network,
      reason: "network is not in the vendored asset table",
    };
  }
  if (rail.parsed.kind === "lnbtc") {
    return { kind: "evaluated", expected: null };
  }
  return {
    kind: "unknown-network",
    network: rail.network,
    reason:
      rail.parsed.kind === "invalid"
        ? "network is not a CAIP-2 identifier"
        : `unsupported namespace '${rail.parsed.namespace}'`,
  };
}

export function railLabel(rail: Rail): string {
  return `rail ${rail.index}: ${rail.scheme || "(no scheme)"}/${rail.network || "(no network)"}`;
}

// ---------------------------------------------------------------------------
// Per-rail checks (the parts a JSON Schema cannot express)
// ---------------------------------------------------------------------------

function checkRail(rail: Rail, classification: Classification, url: string): ValidationResult[] {
  const label = `${url} (${railLabel(rail)})`;

  if (classification.kind === "unknown-scheme") {
    return [
      warn(
        label,
        `non-standard scheme '${classification.scheme}' — not evaluated (this does not affect other rails)`
      ),
    ];
  }
  if (classification.kind === "unknown-network") {
    return [
      warn(
        label,
        `network '${classification.network}' not verifiable — ${classification.reason} (not evaluated; this does not affect other rails)`
      ),
    ];
  }

  const out: ValidationResult[] = [];

  if (rail.parsed.kind === "eip155") {
    const expected = classification.expected;
    if (expected) {
      if (!assetMatches(expected.asset, rail.asset)) {
        // An address that is not the table's entry is "not verifiable" rather
        // than wrong: the rail may price a different token, and the examples
        // carry deliberately fabricated addresses. The name/version check
        // below is the one that must fail, because that is what breaks
        // signatures.
        out.push(
          warn(
            label,
            `asset is not ${expected.symbol ?? "the table's asset"} on ${rail.parsed.id} (expected ${expected.asset}, got ${rail.asset ?? "(none)"}) — token not verifiable, not failed`
          )
        );
      }
      const name = rail.extra.name;
      const version = rail.extra.version;
      if (name !== expected.name || String(version) !== expected.version) {
        out.push(
          fail(
            label,
            `EIP-712 domain mismatch: extra.name/version must be "${expected.name}"/"${expected.version}" on ${rail.parsed.id}, got "${name ?? "(none)"}"/"${version ?? "(none)"}" — signatures are bound to this domain, so verification fails on-chain`
          )
        );
      }
    }
    if (rail.payTo && !/^0x[0-9a-fA-F]{40}$/.test(rail.payTo)) {
      out.push(fail(label, `payTo is not an EVM address: ${rail.payTo}`));
    }
  }

  if (rail.parsed.kind === "lnbtc") {
    if (rail.asset !== "BTC") {
      out.push(fail(label, `asset must be "BTC" on an lnbtc rail, got ${rail.asset ?? "(none)"}`));
    }
    if (rail.payTo && !/^(02|03)[0-9a-f]{64}$/.test(rail.payTo)) {
      out.push(
        fail(label, `payTo is not a compressed secp256k1 public key (66 lowercase hex): ${rail.payTo}`)
      );
    }
    const invoice = rail.extra.invoice;
    if (
      typeof invoice === "string" &&
      rail.parsed.reference === "000000000019d6689c085ae165831e93" &&
      /^lntb/i.test(invoice)
    ) {
      out.push(fail(label, "invoice is a testnet (lntb) invoice under the mainnet lnbtc network"));
    }
  }

  if (out.length === 0) out.push(pass(label, describeRail(rail)));
  return out;
}

function describeRail(rail: Rail): string {
  const unit = rail.legacyDecimal
    ? "in 0.2 decimal units"
    : rail.parsed.kind === "lnbtc"
      ? "msat"
      : expectedAsset(rail.parsed.id)?.symbol ?? "atomic";
  const normalised =
    rail.parsed.id && rail.parsed.id !== rail.network ? ` [${rail.network} ≡ ${rail.parsed.id}]` : "";
  return `ok — ${rail.amount ?? "(no amount)"} ${unit} of ${rail.asset ?? "(no asset)"}${normalised}, payTo ${
    rail.payTo ?? "(none)"
  }, timeout ${rail.maxTimeoutSeconds ?? "(none)"}s`;
}

// ---------------------------------------------------------------------------
// v2 evaluation
// ---------------------------------------------------------------------------

interface Analysis {
  rails: Rail[];
  envelopeErrors: string[];
  railErrors: Map<number, string[]>;
  resourceUrl: string | null;
  extension: Record<string, unknown> | null;
}

function analyseV2(obj: Record<string, unknown>, mdfProfile: boolean): Analysis {
  const errors: ErrorObject[] = validate402V2Errors(obj, mdfProfile) ?? [];
  const envelopeErrors: string[] = [];
  const railErrors = new Map<number, string[]>();

  for (const e of errors) {
    const m = /^\/accepts\/(\d+)/.exec(e.instancePath);
    if (!m) {
      envelopeErrors.push(`${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`);
      continue;
    }
    const idx = Number.parseInt(m[1], 10);
    const list = railErrors.get(idx) ?? [];
    list.push(`${e.instancePath}: ${e.message ?? "invalid"}`);
    railErrors.set(idx, list);
  }

  const accepts = Array.isArray(obj.accepts) ? obj.accepts : [];
  const resource = isObject(obj.resource) ? obj.resource : null;
  const extensions = isObject(obj.extensions) ? obj.extensions : null;

  return {
    rails: accepts.map((raw, i) => asRail(i, raw)),
    envelopeErrors,
    railErrors,
    resourceUrl: resource && typeof resource.url === "string" ? resource.url : null,
    extension: extensions && isObject(extensions.mdf) ? extensions.mdf : null,
  };
}

function evaluateV2(
  input: Evaluate402Input,
  obj: Record<string, unknown>,
  fromHeader: boolean
): ValidationResult[] {
  const out: ValidationResult[] = [];
  const a = analyseV2(obj, input.mdfMajor === "0.3");
  const where = fromHeader ? "PAYMENT-REQUIRED header" : "402 body";

  out.push(
    a.envelopeErrors.length > 0
      ? fail(`${input.url} (${where} envelope)`, "not a valid x402 v2 PaymentRequired", a.envelopeErrors)
      : pass(`${input.url} (${where} envelope)`, "x402 v2 PaymentRequired ✓")
  );

  for (const rail of a.rails) {
    const classification = classifyRail(rail);
    const schemaErrors = a.railErrors.get(rail.index) ?? [];

    if (classification.kind !== "evaluated") {
      // Not evaluated: structural deviations on this entry are expected for a
      // non-standard rail and must not be reported as failures.
      const note =
        schemaErrors.length > 0
          ? ` (${schemaErrors.length} structural deviation${schemaErrors.length === 1 ? "" : "s"} not counted: ${schemaErrors[0]})`
          : "";
      out.push(
        ...checkRail(rail, classification, input.url).map((r) => ({
          ...r,
          message: r.message + note,
        }))
      );
      continue;
    }

    if (schemaErrors.length > 0) {
      out.push(
        fail(`${input.url} (${railLabel(rail)})`, "payment requirement is malformed", schemaErrors)
      );
      continue;
    }
    out.push(...checkRail(rail, classification, input.url));
  }

  out.push(...checkExtension(input, a));
  return out;
}

function checkExtension(input: Evaluate402Input, a: Analysis): ValidationResult[] {
  const out: ValidationResult[] = [];
  const isMdfSite = input.mdfMajor === "0.3";
  const ext = a.extension;

  if (!ext) {
    out.push(
      isMdfSite
        ? fail(`${input.url} (extensions.mdf)`, "MDF 0.3.0 requires extensions.mdf")
        : info(`${input.url} (extensions.mdf)`, "not present (not an MDF 0.3.0 site)")
    );
    return out;
  }

  const infoObj = isObject(ext.info) ? ext.info : null;
  if (!infoObj) {
    out.push(fail(`${input.url} (extensions.mdf.info)`, "missing info object"));
    return out;
  }

  const version = infoObj.version;
  if (typeof version !== "string") {
    out.push(fail(`${input.url} (extensions.mdf.info.version)`, "missing or not a string"));
  } else if (!/^\d+\.\d+\.\d+$/.test(version)) {
    out.push(fail(`${input.url} (extensions.mdf.info.version)`, `not MAJOR.MINOR.PATCH: ${version}`));
  } else {
    out.push(pass(`${input.url} (extensions.mdf.info.version)`, version));
  }

  const summary = infoObj.price_summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    out.push(fail(`${input.url} (extensions.mdf.info.price_summary)`, "missing or empty"));
  } else {
    out.push(...checkPriceSummary(input.url, summary, a.rails));
  }

  if (ext.schema === undefined) {
    out.push(fail(`${input.url} (extensions.mdf.schema)`, "missing"));
  }

  return out;
}

function checkPriceSummary(url: string, summary: string, rails: Rail[]): ValidationResult[] {
  const label = `${url} (price_summary)`;
  const missing: string[] = [];

  for (const rail of rails) {
    if (classifyRail(rail).kind !== "evaluated") continue;
    if (rail.amount === null) continue;
    const decimals = rail.parsed.kind === "eip155" ? expectedAsset(rail.parsed.id)?.decimals : 3;
    const human = humanAmount(rail.amount, decimals);
    const candidates = [rail.amount, human].filter((v): v is string => !!v);
    if (!candidates.some((c) => summary.includes(c))) {
      missing.push(`${railLabel(rail)} = ${candidates.join(" / ")}`);
    }
  }

  return missing.length > 0
    ? [fail(label, `does not state the amount of every rail (${missing.join("; ")})`)]
    : [pass(label, `agrees with accepts[] (${rails.length} rail${rails.length === 1 ? "" : "s"})`)];
}

// ---------------------------------------------------------------------------
// Legacy (v1 / MDF 0.2) evaluation
// ---------------------------------------------------------------------------

interface LegacyOffer {
  version: "x402 v1" | "MDF 0.2 envelope";
  rails: Rail[];
  resourceUrl: string | null;
}

function isLegacyV1(obj: Record<string, unknown>): boolean {
  return obj.x402Version === 1;
}

function isLegacyMdf(obj: Record<string, unknown>): boolean {
  return isObject(obj.payment) && typeof obj.resource === "string";
}

function normaliseLegacy(obj: Record<string, unknown>): LegacyOffer {
  if (isLegacyV1(obj)) {
    const accepts = Array.isArray(obj.accepts) ? obj.accepts : [];
    const rails = accepts.map((raw, i) => {
      const r = isObject(raw) ? raw : {};
      return asRail(i, { ...r, amount: r.amount ?? r.maxAmountRequired, network: r.network ?? r.chain });
    });
    const first = accepts.find(isObject) as Record<string, unknown> | undefined;
    return {
      version: "x402 v1",
      rails,
      resourceUrl: typeof first?.resource === "string" ? first.resource : null,
    };
  }

  const payment = obj.payment as Record<string, unknown>;
  // 0.2 used `currency` where 0.3 uses `asset`. A symbol is only usable as an
  // asset on the Lightning rail (BTC); an EVM `USDC` symbol is not a contract
  // address, so it is left undefined and the rail is reported as unverifiable.
  const asset =
    typeof payment.asset === "string"
      ? payment.asset
      : payment.currency === "BTC"
        ? "BTC"
        : undefined;
  return {
    version: "MDF 0.2 envelope",
    rails: [
      asRail(0, {
        scheme: payment.scheme ?? "exact",
        network: payment.chain,
        amount: payment.amount,
        asset,
        payTo: payment.pay_to ?? payment.recipient,
        maxTimeoutSeconds: payment.max_timeout_seconds,
        extra: payment.extra ?? {},
        legacyDecimal: true,
      }),
    ],
    resourceUrl: typeof obj.resource === "string" ? obj.resource : null,
  };
}

function evaluateLegacy(input: Evaluate402Input, body: Record<string, unknown>, mdfSite: boolean): ValidationResult[] {
  const offer = normaliseLegacy(body);
  const label = `${input.url} (402 body, ${offer.version})`;

  const verdict: ValidationResult = mdfSite
    ? fail(
        label,
        `an MDF 0.3.0 site must serve x402 v2; this is ${offer.version}. MDF 0.3.0 is a v2 hard cut.`
      )
    : info(label, `${offer.version} — legacy shape, reported not failed`);

  return [verdict, ...offer.rails.flatMap((rail) => checkRail(rail, classifyRail(rail), input.url))];
}

// ---------------------------------------------------------------------------
// Header, cache, CORS
// ---------------------------------------------------------------------------

function checkHeadersCommon(input: Evaluate402Input): ValidationResult[] {
  const out: ValidationResult[] = [];
  const mdfSite = input.mdfMajor === "0.3";

  const cache = (input.headers.get("cache-control") ?? "").toLowerCase();
  const noStore = /\bno-store\b/.test(cache);
  out.push(
    noStore
      ? pass(`${input.url} (cache)`, "Cache-Control: no-store ✓")
      : mdfSite
        ? fail(`${input.url} (cache)`, `Cache-Control must include no-store, got ${cache || "(none)"}`)
        : warn(`${input.url} (cache)`, `Cache-Control should include no-store, got ${cache || "(none)"}`)
  );

  const version = input.headers.get("x-mdf-version");
  if (version !== null) {
    out.push(pass(`${input.url} (X-MDF-Version)`, version));
  } else if (mdfSite) {
    out.push(fail(`${input.url} (X-MDF-Version)`, "missing on an MDF site"));
  }

  return out;
}

function checkCors(input: Evaluate402Input): ValidationResult[] {
  const origin = input.headers.get("access-control-allow-origin");
  if (origin === null) return [];
  const expose = (input.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  const needed = ["payment-required", "payment-response"].filter((h) => !expose.includes(h));
  if (needed.length === 0) return [];
  return [
    warn(
      `${input.url} (CORS)`,
      `Access-Control-Allow-Origin is set but Access-Control-Expose-Headers does not name ${needed.join(" or ")} — a browser client cannot read the offer`
    ),
  ];
}

// ---------------------------------------------------------------------------
// MDF-only semantic checks (schema cannot express them)
// ---------------------------------------------------------------------------

/**
 * Compare a declared asset with an offered one. A 0x address is compared
 * case-insensitively — EIP-55 casing is a checksum, not part of the identity —
 * and every other identifier is compared exactly, because a non-`exact`
 * scheme's asset identifier is whatever that scheme's spec says it is. A
 * missing side is not a mismatch (the rail checks report that separately).
 */
function sameAsset(declared: string | null, offered: string | null): boolean {
  if (!declared || !offered) return true;
  if (declared === offered) return true;
  const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);
  return isAddress(declared) && isAddress(offered) && declared.toLowerCase() === offered.toLowerCase();
}

function checkMdfSemantics(input: Evaluate402Input, body: unknown, path: string): ValidationResult[] {
  if (input.mdfMajor !== "0.3" || !input.mdfDoc) return [];
  const out: ValidationResult[] = [];

  const missing = tokenAccessWithoutAuth(input.mdfDoc);
  out.push(
    missing.length === 0
      ? pass(`${input.url} (token access)`, "every token-access section names auth.endpoint ✓")
      : fail(
          `${input.url} (token access)`,
          `access: "token" requires auth.endpoint — missing for ${missing.join(", ")}`
        )
  );

  if (!isObject(body) || body.x402Version !== 2) {
    out.push(
      warn(`${input.url} (mdf.json agreement)`, "skipped — the offer is not x402 v2")
    );
    return out;
  }

  const entry = priceEntryForPath(path, input.mdfDoc);
  if (!entry || entry.rails.length === 0) {
    out.push(warn(`${input.url} (mdf.json agreement)`, `no priced entry in mdf.json matches ${path}`));
    return out;
  }

  const declared: DeclaredRail[] = entry.rails;
  // Presence is compared across every rail, not only the ones we can evaluate.
  // A non-standard scheme is still an offer the 402 makes, and a rail the
  // declaration omits is exactly what the one-to-one rule exists to catch
  // (spec 0.3.1 / decision 26; finding F3 in the #57 record). Evaluation is
  // still limited to `evaluated` rails — see evaluateV2.
  const offered = analyseV2(body, true).rails;
  const key = (scheme: string, network: string, chainId?: unknown) =>
    `${scheme.toLowerCase()}|${normaliseRailNetwork(network, chainId)}`;

  const offeredByKey = new Map<string, Rail>();
  for (const rail of offered) {
    // An entry with no scheme or no network is not a coherent offer. The
    // per-rail checks report it; it must not become an agreement failure.
    if (!rail.scheme || !rail.network) continue;
    const k = key(rail.scheme, rail.network, rail.chainId);
    if (!offeredByKey.has(k)) offeredByKey.set(k, rail);
  }
  const declaredKeys = new Set(declared.map((d) => key(d.scheme, d.network, d.chainId)));
  const problems: string[] = [];
  const gaps: string[] = [];

  for (const d of declared) {
    const match = offeredByKey.get(key(d.scheme, d.network, d.chainId));
    if (!match) {
      gaps.push(`${d.scheme}/${d.network} declared in mdf.json but not offered (may be degraded)`);
      continue;
    }
    if (!sameAsset(d.asset, match.asset)) {
      problems.push(`${d.scheme}/${d.network}: asset ${match.asset} does not match the declared ${d.asset}`);
    }
    if (d.amount && match.amount && d.amount !== match.amount) {
      problems.push(`${d.scheme}/${d.network}: amount ${match.amount} does not match the declared ${d.amount}`);
    }
  }

  for (const rail of offered) {
    if (!rail.scheme || !rail.network) continue;
    if (!declaredKeys.has(key(rail.scheme, rail.network, rail.chainId))) {
      problems.push(
        `${rail.scheme}/${rail.network} is offered in accepts[] but not declared in mdf.json for ${entry.key}`
      );
    }
  }

  if (problems.length > 0) {
    out.push(fail(`${input.url} (mdf.json agreement)`, "accepts[] does not match the declared rails", problems));
  } else if (gaps.length > 0) {
    out.push(warn(`${input.url} (mdf.json agreement)`, "declared rails not all offered", gaps));
  } else {
    out.push(
      pass(
        `${input.url} (mdf.json agreement)`,
        `accepts[] matches the ${declared.length} declared rail${declared.length === 1 ? "" : "s"} for ${entry.key}`
      )
    );
  }

  return out;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function evaluate402Response(input: Evaluate402Input): ValidationResult[] {
  const out: ValidationResult[] = [];
  const path = input.path ?? safePath(input.url);
  const mdfSite = input.mdfMajor === "0.3";

  out.push(...checkHeadersCommon(input));

  const body = input.body;
  let legacyBody = false;
  if (!isObject(body)) {
    out.push(
      mdfSite
        ? fail(
            `${input.url} (402 body)`,
            `${input.bodyError ?? "absent or not JSON"} — MDF 0.3.0 requires the PaymentRequired object in the body`
          )
        : warn(
            `${input.url} (402 body)`,
            `${input.bodyError ?? "absent or not JSON"} — x402 v2 permits a header-only challenge, MDF does not`
          )
    );
  } else if (body.x402Version === 2) {
    out.push(...evaluateV2(input, body, false));
  } else if (isLegacyV1(body) || isLegacyMdf(body)) {
    legacyBody = true;
    out.push(...evaluateLegacy(input, body, mdfSite));
  } else {
    out.push(
      fail(
        `${input.url} (402 body)`,
        "unrecognised PaymentRequired shape (no x402Version: 2, x402Version: 1, or MDF payment envelope)"
      )
    );
  }

  const rawHeader = input.headers.get("payment-required");
  const header = decodePaymentRequiredHeader(rawHeader);

  if (rawHeader === null) {
    out.push(
      legacyBody
        ? info(
            `${input.url} (PAYMENT-REQUIRED)`,
            "not applicable — a legacy (v1 / MDF 0.2) offer has no PAYMENT-REQUIRED header"
          )
        : mdfSite
        ? fail(
            `${input.url} (PAYMENT-REQUIRED)`,
            "missing — x402 v2 carries the PaymentRequired object in this header and MDF 0.3.0 requires it"
          )
        : warn(`${input.url} (PAYMENT-REQUIRED)`, "missing — the header is the canonical x402 v2 location")
    );
  } else if (!header.ok) {
    out.push(fail(`${input.url} (PAYMENT-REQUIRED)`, header.reason));
  } else {
    out.push(pass(`${input.url} (PAYMENT-REQUIRED)`, "decodes to JSON"));
    if (!isObject(header.value) || header.value.x402Version !== 2) {
      out.push(
        warn(
          `${input.url} (PAYMENT-REQUIRED)`,
          "decoded header is not an x402 v2 PaymentRequired — not evaluated through the body path"
        )
      );
    } else {
      // Only errors: the header is the same object as the body in the normal
      // case, so repeating its pass/warn lines would double the report. A
      // header that genuinely differs is caught by the agreement check below.
      const fromHeader = evaluateV2(input, header.value, true).filter(
        (r) => !r.pass && r.level === "error"
      );
      out.push(...fromHeader);
      if (isObject(body) && body.x402Version === 2) {
        const diff = firstDifference(body, header.value);
        out.push(
          diff
            ? fail(`${input.url} (body/header agreement)`, `body and PAYMENT-REQUIRED differ at ${diff}`)
            : pass(`${input.url} (body/header agreement)`, "body and PAYMENT-REQUIRED are the same object")
        );
      }
    }
  }

  out.push(...checkCors(input));
  out.push(...checkMdfSemantics(input, body, path));
  return out;
}

// ---------------------------------------------------------------------------
// Paid 200 capture
// ---------------------------------------------------------------------------

export interface EvaluatePaidInput {
  url: string;
  status: number;
  headers: ResponseHeaders;
  /** Parsed PaymentRequired from the earlier 402, when the capture has it. */
  paymentRequired?: unknown;
  mdfDoc?: Record<string, unknown> | null;
  mdfMajor?: SpecMajor;
}

/**
 * Check a paid response without making one: the caller supplies a capture of a
 * 200 that followed a payment.
 */
export function evaluatePaidResponse(input: EvaluatePaidInput): ValidationResult[] {
  const mdfSite = input.mdfMajor === "0.3";

  if (input.status !== 200) {
    return [fail(`${input.url} (paid 200)`, `expected HTTP 200, got ${input.status}`)];
  }

  const raw = input.headers.get("payment-response");
  if (raw === null) {
    return [
      mdfSite
        ? fail(
            `${input.url} (PAYMENT-RESPONSE)`,
            "missing — MDF 0.3.0 requires it on every paid 200 for every x402 rail"
          )
        : warn(`${input.url} (PAYMENT-RESPONSE)`, "missing on a paid 200"),
    ];
  }

  const decoded = decodePaymentRequiredHeader(raw);
  if (!decoded.ok) return [fail(`${input.url} (PAYMENT-RESPONSE)`, decoded.reason)];

  const value = decoded.value;
  if (!isObject(value)) {
    return [fail(`${input.url} (PAYMENT-RESPONSE)`, "decodes to JSON but not an object")];
  }

  const problems: string[] = [];
  if (typeof value.success !== "boolean") problems.push("success must be a boolean");
  if (typeof value.transaction !== "string") problems.push("transaction must be a string");
  if (typeof value.network !== "string") problems.push("network must be a string");

  const network = typeof value.network === "string" ? parseNetwork(value.network) : null;
  if (network?.kind === "lnbtc" && "payer" in value) {
    problems.push("payer MUST be omitted on an lnbtc settlement (Lightning reveals no payer)");
  }

  if (isObject(input.paymentRequired) && Array.isArray(input.paymentRequired.accepts)) {
    const offered = new Set(
      input.paymentRequired.accepts.filter(isObject).map((r) => parseNetwork(r.network).id)
    );
    if (network && offered.size > 0 && !offered.has(network.id)) {
      problems.push(`settled on ${network.id}, which no accepts[] entry offered`);
    }
  }

  const out: ValidationResult[] = [
    problems.length > 0
      ? fail(`${input.url} (PAYMENT-RESPONSE)`, "settlement response is not conformant", problems)
      : pass(
          `${input.url} (PAYMENT-RESPONSE)`,
          `success=${String(value.success)}, network=${String(value.network)}, transaction=${String(value.transaction).slice(0, 18)}…`
        ),
  ];

  if (mdfSite) {
    const cache = (input.headers.get("cache-control") ?? "").toLowerCase();
    out.push(
      /\bprivate\b/.test(cache) && /\bno-store\b/.test(cache)
        ? pass(`${input.url} (paid cache)`, "private, no-store ✓")
        : fail(`${input.url} (paid cache)`, `paid 200 must be "private, no-store", got ${cache || "(none)"}`)
    );
  }

  return out;
}
