begin;

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-attachments', 'project-attachments', false, 2147483648)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

create or replace function public.storage_project_id(object_name text)
returns uuid
language plpgsql
immutable
as $$
declare
  first_segment text;
begin
  first_segment := split_part(object_name, '/', 1);
  return first_segment::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

create policy project_files_select
on storage.objects for select to authenticated
using (
  bucket_id = 'project-attachments'
  and public.is_project_member(public.storage_project_id(name))
);

create policy project_files_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'project-attachments'
  and public.can_edit_project(public.storage_project_id(name))
);

create policy project_files_update
on storage.objects for update to authenticated
using (
  bucket_id = 'project-attachments'
  and public.can_edit_project(public.storage_project_id(name))
)
with check (
  bucket_id = 'project-attachments'
  and public.can_edit_project(public.storage_project_id(name))
);

create policy project_files_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'project-attachments'
  and public.can_edit_project(public.storage_project_id(name))
);

commit;
