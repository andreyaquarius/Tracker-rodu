begin;

-- The family-tree module is private while it is being tested. App
-- administrators always retain access; every other account must be explicitly
-- added to this allow-list by an administrator.
create table if not exists public.family_tree_feature_access (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  granted_by uuid not null references public.profiles(user_id) on delete restrict,
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.family_tree_feature_access enable row level security;
revoke all on public.family_tree_feature_access from anon, authenticated;
grant select, insert, update, delete on public.family_tree_feature_access to service_role;

drop trigger if exists family_tree_feature_access_set_updated_at
  on public.family_tree_feature_access;
create trigger family_tree_feature_access_set_updated_at
before update on public.family_tree_feature_access
for each row execute function public.set_updated_at();

create or replace function public.can_use_family_tree_feature()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and (
      public.is_app_admin(auth.uid())
      or exists (
        select 1
        from public.family_tree_feature_access access
        where access.user_id = auth.uid()
      )
    );
$$;

create or replace function public.get_my_family_tree_feature_access()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select public.can_use_family_tree_feature();
$$;

create or replace function public.assert_family_tree_feature_access()
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if not public.can_use_family_tree_feature() then
    raise exception 'FAMILY_TREE_FEATURE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return true;
end;
$$;

create or replace function public.admin_list_family_tree_feature_access()
returns table (
  user_id uuid,
  email text,
  display_name text,
  is_enabled boolean,
  is_admin boolean,
  granted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    profile.user_id,
    profile.email,
    coalesce(profile.display_name, ''),
    (administrator.user_id is not null or access.user_id is not null),
    (administrator.user_id is not null),
    access.granted_at
  from public.profiles profile
  left join public.app_admins administrator on administrator.user_id = profile.user_id
  left join public.family_tree_feature_access access on access.user_id = profile.user_id
  order by
    (administrator.user_id is not null) desc,
    (access.user_id is not null) desc,
    lower(profile.email);
end;
$$;

create or replace function public.admin_set_family_tree_feature_access(
  target_user_id uuid,
  target_is_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if target_user_id is null
     or not exists (select 1 from public.profiles where user_id = target_user_id) then
    raise exception 'UNKNOWN_USER' using errcode = '22023';
  end if;

  if public.is_app_admin(target_user_id) then
    -- Administrators have permanent access and cannot accidentally be locked
    -- out by deleting an allow-list row.
    delete from public.family_tree_feature_access where user_id = target_user_id;
    return;
  end if;

  if target_is_enabled then
    insert into public.family_tree_feature_access (user_id, granted_by)
    values (target_user_id, auth.uid())
    on conflict (user_id) do update
      set granted_by = excluded.granted_by,
          updated_at = now();
  else
    delete from public.family_tree_feature_access where user_id = target_user_id;
  end if;
end;
$$;

revoke execute on function public.can_use_family_tree_feature() from public, anon;
revoke execute on function public.get_my_family_tree_feature_access() from public, anon;
revoke execute on function public.assert_family_tree_feature_access() from public, anon;
revoke execute on function public.admin_list_family_tree_feature_access() from public, anon;
revoke execute on function public.admin_set_family_tree_feature_access(uuid, boolean) from public, anon;
grant execute on function public.can_use_family_tree_feature() to authenticated;
grant execute on function public.get_my_family_tree_feature_access() to authenticated;
grant execute on function public.assert_family_tree_feature_access() to authenticated;
grant execute on function public.admin_list_family_tree_feature_access() to authenticated;
grant execute on function public.admin_set_family_tree_feature_access(uuid, boolean) to authenticated;

-- Restrictive policies are evaluated in addition to the existing project-role
-- policies. Consequently an account needs both project membership and the
-- private feature entitlement. This protects direct PostgREST table access.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'family_trees',
    'family_tree_persons',
    'family_groups',
    'family_group_members',
    'partner_relationships',
    'parent_sets',
    'parent_child_relationships',
    'association_relationships',
    'tree_layout_positions',
    'gedcom_import_batches',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'family_tree_research_issues',
    'legacy_person_relation_graph_edges',
    'person_names',
    'person_timeline_events'
  ]
  loop
    execute format(
      'drop policy if exists family_tree_feature_entitlement on public.%I',
      table_name
    );
    execute format(
      'create policy family_tree_feature_entitlement on public.%I
       as restrictive for all to authenticated
       using ((select public.can_use_family_tree_feature()))
       with check ((select public.can_use_family_tree_feature()))',
      table_name
    );
  end loop;
end;
$$;

-- Neighborhood RPCs are SECURITY DEFINER for performance and therefore bypass
-- RLS. Keep their implementations private and expose small entitlement-checking
-- wrappers under the original API names.
alter function public.get_family_tree_neighborhood_v1(jsonb)
  rename to get_family_tree_neighborhood_v1_feature_impl;
alter function public.get_family_tree_neighborhood_v2(jsonb)
  rename to get_family_tree_neighborhood_v2_feature_impl;
alter function public.get_family_tree_family_children_v1(jsonb)
  rename to get_family_tree_family_children_v1_feature_impl;
alter function public.get_family_tree_descendants_frontier_v1(jsonb)
  rename to get_family_tree_descendants_frontier_v1_feature_impl;

revoke execute on function public.get_family_tree_neighborhood_v1_feature_impl(jsonb)
  from public, anon, authenticated;
revoke execute on function public.get_family_tree_neighborhood_v2_feature_impl(jsonb)
  from public, anon, authenticated;
revoke execute on function public.get_family_tree_family_children_v1_feature_impl(jsonb)
  from public, anon, authenticated;
revoke execute on function public.get_family_tree_descendants_frontier_v1_feature_impl(jsonb)
  from public, anon, authenticated;

create function public.get_family_tree_neighborhood_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
set statement_timeout = '15s'
as $$
begin
  perform public.assert_family_tree_feature_access();
  return public.get_family_tree_neighborhood_v1_feature_impl(p_request);
end;
$$;

create function public.get_family_tree_neighborhood_v2(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
set statement_timeout = '15s'
as $$
begin
  perform public.assert_family_tree_feature_access();
  return public.get_family_tree_neighborhood_v2_feature_impl(p_request);
end;
$$;

create function public.get_family_tree_family_children_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
set statement_timeout = '15s'
as $$
begin
  perform public.assert_family_tree_feature_access();
  return public.get_family_tree_family_children_v1_feature_impl(p_request);
end;
$$;

create function public.get_family_tree_descendants_frontier_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
set statement_timeout = '15s'
as $$
begin
  perform public.assert_family_tree_feature_access();
  return public.get_family_tree_descendants_frontier_v1_feature_impl(p_request);
end;
$$;

revoke execute on function public.get_family_tree_neighborhood_v1(jsonb) from public, anon;
revoke execute on function public.get_family_tree_neighborhood_v2(jsonb) from public, anon;
revoke execute on function public.get_family_tree_family_children_v1(jsonb) from public, anon;
revoke execute on function public.get_family_tree_descendants_frontier_v1(jsonb) from public, anon;
grant execute on function public.get_family_tree_neighborhood_v1(jsonb) to authenticated;
grant execute on function public.get_family_tree_neighborhood_v2(jsonb) to authenticated;
grant execute on function public.get_family_tree_family_children_v1(jsonb) to authenticated;
grant execute on function public.get_family_tree_descendants_frontier_v1(jsonb) to authenticated;

commit;
