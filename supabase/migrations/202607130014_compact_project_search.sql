begin;

-- The first server-search implementation indexed custom_fields::text verbatim.
-- GEDCOM imports intentionally keep lossless source records, citations and media
-- metadata in custom_fields, so a small amount of live data could produce very
-- large trigram indexes. Keep those records for export/reconciliation, but only
-- expose user-defined values and a small allow-list of useful internal values to
-- project search.
create or replace function public.project_search_custom_field_text(fields jsonb)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(string_agg(entry.field_value, ' ' order by entry.field_key), '')
  from pg_catalog.jsonb_each_text(coalesce(fields, '{}'::jsonb))
    as entry(field_key, field_value)
  where pg_catalog.left(entry.field_key, 2) <> '__'
     or entry.field_key = any (array[
       '__trackerRoduMaidenSurname',
       '__trackerRoduPersonEvents',
       '__gedcomXref',
       '__gedcomRin',
       '__gedcomUid',
       '__gedcomVitalStatus',
       '__gedcomNationality',
       '__gedcomEducation',
       '__gedcomSourceXref',
       '__gedcomEventType',
       '__gedcomEventTag',
       '__gedcomEventRawType',
       '__gedcomEventValue',
       '__gedcomArchiveActRecord'
     ]::text[]);
$function$;

revoke execute on function public.project_search_custom_field_text(jsonb)
  from public, anon;
grant execute on function public.project_search_custom_field_text(jsonb)
  to authenticated, service_role;

comment on function public.project_search_custom_field_text(jsonb) is
  'Compact project-search text: user fields plus selected small user-visible metadata; excludes raw GEDCOM and attachment payloads.';

-- Fail quickly instead of waiting behind a long-running writer. All old indexes
-- and the RPC remain available if this transaction cannot acquire its locks.
set local lock_timeout = '10s';
set local statement_timeout = '15min';

drop index if exists public.researches_project_search_trgm_idx;
create index researches_project_search_trgm_idx
  on public.researches using gin ((lower(
    title || ' ' || goal || ' ' || surnames || ' ' || places || ' ' ||
    period_from || ' ' || period_to || ' ' || archives || ' ' || status ||
    ' ' || notes || ' ' || public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.persons_project_search_trgm_idx;
create index persons_project_search_trgm_idx
  on public.persons using gin ((lower(
    surname || ' ' || given_name || ' ' || patronymic || ' ' || full_name ||
    ' ' || name_variants || ' ' || surname_variants || ' ' || birth_date ||
    ' ' || birth_year_from || ' ' || birth_year_to || ' ' || birth_place ||
    ' ' || marriage_date || ' ' || marriage_place || ' ' || death_date ||
    ' ' || death_year_from || ' ' || death_year_to || ' ' || death_place ||
    ' ' || residence_places || ' ' || social_status || ' ' || religion ||
    ' ' || occupation || ' ' || status || ' ' || notes || ' ' ||
    public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.documents_project_search_trgm_idx;
create index documents_project_search_trgm_idx
  on public.documents using gin ((lower(
    title || ' ' || document_type || ' ' || archive || ' ' || fund || ' ' ||
    file_reference || ' ' || year_from || ' ' || year_to || ' ' || place ||
    ' ' || url || ' ' || review_status || ' ' || description || ' ' || notes ||
    ' ' || public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.year_matrix_project_search_trgm_idx;
create index year_matrix_project_search_trgm_idx
  on public.year_matrix using gin ((lower(
    year_text || ' ' || place || ' ' || document_type || ' ' || status ||
    ' ' || notes || ' ' || public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.tasks_project_search_trgm_idx;
create index tasks_project_search_trgm_idx
  on public.tasks using gin ((lower(
    title || ' ' || person_name || ' ' || description || ' ' || place || ' ' ||
    year_from || ' ' || year_to || ' ' || document_type || ' ' || status ||
    ' ' || priority || ' ' || deadline || ' ' || notes || ' ' ||
    public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.findings_project_search_trgm_idx;
create index findings_project_search_trgm_idx
  on public.findings using gin ((lower(
    finding_type || ' ' || event_date || ' ' || people || ' ' || persons_text ||
    ' ' || place || ' ' || archive || ' ' || fund || ' ' || description ||
    ' ' || file_reference || ' ' || page || ' ' || summary || ' ' ||
    transcription || ' ' || conclusion || ' ' || reliability || ' ' || notes ||
    ' ' || public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.hypotheses_project_search_trgm_idx;
create index hypotheses_project_search_trgm_idx
  on public.hypotheses using gin ((lower(
    title || ' ' || description || ' ' || to_verify || ' ' || related_people ||
    ' ' || status || ' ' || probability || ' ' || arguments_for || ' ' ||
    arguments_against || ' ' || notes || ' ' ||
    public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.archive_requests_project_search_trgm_idx;
create index archive_requests_project_search_trgm_idx
  on public.archive_requests using gin ((lower(
    archive || ' ' || archive_details || ' ' || request_date || ' ' ||
    response_date || ' ' || status || ' ' || subject || ' ' || notes || ' ' ||
    public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

drop index if exists public.custom_records_project_search_trgm_idx;
create index custom_records_project_search_trgm_idx
  on public.custom_records using gin ((lower(
    title || ' ' || values::text
  )) extensions.gin_trgm_ops);

-- Preserve the proven, membership-scoped RPC and its result contract while
-- replacing only the eight expressions that previously stringified all JSON.
-- pg_get_functiondef reads trusted server-owned DDL; no user input enters the
-- dynamic statement. The guards make schema drift fail closed.
do $migration$
declare
  rpc_definition text;
  compact_definition text;
  relation_alias text;
  old_fragment text;
  new_fragment text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.search_project_records(uuid,text,integer)'::regprocedure
  ) into rpc_definition;

  if rpc_definition is null then
    raise exception 'search_project_records(uuid,text,integer) is missing';
  end if;

  compact_definition := rpc_definition;
  foreach relation_alias in array array[
    'research',
    'person',
    'document',
    'matrix',
    'task',
    'finding',
    'hypothesis',
    'request'
  ]::text[] loop
    old_fragment := relation_alias || '.custom_fields::text';
    new_fragment := 'public.project_search_custom_field_text(' ||
      relation_alias || '.custom_fields)';

    if pg_catalog.strpos(compact_definition, old_fragment) > 0 then
      compact_definition := pg_catalog.replace(
        compact_definition,
        old_fragment,
        new_fragment
      );
    elsif pg_catalog.strpos(compact_definition, new_fragment) = 0 then
      raise exception 'Unexpected search RPC body for alias %', relation_alias;
    end if;
  end loop;

  if pg_catalog.strpos(compact_definition, '.custom_fields::text') > 0 then
    raise exception 'Unconverted custom_fields expression remains in search RPC';
  end if;

  if compact_definition <> rpc_definition then
    execute compact_definition;
  end if;
end;
$migration$;

commit;
