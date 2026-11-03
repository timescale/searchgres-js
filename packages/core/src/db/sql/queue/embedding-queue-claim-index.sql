create index embedding_queue_claim_idx on {{schema_ident}}.embedding_queue (visible_at)
where outcome is null;
