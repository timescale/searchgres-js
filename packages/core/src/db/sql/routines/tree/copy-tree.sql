-- ------------------------------------------------------------------------
-- copy_tree
-- ------------------------------------------------------------------------
-- Insert a fresh record for each source-subtree row under `_dst`. New rows get
-- a generated UUIDv7 and content_version/version reset to 1 by the insert
-- trigger; a copied non-null embedding is preserved (no re-embed), a null one
-- enqueues normally. The source is untouched; a destination (tree, name)
-- collision raises 23505 and rolls back.
create function {{schema_ident}}.copy_tree
( _src public.ltree
, _dst public.ltree
, _dry_run boolean default false
)
returns bigint
language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
      declare
        _n bigint;
      begin
        if _dry_run then
          select count(*) into _n
          from {{schema_ident}}.record m
          where _src operator(public.@>) m.tree;
          return _n;
        end if;

        with copied as
        (
          insert into {{schema_ident}}.record
            (content, meta, tree, temporal, name, embedding)
          select
            m.content
          , m.meta
          , case
              when public.nlevel(m.tree) = public.nlevel(_src) then _dst
              else _dst operator(public.||) public.subpath(m.tree, public.nlevel(_src), public.nlevel(m.tree) - public.nlevel(_src))
            end
          , m.temporal
          , m.name
          , m.embedding
          from {{schema_ident}}.record m
          where _src operator(public.@>) m.tree
          returning id
        )
        select count(*) into _n from copied;
        return _n;
      end
      $function$;
