/**
 * user-agent.ts — identify the validator to the sites it probes.
 *
 * Override with MDF_VALIDATOR_UA when a run needs a specific string (the
 * ProofLines interop run uses its own). Not a secret, so an env var is fine.
 */
export const USER_AGENT =
  process.env.MDF_VALIDATOR_UA ?? "mdf-validator/0.2.0 (+https://github.com/bitcryptic-gw/mdf)";
