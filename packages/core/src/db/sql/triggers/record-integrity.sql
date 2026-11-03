-- ------------------------------------------------------------------------
-- create record integrity trigger
-- ------------------------------------------------------------------------
create function {{schema_ident}}.record_integrity()
returns trigger
language plpgsql volatile security invoker
set timezone to 'UTC'
set datestyle to 'ISO, YMD'
set search_path to pg_catalog, public, pg_temp
as $function$
        begin
          if tg_op = 'INSERT' then
            new.content_version := 1;
            new.version := 1;
          else
            -- If the content changed but the caller did NOT supply a matching
            -- replacement vector in the same statement, the stored vector no
            -- longer describes the text. Null it so the async pipeline
            -- regenerates it. A caller MAY supply a fresh vector alongside the
            -- new content (new.embedding distinct from old.embedding); that is
            -- preserved and no regeneration is queued.
            if old.content is distinct from new.content
              and new.embedding is not distinct from old.embedding then
              new.embedding := null;
            end if;

            -- content_version is the EMBEDDING-INPUT FENCE, not a literal text
            -- counter. Advance it whenever the input to embedding generation
            -- changes: the content text changed, OR the stored vector itself
            -- changed (a caller supplied/replaced a precomputed vector, or
            -- cleared one to null). This single bump is the entire staleness
            -- mechanism: the worker's write-back is guarded by the
            -- content_version it claimed (see complete_embedding), so bumping
            -- here makes any already-queued OR in-flight work for the previous
            -- state fail that guard and cancel instead of clobbering the newer
            -- vector. It is what lets a late precomputed-embedding write win a
            -- race against a worker that already claimed the row — no extra
            -- trigger required.
            if old.content is distinct from new.content
              or new.embedding is distinct from old.embedding then
              new.content_version := old.content_version + 1;
            else
              new.content_version := old.content_version;
            end if;

            -- version/version_hash/updated_at track the versioned record fields
            -- only. Embedding lifecycle state is derived operational state, so
            -- an embedding-only change advances content_version (above) but
            -- leaves all three version signals untouched.
            if old.tree is distinct from new.tree
              or old.temporal is distinct from new.temporal
              or old.name is distinct from new.name
              or old.meta is distinct from new.meta
              or old.content is distinct from new.content
            then
              new.version := old.version + 1;
              new.updated_at := pg_catalog.now();
            else
              -- no versioned record field changed
              new.version := old.version;
              new.version_hash := old.version_hash;
              new.updated_at := old.updated_at;
              return new;
            end if;
          end if;

          -- compute the hash on inserts and updates that change something meaningful
          new.version_hash := pg_catalog.md5(
            pg_catalog.jsonb_build_object
            ( 'tree', new.tree::text
            , 'name', new.name
            , 'meta', new.meta
            , 'temporal', new.temporal::text
            , 'content', new.content
            )::text
          );
          return new;
        end;
        $function$;
