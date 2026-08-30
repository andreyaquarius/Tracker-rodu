begin;

-- Forward-only temporal/place expansion of the Research Graph.  The v1 RPC
-- remains byte-for-byte compatible for deployed clients; v2 adds optional
-- point-in-time labels and canonical Place filtering.  No family-tree row,
-- membership, or graph_version is read for mutation by this migration.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;

-- person_names preserves uncertain historical dates as text.  Parse only the
-- three lossless machine forms that the UI writes; arbitrary historical text
-- must never be guessed into a date.
create or replace function security_private.context_partial_date_bound_v1(
  p_value text,
  p_is_start boolean
)
returns date
language plpgsql
stable
parallel safe
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  value_text text := btrim(coalesce(p_value, ''));
  year_value integer;
  month_value integer;
  result_date date;
begin
  if value_text = '' then return null; end if;

  if value_text ~ '^[0-9]{4}$' then
    year_value := value_text::integer;
    if year_value not between 1 and 9999 then return null; end if;
    if p_is_start then return make_date(year_value, 1, 1); end if;
    return make_date(year_value, 12, 31);
  end if;

  if value_text ~ '^[0-9]{4}-[0-9]{2}$' then
    year_value := split_part(value_text, '-', 1)::integer;
    month_value := split_part(value_text, '-', 2)::integer;
    if year_value not between 1 and 9999 or month_value not between 1 and 12 then
      return null;
    end if;
    result_date := make_date(year_value, month_value, 1);
    if p_is_start then return result_date; end if;
    return (result_date + interval '1 month - 1 day')::date;
  end if;

  if value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return value_text::date;
  end if;

  return null;
exception when datetime_field_overflow or invalid_datetime_format then
  return null;
end;
$function$;

-- A bounded, privacy-aware temporal summary for a Place node.  Only explicit
-- dated assignments/relations are presented as historical context; undated
-- current catalogue rows are not re-labelled as facts about the focus year.
create or replace function security_private.context_place_temporal_context_v1(
  p_project_id uuid,
  p_place_id uuid,
  p_can_edit boolean,
  p_focus_from date,
  p_focus_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '8s'
as $function$
declare
  type_payload jsonb;
  type_label text;
  type_count integer := 0;
  hierarchy_payload jsonb := '[]'::jsonb;
  hierarchy_labels text;
  hierarchy_ambiguous boolean := false;
  hierarchy_truncated boolean := false;
  secondary_label text;
begin
  if p_focus_from is null or p_focus_to is null
     or not security_private.context_entity_visible_v2(
       p_project_id,'place',p_place_id,p_can_edit
     ) then return '{}'::jsonb; end if;

  with eligible_types as (
    select assignment.*,place_type.label_uk,
      row_number() over(order by assignment.is_primary desc,
        assignment.confidence desc nulls last,
        assignment.valid_from desc nulls last,assignment.updated_at desc,assignment.id) rank
    from public.place_type_assignments assignment
    join public.place_types place_type on place_type.code=assignment.place_type_code
    where assignment.place_id=p_place_id
      and (assignment.project_id is null or assignment.project_id=p_project_id)
      and (assignment.valid_from is not null or assignment.valid_to is not null)
      and (assignment.valid_from is null or assignment.valid_from<=p_focus_to)
      and (assignment.valid_to is null or assignment.valid_to>=p_focus_from)
  )
  select
    (select jsonb_strip_nulls(jsonb_build_object(
      'assignmentId',eligible.id,'code',eligible.place_type_code,
      'label',eligible.label_uk,'validFrom',eligible.valid_from,
      'validTo',eligible.valid_to,'confidence',eligible.confidence
    )) from eligible_types eligible where eligible.rank=1),
    (select eligible.label_uk from eligible_types eligible where eligible.rank=1),
    (select count(distinct eligible.place_type_code)::integer from eligible_types eligible)
  into type_payload,type_label,type_count;

  with recursive hierarchy_walk as (
    select 0 depth,p_place_id place_id,array[p_place_id]::uuid[] path,
      null::uuid relation_id,null::text relation_type,
      null::date valid_from,null::date valid_to,false cycle_detected
    union all
    select walk.depth+1,relation.parent_place_id,
      walk.path||relation.parent_place_id,relation.id,relation.relation_type,
      relation.valid_from,relation.valid_to,relation.parent_place_id=any(walk.path)
    from hierarchy_walk walk
    join lateral (
      select relation.*
      from public.place_hierarchy_relations relation
      where relation.child_place_id=walk.place_id
        and (relation.project_id is null or relation.project_id=p_project_id)
        and (relation.valid_from is not null or relation.valid_to is not null)
        and (relation.valid_from is null or relation.valid_from<=p_focus_to)
        and (relation.valid_to is null or relation.valid_to>=p_focus_from)
        and security_private.context_entity_exists_v2(
          p_project_id,'place',relation.parent_place_id
        )
      order by relation.confidence desc nulls last,
        relation.valid_from desc nulls last,relation.updated_at desc,relation.id
      limit 1
    ) relation on true
    where walk.depth<8 and not walk.cycle_detected
  ), named_walk as (
    select walk.*,
      coalesce((
        select place_name.name
        from public.place_names place_name
        where place_name.place_id=walk.place_id
          and (place_name.project_id is null or place_name.project_id=p_project_id)
          and (place_name.valid_from is not null or place_name.valid_to is not null)
          and (place_name.valid_from is null or place_name.valid_from<=p_focus_to)
          and (place_name.valid_to is null or place_name.valid_to>=p_focus_from)
        order by place_name.is_primary desc,place_name.confidence desc nulls last,
          place_name.valid_from desc nulls last,place_name.updated_at desc,place_name.id
        limit 1
      ),place_row.canonical_name) display_name,
      count(*) over(partition by walk.depth) depth_count
    from hierarchy_walk walk
    join public.places place_row on place_row.id=walk.place_id
    where walk.depth>0
  ), hierarchy_result as (
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'depth',named.depth,'relationId',named.relation_id,
        'relationType',named.relation_type,'placeId',named.place_id,
        'label',named.display_name,'validFrom',named.valid_from,
        'validTo',named.valid_to,'cycleDetected',named.cycle_detected
      ) order by named.depth,named.path,named.relation_id),'[]'::jsonb) payload,
      string_agg(named.display_name,' › ' order by named.depth,named.path) labels,
      exists(
        select 1
        from hierarchy_walk branch
        where branch.depth<8 and (
          select count(*)
          from public.place_hierarchy_relations relation
          where relation.child_place_id=branch.place_id
            and (relation.project_id is null or relation.project_id=p_project_id)
            and (relation.valid_from is not null or relation.valid_to is not null)
            and (relation.valid_from is null or relation.valid_from<=p_focus_to)
            and (relation.valid_to is null or relation.valid_to>=p_focus_from)
            and security_private.context_entity_exists_v2(
              p_project_id,'place',relation.parent_place_id
            )
        )>1
      ) ambiguous,
      coalesce(bool_or(named.cycle_detected),false)
        or exists(select 1 from named_walk leaf where leaf.depth=8)
        or exists(
          select 1
          from hierarchy_walk branch
          where branch.depth<8 and (
            select count(*)
            from public.place_hierarchy_relations relation
            where relation.child_place_id=branch.place_id
              and (relation.project_id is null or relation.project_id=p_project_id)
              and (relation.valid_from is not null or relation.valid_to is not null)
              and (relation.valid_from is null or relation.valid_from<=p_focus_to)
              and (relation.valid_to is null or relation.valid_to>=p_focus_from)
              and security_private.context_entity_exists_v2(
                p_project_id,'place',relation.parent_place_id
              )
          )>1
        ) truncated
    from named_walk named
  )
  select result.payload,result.labels,result.ambiguous,result.truncated
  into hierarchy_payload,hierarchy_labels,hierarchy_ambiguous,hierarchy_truncated
  from hierarchy_result result;

  secondary_label := nullif(btrim(concat_ws(' · ',
    nullif(type_label,''),nullif(hierarchy_labels,'')
  )), '');

  return jsonb_strip_nulls(jsonb_build_object(
    'secondaryLabel',secondary_label,
    'temporalPlaceType',type_payload,
    'temporalPlaceTypeAmbiguous',type_count>1,
    'temporalHierarchy',hierarchy_payload,
    'temporalHierarchyAmbiguous',hierarchy_ambiguous,
    'temporalHierarchyTruncated',hierarchy_truncated,
    'temporalContextAmbiguous',(type_count>1 or hierarchy_ambiguous)
  ));
end;
$function$;

create or replace function security_private.context_entity_visible_for_temporal_graph_v1(
  p_project_id uuid,p_entity_type text,p_entity_id uuid,p_can_edit boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare target_id uuid;
begin
  if security_private.context_entity_visible_v2(
    p_project_id,p_entity_type,p_entity_id,p_can_edit
  ) then return true; end if;
  if lower(coalesce(p_entity_type,''))<>'place' then return false; end if;
  select place.merged_into_place_id into target_id
  from public.places place
  where place.id=p_entity_id and place.status='merged'
    and (place.project_id is null or place.project_id=p_project_id);
  return target_id is not null and security_private.context_entity_visible_v2(
    p_project_id,'place',target_id,p_can_edit
  );
end;
$function$;

-- Resolve the display name separately from the canonical/source projection.
-- The helper first applies the existing endpoint visibility/masking contract,
-- so a historical name can never reveal a private living person.
create or replace function security_private.context_entity_temporal_descriptor_v1(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_can_edit boolean,
  p_focus_from date,
  p_focus_to date,
  p_focus_date date,
  p_focus_year integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  base_label text;
  base_secondary_label text;
  selected_id uuid;
  selected_label text;
  selected_valid_from text;
  selected_valid_to text;
  temporal_kind text;
  temporal_ambiguous boolean := false;
  place_context jsonb := '{}'::jsonb;
  lookup_entity_id uuid := p_entity_id;
  merged_from_id uuid;
begin
  if lower(coalesce(p_entity_type,''))='place'
     and not security_private.context_entity_visible_v2(
       p_project_id,'place',p_entity_id,p_can_edit
     ) then
    select place.merged_into_place_id into lookup_entity_id
    from public.places place
    where place.id=p_entity_id and place.status='merged'
      and (place.project_id is null or place.project_id=p_project_id)
      and security_private.context_entity_visible_v2(
        p_project_id,'place',place.merged_into_place_id,p_can_edit
      );
    if lookup_entity_id is not null then merged_from_id:=p_entity_id;
    else lookup_entity_id:=p_entity_id;
    end if;
  end if;
  base_label := security_private.context_entity_label_v2(
    p_project_id, p_entity_type, lookup_entity_id, p_can_edit
  );
  base_secondary_label := security_private.context_entity_secondary_label_v2(
    p_project_id, p_entity_type, lookup_entity_id, p_can_edit
  );

  if p_focus_from is null or p_focus_to is null
     or not security_private.context_entity_visible_for_temporal_graph_v1(
       p_project_id, p_entity_type, p_entity_id, p_can_edit
     )
     or security_private.context_entity_is_masked_v2(
       p_project_id, p_entity_type, p_entity_id, p_can_edit
     ) then
    return jsonb_strip_nulls(jsonb_build_object(
      'label', base_label,
      'secondaryLabel', base_secondary_label,
      'temporalLabelApplied', false,
      'mergedFromPlaceId',merged_from_id,
      'redirectPlaceId',case when merged_from_id is null then null else lookup_entity_id end
    ));
  end if;

  case lower(coalesce(p_entity_type, ''))
    when 'person' then
      select
        person_name.id,
        coalesce(
          nullif(btrim(person_name.full_name), ''),
          nullif(btrim(person_name.full_normalized), ''),
          nullif(btrim(person_name.original_text), ''),
          nullif(btrim(concat_ws(' ',
            nullif(person_name.prefix, ''),
            nullif(person_name.surname, ''),
            nullif(person_name.given_name, ''),
            nullif(person_name.patronymic, ''),
            nullif(person_name.suffix, '')
          )), '')
        ),
        nullif(person_name.valid_from, ''),
        nullif(person_name.valid_to, '')
      into selected_id, selected_label, selected_valid_from, selected_valid_to
      from public.person_names person_name
      where person_name.project_id = p_project_id
        and person_name.person_id = p_entity_id
        and person_name.is_searchable
        and person_name.evidence_status <> 'disproven'
        and coalesce(
          nullif(btrim(person_name.full_name), ''),
          nullif(btrim(person_name.full_normalized), ''),
          nullif(btrim(person_name.original_text), ''),
          nullif(btrim(concat_ws(' ',
            nullif(person_name.prefix, ''),
            nullif(person_name.surname, ''),
            nullif(person_name.given_name, ''),
            nullif(person_name.patronymic, ''),
            nullif(person_name.suffix, '')
          )), '')
        ) is not null
        and (
          security_private.context_partial_date_bound_v1(person_name.valid_from, true) is not null
          or security_private.context_partial_date_bound_v1(person_name.valid_to, false) is not null
        )
        and (
          security_private.context_partial_date_bound_v1(person_name.valid_from, true) is null
          or security_private.context_partial_date_bound_v1(person_name.valid_from, true) <= p_focus_to
        )
        and (
          security_private.context_partial_date_bound_v1(person_name.valid_to, false) is null
          or security_private.context_partial_date_bound_v1(person_name.valid_to, false) >= p_focus_from
        )
      order by
        (
          security_private.context_partial_date_bound_v1(person_name.valid_from, true) is not null
          or security_private.context_partial_date_bound_v1(person_name.valid_to, false) is not null
        ) desc,
        case person_name.evidence_status
          when 'proven' then 0 when 'likely' then 1 when 'unknown' then 2
          when 'disputed' then 3 else 4
        end,
        case person_name.date_precision
          when 'exact' then 0 when 'day' then 0 when 'month' then 1
          when 'year' then 2 when 'range' then 3 when 'between' then 3
          when 'circa' then 4 when 'before' then 5 when 'after' then 5 else 6
        end,
        person_name.is_preferred desc,
        person_name.is_primary desc,
        person_name.confidence desc nulls last,
        person_name.updated_at desc,
        person_name.id
      limit 1;
      select count(distinct coalesce(
        nullif(btrim(person_name.full_name), ''),
        nullif(btrim(person_name.full_normalized), ''),
        nullif(btrim(person_name.original_text), '')
      ))>1
      into temporal_ambiguous
      from public.person_names person_name
      where person_name.project_id=p_project_id
        and person_name.person_id=p_entity_id
        and person_name.is_searchable
        and person_name.evidence_status<>'disproven'
        and (
          security_private.context_partial_date_bound_v1(person_name.valid_from,true) is not null
          or security_private.context_partial_date_bound_v1(person_name.valid_to,false) is not null
        )
        and (
          security_private.context_partial_date_bound_v1(person_name.valid_from,true) is null
          or security_private.context_partial_date_bound_v1(person_name.valid_from,true)<=p_focus_to
        )
        and (
          security_private.context_partial_date_bound_v1(person_name.valid_to,false) is null
          or security_private.context_partial_date_bound_v1(person_name.valid_to,false)>=p_focus_from
        );
      temporal_kind := 'person_name';

    when 'place' then
      select
        place_name.id,
        place_name.name,
        place_name.valid_from::text,
        place_name.valid_to::text
      into selected_id, selected_label, selected_valid_from, selected_valid_to
      from public.place_names place_name
      where place_name.place_id = lookup_entity_id
        and (place_name.project_id is null or place_name.project_id=p_project_id)
        and (place_name.valid_from is not null or place_name.valid_to is not null)
        and (place_name.valid_from is null or place_name.valid_from <= p_focus_to)
        and (place_name.valid_to is null or place_name.valid_to >= p_focus_from)
      order by
        (place_name.valid_from is not null or place_name.valid_to is not null) desc,
        place_name.is_primary desc,
        place_name.confidence desc nulls last,
        place_name.updated_at desc,
        place_name.id
      limit 1;
      select count(distinct place_name.name)>1
      into temporal_ambiguous
      from public.place_names place_name
      where place_name.place_id=lookup_entity_id
        and (place_name.project_id is null or place_name.project_id=p_project_id)
        and (place_name.valid_from is not null or place_name.valid_to is not null)
        and (place_name.valid_from is null or place_name.valid_from<=p_focus_to)
        and (place_name.valid_to is null or place_name.valid_to>=p_focus_from);
      place_context := security_private.context_place_temporal_context_v1(
        p_project_id,lookup_entity_id,p_can_edit,p_focus_from,p_focus_to
      );
      temporal_kind := 'place_name';
    else
      null;
  end case;

  if selected_id is null or nullif(btrim(selected_label), '') is null then
    return jsonb_strip_nulls(jsonb_build_object(
      'label', base_label,
      'secondaryLabel', coalesce(place_context->>'secondaryLabel',base_secondary_label),
      'temporalLabelApplied', false,
      'focusDate', p_focus_date,
      'focusYear', p_focus_year,
      'mergedFromPlaceId',merged_from_id,
      'redirectPlaceId',case when merged_from_id is null then null else lookup_entity_id end
    )) || (place_context-'secondaryLabel');
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'label', selected_label,
    'secondaryLabel', coalesce(place_context->>'secondaryLabel',base_secondary_label),
    'temporalLabelApplied', selected_label is distinct from base_label,
    'temporalNameAmbiguous',temporal_ambiguous,
    'nameId', selected_id,
    'temporalNameId', selected_id,
    'temporalNameKind', temporal_kind,
    'canonicalLabel', base_label,
    'temporalValidFrom', selected_valid_from,
    'temporalValidTo', selected_valid_to,
    'focusDate', p_focus_date,
    'focusYear', p_focus_year,
    'mergedFromPlaceId',merged_from_id,
    'redirectPlaceId',case when merged_from_id is null then null else lookup_entity_id end
  )) || (place_context-'secondaryLabel');
end;
$function$;

-- Canonical Place filter semantics.  A relation matches when either endpoint
-- is the selected Place, an Event linked to it, or a Person with a linked
-- timeline event there.  This preserves a connected graph and avoids fuzzy
-- comparisons against source wording such as person_timeline_events.place_name.
create or replace function security_private.context_entity_matches_places_v1(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_place_ids uuid[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if cardinality(coalesce(p_place_ids, array[]::uuid[])) = 0 then return true; end if;

  case lower(coalesce(p_entity_type, ''))
    when 'place' then
      return p_entity_id = any(p_place_ids) or exists (
        select 1 from public.places place
        where place.id=p_entity_id
          and place.status='merged'
          and place.merged_into_place_id=any(p_place_ids)
          and (place.project_id is null or place.project_id=p_project_id)
      );
    when 'event' then
      return exists (
        select 1
        from public.person_timeline_events event
        where event.id = p_entity_id
          and event.project_id = p_project_id
          and event.place_id = any(p_place_ids)
          and event.place_resolution_status = 'confirmed'
      );
    when 'person' then
      return exists (
        select 1
        from public.person_timeline_events event
        where event.person_id = p_entity_id
          and event.project_id = p_project_id
          and event.place_id = any(p_place_ids)
          and event.place_resolution_status = 'confirmed'
      );
    when 'document' then
      return exists (
        select 1
        from public.document_place_links place_link
        where place_link.document_id = p_entity_id
          and place_link.project_id = p_project_id
          and place_link.place_id = any(p_place_ids)
          and place_link.resolution_status = 'confirmed'
      );
    when 'finding' then
      return exists (
        select 1
        from public.document_place_links place_link
        where place_link.source_finding_id = p_entity_id
          and place_link.project_id = p_project_id
          and place_link.place_id = any(p_place_ids)
          and place_link.resolution_status = 'confirmed'
      );
    else
      return false;
  end case;
end;
$function$;

create or replace function security_private.context_relation_matches_places_v1(
  p_project_id uuid,
  p_relation_id uuid,
  p_place_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select cardinality(coalesce(p_place_ids,array[]::uuid[]))=0 or exists (
    select 1
    from public.context_relation_evidence_links evidence
    where evidence.project_id=p_project_id
      and evidence.relation_id=p_relation_id
      and evidence.deleted_at is null
      and (
        (evidence.evidence_entity_type='place' and evidence.evidence_entity_id=any(p_place_ids))
        or (
          evidence.evidence_entity_type='document' and exists (
            select 1 from public.document_place_links place_link
            where place_link.project_id=p_project_id
              and place_link.document_id=evidence.evidence_entity_id
              and place_link.place_id=any(p_place_ids)
              and place_link.resolution_status='confirmed'
          )
        )
        or (
          evidence.evidence_entity_type='finding' and exists (
            select 1 from public.document_place_links place_link
            where place_link.project_id=p_project_id
              and place_link.source_finding_id=evidence.evidence_entity_id
              and place_link.place_id=any(p_place_ids)
              and place_link.resolution_status='confirmed'
          )
        )
        or (
          evidence.evidence_entity_type='event' and exists (
            select 1 from public.person_timeline_events event
            where event.project_id=p_project_id
              and event.id=evidence.evidence_entity_id
              and event.place_id=any(p_place_ids)
              and event.place_resolution_status='confirmed'
          )
        )
      )
  ) or exists (
    select 1
    from public.context_relations generic_relation
    join public.context_relation_evidence evidence
      on evidence.relation_id=generic_relation.person_context_relation_id
     and evidence.project_id=generic_relation.project_id
     and evidence.deleted_at is null
    where generic_relation.id=p_relation_id
      and generic_relation.project_id=p_project_id
      and (
        exists (
          select 1 from public.document_place_links place_link
          where place_link.project_id=p_project_id
            and place_link.place_id=any(p_place_ids)
            and place_link.resolution_status='confirmed'
            and (
              place_link.document_id=evidence.source_document_id
              or place_link.source_finding_id=evidence.source_finding_id
            )
        )
        or exists (
          select 1 from public.person_timeline_events event
          where event.project_id=p_project_id
            and event.id=evidence.source_event_id
            and event.place_id=any(p_place_ids)
            and event.place_resolution_status='confirmed'
        )
      )
  );
$function$;

-- Supports safe local re-application while 021 is still uncommitted.  On a
-- fresh production database these signatures simply do not exist.
drop function if exists public.get_person_research_context_graph_v2(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],integer,integer
);
drop function if exists security_private.get_person_research_context_graph_v2(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],integer,integer
);

create or replace function security_private.get_person_research_context_graph_v2(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 2,
  p_entity_types text[] default null,
  p_relation_type_ids uuid[] default null,
  p_evidence_statuses text[] default null,
  p_assertion_kinds text[] default null,
  p_valid_from date default null,
  p_valid_to date default null,
  p_min_confidence integer default null,
  p_has_evidence boolean default null,
  p_focus_date date default null,
  p_focus_year integer default null,
  p_place_ids uuid[] default null,
  p_include_undated boolean default false,
  p_max_nodes integer default 100,
  p_max_edges integer default 250
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '8s'
as $function$
declare
  result jsonb;
  can_edit boolean;
  graph_revision bigint;
  focus_from date;
  focus_to date;
  date_filter_active boolean;
  merged_place_id uuid;
  merged_target_id uuid;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  if p_center_person_id is null then raise exception 'CONTEXT_GRAPH_CENTER_PERSON_REQUIRED' using errcode='22023'; end if;
  if not exists(select 1 from public.persons person where person.id=p_center_person_id and person.project_id=p_project_id) then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode='P0002';
  end if;
  if p_depth is null or p_depth<1 or p_depth>3 then raise exception 'CONTEXT_GRAPH_DEPTH_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_max_nodes is null or p_max_nodes<1 or p_max_nodes>100 then raise exception 'CONTEXT_GRAPH_MAX_NODES_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_max_edges is null or p_max_edges<1 or p_max_edges>250 then raise exception 'CONTEXT_GRAPH_MAX_EDGES_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_min_confidence is not null and (p_min_confidence<0 or p_min_confidence>100) then raise exception 'CONTEXT_GRAPH_MIN_CONFIDENCE_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_valid_from is not null and p_valid_to is not null and p_valid_from>p_valid_to then raise exception 'CONTEXT_GRAPH_DATE_RANGE_INVALID' using errcode='22023'; end if;
  if p_focus_date is not null and p_focus_year is not null then raise exception 'CONTEXT_GRAPH_TEMPORAL_FOCUS_AMBIGUOUS' using errcode='22023'; end if;
  if p_focus_year is not null and p_focus_year not between 1 and 9999 then raise exception 'CONTEXT_GRAPH_FOCUS_YEAR_OUT_OF_RANGE' using errcode='22023'; end if;
  if cardinality(coalesce(p_place_ids,array[]::uuid[]))>50 then raise exception 'CONTEXT_GRAPH_PLACE_FILTER_LIMIT_EXCEEDED' using errcode='22023'; end if;
  if exists(select 1 from unnest(coalesce(p_place_ids,array[]::uuid[])) requested(value) where requested.value is null) then
    raise exception 'CONTEXT_GRAPH_PLACE_FILTER_INVALID' using errcode='22023';
  end if;
  select place.id,place.merged_into_place_id
  into merged_place_id,merged_target_id
  from unnest(coalesce(p_place_ids,array[]::uuid[])) requested(value)
  join public.places place on place.id=requested.value
  where place.status='merged' and place.merged_into_place_id is not null
    and (place.project_id is null or place.project_id=p_project_id)
  order by place.id
  limit 1;
  if merged_place_id is not null then
    raise exception 'CONTEXT_GRAPH_PLACE_MERGED_USE_TARGET:%',merged_target_id
      using errcode='22023';
  end if;
  if exists(
    select 1 from unnest(coalesce(p_place_ids,array[]::uuid[])) requested(value)
    where not security_private.context_entity_exists_v2(p_project_id,'place',requested.value)
  ) then raise exception 'CONTEXT_GRAPH_PLACE_NOT_FOUND_IN_SCOPE' using errcode='P0002'; end if;
  if exists(select 1 from unnest(coalesce(p_entity_types,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('person','family','place','event','document','finding','source','repository','hypothesis'))
  then raise exception 'CONTEXT_GRAPH_ENTITY_TYPE_INVALID' using errcode='22023'; end if;
  if exists(select 1 from unnest(coalesce(p_evidence_statuses,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('proven','likely','disputed','disproven','unknown'))
  then raise exception 'CONTEXT_GRAPH_EVIDENCE_STATUS_INVALID' using errcode='22023'; end if;
  if exists(select 1 from unnest(coalesce(p_assertion_kinds,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('manual','legacy_import','generated','research_hypothesis'))
  then raise exception 'CONTEXT_GRAPH_ASSERTION_KIND_INVALID' using errcode='22023'; end if;

  focus_from := coalesce(p_focus_date, case when p_focus_year is null then null else make_date(p_focus_year,1,1) end);
  focus_to := coalesce(p_focus_date, case when p_focus_year is null then null else make_date(p_focus_year,12,31) end);
  date_filter_active := focus_from is not null or p_valid_from is not null or p_valid_to is not null;
  can_edit := coalesce(auth.role(),'')='service_role' or public.can_edit_project(p_project_id);
  select coalesce(revision.revision,0) into graph_revision
  from (select 1) seed left join public.context_graph_revisions revision on revision.project_id=p_project_id;

  with recursive
  relation_candidates as materialized (
    select relation.*,
      relation_type.code relation_type_code,relation_type.label_uk relation_type_label,
      relation_type.category relation_category,relation_type.directionality
    from (
      select raw_relation.*,
        case
          when raw_relation.valid_from is null and raw_relation.valid_to is null
            then security_private.context_partial_date_bound_v1(raw_relation.period_text,true)
          else raw_relation.valid_from
        end effective_valid_from,
        case
          when raw_relation.valid_from is null and raw_relation.valid_to is null
            then security_private.context_partial_date_bound_v1(raw_relation.period_text,false)
          else raw_relation.valid_to
        end effective_valid_to
      from security_private.context_relation_union_v2(p_project_id) raw_relation
    ) relation
    join public.context_relation_types relation_type
      on relation_type.id=relation.relation_type_id
     and (relation_type.project_id is null or relation_type.project_id=p_project_id)
    where security_private.context_entity_visible_for_temporal_graph_v1(
        p_project_id,relation.source_entity_type,relation.source_entity_id,can_edit
      )
      and security_private.context_entity_visible_for_temporal_graph_v1(
        p_project_id,relation.target_entity_type,relation.target_entity_id,can_edit
      )
      and (relation.privacy_status<>'confidential' or can_edit)
      and (cardinality(coalesce(p_entity_types,array[]::text[]))=0
        or (relation.source_entity_type='person' and relation.source_entity_id=p_center_person_id)
        or relation.source_entity_type=any(p_entity_types))
      and (cardinality(coalesce(p_entity_types,array[]::text[]))=0
        or (relation.target_entity_type='person' and relation.target_entity_id=p_center_person_id)
        or relation.target_entity_type=any(p_entity_types))
      and (cardinality(coalesce(p_relation_type_ids,array[]::uuid[]))=0 or relation.relation_type_id=any(p_relation_type_ids))
      and (cardinality(coalesce(p_evidence_statuses,array[]::text[]))=0 or relation.evidence_status=any(p_evidence_statuses))
      and (cardinality(coalesce(p_assertion_kinds,array[]::text[]))=0 or relation.assertion_kind=any(p_assertion_kinds))
      and (p_valid_from is null or relation.effective_valid_to is null or relation.effective_valid_to>=p_valid_from)
      and (p_valid_to is null or relation.effective_valid_from is null or relation.effective_valid_from<=p_valid_to)
      and (
        not date_filter_active or coalesce(p_include_undated,false)
        or relation.effective_valid_from is not null
        or relation.effective_valid_to is not null
      )
      and (focus_from is null or relation.effective_valid_to is null or relation.effective_valid_to>=focus_from)
      and (focus_to is null or relation.effective_valid_from is null or relation.effective_valid_from<=focus_to)
      and (p_min_confidence is null or relation.confidence>=p_min_confidence)
      and (p_has_evidence is null or (relation.evidence_count>0)=p_has_evidence)
      and (
        cardinality(coalesce(p_place_ids,array[]::uuid[]))=0
        or (
          not (
            relation.source_entity_type='person'
            and relation.source_entity_id=p_center_person_id
          )
          and security_private.context_entity_matches_places_v1(
            p_project_id,relation.source_entity_type,relation.source_entity_id,p_place_ids
          )
        )
        or (
          not (
            relation.target_entity_type='person'
            and relation.target_entity_id=p_center_person_id
          )
          and security_private.context_entity_matches_places_v1(
            p_project_id,relation.target_entity_type,relation.target_entity_id,p_place_ids
          )
        )
        or security_private.context_relation_matches_places_v1(
          p_project_id,relation.id,p_place_ids
        )
      )
  ), relation_base as materialized (
    select candidate.*
    from relation_candidates candidate
    where not (
      candidate.assertion_kind='legacy_import'
      and candidate.metadata->>'compatibilityProjection'='hypothesis_links'
      and exists (
        select 1 from relation_candidates generic_relation
        where generic_relation.id<>candidate.id
          and not (
            generic_relation.assertion_kind='legacy_import'
            and generic_relation.metadata->>'compatibilityProjection'='hypothesis_links'
          )
          and generic_relation.relation_type_id=candidate.relation_type_id
          and generic_relation.source_entity_type=candidate.source_entity_type
          and generic_relation.source_entity_id=candidate.source_entity_id
          and generic_relation.target_entity_type=candidate.target_entity_type
          and generic_relation.target_entity_id=candidate.target_entity_id
      )
    )
  ), directed_edges as materialized (
    select relation.id relation_id,relation.source_entity_type from_type,relation.source_entity_id from_id,
      relation.target_entity_type to_type,relation.target_entity_id to_id,relation.updated_at
    from relation_base relation
    union all
    select relation.id,relation.target_entity_type,relation.target_entity_id,
      relation.source_entity_type,relation.source_entity_id,relation.updated_at
    from relation_base relation
  ), walk(entity_type,entity_id,depth) as (
    select 'person'::text,p_center_person_id,0
    union
    select edge.to_type,edge.to_id,walk.depth+1
    from walk join directed_edges edge on edge.from_type=walk.entity_type and edge.from_id=walk.entity_id
    where walk.depth<p_depth
  ), reachable_nodes as (
    select walk.entity_type,walk.entity_id,min(walk.depth) depth
    from walk group by walk.entity_type,walk.entity_id
  ), node_activity as (
    select reachable.entity_type,reachable.entity_id,reachable.depth,max(edge.updated_at) latest_relation_at
    from reachable_nodes reachable
    left join directed_edges edge on edge.from_type=reachable.entity_type and edge.from_id=reachable.entity_id
    group by reachable.entity_type,reachable.entity_id,reachable.depth
  ), ranked_nodes as (
    select activity.*,row_number() over(order by activity.depth,
      (activity.entity_type='person' and activity.entity_id=p_center_person_id) desc,
      activity.latest_relation_at desc nulls last,activity.entity_type,activity.entity_id) node_rank
    from node_activity activity
  ), candidate_nodes as materialized (
    select ranked.* from ranked_nodes ranked where ranked.node_rank<=p_max_nodes
  ), candidate_edges as materialized (
    select relation.*,greatest(source_node.depth,target_node.depth) graph_depth
    from relation_base relation
    join candidate_nodes source_node on source_node.entity_type=relation.source_entity_type and source_node.entity_id=relation.source_entity_id
    join candidate_nodes target_node on target_node.entity_type=relation.target_entity_type and target_node.entity_id=relation.target_entity_id
  ), parent_options as (
    select edge.id relation_id,target_node.entity_type child_type,target_node.entity_id child_id,
      target_node.node_rank child_rank,target_node.depth child_depth,edge.updated_at
    from candidate_edges edge
    join candidate_nodes source_node on source_node.entity_type=edge.source_entity_type and source_node.entity_id=edge.source_entity_id
    join candidate_nodes target_node on target_node.entity_type=edge.target_entity_type and target_node.entity_id=edge.target_entity_id
    where target_node.depth=source_node.depth+1
    union all
    select edge.id,source_node.entity_type,source_node.entity_id,
      source_node.node_rank,source_node.depth,edge.updated_at
    from candidate_edges edge
    join candidate_nodes source_node on source_node.entity_type=edge.source_entity_type and source_node.entity_id=edge.source_entity_id
    join candidate_nodes target_node on target_node.entity_type=edge.target_entity_type and target_node.entity_id=edge.target_entity_id
    where source_node.depth=target_node.depth+1
  ), ranked_parent_options as (
    select option.*,row_number() over(partition by option.child_type,option.child_id
      order by option.updated_at desc,option.relation_id) parent_rank
    from parent_options option
  ), chosen_parent_edges as (
    select option.relation_id,min(option.child_rank) child_rank,min(option.child_depth) child_depth
    from ranked_parent_options option where option.parent_rank=1 group by option.relation_id
  ), ranked_edges as (
    select edge.*,row_number() over(order by
      (parent.relation_id is not null) desc,
      coalesce(parent.child_depth,edge.graph_depth),
      parent.child_rank nulls last,edge.updated_at desc,edge.id) edge_rank
    from candidate_edges edge left join chosen_parent_edges parent on parent.relation_id=edge.id
  ), selected_edges as materialized (
    select ranked.* from ranked_edges ranked where ranked.edge_rank<=p_max_edges
  ), final_node_keys as (
    select 'person'::text entity_type,p_center_person_id entity_id
    union select edge.source_entity_type,edge.source_entity_id from selected_edges edge
    union select edge.target_entity_type,edge.target_entity_id from selected_edges edge
  ), selected_nodes as materialized (
    select candidate.* from candidate_nodes candidate
    join final_node_keys key on key.entity_type=candidate.entity_type and key.entity_id=candidate.entity_id
  ), node_rows as (
    select node.node_rank,jsonb_build_object(
      'id',node.entity_type||':'||node.entity_id::text,'entityType',node.entity_type,'entityId',node.entity_id,
      'label',temporal.descriptor->>'label',
      'secondaryLabel',coalesce(temporal.descriptor->>'secondaryLabel',''),
      'isCenter',node.entity_type='person' and node.entity_id=p_center_person_id,
      'masked',security_private.context_entity_is_masked_v2(p_project_id,node.entity_type,node.entity_id,can_edit),
      'depth',node.depth,
      'metadata',security_private.context_entity_metadata_v2(
        p_project_id,node.entity_type,node.entity_id,can_edit
      ) || (temporal.descriptor - 'label' - 'secondaryLabel')
    ) payload
    from selected_nodes node
    cross join lateral (
      select security_private.context_entity_temporal_descriptor_v1(
        p_project_id,node.entity_type,node.entity_id,can_edit,
        focus_from,focus_to,p_focus_date,p_focus_year
      ) descriptor
    ) temporal
  ), edge_rows as (
    select edge.edge_rank,jsonb_build_object(
      'id',edge.id,'source',edge.source_entity_type||':'||edge.source_entity_id::text,
      'target',edge.target_entity_type||':'||edge.target_entity_id::text,
      'sourceEntityType',edge.source_entity_type,'sourceEntityId',edge.source_entity_id,
      'targetEntityType',edge.target_entity_type,'targetEntityId',edge.target_entity_id,
      'relationTypeId',edge.relation_type_id,'relationTypeCode',edge.relation_type_code,
      'relationTypeLabel',edge.relation_type_label,'relationCategory',edge.relation_category,
      'directionality',edge.directionality,'sourceRoleLabel',edge.source_role_label,
      'targetRoleLabel',edge.target_role_label,
      'validFrom',edge.effective_valid_from,'validTo',edge.effective_valid_to,
      'periodText',edge.period_text,'evidenceStatus',edge.evidence_status,'confidence',edge.confidence,
      'privacyStatus',edge.privacy_status,'assertionKind',edge.assertion_kind,
      'generated',edge.assertion_kind='generated','metadata',edge.metadata||jsonb_build_object(
        'temporalBoundsDerived',(
          (edge.valid_from is null and edge.effective_valid_from is not null)
          or (edge.valid_to is null and edge.effective_valid_to is not null)
        )
      ),
      'lockVersion',edge.lock_version,'evidenceCount',edge.evidence_count
    ) payload from selected_edges edge
  )
  select jsonb_build_object(
    'projectId',p_project_id,'center',jsonb_build_object('entityType','person','entityId',p_center_person_id),
    'depth',p_depth,'revision',graph_revision,
    'nodes',coalesce((select jsonb_agg(node.payload order by node.node_rank) from node_rows node),'[]'::jsonb),
    'edges',coalesce((select jsonb_agg(edge.payload order by edge.edge_rank) from edge_rows edge),'[]'::jsonb),
    'limits',jsonb_build_object('maxNodes',p_max_nodes,'maxEdges',p_max_edges,'maxPlaceIds',50),
    'truncated',jsonb_build_object(
      'nodes',(select count(*) from reachable_nodes)>(select count(*) from selected_nodes),
      'edges',(select count(*) from candidate_edges)>(select count(*) from selected_edges)
    ),
    'filters',jsonb_build_object(
      'entityTypes',coalesce(to_jsonb(p_entity_types),'[]'::jsonb),
      'relationTypeIds',coalesce(to_jsonb(p_relation_type_ids),'[]'::jsonb),
      'evidenceStatuses',coalesce(to_jsonb(p_evidence_statuses),'[]'::jsonb),
      'assertionKinds',coalesce(to_jsonb(p_assertion_kinds),'[]'::jsonb),
      'validFrom',p_valid_from,'validTo',p_valid_to,'minConfidence',p_min_confidence,
      'hasEvidence',p_has_evidence,'focusDate',p_focus_date,'focusYear',p_focus_year,
      'placeIds',coalesce(to_jsonb(p_place_ids),'[]'::jsonb),
      'includeUndated',coalesce(p_include_undated,false)
    )
  ) into result;
  return result;
end;
$function$;

create or replace function public.get_person_research_context_graph_v2(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 2,
  p_entity_types text[] default null,
  p_relation_type_ids uuid[] default null,
  p_evidence_statuses text[] default null,
  p_assertion_kinds text[] default null,
  p_valid_from date default null,
  p_valid_to date default null,
  p_min_confidence integer default null,
  p_has_evidence boolean default null,
  p_focus_date date default null,
  p_focus_year integer default null,
  p_place_ids uuid[] default null,
  p_include_undated boolean default false,
  p_max_nodes integer default 100,
  p_max_edges integer default 250
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_person_research_context_graph_v2(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
  );
$wrapper$;

revoke all on function security_private.context_partial_date_bound_v1(text,boolean)
  from public, anon, authenticated, service_role;
revoke all on function security_private.context_entity_temporal_descriptor_v1(
  uuid,text,uuid,boolean,date,date,date,integer
) from public, anon, authenticated, service_role;
revoke all on function security_private.context_entity_visible_for_temporal_graph_v1(uuid,text,uuid,boolean)
  from public, anon, authenticated, service_role;
revoke all on function security_private.context_entity_matches_places_v1(uuid,text,uuid,uuid[])
  from public, anon, authenticated, service_role;
revoke all on function security_private.context_relation_matches_places_v1(uuid,uuid,uuid[])
  from public, anon, authenticated, service_role;
revoke all on function security_private.context_place_temporal_context_v1(uuid,uuid,boolean,date,date)
  from public, anon, authenticated, service_role;
revoke all on function security_private.get_person_research_context_graph_v2(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer
) from public, anon, authenticated, service_role;
grant execute on function security_private.get_person_research_context_graph_v2(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer
) to authenticated, service_role;

revoke all on function public.get_person_research_context_graph_v2(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer
) from public, anon, authenticated, service_role;
grant execute on function public.get_person_research_context_graph_v2(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer
) to authenticated, service_role;

comment on function public.get_person_research_context_graph_v2(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer
) is
  'Authenticated bounded Research Graph with canonical Place filter and privacy-safe historical Person/Place labels at one optional date or year.';

notify pgrst, 'reload schema';

commit;
