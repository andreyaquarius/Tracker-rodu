begin;

-- Personal saved Research Graph views (TZ 13, section 24).
--
-- Views are deliberately kept outside the exposed public schema.  A project
-- member, including a viewer, may persist UI state for their own account, but
-- project owners/editors cannot inspect or mutate another member's private
-- views.  No share token or public-link surface is introduced here.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;

create table if not exists security_private.context_graph_saved_views (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  config_version smallint not null default 1,
  name text not null,
  description text,
  center_entity_type text not null default 'person',
  center_entity_id uuid not null,
  depth integer not null default 2,
  entity_types text[] not null default array[
    'person','family','place','event','document','finding',
    'source','repository','hypothesis'
  ]::text[],
  relation_type_ids uuid[] not null default '{}'::uuid[],
  evidence_statuses text[] not null default '{}'::text[],
  assertion_kinds text[] not null default '{}'::text[],
  valid_from date,
  valid_to date,
  min_confidence integer,
  has_evidence boolean,
  focus_date date,
  focus_year integer,
  place_ids uuid[] not null default '{}'::uuid[],
  include_undated boolean not null default false,
  max_nodes integer not null default 100,
  max_edges integer not null default 220,
  layout_id text not null default 'radial',
  zoom numeric(8,4) not null default 1,
  viewport jsonb not null default '{"x":0,"y":0,"width":0,"height":0}'::jsonb,
  lock_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_graph_saved_views_project_owner_fk
    foreign key (project_id, owner_id)
    references public.project_members(project_id, user_id) on delete cascade,
  constraint context_graph_saved_views_center_person_fk
    foreign key (center_entity_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  constraint context_graph_saved_views_config_version
    check (config_version = 1),
  constraint context_graph_saved_views_name_length
    check (char_length(name) between 1 and 120),
  constraint context_graph_saved_views_description_length
    check (description is null or char_length(description) <= 500),
  constraint context_graph_saved_views_center_type
    check (center_entity_type = 'person'),
  constraint context_graph_saved_views_depth
    check (depth between 1 and 3),
  constraint context_graph_saved_views_entity_types_limit
    check (cardinality(entity_types) between 1 and 9),
  constraint context_graph_saved_views_relation_types_limit
    check (cardinality(relation_type_ids) <= 1),
  constraint context_graph_saved_views_evidence_statuses_limit
    check (cardinality(evidence_statuses) <= 1),
  constraint context_graph_saved_views_assertion_kinds_limit
    check (cardinality(assertion_kinds) <= 1),
  constraint context_graph_saved_views_date_range
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint context_graph_saved_views_confidence
    check (min_confidence is null or min_confidence between 0 and 100),
  constraint context_graph_saved_views_temporal_focus
    check (focus_date is null or focus_year is null),
  constraint context_graph_saved_views_focus_year
    check (focus_year is null or focus_year between 1 and 9999),
  constraint context_graph_saved_views_places_limit
    check (cardinality(place_ids) <= 1),
  constraint context_graph_saved_views_node_limit
    check (max_nodes = 100),
  constraint context_graph_saved_views_edge_limit
    check (max_edges = 220),
  constraint context_graph_saved_views_layout
    check (layout_id = 'radial'),
  constraint context_graph_saved_views_zoom
    check (zoom between 0.5 and 2),
  constraint context_graph_saved_views_viewport_object
    check (jsonb_typeof(viewport) = 'object'),
  constraint context_graph_saved_views_lock_version
    check (lock_version >= 1)
);

create unique index if not exists context_graph_saved_views_owner_name_uidx
  on security_private.context_graph_saved_views (
    project_id,
    owner_id,
    lower(name)
  );

create index if not exists context_graph_saved_views_owner_center_idx
  on security_private.context_graph_saved_views (
    project_id,
    owner_id,
    center_entity_type,
    center_entity_id,
    updated_at desc,
    id
  );

alter table security_private.context_graph_saved_views enable row level security;

drop policy if exists context_graph_saved_views_owner_select
  on security_private.context_graph_saved_views;
create policy context_graph_saved_views_owner_select
on security_private.context_graph_saved_views
for select to authenticated
using (
  owner_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

drop policy if exists context_graph_saved_views_owner_insert
  on security_private.context_graph_saved_views;
create policy context_graph_saved_views_owner_insert
on security_private.context_graph_saved_views
for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

drop policy if exists context_graph_saved_views_owner_update
  on security_private.context_graph_saved_views;
create policy context_graph_saved_views_owner_update
on security_private.context_graph_saved_views
for update to authenticated
using (
  owner_id = (select auth.uid())
  and (select public.is_project_member(project_id))
)
with check (
  owner_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

drop policy if exists context_graph_saved_views_owner_delete
  on security_private.context_graph_saved_views;
create policy context_graph_saved_views_owner_delete
on security_private.context_graph_saved_views
for delete to authenticated
using (
  owner_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

-- Keep parsing and validation in the checked private implementation.  The
-- public functions at the bottom are SECURITY INVOKER facades only.
create or replace function security_private.context_graph_saved_view_date_v1(
  p_value jsonb,
  p_field text
)
returns date
language plpgsql
stable
parallel safe
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  value_text text;
begin
  if p_value is null or p_value = 'null'::jsonb then return null; end if;
  if jsonb_typeof(p_value) <> 'string' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  value_text := p_value #>> '{}';
  if value_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  return value_text::date;
exception
  when datetime_field_overflow or invalid_datetime_format then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
end;
$function$;

create or replace function security_private.context_graph_saved_view_integer_v1(
  p_value jsonb,
  p_field text,
  p_default integer,
  p_min integer,
  p_max integer,
  p_nullable boolean default false
)
returns integer
language plpgsql
immutable
parallel safe
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare result integer;
begin
  if p_value is null or p_value = 'null'::jsonb then
    if p_nullable then return null; end if;
    return p_default;
  end if;
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}') !~ '^-?[0-9]+$' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  begin
    result := (p_value #>> '{}')::integer;
  exception when numeric_value_out_of_range then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_OUT_OF_RANGE', upper(p_field)
      using errcode = '22023';
  end;
  if result < p_min or result > p_max then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_OUT_OF_RANGE', upper(p_field)
      using errcode = '22023';
  end if;
  return result;
end;
$function$;

create or replace function security_private.context_graph_saved_view_partial_date_v1(
  p_value jsonb,
  p_field text,
  p_is_start boolean
)
returns date
language plpgsql
stable
parallel safe
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  value_text text;
  result date;
begin
  if p_value is null or p_value = 'null'::jsonb then return null; end if;
  if jsonb_typeof(p_value) <> 'string' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  value_text := p_value #>> '{}';
  if value_text !~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  result := security_private.context_partial_date_bound_v1(value_text, p_is_start);
  if result is null then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  return result;
end;
$function$;

create or replace function security_private.context_graph_saved_view_boolean_v1(
  p_value jsonb,
  p_field text,
  p_default boolean,
  p_nullable boolean default false
)
returns boolean
language plpgsql
immutable
parallel safe
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  if p_value is null or p_value = 'null'::jsonb then
    if p_nullable then return null; end if;
    return p_default;
  end if;
  if jsonb_typeof(p_value) <> 'boolean' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  return (p_value #>> '{}')::boolean;
end;
$function$;

create or replace function security_private.context_graph_saved_view_number_v1(
  p_value jsonb,
  p_field text,
  p_default numeric,
  p_min numeric,
  p_max numeric
)
returns numeric
language plpgsql
immutable
parallel safe
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare result numeric;
begin
  if p_value is null or p_value = 'null'::jsonb then return p_default; end if;
  if jsonb_typeof(p_value) <> 'number' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_INVALID', upper(p_field)
      using errcode = '22023';
  end if;
  result := (p_value #>> '{}')::numeric;
  if result < p_min or result > p_max then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_OUT_OF_RANGE', upper(p_field)
      using errcode = '22023';
  end if;
  return result;
exception when numeric_value_out_of_range then
  raise exception 'CONTEXT_GRAPH_SAVED_VIEW_%_OUT_OF_RANGE', upper(p_field)
    using errcode = '22023';
end;
$function$;

create or replace function security_private.context_graph_saved_view_json_v1(
  p_view security_private.context_graph_saved_views
)
returns jsonb
language sql
stable
parallel safe
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select jsonb_build_object(
    'id', p_view.id,
    'projectId', p_view.project_id,
    'ownerId', p_view.owner_id,
    'configVersion', p_view.config_version,
    'name', p_view.name,
    'description', p_view.description,
    'centerEntityType', p_view.center_entity_type,
    'centerEntityId', p_view.center_entity_id,
    'filters', jsonb_build_object(
      'depth', p_view.depth,
      'entityTypes', to_jsonb(p_view.entity_types),
      'relationTypeIds', to_jsonb(p_view.relation_type_ids),
      'evidenceStatuses', to_jsonb(p_view.evidence_statuses),
      'assertionKinds', to_jsonb(p_view.assertion_kinds),
      'validFrom', p_view.valid_from,
      'validTo', p_view.valid_to,
      'minConfidence', p_view.min_confidence,
      'hasEvidence', p_view.has_evidence,
      'focusDate', p_view.focus_date,
      'focusYear', p_view.focus_year,
      'placeIds', to_jsonb(p_view.place_ids),
      'includeUndated', p_view.include_undated,
      'maxNodes', p_view.max_nodes,
      'maxEdges', p_view.max_edges
    ),
    'viewState', jsonb_build_object(
      'layoutId', p_view.layout_id,
      'zoom', p_view.zoom,
      'viewport', p_view.viewport
    ),
    'lockVersion', p_view.lock_version,
    'createdAt', p_view.created_at,
    'updatedAt', p_view.updated_at
  );
$function$;

create or replace function security_private.context_graph_saved_view_canonical_place_v1(
  p_project_id uuid,
  p_place_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  canonical_id uuid;
  exhausted boolean;
begin
  if p_place_id is null then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PLACES_INVALID' using errcode = '22023';
  end if;
  with recursive place_chain as (
    select place.id, place.status, place.merged_into_place_id,
      array[place.id]::uuid[] path, 0 depth, false cycle_detected
    from public.places place
    where place.id = p_place_id
      and (place.project_id is null or place.project_id = p_project_id)
    union all
    select target.id, target.status, target.merged_into_place_id,
      chain.path || target.id, chain.depth + 1,
      target.id = any(chain.path)
    from place_chain chain
    join public.places target on target.id = chain.merged_into_place_id
      and (target.project_id is null or target.project_id = p_project_id)
    where chain.status = 'merged'
      and chain.merged_into_place_id is not null
      and chain.depth < 8
      and not chain.cycle_detected
  )
  select chain.id,
    chain.cycle_detected
      or (chain.depth = 8 and chain.status = 'merged'
        and chain.merged_into_place_id is not null)
  into canonical_id, exhausted
  from place_chain chain
  order by chain.depth desc
  limit 1;

  if canonical_id is null
     or exhausted
     or not security_private.context_entity_exists_v2(
       p_project_id, 'place', canonical_id
     )
     or exists (
       select 1 from public.places place
       where place.id = canonical_id
         and place.status not in ('active', 'needs_review')
     ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PLACE_NOT_CANONICAL'
      using errcode = '22023';
  end if;
  return canonical_id;
end;
$function$;

create or replace function security_private.validate_context_graph_saved_view_v1(
  p_view security_private.context_graph_saved_views
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare can_edit boolean;
begin
  if p_view.config_version <> 1 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CONFIG_VERSION_UNSUPPORTED'
      using errcode = '22023';
  end if;
  can_edit := public.can_edit_project(p_view.project_id);
  if not security_private.context_entity_visible_v2(
    p_view.project_id, p_view.center_entity_type, p_view.center_entity_id, can_edit
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CENTER_STALE'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1 from unnest(p_view.relation_type_ids) requested(value)
    where not exists (
      select 1 from public.context_relation_types relation_type
      where relation_type.id = requested.value
        and relation_type.is_active
        and (relation_type.project_id is null
          or relation_type.project_id = p_view.project_id)
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_RELATION_FILTER_STALE'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1 from unnest(p_view.place_ids) requested(value)
    where security_private.context_graph_saved_view_canonical_place_v1(
      p_view.project_id, requested.value
    ) <> requested.value
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PLACE_FILTER_STALE'
      using errcode = 'P0002';
  end if;
end;
$function$;

create or replace function security_private.list_context_graph_saved_views_v1(
  p_project_id uuid,
  p_center_entity_type text default null,
  p_center_entity_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  normalized_type text := nullif(lower(btrim(coalesce(p_center_entity_type, ''))), '');
  result jsonb;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  if actor_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if normalized_type is not null and normalized_type <> 'person' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CENTER_TYPE_INVALID' using errcode = '22023';
  end if;
  if (normalized_type is null) <> (p_center_entity_id is null) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CENTER_FILTER_INCOMPLETE' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_LIMIT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 10000 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_OFFSET_OUT_OF_RANGE' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'items', coalesce(jsonb_agg(
      security_private.context_graph_saved_view_json_v1(page.view_row)
      order by (page.view_row).updated_at desc, (page.view_row).id
    ), '[]'::jsonb),
    'total', coalesce(max(page.total_count), 0),
    'limit', p_limit,
    'offset', p_offset
  )
  into result
  from (
    select view_row,
      count(*) over()::integer total_count
    from security_private.context_graph_saved_views view_row
    where view_row.project_id = p_project_id
      and view_row.owner_id = actor_id
      and (normalized_type is null or view_row.center_entity_type = normalized_type)
      and (p_center_entity_id is null or view_row.center_entity_id = p_center_entity_id)
    order by view_row.updated_at desc, view_row.id
    limit p_limit offset p_offset
  ) page;

  return coalesce(result, jsonb_build_object(
    'items', '[]'::jsonb, 'total', 0, 'limit', p_limit, 'offset', p_offset
  ));
end;
$function$;

create or replace function security_private.get_context_graph_saved_view_v1(
  p_project_id uuid,
  p_view_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  view_row security_private.context_graph_saved_views%rowtype;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  if actor_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_view_id is null then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_ID_REQUIRED' using errcode = '22023';
  end if;
  select saved.* into view_row
  from security_private.context_graph_saved_views saved
  where saved.id = p_view_id
    and saved.project_id = p_project_id
    and saved.owner_id = actor_id;
  if not found then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform security_private.validate_context_graph_saved_view_v1(view_row);
  return security_private.context_graph_saved_view_json_v1(view_row);
end;
$function$;

create or replace function security_private.save_context_graph_saved_view_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  payload jsonb := coalesce(p_payload, '{}'::jsonb);
  filters jsonb;
  view_state jsonb;
  viewport_payload jsonb;
  saved_id uuid;
  normalized_name text;
  normalized_description text;
  center_type text;
  center_id uuid;
  depth_value integer;
  entity_type_values text[];
  relation_type_values uuid[];
  evidence_status_values text[];
  assertion_kind_values text[];
  valid_from_value date;
  valid_to_value date;
  min_confidence_value integer;
  has_evidence_value boolean;
  focus_date_value date;
  focus_year_value integer;
  place_values uuid[];
  include_undated_value boolean;
  max_nodes_value integer;
  max_edges_value integer;
  layout_value text;
  zoom_value numeric;
  viewport_value jsonb;
  can_edit boolean;
  result_row security_private.context_graph_saved_views%rowtype;
  conflicting_name uuid;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  if actor_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if jsonb_typeof(payload) <> 'object' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  if pg_column_size(payload) > 32768 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PAYLOAD_TOO_LARGE' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(payload) key(value)
    where key.value not in (
      'id', 'configVersion', 'name', 'description', 'centerEntityType', 'centerEntityId',
      'filters', 'viewState'
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PAYLOAD_FIELD_INVALID' using errcode = '22023';
  end if;
  if not (payload ? 'configVersion')
     or jsonb_typeof(payload->'configVersion') <> 'number'
     or (payload->>'configVersion') !~ '^[0-9]+$'
     or (payload->>'configVersion')::integer <> 1 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CONFIG_VERSION_UNSUPPORTED'
      using errcode = '22023';
  end if;

  if payload ? 'id' and payload->>'id' <> '' then
    begin saved_id := (payload->>'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'CONTEXT_GRAPH_SAVED_VIEW_ID_INVALID' using errcode = '22023';
    end;
    if p_expected_lock_version is null or p_expected_lock_version < 1 then
      raise exception 'CONTEXT_GRAPH_SAVED_VIEW_EXPECTED_LOCK_REQUIRED' using errcode = '22023';
    end if;
  else
    saved_id := null;
    if p_expected_lock_version is not null then
      raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CREATE_LOCK_NOT_ALLOWED' using errcode = '22023';
    end if;
  end if;

  if jsonb_typeof(payload->'name') <> 'string' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NAME_REQUIRED' using errcode = '22023';
  end if;
  normalized_name := btrim(regexp_replace(payload->>'name', '\s+', ' ', 'g'));
  if char_length(normalized_name) < 1 or char_length(normalized_name) > 120 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NAME_LENGTH_INVALID' using errcode = '22023';
  end if;
  if payload ? 'description' and payload->'description' <> 'null'::jsonb
     and jsonb_typeof(payload->'description') <> 'string' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_DESCRIPTION_INVALID' using errcode = '22023';
  end if;
  normalized_description := nullif(btrim(coalesce(payload->>'description', '')), '');
  if char_length(coalesce(normalized_description, '')) > 500 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_DESCRIPTION_TOO_LONG' using errcode = '22023';
  end if;

  center_type := lower(btrim(coalesce(payload->>'centerEntityType', 'person')));
  if center_type <> 'person' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CENTER_TYPE_INVALID' using errcode = '22023';
  end if;
  begin center_id := (payload->>'centerEntityId')::uuid;
  exception when invalid_text_representation or null_value_not_allowed then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CENTER_ID_INVALID' using errcode = '22023';
  end;
  if center_id is null then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CENTER_ID_REQUIRED' using errcode = '22023';
  end if;

  can_edit := public.can_edit_project(p_project_id);
  if not security_private.context_entity_visible_v2(
    p_project_id, center_type, center_id, can_edit
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_CENTER_NOT_VISIBLE' using errcode = 'P0002';
  end if;

  filters := coalesce(payload->'filters', '{}'::jsonb);
  if jsonb_typeof(filters) <> 'object' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_FILTERS_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(filters) key(value)
    where key.value not in (
      'depth', 'entityTypes', 'relationTypeIds', 'evidenceStatuses',
      'assertionKinds', 'validFrom', 'validTo', 'minConfidence',
      'hasEvidence', 'focusDate', 'focusYear', 'placeIds',
      'includeUndated', 'maxNodes', 'maxEdges'
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_FILTER_FIELD_INVALID' using errcode = '22023';
  end if;

  depth_value := security_private.context_graph_saved_view_integer_v1(
    filters->'depth', 'DEPTH', 2, 1, 3, false
  );
  min_confidence_value := security_private.context_graph_saved_view_integer_v1(
    filters->'minConfidence', 'MIN_CONFIDENCE', null, 0, 100, true
  );
  focus_year_value := security_private.context_graph_saved_view_integer_v1(
    filters->'focusYear', 'FOCUS_YEAR', null, 1, 9999, true
  );
  max_nodes_value := security_private.context_graph_saved_view_integer_v1(
    filters->'maxNodes', 'MAX_NODES', 100, 100, 100, false
  );
  max_edges_value := security_private.context_graph_saved_view_integer_v1(
    filters->'maxEdges', 'MAX_EDGES', 220, 220, 220, false
  );
  valid_from_value := security_private.context_graph_saved_view_partial_date_v1(
    filters->'validFrom', 'VALID_FROM', true
  );
  valid_to_value := security_private.context_graph_saved_view_partial_date_v1(
    filters->'validTo', 'VALID_TO', false
  );
  focus_date_value := security_private.context_graph_saved_view_date_v1(
    filters->'focusDate', 'FOCUS_DATE'
  );
  if valid_from_value is not null and valid_to_value is not null
     and valid_from_value > valid_to_value then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_DATE_RANGE_INVALID' using errcode = '22023';
  end if;
  if focus_date_value is not null and focus_year_value is not null then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_TEMPORAL_FOCUS_AMBIGUOUS' using errcode = '22023';
  end if;
  has_evidence_value := security_private.context_graph_saved_view_boolean_v1(
    filters->'hasEvidence', 'HAS_EVIDENCE', null, true
  );
  include_undated_value := security_private.context_graph_saved_view_boolean_v1(
    filters->'includeUndated', 'INCLUDE_UNDATED', false, false
  );

  if filters ? 'entityTypes' and jsonb_typeof(filters->'entityTypes') <> 'array' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_ENTITY_TYPES_INVALID' using errcode = '22023';
  end if;
  select coalesce(array_agg(value order by value), '{}'::text[])
  into entity_type_values
  from (
    select distinct lower(btrim(item.value)) value
    from jsonb_array_elements_text(coalesce(filters->'entityTypes',
      '["person","family","place","event","document","finding","source","repository","hypothesis"]'::jsonb
    )) item
  ) normalized
  where value <> '';
  if cardinality(entity_type_values) < 1
     or cardinality(entity_type_values) > 9 or exists (
    select 1 from unnest(entity_type_values) item
    where item not in (
      'person', 'family', 'place', 'event', 'document', 'finding',
      'source', 'repository', 'hypothesis'
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_ENTITY_TYPES_INVALID' using errcode = '22023';
  end if;

  if filters ? 'relationTypeIds' and jsonb_typeof(filters->'relationTypeIds') <> 'array' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_RELATION_TYPES_INVALID' using errcode = '22023';
  end if;
  begin
    select coalesce(array_agg(value order by value), '{}'::uuid[])
    into relation_type_values
    from (
      select distinct item.value::uuid value
      from jsonb_array_elements_text(coalesce(filters->'relationTypeIds', '[]'::jsonb)) item
    ) normalized;
  exception when invalid_text_representation then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_RELATION_TYPES_INVALID' using errcode = '22023';
  end;
  if cardinality(relation_type_values) > 1 or exists (
    select 1 from unnest(relation_type_values) requested(value)
    where not exists (
      select 1 from public.context_relation_types relation_type
      where relation_type.id = requested.value
        and relation_type.is_active
        and (relation_type.project_id is null or relation_type.project_id = p_project_id)
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_RELATION_TYPES_INVALID' using errcode = '22023';
  end if;

  if filters ? 'evidenceStatuses' and jsonb_typeof(filters->'evidenceStatuses') <> 'array' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_EVIDENCE_STATUSES_INVALID' using errcode = '22023';
  end if;
  select coalesce(array_agg(value order by value), '{}'::text[])
  into evidence_status_values
  from (
    select distinct lower(btrim(item.value)) value
    from jsonb_array_elements_text(coalesce(filters->'evidenceStatuses', '[]'::jsonb)) item
  ) normalized
  where value <> '';
  if cardinality(evidence_status_values) > 1 or exists (
    select 1 from unnest(evidence_status_values) item
    where item not in ('proven', 'likely', 'disputed', 'disproven', 'unknown')
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_EVIDENCE_STATUSES_INVALID' using errcode = '22023';
  end if;

  if filters ? 'assertionKinds' and jsonb_typeof(filters->'assertionKinds') <> 'array' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_ASSERTION_KINDS_INVALID' using errcode = '22023';
  end if;
  select coalesce(array_agg(value order by value), '{}'::text[])
  into assertion_kind_values
  from (
    select distinct lower(btrim(item.value)) value
    from jsonb_array_elements_text(coalesce(filters->'assertionKinds', '[]'::jsonb)) item
  ) normalized
  where value <> '';
  if cardinality(assertion_kind_values) > 1 or exists (
    select 1 from unnest(assertion_kind_values) item
    where item not in ('manual', 'legacy_import', 'generated', 'research_hypothesis')
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_ASSERTION_KINDS_INVALID' using errcode = '22023';
  end if;

  if filters ? 'placeIds' and jsonb_typeof(filters->'placeIds') <> 'array' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PLACES_INVALID' using errcode = '22023';
  end if;
  begin
    select coalesce(array_agg(value order by value), '{}'::uuid[])
    into place_values
    from (
      select distinct security_private.context_graph_saved_view_canonical_place_v1(
        p_project_id, item.value::uuid
      ) value
      from jsonb_array_elements_text(coalesce(filters->'placeIds', '[]'::jsonb)) item
    ) normalized;
  exception when invalid_text_representation then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PLACES_INVALID' using errcode = '22023';
  end;
  if cardinality(place_values) > 1 or exists (
    select 1 from unnest(place_values) requested(value)
    where not security_private.context_entity_exists_v2(
      p_project_id, 'place', requested.value
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_PLACES_INVALID' using errcode = '22023';
  end if;
  view_state := coalesce(payload->'viewState', '{}'::jsonb);
  if jsonb_typeof(view_state) <> 'object' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_STATE_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(view_state) key(value)
    where key.value not in ('layoutId', 'zoom', 'viewport')
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_STATE_FIELD_INVALID' using errcode = '22023';
  end if;
  layout_value := lower(btrim(coalesce(view_state->>'layoutId', 'radial')));
  if layout_value <> 'radial' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_LAYOUT_INVALID' using errcode = '22023';
  end if;
  zoom_value := security_private.context_graph_saved_view_number_v1(
    view_state->'zoom', 'ZOOM', 1, 0.5, 2
  );
  viewport_payload := coalesce(view_state->'viewport', '{}'::jsonb);
  if jsonb_typeof(viewport_payload) <> 'object' then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_VIEWPORT_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(viewport_payload) key(value)
    where key.value not in ('x', 'y', 'width', 'height')
  ) then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_VIEWPORT_FIELD_INVALID' using errcode = '22023';
  end if;
  viewport_value := jsonb_build_object(
    'x', security_private.context_graph_saved_view_number_v1(
      viewport_payload->'x', 'VIEWPORT_X', 0, 0, 10000000
    ),
    'y', security_private.context_graph_saved_view_number_v1(
      viewport_payload->'y', 'VIEWPORT_Y', 0, 0, 10000000
    ),
    'width', security_private.context_graph_saved_view_number_v1(
      viewport_payload->'width', 'VIEWPORT_WIDTH', 0, 0, 100000
    ),
    'height', security_private.context_graph_saved_view_number_v1(
      viewport_payload->'height', 'VIEWPORT_HEIGHT', 0, 0, 100000
    )
  );

  select saved.id into conflicting_name
  from security_private.context_graph_saved_views saved
  where saved.project_id = p_project_id
    and saved.owner_id = actor_id
    and lower(saved.name) = lower(normalized_name)
    and (saved_id is null or saved.id <> saved_id)
  limit 1;
  if conflicting_name is not null then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NAME_EXISTS' using errcode = '23505';
  end if;

  if saved_id is null then
    perform pg_advisory_xact_lock(hashtextextended(
      'context_graph_saved_views:' || p_project_id::text || ':' || actor_id::text,
      0
    ));
    if (
      select count(*)
      from security_private.context_graph_saved_views saved
      where saved.project_id = p_project_id and saved.owner_id = actor_id
    ) >= 50 then
      raise exception 'CONTEXT_GRAPH_SAVED_VIEW_QUOTA_EXCEEDED' using errcode = '22023';
    end if;
    insert into security_private.context_graph_saved_views (
      project_id, owner_id, name, description, center_entity_type,
      center_entity_id, depth, entity_types, relation_type_ids,
      evidence_statuses, assertion_kinds, valid_from, valid_to,
      min_confidence, has_evidence, focus_date, focus_year, place_ids,
      include_undated, max_nodes, max_edges, layout_id, zoom, viewport
    ) values (
      p_project_id, actor_id, normalized_name, normalized_description,
      center_type, center_id, depth_value, entity_type_values,
      relation_type_values, evidence_status_values, assertion_kind_values,
      valid_from_value, valid_to_value, min_confidence_value,
      has_evidence_value, focus_date_value, focus_year_value, place_values,
      include_undated_value, max_nodes_value, max_edges_value,
      layout_value, zoom_value, viewport_value
    ) returning * into result_row;
  else
    update security_private.context_graph_saved_views saved
    set name = normalized_name,
        description = normalized_description,
        center_entity_type = center_type,
        center_entity_id = center_id,
        depth = depth_value,
        entity_types = entity_type_values,
        relation_type_ids = relation_type_values,
        evidence_statuses = evidence_status_values,
        assertion_kinds = assertion_kind_values,
        valid_from = valid_from_value,
        valid_to = valid_to_value,
        min_confidence = min_confidence_value,
        has_evidence = has_evidence_value,
        focus_date = focus_date_value,
        focus_year = focus_year_value,
        place_ids = place_values,
        include_undated = include_undated_value,
        max_nodes = max_nodes_value,
        max_edges = max_edges_value,
        layout_id = layout_value,
        zoom = zoom_value,
        viewport = viewport_value,
        lock_version = saved.lock_version + 1,
        updated_at = now()
    where saved.id = saved_id
      and saved.project_id = p_project_id
      and saved.owner_id = actor_id
      and saved.lock_version = p_expected_lock_version
    returning saved.* into result_row;
    if not found then
      if exists (
        select 1 from security_private.context_graph_saved_views saved
        where saved.id = saved_id
          and saved.project_id = p_project_id
          and saved.owner_id = actor_id
      ) then
        raise exception 'CONTEXT_GRAPH_SAVED_VIEW_VERSION_CONFLICT'
          using errcode = '40001';
      end if;
      raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  perform security_private.validate_context_graph_saved_view_v1(result_row);
  return security_private.context_graph_saved_view_json_v1(result_row);
exception
  when unique_violation then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NAME_EXISTS' using errcode = '23505';
end;
$function$;

create or replace function security_private.delete_context_graph_saved_view_v1(
  p_project_id uuid,
  p_view_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  deleted_id uuid;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  if actor_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_view_id is null then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_ID_REQUIRED' using errcode = '22023';
  end if;
  if p_expected_lock_version is null or p_expected_lock_version < 1 then
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_EXPECTED_LOCK_REQUIRED' using errcode = '22023';
  end if;
  delete from security_private.context_graph_saved_views saved
  where saved.id = p_view_id
    and saved.project_id = p_project_id
    and saved.owner_id = actor_id
    and saved.lock_version = p_expected_lock_version
  returning saved.id into deleted_id;
  if deleted_id is null then
    if exists (
      select 1 from security_private.context_graph_saved_views saved
      where saved.id = p_view_id
        and saved.project_id = p_project_id
        and saved.owner_id = actor_id
    ) then
      raise exception 'CONTEXT_GRAPH_SAVED_VIEW_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
    raise exception 'CONTEXT_GRAPH_SAVED_VIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', deleted_id, 'deleted', true);
end;
$function$;

-- Authenticated facade.  These wrappers never become SECURITY DEFINER; all
-- privilege elevation and project/owner validation remains in the private
-- checked implementation above.
create or replace function public.list_context_graph_saved_views_v1(
  p_project_id uuid,
  p_center_entity_type text default null,
  p_center_entity_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.list_context_graph_saved_views_v1(
    p_project_id, p_center_entity_type, p_center_entity_id, p_limit, p_offset
  );
$function$;

create or replace function public.get_context_graph_saved_view_v1(
  p_project_id uuid,
  p_view_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.get_context_graph_saved_view_v1(p_project_id, p_view_id);
$function$;

create or replace function public.save_context_graph_saved_view_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.save_context_graph_saved_view_v1(
    p_project_id, p_payload, p_expected_lock_version
  );
$function$;

create or replace function public.delete_context_graph_saved_view_v1(
  p_project_id uuid,
  p_view_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.delete_context_graph_saved_view_v1(
    p_project_id, p_view_id, p_expected_lock_version
  );
$function$;

revoke all on table security_private.context_graph_saved_views
from public, anon, authenticated, service_role;

do $context_graph_saved_view_private_acl$
declare function_record record;
begin
  for function_record in
    select procedure.oid::regprocedure signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'security_private'
      and procedure.proname = any(array[
        'context_graph_saved_view_date_v1',
        'context_graph_saved_view_integer_v1',
        'context_graph_saved_view_partial_date_v1',
        'context_graph_saved_view_boolean_v1',
        'context_graph_saved_view_number_v1',
        'context_graph_saved_view_json_v1',
        'context_graph_saved_view_canonical_place_v1',
        'validate_context_graph_saved_view_v1',
        'list_context_graph_saved_views_v1',
        'get_context_graph_saved_view_v1',
        'save_context_graph_saved_view_v1',
        'delete_context_graph_saved_view_v1'
      ]::text[])
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_record.signature
    );
  end loop;
end;
$context_graph_saved_view_private_acl$;

grant execute on function security_private.list_context_graph_saved_views_v1(
  uuid, text, uuid, integer, integer
) to authenticated;
grant execute on function security_private.get_context_graph_saved_view_v1(
  uuid, uuid
) to authenticated;
grant execute on function security_private.save_context_graph_saved_view_v1(
  uuid, jsonb, integer
) to authenticated;
grant execute on function security_private.delete_context_graph_saved_view_v1(
  uuid, uuid, integer
) to authenticated;

revoke all on function public.list_context_graph_saved_views_v1(
  uuid, text, uuid, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.get_context_graph_saved_view_v1(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.save_context_graph_saved_view_v1(uuid, jsonb, integer)
from public, anon, authenticated, service_role;
revoke all on function public.delete_context_graph_saved_view_v1(uuid, uuid, integer)
from public, anon, authenticated, service_role;

grant execute on function public.list_context_graph_saved_views_v1(
  uuid, text, uuid, integer, integer
) to authenticated;
grant execute on function public.get_context_graph_saved_view_v1(uuid, uuid)
to authenticated;
grant execute on function public.save_context_graph_saved_view_v1(uuid, jsonb, integer)
to authenticated;
grant execute on function public.delete_context_graph_saved_view_v1(uuid, uuid, integer)
to authenticated;

notify pgrst, 'reload schema';

commit;
