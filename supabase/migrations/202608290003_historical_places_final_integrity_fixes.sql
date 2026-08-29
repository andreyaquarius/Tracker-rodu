begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- ---------------------------------------------------------------------------
-- Safe global redirects
-- ---------------------------------------------------------------------------

-- A merged global row is deliberately no longer a readable catalogue record.
-- Expose only the redirect and the already-readable final target projection;
-- never return the source names, evidence, metadata, people, or documents.
create or replace function security_private.get_historical_place_redirect_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  source_row public.places;
  final_row public.places;
  resolved_row record;
  final_depth integer;
  final_cycle boolean;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  source_was_public boolean := false;
begin
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;

  select * into source_row
  from public.places candidate
  where candidate.id = p_place_id;
  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if source_row.project_id is not null
     or source_row.status <> 'merged'
     or source_row.merged_into_place_id is null then
    return null;
  end if;

  -- A public redirect is allowed only when the immutable private audit proves
  -- that this exact global row was public immediately before it became a
  -- redirect.  Service-role maintenance can still resolve legacy/internal
  -- merges, but API callers cannot discover a formerly private source UUID.
  select exists (
    select 1
    from security_private.historical_place_audit_log audit_row
    where audit_row.entity_table = 'places'
      and audit_row.entity_id = source_row.id
      and audit_row.action = 'update'
      and audit_row.before_data ->> 'project_id' is null
      and coalesce(audit_row.before_data ->> 'is_public', 'false') = 'true'
      and audit_row.after_data ->> 'status' = 'merged'
      and audit_row.after_data ->> 'merged_into_place_id'
        = source_row.merged_into_place_id::text
  ) into source_was_public;

  if not caller_is_service and not source_was_public then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;

  with recursive redirect_chain as (
    select
      source_row.id,
      source_row.project_id,
      source_row.status,
      source_row.merged_into_place_id,
      0 depth,
      array[source_row.id]::uuid[] path,
      false cycle_detected
    union all
    select
      next_row.id,
      next_row.project_id,
      next_row.status,
      next_row.merged_into_place_id,
      chain.depth + 1,
      chain.path || next_row.id,
      next_row.id = any(chain.path)
    from redirect_chain chain
    join public.places next_row on next_row.id = chain.merged_into_place_id
    where chain.status = 'merged'
      and chain.merged_into_place_id is not null
      and not chain.cycle_detected
      and chain.depth < 32
  )
  select
    place_row as place_record,
    chain.depth as redirect_depth,
    chain.cycle_detected
  into resolved_row
  from redirect_chain chain
  join public.places place_row on place_row.id = chain.id
  order by chain.depth desc
  limit 1;

  final_row := resolved_row.place_record;
  final_depth := resolved_row.redirect_depth;
  final_cycle := resolved_row.cycle_detected;

  if final_cycle
     or final_row.status = 'merged'
     or final_row.project_id is not null then
    raise exception 'PLACE_REDIRECT_CHAIN_INVALID' using errcode = '22023';
  end if;
  if not security_private.can_read_historical_place_v2(final_row.id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', source_row.id,
    'projectId', null,
    'scope', 'global',
    'canonicalName', final_row.canonical_name,
    'modernName', nullif(final_row.modern_name, ''),
    'displayName', coalesce(nullif(final_row.modern_name, ''), final_row.canonical_name),
    'status', 'merged',
    -- Do not disclose source moderation metadata.  All visible labels and
    -- coordinates in this minimal envelope belong to the readable target.
    'verificationStatus', final_row.verification_status,
    'isPublic', false,
    'latitude', final_row.latitude,
    'longitude', final_row.longitude,
    'mergedIntoPlaceId', source_row.merged_into_place_id,
    'isRedirect', true,
    'redirect', jsonb_build_object(
      'targetPlaceId', source_row.merged_into_place_id,
      'finalTargetPlaceId', final_row.id,
      'hopCount', final_depth
    ),
    'target', jsonb_build_object(
      'id', final_row.id,
      'projectId', null,
      'scope', 'global',
      'canonicalName', final_row.canonical_name,
      'modernName', nullif(final_row.modern_name, ''),
      'displayName', coalesce(nullif(final_row.modern_name, ''), final_row.canonical_name),
      'status', final_row.status,
      'verificationStatus', final_row.verification_status,
      'isPublic', final_row.is_public,
      'latitude', final_row.latitude,
      'longitude', final_row.longitude
    )
  );
end;
$function$;

-- The direct public redirect lookup masks non-readable existing rows as
-- PLACE_NOT_FOUND.  Other profile/projection dispatchers keep their established
-- PLACE_ACCESS_REQUIRED behavior by calling the internal resolver above.
create or replace function security_private.get_historical_place_redirect_public_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  redirect_row jsonb;
begin
  redirect_row := security_private.get_historical_place_redirect_v1(p_place_id);
  if redirect_row is null
     and not security_private.can_read_historical_place_v2(p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  return redirect_row;
end;
$function$;

create or replace function public.get_place_redirect_v1(p_place_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_historical_place_redirect_public_v1($1);
$wrapper$;

create or replace function security_private.get_place_profile_or_redirect_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  redirect_row jsonb;
begin
  redirect_row := security_private.get_historical_place_redirect_v1(p_place_id);
  if redirect_row is not null then
    return jsonb_build_object(
      'place', redirect_row,
      'redirect', redirect_row -> 'redirect',
      'atDate', p_at_date,
      'activeName', null,
      'names', '[]'::jsonb,
      'hierarchy', jsonb_build_object(
        'status', 'redirect',
        'atDate', p_at_date,
        'hierarchy', '[]'::jsonb,
        'redirect', redirect_row -> 'redirect'
      ),
      'hierarchyHistory', '[]'::jsonb,
      'counts', jsonb_build_object(
        'names', 0,
        'hierarchyRelations', 0,
        'visiblePersonEvents', 0
      )
    );
  end if;
  return security_private.get_place_profile_v1(p_place_id, p_at_date);
end;
$function$;

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
  select security_private.get_place_profile_or_redirect_v1($1, $2);
$wrapper$;

create or replace function security_private.get_place_autocomplete_or_redirect_v1(
  p_place_id uuid,
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  redirect_row jsonb;
begin
  perform security_private.assert_historical_period_v1(
    p_at_date,
    p_period_from,
    p_period_to,
    case when p_at_date is not null then 'day'
         when p_period_from is not null then 'range' else null end,
    'PLACE_AUTOCOMPLETE'
  );
  redirect_row := security_private.get_historical_place_redirect_v1(p_place_id);
  if redirect_row is not null then
    return redirect_row || jsonb_build_object(
      'historicalNames', '[]'::jsonb,
      'hierarchy', jsonb_build_object(
        'status', 'redirect',
        'hierarchy', '[]'::jsonb,
        'redirect', redirect_row -> 'redirect'
      ),
      'atDate', p_at_date,
      'periodFrom', p_period_from,
      'periodTo', p_period_to
    );
  end if;
  return security_private.get_place_autocomplete_projection_v1(
    p_place_id, p_at_date, p_period_from, p_period_to
  );
end;
$function$;

create or replace function public.get_place_autocomplete_projection_v1(
  p_place_id uuid,
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_place_autocomplete_or_redirect_v1($1,$2,$3,$4);
$wrapper$;

create or replace function security_private.list_place_external_identifiers_or_redirect_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
begin
  if security_private.get_historical_place_redirect_v1(p_place_id) is not null then
    return '[]'::jsonb;
  end if;
  return security_private.list_place_external_identifiers_v1(p_place_id);
end;
$function$;

create or replace function public.list_place_external_identifiers_v1(p_place_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_place_external_identifiers_or_redirect_v1($1);
$wrapper$;

-- ---------------------------------------------------------------------------
-- Merge graph integrity and richer preview context
-- ---------------------------------------------------------------------------

-- Evaluate the hierarchy graph exactly as it would look after source ID
-- substitution. Direct source/target edges become self-links and are removed by
-- merge; every other edge participates in the transitive cycle check.
create or replace function security_private.historical_place_merge_cycle_v1(
  p_source_place_id uuid,
  p_target_place_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
  with recursive transformed_edges as materialized (
    select
      relation_row.id,
      case when relation_row.child_place_id = p_source_place_id
        then p_target_place_id else relation_row.child_place_id end child_place_id,
      case when relation_row.parent_place_id = p_source_place_id
        then p_target_place_id else relation_row.parent_place_id end parent_place_id
    from public.place_hierarchy_relations relation_row
  ), usable_edges as materialized (
    select * from transformed_edges edge
    where edge.child_place_id <> edge.parent_place_id
  ), hierarchy_walk as (
    select
      edge.parent_place_id place_id,
      array[p_target_place_id, edge.parent_place_id]::uuid[] path,
      array[edge.id]::uuid[] relation_ids,
      edge.parent_place_id = p_target_place_id cycle_detected
    from usable_edges edge
    where edge.child_place_id = p_target_place_id
    union all
    select
      edge.parent_place_id,
      walk.path || edge.parent_place_id,
      walk.relation_ids || edge.id,
      edge.parent_place_id = any(walk.path)
    from hierarchy_walk walk
    join usable_edges edge on edge.child_place_id = walk.place_id
    where not walk.cycle_detected
  ), first_cycle as (
    select walk.path, walk.relation_ids
    from hierarchy_walk walk
    where walk.cycle_detected
    order by cardinality(walk.path), walk.path
    limit 1
  )
  select jsonb_build_object(
    'wouldCreateCycle', exists(select 1 from first_cycle),
    'path', coalesce((select to_jsonb(path) from first_cycle), '[]'::jsonb),
    'relationIds', coalesce((select to_jsonb(relation_ids) from first_cycle), '[]'::jsonb)
  );
$function$;

create or replace function security_private.historical_place_admin_context_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  ancestor_rows jsonb;
  current_hierarchy jsonb;
begin
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  with recursive hierarchy_walk as (
    select
      0 depth,
      p_place_id place_id,
      null::uuid relation_id,
      null::text relation_type,
      null::date valid_from,
      null::date valid_to,
      array[p_place_id]::uuid[] path
    union all
    select
      walk.depth + 1,
      relation_row.parent_place_id,
      relation_row.id,
      relation_row.relation_type,
      relation_row.valid_from,
      relation_row.valid_to,
      walk.path || relation_row.parent_place_id
    from hierarchy_walk walk
    join public.place_hierarchy_relations relation_row
      on relation_row.child_place_id = walk.place_id
    where walk.depth < 32
      and not relation_row.parent_place_id = any(walk.path)
      and security_private.can_read_historical_place_v1(relation_row.parent_place_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'depth', walk.depth,
    'relationId', walk.relation_id,
    'relationType', walk.relation_type,
    'validFrom', walk.valid_from,
    'validTo', walk.valid_to,
    'path', to_jsonb(walk.path),
    'place', jsonb_build_object(
      'id', place_row.id,
      'canonicalName', place_row.canonical_name,
      'modernName', nullif(place_row.modern_name, ''),
      'placeType', type_row.place_type_code,
      'latitude', place_row.latitude,
      'longitude', place_row.longitude
    )
  ) order by walk.depth, walk.path, walk.relation_id), '[]'::jsonb)
  into ancestor_rows
  from hierarchy_walk walk
  join public.places place_row on place_row.id = walk.place_id
  left join lateral (
    select assignment.place_type_code
    from public.place_type_assignments assignment
    where assignment.place_id = place_row.id
      and (
        walk.valid_from is null
        or (assignment.valid_from is null or assignment.valid_from <= walk.valid_from)
           and (assignment.valid_to is null or assignment.valid_to >= walk.valid_from)
      )
    order by assignment.is_primary desc,
      assignment.valid_from desc nulls last,
      assignment.id
    limit 1
  ) type_row on true
  where walk.depth > 0;

  current_hierarchy := security_private.resolve_place_hierarchy_period_v1(
    p_place_id, current_date, current_date, 32
  );

  return jsonb_build_object(
    'atDate', current_date,
    'currentHierarchy', current_hierarchy,
    'ancestors', ancestor_rows,
    'history', security_private.list_place_hierarchy_history_v1(p_place_id)
  );
end;
$function$;

create or replace function security_private.merge_place_snapshot_v2(
  p_place_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
  select security_private.merge_place_snapshot_v1(p_place_id)
    || jsonb_build_object(
      'adminContext', security_private.historical_place_admin_context_v1(p_place_id)
    );
$function$;

create or replace function security_private.merge_places_preview_v1(
  p_source_place_id uuid,
  p_target_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  source_place public.places%rowtype;
  target_place public.places%rowtype;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  caller_can_merge boolean := false;
  cycle_data jsonb;
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_source_place_id is null or p_target_place_id is null then
    raise exception 'MERGE_PLACE_IDS_REQUIRED' using errcode = '22023';
  end if;
  if p_source_place_id = p_target_place_id then
    raise exception 'MERGE_PLACES_MUST_DIFFER' using errcode = '22023';
  end if;

  select row_data.* into source_place from public.places row_data
  where row_data.id = p_source_place_id;
  if not found then raise exception 'MERGE_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  select row_data.* into target_place from public.places row_data
  where row_data.id = p_target_place_id;
  if not found then raise exception 'MERGE_TARGET_NOT_FOUND' using errcode = 'P0002'; end if;

  if source_place.project_id is distinct from target_place.project_id then
    raise exception 'MERGE_PLACE_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if source_place.status = 'merged' or target_place.status = 'merged' then
    raise exception 'MERGE_REDIRECT_PLACE_FORBIDDEN' using errcode = '22023';
  end if;
  if target_place.status = 'archived' then
    raise exception 'MERGE_TARGET_ARCHIVED' using errcode = '22023';
  end if;

  if source_place.project_id is null then
    if not caller_is_service
       and (not security_private.can_read_historical_place_v1(source_place.id)
         or not security_private.can_read_historical_place_v1(target_place.id)) then
      raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
    end if;
    caller_can_merge := caller_is_service;
    if caller_is_service and (
      target_place.status <> 'active'
      or target_place.verification_status <> 'verified'
    ) then
      raise exception 'GLOBAL_PLACE_MERGE_TARGET_NOT_READABLE' using errcode = '22023';
    end if;
    if caller_is_service and source_place.is_public and not target_place.is_public then
      raise exception 'GLOBAL_PUBLIC_PLACE_MERGE_TARGET_MUST_BE_PUBLIC' using errcode = '22023';
    end if;
  else
    if not caller_is_service and not public.is_project_member(source_place.project_id) then
      raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
    end if;
    caller_can_merge := caller_is_service or public.can_edit_project(source_place.project_id);
  end if;

  if source_place.project_id is not null or caller_is_service then
    cycle_data := security_private.historical_place_merge_cycle_v1(
      source_place.id, target_place.id
    );
    if coalesce((cycle_data ->> 'wouldCreateCycle')::boolean, false) then
      raise exception 'PLACE_MERGE_HIERARCHY_CYCLE'
        using errcode = '22023', detail = cycle_data::text;
    end if;
  else
    cycle_data := jsonb_build_object(
      'wouldCreateCycle', false,
      'notEvaluated', true
    );
  end if;

  return jsonb_build_object(
    'source', security_private.merge_place_snapshot_v2(source_place.id),
    'target', security_private.merge_place_snapshot_v2(target_place.id),
    'canMerge', caller_can_merge,
    'requiresChangeRequest', source_place.project_id is null and not caller_is_service,
    'hierarchyCycleCheck', cycle_data,
    'preservationPreview', jsonb_build_object(
      'hierarchySelfLinks', (
        select count(*) from public.place_hierarchy_relations relation_row
        where (relation_row.child_place_id = source_place.id and relation_row.parent_place_id = target_place.id)
           or (relation_row.child_place_id = target_place.id and relation_row.parent_place_id = source_place.id)
      ),
      'genericSelfLinks', (
        select count(*) from public.place_relations relation_row
        where (relation_row.place_id = source_place.id and relation_row.related_place_id = target_place.id)
           or (relation_row.place_id = target_place.id and relation_row.related_place_id = source_place.id)
      ),
      'parishSelfLinks', (
        select count(*) from public.place_parish_relations relation_row
        where (relation_row.place_id = source_place.id and relation_row.parish_place_id = target_place.id)
           or (relation_row.place_id = target_place.id and relation_row.parish_place_id = source_place.id)
      )
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Exact-date map semantics
-- ---------------------------------------------------------------------------

create or replace function security_private.get_place_map_context_v1(
  p_place_id uuid,
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
declare
  bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  effective_period_from date := coalesce(p_period_from, p_at_date);
  effective_period_to date := coalesce(p_period_to, p_at_date);
  redirect_row jsonb;
begin
  perform security_private.assert_historical_period_v1(
    p_at_date, p_period_from, p_period_to,
    case when p_at_date is not null then 'day'
         when p_period_from is not null then 'range' else null end,
    'PLACE_MAP_CONTEXT'
  );

  redirect_row := security_private.get_historical_place_redirect_v1(p_place_id);
  if redirect_row is not null then
    return jsonb_build_object(
      'place', redirect_row,
      'redirect', redirect_row -> 'redirect',
      'boundaries', '[]'::jsonb,
      'documents', '[]'::jsonb,
      'events', '[]'::jsonb,
      'atDate', p_at_date,
      'periodFrom', p_period_from,
      'periodTo', p_period_to,
      'temporalMode', case when p_at_date is not null then 'exact_date'
        when p_period_from is not null then 'period' else 'all_time' end
    );
  end if;

  return jsonb_build_object(
    'place', security_private.get_place_autocomplete_projection_v1(
      p_place_id, p_at_date, p_period_from, p_period_to
    ),
    'boundaries', security_private.list_place_boundaries_v2(
      p_place_id, p_at_date, p_period_from, p_period_to
    ),
    'documents', security_private.list_place_documents_v2(
      p_place_id, effective_period_from, effective_period_to, bounded_limit, 0
    ),
    'events', security_private.list_place_events_v2(
      p_place_id, effective_period_from, effective_period_to, bounded_limit, 0
    ),
    'atDate', p_at_date,
    'periodFrom', p_period_from,
    'periodTo', p_period_to,
    'temporalMode', case when p_at_date is not null then 'exact_date'
      when p_period_from is not null then 'period' else 'all_time' end
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Date-aware alias matching
-- ---------------------------------------------------------------------------

create or replace function security_private.search_places_v2(
  p_query text default '',
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null,
  p_date_precision text default null,
  p_project_id uuid default null,
  p_limit integer default 20,
  p_ancestor_place_id uuid default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_radius_km numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
declare
  raw_query text := btrim(coalesce(p_query, ''));
  normalized_query text := public.historical_place_search_normalize_v1(btrim(coalesce(p_query, '')));
  bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  has_coordinates boolean := p_latitude is not null or p_longitude is not null or p_radius_km is not null;
begin
  perform security_private.assert_historical_period_v1(
    p_at_date, p_period_from, p_period_to, p_date_precision, 'PLACE_SEARCH'
  );
  if char_length(raw_query) > 200 then
    raise exception 'PLACE_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  if p_project_id is not null
     and coalesce(auth.role(), '') <> 'service_role'
     and (auth.uid() is null or not public.is_project_member(p_project_id)) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if has_coordinates and (p_latitude is null or p_longitude is null or p_radius_km is null) then
    raise exception 'PLACE_COORDINATE_SEARCH_REQUIRES_LATITUDE_LONGITUDE_RADIUS'
      using errcode = '22023';
  end if;
  if p_latitude is not null and p_latitude not between -90 and 90 then
    raise exception 'PLACE_SEARCH_LATITUDE_INVALID' using errcode = '22023';
  end if;
  if p_longitude is not null and p_longitude not between -180 and 180 then
    raise exception 'PLACE_SEARCH_LONGITUDE_INVALID' using errcode = '22023';
  end if;
  if p_radius_km is not null and p_radius_km not between 0.01 and 500 then
    raise exception 'PLACE_SEARCH_RADIUS_INVALID' using errcode = '22023';
  end if;
  if p_ancestor_place_id is not null
     and not security_private.can_read_historical_place_v2(p_ancestor_place_id) then
    raise exception 'PLACE_ANCESTOR_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if char_length(normalized_query) < 2
     and p_ancestor_place_id is null
     and not has_coordinates then
    return '[]'::jsonb;
  end if;

  return coalesce((
    with recursive ancestor_descendants as (
      select p_ancestor_place_id place_id, 0 depth,
        array[p_ancestor_place_id]::uuid[] path
      where p_ancestor_place_id is not null
      union all
      select relation.child_place_id, walk.depth + 1,
        walk.path || relation.child_place_id
      from ancestor_descendants walk
      join public.place_hierarchy_relations relation
        on relation.parent_place_id = walk.place_id
       and security_private.can_read_historical_place_relation_v1(
         relation.project_id, relation.child_place_id, relation.parent_place_id
       )
       and (
         (p_at_date is null and p_period_from is null)
         or (p_at_date is not null
           and (relation.valid_from is null or relation.valid_from <= p_at_date)
           and (relation.valid_to is null or relation.valid_to >= p_at_date))
         or (p_period_from is not null
           and (relation.valid_from is null or relation.valid_from <= p_period_to)
           and (relation.valid_to is null or relation.valid_to >= p_period_from))
       )
      where walk.depth < 32
        and not relation.child_place_id = any(walk.path)
    ), visible_places as (
      select place_row.*
      from public.places place_row
      where place_row.status not in ('merged','archived')
        and security_private.can_read_historical_place_v2(place_row.id)
        and (p_project_id is null
          or place_row.project_id is null
          or place_row.project_id = p_project_id)
        and (p_ancestor_place_id is null or exists (
          select 1 from ancestor_descendants descendant
          where descendant.depth > 0 and descendant.place_id = place_row.id
        ))
        and (not has_coordinates or (
          place_row.location is not null
          and extensions.st_dwithin(
            place_row.location::extensions.geography,
            extensions.st_setsrid(
              extensions.st_makepoint(p_longitude::double precision, p_latitude::double precision),
              4326
            )::extensions.geography,
            p_radius_km::double precision * 1000.0
          )
        ))
    ), matched as (
      select place_row.id,
        coalesce(match_name.name, place_row.canonical_name) matched_name,
        case
          when char_length(normalized_query) < 2 then 0
          when match_name.search_text = normalized_query then 0
          when place_row.search_text = normalized_query then 0
          when coalesce(match_name.search_text, place_row.search_text) like normalized_query || '%' then 1
          when coalesce(match_name.search_text, place_row.search_text) like '%' || normalized_query || '%' then 2
          else 3
        end match_rank,
        case when has_coordinates then extensions.st_distance(
          place_row.location::extensions.geography,
          extensions.st_setsrid(
            extensions.st_makepoint(p_longitude::double precision, p_latitude::double precision), 4326
          )::extensions.geography
        ) / 1000.0 else null end distance_km
      from visible_places place_row
      left join lateral (
        select name_row.name, name_row.search_text
        from public.place_names name_row
        where name_row.place_id = place_row.id
          and (
            (p_at_date is null and p_period_from is null)
            or (p_at_date is not null
              and (name_row.valid_from is null or name_row.valid_from <= p_at_date)
              and (name_row.valid_to is null or name_row.valid_to >= p_at_date))
            or (p_period_from is not null
              and (name_row.valid_from is null or name_row.valid_from <= p_period_to)
              and (name_row.valid_to is null or name_row.valid_to >= p_period_from))
          )
          and (char_length(normalized_query) < 2
            or name_row.search_text like '%' || normalized_query || '%'
            or name_row.search_text % normalized_query)
        order by
          case when name_row.search_text = normalized_query then 0
               when name_row.search_text like normalized_query || '%' then 1
               when name_row.search_text like '%' || normalized_query || '%' then 2 else 3 end,
          extensions.similarity(name_row.search_text, normalized_query) desc,
          name_row.id
        limit 1
      ) match_name on true
      where char_length(normalized_query) < 2
         or place_row.search_text like '%' || normalized_query || '%'
         or place_row.search_text % normalized_query
         or match_name.name is not null
    ), limited as (
      select * from matched
      order by match_rank, distance_km nulls last, matched_name, id
      limit bounded_limit
    )
    select jsonb_agg(
      security_private.get_place_autocomplete_projection_v1(
        limited.id, p_at_date, p_period_from, p_period_to
      ) || jsonb_build_object(
        'matchedName', limited.matched_name,
        'distanceKm', case when limited.distance_km is null then null
          else round(limited.distance_km::numeric, 3) end,
        'ancestorPlaceId', p_ancestor_place_id
      )
      order by limited.match_rank, limited.distance_km nulls last, limited.matched_name, limited.id
    )
    from limited
  ), '[]'::jsonb);
end;
$function$;

-- Public facades remain SECURITY INVOKER. Grant only the private dispatchers
-- needed by those facades; internal graph helpers stay unreachable to API roles.
revoke all on function security_private.get_historical_place_redirect_v1(uuid)
  from public, anon, authenticated, service_role;

revoke all on function security_private.get_historical_place_redirect_public_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_historical_place_redirect_public_v1(uuid)
  to anon, authenticated, service_role;

revoke all on function public.get_place_redirect_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_place_redirect_v1(uuid)
  to anon, authenticated, service_role;

revoke all on function security_private.get_place_profile_or_redirect_v1(uuid,date)
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_place_profile_or_redirect_v1(uuid,date)
  to authenticated, service_role;

revoke all on function security_private.get_place_autocomplete_or_redirect_v1(uuid,date,date,date)
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_place_autocomplete_or_redirect_v1(uuid,date,date,date)
  to anon, authenticated, service_role;

revoke all on function security_private.list_place_external_identifiers_or_redirect_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.list_place_external_identifiers_or_redirect_v1(uuid)
  to authenticated, service_role;

revoke all on function security_private.historical_place_merge_cycle_v1(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.historical_place_admin_context_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.merge_place_snapshot_v2(uuid)
  from public, anon, authenticated, service_role;

comment on function public.get_place_redirect_v1(uuid) is
  'Returns only a safe redirect and visible final-target summary for a merged global Place; never returns source evidence.';
comment on function public.get_place_profile_v1(uuid,date) is
  'Returns the historical Place profile, or a minimal safe redirect envelope for a merged global source.';
comment on function public.get_place_autocomplete_projection_v1(uuid,date,date,date) is
  'Returns the date-aware Place projection, or a minimal safe redirect for a merged global source.';
comment on function public.merge_places_preview_v1(uuid,uuid) is
  'Returns merge evidence plus full accessible administrative context, and rejects a merge that would create a transitive hierarchy cycle.';
comment on function public.get_place_map_context_v1(uuid,date,date,date,integer) is
  'Map context whose exact date filters documents and events as the equivalent one-day period.';
comment on function public.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric) is
  'Safe Place search whose historical-name matches respect exact-date or period validity while canonical and modern labels remain searchable.';

notify pgrst, 'reload schema';

analyze public.places;
analyze public.place_names;
analyze public.place_hierarchy_relations;

commit;
