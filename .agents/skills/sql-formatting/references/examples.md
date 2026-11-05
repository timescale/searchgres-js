# Formatting examples

These are synthetic examples of the visual conventions, not database-design
recommendations. Preserve the original SQL's semantics and attributes when
formatting existing code.

## Inserts and updates

Expanded insert column/value lists use the same punctuation gutter:

```sql
insert into {{schema_ident}}.record
( id
, name
, meta
)
values
( _id
, _name
, _meta
)
on conflict (id) do update set
  name = excluded.name
, meta = excluded.meta
returning id
;
```

For an expanded update, keep `set` on the header when convenient, with the first
assignment indented two spaces and following commas at the statement indentation:

```sql
update {{schema_ident}}.record set
  name = _name
, meta = coalesce(_meta, meta)
, updated_at = now()
where id = _id
and version = _version
returning id, version
;
```

Local `update ...` / `set first_assignment` or a separate `set` line are also
valid. Keep a compact statement compact when it is easier to read:

```sql
delete from {{schema_ident}}.record where id = _id returning id;
```

## Long joins and boolean groups

```sql
select
  r.id
, r.name
, g.name as group_name
from {{schema_ident}}.record r
left join {{schema_ident}}.record_group g
  on g.id = r.group_id
  and g.enabled
where r.deleted_at is null
and
(
  r.owner_id = _principal_id
  or r.is_public
)
order by r.created_at desc, r.id;
```

The join's `and` and `on` align as keywords. The query's `and` aligns with `where`.
Short joins can stay on one line. Neither parentheses around every `on` condition
nor changing alias spellings is required.

## Derived tables and nested calls

```sql
select
  x.group_id
, coalesce
  ( jsonb_agg
    ( jsonb_build_object
      ( 'id', x.id
      , 'name', x.name
      )
    )
  , '[]'::jsonb
  ) as records
from
(
  select r.group_id, r.id, r.name
  from {{schema_ident}}.record r
  where r.active
) x
group by x.group_id;
```

Within every expanded call, `(`, `,`, and `)` form a vertical gutter. Keep calls
inline when this expansion adds no useful structure.

## Expanded case expression

```sql
select
  r.id
, case
    when r.deleted_at is not null then 'deleted'
    when r.visible then 'visible'
    else 'hidden'
  end as status
from {{schema_ident}}.record r;
```

An expression case can expand this way. Procedural `case` blocks may instead
use `when` aligned with `case`; preserve the existing block's convention.

## PL/pgSQL

```sql
create or replace function {{schema_ident}}.rename_record
( _id uuid
, _name text
)
returns boolean
as $func$
declare
  _changed boolean;
begin
  if _name is null then
    raise exception 'Name must not be NULL'
      using errcode = 'invalid_parameter_value';
  end if;

  update {{schema_ident}}.record set
    name = _name
  where id = _id
  ;

  _changed = found;
  return _changed;
end;
$func$ language plpgsql volatile security invoker
;
```

The capital letters inside the message stay unchanged. Assignment `=` is valid
in this example; existing code using `:=` should retain it. Preserve actual
volatility/security/settings rather than copying this example's choices.

## Constraints, indexes, and triggers

Simple constraints stay inline. Table-level constraints occupy list entries.
Complex predicates may expand without changing their grouping:

```sql
create table {{schema_ident}}.example
( id   uuid primary key
, kind text not null
, name text not null
, check
  (
    kind in ('public', 'private')
    and name <> ''
  )
, unique (kind, name)
);

create index example_name_idx
  on {{schema_ident}}.example (name)
  where kind = 'public';

create trigger example_updated
  before update on {{schema_ident}}.example
  for each row
  execute function {{schema_ident}}.update_timestamp();
```

One-line index definitions are equally established for short declarations.

## Templates, client commands, and literal preservation

Treat template directives and psql commands as a separate language, not as
ordinary SQL tokens:

```sql
create or replace function {{schema_ident}}.lookup
( _id uuid
)
returns text
as $func$
  select r."DisplayName"
  from {{schema_ident}}.record r
  where r.id = _id
$func$ language sql stable security invoker
;
```

Keep `{{schema_ident}}`, `{{schema_literal}}`, `{{vector_column_type}}`,
`{{hnsw_opclass}}`, `$1`, `:name`, `:'name'`, `:"name"`, `${expression}`, and
other host placeholders intact when present. Do not introduce these marker forms
into code that does not use them.

```sql
\set ON_ERROR_STOP on

select
  current_setting('TimeZone') as timezone
, 'SELECT X, Y FROM T' as literal_text
\gset context_
```

Keep `ON_ERROR_STOP`, `'TimeZone'`, and the entire SQL-looking string unchanged.
There is deliberately no semicolon before `\gset`: it executes the query buffer.
Formatting must not execute the script, including any shell metacommands.

Preserve newline-dependent literal concatenation as well:

```sql
select 'foo'
       'bar' as combined;
```

PostgreSQL treats this as `'foobar'` because the separating whitespace contains a
newline. Replacing that newline with a space changes valid SQL into invalid SQL.
Do not trim whitespace inside literals or reindent a non-SQL routine body.
