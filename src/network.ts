/**
 * network.ts — CAIP-2 parsing, and normalisation of the chain names x402 v1
 * used on the wire.
 *
 * The validator compares networks across three vintages: v2 CAIP-2 ids,
 * x402 v1 chain names ("base", "base-sepolia"), and MDF 0.2 "chain" values
 * ("base", "lightning"). Everything normalises to a CAIP-2 string so the
 * comparison is one string equality.
 */

export type NetworkKind = "eip155" | "lnbtc" | "other" | "invalid";

export interface ParsedNetwork {
  kind: NetworkKind;
  /** CAIP-2 id as given (trimmed), or the raw value when invalid. */
  id: string;
  namespace?: string;
  reference?: string;
  chainId?: number;
}

/** The CAIP-2 pattern x402 v2 itself uses (spec §11.1 / core NetworkSchemaV2). */
const CAIP2 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/;

export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";
export const LNBTC_MAINNET = "lnbtc:000000000019d6689c085ae165831e93";

/**
 * Legacy x402 v1 / MDF 0.2 chain names → CAIP-2.
 *
 * Deliberately conservative: only names whose mapping is unambiguous. A name
 * not in this table stays unmatched rather than being guessed, so the caller
 * reports "unknown network" instead of comparing against the wrong chain.
 */
const LEGACY_NAMES: Record<string, string> = {
  base: BASE_MAINNET,
  "base-mainnet": BASE_MAINNET,
  base_mainnet: BASE_MAINNET,
  "base-sepolia": BASE_SEPOLIA,
  base_sepolia: BASE_SEPOLIA,
  "base-sepolia-testnet": BASE_SEPOLIA,
  ethereum: "eip155:1",
  mainnet: "eip155:1",
  lightning: LNBTC_MAINNET,
  l402: LNBTC_MAINNET,
  lnbtc: LNBTC_MAINNET,
};

export function parseNetwork(raw: unknown): ParsedNetwork {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { kind: "invalid", id: "" };

  const normalised = normaliseLegacyNetwork(value);
  const m = CAIP2.exec(normalised);
  if (!m) return { kind: "invalid", id: value };

  const [, namespace, reference] = m;
  if (namespace === "eip155") {
    const chainId = Number.parseInt(reference, 10);
    return {
      kind: Number.isSafeInteger(chainId) && chainId > 0 ? "eip155" : "invalid",
      id: normalised,
      namespace,
      reference,
      chainId: Number.isSafeInteger(chainId) ? chainId : undefined,
    };
  }
  if (namespace === "lnbtc") {
    // The lnbtc reference is the first 32 hex characters of the Bitcoin
    // genesis hash (spec: Scheme and Networks).
    return {
      kind: /^[0-9a-f]{32}$/.test(reference) ? "lnbtc" : "invalid",
      id: normalised,
      namespace,
      reference,
    };
  }
  return { kind: "other", id: normalised, namespace, reference };
}

/** Map a legacy chain name to CAIP-2; return the input unchanged otherwise. */
export function normaliseLegacyNetwork(value: string): string {
  const key = value.trim().toLowerCase();
  return LEGACY_NAMES[key] ?? value.trim();
}

/** True when the value is (or normalises to) a well-formed CAIP-2 id. */
export function isCaip2(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return CAIP2.test(normaliseLegacyNetwork(value));
}
