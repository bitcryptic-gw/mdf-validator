# Schema validation fixtures — old-engine baseline

Recorded 2026-09-05 against the hand-rolled engine (`src/validator.ts`),
before the Ajv replacement. Each mdf fixture was served as `/mdf.json` and
validated via the CLI (`bun run src/index.ts --json <url>`).

| fixture | old-engine verdict | exit | genuinely valid? |
|---|---|---|---|
| `demo.json` | VALID | 0 | yes |
| `missing-amount.json` | VALID | 0 | **no** — `pricing.default` lacks required `amount`; section amount `"abc"` |
| `format-uri.json` | VALID | 0 | **no** — `site` is not a URI |
| `minitems.json` | VALID | 0 | **no** — `payment.accepted_chains` is empty (minItems 1) |
| `uniqueitems.json` | VALID | 0 | **no** — `payment.accepted_chains` duplicates `"base"` |
| `propertynames-valid.json` | VALID | 0 | yes (see note) |
| `minimum.json` | VALID | 0 | **no** — `auth.token_ttl_seconds` is 30 (< 60) |
| `dialects-rss2.json` | VALID | 0 | yes (`dialect: pandoc`, `feed.format: rss2`) |
| `dialect-other.json` | VALID | 0 | yes (`dialect: other`) |

402 bodies: **not validated at all** by the old engine — no path exists.

Note on `propertynames`: `mdf.schema.json` constrains
`pricing.sections` keys with `propertyNames: { type: "string" }`, which no
JSON document can violate (object keys are always strings). The fixture
exercises the path as a valid case; there is no constructible violating
fixture for this keyword.

The six `**no**` rows are the silent-gap set: documents the old engine passed
that a conformant validator must reject. `pricing` is what an agent reads to
decide whether to spend money.
