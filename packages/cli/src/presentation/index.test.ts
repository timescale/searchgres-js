import assert from "node:assert/strict";
import test from "node:test";
import type { SearchResult, StoredRecord } from "searchgres";
import {
  parseSelection,
  presentQueueStats,
  presentRecord,
  presentTemporal,
  projectSearchEnvelope,
  projectSearchResult,
  projectStoredRecord,
} from "./index.ts";

const result: SearchResult = {
  id: "01900000-0000-7000-8000-000000000001",
  content: "A😀BCDéF",
  meta: { source: "docs", "build.id": 42, $thread: "thread-1" },
  tree: "docs.search",
  name: null,
  temporal: null,
  score: -1,
  hasEmbedding: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: null,
  version: "2",
  versionHash: "abc123",
};

const select = (value: string | readonly string[]) =>
  parseSelection(value, { kind: "search-result" });

test("projects every field in the selected order", () => {
  const order = [
    "versionHash",
    "score",
    "id",
    "content",
    "meta",
    "tree",
    "name",
    "temporal",
    "hasEmbedding",
    "createdAt",
    "updatedAt",
    "version",
  ];
  const projected = projectSearchResult(result, select(order));
  assert.deepEqual(projected, result);
  assert.deepEqual(Object.keys(projected), order);
  assert.deepEqual(
    Object.keys(
      projectSearchResult(
        result,
        select("score,tree,name,content:3,meta.source"),
      ),
    ),
    ["score", "tree", "name", "content", "contentLength", "meta"],
  );
});

test("supports Unicode content ranges from text and arrays", () => {
  assert.deepEqual(projectSearchResult(result, select("id,content:2")), {
    id: result.id,
    content: "A😀",
    contentLength: 8,
  });
  for (const [selector, content] of [
    ["content:2..5", "BCD"],
    ["content:5..", "éF"],
    ["content:..3", "A😀B"],
    ["content:-2..", "́F"],
    ["content:..-2", "A😀BCDe"],
    ["content:-5..-2", "CDe"],
  ] as const) {
    assert.deepEqual(projectSearchResult(result, select([selector])), {
      content,
      contentLength: 8,
    });
  }
});

test("selects exact metadata keys safely", () => {
  assert.deepEqual(
    projectSearchResult(result, select(["meta.$thread", "meta.build.id"])),
    { meta: { $thread: "thread-1", "build.id": 42 } },
  );
  const special = { ...result, meta: JSON.parse('{"__proto__":"safe"}') };
  assert.equal(
    JSON.stringify(projectSearchResult(special, select(["meta.__proto__"]))),
    '{"meta":{"__proto__":"safe"}}',
  );
});

test("full metadata wins and envelopes are retained", () => {
  assert.deepEqual(
    projectSearchEnvelope(
      { results: [result] },
      select(["meta.source", "meta", "score"]),
    ),
    { results: [{ meta: result.meta, score: -1 }] },
  );
  assert.deepEqual(
    projectSearchEnvelope(
      { results: [result] },
      select(["name", "temporal", "score", "updatedAt"]),
    ),
    {
      results: [{ name: null, temporal: null, score: -1, updatedAt: null }],
    },
  );
});

test("stored records reject score and support projection", () => {
  const { score: _score, ...stored } = result;
  assert.throws(
    () => parseSelection(["score"], { kind: "stored-record" }),
    /only on search results/,
  );
  assert.deepEqual(
    projectStoredRecord(
      stored as StoredRecord,
      parseSelection(["id", "content:3"], { kind: "stored-record" }),
    ),
    { id: result.id, content: "A😀B", contentLength: 8 },
  );
});

test("rejects empty, unknown, and conflicting selectors", () => {
  for (const selectors of [
    [],
    [""],
    ["id", ""],
    ["unknown"],
    ["createdBy"],
    ["meta."],
    ["content:"],
    ["content:.."],
    ["content:-1"],
    ["content:abc"],
    ["content:20...40"],
    ["content:1.5..10"],
    ["content:10..abc"],
    ["content", "content:20"],
    ["content:10", "content:-10.."],
  ]) {
    assert.throws(() => select(selectors));
  }
  assert.doesNotThrow(() => select(["content:3", "content:..3"]));
});

test("queue state presents its subset relationships explicitly", () => {
  const oldest = new Date("2026-09-17T12:00:00.000Z");
  assert.deepEqual(
    presentQueueStats({
      pending: 5,
      waiting: 2,
      inFlight: 3,
      failed: 4,
      oldestPendingAt: oldest,
    }),
    {
      pending: {
        total: 5,
        claimable: 2,
        deferred: 3,
        oldestAt: oldest,
      },
      failed: { terminal: 4 },
    },
  );
});

test("temporal is presented in its input shape", () => {
  assert.equal(presentTemporal(null), null);
  assert.deepEqual(
    presentTemporal('["2026-09-12 15:00:00+00","2026-09-12 15:00:00+00"]'),
    ["2026-09-12T15:00:00.000Z"],
  );
  assert.deepEqual(
    presentTemporal('["2026-01-01 00:00:00+00","2026-02-01 00:00:00+00")'),
    ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
  );
  const interval: StoredRecord = {
    ...result,
    temporal: '["2026-01-01 00:00:00+00","2026-02-01 00:00:00+00")',
  };
  assert.deepEqual(presentRecord(interval).temporal, [
    "2026-01-01T00:00:00.000Z",
    "2026-02-01T00:00:00.000Z",
  ]);
  assert.deepEqual(
    projectStoredRecord(
      interval,
      parseSelection("temporal", { kind: "stored-record" }),
    ),
    { temporal: ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"] },
  );
});
