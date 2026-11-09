import type { Index, ProcessEmbeddingsOptions } from "searchgres";
import { duration, loadConfiguredCommand } from "./config/config.ts";
import {
  type Flags,
  nonnegativeInteger,
  optionalFlag,
  positiveInteger,
  requiredFlag,
} from "./flags.ts";
import { outputFormat, writeStructuredOutput } from "./format.ts";
import { presentQueueStats } from "./presentation/index.ts";
import { installShutdown, openRuntime } from "./runtime/index.ts";
import { InputError, safeError } from "./runtime/report.ts";

/** One forward traversal, not a snapshot and not an automatic failure retry loop. */
export async function retryAll(
  index: Pick<Index, "listEmbeddingFailures" | "retryEmbeddingFailures">,
  signal?: AbortSignal,
) {
  let after: string | undefined;
  let retried = 0;
  let skipped = 0;
  while (!signal?.aborted) {
    const page = await index.listEmbeddingFailures({
      limit: 1000,
      ...(after ? { after } : {}),
    });
    if (!page.length) break;
    const result = await index.retryEmbeddingFailures({
      queueIds: page.map((f) => f.queueId),
    });
    retried += result.retried;
    skipped += result.skipped;
    after = page.at(-1)?.queueId;
    if (page.length < 1000) break;
  }
  return { retried, skipped };
}
export async function runEmbeddings(
  command: string,
  flags: Flags,
): Promise<void> {
  if (flags.has("ndjson") && command !== "failures")
    throw new InputError("--ndjson requires a collection command");
  const { config } = await loadConfiguredCommand(flags);
  const runtime = await openRuntime(config);
  const controller = new AbortController();
  const shutdown = installShutdown(
    () => runtime.close(),
    () => controller.abort(),
  );
  const index = runtime.index;
  const output = (value: unknown) =>
    writeStructuredOutput(value, outputFormat(flags));
  const integer = (name: string) => {
    const value = optionalFlag(flags, name);
    const number =
      value === undefined ? undefined : positiveInteger(value, name);
    if (name === "batch-size" && number !== undefined && number > 1000)
      throw new InputError("--batch-size must be at most 1000");
    return number;
  };
  try {
    if (command === "worker") {
      const count = flags.has("workers")
        ? nonnegativeInteger(requiredFlag(flags, "workers"), "workers")
        : config.worker.count;
      if (count < 1)
        throw new InputError("embeddings worker requires at least one worker");
      if (count > 64) throw new InputError("--workers must be at most 64");
      // A worker stops by itself only after a fault that a retry cannot fix
      // (a wrong vector dimension). Exit with status 1 when all workers stop.
      let stopped = 0;
      let allStopped = () => {};
      const stoppedAll = new Promise<void>((resolve) => {
        allStopped = resolve;
      });
      runtime.startEmbeddingWorkers(count, {
        onError: (error, context) => {
          console.error(
            JSON.stringify({
              error: safeError(error),
              ...(context.stopped ? { workerStopped: true } : {}),
            }),
          );
          if (context.stopped && ++stopped === count) {
            process.exitCode = 1;
            allStopped();
          }
        },
        ...(flags.has("batch-size")
          ? { batchSize: integer("batch-size") as number }
          : {}),
        ...(flags.has("interval")
          ? {
              intervalMs: parsePositiveDuration(
                requiredFlag(flags, "interval"),
              ),
            }
          : {}),
      });
      console.error(
        `searchgres.js embedding worker pool running (${count} workers)`,
      );
      await Promise.race([
        stoppedAll,
        new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        }),
      ]);
      return;
    }
    await runtime.run(async () => {
      switch (command) {
        case "process": {
          const options: ProcessEmbeddingsOptions = {
            batchSize: integer("batch-size") ?? config.worker.batchSize,
            ...(flags.has("max-batches")
              ? { maxBatches: integer("max-batches") as number }
              : {}),
            ...(flags.has("max-duration")
              ? {
                  maxDurationMs: parsePositiveDuration(
                    requiredFlag(flags, "max-duration"),
                  ),
                }
              : {}),
            signal: controller.signal,
          };
          const { sampleError, ...result } =
            await index.processEmbeddings(options);
          // Show only the safe error class (for example an HTTP status), not
          // remote provider text. PostgreSQL keeps the bounded diagnostic.
          output({
            ...result,
            sampleError: sampleError === null ? null : safeError(sampleError),
          });
          if (result.failed > 0) process.exitCode = 1;
          break;
        }
        case "status":
          output(presentQueueStats(await index.queueStats()));
          break;
        case "failures":
          output({
            failures: (
              await index.listEmbeddingFailures({
                limit: integer("limit") ?? 100,
                ...(flags.has("after")
                  ? { after: requiredFlag(flags, "after") }
                  : {}),
              })
            ).map((failure) => ({
              ...failure,
              // The database retains bounded provider diagnostics, not a safe
              // public error contract. Do not echo raw remote error messages.
              lastError:
                failure.lastError === null
                  ? null
                  : "Embedding generation failed; provider diagnostic retained in PostgreSQL",
            })),
          });
          break;
        case "retry": {
          if (flags.has("all") === flags.has("queue-id"))
            throw new InputError("retry requires either --all or --queue-id");
          if (flags.has("all")) {
            if (!flags.has("yes"))
              throw new InputError("retry --all requires --yes");
            output(await retryAll(index, controller.signal));
          } else
            output(
              await index.retryEmbeddingFailures({
                queueIds: requiredFlag(flags, "queue-id").split(","),
              }),
            );
          break;
        }
        case "prune":
          if (!flags.has("yes")) throw new InputError("prune requires --yes");
          output({
            pruned: await index.pruneEmbeddingQueue({
              retentionMs: parsePositiveDuration(
                requiredFlag(flags, "older-than"),
              ),
            }),
          });
          break;
        default:
          throw new InputError("Unknown embeddings command");
      }
    });
  } finally {
    await shutdown.stop();
  }
}
export function parsePositiveDuration(value: string): number {
  try {
    const ms = duration(value);
    if (ms > 0) return ms;
  } catch {
    /* safe input error below */
  }
  throw new InputError(
    "expected a positive duration such as 500ms, 30s, or 5m",
  );
}
