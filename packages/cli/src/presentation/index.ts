import type { QueueStats, SearchResult, StoredRecord } from "searchgres";

const bareSelectFields = [
  "id",
  "content",
  "meta",
  "tree",
  "name",
  "temporal",
  "score",
  "hasEmbedding",
  "createdAt",
  "updatedAt",
  "version",
  "versionHash",
] as const;

type BareSelectField = (typeof bareSelectFields)[number];
type ContentRange = {
  readonly start: number | undefined;
  readonly end: number | undefined;
};

export interface ParsedSelect {
  readonly fields: ReadonlySet<BareSelectField>;
  readonly contentRange?: ContentRange;
  readonly includeFullMeta: boolean;
  readonly metaKeys: ReadonlySet<string>;
}

type MutablePartial<T> = { -readonly [K in keyof T]?: T[K] };

/**
 * Temporal values are presented in the same shape they are accepted: one ISO
 * instant, or an ISO `[start, end]` interval. Core returns PostgreSQL's
 * canonical `tstzrange` text, which callers should never need to parse.
 */
export type PresentedTemporal = [string] | [string, string] | null;
export type PresentedRecord<T extends StoredRecord> = Omit<T, "temporal"> & {
  readonly temporal: PresentedTemporal;
};

export function presentTemporal(value: string | null): PresentedTemporal {
  if (value === null) return null;
  const match = /^[[(]"?(.+?)"?,"?(.+?)"?[)\]]$/.exec(value);
  if (!match?.[1] || !match[2])
    throw new Error("unexpected temporal range text from PostgreSQL");
  const start = isoTimestamp(match[1]);
  const end = isoTimestamp(match[2]);
  return start === end ? [start] : [start, end];
}

function isoTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error("unexpected temporal timestamp text from PostgreSQL");
  return new Date(milliseconds).toISOString();
}

/** Present one core record or search result for CLI/MCP output. */
export function presentRecord<T extends StoredRecord>(
  record: T,
): PresentedRecord<T> {
  return { ...record, temporal: presentTemporal(record.temporal) };
}

/** Queue state with subset relationships made explicit for operators. */
export interface PresentedQueueStats {
  readonly pending: {
    readonly total: number;
    readonly claimable: number;
    readonly deferred: number;
    readonly oldestAt: Date | null;
  };
  readonly failed: {
    readonly terminal: number;
  };
}

export function presentQueueStats(stats: QueueStats): PresentedQueueStats {
  return {
    pending: {
      total: stats.pending,
      claimable: stats.waiting,
      deferred: stats.inFlight,
      oldestAt: stats.oldestPendingAt,
    },
    failed: { terminal: stats.failed },
  };
}

export type ProjectedSearchResult = Omit<
  MutablePartial<SearchResult>,
  "temporal"
> & {
  temporal?: PresentedTemporal;
  readonly contentLength?: number;
};

export interface ProjectedSearchEnvelope {
  readonly results: readonly ProjectedSearchResult[];
}

export type SelectionKind = "stored-record" | "search-result";

/** Parse CLI text or MCP selector arrays into one shared presentation plan. */
export function parseSelection(
  value: string | readonly string[],
  options: { readonly kind: SelectionKind },
): ParsedSelect {
  const specs = (typeof value === "string" ? value.split(",") : value).map(
    (field) => field.trim(),
  );
  if (specs.length === 0 || specs.some((field) => field === "")) {
    throw new Error("select at least one field");
  }

  const fields = new Set<BareSelectField>();
  const metaKeys = new Set<string>();
  const contentSelections = new Map<string, ContentRange | undefined>();
  let includeFullMeta = false;

  for (const spec of specs) {
    if (spec === "content") {
      fields.add("content");
      contentSelections.set("full", undefined);
      continue;
    }

    const range = parseContentRange(spec);
    if (range !== null) {
      fields.add("content");
      contentSelections.set(rangeKey(range), range);
      continue;
    }

    if (spec.startsWith("meta.")) {
      const key = spec.slice("meta.".length);
      if (key === "") throw new Error("metadata key must not be empty");
      fields.add("meta");
      metaKeys.add(key);
      continue;
    }

    if ((bareSelectFields as readonly string[]).includes(spec)) {
      if (spec === "score" && options.kind === "stored-record") {
        throw new Error("score is available only on search results");
      }
      const field = spec as BareSelectField;
      fields.add(field);
      if (field === "meta") includeFullMeta = true;
      continue;
    }

    if (spec.startsWith("content:")) {
      throw new Error(`invalid content range: ${spec}`);
    }
    throw new Error(`unknown field: ${spec}`);
  }

  if (contentSelections.size > 1) {
    throw new Error("only one distinct content selection may be used");
  }

  const contentSelection = contentSelections.values().next();
  return {
    fields,
    ...(contentSelection.done || contentSelection.value === undefined
      ? {}
      : { contentRange: contentSelection.value }),
    includeFullMeta,
    metaKeys,
  };
}

/** Backwards-compatible CLI parser for search-result selection. */
export function parseSelectFields(value: string): ParsedSelect {
  return parseSelection(value, { kind: "search-result" });
}

/** Project core results for presentation while retaining the result envelope. */
export function projectSearchEnvelope(
  envelope: { readonly results: readonly SearchResult[] },
  select: ParsedSelect,
): ProjectedSearchEnvelope {
  return {
    results: envelope.results.map((result) =>
      projectSearchResult(result, select),
    ),
  };
}

export type ProjectedStoredRecord = Omit<
  MutablePartial<StoredRecord>,
  "temporal"
> & {
  temporal?: PresentedTemporal;
  readonly contentLength?: number;
};

export function projectStoredRecord(
  result: StoredRecord,
  select: ParsedSelect,
): ProjectedStoredRecord {
  return projectRecord(result, select);
}

export function projectSearchResult(
  result: SearchResult,
  select: ParsedSelect,
): ProjectedSearchResult {
  return projectRecord(result, select);
}

function projectRecord(
  result: StoredRecord | SearchResult,
  select: ParsedSelect,
): ProjectedSearchResult {
  const projected: ProjectedSearchResult & { contentLength?: number } = {};

  // Add fields in the order the caller selected them.
  for (const field of select.fields) {
    switch (field) {
      case "content":
        if (select.contentRange === undefined)
          projected.content = result.content;
        else {
          const points = [...result.content];
          projected.content = points
            .slice(select.contentRange.start, select.contentRange.end)
            .join("");
          projected.contentLength = points.length;
        }
        break;
      case "meta":
        if (select.includeFullMeta) projected.meta = result.meta;
        else {
          const selectedMeta: typeof result.meta = {};
          for (const key of select.metaKeys) {
            if (!Object.hasOwn(result.meta, key)) continue;
            const value = result.meta[key];
            if (value === undefined) continue;
            // Define rather than assign so a literal "__proto__" metadata key
            // is projected as data instead of invoking Object.prototype's
            // setter.
            Object.defineProperty(selectedMeta, key, {
              value,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          projected.meta = selectedMeta;
        }
        break;
      case "temporal":
        projected.temporal = presentTemporal(result.temporal);
        break;
      case "score":
        if ("score" in result) projected.score = result.score;
        break;
      default:
        projected[field] = result[field] as never;
    }
  }

  return projected;
}

function parseContentRange(spec: string): ContentRange | null {
  const shorthand = /^content:(\d+)$/.exec(spec);
  if (shorthand?.[1] !== undefined) {
    return { start: undefined, end: safeOffset(shorthand[1], spec) };
  }

  const range = /^content:(-?\d*)\.\.(-?\d*)$/.exec(spec);
  if (range === null) return null;
  const startText = range[1] ?? "";
  const endText = range[2] ?? "";
  if (startText === "" && endText === "") {
    throw new Error(`invalid content range: ${spec}`);
  }
  return {
    start: startText === "" ? undefined : safeOffset(startText, spec),
    end: endText === "" ? undefined : safeOffset(endText, spec),
  };
}

function safeOffset(value: string, spec: string): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) {
    throw new Error(`invalid content range: ${spec}`);
  }
  return offset;
}

function rangeKey(range: ContentRange): string {
  return `${range.start ?? ""}..${range.end ?? ""}`;
}
