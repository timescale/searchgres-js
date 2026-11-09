import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Sql } from "postgres";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";
import { controllableEmbeddingModel } from "./support/embedding.ts";

let sql: Sql;
let createIndex: typeof import("../src/create-index.ts").createIndex;
let migrateIndex: typeof import("../src/migrate-index.ts").migrateIndex;
let openIndex: typeof import("../src/open-index.ts").openIndex;
let dropIndex: typeof import("../src/drop-index.ts").dropIndex;
const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

before(async () => {
  trace.disable();
  context.disable();
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
  ({ createIndex } = await import("../src/create-index.ts"));
  ({ migrateIndex } = await import("../src/migrate-index.ts"));
  ({ openIndex } = await import("../src/open-index.ts"));
  ({ dropIndex } = await import("../src/drop-index.ts"));
  sql = connect();
});

after(async () => {
  await sql.end();
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
});

function operation(name: string) {
  return exporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.instrumentationScope.name === "searchgres" && span.name === name,
    );
}

function sqlChildren(parentSpanId: string) {
  return exporter
    .getFinishedSpans()
    .filter(
      (span) =>
        span.instrumentationScope.name === "searchgres/sql" &&
        span.parentSpanContext?.spanId === parentSpanId,
    );
}

test("index lifecycle spans parent their SQL and expose index shape", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    await provider.forceFlush();

    const created = operation("searchgres.index.create");
    assert.ok(created);
    assert.equal(created.attributes["searchgres.index.schema"], schema);
    assert.equal(created.attributes["searchgres.index.vector_type"], "halfvec");
    assert.equal(created.attributes["searchgres.index.dimensions"], 4);
    const createSql = sqlChildren(created.spanContext().spanId);
    assert.ok(createSql.length > 5, "create operation did not parent its SQL");
    assert.ok(createSql.every((span) => span.kind === SpanKind.CLIENT));
    const { bootstrapMigrations, idempotentMigrations, incrementalMigrations } =
      await import("../src/db/definitions.ts");
    const allMigrations = [
      ...bootstrapMigrations,
      ...incrementalMigrations,
      ...idempotentMigrations,
    ];
    for (const migration of allMigrations) {
      const statement = createSql.find(
        (span) => span.name === `${migration.type}:${migration.name}`,
      );
      assert.ok(statement, migration.file);
      assert.equal(statement.attributes["db.operation.name"], "CREATE");
      assert.equal(statement.attributes["db.namespace"], schema);
      assert.equal(
        statement.attributes["searchgres.migration.name"],
        migration.name,
      );
      assert.equal(
        statement.attributes["searchgres.migration.file"],
        migration.file,
      );
      assert.equal(
        statement.attributes["searchgres.migration.type"],
        migration.type,
      );
      assert.equal(
        statement.attributes["searchgres.migration.schema_version"],
        "3",
      );
      const text = statement.attributes["db.query.text"];
      assert.equal(typeof text, "string");
      assert.ok(String(text).length > 0, migration.file);
      assert.ok(!String(text).includes("{{"), migration.file);
    }

    exporter.reset();
    await migrateIndex(sql, schema);
    await provider.forceFlush();
    const migrated = operation("searchgres.index.migrate");
    assert.ok(migrated);
    assert.equal(migrated.attributes["searchgres.index.schema"], schema);
    assert.equal(
      migrated.attributes["searchgres.index.vector_type"],
      "halfvec",
    );
    assert.equal(migrated.attributes["searchgres.index.dimensions"], 4);
    const migrateSql = sqlChildren(migrated.spanContext().spanId);
    assert.ok(
      migrateSql.length > 5,
      "migrate operation did not parent its SQL",
    );
    for (const migration of idempotentMigrations) {
      const statement = migrateSql.find(
        (span) => span.name === `idempotent:${migration.name}`,
      );
      assert.ok(statement, migration.file);
      assert.equal(
        statement.attributes["searchgres.migration.file"],
        migration.file,
      );
      assert.equal(
        statement.attributes["searchgres.migration.type"],
        "idempotent",
      );
    }

    exporter.reset();
    await openIndex(sql, schema, { embedding: controllableEmbeddingModel() });
    await provider.forceFlush();
    const opened = operation("searchgres.index.open");
    assert.ok(opened);
    assert.equal(opened.attributes["searchgres.index.schema"], schema);
    assert.equal(opened.attributes["searchgres.index.vector_type"], "halfvec");
    assert.equal(opened.attributes["searchgres.index.dimensions"], 4);
    assert.ok(
      sqlChildren(opened.spanContext().spanId).length > 2,
      "open operation did not parent its SQL",
    );

    exporter.reset();
    await dropIndex(sql, schema);
    await provider.forceFlush();
    const dropped = operation("searchgres.index.drop");
    assert.ok(dropped);
    assert.ok(
      sqlChildren(dropped.spanContext().spanId).length > 1,
      "drop operation did not parent its verification and DDL",
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("unsafe migration failures retain SQL text, migration file metadata, line/column location, error status and typed timeout mapping", async () => {
  const { defineMigration, executeMigrationFile } = await import(
    "../src/db/definitions.ts"
  );
  const { indexSqlContext } = await import("../src/db/template.ts");
  const { StatementTimeoutError } = await import("../src/errors.ts");
  const schema = randomTestSchema();
  const context = indexSqlContext(schema, { dimensions: 4 }, "'english'");
  const statement = "select pg_catalog.pg_sleep(1)";
  exporter.reset();
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`set local statement_timeout = '20ms'`;
      await executeMigrationFile(
        tx,
        context,
        defineMigration("idempotent", "idempotent/999_timeout.sql", statement),
        "3",
      );
    }),
    StatementTimeoutError,
  );
  await provider.forceFlush();
  const failed = exporter
    .getFinishedSpans()
    .find((span) => span.name === "idempotent:999_timeout");
  assert.ok(failed);
  assert.equal(failed.instrumentationScope.name, "searchgres/sql");
  assert.equal(failed.attributes["db.query.text"], statement);
  assert.equal(failed.attributes["db.namespace"], schema);
  assert.equal(
    failed.attributes["searchgres.migration.file"],
    "idempotent/999_timeout.sql",
  );
  assert.equal(failed.attributes["searchgres.migration.type"], "idempotent");
  assert.equal(failed.status.code, SpanStatusCode.ERROR);
  assert.ok(failed.events.some((event) => event.name === "exception"));

  exporter.reset();
  const syntaxSql = "select 1;\nselect * from\n  pg_catalog.no_such_relation;";
  await assert.rejects(
    sql.begin(async (tx) => {
      await executeMigrationFile(
        tx,
        context,
        defineMigration("incremental", "incremental/999_syntax.sql", syntaxSql),
        "3",
      );
    }),
  );
  await provider.forceFlush();
  const located = exporter
    .getFinishedSpans()
    .find((span) => span.name === "incremental:999_syntax");
  assert.ok(located);
  assert.equal(
    located.attributes["searchgres.migration.file"],
    "incremental/999_syntax.sql",
  );
  assert.equal(located.attributes["searchgres.sql.line"], 3);
  assert.equal(located.attributes["searchgres.sql.column"], 3);
});

test("public index operations emit one domain span with safe useful attributes", async () => {
  const schema = randomTestSchema();
  const id = "019571e2-7c00-7000-8000-000000000001";
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, {
      embedding: controllableEmbeddingModel(),
    });
    exporter.reset();

    await index.upsert({
      id,
      content: "private upsert content",
      tree: "docs",
      name: "one",
    });
    await index.upsertMany([{ content: "many", tree: "docs.many" }]);
    await index.insert({ content: "insert", tree: "inserted" });
    await index.insertMany([{ content: "insert many", tree: "inserted.many" }]);
    const record = await index.get(id);
    await index.getByName("docs", "one");
    await index.patch(id, record.versionHash, {
      content: "private patched content",
    });
    await index.search({ filter: { tree: "docs" } });
    await index.moveTree("docs", "moved", { dryRun: true });
    await index.copyTree("docs", "copied", { dryRun: true });
    await index.deleteTree("docs", { dryRun: true });
    await index.countTree({ tree: "docs" });
    await index.listTree("docs.*");
    await index.treeView("docs");
    await index.processEmbeddings({ maxBatches: 1 });
    await index.queueStats();
    await index.listEmbeddingFailures();
    await index.retryEmbeddingFailures({ queueIds: ["999999999"] });
    await index.pruneEmbeddingQueue({ retentionMs: 1 });
    await index.delete(id);
    await index.upsert({
      content: "delete by name",
      tree: "temp",
      name: "named",
    });
    await index.deleteByName("temp", "named");
    const many = await index.upsertMany([
      { content: "delete many one", tree: "temp" },
      { content: "delete many two", tree: "temp" },
    ]);
    await index.deleteMany(many.map((result) => result.id));

    const appTracer = trace.getTracer("test/application");
    await sql.begin(async (tx) => {
      await appTracer.startActiveSpan("caller.transaction", async (parent) => {
        try {
          await index.with(tx).countTree({ tree: "docs" });
        } finally {
          parent.end();
        }
      });
    });

    await assert.rejects(() => index.get("not-a-uuid"));
    await index.drop();
    await provider.forceFlush();

    const names = [
      "searchgres.record.upsert",
      "searchgres.record.upsert_many",
      "searchgres.record.insert",
      "searchgres.record.insert_many",
      "searchgres.record.get_by_name",
      "searchgres.record.patch",
      "searchgres.search",
      "searchgres.tree.move",
      "searchgres.tree.copy",
      "searchgres.tree.delete",
      "searchgres.tree.list",
      "searchgres.tree.view",
      "searchgres.embedding.process",
      "searchgres.embedding.queue.stats",
      "searchgres.embedding.failure.list",
      "searchgres.embedding.failure.retry",
      "searchgres.embedding.queue.prune",
      "searchgres.record.delete",
      "searchgres.record.delete_by_name",
      "searchgres.record.delete_many",
      "searchgres.index.drop",
    ];
    for (const name of names) {
      assert.ok(operation(name), `missing operation span ${name}`);
    }

    const upserted = operation("searchgres.record.upsert");
    assert.equal(upserted?.attributes["searchgres.index.schema"], schema);
    assert.equal(upserted?.attributes["searchgres.record.id"], id);
    assert.equal(upserted?.attributes["searchgres.batch.size"], 1);
    assert.equal(upserted?.attributes["searchgres.result.count"], 1);

    const deletedMany = operation("searchgres.record.delete_many");
    assert.equal(deletedMany?.attributes["searchgres.batch.size"], 2);
    assert.equal(deletedMany?.attributes["searchgres.result.count"], 2);

    const moved = operation("searchgres.tree.move");
    assert.equal(moved?.attributes["searchgres.tree.dry_run"], true);

    const searched = operation("searchgres.search");
    assert.equal(searched?.attributes["searchgres.search.mode"], "filter");
    assert.equal(searched?.attributes["searchgres.search.has_filter"], true);
    assert.ok(searched);
    assert.ok(
      sqlChildren(searched.spanContext().spanId).length > 0,
      "search operation did not parent its SQL",
    );

    const processed = operation("searchgres.embedding.process");
    const generated = operation("searchgres.embedding.generate");
    assert.ok(processed);
    assert.equal(
      generated?.parentSpanContext?.spanId,
      processed.spanContext().spanId,
      "embedding generation was not a process sub-operation",
    );

    const inserted = operation("searchgres.record.insert");
    assert.equal(
      inserted?.parentSpanContext,
      undefined,
      "insert exposed nested public-operation implementation details",
    );

    const allAttributes = exporter
      .getFinishedSpans()
      .filter((span) => span.instrumentationScope.name === "searchgres")
      .map((span) => JSON.stringify(span.attributes))
      .join("\n");
    assert.doesNotMatch(allAttributes, /private upsert content/);
    assert.doesNotMatch(allAttributes, /private patched content/);
    assert.doesNotMatch(allAttributes, /docs\.\*/);

    const failedGet = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "searchgres.record.get")
      .find((span) => span.status.code === SpanStatusCode.ERROR);
    assert.ok(failedGet);
    assert.equal(failedGet.attributes["error.type"], "InvalidInputError");
    assert.equal(
      failedGet.attributes["searchgres.error.code"],
      "INVALID_INPUT",
    );
    assert.equal(failedGet.attributes["searchgres.record.id"], undefined);
    assert.ok(failedGet.events.some((event) => event.name === "exception"));

    const parent = exporter
      .getFinishedSpans()
      .find((span) => span.name === "caller.transaction");
    const transactionCount = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "searchgres.tree.count")
      .find(
        (span) =>
          span.parentSpanContext?.spanId === parent?.spanContext().spanId,
      );
    assert.ok(parent);
    assert.ok(transactionCount, "transaction operation lost caller context");
    assert.ok(
      sqlChildren(transactionCount.spanContext().spanId).length > 0,
      "transaction operation did not parent its SQL",
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});
