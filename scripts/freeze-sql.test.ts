import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkSqlFiles,
  freezeIncrementalSqlFiles,
  readFrozenFile,
} from "./freeze-sql.ts";

const repoSqlRoot = resolve(import.meta.dir, "../packages/core/src/db/sql");

test("checkSqlFiles allows trailing unfrozen files, and freeze refuses to overwrite modified frozen hashes without --force", async () => {
  await checkSqlFiles(repoSqlRoot);

  const tempRoot = await mkdtemp(join(tmpdir(), "searchgres-freeze-sql-"));
  try {
    await cp(repoSqlRoot, tempRoot, { recursive: true });
    await checkSqlFiles(tempRoot);

    // A new, unfrozen 002 file after the last frozen entry passes checkSqlFiles
    // during development and is added to frozen.txt when freeze runs.
    const nextPath = join(tempRoot, "incremental/002_unreleased.sql");
    await writeFile(nextPath, "select 1;\n", "utf8");
    await checkSqlFiles(tempRoot);
    await freezeIncrementalSqlFiles(tempRoot);
    expect((await readFrozenFile(tempRoot)).has("002_unreleased.sql")).toBe(
      true,
    );
    await unlink(nextPath);
    await freezeIncrementalSqlFiles(tempRoot, { force: true });

    // Editing a frozen incremental file is rejected by both checkSqlFiles and
    // default freezeIncrementalSqlFiles; deliberate { force: true } updates it.
    const initialPath = join(tempRoot, "incremental/001_initial.sql");
    await writeFile(initialPath, "-- modified\n", "utf8");
    await expect(checkSqlFiles(tempRoot)).rejects.toThrow(
      /changing frozen incremental sql file 001_initial\.sql is not allowed/,
    );
    await expect(freezeIncrementalSqlFiles(tempRoot)).rejects.toThrow(
      /changing frozen incremental sql file 001_initial\.sql is not allowed/,
    );

    await freezeIncrementalSqlFiles(tempRoot, { force: true });
    await checkSqlFiles(tempRoot);

    // Adding a new incremental file with a gap in numbering (003 instead of 002) is rejected.
    const gapPath = join(tempRoot, "incremental/003_gap.sql");
    await writeFile(gapPath, "select 1;\n", "utf8");
    await expect(checkSqlFiles(tempRoot)).rejects.toThrow(
      /incremental sql files must be strictly ordered/,
    );
    await unlink(gapPath);

    // Removing a file listed in frozen.txt is rejected.
    await unlink(initialPath);
    await expect(checkSqlFiles(tempRoot)).rejects.toThrow(
      /removing or renaming frozen incremental sql file 001_initial\.sql is not allowed/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
