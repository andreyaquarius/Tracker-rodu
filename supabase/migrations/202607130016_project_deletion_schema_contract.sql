begin;

-- Keep the deletion worker honest in the opposite direction too. The worker
-- already tolerates a phase whose optional table is not installed; this
-- helper detects the more dangerous case: an installed project-owned table
-- which no deletion phase knows about.
create or replace function private.project_deletion_uncovered_table_names()
returns text[]
language sql
stable
set search_path = ''
as $$
  with project_owned_tables as (
    select distinct table_record.relname as table_name
    from pg_catalog.pg_class table_record
    join pg_catalog.pg_namespace table_schema
      on table_schema.oid = table_record.relnamespace
    where table_schema.nspname = 'public'
      and table_record.relkind in ('r', 'p')
      and (
        exists (
          select 1
          from pg_catalog.pg_attribute project_column
          where project_column.attrelid = table_record.oid
            and project_column.attname = 'project_id'
            and project_column.attnum > 0
            and not project_column.attisdropped
        )
        or exists (
          select 1
          from pg_catalog.pg_constraint project_foreign_key
          where project_foreign_key.conrelid = table_record.oid
            and project_foreign_key.contype = 'f'
            and project_foreign_key.confrelid =
              'public.projects'::pg_catalog.regclass
        )
      )
  )
  select coalesce(
    pg_catalog.array_agg(project_owned.table_name order by project_owned.table_name),
    array[]::text[]
  )
  from project_owned_tables project_owned
  where project_owned.table_name <> 'project_members'
    and not (
      project_owned.table_name = any(private.project_deletion_phase_names())
    );
$$;

revoke execute on function private.project_deletion_uncovered_table_names()
  from public, anon, authenticated;

do $$
declare
  uncovered_tables text[] := private.project_deletion_uncovered_table_names();
begin
  if cardinality(uncovered_tables) > 0 then
    raise exception
      'PROJECT_DELETION_PHASES_MISSING_TABLES: %',
      array_to_string(uncovered_tables, ', ');
  end if;
end;
$$;

-- Restoring a backup keeps the project, memberships, invitations and audit
-- trail, but it must remove every prior content/graph/import row. Deriving the
-- list from the deletion worker prevents the restore path from drifting behind
-- newly introduced family-tree tables again.
create or replace function private.project_restore_clear_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.array_agg(phase.table_name order by phase.ordinality),
    array[]::text[]
  )
  from pg_catalog.unnest(private.project_deletion_phase_names())
    with ordinality as phase(table_name, ordinality)
  where phase.table_name not in ('activity_log', 'project_invitations');
$$;

revoke execute on function private.project_restore_clear_phase_names()
  from public, anon, authenticated;

create or replace function public.clear_project_records_for_restore(
  target_project_id uuid,
  batch_size integer default 500
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
set statement_timeout = '8s'
as $$
declare
  actor_id uuid := auth.uid();
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 500), 500));
  current_table text;
  current_relation regclass;
  deleted_count integer := 0;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if not public.is_project_owner(target_project_id)
     and not public.is_app_admin(actor_id) then
    raise exception 'PROJECT_RESTORE_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if exists (
    select 1
    from public.projects project
    where project.id = target_project_id
      and project.deletion_pending
  ) then
    raise exception 'PROJECT_DELETION_IN_PROGRESS' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 8417)
  );
  perform pg_catalog.set_config('app.project_deletion', 'on', true);

  foreach current_table in array private.project_restore_clear_phase_names()
  loop
    current_relation := pg_catalog.to_regclass(format('public.%I', current_table));
    if current_relation is null then
      continue;
    end if;

    execute format(
      'with target_rows as (
         select ctid
         from %s
         where project_id = $1
         limit $2
       ), deleted_rows as (
         delete from %s target
         using target_rows
         where target.ctid = target_rows.ctid
         returning 1
       )
       select count(*)::integer from deleted_rows',
      current_relation,
      current_relation
    )
    into deleted_count
    using target_project_id, safe_batch_size;

    if deleted_count > 0 then
      return pg_catalog.jsonb_build_object(
        'complete', false,
        'table', current_table,
        'deletedRows', deleted_count
      );
    end if;
  end loop;

  delete from private.project_dashboard_stats_cache
  where project_id = target_project_id;

  return pg_catalog.jsonb_build_object(
    'complete', true,
    'table', null,
    'deletedRows', 0
  );
end;
$$;

revoke execute on function public.clear_project_records_for_restore(uuid, integer)
  from public, anon;
grant execute on function public.clear_project_records_for_restore(uuid, integer)
  to authenticated;

comment on function public.clear_project_records_for_restore(uuid, integer) is
  'Deletes one bounded batch of project content before backup restore while preserving project access and audit records.';

commit;
