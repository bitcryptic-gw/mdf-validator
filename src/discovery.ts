/**
 * discovery.ts — find URLs that should answer with a 402.
 *
 * Order matters, because each source says something slightly different:
 *
 *   1. `--priced-url` flags            — the operator asserting "this is priced".
 *   2. /.well-known/x402               — the site's own machine-readable index
 *                                        of paid resources (x402 discovery).
 *   3. /mdf.json priced sections       — paths an MDF site declares priced,
 *                                        resolved against real /llms.txt URLs
 *                                        (never fabricated from a glob).
 *   4. /llms.txt notes                 — entries whose trailing note says
 *                                        402/x402/paid.
 *
 * Kept separate from headers.ts so the ordering and de-duplication can be
 * tested without network I/O.
 */

import type { ValidationResult } from "./result.ts";
import { warn } from "./result.ts";
import { matchesPath } from "./glob.ts";
import { isPriced, priceEntryForPath } from "./mdf.ts";
import { USER_AGENT } from "./user-agent.ts";

export interface ProbeTarget {
  url: string;
  source: string;
}

export interface DiscoveryInput {
  baseUrl: string;
  mdfDoc: Record<string, unknown> | null;
  llmsText: string | null;
  explicit: string[];
  timeout: number;
  maxProbes?: number;
}

export const DEFAULT_MAX_PROBES = 10;

/**
 * Metadata documents are never priced content, even when a site's default
 * price applies to every path. The live demo's `/llms.txt` lists `/mdf.json`,
 * which a naive "is this path priced?" test turns into a 402 probe and then a
 * false "payment gate not enforced" failure.
 */
const METADATA_PATHS = [/^\/mdf\.json$/, /^\/llms\.txt$/, /^\/robots\.txt$/, /^\/feed\.xml$/, /^\/atom\.xml$/, /^\/sitemap\.xml$/, /^\/\.well-known\//];

export function isMetadataPath(path: string): boolean {
  return METADATA_PATHS.some((re) => re.test(path));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Absolute, same-origin content URLs from an llms.txt body, with their line. */
export function parseLlmsEntries(baseUrl: string, text: string): Array<{ url: string; line: string }> {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const out: Array<{ url: string; line: string }> = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const candidates: string[] = [];
    for (const m of line.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g)) candidates.push(m[1]);
    for (const m of line.matchAll(/https?:\/\/[^\s>)]+/g)) candidates.push(m[0]);

    for (const raw of candidates) {
      let url: URL;
      try {
        url = new URL(raw, base.origin + "/");
      } catch {
        continue;
      }
      if (url.origin !== base.origin) continue;
      if (seen.has(url.pathname)) continue;
      seen.add(url.pathname);
      out.push({ url: url.toString(), line });
    }
  }
  return out;
}

export function llmsNoteSaysPaid(line: string): boolean {
  return /\b(402|x402|paid)\b/i.test(line);
}

/** Paths an MDF doc declares priced, matched against real llms.txt URLs. */
export function mdfPricedUrls(
  baseUrl: string,
  mdfDoc: Record<string, unknown> | null,
  llmsEntries: Array<{ url: string }>
): ProbeTarget[] {
  if (!mdfDoc) return [];
  const out: ProbeTarget[] = [];
  for (const { url } of llmsEntries) {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    if (isPriced(priceEntryForPath(path, mdfDoc))) {
      out.push({ url, source: "mdf.json pricing" });
    }
  }
  return out;
}

/** Resource URLs from a /.well-known/x402 document. */
export function wellKnownUrls(baseUrl: string, doc: unknown): ProbeTarget[] {
  if (!isObject(doc)) return [];
  const out: ProbeTarget[] = [];
  const lists: unknown[] = [];
  if (Array.isArray(doc.resources)) lists.push(doc.resources);
  if (Array.isArray(doc.items)) lists.push(doc.items);

  for (const list of lists) {
    for (const entry of list as unknown[]) {
      if (!isObject(entry)) continue;
      const raw =
        typeof entry.resource === "string"
          ? entry.resource
          : typeof entry.url === "string"
            ? entry.url
            : isObject(entry.resource) && typeof entry.resource.url === "string"
              ? entry.resource.url
              : null;
      if (!raw) continue;
      try {
        out.push({ url: new URL(raw, baseUrl + "/").toString(), source: "/.well-known/x402" });
      } catch {
        /* ignore unparseable */
      }
    }
  }
  return out;
}

async function fetchJson(url: string, timeout: number): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function discoverPricedUrls(
  input: DiscoveryInput
): Promise<{ targets: ProbeTarget[]; notes: ValidationResult[] }> {
  const max = input.maxProbes ?? DEFAULT_MAX_PROBES;
  const notes: ValidationResult[] = [];
  const collected: ProbeTarget[] = [];

  for (const url of input.explicit) collected.push({ url, source: "--priced-url" });

  const wellKnown = await fetchJson(`${input.baseUrl}/.well-known/x402`, input.timeout);
  if (wellKnown) {
    const found = wellKnownUrls(input.baseUrl, wellKnown);
    for (const t of found) collected.push(t);
    if (found.length === 0) {
      notes.push(warn(`${input.baseUrl}/.well-known/x402`, "present but lists no resources"));
    }
  }

  const llmsEntries = input.llmsText
    ? parseLlmsEntries(input.baseUrl, input.llmsText)
    : [];

  if (input.mdfDoc) {
    for (const t of mdfPricedUrls(input.baseUrl, input.mdfDoc, llmsEntries)) collected.push(t);
  }

  for (const entry of llmsEntries) {
    if (llmsNoteSaysPaid(entry.line)) {
      collected.push({ url: entry.url, source: "/llms.txt note" });
    }
  }

  // De-duplicate by path, keeping the first (highest-priority) source.
  const byPath = new Map<string, ProbeTarget>();
  for (const t of collected) {
    let path: string;
    try {
      path = new URL(t.url).pathname;
    } catch {
      path = t.url;
    }
    if (isMetadataPath(path)) continue;
    if (!byPath.has(path)) byPath.set(path, t);
  }

  const targets = [...byPath.values()].slice(0, max);
  if (byPath.size > max) {
    notes.push(
      warn(
        `${input.baseUrl} (402 discovery)`,
        `${byPath.size} priced URLs discovered, probing the first ${max} (cap ${max})`
      )
    );
  }

  return { targets, notes };
}
