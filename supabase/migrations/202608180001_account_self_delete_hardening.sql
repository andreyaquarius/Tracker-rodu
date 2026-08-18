begin;

create table if not exists private.account_deletion_jobs (
  user_id uuid primary key,
  project_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on table private.account_deletion_jobs from public, anon, authenticated;
grant select, insert, update, delete on table private.account_deletion_jobs to service_role;

-- Account deletion is a server-only operation.  The first version revoked the
-- function from the named API roles, but PostgreSQL grants EXECUTE to PUBLIC
-- for new functions by default.  Revoke PUBLIC explicitly and keep the RPC
-- callable only by the service-role Edge Function.
create or replace function public.delete_account_data(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  relation record;
  owned_project_ids uuid[] := '{}'::uuid[];
  total_deleted bigint := 0;
  removed bigint := 0;
begin
  if p_user_id is null then
    raise exception using
      errcode = '22004',
      message = 'ACCOUNT_ID_REQUIRED';
  end if;

  -- Administrators cannot delete themselves through the public product flow.
  -- Their accounts own operational/audit rows with restrictive foreign keys
  -- and must be removed only through the documented administrator procedure.
  if public.is_app_admin(p_user_id) then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_ACCOUNT_DELETE_BLOCKED';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.user_id = p_user_id
  ) then
    return 0;
  end if;

  -- Serialize retries for one account.  This avoids two requests racing while
  -- ownership and attribution are being transferred.
  perform pg_advisory_xact_lock(hashtextextended('delete-account:' || p_user_id::text, 0));

  select coalesce(array_agg(project.id order by project.id), '{}'::uuid[])
  into owned_project_ids
  from public.projects project
  where project.owner_id = p_user_id;

  -- Keep a private durable manifest until Storage is confirmed clean. It is
  -- intentionally outside the profile/project FK graph so a timed-out Edge
  -- Function can safely continue on the next authenticated retry.
  insert into private.account_deletion_jobs (
    user_id,
    project_ids,
    created_at,
    updated_at
  ) values (
    p_user_id,
    owned_project_ids,
    now(),
    now()
  )
  on conflict (user_id) do update
  set project_ids = (
        select coalesce(array_agg(distinct project_id order by project_id), '{}'::uuid[])
        from unnest(
          private.account_deletion_jobs.project_ids || excluded.project_ids
        ) as merged(project_id)
      ),
      updated_at = now();

  -- Only projects owned by the departing user are removed. Membership in a
  -- project owned by somebody else must never make that shared project data
  -- disappear.
  delete from public.projects project
  where project.owner_id = p_user_id;
  get diagnostics removed = row_count;
  total_deleted := total_deleted + removed;

  -- Preserve records in projects owned by somebody else. Required attribution
  -- columns (created_by/uploaded_by/updated_by and future equivalents) are
  -- transferred to the project owner instead of deleting the records merely
  -- because the departing member created them.
  for relation in
    select distinct
      child_ns.nspname as table_schema,
      child_class.relname as table_name,
      child_attr.attname as column_name
    from pg_constraint constraint_row
    join pg_class child_class
      on child_class.oid = constraint_row.conrelid
    join pg_namespace child_ns
      on child_ns.oid = child_class.relnamespace
    join pg_class parent_class
      on parent_class.oid = constraint_row.confrelid
    join pg_namespace parent_ns
      on parent_ns.oid = parent_class.relnamespace
    join unnest(constraint_row.conkey) with ordinality as child_keys(attnum, ord) on true
    join unnest(constraint_row.confkey) with ordinality as parent_keys(attnum, ord)
      on parent_keys.ord = child_keys.ord
    join pg_attribute child_attr
      on child_attr.attrelid = constraint_row.conrelid
      and child_attr.attnum = child_keys.attnum
    join pg_attribute parent_attr
      on parent_attr.attrelid = constraint_row.confrelid
      and parent_attr.attnum = parent_keys.attnum
    where constraint_row.contype = 'f'
      and child_ns.nspname in ('public', 'private')
      and child_attr.attnotnull
      and child_attr.attname not in ('user_id', 'owner_id')
      and exists (
        select 1
        from pg_attribute project_column
        where project_column.attrelid = constraint_row.conrelid
          and project_column.attname = 'project_id'
          and project_column.attnum > 0
          and not project_column.attisdropped
      )
      and (
        (
          parent_ns.nspname = 'public'
          and parent_class.relname = 'profiles'
          and parent_attr.attname = 'user_id'
        )
        or (
          parent_ns.nspname = 'auth'
          and parent_class.relname = 'users'
          and parent_attr.attname = 'id'
        )
      )
  loop
    execute format(
      'update %I.%I as target
          set %I = project.owner_id
         from public.projects as project
        where target.project_id = project.id
          and target.%I = $1
          and project.owner_id <> $1',
      relation.table_schema,
      relation.table_name,
      relation.column_name,
      relation.column_name
    ) using p_user_id;
  end loop;

  -- Optional actor/inviter/resolver references are historical attribution, not
  -- ownership. Remove only the reference and retain the shared record.
  for relation in
    select distinct
      child_ns.nspname as table_schema,
      child_class.relname as table_name,
      child_attr.attname as column_name
    from pg_constraint constraint_row
    join pg_class child_class
      on child_class.oid = constraint_row.conrelid
    join pg_namespace child_ns
      on child_ns.oid = child_class.relnamespace
    join pg_class parent_class
      on parent_class.oid = constraint_row.confrelid
    join pg_namespace parent_ns
      on parent_ns.oid = parent_class.relnamespace
    join unnest(constraint_row.conkey) with ordinality as child_keys(attnum, ord) on true
    join unnest(constraint_row.confkey) with ordinality as parent_keys(attnum, ord)
      on parent_keys.ord = child_keys.ord
    join pg_attribute child_attr
      on child_attr.attrelid = constraint_row.conrelid
      and child_attr.attnum = child_keys.attnum
    join pg_attribute parent_attr
      on parent_attr.attrelid = constraint_row.confrelid
      and parent_attr.attnum = parent_keys.attnum
    where constraint_row.contype = 'f'
      and child_ns.nspname in ('public', 'private')
      and not child_attr.attnotnull
      and child_attr.attname <> 'user_id'
      and (
        (
          parent_ns.nspname = 'public'
          and parent_class.relname = 'profiles'
          and parent_attr.attname = 'user_id'
        )
        or (
          parent_ns.nspname = 'auth'
          and parent_class.relname = 'users'
          and parent_attr.attname = 'id'
        )
      )
  loop
    execute format(
      'update %I.%I set %I = null where %I = $1',
      relation.table_schema,
      relation.table_name,
      relation.column_name,
      relation.column_name
    ) using p_user_id;
  end loop;

  -- Membership and personal rows use ON DELETE CASCADE from the profile/auth
  -- user. The auth user itself is deleted immediately afterwards by the Edge
  -- Function with the service role.
  delete from public.profiles profile
  where profile.user_id = p_user_id;
  get diagnostics removed = row_count;
  total_deleted := total_deleted + removed;

  return total_deleted::integer;
end;
$$;

revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;

create or replace function public.delete_account_data_v2(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  removed_rows integer := 0;
  deletion_project_ids uuid[] := '{}'::uuid[];
begin
  removed_rows := public.delete_account_data(p_user_id);

  select coalesce(job.project_ids, '{}'::uuid[])
  into deletion_project_ids
  from private.account_deletion_jobs job
  where job.user_id = p_user_id;

  return jsonb_build_object(
    'removedRows', removed_rows,
    'projectIds', coalesce(deletion_project_ids, '{}'::uuid[])
  );
end;
$$;

create or replace function public.complete_account_deletion(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, pg_temp
as $$
begin
  delete from private.account_deletion_jobs job
  where job.user_id = p_user_id;
end;
$$;

revoke all on function public.delete_account_data_v2(uuid) from public, anon, authenticated;
revoke all on function public.complete_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data_v2(uuid) to service_role;
grant execute on function public.complete_account_deletion(uuid) to service_role;

commit;
