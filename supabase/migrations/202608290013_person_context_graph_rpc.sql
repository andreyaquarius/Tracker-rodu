begin;

-- A pre-commit local preview of this migration exposed the former eight-
-- argument signature. Remove that preview overload first so named PostgREST
-- calls can never resolve ambiguously after the bounded edge argument was
-- added. Fresh environments simply skip these statements.
drop function if exists public.get_person_context_graph_v1(
  uuid, uuid, integer, integer, uuid[], text[], date, date
);
drop function if exists security_private.get_person_context_graph_v1(
  uuid, uuid, integer, integer, uuid[], text[], date, date
);

-- The first bounded contextual graph read model intentionally exposes only
-- Person nodes backed by person_context_relations. It is project-scoped and
-- never reads or mutates the classic family-tree graph.
create or replace function security_private.get_person_context_graph_v1(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 1,
  p_max_nodes integer default 100,
  p_relation_type_ids uuid[] default null,
  p_evidence_statuses text[] default null,
  p_valid_from date default null,
  p_valid_to date default null,
  p_max_edges integer default 250
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
  can_edit boolean;
  max_edges integer;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);

  if p_center_person_id is null then
    raise exception 'CONTEXT_GRAPH_CENTER_PERSON_REQUIRED' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.persons person
    where person.id = p_center_person_id
      and person.project_id = p_project_id
  ) then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode = 'P0002';
  end if;
  if p_depth is null or p_depth <> 1 then
    raise exception 'CONTEXT_GRAPH_DEPTH_UNSUPPORTED' using errcode = '22023';
  end if;
  if p_max_nodes is null or p_max_nodes < 1 or p_max_nodes > 100 then
    raise exception 'CONTEXT_GRAPH_MAX_NODES_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_valid_from is not null and p_valid_to is not null and p_valid_from > p_valid_to then
    raise exception 'CONTEXT_GRAPH_DATE_RANGE_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_evidence_statuses, array[]::text[])) as requested_status(status)
    where requested_status.status is null
       or requested_status.status not in ('proven', 'likely', 'disputed', 'disproven', 'unknown')
  ) then
    raise exception 'CONTEXT_GRAPH_EVIDENCE_STATUS_INVALID' using errcode = '22023';
  end if;

  -- Keep the optional trailing argument backward-safe while enforcing a hard
  -- server-side ceiling even when a client sends an excessive or null value.
  max_edges := least(greatest(coalesce(p_max_edges, 250), 1), 500);

  can_edit := coalesce(auth.role(), '') = 'service_role'
    or public.can_edit_project(p_project_id);

  -- Foundation semantics are intentional: `private` is visible inside the
  -- project, while `confidential` is editor-only. Endpoint privacy still hides
  -- relations touching living private/confidential people from non-editors.
  with visible_relations as materialized (
    select
      relation.*,
      relation_type.code as relation_type_code,
      relation_type.label_uk as relation_type_label,
      relation_type.category as relation_category,
      relation_type.directionality,
      case
        when relation.source_person_id = p_center_person_id then relation.target_person_id
        else relation.source_person_id
      end as neighbor_person_id
    from public.person_context_relations relation
    join public.context_relation_types relation_type
      on relation_type.id = relation.relation_type_id
     and (relation_type.project_id is null or relation_type.project_id = p_project_id)
    where relation.project_id = p_project_id
      and relation.deleted_at is null
      and (
        relation.source_person_id = p_center_person_id
        or relation.target_person_id = p_center_person_id
      )
      and (relation.privacy_status <> 'confidential' or can_edit)
      and (
        can_edit
        or not exists (
          select 1
          from public.persons private_endpoint
          where private_endpoint.project_id = relation.project_id
            and private_endpoint.id in (
              relation.source_person_id,
              relation.target_person_id
            )
            and private_endpoint.is_living
            and private_endpoint.privacy_status in ('private', 'confidential')
        )
      )
      and (
        cardinality(coalesce(p_relation_type_ids, array[]::uuid[])) = 0
        or relation.relation_type_id = any(p_relation_type_ids)
      )
      and (
        cardinality(coalesce(p_evidence_statuses, array[]::text[])) = 0
        or relation.evidence_status = any(p_evidence_statuses)
      )
      -- Date filters select assertions whose open or closed validity interval
      -- overlaps the requested interval. Undated assertions are open-ended.
      and (
        p_valid_from is null
        or relation.valid_to is null
        or relation.valid_to >= p_valid_from
      )
      and (
        p_valid_to is null
        or relation.valid_from is null
        or relation.valid_from <= p_valid_to
      )
  ), neighbor_activity as (
    select
      visible.neighbor_person_id,
      max(visible.updated_at) as latest_relation_at
    from visible_relations visible
    group by visible.neighbor_person_id
  ), ranked_neighbors as (
    select
      neighbor.neighbor_person_id,
      row_number() over (
        order by neighbor.latest_relation_at desc, neighbor.neighbor_person_id
      ) as neighbor_rank
    from neighbor_activity neighbor
  ), selected_neighbors as (
    select ranked.neighbor_person_id, ranked.neighbor_rank
    from ranked_neighbors ranked
    where ranked.neighbor_rank <= greatest(p_max_nodes - 1, 0)
  ), candidate_relations as materialized (
    select
      visible.*,
      selected.neighbor_rank,
      row_number() over (
        partition by visible.neighbor_person_id
        order by visible.updated_at desc, visible.id
      ) as neighbor_edge_rank
    from visible_relations visible
    join selected_neighbors selected
      on selected.neighbor_person_id = visible.neighbor_person_id
  ), ranked_relations as materialized (
    select
      candidate.*,
      row_number() over (
        -- Round-robin by neighbor first. This keeps the chosen subgraph useful
        -- under a small edge budget and is deterministic for equal timestamps.
        order by
          candidate.neighbor_edge_rank,
          candidate.neighbor_rank,
          candidate.updated_at desc,
          candidate.id
      ) as edge_rank
    from candidate_relations candidate
  ), selected_relations as materialized (
    select ranked.*
    from ranked_relations ranked
    where ranked.edge_rank <= max_edges
  ), graph_people as (
    select p_center_person_id as person_id
    union
    select selected.neighbor_person_id
    from selected_relations selected
  ), node_rows as (
    select
      person.id,
      person.id = p_center_person_id as is_center,
      person.is_living
        and person.privacy_status in ('private', 'confidential')
        and not can_edit as is_masked,
      jsonb_strip_nulls(jsonb_build_object(
        'id', person.id,
        'entityType', 'person',
        'isCenter', person.id = p_center_person_id,
        'displayName', case
          when person.is_living
            and person.privacy_status in ('private', 'confidential')
            and not can_edit
          then 'Приватна особа'
          else coalesce(
            nullif(person.full_name, ''),
            nullif(trim(concat_ws(' ', person.surname, person.given_name, person.patronymic)), ''),
            'Особа'
          )
        end,
        'givenName', case
          when person.is_living
            and person.privacy_status in ('private', 'confidential')
            and not can_edit then null
          else nullif(person.given_name, '')
        end,
        'surname', case
          when person.is_living
            and person.privacy_status in ('private', 'confidential')
            and not can_edit then null
          else nullif(person.surname, '')
        end,
        'patronymic', case
          when person.is_living
            and person.privacy_status in ('private', 'confidential')
            and not can_edit then null
          else nullif(person.patronymic, '')
        end,
        'gender', case
          when person.is_living
            and person.privacy_status in ('private', 'confidential')
            and not can_edit then ''
          else person.gender
        end,
        'sex', case
          when person.is_living
            and person.privacy_status in ('private', 'confidential')
            and not can_edit then 'unknown'
          when lower(person.gender) in ('male', 'm', 'чоловік', 'чоловіча') then 'male'
          when lower(person.gender) in ('female', 'f', 'жінка', 'жіноча') then 'female'
          when lower(person.gender) in ('other', 'інша', 'інше') then 'other'
          else 'unknown'
        end,
        'isLiving', person.is_living,
        'isPrivate', person.privacy_status in ('private', 'confidential'),
        'masked', person.is_living
          and person.privacy_status in ('private', 'confidential')
          and not can_edit,
        'degree', (
          select count(*)
          from selected_relations graph_relation
          where graph_relation.source_person_id = person.id
             or graph_relation.target_person_id = person.id
        )
      )) as payload
    from graph_people graph_person
    join public.persons person
      on person.id = graph_person.person_id
     and person.project_id = p_project_id
  ), edge_rows as (
    select
      relation.id,
      relation.updated_at,
      jsonb_build_object(
        'id', relation.id,
        'sourcePersonId', relation.source_person_id,
        'targetPersonId', relation.target_person_id,
        'relationTypeId', relation.relation_type_id,
        'relationTypeCode', relation.relation_type_code,
        'relationTypeLabel', relation.relation_type_label,
        'category', relation.relation_category,
        'directionality', relation.directionality,
        'sourceRoleLabel', relation.source_role_label,
        'targetRoleLabel', relation.target_role_label,
        'validFrom', relation.valid_from,
        'validTo', relation.valid_to,
        'periodText', relation.period_text,
        'evidenceStatus', relation.evidence_status,
        'confidence', relation.confidence,
        'privacyStatus', relation.privacy_status,
        'assertionKind', relation.assertion_kind,
        'evidenceCount', (
          select count(*)
          from public.context_relation_evidence evidence
          where evidence.relation_id = relation.id
            and evidence.project_id = p_project_id
            and evidence.deleted_at is null
        ),
        'createdAt', relation.created_at,
        'updatedAt', relation.updated_at
      ) as payload
    from selected_relations relation
  )
  select jsonb_build_object(
    'centerPersonId', p_center_person_id,
    'nodes', coalesce((
      select jsonb_agg(node.payload order by node.is_center desc, node.id)
      from node_rows node
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(edge.payload order by edge.updated_at desc, edge.id)
      from edge_rows edge
    ), '[]'::jsonb),
    'revision', coalesce((
      select graph_revision.revision
      from public.context_graph_revisions graph_revision
      where graph_revision.project_id = p_project_id
    ), 0),
    'truncated', (
      select count(*) > greatest(p_max_nodes - 1, 0)
      from ranked_neighbors
    ),
    'edgesTruncated', (
      select count(*) > max_edges
      from ranked_relations
    )
  )
  into result;

  return result;
end;
$function$;

-- Lightweight profile-list read model. Unlike the foundation list RPC, it
-- never embeds evidence rows; callers receive only an evidence count and can
-- load evidence separately when a relation is opened.
create or replace function security_private.list_person_context_relation_summaries_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_include_deleted boolean default false,
  p_limit integer default 100,
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
  can_edit boolean;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);

  if p_person_id is null then
    raise exception 'CONTEXT_RELATION_PERSON_REQUIRED' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.persons person
    where person.id = p_person_id
      and person.project_id = p_project_id
  ) then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'CONTEXT_RELATION_LIMIT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception 'CONTEXT_RELATION_OFFSET_OUT_OF_RANGE' using errcode = '22023';
  end if;

  can_edit := coalesce(auth.role(), '') = 'service_role'
    or public.can_edit_project(p_project_id);

  with visible as materialized (
    select relation.*
    from public.person_context_relations relation
    where relation.project_id = p_project_id
      and (
        relation.source_person_id = p_person_id
        or relation.target_person_id = p_person_id
      )
      and (coalesce(p_include_deleted, false) or relation.deleted_at is null)
      -- Same privacy contract as the foundation list RPC: project-private is
      -- member-visible; confidential assertions require edit access.
      and (relation.privacy_status <> 'confidential' or can_edit)
      and (
        can_edit
        or not exists (
          select 1
          from public.persons endpoint
          where endpoint.project_id = relation.project_id
            and endpoint.id in (
              relation.source_person_id,
              relation.target_person_id
            )
            and endpoint.is_living
            and endpoint.privacy_status in ('private', 'confidential')
        )
      )
  ), summary_page as materialized (
    select visible.*
    from visible
    order by visible.updated_at desc, visible.id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        (
          security_private.context_relation_json_v1(relation_row, false)
          - 'evidence'
          || jsonb_build_object(
            'evidenceCount', (
              select count(*)
              from public.context_relation_evidence evidence
              where evidence.project_id = p_project_id
                and evidence.relation_id = relation_row.id
                and evidence.deleted_at is null
            )
          )
        )
        order by relation_row.updated_at desc, relation_row.id
      )
      from summary_page
      join public.person_context_relations relation_row
        on relation_row.id = summary_page.id
       and relation_row.project_id = p_project_id
    ), '[]'::jsonb),
    'total', (select count(*) from visible),
    'revision', coalesce((
      select graph_revision.revision
      from public.context_graph_revisions graph_revision
      where graph_revision.project_id = p_project_id
    ), 0)
  )
  into result;

  return result;
end;
$function$;

-- Data API facade remains SECURITY INVOKER. The private body re-checks project
-- membership and performs all privacy filtering before building the payload.
create or replace function public.get_person_context_graph_v1(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 1,
  p_max_nodes integer default 100,
  p_relation_type_ids uuid[] default null,
  p_evidence_statuses text[] default null,
  p_valid_from date default null,
  p_valid_to date default null,
  p_max_edges integer default 250
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_person_context_graph_v1(
    $1, $2, $3, $4, $5, $6, $7, $8, $9
  );
$wrapper$;

create or replace function public.list_person_context_relation_summaries_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_include_deleted boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_person_context_relation_summaries_v1(
    $1, $2, $3, $4, $5
  );
$wrapper$;

revoke all on function security_private.get_person_context_graph_v1(
  uuid, uuid, integer, integer, uuid[], text[], date, date, integer
) from public, anon, authenticated, service_role;
grant execute on function security_private.get_person_context_graph_v1(
  uuid, uuid, integer, integer, uuid[], text[], date, date, integer
) to authenticated, service_role;

revoke all on function public.get_person_context_graph_v1(
  uuid, uuid, integer, integer, uuid[], text[], date, date, integer
) from public, anon, authenticated, service_role;
grant execute on function public.get_person_context_graph_v1(
  uuid, uuid, integer, integer, uuid[], text[], date, date, integer
) to authenticated, service_role;

revoke all on function security_private.list_person_context_relation_summaries_v1(
  uuid, uuid, boolean, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function security_private.list_person_context_relation_summaries_v1(
  uuid, uuid, boolean, integer, integer
) to authenticated, service_role;

revoke all on function public.list_person_context_relation_summaries_v1(
  uuid, uuid, boolean, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.list_person_context_relation_summaries_v1(
  uuid, uuid, boolean, integer, integer
) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
