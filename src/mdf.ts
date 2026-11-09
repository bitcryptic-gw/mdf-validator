/**
 * mdf.ts — reading `/mdf.json` pricing across spec generations.
 *
 * 0.3.0: an entry is `{ rails: [{ scheme, network, asset, amount }], access? }`.
 * 0.2.x: an entry is `{ amount, currency, chain }`, one rail implied.
 *
 * Both are read into the same small `PriceEntry`, because everything the
 * validator does with pricing (discovery, the accepts[]↔rails comparison,
 * the token-access rule) wants rails rather than raw JSON.
 */

import { matchesPath } from "./glob.ts";
import { normaliseLegacyNetwork } from "./network.ts";

export interface DeclaredRail {
  scheme: string;
  network: string;
  asset: string | null;
  amount: string | null;
  /** True when synthesised from a 0.2 `amount`/`currency`/`chain` entry. */
  legacy: boolean;
}

export type AccessMode = "per_fetch" | "token";

export interface PriceEntry {
  /** The section glob this came from, or "default". */
  key: string;
  rails: DeclaredRail[];
  access: AccessMode;
}

type Doc = Record<string, unknown>;

function isObject(v: unknown): v is Doc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read one raw price entry into the common model (never throws). */
export function readPriceEntry(key: string, raw: unknown): PriceEntry | null {
  if (!isObject(raw)) return null;

  if (Array.isArray(raw.rails)) {
    const rails: DeclaredRail[] = [];
    for (const r of raw.rails) {
      if (!isObject(r)) continue;
      rails.push({
        scheme: typeof r.scheme === "string" ? r.scheme : "",
        network:
          typeof r.network === "string" ? normaliseLegacyNetwork(r.network) : "",
        asset: typeof r.asset === "string" ? r.asset : null,
        amount: typeof r.amount === "string" ? r.amount : null,
        legacy: false,
      });
    }
    return {
      key,
      rails,
      access: raw.access === "token" ? "token" : "per_fetch",
    };
  }

  // 0.2.x shape: amount/currency/chain, with amount "0"/"0.0000" meaning free.
  if (typeof raw.amount === "string") {
    const free = /^0+(\.0+)?$/.test(raw.amount.trim());
    return {
      key,
      rails: free
        ? []
        : [
            {
              scheme: "exact",
              network:
                typeof raw.chain === "string"
                  ? normaliseLegacyNetwork(raw.chain)
                  : "",
              asset: null,
              amount: raw.amount,
              legacy: true,
            },
          ],
      access: "per_fetch",
    };
  }

  return null;
}

/** The price entry that applies to a path: most specific matching glob wins. */
export function priceEntryForPath(path: string, doc: Doc | null): PriceEntry | null {
  if (!doc) return null;
  const pricing = doc.pricing;
  if (!isObject(pricing)) return null;

  const sections = isObject(pricing.sections) ? pricing.sections : null;
  if (sections) {
    let best: string | null = null;
    for (const pattern of Object.keys(sections)) {
      if (matchesPath(pattern, path) && (best === null || pattern.length > best.length)) {
        best = pattern;
      }
    }
    if (best !== null) {
      const entry = readPriceEntry(best, sections[best]);
      if (entry) return entry;
    }
  }

  if (pricing.default !== undefined) {
    return readPriceEntry("default", pricing.default);
  }
  return null;
}

/** Every price entry in the document, default first. */
export function allPriceEntries(doc: Doc | null): PriceEntry[] {
  if (!doc) return [];
  const pricing = doc.pricing;
  if (!isObject(pricing)) return [];
  const out: PriceEntry[] = [];
  if (pricing.default !== undefined) {
    const def = readPriceEntry("default", pricing.default);
    if (def) out.push(def);
  }
  if (isObject(pricing.sections)) {
    for (const [pattern, raw] of Object.entries(pricing.sections)) {
      const entry = readPriceEntry(pattern, raw);
      if (entry) out.push(entry);
    }
  }
  return out;
}

export function isPriced(entry: PriceEntry | null): boolean {
  return !!entry && entry.rails.length > 0;
}

/**
 * The direct form of the token-access rule (decision 20). The JSON Schema
 * encodes the contrapositive; the validator checks this spelling too so a
 * schema change cannot silently drop the requirement.
 */
export function tokenAccessWithoutAuth(doc: Doc | null): string[] {
  if (!doc) return [];
  const auth = isObject(doc.auth) ? doc.auth : null;
  const hasEndpoint =
    !!auth && typeof auth.endpoint === "string" && auth.endpoint.length > 0;
  if (hasEndpoint) return [];
  return allPriceEntries(doc)
    .filter((e) => e.access === "token")
    .map((e) => e.key);
}

/** Union of every network any rail declares. */
export function declaredNetworks(doc: Doc | null): string[] {
  const set = new Set<string>();
  for (const entry of allPriceEntries(doc)) {
    for (const rail of entry.rails) if (rail.network) set.add(rail.network);
  }
  return [...set];
}
