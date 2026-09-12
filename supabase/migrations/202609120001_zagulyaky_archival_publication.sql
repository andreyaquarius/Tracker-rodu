begin;

-- Historical archive material has a moderator-reviewed basis of its own.
-- Never invent consent, clear every living-person flag, or auto-approve imports.
alter table public.zagulyaky_privacy_clearances
  drop constraint zagulyaky_privacy_clearances_publication_basis_check;
alter table public.zagulyaky_privacy_clearances
  add constraint zagulyaky_privacy_clearances_publication_basis_check
  check (publication_basis in ('documented_consent', 'historical_archive'));

create or replace function security_private.zagulyaky_has_living_person_clearance_v1(p_record_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select exists (
    select 1 from public.zagulyaky_privacy_clearances clearance
    where clearance.record_id = p_record_id
      and clearance.review_status = 'approved'
      and clearance.reviewed_content_fingerprint ~ '^[0-9a-f]{64}$'
      and clearance.reviewed_content_fingerprint =
        security_private.zagulyaky_living_person_content_fingerprint_v1(p_record_id)
      and (
        (clearance.publication_basis = 'documented_consent'
          and clearance.consent_obtained_at is not null
          and char_length(btrim(clearance.evidence_reference)) >= 3)
        or (clearance.publication_basis = 'historical_archive'
          and clearance.consent_obtained_at is null
          and clearance.reviewed_by is not null and clearance.reviewed_at is not null
          and exists (
            select 1 from public.zagulyaky_record_sources rs
            join public.zagulyaky_sources source on source.id = rs.source_id
            where rs.record_id = p_record_id
              and clearance.evidence_reference = 'archival-source:' || source.id::text
              and source.permission_status <> 'restricted'
              and (nullif(btrim(source.citation), '') is not null
                or nullif(btrim(source.archive_name), '') is not null
                or source.source_url ~* '^https?://')
          ))
      )
  )
$function$;

-- The attestation and publication are one transaction. An invalid/stale review
-- must not leave an approval behind; the caller cannot use this as a bypass for
-- a blocked record or for an unrelated source. Existing consent RPCs stay intact.
create or replace function security_private.admin_publish_archival_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_source_id uuid,
  p_note text default '',
  p_verification_status text default null,
  p_public_slug text default null
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  existing public.zagulyaky_records;
  fingerprint text;
  result jsonb;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select r.* into existing from public.zagulyaky_records r where r.id = p_record_id for update;
  if not found then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then
    raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if existing.status <> 'pending_review' then
    raise exception 'INVALID_MODERATION_TRANSITION' using errcode = '55000';
  end if;
  if existing.privacy_status = 'blocked' then
    raise exception 'ARCHIVAL_PUBLICATION_BLOCKED' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.zagulyaky_record_sources rs
    join public.zagulyaky_sources source on source.id = rs.source_id
    where rs.record_id = p_record_id and source.id = p_source_id
      and source.permission_status <> 'restricted'
      and (nullif(btrim(source.citation), '') is not null
        or nullif(btrim(source.archive_name), '') is not null
        or source.source_url ~* '^https?://')
  ) then raise exception 'ARCHIVAL_PUBLICATION_SOURCE_REQUIRED' using errcode = '23514'; end if;

  fingerprint := security_private.zagulyaky_living_person_content_fingerprint_v1(p_record_id);
  if fingerprint is null or fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'LIVING_PERSON_CONTENT_FINGERPRINT_REQUIRED' using errcode = '23514';
  end if;
  insert into public.zagulyaky_privacy_clearances (
    record_id, review_status, publication_basis, consent_obtained_at, evidence_reference,
    private_note, reviewed_by, reviewed_at, reviewed_content_fingerprint, revoked_by, revoked_at
  ) values (
    p_record_id, 'approved', 'historical_archive', null, 'archival-source:' || p_source_id::text,
    'Модератор підтвердив: опубліковане архівне джерело, без даних живих осіб.',
    auth.uid(), now(), fingerprint, null, null
  ) on conflict (record_id) do update set
    review_status = excluded.review_status,
    publication_basis = excluded.publication_basis,
    consent_obtained_at = null,
    evidence_reference = excluded.evidence_reference,
    private_note = excluded.private_note,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at,
    reviewed_content_fingerprint = excluded.reviewed_content_fingerprint,
    revoked_by = null, revoked_at = null, updated_at = now()
  where zagulyaky_privacy_clearances.record_id = p_record_id;

  result := security_private.admin_review_zagulyaka_v1(
    p_record_id, p_expected_lock_version, 'publish', p_note, p_verification_status, 'cleared', p_public_slug
  );
  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, note)
  values (p_record_id, auth.uid(), 'privacy_clear', existing.status, 'published',
    'Опубліковане архівне джерело; модератор підтвердив відсутність даних живих осіб.');
  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (auth.uid(), 'zagulyaky.archival_publication', 'zagulyaky_record', p_record_id::text, 'success',
    jsonb_build_object('publicationBasis', 'historical_archive', 'sourceId', p_source_id,
      'reviewedContentFingerprint', fingerprint));
  return result;
end;
$function$;

create or replace function public.admin_publish_archival_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_source_id uuid,
  p_note text default '',
  p_verification_status text default null,
  p_public_slug text default null
)
returns jsonb language sql volatile security invoker
set search_path = ''
as $function$
  select security_private.admin_publish_archival_zagulyaka_v1(
    p_record_id, p_expected_lock_version, p_source_id, p_note, p_verification_status, p_public_slug
  )
$function$;

revoke all on function security_private.admin_publish_archival_zagulyaka_v1(uuid, integer, uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_publish_archival_zagulyaka_v1(uuid, integer, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.admin_publish_archival_zagulyaka_v1(uuid, integer, uuid, text, text, text) to authenticated;
grant execute on function public.admin_publish_archival_zagulyaka_v1(uuid, integer, uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
