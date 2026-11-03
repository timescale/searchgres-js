create function {{schema_ident}}.delete_record_by_name(_tree public.ltree, _name text)
returns boolean
language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
        with deleted as
        (
          delete from {{schema_ident}}.record
          where tree operator(public.=) _tree and name = _name
          returning 1
        )
        select exists (select 1 from deleted)
      $function$;
