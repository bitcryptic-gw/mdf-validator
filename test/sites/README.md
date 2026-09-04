# Non-reference fixture servers

Three deliberately non-reference MDF fixture sites for stressing the
validator's `--check-headers` heuristics. They are the first targets the
validator has seen that were not built by the reference-implementation
authors.

Serve one with:

```bash
bun run test/sites/sites.ts <site> <port>
# e.g.
bun run test/sites/sites.ts glob-no-root 3991
```

Then validate:

```bash
bun run src/index.ts --check-headers http://127.0.0.1:<port>
```

## Sites

| site | shape | purpose |
|---|---|---|
| `glob-no-root` | free tier declared as `/docs/**` with **no page at `/docs`**; default priced | the false-failure case the glob-fabrication heuristic produced |
| `no-llms` | no `/llms.txt` at all; root free | exercises the root fallback when no URL list exists |
| `paid-on-200` | free docs page + priced `/premium/deep-dive` that returns **200, not 402** | confirms the 402 check catches a missing payment gate |

## Pre-fix evidence (recorded 2026-09-05, before `ecfd722`)

The old glob-fabrication heuristic (and the pre-402 validator) failed one of
these — evidence the heuristic was broken, not merely inelegant:

- `glob-no-root` — **FAILED** (2 checks): it fabricated `/docs` from the
  `/docs/**` glob, hit the 404 page, and reported
  `Content-Type — expected text/markdown, got text/html` and
  `x-mdf-version — missing` on a conformant site.
- `no-llms` — passed free-tier checks via the root fallback that already
  existed; only the llms reachability warning appeared.
- `paid-on-200` — pre-402 validator **passed it** (the fabricated `/docs`
  probe masked the missing payment gate); the new 402 check fails it with
  `served paid content with HTTP 200 and no 402`.

Note: `x-mdf-version` is asserted as present on free content responses. This
is an ambiguous requirement — the spec mentions it only in an example
(CONCEPT.md) — so fixture md responses carry it, as the reference server does.
