# Search and filter

`index.search(options)` runs every kind of query. The retrieval mode is inferred
from which arms you supply—there is no `mode` parameter. For the reasoning behind
BM25, vector search, RRF, candidate windows, and score semantics, read
[How search works](../concepts/how-search-works.md).

| You supply | You get |
| --- | --- |
| `semantic` or `vector` | Semantic (vector cosine) search |
| `fulltext` | Keyword (BM25) search |
| a semantic arm **and** `fulltext` | Hybrid search (RRF fusion) |
| none of the above | Filter-only listing, ordered by id |

`semantic` is non-empty text searchgres.js embeds with the index's model. `vector`
is a precomputed query vector that skips the model. They are mutually exclusive.
A vector must contain exactly `index.dimensions` finite numbers; a wrong length
throws `DimensionMismatchError`. `fulltext`, when present, must also be
non-empty.

Every result is the full record plus a `score`:

```ts
type SearchResult = {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  temporal: string | null;
  name: string | null;
  hasEmbedding: boolean;
  version: string;
  versionHash: string;
  createdAt: Date;
  updatedAt: Date | null;
  score: number;
};
```

`score` is cosine similarity in `[-1, 1]` for semantic, positive BM25 for
keyword, a small positive fusion value for hybrid, and `-1` for a filter-only
listing.

## Recipes

### Find related content (semantic)

```ts
const hits = await index.search({
  semantic: "how do we keep credentials fresh?",
  limit: 5,
});
```

Restrict weak matches with `semanticThreshold` (minimum cosine similarity, `0`
to `1`):

```ts
await index.search({ semantic: "...", semanticThreshold: 0.5 });
```

### Look up exact terms (keyword)

```ts
const hits = await index.search({ fulltext: "rate limit" });
```

BM25 returns only genuine lexical matches, so the result count is a ceiling, not
padded with irrelevant rows.

### Retrieve for RAG (hybrid)

Pass both arms; results that rank well in both rise to the top:

```ts
const hits = await index.search({
  semantic: userQuestion,
  fulltext: userQuestion,
  limit: 8,
});
```

Use a precomputed query vector instead of `semantic` to skip the embedding call:

```ts
await index.search({ vector: precomputed, fulltext: "rate limit" });
```

This is also the right form for a search inside a caller transaction
(`index.with(tx)`), so the provider call does not run while the transaction is
open — see [Compose in a transaction](records-and-trees.md#compose-in-a-transaction).

### Scope to part of the tree

```ts
await index.search({
  semantic: "rate limiting",
  filter: { tree: "docs.api" }, // this path and everything under it
});
```

### Filter by metadata

```ts
await index.search({
  fulltext: "rate limit",
  filter: { meta: { source: "runbook" } }, // JSONB containment
});

await index.search({
  fulltext: "rate limit",
  filter: { metaPredicate: "$.version >= 3" }, // JSONPath predicate
});
```

### Filter by time

```ts
await index.search({
  semantic: "maintenance",
  filter: {
    temporalOverlaps: ["2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z"],
  },
});
```

### Combine filters with and / or / not

Filters are a composable boolean tree and apply to every mode:

```ts
await index.search({
  fulltext: "rate limit",
  filter: {
    and: [
      { tree: "docs.api" },
      {
        or: [
          { meta: { source: "runbook" } },
          { metaPredicate: "$.version >= 3" },
        ],
      },
      { not: { regexp: "deprecated" } },
    ],
  },
});
```

## Filter leaves

| Leaf | Matches |
| --- | --- |
| `{ tree: "docs.api" }` | The path and its whole subtree (ancestor-or-self containment). |
| `{ lquery: "docs.*.api" }` | An `ltree` `lquery` pattern. |
| `{ ltxtquery: "api & v2" }` | An `ltree` label search. |
| `{ meta: { ... } }` | JSONB containment; must be a non-empty object. |
| `{ metaPredicate: "$.n >= 3" }` | A PostgreSQL JSONPath predicate (`@@`); must return a boolean. |
| `{ temporalWithin: [start, end] }` | Record's time range is inside `[start, end)`. |
| `{ temporalOverlaps: [start, end] }` | Record's time range overlaps `[start, end)`. |
| `{ temporalBefore: t }` | Record's time is strictly before `t`. |
| `{ temporalAfter: t }` | Record's time is strictly after `t`. |
| `{ temporalContains: t }` | Record's time range contains `t`. |
| <code>{ regexp: "429&#124;throttl" }</code> | Case-insensitive POSIX match on `content`. |

Rules:

- `and` and `or` take at least two children; `not` takes exactly one.
- Nesting is limited to depth 16 and 100 nodes.
- Timestamps are `Date` or ISO-8601 with an offset or `Z`; a range requires
  `start < end`.
- **`regexp` can't stand alone in a filter-only search.** A regex without a
  ranking arm would scan the whole index, so it must be accompanied by an
  indexable filter (`tree`, `lquery`, `ltxtquery`, `meta`, or temporal) on the
  same branch, and it may not appear under `not`. With a `semantic`/`vector` or
  `fulltext` arm present, the arm bounds the scan and `regexp` is unrestricted.
- **`metaPredicate` must be a boolean predicate.** It is evaluated with the
  jsonb `@@` operator, which uses only the first result item and returns null
  when that item is not a boolean. searchgres treats null as no match. A path
  without a comparison, such as `"$.chapter"`, is valid JSONPath but matches
  nothing, with no error. Write a comparison such as
  `'$.chapter == "Appendix"'`, or `"exists($.chapter)"` to test that a key is
  present.

## Ranking controls

| Option | Applies to | Meaning |
| --- | --- | --- |
| `limit` | all | Integer from 1 to 1,000 (default 10). |
| `semanticThreshold` | semantic, vector, hybrid | Finite minimum cosine similarity, `0`–`1`; requires a semantic or vector arm. |
| `k` | hybrid | Nonnegative finite RRF constant (default 60). |
| `candidateLimit` | hybrid | Integer from 1 to 1,000; candidates per arm before fusion (default 30). Internally raised to at least `limit`. |
| `fulltextWeight` | hybrid | Finite weight of the keyword arm, `0`–`1` (default 1). |
| `semanticWeight` | hybrid | Finite weight of the semantic arm, `0`–`1` (default 1). |

`k`, `candidateLimit`, and the weights are rejected outside hybrid mode.
Unknown keys, invalid combinations, and out-of-range values throw
[`InvalidInputError`](../reference/errors.md).

Hybrid search is a fused **top-k** operation: the score reflects rank within a
candidate window, not absolute relevance, and there is no cursor. To see more
results, raise `limit`.

## Filter-only listing and pagination

A search with no ranking arm lists records by `id`. Because ids are UUIDv7, that
order is chronological, and it supports stable keyset pagination:

```ts
const first = await index.search({ order: "asc", limit: 100 });
const next = await index.search({
  order: "asc",
  after: first.at(-1)?.id,
  limit: 100,
});
```

`order`, `after`, and `before` apply only to filter-only listing. Supplying them
with a ranking arm is rejected — ranked results are top-k, not a paginated feed.
`after` and `before` are mutually exclusive UUIDv7 record-id cursors. `order`
defaults to `"desc"`.

Next: [Build a RAG retriever](rag.md) or
[Manage records and trees](records-and-trees.md).
