# mdf-validator

CLI tool to validate MDF (Markdown First) site compliance.

Fetches `/mdf.json` from a site, validates it against the MDF schema, checks `/llms.txt` reachability, and optionally verifies that content URLs respond with correct MDF headers.

**Spec:** https://github.com/bitcryptic-gw/mdf  
**Status:** v0.1.0 — schema validation + header checks

---

## Install

### Run directly with Bun

```bash
bun run https://raw.githubusercontent.com/bitcryptic-gw/mdf-validator/main/src/index.ts -- https://your-site.com
```

### Build a standalone binary

```bash
git clone https://github.com/bitcryptic-gw/mdf-validator.git
cd mdf-validator
bun install
bun run build          # current platform
bun run build:linux    # linux x64
bun run build:mac      # macOS arm64
```

The compiled binary has no runtime dependencies — copy it anywhere.

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
✅ https://mdf-demo.bitcryptic.com/ x-mdf-tokens — 847

5/5 checks passed
```

**Failing site:**
```
❌ https://example.com/mdf.json — schema validation failed
   pricing.default.currency: required field missing
   payment.endpoint: additional property not allowed
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

## What it checks

| Check | Always | --check-headers |
|-------|--------|-----------------|
| `/mdf.json` fetchable | ✅ | ✅ |
| `/mdf.json` valid JSON | ✅ | ✅ |
| Schema validation (required fields, types, patterns) | ✅ | ✅ |
| `/llms.txt` reachable | ✅ | ✅ |
| Free content URL returns `text/markdown` | — | ✅ |
| `X-MDF-Version` header present | — | ✅ |
| `X-MDF-Tokens` header present | — | ✅ |

---

## Authors

**Gary Walker** / [BitCryptic™](https://bitcryptic.com)  
**Graham Hall** / [Slepner](https://slepner.com.au)

---

## License

MIT
