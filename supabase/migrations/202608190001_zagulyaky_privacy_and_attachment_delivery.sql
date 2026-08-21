begin;

-- Close the documented living-person rule at the database boundary.  A
-- potential living person can be visible only after a moderator records a
-- private, documented consent decision.  The proof reference is deliberately
-- never included in public projections, sitemap data, or browser logs.
create table if not exists public.zagulyaky_privacy_clearances (
  record_id uuid primary key references public.zagulyaky_records(id) on delete cascade,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'revoked', 'rejected')),
  publication_basis text not null default 'documented_consent'
    check (publication_basis in ('documented_consent')),
  consent_obtained_at timestamptz,
  evidence_reference text not null default ''
    check (char_length(evidence_reference) <= 500),
  private_note text not null default ''
    check (char_length(private_note) <= 3000),
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  reviewed_at timestamptz,
  revoked_by uuid references public.profiles(user_id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zagulyaky_privacy_clearances_status_idx
  on public.zagulyaky_privacy_clearances(review_status, reviewed_at desc);

alter table public.zagulyaky_privacy_clearances enable row level security;
revoke all on table public.zagulyaky_privacy_clearances from public, anon, authenticated;
grant all on table public.zagulyaky_privacy_clearances to service_role;

create or replace function security_private.zagulyaky_has_living_person_clearance_v1(
  p_record_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select exists (
    select 1
    from public.zagulyaky_privacy_clearances clearance
    where clearance.record_id = p_record_id
      and clearance.review_status = 'approved'
      and clearance.publication_basis = 'documented_consent'
      and clearance.consent_obtained_at is not null
      and char_length(btrim(clearance.evidence_reference)) >= 3
  )
$function$;

-- This trigger protects every write path, including a future RPC or a manual
-- moderator action that might otherwise bypass the current review endpoint.
create or replace function security_private.enforce_zagulyaky_living_person_privacy_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  has_clearance boolean := false;
begin
  if new.possible_living_person then
    has_clearance := security_private.zagulyaky_has_living_person_clearance_v1(new.id);
    if not has_clearance then
      -- Marking an edited historic record as potentially living must remove a
      -- stale clearance before it can be submitted again.
      if tg_op = 'UPDATE' and not coalesce(old.possible_living_person, false) then
        new.privacy_status := 'requires_consent';
      end if;
      if new.status = 'published' or new.privacy_status = 'cleared' then
        raise exception 'LIVING_PERSON_DOCUMENTED_CONSENT_REQUIRED' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

-- Existing potential-living records lose public visibility until a moderator
-- records a clearance.  The public projection already filters on `cleared`;
-- no existing personal data is copied or disclosed by this migration.
update public.zagulyaky_records
set privacy_status = 'requires_consent'
where possible_living_person
  and privacy_status = 'cleared'
  and not security_private.zagulyaky_has_living_person_clearance_v1(id);

drop trigger if exists zagulyaky_records_living_person_privacy on public.zagulyaky_records;
create trigger zagulyaky_records_living_person_privacy
before insert or update on public.zagulyaky_records
for each row execute function security_private.enforce_zagulyaky_living_person_privacy_v1();

create or replace function security_private.admin_get_zagulyaka_privacy_clearance_v1(
  p_record_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.zagulyaky_records where id = p_record_id) then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'recordId', clearance.record_id,
    'reviewStatus', clearance.review_status,
    'publicationBasis', clearance.publication_basis,
    'consentObtainedAt', clearance.consent_obtained_at,
    'evidenceReference', clearance.evidence_reference,
    'privateNote', clearance.private_note,
    'reviewedAt', clearance.reviewed_at,
    'revokedAt', clearance.revoked_at
  ) into result
  from public.zagulyaky_privacy_clearances clearance
  where clearance.record_id = p_record_id;

  return coalesce(result, jsonb_build_object(
    'recordId', p_record_id,
    'reviewStatus', 'missing',
    'publicationBasis', null,
    'consentObtainedAt', null,
    'evidenceReference', '',
    'privateNote', ''
  ));
end;
$function$;

create or replace function public.admin_get_zagulyaka_privacy_clearance_v1(
  p_record_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaka_privacy_clearance_v1($1)
$function$;

create or replace function security_private.admin_record_zagulyaka_living_consent_v1(
  p_record_id uuid,
  p_consent_obtained_at timestamptz,
  p_evidence_reference text,
  p_private_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  target_record public.zagulyaky_records;
  saved public.zagulyaky_privacy_clearances;
  visibility_restored boolean := false;
  normalized_reference text := btrim(coalesce(p_evidence_reference, ''));
  normalized_note text := btrim(coalesce(p_private_note, ''));
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_consent_obtained_at is null or p_consent_obtained_at > now() + interval '1 day' then
    raise exception 'INVALID_CONSENT_DATE' using errcode = '22023';
  end if;
  if char_length(normalized_reference) not between 3 and 500 then
    raise exception 'CONSENT_EVIDENCE_REFERENCE_REQUIRED' using errcode = '23514';
  end if;
  if char_length(normalized_note) > 3000 then
    raise exception 'CONSENT_NOTE_TOO_LONG' using errcode = '22023';
  end if;

  select * into target_record
  from public.zagulyaky_records
  where id = p_record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if not target_record.possible_living_person then
    raise exception 'LIVING_PERSON_FLAG_REQUIRED' using errcode = '23514';
  end if;

  insert into public.zagulyaky_privacy_clearances(
    record_id, review_status, publication_basis, consent_obtained_at,
    evidence_reference, private_note, reviewed_by, reviewed_at,
    revoked_by, revoked_at, updated_at
  ) values (
    target_record.id, 'approved', 'documented_consent', p_consent_obtained_at,
    normalized_reference, normalized_note, current_user_id, now(), null, null, now()
  )
  on conflict (record_id) do update set
    review_status = 'approved',
    publication_basis = 'documented_consent',
    consent_obtained_at = excluded.consent_obtained_at,
    evidence_reference = excluded.evidence_reference,
    private_note = excluded.private_note,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at,
    revoked_by = null,
    revoked_at = null,
    updated_at = now()
  returning * into saved;

  -- Migration of an already-published potential living person deliberately
  -- hides it with `requires_consent` without changing the historic published
  -- status. Once the missing documented consent is recorded, restore only that
  -- narrowly-defined visibility state. Do not auto-clear a general `blocked`
  -- decision: it may represent an unrelated unresolved privacy claim.
  if target_record.status = 'published' and target_record.privacy_status = 'requires_consent' then
    update public.zagulyaky_records
    set privacy_status = 'cleared'
    where id = target_record.id;
    visibility_restored := found;
  end if;

  insert into public.zagulyaky_moderation_actions(
    record_id, actor_id, action, from_status, to_status, note, metadata
  ) values (
    target_record.id, current_user_id, 'privacy_clear', target_record.status,
    target_record.status, 'Задокументовано згоду для потенційно живої особи',
    jsonb_build_object(
      'basis', 'documented_consent',
      'evidenceReferenceProvided', true,
      'publicVisibilityRestored', visibility_restored
    )
  );
  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id, 'zagulyaky.privacy_consent.record', 'zagulyaky_record',
    target_record.id::text, 'success',
    jsonb_build_object(
      'basis', saved.publication_basis,
      'evidenceReferenceProvided', true,
      'publicVisibilityRestored', visibility_restored
    )
  );

  return jsonb_build_object(
    'recordId', saved.record_id,
    'reviewStatus', saved.review_status,
    'publicationBasis', saved.publication_basis,
    'consentObtainedAt', saved.consent_obtained_at,
    'evidenceReference', saved.evidence_reference,
    'privateNote', saved.private_note,
    'reviewedAt', saved.reviewed_at,
    'publicVisibilityRestored', visibility_restored
  );
end;
$function$;

create or replace function public.admin_record_zagulyaka_living_consent_v1(
  p_record_id uuid,
  p_consent_obtained_at timestamptz,
  p_evidence_reference text,
  p_private_note text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_record_zagulyaka_living_consent_v1($1, $2, $3, $4)
$function$;

-- Public derivatives are private Storage objects too.  They are delivered
-- through a short-lived Edge signed URL only after the public-record guard is
-- re-evaluated, so a privacy block immediately prevents new direct access.
update storage.buckets
set public = false
where id = 'zagulyaky-public';

alter table public.zagulyaky_moderation_actions
  drop constraint if exists zagulyaky_moderation_actions_action_check;
alter table public.zagulyaky_moderation_actions
  add constraint zagulyaky_moderation_actions_action_check check (action in (
    'submit', 'withdraw', 'publish', 'request_changes', 'reject',
    'archive', 'restore', 'merge', 'privacy_block', 'privacy_clear',
    'duplicate_candidate_create', 'duplicate_candidate_confirm',
    'duplicate_candidate_dismiss', 'claim_review', 'claim_resolve',
    'claim_reject', 'attachment_add', 'attachment_remove',
    'attachment_publish', 'attachment_revoke'
  ));

-- Version snapshots intentionally contain a small manifest, not Storage paths,
-- hashes or private metadata. It lets a moderator see that evidence changed
-- without turning immutable history into an attachment-disclosure channel.
create or replace function security_private.capture_zagulyaky_record_version_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  full_snapshot jsonb;
begin
  select jsonb_build_object(
    'record', to_jsonb(new) - 'search_vector',
    'sources', coalesce((
      select jsonb_agg((to_jsonb(source) - 'created_by') || jsonb_build_object('isPrimary', link.is_primary)
        order by link.is_primary desc, source.created_at, source.id)
      from public.zagulyaky_record_sources link
      join public.zagulyaky_sources source on source.id = link.source_id
      where link.record_id = new.id
    ), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(to_jsonb(participant) order by participant.sort_order, participant.id)
      from public.zagulyaky_participants participant where participant.record_id = new.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(to_jsonb(discovery) order by discovery.id)
      from public.zagulyaky_document_discoveries discovery where discovery.record_id = new.id
    ), '[]'::jsonb),
    'attachmentManifest', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', attachment.id,
        'fileName', attachment.file_name,
        'mimeType', attachment.mime_type,
        'byteSize', attachment.byte_size,
        'isPublicDerivative', attachment.is_public_derivative
      ) order by attachment.created_at, attachment.id)
      from public.zagulyaky_attachments attachment
      where attachment.record_id = new.id
    ), '[]'::jsonb)
  ) into full_snapshot;

  insert into public.zagulyaky_record_versions(record_id, revision_no, snapshot, actor_id)
  values (new.id, new.lock_version, full_snapshot, auth.uid())
  on conflict (record_id, revision_no) do nothing;
  return new;
end;
$function$;

create or replace function security_private.audit_zagulyaky_attachment_change_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  attachment_id uuid;
  parent_record_id uuid;
  attachment_mime text;
  attachment_size bigint;
begin
  if tg_op = 'INSERT' then
    attachment_id := new.id;
    parent_record_id := new.record_id;
    attachment_mime := new.mime_type;
    attachment_size := new.byte_size;
    insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, metadata)
    values (parent_record_id, auth.uid(), 'attachment_add',
      jsonb_build_object('attachmentId', attachment_id, 'mimeType', attachment_mime, 'byteSize', attachment_size));
  elsif tg_op = 'DELETE' then
    attachment_id := old.id;
    parent_record_id := old.record_id;
    attachment_mime := old.mime_type;
    attachment_size := old.byte_size;
    insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, metadata)
    values (parent_record_id, auth.uid(), 'attachment_remove',
      jsonb_build_object('attachmentId', attachment_id, 'mimeType', attachment_mime, 'byteSize', attachment_size));
  end if;
  if tg_op = 'INSERT' then return new; end if;
  return old;
end;
$function$;

drop trigger if exists zagulyaky_attachments_audit_change on public.zagulyaky_attachments;
create trigger zagulyaky_attachments_audit_change
after insert or delete on public.zagulyaky_attachments
for each row execute function security_private.audit_zagulyaky_attachment_change_v1();

create or replace function security_private.zagulyaky_public_attachment_path_v1(
  p_record_id uuid,
  p_attachment_id uuid,
  p_file_name text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select 'catalogue/' || p_record_id::text || '/' || p_attachment_id::text || '/' ||
    coalesce(
      nullif(trim(both '-' from regexp_replace(lower(coalesce(p_file_name, '')), '[^a-z0-9._-]+', '-', 'g')), ''),
      'attachment'
    )
$function$;

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
  select a into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r into target_record
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

create or replace function public.admin_get_zagulyaka_attachment_review_v1(
  p_attachment_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaka_attachment_review_v1($1)
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
  select a into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r into target_record
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

create or replace function public.admin_prepare_zagulyaka_attachment_publication_v1(
  p_attachment_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_prepare_zagulyaka_attachment_publication_v1($1)
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
  select a into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r into target_record
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

create or replace function public.admin_complete_zagulyaka_attachment_publication_v1(
  p_attachment_id uuid,
  p_public_path text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_complete_zagulyaka_attachment_publication_v1($1, $2)
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
  select a into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r into target_record
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

create or replace function public.admin_revoke_zagulyaka_attachment_publication_v1(
  p_attachment_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_revoke_zagulyaka_attachment_publication_v1($1)
$function$;

create or replace function security_private.get_public_zagulyaka_attachment_delivery_v1(
  p_attachment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select coalesce(jsonb_build_object(
    'attachmentId', attachment.id,
    'bucket', attachment.public_bucket,
    'path', attachment.public_path,
    'fileName', attachment.file_name,
    'mimeType', attachment.mime_type
  ), '{}'::jsonb)
  from public.zagulyaky_attachments attachment
  join public.zagulyaky_records target_record on target_record.id = attachment.record_id
  where attachment.id = p_attachment_id
    and attachment.is_public_derivative
    and attachment.public_bucket is not null
    and attachment.public_path is not null
    and target_record.status = 'published'
    and target_record.privacy_status = 'cleared'
$function$;

create or replace function public.get_public_zagulyaka_attachment_delivery_v1(
  p_attachment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select security_private.get_public_zagulyaka_attachment_delivery_v1($1)
$function$;

-- A v2 delete response preserves only the private object locations long
-- enough for the authenticated owner to remove them after the DB transaction.
-- This replaces the UI path while keeping v1 available for old clients.
create or replace function public.delete_my_zagulyaka_draft_v2(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  existing public.zagulyaky_records;
  owned_source_ids uuid[] := '{}'::uuid[];
  private_objects jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from auth.uid() then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_DELETABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', attachment.storage_bucket, 'path', attachment.storage_path)), '[]'::jsonb)
  into private_objects
  from public.zagulyaky_attachments attachment
  where attachment.record_id = existing.id
    and attachment.storage_bucket = 'zagulyaky-private';
  select coalesce(array_agg(rs.source_id), '{}'::uuid[]) into owned_source_ids
  from public.zagulyaky_record_sources rs where rs.record_id = existing.id;
  delete from public.zagulyaky_records where id = existing.id;
  delete from public.zagulyaky_sources source
  where source.id = any(owned_source_ids)
    and source.created_by = auth.uid()
    and not exists (select 1 from public.zagulyaky_record_sources rs where rs.source_id = source.id);
  return jsonb_build_object('recordId', existing.id, 'privateObjects', private_objects);
end;
$function$;

revoke all on function security_private.zagulyaky_has_living_person_clearance_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.enforce_zagulyaky_living_person_privacy_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.capture_zagulyaky_record_version_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.audit_zagulyaky_attachment_change_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaka_privacy_clearance_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_record_zagulyaka_living_consent_v1(uuid,timestamptz,text,text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_public_attachment_path_v1(uuid,uuid,text) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaka_attachment_review_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_prepare_zagulyaka_attachment_publication_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_complete_zagulyaka_attachment_publication_v1(uuid,text) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_revoke_zagulyaka_attachment_publication_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.get_public_zagulyaka_attachment_delivery_v1(uuid) from public, anon, authenticated, service_role;

-- The moderator facades below are SECURITY INVOKER so that auth.uid() and the
-- moderator-permission check see the actual caller. PostgreSQL therefore also
-- requires authenticated API roles to invoke these *private* definer
-- implementations; the functions remain in a non-exposed schema and enforce
-- authorization before returning any data. The anonymous delivery facade is a
-- separate SECURITY DEFINER function because anon deliberately has no USAGE
-- on the private schema and its implementation filters to public records.
grant execute on function security_private.admin_get_zagulyaka_privacy_clearance_v1(uuid) to authenticated, service_role;
grant execute on function security_private.admin_record_zagulyaka_living_consent_v1(uuid,timestamptz,text,text) to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaka_attachment_review_v1(uuid) to authenticated, service_role;
grant execute on function security_private.admin_prepare_zagulyaka_attachment_publication_v1(uuid) to authenticated, service_role;
grant execute on function security_private.admin_complete_zagulyaka_attachment_publication_v1(uuid,text) to authenticated, service_role;
grant execute on function security_private.admin_revoke_zagulyaka_attachment_publication_v1(uuid) to authenticated, service_role;
grant execute on function security_private.get_public_zagulyaka_attachment_delivery_v1(uuid) to authenticated, service_role;

revoke all on function public.admin_get_zagulyaka_privacy_clearance_v1(uuid) from public, anon;
revoke all on function public.admin_record_zagulyaka_living_consent_v1(uuid,timestamptz,text,text) from public, anon;
revoke all on function public.admin_prepare_zagulyaka_attachment_publication_v1(uuid) from public, anon;
revoke all on function public.admin_get_zagulyaka_attachment_review_v1(uuid) from public, anon;
revoke all on function public.admin_complete_zagulyaka_attachment_publication_v1(uuid,text) from public, anon;
revoke all on function public.admin_revoke_zagulyaka_attachment_publication_v1(uuid) from public, anon;
revoke all on function public.delete_my_zagulyaka_draft_v2(uuid,integer) from public, anon;
revoke all on function public.get_public_zagulyaka_attachment_delivery_v1(uuid) from public;

grant execute on function public.admin_get_zagulyaka_privacy_clearance_v1(uuid) to authenticated, service_role;
grant execute on function public.admin_record_zagulyaka_living_consent_v1(uuid,timestamptz,text,text) to authenticated, service_role;
grant execute on function public.admin_prepare_zagulyaka_attachment_publication_v1(uuid) to authenticated, service_role;
grant execute on function public.admin_get_zagulyaka_attachment_review_v1(uuid) to authenticated, service_role;
grant execute on function public.admin_complete_zagulyaka_attachment_publication_v1(uuid,text) to authenticated, service_role;
grant execute on function public.admin_revoke_zagulyaka_attachment_publication_v1(uuid) to authenticated, service_role;
grant execute on function public.delete_my_zagulyaka_draft_v2(uuid,integer) to authenticated, service_role;
grant execute on function public.get_public_zagulyaka_attachment_delivery_v1(uuid) to anon, authenticated, service_role;

commit;
