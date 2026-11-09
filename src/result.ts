/**
 * result.ts — the shape every check returns, and small constructors.
 *
 * Kept in its own module (rather than in index.ts) so pure evaluation code can
 * import it without pulling in the CLI entry point.
 */

export interface ValidationResult {
  pass: boolean;
  level: "info" | "warn" | "error";
  label: string;
  message: string;
  errors?: string[];
  data?: Record<string, unknown>;
}

export function pass(label: string, message: string): ValidationResult {
  return { pass: true, level: "info", label, message };
}

export function warn(label: string, message: string, errors?: string[]): ValidationResult {
  return { pass: false, level: "warn", label, message, ...(errors ? { errors } : {}) };
}

export function fail(label: string, message: string, errors?: string[]): ValidationResult {
  return { pass: false, level: "error", label, message, ...(errors ? { errors } : {}) };
}

export function info(label: string, message: string): ValidationResult {
  return { pass: true, level: "info", label, message };
}
