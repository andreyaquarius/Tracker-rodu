begin;

-- A Google Drive object may be cited by several records or by several events.
-- The old global bucket/path constraint treated the attachment table as object
-- storage even though each row is an owner/field association.
alter table public.attachments
  drop constraint if exists attachments_storage_bucket_storage_path_key;

alter table public.attachments
  drop constraint if exists attachments_owner_field_storage_path_key;

alter table public.attachments
  add constraint attachments_owner_field_storage_path_key
  unique (project_id, owner_type, owner_id, field_key, storage_bucket, storage_path);

commit;
