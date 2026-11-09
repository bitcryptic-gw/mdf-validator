/**
 * integration.test.ts — one end-to-end run against a local HTTP server.
 *
 * This is the regression test for finding B1: the /mdf.json result must not
 * gate the x402 checks. The server deliberately returns 404 for /mdf.json and
 * a valid x402 v2 offer elsewhere, which is the shape of a third-party x402
 * publisher (and the shape of the ProofLines run).
 */

import { test, expect, afterAll } from "bun:test";
import { checkHeaders } from "./headers.ts";
import { validateMdfJson } from "./validator.ts";

const body = {
  x402Version: 2,
  resource: { url: "http://PLACEHOLDER/paid" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x3333333333333333333333333333333333333333",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const base = `http://127.0.0.1:${server.port}`;
    const encoded = Buffer.from(JSON.stringify(body)).toString("base64");

    if (url.pathname === "/mdf.json") {
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/llms.txt") {
      return new Response(`# Index\n\n- [Paid](${base}/paid) ; HTTP 402\n`, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/.well-known/x402") {
      return Response.json({ x402Version: 2, resources: [{ resource: `${base}/paid` }] });
    }
    if (url.pathname === "/paid") {
      return new Response(JSON.stringify(body), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "payment-required": encoded,
        },
      });
    }
    return new Response("nope", { status: 404 });
  },
});

afterAll(() => server.stop(true));

test("a site with no /mdf.json is a warning, and the 402 checks still run", async () => {
  const base = `http://127.0.0.1:${server.port}`;

  const mdf = await validateMdfJson(base, 5000);
  expect(mdf.level).toBe("warn");
  expect(mdf.message).toContain("not an MDF site");

  const results = await checkHeaders(base, null, 5000, { maxProbes: 5 });
  const text = results.map((r) => `${r.label} — ${r.message}`).join("\n");

  // The 402 was found through discovery and evaluated per rail.
  expect(text).toContain("/paid (402");
  expect(text).toContain("eip155:84532");
  // No errors at all: the site is conformant x402 v2, if not an MDF site.
  expect(results.filter((r) => !r.pass && r.level === "error")).toEqual([]);
});

test("--priced-url works without any discovery source", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const results = await checkHeaders(base, null, 5000, {
    pricedUrls: [`${base}/paid`],
    maxProbes: 1,
  });
  expect(results.some((r) => r.label.includes("(402 discovery)") && r.message.includes("--priced-url"))).toBe(true);
  expect(results.some((r) => r.label.startsWith(`${base}/paid`))).toBe(true);
});
