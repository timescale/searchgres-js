create index embedding_queue_archive_idx on {{schema_ident}}.embedding_queue (created_at)
where outcome is not null;
