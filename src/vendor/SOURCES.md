# Vendored upstream files

Every file here is a copy of something owned by another repository. Nothing is
fetched at runtime; update by re-copying and re-recording the hash.

| path here | source | source commit | sha256 |
|---|---|---|---|
| `src/schemas/mdf.schema.json` | `bitcryptic-gw/mdf` `mdf.schema.json` (spec 0.3.1) | `f8e0b36` | `3f57a680f5fd9c33238c23a90230b94e778a68a4d8d565c6ababd0c71027c526` |
| `src/schemas/mdf-402.schema.json` | `bitcryptic-gw/mdf` `mdf-402.schema.json` (spec 0.3.1) | `f8e0b36` | `0c9e3558e967c394978992ded3ff1ae5f2dbf8a264c4c45ce1984374ba7c0935` |
| `src/schemas/legacy-0.2/mdf.schema.json` | same, spec 0.2.0 | `e8f398e` | `6ee256a47ef26b29fe3fa6c88bf5c42d167289764254857b713077f7a64aea0c` |
| `src/schemas/legacy-0.2/mdf-402.schema.json` | same, spec 0.2.0 | `e8f398e` | `57ef8481f8603864bd3dad75739a6bb502182c3c00e49e7bf92b6fe76191c638` |
| `src/vendor/upstream/defaultAssets.ts` | `x402-foundation/x402` `typescript/packages/mechanisms/evm/src/defaultAssets.ts` | `513dd66d2b3eb2388065f9923d81aa496e626082` | `4a87a165c7c2510b49465e969f58c9441488a491e4068e7aa819a4a5a43f3d8b` |
| `src/vendor/defaultAssets.json` | extracted from the file above by `scripts/extract-default-assets.mjs` | same | records the source hash in `_source_sha256` |

The two 0.3.x schemas are vendored from the head of `bitcryptic-gw/mdf`'s
`spec/0.3.1-native-asset-rails` branch (`f8e0b36`, spec PR #6). That PR must
merge before this repository's vendoring is authoritative; if it lands under a
different merge commit, re-point the `source commit` column (and re-check the
hashes) rather than leaving it at the branch head.

## Why `defaultAssets.ts` is not imported

The upstream file is a TypeScript module that imports types from `@x402/core`
and values from `./constants`, so it cannot be imported here without adding
`@x402/core` as a runtime dependency (which would also make the compiled binary
depend on that package's build). It is kept **verbatim** as provenance; the
data it exports is extracted once into `defaultAssets.json`, which is what the
validator reads. The extraction script records the source sha256 in the JSON.

`eip155:8453` is the pair that matters most: the EIP-712 domain name there is
`"USD Coin"`, not `"USDC"` — see decision 24 and `src/vendor/upstream/defaultAssets.ts:41-49`.
