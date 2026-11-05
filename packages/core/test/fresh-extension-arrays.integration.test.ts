import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import { ensureExtensions } from "../src/db/extensions.ts";
import { ExtensionError } from "../src/errors.ts";
import { openIndex } from "../src/open-index.ts";
import {
  connect,
  connectToDatabase,
  createTestDatabase,
  dropTestDatabase,
  randomTestDatabase,
} from "./support/db.ts";

/**
 * Regression: postgres.js caches custom array serializers when a connection
 * starts. createIndex may install ltree/vector after that discovery has run, so
 * a bare JS array sent on the same connection degrades to `a,b` instead of a
 * PostgreSQL array literal. A one-connection pool makes that sequence
 * deterministic and also proves a prepared statement can be reused.
 */
test("batch writes work when createIndex installs extension array types on the same connection", async () => {
  const admin = connect();
  const database = randomTestDatabase();
  let indexSql: Sql | undefined;

  try {
    await createTestDatabase(admin, database);
    indexSql = connectToDatabase(database, 1);

    // Open the only pool connection before the extension types exist. This
    // freezes postgres.js's initial array-type map without ltree[]/halfvec[].
    const installed = await indexSql<{ readonly extname: string }[]>`
      select extname
      from pg_catalog.pg_extension
      where extname in ('vector', 'pg_textsearch', 'ltree')
    `;
    assert.deepEqual(Array.from(installed), []);

    // createIndex does not install extensions itself; it requires them to be
    // installed first via ensureExtensions (or administrative setup).
    await assert.rejects(
      () => createIndex(indexSql!, "docs", { dimensions: 4 }),
      (error: unknown) => {
        assert.ok(error instanceof ExtensionError);
        assert.equal(error.reason, "missing");
        return true;
      },
    );

    await ensureExtensions(indexSql);
    await createIndex(indexSql, "docs", { dimensions: 4 });
    const index = await openIndex(indexSql, "docs", {
      embedding: "mock-embedding",
    });

    const first = await index.upsertMany([
      {
        content: "Auth tokens rotate daily.",
        tree: "docs.auth",
        temporal: ["2026-01-01T00:00:00Z"],
        embedding: [1, 0, 0, 0],
      },
      {
        content: "Rate limits apply per API key.",
        tree: "docs.api",
        name: "rate-limit",
        temporal: ["2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"],
      },
      {
        content: "Backups are retained for thirty days.",
        tree: "docs.ops",
      },
    ]);
    assert.deepEqual(
      first.map((result) => result.status),
      ["inserted", "inserted", "inserted"],
    );

    // Reuse the prepared batch statement and exercise text-array escaping.
    const second = await index.upsertMany([
      {
        content: 'Cache keys may contain commas, quotes " and backslashes \\.',
        tree: "docs.cache",
        name: 'key,"primary\\name',
        embedding: [0, 1, 0, 0],
      },
    ]);
    assert.equal(second[0]?.status, "inserted");

    const rows = await indexSql<
      {
        readonly content: string;
        readonly tree: string;
        readonly name: string | null;
        readonly temporal: string | null;
        readonly embedding: string | null;
      }[]
    >`
      select content, tree::text as tree, name, temporal, embedding
      from docs.record
      order by tree
    `;
    assert.deepEqual(
      rows.map((row) => row.tree),
      ["docs.api", "docs.auth", "docs.cache", "docs.ops"],
    );
    assert.equal(rows[0]?.name, "rate-limit");
    assert.ok(rows[0]?.temporal);
    assert.equal(rows[0]?.embedding, null);
    assert.equal(rows[1]?.name, null);
    assert.ok(rows[1]?.temporal);
    assert.equal(rows[1]?.embedding, "[1,0,0,0]");
    assert.equal(rows[2]?.name, 'key,"primary\\name');
    assert.equal(
      rows[2]?.content,
      'Cache keys may contain commas, quotes " and backslashes \\.',
    );
    assert.equal(rows[2]?.embedding, "[0,1,0,0]");
    assert.equal(rows[3]?.name, null);
    assert.equal(rows[3]?.temporal, null);
    assert.equal(rows[3]?.embedding, null);

    // The alternate pgvector storage type uses a distinct array cast path.
    await createIndex(indexSql, "docs_vector", {
      dimensions: 4,
      vectorType: "vector",
    });
    const vectorIndex = await openIndex(indexSql, "docs_vector", {
      embedding: "mock-embedding",
    });
    const vectorResult = await vectorIndex.upsert({
      content: "Full precision vector.",
      tree: "docs.vectors",
      embedding: [0, 0, 1, 0],
    });
    const [vectorRow] = await indexSql<{ readonly embedding: string | null }[]>`
      select embedding
      from docs_vector.record
      where id = ${vectorResult.id}
    `;
    assert.equal(vectorRow?.embedding, "[0,0,1,0]");
  } finally {
    await indexSql?.end();
    await dropTestDatabase(admin, database);
    await admin.end();
  }
});
