create function {{schema_ident}}.batch_upsert
( _ids uuid[]
, _contents text[]
, _metas jsonb
, _trees public.ltree[]
, _temporals tstzrange[]
, _names text[]
, _embeddings public.{{vector_type_ident}}[]
, _on_conflict text default 'replace'
)
returns table (ord bigint, id uuid, status text)
language plpgsql volatile security invoker
set timezone to 'UTC'
set datestyle to 'ISO, YMD'
set search_path to pg_catalog, public, pg_temp
as $function$
        -- The out columns (id, ...) shadow table columns inside the body; the
        -- body never reads them as variables, so resolve ambiguity to columns.
        #variable_conflict use_column
        declare
          _rows jsonb;
        begin
          -- Parallel arrays plus one JSON array of meta objects, aligned by
          -- position. _metas is a jsonb array (not jsonb[]) so drivers pass json
          -- values without double-encoding scalar strings.
          if cardinality(_ids) is distinct from cardinality(_contents)
             or cardinality(_ids) is distinct from cardinality(_trees)
             or jsonb_typeof(_metas) is distinct from 'array'
             or cardinality(_ids) is distinct from jsonb_array_length(_metas)
             or cardinality(_ids) is distinct from cardinality(_temporals)
             or cardinality(_ids) is distinct from cardinality(_names)
             or cardinality(_ids) is distinct from cardinality(_embeddings)
          then
            raise exception 'batch arrays must have equal lengths'
              using errcode = 'invalid_parameter_value';
          end if;

          if _on_conflict is null or _on_conflict not in ('error', 'replace', 'ignore') then
            raise exception 'invalid _on_conflict: %', _on_conflict
              using errcode = 'invalid_parameter_value';
          end if;

          -- A duplicate idempotency key within the batch is ambiguous (two
          -- outcomes for one key) and would slip past the per-key partitions.
          if exists
          (
            select 1 from unnest(_ids) u(id)
            where u.id is not null
            group by u.id having count(*) > 1
          ) then
            raise exception 'duplicate explicit id within batch'
              using errcode = 'invalid_parameter_value';
          end if;
          if exists
          (
            select 1 from unnest(_trees, _names) u(tree, name)
            where u.name is not null
            group by u.tree, u.name having count(*) > 1
          ) then
            raise exception 'duplicate (tree, name) within batch'
              using errcode = 'invalid_parameter_value';
          end if;

          -- Two inputs with DIFFERENT keys can still resolve to the same
          -- existing row: an unnamed {id: X} and a {tree, name} slot already
          -- holding id X. Status is attributed by stored id, so that would mark
          -- both inputs from one write. Reject it. Skip the probe when either an
          -- explicit-id input or a named input is absent.
          if cardinality(array_remove(_ids, null)) > 0
             and exists (select 1 from unnest(_names) n(name) where n.name is not null)
             and exists
          (
            select 1 from
            (
              select m.id
              from unnest(_ids, _names) u(id, name)
              join {{schema_ident}}.record m on m.id = u.id
              where u.id is not null and u.name is null
              union all
              select m.id
              from unnest(_trees, _names) u(tree, name)
              join {{schema_ident}}.record m on m.tree = u.tree and m.name = u.name
              where u.name is not null
            ) x
            group by x.id having count(*) > 1
          ) then
            raise exception 'batch inputs target the same existing record through id and (tree, name)'
              using errcode = 'invalid_parameter_value';
          end if;

          -- One mutation statement (one snapshot). Its per-input outcomes are
          -- captured so a second statement can resolve skipped named rows.
          with source as
          (
            select
              u.ord::bigint as position
            , u.id as explicit_id
            , coalesce(u.id, uuidv7()) as id
            , u.content
            , coalesce(nullif(e.meta, 'null'::jsonb), '{}'::jsonb) as meta
            , u.tree
            , u.temporal
            , u.name
            , u.embedding
            from unnest(_ids, _contents, _trees, _temporals, _names, _embeddings)
              with ordinality u(id, content, tree, temporal, name, embedding, ord)
            join jsonb_array_elements(_metas) with ordinality e(meta, ord)
              on e.ord = u.ord
          )
          -- Named rows (with OR without an explicit id) dedup on (tree, name).
          , named_mutation as
          (
            insert into {{schema_ident}}.record as record
              (id, content, meta, tree, temporal, name, embedding)
            select id, content, meta, tree, temporal, name, embedding
            from source
            where name is not null
            on conflict (tree, name) where name is not null do update set
              content = excluded.content
            , meta = excluded.meta
            , temporal = excluded.temporal
            , embedding = case
                when excluded.embedding is null
                  and record.content is not distinct from excluded.content
                then record.embedding
                else excluded.embedding
              end
            where _on_conflict = 'replace'
              and
              (
                record.content is distinct from excluded.content
                or record.meta is distinct from excluded.meta
                or record.temporal is distinct from excluded.temporal
                or
                (
                  excluded.embedding is not null
                  and record.embedding::text is distinct from excluded.embedding::text
                )
              )
            returning record.id, record.tree::text as tree, record.name, (xmax = 0) as inserted
          )
          -- Unnamed rows with an explicit id dedup on the id (import identity);
          -- an id-keyed replace can also move or rename the row.
          , id_mutation as
          (
            insert into {{schema_ident}}.record as record
              (id, content, meta, tree, temporal, name, embedding)
            select id, content, meta, tree, temporal, name, embedding
            from source
            where name is null and explicit_id is not null
            on conflict (id) do update set
              tree = excluded.tree
            , name = excluded.name
            , content = excluded.content
            , meta = excluded.meta
            , temporal = excluded.temporal
            , embedding = case
                when excluded.embedding is null
                  and record.content is not distinct from excluded.content
                then record.embedding
                else excluded.embedding
              end
            where _on_conflict = 'replace'
              and
              (
                record.tree is distinct from excluded.tree
                or record.name is distinct from excluded.name
                or record.content is distinct from excluded.content
                or record.meta is distinct from excluded.meta
                or record.temporal is distinct from excluded.temporal
                or
                (
                  excluded.embedding is not null
                  and record.embedding::text is distinct from excluded.embedding::text
                )
              )
            returning record.id, record.tree::text as tree, record.name, (xmax = 0) as inserted
          )
          -- Anonymous rows always insert (their generated id is unique).
          , anonymous_mutation as
          (
            insert into {{schema_ident}}.record as record
              (id, content, meta, tree, temporal, name, embedding)
            select id, content, meta, tree, temporal, name, embedding
            from source
            where name is null and explicit_id is null
            returning record.id, record.tree::text as tree, record.name, true as inserted
          )
          , mutation as
          (
            select id, tree, name, inserted from named_mutation
            union all
            select id, tree, name, inserted from id_mutation
            union all
            select id, tree, name, inserted from anonymous_mutation
          )
          select jsonb_agg
          (
            jsonb_build_object
            ( 'position', source.position
            , 'mutation_id', mutation.id
            , 'source_id', source.id
            , 'tree', source.tree::text
            , 'name', source.name
            , 'status', case
                when mutation.id is null then 'skipped'
                when mutation.inserted then 'inserted'
                else 'updated'
              end
            )
            order by source.position
          )
          into _rows
          from source
          left outer join mutation
            on
            (
              source.name is not null
              and mutation.tree = source.tree::text
              and mutation.name = source.name
            )
            or
            (
              source.name is null
              and mutation.id = source.id
            );

          -- 'error' does nothing on conflict above (like 'ignore'), then fails
          -- the whole statement here so partial inserts roll back.
          if _on_conflict = 'error'
             and _rows is not null
             and exists
             (
               select 1 from jsonb_array_elements(_rows) e
               where e->>'status' = 'skipped'
             )
          then
            raise exception 'record already exists (id or tree/name conflict)'
              using errcode = 'unique_violation';
          end if;

          -- A skipped named row's stored id is resolved against a FRESH snapshot
          -- (a new statement), so a concurrently committed conflicting row yields
          -- its kept id rather than this batch's minted id.
          return query
          select
            (e->>'position')::bigint as ord
          , coalesce
            ( (e->>'mutation_id')::uuid
            , case
                when e->>'name' is null then (e->>'source_id')::uuid
                else
                (
                  select r.id
                  from {{schema_ident}}.record r
                  where r.tree::text = e->>'tree' and r.name = e->>'name'
                )
              end
            ) as id
          , e->>'status' as status
          from jsonb_array_elements(coalesce(_rows, '[]'::jsonb)) e
          order by (e->>'position')::bigint;
        end;
        $function$;
