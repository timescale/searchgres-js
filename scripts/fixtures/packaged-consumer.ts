import type postgres from "postgres";
import {
  createIndex,
  type Filter,
  Index,
  type IndexConfig,
  noEmbedding,
  normalizeIndexConfig,
  noTruncation,
  openIndex,
  type SearchOptions,
  type SearchResult,
  type StoredRecord,
  type TransactionIndex,
  type UpsertRecord,
  type UpsertResult,
} from "searchgres";

// Declaration-only qualification: importing this file never opens a pool or DB.
export async function consumerTypes(sql: postgres.Sql, schema: string) {
  const config = { dimensions: 4, vectorType: "halfvec" } satisfies IndexConfig;
  const normalized = normalizeIndexConfig(config);
  const dimensions: number = normalized.dimensions;
  const textConfig: string = normalized.bm25.textConfig;
  await createIndex(sql, schema, config);
  const index = await openIndex(sql, schema, { embedding: noEmbedding });
  const handle: Index = index;
  const record = {
    content: "artifact",
    embedding: [1, 0, 0, 0],
    meta: { kind: "fixture", nested: [true, null] },
  } satisfies UpsertRecord;
  const writes: readonly UpsertResult[] = await index.upsertMany([record]);
  const write = await index.upsert(record);
  const status: "inserted" | "updated" | "skipped" = write.status;
  const stored: StoredRecord = await index.get(write.id);
  const createdAt: Date = stored.createdAt;
  const filter = {
    and: [{ tree: "artifact.docs" }, { meta: { kind: "fixture" } }],
  } satisfies Filter;
  const options = {
    filter,
    fulltext: "artifact",
    vector: [1, 0, 0, 0],
    limit: 2,
  } satisfies SearchOptions;
  const results: readonly SearchResult[] = await index.search(options);
  const score: number | undefined = results[0]?.score;
  await sql.begin(async (tx) => {
    const scoped: TransactionIndex = index.with(tx);
    await scoped.search({ filter });
    await scoped.get(write.id);
  });

  // @ts-expect-error The caller-owned pool is an internal implementation detail.
  index.sql;
  // @ts-expect-error Construction is internal; consumers must use openIndex.
  new Index({
    sql,
    schema,
    dimensions: 4,
    vectorType: "vector",
    embedding: noEmbedding,
    truncate: noTruncation,
  });
  // @ts-expect-error Zod-derived inputs retain the vector-type union.
  normalizeIndexConfig({ dimensions: 4, vectorType: "float32" });
  // @ts-expect-error Zod-derived write inputs require string content.
  index.upsert({ content: 42 });
  // @ts-expect-error Search vectors contain numbers, not strings.
  index.search({ vector: ["1"] });
  // @ts-expect-error Search results retain a numeric score.
  const invalidScore: string = results[0]?.score;

  return {
    handle,
    dimensions,
    textConfig,
    writes,
    status,
    createdAt,
    score,
    invalidScore,
  };
}
