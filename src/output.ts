/**
 * output.ts — format ValidationResult[] as human-readable text or JSON
 */

import type { ValidationResult } from "./index.ts";

const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";

export function formatText(results: ValidationResult[]): string {
  const lines: string[] = [];

  for (const r of results) {
    const icon = r.pass ? PASS : r.level === "warn" ? WARN : FAIL;
    lines.push(`${icon} ${r.label} — ${r.message}`);
    if (r.errors && r.errors.length > 0) {
      for (const err of r.errors) {
        lines.push(`   ${err}`);
      }
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass && r.level === "error").length;
  const warned = results.filter((r) => !r.pass && r.level === "warn").length;

  lines.push("");
  if (failed === 0 && warned === 0) {
    lines.push(`${passed}/${results.length} checks passed`);
  } else {
    const parts = [`${passed} passed`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (warned > 0) parts.push(`${warned} warnings`);
    lines.push(parts.join(", "));
  }

  return lines.join("\n");
}

export function formatJson(results: ValidationResult[]): string {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass && r.level === "error").length;
  const warned = results.filter((r) => !r.pass && r.level === "warn").length;

  const output = {
    summary: {
      passed,
      failed,
      warned,
      total: results.length,
      valid: failed === 0,
    },
    checks: results.map((r) => ({
      pass: r.pass,
      level: r.level,
      label: r.label,
      message: r.message,
      ...(r.errors ? { errors: r.errors } : {}),
    })),
  };

  return JSON.stringify(output, null, 2);
}
