/**
 * glob.ts — the path-pattern matcher used by `/mdf.json` pricing entries.
 *
 * Same semantics the spec states and the reference server implements:
 * `*` matches within a segment, `**` across segments, and the most specific
 * (longest) matching pattern wins.
 */

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u00a7DOUBLE\u00a7")
    .replace(/\*/g, "[^/]+")
    .replace(/\u00a7DOUBLE\u00a7/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesPath(pattern: string, path: string): boolean {
  try {
    return globToRegex(pattern).test(path);
  } catch {
    return false;
  }
}
