create unique index record_tree_name_uidx on {{schema_ident}}.record (tree, name)
where name is not null;
