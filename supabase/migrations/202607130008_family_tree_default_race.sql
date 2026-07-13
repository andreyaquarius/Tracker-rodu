begin;

-- GEDCOM relation batches can arrive concurrently from older clients, multiple
-- tabs or several project editors. Several transactions can therefore discover
-- that a project has no default tree at the same time. Serialize graph
-- projection per project, then let the partial unique index atomically return
-- the winning default row instead of surfacing a duplicate-key error.
create or replace function public.ensure_default_family_tree(target_project_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_tree_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if not public.can_edit_project(target_project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'family_tree_graph_sync:' || target_project_id::text,
      0
    )
  );

  select tree.id
    into target_tree_id
  from public.family_trees as tree
  where tree.project_id = target_project_id
    and tree.is_default
  limit 1;

  if target_tree_id is not null then
    return target_tree_id;
  end if;

  insert into public.family_trees as existing_tree (
    project_id,
    title,
    description,
    is_default,
    privacy_status,
    created_by
  )
  values (
    target_project_id,
    'Родове дерево',
    '',
    true,
    'private',
    auth.uid()
  )
  on conflict (project_id) where is_default do update
    set is_default = existing_tree.is_default
  returning existing_tree.id into target_tree_id;

  return target_tree_id;
end;
$$;

create or replace function public.family_tree_default_for_project(
  target_project_id uuid,
  actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_tree_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'family_tree_graph_sync:' || target_project_id::text,
      0
    )
  );

  select tree.id
    into target_tree_id
  from public.family_trees as tree
  where tree.project_id = target_project_id
    and tree.is_default
  limit 1;

  if target_tree_id is not null then
    return target_tree_id;
  end if;

  insert into public.family_trees as existing_tree (
    project_id,
    title,
    description,
    is_default,
    privacy_status,
    created_by
  )
  values (
    target_project_id,
    'Родове дерево',
    '',
    true,
    'private',
    actor_id
  )
  on conflict (project_id) where is_default do update
    set is_default = existing_tree.is_default
  returning existing_tree.id into target_tree_id;

  return target_tree_id;
end;
$$;

revoke execute on function public.ensure_default_family_tree(uuid)
  from public, anon;
grant execute on function public.ensure_default_family_tree(uuid)
  to authenticated;

revoke execute on function public.family_tree_default_for_project(uuid, uuid)
  from public, anon, authenticated;

comment on function public.ensure_default_family_tree(uuid) is
  'Atomically creates or returns the single default family tree for a project.';
comment on function public.family_tree_default_for_project(uuid, uuid) is
  'Trigger-only atomic default-tree resolver for parallel legacy/GEDCOM relation batches.';

commit;
