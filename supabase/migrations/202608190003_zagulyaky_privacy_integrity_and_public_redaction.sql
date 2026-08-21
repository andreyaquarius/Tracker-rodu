begin;

-- A consent decision is about a particular version of the person/document and
-- its supporting details, not a permanent blank cheque for a record id.  The
-- fingerprint intentionally excludes workflow fields (status, privacy,
-- moderation notes, timestamps and lock version), so a moderator can publish
-- the reviewed content without invalidating the decision itself.
alter table public.zagulyaky_privacy_clearances
  add column if not exists reviewed_content_fingerprint text;

alter table public.zagulyaky_privacy_clearances
  drop constraint if exists zagulyaky_privacy_clearances_fingerprint_check;
alter table public.zagulyaky_privacy_clearances
  add constraint zagulyaky_privacy_clearances_fingerprint_check check (
    reviewed_content_fingerprint is null
    or reviewed_content_fingerprint ~ '^[0-9a-f]{64}$'
  );

create or replace function security_private.zagulyaky_living_person_content_fingerprint_v1(
  p_record_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  content_snapshot jsonb;
  fingerprint text;
begin
  select jsonb_build_object(
    'record', jsonb_build_object(
      'kind', record_row.kind,
      'title', record_row.title,
      'summary', record_row.summary,
      'originalText', record_row.original_text,
      'normalizedText', record_row.normalized_text,
      'originalLanguage', record_row.original_language,
      'eventType', record_row.event_type,
      'eventDateText', record_row.event_date_text,
      'eventYearFrom', record_row.event_year_from,
      'eventYearTo', record_row.event_year_to,
      'datePrecision', record_row.date_precision,
      'sourceLocationText', record_row.source_location_text,
      'sourceLocationNormalized', record_row.source_location_normalized,
      'foundLocationText', record_row.found_location_text,
      'foundLocationNormalized', record_row.found_location_normalized,
      'classificationReason', record_row.classification_reason,
      'payload', record_row.payload,
      'possibleLivingPerson', record_row.possible_living_person
    ),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', participant.role,
        'originalFullName', participant.original_full_name,
        'normalizedUkFullName', participant.normalized_uk_full_name,
        'surname', participant.surname,
        'givenName', participant.given_name,
        'patronymic', participant.patronymic,
        'maidenName', participant.maiden_name,
        'sex', participant.sex,
        'ageText', participant.age_text,
        'residenceText', participant.residence_text,
        'originText', participant.origin_text,
        'notes', participant.notes,
        'sortOrder', participant.sort_order
      ) order by participant.sort_order, participant.role,
        participant.normalized_uk_full_name, participant.original_full_name,
        participant.id)
      from public.zagulyaky_participants participant
      where participant.record_id = record_row.id
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'isPrimary', link.is_primary,
        'sourceType', source.source_type,
        'title', source.title,
        'archiveName', source.archive_name,
        'fond', source.fond,
        'inventory', source.inventory,
        'fileNumber', source.file_number,
        'pageFrom', source.page_from,
        'pageTo', source.page_to,
        'citation', source.citation,
        'sourceUrl', source.source_url,
        'sourcePlatform', source.source_platform,
        'externalId', source.external_id,
        'accessDate', source.access_date,
        'permissionStatus', source.permission_status,
        'metadata', source.metadata
      ) order by link.is_primary desc, source.source_type, source.title,
        source.citation, source.id)
      from public.zagulyaky_record_sources link
      join public.zagulyaky_sources source on source.id = link.source_id
      where link.record_id = record_row.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'officialLocationText', discovery.official_location_text,
        'discoveredLocationText', discovery.discovered_location_text,
        'recordTypes', discovery.record_types,
        'factualYearFrom', discovery.factual_year_from,
        'factualYearTo', discovery.factual_year_to,
        'pageFrom', discovery.page_from,
        'pageTo', discovery.page_to,
        'notes', discovery.notes
      ) order by discovery.official_location_text, discovery.discovered_location_text,
        discovery.factual_year_from nulls first, discovery.factual_year_to nulls first,
        discovery.page_from nulls first, discovery.page_to nulls first, discovery.id)
      from public.zagulyaky_document_discoveries discovery
      where discovery.record_id = record_row.id
    ), '[]'::jsonb)
  ) into content_snapshot
  from public.zagulyaky_records record_row
  where record_row.id = p_record_id;

  if content_snapshot is null then
    return null;
  end if;

  -- pgcrypto was installed by the initial migration before this feature. Some
  -- established Supabase projects place it in `public`, newer local setups may
  -- place it in `extensions`; resolve the approved function dynamically so the
  -- integrity guard works in either safe schema rather than failing migration.
  if to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute 'select encode(extensions.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into fingerprint using content_snapshot::text;
  elsif to_regprocedure('public.digest(bytea,text)') is not null then
    execute 'select encode(public.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into fingerprint using content_snapshot::text;
  else
    raise exception 'PGCRYPTO_DIGEST_REQUIRED' using errcode = '55000';
  end if;
  return fingerprint;
end;
$function$;

create or replace function security_private.stamp_zagulyaky_privacy_clearance_fingerprint_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  should_stamp boolean := false;
  fingerprint text;
begin
  if new.review_status <> 'approved' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    should_stamp := true;
  elsif old.review_status is distinct from 'approved'
    or new.consent_obtained_at is distinct from old.consent_obtained_at
    or new.evidence_reference is distinct from old.evidence_reference
    or new.publication_basis is distinct from old.publication_basis then
    should_stamp := true;
  end if;

  -- Do not overwrite a historic reviewed fingerprint while a row is merely
  -- being revoked/annotated. A new documented approval is the only action that
  -- creates a new evidence/content binding.
  if should_stamp then
    fingerprint := security_private.zagulyaky_living_person_content_fingerprint_v1(new.record_id);
    if fingerprint is null or fingerprint !~ '^[0-9a-f]{64}$' then
      raise exception 'LIVING_PERSON_CONTENT_FINGERPRINT_REQUIRED' using errcode = '23514';
    end if;
    new.reviewed_content_fingerprint := fingerprint;
  end if;
  return new;
end;
$function$;

drop trigger if exists zagulyaky_privacy_clearances_stamp_fingerprint on public.zagulyaky_privacy_clearances;
create trigger zagulyaky_privacy_clearances_stamp_fingerprint
before insert or update on public.zagulyaky_privacy_clearances
for each row execute function security_private.stamp_zagulyaky_privacy_clearance_fingerprint_v1();

-- 190001 may have already recorded an approval. Preserve those decisions and
-- bind them to the content that exists at the moment this hardening is applied.
update public.zagulyaky_privacy_clearances clearance
set reviewed_content_fingerprint = security_private.zagulyaky_living_person_content_fingerprint_v1(clearance.record_id),
    updated_at = now()
where clearance.review_status = 'approved'
  and (clearance.reviewed_content_fingerprint is null
    or clearance.reviewed_content_fingerprint !~ '^[0-9a-f]{64}$');

alter table public.zagulyaky_privacy_clearances
  drop constraint if exists zagulyaky_privacy_clearances_approved_fingerprint_required;
alter table public.zagulyaky_privacy_clearances
  add constraint zagulyaky_privacy_clearances_approved_fingerprint_required check (
    review_status <> 'approved'
    or reviewed_content_fingerprint ~ '^[0-9a-f]{64}$'
  );

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
      and clearance.reviewed_content_fingerprint ~ '^[0-9a-f]{64}$'
      and clearance.reviewed_content_fingerprint =
        security_private.zagulyaky_living_person_content_fingerprint_v1(p_record_id)
  )
$function$;

-- A privacy block must always be possible, even if a current clearance is
-- missing or stale. It also explicitly revokes consent so it cannot silently
-- resurrect a record after a privacy claim has been handled.
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
      if tg_op = 'UPDATE'
        and not coalesce(old.possible_living_person, false)
        and new.privacy_status is distinct from 'blocked' then
        new.privacy_status := 'requires_consent';
      end if;
      -- `cleared` is the only privacy value that makes a record visible. A
      -- protected transition to `blocked` must never be rejected here.
      if new.privacy_status = 'cleared' then
        raise exception 'LIVING_PERSON_DOCUMENTED_CONSENT_REQUIRED' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function security_private.revoke_zagulyaky_living_clearance_on_privacy_block_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if new.possible_living_person
    and new.privacy_status = 'blocked'
    and old.privacy_status is distinct from 'blocked' then
    update public.zagulyaky_privacy_clearances
    set review_status = 'revoked',
        revoked_by = auth.uid(),
        revoked_at = now(),
        updated_at = now()
    where record_id = new.id
      and review_status = 'approved';
  end if;
  return new;
end;
$function$;

drop trigger if exists zagulyaky_records_revoke_living_clearance_on_privacy_block on public.zagulyaky_records;
create trigger zagulyaky_records_revoke_living_clearance_on_privacy_block
after update on public.zagulyaky_records
for each row execute function security_private.revoke_zagulyaky_living_clearance_on_privacy_block_v1();

-- The moderate-only read tells the UI whether a stored approval still matches
-- the content. The evidence reference itself remains moderator-only.
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
    'revokedAt', clearance.revoked_at,
    'clearanceCurrent', clearance.review_status = 'approved'
      and clearance.reviewed_content_fingerprint =
        security_private.zagulyaky_living_person_content_fingerprint_v1(p_record_id)
  ) into result
  from public.zagulyaky_privacy_clearances clearance
  where clearance.record_id = p_record_id;

  return coalesce(result, jsonb_build_object(
    'recordId', p_record_id,
    'reviewStatus', 'missing',
    'publicationBasis', null,
    'consentObtainedAt', null,
    'evidenceReference', '',
    'privateNote', '',
    'clearanceCurrent', false
  ));
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
    || jsonb_build_object('clearanceCurrent', true)
$function$;

-- Public catalogue payloads must never disclose private Storage bucket/path
-- coordinates. Move the original broad detail function into the non-exposed
-- schema, preserve its behaviour, and expose a filtered/redacted facade.
alter function public.get_public_zagulyaka_v1(text) set schema security_private;
revoke all on function security_private.get_public_zagulyaka_v1(text)
  from public, anon, authenticated, service_role;

create or replace function public.get_public_zagulyaka_v1(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as (
    select security_private.get_public_zagulyaka_v1($1) as payload
  )
  select case
    when source.payload is null then null
    when exists (
      select 1
      from public.zagulyaky_records record_row
      where record_row.id::text = (source.payload ->> 'id')
        and record_row.possible_living_person
        and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
    ) then null
    else jsonb_set(
      source.payload,
      '{publicAttachments}',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', attachment.value -> 'id',
          'fileName', attachment.value -> 'fileName',
          'mimeType', attachment.value -> 'mimeType',
          'byteSize', attachment.value -> 'byteSize'
        ) order by attachment.ordinality)
        from jsonb_array_elements(coalesce(source.payload -> 'publicAttachments', '[]'::jsonb))
          with ordinality as attachment(value, ordinality)
      ), '[]'::jsonb),
      true
    )
  end
  from source
$function$;

-- Search wrappers retain cursor semantics from the original bounded query and
-- remove any now-stale living-person result before it reaches a browser.
--
-- The visibility predicate must also run *inside* the bounded search, before
-- `limit` and cursor construction. Filtering only the serialized `items`
-- would leave a hidden record's id/publishedAt in `nextCursor`, which is still
-- an anonymous disclosure and makes pagination skip unpredictably.
create or replace function security_private.search_zagulyaky_v1(
  p_kind text,
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  result jsonb;
begin
  if p_kind not in ('person', 'document') then
    raise exception 'INVALID_ZAGULYAKY_KIND' using errcode = '22023';
  end if;
  if p_filters is null or jsonb_typeof(p_filters) <> 'object' then
    raise exception 'INVALID_FILTERS' using errcode = '22023';
  end if;
  if char_length(coalesce(p_query, '')) > 200 then
    raise exception 'SEARCH_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  if (p_cursor_published_at is null) <> (p_cursor_id is null) then
    raise exception 'INCOMPLETE_SEARCH_CURSOR' using errcode = '22023';
  end if;
  if (p_filters ? 'yearFrom' and coalesce(p_filters->>'yearFrom', '') !~ '^\d{1,4}$')
    or (p_filters ? 'yearTo' and coalesce(p_filters->>'yearTo', '') !~ '^\d{1,4}$') then
    raise exception 'INVALID_YEAR_FILTER' using errcode = '22023';
  end if;

  with matched as (
    select r.*
    from public.zagulyaky_records r
    where r.kind = p_kind
      and r.status = 'published'
      and r.privacy_status = 'cleared'
      and (
        not r.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(r.id)
      )
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or r.search_vector @@ websearch_to_tsquery('simple'::regconfig, p_query)
        or r.title ilike '%' || p_query || '%'
        or exists (
          select 1 from public.zagulyaky_participants participant
          where participant.record_id = r.id
            and lower(coalesce(participant.original_full_name, '') || ' ' ||
              coalesce(participant.normalized_uk_full_name, '')) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
            and lower(coalesce(source.title, '') || ' ' || coalesce(source.citation, '') || ' ' ||
              coalesce(source.archive_name, '')) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1
          from public.zagulyaky_document_discoveries discovery
          where discovery.record_id = r.id
            and lower(coalesce(discovery.official_location_text, '') || ' ' ||
              coalesce(discovery.discovered_location_text, '')) like '%' || lower(p_query) || '%'
        )
      )
      and (not (p_filters ? 'eventType') or r.event_type = p_filters->>'eventType')
      and (not (p_filters ? 'verificationStatus') or r.verification_status = p_filters->>'verificationStatus')
      and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters->>'yearFrom')::integer)
      and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters->>'yearTo')::integer)
      and (not (p_filters ? 'sourceLocation') or coalesce(r.source_location_normalized, r.source_location_text, '') ilike '%' || (p_filters->>'sourceLocation') || '%')
      and (not (p_filters ? 'foundLocation') or coalesce(r.found_location_normalized, r.found_location_text, '') ilike '%' || (p_filters->>'foundLocation') || '%')
      and (
        not (p_filters ? 'archiveName')
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources s on s.id = rs.source_id
          where rs.record_id = r.id
            and coalesce(s.archive_name, '') ilike '%' || (p_filters->>'archiveName') || '%'
        )
      )
      and (
        p_cursor_published_at is null
        or r.published_at < p_cursor_published_at
        or (r.published_at = p_cursor_published_at and r.id < p_cursor_id)
      )
    order by r.published_at desc, r.id desc
    limit safe_limit + 1
  ), page_rows as (
    select * from matched order by published_at desc, id desc limit safe_limit
  ), last_row as (
    select published_at, id from page_rows order by published_at, id limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'slug', r.public_slug,
        'kind', r.kind,
        'title', r.title,
        'summary', r.summary,
        'subject', (
          select jsonb_build_object(
            'originalFullName', participant.original_full_name,
            'normalizedUkFullName', participant.normalized_uk_full_name,
            'sex', participant.sex,
            'ageText', participant.age_text
          )
          from public.zagulyaky_participants participant
          where participant.record_id = r.id and participant.role = 'subject'
          order by participant.sort_order, participant.id
          limit 1
        ),
        'primarySource', (
          select jsonb_build_object(
            'sourceType', source.source_type,
            'title', source.title,
            'archiveName', source.archive_name,
            'citation', source.citation,
            'pageFrom', source.page_from,
            'pageTo', source.page_to,
            'sourceUrl', source.source_url
          )
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
          order by rs.is_primary desc, source.created_at, source.id
          limit 1
        ),
        'documentDiscovery', (
          select jsonb_build_object(
            'officialLocationText', discovery.official_location_text,
            'discoveredLocationText', discovery.discovered_location_text,
            'recordTypes', discovery.record_types,
            'factualYearFrom', discovery.factual_year_from,
            'factualYearTo', discovery.factual_year_to,
            'pageFrom', discovery.page_from,
            'pageTo', discovery.page_to
          )
          from public.zagulyaky_document_discoveries discovery
          where discovery.record_id = r.id
          order by discovery.id
          limit 1
        ),
        'eventType', r.event_type,
        'eventDateText', r.event_date_text,
        'eventYearFrom', r.event_year_from,
        'eventYearTo', r.event_year_to,
        'datePrecision', r.date_precision,
        'sourceLocation', coalesce(r.source_location_normalized, r.source_location_text),
        'foundLocation', coalesce(r.found_location_normalized, r.found_location_text),
        'verificationStatus', r.verification_status,
        'publishedAt', r.published_at,
        'confirmationCount', (
          select count(*) from public.zagulyaky_confirmations c
          where c.record_id = r.id and c.confirmation_type in ('confirm', 'source_checked')
        )
      ) order by r.published_at desc, r.id desc)
      from page_rows r
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from matched) > safe_limit then (
      select jsonb_build_object('publishedAt', published_at, 'id', id) from last_row
    ) else null end
  ) into result;

  return result;
end;
$function$;

create or replace function public.search_zagulyaky_people_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as (
    select security_private.search_zagulyaky_v1('person', $1, $2, $3, $4, $5) as payload
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(item.value order by item.ordinality)
      from jsonb_array_elements(coalesce(source.payload -> 'items', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      where not exists (
        select 1
        from public.zagulyaky_records record_row
        where record_row.id::text = (item.value ->> 'id')
          and record_row.possible_living_person
          and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
    ), '[]'::jsonb),
    'nextCursor', source.payload -> 'nextCursor'
  )
  from source
$function$;

create or replace function public.search_zagulyaky_documents_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as (
    select security_private.search_zagulyaky_v1('document', $1, $2, $3, $4, $5) as payload
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(item.value order by item.ordinality)
      from jsonb_array_elements(coalesce(source.payload -> 'items', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      where not exists (
        select 1
        from public.zagulyaky_records record_row
        where record_row.id::text = (item.value ->> 'id')
          and record_row.possible_living_person
          and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
    ), '[]'::jsonb),
    'nextCursor', source.payload -> 'nextCursor'
  )
  from source
$function$;

create or replace function public.get_zagulyaky_public_stats_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with visible as (
    select *
    from public.zagulyaky_records record_row
    where record_row.status = 'published'
      and record_row.privacy_status = 'cleared'
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
  ), locations as (
    select nullif(btrim(coalesce(source_location_normalized, source_location_text)), '') as location from visible
    union
    select nullif(btrim(coalesce(found_location_normalized, found_location_text)), '') from visible
    union
    select nullif(btrim(discovery.official_location_text), '')
      from public.zagulyaky_document_discoveries discovery join visible on visible.id = discovery.record_id
    union
    select nullif(btrim(discovery.discovered_location_text), '')
      from public.zagulyaky_document_discoveries discovery join visible on visible.id = discovery.record_id
  )
  select jsonb_build_object(
    'people', count(*) filter (where kind = 'person'),
    'documents', count(*) filter (where kind = 'document'),
    'verified', count(*) filter (where verification_status = 'verified'),
    'corroboratedOrVerified', count(*) filter (where verification_status in ('corroborated', 'verified')),
    'places', (select count(*) from locations where location is not null),
    'archives', (
      select count(distinct nullif(btrim(source.archive_name), ''))
      from public.zagulyaky_record_sources link
      join public.zagulyaky_sources source on source.id = link.source_id
      join visible on visible.id = link.record_id
    ),
    'contributors', count(distinct created_by) filter (where created_by is not null),
    'addedLast30Days', count(*) filter (where published_at >= now() - interval '30 days'),
    'yearFrom', min(event_year_from),
    'yearTo', max(coalesce(event_year_to, event_year_from))
  )
  from visible
$function$;

-- The Edge Function is the only caller that needs a Storage location. This
-- service-role-only facade keeps the public and anonymous RPC surfaces free of
-- bucket/path data while retaining a short-lived signed delivery URL.
create or replace function public.service_get_public_zagulyaka_attachment_delivery_v1(
  p_attachment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select security_private.get_public_zagulyaka_attachment_delivery_v1($1)
  where not exists (
    select 1
    from public.zagulyaky_attachments attachment
    join public.zagulyaky_records record_row on record_row.id = attachment.record_id
    where attachment.id = $1
      and record_row.possible_living_person
      and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
  )
$function$;

-- The first attachment-delivery facade was intentionally public. It is now
-- deprecated in favour of the service-only facade above; keep its definition
-- for migration compatibility but remove all execution rights.
revoke all on function public.get_public_zagulyaka_attachment_delivery_v1(uuid)
  from public, anon, authenticated, service_role;

-- Authors may clean up an upload that was never attached, but may not delete a
-- live private original behind the metadata/RPC/audit/outbox workflow.
create or replace function security_private.zagulyaky_private_storage_path_is_unattached_v1(
  p_storage_path text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select not exists (
    select 1
    from public.zagulyaky_attachments attachment
    join public.zagulyaky_records record_row on record_row.id = attachment.record_id
    where attachment.storage_bucket = 'zagulyaky-private'
      and attachment.storage_path = p_storage_path
      and record_row.created_by = auth.uid()
  )
$function$;

drop policy if exists zagulyaky_private_file_delete_own on storage.objects;
create policy zagulyaky_private_file_delete_own
on storage.objects for delete to authenticated
using (
  bucket_id = 'zagulyaky-private'
  and name like ((select auth.uid())::text || '/%')
  and security_private.zagulyaky_private_storage_path_is_unattached_v1(name)
);

revoke all on function security_private.zagulyaky_living_person_content_fingerprint_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.stamp_zagulyaky_privacy_clearance_fingerprint_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.revoke_zagulyaky_living_clearance_on_privacy_block_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.get_public_zagulyaka_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.get_public_zagulyaka_attachment_delivery_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_private_storage_path_is_unattached_v1(text)
  from public, anon, authenticated, service_role;

-- The storage RLS predicate is evaluated as the authenticated browser role;
-- it needs only this narrow boolean helper, never direct attachment-table ACL.
grant execute on function security_private.zagulyaky_private_storage_path_is_unattached_v1(text)
  to authenticated, service_role;

revoke all on function public.service_get_public_zagulyaka_attachment_delivery_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_get_public_zagulyaka_attachment_delivery_v1(uuid)
  to service_role;

revoke all on function public.get_public_zagulyaka_v1(text)
  from public;
revoke all on function public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid)
  from public;
revoke all on function public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)
  from public;
revoke all on function public.get_zagulyaky_public_stats_v1()
  from public;
grant execute on function public.get_public_zagulyaka_v1(text)
  to anon, authenticated, service_role;
grant execute on function public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid)
  to anon, authenticated, service_role;
grant execute on function public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)
  to anon, authenticated, service_role;
grant execute on function public.get_zagulyaky_public_stats_v1()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
