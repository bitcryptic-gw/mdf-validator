# Changelog

## [Unreleased]

Spec 0.3.1 support (Vikunja #69). 0.3.1 only loosens the schema — a
non-`exact` scheme defines its own asset identifier — so nothing here changes
what a 0.3.0 document has to look like; what changes is that a rail the
declaration omits is now spotted.

### Changed

- **The one-to-one check compares presence across every rail, not only the
  ones we can evaluate** (`checkMdfSemantics` in `src/evaluate.ts`). Before,
  the comparison set was `rails.filter(classifyRail(...).kind === "evaluated")`,
  so a non-`exact` rail was invisible on both sides: a faithful declaration got
  a false "declared but not offered" warning, and a declaration that omitted a
  rail the 402 offered passed. Now an offered rail that is not declared is a
  **failure** (`offered in accepts[] but not declared in mdf.json`), a declared
  rail that is not offered stays a **warning** (`may be degraded`), and a
  declared rail that is offered with a different `asset` or `amount` is a
  failure. Per-rail semantic checks still run only for `evaluated` rails, and
  an unknown scheme still gets its per-rail "non-standard, not evaluated"
  warning — a rail we cannot evaluate never fails the offer.
- **Network normalisation for that comparison** (`normaliseRailNetwork` in
  `src/network.ts`): a CAIP-2 id is used as written; an alias carrying a numeric
  `chainId` on the entry becomes `eip155:<chainId>` (how ProofLines names
  Monad: `monad-testnet` + `chainId: 10143`); otherwise the legacy alias table
  applies; otherwise the value is compared literally.
- **`asset` is compared exactly except for 0x addresses**, where EIP-55 casing
  is a checksum rather than part of the identity. A non-`exact` scheme's opaque
  identifier is whatever its own spec says it is.

### Added

- **`--mdf-json <path>`** — validate a local `/mdf.json` against a live site in
  place of fetching one. Its schema result is reported the same way, and the
  document drives the `accepts[]` agreement and token-access checks, so a
  drafted capability document can be tested before it is published.
- Fixtures for the ProofLines two-rail shape (`mdf-prooflines-two-rail.json`,
  `mdf-prooflines-usdc-only.json`) and the 0.3.1 spec example
  (`mdf-spec-native-asset-rail.json`), with tests for the pass, the
  undeclared-rail failure, the declared-but-absent warning, an asset mismatch
  and an amount mismatch.

### Vendored

- `src/schemas/mdf.schema.json` and `src/schemas/mdf-402.schema.json`
  re-vendored from `bitcryptic-gw/mdf` `f8e0b36` (spec 0.3.1); new sha256s are
  recorded in `src/vendor/SOURCES.md`.

## [0.2.0] — 2026-11-09

Spec 0.3.0 / x402 v2 support (Vikunja #58–#60). Validates what an x402 v2
publisher actually serves, not only what an MDF site declares.

### Added

- **Per-rail evaluation of x402 v2 offers.** Each `accepts[]` entry is checked
  on its own. A known scheme on a known network is fully checked; a
  non-standard scheme or an unverifiable network produces a **per-rail
  warning** (`non-standard scheme … not evaluated`) and never fails the other
  rails or the offer. Fixes the bucket-C behaviour from the 2026-11-08
  ProofLines run, where the whole offer failed before any rail was examined.
- **`PAYMENT-REQUIRED` support.** The header is decoded (size-limited before
  decoding, base64 tolerant of padding and the URL-safe alphabet), validated
  through the same path as the body, and compared field for field. A mismatch
  names the first differing pointer. Malformed input is its own failure.
- **402 URL discovery from four sources**, in priority order: `--priced-url`,
  `/.well-known/x402`, `mdf.json` priced rails matched against real
  `llms.txt` URLs, and `llms.txt` entries with a 402/x402/paid note.
- **`--priced-url <url>`** (repeatable) and **`--paid-response <file>`** (a
  captured paid 200; the validator never makes a payment).
- **`--delay <ms>`**, to space probes on third-party sites.
- **CAIP-2 parsing and legacy network normalisation** (`base`,
  `base-sepolia`, `base_sepolia`, `lightning`, …).
- **Asset and EIP-712 domain checks per network.** `extra.name`/`extra.version`
  are compared against the vendored upstream asset table: mainnet USDC is
  `"USD Coin"`, Base Sepolia's is `"USDC"`. A wrong name is a **failure**, with
  a message explaining that EIP-3009 signatures are bound to the domain. An
  asset address that is not the table's entry is a warning ("not verifiable"),
  because a rail may legitimately price another token.
- **Semantic checks the schema cannot express**, for MDF 0.3 sites:
  `accepts[]` ↔ `mdf.json` rails one-to-one (a missing rail warns — it may be
  degraded — an extra or mismatched rail fails); `access: "token"` requires
  `auth.endpoint` (the schema encodes the contrapositive, the validator checks
  the direct form too); the price summary states every rail's amount; the 402
  is `no-store`; `X-MDF-Version` is present.
- **x402 v1 / MDF 0.2 tolerance.** Legacy shapes are normalised into the same
  per-rail model and reported as "x402 v1 (legacy)" — informational for a
  third-party site, a failure for a site that declares MDF 0.3.x, which is a
  v2 hard cut.
- **CORS warning** when `Access-Control-Allow-Origin` is set without
  `PAYMENT-REQUIRED`/`PAYMENT-RESPONSE` in `Access-Control-Expose-Headers`.

### Changed — behaviour

- **`/mdf.json` no longer gates the other checks** (finding B1). `/llms.txt`,
  the header checks and the 402 checks run regardless, and an invalid
  `/mdf.json` is still an error — a site claiming MDF conformance is held to it.
- **A missing `/mdf.json` is a warning only when the site gives no other MDF
  signal.** If any response carries `X-MDF-Version`, `/llms.txt` references
  `mdf.json`, or a 402 carries `extensions.mdf`, the absent document is an
  **error** and the message names the signal that triggered it (for example
  "site declares MDF via X-MDF-Version … but /mdf.json is missing (HTTP 404)").
  Severity only — no check is gated on it. A clean third-party x402 publisher
  with no MDF signals still exits 0.
- **A `/mdf.json` served as HTML is reported as what it is** ("response is not
  valid JSON (served as text/html — likely an HTML page or SPA fallback)").
- **Which `/mdf.json` schema applies is decided by the declared
  `mdf_version`**: 0.3.x is checked against the 0.3.0 schema, everything else
  against the 0.2.0 schema and reported as legacy.
- **`--check-headers` implies nothing about `/mdf.json` success**; the CLI's
  exit code is 1 only for error-level results. Warnings do not fail a run.
- **Requests carry an identifying `User-Agent`** (`mdf-validator/0.2.0
  (+https://github.com/bitcryptic-gw/mdf)`), overridable with
  `MDF_VALIDATOR_UA`.

### Vendored

- `src/schemas/mdf.schema.json`, `src/schemas/mdf-402.schema.json` — spec
  0.3.0 at `bitcryptic-gw/mdf@d5bf772`.
- `src/schemas/legacy-0.2/*` — spec 0.2.0 at `e8f398e`, kept for reading older
  sites.
- `src/vendor/upstream/defaultAssets.ts` + `defaultAssets.json` — x402
  `513dd66d2b3eb2388065f9923d81aa496e626082`.

Paths, commits and sha256 for every file: `src/vendor/SOURCES.md`.

### Tests

56 tests (`bun test`): per-rail evaluation, header agreement, per-network
EIP-712 domains, mdf.json agreement, token access, legacy normalisation,
discovery, and a local-server integration test for the B1 decoupling.
