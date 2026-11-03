create index embedding_queue_record_idx on {{schema_ident}}.embedding_queue (record_id, content_version desc)
where outcome is null;
