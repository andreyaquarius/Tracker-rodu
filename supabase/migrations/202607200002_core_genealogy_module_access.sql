begin;

-- Family Tree and Persons V2 are core authenticated modules. Tariff capacity
-- is enforced separately by subscription reservation/usage functions, while
-- the existing restrictive project policies continue to enforce membership
-- and role access.
create or replace function security_private.can_use_family_tree_feature()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null;
$function$;

create or replace function public.can_use_family_tree_feature()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select auth.uid() is not null;
$function$;

create or replace function public.get_my_family_tree_feature_access()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select auth.uid() is not null;
$function$;

create or replace function public.assert_family_tree_feature_access()
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $function$
begin
  if auth.uid() is null then
    raise exception 'FAMILY_TREE_FEATURE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return true;
end;
$function$;

-- Workers authorize GEDCOM export jobs for the recorded requester rather than
-- the current JWT. Keep owner/editor/admin project authorization, but remove
-- the retired per-user beta table from that decision.
create or replace function security_private.gedcom_export_request_authorized(
  target_user_id uuid,
  target_project_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select target_user_id is not null
    and target_project_id is not null
    and exists (
      select 1
      from public.projects project
      where project.id = target_project_id
        and not project.deletion_pending
        and (
          project.owner_id = target_user_id
          or public.is_app_admin(target_user_id)
          or exists (
            select 1
            from public.project_members member
            where member.project_id = project.id
              and member.user_id = target_user_id
              and member.role in ('owner', 'editor')
          )
        )
    );
$function$;

revoke all on function security_private.can_use_family_tree_feature()
  from public, anon;
grant execute on function security_private.can_use_family_tree_feature()
  to authenticated, service_role;

revoke all on function security_private.gedcom_export_request_authorized(uuid, uuid)
  from public, anon;
grant execute on function security_private.gedcom_export_request_authorized(uuid, uuid)
  to authenticated, service_role;

revoke all on function public.can_use_family_tree_feature()
  from public, anon;
revoke all on function public.get_my_family_tree_feature_access()
  from public, anon;
revoke all on function public.assert_family_tree_feature_access()
  from public, anon;
grant execute on function public.can_use_family_tree_feature()
  to authenticated, service_role;
grant execute on function public.get_my_family_tree_feature_access()
  to authenticated, service_role;
grant execute on function public.assert_family_tree_feature_access()
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
