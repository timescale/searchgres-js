-- ------------------------------------------------------------------------
-- create embedding enqueue function and triggers
-- ------------------------------------------------------------------------
create function {{schema_ident}}.enqueue_record_embedding()
returns trigger
language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
        begin
          insert into {{schema_ident}}.embedding_queue
            (record_id, content_version)
          values
            (new.id, new.content_version);
          return new;
        end;
        $function$;
