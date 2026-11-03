import type { Span } from "@opentelemetry/api";
import type postgres from "postgres";
import { z } from "zod";
import { assertEmbeddingAvailable, embedQuery } from "./embedding.ts";
import {
  DimensionMismatchError,
  InvalidInputError,
  SearchgresError,
} from "./errors.ts";
import { isValidTreePath } from "./identifiers.ts";
import type { Index } from "./open-index.ts";
import { mapInputSqlError } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";
import {
  normalizeRangeLiteral,
  normalizeTimestamp,
  type Timestamp,
  timestampSchema,
} from "./temporal.ts";
import { toValidationIssue } from "./validation.ts";

/**
 * Guards against pathological ASTs from untrusted callers. Enforced twice: by
 * {@link guardFilterShape} on the raw input before Zod sees it (Zod's recursive
 * `z.lazy` would otherwise overflow the stack on a deep enough tree and
 * surface an untyped RangeError), and again in {@link normalizeFilter} on the
 * parsed tree, which is where the counts are authoritative.
 */
const MAX_FILTER_DEPTH = 16;
const MAX_FILTER_NODES = 100;

// ---------------------------------------------------------------------------
// filter + options schemas (public types are inferred from these)
// ---------------------------------------------------------------------------

const nonEmptyString = z.string().min(1);

const treeFilterLeaf = z
  .string()
  .refine(isValidTreePath, "expected a dotted ltree path (or the empty root)");

const metaFilterLeaf = z
  .record(z.string(), z.json())
  .refine(
    (value) => Object.keys(value).length > 0,
    "meta filter must not be an empty object",
  );

const rangeLeaf = z.tuple([timestampSchema, timestampSchema]).readonly();

/** A timestamp accepted by a temporal filter. */
export type { Timestamp };
/** A `[start, end]` window accepted by a temporal-range filter. */
export type TemporalRange = z.input<typeof rangeLeaf>;

/**
 * Internal recursion anchor for {@link filterSchema}. Zod's `z.lazy` needs an
 * explicit TypeScript type for a self-referential schema; the exported public
 * {@link Filter} is still derived from the schema via `z.input`, so this stays
 * internal and the two cannot drift on anything the schema validates.
 */
type FilterNode =
  | { readonly and: readonly FilterNode[] }
  | { readonly or: readonly FilterNode[] }
  | { readonly not: FilterNode }
  | { readonly tree: z.input<typeof treeFilterLeaf> }
  | { readonly lquery: z.input<typeof nonEmptyString> }
  | { readonly ltxtquery: z.input<typeof nonEmptyString> }
  | { readonly meta: z.input<typeof metaFilterLeaf> }
  | { readonly metaPredicate: z.input<typeof nonEmptyString> }
  | { readonly temporalWithin: TemporalRange }
  | { readonly temporalOverlaps: TemporalRange }
  | { readonly temporalBefore: Timestamp }
  | { readonly temporalAfter: Timestamp }
  | { readonly temporalContains: Timestamp }
  | { readonly regexp: z.input<typeof nonEmptyString> };

const filterSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(filterSchema).min(2) }),
    z.strictObject({ or: z.array(filterSchema).min(2) }),
    z.strictObject({ not: filterSchema }),
    z.strictObject({ tree: treeFilterLeaf }),
    z.strictObject({ lquery: nonEmptyString }),
    z.strictObject({ ltxtquery: nonEmptyString }),
    z.strictObject({ meta: metaFilterLeaf }),
    z.strictObject({ metaPredicate: nonEmptyString }),
    z.strictObject({ temporalWithin: rangeLeaf }),
    z.strictObject({ temporalOverlaps: rangeLeaf }),
    z.strictObject({ temporalBefore: timestampSchema }),
    z.strictObject({ temporalAfter: timestampSchema }),
    z.strictObject({ temporalContains: timestampSchema }),
    z.strictObject({ regexp: nonEmptyString }),
  ]),
);

/**
 * A composable boolean filter over records. Every leaf is a predicate on one
 * record; `and`/`or`/`not` compose them. Leaves are filter criteria only —
 * ranking (semantic/fulltext) stays on {@link SearchOptions}.
 */
export type Filter = z.input<typeof filterSchema>;

const searchOptionsSchema = z
  .strictObject({
    semantic: nonEmptyString.optional(),
    vector: z.array(z.number().finite()).readonly().optional(),
    fulltext: nonEmptyString.optional(),
    filter: filterSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    candidateLimit: z.number().int().min(1).max(1000).optional(),
    semanticThreshold: z.number().min(0).max(1).optional(),
    k: z.number().min(0).optional(),
    fulltextWeight: z.number().min(0).max(1).optional(),
    semanticWeight: z.number().min(0).max(1).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    after: z.uuidv7().optional(),
    before: z.uuidv7().optional(),
  })
  .superRefine((options, context) => {
    const hasSemantic =
      options.semantic !== undefined || options.vector !== undefined;
    const hasFulltext = options.fulltext !== undefined;
    const ranked = hasSemantic || hasFulltext;
    const hybrid = hasSemantic && hasFulltext;

    if (options.semantic !== undefined && options.vector !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["vector"],
        message: "provide either `semantic` text or a `vector`, not both",
      });
    }
    if (options.semanticThreshold !== undefined && !hasSemantic) {
      context.addIssue({
        code: "custom",
        path: ["semanticThreshold"],
        message: "semanticThreshold requires a `semantic` or `vector` arm",
      });
    }
    for (const key of [
      "k",
      "candidateLimit",
      "fulltextWeight",
      "semanticWeight",
    ] as const) {
      if (options[key] !== undefined && !hybrid) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} only applies to a hybrid search (both semantic and fulltext)`,
        });
      }
    }
    for (const key of ["order", "after", "before"] as const) {
      if (options[key] !== undefined && ranked) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} only applies to a filter-only search`,
        });
      }
    }
    if (options.after !== undefined && options.before !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["before"],
        message: "provide either `after` or `before`, not both",
      });
    }
  });

/** Caller-facing search input, inferred from the runtime validator. */
export type SearchOptions = z.input<typeof searchOptionsSchema>;

/** One search hit: the full record plus its score. */
export interface SearchResult {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly tree: string;
  readonly temporal: string | null;
  readonly name: string | null;
  readonly hasEmbedding: boolean;
  readonly version: string;
  readonly versionHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
  /**
   * Cosine similarity `[-1, 1]` for a semantic arm; positive BM25 for keyword;
   * a small positive RRF value for hybrid; `-1` for a filter-only listing.
   */
  readonly score: number;
}

interface SearchRow {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly tree: string;
  readonly temporal: string | null;
  readonly name: string | null;
  readonly has_embedding: boolean;
  readonly version: string;
  readonly version_hash: string;
  readonly created_at: Date;
  readonly updated_at: Date | null;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// filter normalization + safety analysis
// ---------------------------------------------------------------------------

type CanonicalFilter = Record<string, unknown>;

interface FilterAnalysis {
  readonly isGuard: boolean;
  readonly hasRegex: boolean;
  readonly unguarded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bound the depth and node count of a raw, not-yet-validated filter so that
 * schema parsing never recurses past the caps. Only the combinator shape is
 * inspected (`and`/`or` arrays, `not` objects); everything else counts as a
 * leaf and is left for Zod to validate. Iterative, so the guard itself cannot
 * overflow on the input it exists to reject.
 */
function guardFilterShape(root: unknown): void {
  let nodes = 0;
  const stack: { readonly node: unknown; readonly depth: number }[] = [
    { node: root, depth: 1 },
  ];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, depth } = next;
    if (depth > MAX_FILTER_DEPTH) {
      throwInvalidFilter(
        `filter nesting exceeds the maximum depth of ${MAX_FILTER_DEPTH}`,
      );
    }
    if (++nodes > MAX_FILTER_NODES) {
      throwInvalidFilter(
        `filter exceeds the maximum of ${MAX_FILTER_NODES} nodes`,
      );
    }
    if (!isRecord(node)) {
      continue;
    }
    for (const key of ["and", "or"] as const) {
      if (Array.isArray(node[key])) {
        for (const child of node[key]) {
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    }
    if ("not" in node) {
      stack.push({ node: node.not, depth: depth + 1 });
    }
  }
}

/**
 * Validate structural limits, normalize temporal leaves to canonical strings,
 * and enforce the regex-safety rule. `ranked` relaxes the rule because a
 * semantic/keyword arm already bounds the scan.
 */
function normalizeFilter(filter: FilterNode, ranked: boolean): CanonicalFilter {
  let nodes = 0;
  const walk = (node: FilterNode, depth: number): CanonicalFilter => {
    if (depth > MAX_FILTER_DEPTH) {
      throwInvalidFilter(
        `filter nesting exceeds the maximum depth of ${MAX_FILTER_DEPTH}`,
      );
    }
    if (++nodes > MAX_FILTER_NODES) {
      throwInvalidFilter(
        `filter exceeds the maximum of ${MAX_FILTER_NODES} nodes`,
      );
    }
    if ("and" in node) {
      return { and: node.and.map((child) => walk(child, depth + 1)) };
    }
    if ("or" in node) {
      return { or: node.or.map((child) => walk(child, depth + 1)) };
    }
    if ("not" in node) {
      return { not: walk(node.not, depth + 1) };
    }
    if ("temporalWithin" in node) {
      return { temporalWithin: rangeLiteral(node.temporalWithin) };
    }
    if ("temporalOverlaps" in node) {
      return { temporalOverlaps: rangeLiteral(node.temporalOverlaps) };
    }
    if ("temporalBefore" in node) {
      return { temporalBefore: normalizeTimestamp(node.temporalBefore) };
    }
    if ("temporalAfter" in node) {
      return { temporalAfter: normalizeTimestamp(node.temporalAfter) };
    }
    if ("temporalContains" in node) {
      return { temporalContains: normalizeTimestamp(node.temporalContains) };
    }
    // leaf passthrough (tree/lquery/ltxtquery/meta/metaPredicate/regexp)
    return node as CanonicalFilter;
  };

  const canonical = walk(filter, 1);
  if (!ranked) {
    const analysis = analyzeFilter(filter);
    if (analysis.unguarded) {
      throwInvalidFilter(
        "a `regexp` filter must be accompanied by an indexable filter (tree, lquery, ltxtquery, meta, or temporal)",
      );
    }
  }
  return canonical;
}

/**
 * Two-pass helper: guard/regex analysis that also rejects regex under `not`.
 *
 * Deliberately duplicated in `db/sql/routines/search/analyze-filter.sql` so
 * direct-SQL callers of `search_records` get the same protection; this copy
 * gives library callers a typed error before any round trip. The two must
 * implement identical rules — change both together.
 */
function analyzeFilter(node: FilterNode): FilterAnalysis {
  if ("and" in node) {
    const children = node.and.map(analyzeFilter);
    return {
      isGuard: children.some((c) => c.isGuard),
      hasRegex: children.some((c) => c.hasRegex),
      unguarded:
        children.some((c) => c.unguarded) && !children.some((c) => c.isGuard),
    };
  }
  if ("or" in node) {
    const children = node.or.map(analyzeFilter);
    return {
      isGuard:
        children.every((c) => c.isGuard) && !children.some((c) => c.hasRegex),
      hasRegex: children.some((c) => c.hasRegex),
      unguarded: children.some((c) => c.unguarded),
    };
  }
  if ("not" in node) {
    const child = analyzeFilter(node.not);
    if (child.hasRegex) {
      throwInvalidFilter(
        "a `regexp` filter may not appear under `not` in a filter-only search",
      );
    }
    return { isGuard: false, hasRegex: false, unguarded: false };
  }
  if ("regexp" in node) {
    return { isGuard: false, hasRegex: true, unguarded: true };
  }
  if ("metaPredicate" in node) {
    return { isGuard: false, hasRegex: false, unguarded: false };
  }
  return { isGuard: true, hasRegex: false, unguarded: false };
}

function rangeLiteral(range: TemporalRange): string {
  const result = normalizeRangeLiteral(range[0], range[1]);
  if ("error" in result) {
    throwInvalidFilter(result.error);
  }
  return result.literal;
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/** Run a search against the index, embedding `semantic` text when needed. */
export async function search(
  index: Index,
  options: SearchOptions,
  span: Span,
): Promise<readonly SearchResult[]> {
  if (isRecord(options) && options.filter !== undefined) {
    guardFilterShape(options.filter);
  }
  const parsed = searchOptionsSchema.safeParse(options ?? {});
  if (!parsed.success) {
    throwInvalidOptions(parsed.error);
  }
  const opts = parsed.data;

  const hasSemantic = opts.semantic !== undefined || opts.vector !== undefined;
  const hasFulltext = opts.fulltext !== undefined;
  const ranked = hasSemantic || hasFulltext;
  const hybrid = hasSemantic && hasFulltext;

  span.setAttributes({
    "searchgres.search.mode": hybrid
      ? "hybrid"
      : hasSemantic
        ? "semantic"
        : hasFulltext
          ? "keyword"
          : "filter",
    "searchgres.search.has_filter": opts.filter !== undefined,
  });

  const filterJson =
    opts.filter === undefined ? null : normalizeFilter(opts.filter, ranked);

  let vector: string | null = null;
  if (opts.vector !== undefined) {
    if (opts.vector.length !== index.dimensions) {
      throw new DimensionMismatchError(index.dimensions, opts.vector.length);
    }
    vector = JSON.stringify(opts.vector);
  } else if (opts.semantic !== undefined) {
    assertEmbeddingAvailable(index, "search by semantic text");
    vector = JSON.stringify(await embedQuery(index, opts.semantic));
  }

  const rows = hybrid
    ? await runHybrid(index, opts, filterJson, vector as string)
    : await runSingle(index, opts, filterJson, vector, ranked);

  const results = rows.map(mapRow);
  span.setAttribute("searchgres.result.count", results.length);
  return results;
}

async function runSingle(
  index: Index,
  opts: z.output<typeof searchOptionsSchema>,
  filterJson: CanonicalFilter | null,
  vector: string | null,
  ranked: boolean,
): Promise<readonly SearchRow[]> {
  const { sql } = index;
  const order = opts.order ?? "desc";
  return runSearch(
    sql<SearchRow[]>`
      select id, content, meta, tree, temporal, name, has_embedding,
             version, version_hash, created_at, updated_at, score
      from ${sql(index.schema)}.search_records
      ( ${filterParam(index, filterJson)}
      , ${opts.fulltext ?? null}
      , ${vectorParam(index, vector)}
      , ${opts.semanticThreshold ?? null}
      , ${opts.limit ?? null}
      , ${ranked ? "desc" : order}
      , ${opts.after ?? null}
      , ${opts.before ?? null}
      )
    `,
    index.schema,
  );
}

async function runHybrid(
  index: Index,
  opts: z.output<typeof searchOptionsSchema>,
  filterJson: CanonicalFilter | null,
  vector: string,
): Promise<readonly SearchRow[]> {
  const { sql } = index;
  return runSearch(
    sql<SearchRow[]>`
      select id, content, meta, tree, temporal, name, has_embedding,
             version, version_hash, created_at, updated_at, score
      from ${sql(index.schema)}.hybrid_search_records
      ( ${filterParam(index, filterJson)}
      , ${opts.fulltext ?? null}
      , ${vectorParam(index, vector)}
      , ${opts.semanticThreshold ?? null}
      , ${opts.k ?? null}
      , ${opts.candidateLimit ?? null}
      , ${opts.fulltextWeight ?? null}
      , ${opts.semanticWeight ?? null}
      , ${opts.limit ?? null}
      )
    `,
    index.schema,
  );
}

function filterParam(index: Index, filterJson: CanonicalFilter | null) {
  const { sql } = index;
  return filterJson === null
    ? sql`null::jsonb`
    : sql`${sql.json(filterJson as never)}::jsonb`;
}

function vectorParam(index: Index, vector: string | null) {
  const { sql } = index;
  if (vector === null) {
    return sql`null`;
  }
  return index.vectorType === "halfvec"
    ? sql`${vector}::public.halfvec`
    : sql`${vector}::public.vector`;
}

async function runSearch(
  query: postgres.PendingQuery<SearchRow[]>,
  schema: string,
): Promise<readonly SearchRow[]> {
  try {
    return await runSql(query, {
      spanName: "searchRecords",
      dbOperationName: "SELECT",
      namespace: schema,
    });
  } catch (error) {
    if (error instanceof SearchgresError) {
      throw error;
    }
    throw mapInputSqlError(error, "search input") ?? error;
  }
}

function mapRow(row: SearchRow): SearchResult {
  return {
    id: row.id,
    content: row.content,
    meta: row.meta,
    tree: row.tree,
    temporal: row.temporal,
    name: row.name,
    hasEmbedding: row.has_embedding,
    version: row.version,
    versionHash: row.version_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score: row.score,
  };
}

function throwInvalidFilter(message: string): never {
  throw new InvalidInputError(`Invalid search filter: ${message}`, {
    issues: [{ code: "custom", message, path: ["filter"] }],
  });
}

function throwInvalidOptions(error: z.ZodError): never {
  const issues = error.issues.map(toValidationIssue);
  const first = issues[0];
  const detail = first
    ? `${first.path.join(".") || "options"}: ${first.message}`
    : "validation failed";
  throw new InvalidInputError(`Invalid search options: ${detail}`, {
    cause: error,
    issues,
  });
}
