// Shared shell-facing flag validation for the one compiled binary.
import { InputError } from "./runtime/report.ts";

/** A parsed command line: kebab-case flag name to value, or `true` if boolean. */
export type Flags = Map<string, string | true>;

/** Convert Commander's camelCase option object into a kebab-case flag map. */
export function flagsFromOptions(options: Record<string, unknown>): Flags {
  const flags: Flags = new Map();
  for (const [name, value] of Object.entries(options)) {
    if (name === "envFile" && value === false) {
      flags.set("no-env-file", true);
      continue;
    }
    if (value === undefined || value === false) continue;
    flags.set(kebabCase(name), value === true ? true : String(value));
  }
  return flags;
}

export function requiredFlag(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (!value || value === true) throw new InputError(`--${name} is required`);
  return value;
}

export function optionalFlag(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new InputError(`--${name} requires a value`);
  return value;
}

export function rejectUnknownFlags(
  flags: Flags,
  allowed: ReadonlySet<string>,
): void {
  for (const name of flags.keys())
    if (!allowed.has(name)) throw new InputError(`Unknown flag: --${name}`);
}

export function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new InputError(
      `--${name} must be a positive integer within the safe range`,
    );
  return number;
}

export function nonnegativeInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new InputError(
      `--${name} must be a nonnegative integer within the safe range`,
    );
  return number;
}

export function unitInterval(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw new InputError(`--${name} must be a number between 0 and 1`);
  return number;
}

export function nonnegativeNumber(value: string, name: string): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number < 0)
    throw new InputError(`--${name} must be a non-negative number`);
  return number;
}

export function enumeration<T extends string>(
  value: string,
  name: string,
  allowed: readonly T[],
): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined)
    throw new InputError(`--${name} must be one of ${allowed.join(", ")}`);
  return match;
}

/** `candidate-limit` -> `candidateLimit`. */
export function camelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** `temporalWithin` -> `temporal-within`. */
export function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function parseJsonObject(raw: string, name: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InputError(`--${name} must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new InputError(`--${name} must be a JSON object`);
  return parsed;
}
