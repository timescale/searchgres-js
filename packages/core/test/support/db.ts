import postgresV3, { type Sql } from "postgres";
import postgresV4 from "postgres-v4";

/**
 * The postgres.js major version under test. Core supports postgres.js 3 and 4;
 * CI runs the database suite once with each. Core takes the caller's `sql`
 * instance, so only the test connections choose the driver.
 */
export const POSTGRES_JS_MAJOR =
  process.env.SEARCHGRES_TEST_POSTGRES_JS === "4" ? 4 : 3;

/** Create a test pool with the postgres.js major version under test. */
export function createPostgres(
  url: string,
  options: { max?: number } = {},
): Sql {
  const factory = (POSTGRES_JS_MAJOR === 4
    ? postgresV4
    : postgresV3) as unknown as typeof postgresV3;
  return factory(url, { onnotice: () => {}, ...options });
}

const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres@127.0.0.1:5432/postgres";
const SCHEMA_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function connect(): Sql {
  return connectToUrl(testDatabaseUrl());
}

export function connectToDatabase(database: string, max?: number): Sql {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${database}`;
  return connectToUrl(url.toString(), max);
}

function connectToUrl(url: string, max?: number): Sql {
  return createPostgres(url, max === undefined ? {} : { max });
}

/** Generate a valid test-only schema name that cannot collide with production. */
export function randomTestSchema(): string {
  return `sgtest_${randomSuffix(12)}`;
}

export function randomTestDatabase(): string {
  return `sgtestdb_${randomSuffix(12)}`;
}

function randomSuffix(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let suffix = "";
  for (const byte of bytes) {
    suffix += SCHEMA_ALPHABET[byte % SCHEMA_ALPHABET.length];
  }
  return suffix;
}

export async function dropTestSchema(sql: Sql, schema: string): Promise<void> {
  await sql`drop schema if exists ${sql(schema)} cascade`;
}

export async function createTestDatabase(
  sql: Sql,
  database: string,
): Promise<void> {
  await sql`create database ${sql(database)} template template0`;
}

export async function dropTestDatabase(
  sql: Sql,
  database: string,
): Promise<void> {
  await sql`drop database if exists ${sql(database)}`;
}

export async function schemaExists(sql: Sql, schema: string): Promise<boolean> {
  const [row] = await sql<{ readonly present: boolean }[]>`
    select exists (
      select 1
      from pg_catalog.pg_namespace n
      where n.nspname = ${schema}
    ) as present
  `;
  return row?.present ?? false;
}

export async function columnType(
  sql: Sql,
  schema: string,
  table: string,
  column: string,
): Promise<string | null> {
  const [row] = await sql<{ readonly type: string }[]>`
    select pg_catalog.format_type(a.atttypid, a.atttypmod) as type
    from pg_catalog.pg_attribute a
    where a.attrelid = ${`${schema}.${table}`}::pg_catalog.regclass
      and a.attname = ${column}
      and not a.attisdropped
  `;
  return row?.type ?? null;
}

export async function listIndexes(
  sql: Sql,
  schema: string,
  table: string,
): Promise<readonly string[]> {
  const rows = await sql<{ readonly indexname: string }[]>`
    select indexname
    from pg_catalog.pg_indexes
    where schemaname = ${schema}
      and tablename = ${table}
    order by indexname
  `;
  return rows.map((row) => row.indexname);
}

export async function indexReloptions(
  sql: Sql,
  schema: string,
  index: string,
): Promise<readonly string[]> {
  const [row] = await sql<{ readonly reloptions: readonly string[] | null }[]>`
    select c.reloptions
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relname = ${index}
  `;
  return row?.reloptions ?? [];
}

export async function indexOpclass(
  sql: Sql,
  schema: string,
  index: string,
): Promise<string | null> {
  const [row] = await sql<{ readonly opcname: string }[]>`
    select opc.opcname
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_opclass opc on opc.oid = i.indclass[0]
    where n.nspname = ${schema}
      and c.relname = ${index}
  `;
  return row?.opcname ?? null;
}

export async function listTriggers(
  sql: Sql,
  schema: string,
  table: string,
): Promise<readonly string[]> {
  const rows = await sql<{ readonly tgname: string }[]>`
    select t.tgname
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relname = ${table}
      and not t.tgisinternal
    order by t.tgname
  `;
  return rows.map((row) => row.tgname);
}

function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export async function listFunctions(
  sql: Sql,
  schema: string,
): Promise<readonly string[]> {
  const rows = await sql<{ readonly proname: string }[]>`
    select p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema}
    order by p.proname
  `;
  return rows.map((row) => row.proname);
}
