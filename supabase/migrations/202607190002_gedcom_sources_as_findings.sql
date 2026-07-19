begin;

alter table public.findings
  add column if not exists source_url text not null default '';

comment on column public.findings.source_url is
  'External source link for a finding. file_reference remains the archival file/case number.';

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.findings'::regclass
      and conname = 'findings_source_url_http_check'
  ) then
    alter table public.findings
      add constraint findings_source_url_http_check
      check (source_url = '' or source_url ~* '^https?://');
  end if;
end;
$migration$;

-- Keep cleanup expressions local to this migration; no additional public RPC
-- is exposed. Raw GEDCOM metadata remains untouched in custom_fields/archive.
create or replace function pg_temp.gedcom_first_url(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select pg_catalog.regexp_replace(
    coalesce(
      pg_catalog.substring(
        coalesce(value, ''),
        $url$(https?://[^[:space:]<>"']+)$url$
      ),
      ''
    ),
    $trailing$[),.;:!?\]}]+$$trailing$,
    '',
    'g'
  );
$function$;

create or replace function pg_temp.gedcom_visible_text(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select pg_catalog.btrim(
    pg_catalog.regexp_replace(
      coalesce(value, ''),
      $url$https?://[^[:space:]<>"']+$url$,
      '',
      'gi'
    ),
    E' \t\r\n·|,;:–—-'
  );
$function$;

-- Recover the link from the old generated document first, then from malformed
-- finding fields/raw metadata. Only GEDCOM-stamped findings are touched.
update public.findings finding
set source_url = pg_temp.gedcom_first_url(concat_ws(
  ' ',
  document.url,
  document.file_reference,
  finding.page,
  finding.file_reference,
  finding.summary,
  finding.description,
  finding.transcription,
  finding.notes,
  finding.custom_fields::text,
  document.custom_fields::text
))
from public.documents document
where finding.document_id = document.id
  and finding.source_url = ''
  and document.custom_fields ? '__gedcomSourceXref'
  and pg_temp.gedcom_first_url(concat_ws(
    ' ',
    document.url,
    document.file_reference,
    finding.page,
    finding.file_reference,
    finding.summary,
    finding.description,
    finding.transcription,
    finding.notes,
    finding.custom_fields::text,
    document.custom_fields::text
  )) <> '';

update public.findings finding
set source_url = pg_temp.gedcom_first_url(concat_ws(
  ' ',
  finding.page,
  finding.file_reference,
  finding.summary,
  finding.description,
  finding.transcription,
  finding.notes,
  finding.archive,
  finding.fund,
  finding.custom_fields::text
))
where finding.source_url = ''
  and (
    finding.custom_fields ? '__gedcomCitation'
    or finding.custom_fields ? '__gedcomEventDescription'
    or finding.custom_fields ? '__gedcomSourceXref'
  )
  and pg_temp.gedcom_first_url(concat_ws(
    ' ',
    finding.page,
    finding.file_reference,
    finding.summary,
    finding.description,
    finding.transcription,
    finding.notes,
    finding.archive,
    finding.fund,
    finding.custom_fields::text
  )) <> '';

-- Remove duplicated URL text from user-visible fields while retaining archive
-- references and the untouched raw citation/source JSON.
update public.findings finding
set
  archive = pg_temp.gedcom_visible_text(finding.archive),
  fund = pg_temp.gedcom_visible_text(finding.fund),
  description = pg_temp.gedcom_visible_text(finding.description),
  file_reference = pg_temp.gedcom_visible_text(finding.file_reference),
  page = pg_temp.gedcom_visible_text(finding.page),
  summary = coalesce(
    nullif(pg_temp.gedcom_visible_text(finding.summary), ''),
    nullif(pg_temp.gedcom_visible_text(finding.description), ''),
    nullif(finding.finding_type, ''),
    'Джерело GEDCOM'
  ),
  transcription = pg_temp.gedcom_visible_text(finding.transcription),
  notes = pg_temp.gedcom_visible_text(finding.notes)
where (
    finding.custom_fields ? '__gedcomCitation'
    or finding.custom_fields ? '__gedcomEventDescription'
    or finding.custom_fields ? '__gedcomSourceXref'
  )
  and concat_ws(
    ' ',
    finding.archive,
    finding.fund,
    finding.description,
    finding.file_reference,
    finding.page,
    finding.summary,
    finding.transcription,
    finding.notes
  ) ~* 'https?://';

-- A top-level SOUR with no citation used to exist only as an auto-generated
-- document. Preserve it as an unlinked finding before eligible documents are
-- removed. Copy created_by so the ownership/audit trail stays intact.
-- Migrations run without an authenticated application user, so the normal
-- subscription/access trigger would reject this one-time data projection.
-- A project may also have been downgraded after a professional-plan import,
-- leaving a valid legacy document without research_id. Suspend only those two
-- application-context checks for this statement; all constraints and the
-- durable GEDCOM write fence stay active.
alter table public.findings
  disable trigger findings_scoped_insert_access;
alter table public.findings
  disable trigger findings_require_research_scope;

insert into public.findings (
  project_id,
  research_id,
  document_id,
  finding_type,
  event_date,
  people,
  persons_text,
  place,
  archive,
  fund,
  description,
  file_reference,
  page,
  source_url,
  summary,
  transcription,
  conclusion,
  reliability,
  needs_review,
  notes,
  custom_fields,
  created_by,
  created_at,
  updated_at
)
select
  document.project_id,
  document.research_id,
  null,
  'джерело',
  '',
  '',
  '',
  document.place,
  pg_temp.gedcom_visible_text(document.archive),
  '',
  pg_temp.gedcom_visible_text(document.description),
  case
    when document.file_reference ~* '^https?://' then ''
    else pg_temp.gedcom_visible_text(document.file_reference)
  end,
  '',
  pg_temp.gedcom_first_url(concat_ws(
    ' ',
    document.url,
    document.file_reference,
    document.title,
    document.description,
    document.notes,
    document.custom_fields::text
  )),
  coalesce(
    nullif(pg_temp.gedcom_visible_text(document.title), ''),
    'Джерело GEDCOM'
  ),
  pg_temp.gedcom_visible_text(document.description),
  '',
  'імпортовано',
  false,
  pg_temp.gedcom_visible_text(document.notes),
  (document.custom_fields - '__trackerRoduDocumentScans')
    || jsonb_build_object('__gedcomStandaloneSource', true),
  document.created_by,
  document.created_at,
  document.updated_at
from public.documents document
where document.custom_fields ? '__gedcomSourceXref'
  and not exists (
    select 1
    from public.findings finding
    where finding.project_id = document.project_id
      and finding.custom_fields->>'__gedcomSourceXref'
        = document.custom_fields->>'__gedcomSourceXref'
      and coalesce(
        finding.custom_fields->>'__gedcomImportSourceKey',
        ''
      ) = coalesce(
        document.custom_fields->>'__gedcomImportSourceKey',
        ''
      )
  );

alter table public.findings
  enable trigger findings_require_research_scope;
alter table public.findings
  enable trigger findings_scoped_insert_access;

-- Delete only pristine generated rows. Any edit, upload, or manual reference
-- makes the document user-owned and therefore ineligible for automatic cleanup.
delete from public.documents document
where document.custom_fields ? '__gedcomSourceXref'
  and document.updated_at = document.created_at
  and coalesce(
    case
      when jsonb_typeof(document.custom_fields->'__trackerRoduDocumentScans') = 'array'
        then jsonb_array_length(document.custom_fields->'__trackerRoduDocumentScans')
      else 0
    end,
    0
  ) = 0
  and not exists (
    select 1 from public.attachments attachment
    where attachment.owner_id = document.id
      and lower(attachment.owner_type) in ('document', 'documents')
  )
  and not exists (
    select 1 from public.tasks task where task.document_id = document.id
  )
  and not exists (
    select 1 from public.year_matrix matrix where matrix.document_id = document.id
  )
  and not exists (
    select 1 from public.hypothesis_links link
    where link.target_type = 'document' and link.target_id = document.id
  )
  and not exists (
    select 1 from public.record_links link
    where (lower(link.source_type) in ('document', 'documents') and link.source_id = document.id)
       or (lower(link.target_type) in ('document', 'documents') and link.target_id = document.id)
  )
  and not exists (
    select 1 from public.person_names name where name.source_document_id = document.id
  )
  and not exists (
    select 1 from public.person_timeline_events event where event.source_document_id = document.id
  )
  and not exists (
    select 1 from public.partner_relationships relation where relation.source_document_id = document.id
  )
  and not exists (
    select 1 from public.parent_child_relationships relation where relation.source_document_id = document.id
  )
  and not exists (
    select 1 from public.association_relationships relation where relation.source_document_id = document.id
  )
  and not exists (
    select 1
    from public.findings finding
    where finding.document_id = document.id
      and not (
        finding.custom_fields ? '__gedcomSourceXref'
        and finding.custom_fields->>'__gedcomSourceXref'
          = document.custom_fields->>'__gedcomSourceXref'
        and coalesce(
          finding.custom_fields->>'__gedcomImportSourceKey',
          ''
        ) = coalesce(
          document.custom_fields->>'__gedcomImportSourceKey',
          ''
        )
      )
  )
  -- A document-fragment selection stores its document reference in JSON rather
  -- than in findings.document_id. Treat it as a manual use and retain the
  -- source document even if every generated column is otherwise pristine.
  and not exists (
    select 1
    from public.findings finding
    where finding.custom_fields #>>
      '{__trackerRoduFindingMeta,fragmentSelection,documentId}' = document.id::text
  );

-- Keep server search and its supporting trigram index aware of the dedicated
-- link without re-introducing bulky raw GEDCOM JSON into the index.
drop index if exists public.findings_project_search_trgm_idx;
create index findings_project_search_trgm_idx
  on public.findings using gin ((lower(
    finding_type || ' ' || event_date || ' ' || people || ' ' || persons_text ||
    ' ' || place || ' ' || archive || ' ' || fund || ' ' || description ||
    ' ' || file_reference || ' ' || page || ' ' || source_url || ' ' || summary || ' ' ||
    transcription || ' ' || conclusion || ' ' || reliability || ' ' || notes ||
    ' ' || public.project_search_custom_field_text(custom_fields)
  )) extensions.gin_trgm_ops);

do $migration$
declare
  rpc_definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.search_project_records(uuid,text,integer)'::regprocedure
  ) into rpc_definition;

  if rpc_definition is null then
    raise exception 'search_project_records(uuid,text,integer) is missing';
  end if;

  if pg_catalog.strpos(rpc_definition, 'finding.source_url') > 0 then
    return;
  end if;

  updated_definition := pg_catalog.regexp_replace(
    rpc_definition,
    $pattern$finding\.file_reference[[:space:]]*\|\|[[:space:]]*' '[[:space:]]*\|\|[[:space:]]*finding\.page$pattern$,
    $replacement$finding.file_reference || ' ' || finding.source_url || ' ' || finding.page$replacement$
  );

  if updated_definition = rpc_definition then
    raise exception 'Unexpected search RPC finding expression';
  end if;

  execute updated_definition;
end;
$migration$;

commit;
