-- ------------------------------------------------------------------------
-- delete_record / delete_record_by_name
-- ------------------------------------------------------------------------
-- Return whether an exact row was removed (queue rows cascade via the FK). The
-- TS layer maps false to NotFoundError.
create function {{schema_ident}}.delete_record(_id uuid)
returns boolean
language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
        with deleted as
        (
          delete from {{schema_ident}}.record where id = _id returning 1
        )
        select exists (select 1 from deleted)
      $function$;
