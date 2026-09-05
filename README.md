# mdf-validator

CLI tool to validate MDF (Markdown First) site compliance.

Fetches `/mdf.json` from a site, validates it against the MDF schema, checks `/llms.txt` reachability, and optionally verifies that content URLs respond with correct MDF headers.

**Spec:** https://github.com/bitcryptic-gw/mdf  
**Status:** v0.1.0 — schema validation + header checks

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

# Also check MDF response headers on a content URL
mdf-validate --check-headers https://mdf-demo.bitcryptic.com

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

Exit code is `0` if all checks pass or warn, `1` if any check fails.

---

## How `--check-headers` picks its URLs

The header and 402 checks never fabricate a URL from a pricing glob — a free
`/docs/**` tier does not imply `/docs` exists. Probe URLs are resolved from
the target's `/llms.txt`, restricted to the target's own origin; when
`/llms.txt` is absent or lists nothing usable, the site root is the fallback.

- **Free URL** (for the header checks): the first listed URL whose price is
  zero, else the site root when the root is free.
- **Priced URL** (for the 402 check): the first listed URL with a non-zero
  price. A 402 is returned pre-payment, so probing it costs nothing. If no
  priced URL is listed, the check reports a distinct "skipped" message rather
  than a pass.

Only same-origin URLs are probed; external URLs that happen to appear in
`/llms.txt` are ignored. This follows the spec's Validator Guidance
(CONCEPT.md).

---

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

## Authors

**Gary Walker** / [BitCryptic™](https://bitcryptic.com)  
**Graham Hall** / [Slepner](https://slepner.com.au)

---

## License

MIT
