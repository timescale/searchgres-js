import { CommanderError } from "commander";
import { runProgram } from "./program.ts";
import {
  commanderInputError,
  exitCode,
  formatError,
} from "./runtime/report.ts";

try {
  await runProgram(process.argv.slice(2));
} catch (caught) {
  const error =
    caught instanceof CommanderError ? commanderInputError(caught) : caught;
  if (caught instanceof CommanderError && error === undefined) {
    // Commander already wrote help or version output.
    process.exitCode = caught.exitCode === 0 ? 0 : 2;
  } else {
    process.stderr.write(
      `${formatError(error, process.stderr.isTTY === true)}\n`,
    );
    process.exitCode = exitCode(error);
  }
}
