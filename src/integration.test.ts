/**
 * integration.test.ts — end-to-end runs against a local HTTP server.
 *
 * Two things are pinned here:
 *   - finding B1: the /mdf.json result never gates the x402 checks;
 *   - the severity rule: a missing /mdf.json is a warning for a site with no
 *     other MDF signal, and an error for a site that signals MDF elsewhere
 *     (X-MDF-Version, /llms.txt referencing mdf.json, extensions.mdf in a 402).
 *
 * The CLI is spawned as a subprocess so exit codes are real.
 */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHeaders } from "./headers.ts";
import { validateMdfJson } from "./validator.ts";
import { applyMdfSignals, dedupeSignals } from "./mdf-signal.ts";
import type { MdfSignal } from "./mdf-signal.ts";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

interface Config {
  /** /mdf.json response. */
  mdf: "missing" | "html" | "valid";
  /** Does /llms.txt mention mdf.json? */
  llmsSignalsMdf?: boolean;
  /** Send X-MDF-Version on content responses (as an MDF site would)? */
  withVersion?: boolean;
  /** Add extensions.mdf to the 402? */
  extensionMdf?: boolean;
}

const USDC = { "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };

function rail(base: string) {
  return {
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    asset: USDC["eip155:84532"],
    payTo: "0x3333333333333333333333333333333333333333",
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
}

function startServer(config: Config) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${server.port}`;

      const body: Record<string, unknown> = {
        x402Version: 2,
        resource: { url: `${base}/paid` },
        accepts: [rail(base)],
      };
      if (config.extensionMdf) {
        body.extensions = {
          mdf: {
            info: { version: "0.3.0", price_summary: "0.001 USDC on Base Sepolia" },
            schema: { type: "object" },
          },
        };
      }
      const encoded = Buffer.from(JSON.stringify(body)).toString("base64");

      if (url.pathname === "/mdf.json") {
        if (config.mdf === "missing") return new Response("not found", { status: 404 });
        if (config.mdf === "html") {
          return new Response("<!doctype html><html><body>app</body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return Response.json({
          mdf_version: "0.3.0",
          site: base,
          pricing: {
            default: { rails: [] },
            sections: {
              "/paid": {
                rails: [
                  {
                    scheme: "exact",
                    network: "eip155:84532",
                    asset: USDC["eip155:84532"],
                    amount: "1000",
                  },
                ],
              },
            },
          },
        });
      }
      if (url.pathname === "/llms.txt") {
        const lines = [`# Index`, ``, `- [Free](${base}/free)`, `- [Paid](${base}/paid) ; HTTP 402`];
        if (config.llmsSignalsMdf) lines.push(`- [Capabilities](${base}/mdf.json)`);
        return new Response(lines.join("\n"), { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/" || url.pathname === "/free") {
        return new Response("# Free\n", {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "cache-control": "no-cache",
            ...(config.withVersion ? { "x-mdf-version": "1" } : {}),
          },
        });
      }
      if (url.pathname === "/paid") {
        return new Response(JSON.stringify(body), {
          status: 402,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            ...(config.withVersion ? { "x-mdf-version": "1" } : {}),
            "payment-required": encoded,
          },
        });
      }
      return new Response("nope", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

/**
 * Spawn the CLI asynchronously: the test server runs in this process, so a
 * blocking spawn would deadlock the event loop that has to answer it.
 */
async function runCli(base: string, extra: string[] = []): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts", "--check-headers", ...extra, base],
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out: `${stdout}${stderr}` };
}

/** Spawn the CLI with exactly these arguments (no --check-headers unless given). */
async function runCliRaw(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts", ...args],
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out: `${stdout}${stderr}` };
}

// ---------------------------------------------------------------------------
// B1 / severity
// ---------------------------------------------------------------------------

test("no MDF signal + missing /mdf.json: warning, exit 0, x402 checks still run", async () => {
  const base = startServer({ mdf: "missing" });

  const mdf = await validateMdfJson(base, 5000);
  expect(mdf.level).toBe("warn");
  expect(mdf.unavailable).toContain("HTTP 404");

  const results = await checkHeaders(base, null, 5000, { maxProbes: 5 });
  const text = results.map((r) => `${r.label} — ${r.message}`).join("\n");
  expect(text).toContain("/paid (402");
  expect(text).toContain("eip155:84532");
  expect(results.filter((r) => !r.pass && r.level === "error")).toEqual([]);

  const cli = await runCli(base);
  expect(cli.code).toBe(0);
  expect(cli.out).toContain("not an MDF site");
});

test("X-MDF-Version elsewhere + missing /mdf.json: error, non-zero exit, signal named", async () => {
  const base = startServer({ mdf: "missing", withVersion: true });
  const cli = await runCli(base);
  expect(cli.code).not.toBe(0);
  expect(cli.out).toContain("site declares MDF via X-MDF-Version");
});

test("/llms.txt referencing mdf.json + missing /mdf.json: error, signal named", async () => {
  const base = startServer({ mdf: "missing", llmsSignalsMdf: true });
  const cli = await runCli(base);
  expect(cli.code).not.toBe(0);
  expect(cli.out).toContain("site declares MDF via /llms.txt references mdf.json");
});

test("a 402 with extensions.mdf + missing /mdf.json: error, signal named", async () => {
  const base = startServer({ mdf: "missing", extensionMdf: true });
  const cli = await runCli(base);
  expect(cli.code).not.toBe(0);
  expect(cli.out).toContain("site declares MDF via the 402 carries extensions.mdf");
});

test("signal + present and valid /mdf.json: passes, exit 0", async () => {
  const base = startServer({ mdf: "valid", withVersion: true, extensionMdf: true });
  const cli = await runCli(base);
  expect(cli.code).toBe(0);
  expect(cli.out).toContain("valid (MDF v0.3.0)");
});

test("signal + /mdf.json served as HTML: error, reported as not JSON", async () => {
  const base = startServer({ mdf: "html", withVersion: true });
  const cli = await runCli(base);
  expect(cli.code).not.toBe(0);
  expect(cli.out).toContain("not JSON");
  expect(cli.out).toContain("text/html");
  expect(cli.out).toContain("site declares MDF via X-MDF-Version");
});

// ---------------------------------------------------------------------------
// --mdf-json: a local declaration in place of the fetch
// ---------------------------------------------------------------------------

function localMdf(doc: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "mdf-json-"));
  const file = join(dir, "mdf.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

test("--mdf-json validates a local document and never fetches /mdf.json", async () => {
  const base = startServer({ mdf: "missing" });
  const file = localMdf({
    mdf_version: "0.3.1",
    site: base,
    pricing: { default: { rails: [] } },
  });
  const cli = await runCliRaw(["--mdf-json", file, base]);
  expect(cli.code).toBe(0);
  expect(cli.out).toContain("valid (MDF v0.3.1)");
  expect(cli.out).toContain("local document, /mdf.json not fetched");
  // The site's own /mdf.json is 404; the local document must not be reported as
  // missing, and the fetch must not have happened.
  expect(cli.out).not.toContain("no MDF capability document");
});

test("--mdf-json rejects a local document that fails its own schema", async () => {
  const base = startServer({ mdf: "missing" });
  const file = localMdf({ mdf_version: "0.3.1", site: base, pricing: {} });
  const cli = await runCliRaw(["--mdf-json", file, base]);
  expect(cli.code).not.toBe(0);
  expect(cli.out).toContain("schema validation failed");
  expect(cli.out).toContain("must have required property 'default'");
});

test("--mdf-json feeds the live accept[] agreement check", async () => {
  // The server offers one exact/eip155:84532 rail on /paid; the local document
  // declares a different rail there, so the offer is undeclared.
  const base = startServer({ mdf: "missing" });
  const file = localMdf({
    mdf_version: "0.3.1",
    site: base,
    pricing: {
      default: { rails: [] },
      sections: {
        "/paid": {
          rails: [
            {
              scheme: "exact",
              network: "lnbtc:000000000019d6689c085ae165831e93",
              asset: "BTC",
              amount: "1000",
            },
          ],
        },
      },
    },
  });
  const cli = await runCli(base, ["--mdf-json", file]);
  expect(cli.code).not.toBe(0);
  expect(cli.out).toContain("offered in accepts[] but not declared");
});

// ---------------------------------------------------------------------------
// Severity helper (pure)
// ---------------------------------------------------------------------------

const base404 = {
  pass: false,
  level: "warn" as const,
  label: "https://x/mdf.json",
  message: "HTTP 404",
  unavailable: "/mdf.json is missing (HTTP 404)",
};
const signal: MdfSignal = { kind: "x-mdf-version", label: "X-MDF-Version: 1", where: "https://x/free" };

test("applyMdfSignals leaves an unavailable result as a warning with no signal", () => {
  expect(applyMdfSignals(base404, []).level).toBe("warn");
});

test("applyMdfSignals names the signal and the reason", () => {
  const r = applyMdfSignals(base404, [signal]);
  expect(r.level).toBe("error");
  expect(r.message).toContain("site declares MDF via X-MDF-Version: 1 at https://x/free");
  expect(r.message).toContain("/mdf.json is missing (HTTP 404)");
});

test("applyMdfSignals does not touch a document that parsed", () => {
  const parsed = { pass: true, level: "info" as const, label: "x", message: "valid" };
  expect(applyMdfSignals(parsed, [signal])).toEqual(parsed);
});

test("dedupeSignals keeps one per kind", () => {
  const two = dedupeSignals([signal, { ...signal, where: "elsewhere" }]);
  expect(two.length).toBe(1);
  expect(two[0].where).toBe("https://x/free");
});
