# Ingest records

A record is one unit of searchable content—one caller-defined chunk, fact,
summary, event, or other textual unit. searchgres.js does not split or transform
source material for you; your application decides what representations to
index. See [Model records](../concepts/record-model.md) for design guidance.

## Write one record

```ts
const result = await index.upsert({
  content: "Authentication tokens rotate every 24 hours.",
  tree: "docs.auth",
  name: "token-rotation",
  meta: { source: "runbook", version: 3 },
});

result; // { id: "019ce89d-...", status: "inserted" }
```

## Write a batch

`upsertMany` writes up to 1,000 records in a single round trip and returns one
result per input, in order:

```ts
const results = await index.upsertMany([
  { content: "First chunk", tree: "docs.guide" },
  { content: "Second chunk", tree: "docs.guide" },
]);

for (const { id, status } of results) {
  console.log(id, status); // status: "inserted" | "updated" | "skipped"
}
```

Batches over 1,000 throw [`BatchTooLargeError`](../reference/errors.md); chunk
your input and call again.

## The record fields

```ts
type UpsertRecord = {
  content: string;                    // required, non-empty — the searchable text
  tree?: string;                      // dotted ltree path; defaults to root ""
  name?: string | null;               // optional non-empty leaf name, unique within a tree
  meta?: Record<string, unknown>;     // arbitrary JSON, filterable
  temporal?:                          // a point in time, or a half-open interval
    | readonly [Date | string]
    | readonly [Date | string, Date | string];
  id?: string;                        // optional UUIDv7 (generated if omitted)
  embedding?: readonly number[];      // optional precomputed vector
};
```

- **`content`** is the text that gets embedded and BM25-indexed. It must be
  non-empty: providers reject empty input, so an empty record could never be
  embedded and is refused with `InvalidInputError` instead.
- **`tree`** is a raw dotted `ltree` path such as `docs.api.auth`. Each label is
  `[A-Za-z0-9_-]+`. The empty string `""` is the root. Use it to scope searches
  later (see [Search and filter](search.md)).
- **`name`** makes a record addressable by `(tree, name)` and is its idempotency
  key (see below). Set it to `null` (the default) for anonymous records; the
  empty string is rejected rather than treated as a name.
- **`meta`** is any JSON object; filter on it with containment or JSONPath.
- **`temporal`** stores represented time. A one-element tuple is a point stored as
  `[t, t]`; a two-element tuple is stored as the half-open interval `[start, end)`
  and requires `start < end`. Timestamp strings must include an offset or `Z`
  (e.g. `2026-01-01T00:00:00Z`); `Date` objects work too.
- **`id`** is generated as a UUIDv7 when omitted. A supplied id must be UUIDv7.
- **`embedding`** lets you supply a precomputed vector; see
  [Generate embeddings](embeddings.md).

## Conflicts and idempotency

The idempotency key is the record's `name` slot `(tree, name)` if it has a name,
otherwise its explicit `id`. An anonymous record (no name, no id) always inserts.

`onConflict` chooses what happens when that key already exists:

```ts
await index.upsert(record);                              // default: replace
await index.upsert(record, { onConflict: "error" });   // throw
await index.upsert(record, { onConflict: "ignore" });  // keep existing, skip
await index.upsert(record, { onConflict: "replace" }); // overwrite if changed

await index.insert(record);      // equivalent to upsert(..., { onConflict: "error" })
await index.insertMany(records); // same conflict behavior for a batch
```

- **`replace`** (default) updates in place, but only when a field actually
  differs; an identical replace reports `"skipped"`, so re-running an import is
  a no-op.
- **`error`** throws [`ConflictError`](../reference/errors.md) and rolls back the
  whole batch if any input conflicts. `insert` and `insertMany` always use it.
- **`ignore`** leaves the existing record and reports `"skipped"`.

### Idempotent document ingest

Give each source document a stable `(tree, name)` and use `replace`. Re-running
the import only rewrites what changed:

```ts
await index.upsertMany(
  chunks.map((chunk) => ({
    tree: `docs.${doc.slug}`,
    name: `chunk-${chunk.index}`,
    content: chunk.text,
    meta: { source: "docs", version: doc.version },
  })),
  { onConflict: "replace" },
);
```

### Remove records whose source is gone

`upsertMany` adds and updates records, but it does not remove a record whose
source document was deleted. To sync a subtree with its source, list the
records in that subtree with keyset pagination, compare their `(tree, name)`
keys with the source, and delete the rest with `deleteMany`:

```ts
// The (tree, name) keys of the current source chunks under `docs`.
const current = new Set(chunks.map((c) => `${c.tree}\u0000${c.name}`));

const stale: string[] = [];
let cursor: string | undefined;
for (;;) {
  const page = await index.search({
    filter: { tree: "docs" },
    order: "asc",
    limit: 1000,
    ...(cursor === undefined ? {} : { after: cursor }),
  });
  for (const record of page) {
    if (!current.has(`${record.tree}\u0000${record.name}`)) {
      stale.push(record.id);
    }
  }
  if (page.length < 1000) break;
  cursor = page.at(-1)?.id;
}

for (let i = 0; i < stale.length; i += 1000) {
  await index.deleteMany(stale.slice(i, i + 1000));
}
```

- The filter limits the sync to one subtree. Records outside it do not change.
- The recipe assumes that every record in the subtree has a stable
  `(tree, name)` from its source. A record without a name never matches a key,
  so the recipe deletes it.
- Run the upsert first, then this cleanup. A record that another process
  writes during the listing can be missed (it stays) or, if its key is not in
  `current`, deleted. If other writers share the subtree, coordinate the sync
  with them.
- If a whole subtree goes away, `deleteTree` removes it in one call.

### Import with stable ids

For migrations or cross-system identity, supply your own UUIDv7 ids. An unnamed
record keyed on its id is updated in place on `replace`:

```ts
await index.upsertMany(rows, { onConflict: "replace" });
```

Duplicate ids within a batch, duplicate `(tree, name)` keys, or a batch where an
id and a name resolve to the same existing record are rejected with
[`InvalidInputError`](../reference/errors.md) before anything is written.

## Index existing application data

searchgres.js operates on records in its managed index schema, but those records
can be projections of arbitrary existing tables. Populate them through:

- application jobs that read source rows and call `upsertMany()`;
- scheduled SQL that calls the schema-local `batch_upsert` routine;
- triggers on source tables;
- a change-data-capture consumer.

Writes performed through direct SQL still run the index's integrity and queue
triggers. If projected content has no vector, it enters the embedding queue just
like a library write. Keep remote embedding calls out of source-table triggers;
let a separate searchgres.js worker process the queue asynchronously.

See [Direct SQL](../reference/sql.md) for routine signatures.

## Store raw and derived records

Chunking, fact extraction, and summarization can happen before ingest. Preserve
raw evidence and organize representations explicitly:

```text
knowledge.raw.handbook.security
knowledge.summary.handbook.security
knowledge.facts.handbook.security
```

Use tree or metadata filters to select a representation. A second index is often
better when derived records require a different embedding model, dimensions, or
lifecycle.

## When is a record searchable?

Immediately for keyword and filter queries. For **semantic** search a record
needs its vector, which is generated asynchronously unless you supply one. After
a bulk ingest, drain the queue (or run a worker) before expecting semantic
results:

```ts
await index.upsertMany(records);
await index.processEmbeddings();
```

See [Generate embeddings](embeddings.md) for the full lifecycle, including
supplying precomputed vectors.

Next: [Generate embeddings](embeddings.md).
