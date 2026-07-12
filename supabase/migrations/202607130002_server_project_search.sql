begin;

-- Server-side project search replaces full-project browser hydration for large
-- workspaces. Trigrams support contains matches (including Cyrillic text)
-- while the existing project_id indexes keep every search tenant-scoped.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create index if not exists researches_project_search_trgm_idx
  on public.researches using gin ((lower(
    title || ' ' || goal || ' ' || surnames || ' ' || places || ' ' ||
    period_from || ' ' || period_to || ' ' || archives || ' ' || status ||
    ' ' || notes || ' ' || custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists persons_project_search_trgm_idx
  on public.persons using gin ((lower(
    surname || ' ' || given_name || ' ' || patronymic || ' ' || full_name ||
    ' ' || name_variants || ' ' || surname_variants || ' ' || birth_date ||
    ' ' || birth_year_from || ' ' || birth_year_to || ' ' || birth_place ||
    ' ' || marriage_date || ' ' || marriage_place || ' ' || death_date ||
    ' ' || death_year_from || ' ' || death_year_to || ' ' || death_place ||
    ' ' || residence_places || ' ' || social_status || ' ' || religion ||
    ' ' || occupation || ' ' || status || ' ' || notes || ' ' ||
    custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists documents_project_search_trgm_idx
  on public.documents using gin ((lower(
    title || ' ' || document_type || ' ' || archive || ' ' || fund || ' ' ||
    file_reference || ' ' || year_from || ' ' || year_to || ' ' || place ||
    ' ' || url || ' ' || review_status || ' ' || description || ' ' || notes ||
    ' ' || custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists year_matrix_project_search_trgm_idx
  on public.year_matrix using gin ((lower(
    year_text || ' ' || place || ' ' || document_type || ' ' || status ||
    ' ' || notes || ' ' || custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists tasks_project_search_trgm_idx
  on public.tasks using gin ((lower(
    title || ' ' || person_name || ' ' || description || ' ' || place || ' ' ||
    year_from || ' ' || year_to || ' ' || document_type || ' ' || status ||
    ' ' || priority || ' ' || deadline || ' ' || notes || ' ' ||
    custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists findings_project_search_trgm_idx
  on public.findings using gin ((lower(
    finding_type || ' ' || event_date || ' ' || people || ' ' || persons_text ||
    ' ' || place || ' ' || archive || ' ' || fund || ' ' || description ||
    ' ' || file_reference || ' ' || page || ' ' || summary || ' ' ||
    transcription || ' ' || conclusion || ' ' || reliability || ' ' || notes ||
    ' ' || custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists hypotheses_project_search_trgm_idx
  on public.hypotheses using gin ((lower(
    title || ' ' || description || ' ' || to_verify || ' ' || related_people ||
    ' ' || status || ' ' || probability || ' ' || arguments_for || ' ' ||
    arguments_against || ' ' || notes || ' ' || custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists archive_requests_project_search_trgm_idx
  on public.archive_requests using gin ((lower(
    archive || ' ' || archive_details || ' ' || request_date || ' ' ||
    response_date || ' ' || status || ' ' || subject || ' ' || notes || ' ' ||
    custom_fields::text
  )) extensions.gin_trgm_ops);

create index if not exists custom_records_project_search_trgm_idx
  on public.custom_records using gin ((lower(
    title || ' ' || values::text
  )) extensions.gin_trgm_ops);

create or replace function public.search_project_records(
  target_project_id uuid,
  search_query text,
  result_limit integer default 40
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $$
declare
  normalized_query text := lower(btrim(coalesce(search_query, '')));
  escaped_query text := replace(
    replace(replace(normalized_query, '!', '!!'), '%', '!%'),
    '_',
    '!_'
  );
  bounded_limit integer := least(greatest(coalesce(result_limit, 40), 1), 50);
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if target_project_id is null
     or not public.is_project_member(target_project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if char_length(normalized_query) < 3 then
    return '[]'::jsonb;
  end if;

  return (
    with candidates as (
      select candidate.*
      from (
        select
          research.id as entity_id,
          'researches'::text as module_key,
          'researches'::text as page_key,
          'Дослідження'::text as module_label,
          research.title,
          left(concat_ws(' · ',
            nullif(research.surnames, ''),
            nullif(research.places, ''),
            nullif(research.status, '')
          ), 240) as description,
          lower(
            research.title || ' ' || research.goal || ' ' || research.surnames ||
            ' ' || research.places || ' ' || research.period_from || ' ' ||
            research.period_to || ' ' || research.archives || ' ' ||
            research.status || ' ' || research.notes || ' ' ||
            research.custom_fields::text
          ) as search_text,
          research.updated_at
        from public.researches research
        where research.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          person.id as entity_id,
          'persons'::text as module_key,
          'persons'::text as page_key,
          'Особи'::text as module_label,
          coalesce(
            nullif(person.full_name, ''),
            nullif(btrim(person.surname || ' ' || person.given_name || ' ' || person.patronymic), ''),
            'Особа без імені'
          ) as title,
          left(concat_ws(' · ',
            nullif(concat_ws('–', nullif(person.birth_year_from, ''), nullif(person.death_year_to, '')), ''),
            nullif(person.birth_place, ''),
            nullif(person.residence_places, ''),
            nullif(person.status, '')
          ), 240) as description,
          lower(
            person.surname || ' ' || person.given_name || ' ' || person.patronymic ||
            ' ' || person.full_name || ' ' || person.name_variants || ' ' ||
            person.surname_variants || ' ' || person.birth_date || ' ' ||
            person.birth_year_from || ' ' || person.birth_year_to || ' ' ||
            person.birth_place || ' ' || person.marriage_date || ' ' ||
            person.marriage_place || ' ' || person.death_date || ' ' ||
            person.death_year_from || ' ' || person.death_year_to || ' ' ||
            person.death_place || ' ' || person.residence_places || ' ' ||
            person.social_status || ' ' || person.religion || ' ' ||
            person.occupation || ' ' || person.status || ' ' || person.notes ||
            ' ' || person.custom_fields::text
          ) as search_text,
          person.updated_at
        from public.persons person
        where person.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          document.id as entity_id,
          'documents'::text as module_key,
          'documents'::text as page_key,
          'Документи'::text as module_label,
          document.title,
          left(concat_ws(' · ',
            nullif(document.document_type, ''),
            nullif(concat_ws('–', nullif(document.year_from, ''), nullif(document.year_to, '')), ''),
            nullif(document.archive, ''),
            nullif(document.place, '')
          ), 240) as description,
          lower(
            document.title || ' ' || document.document_type || ' ' ||
            document.archive || ' ' || document.fund || ' ' ||
            document.file_reference || ' ' || document.year_from || ' ' ||
            document.year_to || ' ' || document.place || ' ' || document.url ||
            ' ' || document.review_status || ' ' || document.description || ' ' ||
            document.notes || ' ' || document.custom_fields::text
          ) as search_text,
          document.updated_at
        from public.documents document
        where document.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          matrix.id as entity_id,
          'yearMatrix'::text as module_key,
          'yearMatrix'::text as page_key,
          'Матриця років'::text as module_label,
          concat_ws(' · ', matrix.year_text, nullif(matrix.document_type, '')) as title,
          left(concat_ws(' · ', nullif(matrix.place, ''), nullif(matrix.status, '')), 240) as description,
          lower(
            matrix.year_text || ' ' || matrix.place || ' ' || matrix.document_type ||
            ' ' || matrix.status || ' ' || matrix.notes || ' ' ||
            matrix.custom_fields::text
          ) as search_text,
          matrix.updated_at
        from public.year_matrix matrix
        where matrix.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          task.id as entity_id,
          'tasks'::text as module_key,
          'tasks'::text as page_key,
          'Завдання'::text as module_label,
          task.title,
          left(concat_ws(' · ',
            nullif(task.person_name, ''),
            nullif(task.place, ''),
            nullif(task.priority, ''),
            nullif(task.status, '')
          ), 240) as description,
          lower(
            task.title || ' ' || task.person_name || ' ' || task.description ||
            ' ' || task.place || ' ' || task.year_from || ' ' || task.year_to ||
            ' ' || task.document_type || ' ' || task.status || ' ' ||
            task.priority || ' ' || task.deadline || ' ' || task.notes || ' ' ||
            task.custom_fields::text
          ) as search_text,
          task.updated_at
        from public.tasks task
        where task.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          finding.id as entity_id,
          'findings'::text as module_key,
          'findings'::text as page_key,
          'Знахідки'::text as module_label,
          coalesce(
            nullif(finding.summary, ''),
            nullif(finding.people, ''),
            nullif(finding.persons_text, ''),
            nullif(finding.finding_type, ''),
            'Знахідка'
          ) as title,
          left(concat_ws(' · ',
            nullif(finding.finding_type, ''),
            nullif(finding.event_date, ''),
            nullif(finding.place, ''),
            nullif(finding.archive, '')
          ), 240) as description,
          lower(
            finding.finding_type || ' ' || finding.event_date || ' ' ||
            finding.people || ' ' || finding.persons_text || ' ' || finding.place ||
            ' ' || finding.archive || ' ' || finding.fund || ' ' ||
            finding.description || ' ' || finding.file_reference || ' ' ||
            finding.page || ' ' || finding.summary || ' ' || finding.transcription ||
            ' ' || finding.conclusion || ' ' || finding.reliability || ' ' ||
            finding.notes || ' ' || finding.custom_fields::text
          ) as search_text,
          finding.updated_at
        from public.findings finding
        where finding.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          hypothesis.id as entity_id,
          'hypotheses'::text as module_key,
          'hypotheses'::text as page_key,
          'Гіпотези'::text as module_label,
          hypothesis.title,
          left(concat_ws(' · ',
            nullif(hypothesis.related_people, ''),
            nullif(hypothesis.probability, ''),
            nullif(hypothesis.status, '')
          ), 240) as description,
          lower(
            hypothesis.title || ' ' || hypothesis.description || ' ' ||
            hypothesis.to_verify || ' ' || hypothesis.related_people || ' ' ||
            hypothesis.status || ' ' || hypothesis.probability || ' ' ||
            hypothesis.arguments_for || ' ' || hypothesis.arguments_against ||
            ' ' || hypothesis.notes || ' ' || hypothesis.custom_fields::text
          ) as search_text,
          hypothesis.updated_at
        from public.hypotheses hypothesis
        where hypothesis.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          request.id as entity_id,
          'archiveRequests'::text as module_key,
          'archiveRequests'::text as page_key,
          'Запити в архів'::text as module_label,
          coalesce(nullif(request.subject, ''), 'Запит до ' || coalesce(nullif(request.archive, ''), 'архіву')) as title,
          left(concat_ws(' · ',
            nullif(request.archive, ''),
            nullif(request.request_date, ''),
            nullif(request.status, '')
          ), 240) as description,
          lower(
            request.archive || ' ' || request.archive_details || ' ' ||
            request.request_date || ' ' || request.response_date || ' ' ||
            request.status || ' ' || request.subject || ' ' || request.notes ||
            ' ' || request.custom_fields::text
          ) as search_text,
          request.updated_at
        from public.archive_requests request
        where request.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'

      union all

      select candidate.*
      from (
        select
          record.id as entity_id,
          'custom:' || record.section_id::text as module_key,
          'custom:' || record.section_id::text as page_key,
          section.name as module_label,
          record.title,
          left(concat_ws(' · ', section.name, nullif(record.values::text, '{}')), 240) as description,
          lower(record.title || ' ' || record.values::text) as search_text,
          record.updated_at
        from public.custom_records record
        join public.custom_sections section
          on section.id = record.section_id
         and section.project_id = record.project_id
        where record.project_id = target_project_id
      ) candidate
      where candidate.search_text like '%' || escaped_query || '%' escape '!'
    ),
    ranked as (
      select
        candidates.*,
        (
          case
            when lower(candidates.title) = normalized_query then 100
            when lower(candidates.title) like escaped_query || '%' escape '!' then 80
            when lower(candidates.title) like '%' || escaped_query || '%' escape '!' then 60
            else 20
          end
          + greatest(
              0,
              20 - abs(char_length(candidates.title) - char_length(normalized_query))
            )
        )::double precision as relevance
      from candidates
    ),
    limited as (
      select *
      from ranked
      order by relevance desc, updated_at desc, module_key, entity_id
      limit bounded_limit
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', limited.entity_id::text,
          'entityId', limited.entity_id::text,
          'module', limited.module_key,
          'page', limited.page_key,
          'moduleLabel', limited.module_label,
          'title', limited.title,
          'description', limited.description
        )
        order by limited.relevance desc, limited.updated_at desc,
          limited.module_key, limited.entity_id
      ),
      '[]'::jsonb
    )
    from limited
  );
end;
$$;

revoke execute on function public.search_project_records(uuid, text, integer)
  from public, anon;
grant execute on function public.search_project_records(uuid, text, integer)
  to authenticated;

comment on function public.search_project_records(uuid, text, integer) is
  'Returns at most 50 compact, relevance-ranked search hits for a project member.';

commit;
