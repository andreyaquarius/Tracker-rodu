begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- Public, global "Zahuliaky" catalogue. This migration intentionally does not
-- reference projects or persons: a catalogue occurrence is not a canonical
-- private-tree person and must never expose a user's tree membership.

insert into public.admin_role_permissions(role_code, permission_code) values
  ('content_admin', 'zagulyaky.moderate'),
  ('super_admin', 'zagulyaky.moderate')
on conflict (role_code, permission_code) do nothing;

create table if not exists public.zagulyaky_records (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('person', 'document')),
  status text not null default 'draft' check (status in (
    'draft', 'pending_review', 'needs_changes', 'published',
    'rejected', 'withdrawn', 'merged', 'archived'
  )),
  verification_status text not null default 'unverified' check (verification_status in (
    'unverified', 'plausible', 'corroborated', 'verified', 'disputed'
  )),
  privacy_status text not null default 'pending' check (privacy_status in (
    'pending', 'cleared', 'blocked', 'requires_consent'
  )),
  public_slug text,
  title text not null default 'Нова загуляка' check (char_length(title) between 1 and 300),
  summary text not null default '' check (char_length(summary) <= 4000),
  original_text text not null default '',
  normalized_text text not null default '',
  original_language text,
  event_type text,
  event_date_text text,
  event_year_from integer check (event_year_from is null or event_year_from between 1 and 2200),
  event_year_to integer check (event_year_to is null or event_year_to between 1 and 2200),
  date_precision text check (date_precision is null or date_precision in (
    'exact', 'month', 'year', 'range', 'approximate', 'before', 'after', 'unknown'
  )),
  source_location_text text,
  source_location_normalized text,
  found_location_text text,
  found_location_normalized text,
  classification_reason text not null default '',
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  possible_living_person boolean not null default false,
  submission_terms_version smallint check (submission_terms_version is null or submission_terms_version between 1 and 100),
  rights_confirmed_at timestamptz,
  public_attribution boolean not null default false,
  public_attribution_name text check (public_attribution_name is null or char_length(public_attribution_name) <= 120),
  -- Public catalogue entries survive an account deletion, but their private
  -- author attribution is removed. This also keeps the existing account
  -- deletion workflow from being blocked by a global (non-project) record.
  created_by uuid default auth.uid() references public.profiles(user_id) on delete set null,
  submitted_at timestamptz,
  published_at timestamptz,
  moderated_by uuid references public.profiles(user_id) on delete set null,
  moderation_note text,
  merged_into_id uuid references public.zagulyaky_records(id) on delete restrict,
  lock_version integer not null default 1 check (lock_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' ||
      coalesce(original_text, '') || ' ' || coalesce(normalized_text, '') || ' ' ||
      coalesce(source_location_text, '') || ' ' || coalesce(source_location_normalized, '') || ' ' ||
      coalesce(found_location_text, '') || ' ' || coalesce(found_location_normalized, '')
    )
  ) stored,
  check (event_year_to is null or event_year_from is null or event_year_to >= event_year_from),
  check (merged_into_id is null or merged_into_id <> id),
  check (public_slug is null or char_length(public_slug) between 3 and 180),
  check ((status = 'published' and published_at is not null and public_slug is not null)
    or status <> 'published')
);

create unique index if not exists zagulyaky_records_public_slug_unique
  on public.zagulyaky_records(lower(public_slug))
  where public_slug is not null;
create index if not exists zagulyaky_records_public_feed_idx
  on public.zagulyaky_records(kind, published_at desc, id desc)
  where status = 'published' and privacy_status = 'cleared';
create index if not exists zagulyaky_records_owner_idx
  on public.zagulyaky_records(created_by, updated_at desc);
create index if not exists zagulyaky_records_moderation_idx
  on public.zagulyaky_records(status, submitted_at, created_at);
create index if not exists zagulyaky_records_year_idx
  on public.zagulyaky_records(event_year_from, event_year_to);
create index if not exists zagulyaky_records_search_idx
  on public.zagulyaky_records using gin(search_vector);
create index if not exists zagulyaky_records_title_trgm_idx
  on public.zagulyaky_records using gin ((lower(title)) extensions.gin_trgm_ops);
create index if not exists zagulyaky_records_locations_trgm_idx
  on public.zagulyaky_records using gin ((lower(
    coalesce(source_location_normalized, source_location_text, '') || ' ' ||
    coalesce(found_location_normalized, found_location_text, '')
  )) extensions.gin_trgm_ops);

create table if not exists public.zagulyaky_sources (
  id uuid primary key default gen_random_uuid(),
  source_type text not null default 'other' check (source_type in (
    'archive', 'library', 'website', 'social_post', 'book', 'database', 'other'
  )),
  title text not null default '',
  archive_name text,
  fond text,
  inventory text,
  file_number text,
  page_from text,
  page_to text,
  citation text not null default '',
  source_url text,
  source_platform text,
  external_id text,
  access_date date,
  permission_status text not null default 'unknown' check (permission_status in (
    'unknown', 'link_only', 'permission_granted', 'public_domain', 'restricted'
  )),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by uuid default auth.uid() references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_url is null or source_url ~* '^https?://')
);

create index if not exists zagulyaky_sources_archive_idx
  on public.zagulyaky_sources(archive_name, fond, inventory, file_number);
create index if not exists zagulyaky_sources_external_idx
  on public.zagulyaky_sources(source_platform, external_id)
  where external_id is not null;
create index if not exists zagulyaky_sources_search_trgm_idx
  on public.zagulyaky_sources using gin ((lower(
    coalesce(title, '') || ' ' || coalesce(citation, '') || ' ' || coalesce(archive_name, '')
  )) extensions.gin_trgm_ops);

create table if not exists public.zagulyaky_record_sources (
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  source_id uuid not null references public.zagulyaky_sources(id) on delete restrict,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (record_id, source_id)
);

create unique index if not exists zagulyaky_record_sources_one_primary
  on public.zagulyaky_record_sources(record_id)
  where is_primary;

create table if not exists public.zagulyaky_participants (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  role text not null default 'subject' check (role in (
    'subject', 'spouse', 'parent', 'child', 'witness', 'godparent',
    'official', 'relative', 'mentioned', 'other'
  )),
  original_full_name text not null default '',
  normalized_uk_full_name text not null default '',
  surname text,
  given_name text,
  patronymic text,
  maiden_name text,
  sex text check (sex is null or sex in ('male', 'female', 'unknown')),
  age_text text,
  residence_text text,
  origin_text text,
  notes text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists zagulyaky_participants_record_idx
  on public.zagulyaky_participants(record_id, sort_order, id);
create index if not exists zagulyaky_participants_name_idx
  on public.zagulyaky_participants(lower(normalized_uk_full_name));
create index if not exists zagulyaky_participants_search_trgm_idx
  on public.zagulyaky_participants using gin ((lower(
    coalesce(original_full_name, '') || ' ' || coalesce(normalized_uk_full_name, '')
  )) extensions.gin_trgm_ops);

create table if not exists public.zagulyaky_document_discoveries (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  official_location_text text not null default '',
  discovered_location_text text not null default '',
  record_types text[] not null default '{}',
  factual_year_from integer check (factual_year_from is null or factual_year_from between 1 and 2200),
  factual_year_to integer check (factual_year_to is null or factual_year_to between 1 and 2200),
  page_from text,
  page_to text,
  notes text not null default '',
  created_at timestamptz not null default now(),
  check (factual_year_to is null or factual_year_from is null or factual_year_to >= factual_year_from)
);

create index if not exists zagulyaky_document_discoveries_record_idx
  on public.zagulyaky_document_discoveries(record_id, id);
create index if not exists zagulyaky_document_discoveries_search_trgm_idx
  on public.zagulyaky_document_discoveries using gin ((lower(
    coalesce(official_location_text, '') || ' ' || coalesce(discovered_location_text, '')
  )) extensions.gin_trgm_ops);

create table if not exists public.zagulyaky_attachments (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  source_id uuid references public.zagulyaky_sources(id) on delete set null,
  storage_bucket text not null,
  storage_path text not null,
  public_bucket text,
  public_path text,
  file_name text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size between 1 and 26214400),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  is_public_derivative boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by uuid default auth.uid() references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create index if not exists zagulyaky_attachments_record_idx
  on public.zagulyaky_attachments(record_id, created_at, id);

create table if not exists public.zagulyaky_record_versions (
  id bigint generated always as identity primary key,
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  actor_id uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  unique (record_id, revision_no)
);

create table if not exists public.zagulyaky_confirmations (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(user_id) on delete cascade,
  confirmation_type text not null default 'confirm' check (confirmation_type in (
    'confirm', 'source_checked', 'correction_suggested', 'duplicate_suggested'
  )),
  comment text not null default '' check (char_length(comment) <= 4000),
  created_at timestamptz not null default now(),
  unique (record_id, user_id, confirmation_type)
);

create index if not exists zagulyaky_confirmations_record_idx
  on public.zagulyaky_confirmations(record_id, created_at);

create table if not exists public.zagulyaky_claims (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  submitted_by uuid default auth.uid() references public.profiles(user_id) on delete set null,
  claim_type text not null check (claim_type in (
    'correction', 'privacy', 'copyright', 'abuse', 'source_problem', 'other'
  )),
  message text not null check (char_length(message) between 10 and 8000),
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'rejected')),
  resolution_note text,
  resolved_by uuid references public.profiles(user_id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zagulyaky_claims_status_idx
  on public.zagulyaky_claims(status, created_at);
create index if not exists zagulyaky_claims_submitter_idx
  on public.zagulyaky_claims(submitted_by, created_at desc);

create table if not exists public.zagulyaky_bookmarks (
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (record_id, user_id)
);

create index if not exists zagulyaky_bookmarks_user_idx
  on public.zagulyaky_bookmarks(user_id, created_at desc);

create table if not exists public.zagulyaky_duplicate_candidates (
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  candidate_record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  score numeric(5,4) not null check (score between 0 and 1),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'dismissed')),
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (record_id, candidate_record_id),
  check (record_id < candidate_record_id)
);

create table if not exists public.zagulyaky_moderation_actions (
  id bigint generated always as identity primary key,
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null check (action in (
    'submit', 'withdraw', 'publish', 'request_changes', 'reject',
    'archive', 'restore', 'merge', 'privacy_block', 'privacy_clear'
  )),
  from_status text,
  to_status text,
  note text not null default '' check (char_length(note) <= 8000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists zagulyaky_moderation_actions_record_idx
  on public.zagulyaky_moderation_actions(record_id, created_at desc);

-- Keep global public contributions and moderation history when an account is
-- deleted. Recreate these constraints as SET NULL as well when this migration
-- is retried after a partially-created schema.
alter table public.zagulyaky_records alter column created_by drop not null;
alter table public.zagulyaky_records drop constraint if exists zagulyaky_records_created_by_fkey;
alter table public.zagulyaky_records add constraint zagulyaky_records_created_by_fkey
  foreign key (created_by) references public.profiles(user_id) on delete set null;
alter table public.zagulyaky_sources alter column created_by drop not null;
alter table public.zagulyaky_sources drop constraint if exists zagulyaky_sources_created_by_fkey;
alter table public.zagulyaky_sources add constraint zagulyaky_sources_created_by_fkey
  foreign key (created_by) references public.profiles(user_id) on delete set null;
alter table public.zagulyaky_attachments alter column created_by drop not null;
alter table public.zagulyaky_attachments drop constraint if exists zagulyaky_attachments_created_by_fkey;
alter table public.zagulyaky_attachments add constraint zagulyaky_attachments_created_by_fkey
  foreign key (created_by) references public.profiles(user_id) on delete set null;
alter table public.zagulyaky_claims alter column submitted_by drop not null;
alter table public.zagulyaky_claims drop constraint if exists zagulyaky_claims_submitted_by_fkey;
alter table public.zagulyaky_claims add constraint zagulyaky_claims_submitted_by_fkey
  foreign key (submitted_by) references public.profiles(user_id) on delete set null;
alter table public.zagulyaky_moderation_actions alter column actor_id drop not null;
alter table public.zagulyaky_moderation_actions drop constraint if exists zagulyaky_moderation_actions_actor_id_fkey;
alter table public.zagulyaky_moderation_actions add constraint zagulyaky_moderation_actions_actor_id_fkey
  foreign key (actor_id) references public.profiles(user_id) on delete set null;

-- Automatic optimistic-lock and immutable record history.
create or replace function security_private.touch_zagulyaky_record_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.lock_version := old.lock_version + 1;
  end if;
  return new;
end;
$function$;

create or replace function security_private.capture_zagulyaky_record_version_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  full_snapshot jsonb;
begin
  select jsonb_build_object(
    'record', to_jsonb(new) - 'search_vector',
    'sources', coalesce((
      select jsonb_agg((to_jsonb(s) - 'created_by') || jsonb_build_object('isPrimary', rs.is_primary)
        order by rs.is_primary desc, s.created_at, s.id)
      from public.zagulyaky_record_sources rs
      join public.zagulyaky_sources s on s.id = rs.source_id
      where rs.record_id = new.id
    ), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.sort_order, p.id)
      from public.zagulyaky_participants p where p.record_id = new.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.id)
      from public.zagulyaky_document_discoveries d where d.record_id = new.id
    ), '[]'::jsonb)
  ) into full_snapshot;

  insert into public.zagulyaky_record_versions(record_id, revision_no, snapshot, actor_id)
  values (new.id, new.lock_version, full_snapshot, auth.uid())
  on conflict (record_id, revision_no) do nothing;
  return new;
end;
$function$;

drop trigger if exists zagulyaky_records_touch on public.zagulyaky_records;
create trigger zagulyaky_records_touch
before update on public.zagulyaky_records
for each row execute function security_private.touch_zagulyaky_record_v1();

drop trigger if exists zagulyaky_records_version on public.zagulyaky_records;
create trigger zagulyaky_records_version
after insert or update on public.zagulyaky_records
for each row execute function security_private.capture_zagulyaky_record_version_v1();

-- Base-table RLS is defence in depth. Client roles are additionally denied
-- direct table privileges below and must use the contract RPCs.
alter table public.zagulyaky_records enable row level security;
alter table public.zagulyaky_sources enable row level security;
alter table public.zagulyaky_record_sources enable row level security;
alter table public.zagulyaky_participants enable row level security;
alter table public.zagulyaky_document_discoveries enable row level security;
alter table public.zagulyaky_attachments enable row level security;
alter table public.zagulyaky_record_versions enable row level security;
alter table public.zagulyaky_confirmations enable row level security;
alter table public.zagulyaky_claims enable row level security;
alter table public.zagulyaky_bookmarks enable row level security;
alter table public.zagulyaky_duplicate_candidates enable row level security;
alter table public.zagulyaky_moderation_actions enable row level security;

drop policy if exists zagulyaky_records_owner_select on public.zagulyaky_records;
create policy zagulyaky_records_owner_select on public.zagulyaky_records
  for select to authenticated
  using (created_by = (select auth.uid()) or security_private.has_admin_permission_v1('zagulyaky.moderate'));

drop policy if exists zagulyaky_records_owner_insert on public.zagulyaky_records;
create policy zagulyaky_records_owner_insert on public.zagulyaky_records
  for insert to authenticated
  with check (created_by = (select auth.uid()) and status = 'draft');

drop policy if exists zagulyaky_records_owner_update on public.zagulyaky_records;
create policy zagulyaky_records_owner_update on public.zagulyaky_records
  for update to authenticated
  using (
    (created_by = (select auth.uid()) and status in ('draft', 'needs_changes', 'withdrawn'))
    or security_private.has_admin_permission_v1('zagulyaky.moderate')
  )
  with check (
    (created_by = (select auth.uid()) and status in ('draft', 'needs_changes', 'withdrawn'))
    or security_private.has_admin_permission_v1('zagulyaky.moderate')
  );

drop policy if exists zagulyaky_records_owner_delete on public.zagulyaky_records;
create policy zagulyaky_records_owner_delete on public.zagulyaky_records
  for delete to authenticated
  using (created_by = (select auth.uid()) and status in ('draft', 'needs_changes', 'withdrawn'));

-- Child tables inherit record ownership through EXISTS checks.
do $policies$
declare
  table_name text;
begin
  foreach table_name in array array[
    'zagulyaky_record_sources', 'zagulyaky_participants',
    'zagulyaky_document_discoveries', 'zagulyaky_attachments',
    'zagulyaky_record_versions', 'zagulyaky_duplicate_candidates',
    'zagulyaky_moderation_actions'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_owner_select', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (' ||
      'exists (select 1 from public.zagulyaky_records r where r.id = record_id ' ||
      'and (r.created_by = (select auth.uid()) or security_private.has_admin_permission_v1(''zagulyaky.moderate''))))',
      table_name || '_owner_select', table_name
    );
  end loop;
end;
$policies$;

drop policy if exists zagulyaky_sources_owner_select on public.zagulyaky_sources;
create policy zagulyaky_sources_owner_select on public.zagulyaky_sources
  for select to authenticated
  using (created_by = (select auth.uid()) or security_private.has_admin_permission_v1('zagulyaky.moderate'));

drop policy if exists zagulyaky_confirmations_owner_select on public.zagulyaky_confirmations;
create policy zagulyaky_confirmations_owner_select on public.zagulyaky_confirmations
  for select to authenticated
  using (user_id = (select auth.uid()) or security_private.has_admin_permission_v1('zagulyaky.moderate'));

drop policy if exists zagulyaky_claims_owner_select on public.zagulyaky_claims;
create policy zagulyaky_claims_owner_select on public.zagulyaky_claims
  for select to authenticated
  using (submitted_by = (select auth.uid()) or security_private.has_admin_permission_v1('zagulyaky.moderate'));

drop policy if exists zagulyaky_bookmarks_owner_select on public.zagulyaky_bookmarks;
create policy zagulyaky_bookmarks_owner_select on public.zagulyaky_bookmarks
  for select to authenticated using (user_id = (select auth.uid()));

-- Public search: only the explicit, privacy-cleared published projection is
-- serialized. Contributor identity and private attachment paths are excluded.
create or replace function security_private.search_zagulyaky_v1(
  p_kind text,
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  result jsonb;
begin
  if p_kind not in ('person', 'document') then
    raise exception 'INVALID_ZAGULYAKY_KIND' using errcode = '22023';
  end if;
  if p_filters is null or jsonb_typeof(p_filters) <> 'object' then
    raise exception 'INVALID_FILTERS' using errcode = '22023';
  end if;
  if char_length(coalesce(p_query, '')) > 200 then
    raise exception 'SEARCH_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  if (p_cursor_published_at is null) <> (p_cursor_id is null) then
    raise exception 'INCOMPLETE_SEARCH_CURSOR' using errcode = '22023';
  end if;
  if (p_filters ? 'yearFrom' and coalesce(p_filters->>'yearFrom', '') !~ '^\d{1,4}$')
    or (p_filters ? 'yearTo' and coalesce(p_filters->>'yearTo', '') !~ '^\d{1,4}$') then
    raise exception 'INVALID_YEAR_FILTER' using errcode = '22023';
  end if;

  with matched as (
    select r.*
    from public.zagulyaky_records r
    where r.kind = p_kind
      and r.status = 'published'
      and r.privacy_status = 'cleared'
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or r.search_vector @@ websearch_to_tsquery('simple'::regconfig, p_query)
        or r.title ilike '%' || p_query || '%'
        or exists (
          select 1 from public.zagulyaky_participants participant
          where participant.record_id = r.id
            and lower(coalesce(participant.original_full_name, '') || ' ' ||
              coalesce(participant.normalized_uk_full_name, '')) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
            and lower(coalesce(source.title, '') || ' ' || coalesce(source.citation, '') || ' ' ||
              coalesce(source.archive_name, '')) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1 from public.zagulyaky_document_discoveries discovery
          where discovery.record_id = r.id
            and lower(coalesce(discovery.official_location_text, '') || ' ' ||
              coalesce(discovery.discovered_location_text, '')) like '%' || lower(p_query) || '%'
        )
      )
      and (not (p_filters ? 'eventType') or r.event_type = p_filters->>'eventType')
      and (not (p_filters ? 'verificationStatus') or r.verification_status = p_filters->>'verificationStatus')
      and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters->>'yearFrom')::integer)
      and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters->>'yearTo')::integer)
      and (not (p_filters ? 'sourceLocation') or coalesce(r.source_location_normalized, r.source_location_text, '') ilike '%' || (p_filters->>'sourceLocation') || '%')
      and (not (p_filters ? 'foundLocation') or coalesce(r.found_location_normalized, r.found_location_text, '') ilike '%' || (p_filters->>'foundLocation') || '%')
      and (
        not (p_filters ? 'archiveName')
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources s on s.id = rs.source_id
          where rs.record_id = r.id
            and coalesce(s.archive_name, '') ilike '%' || (p_filters->>'archiveName') || '%'
        )
      )
      and (
        p_cursor_published_at is null
        or r.published_at < p_cursor_published_at
        or (r.published_at = p_cursor_published_at and r.id < p_cursor_id)
      )
    order by r.published_at desc, r.id desc
    limit safe_limit + 1
  ), page_rows as (
    select * from matched order by published_at desc, id desc limit safe_limit
  ), last_row as (
    select published_at, id from page_rows order by published_at, id limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'slug', r.public_slug,
        'kind', r.kind,
        'title', r.title,
        'summary', r.summary,
        'subject', (
          select jsonb_build_object(
            'originalFullName', participant.original_full_name,
            'normalizedUkFullName', participant.normalized_uk_full_name,
            'sex', participant.sex,
            'ageText', participant.age_text
          )
          from public.zagulyaky_participants participant
          where participant.record_id = r.id and participant.role = 'subject'
          order by participant.sort_order, participant.id
          limit 1
        ),
        'primarySource', (
          select jsonb_build_object(
            'sourceType', source.source_type,
            'title', source.title,
            'archiveName', source.archive_name,
            'citation', source.citation,
            'pageFrom', source.page_from,
            'pageTo', source.page_to,
            'sourceUrl', source.source_url
          )
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
          order by rs.is_primary desc, source.created_at, source.id
          limit 1
        ),
        'documentDiscovery', (
          select jsonb_build_object(
            'officialLocationText', discovery.official_location_text,
            'discoveredLocationText', discovery.discovered_location_text,
            'recordTypes', discovery.record_types,
            'factualYearFrom', discovery.factual_year_from,
            'factualYearTo', discovery.factual_year_to,
            'pageFrom', discovery.page_from,
            'pageTo', discovery.page_to
          )
          from public.zagulyaky_document_discoveries discovery
          where discovery.record_id = r.id
          order by discovery.id
          limit 1
        ),
        'eventType', r.event_type,
        'eventDateText', r.event_date_text,
        'eventYearFrom', r.event_year_from,
        'eventYearTo', r.event_year_to,
        'datePrecision', r.date_precision,
        'sourceLocation', coalesce(r.source_location_normalized, r.source_location_text),
        'foundLocation', coalesce(r.found_location_normalized, r.found_location_text),
        'verificationStatus', r.verification_status,
        'publishedAt', r.published_at,
        'confirmationCount', (
          select count(*) from public.zagulyaky_confirmations c
          where c.record_id = r.id and c.confirmation_type in ('confirm', 'source_checked')
        )
      ) order by r.published_at desc, r.id desc)
      from page_rows r
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from matched) > safe_limit then (
      select jsonb_build_object('publishedAt', published_at, 'id', id) from last_row
    ) else null end
  ) into result;

  return result;
end;
$function$;

create or replace function public.search_zagulyaky_people_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select security_private.search_zagulyaky_v1('person', p_query, p_filters, p_limit, p_cursor_published_at, p_cursor_id)
$function$;

create or replace function public.search_zagulyaky_documents_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select security_private.search_zagulyaky_v1('document', p_query, p_filters, p_limit, p_cursor_published_at, p_cursor_id)
$function$;

create or replace function public.get_public_zagulyaka_v1(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
begin
  if char_length(btrim(coalesce(p_slug, ''))) not between 3 and 180 then
    return null;
  end if;
  select jsonb_build_object(
    'id', r.id,
    'slug', r.public_slug,
    'kind', r.kind,
    'title', r.title,
    'summary', r.summary,
    'originalText', r.original_text,
    'normalizedText', r.normalized_text,
    'originalLanguage', r.original_language,
    'eventType', r.event_type,
    'eventDateText', r.event_date_text,
    'eventYearFrom', r.event_year_from,
    'eventYearTo', r.event_year_to,
    'datePrecision', r.date_precision,
    'sourceLocationText', r.source_location_text,
    'sourceLocationNormalized', r.source_location_normalized,
    'foundLocationText', r.found_location_text,
    'foundLocationNormalized', r.found_location_normalized,
    'classificationReason', r.classification_reason,
    'verificationStatus', r.verification_status,
    'contributor', case when r.public_attribution then coalesce(r.public_attribution_name, 'Учасник спільноти') else null end,
    'publishedAt', r.published_at,
    'updatedAt', r.updated_at,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'role', p.role,
        'originalFullName', p.original_full_name,
        'normalizedUkFullName', p.normalized_uk_full_name,
        'surname', p.surname,
        'givenName', p.given_name,
        'patronymic', p.patronymic,
        'maidenName', p.maiden_name,
        'sex', p.sex,
        'ageText', p.age_text,
        'residenceText', p.residence_text,
        'originText', p.origin_text,
        'notes', p.notes
      ) order by p.sort_order, p.id)
      from public.zagulyaky_participants p where p.record_id = r.id
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'sourceType', s.source_type,
        'title', s.title,
        'archiveName', s.archive_name,
        'fond', s.fond,
        'inventory', s.inventory,
        'fileNumber', s.file_number,
        'pageFrom', s.page_from,
        'pageTo', s.page_to,
        'citation', s.citation,
        'sourceUrl', s.source_url,
        'sourcePlatform', s.source_platform,
        'accessDate', s.access_date,
        'permissionStatus', s.permission_status,
        'isPrimary', rs.is_primary
      ) order by rs.is_primary desc, s.created_at, s.id)
      from public.zagulyaky_record_sources rs
      join public.zagulyaky_sources s on s.id = rs.source_id
      where rs.record_id = r.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'officialLocationText', d.official_location_text,
        'discoveredLocationText', d.discovered_location_text,
        'recordTypes', d.record_types,
        'factualYearFrom', d.factual_year_from,
        'factualYearTo', d.factual_year_to,
        'pageFrom', d.page_from,
        'pageTo', d.page_to,
        'notes', d.notes
      ) order by d.id)
      from public.zagulyaky_document_discoveries d where d.record_id = r.id
    ), '[]'::jsonb),
    'publicAttachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'bucket', a.public_bucket,
        'path', a.public_path,
        'fileName', a.file_name,
        'mimeType', a.mime_type,
        'byteSize', a.byte_size
      ) order by a.created_at, a.id)
      from public.zagulyaky_attachments a
      where a.record_id = r.id
        and a.is_public_derivative
        and a.public_bucket is not null
        and a.public_path is not null
    ), '[]'::jsonb),
    'confirmationCount', (
      select count(*) from public.zagulyaky_confirmations c
      where c.record_id = r.id and c.confirmation_type in ('confirm', 'source_checked')
    )
  ) into result
  from public.zagulyaky_records r
  where lower(r.public_slug) = lower(btrim(p_slug))
    and r.status = 'published'
    and r.privacy_status = 'cleared';

  return result;
end;
$function$;

create or replace function public.get_zagulyaky_public_stats_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with visible as (
    select * from public.zagulyaky_records
    where status = 'published' and privacy_status = 'cleared'
  ), locations as (
    select nullif(btrim(coalesce(source_location_normalized, source_location_text)), '') as location from visible
    union
    select nullif(btrim(coalesce(found_location_normalized, found_location_text)), '') from visible
    union
    select nullif(btrim(discovery.official_location_text), '')
      from public.zagulyaky_document_discoveries discovery join visible on visible.id = discovery.record_id
    union
    select nullif(btrim(discovery.discovered_location_text), '')
      from public.zagulyaky_document_discoveries discovery join visible on visible.id = discovery.record_id
  )
  select jsonb_build_object(
    'people', count(*) filter (where kind = 'person'),
    'documents', count(*) filter (where kind = 'document'),
    'verified', count(*) filter (where verification_status = 'verified'),
    'corroboratedOrVerified', count(*) filter (where verification_status in ('corroborated', 'verified')),
    'places', (select count(*) from locations where location is not null),
    'archives', (
      select count(distinct lower(btrim(source.archive_name)))
      from public.zagulyaky_record_sources rs
      join visible on visible.id = rs.record_id
      join public.zagulyaky_sources source on source.id = rs.source_id
      where nullif(btrim(source.archive_name), '') is not null
    ),
    'contributors', count(distinct created_by) filter (where created_by is not null),
    'addedLast30Days', count(*) filter (where published_at >= now() - interval '30 days'),
    'yearFrom', min(event_year_from),
    'yearTo', max(coalesce(event_year_to, event_year_from))
  )
  from visible
$function$;

-- Authenticated author's contracts.
create or replace function public.create_zagulyaka_draft_v1(
  p_kind text,
  p_record jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  created_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_kind not in ('person', 'document') then raise exception 'INVALID_ZAGULYAKY_KIND' using errcode = '22023'; end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' then raise exception 'INVALID_RECORD' using errcode = '22023'; end if;
  if octet_length(p_record::text) > 1048576 then raise exception 'RECORD_PAYLOAD_TOO_LARGE' using errcode = '54000'; end if;
  if (select count(*) from public.zagulyaky_records r
      where r.created_by = current_user_id and r.created_at >= now() - interval '1 hour') >= 30 then
    raise exception 'ZAGULYAKY_DRAFT_RATE_LIMITED' using errcode = 'P0001';
  end if;

  insert into public.zagulyaky_records(
    kind, title, summary, original_text, normalized_text, original_language,
    event_type, event_date_text, event_year_from, event_year_to, date_precision,
    source_location_text, source_location_normalized,
    found_location_text, found_location_normalized, classification_reason, payload,
    possible_living_person, submission_terms_version, rights_confirmed_at,
    public_attribution, public_attribution_name, created_by
  ) values (
    p_kind,
    coalesce(nullif(btrim(p_record->>'title'), ''), 'Нова загуляка'),
    coalesce(p_record->>'summary', ''),
    coalesce(p_record->>'originalText', ''),
    coalesce(p_record->>'normalizedText', ''),
    nullif(btrim(p_record->>'originalLanguage'), ''),
    nullif(btrim(p_record->>'eventType'), ''),
    nullif(btrim(p_record->>'eventDateText'), ''),
    case when p_record->>'eventYearFrom' ~ '^\d{1,4}$' then (p_record->>'eventYearFrom')::integer end,
    case when p_record->>'eventYearTo' ~ '^\d{1,4}$' then (p_record->>'eventYearTo')::integer end,
    nullif(btrim(p_record->>'datePrecision'), ''),
    nullif(btrim(p_record->>'sourceLocationText'), ''),
    nullif(btrim(p_record->>'sourceLocationNormalized'), ''),
    nullif(btrim(p_record->>'foundLocationText'), ''),
    nullif(btrim(p_record->>'foundLocationNormalized'), ''),
    coalesce(p_record->>'classificationReason', ''),
    coalesce(p_record->'payload', '{}'::jsonb),
    coalesce((p_record->>'possibleLivingPerson')::boolean, false),
    case when p_record->>'submissionTermsVersion' ~ '^\d{1,3}$' then (p_record->>'submissionTermsVersion')::smallint end,
    case when coalesce((p_record->>'rightsConfirmed')::boolean, false) then now() end,
    coalesce((p_record->>'publicAttribution')::boolean, false),
    nullif(btrim(p_record->>'publicAttributionName'), ''),
    current_user_id
  ) returning * into created_record;

  return (to_jsonb(created_record) - 'search_vector');
end;
$function$;

create or replace function public.update_my_zagulyaka_draft_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH' using errcode = '22023'; end if;
  if octet_length(p_patch::text) > 1048576 then raise exception 'RECORD_PAYLOAD_TOO_LARGE' using errcode = '54000'; end if;

  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_EDITABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;

  update public.zagulyaky_records r set
    status = case when existing.status = 'withdrawn' then 'draft' else existing.status end,
    title = case when p_patch ? 'title' then coalesce(nullif(btrim(p_patch->>'title'), ''), existing.title) else existing.title end,
    summary = case when p_patch ? 'summary' then coalesce(p_patch->>'summary', '') else existing.summary end,
    original_text = case when p_patch ? 'originalText' then coalesce(p_patch->>'originalText', '') else existing.original_text end,
    normalized_text = case when p_patch ? 'normalizedText' then coalesce(p_patch->>'normalizedText', '') else existing.normalized_text end,
    original_language = case when p_patch ? 'originalLanguage' then nullif(btrim(p_patch->>'originalLanguage'), '') else existing.original_language end,
    event_type = case when p_patch ? 'eventType' then nullif(btrim(p_patch->>'eventType'), '') else existing.event_type end,
    event_date_text = case when p_patch ? 'eventDateText' then nullif(btrim(p_patch->>'eventDateText'), '') else existing.event_date_text end,
    event_year_from = case when p_patch ? 'eventYearFrom' then case when p_patch->>'eventYearFrom' ~ '^\d{1,4}$' then (p_patch->>'eventYearFrom')::integer end else existing.event_year_from end,
    event_year_to = case when p_patch ? 'eventYearTo' then case when p_patch->>'eventYearTo' ~ '^\d{1,4}$' then (p_patch->>'eventYearTo')::integer end else existing.event_year_to end,
    date_precision = case when p_patch ? 'datePrecision' then nullif(btrim(p_patch->>'datePrecision'), '') else existing.date_precision end,
    source_location_text = case when p_patch ? 'sourceLocationText' then nullif(btrim(p_patch->>'sourceLocationText'), '') else existing.source_location_text end,
    source_location_normalized = case when p_patch ? 'sourceLocationNormalized' then nullif(btrim(p_patch->>'sourceLocationNormalized'), '') else existing.source_location_normalized end,
    found_location_text = case when p_patch ? 'foundLocationText' then nullif(btrim(p_patch->>'foundLocationText'), '') else existing.found_location_text end,
    found_location_normalized = case when p_patch ? 'foundLocationNormalized' then nullif(btrim(p_patch->>'foundLocationNormalized'), '') else existing.found_location_normalized end,
    classification_reason = case when p_patch ? 'classificationReason' then coalesce(p_patch->>'classificationReason', '') else existing.classification_reason end,
    payload = case when p_patch ? 'payload' and jsonb_typeof(p_patch->'payload') = 'object' then p_patch->'payload' else existing.payload end,
    possible_living_person = case when p_patch ? 'possibleLivingPerson' then coalesce((p_patch->>'possibleLivingPerson')::boolean, false) else existing.possible_living_person end,
    submission_terms_version = case when p_patch ? 'submissionTermsVersion' and p_patch->>'submissionTermsVersion' ~ '^\d{1,3}$' then (p_patch->>'submissionTermsVersion')::smallint else existing.submission_terms_version end,
    rights_confirmed_at = case when p_patch ? 'rightsConfirmed' then case when coalesce((p_patch->>'rightsConfirmed')::boolean, false) then now() else null end else existing.rights_confirmed_at end,
    public_attribution = case when p_patch ? 'publicAttribution' then coalesce((p_patch->>'publicAttribution')::boolean, false) else existing.public_attribution end,
    public_attribution_name = case when p_patch ? 'publicAttributionName' then nullif(btrim(p_patch->>'publicAttributionName'), '') else existing.public_attribution_name end
  where r.id = existing.id
  returning * into updated_record;

  return (to_jsonb(updated_record) - 'search_vector');
end;
$function$;

create or replace function public.replace_my_zagulyaka_details_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_sources jsonb default '[]'::jsonb,
  p_participants jsonb default '[]'::jsonb,
  p_document_discoveries jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  item jsonb;
  source_id uuid;
  previous_source_ids uuid[];
  item_index integer := 0;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_sources is null or p_participants is null or p_document_discoveries is null
    or jsonb_typeof(p_sources) <> 'array' or jsonb_typeof(p_participants) <> 'array'
    or jsonb_typeof(p_document_discoveries) <> 'array' then
    raise exception 'DETAILS_MUST_BE_ARRAYS' using errcode = '22023';
  end if;
  if octet_length(p_sources::text) + octet_length(p_participants::text)
      + octet_length(p_document_discoveries::text) > 4194304 then
    raise exception 'DETAILS_PAYLOAD_TOO_LARGE' using errcode = '54000';
  end if;
  if jsonb_array_length(p_sources) > 20 or jsonb_array_length(p_participants) > 100
    or jsonb_array_length(p_document_discoveries) > 100 then
    raise exception 'DETAILS_LIMIT_EXCEEDED' using errcode = '54000';
  end if;

  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_EDITABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;

  select coalesce(array_agg(rs.source_id), '{}'::uuid[]) into previous_source_ids
  from public.zagulyaky_record_sources rs where rs.record_id = existing.id;
  delete from public.zagulyaky_record_sources where record_id = existing.id;
  delete from public.zagulyaky_sources s
  where s.id = any(previous_source_ids)
    and s.created_by = current_user_id
    and not exists (select 1 from public.zagulyaky_record_sources rs where rs.source_id = s.id);
  delete from public.zagulyaky_participants where record_id = existing.id;
  delete from public.zagulyaky_document_discoveries where record_id = existing.id;

  item_index := 0;
  for item in select value from jsonb_array_elements(p_sources) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'INVALID_SOURCE'; end if;
    insert into public.zagulyaky_sources(
      source_type, title, archive_name, fond, inventory, file_number,
      page_from, page_to, citation, source_url, source_platform, external_id,
      access_date, permission_status, metadata, created_by
    ) values (
      coalesce(nullif(item->>'sourceType', ''), 'other'),
      coalesce(item->>'title', ''), nullif(item->>'archiveName', ''),
      nullif(item->>'fond', ''), nullif(item->>'inventory', ''), nullif(item->>'fileNumber', ''),
      nullif(item->>'pageFrom', ''), nullif(item->>'pageTo', ''), coalesce(item->>'citation', ''),
      nullif(item->>'sourceUrl', ''), nullif(item->>'sourcePlatform', ''), nullif(item->>'externalId', ''),
      case when item->>'accessDate' ~ '^\d{4}-\d{2}-\d{2}$' then (item->>'accessDate')::date end,
      coalesce(nullif(item->>'permissionStatus', ''), 'unknown'),
      case when jsonb_typeof(item->'metadata') = 'object' then item->'metadata' else '{}'::jsonb end,
      current_user_id
    ) returning id into source_id;
    insert into public.zagulyaky_record_sources(record_id, source_id, is_primary)
    values (existing.id, source_id, item_index = 0);
    item_index := item_index + 1;
  end loop;

  item_index := 0;
  for item in select value from jsonb_array_elements(p_participants) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'INVALID_PARTICIPANT'; end if;
    insert into public.zagulyaky_participants(
      record_id, role, original_full_name, normalized_uk_full_name,
      surname, given_name, patronymic, maiden_name, sex, age_text,
      residence_text, origin_text, notes, sort_order
    ) values (
      existing.id, coalesce(nullif(item->>'role', ''), 'subject'),
      coalesce(item->>'originalFullName', ''), coalesce(item->>'normalizedUkFullName', ''),
      nullif(item->>'surname', ''), nullif(item->>'givenName', ''), nullif(item->>'patronymic', ''),
      nullif(item->>'maidenName', ''), nullif(item->>'sex', ''), nullif(item->>'ageText', ''),
      nullif(item->>'residenceText', ''), nullif(item->>'originText', ''),
      coalesce(item->>'notes', ''), item_index
    );
    item_index := item_index + 1;
  end loop;

  for item in select value from jsonb_array_elements(p_document_discoveries) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'INVALID_DOCUMENT_DISCOVERY'; end if;
    insert into public.zagulyaky_document_discoveries(
      record_id, official_location_text, discovered_location_text, record_types,
      factual_year_from, factual_year_to, page_from, page_to, notes
    ) values (
      existing.id, coalesce(item->>'officialLocationText', ''), coalesce(item->>'discoveredLocationText', ''),
      coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(item->'recordTypes') = 'array' then item->'recordTypes' else '[]'::jsonb end)), '{}'::text[]),
      case when item->>'factualYearFrom' ~ '^\d{1,4}$' then (item->>'factualYearFrom')::integer end,
      case when item->>'factualYearTo' ~ '^\d{1,4}$' then (item->>'factualYearTo')::integer end,
      nullif(item->>'pageFrom', ''), nullif(item->>'pageTo', ''), coalesce(item->>'notes', '')
    );
  end loop;

  update public.zagulyaky_records set status = case when status = 'withdrawn' then 'draft' else status end
  where id = existing.id returning * into updated_record;
  return jsonb_build_object('record', to_jsonb(updated_record) - 'search_vector');
end;
$function$;

create or replace function public.submit_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_SUBMITTABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;
  if btrim(existing.title) = '' or btrim(existing.classification_reason) = '' then
    raise exception 'ZAGULYAKA_REQUIRED_FIELDS_MISSING' using errcode = '23514';
  end if;
  if existing.kind = 'person' and (existing.event_type is null or existing.found_location_text is null) then
    raise exception 'PERSON_EVENT_AND_FOUND_LOCATION_REQUIRED' using errcode = '23514';
  end if;
  if existing.kind = 'person' and not exists (
    select 1 from public.zagulyaky_participants participant
    where participant.record_id = existing.id
      and participant.role = 'subject'
      and nullif(btrim(coalesce(nullif(participant.normalized_uk_full_name, ''), participant.original_full_name)), '') is not null
  ) then
    raise exception 'PERSON_SUBJECT_REQUIRED' using errcode = '23514';
  end if;
  if existing.kind = 'document' and not exists (
    select 1 from public.zagulyaky_document_discoveries discovery
    where discovery.record_id = existing.id
      and nullif(btrim(discovery.official_location_text), '') is not null
      and nullif(btrim(discovery.discovered_location_text), '') is not null
  ) then
    raise exception 'DOCUMENT_LOCATIONS_REQUIRED' using errcode = '23514';
  end if;
  if not exists (select 1 from public.zagulyaky_record_sources rs where rs.record_id = existing.id) then
    raise exception 'ZAGULYAKA_SOURCE_REQUIRED' using errcode = '23514';
  end if;
  if existing.submission_terms_version is null or existing.rights_confirmed_at is null then
    raise exception 'ZAGULYAKA_RIGHTS_CONFIRMATION_REQUIRED' using errcode = '23514';
  end if;

  update public.zagulyaky_records set status = 'pending_review', submitted_at = now(), moderation_note = null
  where id = existing.id returning * into updated_record;
  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status)
  values (existing.id, current_user_id, 'submit', existing.status, 'pending_review');
  return to_jsonb(updated_record) - 'search_vector';
end;
$function$;

create or replace function public.withdraw_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('pending_review', 'needs_changes') then raise exception 'ZAGULYAKA_NOT_WITHDRAWABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;
  update public.zagulyaky_records set status = 'withdrawn' where id = existing.id returning * into updated_record;
  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status)
  values (existing.id, current_user_id, 'withdraw', existing.status, 'withdrawn');
  return to_jsonb(updated_record) - 'search_vector';
end;
$function$;

create or replace function public.delete_my_zagulyaka_draft_v1(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  existing public.zagulyaky_records;
  owned_source_ids uuid[] := '{}'::uuid[];
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from auth.uid() then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_DELETABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;
  select coalesce(array_agg(rs.source_id), '{}'::uuid[]) into owned_source_ids
  from public.zagulyaky_record_sources rs where rs.record_id = existing.id;
  delete from public.zagulyaky_records where id = existing.id;
  delete from public.zagulyaky_sources source
  where source.id = any(owned_source_ids)
    and source.created_by = auth.uid()
    and not exists (
      select 1 from public.zagulyaky_record_sources rs where rs.source_id = source.id
    );
  return true;
end;
$function$;

create or replace function public.get_my_zagulyaky_v1(
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select case when auth.uid() is null then '[]'::jsonb else coalesce(jsonb_agg(item order by item_updated_at desc), '[]'::jsonb) end
  from (
    select (to_jsonb(r) - 'search_vector' - 'created_by' - 'moderated_by') as item, r.updated_at as item_updated_at
    from public.zagulyaky_records r
    where r.created_by = auth.uid()
      and (p_status is null or r.status = p_status)
    order by r.updated_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ) q
$function$;

create or replace function public.get_my_zagulyaka_draft_v1(p_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  result jsonb;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.zagulyaky_records r
    where r.id = p_record_id
      and (r.created_by = current_user_id or security_private.has_admin_permission_v1('zagulyaky.moderate'))
  ) then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'record', to_jsonb(r) - 'search_vector' - 'moderated_by',
    'sources', coalesce((
      select jsonb_agg((to_jsonb(s) - 'created_by') || jsonb_build_object('isPrimary', rs.is_primary)
        order by rs.is_primary desc, s.created_at, s.id)
      from public.zagulyaky_record_sources rs
      join public.zagulyaky_sources s on s.id = rs.source_id
      where rs.record_id = r.id
    ), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.sort_order, p.id)
      from public.zagulyaky_participants p where p.record_id = r.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.id)
      from public.zagulyaky_document_discoveries d where d.record_id = r.id
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(to_jsonb(a) - 'created_by' order by a.created_at, a.id)
      from public.zagulyaky_attachments a where a.record_id = r.id
    ), '[]'::jsonb)
  ) into result
  from public.zagulyaky_records r where r.id = p_record_id;

  return result;
end;
$function$;

create or replace function public.confirm_zagulyaka_v1(
  p_record_id uuid,
  p_confirmation_type text default 'confirm',
  p_comment text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result public.zagulyaky_confirmations;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_confirmation_type not in ('confirm', 'source_checked', 'correction_suggested', 'duplicate_suggested') then
    raise exception 'INVALID_CONFIRMATION_TYPE' using errcode = '22023';
  end if;
  if not exists (select 1 from public.zagulyaky_records where id = p_record_id and status = 'published' and privacy_status = 'cleared') then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.zagulyaky_confirmations(record_id, user_id, confirmation_type, comment)
  values (p_record_id, auth.uid(), p_confirmation_type, left(coalesce(p_comment, ''), 4000))
  on conflict (record_id, user_id, confirmation_type) do update
    set comment = excluded.comment, created_at = now()
  returning * into result;
  return to_jsonb(result) - 'user_id';
end;
$function$;

create or replace function public.create_zagulyaka_claim_v1(
  p_record_id uuid,
  p_claim_type text,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result public.zagulyaky_claims;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_claim_type not in ('correction', 'privacy', 'copyright', 'abuse', 'source_problem', 'other') then
    raise exception 'INVALID_CLAIM_TYPE' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_message, ''))) not between 10 and 8000 then
    raise exception 'INVALID_CLAIM_MESSAGE' using errcode = '22023';
  end if;
  if not exists (select 1 from public.zagulyaky_records where id = p_record_id and status = 'published') then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if (select count(*) from public.zagulyaky_claims c
      where c.submitted_by = auth.uid() and c.created_at >= now() - interval '1 hour') >= 10 then
    raise exception 'ZAGULYAKY_CLAIM_RATE_LIMITED' using errcode = 'P0001';
  end if;
  insert into public.zagulyaky_claims(record_id, submitted_by, claim_type, message)
  values (p_record_id, auth.uid(), p_claim_type, btrim(p_message)) returning * into result;
  return to_jsonb(result) - 'submitted_by' - 'resolved_by';
end;
$function$;

create or replace function public.set_zagulyaka_bookmark_v1(p_record_id uuid, p_bookmarked boolean)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from public.zagulyaky_records where id = p_record_id and status = 'published' and privacy_status = 'cleared') then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if coalesce(p_bookmarked, false) then
    insert into public.zagulyaky_bookmarks(record_id, user_id) values (p_record_id, auth.uid()) on conflict do nothing;
  else
    delete from public.zagulyaky_bookmarks where record_id = p_record_id and user_id = auth.uid();
  end if;
  return coalesce(p_bookmarked, false);
end;
$function$;

-- Moderator contracts. Moderation status and public evidence status remain
-- deliberately separate.
create or replace function public.admin_list_zagulyaky_queue_v1(
  p_status text default 'pending_review',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in (
    'draft', 'pending_review', 'needs_changes', 'published',
    'rejected', 'withdrawn', 'merged', 'archived'
  ) then
    raise exception 'INVALID_ZAGULYAKA_STATUS' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(to_jsonb(q) order by q.submitted_at nulls last, q.created_at), '[]'::jsonb),
    'total', (select count(*) from public.zagulyaky_records r where p_status is null or r.status = p_status)
  ) into result
  from (
    select r.id, r.kind, r.status, r.verification_status, r.privacy_status,
      r.title, r.summary, r.event_type, r.event_date_text, r.event_year_from,
      r.event_year_to, r.source_location_text, r.found_location_text,
      r.classification_reason, r.created_by, r.lock_version, r.submitted_at,
      r.possible_living_person, r.submission_terms_version, r.rights_confirmed_at,
      r.created_at, r.updated_at,
      (select count(*) from public.zagulyaky_record_sources rs where rs.record_id = r.id) as source_count,
      (select count(*) from public.zagulyaky_duplicate_candidates dc where dc.record_id = r.id or dc.candidate_record_id = r.id) as duplicate_candidate_count
    from public.zagulyaky_records r
    where p_status is null or r.status = p_status
    order by r.submitted_at nulls last, r.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ) q;
  return result;
end;
$function$;

create or replace function public.admin_review_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_action text,
  p_note text default '',
  p_verification_status text default null,
  p_privacy_status text default null,
  p_public_slug text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  updated_record public.zagulyaky_records;
  next_status text;
  action_code text;
  safe_slug text;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;
  if p_verification_status is not null and p_verification_status not in ('unverified', 'plausible', 'corroborated', 'verified', 'disputed') then
    raise exception 'INVALID_VERIFICATION_STATUS' using errcode = '22023';
  end if;
  if p_privacy_status is not null and p_privacy_status not in ('pending', 'cleared', 'blocked', 'requires_consent') then
    raise exception 'INVALID_PRIVACY_STATUS' using errcode = '22023';
  end if;

  case p_action
    when 'publish' then next_status := 'published'; action_code := 'publish';
    when 'request_changes' then next_status := 'needs_changes'; action_code := 'request_changes';
    when 'reject' then next_status := 'rejected'; action_code := 'reject';
    when 'archive' then next_status := 'archived'; action_code := 'archive';
    when 'restore' then next_status := 'pending_review'; action_code := 'restore';
    else raise exception 'INVALID_MODERATION_ACTION' using errcode = '22023';
  end case;

  if p_action in ('publish', 'request_changes', 'reject') and existing.status <> 'pending_review' then
    raise exception 'INVALID_MODERATION_TRANSITION' using errcode = '55000';
  end if;
  if p_action = 'archive' and existing.status not in ('published', 'rejected') then
    raise exception 'INVALID_MODERATION_TRANSITION' using errcode = '55000';
  end if;
  if p_action = 'restore' and existing.status <> 'archived' then
    raise exception 'INVALID_MODERATION_TRANSITION' using errcode = '55000';
  end if;

  if p_action in ('request_changes', 'reject') and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'MODERATION_NOTE_REQUIRED' using errcode = '23514';
  end if;
  if p_action = 'publish' then
    if coalesce(p_privacy_status, existing.privacy_status) <> 'cleared' then
      raise exception 'PRIVACY_CLEARANCE_REQUIRED' using errcode = '23514';
    end if;
    if not exists (select 1 from public.zagulyaky_record_sources rs where rs.record_id = existing.id) then
      raise exception 'ZAGULYAKA_SOURCE_REQUIRED' using errcode = '23514';
    end if;
    safe_slug := left(lower(regexp_replace(coalesce(nullif(btrim(p_public_slug), ''), 'z-' || replace(existing.id::text, '-', '')), '[^a-z0-9-]+', '-', 'g')), 180);
    safe_slug := trim(both '-' from safe_slug);
    if char_length(safe_slug) < 3 then safe_slug := 'z-' || replace(existing.id::text, '-', ''); end if;
  else
    safe_slug := existing.public_slug;
  end if;

  update public.zagulyaky_records set
    status = next_status,
    verification_status = coalesce(p_verification_status, verification_status),
    privacy_status = coalesce(p_privacy_status, privacy_status),
    public_slug = safe_slug,
    published_at = case when next_status = 'published' then coalesce(published_at, now()) else published_at end,
    moderated_by = current_user_id,
    moderation_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = existing.id returning * into updated_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, note)
  values (existing.id, current_user_id, action_code, existing.status, next_status, coalesce(p_note, ''));

  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (
    current_user_id, 'zagulyaky.' || action_code, 'zagulyaky_record', existing.id::text, 'success',
    jsonb_build_object('fromStatus', existing.status, 'toStatus', next_status,
      'verificationStatus', updated_record.verification_status, 'privacyStatus', updated_record.privacy_status)
  );

  return to_jsonb(updated_record) - 'search_vector';
end;
$function$;

create or replace function public.admin_resolve_zagulyaka_claim_v1(
  p_claim_id uuid,
  p_status text,
  p_resolution_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  updated_claim public.zagulyaky_claims;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_status not in ('reviewing', 'resolved', 'rejected') then
    raise exception 'INVALID_CLAIM_STATUS' using errcode = '22023';
  end if;
  if p_status in ('resolved', 'rejected') and char_length(btrim(coalesce(p_resolution_note, ''))) < 3 then
    raise exception 'RESOLUTION_NOTE_REQUIRED' using errcode = '23514';
  end if;

  update public.zagulyaky_claims set
    status = p_status,
    resolution_note = nullif(btrim(coalesce(p_resolution_note, '')), ''),
    resolved_by = case when p_status in ('resolved', 'rejected') then current_user_id else null end,
    resolved_at = case when p_status in ('resolved', 'rejected') then now() else null end,
    updated_at = now()
  where id = p_claim_id returning * into updated_claim;
  if not found then raise exception 'ZAGULYAKA_CLAIM_NOT_FOUND' using errcode = 'P0002'; end if;

  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (current_user_id, 'zagulyaky.claim.' || p_status, 'zagulyaky_claim', p_claim_id::text,
    'success', jsonb_build_object('status', p_status));
  return to_jsonb(updated_claim) - 'submitted_by';
end;
$function$;

create or replace function public.admin_list_zagulyaky_claims_v1(
  p_status text default 'open',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('open', 'reviewing', 'resolved', 'rejected') then
    raise exception 'INVALID_CLAIM_STATUS' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'items', coalesce(jsonb_agg(to_jsonb(item) order by item.created_at), '[]'::jsonb),
    'total', (
      select count(*) from public.zagulyaky_claims claim
      where p_status is null or claim.status = p_status
    )
  ) into result
  from (
    select claim.id, claim.record_id, record.public_slug, record.title as record_title,
      claim.submitted_by, claim.claim_type, claim.message, claim.status,
      claim.resolution_note, claim.resolved_by, claim.resolved_at,
      claim.created_at, claim.updated_at
    from public.zagulyaky_claims claim
    join public.zagulyaky_records record on record.id = claim.record_id
    where p_status is null or claim.status = p_status
    order by claim.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ) item;
  return result;
end;
$function$;

-- Direct table access is intentionally unavailable to browser roles. RLS
-- remains enabled as a second layer and service jobs retain explicit access.
revoke all on table public.zagulyaky_records from public, anon, authenticated;
revoke all on table public.zagulyaky_sources from public, anon, authenticated;
revoke all on table public.zagulyaky_record_sources from public, anon, authenticated;
revoke all on table public.zagulyaky_participants from public, anon, authenticated;
revoke all on table public.zagulyaky_document_discoveries from public, anon, authenticated;
revoke all on table public.zagulyaky_attachments from public, anon, authenticated;
revoke all on table public.zagulyaky_record_versions from public, anon, authenticated;
revoke all on table public.zagulyaky_confirmations from public, anon, authenticated;
revoke all on table public.zagulyaky_claims from public, anon, authenticated;
revoke all on table public.zagulyaky_bookmarks from public, anon, authenticated;
revoke all on table public.zagulyaky_duplicate_candidates from public, anon, authenticated;
revoke all on table public.zagulyaky_moderation_actions from public, anon, authenticated;

grant all on table public.zagulyaky_records to service_role;
grant all on table public.zagulyaky_sources to service_role;
grant all on table public.zagulyaky_record_sources to service_role;
grant all on table public.zagulyaky_participants to service_role;
grant all on table public.zagulyaky_document_discoveries to service_role;
grant all on table public.zagulyaky_attachments to service_role;
grant all on table public.zagulyaky_record_versions to service_role;
grant all on table public.zagulyaky_confirmations to service_role;
grant all on table public.zagulyaky_claims to service_role;
grant all on table public.zagulyaky_bookmarks to service_role;
grant all on table public.zagulyaky_duplicate_candidates to service_role;
grant all on table public.zagulyaky_moderation_actions to service_role;
grant usage, select on sequence public.zagulyaky_record_versions_id_seq to service_role;
grant usage, select on sequence public.zagulyaky_moderation_actions_id_seq to service_role;

revoke all on function security_private.touch_zagulyaky_record_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.capture_zagulyaky_record_version_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.search_zagulyaky_v1(text,text,jsonb,integer,timestamptz,uuid) from public, anon, authenticated, service_role;
grant execute on function security_private.search_zagulyaky_v1(text,text,jsonb,integer,timestamptz,uuid) to service_role;

revoke all on function public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid) from public;
revoke all on function public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid) from public;
revoke all on function public.get_public_zagulyaka_v1(text) from public;
revoke all on function public.get_zagulyaky_public_stats_v1() from public;
grant execute on function public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid) to anon, authenticated, service_role;
grant execute on function public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid) to anon, authenticated, service_role;
grant execute on function public.get_public_zagulyaka_v1(text) to anon, authenticated, service_role;
grant execute on function public.get_zagulyaky_public_stats_v1() to anon, authenticated, service_role;

revoke all on function public.create_zagulyaka_draft_v1(text,jsonb) from public;
revoke all on function public.update_my_zagulyaka_draft_v1(uuid,integer,jsonb) from public;
revoke all on function public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb) from public;
revoke all on function public.submit_zagulyaka_v1(uuid,integer) from public;
revoke all on function public.withdraw_zagulyaka_v1(uuid,integer) from public;
revoke all on function public.delete_my_zagulyaka_draft_v1(uuid,integer) from public;
revoke all on function public.get_my_zagulyaky_v1(text,integer,integer) from public;
revoke all on function public.get_my_zagulyaka_draft_v1(uuid) from public;
revoke all on function public.confirm_zagulyaka_v1(uuid,text,text) from public;
revoke all on function public.create_zagulyaka_claim_v1(uuid,text,text) from public;
revoke all on function public.set_zagulyaka_bookmark_v1(uuid,boolean) from public;
grant execute on function public.create_zagulyaka_draft_v1(text,jsonb) to authenticated, service_role;
grant execute on function public.update_my_zagulyaka_draft_v1(uuid,integer,jsonb) to authenticated, service_role;
grant execute on function public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb) to authenticated, service_role;
grant execute on function public.submit_zagulyaka_v1(uuid,integer) to authenticated, service_role;
grant execute on function public.withdraw_zagulyaka_v1(uuid,integer) to authenticated, service_role;
grant execute on function public.delete_my_zagulyaka_draft_v1(uuid,integer) to authenticated, service_role;
grant execute on function public.get_my_zagulyaky_v1(text,integer,integer) to authenticated, service_role;
grant execute on function public.get_my_zagulyaka_draft_v1(uuid) to authenticated, service_role;
grant execute on function public.confirm_zagulyaka_v1(uuid,text,text) to authenticated, service_role;
grant execute on function public.create_zagulyaka_claim_v1(uuid,text,text) to authenticated, service_role;
grant execute on function public.set_zagulyaka_bookmark_v1(uuid,boolean) to authenticated, service_role;

revoke all on function public.admin_list_zagulyaky_queue_v1(text,integer,integer) from public;
revoke all on function public.admin_review_zagulyaka_v1(uuid,integer,text,text,text,text,text) from public;
revoke all on function public.admin_resolve_zagulyaka_claim_v1(uuid,text,text) from public;
revoke all on function public.admin_list_zagulyaky_claims_v1(text,integer,integer) from public;
grant execute on function public.admin_list_zagulyaky_queue_v1(text,integer,integer) to authenticated, service_role;
grant execute on function public.admin_review_zagulyaka_v1(uuid,integer,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.admin_resolve_zagulyaka_claim_v1(uuid,text,text) to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_claims_v1(text,integer,integer) to authenticated, service_role;

commit;
