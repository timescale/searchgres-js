import { createHash } from "node:crypto";
import type postgres from "postgres";
import { runSql } from "../sql/exec.ts";

export type AdvisoryLockKey = readonly [number, number];

/** Derive a stable pair of signed int4 values for a per-schema advisory lock. */
export function advisoryLockKey(name: string): AdvisoryLockKey {
  const digest = createHash("sha256").update(name).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/** Block transaction-locally until an advisory lock is acquired or times out. */
export async function acquireAdvisoryLock(
  sql: postgres.ISql,
  [first, second]: AdvisoryLockKey,
): Promise<void> {
  await runSql(
    sql`select pg_catalog.pg_advisory_xact_lock(${first}, ${second})`,
    { spanName: "acquireAdvisoryLock", dbOperationName: "SELECT" },
  );
}
