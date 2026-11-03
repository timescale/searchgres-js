create index record_temporal_gist_idx on {{schema_ident}}.record using gist (temporal)
where temporal is not null;
