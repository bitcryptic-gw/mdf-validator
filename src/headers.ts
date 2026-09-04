/**
 * headers.ts — verify MDF response headers on content URLs, and validate a
 * live 402 body when the site declares priced content.
 *
 * Test URLs are resolved from the site's own /llms.txt rather than fabricated
 * from pricing globs. The old glob-fabrication heuristic failed conformant
 * sites whose free tier was a glob with no page at the glob root (e.g. a free
 * /docs/** with no /docs page): it probed /docs, got a 404, and reported a
 * header failure on the 404 body. /llms.txt exists to list real resources.
 */

import type { ValidationResult } from "./index.ts";
import { validate402Body } from "./validator.ts";

const REQUIRED_HEADERS = ["x-mdf-version"] as const;
const EXPECTED_CONTENT_TYPE = "text/markdown";

type PriceRule = {
  amount?: unknown;
  currency?: unknown;
  chain?: unknown;
};

/**
 * Look up the price rule for a URL path using the same glob semantics the
 * reference implementation uses: most-specific (longest) matching section
 * wins, otherwise the default. Returns null when pricing is absent.
 */
function priceForPath(
  urlPath: string,
  mdfDoc: Record<string, unknown>
): PriceRule | null {
  const pricing = mdfDoc.pricing as Record<string, unknown> | undefined;
  if (!pricing) return null;

  const sections = pricing.sections as Record<string, unknown> | undefined;
  const def = pricing.default as PriceRule | undefined;

  if (sections) {
    let bestPattern: string | null = null;
    for (const pattern of Object.keys(sections)) {
      if (globToRegex(pattern).test(urlPath)) {
        if (bestPattern === null || pattern.length > bestPattern.length) {
          bestPattern = pattern;
        }
      }
    }
    if (bestPattern !== null) {
      return sections[bestPattern] as PriceRule;
    }
  }

  return def ?? null;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLE§")
    .replace(/\*/g, "[^/]+")
    .replace(/§DOUBLE§/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isFree(rule: PriceRule | null): boolean {
  return rule !== null && parseFloat(String(rule.amount)) === 0;
}

function isPriced(rule: PriceRule | null): boolean {
  return rule !== null && parseFloat(String(rule.amount)) > 0;
}

/**
 * Extract absolute, same-origin content URLs from an llms.txt body.
 * Accepts markdown links ([Title](url)) and bare http(s) URLs.
 */
function parseLlmsUrls(baseUrl: string, llmsText: string): string[] {
  const base = new URL(baseUrl);
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw, base.origin + "/");
    } catch {
      return;
    }
    if (url.origin !== base.origin) return;
    const normalized = url.pathname;
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(url.toString());
  };

  const linkRe = /\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g;
  const bareRe = /https?:\/\/[^\s>]+/g;

  for (const m of llmsText.matchAll(linkRe)) push(m[1]);
  for (const m of llmsText.matchAll(bareRe)) push(m[0]);

  return out;
}

async function fetchText(url: string, timeout: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function checkHeaders(
  baseUrl: string,
  mdfDoc: Record<string, unknown>,
  timeout: number
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // Resolve real content URLs from /llms.txt when available.
  const llmsText = await fetchText(`${baseUrl}/llms.txt`, timeout);
  const llmsUrls = llmsText ? parseLlmsUrls(baseUrl, llmsText) : [];

  const freeUrls = llmsUrls.filter((u) => isFree(priceForPath(new URL(u).pathname, mdfDoc)));
  const pricedUrls = llmsUrls.filter((u) => isPriced(priceForPath(new URL(u).pathname, mdfDoc)));

  // A free URL for the header checks: prefer a real listed URL, then fall back
  // to the site root only when the root itself is free.
  let freeUrl: string | null = null;
  let freeSource = "";
  if (freeUrls.length > 0) {
    freeUrl = freeUrls[0];
    freeSource = "from /llms.txt";
  } else if (isFree(priceForPath("/", mdfDoc))) {
    freeUrl = baseUrl + "/";
    freeSource = "site root (free default)";
  }

  if (!freeUrl) {
    results.push({
      pass: false,
      level: "warn",
      label: `${baseUrl} (headers check)`,
      message:
        llmsUrls.length === 0
          ? "no /llms.txt and no free default — skipped free-content header checks (site may be fully priced)"
          : "no free content URL found in /llms.txt or pricing — skipped free-content header checks",
    });
  } else {
    const freeHeaders = await probeContentUrl(freeUrl, timeout, "free");
    if (freeHeaders) {
      const { contentType, status } = freeHeaders;
      if (status !== 200) {
        results.push({
          pass: false,
          level: "warn",
          label: `${freeUrl} (free content, ${freeSource})`,
          message: `returned HTTP ${status} — header checks inconclusive`,
        });
      } else {
        const hasMarkdownType = contentType.startsWith(EXPECTED_CONTENT_TYPE);
        results.push({
          pass: hasMarkdownType,
          level: hasMarkdownType ? "info" : "error",
          label: `${freeUrl} Content-Type`,
          message: hasMarkdownType
            ? `text/markdown ✓`
            : `expected text/markdown, got ${contentType || "(none)"}`,
        });

        for (const header of REQUIRED_HEADERS) {
          const val = freeHeaders.headers.get(header);
          const present = val !== null;
          results.push({
            pass: present,
            level: present ? "info" : "error",
            label: `${freeUrl} ${header}`,
            message: present ? `${val}` : "missing",
          });
        }

        const price = freeHeaders.headers.get("x-mdf-price");
        results.push({
          pass: true,
          level: "info",
          label: `${freeUrl} x-mdf-price`,
          message: price !== null ? price : "(not present — optional for free content)",
        });
      }
    }
  }

  // A priced URL to exercise the 402 path. Only real listed URLs qualify; the
  // 402 body is returned pre-payment, so this costs nothing to probe.
  if (pricedUrls.length === 0) {
    results.push({
      pass: true,
      level: "info",
      label: `${baseUrl} (402 check)`,
      message: llmsUrls.length === 0
        ? "skipped — no /llms.txt to resolve a priced URL from"
        : "skipped — no priced content URL found in /llms.txt",
    });
  } else {
    await check402Response(pricedUrls[0], timeout, results);
  }

  return results;
}

/** Fetch a content URL and return headers + status (Accept: markdown). */
async function probeContentUrl(
  url: string,
  timeout: number
): Promise<{ status: number; contentType: string; headers: Headers } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      headers: { Accept: "text/markdown, text/html;q=0.9" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      headers: res.headers,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a priced URL and classify the outcome. The cases are deliberately
 * distinct because each means something different.
 */
async function check402Response(
  url: string,
  timeout: number,
  results: ValidationResult[]
): Promise<void> {
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    res = await fetch(url, {
      headers: { Accept: "text/markdown, text/html;q=0.9" },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err: any) {
    results.push({
      pass: false,
      level: "warn",
      label: `${url} (402 check)`,
      message:
        err?.name === "AbortError"
          ? "timed out — inconclusive"
          : "fetch failed — inconclusive",
    });
    return;
  }

  const label = `${url} (402 check)`;

  if (res.status === 402) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      results.push({
        pass: false,
        level: "error",
        label,
        message: "returned 402 but body is not valid JSON",
      });
      return;
    }
    const errors = validate402Body(body);
    if (errors.length > 0) {
      results.push({
        pass: false,
        level: "error",
        label,
        message: "402 body failed mdf-402.schema.json validation",
        errors,
      });
    } else {
      results.push({
        pass: true,
        level: "info",
        label,
        message: "402 body validates against mdf-402.schema.json",
      });
    }
    return;
  }

  if (res.status === 200) {
    results.push({
      pass: false,
      level: "error",
      label,
      message: "served paid content with HTTP 200 and no 402 — payment gate not enforced",
    });
    return;
  }

  results.push({
    pass: false,
    level: "warn",
    label,
    message: `returned HTTP ${res.status} — no 402 to validate, inconclusive`,
  });
}
