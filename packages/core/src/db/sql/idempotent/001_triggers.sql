--------------------------------------------------------------------------------
-- record integrity trigger
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.record_integrity()
returns trigger
as $func$
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
      and new.embedding is not distinct from old.embedding
    then
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
      or new.embedding is distinct from old.embedding
    then
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
  new.version_hash := pg_catalog.md5
  (
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
$func$ language plpgsql volatile security invoker
set timezone to 'UTC'
set datestyle to 'ISO, YMD'
set search_path to pg_catalog, public, pg_temp
;

create or replace trigger record_integrity_before_write
before insert or update on {{schema_ident}}.record
for each row
execute function {{schema_ident}}.record_integrity();

--------------------------------------------------------------------------------
-- embedding enqueue function and triggers
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.enqueue_record_embedding()
returns trigger
as $func$
begin
  insert into {{schema_ident}}.embedding_queue
  ( record_id
  , content_version
  )
  values
  ( new.id
  , new.content_version
  );
  return new;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

create or replace trigger record_enqueue_after_insert
after insert on {{schema_ident}}.record
for each row
when (new.embedding is null)
execute function {{schema_ident}}.enqueue_record_embedding();

-- Enqueue whenever an update leaves the row needing an async vector. We
-- key off content_version rather than re-deriving "what changed":
-- record_integrity (BEFORE) has already advanced content_version iff the
-- embedding input changed, and has already nulled a now-stale vector. So
-- "vector is null AND content_version advanced" is exactly the set of
-- updates that produced fresh work: content changed without a replacement
-- (vector nulled), or a vector explicitly cleared to null. A supplied
-- non-null vector advances content_version too (invalidating old queue
-- rows) but needs no new work, so the "new.embedding is null" guard skips
-- it. "of content, embedding" keeps metadata-only updates from firing.
create or replace trigger record_enqueue_after_embedding_input
after update of content, embedding on {{schema_ident}}.record
for each row
when
(
  new.embedding is null
  and new.content_version is distinct from old.content_version
)
execute function {{schema_ident}}.enqueue_record_embedding();
