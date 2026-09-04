/**
 * sites.ts — minimal non-reference MDF fixture servers for the validator.
 *
 * Each site is a route table (path -> body/status/content-type), not a real
 * MDF server. They are shaped deliberately unlike the reference
 * implementation to stress the validator's heuristics:
 *
 *   glob-no-root   free tier declared as /docs/** with NO page at /docs —
 *                  the case glob-fabricated URLs used to fail falsely.
 *   no-llms        no /llms.txt at all — exercises the root fallback.
 *   paid-on-200    serves paid content with a 200 instead of a 402.
 *
 * Run: bun run test/sites/sites.ts <site> <port>
 */

type Route = { status: number; contentType: string; body: string; headers?: Record<string, string> };
type Site = Record<string, Route>;

const json = (o: unknown): Route => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(o),
});
// Markdown content carries X-MDF-Version like the reference implementation.
const md = (body: string): Route => ({
  status: 200,
  contentType: "text/markdown; charset=utf-8",
  body,
  headers: { "X-MDF-Version": "1" },
});
const txt = (body: string): Route => ({
  status: 200,
  contentType: "text/plain; charset=utf-8",
  body,
});
const missing = (): Route => ({
  status: 404,
  contentType: "text/html; charset=utf-8",
  body: "404",
});

const SITES: Record<string, Site> = {
  // Free tier is a glob whose root (/docs) does not exist; only
  // /docs/getting-started is a real page. Default is priced.
  "glob-no-root": {
    "/mdf.json": json({
      mdf_version: "1.0",
      site: "http://127.0.0.1:<PORT>",
      pricing: {
        default: { amount: "0.0001", currency: "USDC", chain: "base" },
        sections: { "/docs/**": { amount: "0.0000", currency: null, chain: null } },
      },
    }),
    "/llms.txt": txt(
      "# Glob Root Fixture\n\n- [Getting Started](/docs/getting-started)\n"
    ),
    "/docs/getting-started": md("# Getting Started\n"),
    "/docs/getting-started.md": md("# Getting Started\n"),
  },

  // No /llms.txt at all; root is free. Exercises the root fallback.
  "no-llms": {
    "/mdf.json": json({
      mdf_version: "1.0",
      site: "http://127.0.0.1:<PORT>",
      pricing: {
        default: { amount: "0.0000", currency: null, chain: null },
        sections: { "/": { amount: "0.0000", currency: null, chain: null } },
      },
    }),
    "/": md("# Index\n"),
    "/index.md": md("# Index\n"),
  },

  // Paid content is served with a 200 and no 402. A free docs page exists so
  // the free-tier header checks can run; the 402 check must catch the 200.
  "paid-on-200": {
    "/mdf.json": json({
      mdf_version: "1.0",
      site: "http://127.0.0.1:<PORT>",
      pricing: {
        default: { amount: "0.0001", currency: "USDC", chain: "base" },
        sections: {
          "/docs/**": { amount: "0.0000", currency: null, chain: null },
          "/premium/**": { amount: "1.0000", currency: "USDC", chain: "base" },
        },
      },
    }),
    "/llms.txt": txt(
      "# Paid-on-200 Fixture\n\n- [Docs](/docs/getting-started)\n- [Premium](/premium/deep-dive)\n"
    ),
    "/docs/getting-started": md("# Getting Started\n"),
    "/docs/getting-started.md": md("# Getting Started\n"),
    "/premium/deep-dive": md("# Paid Content Served Anyway\n"),
    "/premium/deep-dive.md": md("# Paid Content Served Anyway\n"),
  },
};

const [siteName, portArg] = process.argv.slice(2);
const port = parseInt(portArg ?? "3990", 10);
const site = SITES[siteName];
if (!site) {
  console.error(`Unknown site: ${siteName}. Known: ${Object.keys(SITES).join(", ")}`);
  process.exit(1);
}

// Substitute the real origin into fixture bodies so /mdf.json's site field
// matches the URL the validator is pointed at.
const routes: Site = {};
for (const [path, route] of Object.entries(site)) {
  routes[path] = { ...route, body: route.body.replaceAll("<PORT>", String(port)) };
}

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    const route = routes[url.pathname] ?? missing();
    return new Response(route.body, {
      status: route.status,
      headers: { "Content-Type": route.contentType, ...(route.headers ?? {}) },
    });
  },
});

console.log(`[sites] ${siteName} serving on :${port}`);
