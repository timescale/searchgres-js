/**
 * The library's own version.
 *
 * Hand-maintained and mirrored from package.json, which `version.test.ts`
 * enforces. Keeping a source constant also lets Node source tests run without
 * importing package JSON. Published consumers need no runtime filesystem access.
 *
 * This is package metadata only. Immutable index schemas use their own format
 * marker and never derive compatibility from the library package version.
 */
export const LIBRARY_VERSION = "0.4.0";
