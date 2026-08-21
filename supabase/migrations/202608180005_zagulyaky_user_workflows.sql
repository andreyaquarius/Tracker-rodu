-- Загуляки: user-side safety and attachment workflow.
--
-- Private originals live in a bucket that only their author can access. A
-- separate server-side workflow may copy an explicitly approved derivative to
-- the public bucket; browser roles never obtain write access to that bucket.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'zagulyaky-private',
    'zagulyaky-private',
    false,
    26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  ),
  (
    'zagulyaky-public',
    'zagulyaky-public',
    true,
    26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  )
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists zagulyaky_private_file_select_own on storage.objects;
create policy zagulyaky_private_file_select_own
on storage.objects for select to authenticated
using (
  bucket_id = 'zagulyaky-private'
  and name like ((select auth.uid())::text || '/%')
);

drop policy if exists zagulyaky_private_file_insert_own on storage.objects;
create policy zagulyaky_private_file_insert_own
on storage.objects for insert to authenticated
with check (
  bucket_id = 'zagulyaky-private'
  and name like ((select auth.uid())::text || '/%')
  and position('..' in name) = 0
);

drop policy if exists zagulyaky_private_file_delete_own on storage.objects;
create policy zagulyaky_private_file_delete_own
on storage.objects for delete to authenticated
using (
  bucket_id = 'zagulyaky-private'
  and name like ((select auth.uid())::text || '/%')
);

-- A possible living person may be submitted, but it is never implicitly
-- cleared for publication. A moderator has to consciously set privacy to
-- `cleared` during review. This makes the original-stage policy enforceable.
create or replace function public.submit_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_SUBMITTABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;
  if btrim(existing.title) = '' or btrim(existing.classification_reason) = '' then
    raise exception 'ZAGULYAKA_REQUIRED_FIELDS_MISSING' using errcode = '23514';
  end if;
  if existing.kind = 'person' and (existing.event_type is null or existing.found_location_text is null) then
    raise exception 'PERSON_EVENT_AND_FOUND_LOCATION_REQUIRED' using errcode = '23514';
  end if;
  if existing.kind = 'person' and not exists (
    select 1 from public.zagulyaky_participants participant
    where participant.record_id = existing.id
      and participant.role = 'subject'
      and nullif(btrim(coalesce(nullif(participant.normalized_uk_full_name, ''), participant.original_full_name)), '') is not null
  ) then
    raise exception 'PERSON_SUBJECT_REQUIRED' using errcode = '23514';
  end if;
  if existing.kind = 'document' and not exists (
    select 1 from public.zagulyaky_document_discoveries discovery
    where discovery.record_id = existing.id
      and nullif(btrim(discovery.official_location_text), '') is not null
      and nullif(btrim(discovery.discovered_location_text), '') is not null
  ) then
    raise exception 'DOCUMENT_LOCATIONS_REQUIRED' using errcode = '23514';
  end if;
  if not exists (select 1 from public.zagulyaky_record_sources rs where rs.record_id = existing.id) then
    raise exception 'ZAGULYAKA_SOURCE_REQUIRED' using errcode = '23514';
  end if;
  if existing.submission_terms_version is null or existing.rights_confirmed_at is null then
    raise exception 'ZAGULYAKA_RIGHTS_CONFIRMATION_REQUIRED' using errcode = '23514';
  end if;

  update public.zagulyaky_records
  set status = 'pending_review',
      submitted_at = now(),
      moderation_note = null,
      -- Any re-submission that is marked as potentially living must re-enter
      -- the consent gate. In particular, a stale `cleared` value from an
      -- earlier review must never survive an author edit/re-submit.
      privacy_status = case
        when possible_living_person then 'requires_consent'
        else privacy_status
      end
  where id = existing.id
  returning * into updated_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (
    existing.id,
    current_user_id,
    'submit',
    existing.status,
    'pending_review',
    jsonb_build_object('possibleLivingPerson', existing.possible_living_person)
  );
  return to_jsonb(updated_record) - 'search_vector';
end;
$function$;

create or replace function public.attach_my_zagulyaka_file_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, storage, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  updated_record public.zagulyaky_records;
  created_attachment public.zagulyaky_attachments;
  expected_prefix text;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then
    raise exception 'ZAGULYAKA_NOT_EDITABLE' using errcode = '55000';
  end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then
    raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001';
  end if;
  expected_prefix := current_user_id::text || '/' || existing.id::text || '/';
  if p_storage_path is null
    or left(p_storage_path, char_length(expected_prefix)) <> expected_prefix
    or position('..' in p_storage_path) > 0 or char_length(p_storage_path) > 500 then
    raise exception 'INVALID_ZAGULYAKA_ATTACHMENT_PATH' using errcode = '22023';
  end if;
  if p_file_name is null or char_length(btrim(p_file_name)) not between 1 and 240 then
    raise exception 'INVALID_ZAGULYAKA_ATTACHMENT_NAME' using errcode = '22023';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then
    raise exception 'INVALID_ZAGULYAKA_ATTACHMENT_MIME' using errcode = '22023';
  end if;
  if p_byte_size is null or p_byte_size not between 1 and 26214400 then
    raise exception 'INVALID_ZAGULYAKA_ATTACHMENT_SIZE' using errcode = '22023';
  end if;
  if p_sha256 is null or lower(p_sha256) !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_ZAGULYAKA_ATTACHMENT_SHA256' using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'zagulyaky-private'
      and object.name = p_storage_path
  ) then
    raise exception 'ZAGULYAKA_ATTACHMENT_OBJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.zagulyaky_attachments(
    record_id, storage_bucket, storage_path, file_name, mime_type, byte_size,
    sha256, is_public_derivative, created_by
  ) values (
    existing.id, 'zagulyaky-private', p_storage_path, btrim(p_file_name), p_mime_type,
    p_byte_size, lower(p_sha256), false, current_user_id
  ) returning * into created_attachment;

  update public.zagulyaky_records set updated_at = now()
  where id = existing.id returning * into updated_record;

  return jsonb_build_object(
    'recordId', updated_record.id,
    'lockVersion', updated_record.lock_version,
    'attachment', to_jsonb(created_attachment) - 'created_by'
  );
end;
$function$;

create or replace function public.delete_my_zagulyaka_attachment_v1(
  p_record_id uuid,
  p_attachment_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  removed_attachment public.zagulyaky_attachments;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then
    raise exception 'ZAGULYAKA_NOT_EDITABLE' using errcode = '55000';
  end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then
    raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001';
  end if;
  delete from public.zagulyaky_attachments
  where id = p_attachment_id
    and record_id = existing.id
    and storage_bucket = 'zagulyaky-private'
    and is_public_derivative = false
  returning * into removed_attachment;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  update public.zagulyaky_records set updated_at = now()
  where id = existing.id returning * into updated_record;
  return jsonb_build_object(
    'recordId', updated_record.id,
    'lockVersion', updated_record.lock_version,
    'storageBucket', removed_attachment.storage_bucket,
    'storagePath', removed_attachment.storage_path
  );
end;
$function$;

revoke all on function public.attach_my_zagulyaka_file_v1(uuid, integer, text, text, text, bigint, text) from public;
revoke all on function public.delete_my_zagulyaka_attachment_v1(uuid, uuid, integer) from public;
grant execute on function public.attach_my_zagulyaka_file_v1(uuid, integer, text, text, text, bigint, text) to authenticated, service_role;
grant execute on function public.delete_my_zagulyaka_attachment_v1(uuid, uuid, integer) to authenticated, service_role;
