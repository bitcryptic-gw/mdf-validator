# mdf-validator

CLI tool to validate MDF (Markdown First) site compliance.

Fetches `/mdf.json` from a site, validates it against the MDF schema, checks `/llms.txt` reachability, and optionally verifies that content URLs respond with correct MDF headers.

**Spec:** https://github.com/bitcryptic-gw/mdf (0.3.0 / x402 v2)  
**Status:** v0.2.0 — spec 0.3.0: per-rail x402 v2 checks, `PAYMENT-REQUIRED`, v1 tolerance

---

## Install

### Build a standalone binary

```bash
git clone https://github.com/bitcryptic-gw/mdf-validator.git
cd mdf-validator
bun install
bun run build          # current platform
bun run build:linux    # linux x64
bun run build:mac      # macOS arm64
```

The compiled binary has no runtime dependencies — dependencies (including the
Ajv JSON Schema validator) are bundled in at compile time, so the binary can be
copied anywhere. Building from source requires `bun install` first; the
committed `bun.lock` pins the dependency set.

To run from source instead:

```bash
bun run src/index.ts -- https://your-site.com
```

---

## Usage

```bash
# Validate /mdf.json schema
mdf-validate https://mdf-demo.bitcryptic.com

# Check /llms.txt, free-content headers, and every discoverable 402
mdf-validate --check-headers https://mdf-demo.bitcryptic.com

# Probe a specific priced URL (repeatable; implies --check-headers)
mdf-validate --priced-url https://example.com/premium https://example.com

# Check a captured paid 200 (no payment is made by the validator)
mdf-validate --paid-response capture.json https://example.com

# Be polite when probing someone else's site
mdf-validate --check-headers --delay 2000 https://prooflines.org

# Machine-readable JSON output
mdf-validate --json https://mdf-demo.bitcryptic.com

# Custom timeout (ms)
mdf-validate --timeout 5000 https://mdf-demo.bitcryptic.com
```

---

## Output

**Passing site:**
```
✅ https://mdf-demo.bitcryptic.com/mdf.json — valid (MDF v1.0)
✅ https://mdf-demo.bitcryptic.com/llms.txt — reachable
✅ https://mdf-demo.bitcryptic.com/ Content-Type — text/markdown ✓
✅ https://mdf-demo.bitcryptic.com/ x-mdf-version — 1
✅ https://mdf-demo.bitcryptic.com/ x-mdf-price — (not present — optional for free content)

5/5 checks passed
```

**Failing site:**
```
❌ https://example.com/mdf.json — schema validation failed
   /pricing/default: must have required property 'amount'
   /pricing/sections/~1premium~1**/amount: must match pattern "^\\d+(\\.\\d+)?$"
⚠️  https://example.com/llms.txt — not reachable (404)

0 passed, 1 failed, 1 warnings
```

**JSON output:**
```json
{
  "summary": {
    "passed": 5,
    "failed": 0,
    "warned": 0,
    "total": 5,
    "valid": true
  },
  "checks": [...]
}
```

Exit code is `0` if all checks pass or warn, `1` if any check fails at error
level. A missing `/mdf.json`, a non-standard rail, an unverifiable network and
a CORS expose-list omission are warnings.

---

## How the 402 checks pick their URLs

Probe URLs are never fabricated from a pricing glob — a free `/docs/**` tier
does not imply `/docs` exists. Four sources are used, in priority order, and
de-duplicated by path:

1. `--priced-url <url>`, repeated (the operator asserting "this is priced").
2. `/.well-known/x402` — the site's own index of paid resources. This is what
   a non-MDF x402 publisher actually serves, and it is why the 402 checks work
   on a site with no `/mdf.json`.
3. `/mdf.json` pricing — sections whose `rails` are non-empty, matched against
   real `/llms.txt` URLs.
4. `/llms.txt` — entries whose trailing note says 402/x402/paid.

At most 10 URLs are probed per run (`--max-probes` is not exposed; the cap is a
constant). `--delay <ms>` spaces the probes; use 2000 on third-party sites.

The `/mdf.json` check is **not** a gate. A 404 there is a warning ("not an MDF
site") and the x402 checks still run; a 200 that is not JSON says so
explicitly, including the "served as text/html" case that means an SPA
fallback answered the request.

---

## What it checks

| Check | Where |
|-------|-------|
| `/mdf.json` present, JSON, valid against the schema for the version it declares | always |
| `/llms.txt` reachable | `--check-headers` |
| Free content URL returns `text/markdown`, `X-MDF-Version` present | `--check-headers` |
| 402 body is a valid x402 v2 `PaymentRequired` (closed root, open `accepts[]`, open `extensions`) | `--check-headers` / `--priced-url` |
| `PAYMENT-REQUIRED` decodes, validates, and agrees with the body field for field | same |
| Each rail: known scheme+network fully checked; unknown scheme/network warns per rail and never fails the offer | same |
| CAIP-2 networks parsed; legacy names (`base`, `base-sepolia`) normalised for comparison | same |
| Asset and **EIP-712 domain** (`extra.name`/`extra.version`) per network — mainnet USDC is `"USD Coin"`, Sepolia `"USDC"` | same |
| `accepts[]` matches `/mdf.json` rails one-to-one (missing rail warns, extra/mismatched fails) | same, MDF 0.3 sites |
| `access: "token"` requires `auth.endpoint`; price summary agrees with `accepts[]`; 402 is `no-store`; `X-MDF-Version` present | same, MDF 0.3 sites |
| x402 v1 / MDF 0.2 shape: normalised and reported as legacy (failure only if the site declares MDF 0.3.x) | same |
| `PAYMENT-RESPONSE` present and conformant on a captured paid 200 | `--paid-response` |

Warnings never fail a run.

## What it checks

| Check | Always | --check-headers |
|-------|--------|-----------------|
| `/mdf.json` fetchable | ✅ | ✅ |
| `/mdf.json` valid JSON | ✅ | ✅ |
| Schema validation (required fields, types, patterns) | ✅ | ✅ |
| `/llms.txt` reachable | ✅ | ✅ |
| Free content URL returns `text/markdown` | — | ✅ |
| `X-MDF-Version` header present | — | ✅ |

---

## Vendored upstream

Schemas and the per-network asset table are vendored, never fetched at runtime.
Every file, its source commit and its sha256: `src/vendor/SOURCES.md`.

---

## Authors

**Gary Walker** / [BitCryptic™](https://bitcryptic.com)  
**Graham Hall** / [Slepner](https://slepner.com.au)

---

## License

MIT
