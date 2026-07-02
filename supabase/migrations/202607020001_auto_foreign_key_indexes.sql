begin;

-- Create leftmost covering indexes for every foreign key in the target schema.
-- The function is intentionally idempotent and can be rerun after future table
-- migrations if the database does not allow DDL event triggers.
create or replace function public.ensure_foreign_key_covering_indexes(
  target_schema text default 'public'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  fk record;
  created_count integer := 0;
  index_name text;
begin
  for fk in
    with foreign_keys as (
      select
        constraint_info.oid as constraint_oid,
        constraint_info.conname as constraint_name,
        constraint_info.conrelid as table_oid,
        namespace_info.nspname as schema_name,
        table_info.relname as table_name,
        constraint_info.conkey::smallint[] as fk_attnums,
        array_agg(attribute_info.attname order by key_info.ordinality) as fk_columns,
        string_agg(format('%I', attribute_info.attname), ', ' order by key_info.ordinality) as fk_columns_sql
      from pg_constraint constraint_info
      join pg_class table_info
        on table_info.oid = constraint_info.conrelid
      join pg_namespace namespace_info
        on namespace_info.oid = table_info.relnamespace
      join unnest(constraint_info.conkey) with ordinality as key_info(attnum, ordinality)
        on true
      join pg_attribute attribute_info
        on attribute_info.attrelid = constraint_info.conrelid
       and attribute_info.attnum = key_info.attnum
      where constraint_info.contype = 'f'
        and namespace_info.nspname = target_schema
        and table_info.relkind in ('r', 'p')
      group by
        constraint_info.oid,
        constraint_info.conname,
        constraint_info.conrelid,
        namespace_info.nspname,
        table_info.relname,
        constraint_info.conkey
    )
    select
      foreign_keys.*,
      exists (
        select 1
        from pg_index index_info
        where index_info.indrelid = foreign_keys.table_oid
          and index_info.indisvalid
          and index_info.indisready
          and index_info.indpred is null
          and index_info.indexprs is null
          and (
            select array_agg(index_key.attnum::smallint order by index_key.ordinality)
            from unnest(regexp_split_to_array(trim(index_info.indkey::text), '[[:space:]]+')::smallint[])
              with ordinality as index_key(attnum, ordinality)
            where index_key.ordinality <= array_length(foreign_keys.fk_attnums, 1)
          ) = foreign_keys.fk_attnums
      ) as has_covering_index
    from foreign_keys
  loop
    if fk.has_covering_index then
      continue;
    end if;

    index_name := lower(fk.table_name || '_' || array_to_string(fk.fk_columns, '_') || '_fk_idx');
    index_name := regexp_replace(index_name, '[^a-z0-9_]+', '_', 'g');

    if length(index_name) > 60 then
      index_name :=
        substr(regexp_replace(lower(fk.table_name), '[^a-z0-9_]+', '_', 'g'), 1, 32) ||
        '_' ||
        substr(md5(fk.constraint_name || ':' || array_to_string(fk.fk_columns, ',')), 1, 12) ||
        '_fk_idx';
    end if;

    execute format(
      'create index if not exists %I on %I.%I (%s)',
      index_name,
      fk.schema_name,
      fk.table_name,
      fk.fk_columns_sql
    );

    created_count := created_count + 1;
  end loop;

  return created_count;
end;
$$;

revoke execute on function public.ensure_foreign_key_covering_indexes(text)
  from public, anon, authenticated;

-- Apply indexes for all current public foreign keys.
select public.ensure_foreign_key_covering_indexes('public');

-- Best-effort future automation. Supabase projects may reject event triggers
-- without elevated privileges, so this block deliberately degrades to a notice.
create or replace function public.ensure_foreign_key_covering_indexes_after_ddl()
returns event_trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ensure_foreign_key_covering_indexes('public');
end;
$$;

revoke execute on function public.ensure_foreign_key_covering_indexes_after_ddl()
  from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_event_trigger
    where evtname = 'ensure_public_foreign_key_indexes_after_ddl'
  ) then
    execute 'create event trigger ensure_public_foreign_key_indexes_after_ddl
      on ddl_command_end
      when tag in (''CREATE TABLE'', ''ALTER TABLE'')
      execute function public.ensure_foreign_key_covering_indexes_after_ddl()';
  end if;
exception
  when insufficient_privilege or undefined_object then
    raise notice 'Automatic foreign key index event trigger was not installed: %', sqlerrm;
end;
$$;

commit;
