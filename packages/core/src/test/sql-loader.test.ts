import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import text from "./fixtures/text.sql" with { type: "text" };

test("SQL text imports preserve bytes in Node source tests", () => {
  const expected = readFileSync(
    new URL("./fixtures/text.sql", import.meta.url),
  );
  assert.deepEqual(Buffer.from(text, "utf8"), expected);
  assert.ok(text.includes("\r\n"));
});
