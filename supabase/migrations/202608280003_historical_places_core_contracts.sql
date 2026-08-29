begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- The audit trail is private, but it is still project-owned data. Remove only
-- impossible legacy orphans before adding the ownership contract, then let a
-- project deletion remove its private audit rows atomically.
delete from security_private.historical_place_audit_log audit_row
where audit_row.project_id is not null
  and not exists (
    select 1
    from public.projects project_row
    where project_row.id = audit_row.project_id
  );

do $do$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'security_private.historical_place_audit_log'::regclass
      and constraint_row.conname =
        'historical_place_audit_log_project_id_fkey'
  ) then
    alter table security_private.historical_place_audit_log
      add constraint historical_place_audit_log_project_id_fkey
      foreign key (project_id)
      references public.projects(id)
      on delete cascade;
  end if;
end;
$do$;

create index if not exists person_timeline_events_project_place_date_idx
  on public.person_timeline_events (project_id, place_id, event_date, id)
  where place_id is not null;

-- Exact source wording is protected by the general event trigger. The only
-- supported destructive clear is an explicit RPC call with
-- p_preserve_original_text=false. Its permission marker cannot be forged by
-- an API role (unlike a custom GUC) and exists only for the current statement
-- transaction/backend/event tuple.
create table if not exists security_private.person_event_place_clear_context (
  transaction_id bigint not null,
  backend_pid integer not null,
  event_id uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (transaction_id, backend_pid, event_id)
);

revoke all on table security_private.person_event_place_clear_context
  from public, anon, authenticated, service_role;

create or replace function security_private.validate_person_event_place_link_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  linked_place_project_id uuid;
  linked_place_status text;
  linked_place_verification_status text;
  projection_restore_allowed boolean := false;
  explicit_original_clear_allowed boolean := false;
begin
  if btrim(coalesce(new.place_original_text, '')) = ''
     and coalesce(new.place_name, '') <> '' then
    select exists (
      select 1
      from security_private.person_event_place_clear_context context
      where context.transaction_id = pg_catalog.txid_current()
        and context.backend_pid = pg_catalog.pg_backend_pid()
        and context.event_id = new.id
    ) into explicit_original_clear_allowed;

    if not explicit_original_clear_allowed then
      new.place_original_text := new.place_name;
    end if;
  end if;

  if new.place_id is null then
    return new;
  end if;

  select
    place_row.project_id,
    place_row.status,
    place_row.verification_status
  into
    linked_place_project_id,
    linked_place_status,
    linked_place_verification_status
  from public.places place_row
  where place_row.id = new.place_id;

  if not found then
    raise exception 'PERSON_EVENT_PLACE_NOT_FOUND'
      using errcode = '23503';
  end if;

  if linked_place_project_id is not null
     and linked_place_project_id is distinct from new.project_id then
    raise exception 'PERSON_EVENT_PLACE_SCOPE_MISMATCH'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE'
     and coalesce(new.metadata ->> 'source', '') like 'persons_projection%' then
    select exists (
      select 1
      from security_private.person_event_place_restore_context context
      where context.transaction_id = pg_catalog.txid_current()
        and context.backend_pid = pg_catalog.pg_backend_pid()
        and context.project_id = new.project_id
        and context.person_id = new.person_id
        and context.event_type = new.event_type
        and not context.is_ambiguous
        and context.place_id = new.place_id
        and context.place_name_snapshot is not distinct from coalesce(new.place_name, '')
    ) into projection_restore_allowed;
  end if;

  if linked_place_project_id is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not projection_restore_allowed
     and not (
       linked_place_status = 'active'
       and linked_place_verification_status = 'verified'
     ) then
    raise exception 'PERSON_EVENT_PLACE_ACCESS_REQUIRED'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

-- A single visibility rule is shared by all trusted read bodies. Anonymous
-- access remains limited to the existing public catalogue APIs; these richer
-- profile APIs require an authenticated project context (or service_role).
create or replace function security_private.can_read_historical_place_v1(
  p_place_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select exists (
    select 1
    from public.places place_row
    where place_row.id = p_place_id
      and (
        coalesce(auth.role(), '') = 'service_role'
        or (
          auth.uid() is not null
          and (
            (
              place_row.project_id is null
              and place_row.status = 'active'
              and place_row.verification_status = 'verified'
            )
            or (
              place_row.project_id is not null
              and public.is_project_member(place_row.project_id)
            )
          )
        )
      )
  );
$function$;

create or replace function security_private.list_place_names_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', name_row.id,
        'placeId', name_row.place_id,
        'name', name_row.name,
        'originalText', name_row.original_text,
        'languageCode', name_row.language_code,
        'nameType', name_row.name_type,
        'validFrom', name_row.valid_from,
        'validTo', name_row.valid_to,
        'validFromText', name_row.valid_from_text,
        'validToText', name_row.valid_to_text,
        'validFromPrecision', name_row.valid_from_precision,
        'validToPrecision', name_row.valid_to_precision,
        'sourceDocumentId', name_row.source_document_id,
        'sourceFindingId', name_row.source_finding_id,
        'citationId', name_row.citation_id,
        'sourceReference', name_row.source_reference,
        'confidence', name_row.confidence,
        'isPrimary', name_row.is_primary,
        'note', name_row.note,
        'lockVersion', name_row.lock_version,
        'createdAt', name_row.created_at,
        'updatedAt', name_row.updated_at
      )
      order by
        name_row.is_primary desc,
        name_row.valid_from nulls first,
        name_row.valid_to nulls last,
        name_row.name,
        name_row.id
    )
    from public.place_names name_row
    where name_row.place_id = p_place_id
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_hierarchy_history_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', relation_row.id,
        'childPlaceId', relation_row.child_place_id,
        'parentPlaceId', relation_row.parent_place_id,
        'relationType', relation_row.relation_type,
        'validFrom', relation_row.valid_from,
        'validTo', relation_row.valid_to,
        'validFromText', relation_row.valid_from_text,
        'validToText', relation_row.valid_to_text,
        'validFromPrecision', relation_row.valid_from_precision,
        'validToPrecision', relation_row.valid_to_precision,
        'confidence', relation_row.confidence,
        'sourceDocumentId', relation_row.source_document_id,
        'sourceFindingId', relation_row.source_finding_id,
        'citationId', relation_row.citation_id,
        'sourceReference', relation_row.source_reference,
        'note', relation_row.note,
        'parent', jsonb_build_object(
          'id', parent_place.id,
          'canonicalName', parent_place.canonical_name,
          'modernName', nullif(parent_place.modern_name, ''),
          'scope', case
            when parent_place.project_id is null then 'global'
            else 'project'
          end,
          'status', parent_place.status,
          'verificationStatus', parent_place.verification_status,
          'latitude', parent_place.latitude,
          'longitude', parent_place.longitude
        ),
        'hierarchy', case
          when jsonb_typeof(resolved_history.payload -> 'hierarchy') = 'array'
            and jsonb_array_length(resolved_history.payload -> 'hierarchy') > 0
          then resolved_history.payload -> 'hierarchy'
          else jsonb_build_array(jsonb_build_object(
            'depth', 0,
            'relationId', relation_row.id,
            'relationType', relation_row.relation_type,
            'validFrom', relation_row.valid_from,
            'validTo', relation_row.valid_to,
            'place', jsonb_build_object(
              'id', parent_place.id,
              'canonicalName', parent_place.canonical_name,
              'modernName', nullif(parent_place.modern_name, ''),
              'scope', case when parent_place.project_id is null then 'global' else 'project' end,
              'status', parent_place.status,
              'verificationStatus', parent_place.verification_status,
              'latitude', parent_place.latitude,
              'longitude', parent_place.longitude
            )
          ))
        end,
        'createdAt', relation_row.created_at,
        'updatedAt', relation_row.updated_at
      )
      order by
        relation_row.valid_from nulls first,
        relation_row.valid_to nulls last,
        relation_row.relation_type,
        parent_place.canonical_name,
        relation_row.id
    )
    from public.place_hierarchy_relations relation_row
    join public.places parent_place
      on parent_place.id = relation_row.parent_place_id
    left join lateral (
      select security_private.resolve_place_hierarchy_period_v1(
        relation_row.child_place_id,
        coalesce(relation_row.valid_from, relation_row.valid_to, current_date),
        coalesce(relation_row.valid_from, relation_row.valid_to, current_date),
        12
      ) payload
    ) resolved_history on true
    where relation_row.child_place_id = p_place_id
      and (
        coalesce(auth.role(), '') = 'service_role'
        or (
          relation_row.project_id is null
          and parent_place.project_id is null
          and parent_place.status = 'active'
          and parent_place.verification_status = 'verified'
        )
        or (
          relation_row.project_id is not null
          and public.is_project_member(relation_row.project_id)
          and (
            parent_place.project_id = relation_row.project_id
            or (
              parent_place.project_id is null
              and parent_place.status = 'active'
              and parent_place.verification_status = 'verified'
            )
          )
        )
      )
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.get_place_profile_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  active_name jsonb;
  names_rows jsonb;
  hierarchy_history_rows jsonb;
  hierarchy_resolution jsonb;
  visible_event_count integer;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;

  select place_record.*
  into place_row
  from public.places place_record
  where place_record.id = p_place_id;

  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', name_row.id,
    'name', name_row.name,
    'originalText', name_row.original_text,
    'languageCode', name_row.language_code,
    'nameType', name_row.name_type,
    'validFrom', name_row.valid_from,
    'validTo', name_row.valid_to,
    'isPrimary', name_row.is_primary
  )
  into active_name
  from public.place_names name_row
  where name_row.place_id = p_place_id
    and (
      p_at_date is null
      or (
        (name_row.valid_from is null or name_row.valid_from <= p_at_date)
        and (name_row.valid_to is null or name_row.valid_to >= p_at_date)
      )
    )
  order by
    name_row.is_primary desc,
    name_row.valid_from desc nulls last,
    name_row.updated_at desc,
    name_row.id
  limit 1;

  names_rows := security_private.list_place_names_v1(p_place_id);
  hierarchy_history_rows :=
    security_private.list_place_hierarchy_history_v1(p_place_id);
  hierarchy_resolution := security_private.resolve_place_hierarchy_v1(
    p_place_id,
    p_at_date,
    12
  );

  select count(*)::integer
  into visible_event_count
  from public.person_timeline_events event_row
  where event_row.place_id = p_place_id
    and (
      coalesce(auth.role(), '') = 'service_role'
      or public.is_project_member(event_row.project_id)
    );

  return jsonb_build_object(
    'place', jsonb_build_object(
      'id', place_row.id,
      'projectId', place_row.project_id,
      'scope', case when place_row.project_id is null then 'global' else 'project' end,
      'canonicalName', place_row.canonical_name,
      'modernName', nullif(place_row.modern_name, ''),
      'displayName', coalesce(
        active_name ->> 'name',
        case
          when p_at_date is null then nullif(place_row.modern_name, '')
          else place_row.canonical_name
        end,
        place_row.canonical_name
      ),
      'placeType', (
        select type_row.place_type_code
        from public.place_type_assignments type_row
        where type_row.place_id = place_row.id
          and (
            p_at_date is null
            or (
              (type_row.valid_from is null or type_row.valid_from <= p_at_date)
              and (type_row.valid_to is null or type_row.valid_to >= p_at_date)
            )
          )
        order by
          type_row.is_primary desc,
          type_row.valid_from desc nulls last,
          type_row.updated_at desc,
          type_row.id
        limit 1
      ),
      'description', place_row.description,
      'latitude', place_row.latitude,
      'longitude', place_row.longitude,
      'status', place_row.status,
      'verificationStatus', place_row.verification_status,
      'isPublic', place_row.is_public,
      'mergedIntoPlaceId', place_row.merged_into_place_id,
      'lockVersion', place_row.lock_version,
      'createdAt', place_row.created_at,
      'updatedAt', place_row.updated_at
    ),
    'atDate', p_at_date,
    'activeName', active_name,
    'names', names_rows,
    'hierarchy', hierarchy_resolution,
    'hierarchyHistory', hierarchy_history_rows,
    'counts', jsonb_build_object(
      'names', jsonb_array_length(names_rows),
      'hierarchyRelations', jsonb_array_length(hierarchy_history_rows),
      'visiblePersonEvents', visible_event_count
    )
  );
end;
$function$;

create or replace function security_private.set_person_event_place_v1(
  p_event_id uuid,
  p_place_id uuid,
  p_place_original_text text default null,
  p_resolution_status text default 'confirmed',
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  event_row public.person_timeline_events;
  updated_event public.person_timeline_events;
  preserved_original text;
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_event_id is null then
    raise exception 'PERSON_EVENT_ID_REQUIRED' using errcode = '22023';
  end if;
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;
  if p_resolution_status is null
     or p_resolution_status not in ('confirmed', 'needs_review') then
    raise exception 'PERSON_EVENT_PLACE_STATUS_INVALID' using errcode = '22023';
  end if;
  if p_place_original_text is not null
     and char_length(p_place_original_text) > 10000 then
    raise exception 'PERSON_EVENT_PLACE_ORIGINAL_TEXT_TOO_LONG'
      using errcode = '22023';
  end if;

  select event_record.*
  into event_row
  from public.person_timeline_events event_record
  where event_record.id = p_event_id;

  if not found then
    raise exception 'PERSON_EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not caller_is_service and not public.can_edit_project(event_row.project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform security_private.lock_historical_place_ids_v1(
    array[event_row.place_id, p_place_id]::uuid[],
    true
  );

  -- Re-read after a possibly blocking advisory lock.  This row lock is always
  -- taken after the Place locks, matching merge_places_v1 lock order.
  select event_record.*
  into event_row
  from public.person_timeline_events event_record
  where event_record.id = p_event_id
  for update;
  if not found then
    raise exception 'PERSON_EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not caller_is_service and not public.can_edit_project(event_row.project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if p_expected_updated_at is not null
     and event_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'PERSON_EVENT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  preserved_original := case
    when p_place_original_text is not null then p_place_original_text
    else coalesce(
      nullif(event_row.place_original_text, ''),
      event_row.place_name,
      ''
    )
  end;

  update public.person_timeline_events event_record
  set
    place_id = p_place_id,
    place_original_text = preserved_original,
    place_resolution_status = p_resolution_status,
    updated_at = pg_catalog.now()
  where event_record.id = p_event_id
  returning event_record.* into updated_event;

  return jsonb_build_object(
    'eventId', updated_event.id,
    'projectId', updated_event.project_id,
    'personId', updated_event.person_id,
    'placeId', updated_event.place_id,
    'placeOriginalText', updated_event.place_original_text,
    'resolutionStatus', updated_event.place_resolution_status,
    'updatedAt', updated_event.updated_at
  );
end;
$function$;

create or replace function security_private.clear_person_event_place_v1(
  p_event_id uuid,
  p_preserve_original_text boolean default true,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  event_row public.person_timeline_events;
  updated_event public.person_timeline_events;
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_event_id is null then
    raise exception 'PERSON_EVENT_ID_REQUIRED' using errcode = '22023';
  end if;

  select event_record.*
  into event_row
  from public.person_timeline_events event_record
  where event_record.id = p_event_id;

  if not found then
    raise exception 'PERSON_EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not caller_is_service and not public.can_edit_project(event_row.project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform security_private.lock_historical_place_ids_v1(
    array[event_row.place_id]::uuid[],
    true
  );

  select event_record.*
  into event_row
  from public.person_timeline_events event_record
  where event_record.id = p_event_id
  for update;
  if not found then
    raise exception 'PERSON_EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not caller_is_service and not public.can_edit_project(event_row.project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if p_expected_updated_at is not null
     and event_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'PERSON_EVENT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  if not coalesce(p_preserve_original_text, true) then
    insert into security_private.person_event_place_clear_context (
      transaction_id,
      backend_pid,
      event_id
    ) values (
      pg_catalog.txid_current(),
      pg_catalog.pg_backend_pid(),
      p_event_id
    )
    on conflict (transaction_id, backend_pid, event_id) do nothing;
  end if;

  update public.person_timeline_events event_record
  set
    place_id = null,
    place_original_text = case
      when coalesce(p_preserve_original_text, true) then
        coalesce(nullif(event_record.place_original_text, ''), event_record.place_name, '')
      else ''
    end,
    place_resolution_status = 'unresolved',
    updated_at = pg_catalog.now()
  where event_record.id = p_event_id
  returning event_record.* into updated_event;

  delete from security_private.person_event_place_clear_context context
  where context.transaction_id = pg_catalog.txid_current()
    and context.backend_pid = pg_catalog.pg_backend_pid()
    and context.event_id = p_event_id;

  return jsonb_build_object(
    'eventId', updated_event.id,
    'projectId', updated_event.project_id,
    'personId', updated_event.person_id,
    'placeId', updated_event.place_id,
    'placeOriginalText', updated_event.place_original_text,
    'resolutionStatus', updated_event.place_resolution_status,
    'updatedAt', updated_event.updated_at
  );
end;
$function$;

-- Exposed Data API functions remain SECURITY INVOKER facades. Only the
-- trusted bodies own elevated privileges, and every body repeats the ACL
-- check before reading or changing project data.
create or replace function public.get_place_profile_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_place_profile_v1($1, $2);
$wrapper$;

create or replace function public.list_place_names_v1(
  p_place_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_place_names_v1($1);
$wrapper$;

create or replace function public.list_place_hierarchy_history_v1(
  p_place_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_place_hierarchy_history_v1($1);
$wrapper$;

create or replace function public.set_person_event_place_v1(
  p_event_id uuid,
  p_place_id uuid,
  p_place_original_text text default null,
  p_resolution_status text default 'confirmed',
  p_expected_updated_at timestamptz default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.set_person_event_place_v1($1, $2, $3, $4, $5);
$wrapper$;

create or replace function public.clear_person_event_place_v1(
  p_event_id uuid,
  p_preserve_original_text boolean default true,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.clear_person_event_place_v1($1, $2, $3);
$wrapper$;

revoke all on function security_private.can_read_historical_place_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.validate_person_event_place_link_v1()
  from public, anon, authenticated, service_role;

revoke all on function security_private.get_place_profile_v1(uuid,date)
  from public, anon, authenticated, service_role;
revoke all on function security_private.list_place_names_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.list_place_hierarchy_history_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.set_person_event_place_v1(uuid,uuid,text,text,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function security_private.clear_person_event_place_v1(uuid,boolean,timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function security_private.get_place_profile_v1(uuid,date)
  to authenticated, service_role;
grant execute on function security_private.list_place_names_v1(uuid)
  to authenticated, service_role;
grant execute on function security_private.list_place_hierarchy_history_v1(uuid)
  to authenticated, service_role;
grant execute on function security_private.set_person_event_place_v1(uuid,uuid,text,text,timestamptz)
  to authenticated, service_role;
grant execute on function security_private.clear_person_event_place_v1(uuid,boolean,timestamptz)
  to authenticated, service_role;

revoke all on function public.get_place_profile_v1(uuid,date)
  from public, anon, authenticated, service_role;
revoke all on function public.list_place_names_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_place_hierarchy_history_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_person_event_place_v1(uuid,uuid,text,text,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.clear_person_event_place_v1(uuid,boolean,timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function public.get_place_profile_v1(uuid,date)
  to authenticated, service_role;
grant execute on function public.list_place_names_v1(uuid)
  to authenticated, service_role;
grant execute on function public.list_place_hierarchy_history_v1(uuid)
  to authenticated, service_role;
grant execute on function public.set_person_event_place_v1(uuid,uuid,text,text,timestamptz)
  to authenticated, service_role;
grant execute on function public.clear_person_event_place_v1(uuid,boolean,timestamptz)
  to authenticated, service_role;

notify pgrst, 'reload schema';

analyze public.person_timeline_events;

commit;
