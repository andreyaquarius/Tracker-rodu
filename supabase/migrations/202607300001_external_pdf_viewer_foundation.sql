begin;

-- External PDF source registry. The original binary stays at its provider;
-- this table stores only stable metadata required to resolve and revalidate it.
-- A redundant project_id is intentional: it gives RLS a cheap project-scoped
-- predicate and the composite FK prevents a source from pointing at a document
-- owned by another project.
create unique index if not exists documents_id_project_unique
  on public.documents (id, project_id);

create table if not exists public.document_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  document_id uuid not null,
  provider text not null
    check (provider in ('google_drive', 'wikimedia', 'direct_pdf')),

  original_url text not null,
  canonical_url text,
  source_page_url text,
  provider_host text,
  provider_file_id text,
  provider_file_title text,

  display_name text,
  mime_type text not null default 'application/pdf',
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  page_count integer check (page_count is null or page_count > 0),
  initial_page integer check (
    initial_page is null
    or (
      initial_page > 0
      and (page_count is null or initial_page <= page_count)
    )
  ),

  access_mode text not null
    check (access_mode in ('direct_cors', 'secure_proxy', 'google_drive_api')),
  fingerprint jsonb not null default '{}'::jsonb
    check (jsonb_typeof(fingerprint) = 'object'),
  status text not null default 'active'
    check (status in ('active', 'needs_auth', 'unavailable', 'changed', 'invalid')),
  last_validated_at timestamptz,
  validation_error_code text,
  validation_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(validation_metadata) = 'object'),

  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint document_sources_document_project_fkey
    foreign key (document_id, project_id)
    references public.documents(id, project_id)
    on delete cascade,
  constraint document_sources_original_url_present_check
    check (nullif(btrim(original_url), '') is not null),
  constraint document_sources_original_url_https_check
    check (original_url is null or original_url ~* '^https://'),
  constraint document_sources_canonical_url_https_check
    check (canonical_url is null or canonical_url ~* '^https://'),
  constraint document_sources_source_page_url_https_check
    check (source_page_url is null or source_page_url ~* '^https://')
);

comment on table public.document_sources is
  'Stable metadata for external PDFs. Original PDF bytes and rendered page arrays must never be stored here.';
comment on column public.document_sources.original_url is
  'User-supplied stable HTTPS reference. Never store OAuth tokens or short-lived signed download URLs.';
comment on column public.document_sources.canonical_url is
  'Stable provider URL only; ephemeral access URLs belong in short-lived access sessions, not the database.';
comment on column public.document_sources.fingerprint is
  'Non-secret version metadata such as sha1, md5, etag, revisionId, modifiedTime or contentLength.';
comment on column public.document_sources.validation_metadata is
  'Non-secret validation details only. Do not store tokens, PDF bytes or full signed URLs.';

create index if not exists document_sources_project_document_idx
  on public.document_sources (project_id, document_id);
create index if not exists document_sources_project_status_idx
  on public.document_sources (project_id, status, updated_at desc);
create index if not exists document_sources_provider_file_idx
  on public.document_sources (provider, provider_file_id)
  where provider_file_id is not null;
create index if not exists document_sources_validation_idx
  on public.document_sources (status, last_validated_at)
  where status <> 'invalid';
create unique index if not exists document_sources_id_project_unique
  on public.document_sources (id, project_id);

drop trigger if exists document_sources_set_updated_at on public.document_sources;
create trigger document_sources_set_updated_at
before update on public.document_sources
for each row execute function public.set_updated_at();

alter table public.document_sources enable row level security;

revoke all on public.document_sources from public, anon;
grant select, insert, update, delete on public.document_sources to authenticated;
grant select, insert, update, delete on public.document_sources to service_role;

drop policy if exists document_sources_select_members on public.document_sources;
create policy document_sources_select_members
on public.document_sources for select to authenticated
using ((select public.is_project_member(project_id)));

drop policy if exists document_sources_insert_editors on public.document_sources;
create policy document_sources_insert_editors
on public.document_sources for insert to authenticated
with check ((select public.can_edit_project(project_id)));

drop policy if exists document_sources_update_editors on public.document_sources;
create policy document_sources_update_editors
on public.document_sources for update to authenticated
using ((select public.can_edit_project(project_id)))
with check ((select public.can_edit_project(project_id)));

drop policy if exists document_sources_delete_editors on public.document_sources;
create policy document_sources_delete_editors
on public.document_sources for delete to authenticated
using ((select public.can_edit_project(project_id)));

-- Provenance for findings created from a PDF page or normalized crop. This is
-- additive: legacy finding metadata in findings.custom_fields remains readable
-- and no existing finding is rewritten by this foundation migration.
create unique index if not exists findings_id_project_unique
  on public.findings (id, project_id);

create table if not exists public.finding_document_references (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  finding_id uuid not null,
  document_id uuid not null,
  document_source_id uuid not null,

  page_index integer not null check (page_index >= 1),
  page_label text,
  selection jsonb
    check (selection is null or jsonb_typeof(selection) = 'object'),
  source_fingerprint jsonb not null
    check (jsonb_typeof(source_fingerprint) = 'object'),

  snapshot_provider text
    check (snapshot_provider is null or snapshot_provider in ('google_drive', 'external')),
  snapshot_file_id text,
  snapshot_url text,
  snapshot_mime_type text,

  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint finding_document_references_finding_project_fkey
    foreign key (finding_id, project_id)
    references public.findings(id, project_id)
    on delete cascade,
  constraint finding_document_references_document_project_fkey
    foreign key (document_id, project_id)
    references public.documents(id, project_id)
    on delete cascade,
  constraint finding_document_references_source_project_fkey
    foreign key (document_source_id, project_id)
    references public.document_sources(id, project_id)
    on delete cascade,
  constraint finding_document_references_snapshot_url_https_check
    check (snapshot_url is null or snapshot_url ~* '^https://'),
  constraint finding_document_references_snapshot_pair_check
    check (
      snapshot_provider is not null
      or (
        snapshot_file_id is null
        and snapshot_url is null
        and snapshot_mime_type is null
      )
    )
);

comment on table public.finding_document_references is
  'Project-scoped PDF provenance for a finding. Legacy findings.custom_fields remains compatible.';
comment on column public.finding_document_references.selection is
  'Normalized page coordinates only; null means the whole page.';
comment on column public.finding_document_references.source_fingerprint is
  'Immutable source version captured when the finding is created.';
comment on column public.finding_document_references.snapshot_url is
  'Stable user-created derivative reference only; never store a short-lived signed download URL.';

create index if not exists finding_document_references_project_finding_idx
  on public.finding_document_references (project_id, finding_id);
create index if not exists finding_document_references_document_idx
  on public.finding_document_references (document_id, page_index);
create index if not exists finding_document_references_source_idx
  on public.finding_document_references (document_source_id, page_index);
-- The client saves the finding first because the provenance row has a foreign
-- key to it. A network retry must update that same page reference instead of
-- creating a duplicate row.
create unique index if not exists finding_document_references_retry_unique
  on public.finding_document_references (
    project_id,
    finding_id,
    document_source_id,
    page_index
  );

drop trigger if exists finding_document_references_set_updated_at
  on public.finding_document_references;
create trigger finding_document_references_set_updated_at
before update on public.finding_document_references
for each row execute function public.set_updated_at();

create or replace function public.preserve_finding_document_reference_fingerprint()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.source_fingerprint is distinct from old.source_fingerprint then
    raise exception using
      errcode = '22023',
      message = 'SOURCE_FINGERPRINT_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists finding_document_references_preserve_fingerprint
  on public.finding_document_references;
create trigger finding_document_references_preserve_fingerprint
before update of source_fingerprint on public.finding_document_references
for each row execute function public.preserve_finding_document_reference_fingerprint();

revoke all on function public.preserve_finding_document_reference_fingerprint()
  from public, anon;
grant execute on function public.preserve_finding_document_reference_fingerprint()
  to authenticated, service_role;

alter table public.finding_document_references enable row level security;

revoke all on public.finding_document_references from public, anon;
grant select, insert, update, delete on public.finding_document_references to authenticated;
grant select, insert, update, delete on public.finding_document_references to service_role;

drop policy if exists finding_document_references_select_members
  on public.finding_document_references;
create policy finding_document_references_select_members
on public.finding_document_references for select to authenticated
using ((select public.is_project_member(project_id)));

drop policy if exists finding_document_references_insert_editors
  on public.finding_document_references;
create policy finding_document_references_insert_editors
on public.finding_document_references for insert to authenticated
with check ((select public.can_edit_project(project_id)));

drop policy if exists finding_document_references_update_editors
  on public.finding_document_references;
create policy finding_document_references_update_editors
on public.finding_document_references for update to authenticated
using ((select public.can_edit_project(project_id)))
with check ((select public.can_edit_project(project_id)));

drop policy if exists finding_document_references_delete_editors
  on public.finding_document_references;
create policy finding_document_references_delete_editors
on public.finding_document_references for delete to authenticated
using ((select public.can_edit_project(project_id)));

-- Keep the resumable project-deletion contract complete. Dependent
-- provenance rows are removed before findings/sources/documents.
create or replace function private.project_deletion_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'legacy_person_relation_graph_edges',
    'ai_hypothesis_reviews',
    'family_tree_research_issues',
    'tree_layout_positions',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'person_timeline_events',
    'person_names',
    'association_relationships',
    'parent_child_relationships',
    'parent_sets',
    'partner_relationships',
    'family_group_members',
    'family_groups',
    'family_tree_persons',
    'gedcom_import_batches',
    'family_trees',
    'finding_document_references',
    'finding_participants',
    'task_persons',
    'task_notifications',
    'archive_request_persons',
    'hypothesis_links',
    'record_links',
    'custom_records',
    'custom_section_fields',
    'attachments',
    'activity_log',
    'year_matrix',
    'tasks',
    'findings',
    'hypotheses',
    'archive_requests',
    'person_relations',
    'document_sources',
    'documents',
    'persons',
    'custom_field_definitions',
    'custom_sections',
    'researches',
    'project_invitations'
  ]::text[];
$$;

revoke execute on function private.project_deletion_phase_names()
  from public, anon, authenticated;

-- Preserve an administrator's rollout choice on re-application. The value is
-- false only for the initial insert, so this migration can be run repeatedly
-- without unexpectedly disabling an already enabled production rollout.
insert into public.app_feature_flags (key, title, description, is_enabled)
values (
  'external_pdf_viewer_v2',
  'Новий переглядач зовнішніх PDF',
  'Поетапно вмикає source resolver, захищений доступ і PDF viewer v2.',
  false
)
on conflict (key) do update
set
  title = excluded.title,
  description = excluded.description;

-- Manual rollback plan (only after disabling the flag and backing up provenance):
--   drop table if exists public.finding_document_references;
--   drop function if exists public.preserve_finding_document_reference_fingerprint();
--   drop table if exists public.document_sources;
--   delete from public.app_feature_flags where key = 'external_pdf_viewer_v2';
-- The three composite unique indexes on existing tables are harmless and may
-- be retained; drop them separately only after confirming no later FK uses them.

commit;
