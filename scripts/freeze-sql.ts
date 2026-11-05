import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_SQL_ROOT = resolve(
  import.meta.dir,
  "../packages/core/src/db/sql",
);

export async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function sqlFileNumber(kind: string, filename: string): number {
  const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(filename);
  if (!match?.[1]) {
    throw new Error(`${kind} sql file must match NNN_name.sql: ${filename}`);
  }
  return Number(match[1]);
}

export async function listSqlFiles(
  sqlRoot: string,
  kind: "bootstrap" | "incremental" | "idempotent",
): Promise<readonly string[]> {
  const dir = join(sqlRoot, kind);
  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  let prev = 0;
  for (const file of files) {
    const num = sqlFileNumber(kind, file);
    if (num !== prev + 1) {
      throw new Error(
        `${kind} sql files must be strictly ordered. this: ${num} prev: ${prev} (${file})`,
      );
    }
    prev = num;
  }
  return files;
}

export async function readFrozenFile(
  sqlRoot = DEFAULT_SQL_ROOT,
): Promise<ReadonlyMap<string, string>> {
  const path = join(sqlRoot, "incremental/frozen.txt");
  const raw = await readFile(path, "utf8");
  const frozen = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-f0-9]{64})\s+(\S+)$/.exec(trimmed);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Invalid frozen.txt line: ${line}`);
    }
    if (frozen.has(match[2])) {
      throw new Error(`Duplicate frozen.txt entry: ${match[2]}`);
    }
    frozen.set(match[2], match[1]);
  }
  return frozen;
}

export async function freezeIncrementalSqlFiles(
  sqlRoot = DEFAULT_SQL_ROOT,
  options?: { readonly force?: boolean },
): Promise<void> {
  if (!options?.force) {
    await checkSqlFiles(sqlRoot);
  }
  const files = await listSqlFiles(sqlRoot, "incremental");
  const lines: string[] = [];
  for (const file of files) {
    const digest = await hashFile(join(sqlRoot, "incremental", file));
    lines.push(`${digest} ${file}`);
  }
  await writeFile(
    join(sqlRoot, "incremental/frozen.txt"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

export async function checkSqlFiles(sqlRoot = DEFAULT_SQL_ROOT): Promise<void> {
  await listSqlFiles(sqlRoot, "bootstrap");
  const incrementals = await listSqlFiles(sqlRoot, "incremental");
  await listSqlFiles(sqlRoot, "idempotent");

  const frozen = await readFrozenFile(sqlRoot);
  const frozenNames = [...frozen.keys()];
  const incrementalSet = new Set(incrementals);
  for (const frozenName of frozenNames) {
    if (!incrementalSet.has(frozenName)) {
      throw new Error(
        `removing or renaming frozen incremental sql file ${frozenName} is not allowed`,
      );
    }
  }
  for (let i = 0; i < frozenNames.length; i++) {
    if (incrementals[i] !== frozenNames[i]) {
      throw new Error(
        `unfrozen incremental sql file ${incrementals[i]} cannot precede frozen file ${frozenNames[i]}`,
      );
    }
  }
  for (const file of incrementals) {
    const expected = frozen.get(file);
    if (expected !== undefined) {
      const actual = await hashFile(join(sqlRoot, "incremental", file));
      if (actual !== expected) {
        throw new Error(
          `changing frozen incremental sql file ${file} is not allowed`,
        );
      }
    }
  }
}

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  const force = process.argv.includes("--force");
  if (checkOnly) {
    await checkSqlFiles();
  } else {
    await freezeIncrementalSqlFiles(DEFAULT_SQL_ROOT, { force });
    await checkSqlFiles();
  }
}
