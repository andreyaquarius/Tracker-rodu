begin;

-- A stale optimistic-read token is an expected cache conflict, not a failed
-- database transaction. Returning a small marker prevents PostgreSQL from
-- recording hundreds of thousands of 5xx errors while the client rebases.
-- The v1 neighborhood facade intentionally remains unchanged: the private v2
-- implementation still delegates through it, so v2 is the safe catch boundary.

create or replace function public.get_family_tree_neighborhood_v2(p_request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.get_family_tree_neighborhood_v2(p_request);
exception
  when sqlstate '40001' then
    if sqlerrm in ('TREE_GRAPH_VERSION_CHANGED', 'TREE_PERMISSION_SCOPE_CHANGED') then
      return jsonb_build_object('conflictCode', sqlerrm);
    end if;
    raise;
end;
$wrapper$;

create or replace function public.get_family_tree_family_children_v1(p_request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.get_family_tree_family_children_v1(p_request);
exception
  when sqlstate '40001' then
    if sqlerrm in ('TREE_GRAPH_VERSION_CHANGED', 'TREE_PERMISSION_SCOPE_CHANGED') then
      return jsonb_build_object('conflictCode', sqlerrm);
    end if;
    raise;
end;
$wrapper$;

create or replace function public.get_family_tree_descendants_frontier_v1(p_request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.get_family_tree_descendants_frontier_v1(p_request);
exception
  when sqlstate '40001' then
    if sqlerrm in ('TREE_GRAPH_VERSION_CHANGED', 'TREE_PERMISSION_SCOPE_CHANGED') then
      return jsonb_build_object('conflictCode', sqlerrm);
    end if;
    raise;
end;
$wrapper$;

create or replace function public.get_family_tree_root_lineage_v1(p_request jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.get_family_tree_root_lineage_v1(p_request);
exception
  when sqlstate '40001' then
    if sqlerrm in ('TREE_GRAPH_VERSION_CHANGED', 'TREE_PERMISSION_SCOPE_CHANGED') then
      return jsonb_build_object('conflictCode', sqlerrm);
    end if;
    raise;
end;
$wrapper$;

revoke all on function public.get_family_tree_neighborhood_v2(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_family_tree_family_children_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_family_tree_descendants_frontier_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_family_tree_root_lineage_v1(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.get_family_tree_neighborhood_v2(jsonb)
  to authenticated, service_role;
grant execute on function public.get_family_tree_family_children_v1(jsonb)
  to authenticated, service_role;
grant execute on function public.get_family_tree_descendants_frontier_v1(jsonb)
  to authenticated, service_role;
grant execute on function public.get_family_tree_root_lineage_v1(jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
