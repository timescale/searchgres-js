create trigger record_integrity_before_write
before insert or update on {{schema_ident}}.record
for each row
execute function {{schema_ident}}.record_integrity();
