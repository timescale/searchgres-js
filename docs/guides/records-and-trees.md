# Manage records and trees

Beyond writing and searching, an index handle can read individual records, patch
them safely, delete them, and operate on whole subtrees.

## Read a record

By id, or by its `(tree, name)` address. Both return the full record and throw
[`NotFoundError`](../reference/errors.md) if it doesn't exist.

```ts
const byId = await index.get("019ce89d-f8b4-7000-8000-000000000001");
const byName = await index.getByName("docs.api", "rate-limits");
```

## Patch a record

`patch` is optimistic: pass the `versionHash` you last read. It returns the
updated record.

```ts
const current = await index.get(id);

const updated = await index.patch(id, current.versionHash, {
  content: "Rate limits are 200 requests per minute.",
  meta: { source: "runbook", version: 4 },
});
```

You can change `content`, `meta`, `tree`, `name`, and `temporal`, and supply a
replacement `embedding`. Omit a field to leave it unchanged; set `name` or
`temporal` to `null` to clear it. `tree` can't be null.

Recover from a concurrent change by re-reading and retrying:

```ts
import { StaleVersionError, NotFoundError } from "searchgres";

try {
  await index.patch(id, versionHash, { content });
} catch (error) {
  if (error instanceof StaleVersionError) {
    const fresh = await index.get(id);
    await index.patch(id, fresh.versionHash, { content });
  } else if (error instanceof NotFoundError) {
    // the record was deleted
  } else {
    throw error;
  }
}
```

Renaming or moving a record onto an occupied `(tree, name)` slot throws
[`ConflictError`](../reference/errors.md).

## Delete a record

```ts
await index.delete(id);
await index.deleteByName("docs.api", "rate-limits");
```

Both throw `NotFoundError` when nothing matched. Deleting a record also removes
any queued embedding work for it.

## Subtree operations

Tree paths are raw dotted `ltree`. These operations are inclusive — they act on
the given path and everything under it — and return the number of records
affected.

```ts
await index.moveTree("drafts", "published");    // rewrite the prefix in place
await index.copyTree("templates", "docs.new");  // duplicate as fresh records
await index.deleteTree("scratch");              // delete the subtree
```

Preview any of them without changing data:

```ts
const { count } = await index.deleteTree("scratch", { dryRun: true });
```

Notes:

- An empty subtree returns `{ count: 0 }` — it is not an error.
- `copyTree` gives each copy a fresh id and re-runs the embedding rules: a copied
  non-null vector is preserved as-is; a copy with no vector is queued for
  embedding. The source is left untouched.
- If a move or copy would land a record on an occupied `(tree, name)` slot, the
  whole operation rolls back with [`ConflictError`](../reference/errors.md).

### Count and list

`countTree` takes exactly one filter kind and an optional cap:

```ts
await index.countTree({ tree: "docs.api" });       // { count, capped }
await index.countTree({ lquery: "docs.*.api" });
await index.countTree({ ltxtquery: "api & v2" });

const capped = await index.countTree({ tree: "docs" }, { limit: 1000 });
// capped.capped === true means there are at least 1000; count is a lower bound.
```

`listTree` matches the lquery against each record's own tree path, not against
the set of tree nodes. For every matching record, it returns the record's path
and all of its ancestor paths (not the root), each with the number of matching
records at or under that node:

```ts
for (const { tree, count } of await index.listTree("docs.*")) {
  console.log(tree, count);
}
```

Records that do not match are not counted anywhere, and records at the root
(`""`) never appear. For example, if every record under `docs` is two levels
deep (`docs.api.auth`, `docs.guide.intro`), `listTree("docs.*{1}")` returns
`[]`: no record path is exactly one level below `docs`.

To browse the children of a node, use `treeView` with `levels: 1`. It returns
the node itself and its direct children, each with the count of all records at
or under it:

```ts
await index.treeView("docs", { levels: 1 });
// [{ tree: "docs", count: 2 }, { tree: "docs.api", count: 1 },
//  { tree: "docs.guide", count: 1 }]
```

## Compose in a transaction

`index.with(tx)` binds record and tree operations to a transaction you own, so
they commit or roll back together:

```ts
await sql.begin(async (tx) => {
  const t = index.with(tx);

  const head = await t.get(id);
  await t.patch(id, head.versionHash, { content: "updated" });
  await t.moveTree("drafts", "published");
});
```

The handle `with(tx)` returns exposes reads, writes, search, and tree operations.
It deliberately excludes the embedding-drain and queue methods
(`processEmbeddings`, `startEmbeddingWorker`, `queueStats`,
`pruneEmbeddingQueue`): the worker runs its own short transactions around remote
provider calls and must not be tied to — or outlive — your transaction. You own
the commit, the rollback, and the pool.

`search` is on the handle, but `search({ semantic })` has the same shape as the
excluded methods: it calls the embedding model with your transaction open,
pinning its connection — and any row locks you have taken — for the duration of
a network round trip, and a provider failure aborts your transaction. Embed the
query text before you begin and pass `vector` inside:

```ts
import { embed } from "ai";

const { embedding } = await embed({ model, value: "rate limiting" });

await sql.begin(async (tx) => {
  const t = index.with(tx);
  const hits = await t.search({ vector: embedding, filter: { tree: "docs" } });
  // ...act on hits atomically with other writes
});
```

`fulltext` and filter-only searches stay entirely in the database and are fine
as-is. If your `EmbeddingModel` is local (in-process or on the same host), the
concern shrinks to that model's latency and you may reasonably use `semantic`.

Next: [Run in production](production.md).
