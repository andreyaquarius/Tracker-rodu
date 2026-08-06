begin;

-- Owners may still read, restore, download and delete existing manual copies,
-- but new browser uploads are limited to the bounded automatic rotation. The
-- client removes the oldest object before uploading the next one; the count
-- check is only a fail-closed guard for stale or modified clients.
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
  and (
    select count(*)
    from storage.objects existing
    where existing.bucket_id = 'project-backups'
      and public.storage_project_id(existing.name) =
        public.storage_project_id(objects.name)
      and split_part(existing.name, '/', 2) like
        'tracker-rodu-automatic-%.json'
  ) < 7
);

-- Backups are immutable. The application uploads a new object and prunes old
-- automatic copies instead of overwriting an existing snapshot.
drop policy if exists project_backups_update_owner on storage.objects;

commit;
