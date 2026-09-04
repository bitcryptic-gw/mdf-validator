/**
 * headers.ts — verify MDF response headers on content URLs
 */

import type { ValidationResult } from "./index.ts";

// x-mdf-version appears in the spec's content-serving example (CONCEPT.md).
// x-mdf-tokens was removed from the spec (CONCEPT.md:105) and is not required.
const REQUIRED_HEADERS = ["x-mdf-version"] as const;
const EXPECTED_CONTENT_TYPE = "text/markdown";

export async function checkHeaders(
  baseUrl: string,
  mdfDoc: Record<string, unknown>,
  timeout: number
): Promise<ValidationResult[]> {
  // Find a free ($0.00) content URL to test against — no payment needed
  const testUrl = findFreeUrl(baseUrl, mdfDoc);
  if (!testUrl) {
    return [
      {
        pass: false,
        level: "warn",
        label: `${baseUrl} (headers check)`,
        message: "no free content URL found in pricing sections to test headers against",
      },
    ];
  }

  const results: ValidationResult[] = [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(testUrl, {
      headers: { Accept: "text/markdown, text/html;q=0.9" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Content-Type check
    const contentType = res.headers.get("content-type") ?? "";
    const hasMarkdownType = contentType.startsWith(EXPECTED_CONTENT_TYPE);
    results.push({
      pass: hasMarkdownType,
      level: hasMarkdownType ? "info" : "error",
      label: `${testUrl} Content-Type`,
      message: hasMarkdownType
        ? `text/markdown ✓`
        : `expected text/markdown, got ${contentType || "(none)"}`,
    });

    // Required MDF headers
    for (const header of REQUIRED_HEADERS) {
      const val = res.headers.get(header);
      const present = val !== null;
      results.push({
        pass: present,
        level: present ? "info" : "error",
        label: `${testUrl} ${header}`,
        message: present ? `${val}` : "missing",
      });
    }

    // X-MDF-Price — optional but notable if absent
    const price = res.headers.get("x-mdf-price");
    results.push({
      pass: true,
      level: "info",
      label: `${testUrl} x-mdf-price`,
      message: price !== null ? price : "(not present — optional for free content)",
    });
  } catch (err: any) {
    results.push({
      pass: false,
      level: "error",
      label: `${testUrl} (headers check)`,
      message:
        err?.name === "AbortError"
          ? "timed out"
          : `fetch failed (${err?.message ?? "unknown error"})`,
    });
  }

  return results;
}

function findFreeUrl(
  baseUrl: string,
  mdfDoc: Record<string, unknown>
): string | null {
  const pricing = mdfDoc.pricing as Record<string, unknown> | undefined;
  if (!pricing) return null;

  const sections = pricing.sections as Record<string, unknown> | undefined;
  if (!sections) {
    // Check if default is free
    const def = pricing.default as Record<string, unknown> | undefined;
    if (def && def.amount === "0.0000") return baseUrl + "/";
    return null;
  }

  // Find first section with amount 0
  for (const [pattern, rule] of Object.entries(sections)) {
    const r = rule as Record<string, unknown>;
    if (r.amount === "0.0000" || r.amount === "0.00" || r.amount === "0") {
      // Convert glob pattern to a concrete URL
      const concreteUrl = patternToUrl(baseUrl, pattern);
      if (concreteUrl) return concreteUrl;
    }
  }

  // Fall back to root if default is free
  const def = pricing.default as Record<string, unknown> | undefined;
  if (def && (def.amount === "0.0000" || def.amount === "0.00" || def.amount === "0")) {
    return baseUrl + "/";
  }

  return null;
}

function patternToUrl(baseUrl: string, pattern: string): string | null {
  // Strip glob suffixes to get a concrete path
  const concrete = pattern
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\*\*$/, "")
    .replace(/\*$/, "");

  if (!concrete || concrete === "/") return baseUrl + "/";
  return baseUrl + concrete;
}
