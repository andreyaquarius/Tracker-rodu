begin;

-- Preserve the legacy JSON links, including upper-case/space-padded IDs, without
-- expanding every finding's metadata on every catalogue page request.
create or replace function public.finding_summary_person_ids_v1(value jsonb)
returns text[] language sql immutable parallel safe security invoker
set search_path = ''
as $function$
  select coalesce(array_agg(distinct lower(btrim(item))), '{}'::text[])
  from jsonb_array_elements_text(case
    when jsonb_typeof(value #> '{__trackerRoduFindingMeta,personIds}') = 'array'
      then value #> '{__trackerRoduFindingMeta,personIds}'
    else '[]'::jsonb end) as items(item)
  where nullif(btrim(item), '') is not null
$function$;

revoke all on function public.finding_summary_person_ids_v1(jsonb) from public, anon;
grant execute on function public.finding_summary_person_ids_v1(jsonb) to authenticated, service_role;

create index if not exists findings_summary_person_ids_gin_idx on public.findings
using gin (public.finding_summary_person_ids_v1(custom_fields));

-- A bounded replacement, not an unbounded v1 fallback. Every source table
-- remains subject to the caller's RLS, including documents and living persons.
create or replace function public.list_person_summaries_v2(
  target_project_id uuid, target_person_ids uuid[]
)
returns table (
  person_id uuid, relation_count bigint, task_count bigint, hypothesis_count bigint,
  archive_request_count bigint, finding_count bigint, document_count bigint,
  last_event_type text, last_event_date text
)
language sql stable security invoker set search_path = ''
as $function$
  with selected_persons as materialized (
    select person.id, person.updated_at
    from public.persons person
    where person.project_id = target_project_id
      and person.id = any(target_person_ids)
      and cardinality(target_person_ids) between 1 and 200
  ), relation_links as (
    select relation.person_id, relation.id as relation_id
    from public.person_relations relation
    join selected_persons person on person.id = relation.person_id
    where relation.project_id = target_project_id
    union all
    select relation.related_person_id, relation.id
    from public.person_relations relation
    join selected_persons person on person.id = relation.related_person_id
    where relation.project_id = target_project_id
  ), relation_counts as (
    select person_id, count(distinct relation_id) as total from relation_links group by person_id
  ), task_links as materialized (
    select link.* from public.task_persons link
    join selected_persons person on person.id = link.person_id
    where link.project_id = target_project_id
  ), task_counts as (
    select person_id, count(distinct task_id) as total from task_links group by person_id
  ), hypothesis_person_links as materialized (
    select link.* from public.hypothesis_links link
    join selected_persons person on person.id = link.target_id
    where link.project_id = target_project_id and link.target_type = 'person'
  ), hypothesis_counts as (
    select target_id as person_id, count(distinct hypothesis_id) as total
    from hypothesis_person_links group by target_id
  ), archive_request_counts as (
    select link.person_id, count(distinct link.archive_request_id) as total
    from public.archive_request_persons link
    join selected_persons person on person.id = link.person_id
    where link.project_id = target_project_id group by link.person_id
  ), legacy_findings as materialized (
    select finding.id, finding.document_id,
      public.finding_summary_person_ids_v1(finding.custom_fields) as person_ids
    from public.findings finding
    where finding.project_id = target_project_id
      and public.finding_summary_person_ids_v1(finding.custom_fields)
        && array(select id::text from selected_persons)
  ), finding_links as materialized (
    select participant.person_id, finding.id as finding_id, finding.document_id
    from selected_persons person
    join public.finding_participants participant on participant.person_id = person.id
      and participant.project_id = target_project_id
    join public.findings finding on finding.id = participant.finding_id
      and finding.project_id = participant.project_id
    union all
    select person.id, finding.id, finding.document_id
    from legacy_findings finding
    cross join lateral unnest(finding.person_ids) as metadata(person_id_text)
    join selected_persons person on person.id::text = metadata.person_id_text
  ), finding_counts as (
    select person_id, count(distinct finding_id) as total from finding_links group by person_id
  ), document_links as (
    select person_id, document_id from finding_links where document_id is not null
    union all
    select link.person_id, task.document_id from task_links link
    join public.tasks task on task.id = link.task_id and task.project_id = target_project_id
    where task.document_id is not null
    union all
    select person_link.target_id, document_link.target_id
    from hypothesis_person_links person_link
    join public.hypothesis_links document_link
      on document_link.hypothesis_id = person_link.hypothesis_id
      and document_link.project_id = target_project_id and document_link.target_type = 'document'
  ), document_counts as (
    select link.person_id, count(distinct document.id) as total
    from document_links link
    join public.documents document on document.id = link.document_id and document.project_id = target_project_id
    group by link.person_id
  ), last_events as (
    select distinct on (event.person_id) event.person_id, event.event_type,
      coalesce(nullif(event.event_date, ''), nullif(event.date_to, ''),
        nullif(event.date_from, ''), nullif(event.date_text, '')) as display_date
    from public.person_timeline_events event
    join selected_persons person on person.id = event.person_id
    where event.project_id = target_project_id
    order by event.person_id,
      coalesce(nullif(event.event_date, ''), nullif(event.date_to, ''), nullif(event.date_from, '')) desc nulls last,
      event.updated_at desc, event.id desc
  )
  select person.id, coalesce(relations.total, 0), coalesce(tasks.total, 0),
    coalesce(hypotheses.total, 0), coalesce(requests.total, 0), coalesce(findings.total, 0),
    coalesce(documents.total, 0), event.event_type, event.display_date
  from selected_persons person
  left join relation_counts relations on relations.person_id = person.id
  left join task_counts tasks on tasks.person_id = person.id
  left join hypothesis_counts hypotheses on hypotheses.person_id = person.id
  left join archive_request_counts requests on requests.person_id = person.id
  left join finding_counts findings on findings.person_id = person.id
  left join document_counts documents on documents.person_id = person.id
  left join last_events event on event.person_id = person.id
  order by person.updated_at desc, person.id
$function$;

comment on function public.list_person_summaries_v2(uuid, uuid[]) is
  'RLS-aware counters for up to 200 requested persons. Empty/oversized requests return no rows.';
revoke all on function public.list_person_summaries_v2(uuid, uuid[]) from public, anon;
grant execute on function public.list_person_summaries_v2(uuid, uuid[]) to authenticated;
notify pgrst, 'reload schema';
commit;
