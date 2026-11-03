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
create trigger record_enqueue_after_embedding_input
after update of content, embedding on {{schema_ident}}.record
for each row
when
(
  new.embedding is null
  and new.content_version is distinct from old.content_version
)
execute function {{schema_ident}}.enqueue_record_embedding();
