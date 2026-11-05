---
name: sql-formatting
license: MIT
description: "Write, format, and review SQL in searchgres's preferred style: lowercase syntax, leading commas, two-space nesting, and next-line opening parentheses. Use whenever authoring or editing SQL, PostgreSQL DDL, queries, migrations, SQL/PLpgSQL routines, or embedded SQL in searchgres. This governs presentation, not database design or query optimization."
---

# SQL formatting

Follow this opinionated style rather than a generic SQL formatter's defaults.
The characteristic shape is lowercase SQL with a left-hand punctuation gutter:
commas, parentheses, and boolean connectives reveal structure without trailing
delimiters. Keep short expressions compact; expand meaningful structure rather
than mechanically putting everything on its own line.

Optimize for visible structure, local edits, and readable diffs. When choosing
between permitted layouts, prefer the one that serves those goals without
changing semantics.

Read `references/examples.md` for expanded DML, joins, expressions, routines,
and preservation examples. This skill is self-contained and requires no
external project or service.

## Scope and precedence

- Apply this style to new SQL and requested formatting work. In a focused code
  change, format touched SQL, not unrelated files or whole historical migrations.
  Never reformat frozen incremental migrations listed in
  `packages/core/src/db/sql/incremental/frozen.txt`.
- Explicit user instructions and repository requirements take precedence.
  Preserve deliberate local variants where this guide allows alternatives.
- Formatting is not a refactor. Preserve names, literals, comments, placeholders,
  list and statement order, parentheses affecting precedence, casts, operators,
  query hints, function attributes, and runtime behavior. Do not rename objects
  or parameters, rewrite joins, change types, or change security/search settings.
- PostgreSQL is the source dialect. In other dialects, retain their valid syntax
  and use the same visual principles where applicable.
- In embedded SQL (such as `packages/core/src/db/sql/*.sql` templates and
  `postgres.js` tagged templates), preserve the host language's
  interpolation/escaping rules (`{{schema_ident}}`, `{{vector_column_type}}`,
  `${sql(schema)}`, etc.). Do not alter raw template-literal whitespace when it
  is semantically significant.

## Core rules

### 1. Lowercase SQL syntax, not data

Use lowercase keywords, type names, built-ins, boolean/null constants, and special
PL/pgSQL names: `create table`, `timestamptz`, `coalesce`, `true`, `null`, `new`,
`old`, `tg_op`.

Lowercase keeps the visual style quiet and consistent with surrounding code.
This is a readability preference, not a database performance advantage.

Use lowercase `snake_case` for newly authored identifiers when naming is in scope.
Do not rename existing identifiers as formatting. Preserve quoted identifiers
exactly, and preserve case-sensitive unquoted names where the dialect requires it.

Prefix newly authored routine input parameters and local variables with a leading
underscore: `_id`, `_include_hidden`, `_changed`. This distinguishes them from
table and column names and avoids name-resolution clashes in SQL and PL/pgSQL;
for example, `where r.id = _id` clearly compares a column with a parameter.
Keep table/column names and public result-column names (such as `returns table`
columns) unprefixed. Apply this naming convention when authoring new names or
when renaming is explicitly requested, not during formatting-only work.

Do not lowercase string contents: `tg_op = 'DELETE'`, `'UTC'`, JSON keys, regexes,
messages, and SQLSTATEs remain unchanged. Do not case-fold psql variables,
metacommand arguments, or template directives. Format dollar-quoted routine
bodies only after identifying their language as SQL or PL/pgSQL. Preserve bodies
in other languages; their indentation and case may be significant. Other
dollar-quoted strings are data unless explicitly identified as embedded SQL to
format.

### 2. Two spaces for nesting; a punctuation gutter for lists

Use spaces, two per structural level, not tabs. Remove trailing whitespace only
outside protected literal, template, or other language content. Two-space
nesting preserves horizontal room in deeply nested queries and routines.

For a multiline projection, place `select` on its own line. Indent the first item
two spaces beyond the clause; put later `, ` prefixes at the clause indentation.
Item text consequently lines up:

```sql
select
  r.id
, r.name
, r.created_at
from app.record r
where r.active
and r.deleted_at is null
order by r.created_at desc, r.id
limit 20;
```

Use leading commas in expanded column, parameter, return-column, argument,
assignment, value, ordering, and CTE lists. No trailing-comma layout. Inline
lists use ordinary comma-space separators: `(id, name)`.

The gutter makes list structure visible at predictable positions even when
expressions vary in length. Leading commas usually make appending an item a
one-line change without modifying the previous item. The first item remains
special: removing or moving it may still require adjusting punctuation.

Do not add two spaces before both the first item and all comma prefixes; that
moves the punctuation gutter away from its owning clause.

### 3. Put expanded declaration parentheses on the next line

For tables and expanded signatures, put the name on one line, then `( ` followed
by the first item on the next. Align following commas and the closing parenthesis
with that opening parenthesis:

```sql
create table app.example
( id         uuid primary key
, name       text not null
, created_at timestamptz not null default now()
, unique (name, created_at)
);
```

This is a next-line opener, not `create table app.example (`. Keeping `(`, `,`,
and `)` in one vertical gutter makes the list's boundaries easy to scan,
independently of the declaration's length.

Use this same shape for expanded function parameters, `returns table`, insert
columns, value rows, and function-call arguments. Keep short calls and lists
inline: `coalesce(_name, 'untitled')`, `count(*)`, `numeric(12, 2)`, `name()`.
A compact return declaration such as `returns table (id uuid, status text)` is
also valid.

For CTEs and subqueries, normally give the opening `(` its own line, indent the
query two spaces, and align the closing `)` with the opener:

```sql
with active_records as
(
  select r.id, r.name
  from app.record r
  where r.active
)
, named_records as
(
  select id, name
  from active_records
  where name is not null
)
select id, name
from named_records;
```

Keep `as materialized` / `as not materialized` with the CTE name if present.
Put a derived-table alias after the closing parenthesis: `) r`.

### 4. Align query clauses, lead with boolean connectives

Put major clauses on separate lines at the query's indentation: `select`, `from`,
`join`, `where`, `group by`, `having`, `order by`, `limit`, `returning`.
Put `union` / `union all` on their own line between query arms.

For new SQL, default to `and` / `or` at the same indentation as `where`, as in the
first example. Parenthesize boolean groups as needed to preserve precedence and
indent their contents two spaces. Do not introduce or remove logical grouping
merely for appearance. Leading connectives expose how each predicate connects
to the preceding condition; parentheses, not alignment, establish precedence.

An established local style with `and` indented two spaces beneath `where` is an
accepted variant, particularly in standalone query scripts. Preserve it when
editing such a block rather than creating a mixture.

Keep short join predicates on the join line. For long joins put `on` on the next
line, indented two spaces; subsequent `and` lines can align predicate text beneath
`on`. Follow the local form; do not add/remove join-predicate parentheses or
change `join` to `inner join` just to format it.

New table aliases normally omit `as`; output-expression aliases use `as`.
Preserve existing alias syntax during strictly formatting-only work.

### 5. Compact where useful, align where useful

A short projection can stay `select r.id, r.name`. Tiny queries and mutations may
stay on one line. Another accepted local form is `select first_expression` with
leading-comma continuations aligned beneath the projection. Prefer the
standalone-`select` example for newly expanded projections.

Align table column names/types, parameter types, assignments, output aliases, or
inline comments when it makes a cohesive block easier to scan. Single-space
separation is also established style. Follow the surrounding block; don't pad an
entire file into a grid or let one long item force huge whitespace everywhere.

Selective compactness keeps meaningful structure prominent rather than giving
every trivial expression the same visual weight. Selective alignment aids
scanning without making a longer name trigger whitespace-only changes across
unrelated lines.

There is no fixed line-width rule. Break at meaningful syntax boundaries, not an
arbitrary column. Preserve long template directives and literal data rather than
wrapping them unsafely.

### 6. Ordinary expression spacing

- Space around binary comparison, arithmetic, concatenation, and extension
  operators: `a = b`, `1 - distance`, `meta @> _filter`.
- No padding around qualification or casts: `r.id`, `_id::uuid`.
- Compact JSON access is established: `_patch->>'name'`.
- No space between a compact function name and `(`: `now()`.
- Preserve operator tokens, unary signs, casts, and necessary parentheses.
- Keep simple `case when ... then ... else ... end` expressions inline. Expand
  complex cases and nested calls with two-space structural indentation and
  leading commas for expanded argument lists.

## SQL and PL/pgSQL routines

For newly authored routines, use this wrapper shape, retaining only attributes
and settings actually required by the task:

```sql
create or replace function {{schema_ident}}.find_record
( _id uuid
, _include_hidden boolean default false
)
returns table
( id uuid
, name text
)
as $func$
  select r.id, r.name
  from {{schema_ident}}.record r
  where r.id = _id
  and (_include_hidden or r.visible)
$func$ language sql stable security invoker
;
```

- Put `returns ...` and `as $func$` on their own lines.
- Prefer `$func$` for new function bodies and `$do$` for `do` blocks, but
  preserve existing delimiter tags.
- Indent SQL-language body statements two spaces. A single SQL body query may
  omit its inner terminal semicolon; preserve the surrounding convention.
- Place the closing delimiter and language/behavior attributes together, then
  each function-level `set` clause on its own line, and a standalone final `;`.
  A local layout with `language ...` below the delimiter is also established.
- Do not add `stable`, `volatile`, `strict`, `security`, `rows`, or `set` settings
  merely because they appear in an example. Keep the actual behavior unchanged.
- In PL/pgSQL, normally align `declare`, `begin`, and `end;` with the outer
  declaration; indent declarations and statements two spaces. Nested `if`,
  `case`, loops, and blocks add two spaces. Align closing control keywords with
  their opening keywords.
- Short `if ... then` stays together; long conditions can break before `and` /
  `or`, with `then` on a separate line. Use blank lines between logical phases.
- Both `=` and `:=` assignments are accepted. Preserve the local choice;
  do not convert one into the other as formatting.

## Comments and terminators

Use `-- ` comments for explanations and blank lines between logical sections.
Place short item-specific comments after the definition or expression:

```sql
, display_name text -- optional public label
```

Do not split an item as `, -- comment` followed by its definition on the next
line. Existing explanatory paragraph comments before a list item can remain.
Align related inline comments when useful. Preserve comment contents and
attachment; a `--` comment must not accidentally swallow following SQL.

For major routine sections (such as in `packages/core/src/db/sql/idempotent/*.sql`),
a heading between two 80-hyphen lines is the established convention:

```sql
--------------------------------------------------------------------------------
-- get_record
--------------------------------------------------------------------------------
```

Simple DDL ends with `);`; short statements end inline. A long executable query
or mutation in a procedural body may use a standalone `;` aligned with the
statement. Query scripts also commonly terminate on the final clause. Both are
valid local forms. Preserve statement boundaries, and do not append `;` before
psql `\g`, `\gset`, or another command that executes the current query buffer.

## Working method and final check

1. Read the SQL and its surrounding block before editing. Identify dialect,
   template markers (`{{...}}`), quoted strings, routine bodies, and psql commands.
2. Apply the core shape manually or with a demonstrably compatible formatter.
   Generic formatter defaults often undo this style. Do not install/configure a
   formatter or add dependencies unless requested.
3. Review the diff for presentation-only changes. Check lowercase syntax,
   leading commas, two-space nesting, next-line declaration openers, and local
   compactness/alignment choices.
4. Check that names, literal contents, placeholder order, operators, grouping,
   comments, statement boundaries, and routine attributes are unchanged. A
   whitespace-stripped comparison is not sufficient: whitespace can matter in
   strings, comments, and client commands. Preserve newline-separated adjacent
   string literals: PostgreSQL's implicit literal concatenation requires the
   separating whitespace to include a newline.
5. Run `./bun run check:sql` and `./bun run --filter searchgres test:unit` to
   verify template rendering and manifest integrity.
6. Return the formatted SQL or requested edits. For a style review, give concrete
   deviations and examples; separate certain rules from accepted local variants.
