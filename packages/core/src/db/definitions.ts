/// <reference path="../sql.d.ts" />
import type postgres from "postgres";
import { runSql, type SqlOperation } from "../sql/exec.ts";
import createEmbeddingQueue from "./sql/queue/embedding-queue.sql" with {
  type: "text",
};
import createEmbeddingQueueArchiveIndex from "./sql/queue/embedding-queue-archive-index.sql" with {
  type: "text",
};
import createEmbeddingQueueClaimIndex from "./sql/queue/embedding-queue-claim-index.sql" with {
  type: "text",
};
import createEmbeddingQueueRecordIdIndex from "./sql/queue/embedding-queue-record-id-index.sql" with {
  type: "text",
};
import createEmbeddingQueueRecordIndex from "./sql/queue/embedding-queue-record-index.sql" with {
  type: "text",
};
import createRecordBm25Index from "./sql/records/record-bm25-index.sql" with {
  type: "text",
};
import createRecordHnswIndex from "./sql/records/record-hnsw-index.sql" with {
  type: "text",
};
import createRecordMetaIndex from "./sql/records/record-meta-index.sql" with {
  type: "text",
};
import createRecordNameIndex from "./sql/records/record-name-index.sql" with {
  type: "text",
};
import createRecordTable from "./sql/records/record-table.sql" with {
  type: "text",
};
import createRecordTemporalBoundsConventionCheck from "./sql/records/record-temporal-bounds-convention-check.sql" with {
  type: "text",
};
import createRecordTemporalIndex from "./sql/records/record-temporal-index.sql" with {
  type: "text",
};
import createRecordTreeIndex from "./sql/records/record-tree-index.sql" with {
  type: "text",
};
import createBatchUpsertFunction from "./sql/routines/batch-upsert.sql" with {
  type: "text",
};
import createDeleteRecordFunction from "./sql/routines/records/delete-record.sql" with {
  type: "text",
};
import createDeleteRecordByNameFunction from "./sql/routines/records/delete-record-by-name.sql" with {
  type: "text",
};
import createGetRecordFunction from "./sql/routines/records/get-record.sql" with {
  type: "text",
};
import createGetRecordByNameFunction from "./sql/routines/records/get-record-by-name.sql" with {
  type: "text",
};
import createPatchRecordFunction from "./sql/routines/records/patch-record.sql" with {
  type: "text",
};
import createAnalyzeFilterFunction from "./sql/routines/search/analyze-filter.sql" with {
  type: "text",
};
import createCompileFilterFunction from "./sql/routines/search/compile-filter.sql" with {
  type: "text",
};
import createHybridSearchRecordsFunction from "./sql/routines/search/hybrid-search-records.sql" with {
  type: "text",
};
import createSearchRecordsFunction from "./sql/routines/search/search-records.sql" with {
  type: "text",
};
import createCopyTreeFunction from "./sql/routines/tree/copy-tree.sql" with {
  type: "text",
};
import createCountTreeLqueryFunction from "./sql/routines/tree/count-tree-lquery.sql" with {
  type: "text",
};
import createCountTreeLtreeFunction from "./sql/routines/tree/count-tree-ltree.sql" with {
  type: "text",
};
import createCountTreeLtxtqueryFunction from "./sql/routines/tree/count-tree-ltxtquery.sql" with {
  type: "text",
};
import createDeleteTreeFunction from "./sql/routines/tree/delete-tree.sql" with {
  type: "text",
};
import createListTreeFunction from "./sql/routines/tree/list-tree.sql" with {
  type: "text",
};
import createMoveTreeFunction from "./sql/routines/tree/move-tree.sql" with {
  type: "text",
};
import createTreeViewFunction from "./sql/routines/tree/tree-view.sql" with {
  type: "text",
};
import commentIndexSchema from "./sql/schema/comment-index-schema.sql" with {
  type: "text",
};
import createIndexSchema from "./sql/schema/index-schema.sql" with {
  type: "text",
};
import createSchemaVersionSingletonIndex from "./sql/schema/schema-version-singleton-index.sql" with {
  type: "text",
};
import createSchemaVersionTable from "./sql/schema/schema-version-table.sql" with {
  type: "text",
};
import createEmbeddingEnqueueFunction from "./sql/triggers/embedding-enqueue.sql" with {
  type: "text",
};
import createRecordEmbeddingInputEnqueueTrigger from "./sql/triggers/record-embedding-input-enqueue-trigger.sql" with {
  type: "text",
};
import createRecordInsertEnqueueTrigger from "./sql/triggers/record-insert-enqueue-trigger.sql" with {
  type: "text",
};
import createRecordIntegrityFunction from "./sql/triggers/record-integrity.sql" with {
  type: "text",
};
import createRecordIntegrityTrigger from "./sql/triggers/record-integrity-trigger.sql" with {
  type: "text",
};
import { type IndexSqlContext, renderSql } from "./template.ts";

export interface SqlDefinition {
  readonly sql: string;
  readonly source: string;
  readonly spanName: string;
  readonly dbOperationName: SqlOperation["dbOperationName"];
}

// Explicit dependency order, matching the original format-2 provisioning pass.
export const schemaDefinitions: readonly SqlDefinition[] = [
  {
    sql: createIndexSchema,
    source: "schema/index-schema.sql",
    spanName: "createIndexSchema",
    dbOperationName: "CREATE",
  },
  {
    sql: commentIndexSchema,
    source: "schema/comment-index-schema.sql",
    spanName: "commentIndexSchema",
    dbOperationName: "COMMENT",
  },
];

export const indexDefinitions: readonly SqlDefinition[] = [
  {
    sql: createSchemaVersionTable,
    source: "schema/schema-version-table.sql",
    spanName: "createSchemaVersionTable",
    dbOperationName: "CREATE",
  },
  {
    sql: createSchemaVersionSingletonIndex,
    source: "schema/schema-version-singleton-index.sql",
    spanName: "createSchemaVersionSingletonIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordTable,
    source: "records/record-table.sql",
    spanName: "createRecordTable",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordTemporalBoundsConventionCheck,
    source: "records/record-temporal-bounds-convention-check.sql",
    spanName: "createRecordTemporalBoundsConventionCheck",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordMetaIndex,
    source: "records/record-meta-index.sql",
    spanName: "createRecordMetaIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordTemporalIndex,
    source: "records/record-temporal-index.sql",
    spanName: "createRecordTemporalIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordBm25Index,
    source: "records/record-bm25-index.sql",
    spanName: "createRecordBm25Index",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordHnswIndex,
    source: "records/record-hnsw-index.sql",
    spanName: "createRecordHnswIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordTreeIndex,
    source: "records/record-tree-index.sql",
    spanName: "createRecordTreeIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordNameIndex,
    source: "records/record-name-index.sql",
    spanName: "createRecordNameIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createEmbeddingQueue,
    source: "queue/embedding-queue.sql",
    spanName: "createEmbeddingQueue",
    dbOperationName: "CREATE",
  },
  {
    sql: createEmbeddingQueueClaimIndex,
    source: "queue/embedding-queue-claim-index.sql",
    spanName: "createEmbeddingQueueClaimIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createEmbeddingQueueRecordIndex,
    source: "queue/embedding-queue-record-index.sql",
    spanName: "createEmbeddingQueueRecordIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createEmbeddingQueueArchiveIndex,
    source: "queue/embedding-queue-archive-index.sql",
    spanName: "createEmbeddingQueueArchiveIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createEmbeddingQueueRecordIdIndex,
    source: "queue/embedding-queue-record-id-index.sql",
    spanName: "createEmbeddingQueueRecordIdIndex",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordIntegrityFunction,
    source: "triggers/record-integrity.sql",
    spanName: "createRecordIntegrityFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordIntegrityTrigger,
    source: "triggers/record-integrity-trigger.sql",
    spanName: "createRecordIntegrityTrigger",
    dbOperationName: "CREATE",
  },
  {
    sql: createEmbeddingEnqueueFunction,
    source: "triggers/embedding-enqueue.sql",
    spanName: "createEmbeddingEnqueueFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordInsertEnqueueTrigger,
    source: "triggers/record-insert-enqueue-trigger.sql",
    spanName: "createRecordInsertEnqueueTrigger",
    dbOperationName: "CREATE",
  },
  {
    sql: createRecordEmbeddingInputEnqueueTrigger,
    source: "triggers/record-embedding-input-enqueue-trigger.sql",
    spanName: "createRecordEmbeddingInputEnqueueTrigger",
    dbOperationName: "CREATE",
  },
  {
    sql: createBatchUpsertFunction,
    source: "routines/batch-upsert.sql",
    spanName: "createBatchUpsertFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createGetRecordFunction,
    source: "routines/records/get-record.sql",
    spanName: "createGetRecordFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createGetRecordByNameFunction,
    source: "routines/records/get-record-by-name.sql",
    spanName: "createGetRecordByNameFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createPatchRecordFunction,
    source: "routines/records/patch-record.sql",
    spanName: "createPatchRecordFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createDeleteRecordFunction,
    source: "routines/records/delete-record.sql",
    spanName: "createDeleteRecordFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createDeleteRecordByNameFunction,
    source: "routines/records/delete-record-by-name.sql",
    spanName: "createDeleteRecordByNameFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createMoveTreeFunction,
    source: "routines/tree/move-tree.sql",
    spanName: "createMoveTreeFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createCopyTreeFunction,
    source: "routines/tree/copy-tree.sql",
    spanName: "createCopyTreeFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createDeleteTreeFunction,
    source: "routines/tree/delete-tree.sql",
    spanName: "createDeleteTreeFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createCountTreeLtreeFunction,
    source: "routines/tree/count-tree-ltree.sql",
    spanName: "createCountTreeLtreeFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createCountTreeLqueryFunction,
    source: "routines/tree/count-tree-lquery.sql",
    spanName: "createCountTreeLqueryFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createCountTreeLtxtqueryFunction,
    source: "routines/tree/count-tree-ltxtquery.sql",
    spanName: "createCountTreeLtxtqueryFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createTreeViewFunction,
    source: "routines/tree/tree-view.sql",
    spanName: "createTreeViewFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createListTreeFunction,
    source: "routines/tree/list-tree.sql",
    spanName: "createListTreeFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createCompileFilterFunction,
    source: "routines/search/compile-filter.sql",
    spanName: "createCompileFilterFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createAnalyzeFilterFunction,
    source: "routines/search/analyze-filter.sql",
    spanName: "createAnalyzeFilterFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createSearchRecordsFunction,
    source: "routines/search/search-records.sql",
    spanName: "createSearchRecordsFunction",
    dbOperationName: "CREATE",
  },
  {
    sql: createHybridSearchRecordsFunction,
    source: "routines/search/hybrid-search-records.sql",
    spanName: "createHybridSearchRecordsFunction",
    dbOperationName: "CREATE",
  },
];

export async function executeDefinitions(
  tx: postgres.TransactionSql,
  context: IndexSqlContext,
  definitions: readonly SqlDefinition[],
): Promise<void> {
  for (const definition of definitions) {
    await runSql(tx.unsafe(renderSql(definition.sql, context.variables)), {
      spanName: definition.spanName,
      dbOperationName: definition.dbOperationName,
      namespace: context.schema,
    });
  }
}
