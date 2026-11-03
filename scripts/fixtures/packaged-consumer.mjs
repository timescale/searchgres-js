import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import * as library from "searchgres";
import {
  createIndex,
  dropIndex,
  InvalidConfigError,
  noEmbedding,
  normalizeIndexConfig,
  openIndex,
  SCHEMA_FORMAT_VERSION,
} from "searchgres";
import { sqlText } from "./sql-probe.js";

const { TEST_DATABASE_URL, SQL_PROBE_HASH } = process.env;
assert.ok(TEST_DATABASE_URL, "TEST_DATABASE_URL is required");
assert.ok(SQL_PROBE_HASH, "SQL_PROBE_HASH is required");
assert.ok(process.env.EXPECTED_EXPORTS, "EXPECTED_EXPORTS is required");
assert.deepEqual(
  Object.keys(library).sort(),
  JSON.parse(process.env.EXPECTED_EXPORTS),
);
assert.equal(
  createHash("sha256").update(sqlText).digest("hex"),
  SQL_PROBE_HASH,
);
assert.equal(SCHEMA_FORMAT_VERSION, "2");
assert.throws(
  () => normalizeIndexConfig({ dimensions: 0 }),
  (error) => error instanceof InvalidConfigError,
);

// One connection also exercises bulk array bindings after extension creation.
const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const probe = await sql.unsafe(sqlText).values();
  assert.deepEqual(
    probe.map((row) => [...row]),
    [["back\\slash", "it's SQL", "semi;colon"]],
  );

  for (const vectorType of ["vector", "halfvec"]) {
    const schema = `sgtest_artifact_${randomUUID().replaceAll("-", "")}`;
    let created = false;
    try {
      await createIndex(sql, schema, { dimensions: 4, vectorType });
      created = true;
      const index = await openIndex(sql, schema, { embedding: noEmbedding });
      assert.equal(index.schema, schema);
      assert.equal(index.dimensions, 4);
      assert.equal(index.vectorType, vectorType);
      const versions = await sql`select version from ${sql(schema)}.version`;
      assert.deepEqual(
        versions.map((row) => row.version),
        ["2"],
      );

      const content = "artifact café 雪 back\\slash 'quoted'";
      const written = await index.upsertMany([
        {
          content,
          tree: "artifact.docs",
          name: 'first,"\\雪',
          meta: { kind: "fixture", quoted: 'a,"\\雪' },
          embedding: [1, 0, 0, 0],
        },
        {
          content: "unrelated garden plants",
          tree: "artifact.other",
          name: "second",
          embedding: [0, 1, 0, 0],
        },
      ]);
      assert.equal(written.length, 2);
      assert.ok(written.every((result) => result.status === "inserted"));
      const first = written[0];
      assert.ok(first);
      const record = await index.get(first.id);
      assert.equal(record.content, content);
      assert.equal(record.hasEmbedding, true);
      assert.deepEqual(record.meta, { kind: "fixture", quoted: 'a,"\\雪' });

      const listed = await index.search({ filter: { tree: "artifact.docs" } });
      assert.deepEqual(
        listed.map((result) => result.id),
        [first.id],
      );
      assert.equal(listed[0]?.score, -1);
      const semantic = await index.search({
        vector: [1, 0, 0, 0],
        semanticThreshold: 0.9,
        limit: 2,
      });
      assert.deepEqual(
        semantic.map((result) => result.id),
        [first.id],
      );
      assert.ok(Math.abs(semantic[0].score - 1) < 0.001);
      for (const options of [
        { fulltext: "artifact" },
        { fulltext: "artifact", vector: [1, 0, 0, 0] },
      ]) {
        const results = await index.search({ ...options, limit: 2 });
        assert.equal(results[0]?.id, first.id);
        assert.ok(results[0].score > 0);
      }

      await index.drop();
      created = false;
      const [gone] = await sql`
        select not exists (
          select 1 from pg_catalog.pg_namespace where nspname = ${schema}
        ) as gone
      `;
      assert.equal(gone?.gone, true);
      const [alive] = await sql`select 1 as alive`;
      assert.equal(
        alive?.alive,
        1,
        "dropping an index must not close its pool",
      );
    } finally {
      // createIndex is transactional; never clean up a schema we did not create.
      if (created) await dropIndex(sql, schema);
    }
  }
} finally {
  await sql.end();
}
console.log("Packaged consumer passed (vector and halfvec).");
