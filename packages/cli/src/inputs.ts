// Binary input schemas: deliberately exclude vectors and operational schema selectors.
// Core validates all database operations; these schemas also support offline import
// validation, the filter DSL, and MCP tool discovery.
import { z } from "zod";
import { filterNodeError } from "./filter/issues.ts";

export const uuidSchema = z.uuidv7();
export const timestampSchema = z.iso.datetime({ offset: true });
export const jsonObjectSchema = z.record(z.string(), z.json());
const treePathSchema = z
  .string()
  .refine(
    (path) =>
      path === "" ||
      path.split(".").every((label) => /^[A-Za-z0-9_-]+$/.test(label)),
    "expected dot-separated ltree labels",
  );
const temporalSchema = z
  .union([
    z.tuple([timestampSchema]),
    z.tuple([timestampSchema, timestampSchema]),
  ])
  .refine(
    (value) =>
      value.length === 1 || Date.parse(value[0]) < Date.parse(value[1]),
    "interval start must be before its end",
  );
// Mirror core's record rules so dry runs and MCP schemas reject what core would.
const contentSchema = z.string().min(1, "content must not be empty");
const nameSchema = z
  .string()
  .min(1, "name must not be empty; use null for an unnamed record")
  .nullable();
export const recordInputSchema = z.strictObject({
  id: uuidSchema.optional(),
  content: contentSchema,
  meta: jsonObjectSchema.default({}),
  tree: treePathSchema.default(""),
  temporal: temporalSchema.optional(),
  name: nameSchema.default(null),
});
export const patchInputSchema = z
  .strictObject({
    content: contentSchema.optional(),
    meta: jsonObjectSchema.optional(),
    tree: treePathSchema.optional(),
    name: nameSchema.optional(),
    temporal: temporalSchema.nullable().optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "patch must set at least one field",
  );

type FilterNode =
  | { readonly and: readonly FilterNode[] }
  | { readonly or: readonly FilterNode[] }
  | { readonly not: FilterNode }
  | { readonly tree: string }
  | { readonly lquery: string }
  | { readonly ltxtquery: string }
  | { readonly meta: z.input<typeof jsonObjectSchema> }
  | { readonly metaPredicate: string }
  | { readonly temporalWithin: readonly [string, string] }
  | { readonly temporalOverlaps: readonly [string, string] }
  | { readonly temporalBefore: string }
  | { readonly temporalAfter: string }
  | { readonly temporalContains: string }
  | { readonly regexp: string };
const range = z.tuple([timestampSchema, timestampSchema]);
const nonempty = z.string().min(1);
export const filterSchema: z.ZodType<FilterNode, FilterNode> = z.lazy(() =>
  z.union(
    [
      z.strictObject({ and: z.array(filterSchema).min(2) }),
      z.strictObject({ or: z.array(filterSchema).min(2) }),
      z.strictObject({ not: filterSchema }),
      z.strictObject({ tree: treePathSchema }),
      z.strictObject({ lquery: nonempty }),
      z.strictObject({ ltxtquery: nonempty }),
      z.strictObject({
        meta: jsonObjectSchema.refine(
          (v) => Object.keys(v).length > 0,
          "meta filter must not be an empty object",
        ),
      }),
      z.strictObject({ metaPredicate: nonempty }),
      z.strictObject({ temporalWithin: range }),
      z.strictObject({ temporalOverlaps: range }),
      z.strictObject({ temporalBefore: timestampSchema }),
      z.strictObject({ temporalAfter: timestampSchema }),
      z.strictObject({ temporalContains: timestampSchema }),
      z.strictObject({ regexp: nonempty }),
    ],
    { error: filterNodeError },
  ),
);
export const searchParamsSchema = z.strictObject({
  semantic: nonempty.optional(),
  fulltext: nonempty.optional(),
  filter: filterSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  candidateLimit: z.number().int().min(1).max(1000).optional(),
  semanticThreshold: z.number().min(0).max(1).optional(),
  k: z.number().nonnegative().optional(),
  fulltextWeight: z.number().min(0).max(1).optional(),
  semanticWeight: z.number().min(0).max(1).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  after: uuidSchema.optional(),
  before: uuidSchema.optional(),
});
export type RecordInput = z.input<typeof recordInputSchema>;
export type SearchParams = z.input<typeof searchParamsSchema>;
export type Filter = z.input<typeof filterSchema>;
