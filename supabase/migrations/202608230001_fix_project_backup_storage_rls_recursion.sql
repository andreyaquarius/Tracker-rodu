begin;

-- Do not read storage.objects from a policy on storage.objects. PostgreSQL
-- applies RLS to that nested read too, which re-enters this policy and raises
-- 42P17 (infinite recursion). Keep the existing seven-copy guard in a narrow
-- SECURITY DEFINER helper instead, where it runs as postgres and bypasses
-- storage.objects RLS.
create or replace function security_private.project_backup_slot_available_v1(
  p_project_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  -- This helper is executable from an RLS policy, so it must also be safe if
  -- called directly by an authenticated user.
  if auth.uid() is null
    or p_project_id is null
    or not public.is_project_owner(p_project_id)
    or not public.can_edit_project(p_project_id)
  then
    return false;
  end if;

  return (
    select count(*) < 7
    from storage.objects existing
    where existing.bucket_id = 'project-backups'
      and public.storage_project_id(existing.name) = p_project_id
      and pg_catalog.split_part(existing.name, '/', 2) like
        'tracker-rodu-automatic-%.json'
  );
end;
$function$;

revoke all on function security_private.project_backup_slot_available_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.project_backup_slot_available_v1(uuid)
  to authenticated;

drop policy if exists project_backups_insert_owner on storage.objects;

create policy project_backups_insert_owner
on storage.objects for insert to authenticated
with check (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
  and public.can_edit_project(public.storage_project_id(name))
  and length(name) - length(replace(name, '/', '')) = 1
  and split_part(name, '/', 2) ~
    '^tracker-rodu-automatic-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z[.]json$'
  and security_private.project_backup_slot_available_v1(
    public.storage_project_id(name)
  )
);

commit;
