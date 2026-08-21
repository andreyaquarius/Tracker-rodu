begin;

-- Stage 2 moderator workflows are deliberately added after the catalogue
-- foundation.  They expose only reviewed, bounded moderator projections and
-- keep every elevated implementation outside the PostgREST public schema.

alter table public.zagulyaky_moderation_actions
  drop constraint if exists zagulyaky_moderation_actions_action_check;

alter table public.zagulyaky_moderation_actions
  add constraint zagulyaky_moderation_actions_action_check check (action in (
    'submit', 'withdraw', 'publish', 'request_changes', 'reject',
    'archive', 'restore', 'merge', 'privacy_block', 'privacy_clear',
    'duplicate_candidate_create', 'duplicate_candidate_confirm',
    'duplicate_candidate_dismiss', 'claim_review', 'claim_resolve',
    'claim_reject'
  ));

create index if not exists zagulyaky_duplicate_candidates_status_idx
  on public.zagulyaky_duplicate_candidates(status, created_at desc);

create index if not exists admin_audit_log_zagulyaky_target_idx
  on public.admin_audit_log(target_type, target_id, created_at desc)
  where target_type like 'zagulyaky%';

create or replace function security_private.admin_get_zagulyaka_review_bundle_v1(
  p_record_id uuid,
  p_version_limit integer default 40,
  p_action_limit integer default 80
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
  safe_version_limit integer := least(greatest(coalesce(p_version_limit, 40), 1), 100);
  safe_action_limit integer := least(greatest(coalesce(p_action_limit, 80), 1), 200);
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  if not exists (select 1 from public.zagulyaky_records where id = p_record_id) then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'record', to_jsonb(r) - 'search_vector',
    'sources', coalesce((
      select jsonb_agg((to_jsonb(s) - 'created_by') || jsonb_build_object('isPrimary', rs.is_primary)
        order by rs.is_primary desc, s.created_at, s.id)
      from public.zagulyaky_record_sources rs
      join public.zagulyaky_sources s on s.id = rs.source_id
      where rs.record_id = r.id
    ), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.sort_order, p.id)
      from public.zagulyaky_participants p
      where p.record_id = r.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.id)
      from public.zagulyaky_document_discoveries d
      where d.record_id = r.id
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(to_jsonb(a) - 'created_by' order by a.created_at, a.id)
      from public.zagulyaky_attachments a
      where a.record_id = r.id
    ), '[]'::jsonb),
    'versions', coalesce((
      select jsonb_agg(to_jsonb(version_row) order by version_row.revision_no desc)
      from (
        select version.id, version.revision_no, version.snapshot,
          version.actor_id, version.created_at
        from public.zagulyaky_record_versions version
        where version.record_id = r.id
        order by version.revision_no desc
        limit safe_version_limit
      ) version_row
    ), '[]'::jsonb),
    'moderationActions', coalesce((
      select jsonb_agg(to_jsonb(action_row) order by action_row.created_at desc, action_row.id desc)
      from (
        select action.id, action.action, action.from_status, action.to_status,
          action.note, action.metadata, action.created_at
        from public.zagulyaky_moderation_actions action
        where action.record_id = r.id
        order by action.created_at desc, action.id desc
        limit safe_action_limit
      ) action_row
    ), '[]'::jsonb),
    'adminAudit', coalesce((
      select jsonb_agg(to_jsonb(audit_row) order by audit_row.created_at desc, audit_row.id desc)
      from (
        select audit.id, audit.action_code, audit.target_type, audit.target_id,
          audit.outcome, audit.sanitized_diff, audit.created_at
        from public.admin_audit_log audit
        where audit.target_type = 'zagulyaky_record'
          and audit.target_id = r.id::text
        order by audit.created_at desc, audit.id desc
        limit safe_action_limit
      ) audit_row
    ), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(to_jsonb(claim_row) order by claim_row.created_at desc, claim_row.id desc)
      from (
        select claim.id, claim.claim_type, claim.message, claim.status,
          claim.resolution_note, claim.resolved_at, claim.created_at, claim.updated_at
        from public.zagulyaky_claims claim
        where claim.record_id = r.id
        order by claim.created_at desc, claim.id desc
        limit safe_action_limit
      ) claim_row
    ), '[]'::jsonb)
  ) into result
  from public.zagulyaky_records r
  where r.id = p_record_id;

  return result;
end;
$function$;

create or replace function public.admin_get_zagulyaka_review_bundle_v1(
  p_record_id uuid,
  p_version_limit integer default 40,
  p_action_limit integer default 80
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaka_review_bundle_v1($1, $2, $3)
$function$;

create or replace function security_private.admin_list_zagulyaky_duplicate_candidates_v1(
  p_record_id uuid default null,
  p_status text default 'pending',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
  safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  safe_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending', 'confirmed', 'dismissed') then
    raise exception 'INVALID_DUPLICATE_CANDIDATE_STATUS' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'items', coalesce(jsonb_agg((to_jsonb(item) - 'status_order') order by item.status_order, item.score desc, item.created_at desc), '[]'::jsonb),
    'total', (
      select count(*)
      from public.zagulyaky_duplicate_candidates candidate
      where (p_record_id is null or candidate.record_id = p_record_id or candidate.candidate_record_id = p_record_id)
        and (p_status is null or candidate.status = p_status)
    )
  ) into result
  from (
    select candidate.record_id, candidate.candidate_record_id, candidate.score,
      candidate.reasons, candidate.status, candidate.reviewed_at, candidate.created_at,
      jsonb_build_object(
        'id', left_record.id,
        'kind', left_record.kind,
        'status', left_record.status,
        'privacyStatus', left_record.privacy_status,
        'title', left_record.title,
        'publicSlug', left_record.public_slug,
        'lockVersion', left_record.lock_version,
        'updatedAt', left_record.updated_at
      ) as record,
      jsonb_build_object(
        'id', right_record.id,
        'kind', right_record.kind,
        'status', right_record.status,
        'privacyStatus', right_record.privacy_status,
        'title', right_record.title,
        'publicSlug', right_record.public_slug,
        'lockVersion', right_record.lock_version,
        'updatedAt', right_record.updated_at
      ) as candidate,
      case candidate.status when 'pending' then 0 when 'confirmed' then 1 else 2 end as status_order
    from public.zagulyaky_duplicate_candidates candidate
    join public.zagulyaky_records left_record on left_record.id = candidate.record_id
    join public.zagulyaky_records right_record on right_record.id = candidate.candidate_record_id
    where (p_record_id is null or candidate.record_id = p_record_id or candidate.candidate_record_id = p_record_id)
      and (p_status is null or candidate.status = p_status)
    order by case candidate.status when 'pending' then 0 when 'confirmed' then 1 else 2 end,
      candidate.score desc, candidate.created_at desc
    limit safe_limit
    offset safe_offset
  ) item;

  return result;
end;
$function$;

create or replace function public.admin_list_zagulyaky_duplicate_candidates_v1(
  p_record_id uuid default null,
  p_status text default 'pending',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_list_zagulyaky_duplicate_candidates_v1($1, $2, $3, $4)
$function$;

create or replace function security_private.admin_create_zagulyaka_duplicate_candidate_v1(
  p_record_id uuid,
  p_candidate_record_id uuid,
  p_score numeric default 0.5000,
  p_reasons jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  left_id uuid;
  right_id uuid;
  existing public.zagulyaky_duplicate_candidates;
  saved public.zagulyaky_duplicate_candidates;
  normalized_reasons jsonb := coalesce(p_reasons, '[]'::jsonb);
  preserve_confirmed boolean := false;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_record_id is null or p_candidate_record_id is null or p_record_id = p_candidate_record_id then
    raise exception 'INVALID_DUPLICATE_RECORD_PAIR' using errcode = '22023';
  end if;
  if p_score is null or p_score < 0 or p_score > 1 then
    raise exception 'INVALID_DUPLICATE_SCORE' using errcode = '22023';
  end if;
  if jsonb_typeof(normalized_reasons) <> 'array'
    or jsonb_array_length(normalized_reasons) > 20
    or octet_length(normalized_reasons::text) > 12000 then
    raise exception 'INVALID_DUPLICATE_REASONS' using errcode = '22023';
  end if;
  if not exists (select 1 from public.zagulyaky_records where id = p_record_id)
    or not exists (select 1 from public.zagulyaky_records where id = p_candidate_record_id) then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if (select kind from public.zagulyaky_records where id = p_record_id)
    is distinct from (select kind from public.zagulyaky_records where id = p_candidate_record_id) then
    raise exception 'DUPLICATE_KIND_MISMATCH' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.zagulyaky_records
    where id in (p_record_id, p_candidate_record_id)
      and status = 'merged'
  ) then
    raise exception 'MERGED_ZAGULYAKA_CANNOT_BE_DUPLICATE_CANDIDATE' using errcode = '55000';
  end if;

  left_id := least(p_record_id, p_candidate_record_id);
  right_id := greatest(p_record_id, p_candidate_record_id);

  select * into existing
  from public.zagulyaky_duplicate_candidates
  where record_id = left_id and candidate_record_id = right_id
  for update;

  if found and existing.status = 'confirmed' then
    preserve_confirmed := true;
    saved := existing;
  elsif found then
    update public.zagulyaky_duplicate_candidates
    set score = p_score,
      reasons = normalized_reasons,
      status = 'pending',
      reviewed_by = null,
      reviewed_at = null
    where record_id = left_id and candidate_record_id = right_id
    returning * into saved;
  else
    insert into public.zagulyaky_duplicate_candidates(
      record_id, candidate_record_id, score, reasons
    ) values (left_id, right_id, p_score, normalized_reasons)
    returning * into saved;
  end if;

  if not preserve_confirmed then
    insert into public.zagulyaky_moderation_actions(
      record_id, actor_id, action, from_status, to_status, note, metadata
    ) values
      (left_id, current_user_id, 'duplicate_candidate_create', null, null, '',
        jsonb_build_object('counterpartId', right_id, 'score', saved.score, 'reasonCount', jsonb_array_length(saved.reasons))),
      (right_id, current_user_id, 'duplicate_candidate_create', null, null, '',
        jsonb_build_object('counterpartId', left_id, 'score', saved.score, 'reasonCount', jsonb_array_length(saved.reasons)));

    insert into public.admin_audit_log(
      admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
    ) values (
      current_user_id, 'zagulyaky.duplicate_candidate.create', 'zagulyaky_duplicate_candidate',
      left_id::text || ':' || right_id::text, 'success',
      jsonb_build_object('score', saved.score, 'reasonCount', jsonb_array_length(saved.reasons), 'status', saved.status)
    );
  end if;

  return to_jsonb(saved);
end;
$function$;

create or replace function public.admin_create_zagulyaka_duplicate_candidate_v1(
  p_record_id uuid,
  p_candidate_record_id uuid,
  p_score numeric default 0.5000,
  p_reasons jsonb default '[]'::jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_create_zagulyaka_duplicate_candidate_v1($1, $2, $3, $4)
$function$;

create or replace function security_private.admin_resolve_zagulyaka_duplicate_candidate_v1(
  p_record_id uuid,
  p_candidate_record_id uuid,
  p_status text,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  left_id uuid;
  right_id uuid;
  existing public.zagulyaky_duplicate_candidates;
  saved public.zagulyaky_duplicate_candidates;
  normalized_note text := btrim(coalesce(p_note, ''));
  action_code text;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_record_id is null or p_candidate_record_id is null or p_record_id = p_candidate_record_id then
    raise exception 'INVALID_DUPLICATE_RECORD_PAIR' using errcode = '22023';
  end if;
  if p_status not in ('confirmed', 'dismissed') then
    raise exception 'INVALID_DUPLICATE_CANDIDATE_STATUS' using errcode = '22023';
  end if;
  if char_length(normalized_note) < 3 then
    raise exception 'DUPLICATE_RESOLUTION_NOTE_REQUIRED' using errcode = '23514';
  end if;

  left_id := least(p_record_id, p_candidate_record_id);
  right_id := greatest(p_record_id, p_candidate_record_id);

  select * into existing
  from public.zagulyaky_duplicate_candidates
  where record_id = left_id and candidate_record_id = right_id
  for update;
  if not found then
    raise exception 'ZAGULYAKA_DUPLICATE_CANDIDATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if existing.status = p_status then
    return to_jsonb(existing);
  end if;

  update public.zagulyaky_duplicate_candidates
  set status = p_status,
    reviewed_by = current_user_id,
    reviewed_at = now()
  where record_id = left_id and candidate_record_id = right_id
  returning * into saved;

  action_code := case when p_status = 'confirmed'
    then 'duplicate_candidate_confirm' else 'duplicate_candidate_dismiss' end;
  insert into public.zagulyaky_moderation_actions(
    record_id, actor_id, action, from_status, to_status, note, metadata
  ) values
    (left_id, current_user_id, action_code, null, null, normalized_note,
      jsonb_build_object('counterpartId', right_id, 'candidateStatus', p_status, 'score', saved.score)),
    (right_id, current_user_id, action_code, null, null, normalized_note,
      jsonb_build_object('counterpartId', left_id, 'candidateStatus', p_status, 'score', saved.score));

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id, 'zagulyaky.duplicate_candidate.' || p_status,
    'zagulyaky_duplicate_candidate', left_id::text || ':' || right_id::text,
    'success', jsonb_build_object('status', p_status, 'score', saved.score)
  );

  return to_jsonb(saved);
end;
$function$;

create or replace function public.admin_resolve_zagulyaka_duplicate_candidate_v1(
  p_record_id uuid,
  p_candidate_record_id uuid,
  p_status text,
  p_note text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_resolve_zagulyaka_duplicate_candidate_v1($1, $2, $3, $4)
$function$;

create or replace function security_private.admin_merge_zagulyaka_duplicate_v1(
  p_survivor_record_id uuid,
  p_merged_record_id uuid,
  p_survivor_expected_lock_version integer,
  p_merged_expected_lock_version integer,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  left_id uuid;
  right_id uuid;
  candidate public.zagulyaky_duplicate_candidates;
  survivor public.zagulyaky_records;
  merged_record public.zagulyaky_records;
  updated_merged public.zagulyaky_records;
  normalized_note text := btrim(coalesce(p_note, ''));
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_survivor_record_id is null or p_merged_record_id is null
    or p_survivor_record_id = p_merged_record_id then
    raise exception 'INVALID_DUPLICATE_RECORD_PAIR' using errcode = '22023';
  end if;
  if p_survivor_expected_lock_version is null or p_survivor_expected_lock_version < 1
    or p_merged_expected_lock_version is null or p_merged_expected_lock_version < 1 then
    raise exception 'INVALID_ZAGULYAKA_LOCK_VERSION' using errcode = '22023';
  end if;
  if char_length(normalized_note) < 3 then
    raise exception 'DUPLICATE_MERGE_NOTE_REQUIRED' using errcode = '23514';
  end if;

  left_id := least(p_survivor_record_id, p_merged_record_id);
  right_id := greatest(p_survivor_record_id, p_merged_record_id);
  select * into candidate
  from public.zagulyaky_duplicate_candidates
  where record_id = left_id and candidate_record_id = right_id
  for update;
  if not found or candidate.status <> 'confirmed' then
    raise exception 'DUPLICATE_CONFIRMATION_REQUIRED' using errcode = '55000';
  end if;

  -- Lock records in a deterministic order before reading their current values.
  perform 1
  from public.zagulyaky_records
  where id in (left_id, right_id)
  order by id
  for update;

  select * into survivor from public.zagulyaky_records where id = p_survivor_record_id;
  select * into merged_record from public.zagulyaky_records where id = p_merged_record_id;
  if not found then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_survivor_expected_lock_version is null
    or p_merged_expected_lock_version is null
    or survivor.lock_version is distinct from p_survivor_expected_lock_version
    or merged_record.lock_version is distinct from p_merged_expected_lock_version then
    raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if survivor.kind <> merged_record.kind then
    raise exception 'DUPLICATE_KIND_MISMATCH' using errcode = '23514';
  end if;
  if survivor.status in ('merged', 'archived', 'rejected') then
    raise exception 'INVALID_DUPLICATE_SURVIVOR_STATUS' using errcode = '55000';
  end if;
  if merged_record.status = 'merged' then
    raise exception 'ZAGULYAKA_ALREADY_MERGED' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.zagulyaky_claims claim
    where claim.record_id in (survivor.id, merged_record.id)
      and claim.status in ('open', 'reviewing')
  ) then
    raise exception 'OPEN_ZAGULYAKA_CLAIM_BLOCKS_MERGE' using errcode = '55000';
  end if;

  update public.zagulyaky_records
  set status = 'merged',
    merged_into_id = survivor.id,
    moderated_by = current_user_id,
    moderation_note = normalized_note
  where id = merged_record.id
  returning * into updated_merged;

  insert into public.zagulyaky_moderation_actions(
    record_id, actor_id, action, from_status, to_status, note, metadata
  ) values
    (survivor.id, current_user_id, 'merge', survivor.status, survivor.status, normalized_note,
      jsonb_build_object('mergedRecordId', updated_merged.id, 'role', 'survivor')),
    (updated_merged.id, current_user_id, 'merge', merged_record.status, 'merged', normalized_note,
      jsonb_build_object('survivorRecordId', survivor.id, 'role', 'merged'));

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id, 'zagulyaky.duplicate.merge', 'zagulyaky_duplicate_merge',
    updated_merged.id::text, 'success',
    jsonb_build_object('survivorRecordId', survivor.id, 'mergedRecordId', updated_merged.id)
  );

  return jsonb_build_object(
    'survivor', to_jsonb(survivor) - 'search_vector',
    'merged', to_jsonb(updated_merged) - 'search_vector',
    'candidate', to_jsonb(candidate)
  );
end;
$function$;

create or replace function public.admin_merge_zagulyaka_duplicate_v1(
  p_survivor_record_id uuid,
  p_merged_record_id uuid,
  p_survivor_expected_lock_version integer,
  p_merged_expected_lock_version integer,
  p_note text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_merge_zagulyaka_duplicate_v1($1, $2, $3, $4, $5)
$function$;

create or replace function security_private.admin_resolve_zagulyaka_claim_v2(
  p_claim_id uuid,
  p_status text,
  p_resolution_note text default '',
  p_record_action text default 'none'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing_claim public.zagulyaky_claims;
  updated_claim public.zagulyaky_claims;
  existing_record public.zagulyaky_records;
  updated_record public.zagulyaky_records;
  normalized_note text := btrim(coalesce(p_resolution_note, ''));
  action_code text;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_status not in ('reviewing', 'resolved', 'rejected') then
    raise exception 'INVALID_CLAIM_STATUS' using errcode = '22023';
  end if;
  if p_record_action not in ('none', 'privacy_block', 'archive') then
    raise exception 'INVALID_CLAIM_RECORD_ACTION' using errcode = '22023';
  end if;
  if p_status in ('resolved', 'rejected') and char_length(normalized_note) < 3 then
    raise exception 'RESOLUTION_NOTE_REQUIRED' using errcode = '23514';
  end if;
  if p_record_action <> 'none' and char_length(normalized_note) < 3 then
    raise exception 'CLAIM_RECORD_ACTION_NOTE_REQUIRED' using errcode = '23514';
  end if;
  if p_status = 'reviewing' and p_record_action = 'archive' then
    raise exception 'CLAIM_ARCHIVE_REQUIRES_FINAL_RESOLUTION' using errcode = '55000';
  end if;
  if p_status = 'rejected' and p_record_action <> 'none' then
    raise exception 'REJECTED_CLAIM_CANNOT_CHANGE_RECORD' using errcode = '55000';
  end if;

  select * into existing_claim
  from public.zagulyaky_claims
  where id = p_claim_id
  for update;
  if not found then
    raise exception 'ZAGULYAKA_CLAIM_NOT_FOUND' using errcode = 'P0002';
  end if;
  if existing_claim.status in ('resolved', 'rejected') then
    raise exception 'ZAGULYAKA_CLAIM_ALREADY_CLOSED' using errcode = '55000';
  end if;

  if p_record_action <> 'none' then
    select * into existing_record
    from public.zagulyaky_records
    where id = existing_claim.record_id
    for update;
    if not found then
      raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
    end if;
    if existing_record.status = 'merged' then
      raise exception 'MERGED_ZAGULYAKA_CANNOT_BE_CLAIM_TARGET' using errcode = '55000';
    end if;

    if p_record_action = 'privacy_block' then
      update public.zagulyaky_records
      set privacy_status = 'blocked',
        moderated_by = current_user_id,
        moderation_note = normalized_note
      where id = existing_record.id
      returning * into updated_record;

      insert into public.zagulyaky_moderation_actions(
        record_id, actor_id, action, from_status, to_status, note, metadata
      ) values (
        updated_record.id, current_user_id, 'privacy_block', existing_record.status,
        updated_record.status, normalized_note,
        jsonb_build_object('claimId', existing_claim.id, 'claimType', existing_claim.claim_type)
      );
    else
      if existing_record.status not in ('published', 'rejected') then
        raise exception 'INVALID_MODERATION_TRANSITION' using errcode = '55000';
      end if;
      update public.zagulyaky_records
      set status = 'archived',
        moderated_by = current_user_id,
        moderation_note = normalized_note
      where id = existing_record.id
      returning * into updated_record;

      insert into public.zagulyaky_moderation_actions(
        record_id, actor_id, action, from_status, to_status, note, metadata
      ) values (
        updated_record.id, current_user_id, 'archive', existing_record.status,
        'archived', normalized_note,
        jsonb_build_object('claimId', existing_claim.id, 'claimType', existing_claim.claim_type)
      );
    end if;
  end if;

  update public.zagulyaky_claims
  set status = p_status,
    resolution_note = nullif(normalized_note, ''),
    resolved_by = case when p_status in ('resolved', 'rejected') then current_user_id else null end,
    resolved_at = case when p_status in ('resolved', 'rejected') then now() else null end,
    updated_at = now()
  where id = existing_claim.id
  returning * into updated_claim;

  action_code := case p_status
    when 'reviewing' then 'claim_review'
    when 'resolved' then 'claim_resolve'
    else 'claim_reject'
  end;
  insert into public.zagulyaky_moderation_actions(
    record_id, actor_id, action, from_status, to_status, note, metadata
  ) values (
    existing_claim.record_id, current_user_id, action_code, null, null, normalized_note,
    jsonb_build_object(
      'claimId', existing_claim.id,
      'claimType', existing_claim.claim_type,
      'fromClaimStatus', existing_claim.status,
      'toClaimStatus', p_status,
      'recordAction', p_record_action
    )
  );

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id, 'zagulyaky.claim.' || p_status, 'zagulyaky_claim', existing_claim.id::text,
    'success', jsonb_build_object('claimType', existing_claim.claim_type, 'recordAction', p_record_action)
  );

  return jsonb_build_object(
    'claim', to_jsonb(updated_claim) - 'submitted_by' - 'resolved_by',
    'record', case when updated_record.id is null then null
      else to_jsonb(updated_record) - 'search_vector' end
  );
end;
$function$;

create or replace function public.admin_resolve_zagulyaka_claim_v2(
  p_claim_id uuid,
  p_status text,
  p_resolution_note text default '',
  p_record_action text default 'none'
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_resolve_zagulyaka_claim_v2($1, $2, $3, $4)
$function$;

revoke all on function security_private.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)
  from public, anon, authenticated, service_role;

grant execute on function security_private.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  to authenticated, service_role;
grant execute on function security_private.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)
  to authenticated, service_role;
grant execute on function security_private.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)
  to authenticated, service_role;
grant execute on function security_private.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)
  to authenticated, service_role;
grant execute on function security_private.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)
  to authenticated, service_role;
grant execute on function security_private.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)
  to authenticated, service_role;

revoke all on function public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)
  from public, anon, authenticated, service_role;

grant execute on function public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)
  to authenticated, service_role;
grant execute on function public.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)
  to authenticated, service_role;
grant execute on function public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)
  to authenticated, service_role;
grant execute on function public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)
  to authenticated, service_role;

commit;
