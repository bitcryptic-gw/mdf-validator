/**
 * payment-required.ts — the PAYMENT-REQUIRED header, and body/header agreement.
 *
 * x402 v2 makes the header the canonical transport location for the
 * PaymentRequired object, and MDF 0.3.x additionally requires the body to be
 * the same object. A consumer that reads either must reach the same offer, so
 * a mismatch is a failure in its own right rather than a warning about one of
 * the two.
 */

/** Cap before decoding: a header this large is a defect, not an offer. */
export const MAX_HEADER_CHARS = 64 * 1024;

export type HeaderDecode =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * Decode a base64 PAYMENT-REQUIRED value to a parsed JSON object.
 *
 * Accepts standard and URL-safe alphabets, padded or unpadded (the ProofLines
 * captures include both, differing only by payload length), and tolerates
 * folded whitespace. Malformed input is reported as a distinct reason so the
 * caller can say which part failed.
 */
export function decodePaymentRequiredHeader(raw: string | null | undefined): HeaderDecode {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { ok: false, reason: "header is absent" };
  }
  if (raw.length > MAX_HEADER_CHARS) {
    return {
      ok: false,
      reason: `header is ${raw.length} characters, over the ${MAX_HEADER_CHARS} limit`,
    };
  }

  const cleaned = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    return { ok: false, reason: "header is not valid base64" };
  }
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);

  let text: string;
  try {
    text = Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "base64 decode failed" };
  }
  if (text.trim() === "") {
    return { ok: false, reason: "header decodes to empty content" };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "header decodes, but the content is not JSON" };
  }
}

/** Encode an object the way a server would (used by tests and fixtures). */
export function encodePaymentRequiredHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/**
 * The first path at which two JSON values differ, as a JSON-pointer-ish
 * string, or null when they are equal. Key order is irrelevant.
 */
export function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (a === b) return null;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return `${path || "(root)"}: body and header differ in type`;

  if (aArr && bArr) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (i >= a.length) return `${path}/${i}: present in header only`;
      if (i >= b.length) return `${path}/${i}: present in body only`;
      const d = firstDifference(a[i], b[i], `${path}/${i}`);
      if (d) return d;
    }
    return null;
  }

  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const key of keys) {
      if (!(key in ao)) return `${path}/${key}: present in header only`;
      if (!(key in bo)) return `${path}/${key}: present in body only`;
      const d = firstDifference(ao[key], bo[key], `${path}/${key}`);
      if (d) return d;
    }
    return null;
  }

  return `${path || "(root)"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
