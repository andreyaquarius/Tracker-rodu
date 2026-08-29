begin;

-- Fix PL/pgSQL whole-row assignments used by the private attachment review
-- and publication workflows. Selecting the table alias without .* produces a
-- single composite column; assigning that value to a typed row variable makes
-- PostgreSQL try to cast the composite text into the row's first UUID field
-- and raises 22P02. Public wrappers and their existing ACLs remain unchanged.

create or replace function security_private.admin_get_zagulyaka_attachment_review_v1(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a.* into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r.* into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'recordStatus', target_record.status,
    'privacyStatus', target_record.privacy_status,
    'privateBucket', attachment.storage_bucket,
    'privatePath', attachment.storage_path,
    'fileName', attachment.file_name,
    'mimeType', attachment.mime_type,
    'byteSize', attachment.byte_size,
    'isPublicDerivative', attachment.is_public_derivative
  );
end;
$function$;

create or replace function security_private.admin_prepare_zagulyaka_attachment_publication_v1(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  public_path text;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a.* into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r.* into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  if attachment.is_public_derivative then raise exception 'ATTACHMENT_ALREADY_PUBLISHED' using errcode = '55000'; end if;
  if attachment.storage_bucket <> 'zagulyaky-private' then raise exception 'INVALID_PRIVATE_ATTACHMENT_BUCKET' using errcode = '23514'; end if;
  if target_record.status <> 'published' or target_record.privacy_status <> 'cleared' then
    raise exception 'ATTACHMENT_RECORD_NOT_PUBLIC' using errcode = '23514';
  end if;
  public_path := security_private.zagulyaky_public_attachment_path_v1(target_record.id, attachment.id, attachment.file_name);
  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'privateBucket', attachment.storage_bucket,
    'privatePath', attachment.storage_path,
    'publicBucket', 'zagulyaky-public',
    'publicPath', public_path,
    'fileName', attachment.file_name,
    'mimeType', attachment.mime_type,
    'byteSize', attachment.byte_size
  );
end;
$function$;

create or replace function security_private.admin_complete_zagulyaka_attachment_publication_v1(
  p_attachment_id uuid,
  p_public_path text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, storage, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  expected_path text;
  updated_record public.zagulyaky_records;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a.* into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r.* into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  if attachment.is_public_derivative then raise exception 'ATTACHMENT_ALREADY_PUBLISHED' using errcode = '55000'; end if;
  if target_record.status <> 'published' or target_record.privacy_status <> 'cleared' then
    raise exception 'ATTACHMENT_RECORD_NOT_PUBLIC' using errcode = '23514';
  end if;
  expected_path := security_private.zagulyaky_public_attachment_path_v1(target_record.id, attachment.id, attachment.file_name);
  if p_public_path is null or p_public_path is distinct from expected_path then
    raise exception 'INVALID_PUBLIC_ATTACHMENT_PATH' using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'zagulyaky-public' and object.name = expected_path
  ) then
    raise exception 'PUBLIC_ATTACHMENT_OBJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.zagulyaky_attachments
  set public_bucket = 'zagulyaky-public',
      public_path = expected_path,
      is_public_derivative = true
  where id = attachment.id;
  update public.zagulyaky_records set updated_at = now()
  where id = target_record.id returning * into updated_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (target_record.id, current_user_id, 'attachment_publish', target_record.status, updated_record.status,
    jsonb_build_object('attachmentId', attachment.id, 'mimeType', attachment.mime_type, 'byteSize', attachment.byte_size));
  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (current_user_id, 'zagulyaky.attachment.publish', 'zagulyaky_attachment', attachment.id::text, 'success',
    jsonb_build_object('recordId', target_record.id, 'mimeType', attachment.mime_type, 'byteSize', attachment.byte_size));

  return jsonb_build_object('attachmentId', attachment.id, 'recordId', target_record.id, 'publicPath', expected_path);
end;
$function$;

create or replace function security_private.admin_revoke_zagulyaka_attachment_publication_v1(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  updated_record public.zagulyaky_records;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a.* into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r.* into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  if not attachment.is_public_derivative or attachment.public_bucket is null or attachment.public_path is null then
    raise exception 'ATTACHMENT_NOT_PUBLISHED' using errcode = '55000';
  end if;

  update public.zagulyaky_attachments
  set public_bucket = null, public_path = null, is_public_derivative = false
  where id = attachment.id;
  update public.zagulyaky_records set updated_at = now()
  where id = target_record.id returning * into updated_record;
  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (target_record.id, current_user_id, 'attachment_revoke', target_record.status, updated_record.status,
    jsonb_build_object('attachmentId', attachment.id));
  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (current_user_id, 'zagulyaky.attachment.revoke', 'zagulyaky_attachment', attachment.id::text, 'success',
    jsonb_build_object('recordId', target_record.id));
  return jsonb_build_object('attachmentId', attachment.id, 'publicBucket', attachment.public_bucket, 'publicPath', attachment.public_path);
end;
$function$;

create or replace function security_private.admin_prepare_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, storage, pg_temp
as $function$
declare
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  expected_path text;
  target_exists boolean := false;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a.* into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r.* into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  if attachment.storage_bucket <> 'zagulyaky-private' then
    raise exception 'INVALID_PRIVATE_ATTACHMENT_BUCKET' using errcode = '23514';
  end if;

  if attachment.is_public_derivative then
    if attachment.public_bucket is distinct from 'zagulyaky-public'
      or attachment.public_path is null then
      raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
    end if;
    -- Published legacy derivatives can predate `public_derivative_generation`.
    -- Their recorded path remains valid until revoked; all later publications
    -- receive a fresh v2 path below.
    expected_path := attachment.public_path;
    if exists (
      select 1
      from public.zagulyaky_storage_cleanup_queue cleanup_task
      where cleanup_task.storage_bucket = 'zagulyaky-public'
        and cleanup_task.storage_path = expected_path
        and cleanup_task.status in ('queued', 'retry', 'processing')
    ) then
      raise exception 'PUBLIC_ATTACHMENT_CLEANUP_PENDING' using errcode = '55000';
    end if;
    target_exists := exists (
      select 1
      from storage.objects object
      where object.bucket_id = 'zagulyaky-public'
        and object.name = expected_path
    );
    return jsonb_build_object(
      'attachmentId', attachment.id,
      'recordId', target_record.id,
      'privateBucket', attachment.storage_bucket,
      'privatePath', attachment.storage_path,
      'publicBucket', 'zagulyaky-public',
      'publicPath', expected_path,
      'fileName', attachment.file_name,
      'mimeType', attachment.mime_type,
      'byteSize', attachment.byte_size,
      'publicationState', 'published',
      'targetExists', target_exists
    );
  end if;
  if attachment.public_bucket is not null or attachment.public_path is not null then
    raise exception 'PUBLIC_ATTACHMENT_METADATA_INCONSISTENT' using errcode = '23514';
  end if;
  if target_record.status <> 'published' or target_record.privacy_status <> 'cleared' then
    raise exception 'ATTACHMENT_RECORD_NOT_PUBLIC' using errcode = '23514';
  end if;

  -- Allocation happens in the same locked transaction as prepare. If upload
  -- succeeds but the caller times out before complete, another prepare sees
  -- this exact generation and safely resumes instead of orphaning a copy.
  if attachment.public_derivative_generation is null then
    update public.zagulyaky_attachments
    set public_derivative_generation = gen_random_uuid()
    where id = attachment.id
    returning * into attachment;
  end if;
  expected_path := security_private.zagulyaky_public_attachment_path_v2(
    target_record.id,
    attachment.id,
    attachment.public_derivative_generation,
    attachment.file_name
  );
  if exists (
    select 1
    from public.zagulyaky_storage_cleanup_queue cleanup_task
    where cleanup_task.storage_bucket = 'zagulyaky-public'
      and cleanup_task.storage_path = expected_path
      and cleanup_task.status in ('queued', 'retry', 'processing')
  ) then
    raise exception 'PUBLIC_ATTACHMENT_CLEANUP_PENDING' using errcode = '55000';
  end if;
  target_exists := exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'zagulyaky-public'
      and object.name = expected_path
  );

  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'privateBucket', attachment.storage_bucket,
    'privatePath', attachment.storage_path,
    'publicBucket', 'zagulyaky-public',
    'publicPath', expected_path,
    'fileName', attachment.file_name,
    'mimeType', attachment.mime_type,
    'byteSize', attachment.byte_size,
    'publicDerivativeGeneration', attachment.public_derivative_generation,
    'publicationState', case when target_exists then 'uploaded' else 'ready' end,
    'targetExists', target_exists
  );
end;
$function$;

create or replace function security_private.admin_complete_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid,
  p_public_path text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, storage, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  expected_path text;
  updated_record public.zagulyaky_records;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a.* into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r.* into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  if attachment.storage_bucket <> 'zagulyaky-private' then
    raise exception 'INVALID_PRIVATE_ATTACHMENT_BUCKET' using errcode = '23514';
  end if;

  if attachment.is_public_derivative then
    if attachment.public_bucket is distinct from 'zagulyaky-public'
      or attachment.public_path is null then
      raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
    end if;
    expected_path := attachment.public_path;
  else
    if attachment.public_derivative_generation is null then
      raise exception 'PUBLIC_ATTACHMENT_PREPARATION_REQUIRED' using errcode = '55000';
    end if;
    expected_path := security_private.zagulyaky_public_attachment_path_v2(
      target_record.id,
      attachment.id,
      attachment.public_derivative_generation,
      attachment.file_name
    );
  end if;
  if p_public_path is null or p_public_path is distinct from expected_path then
    raise exception 'INVALID_PUBLIC_ATTACHMENT_PATH' using errcode = '22023';
  end if;
  -- A generation is never reused. This check protects the one active
  -- generation while its revocation remains physically in flight.
  if exists (
    select 1
    from public.zagulyaky_storage_cleanup_queue cleanup_task
    where cleanup_task.storage_bucket = 'zagulyaky-public'
      and cleanup_task.storage_path = expected_path
      and cleanup_task.status in ('queued', 'retry', 'processing')
  ) then
    raise exception 'PUBLIC_ATTACHMENT_CLEANUP_PENDING' using errcode = '55000';
  end if;

  if attachment.is_public_derivative then
    return jsonb_build_object(
      'attachmentId', attachment.id,
      'recordId', target_record.id,
      'publicBucket', 'zagulyaky-public',
      'publicPath', expected_path,
      'alreadyPublished', true
    );
  end if;
  if target_record.status <> 'published' or target_record.privacy_status <> 'cleared' then
    raise exception 'ATTACHMENT_RECORD_NOT_PUBLIC' using errcode = '23514';
  end if;
  if attachment.public_bucket is not null or attachment.public_path is not null then
    raise exception 'PUBLIC_ATTACHMENT_METADATA_INCONSISTENT' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'zagulyaky-public'
      and object.name = expected_path
  ) then
    raise exception 'PUBLIC_ATTACHMENT_OBJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.zagulyaky_attachments
  set public_bucket = 'zagulyaky-public',
      public_path = expected_path,
      is_public_derivative = true
  where id = attachment.id;
  update public.zagulyaky_records set updated_at = clock_timestamp()
  where id = target_record.id returning * into updated_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (
    target_record.id,
    current_user_id,
    'attachment_publish',
    target_record.status,
    updated_record.status,
    jsonb_build_object('attachmentId', attachment.id, 'mimeType', attachment.mime_type, 'byteSize', attachment.byte_size)
  );
  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (
    current_user_id,
    'zagulyaky.attachment.publish',
    'zagulyaky_attachment',
    attachment.id::text,
    'success',
    jsonb_build_object('recordId', target_record.id, 'mimeType', attachment.mime_type, 'byteSize', attachment.byte_size)
  );

  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'publicBucket', 'zagulyaky-public',
    'publicPath', expected_path,
    'alreadyPublished', false
  );
end;
$function$;

create or replace function security_private.admin_revoke_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  expected_path text;
  cleanup_task jsonb;
  cleanup_task_id uuid;
  cleanup_status text;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a.* into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r.* into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;

  if not attachment.is_public_derivative or attachment.public_bucket is null or attachment.public_path is null then
    select task.id, task.status into cleanup_task_id, cleanup_status
    from public.zagulyaky_storage_cleanup_queue task
    where task.source_attachment_id = attachment.id
      and task.storage_bucket = 'zagulyaky-public'
    -- A stale worker can update an older generation after a later revoke.
    -- The most recently *created* public task is the current generation.
    order by task.created_at desc, task.id desc
    limit 1;
    if found then
      return jsonb_build_object(
        'attachmentId', attachment.id,
        'recordId', target_record.id,
        'cleanupTaskId', cleanup_task_id,
        'cleanupStatus', cleanup_status,
        'alreadyRevoked', true
      );
    end if;
    raise exception 'ATTACHMENT_NOT_PUBLISHED' using errcode = '55000';
  end if;

  expected_path := attachment.public_path;
  if attachment.public_bucket is distinct from 'zagulyaky-public' then
    raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
  end if;
  if attachment.public_derivative_generation is not null
    and expected_path is distinct from security_private.zagulyaky_public_attachment_path_v2(
      target_record.id,
      attachment.id,
      attachment.public_derivative_generation,
      attachment.file_name
    ) then
    raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
  end if;

  cleanup_task := security_private.enqueue_zagulyaky_storage_cleanup_v1(
    target_record.id,
    attachment.id,
    coalesce(target_record.created_by, current_user_id),
    attachment.public_bucket,
    attachment.public_path
  );
  cleanup_task_id := (cleanup_task ->> 'taskId')::uuid;
  cleanup_status := cleanup_task ->> 'status';

  update public.zagulyaky_attachments
  set public_bucket = null,
      public_path = null,
      public_derivative_generation = null,
      is_public_derivative = false
  where id = attachment.id;
  update public.zagulyaky_records set updated_at = clock_timestamp()
  where id = target_record.id returning * into target_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (
    target_record.id,
    current_user_id,
    'attachment_revoke',
    target_record.status,
    target_record.status,
    jsonb_build_object('attachmentId', attachment.id, 'cleanupTaskId', cleanup_task_id)
  );
  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (
    current_user_id,
    'zagulyaky.attachment.revoke',
    'zagulyaky_attachment',
    attachment.id::text,
    'success',
    jsonb_build_object('recordId', target_record.id, 'cleanupTaskId', cleanup_task_id)
  );

  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'cleanupTaskId', cleanup_task_id,
    'cleanupStatus', cleanup_status,
    'alreadyRevoked', false
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;

