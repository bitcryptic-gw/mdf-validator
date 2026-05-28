#!/usr/bin/env bun

/**
 * mdf-validate — CLI validator for MDF (Markdown First) sites
 *
 * Usage:
 *   mdf-validate <url>
 *   mdf-validate --check-headers <url>
 *   mdf-validate --json <url>
 *   mdf-validate --help
 */

import { validateMdfJson } from "./validator.ts";
import { checkHeaders } from "./headers.ts";
import { formatText, formatJson } from "./output.ts";

const VERSION = "0.1.0";

function usage() {
  console.log(`
mdf-validate v${VERSION}

Validates an MDF-compliant site by fetching and checking /mdf.json.

Usage:
  mdf-validate [options] <url>

Options:
  --check-headers   Also fetch a sample content URL and verify MDF response headers
  --json            Output results as JSON (for machine consumption)
  --timeout <ms>    Request timeout in milliseconds (default: 10000)
  --help            Show this help message
  --version         Show version

Examples:
  mdf-validate https://mdf-demo.bitcryptic.com
  mdf-validate --check-headers https://mdf-demo.bitcryptic.com
  mdf-validate --json https://mdf-demo.bitcryptic.com
`.trim());
}

function parseArgs(args: string[]): {
  url: string | null;
  checkHeaders: boolean;
  jsonOutput: boolean;
  timeout: number;
} {
  let url: string | null = null;
  let checkHeaders = false;
  let jsonOutput = false;
  let timeout = 10000;

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
      checkHeaders = true;
      continue;
    }
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    if (arg === "--timeout") {
      const next = args[++i];
      const parsed = parseInt(next, 10);
      if (isNaN(parsed) || parsed < 100) {
        console.error("--timeout must be a number >= 100");
        process.exit(1);
      }
      timeout = parsed;
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    url = arg;
  }

  return { url, checkHeaders, jsonOutput, timeout };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const { url, checkHeaders: doCheckHeaders, jsonOutput, timeout } = parseArgs(args);

  if (!url) {
    console.error("Error: URL is required");
    usage();
    process.exit(1);
  }

  // Normalise URL — strip trailing slash
  let baseUrl: string;
  try {
    const parsed = new URL(url);
    baseUrl = parsed.origin + parsed.pathname.replace(/\/$/, "");
  } catch {
    console.error(`Error: Invalid URL: ${url}`);
    process.exit(1);
  }

  const results: ValidationResult[] = [];

  // Step 1: fetch and validate /mdf.json
  const mdfResult = await validateMdfJson(baseUrl, timeout);
  results.push(mdfResult);

  // Step 2: check /llms.txt reachability if mdf.json passed
  if (mdfResult.pass) {
    const llmsUrl = `${baseUrl}/llms.txt`;
    const llmsResult = await checkReachability(llmsUrl, timeout);
    results.push(llmsResult);

    // Step 3: optionally check content headers
    if (doCheckHeaders && mdfResult.data) {
      const headerResults = await checkHeaders(baseUrl, mdfResult.data, timeout);
      results.push(...headerResults);
    }
  }

  // Output
  if (jsonOutput) {
    process.stdout.write(formatJson(results) + "\n");
  } else {
    process.stdout.write(formatText(results) + "\n");
  }

  const allPassed = results.every((r) => r.pass || r.level === "warn");
  process.exit(allPassed ? 0 : 1);
}

async function checkReachability(url: string, timeout: number): Promise<ValidationResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      return { pass: true, level: "info", label: url, message: "reachable" };
    } else {
      return {
        pass: false,
        level: "warn",
        label: url,
        message: `not reachable (HTTP ${res.status})`,
      };
    }
  } catch (err: any) {
    return {
      pass: false,
      level: "warn",
      label: url,
      message: err?.name === "AbortError" ? "timed out" : `not reachable (${err?.message ?? "unknown error"})`,
    };
  }
}

export interface ValidationResult {
  pass: boolean;
  level: "info" | "warn" | "error";
  label: string;
  message: string;
  errors?: string[];
  data?: Record<string, unknown>;
}

main().catch((err) => {
  console.error("Unexpected error:", err?.message ?? err);
  process.exit(1);
});
