#!/usr/bin/env bun

/**
 * mdf-validate — CLI validator for MDF (Markdown First) sites
 *
 * Usage:
 *   mdf-validate <url>
 *   mdf-validate --check-headers <url>
 *   mdf-validate --priced-url <url>... <url>
 *   mdf-validate --paid-response <capture.json> <url>
 *   mdf-validate --json <url>
 *   mdf-validate --help
 */

import { readFileSync } from "node:fs";
import { validateMdfJson, declaredVersionResult } from "./validator.ts";
import { checkHeaders } from "./headers.ts";
import { evaluatePaidResponse } from "./evaluate.ts";
import type { ResponseHeaders } from "./evaluate.ts";
import { formatText, formatJson } from "./output.ts";
import type { ValidationResult } from "./result.ts";
import { applyMdfSignals, dedupeSignals } from "./mdf-signal.ts";
import type { MdfSignal } from "./mdf-signal.ts";

export type { ValidationResult } from "./result.ts";

const VERSION = "0.2.0";

function usage() {
  console.log(`
mdf-validate v${VERSION}

Validates an MDF site, and — independently of /mdf.json — any x402 offer it serves.

Usage:
  mdf-validate [options] <url>

Options:
  --check-headers        Probe /llms.txt, free-content headers, and every
                         discoverable priced URL (mdf.json pricing, /llms.txt
                         notes, /.well-known/x402). Runs even if /mdf.json is
                         missing or invalid.
  --priced-url <url>     Probe this URL for a 402. Repeatable. Implies
                         --check-headers.
  --paid-response <file> Check a captured paid 200. The file is JSON:
                         { "url": "...", "status": 200,
                           "headers": { "payment-response": "<base64>" },
                           "paymentRequired": { ...optional 402 body... } }
  --json                 Output results as JSON (for machine consumption)
  --delay <ms>           Minimum gap between 402 probes (default: 0; use 2000
                         when probing someone else's site)
  --timeout <ms>         Request timeout in milliseconds (default: 10000)
  --help                 Show this help message
  --version              Show version

Exit code is 1 when any check fails at error level. Warnings do not fail.

Examples:
  mdf-validate https://mdf-demo.bitcryptic.com
  mdf-validate --check-headers https://prooflines.org
  mdf-validate --priced-url https://example.com/premium https://example.com
`.trim());
}

interface Args {
  url: string | null;
  checkHeaders: boolean;
  jsonOutput: boolean;
  timeout: number;
  pricedUrls: string[];
  paidResponse: string | null;
  delayMs: number;
}

function parseArgs(args: string[]): Args {
  const out: Args = {
    url: null,
    checkHeaders: false,
    jsonOutput: false,
    timeout: 10000,
    pricedUrls: [],
    paidResponse: null,
    delayMs: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      console.log(`mdf-validate v${VERSION}`);
      process.exit(0);
    }
    if (arg === "--check-headers") {
      out.checkHeaders = true;
      continue;
    }
    if (arg === "--json") {
      out.jsonOutput = true;
      continue;
    }
    if (arg === "--priced-url") {
      const next = args[++i];
      if (!next || !/^https?:\/\//.test(next)) {
        console.error("--priced-url needs an absolute http(s) URL");
        process.exit(1);
      }
      out.pricedUrls.push(next);
      out.checkHeaders = true;
      continue;
    }
    if (arg === "--paid-response") {
      const next = args[++i];
      if (!next) {
        console.error("--paid-response needs a file path");
        process.exit(1);
      }
      out.paidResponse = next;
      continue;
    }
    if (arg === "--delay") {
      const next = args[++i];
      const parsed = parseInt(next, 10);
      if (isNaN(parsed) || parsed < 0) {
        console.error("--delay must be a number >= 0");
        process.exit(1);
      }
      out.delayMs = parsed;
      continue;
    }
    if (arg === "--timeout") {
      const next = args[++i];
      const parsed = parseInt(next, 10);
      if (isNaN(parsed) || parsed < 100) {
        console.error("--timeout must be a number >= 100");
        process.exit(1);
      }
      out.timeout = parsed;
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    out.url = arg;
  }

  return out;
}

function headerGetter(headers: Record<string, string>): ResponseHeaders {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), String(v));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function loadPaidCapture(path: string) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const headers = (parsed.headers ?? {}) as Record<string, string>;
  return {
    url: typeof parsed.url === "string" ? parsed.url : "(capture)",
    status: typeof parsed.status === "number" ? parsed.status : 200,
    headers: headerGetter(headers),
    paymentRequired: parsed.paymentRequired,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const { url, checkHeaders: doCheckHeaders, jsonOutput, timeout, pricedUrls, paidResponse, delayMs } =
    parseArgs(args);

  if (!url) {
    console.error("Error: URL is required");
    usage();
    process.exit(1);
  }

  let baseUrl: string;
  try {
    const parsed = new URL(url);
    baseUrl = parsed.origin + parsed.pathname.replace(/\/$/, "");
  } catch {
    console.error(`Error: Invalid URL: ${url}`);
    process.exit(1);
  }

  const results: ValidationResult[] = [];
  const signals: MdfSignal[] = [];

  // 1. /mdf.json — its own result. Never a gate for anything below (finding B1).
  const mdfResult = await validateMdfJson(baseUrl, timeout);
  results.push(mdfResult);
  const versionLine = declaredVersionResult(mdfResult);
  if (versionLine) results.push(versionLine);

  // 2. Everything else, independently of step 1.
  if (doCheckHeaders) {
    results.push(
      ...(await checkHeaders(baseUrl, mdfResult.doc ?? null, timeout, {
        pricedUrls,
        mdfMajor: mdfResult.major,
        delayMs,
        signalSink: (signal) => signals.push(signal),
      }))
    );
  }

  // A missing /mdf.json is a warning only when the site gives no other MDF
  // signal; if it does, the missing document is a real defect. Severity only —
  // every check above still ran.
  if (mdfResult.xMdfVersionHeader) {
    signals.push({
      kind: "x-mdf-version",
      label: `X-MDF-Version: ${mdfResult.xMdfVersionHeader} on /mdf.json`,
      where: `${baseUrl}/mdf.json`,
    });
  }
  const mdfIndex = results.indexOf(mdfResult);
  if (mdfIndex >= 0) results[mdfIndex] = applyMdfSignals(mdfResult, dedupeSignals(signals));

  // 3. Captured paid 200, if supplied.
  if (paidResponse) {
    const capture = loadPaidCapture(paidResponse);
    results.push(
      ...evaluatePaidResponse({
        ...capture,
        mdfDoc: mdfResult.doc ?? null,
        mdfMajor: mdfResult.major,
      })
    );
  }

  if (jsonOutput) {
    process.stdout.write(formatJson(results) + "\n");
  } else {
    process.stdout.write(formatText(results) + "\n");
  }

  const failed = results.some((r) => !r.pass && r.level === "error");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err?.message ?? err);
  process.exit(1);
});
