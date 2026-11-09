/**
 * headers.ts — the network side: fetch a site, probe content and 402s, and
 * hand the responses to the pure evaluator.
 *
 * Two lessons from the 2026-11-08 interop run are baked in:
 *   - nothing here is gated on `/mdf.json` parsing (finding B1). A third-party
 *     x402 site with no MDF document is still checked.
 *   - 402 URLs are discovered from several sources (finding B2), including
 *     `/.well-known/x402`, which is what a non-MDF publisher actually serves.
 */

import type { ValidationResult } from "./result.ts";
import { fail, info, pass, warn } from "./result.ts";
import { priceEntryForPath } from "./mdf.ts";
import { specMajorOf } from "./schemas.ts";
import type { SpecMajor } from "./schemas.ts";
import { discoverPricedUrls } from "./discovery.ts";
import type { ProbeTarget } from "./discovery.ts";
import { evaluate402Response } from "./evaluate.ts";
import { DEFAULT_MAX_PROBES, parseLlmsEntries } from "./discovery.ts";
import { USER_AGENT } from "./user-agent.ts";

const REQUIRED_HEADERS = ["x-mdf-version"] as const;
const EXPECTED_CONTENT_TYPE = "text/markdown";

export interface HeaderCheckOptions {
  /** Extra priced URLs from `--priced-url`. */
  pricedUrls?: string[];
  mdfMajor?: SpecMajor;
  maxProbes?: number;
  /** Minimum gap between 402 probes, in milliseconds. Polite when probing someone else's site. */
  delayMs?: number;
}

async function fetchText(url: string, timeout: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Is the price entry for this path free (no rails, or a zero 0.2 amount)? */
function isFreePath(path: string, mdfDoc: Record<string, unknown> | null): boolean {
  const entry = priceEntryForPath(path, mdfDoc);
  if (!entry) return false;
  return entry.rails.length === 0;
}

export async function checkHeaders(
  baseUrl: string,
  mdfDoc: Record<string, unknown> | null,
  timeout: number,
  opts: HeaderCheckOptions = {}
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const mdfMajor = opts.mdfMajor ?? specMajorOf(mdfDoc?.mdf_version);
  const llmsText = await fetchText(`${baseUrl}/llms.txt`, timeout);
  const llmsEntries = llmsText ? parseLlmsEntries(baseUrl, llmsText) : [];

  // --- free-content header checks -----------------------------------------
  const freeUrl =
    llmsEntries.find((e) => isFreePath(new URL(e.url).pathname, mdfDoc))?.url ??
    (isFreePath("/", mdfDoc) ? baseUrl + "/" : null);

  if (!freeUrl) {
    results.push(
      warn(
        `${baseUrl} (headers check)`,
        llmsEntries.length === 0
          ? "no /llms.txt and no free default — skipped free-content header checks (site may be fully priced)"
          : "no free content URL found in /llms.txt or pricing — skipped free-content header checks"
      )
    );
  } else {
    results.push(...(await probeFreeUrl(freeUrl, timeout)));
  }

  // --- 402 discovery + evaluation -----------------------------------------
  const { targets, notes } = await discoverPricedUrls({
    baseUrl,
    mdfDoc,
    llmsText,
    explicit: opts.pricedUrls ?? [],
    timeout,
    maxProbes: opts.maxProbes ?? DEFAULT_MAX_PROBES,
  });
  results.push(...notes);

  if (targets.length === 0) {
    results.push(
      pass(
        `${baseUrl} (402 check)`,
        "skipped — discovery found no priced URL (--priced-url, /.well-known/x402, mdf.json pricing, /llms.txt note)"
      )
    );
  } else {
    results.push(
      info(
        `${baseUrl} (402 discovery)`,
        `${targets.length} priced URL${targets.length === 1 ? "" : "s"}: ` +
          targets
            .map((t) => {
              try {
                return `${new URL(t.url).pathname} [${t.source}]`;
              } catch {
                return `${t.url} [${t.source}]`;
              }
            })
            .join(", ")
      )
    );

    const gap = opts.delayMs ?? 0;
    for (const [i, target] of targets.entries()) {
      if (i > 0 && gap > 0) await new Promise((r) => setTimeout(r, gap));
      results.push(...(await probePricedUrl(target, timeout, mdfDoc, mdfMajor)));
    }
  }

  return results;
}

async function probeFreeUrl(url: string, timeout: number): Promise<ValidationResult[]> {
  const out: ValidationResult[] = [];
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    res = await fetch(url, {
      headers: { Accept: "text/markdown, text/html;q=0.9", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    return [warn(`${url} (free content)`, "probe failed — header checks inconclusive")];
  }

  if (res.status !== 200) {
    return [warn(`${url} (free content)`, `returned HTTP ${res.status} — header checks inconclusive`)];
  }

  const contentType = res.headers.get("content-type") ?? "";
  const hasMarkdownType = contentType.startsWith(EXPECTED_CONTENT_TYPE);
  out.push(
    hasMarkdownType
      ? pass(`${url} Content-Type`, "text/markdown ✓")
      : fail(`${url} Content-Type`, `expected text/markdown, got ${contentType || "(none)"}`)
  );

  for (const header of REQUIRED_HEADERS) {
    const val = res.headers.get(header);
    out.push(
      val !== null
        ? pass(`${url} ${header}`, val)
        : fail(`${url} ${header}`, "missing")
    );
  }

  return out;
}

async function probePricedUrl(
  target: ProbeTarget,
  timeout: number,
  mdfDoc: Record<string, unknown> | null,
  mdfMajor: SpecMajor
): Promise<ValidationResult[]> {
  const label = `${target.url} (402, ${target.source})`;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    res = await fetch(target.url, {
      headers: { Accept: "text/markdown, text/html;q=0.9", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err: any) {
    return [
      warn(label, err?.name === "AbortError" ? "timed out — inconclusive" : "fetch failed — inconclusive"),
    ];
  }

  if (res.status !== 402) {
    return res.status === 200
      ? [
          fail(
            label,
            "served content with HTTP 200 and no 402 — payment gate not enforced for a URL the site advertises as priced"
          ),
        ]
      : [warn(label, `returned HTTP ${res.status}, not 402 — no offer to validate`)];
  }

  const raw = await res.text();
  let body: unknown = null;
  let bodyError: string | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    bodyError = raw.trim() === "" ? "body is empty" : "body is not valid JSON";
  }

  return evaluate402Response({
    url: target.url,
    body,
    bodyError,
    headers: res.headers,
    mdfDoc,
    mdfMajor,
    path: new URL(target.url).pathname,
  });
}
