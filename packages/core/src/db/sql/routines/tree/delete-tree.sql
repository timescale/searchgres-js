-- ------------------------------------------------------------------------
-- delete_tree
-- ------------------------------------------------------------------------
-- Delete the inclusive subtree; queue rows cascade via the FK. Returns the
-- count (dry-run counts without deleting).
create function {{schema_ident}}.delete_tree
( _tree public.ltree
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
          where _tree operator(public.@>) m.tree;
          return _n;
        end if;

        with deleted as
        (
          delete from {{schema_ident}}.record m
          where _tree operator(public.@>) m.tree
          returning m.id
        )
        select count(*) into _n from deleted;
        return _n;
      end
      $function$;
