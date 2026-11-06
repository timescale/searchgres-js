// Own only a unique throwaway container and an ephemeral loopback port. Never
// remove a user's pg:up container or require their port 5432 to be unused.
import { randomUUID } from "node:crypto";

const command = Bun.argv.slice(2);
if (!command.length)
  throw new Error("usage: with-postgres.ts <command> [args...]");
const container = `searchgres-test-${randomUUID()}`;
const root = `${import.meta.dir}/..`;
function run(args: string[], capture = false) {
  const result = Bun.spawnSync(args, {
    cwd: root,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`Command failed: ${args[0]} ${args[1]}`);
  return capture ? result.stdout.toString().trim() : "";
}
let status = 1;
try {
  run(["./bun", "run", "pg:build"]);
  run([
    "docker",
    "run",
    "-d",
    "--name",
    container,
    "--shm-size=1g",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "searchgres-postgres",
  ]);
  const address = run(["docker", "port", container, "5432/tcp"], true).split(
    "\n",
  )[0];
  const port = address?.split(":").at(-1);
  if (!port || !/^\d+$/.test(port))
    throw new Error("Could not discover PostgreSQL test port");
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = Bun.spawnSync(
      [
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        "create extension if not exists vector with schema public; create extension if not exists pg_textsearch with schema public; create extension if not exists ltree with schema public;",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (result.exitCode === 0) {
      ready = true;
      break;
    }
    await Bun.sleep(500);
  }
  if (!ready) throw new Error("PostgreSQL test database did not become ready");
  const child = Bun.spawn(command, {
    cwd: root,
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      TEST_POSTGRES_CONTAINER: container,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  status = await child.exited;
} finally {
  Bun.spawnSync(["docker", "rm", "-f", container], {
    stdout: "ignore",
    stderr: "ignore",
  });
}
process.exit(status);
