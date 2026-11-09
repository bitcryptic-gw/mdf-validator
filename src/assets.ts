/**
 * assets.ts — the per-network asset table, and the EIP-712 domain checks that
 * depend on it.
 *
 * The table is vendored from upstream `defaultAssets.ts` (see src/vendor/
 * SOURCES.md). The important property is that `name` and `version` are
 * per-network: USDC is "USD Coin" on Base mainnet and "USDC" on Base Sepolia.
 * EIP-3009 signs over the EIP-712 domain, so an offer carrying the wrong name
 * produces signatures the token contract rejects.
 */

import table from "./vendor/defaultAssets.json";

export interface ExpectedAsset {
  asset: string;
  name: string;
  version: string;
  decimals?: number;
  symbol?: string;
}

interface AssetTable {
  _source: string;
  _source_sha256: string;
  networks: Record<string, ExpectedAsset[]>;
}

const TABLE = table as unknown as AssetTable;

export const ASSET_TABLE_SOURCE = {
  source: TABLE._source,
  sha256: TABLE._source_sha256,
};

/** Every asset the vendored table lists for a network (usually one). */
export function assetsFor(network: string): ExpectedAsset[] {
  return TABLE.networks[network] ?? [];
}

export function isKnownNetwork(network: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE.networks, network);
}

/**
 * The default (index 0) USD-pegged asset for a network, which is what a rail
 * priced in USDC should name, or null when the network is not in the table.
 */
export function expectedAsset(network: string): ExpectedAsset | null {
  return assetsFor(network)[0] ?? null;
}

/** Byte-for-byte asset match, case-insensitive for 0x addresses. */
export function assetMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  return expected.toLowerCase() === actual.toLowerCase();
}

/**
 * Render an atomic integer amount in the asset's display units, using exact
 * decimal shifting (no floating point). Returns null when the amount or the
 * decimals are unusable.
 */
export function humanAmount(atomic: unknown, decimals: number | undefined): string | null {
  if (typeof atomic !== "string" || !/^[0-9]+$/.test(atomic)) return null;
  const d = decimals ?? 0;
  if (d === 0) return atomic;
  const padded = atomic.padStart(d + 1, "0");
  const whole = padded.slice(0, padded.length - d);
  const frac = padded.slice(padded.length - d).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
