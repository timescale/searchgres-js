# How search works

searchgres.js combines multiple retrieval strategies because no single score
captures every kind of relevance. Semantic similarity finds related meaning;
BM25 finds exact language and identifiers; structured filters establish the
scope in which either ranking should operate.

`index.search()` provides all of these paths. The mode is inferred from the
query arms rather than selected with a separate `mode` field.

| Input | Retrieval path |
| --- | --- |
| `semantic` | Embed the query, then run cosine search on the vector index |
| `vector` | Run cosine search on the vector index with a precomputed vector |
| `fulltext` | Run BM25 keyword search |
| semantic/vector plus `fulltext` | Run both arms and fuse them with RRF |
| no ranking arm | List matching records in UUIDv7 order |

A `filter` can be added to every path.

## Semantic retrieval

A semantic query finds records whose embeddings point in a similar direction to
the query embedding. This is useful when wording differs:

```ts
await index.search({
  semantic: "how often are credentials renewed?",
  limit: 10,
});
```

searchgres.js applies the index handle's truncator, calls its embedding model,
checks the returned dimensions, and searches the vector index with cosine
distance. The public score is cosine similarity: higher is better, with a
possible range of `[-1, 1]`.

The vector index is a pgvector HNSW index by default. An index can instead use
the experimental `prism` access method from `pg_vectorsearch`. The two behave
differently under filters: with HNSW, searchgres.js uses strict-order iterative
scanning, so the scan continues when a filter discards rows. `prism` collects a
fixed number of candidates first and filters them afterwards, so a filtered
`prism` semantic search can return fewer rows than `limit`, or none. See
[Vector index access method](../guides/indexes.md#vector-index-access-method-hnsw-vs-prism).

Pass `vector` instead of `semantic` when your application already computed the
query embedding. The two fields are mutually exclusive.

Use `semanticThreshold` to reject low-similarity candidates. It applies before
results are returned and accepts values from `0` through `1`.

## BM25 keyword retrieval

BM25 rewards terms that occur in a record but are uncommon in the corpus, while
accounting for term frequency and record length. It is usually better than
vector search for product names, error codes, identifiers, and exact phrases:

```ts
await index.search({ fulltext: "HTTP 429 rate limit" });
```

The score is a positive, query-dependent BM25 value. Its scale is not comparable
to cosine similarity or to BM25 scores from a different query. searchgres.js
returns only genuine lexical matches; it does not pad the result set to `limit`.

## Hybrid retrieval and RRF

Hybrid search runs a semantic arm and a BM25 arm independently:

```ts
await index.search({
  semantic: "how are requests throttled?",
  fulltext: "HTTP 429 rate limit",
  limit: 10,
});
```

Raw BM25 and cosine scores have different meanings and scales, so adding them
would make one scoring system dominate arbitrarily. searchgres.js instead uses
Reciprocal Rank Fusion (RRF):

```text
score = fulltextWeight / (k + fulltextRank)
      + semanticWeight / (k + semanticRank)
```

A record that ranks well in both arms rises above one that ranks well in only
one. A missing arm contributes zero. The defaults are `k=60`, equal weights, and
30 candidates from each arm.

The hybrid score is meaningful only as an ordering within that result set. It is
not an absolute confidence value and should not be compared across queries.

## Candidate windows and top-k results

Each hybrid arm retrieves a candidate window before fusion. `candidateLimit`
controls its size and `limit` controls the final result count. A larger candidate
window can improve recall, but it also increases work and can introduce noisy
matches. Tune it with evaluation data rather than assuming more is always
better.

Ranked retrieval is a fused top-k operation. It has no cursor because ranks and
RRF scores depend on the complete candidate window. Raise `limit` when you need
more ranked results.

## Structured filters

Filters are boolean predicates over the same record being ranked:

- `tree`, `lquery`, and `ltxtquery` scope hierarchy;
- `meta` uses JSONB containment;
- `metaPredicate` evaluates JSONPath;
- temporal leaves query represented instants and ranges;
- `regexp` provides a precision content filter.

```ts
await index.search({
  semantic: "credential policy",
  fulltext: "token rotation",
  filter: {
    and: [
      { tree: "docs.security" },
      { meta: { status: "current" } },
      { not: { regexp: "deprecated" } },
    ],
  },
});
```

The filter applies to both hybrid arms. This matters: fusing globally ranked
results and filtering afterward could discard the useful candidates before the
correct scope is considered.

A regex cannot be the only filter in an unranked search because that would allow
an unbounded scan. Combine it with a ranking arm or an indexable tree, metadata,
or temporal filter.

## Filter-only listing

With no semantic/vector or fulltext arm, search becomes an ordered record
listing. Its score is the sentinel `-1` and its UUIDv7 order supports keyset
pagination:

```ts
const page = await index.search({
  filter: { tree: "docs.api" },
  order: "asc",
  after: previousLastId,
  limit: 100,
});
```

`order`, `after`, and `before` are valid only on this unranked path.

## Embedding visibility

A record is available to BM25 and filters immediately after it is written. It
can also appear in hybrid results through the BM25 arm before it has a vector;
the missing semantic arm contributes zero to its RRF score. Semantic retrieval
and the semantic arm of hybrid require a stored embedding. Provide one during
ingest or process the database-backed embedding queue with
`processEmbeddings()` or `startEmbeddingWorker()`.

A query using `semantic` text still calls the configured embedding model,
including in hybrid mode. Use a precomputed `vector` to avoid that provider call.

## Choosing a mode

- Start with **BM25** for exact lookup and highly specific terminology.
- Start with **semantic** when users express the same idea with varied wording.
- Use **hybrid** as a strong general retrieval path when both exact and semantic
  signals matter.
- Add **filters** whenever application structure can remove irrelevant regions
  of the corpus.
- Use **filter-only** search for browsing, synchronization, and batch workflows.

The right settings depend on your corpus and task. Evaluate retrieval separately
from answer generation so you can tell whether failures came from finding the
context or reasoning over it.

Next: [Search and filter](../guides/search.md).
