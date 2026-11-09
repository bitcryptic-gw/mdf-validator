/**
 * mdf-signal.ts — is this site claiming to be an MDF site?
 *
 * A missing `/mdf.json` means different things for different targets. A clean
 * third-party x402 publisher simply has none, and failing it for that is the
 * B1 bug in another form. A site that carries `X-MDF-Version`, links
 * `/mdf.json` from its `llms.txt`, or sends `extensions.mdf` in a 402 is
 * telling us it is an MDF site, and then a missing capability document is a
 * real defect.
 *
 * Severity only: no check is gated on this, and every other result is
 * produced either way.
 */

import type { ValidationResult } from "./result.ts";

export type MdfSignalKind = "x-mdf-version" | "llms-txt" | "402-extension";

export interface MdfSignal {
  kind: MdfSignalKind;
  /** Short human description used in the failure message. */
  label: string;
  /** Where the signal was observed. */
  where: string;
}

/** `X-MDF-Version` on any response the validator saw. */
export function headerSignal(headers: { get(name: string): string | null }, where: string): MdfSignal | null {
  const value = headers.get("x-mdf-version");
  if (value === null) return null;
  return {
    kind: "x-mdf-version",
    label: `X-MDF-Version: ${value}`,
    where,
  };
}

/** `/llms.txt` pointing at a capability document. */
export function llmsSignal(llmsText: string | null, where: string): MdfSignal | null {
  if (!llmsText) return null;
  if (!/mdf\.json/i.test(llmsText)) return null;
  return {
    kind: "llms-txt",
    label: "/llms.txt references mdf.json",
    where,
  };
}

/** A 402 carrying MDF's extension entry. */
export function extensionSignal(body: unknown, where: string): MdfSignal | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const extensions = (body as Record<string, unknown>).extensions;
  if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) return null;
  if (!("mdf" in (extensions as Record<string, unknown>))) return null;
  return {
    kind: "402-extension",
    label: "the 402 carries extensions.mdf",
    where,
  };
}

/**
 * Apply the severity rule to a `/mdf.json` result.
 *
 * Only results flagged `unavailable` (missing, non-200, unparseable, or not an
 * object) are affected. A document that parsed but failed its schema stays an
 * error regardless: the site claimed MDF and the claim did not hold.
 */
export function applyMdfSignals<T extends ValidationResult & { unavailable?: string }>(
  result: T,
  signals: MdfSignal[]
): T {
  if (!result.unavailable || signals.length === 0) return result;
  const [first, ...rest] = signals;
  const also = rest.length > 0 ? ` (also: ${rest.map((s) => s.label).join("; ")})` : "";
  return {
    ...result,
    pass: false,
    level: "error",
    message: `site declares MDF via ${first.label} at ${first.where} but ${result.unavailable}${also}`,
  };
}

/** De-duplicate signals by kind, keeping the first observed. */
export function dedupeSignals(signals: MdfSignal[]): MdfSignal[] {
  const seen = new Set<MdfSignalKind>();
  const out: MdfSignal[] = [];
  for (const s of signals) {
    if (seen.has(s.kind)) continue;
    seen.add(s.kind);
    out.push(s);
  }
  return out;
}
