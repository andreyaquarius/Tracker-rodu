begin;

-- Short-lived bearer sessions for the PDF gateway. The browser receives only
-- a cryptographically random token; the database stores its SHA-256 hash.
-- No upstream URL, OAuth credential, signed URL or PDF byte is stored here.
create table if not exists public.pdf_access_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  project_id uuid not null references public.projects(id) on delete cascade,
  document_id uuid not null,
  document_source_id uuid not null,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  provider text not null
    check (provider in ('wikimedia', 'direct_pdf')),
  upstream_host text not null
    check (nullif(btrim(upstream_host), '') is not null),
  source_fingerprint jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_fingerprint) = 'object'),
  request_count integer not null default 0
    check (request_count >= 0),
  max_requests integer not null
    check (max_requests between 1 and 4096),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),

  constraint pdf_access_sessions_document_project_fkey
    foreign key (document_id, project_id)
    references public.documents(id, project_id)
    on delete cascade,
  constraint pdf_access_sessions_source_project_fkey
    foreign key (document_source_id, project_id)
    references public.document_sources(id, project_id)
    on delete cascade,
  constraint pdf_access_sessions_expiry_check
    check (expires_at > created_at)
);

comment on table public.pdf_access_sessions is
  'Short-lived hashed access tokens for the authenticated PDF gateway. Never store raw tokens, upstream URLs or PDF bytes.';
comment on column public.pdf_access_sessions.token_hash is
  'SHA-256 of the random opaque token returned once to the authenticated browser.';
comment on column public.pdf_access_sessions.source_fingerprint is
  'Source version bound at session creation and rechecked before each stream request.';

create index if not exists pdf_access_sessions_expiry_idx
  on public.pdf_access_sessions (expires_at);
create index if not exists pdf_access_sessions_user_expiry_idx
  on public.pdf_access_sessions (user_id, expires_at desc);
create index if not exists pdf_access_sessions_source_idx
  on public.pdf_access_sessions (document_source_id, expires_at desc);

alter table public.pdf_access_sessions enable row level security;

-- Access is intentionally service-only. The Edge Function authenticates the
-- caller first and never exposes this table through the browser data client.
revoke all on public.pdf_access_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.pdf_access_sessions to service_role;

create or replace function public.consume_pdf_access_session(
  target_token_hash text,
  target_user_id uuid
)
returns setof public.pdf_access_sessions
language sql
security definer
set search_path = ''
as $$
  update public.pdf_access_sessions as session
  set
    request_count = session.request_count + 1,
    last_used_at = pg_catalog.now()
  where session.token_hash = target_token_hash
    and session.user_id = target_user_id
    and session.expires_at > pg_catalog.now()
    and session.request_count < session.max_requests
  returning session.*;
$$;

comment on function public.consume_pdf_access_session(text, uuid) is
  'Atomically validates expiry, user binding and request budget for a PDF gateway session.';

revoke all on function public.consume_pdf_access_session(text, uuid)
  from public, anon, authenticated;
grant execute on function public.consume_pdf_access_session(text, uuid)
  to service_role;

-- The resumable project-deletion worker validates that every project-owned
-- public table has a canonical phase, even when a cascading FK would also
-- remove the rows. Sessions go first because they are disposable credentials.
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
    'pdf_access_sessions',
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

-- Manual rollback (only after disabling external_pdf_viewer_v2):
--   drop function if exists public.consume_pdf_access_session(text, uuid);
--   drop table if exists public.pdf_access_sessions;

commit;
