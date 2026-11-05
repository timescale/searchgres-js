import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import {
  type ExtensionRequirement,
  ensureExtension,
} from "../src/db/extensions.ts";
import { acquireAdvisoryLock, advisoryLockKey } from "../src/db/lock.ts";
import {
  ensurePostgresVersion,
  MINIMUM_POSTGRES_VERSION_NUM,
} from "../src/db/preflight.ts";
import {
  applySessionTimeouts,
  DEFAULT_MIGRATION_TIMEOUTS,
} from "../src/db/session.ts";
import { ExtensionError, LockTimeoutError } from "../src/errors.ts";
import { connect } from "./support/db.ts";

let sql: Sql;
const requiredExtensions = [
  { name: "vector", minimumVersion: "0.8.0" },
  { name: "pg_textsearch", minimumVersion: "1.4.0" },
  { name: "ltree", minimumVersion: "1.3.0" },
] as const satisfies readonly ExtensionRequirement[];

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

test("accepts PostgreSQL 18", async () => {
  const version = await ensurePostgresVersion(sql);
  assert.ok(version >= MINIMUM_POSTGRES_VERSION_NUM);
});

test("ensures supplied extensions with an empty search path", async () => {
  const extensions = await sql.begin(async (tx) => {
    await tx.unsafe("set local search_path to ''");
    const results = [];
    for (const requirement of requiredExtensions) {
      results.push(await ensureExtension(tx, requirement));
    }
    return results;
  });

  assert.deepEqual(
    extensions.map((extension) => extension.name),
    requiredExtensions.map((extension) => extension.name),
  );
  for (const extension of extensions) {
    assert.match(extension.version, /\S/);
  }
});

test("checks one caller-selected extension per transaction", async () => {
  const extensions = await Promise.all(
    Array.from({ length: 4 }, () =>
      sql.begin(async (tx) => {
        await applySessionTimeouts(tx, DEFAULT_MIGRATION_TIMEOUTS);
        return ensureExtension(tx, requiredExtensions[2]);
      }),
    ),
  );

  assert.deepEqual(
    extensions,
    Array.from({ length: 4 }, () => extensions[0]),
  );
});

test("reports an unavailable caller-selected extension", async () => {
  await assert.rejects(
    () =>
      sql.begin((tx) =>
        ensureExtension(tx, {
          name: "searchgres_extension_that_does_not_exist",
          minimumVersion: "1.0.0",
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionError);
      assert.equal(error.reason, "unavailable");
      assert.equal(error.extension, "searchgres_extension_that_does_not_exist");
      return true;
    },
  );
});

test("maps an advisory-lock wait timeout", async () => {
  const key = advisoryLockKey("searchgres:test:held-lock");
  let locked!: () => void;
  let release!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const releaseHolder = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = sql.begin(async (tx) => {
    await acquireAdvisoryLock(tx, key);
    locked();
    await releaseHolder;
  });

  await lockHeld;
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await applySessionTimeouts(tx, {
          ...DEFAULT_MIGRATION_TIMEOUTS,
          lockTimeout: "50ms",
        });
        await acquireAdvisoryLock(tx, key);
      }),
    LockTimeoutError,
  );
  release();
  await holder;
});
