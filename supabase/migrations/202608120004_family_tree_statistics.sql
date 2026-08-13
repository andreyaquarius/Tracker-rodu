begin;

-- Family-tree statistics are intentionally calculated on the server.  The
-- browser receives compact aggregates and paginated drill-down rows, never a
-- second copy of a 10–50k person tree.

create or replace function security_private.family_tree_statistics_year_v1(
  primary_value text,
  range_from text default null,
  range_to text default null
)
returns integer
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select case
    when substring(coalesce(nullif(trim(primary_value), ''), '') from '(1[0-9]{3}|20[0-9]{2})') <> ''
      then substring(primary_value from '(1[0-9]{3}|20[0-9]{2})')::integer
    when substring(coalesce(nullif(trim(range_from), ''), '') from '(1[0-9]{3}|20[0-9]{2})') <> ''
      then substring(range_from from '(1[0-9]{3}|20[0-9]{2})')::integer
    when substring(coalesce(nullif(trim(range_to), ''), '') from '(1[0-9]{3}|20[0-9]{2})') <> ''
      then substring(range_to from '(1[0-9]{3}|20[0-9]{2})')::integer
    else null
  end;
$function$;

create or replace function security_private.family_tree_statistics_month_v1(
  source_value text
)
returns integer
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $function$
declare
  normalized text := replace(replace(trim(coalesce(source_value, '')), '/', '-'), '.', '-');
  parts text[];
begin
  parts := string_to_array(normalized, '-');
  if array_length(parts, 1) <> 3 then return null; end if;
  if length(parts[1]) = 4 and parts[1] ~ '^[0-9]{4}$' and parts[2] ~ '^[0-9]{1,2}$' then
    return case when parts[2]::integer between 1 and 12 then parts[2]::integer else null end;
  end if;
  if parts[3] ~ '^[0-9]{4}$' and parts[2] ~ '^[0-9]{1,2}$' then
    return case when parts[2]::integer between 1 and 12 then parts[2]::integer else null end;
  end if;
  return null;
end;
$function$;

-- A GEDCOM MARR record belongs to a family, not to one individual. During
-- import its date is therefore stored on partner_relationships.start_date.
-- Manually entered person events and the legacy persons.marriage_date column
-- remain valid fallbacks. Statistics must use the earliest proven/non-refuted
-- date from all three representations and count both partners independently.
create or replace function security_private.family_tree_statistics_first_marriage_year_v1(
  p_person_id uuid,
  p_tree_id uuid,
  p_legacy_marriage_date text default null
)
returns integer
language sql
stable
set search_path = pg_catalog
as $function$
  with candidate_years as (
    select security_private.family_tree_statistics_year_v1(
      relation.start_date,
      null,
      null
    ) as marriage_year
    from public.partner_relationships relation
    where relation.tree_id = p_tree_id
      and relation.evidence_status <> 'disproven'
      and relation.relationship_type in (
        'marriage',
        'divorced',
        'separated',
        'annulled',
        'widowhood'
      )
      and p_person_id in (relation.person_a_id, relation.person_b_id)
      and nullif(trim(relation.start_date), '') is not null

    union all

    select security_private.family_tree_statistics_year_v1(
      event.event_date,
      event.date_from,
      event.date_to
    )
    from public.person_timeline_events event
    where event.person_id = p_person_id
      and event.event_type = 'marriage'
      and event.evidence_status <> 'disproven'

    union all

    select security_private.family_tree_statistics_year_v1(
      p_legacy_marriage_date,
      null,
      null
    )
  )
  select min(candidate_years.marriage_year)
  from candidate_years
  where candidate_years.marriage_year is not null;
$function$;

-- GEDCOM can explicitly assert that a person died (`DEAT Y`) without giving a
-- death date.  The importer preserves that tri-state assertion in
-- `__gedcomVitalStatus`; statistics must not turn it back into "unknown" just
-- because the date is still being researched.
create or replace function security_private.family_tree_statistics_life_status_v1(
  is_living_value boolean,
  custom_fields_value jsonb,
  death_date_value text default null,
  death_year_from_value text default null,
  death_year_to_value text default null
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select case
    -- The editable application flag is authoritative for a living person.
    when is_living_value is true then 'living'
    -- An explicit GEDCOM death marker is authoritative even without a date.
    when lower(trim(coalesce(custom_fields_value ->> '__gedcomVitalStatus', ''))) = 'deceased' then 'deceased'
    -- A real death value also proves death for legacy records without metadata.
    when coalesce(
      nullif(trim(death_date_value), ''),
      nullif(trim(death_year_from_value), ''),
      nullif(trim(death_year_to_value), '')
    ) is not null then 'deceased'
    -- Modern GEDCOM imports deliberately preserve a genuinely unknown status.
    when lower(trim(coalesce(custom_fields_value ->> '__gedcomVitalStatus', ''))) = 'unknown' then 'unknown'
    -- The application UI is binary, so a manually saved false value means dead.
    when is_living_value is false then 'deceased'
    when lower(trim(coalesce(custom_fields_value ->> '__gedcomVitalStatus', ''))) = 'living' then 'living'
    else 'unknown'
  end;
$function$;

create or replace function security_private.family_tree_statistics_coordinate_v1(
  geo_value jsonb,
  axis text
)
returns numeric
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $function$
declare
  raw_value text;
  parsed_value numeric;
begin
  if jsonb_typeof(geo_value) <> 'object' then return null; end if;
  raw_value := case when axis = 'latitude'
    then coalesce(geo_value ->> 'latitude', geo_value ->> 'lat')
    else coalesce(geo_value ->> 'longitude', geo_value ->> 'lng', geo_value ->> 'lon') end;
  if not pg_input_is_valid(coalesce(raw_value, ''), 'numeric') then return null; end if;
  parsed_value := raw_value::numeric;
  if axis = 'latitude' and parsed_value not between -90 and 90 then return null; end if;
  if axis <> 'latitude' and parsed_value not between -180 and 180 then return null; end if;
  return parsed_value;
end;
$function$;

create or replace function security_private.prepare_family_tree_statistics_v1(
  p_request jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_temp, public
set statement_timeout = '45s'
as $function$
declare
  requested_tree_id uuid;
  requested_scope text;
  requested_branch text;
  requested_generation_from integer;
  requested_generation_to integer;
  requested_year_from integer;
  requested_year_to integer;
  requested_sex text;
  requested_life_status text;
  requested_relationship_type text;
  requested_place text;
  requested_import_source text;
  requested_source_filter text;
  requested_evidence text[];
  requested_event_types text[];
  requested_surname_mode text;
  current_project_id uuid;
  persisted_root_id uuid;
  current_tree_title text;
  current_graph_version bigint;
  current_tree_updated_at timestamptz;
  project_member_role text;
  can_view_private boolean;
  root_name text;
begin
  perform public.assert_family_tree_feature_access();
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_request is null
     or jsonb_typeof(p_request) <> 'object'
     or not pg_input_is_valid(coalesce(p_request ->> 'treeId', ''), 'uuid') then
    raise exception 'INVALID_FAMILY_TREE_STATISTICS_REQUEST' using errcode = '22023';
  end if;

  requested_tree_id := (p_request ->> 'treeId')::uuid;
  requested_scope := case when p_request ->> 'scope' in ('direct-ancestors', 'descendants')
    then p_request ->> 'scope' else 'all' end;
  requested_branch := case when p_request ->> 'branch' in ('paternal', 'maternal')
    then p_request ->> 'branch' else 'all' end;
  requested_generation_from := case when pg_input_is_valid(coalesce(p_request ->> 'generationFrom', ''), 'integer')
    then greatest(0, (p_request ->> 'generationFrom')::integer) else null end;
  requested_generation_to := case when pg_input_is_valid(coalesce(p_request ->> 'generationTo', ''), 'integer')
    then greatest(0, (p_request ->> 'generationTo')::integer) else null end;
  requested_year_from := case when pg_input_is_valid(coalesce(p_request ->> 'yearFrom', ''), 'integer')
    then (p_request ->> 'yearFrom')::integer else null end;
  requested_year_to := case when pg_input_is_valid(coalesce(p_request ->> 'yearTo', ''), 'integer')
    then (p_request ->> 'yearTo')::integer else null end;
  requested_sex := case when p_request ->> 'sex' in ('male', 'female', 'unknown')
    then p_request ->> 'sex' else 'all' end;
  requested_life_status := case when p_request ->> 'lifeStatus' in ('living', 'deceased', 'unknown')
    then p_request ->> 'lifeStatus' else 'all' end;
  requested_relationship_type := lower(trim(coalesce(p_request ->> 'relationshipType', '')));
  requested_place := lower(trim(coalesce(p_request ->> 'place', '')));
  requested_import_source := trim(coalesce(p_request ->> 'importSourceKey', ''));
  requested_source_filter := case when p_request ->> 'sourceFilter' in ('with-sources', 'without-sources')
    then p_request ->> 'sourceFilter' else 'all' end;
  requested_evidence := case
    when jsonb_typeof(p_request -> 'evidenceStatuses') = 'array'
      then array(select jsonb_array_elements_text(p_request -> 'evidenceStatuses'))
    else array[]::text[]
  end;
  requested_event_types := case
    when jsonb_typeof(p_request -> 'eventTypes') = 'array'
      then array(select lower(trim(value)) from jsonb_array_elements_text(p_request -> 'eventTypes') value where trim(value) <> '')
    else array[]::text[]
  end;
  requested_surname_mode := case when p_request ->> 'surnameMode' in ('birth', 'married')
    then p_request ->> 'surnameMode' else 'displayed' end;

  select tree.project_id, tree.root_person_id, tree.title, tree.graph_version, tree.updated_at
    into current_project_id, persisted_root_id, current_tree_title,
      current_graph_version, current_tree_updated_at
  from public.family_trees tree
  where tree.id = requested_tree_id
  for share;

  if current_project_id is null
     or persisted_root_id is null
     or not public.is_project_member(current_project_id) then
    raise exception 'TREE_NOT_FOUND_OR_FORBIDDEN' using errcode = '42501';
  end if;
  if p_request ? 'rootPersonId'
     and nullif(trim(p_request ->> 'rootPersonId'), '') is not null
     and p_request ->> 'rootPersonId' <> persisted_root_id::text then
    raise exception 'TREE_ROOT_CHANGED' using errcode = '40001';
  end if;

  select member.role::text
    into project_member_role
  from public.project_members member
  where member.project_id = current_project_id
    and member.user_id = auth.uid();
  can_view_private := project_member_role in ('owner', 'editor');

  select coalesce(
    nullif(trim(concat_ws(' ', person.surname, person.given_name, person.patronymic)), ''),
    nullif(trim(person.full_name), ''),
    'Особа без імені'
  ) into root_name
  from public.persons person
  where person.id = persisted_root_id;

  drop table if exists pg_temp._ft_stats_kinship;
  drop table if exists pg_temp._ft_stats_direct_ancestors;
  drop table if exists pg_temp._ft_stats_population;
  drop table if exists pg_temp._ft_stats_parent_edges;
  drop table if exists pg_temp._ft_stats_ancestor_occurrences;

  create temporary table _ft_stats_kinship (
    person_id uuid primary key,
    kinship_kind text not null,
    up_steps integer not null,
    down_steps integer not null,
    partner_steps integer not null,
    order_path text not null,
    via_person_id uuid
  ) on commit drop;
  insert into _ft_stats_kinship
  select *
  from security_private.list_family_tree_root_kinship_v1(
    requested_tree_id,
    persisted_root_id
  );

  -- Keep the unique direct-ancestor set identical to the Persons catalogue.
  -- The broad kinship graph remains useful for descendants and collateral
  -- labels, but it is not the canonical source for an ancestor count.
  create temporary table _ft_stats_direct_ancestors (
    person_id uuid primary key,
    generation integer not null,
    order_path text not null
  ) on commit drop;
  insert into _ft_stats_direct_ancestors (person_id, generation, order_path)
  select ancestor.person_id, ancestor.generation, ancestor.order_path
  from security_private.list_family_tree_direct_ancestor_order_v1(
    requested_tree_id,
    persisted_root_id
  ) ancestor;

  create temporary table _ft_stats_parent_edges (
    parent_id uuid not null,
    child_id uuid not null,
    relationship_id uuid not null,
    relationship_type text not null,
    evidence_status text not null,
    side integer not null,
    primary key (parent_id, child_id)
  ) on commit drop;

  insert into _ft_stats_parent_edges (
    parent_id, child_id, relationship_id, relationship_type, evidence_status, side
  )
  select distinct on (relation.parent_id, relation.child_id)
    relation.parent_id,
    relation.child_id,
    relation.id,
    relation.relationship_type,
    relation.evidence_status,
    case
      when relation.parent_role_label in ('father', 'adoptive_father', 'stepfather')
        or relation.relationship_type = 'genetic_father'
        or lower(parent_person.gender) in ('male', 'm', 'чоловік', 'чоловіча') then 0
      when relation.parent_role_label in ('mother', 'adoptive_mother', 'stepmother')
        or relation.relationship_type in ('genetic_mother', 'gestational_parent', 'birth_parent', 'surrogate')
        or lower(parent_person.gender) in ('female', 'f', 'жінка', 'жіноча') then 1
      else row_number() over (partition by relation.child_id order by relation.is_primary_for_display desc, relation.id) - 1
    end::integer
  from public.family_tree_persons child_member
  join lateral (
    select parent_set.id
    from public.parent_sets parent_set
    where parent_set.tree_id = requested_tree_id
      and parent_set.child_id = child_member.person_id
      and exists (
        select 1
        from public.parent_child_relationships candidate
        join public.family_tree_persons candidate_parent
          on candidate_parent.tree_id = requested_tree_id
         and candidate_parent.person_id = candidate.parent_id
         and candidate_parent.member_role <> 'hidden'
        where candidate.parent_set_id = parent_set.id
          and candidate.evidence_status <> 'disproven'
          and (candidate.privacy_status <> 'confidential' or can_view_private)
      )
    order by parent_set.is_default_for_pedigree desc,
      exists (
        select 1
        from public.parent_child_relationships preferred_relation
        where preferred_relation.parent_set_id = parent_set.id
          and preferred_relation.is_primary_for_display
          and preferred_relation.evidence_status <> 'disproven'
          and (preferred_relation.privacy_status <> 'confidential' or can_view_private)
      ) desc,
      parent_set.is_preferred_for_display desc,
      coalesce((
        select min(case relation_kind.relationship_type
          when 'biological' then 0
          when 'genetic_father' then 1
          when 'genetic_mother' then 1
          when 'gestational_parent' then 1
          when 'birth_parent' then 1
          when 'presumed' then 2
          when 'adoptive' then 3
          when 'legal_parent' then 4
          when 'social_parent' then 5
          when 'foster' then 6
          when 'guardian' then 7
          when 'step' then 8
          when 'donor' then 9
          when 'surrogate' then 10
          when 'unknown' then 11
          else 12
        end)
        from public.parent_child_relationships relation_kind
        where relation_kind.parent_set_id = parent_set.id
          and relation_kind.evidence_status <> 'disproven'
      ), 2147483647),
      parent_set.display_order,
      parent_set.id
    limit 1
  ) chosen on true
  join public.parent_child_relationships relation
    on relation.parent_set_id = chosen.id
   and relation.tree_id = requested_tree_id
   and relation.child_id = child_member.person_id
  join public.family_tree_persons parent_member
    on parent_member.tree_id = requested_tree_id
   and parent_member.person_id = relation.parent_id
   and parent_member.member_role <> 'hidden'
  join public.persons parent_person on parent_person.id = relation.parent_id
  where child_member.tree_id = requested_tree_id
    and child_member.member_role <> 'hidden'
    and relation.evidence_status <> 'disproven'
    and (relation.privacy_status <> 'confidential' or can_view_private)
  order by relation.parent_id, relation.child_id,
    relation.is_primary_for_display desc, relation.id;

  create temporary table _ft_stats_ancestor_occurrences (
    person_id uuid not null,
    generation integer not null,
    ahnentafel numeric not null,
    branch text not null,
    path uuid[] not null,
    primary key (generation, ahnentafel)
  ) on commit drop;

  insert into _ft_stats_ancestor_occurrences
  with recursive lineage as (
    select persisted_root_id as person_id, 0 as generation, 1::numeric as ahnentafel,
      'root'::text as branch, array[persisted_root_id]::uuid[] as path
    union all
    select edge.parent_id,
      lineage.generation + 1,
      lineage.ahnentafel * 2 + least(edge.side, 1),
      case when lineage.generation = 0
        then case when edge.side = 0 then 'paternal' else 'maternal' end
        else lineage.branch end,
      lineage.path || edge.parent_id
    from lineage
    join _ft_stats_parent_edges edge on edge.child_id = lineage.person_id
    where lineage.generation < 16
      and edge.side in (0, 1)
      and not edge.parent_id = any(lineage.path)
  )
  select * from lineage;

  create temporary table _ft_stats_population (
    person_id uuid primary key,
    generation integer not null,
    branch text not null,
    kinship_kind text not null,
    up_steps integer not null,
    down_steps integer not null,
    private_living boolean not null,
    has_sources boolean not null
  ) on commit drop;

  insert into _ft_stats_population
  select member.person_id,
    classification.generation,
    classification.branch,
    classification.kinship_kind,
    classification.up_steps,
    classification.down_steps,
    (not can_view_private and person.is_living and coalesce(person.privacy_status, 'project') in ('private', 'confidential')),
    exists (
      select 1 from public.attachments attachment
      where attachment.project_id = current_project_id
        and lower(attachment.owner_type) in ('person', 'persons')
        and attachment.owner_id = member.person_id
    ) or (
      jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,birthScans}', '[]'::jsonb))
      + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,marriageScans}', '[]'::jsonb))
      + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,deathScans}', '[]'::jsonb))
      + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,mentionScans}', '[]'::jsonb))
    ) > 0 or exists (
      select 1 from public.person_timeline_events event
      where event.project_id = current_project_id
        and event.person_id = member.person_id
        and (event.source_document_id is not null or event.source_finding_id is not null)
    ) or exists (
      select 1 from public.finding_participants participant
      where participant.project_id = current_project_id
        and participant.person_id = member.person_id
    ) as has_sources
  from public.family_tree_persons member
  join public.persons person
    on person.id = member.person_id and person.project_id = current_project_id
  left join _ft_stats_kinship kinship on kinship.person_id = member.person_id
  left join _ft_stats_direct_ancestors direct_ancestor
    on direct_ancestor.person_id = member.person_id
  cross join lateral (
    select
      case
        when direct_ancestor.generation > 0 then direct_ancestor.generation
        when kinship.kinship_kind = 'descendant' then kinship.down_steps
        else coalesce(kinship.up_steps + kinship.down_steps, 0)
      end::integer as generation,
      case
        when direct_ancestor.generation > 0 and direct_ancestor.order_path like '/0:%' then 'paternal'
        when direct_ancestor.generation > 0 and direct_ancestor.order_path like '/1:%' then 'maternal'
        when kinship.order_path like '/0:%' then 'paternal'
        when kinship.order_path like '/1:%' then 'maternal'
        else 'other'
      end::text as branch,
      case
        when member.person_id = persisted_root_id then 'root'
        when direct_ancestor.generation > 0 then 'ancestor'
        else coalesce(kinship.kinship_kind, 'unconnected')
      end::text as kinship_kind,
      case
        when direct_ancestor.generation > 0 then direct_ancestor.generation
        else coalesce(kinship.up_steps, 0)
      end::integer as up_steps,
      coalesce(kinship.down_steps, 0)::integer as down_steps
  ) classification
  where member.tree_id = requested_tree_id
    and member.member_role <> 'hidden'
    and (requested_scope = 'all'
      or (requested_scope = 'direct-ancestors' and classification.kinship_kind in ('root', 'ancestor'))
      or (requested_scope = 'descendants' and classification.kinship_kind in ('root', 'descendant')))
    and (requested_branch = 'all'
      or requested_branch = classification.branch)
    and (requested_generation_from is null or classification.generation >= requested_generation_from)
    and (requested_generation_to is null or classification.generation <= requested_generation_to)
    and (requested_sex = 'all'
      or (requested_sex = 'male' and lower(person.gender) in ('male', 'm', 'чоловік', 'чоловіча'))
      or (requested_sex = 'female' and lower(person.gender) in ('female', 'f', 'жінка', 'жіноча'))
      or (requested_sex = 'unknown' and lower(coalesce(person.gender, '')) not in ('male', 'm', 'чоловік', 'чоловіча', 'female', 'f', 'жінка', 'жіноча')))
    and (requested_life_status = 'all'
      or security_private.family_tree_statistics_life_status_v1(
        person.is_living,
        person.custom_fields,
        person.death_date,
        person.death_year_from,
        person.death_year_to
      ) = requested_life_status)
    and (requested_relationship_type = ''
      or exists (
        select 1
        from public.parent_child_relationships relation
        where relation.tree_id = requested_tree_id
          and relation.evidence_status <> 'disproven'
          and lower(relation.relationship_type) = requested_relationship_type
          and member.person_id in (relation.parent_id, relation.child_id)
      )
      or exists (
        select 1
        from public.partner_relationships relation
        where relation.tree_id = requested_tree_id
          and relation.evidence_status <> 'disproven'
          and lower(relation.relationship_type) = requested_relationship_type
          and member.person_id in (relation.person_a_id, relation.person_b_id)
      ))
    and (cardinality(requested_evidence) = 0 or person.status = any(requested_evidence))
    and (requested_place = '' or lower(concat_ws(' ', person.birth_place, person.marriage_place, person.death_place, person.residence_places)) like '%' || requested_place || '%'
      or exists (select 1 from public.person_timeline_events event where event.person_id = person.id and lower(coalesce(event.place_name, '')) like '%' || requested_place || '%'))
    and (requested_import_source = '' or person.custom_fields ->> '__gedcomImportSourceKey' = requested_import_source)
    and (requested_source_filter = 'all'
      or requested_source_filter = 'with-sources' and (
        exists (select 1 from public.attachments a where a.project_id = current_project_id and lower(a.owner_type) in ('person', 'persons') and a.owner_id = member.person_id)
        or (
          jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,birthScans}', '[]'::jsonb))
          + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,marriageScans}', '[]'::jsonb))
          + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,deathScans}', '[]'::jsonb))
          + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,mentionScans}', '[]'::jsonb))
        ) > 0
        or exists (select 1 from public.person_timeline_events e where e.person_id = member.person_id and (e.source_document_id is not null or e.source_finding_id is not null))
        or exists (select 1 from public.finding_participants fp where fp.person_id = member.person_id)
      )
      or requested_source_filter = 'without-sources' and not (
        exists (select 1 from public.attachments a where a.project_id = current_project_id and lower(a.owner_type) in ('person', 'persons') and a.owner_id = member.person_id)
        or (
          jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,birthScans}', '[]'::jsonb))
          + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,marriageScans}', '[]'::jsonb))
          + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,deathScans}', '[]'::jsonb))
          + jsonb_array_length(coalesce(person.custom_fields #> '{__trackerRoduPersonScans,mentionScans}', '[]'::jsonb))
        ) > 0
        or exists (select 1 from public.person_timeline_events e where e.person_id = member.person_id and (e.source_document_id is not null or e.source_finding_id is not null))
        or exists (select 1 from public.finding_participants fp where fp.person_id = member.person_id)
      ))
    and (requested_year_from is null or coalesce(
      security_private.family_tree_statistics_year_v1(person.birth_date, person.birth_year_from, person.birth_year_to),
      security_private.family_tree_statistics_year_v1(person.death_date, person.death_year_from, person.death_year_to)
    ) >= requested_year_from)
    and (requested_year_to is null or coalesce(
      security_private.family_tree_statistics_year_v1(person.birth_date, person.birth_year_from, person.birth_year_to),
      security_private.family_tree_statistics_year_v1(person.death_date, person.death_year_from, person.death_year_to)
    ) <= requested_year_to);

  return jsonb_build_object(
    'treeId', requested_tree_id,
    'projectId', current_project_id,
    'title', current_tree_title,
    'rootPersonId', persisted_root_id,
    'rootPersonName', root_name,
    'graphVersion', current_graph_version::text,
    'treeUpdatedAt', current_tree_updated_at,
    'calculatedAt', now(),
    'canViewPrivate', can_view_private,
    'filteredPeople', (select count(*) from _ft_stats_population),
    'scope', requested_scope,
    'branch', requested_branch,
    'relationshipType', nullif(requested_relationship_type, ''),
    'eventTypes', to_jsonb(requested_event_types),
    'surnameMode', requested_surname_mode,
    'methodology', 'Коренева особа береться з активного дерева. Спростовані зв’язки виключено. Життєвий статус береться зі збереженої ознаки GEDCOM та картки особи: DEAT Y означає «померла» навіть без відомої дати смерті. Лише записи без ознаки життя або смерті мають невідомий статус. Приблизні роки позначаються окремо.'
  );
end;
$function$;

create or replace function security_private.family_tree_statistics_profile_scores_v1()
returns table (person_id uuid, score integer)
language plpgsql
volatile
security invoker
set search_path = pg_temp, public
as $function$
begin
  return query
  select person.id,
    round(100.0 * (
      (case when coalesce(
        nullif(trim(person.full_name), ''),
        nullif(trim(concat_ws(' ',
          coalesce(nullif(trim(person.surname), ''), nullif(trim(person.custom_fields ->> '__trackerRoduMaidenSurname'), '')),
          nullif(trim(person.given_name), ''),
          nullif(trim(person.patronymic), '')
        )), '')
      ) is not null then 1 else 0 end) +
      (case when nullif(trim(person.given_name), '') is not null and nullif(trim(person.surname), '') is not null then 1 else 0 end) +
      (case when lower(trim(coalesce(person.gender, ''))) in ('male', 'man', 'm', 'чоловік', 'чоловіча', 'female', 'woman', 'f', 'жінка', 'жіноча') then 1 else 0 end) +
      (case when coalesce(nullif(trim(person.birth_date), ''), nullif(trim(person.birth_year_from), ''), nullif(trim(person.birth_year_to), '')) is not null then 1 else 0 end) +
      (case when nullif(trim(person.birth_place), '') is not null then 1 else 0 end) +
      (case when security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'deceased' and coalesce(nullif(trim(person.death_date), ''), nullif(trim(person.death_year_from), ''), nullif(trim(person.death_year_to), '')) is not null then 1 else 0 end) +
      (case when security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'deceased' and nullif(trim(person.death_place), '') is not null then 1 else 0 end) +
      (case when nullif(trim(regexp_replace(coalesce(person.residence_places, ''), '[;|\n\r]+', '', 'g')), '') is not null then 1 else 0 end) +
      (case when nullif(trim(person.occupation), '') is not null then 1 else 0 end) +
      (case when coalesce(
          nullif(trim(person.birth_date), ''),
          nullif(trim(person.birth_place), ''),
          nullif(trim(person.marriage_date), ''),
          nullif(trim(person.marriage_place), ''),
          nullif(trim(person.death_date), ''),
          nullif(trim(person.death_place), ''),
          nullif(trim(regexp_replace(coalesce(person.residence_places, ''), '[;|\n\r]+', '', 'g')), '')
        ) is not null
        or exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(person.custom_fields -> '__trackerRoduPersonEvents') = 'array'
                then person.custom_fields -> '__trackerRoduPersonEvents'
              else '[]'::jsonb
            end
          ) as event(value)
          where coalesce(
            nullif(trim(event.value ->> 'date'), ''),
            nullif(trim(event.value ->> 'placeName'), ''),
            nullif(trim(event.value ->> 'value'), ''),
            nullif(trim(event.value ->> 'notes'), '')
          ) is not null
        ) then 1 else 0 end) +
      (case when (
        (case when jsonb_typeof(person.custom_fields #> '{__trackerRoduPersonScans,birthScans}') = 'array'
          then jsonb_array_length(person.custom_fields #> '{__trackerRoduPersonScans,birthScans}') else 0 end) +
        (case when jsonb_typeof(person.custom_fields #> '{__trackerRoduPersonScans,marriageScans}') = 'array'
          then jsonb_array_length(person.custom_fields #> '{__trackerRoduPersonScans,marriageScans}') else 0 end) +
        (case when jsonb_typeof(person.custom_fields #> '{__trackerRoduPersonScans,deathScans}') = 'array'
          then jsonb_array_length(person.custom_fields #> '{__trackerRoduPersonScans,deathScans}') else 0 end) +
        (case when jsonb_typeof(person.custom_fields #> '{__trackerRoduPersonScans,mentionScans}') = 'array'
          then jsonb_array_length(person.custom_fields #> '{__trackerRoduPersonScans,mentionScans}') else 0 end)
      ) > 0 then 1 else 0 end) +
      (case when exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(person.custom_fields #> '{__trackerRoduPersonScans,photos}') = 'array'
              then person.custom_fields #> '{__trackerRoduPersonScans,photos}'
            else '[]'::jsonb
          end
        ) as photo(value)
        where coalesce(photo.value ->> 'availability', 'available') <> 'missing-local'
      ) then 1 else 0 end) +
      (case when nullif(trim(person.notes), '') is not null then 1 else 0 end)
    ) / (11.0 + case when security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'deceased' then 2 else 0 end))::integer as score
  from _ft_stats_population population
  join public.persons person on person.id = population.person_id;
end;
$function$;

create or replace function security_private.get_family_tree_statistics_tab_v1(
  p_request jsonb,
  p_tab text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_temp, public
set statement_timeout = '45s'
as $function$
#variable_conflict use_column
declare
  meta jsonb;
  result jsonb;
  current_project_id uuid;
  current_tree_id uuid;
  can_view_private boolean;
  root_person_id uuid;
  requested_event_types text[];
  requested_surname_mode text;
begin
  meta := security_private.prepare_family_tree_statistics_v1(p_request);
  current_project_id := (meta ->> 'projectId')::uuid;
  current_tree_id := (meta ->> 'treeId')::uuid;
  root_person_id := (meta ->> 'rootPersonId')::uuid;
  can_view_private := (meta ->> 'canViewPrivate')::boolean;
  requested_event_types := case
    when jsonb_typeof(p_request -> 'eventTypes') = 'array'
      then array(select lower(trim(value)) from jsonb_array_elements_text(p_request -> 'eventTypes') value where trim(value) <> '')
    else array[]::text[]
  end;
  requested_surname_mode := case when p_request ->> 'surnameMode' in ('birth', 'married')
    then p_request ->> 'surnameMode' else 'displayed' end;

  if p_tab = 'overview' then
    with scores as materialized (
      select * from security_private.family_tree_statistics_profile_scores_v1()
    ), facts as materialized (
      select person.*, population.generation, population.kinship_kind, scores.score,
        case
          when population.private_living then 'hidden'
          else security_private.family_tree_statistics_life_status_v1(
            person.is_living,
            person.custom_fields,
            person.death_date,
            person.death_year_from,
            person.death_year_to
          )
        end as life_group,
        case
          when population.private_living then 'hidden'
          when lower(coalesce(person.gender, '')) in ('male', 'm', 'чоловік', 'чоловіча') then 'male'
          when lower(coalesce(person.gender, '')) in ('female', 'f', 'жінка', 'жіноча') then 'female'
          else 'unknown'
        end as sex_group
      from _ft_stats_population population
      join public.persons person on person.id = population.person_id
      join scores on scores.person_id = person.id
    ), metrics as (
      select jsonb_build_array(
        jsonb_build_object('id','all','label','Усього осіб','value',count(*),'detailKey','all'),
        jsonb_build_object('id','living','label','Живих','value',count(*) filter (where life_group='living'),'detailKey','living'),
        jsonb_build_object('id','deceased','label','Померлих','value',count(*) filter (where life_group='deceased'),'detailKey','deceased'),
        jsonb_build_object('id','unknown-life','label','Статус невідомий','value',count(*) filter (where life_group='unknown'),'detailKey','unknown-life'),
        jsonb_build_object('id','hidden-private','label','Приховано приватністю','value',count(*) filter (where life_group='hidden')),
        jsonb_build_object('id','male','label','Чоловіків','value',count(*) filter (where sex_group='male'),'detailKey','male'),
        jsonb_build_object('id','female','label','Жінок','value',count(*) filter (where sex_group='female'),'detailKey','female'),
        jsonb_build_object('id','parent-links','label','Батьківських зв’язків','value',(select count(*) from public.parent_child_relationships relation where relation.tree_id=current_tree_id and relation.evidence_status<>'disproven' and exists(select 1 from _ft_stats_population population where population.person_id in (relation.parent_id,relation.child_id)))),
        jsonb_build_object('id','partner-links','label','Партнерських зв’язків','value',(select count(*) from public.partner_relationships relation where relation.tree_id=current_tree_id and relation.evidence_status<>'disproven' and exists(select 1 from _ft_stats_population population where population.person_id in (relation.person_a_id,relation.person_b_id)))),
        jsonb_build_object('id','generations','label','Поколінь','value',coalesce(max(generation),0)+1),
        jsonb_build_object('id','ancestors','label','Унікальних прямих предків','value',count(*) filter (where kinship_kind='ancestor'),'detailKey','direct-ancestors'),
        jsonb_build_object('id','ancestor-slots','label','Позицій предків (1–16 покоління)','value',(
          select count(*)
          from _ft_stats_ancestor_occurrences occurrence
          join facts ancestor_fact on ancestor_fact.id=occurrence.person_id
          where occurrence.generation>0
        )),
        jsonb_build_object('id','documents','label','Документів','value',(select count(distinct e.source_document_id) from public.person_timeline_events e join _ft_stats_population p on p.person_id=e.person_id where e.source_document_id is not null)),
        jsonb_build_object('id','findings','label','Знахідок','value',(select count(distinct fp.finding_id) from public.finding_participants fp join _ft_stats_population p on p.person_id=fp.person_id)),
        jsonb_build_object('id','warnings','label','Відкритих попереджень','value',(
          select count(*) from public.family_tree_research_issues issue
          where issue.tree_id=current_tree_id and issue.status='open'
            and (issue.person_id is null or exists(select 1 from _ft_stats_population population where population.person_id=issue.person_id))
        ),'detailKey','open-tree-issues'),
        jsonb_build_object('id','completeness','label','Середня заповненість','value',coalesce(round(avg(score)),0),'suffix','%')
      ) payload from facts
    )
    select jsonb_build_object(
      'meta', meta,
      'metrics', metrics.payload,
      'charts', jsonb_build_array(
        jsonb_build_object('id','gender','title','Склад дерева за статтю','type','donut','rows',(
          select jsonb_agg(jsonb_build_object('label',label,'value',value,'detailKey',detail_key) order by sort)
          from (values
            ('Чоловіки',(select count(*) from facts where sex_group='male'),'male',1),
            ('Жінки',(select count(*) from facts where sex_group='female'),'female',2),
            ('Невідомо',(select count(*) from facts where sex_group='unknown'),'unknown-sex',3)
            ,('Приховано',(select count(*) from facts where sex_group='hidden'),null,4)
          ) v(label,value,detail_key,sort)
        )),
        jsonb_build_object('id','life','title','Життєвий статус','type','donut','rows',(
          select jsonb_agg(jsonb_build_object('label',label,'value',value,'detailKey',detail_key) order by sort)
          from (values
            ('Живі',(select count(*) from facts where life_group='living'),'living',1),
            ('Померлі',(select count(*) from facts where life_group='deceased'),'deceased',2),
            ('Невідомо',(select count(*) from facts where life_group='unknown'),'unknown-life',3)
            ,('Приховано',(select count(*) from facts where life_group='hidden'),null,4)
          ) v(label,value,detail_key,sort)
        )),
        jsonb_build_object('id','generations','title','Особи за поколіннями','type','bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label','Покоління '||generation,'value',amount,'detailKey','generation:'||generation) order by generation),'[]'::jsonb)
          from (select generation,count(*) amount from facts group by generation) grouped
        )),
        jsonb_build_object('id','evidence','title','Стан доказовості','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',status,'value',amount,'detailKey','evidence:'||status) order by amount desc),'[]'::jsonb)
          from (select coalesce(nullif(status,''),'Не вказано') status,count(*) amount from facts group by status) grouped
        )),
        jsonb_build_object('id','completeness','title','Заповненість профілів','type','distribution','rows',(
          select jsonb_agg(jsonb_build_object('label',label,'value',value,'detailKey',detail_key) order by sort)
          from (values
            ('0–24%',(select count(*) from facts where score<25),'completeness:0:24',1),
            ('25–49%',(select count(*) from facts where score between 25 and 49),'completeness:25:49',2),
            ('50–74%',(select count(*) from facts where score between 50 and 74),'completeness:50:74',3),
            ('75–99%',(select count(*) from facts where score between 75 and 99),'completeness:75:99',4),
            ('100%',(select count(*) from facts where score=100),'completeness:100:100',5)
          ) v(label,value,detail_key,sort)
        ))
      ),
      'tables', '[]'::jsonb
    ) into result
    from metrics;

  elsif p_tab = 'ancestry' then
    with filtered_occurrences as materialized (
      select occurrence.*
      from _ft_stats_ancestor_occurrences occurrence
      join _ft_stats_population population on population.person_id=occurrence.person_id
    ), occurrence_counts as materialized (
      select person_id, count(*) amount, min(generation) first_generation
      from filtered_occurrences where generation > 0
      group by person_id
    ), generations as materialized (
      select series.generation,
        power(2::numeric, series.generation)::bigint possible,
        count(occ.person_id)::bigint found
      from generate_series(1,16) series(generation)
      left join filtered_occurrences occ on occ.generation=series.generation
      group by series.generation
    ), repeats as materialized (
      select counts.person_id, counts.amount, counts.first_generation,
        case when population.private_living then 'Приховано'
          else coalesce(nullif(trim(concat_ws(' ',person.surname,person.given_name,person.patronymic)),''),nullif(trim(person.full_name),''),'Особа без імені') end display_name
      from occurrence_counts counts
      join public.persons person on person.id=counts.person_id
      left join _ft_stats_population population on population.person_id=counts.person_id
      where counts.amount>1
    ), gaps as materialized (
      select occ.person_id, occ.generation, 2-count(edge.parent_id) missing,
        case when population.private_living then 'Приховано'
          else coalesce(nullif(trim(concat_ws(' ',person.surname,person.given_name,person.patronymic)),''),nullif(trim(person.full_name),''),'Особа без імені') end display_name
      from filtered_occurrences occ
      join public.persons person on person.id=occ.person_id
      left join _ft_stats_population population on population.person_id=occ.person_id
      left join _ft_stats_parent_edges edge on edge.child_id=occ.person_id and edge.side in (0,1)
      where occ.generation between 0 and 15
      group by occ.person_id,occ.generation,population.private_living,person.surname,person.given_name,person.patronymic,person.full_name
      having count(edge.parent_id)<2
    )
    select jsonb_build_object(
      'meta',meta,
      'metrics',jsonb_build_array(
        jsonb_build_object('id','max-generation','label','Максимальне покоління','value',coalesce((select max(generation) from filtered_occurrences),0)),
        jsonb_build_object('id','unique-ancestors','label','Унікальні прямі предки','value',(select count(*) from _ft_stats_population where kinship_kind='ancestor'),'detailKey','direct-ancestors'),
        jsonb_build_object('id','occupied-slots','label','Позицій предків (1–16 покоління)','value',(select count(*) from filtered_occurrences where generation>0)),
        jsonb_build_object('id','repeated','label','Повторні предки','value',(select count(*) from occurrence_counts where amount>1),'detailKey','repeated-ancestors'),
        jsonb_build_object('id','missing','label','Пропущені позиції','value',(select coalesce(sum(missing),0) from gaps),'detailKey','ancestry-gaps'),
        jsonb_build_object('id','paternal','label','Батьківська гілка','value',(select count(*) from _ft_stats_population where kinship_kind='ancestor' and branch='paternal'),'detailKey','paternal'),
        jsonb_build_object('id','maternal','label','Материнська гілка','value',(select count(*) from _ft_stats_population where kinship_kind='ancestor' and branch='maternal'),'detailKey','maternal'),
        jsonb_build_object('id','repeat-rate','label','Коефіцієнт повторення','value',coalesce(round(100*((select count(*) from filtered_occurrences where generation>0)-(select count(*) from occurrence_counts))::numeric/nullif((select count(*) from filtered_occurrences where generation>0),0),1),0),'suffix','%')
      ),
      'charts',jsonb_build_array(
        jsonb_build_object('id','generation-completeness','title','Заповненість поколінь','type','stacked-progress','rows',(
          select jsonb_agg(jsonb_build_object('label','Покоління '||generation,'value',found,'secondary',possible-found,'total',possible,'percent',round(100*found::numeric/nullif(possible,0),1),'detailKey','generation:'||generation) order by generation) from generations
        )),
        jsonb_build_object('id','branches','title','Батьківська та материнська гілки','type','donut','rows',jsonb_build_array(
          jsonb_build_object('label','Батьківська','value',(select count(*) from _ft_stats_population where kinship_kind='ancestor' and branch='paternal'),'detailKey','paternal'),
          jsonb_build_object('label','Материнська','value',(select count(*) from _ft_stats_population where kinship_kind='ancestor' and branch='maternal'),'detailKey','maternal')
        )),
        jsonb_build_object('id','relationship-types','title','Типи батьківських зв’язків','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',relationship_type,'value',amount,'detailKey','parent-type:'||relationship_type) order by amount desc),'[]'::jsonb)
          from (select relationship_type,count(*) amount from _ft_stats_parent_edges group by relationship_type) x
        )),
        jsonb_build_object('id','relationship-evidence','title','Доказовість зв’язків','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',evidence_status,'value',amount,'detailKey','relationship-evidence:'||evidence_status) order by amount desc),'[]'::jsonb)
          from (select evidence_status,count(*) amount from _ft_stats_parent_edges group by evidence_status) x
        ))
      ),
      'tables',jsonb_build_array(
        jsonb_build_object('id','generation-table','title','Покоління родоводу','columns',jsonb_build_array('Покоління','Можливо','Знайдено','Порожньо','Заповнено'),'rows',(
          select jsonb_agg(jsonb_build_array(generation,possible,found,possible-found,round(100*found::numeric/nullif(possible,0),1)||'%') order by generation) from generations
        )),
        jsonb_build_object('id','repeat-table','title','Найбільш повторювані предки','columns',jsonb_build_array('Особа','Повторів','Перше покоління'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(display_name,amount,first_generation) order by amount desc,display_name),'[]'::jsonb) from (select * from repeats order by amount desc limit 50) x
        )),
        jsonb_build_object('id','gap-table','title','Прогалини родоводу','columns',jsonb_build_array('Особа','Покоління','Відсутніх батьків'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(display_name,generation,missing) order by generation,display_name),'[]'::jsonb) from (select * from gaps order by generation,display_name limit 100) x
        ))
      )
    ) into result;

  elsif p_tab = 'demography' then
    with person_years as materialized (
      select person.id,
        case when population.private_living then 'Приховано' else coalesce(nullif(trim(concat_ws(' ',person.surname,person.given_name,person.patronymic)),''),nullif(trim(person.full_name),''),'Особа без імені') end display_name,
        security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) birth_year,
        security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to) death_year,
        security_private.family_tree_statistics_first_marriage_year_v1(person.id,current_tree_id,person.marriage_date) marriage_year,
        security_private.family_tree_statistics_month_v1(person.birth_date) birth_month,
        security_private.family_tree_statistics_month_v1(person.marriage_date) marriage_month,
        security_private.family_tree_statistics_month_v1(person.death_date) death_month,
        (trim(coalesce(person.birth_date,'')) ~ '^[0-3]?[0-9][./-](0?[1-9]|1[0-2])[./-](1[0-9]{3}|20[0-9]{2})$|^(1[0-9]{3}|20[0-9]{2})[./-](0?[1-9]|1[0-2])[./-][0-3]?[0-9]$') birth_exact,
        (trim(coalesce(person.death_date,'')) ~ '^[0-3]?[0-9][./-](0?[1-9]|1[0-2])[./-](1[0-9]{3}|20[0-9]{2})$|^(1[0-9]{3}|20[0-9]{2})[./-](0?[1-9]|1[0-2])[./-][0-3]?[0-9]$') death_exact
      from _ft_stats_population population join public.persons person on person.id=population.person_id
      where not population.private_living
    ), valid_lifespans as materialized (
      select *,death_year-birth_year age from person_years where death_year-birth_year between 0 and 120
    ), event_years as materialized (
      select event.event_type,security_private.family_tree_statistics_year_v1(event.event_date,event.date_from,event.date_to) event_year
      from public.person_timeline_events event join _ft_stats_population population on population.person_id=event.person_id
    )
    select jsonb_build_object(
      'meta',meta,
      'metrics',jsonb_build_array(
        jsonb_build_object('id','known-births','label','Відомих років народження','value',(select count(*) from person_years where birth_year is not null),'detailKey','known-birth'),
        jsonb_build_object('id','known-deaths','label','Відомих років смерті','value',(select count(*) from person_years where death_year is not null),'detailKey','known-death'),
        jsonb_build_object('id','average-life','label','Середня тривалість життя','value',coalesce((select round(avg(age),1) from valid_lifespans),0),'suffix',' року','sampleSize',(select count(*) from valid_lifespans)),
        jsonb_build_object('id','average-marriage','label','Середній вік першого шлюбу','value',coalesce((select round(avg(marriage_year-birth_year),1) from person_years where marriage_year-birth_year between 12 and 100),0),'suffix',' року','sampleSize',(select count(*) from person_years where marriage_year-birth_year between 12 and 100))
      ),
      'charts',jsonb_build_array(
        jsonb_build_object('id','birth-decades','title','Народження за десятиліттями','type','bar','seriesLabels',jsonb_build_array('Точні дати','Приблизні дати'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',decade||'‑ті','value',amount-approximate,'secondary',approximate,'total',amount,'detailKey','birth-decade:'||decade) order by decade),'[]'::jsonb) from (select (birth_year/10)*10 decade,count(*) amount,count(*) filter(where not birth_exact) approximate from person_years where birth_year is not null group by 1) x
        )),
        jsonb_build_object('id','death-decades','title','Смерті за десятиліттями','type','bar','seriesLabels',jsonb_build_array('Точні дати','Приблизні дати'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',decade||'‑ті','value',amount-approximate,'secondary',approximate,'total',amount,'detailKey','death-decade:'||decade) order by decade),'[]'::jsonb) from (select (death_year/10)*10 decade,count(*) amount,count(*) filter(where not death_exact) approximate from person_years where death_year is not null group by 1) x
        )),
        jsonb_build_object('id','events-years','title','Життєві події за роками','type','line','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',event_year::text,'value',amount,'detailKey','event-year:'||event_year) order by event_year),'[]'::jsonb) from (select event_year,count(*) amount from event_years where event_year is not null group by event_year) x
        )),
        jsonb_build_object('id','lifespan','title','Вік на момент смерті','type','bar','rows',(
          select jsonb_agg(jsonb_build_object('label',label,'value',value,'detailKey',detail_key) order by sort) from (values
            ('0–9',(select count(*) from valid_lifespans where age<10),'lifespan:0:9',1),('10–19',(select count(*) from valid_lifespans where age between 10 and 19),'lifespan:10:19',2),('20–39',(select count(*) from valid_lifespans where age between 20 and 39),'lifespan:20:39',3),('40–59',(select count(*) from valid_lifespans where age between 40 and 59),'lifespan:40:59',4),('60–79',(select count(*) from valid_lifespans where age between 60 and 79),'lifespan:60:79',5),('80–99',(select count(*) from valid_lifespans where age between 80 and 99),'lifespan:80:99',6),('100+',(select count(*) from valid_lifespans where age>=100),'lifespan:100:120',7)
          ) v(label,value,detail_key,sort)
        )),
        jsonb_build_object('id','century-life','title','Середня тривалість життя за століттями','type','bar','seriesLabels',jsonb_build_array('Середній вік','Розмір вибірки'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',century||' ст.','value',average,'secondary',sample) order by century),'[]'::jsonb) from (select ((birth_year-1)/100)+1 century,round(avg(age),1) average,count(*) sample from valid_lifespans group by 1) x
        )),
        jsonb_build_object('id','first-marriage-age','title','Вік вступу в перший шлюб','type','bar','rows',(
          select jsonb_agg(jsonb_build_object('label',label,'value',value,'detailKey',detail_key) order by sort) from (values
            ('12–17',(select count(*) from person_years where marriage_year-birth_year between 12 and 17),'marriage-age:12:17',1),
            ('18–24',(select count(*) from person_years where marriage_year-birth_year between 18 and 24),'marriage-age:18:24',2),
            ('25–34',(select count(*) from person_years where marriage_year-birth_year between 25 and 34),'marriage-age:25:34',3),
            ('35–49',(select count(*) from person_years where marriage_year-birth_year between 35 and 49),'marriage-age:35:49',4),
            ('50+',(select count(*) from person_years where marriage_year-birth_year between 50 and 100),'marriage-age:50:100',5)
          ) v(label,value,detail_key,sort)
        )),
        jsonb_build_object('id','seasonality','title','Сезонність подій','type','multi-bar','seriesLabels',jsonb_build_array('Народження','Шлюби','Смерті'),'rows',(
          select jsonb_agg(jsonb_build_object('label',label,'value',births,'secondary',marriages,'tertiary',deaths) order by month_number)
          from (select month_number,case month_number when 1 then 'Січ' when 2 then 'Лют' when 3 then 'Бер' when 4 then 'Кві' when 5 then 'Тра' when 6 then 'Чер' when 7 then 'Лип' when 8 then 'Сер' when 9 then 'Вер' when 10 then 'Жов' when 11 then 'Лис' else 'Гру' end label,
            (select count(*) from person_years where birth_month=month_number) births,
            (select count(*) from person_years where marriage_month=month_number) marriages,
            (select count(*) from person_years where death_month=month_number) deaths from generate_series(1,12) month_number) x
        ))
      ),
      'tables',jsonb_build_array(
        jsonb_build_object('id','oldest','title','Найстарші відомі особи','columns',jsonb_build_array('Особа','Рік народження','Рік смерті','Вік'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(display_name,birth_year,death_year,age) order by age desc),'[]'::jsonb) from (select * from valid_lifespans order by age desc limit 30) x
        )),
        jsonb_build_object('id','youngest','title','Наймолодші померлі особи','columns',jsonb_build_array('Особа','Рік народження','Рік смерті','Вік'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(display_name,birth_year,death_year,age) order by age),'[]'::jsonb) from (select * from valid_lifespans order by age limit 30) x
        ))
      )
    ) into result;

  elsif p_tab = 'families' then
    with child_counts as materialized (
      select edge.child_id, count(*) parent_count
      from _ft_stats_parent_edges edge
      join _ft_stats_population child on child.person_id=edge.child_id
      group by edge.child_id
    ), parent_children as materialized (
      select edge.parent_id, count(distinct edge.child_id) children
      from _ft_stats_parent_edges edge
      join _ft_stats_population parent on parent.person_id=edge.parent_id
      group by edge.parent_id
    ), family_sizes as materialized (
      select edge.child_id, array_agg(edge.parent_id order by edge.parent_id) parents
      from _ft_stats_parent_edges edge
      join _ft_stats_population child on child.person_id=edge.child_id
      group by edge.child_id
    ), grouped_families as materialized (
      select parents,count(*) children from family_sizes group by parents
    ), partner_edges as materialized (
      select person_a_id person_id,person_b_id partner_id from public.partner_relationships where tree_id=current_tree_id and evidence_status<>'disproven'
      union all
      select person_b_id,person_a_id from public.partner_relationships where tree_id=current_tree_id and evidence_status<>'disproven'
    ), partner_counts as materialized (
      select population.person_id,count(distinct partner_edges.partner_id) partners
      from _ft_stats_population population
      left join partner_edges on partner_edges.person_id=population.person_id
      group by population.person_id
    ), parent_ages as materialized (
      select security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to)
        - security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to) age
      from _ft_stats_parent_edges edge
      join _ft_stats_population population on population.person_id=edge.child_id
      join public.persons parent on parent.id=edge.parent_id
      join public.persons child on child.id=edge.child_id
      where security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to)
        - security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to) between 12 and 80
    ), sibling_counts as materialized (
      select population.person_id,count(distinct sibling.child_id) siblings
      from _ft_stats_population population
      left join _ft_stats_parent_edges own_parent on own_parent.child_id=population.person_id
      left join _ft_stats_parent_edges sibling
        on sibling.parent_id=own_parent.parent_id and sibling.child_id<>population.person_id
      group by population.person_id
    ), association_counts as materialized (
      select association.association_type,count(*) amount
      from public.association_relationships association
      where association.tree_id=current_tree_id
        and association.evidence_status<>'disproven'
        and exists(select 1 from _ft_stats_population population where population.person_id=association.person_a_id)
        and exists(select 1 from _ft_stats_population population where population.person_id=association.person_b_id)
      group by association.association_type
    )
    select jsonb_build_object(
      'meta',meta,
      'metrics',jsonb_build_array(
        jsonb_build_object('id','average-children','label','Середня кількість дітей','value',coalesce((select round(avg(children),1) from grouped_families),0),'sampleSize',(select count(*) from grouped_families)),
        jsonb_build_object('id','largest-family','label','Найбільша родина','value',coalesce((select max(children) from grouped_families),0),'suffix',' дітей'),
        jsonb_build_object('id','average-partners','label','Партнерів на особу','value',coalesce((select round(avg(partners),1) from partner_counts),0),'sampleSize',(select count(*) from partner_counts)),
        jsonb_build_object('id','average-parent-age','label','Середній вік батьків','value',coalesce((select round(avg(age),1) from parent_ages),0),'suffix',' року','sampleSize',(select count(*) from parent_ages)),
        jsonb_build_object('id','complete-parent-sets','label','Повних наборів батьків','value',(select count(*) from child_counts where parent_count>=2),'detailKey','complete-parent-set'),
        jsonb_build_object('id','partial-parent-sets','label','Неповних наборів батьків','value',(select count(*) from child_counts where parent_count=1),'detailKey','partial-parent-set'),
        jsonb_build_object('id','without-parents','label','Без відомих батьків','value',(select count(*) from _ft_stats_population p where not exists(select 1 from _ft_stats_parent_edges e where e.child_id=p.person_id)),'detailKey','without-parents'),
        jsonb_build_object('id','without-partners','label','Без партнерів','value',(select count(*) from _ft_stats_population population where not exists(select 1 from public.partner_relationships relation where relation.tree_id=current_tree_id and relation.evidence_status<>'disproven' and population.person_id in (relation.person_a_id,relation.person_b_id))),'detailKey','without-partners'),
        jsonb_build_object('id','without-children','label','Без дітей','value',(select count(*) from _ft_stats_population population where not exists(select 1 from _ft_stats_parent_edges edge where edge.parent_id=population.person_id)),'detailKey','without-children'),
        jsonb_build_object('id','average-siblings','label','Братів і сестер на особу','value',coalesce((select round(avg(siblings),1) from sibling_counts),0),'sampleSize',(select count(*) from sibling_counts)),
        jsonb_build_object('id','associations','label','Асоціативних зв’язків','value',(select coalesce(sum(amount),0) from association_counts))
      ),
      'charts',jsonb_build_array(
        jsonb_build_object('id','children-distribution','title','Кількість дітей у родинах','type','bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',children||' дітей','value',families,'detailKey','family-size:'||children) order by children),'[]'::jsonb)
          from (select children,count(*) families from grouped_families group by children) x
        )),
        jsonb_build_object('id','partners-distribution','title','Кількість партнерів на одну особу','type','bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',partners::text,'value',people,'detailKey','partners:'||partners) order by partners),'[]'::jsonb)
          from (select partners,count(*) people from partner_counts group by partners) x
        )),
        jsonb_build_object('id','partnership-types','title','Типи партнерств','type','donut','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',coalesce(nullif(relationship_type,''),'Інше'),'value',amount,'detailKey','partner-type:'||coalesce(relationship_type,'')) order by amount desc),'[]'::jsonb)
          from (
            select relationship_type,count(*) amount
            from public.partner_relationships relation
            where relation.tree_id=current_tree_id and relation.evidence_status<>'disproven'
              and exists(select 1 from _ft_stats_population population where population.person_id in (relation.person_a_id,relation.person_b_id))
            group by relationship_type
          ) x
        )),
        jsonb_build_object('id','parent-types','title','Типи батьківських зв’язків','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',relationship_type,'value',amount,'detailKey','parent-type:'||relationship_type) order by amount desc),'[]'::jsonb)
          from (
            select edge.relationship_type,count(*) amount
            from _ft_stats_parent_edges edge
            join _ft_stats_population child on child.person_id=edge.child_id
            group by edge.relationship_type
          ) x
        )),
        jsonb_build_object('id','siblings-distribution','title','Кількість братів і сестер','type','bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',siblings::text,'value',people,'detailKey','siblings:'||siblings) order by siblings),'[]'::jsonb)
          from (select siblings,count(*) people from sibling_counts group by siblings) x
        )),
        jsonb_build_object('id','association-types','title','Не кровні й асоціативні зв’язки','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',association_type,'value',amount,'detailKey','association-type:'||association_type) order by amount desc),'[]'::jsonb)
          from association_counts
        ))
      ),
      'tables',jsonb_build_array(
        jsonb_build_object('id','largest-families','title','Найбільші родини','columns',jsonb_build_array('Батьків у наборі','Дітей'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(cardinality(parents),children) order by children desc),'[]'::jsonb) from (select * from grouped_families order by children desc limit 50) x
        ))
      )
    ) into result;

  elsif p_tab = 'names' then
    with people as materialized (
      select person.* from _ft_stats_population population join public.persons person on person.id=population.person_id
      where not population.private_living
    ), all_names as materialized (
      select person.id person_id,population.branch,
        lower(trim(case
          when requested_surname_mode='birth' then coalesce(nullif(birth_name.surname,''),nullif(person.custom_fields->>'__trackerRoduMaidenSurname',''),nullif(display_name.surname,''),person.surname)
          when requested_surname_mode='married' then coalesce(nullif(married_name.surname,''),nullif(display_name.surname,''),person.surname)
          else coalesce(nullif(display_name.surname,''),person.surname)
        end)) surname,
        lower(trim(coalesce(nullif(display_name.given_name,''),person.given_name))) given_name,
        lower(trim(coalesce(nullif(display_name.patronymic,''),person.patronymic))) patronymic,
        person.gender,
        case
          when requested_surname_mode='birth' and (birth_name.id is not null or nullif(person.custom_fields->>'__trackerRoduMaidenSurname','') is not null) then 'birth'
          when requested_surname_mode='married' and married_name.id is not null then 'married'
          else coalesce(display_name.name_type,'primary')
        end name_type,
        security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) birth_year
      from people person
      join _ft_stats_population population on population.person_id=person.id
      left join lateral (
        select name.* from public.person_names name where name.person_id=person.id
        order by name.is_primary desc,name.is_preferred desc,name.updated_at desc,name.id limit 1
      ) display_name on true
      left join lateral (
        select name.* from public.person_names name where name.person_id=person.id and name.name_type='birth'
        order by name.is_preferred desc,name.updated_at desc,name.id limit 1
      ) birth_name on true
      left join lateral (
        select name.* from public.person_names name where name.person_id=person.id and name.name_type='married'
        order by name.is_preferred desc,name.updated_at desc,name.id limit 1
      ) married_name on true
    ), name_variants as materialized (
      select lower(trim(coalesce(nullif(name.full_name,''),nullif(name.original_text,''),nullif(concat_ws(' ',name.surname,name.given_name,name.patronymic),'')))) variant,
        count(distinct name.person_id) people
      from public.person_names name
      join _ft_stats_population population on population.person_id=name.person_id
      where not population.private_living and not name.is_primary
        and nullif(trim(coalesce(nullif(name.full_name,''),nullif(name.original_text,''),nullif(concat_ws(' ',name.surname,name.given_name,name.patronymic),''))),'') is not null
      group by 1
    )
    select jsonb_build_object(
      'meta',meta,
      'metrics',jsonb_build_array(
        jsonb_build_object('id','unique-surnames','label','Унікальних прізвищ','value',(select count(distinct surname) from all_names where surname<>'')),
        jsonb_build_object('id','unique-given','label','Унікальних імен','value',(select count(distinct given_name) from all_names where given_name<>'')),
        jsonb_build_object('id','variants','label','Варіантів написання','value',(select count(*) from public.person_names n join _ft_stats_population p on p.person_id=n.person_id where not n.is_primary)),
        jsonb_build_object('id','unstructured','label','Без структурованого імені','value',(select count(*) from people where nullif(trim(given_name),'') is null or nullif(trim(surname),'') is null),'detailKey','unstructured-name')
      ),
      'charts',jsonb_build_array(
        jsonb_build_object('id','surnames','title','Найпоширеніші прізвища','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',initcap(surname),'value',amount,'detailKey','surname:'||surname) order by amount desc,surname),'[]'::jsonb) from (select surname,count(distinct person_id) amount from all_names where surname<>'' group by surname order by 2 desc limit 20) x
        )),
        jsonb_build_object('id','male-names','title','Найпоширеніші чоловічі імена','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',initcap(given_name),'value',amount,'detailKey','given-name:male:'||given_name) order by amount desc,given_name),'[]'::jsonb) from (select given_name,count(*) amount from all_names where lower(gender) in ('male','m','чоловік','чоловіча') and given_name<>'' group by given_name order by 2 desc limit 20) x
        )),
        jsonb_build_object('id','female-names','title','Найпоширеніші жіночі імена','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',initcap(given_name),'value',amount,'detailKey','given-name:female:'||given_name) order by amount desc,given_name),'[]'::jsonb) from (select given_name,count(*) amount from all_names where lower(gender) in ('female','f','жінка','жіноча') and given_name<>'' group by given_name order by 2 desc limit 20) x
        )),
        jsonb_build_object('id','patronymics','title','Найпоширеніші по батькові','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',initcap(patronymic),'value',amount,'detailKey','patronymic:'||patronymic) order by amount desc,patronymic),'[]'::jsonb) from (select patronymic,count(*) amount from all_names where patronymic<>'' group by patronymic order by 2 desc limit 20) x
        )),
        jsonb_build_object('id','name-decades','title','Популярність імен за десятиліттями','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',decade||'‑ті · '||initcap(given_name),'value',amount) order by decade,given_name),'[]'::jsonb) from (select (birth_year/10)*10 decade,given_name,count(*) amount from all_names where birth_year is not null and given_name<>'' group by 1,2 order by count(*) desc limit 100) x
        )),
        jsonb_build_object('id','name-variants','title','Варіанти написання імен та прізвищ','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',initcap(variant),'value',people,'detailKey','name-variant:'||variant) order by people desc,variant),'[]'::jsonb)
          from (select * from name_variants order by people desc,variant limit 30) variants
        )),
        jsonb_build_object('id','surname-branches','title','Прізвища за гілками дерева','type','multi-bar','seriesLabels',jsonb_build_array('Батьківська гілка','Материнська гілка'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',initcap(surname),'value',paternal,'secondary',maternal) order by paternal+maternal desc,surname),'[]'::jsonb)
          from (
            select surname,count(*) filter(where branch='paternal') paternal,count(*) filter(where branch='maternal') maternal
            from all_names where surname<>'' group by surname order by count(*) desc limit 30
          ) branches
        ))
      ),
      'tables',jsonb_build_array(
        jsonb_build_object('id','maiden-surnames','title','Дівочі прізвища','columns',jsonb_build_array('Прізвище','Кількість'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(initcap(surname),amount) order by amount desc,surname),'[]'::jsonb) from (select surname,count(*) amount from all_names where name_type in ('birth','maiden') and surname<>'' group by surname order by 2 desc limit 50) x
        )),
        jsonb_build_object('id','variants-table','title','Варіанти написання','columns',jsonb_build_array('Варіант','Осіб'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(initcap(variant),people) order by people desc,variant),'[]'::jsonb) from (select * from name_variants order by people desc,variant limit 100) variants
        ))
      )
    ) into result;

  elsif p_tab = 'geography' then
    with places as materialized (
      select population.person_id,'birth' event_code,'Народження' event_type,nullif(trim(person.birth_place),'') place_name,null::jsonb geo,
        security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) event_year,0 sequence_rank
      from _ft_stats_population population join public.persons person on person.id=population.person_id
      where not population.private_living and (cardinality(requested_event_types)=0 or 'birth'=any(requested_event_types))
      union all select population.person_id,'marriage','Шлюб',nullif(trim(person.marriage_place),''),null::jsonb,security_private.family_tree_statistics_year_v1(person.marriage_date,null,null),1 from _ft_stats_population population join public.persons person on person.id=population.person_id where not population.private_living and (cardinality(requested_event_types)=0 or 'marriage'=any(requested_event_types))
      union all select population.person_id,'death','Смерть',nullif(trim(person.death_place),''),null::jsonb,security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to),3 from _ft_stats_population population join public.persons person on person.id=population.person_id where not population.private_living and (cardinality(requested_event_types)=0 or 'death'=any(requested_event_types))
      union all select population.person_id,'residence','Проживання',nullif(trim(person.residence_places),''),null::jsonb,null::integer,2 from _ft_stats_population population join public.persons person on person.id=population.person_id where not population.private_living and (cardinality(requested_event_types)=0 or 'residence'=any(requested_event_types))
      union all select event.person_id,event.event_type,coalesce(nullif(event.title,''),event.event_type),nullif(trim(event.place_name),''),event.geo,
        security_private.family_tree_statistics_year_v1(event.event_date,event.date_from,event.date_to),2
        from public.person_timeline_events event join _ft_stats_population population on population.person_id=event.person_id
        where not population.private_living and (cardinality(requested_event_types)=0 or event.event_type=any(requested_event_types))
    ), normalized as materialized (
      select person_id,event_code,event_type,place_name,lower(regexp_replace(coalesce(place_name,''),'\s+',' ','g')) normalized_name,geo,event_year,sequence_rank,
        security_private.family_tree_statistics_coordinate_v1(geo,'latitude') latitude,
        security_private.family_tree_statistics_coordinate_v1(geo,'longitude') longitude
      from places where place_name is not null
    ), grouped as materialized (
      select normalized_name,min(place_name) place_name,count(*) events,count(distinct person_id) people,
        min(latitude) latitude,min(longitude) longitude
      from normalized group by normalized_name
    ), ordered_places as materialized (
      select person_id,place_name,latitude,longitude,event_year,
        lag(place_name) over person_path previous_place,
        lag(latitude) over person_path previous_latitude,
        lag(longitude) over person_path previous_longitude
      from normalized where latitude is not null and longitude is not null
      window person_path as (partition by person_id order by event_year nulls last,sequence_rank,normalized_name)
    ), movement_paths as materialized (
      select person_id,previous_place from_label,place_name to_label,
        previous_latitude from_latitude,previous_longitude from_longitude,
        latitude to_latitude,longitude to_longitude
      from ordered_places
      where previous_latitude is not null and previous_longitude is not null
        and (previous_latitude,previous_longitude) is distinct from (latitude,longitude)
    )
    select jsonb_build_object(
      'meta',meta,
      'metrics',jsonb_build_array(
        jsonb_build_object('id','unique-places','label','Унікальних місць','value',(select count(*) from grouped)),
        jsonb_build_object('id','placed-events','label','Подій із місцем','value',(select count(*) from normalized)),
        jsonb_build_object('id','missing-places','label','Осіб без місця','value',(select count(*) from _ft_stats_population population join public.persons person on person.id=population.person_id where not population.private_living and nullif(trim(concat_ws('',person.birth_place,person.marriage_place,person.death_place,person.residence_places)),'') is null),'detailKey','without-place'),
        jsonb_build_object('id','without-coordinates','label','Місць без координат','value',(select count(*) from grouped where latitude is null or longitude is null),'detailKey','without-coordinates')
      ),
      'charts',jsonb_build_array(
        jsonb_build_object('id','places','title','Найпоширеніші місця','type','horizontal-bar','seriesLabels',jsonb_build_array('Події','Особи'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',place_name,'value',events,'secondary',people,'detailKey','place:'||normalized_name) order by events desc,place_name),'[]'::jsonb) from (select * from grouped order by events desc limit 30) x
        )),
        jsonb_build_object('id','event-types','title','Події за типом місця','type','donut','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',event_type,'value',amount,'detailKey','event-type:'||event_code) order by amount desc),'[]'::jsonb) from (select event_code,event_type,count(*) amount from normalized group by event_code,event_type) x
        ))
      ),
      'map',jsonb_build_object('markers',(
        select coalesce(jsonb_agg(jsonb_build_object('label',place_name,'latitude',latitude,'longitude',longitude,'value',events,'people',people,'detailKey','place:'||normalized_name) order by events desc),'[]'::jsonb)
        from grouped where latitude is not null and longitude is not null
      ),'paths',(
        select coalesce(jsonb_agg(jsonb_build_object('personId',person_id,'fromLabel',from_label,'toLabel',to_label,'fromLatitude',from_latitude,'fromLongitude',from_longitude,'toLatitude',to_latitude,'toLongitude',to_longitude)),'[]'::jsonb)
        from (select * from movement_paths limit 500) paths
      )),
      'tables',jsonb_build_array(
        jsonb_build_object('id','places-table','title','Місця подій','columns',jsonb_build_array('Місце','Подій','Осіб','Координати'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(place_name,events,people,case when latitude is null or longitude is null then 'Немає' else latitude||', '||longitude end) order by events desc,place_name),'[]'::jsonb) from grouped
        ))
      )
    ) into result;

  elsif p_tab = 'research' then
    with event_evidence as materialized (
      select event.* from public.person_timeline_events event join _ft_stats_population population on population.person_id=event.person_id
      where not population.private_living
    ), finding_people as materialized (
      select distinct participant.person_id,participant.finding_id
      from public.finding_participants participant
      join _ft_stats_population population on population.person_id=participant.person_id
      where participant.person_id is not null and not population.private_living
    ), linked_findings as materialized (
      select distinct finding.*
      from public.findings finding join finding_people participant on participant.finding_id=finding.id
    ), document_people as materialized (
      select distinct event.person_id,event.source_document_id document_id
      from event_evidence event where event.source_document_id is not null
      union
      select distinct participant.person_id,finding.document_id
      from finding_people participant join public.findings finding on finding.id=participant.finding_id
      where finding.document_id is not null
    ), document_usage as materialized (
      select source.document_id,count(*) uses,count(distinct source.person_id) people
      from (
        select event.person_id,event.source_document_id document_id from event_evidence event where event.source_document_id is not null
        union all
        select participant.person_id,finding.document_id from finding_people participant join public.findings finding on finding.id=participant.finding_id where finding.document_id is not null
      ) source group by source.document_id
    ), person_evidence as materialized (
      select population.person_id,population.has_sources,population.generation,
        count(distinct document_people.document_id) documents,
        count(distinct finding_people.finding_id) findings
      from _ft_stats_population population
      left join document_people on document_people.person_id=population.person_id
      left join finding_people on finding_people.person_id=population.person_id
      where not population.private_living
      group by population.person_id,population.has_sources,population.generation
    )
    select jsonb_build_object(
      'meta',meta,
      'metrics',jsonb_build_array(
        jsonb_build_object('id','with-sources','label','Осіб із джерелами','value',(select count(*) from person_evidence where has_sources),'detailKey','with-sources'),
        jsonb_build_object('id','without-sources','label','Осіб без джерел','value',(select count(*) from person_evidence where not has_sources),'detailKey','without-sources'),
        jsonb_build_object('id','average-sources','label','Джерел на особу','value',coalesce((select round(avg(documents+findings),1) from person_evidence),0)),
        jsonb_build_object('id','confirmed-findings','label','Підтверджених знахідок','value',(select count(*) from linked_findings where not needs_review),'detailKey','finding-review:confirmed'),
        jsonb_build_object('id','unreviewed-findings','label','Неперевірених знахідок','value',(select count(*) from linked_findings where needs_review),'detailKey','finding-review:review'),
        jsonb_build_object('id','events-without-source','label','Подій без джерел','value',(select count(*) from event_evidence where source_document_id is null and source_finding_id is null),'detailKey','events-without-source'),
        jsonb_build_object('id','links-without-source','label','Зв’язків без джерел','value',(select count(*) from public.parent_child_relationships relation where relation.tree_id=current_tree_id and relation.evidence_status<>'disproven' and relation.source_document_id is null and relation.source_finding_id is null and exists(select 1 from _ft_stats_population population where population.person_id in (relation.parent_id,relation.child_id))),'detailKey','links-without-source'),
        jsonb_build_object('id','open-problems','label','Відкритих дослідницьких проблем','value',(
          (select count(distinct h.id) from public.hypotheses h join public.hypothesis_links l on l.hypothesis_id=h.id join _ft_stats_population p on p.person_id=l.target_id where l.target_type='person' and lower(coalesce(h.status,'')) not in ('completed','closed','спростована'))
          +(select count(*) from public.family_tree_research_issues issue where issue.tree_id=current_tree_id and issue.status='open' and (issue.person_id is null or exists(select 1 from _ft_stats_population population where population.person_id=issue.person_id)))
        ))
      ),
      'charts',jsonb_build_array(
        jsonb_build_object('id','evidence-generations','title','Особи з доказами за поколіннями','type','stacked-progress','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label','Покоління '||generation,'value',with_sources,'secondary',total-with_sources,'total',total,'percent',round(100*with_sources::numeric/nullif(total,0),1)) order by generation),'[]'::jsonb)
          from (select generation,count(*) total,count(*) filter(where has_sources) with_sources from person_evidence group by generation) x
        )),
        jsonb_build_object('id','document-generations','title','Використання документів за поколіннями','type','multi-bar','seriesLabels',jsonb_build_array('Документи','Особи'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label','Покоління '||generation,'value',documents,'secondary',people) order by generation),'[]'::jsonb)
          from (select generation,sum(documents) documents,count(*) filter(where documents>0) people from person_evidence group by generation) x
        )),
        jsonb_build_object('id','evidence-statuses','title','Статуси доказовості','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',status,'value',amount,'detailKey','evidence:'||status) order by amount desc),'[]'::jsonb)
          from (select coalesce(nullif(person.status,''),'Не вказано') status,count(*) amount from _ft_stats_population population join public.persons person on person.id=population.person_id where not population.private_living group by 1) x
        )),
        jsonb_build_object('id','document-types','title','Документи за типами','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',document_type,'value',amount) order by amount desc),'[]'::jsonb) from (select coalesce(nullif(document.document_type,''),'Не вказано') document_type,count(distinct document.id) amount from public.documents document join document_people link on link.document_id=document.id group by 1) x
        )),
        jsonb_build_object('id','finding-types','title','Знахідки за типами','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',finding_type,'value',amount) order by amount desc),'[]'::jsonb) from (select coalesce(nullif(finding.finding_type,''),'Не вказано') finding_type,count(distinct finding.id) amount from linked_findings finding group by 1) x
        )),
        jsonb_build_object('id','archives','title','Джерела за архівами та установами','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',archive,'value',amount) order by amount desc),'[]'::jsonb) from (select coalesce(nullif(document.archive,''),'Не вказано') archive,count(distinct document.id) amount from public.documents document join document_people link on link.document_id=document.id group by 1 order by 2 desc limit 30) x
        )),
        jsonb_build_object('id','finding-review','title','Стан перевірки знахідок','type','donut','rows',jsonb_build_array(
          jsonb_build_object('label','Підтверджені','value',(select count(*) from linked_findings where not needs_review),'detailKey','finding-review:confirmed'),
          jsonb_build_object('label','Потребують перевірки','value',(select count(*) from linked_findings where needs_review),'detailKey','finding-review:review')
        )),
        jsonb_build_object('id','findings-years','title','Знахідки за роками створення','type','line','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',created_year::text,'value',amount,'detailKey','finding-year:'||created_year) order by created_year),'[]'::jsonb)
          from (select extract(year from created_at)::integer created_year,count(*) amount from linked_findings group by 1) years
        )),
        jsonb_build_object('id','materials-per-person','title','Документи й знахідки на одну особу','type','bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',bucket_label,'value',people,'detailKey','materials:'||minimum||':'||maximum) order by minimum),'[]'::jsonb)
          from (
            select bucket.minimum,bucket.maximum,bucket.bucket_label,count(*) people
            from (values (0,0,'0'),(1,1,'1'),(2,3,'2–3'),(4,7,'4–7'),(8,2147483647,'8+')) bucket(minimum,maximum,bucket_label)
            join person_evidence person on person.documents+person.findings between bucket.minimum and bucket.maximum
            group by bucket.minimum,bucket.maximum,bucket.bucket_label
          ) buckets
        ))
      ),
      'tables',jsonb_build_array(
        jsonb_build_object('id','frequent-documents','title','Найчастіше використані документи','columns',jsonb_build_array('Документ','Використань','Осіб','Тип','Архів / установа'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(document.title,usage.uses,usage.people,coalesce(nullif(document.document_type,''),'Не вказано'),coalesce(nullif(document.archive,''),'Не вказано')) order by usage.uses desc,document.title),'[]'::jsonb)
          from (select * from document_usage order by uses desc limit 100) usage join public.documents document on document.id=usage.document_id
        ))
      )
    ) into result;

  elsif p_tab = 'quality' then
    with scores as materialized (select * from security_private.family_tree_statistics_profile_scores_v1()),
    facts as materialized (
      select person.*,population.has_sources,population.private_living,population.generation,scores.score,
        security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) life_group,
        security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) birth_year,
        security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to) death_year
      from _ft_stats_population population join public.persons person on person.id=population.person_id join scores on scores.person_id=person.id
      where not population.private_living
    ), issue_rows as materialized (
      select 'Без структурованого імені' label,count(*) value,'unstructured-name' detail_key from facts where nullif(trim(given_name),'') is null or nullif(trim(surname),'') is null
      union all select 'Невідома стать',count(*),'unknown-sex' from facts where lower(coalesce(gender,'')) not in ('male','m','чоловік','чоловіча','female','f','жінка','жіноча')
      union all select 'Немає дати народження',count(*),'without-birth-date' from facts where birth_year is null
      union all select 'Немає місця народження',count(*),'without-birth-place' from facts where nullif(trim(birth_place),'') is null
      union all select 'Немає даних про смерть',count(*),'without-death-data' from facts where life_group='deceased' and death_year is null
      union all select 'Немає батьків',count(*),'without-parents' from facts where not exists(select 1 from _ft_stats_parent_edges e where e.child_id=facts.id)
      union all select 'Немає джерел',count(*),'without-sources' from facts where not has_sources
      union all select 'Немає фото',count(*),'without-photo' from facts
        where not exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(facts.custom_fields #> '{__trackerRoduPersonScans,photos}') = 'array'
                then facts.custom_fields #> '{__trackerRoduPersonScans,photos}'
              else '[]'::jsonb
            end
          ) photo(value)
          where coalesce(photo.value ->> 'availability', 'available') <> 'missing-local'
        )
      union all select 'Подія без дати',count(*),'event-without-date' from public.person_timeline_events e join _ft_stats_population p on p.person_id=e.person_id where not p.private_living and coalesce(nullif(trim(e.event_date),''),nullif(trim(e.date_from),''),nullif(trim(e.date_to),'')) is null
      union all select 'Подія без місця',count(*),'event-without-place' from public.person_timeline_events e join _ft_stats_population p on p.person_id=e.person_id where not p.private_living and nullif(trim(e.place_name),'') is null
      union all select 'Зв’язок без доказу',count(*),'links-without-evidence' from public.parent_child_relationships relation where relation.tree_id=current_tree_id and relation.evidence_status in ('unknown','unverified','') and exists(select 1 from _ft_stats_population population where population.person_id in (relation.parent_id,relation.child_id))
      union all select 'Смерть раніше народження',count(*),'death-before-birth' from facts where birth_year is not null and death_year is not null and death_year<birth_year
      union all select 'Дитина народилась раніше за батька або матір',count(*),'child-before-parent-birth' from _ft_stats_parent_edges e join facts parent on parent.id=e.parent_id join facts child on child.id=e.child_id where parent.birth_year is not null and child.birth_year is not null and child.birth_year<parent.birth_year
      union all select 'Неприродний вік батьків',count(*),'implausible-parent-age' from _ft_stats_parent_edges e join facts parent on parent.id=e.parent_id join facts child on child.id=e.child_id where parent.birth_year is not null and child.birth_year is not null and child.birth_year-parent.birth_year not between 0 and 80
      union all select 'Можливі дублікати',count(*),'possible-duplicates' from public.family_tree_research_issues issue where issue.tree_id=current_tree_id and issue.status='open' and lower(issue.issue_type) like '%duplicate%' and (issue.person_id is null or exists(select 1 from _ft_stats_population population where population.person_id=issue.person_id))
      union all select 'Відкриті проблеми дерева',count(*),'open-tree-issues' from public.family_tree_research_issues issue where issue.tree_id=current_tree_id and issue.status='open' and (issue.person_id is null or exists(select 1 from _ft_stats_population population where population.person_id=issue.person_id))
    )
    select jsonb_build_object(
      'meta',meta,
      'metrics',jsonb_build_array(
        jsonb_build_object('id','average-completeness','label','Середня заповненість','value',coalesce((select round(avg(score)) from facts),0),'suffix','%'),
        jsonb_build_object('id','complete-profiles','label','Повних профілів','value',(select count(*) from facts where score=100),'detailKey','completeness:100:100'),
        jsonb_build_object('id','critical-profiles','label','Критичних профілів','value',(select count(*) from facts where score<50),'detailKey','critical-profile'),
        jsonb_build_object('id','contradictions','label','Суперечностей','value',(select coalesce(sum(value),0) from issue_rows where detail_key in ('death-before-birth','child-before-parent-birth','implausible-parent-age')),'detailKey','all-contradictions'),
        jsonb_build_object('id','open-warnings','label','Відкритих попереджень','value',(
          (select coalesce(sum(value),0) from issue_rows where detail_key not in ('open-tree-issues','possible-duplicates'))
          +(select count(*) from public.family_tree_research_issues issue where issue.tree_id=current_tree_id and issue.status='open' and (issue.person_id is null or exists(select 1 from _ft_stats_population population where population.person_id=issue.person_id)))
        ),'detailKey','all-quality-issues')
      ),
      'charts',jsonb_build_array(
        jsonb_build_object('id','score-distribution','title','Заповненість профілів','type','distribution','rows',(
          select jsonb_agg(jsonb_build_object('label',label,'value',value,'detailKey',detail_key) order by sort) from (values
            ('0–24%',(select count(*) from facts where score<25),'completeness:0:24',1),('25–49%',(select count(*) from facts where score between 25 and 49),'completeness:25:49',2),('50–74%',(select count(*) from facts where score between 50 and 74),'completeness:50:74',3),('75–99%',(select count(*) from facts where score between 75 and 99),'completeness:75:99',4),('100%',(select count(*) from facts where score=100),'completeness:100:100',5)
          ) x(label,value,detail_key,sort)
        )),
        jsonb_build_object('id','issues','title','Категорії проблем','type','horizontal-bar','rows',(
          select coalesce(jsonb_agg(jsonb_build_object('label',label,'value',value,'detailKey',detail_key) order by value desc,label),'[]'::jsonb) from issue_rows where value>0
        ))
      ),
      'tables',jsonb_build_array(
        jsonb_build_object('id','issues-table','title','Проблеми для виправлення','columns',jsonb_build_array('Проблема','Кількість'),'rows',(
          select coalesce(jsonb_agg(jsonb_build_array(label,value) order by value desc,label),'[]'::jsonb) from issue_rows where value>0
        ))
      )
    ) into result;

  else
    raise exception 'UNKNOWN_FAMILY_TREE_STATISTICS_TAB' using errcode='22023';
  end if;

  return result;
end;
$function$;

create table if not exists security_private.family_tree_statistics_cache (
  tree_id uuid not null,
  project_id uuid not null,
  graph_version bigint not null,
  root_person_id uuid not null,
  access_scope text not null check (access_scope in ('full', 'viewer')),
  tab text not null,
  filter_key text not null,
  payload jsonb not null,
  calculated_at timestamptz not null default now(),
  primary key (tree_id, graph_version, access_scope, tab, filter_key)
);

create index if not exists family_tree_statistics_cache_cleanup_idx
  on security_private.family_tree_statistics_cache(tree_id, tab, access_scope, calculated_at desc);

create or replace function security_private.family_tree_statistics_prune_cache_v1()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,security_private
as $function$
begin
  delete from security_private.family_tree_statistics_cache cache
  where cache.tree_id=new.id
    and cache.graph_version<>new.graph_version;
  return new;
end;
$function$;

drop trigger if exists family_tree_statistics_prune_cache_trigger on public.family_trees;
create trigger family_tree_statistics_prune_cache_trigger
after update of graph_version on public.family_trees
for each row
when (old.graph_version is distinct from new.graph_version)
execute function security_private.family_tree_statistics_prune_cache_v1();

create or replace function security_private.get_cached_family_tree_statistics_tab_v1(
  p_request jsonb,
  p_tab text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=pg_catalog,public,security_private
set statement_timeout='45s'
as $function$
declare
  requested_tree_id uuid;
  current_project_id uuid;
  current_root_person_id uuid;
  current_graph_version bigint;
  member_role text;
  current_access_scope text;
  current_filter_key text;
  cached_payload jsonb;
  result jsonb;
begin
  perform public.assert_family_tree_feature_access();
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode='42501';
  end if;
  if p_tab not in ('overview','ancestry','demography','families','names','geography','research','quality')
     or p_request is null
     or jsonb_typeof(p_request)<>'object'
     or not pg_input_is_valid(coalesce(p_request->>'treeId',''),'uuid') then
    raise exception 'INVALID_FAMILY_TREE_STATISTICS_REQUEST' using errcode='22023';
  end if;
  requested_tree_id := (p_request->>'treeId')::uuid;
  select tree.project_id,tree.root_person_id,tree.graph_version
    into current_project_id,current_root_person_id,current_graph_version
  from public.family_trees tree where tree.id=requested_tree_id;
  if current_project_id is null or current_root_person_id is null
     or not public.is_project_member(current_project_id) then
    raise exception 'TREE_NOT_FOUND_OR_FORBIDDEN' using errcode='42501';
  end if;
  if nullif(trim(coalesce(p_request->>'rootPersonId','')),'') is not null
     and p_request->>'rootPersonId'<>current_root_person_id::text then
    raise exception 'TREE_ROOT_CHANGED' using errcode='40001';
  end if;
  select member.role::text into member_role
  from public.project_members member
  where member.project_id=current_project_id and member.user_id=auth.uid();
  current_access_scope := case when member_role in ('owner','editor') then 'full' else 'viewer' end;
  current_filter_key := md5(((p_request - 'bypassCache' - 'offset' - 'limit' - 'detailKey') ||
    jsonb_build_object(
      'rootPersonId',current_root_person_id::text,
      'statisticsVersion',2
    ))::text);

  if coalesce((p_request->>'bypassCache')::boolean,false) is not true then
    select cache.payload into cached_payload
    from security_private.family_tree_statistics_cache cache
    where cache.tree_id=requested_tree_id
      and cache.graph_version=current_graph_version
      and cache.access_scope=current_access_scope
      and cache.tab=p_tab
      and cache.filter_key=current_filter_key;
    if cached_payload is not null then return cached_payload; end if;
  end if;

  result := security_private.get_family_tree_statistics_tab_v1(p_request,p_tab);
  insert into security_private.family_tree_statistics_cache(
    tree_id,project_id,graph_version,root_person_id,access_scope,tab,filter_key,payload,calculated_at
  ) values (
    requested_tree_id,current_project_id,current_graph_version,current_root_person_id,
    current_access_scope,p_tab,current_filter_key,result,now()
  ) on conflict (tree_id,graph_version,access_scope,tab,filter_key)
    do update set payload=excluded.payload,calculated_at=excluded.calculated_at;

  -- Bound the cache: keep the 48 most recently used filter variants for each
  -- tab and access scope, while a graph-version change removes the old set.
  delete from security_private.family_tree_statistics_cache stale
  where stale.tree_id=requested_tree_id
    and stale.graph_version=current_graph_version
    and stale.access_scope=current_access_scope
    and stale.tab=p_tab
    and stale.filter_key not in (
      select recent.filter_key
      from security_private.family_tree_statistics_cache recent
      where recent.tree_id=requested_tree_id
        and recent.graph_version=current_graph_version
        and recent.access_scope=current_access_scope
        and recent.tab=p_tab
      order by recent.calculated_at desc
      limit 48
    );
  return result;
end;
$function$;

-- Public tab endpoints keep stable names while sharing one audited population
-- builder and one set of filtering/privacy rules.
create or replace function public.get_family_tree_statistics_overview_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'overview') $$;
create or replace function public.get_family_tree_statistics_ancestry_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'ancestry') $$;
create or replace function public.get_family_tree_statistics_demography_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'demography') $$;
create or replace function public.get_family_tree_statistics_families_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'families') $$;
create or replace function public.get_family_tree_statistics_names_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'names') $$;
create or replace function public.get_family_tree_statistics_geography_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'geography') $$;
create or replace function public.get_family_tree_statistics_research_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'research') $$;
create or replace function public.get_family_tree_statistics_quality_v1(p_request jsonb)
returns jsonb language sql volatile security invoker set search_path=pg_catalog
as $$ select security_private.get_cached_family_tree_statistics_tab_v1($1,'quality') $$;

create or replace function public.list_family_tree_statistics_people_v1(
  p_request jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=pg_temp,public
set statement_timeout='45s'
as $function$
#variable_conflict use_column
declare
  meta jsonb;
  detail_key text := trim(coalesce(p_request->>'detailKey','all'));
  requested_offset integer := greatest(coalesce(nullif(p_request->>'offset','')::integer,0),0);
  requested_limit integer := least(greatest(coalesce(nullif(p_request->>'limit','')::integer,50),1),100);
  score_from integer;
  score_to integer;
  can_view_private boolean;
  requested_surname_mode text;
  rows_payload jsonb;
  total_count integer;
begin
  meta := security_private.prepare_family_tree_statistics_v1(p_request);
  can_view_private := (meta->>'canViewPrivate')::boolean;
  requested_surname_mode := coalesce(meta->>'surnameMode','displayed');
  if detail_key like 'completeness:%' then
    score_from := split_part(detail_key,':',2)::integer;
    score_to := split_part(detail_key,':',3)::integer;
  end if;
  drop table if exists pg_temp._ft_stats_detail_matches;
  create temporary table _ft_stats_detail_matches (
    id uuid primary key,
    display_name text not null,
    birth_date text,
    death_date text,
    generation integer not null,
    branch text not null,
    kinship_kind text not null,
    score integer not null,
    status text,
    has_sources boolean not null
  ) on commit drop;
  with scores as materialized (
    select * from security_private.family_tree_statistics_profile_scores_v1()
  )
  insert into _ft_stats_detail_matches (
    id,display_name,birth_date,death_date,generation,branch,kinship_kind,score,status,has_sources
  )
    select person.id,
      case when population.private_living and not can_view_private then 'Приховано'
        else coalesce(nullif(trim(concat_ws(' ',person.surname,person.given_name,person.patronymic)),''),nullif(trim(person.full_name),''),'Особа без імені') end display_name,
      case when population.private_living and not can_view_private then null else person.birth_date end birth_date,
      case when population.private_living and not can_view_private then null else person.death_date end death_date,
      population.generation,population.branch,population.kinship_kind,scores.score,
      person.status,population.has_sources
    from _ft_stats_population population
    join public.persons person on person.id=population.person_id
    join scores on scores.person_id=person.id
    where (can_view_private or not population.private_living)
      and case
      when detail_key='all' then true
      when detail_key='all-quality-issues' then
        scores.score<100
        or nullif(trim(person.given_name),'') is null
        or nullif(trim(person.surname),'') is null
        or lower(coalesce(person.gender,'')) not in ('male','m','чоловік','чоловіча','female','f','жінка','жіноча')
        or security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) is null
        or nullif(trim(person.birth_place),'') is null
        or (security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'deceased' and security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to) is null)
        or not population.has_sources
        or not exists(select 1 from _ft_stats_parent_edges edge where edge.child_id=person.id)
        or not exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(person.custom_fields #> '{__trackerRoduPersonScans,photos}') = 'array'
                then person.custom_fields #> '{__trackerRoduPersonScans,photos}'
              else '[]'::jsonb
            end
          ) photo(value)
          where coalesce(photo.value ->> 'availability', 'available') <> 'missing-local'
        )
        or exists(select 1 from public.person_timeline_events event where event.person_id=person.id and (coalesce(nullif(trim(event.event_date),''),nullif(trim(event.date_from),''),nullif(trim(event.date_to),'')) is null or nullif(trim(event.place_name),'') is null))
        or exists(select 1 from public.family_tree_research_issues issue where issue.tree_id=(meta->>'treeId')::uuid and issue.status='open' and issue.person_id=person.id)
      when detail_key='all-contradictions' then
        (
          security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) is not null
          and security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to) is not null
          and security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to)<security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to)
        ) or exists(
          select 1 from _ft_stats_parent_edges edge
          join public.persons parent on parent.id=edge.parent_id
          join public.persons child on child.id=edge.child_id
          where person.id in (parent.id,child.id)
            and security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to) is not null
            and security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to) is not null
            and security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to)-security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to) not between 0 and 80
        )
      when detail_key='living' then security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'living'
      when detail_key='deceased' then security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'deceased'
      when detail_key='known-death' then security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to) is not null
      when detail_key='unknown-life' then security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'unknown'
      when detail_key='male' then lower(person.gender) in ('male','m','чоловік','чоловіча')
      when detail_key='female' then lower(person.gender) in ('female','f','жінка','жіноча')
      when detail_key='unknown-sex' then lower(coalesce(person.gender,'')) not in ('male','m','чоловік','чоловіча','female','f','жінка','жіноча')
      when detail_key='direct-ancestors' then population.kinship_kind='ancestor'
      when detail_key='paternal' then population.branch='paternal'
      when detail_key='maternal' then population.branch='maternal'
      when detail_key='repeated-ancestors' then exists(select 1 from _ft_stats_ancestor_occurrences occurrence where occurrence.person_id=person.id group by occurrence.person_id having count(*)>1)
      when detail_key='ancestry-gaps' then exists(select 1 from _ft_stats_ancestor_occurrences occurrence where occurrence.person_id=person.id) and (select count(*) from _ft_stats_parent_edges edge where edge.child_id=person.id and edge.side in (0,1))<2
      when detail_key='known-birth' then security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) is not null
      when detail_key='complete-parent-set' then (select count(*) from _ft_stats_parent_edges edge where edge.child_id=person.id)>=2
      when detail_key='partial-parent-set' then (select count(*) from _ft_stats_parent_edges edge where edge.child_id=person.id)=1
      when detail_key='with-sources' then population.has_sources
      when detail_key='without-sources' then not population.has_sources
      when detail_key in ('events-without-source','event-without-date','event-without-place') then exists(
        select 1 from public.person_timeline_events event
        where event.person_id=person.id
          and case
            when detail_key='events-without-source' then event.source_document_id is null and event.source_finding_id is null
            when detail_key='event-without-date' then coalesce(nullif(trim(event.event_date),''),nullif(trim(event.date_from),''),nullif(trim(event.date_to),'')) is null
            else nullif(trim(event.place_name),'') is null
          end
      )
      when detail_key in ('links-without-source','links-without-evidence') then exists(
        select 1 from public.parent_child_relationships relation
        where relation.tree_id=(meta->>'treeId')::uuid
          and person.id in (relation.parent_id,relation.child_id)
          and relation.evidence_status<>'disproven'
          and case
            when detail_key='links-without-source' then relation.source_document_id is null and relation.source_finding_id is null
            else relation.evidence_status in ('unknown','unverified','')
          end
      )
      when detail_key in ('critical-profile') then scores.score<50
      when detail_key='unstructured-name' then nullif(trim(person.given_name),'') is null or nullif(trim(person.surname),'') is null
      when detail_key='without-birth-date' then security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) is null
      when detail_key='without-birth-place' then nullif(trim(person.birth_place),'') is null
      when detail_key='without-death-data' then security_private.family_tree_statistics_life_status_v1(person.is_living,person.custom_fields,person.death_date,person.death_year_from,person.death_year_to) = 'deceased' and security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to) is null
      when detail_key='without-place' then nullif(trim(concat_ws('',person.birth_place,person.marriage_place,person.death_place,person.residence_places)),'') is null
      when detail_key='without-parents' then not exists(select 1 from _ft_stats_parent_edges e where e.child_id=person.id)
      when detail_key='without-partners' then not exists(
        select 1 from public.partner_relationships relation
        where relation.tree_id=(meta->>'treeId')::uuid and relation.evidence_status<>'disproven'
          and person.id in (relation.person_a_id,relation.person_b_id)
      )
      when detail_key='without-children' then not exists(select 1 from _ft_stats_parent_edges edge where edge.parent_id=person.id)
      when detail_key='without-photo' then not exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(person.custom_fields #> '{__trackerRoduPersonScans,photos}') = 'array'
              then person.custom_fields #> '{__trackerRoduPersonScans,photos}'
            else '[]'::jsonb
          end
        ) photo(value)
        where coalesce(photo.value ->> 'availability', 'available') <> 'missing-local'
      )
      when detail_key='without-coordinates' then exists (
        select 1
        from public.person_timeline_events event
        where event.person_id=person.id
          and nullif(trim(event.place_name),'') is not null
          and (
            security_private.family_tree_statistics_coordinate_v1(event.geo,'latitude') is null
            or security_private.family_tree_statistics_coordinate_v1(event.geo,'longitude') is null
          )
      )
      when detail_key='death-before-birth' then security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) is not null and security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to)<security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to)
      when detail_key='implausible-parent-age' then exists(
        select 1 from _ft_stats_parent_edges edge
        join public.persons parent on parent.id=edge.parent_id
        join public.persons child on child.id=edge.child_id
        where person.id in (parent.id,child.id)
          and security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to) is not null
          and security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to) is not null
          and security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to)-security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to) not between 0 and 80
      )
      when detail_key='child-before-parent-birth' then exists(
        select 1 from _ft_stats_parent_edges edge
        join public.persons parent on parent.id=edge.parent_id
        join public.persons child on child.id=edge.child_id
        where person.id in (parent.id,child.id)
          and security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to) is not null
          and security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to) is not null
          and security_private.family_tree_statistics_year_v1(child.birth_date,child.birth_year_from,child.birth_year_to)<security_private.family_tree_statistics_year_v1(parent.birth_date,parent.birth_year_from,parent.birth_year_to)
      )
      when detail_key='open-tree-issues' then exists(
        select 1 from public.family_tree_research_issues issue
        where issue.tree_id=(meta->>'treeId')::uuid and issue.status='open' and issue.person_id=person.id
      )
      when detail_key='possible-duplicates' then exists(
        select 1 from public.family_tree_research_issues issue
        where issue.tree_id=(meta->>'treeId')::uuid and issue.status='open'
          and issue.person_id=person.id and lower(issue.issue_type) like '%duplicate%'
      )
      when detail_key like 'birth-decade:%' then
        (security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to)/10)*10=split_part(detail_key,':',2)::integer
      when detail_key like 'death-decade:%' then
        (security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to)/10)*10=split_part(detail_key,':',2)::integer
      when detail_key like 'event-year:%' then exists(
        select 1 from public.person_timeline_events event where event.person_id=person.id
          and security_private.family_tree_statistics_year_v1(event.event_date,event.date_from,event.date_to)=split_part(detail_key,':',2)::integer
      )
      when detail_key like 'lifespan:%' then
        security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) is not null
        and security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to) is not null
        and security_private.family_tree_statistics_year_v1(person.death_date,person.death_year_from,person.death_year_to)-security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to)
          between split_part(detail_key,':',2)::integer and split_part(detail_key,':',3)::integer
      when detail_key like 'marriage-age:%' then
        security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to) is not null
        and security_private.family_tree_statistics_first_marriage_year_v1(person.id,(meta->>'treeId')::uuid,person.marriage_date) is not null
        and security_private.family_tree_statistics_first_marriage_year_v1(person.id,(meta->>'treeId')::uuid,person.marriage_date)-security_private.family_tree_statistics_year_v1(person.birth_date,person.birth_year_from,person.birth_year_to)
          between split_part(detail_key,':',2)::integer and split_part(detail_key,':',3)::integer
      when detail_key like 'parent-type:%' then exists(
        select 1 from _ft_stats_parent_edges edge where person.id in (edge.parent_id,edge.child_id)
          and edge.relationship_type=substring(detail_key from length('parent-type:')+1)
      )
      when detail_key like 'relationship-evidence:%' then exists(
        select 1 from _ft_stats_parent_edges edge where person.id in (edge.parent_id,edge.child_id)
          and edge.evidence_status=substring(detail_key from length('relationship-evidence:')+1)
      )
      when detail_key like 'generation:%' then population.generation=split_part(detail_key,':',2)::integer
      when detail_key like 'evidence:%' then person.status=split_part(detail_key,':',2)
      when detail_key like 'family-size:%' then exists(
        select 1 from (
          select child_families.parents,count(*) children
          from (
            select edge.child_id,array_agg(edge.parent_id order by edge.parent_id) parents
            from _ft_stats_parent_edges edge group by edge.child_id
          ) child_families group by child_families.parents
        ) family
        where person.id=any(family.parents) and family.children=split_part(detail_key,':',2)::integer
      )
      when detail_key like 'partners:%' then (
        select count(*) from public.partner_relationships relation
        where relation.tree_id=(meta->>'treeId')::uuid and relation.evidence_status<>'disproven'
          and person.id in (relation.person_a_id,relation.person_b_id)
      )=split_part(detail_key,':',2)::integer
      when detail_key like 'siblings:%' then (
        select count(distinct sibling.child_id)
        from _ft_stats_parent_edges own_parent
        join _ft_stats_parent_edges sibling on sibling.parent_id=own_parent.parent_id and sibling.child_id<>person.id
        where own_parent.child_id=person.id
      )=split_part(detail_key,':',2)::integer
      when detail_key like 'association-type:%' then exists(
        select 1 from public.association_relationships association
        where association.tree_id=(meta->>'treeId')::uuid and association.evidence_status<>'disproven'
          and person.id in (association.person_a_id,association.person_b_id)
          and association.association_type=substring(detail_key from length('association-type:')+1)
      )
      when detail_key like 'partner-type:%' then exists(
        select 1 from public.partner_relationships relation
        where relation.tree_id=(meta->>'treeId')::uuid and relation.evidence_status<>'disproven'
          and person.id in (relation.person_a_id,relation.person_b_id)
          and coalesce(relation.relationship_type,'')=substring(detail_key from length('partner-type:')+1)
      )
      when detail_key like 'surname:%' then lower(trim(case
        when requested_surname_mode='birth' then coalesce(
          nullif((select name.surname from public.person_names name where name.person_id=person.id and name.name_type='birth' order by name.is_preferred desc,name.updated_at desc,name.id limit 1),''),
          nullif(person.custom_fields->>'__trackerRoduMaidenSurname',''),
          nullif((select name.surname from public.person_names name where name.person_id=person.id order by name.is_primary desc,name.is_preferred desc,name.updated_at desc,name.id limit 1),''),person.surname)
        when requested_surname_mode='married' then coalesce(
          nullif((select name.surname from public.person_names name where name.person_id=person.id and name.name_type='married' order by name.is_preferred desc,name.updated_at desc,name.id limit 1),''),
          nullif((select name.surname from public.person_names name where name.person_id=person.id order by name.is_primary desc,name.is_preferred desc,name.updated_at desc,name.id limit 1),''),person.surname)
        else coalesce(nullif((select name.surname from public.person_names name where name.person_id=person.id order by name.is_primary desc,name.is_preferred desc,name.updated_at desc,name.id limit 1),''),person.surname)
      end))=lower(substring(detail_key from length('surname:')+1))
      when detail_key like 'given-name:%' then
        lower(coalesce(nullif((select name.given_name from public.person_names name where name.person_id=person.id order by name.is_primary desc,name.is_preferred desc,name.updated_at desc,name.id limit 1),''),person.given_name))=lower(split_part(detail_key,':',3))
        and case split_part(detail_key,':',2)
          when 'male' then lower(person.gender) in ('male','m','чоловік','чоловіча')
          when 'female' then lower(person.gender) in ('female','f','жінка','жіноча')
          else true end
      when detail_key like 'patronymic:%' then lower(coalesce(nullif((select name.patronymic from public.person_names name where name.person_id=person.id order by name.is_primary desc,name.is_preferred desc,name.updated_at desc,name.id limit 1),''),person.patronymic))=lower(substring(detail_key from length('patronymic:')+1))
      when detail_key like 'name-variant:%' then exists(
        select 1 from public.person_names name
        where name.person_id=person.id and not name.is_primary
          and lower(trim(coalesce(nullif(name.full_name,''),nullif(name.original_text,''),nullif(concat_ws(' ',name.surname,name.given_name,name.patronymic),''))))=lower(substring(detail_key from length('name-variant:')+1))
      )
      when detail_key like 'finding-review:%' then exists(
        select 1 from public.finding_participants participant
        join public.findings finding on finding.id=participant.finding_id
        where participant.person_id=person.id and case substring(detail_key from length('finding-review:')+1)
          when 'confirmed' then not finding.needs_review else finding.needs_review end
      )
      when detail_key like 'finding-year:%' then exists(
        select 1 from public.finding_participants participant
        join public.findings finding on finding.id=participant.finding_id
        where participant.person_id=person.id and extract(year from finding.created_at)::integer=split_part(detail_key,':',2)::integer
      )
      when detail_key like 'materials:%' then (
        (select count(distinct source.document_id) from (
          select event.source_document_id document_id
          from public.person_timeline_events event
          where event.person_id=person.id and event.source_document_id is not null
          union
          select finding.document_id
          from public.finding_participants participant
          join public.findings finding on finding.id=participant.finding_id
          where participant.person_id=person.id and finding.document_id is not null
        ) source)
        +(select count(distinct participant.finding_id) from public.finding_participants participant where participant.person_id=person.id)
      ) between split_part(detail_key,':',2)::integer and split_part(detail_key,':',3)::integer
      when detail_key like 'event-type:%' then case substring(detail_key from length('event-type:')+1)
        when 'birth' then nullif(trim(person.birth_place),'') is not null
        when 'marriage' then nullif(trim(person.marriage_place),'') is not null
        when 'death' then nullif(trim(person.death_place),'') is not null
        when 'residence' then nullif(trim(person.residence_places),'') is not null
        else exists(select 1 from public.person_timeline_events event where event.person_id=person.id and event.event_type=substring(detail_key from length('event-type:')+1) and nullif(trim(event.place_name),'') is not null)
      end
      when detail_key like 'place:%' then lower(regexp_replace(concat_ws(' ',person.birth_place,person.marriage_place,person.death_place,person.residence_places),'\s+',' ','g')) like '%'||lower(substring(detail_key from length('place:')+1))||'%'
        or exists(select 1 from public.person_timeline_events event where event.person_id=person.id and lower(regexp_replace(coalesce(event.place_name,''),'\s+',' ','g'))=lower(substring(detail_key from length('place:')+1)))
      when detail_key like 'completeness:%' then scores.score between score_from and score_to
      else false
    end
  ;
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id',page.id,'displayName',page.display_name,'birthDate',page.birth_date,
      'deathDate',page.death_date,'generation',page.generation,'branch',page.branch,
      'kinshipKind',page.kinship_kind,'completeness',page.score,
      'evidenceStatus',page.status,'hasSources',page.has_sources
    ) order by page.generation,page.display_name,page.id),'[]'::jsonb)
  into rows_payload
  from (
    select * from _ft_stats_detail_matches order by generation,display_name,id
    offset requested_offset limit requested_limit
  ) page;
  select count(*)::integer into total_count from _ft_stats_detail_matches;
  return jsonb_build_object('meta',meta,'detailKey',detail_key,'offset',requested_offset,'limit',requested_limit,'total',total_count,'rows',rows_payload);
end;
$function$;

revoke all on function security_private.prepare_family_tree_statistics_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function security_private.family_tree_statistics_profile_scores_v1() from public,anon,authenticated,service_role;
revoke all on function security_private.family_tree_statistics_life_status_v1(boolean,jsonb,text,text,text) from public,anon,authenticated,service_role;
revoke all on function security_private.family_tree_statistics_coordinate_v1(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function security_private.family_tree_statistics_first_marriage_year_v1(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function security_private.get_family_tree_statistics_tab_v1(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function security_private.get_cached_family_tree_statistics_tab_v1(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function security_private.family_tree_statistics_prune_cache_v1() from public,anon,authenticated,service_role;
grant execute on function security_private.prepare_family_tree_statistics_v1(jsonb) to authenticated,service_role;
grant execute on function security_private.family_tree_statistics_profile_scores_v1() to authenticated,service_role;
grant execute on function security_private.family_tree_statistics_coordinate_v1(jsonb,text) to authenticated,service_role;
grant execute on function security_private.get_family_tree_statistics_tab_v1(jsonb,text) to authenticated,service_role;
grant execute on function security_private.get_cached_family_tree_statistics_tab_v1(jsonb,text) to authenticated,service_role;

revoke all on function public.get_family_tree_statistics_overview_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_family_tree_statistics_ancestry_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_family_tree_statistics_demography_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_family_tree_statistics_overview_v1(jsonb) to authenticated,service_role;
grant execute on function public.get_family_tree_statistics_ancestry_v1(jsonb) to authenticated,service_role;
grant execute on function public.get_family_tree_statistics_demography_v1(jsonb) to authenticated,service_role;
revoke all on function public.get_family_tree_statistics_families_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_family_tree_statistics_names_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_family_tree_statistics_geography_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_family_tree_statistics_research_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_family_tree_statistics_quality_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_family_tree_statistics_families_v1(jsonb) to authenticated,service_role;
grant execute on function public.get_family_tree_statistics_names_v1(jsonb) to authenticated,service_role;
grant execute on function public.get_family_tree_statistics_geography_v1(jsonb) to authenticated,service_role;
grant execute on function public.get_family_tree_statistics_research_v1(jsonb) to authenticated,service_role;
grant execute on function public.get_family_tree_statistics_quality_v1(jsonb) to authenticated,service_role;
revoke all on function public.list_family_tree_statistics_people_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.list_family_tree_statistics_people_v1(jsonb) to authenticated,service_role;

create index if not exists person_timeline_events_person_stats_idx
  on public.person_timeline_events(person_id,event_type);
create index if not exists finding_participants_person_stats_idx
  on public.finding_participants(person_id,finding_id);
create index if not exists attachments_person_stats_idx
  on public.attachments(owner_id,field_key)
  where lower(owner_type) in ('person','persons');

-- Cached payloads may have been produced by an older life-status formula.
delete from security_private.family_tree_statistics_cache;

notify pgrst,'reload schema';
commit;
