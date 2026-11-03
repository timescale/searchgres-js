-- Stamp the schema so openIndex/dropIndex can tell a searchgres index from
-- a caller schema that merely contains similarly named tables. COMMENT is a
-- utility statement and cannot take bind parameters, so the fixed constant
-- is inlined as a pre-quoted literal.
comment on schema {{schema_ident}} is {{schema_comment_literal}};
