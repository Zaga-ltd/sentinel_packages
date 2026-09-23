/**
 * The version this copy was built from.
 *
 * Kept as a constant rather than read from package.json because the shipped
 * artefact is a single bundled file with no package.json beside it. A test
 * asserts the two agree, so the duplication cannot drift silently.
 */
export const VERSION = "0.3.0";
