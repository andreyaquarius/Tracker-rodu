begin;

-- Forward-only hardening for the polymorphic Research Graph introduced by
-- 202608290019.  The old hypotheses/hypothesis_links model remains canonical
-- for its existing UI; this migration adds a read-through projection only.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;

-- The deployed legacy contract is exactly Person/Document/Finding ->
-- Hypothesis.  Fail visibly if a future environment has drifted rather than
-- silently producing malformed graph endpoints.
do $hypothesis_links_contract$
begin
  if to_regclass('public.hypothesis_links') is null
     or not exists (
       select 1 from pg_catalog.pg_attribute attribute
       where attribute.attrelid = 'public.hypothesis_links'::regclass
         and attribute.attname = 'project_id' and not attribute.attisdropped
     )
     or not exists (
       select 1 from pg_catalog.pg_attribute attribute
       where attribute.attrelid = 'public.hypothesis_links'::regclass
         and attribute.attname = 'hypothesis_id' and not attribute.attisdropped
     )
     or not exists (
       select 1 from pg_catalog.pg_attribute attribute
       where attribute.attrelid = 'public.hypothesis_links'::regclass
         and attribute.attname = 'target_type' and not attribute.attisdropped
     )
     or not exists (
       select 1 from pg_catalog.pg_attribute attribute
       where attribute.attrelid = 'public.hypothesis_links'::regclass
         and attribute.attname = 'target_id' and not attribute.attisdropped
     ) then
    raise exception 'HYPOTHESIS_LINKS_CONTRACT_UNSUPPORTED' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.hypothesis_links link
    where link.target_type not in ('person','document','finding')
  ) then
    raise exception 'HYPOTHESIS_LINK_TARGET_TYPE_UNSUPPORTED' using errcode = '23514';
  end if;
end;
$hypothesis_links_contract$;

-- A project custom relation type may reuse another project's code, but a
-- system code is globally reserved.  Refuse a dirty state instead of letting
-- code-based saves silently pick a project row in place of the system type.
do $context_system_code_preflight$
declare conflicting_codes text;
begin
  select string_agg(distinct system_type.code, ', ' order by system_type.code)
  into conflicting_codes
  from public.context_relation_types system_type
  join public.context_relation_types custom_type
    on lower(custom_type.code) = lower(system_type.code)
   and custom_type.project_id is not null
  where system_type.project_id is null and system_type.is_system;
  if conflicting_codes is not null then
    raise exception 'CONTEXT_RELATION_TYPE_SYSTEM_CODE_CONFLICT: %', conflicting_codes
      using errcode = '23505';
  end if;
end;
$context_system_code_preflight$;

create or replace function security_private.guard_context_relation_type_system_code_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if new.project_id is null and new.is_system and exists (
    select 1 from public.context_relation_types relation_type
    where relation_type.project_id is not null
      and lower(relation_type.code) = lower(btrim(new.code))
      and relation_type.id <> new.id
  ) then
    raise exception 'CONTEXT_RELATION_TYPE_SYSTEM_CODE_CONFLICT' using errcode = '23505';
  end if;
  if new.project_id is not null and exists (
    select 1 from public.context_relation_types relation_type
    where relation_type.project_id is null and relation_type.is_system
      and lower(relation_type.code) = lower(btrim(new.code))
      and relation_type.id <> new.id
  ) then
    raise exception 'CONTEXT_RELATION_TYPE_CODE_RESERVED' using errcode = '23505';
  end if;
  return new;
end;
$function$;

create or replace function security_private.get_person_research_context_graph_v1(
  p_project_id uuid,p_center_person_id uuid,p_depth integer default 2,
  p_entity_types text[] default null,p_relation_type_ids uuid[] default null,
  p_evidence_statuses text[] default null,p_assertion_kinds text[] default null,
  p_valid_from date default null,p_valid_to date default null,
  p_min_confidence integer default null,p_has_evidence boolean default null,
  p_max_nodes integer default 100,p_max_edges integer default 250
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
declare can_edit boolean;
declare graph_revision bigint;
begin
  perform security_private.require_context_project_access_v1(p_project_id,false);
  if p_center_person_id is null then raise exception 'CONTEXT_GRAPH_CENTER_PERSON_REQUIRED' using errcode='22023'; end if;
  if not exists(select 1 from public.persons person where person.id=p_center_person_id and person.project_id=p_project_id) then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode='P0002';
  end if;
  if p_depth is null or p_depth<1 or p_depth>3 then raise exception 'CONTEXT_GRAPH_DEPTH_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_max_nodes is null or p_max_nodes<1 or p_max_nodes>100 then raise exception 'CONTEXT_GRAPH_MAX_NODES_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_max_edges is null or p_max_edges<1 or p_max_edges>250 then raise exception 'CONTEXT_GRAPH_MAX_EDGES_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_min_confidence is not null and (p_min_confidence<0 or p_min_confidence>100) then raise exception 'CONTEXT_GRAPH_MIN_CONFIDENCE_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_valid_from is not null and p_valid_to is not null and p_valid_from>p_valid_to then raise exception 'CONTEXT_GRAPH_DATE_RANGE_INVALID' using errcode='22023'; end if;
  if exists(select 1 from unnest(coalesce(p_entity_types,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('person','family','place','event','document','finding','source','repository','hypothesis'))
  then raise exception 'CONTEXT_GRAPH_ENTITY_TYPE_INVALID' using errcode='22023'; end if;
  if exists(select 1 from unnest(coalesce(p_evidence_statuses,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('proven','likely','disputed','disproven','unknown'))
  then raise exception 'CONTEXT_GRAPH_EVIDENCE_STATUS_INVALID' using errcode='22023'; end if;
  if exists(select 1 from unnest(coalesce(p_assertion_kinds,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('manual','legacy_import','generated','research_hypothesis'))
  then raise exception 'CONTEXT_GRAPH_ASSERTION_KIND_INVALID' using errcode='22023'; end if;

  can_edit := coalesce(auth.role(),'')='service_role' or public.can_edit_project(p_project_id);
  select coalesce(revision.revision,0) into graph_revision
  from (select 1) seed left join public.context_graph_revisions revision on revision.project_id=p_project_id;

  with recursive
  relation_candidates as materialized (
    select relation.*,
      relation_type.code relation_type_code,relation_type.label_uk relation_type_label,
      relation_type.category relation_category,relation_type.directionality
    from security_private.context_relation_union_v2(p_project_id) relation
    join public.context_relation_types relation_type
      on relation_type.id=relation.relation_type_id
     and (relation_type.project_id is null or relation_type.project_id=p_project_id)
    where security_private.context_entity_visible_v2(
        p_project_id,relation.source_entity_type,relation.source_entity_id,can_edit
      )
      and security_private.context_entity_visible_v2(
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
      and (p_valid_from is null or relation.valid_to is null or relation.valid_to>=p_valid_from)
      and (p_valid_to is null or relation.valid_from is null or relation.valid_from<=p_valid_to)
      and (p_min_confidence is null or relation.confidence>=p_min_confidence)
      and (p_has_evidence is null or (relation.evidence_count>0)=p_has_evidence)
  ), relation_base as materialized (
    select candidate.*
    from relation_candidates candidate
    where not (
      candidate.assertion_kind='legacy_import'
      and candidate.metadata->>'compatibilityProjection'='hypothesis_links'
      and exists (
        select 1
        from relation_candidates generic_relation
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
      'label',security_private.context_entity_label_v2(p_project_id,node.entity_type,node.entity_id,can_edit),
      'secondaryLabel',security_private.context_entity_secondary_label_v2(p_project_id,node.entity_type,node.entity_id,can_edit),
      'isCenter',node.entity_type='person' and node.entity_id=p_center_person_id,
      'masked',security_private.context_entity_is_masked_v2(p_project_id,node.entity_type,node.entity_id,can_edit),
      'depth',node.depth,'metadata',security_private.context_entity_metadata_v2(p_project_id,node.entity_type,node.entity_id,can_edit)
    ) payload from selected_nodes node
  ), edge_rows as (
    select edge.edge_rank,jsonb_build_object(
      'id',edge.id,'source',edge.source_entity_type||':'||edge.source_entity_id::text,
      'target',edge.target_entity_type||':'||edge.target_entity_id::text,
      'sourceEntityType',edge.source_entity_type,'sourceEntityId',edge.source_entity_id,
      'targetEntityType',edge.target_entity_type,'targetEntityId',edge.target_entity_id,
      'relationTypeId',edge.relation_type_id,'relationTypeCode',edge.relation_type_code,
      'relationTypeLabel',edge.relation_type_label,'relationCategory',edge.relation_category,
      'directionality',edge.directionality,'sourceRoleLabel',edge.source_role_label,
      'targetRoleLabel',edge.target_role_label,'validFrom',edge.valid_from,'validTo',edge.valid_to,
      'periodText',edge.period_text,'evidenceStatus',edge.evidence_status,'confidence',edge.confidence,
      'privacyStatus',edge.privacy_status,'assertionKind',edge.assertion_kind,
      'generated',edge.assertion_kind='generated','metadata',edge.metadata,
      'lockVersion',edge.lock_version,'evidenceCount',edge.evidence_count
    ) payload from selected_edges edge
  )
  select jsonb_build_object(
    'projectId',p_project_id,'center',jsonb_build_object('entityType','person','entityId',p_center_person_id),
    'depth',p_depth,'revision',graph_revision,
    'nodes',coalesce((select jsonb_agg(node.payload order by node.node_rank) from node_rows node),'[]'::jsonb),
    'edges',coalesce((select jsonb_agg(edge.payload order by edge.edge_rank) from edge_rows edge),'[]'::jsonb),
    'limits',jsonb_build_object('maxNodes',p_max_nodes,'maxEdges',p_max_edges),
    'truncated',jsonb_build_object(
      'nodes',(select count(*) from reachable_nodes)>(select count(*) from selected_nodes),
      'edges',(select count(*) from candidate_edges)>(select count(*) from selected_edges)
    ),
    'filters',jsonb_build_object(
      'entityTypes',coalesce(to_jsonb(p_entity_types),'[]'::jsonb),
      'relationTypeIds',coalesce(to_jsonb(p_relation_type_ids),'[]'::jsonb),
      'evidenceStatuses',coalesce(to_jsonb(p_evidence_statuses),'[]'::jsonb),
      'assertionKinds',coalesce(to_jsonb(p_assertion_kinds),'[]'::jsonb),
      'validFrom',p_valid_from,'validTo',p_valid_to,'minConfidence',p_min_confidence,'hasEvidence',p_has_evidence
    )
  ) into result;
  return result;
end;
$function$;


create or replace function security_private.archive_context_evidence_with_parent_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  update public.context_relation_evidence_links evidence
  set deleted_at=coalesce(evidence.deleted_at,new.deleted_at,now()),
      deleted_by=coalesce(evidence.deleted_by,new.deleted_by,auth.uid()),
      updated_by=coalesce(auth.uid(),new.updated_by,evidence.updated_by)
  where evidence.relation_id=new.id and evidence.deleted_at is null;
  return null;
end;
$function$;

drop trigger if exists context_relations_25_archive_evidence on public.context_relations;
create trigger context_relations_25_archive_evidence
after update of deleted_at on public.context_relations
for each row
when (old.deleted_at is null and new.deleted_at is not null)
execute function security_private.archive_context_evidence_with_parent_v1();

create or replace function security_private.cleanup_context_endpoint_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare endpoint_type text := tg_argv[0];
begin
  -- Evidence that points at the deleted entity is archived even when its
  -- parent relation remains active.
  update public.context_relation_evidence_links evidence
  set deleted_at=coalesce(evidence.deleted_at,now()),
      deleted_by=coalesce(evidence.deleted_by,auth.uid()),
      updated_by=coalesce(auth.uid(),evidence.updated_by)
  where evidence.deleted_at is null
    and evidence.evidence_entity_type=endpoint_type
    and evidence.evidence_entity_id=old.id;

  -- The centralized parent trigger above archives every remaining evidence
  -- item for each relation that becomes inactive here.
  update public.context_relations relation
  set deleted_at=coalesce(relation.deleted_at,now()),
      deleted_by=coalesce(relation.deleted_by,auth.uid()),
      updated_by=coalesce(auth.uid(),relation.updated_by)
  where relation.deleted_at is null
    and relation.person_context_relation_id is null
    and (
      (relation.source_entity_type=endpoint_type and relation.source_entity_id=old.id)
      or (relation.target_entity_type=endpoint_type and relation.target_entity_id=old.id)
    );
  return old;
end;
$function$;

create or replace function security_private.list_context_relation_evidence_v2(
  p_project_id uuid,p_relation_id uuid,p_limit integer default 50,p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare relation_row public.context_relations%rowtype;
declare can_edit boolean;
declare result jsonb;
begin
  perform security_private.require_context_project_access_v1(p_project_id,false);
  if p_relation_id is null then raise exception 'CONTEXT_RELATION_ID_REQUIRED' using errcode='22023'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'CONTEXT_EVIDENCE_LIMIT_OUT_OF_RANGE' using errcode='22023'; end if;
  if p_offset is null or p_offset<0 or p_offset>100000 then raise exception 'CONTEXT_EVIDENCE_OFFSET_OUT_OF_RANGE' using errcode='22023'; end if;
  can_edit := coalesce(auth.role(),'')='service_role' or public.can_edit_project(p_project_id);
  select relation.* into relation_row from public.context_relations relation
  where relation.id=p_relation_id and relation.project_id=p_project_id and relation.deleted_at is null;
  if not found
     or (relation_row.privacy_status='confidential' and not can_edit)
     or not security_private.context_entity_visible_v2(
       p_project_id,relation_row.source_entity_type,relation_row.source_entity_id,can_edit
     )
     or not security_private.context_entity_visible_v2(
       p_project_id,relation_row.target_entity_type,relation_row.target_entity_id,can_edit
     ) then
    raise exception 'CONTEXT_RELATION_NOT_FOUND' using errcode='P0002';
  end if;

  with evidence_rows as (
    select evidence.id,'generic'::text as evidence_source,
      evidence.evidence_entity_type,evidence.evidence_entity_id,
      null::text as evidence_kind,evidence.citation_id,evidence.document_fragment_id,
      evidence.source_locator,evidence.excerpt,evidence.lock_version,
      evidence.created_at,evidence.updated_at
    from public.context_relation_evidence_links evidence
    where evidence.relation_id=relation_row.id and evidence.project_id=p_project_id
      and evidence.deleted_at is null
      and (
        evidence.evidence_entity_id is null
        or security_private.context_entity_visible_v2(
          p_project_id,evidence.evidence_entity_type,evidence.evidence_entity_id,can_edit
        )
      )
    union all
    select evidence.id,'person_v1'::text,
      case
        when evidence.source_document_id is not null then 'document'
        when evidence.source_finding_id is not null then 'finding'
        when evidence.source_event_id is not null then 'event'
        else null
      end,
      coalesce(evidence.source_document_id,evidence.source_finding_id,evidence.source_event_id),
      evidence.evidence_kind,evidence.citation_id,evidence.document_fragment_id,
      evidence.source_locator,evidence.excerpt,evidence.lock_version,
      evidence.created_at,evidence.updated_at
    from public.context_relation_evidence evidence
    where relation_row.person_context_relation_id is not null
      and evidence.relation_id=relation_row.person_context_relation_id
      and evidence.project_id=p_project_id and evidence.deleted_at is null
      and (evidence.source_document_id is null or security_private.context_entity_visible_v2(
        p_project_id,'document',evidence.source_document_id,can_edit
      ))
      and (evidence.source_finding_id is null or security_private.context_entity_visible_v2(
        p_project_id,'finding',evidence.source_finding_id,can_edit
      ))
      and (evidence.source_event_id is null or security_private.context_entity_visible_v2(
        p_project_id,'event',evidence.source_event_id,can_edit
      ))
  ), ranked as (
    select row_number() over(order by evidence.created_at,evidence.id) row_number,evidence.*
    from evidence_rows evidence
  ), page as (
    select ranked.* from ranked
    where ranked.row_number>p_offset and ranked.row_number<=p_offset+p_limit
  )
  select jsonb_build_object(
    'relationId',p_relation_id,
    'items',coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id',page.id,'evidenceSource',page.evidence_source,
      'evidenceEntityType',page.evidence_entity_type,'evidenceEntityId',page.evidence_entity_id,
      'evidenceKind',page.evidence_kind,'citationId',page.citation_id,
      'documentFragmentId',page.document_fragment_id,'sourceLocator',page.source_locator,
      'excerpt',page.excerpt,'lockVersion',page.lock_version,
      'createdAt',page.created_at,'updatedAt',page.updated_at
    )) order by page.row_number),'[]'::jsonb),
    'count',(select count(*) from evidence_rows),
    'limit',p_limit,'offset',p_offset
  ) into result from page;
  return result;
end;
$function$;

drop function if exists public.list_context_relation_evidence_v2(uuid,uuid,integer,integer);

create or replace function public.get_context_relation_evidence_v2(
  p_project_id uuid,p_relation_id uuid,p_limit integer default 50,p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_context_relation_evidence_v2($1,$2,$3,$4);
$wrapper$;


create or replace function security_private.context_entity_visible_v2(
  p_project_id uuid,p_entity_type text,p_entity_id uuid,p_can_edit boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare row_data jsonb;
declare owner_person_id uuid;
begin
  if not security_private.context_entity_exists_v2(
    p_project_id,lower(coalesce(p_entity_type,'')),p_entity_id
  ) then return false; end if;
  if coalesce(p_can_edit,false) then return true; end if;
  case lower(p_entity_type)
    when 'person' then
      return not security_private.context_entity_is_masked_v2(p_project_id,'person',p_entity_id,false);
    when 'event' then
      select event.person_id into owner_person_id from public.person_timeline_events event
      where event.id=p_entity_id and event.project_id=p_project_id;
      return not security_private.context_entity_is_masked_v2(p_project_id,'person',owner_person_id,false);
    when 'document' then select to_jsonb(document) into row_data from public.documents document where document.id=p_entity_id and document.project_id=p_project_id;
    when 'finding' then select to_jsonb(finding) into row_data from public.findings finding where finding.id=p_entity_id and finding.project_id=p_project_id;
    when 'hypothesis' then select to_jsonb(hypothesis) into row_data from public.hypotheses hypothesis where hypothesis.id=p_entity_id and hypothesis.project_id=p_project_id;
    when 'source' then select to_jsonb(source) into row_data from public.document_sources source where source.id=p_entity_id and source.project_id=p_project_id;
    when 'family' then select to_jsonb(group_row) into row_data from public.family_groups group_row where group_row.id=p_entity_id and group_row.project_id=p_project_id;
    else return true;
  end case;
  if coalesce(row_data->>'privacy_status','')='confidential' then return false; end if;
  return true;
end;
$function$;

create or replace function security_private.context_entity_secondary_label_v2(
  p_project_id uuid,p_entity_type text,p_entity_id uuid,p_can_edit boolean
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result text;
begin
  if not security_private.context_entity_visible_v2(
    p_project_id,p_entity_type,p_entity_id,p_can_edit
  ) then return ''; end if;
  case lower(p_entity_type)
    when 'person' then
      select nullif(btrim(concat_ws(' – ',nullif(person.birth_date,''),nullif(person.death_date,''))),'') into result
      from public.persons person where person.id=p_entity_id and person.project_id=p_project_id;
    when 'family' then select group_row.group_type into result from public.family_groups group_row where group_row.id=p_entity_id and group_row.project_id=p_project_id;
    when 'place' then select nullif(place.modern_name,'') into result from public.places place where place.id=p_entity_id;
    when 'event' then
      select coalesce(nullif(event.date_text,''),nullif(event.event_date,''),nullif(event.place_name,'')) into result
      from public.person_timeline_events event where event.id=p_entity_id and event.project_id=p_project_id;
    when 'document' then
      select nullif(btrim(concat_ws('–',nullif(document.year_from,''),nullif(document.year_to,''))),'') into result
      from public.documents document where document.id=p_entity_id and document.project_id=p_project_id;
    when 'finding' then
      select coalesce(nullif(finding.event_date,''),nullif(finding.place,'')) into result
      from public.findings finding where finding.id=p_entity_id and finding.project_id=p_project_id;
    when 'source' then select source.provider into result from public.document_sources source where source.id=p_entity_id and source.project_id=p_project_id;
    when 'repository' then select coalesce(nullif(resource.archive_name,''),resource.resource_type) into result from public.archive_resources resource where resource.id=p_entity_id;
    when 'hypothesis' then select nullif(hypothesis.status,'') into result from public.hypotheses hypothesis where hypothesis.id=p_entity_id and hypothesis.project_id=p_project_id;
  end case;
  return coalesce(result,'');
end;
$function$;

create or replace function security_private.context_entity_metadata_v2(
  p_project_id uuid,p_entity_type text,p_entity_id uuid,p_can_edit boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb := '{}'::jsonb;
begin
  if not security_private.context_entity_visible_v2(
    p_project_id,p_entity_type,p_entity_id,p_can_edit
  ) then return '{}'::jsonb; end if;
  case lower(p_entity_type)
    when 'person' then
      select jsonb_strip_nulls(jsonb_build_object(
        'isLiving',person.is_living,'privacyStatus',person.privacy_status,
        'gender',nullif(person.gender,''),'birthDate',nullif(person.birth_date,''),
        'deathDate',nullif(person.death_date,'')
      )) into result from public.persons person where person.id=p_entity_id and person.project_id=p_project_id;
    when 'family' then
      select jsonb_build_object('groupType',group_row.group_type) into result
      from public.family_groups group_row where group_row.id=p_entity_id and group_row.project_id=p_project_id;
    when 'place' then
      select jsonb_strip_nulls(jsonb_build_object(
        'modernName',nullif(place.modern_name,''),'latitude',place.latitude,
        'longitude',place.longitude,'verificationStatus',place.verification_status
      )) into result from public.places place where place.id=p_entity_id;
    when 'event' then
      select jsonb_strip_nulls(jsonb_build_object(
        'eventType',event.event_type,'dateText',nullif(event.date_text,''),
        'eventDate',nullif(event.event_date,''),'placeName',nullif(event.place_name,''),
        -- personId is intentionally the only navigation identifier exposed.
        'personId',event.person_id
      )) into result from public.person_timeline_events event where event.id=p_entity_id and event.project_id=p_project_id;
    when 'document' then
      select jsonb_strip_nulls(jsonb_build_object(
        'documentType',nullif(document.document_type,''),'yearFrom',nullif(document.year_from,''),
        'yearTo',nullif(document.year_to,''),'place',nullif(document.place,'')
      )) into result from public.documents document where document.id=p_entity_id and document.project_id=p_project_id;
    when 'finding' then
      select jsonb_strip_nulls(jsonb_build_object(
        'findingType',nullif(finding.finding_type,''),'eventDate',nullif(finding.event_date,''),
        'place',nullif(finding.place,''),'reliability',nullif(finding.reliability,'')
      )) into result from public.findings finding where finding.id=p_entity_id and finding.project_id=p_project_id;
    when 'source' then
      select jsonb_strip_nulls(jsonb_build_object('provider',source.provider,'status',source.status,'documentId',source.document_id))
      into result from public.document_sources source where source.id=p_entity_id and source.project_id=p_project_id;
    when 'repository' then
      select jsonb_strip_nulls(jsonb_build_object('resourceType',resource.resource_type,'archiveName',nullif(resource.archive_name,''),'isPublic',resource.is_public))
      into result from public.archive_resources resource where resource.id=p_entity_id;
    when 'hypothesis' then
      select jsonb_strip_nulls(jsonb_build_object('status',nullif(hypothesis.status,''),'probability',nullif(hypothesis.probability,'')))
      into result from public.hypotheses hypothesis where hypothesis.id=p_entity_id and hypothesis.project_id=p_project_id;
  end case;
  return coalesce(result,'{}'::jsonb);
end;
$function$;

create or replace function security_private.hypothesis_link_context_id_v1(
  p_project_id uuid,p_hypothesis_id uuid,p_target_type text,p_target_id uuid
)
returns uuid
language sql
immutable
security definer
set search_path = pg_catalog
as $function$
  select (
    substr(hash_value,1,8)||'-'||substr(hash_value,9,4)||'-'||
    substr(hash_value,13,4)||'-'||substr(hash_value,17,4)||'-'||substr(hash_value,21,12)
  )::uuid
  from (
    select md5('hypothesis_links:'||p_project_id::text||':'||p_hypothesis_id::text||':'||lower(p_target_type)||':'||p_target_id::text) hash_value
  ) value;
$function$;

create or replace function security_private.context_relation_union_v2(
  p_project_id uuid
)
returns table (
  id uuid,project_id uuid,relation_type_id uuid,
  source_entity_type text,source_entity_id uuid,target_entity_type text,target_entity_id uuid,
  source_role_label text,target_role_label text,valid_from date,valid_to date,period_text text,
  evidence_status text,confidence integer,privacy_status text,assertion_kind text,
  metadata jsonb,person_context_relation_id uuid,lock_version integer,
  updated_at timestamptz,evidence_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select relation.id,relation.project_id,relation.relation_type_id,
    relation.source_entity_type,relation.source_entity_id,
    relation.target_entity_type,relation.target_entity_id,
    relation.source_role_label,relation.target_role_label,
    relation.valid_from,relation.valid_to,relation.period_text,
    relation.evidence_status,relation.confidence,relation.privacy_status,
    relation.assertion_kind,relation.metadata,relation.person_context_relation_id,
    relation.lock_version,relation.updated_at,
    security_private.context_relation_evidence_count_v2(relation)
  from public.context_relations relation
  where relation.project_id=p_project_id and relation.deleted_at is null
  union all
  select
    security_private.hypothesis_link_context_id_v1(link.project_id,link.hypothesis_id,link.target_type,link.target_id),
    link.project_id,relation_type.id,
    link.target_type,link.target_id,'hypothesis'::text,link.hypothesis_id,
    'Підтвердження'::text,'Гіпотеза'::text,null::date,null::date,''::text,
    'unknown'::text,0,'project'::text,'legacy_import'::text,
    jsonb_build_object('compatibilityProjection','hypothesis_links'),
    null::uuid,1,hypothesis.updated_at,0
  from public.hypothesis_links link
  join public.hypotheses hypothesis
    on hypothesis.id=link.hypothesis_id and hypothesis.project_id=link.project_id
  join public.context_relation_types relation_type
    on relation_type.project_id is null and relation_type.is_system
   and relation_type.code='supports_hypothesis' and relation_type.is_active
  where link.project_id=p_project_id
    and link.target_type in ('person','document','finding');
$function$;


drop trigger if exists context_relation_types_05_system_code_guard on public.context_relation_types;
create trigger context_relation_types_05_system_code_guard
before insert or update on public.context_relation_types
for each row execute function security_private.guard_context_relation_type_system_code_v2();

create or replace function security_private.context_entity_label_v2(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_can_edit boolean
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result text;
begin
  if security_private.context_entity_is_masked_v2(
    p_project_id,p_entity_type,p_entity_id,p_can_edit
  ) then return 'Приватна особа'; end if;
  if not security_private.context_entity_visible_v2(
    p_project_id,p_entity_type,p_entity_id,p_can_edit
  ) then return 'Недоступна сутність'; end if;
  case lower(p_entity_type)
    when 'person' then
      select coalesce(nullif(person.full_name,''),nullif(btrim(concat_ws(' ',person.surname,person.given_name,person.patronymic)),''),'Особа')
      into result from public.persons person where person.id=p_entity_id and person.project_id=p_project_id;
    when 'family' then
      select coalesce(nullif(group_row.display_label,''),'Родина') into result
      from public.family_groups group_row where group_row.id=p_entity_id and group_row.project_id=p_project_id;
    when 'place' then select place.canonical_name into result from public.places place where place.id=p_entity_id;
    when 'event' then
      select coalesce(nullif(event.title,''),nullif(event.event_type,''),'Подія') into result
      from public.person_timeline_events event where event.id=p_entity_id and event.project_id=p_project_id;
    when 'document' then select document.title into result from public.documents document where document.id=p_entity_id and document.project_id=p_project_id;
    when 'finding' then
      select left(coalesce(nullif(finding.summary,''),nullif(finding.description,''),nullif(finding.finding_type,''),'Знахідка'),240)
      into result from public.findings finding where finding.id=p_entity_id and finding.project_id=p_project_id;
    when 'source' then
      select left(coalesce(nullif(source.display_name,''),nullif(source.provider_file_title,''),nullif(source.source_page_url,''),source.original_url,'Джерело'),240)
      into result from public.document_sources source where source.id=p_entity_id and source.project_id=p_project_id;
    when 'repository' then select resource.title into result from public.archive_resources resource where resource.id=p_entity_id;
    when 'hypothesis' then select hypothesis.title into result from public.hypotheses hypothesis where hypothesis.id=p_entity_id and hypothesis.project_id=p_project_id;
  end case;
  return coalesce(nullif(result,''),initcap(p_entity_type));
end;
$function$;

do $context_research_hardening_acl$
declare function_record record;
begin
  for function_record in
    select procedure.oid::regprocedure signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='security_private'
      and procedure.proname=any(array[
        'guard_context_relation_type_system_code_v2',
        'context_entity_visible_v2','context_entity_label_v2',
        'context_entity_secondary_label_v2','context_entity_metadata_v2',
        'hypothesis_link_context_id_v1','context_relation_union_v2',
        'archive_context_evidence_with_parent_v1','cleanup_context_endpoint_v2',
        'list_context_relation_evidence_v2','get_person_research_context_graph_v1'
      ]::text[])
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',function_record.signature);
  end loop;
end;
$context_research_hardening_acl$;

grant execute on function security_private.list_context_relation_evidence_v2(uuid,uuid,integer,integer)
to authenticated,service_role;
grant execute on function security_private.get_person_research_context_graph_v1(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer
) to authenticated,service_role;

revoke all on function public.get_context_relation_evidence_v2(uuid,uuid,integer,integer)
from public,anon,authenticated,service_role;
grant execute on function public.get_context_relation_evidence_v2(uuid,uuid,integer,integer)
to authenticated,service_role;
revoke all on function public.get_person_research_context_graph_v1(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer
) from public,anon,authenticated,service_role;
grant execute on function public.get_person_research_context_graph_v1(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer
) to authenticated,service_role;

notify pgrst, 'reload schema';
analyze public.context_relations;
analyze public.context_relation_evidence_links;

commit;
