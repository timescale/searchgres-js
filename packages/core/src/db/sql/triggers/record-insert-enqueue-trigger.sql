create trigger record_enqueue_after_insert
after insert on {{schema_ident}}.record
for each row
when (new.embedding is null)
execute function {{schema_ident}}.enqueue_record_embedding();
