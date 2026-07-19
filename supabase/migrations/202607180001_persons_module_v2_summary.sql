begin;

-- Return the light-weight counters needed by the persons V2 catalogue in one
-- statement. SECURITY INVOKER is intentional: every source relation, and most
-- importantly public.persons, remains filtered by the caller's current RLS
-- policies (including the living-person privacy policy).
create or replace function public.list_person_summaries(target_project_id uuid)
returns table (
  person_id uuid,
  relation_count bigint,
  task_count bigint,
  hypothesis_count bigint,
  archive_request_count bigint,
  finding_count bigint,
  document_count bigint,
  last_event_type text,
  last_event_date text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with relation_links as (
    select
      relation.person_id,
      relation.id as relation_id
    from public.person_relations relation
    where relation.project_id = target_project_id

    union all

    select
      relation.related_person_id as person_id,
      relation.id as relation_id
    from public.person_relations relation
    where relation.project_id = target_project_id
  ),
  relation_counts as (
    select
      link.person_id,
      pg_catalog.count(distinct link.relation_id) as relation_count
    from relation_links link
    group by link.person_id
  ),
  task_counts as (
    select
      link.person_id,
      pg_catalog.count(distinct link.task_id) as task_count
    from public.task_persons link
    where link.project_id = target_project_id
    group by link.person_id
  ),
  hypothesis_counts as (
    select
      link.target_id as person_id,
      pg_catalog.count(distinct link.hypothesis_id) as hypothesis_count
    from public.hypothesis_links link
    where link.project_id = target_project_id
      and link.target_type = 'person'
    group by link.target_id
  ),
  archive_request_counts as (
    select
      link.person_id,
      pg_catalog.count(distinct link.archive_request_id) as archive_request_count
    from public.archive_request_persons link
    where link.project_id = target_project_id
    group by link.person_id
  ),
  finding_links as (
    select
      finding.project_id,
      participant.person_id::text as person_id_text,
      finding.id as finding_id,
      finding.document_id
    from public.findings finding
    join public.finding_participants participant
      on participant.project_id = finding.project_id
     and participant.finding_id = finding.id
    where finding.project_id = target_project_id
      and participant.person_id is not null

    union all

    select
      finding.project_id,
      pg_catalog.lower(pg_catalog.btrim(metadata_person.person_id_text)) as person_id_text,
      finding.id as finding_id,
      finding.document_id
    from public.findings finding
    cross join lateral pg_catalog.jsonb_array_elements_text(
      case
        when pg_catalog.jsonb_typeof(
          finding.custom_fields #> '{__trackerRoduFindingMeta,personIds}'
        ) = 'array'
          then finding.custom_fields #> '{__trackerRoduFindingMeta,personIds}'
        else '[]'::jsonb
      end
    ) as metadata_person(person_id_text)
    where finding.project_id = target_project_id
  ),
  finding_counts as (
    select
      link.person_id_text,
      pg_catalog.count(distinct link.finding_id) as finding_count
    from finding_links link
    where link.person_id_text is not null
      and link.person_id_text <> ''
    group by link.person_id_text
  ),
  person_document_links as (
    select
      link.project_id,
      link.person_id_text,
      link.document_id
    from finding_links link
    where link.document_id is not null

    union all

    select
      link.project_id,
      link.person_id::text as person_id_text,
      task.document_id
    from public.task_persons link
    join public.tasks task
      on task.project_id = link.project_id
     and task.id = link.task_id
    where link.project_id = target_project_id
      and task.document_id is not null

    union all

    select
      person_link.project_id,
      person_link.target_id::text as person_id_text,
      document_link.target_id as document_id
    from public.hypothesis_links person_link
    join public.hypothesis_links document_link
      on document_link.project_id = person_link.project_id
     and document_link.hypothesis_id = person_link.hypothesis_id
     and document_link.target_type = 'document'
    where person_link.project_id = target_project_id
      and person_link.target_type = 'person'
  ),
  document_counts as (
    select
      link.person_id_text,
      pg_catalog.count(distinct document.id) as document_count
    from person_document_links link
    join public.documents document
      on document.project_id = link.project_id
     and document.id = link.document_id
    where link.person_id_text is not null
      and link.person_id_text <> ''
    group by link.person_id_text
  ),
  ranked_events as (
    select
      event.person_id,
      event.event_type,
      coalesce(
        nullif(event.event_date, ''),
        nullif(event.date_to, ''),
        nullif(event.date_from, ''),
        nullif(event.date_text, '')
      ) as display_event_date,
      pg_catalog.row_number() over (
        partition by event.person_id
        order by
          coalesce(
            nullif(event.event_date, ''),
            nullif(event.date_to, ''),
            nullif(event.date_from, '')
          ) desc nulls last,
          event.updated_at desc,
          event.id desc
      ) as event_rank
    from public.person_timeline_events event
    where event.project_id = target_project_id
  ),
  last_events as (
    select
      event.person_id,
      event.event_type,
      event.display_event_date
    from ranked_events event
    where event.event_rank = 1
  )
  select
    person.id as person_id,
    coalesce(relations.relation_count, 0::bigint) as relation_count,
    coalesce(tasks.task_count, 0::bigint) as task_count,
    coalesce(hypotheses.hypothesis_count, 0::bigint) as hypothesis_count,
    coalesce(requests.archive_request_count, 0::bigint) as archive_request_count,
    coalesce(findings.finding_count, 0::bigint) as finding_count,
    coalesce(documents.document_count, 0::bigint) as document_count,
    last_event.event_type as last_event_type,
    last_event.display_event_date as last_event_date
  from public.persons person
  left join relation_counts relations on relations.person_id = person.id
  left join task_counts tasks on tasks.person_id = person.id
  left join hypothesis_counts hypotheses on hypotheses.person_id = person.id
  left join archive_request_counts requests on requests.person_id = person.id
  left join finding_counts findings on findings.person_id_text = person.id::text
  left join document_counts documents on documents.person_id_text = person.id::text
  left join last_events last_event on last_event.person_id = person.id
  where person.project_id = target_project_id
  order by person.updated_at desc, person.id asc;
$function$;

comment on function public.list_person_summaries(uuid) is
  'RLS-aware aggregate counters and latest timeline event for the persons V2 catalogue.';

revoke all on function public.list_person_summaries(uuid) from public, anon;
grant execute on function public.list_person_summaries(uuid) to authenticated;

commit;
