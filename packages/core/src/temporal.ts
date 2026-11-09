import { z } from "zod";

/**
 * A timestamp accepted on the public API: a `Date`, or an ISO-8601 string that
 * carries an explicit offset or `Z`. Strings without an offset are rejected so a
 * value's instant is never silently reinterpreted in the server's time zone.
 */
const TIMESTAMP_MESSAGE =
  "expected an ISO 8601 timestamp with a UTC offset or Z, for example 2026-01-02T03:04:05Z";

export const timestampSchema = z.union(
  [z.date(), z.iso.datetime({ offset: true, error: TIMESTAMP_MESSAGE })],
  { error: `${TIMESTAMP_MESSAGE}, or a Date` },
);

export type Timestamp = z.input<typeof timestampSchema>;

/** Canonical UTC ISO-8601 rendering of a validated timestamp. */
export function normalizeTimestamp(timestamp: Date | string): string {
  return timestamp instanceof Date
    ? timestamp.toISOString()
    : new Date(timestamp).toISOString();
}

/** Epoch milliseconds for a validated timestamp (used for ordering checks). */
export function timestampMilliseconds(timestamp: Date | string): number {
  return timestamp instanceof Date
    ? timestamp.getTime()
    : Date.parse(timestamp);
}

/**
 * Render a half-open `[start,end)` tstzrange literal from two timestamps,
 * enforcing `start < end`. Returns `null` describing the failure via `issue`
 * when the interval is empty or inverted, so callers can attach their own path.
 */
export function normalizeRangeLiteral(
  start: Date | string,
  end: Date | string,
): { readonly literal: string } | { readonly error: string } {
  if (timestampMilliseconds(start) >= timestampMilliseconds(end)) {
    return { error: "interval start must be before its end" };
  }
  return {
    literal: `[${normalizeTimestamp(start)},${normalizeTimestamp(end)})`,
  };
}

/**
 * A temporal value on a record write: a single-element tuple for a point in
 * time, or a two-element tuple for a half-open interval. Strings must carry an
 * explicit offset (enforced by {@link timestampSchema}).
 */
export const temporalTupleSchema = z
  .union([
    z.tuple([timestampSchema]).readonly(),
    z.tuple([timestampSchema, timestampSchema]).readonly(),
  ])
  .superRefine((temporal, context) => {
    if (
      temporal.length === 2 &&
      timestampMilliseconds(temporal[0]) >= timestampMilliseconds(temporal[1])
    ) {
      context.addIssue({
        code: "custom",
        message: "interval start must be before its end",
      });
    }
  });

/**
 * Canonical tstzrange literal for a validated temporal tuple: a point becomes
 * the closed `[t,t]`; an interval becomes the half-open `[start,end)`.
 */
export function normalizeTemporalTuple(
  temporal: z.output<typeof temporalTupleSchema>,
): string {
  const start = normalizeTimestamp(temporal[0]);
  if (temporal.length === 1) {
    return `[${start},${start}]`;
  }
  return `[${start},${normalizeTimestamp(temporal[1])})`;
}
