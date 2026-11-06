import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Sql } from "postgres";
import type { IndexConfig } from "../../src/config.ts";
import type { createIndex } from "../../src/create-index.ts";
import type { noEmbedding } from "../../src/embedding.ts";
import type { SchemaVersionError } from "../../src/errors.ts";
import type { openIndex } from "../../src/open-index.ts";

const execFileAsync = promisify(execFile);

export interface V032Core {
  readonly SCHEMA_FORMAT_VERSION: string;
  readonly createIndex: typeof createIndex;
  readonly openIndex: typeof openIndex;
  readonly noEmbedding: typeof noEmbedding;
  readonly SchemaVersionError: typeof SchemaVersionError;
}

let cachedDir: string | undefined;
let cachedModule: Promise<V032Core> | undefined;

export async function getV032Core(): Promise<V032Core> {
  if (!cachedModule) {
    cachedModule = (async () => {
      const repoRoot = resolve(import.meta.dirname, "../../../..");
      cachedDir = await mkdtemp(join(tmpdir(), "searchgres-v032-"));
      try {
        await execFileAsync(
          "sh",
          [
            "-c",
            'git archive v0.3.2 packages/core/src | tar -x -C "$1"',
            "sh",
            cachedDir,
          ],
          { cwd: repoRoot },
        );
      } catch (error) {
        throw new Error(
          "git tag v0.3.2 is missing; run 'git fetch --tags' or checkout with fetch-depth: 0",
          { cause: error },
        );
      }
      await symlink(
        resolve(repoRoot, "node_modules"),
        join(cachedDir, "node_modules"),
      );
      const v032 = (await import(
        pathToFileURL(join(cachedDir, "packages/core/src/index.ts")).href
      )) as V032Core;
      assert.equal(v032.SCHEMA_FORMAT_VERSION, "2");
      return v032;
    })();
  }
  return cachedModule;
}

export async function cleanupV032Core(): Promise<void> {
  if (cachedDir) {
    const dir = cachedDir;
    cachedDir = undefined;
    cachedModule = undefined;
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Provision a genuine v0.3.2 format-2 index schema (version = '2', no migration
 * table, v0.3.2 routine bodies) by invoking v0.3.2's `createIndex`.
 */
export async function createFormat2Index(
  sql: Sql,
  schema: string,
  config: IndexConfig,
): Promise<void> {
  const v032 = await getV032Core();
  const { vectorIndex, ...rest } = config;
  const v032Config = {
    ...rest,
    ...(vectorIndex?.method === "hnsw"
      ? {
          hnsw: {
            ...(vectorIndex.m !== undefined ? { m: vectorIndex.m } : {}),
            ...(vectorIndex.efConstruction !== undefined
              ? { efConstruction: vectorIndex.efConstruction }
              : {}),
          },
        }
      : {}),
  };
  await v032.createIndex(sql, schema, v032Config as never);
}
