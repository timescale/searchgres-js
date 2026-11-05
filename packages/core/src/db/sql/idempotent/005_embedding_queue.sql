--------------------------------------------------------------------------------
-- claim_embedding_batch
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.claim_embedding_batch
( _batch_size integer default 10
, _lease_ms bigint default 300000
, _max_attempts integer default 3
)
returns table
( queue_id bigint
, record_id uuid
, content_version integer
, content text
, claimed boolean
)
as $func$
#variable_conflict use_column
begin
  -- Finalize rows that exhausted their attempt budget so a row stranded by a
  -- crash after its final claim does not stay pending forever.
  update {{schema_ident}}.embedding_queue
  set
    outcome = 'failed'
  , last_error = coalesce(last_error, 'exceeded max attempts')
  , updated_at = now()
  where outcome is null
  and visible_at <= now()
  and attempts >= _max_attempts
  ;

  return query
  with candidate as
  (
    -- Lock the oldest eligible rows and skip any a concurrent drainer holds.
    select
      q.id
    , q.record_id
    , q.content_version
    from {{schema_ident}}.embedding_queue q
    where q.outcome is null
    and q.visible_at <= now()
    and q.attempts < _max_attempts
    order by q.visible_at
    for update skip locked
    limit _batch_size
  )
  , joined as
  (
    -- Left join so a deleted record surfaces as record_content is null.
    select
      c.id
    , c.record_id
    , c.content_version
    , r.content as record_content
    , r.content_version as current_version
    from candidate c
    left join {{schema_ident}}.record r
      on r.id = c.record_id
  )
  , cancelled as
  (
    -- Stale: record gone, or its content_version moved past the queued one.
    update {{schema_ident}}.embedding_queue q
    set
      outcome = 'cancelled'
    , updated_at = now()
    from joined j
    where q.id = j.id
    and
    (
      j.record_content is null
      or j.current_version is distinct from j.content_version
    )
    returning q.id
  )
  , claimed as
  (
    -- Fresh: extend the lease and spend one attempt.
    update {{schema_ident}}.embedding_queue q
    set
      attempts = q.attempts + 1
    , visible_at = now() + (_lease_ms * interval '1 millisecond')
    , updated_at = now()
    from joined j
    where q.id = j.id
    and j.record_content is not null
    and j.current_version is not distinct from j.content_version
    returning q.id
  )
  select
    j.id as queue_id
  , j.record_id
  , j.content_version
  , j.record_content as content
  , (cl.id is not null) as claimed
  from joined j
  left join claimed cl
    on cl.id = j.id
  order by j.id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- complete_embedding
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.complete_embedding
( _queue_id bigint
, _record_id uuid
, _content_version integer
, _embedding public.{{vector_type_ident}}({{dimensions_int}})
)
returns text
as $func$
  with active as
  (
    select
      q.record_id
    , q.content_version
    from {{schema_ident}}.embedding_queue q
    where q.id = _queue_id
    and q.outcome is null
    for update
  )
  , written as
  (
    update {{schema_ident}}.record rec
    set embedding = _embedding
    from active a
    where rec.id = a.record_id
    and rec.id = _record_id
    and rec.content_version = a.content_version
    and rec.content_version = _content_version
    returning rec.id
  )
  , finalized as
  (
    update {{schema_ident}}.embedding_queue q
    set
      outcome = case
        when exists (select 1 from written) then 'completed'
        else 'cancelled'
      end
    , updated_at = now()
    where q.id = _queue_id
    and q.outcome is null
    returning q.outcome
  )
  select coalesce((select f.outcome from finalized f), 'cancelled')
$func$ language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- fail_embedding
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.fail_embedding
( _queue_id bigint
, _error text
)
returns void
as $func$
  update {{schema_ident}}.embedding_queue
  set
    last_error = _error
  , updated_at = now()
  where id = _queue_id
  and outcome is null
  ;
$func$ language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- release_embedding
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.release_embedding
( _queue_id bigint
, _backoff_ms bigint default 0
)
returns void
as $func$
  update {{schema_ident}}.embedding_queue
  set
    attempts = greatest(attempts - 1, 0)
  , visible_at = now() + (_backoff_ms * interval '1 millisecond')
  , updated_at = now()
  where id = _queue_id
  and outcome is null
  ;
$func$ language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- prune_embedding_queue
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.prune_embedding_queue
( _retention_ms double precision
)
returns bigint
as $func$
  with deleted as
  (
    delete from {{schema_ident}}.embedding_queue
    where outcome is not null
    and created_at < now() - (_retention_ms * interval '1 millisecond')
    returning id
  )
  select count(*)::bigint
  from deleted
$func$ language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- pending_embedding_count
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.pending_embedding_count()
returns bigint
as $func$
  select count(*)::bigint
  from {{schema_ident}}.embedding_queue
  where outcome is null
$func$ language sql stable security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- list_embedding_failures
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.list_embedding_failures
( _limit integer default 100
, _after bigint default null
)
returns table
( queue_id bigint
, record_id uuid
, content_version integer
, attempts integer
, last_error text
, enqueued_at timestamptz
, failed_at timestamptz
)
as $func$
#variable_conflict use_column
begin
  if _after is null then
    return query
    select
      q.id as queue_id
    , q.record_id
    , q.content_version
    , q.attempts
    , q.last_error
    , q.created_at as enqueued_at
    , coalesce(q.updated_at, q.created_at) as failed_at
    from {{schema_ident}}.embedding_queue q
    join {{schema_ident}}.record r
      on r.id = q.record_id
      and r.content_version = q.content_version
    where q.outcome = 'failed'
    and r.embedding is null
    order by q.id
    limit _limit;
  else
    return query
    select
      q.id as queue_id
    , q.record_id
    , q.content_version
    , q.attempts
    , q.last_error
    , q.created_at as enqueued_at
    , coalesce(q.updated_at, q.created_at) as failed_at
    from {{schema_ident}}.embedding_queue q
    join {{schema_ident}}.record r
      on r.id = q.record_id
      and r.content_version = q.content_version
    where q.outcome = 'failed'
    and r.embedding is null
    and q.id > _after
    order by q.id
    limit _limit;
  end if;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- retry_embedding_failures
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.retry_embedding_failures
( _queue_ids bigint[]
)
returns bigint
as $func$
  with requested as
  (
    select distinct u.id
    from pg_catalog.unnest(_queue_ids) u(id)
    where u.id is not null
  )
  , reset as
  (
    update {{schema_ident}}.embedding_queue q
    set
      outcome = null
    , attempts = 0
    , last_error = null
    , visible_at = now()
    , updated_at = now()
    from requested wanted, {{schema_ident}}.record r
    where q.id = wanted.id
    and q.outcome = 'failed'
    and r.id = q.record_id
    and r.content_version = q.content_version
    and r.embedding is null
    returning q.id
  )
  select count(*)::bigint
  from reset
$func$ language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- embedding_queue_stats
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.embedding_queue_stats()
returns table
( pending bigint
, in_flight bigint
, waiting bigint
, failed bigint
, oldest_pending_at timestamptz
)
as $func$
  select
    count(*) filter (where q.outcome is null)::bigint as pending
  , count(*) filter (where q.outcome is null and q.visible_at > now())::bigint as in_flight
  , count(*) filter (where q.outcome is null and q.visible_at <= now())::bigint as waiting
  , count(*) filter
    (
      where q.outcome = 'failed'
      and exists
      (
        select 1
        from {{schema_ident}}.record r
        where r.id = q.record_id
        and r.content_version = q.content_version
        and r.embedding is null
      )
    )::bigint as failed
  , min(q.created_at) filter (where q.outcome is null) as oldest_pending_at
  from {{schema_ident}}.embedding_queue q
$func$ language sql stable security invoker
set search_path to pg_catalog, public, pg_temp
;
