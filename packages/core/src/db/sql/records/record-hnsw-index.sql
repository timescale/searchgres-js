create index record_embedding_hnsw_idx on {{schema_ident}}.record using hnsw (embedding public.{{cosine_opclass_ident}})
with (
  m = {{hnsw_m_int}},
  ef_construction = {{hnsw_ef_construction_int}}
);
