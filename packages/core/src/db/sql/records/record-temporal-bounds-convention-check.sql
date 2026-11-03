alter table {{schema_ident}}.record add constraint record_temporal_bounds_convention_check
check
(
  temporal is null
  or
  (
    (
      pg_catalog.lower(temporal) = pg_catalog.upper(temporal)
      and pg_catalog.lower_inc(temporal)
      and pg_catalog.upper_inc(temporal)
    )
    or
    (
      pg_catalog.lower(temporal) < pg_catalog.upper(temporal)
      and pg_catalog.lower_inc(temporal)
      and not pg_catalog.upper_inc(temporal)
    )
  )
);
