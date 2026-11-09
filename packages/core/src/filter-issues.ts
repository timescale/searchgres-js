import type { z } from "zod";

/** The keys that name the filter node kinds. Each filter node has exactly one. */
export const FILTER_KEYS: readonly string[] = [
  "and",
  "or",
  "not",
  "tree",
  "lquery",
  "ltxtquery",
  "meta",
  "metaPredicate",
  "temporalWithin",
  "temporalOverlaps",
  "temporalBefore",
  "temporalAfter",
  "temporalContains",
  "regexp",
];

const MAX_QUOTED_KEY_LENGTH = 64;
const MAX_LISTED_KEYS = 4;

type Issue = z.core.$ZodIssue;

function quoteKey(key: string): string {
  return JSON.stringify(
    key.length > MAX_QUOTED_KEY_LENGTH
      ? `${key.slice(0, MAX_QUOTED_KEY_LENGTH)}...`
      : key,
  );
}

function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

/**
 * Find the one union branch that accepts the shape of the node. A branch
 * accepts the shape when it reports no wrong-type or unknown-key issue on the
 * node itself. Its issues are then about the node's value.
 */
function matchingBranch(
  branches: readonly (readonly Issue[])[],
): readonly Issue[] | undefined {
  const matches = branches.filter(
    (issues) =>
      !issues.some(
        (issue) =>
          issue.path.length === 0 &&
          (issue.code === "unrecognized_keys" || issue.code === "invalid_type"),
      ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Replace each union issue that has one matching branch with the issues of
 * that branch, and make their paths absolute. Other issues do not change.
 */
export function resolveFilterIssues(
  issues: readonly Issue[],
  prefix: readonly PropertyKey[] = [],
): Issue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union") {
      const branch = matchingBranch(issue.errors);
      if (branch !== undefined) {
        return resolveFilterIssues(branch, path);
      }
    }
    return [{ ...issue, path }];
  });
}

/**
 * Zod error function for the filter node union. It replaces the generic
 * "Invalid input" with the cause: the node is not an object, it does not have
 * exactly one key, its key is unknown, or its value is not valid.
 */
export function filterNodeError(
  issue: z.core.$ZodRawIssue,
): string | undefined {
  if (issue.code !== "invalid_union") {
    return undefined;
  }
  const node = issue.input;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return 'expected a filter object with exactly one key, for example { tree: "docs" }';
  }
  const keys = Object.keys(node);
  if (keys.length !== 1) {
    const listed = keys.slice(0, MAX_LISTED_KEYS).map(quoteKey).join(", ");
    return keys.length === 0
      ? "a filter object must have exactly one key, but it has none"
      : `a filter object must have exactly one key, but it has ${keys.length} (${listed}${keys.length > MAX_LISTED_KEYS ? ", ..." : ""}). Combine conditions with { and: [...] }`;
  }
  const key = keys[0] as string;
  if (!FILTER_KEYS.includes(key)) {
    return `unknown filter key ${quoteKey(key)}. Expected one of: ${FILTER_KEYS.join(", ")}. To match a metadata field, use { meta: { ${quoteKey(key)}: ... } }`;
  }
  const [first] = resolveFilterIssues(matchingBranch(issue.errors) ?? []);
  if (first === undefined) {
    return undefined;
  }
  return first.path.length === 0
    ? first.message
    : `${joinPath(first.path)}: ${first.message}`;
}
