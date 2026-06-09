begin;

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-backups', 'project-backups', false, 104857600)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

drop policy if exists project_backups_select_owner on storage.objects;
drop policy if exists project_backups_insert_owner on storage.objects;
drop policy if exists project_backups_update_owner on storage.objects;
drop policy if exists project_backups_delete_owner on storage.objects;

create policy project_backups_select_owner
on storage.objects for select to authenticated
using (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
);

create policy project_backups_insert_owner
on storage.objects for insert to authenticated
with check (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
);

create policy project_backups_update_owner
on storage.objects for update to authenticated
using (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
)
with check (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
);

create policy project_backups_delete_owner
on storage.objects for delete to authenticated
using (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
);

commit;
