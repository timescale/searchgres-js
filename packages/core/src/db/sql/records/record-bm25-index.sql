create index record_content_bm25_idx on {{schema_ident}}.record using bm25 (content)
with
( text_config = {{text_config_literal}}
, k1 = {{bm25_k1_number}}
, b = {{bm25_b_number}}
);
