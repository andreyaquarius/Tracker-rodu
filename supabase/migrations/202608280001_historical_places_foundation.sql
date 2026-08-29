begin;

-- Historical places foundation (additive, no legacy rewrites).
--
-- Scope convention:
--   * places.project_id is null     -> shared/global catalogue row;
--   * places.project_id is not null -> private row owned by one project.
--
-- This migration deliberately does not backfill, alter, or link any existing
-- person/document/finding/Zagulyaky text or geo field.  Those values remain
-- source evidence until a later, reviewed resolution migration is introduced.

set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;
create extension if not exists pg_trgm with schema extensions;

create or replace function public.historical_place_search_normalize_v1(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select btrim(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        pg_catalog.translate(
          pg_catalog.lower(coalesce(p_value, '')),
          'ёѣѳѵыэіїєґ',
          'еефіиеііег'
        ),
        'ąćęłńóśźżáčďéěíňřšťúůýž',
        'acelnoszzacdeeinrstuuyz'
      ),
      '[^[:alnum:]]+',
      ' ',
      'g'
    )
  );
$function$;

comment on function public.historical_place_search_normalize_v1(text) is
  'Deterministic search-only normalization for modern and historical place names. It never rewrites source text.';

create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  canonical_name text not null,
  modern_name text not null default '',
  description text not null default '',
  latitude numeric,
  longitude numeric,
  status text not null default 'active',
  verification_status text not null default 'unverified',
  is_public boolean not null default false,
  merged_into_place_id uuid references public.places(id) on delete restrict,
  published_at timestamptz,
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  search_text text generated always as (
    public.historical_place_search_normalize_v1(canonical_name || ' ' || modern_name)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint places_canonical_name_check
    check (char_length(btrim(canonical_name)) between 1 and 500),
  constraint places_modern_name_check
    check (char_length(modern_name) <= 500),
  constraint places_description_check
    check (char_length(description) <= 20000),
  constraint places_coordinates_pair_check
    check ((latitude is null) = (longitude is null)),
  constraint places_latitude_check
    check (latitude is null or latitude between -90 and 90),
  constraint places_longitude_check
    check (longitude is null or longitude between -180 and 180),
  constraint places_status_check
    check (status in ('active', 'needs_review', 'merged', 'archived')),
  constraint places_verification_status_check
    check (verification_status in ('unverified', 'plausible', 'verified', 'disputed')),
  constraint places_publication_scope_check
    check (
      not is_public
      or (
        project_id is null
        and status = 'active'
        and verification_status = 'verified'
      )
    ),
  constraint places_published_at_check
    check (
      (is_public and published_at is not null)
      or (not is_public and published_at is null)
    ),
  constraint places_merge_state_check
    check (
      (status = 'merged' and merged_into_place_id is not null)
      or (status <> 'merged' and merged_into_place_id is null)
    ),
  constraint places_not_self_merged_check
    check (merged_into_place_id is null or merged_into_place_id <> id),
  constraint places_lock_version_check
    check (lock_version > 0),
  constraint places_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint places_metadata_size_check
    check (octet_length(metadata::text) <= 100000)
);

comment on table public.places is
  'Canonical historical place identities. project_id NULL is the shared catalogue; non-NULL is project-private.';
comment on column public.places.project_id is
  'NULL for a global catalogue place, otherwise the owning project. Scope is immutable after creation.';
comment on column public.places.canonical_name is
  'Current canonical display label; historical and source spellings belong in place_names.';
comment on column public.places.modern_name is
  'Optional current/modern label when it differs from the canonical label.';
comment on column public.places.latitude is
  'Canonical point latitude only. Raw evidence coordinates remain unchanged in their source records.';
comment on column public.places.longitude is
  'Canonical point longitude only. PostGIS boundaries are intentionally deferred to a later migration.';
comment on column public.places.status is
  'Lifecycle status: active, needs_review, merged, or archived.';
comment on column public.places.verification_status is
  'Evidence assessment: unverified, plausible, verified, or disputed.';
comment on column public.places.is_public is
  'Only an active verified global row may be public. Public rows and safe name columns may be read anonymously.';
comment on column public.places.merged_into_place_id is
  'Non-destructive redirect target. A merged place row remains addressable for audit and future redirects.';

create table if not exists public.place_names (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  original_text text not null default '',
  language_code text,
  name_type text not null default 'variant',
  valid_from date,
  valid_to date,
  valid_from_text text,
  valid_to_text text,
  valid_from_precision text,
  valid_to_precision text,
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  citation_id uuid,
  source_reference text,
  confidence smallint default 50,
  is_primary boolean not null default false,
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  search_text text generated always as (
    public.historical_place_search_normalize_v1(name)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_names_name_check
    check (char_length(btrim(name)) between 1 and 500),
  constraint place_names_original_text_check
    check (char_length(original_text) between 1 and 2000),
  constraint place_names_language_code_check
    check (language_code is null or language_code ~ '^[A-Za-z][A-Za-z0-9-]{0,34}$'),
  constraint place_names_name_type_check
    check (name_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_names_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint place_names_valid_from_text_check
    check (valid_from_text is null or char_length(valid_from_text) <= 500),
  constraint place_names_valid_to_text_check
    check (valid_to_text is null or char_length(valid_to_text) <= 500),
  constraint place_names_valid_from_precision_check
    check (
      valid_from_precision is null
      or valid_from_precision in ('day', 'month', 'year', 'circa', 'before', 'after', 'range', 'unknown')
    ),
  constraint place_names_valid_to_precision_check
    check (
      valid_to_precision is null
      or valid_to_precision in ('day', 'month', 'year', 'circa', 'before', 'after', 'range', 'unknown')
    ),
  constraint place_names_source_reference_check
    check (source_reference is null or char_length(source_reference) <= 2000),
  constraint place_names_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint place_names_note_check
    check (char_length(note) <= 10000),
  constraint place_names_lock_version_check
    check (lock_version > 0),
  constraint place_names_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint place_names_metadata_size_check
    check (octet_length(metadata::text) <= 100000)
);

comment on table public.place_names is
  'Unlimited modern, historical, official, local, erroneous, and variant names for one place.';
comment on column public.place_names.project_id is
  'Derived from the parent place by a trigger; clients cannot move a name across scopes.';
comment on column public.place_names.name is
  'Display spelling used by the catalogue. It is never replaced by search normalization.';
comment on column public.place_names.original_text is
  'Exact source wording supplied by the user or document. It is never normalized or overwritten.';
comment on column public.place_names.language_code is
  'Language selection; no user-facing script field is required in this foundation.';
comment on column public.place_names.valid_from is
  'Machine-comparable lower date when known; valid_from_text and precision preserve source wording/uncertainty.';
comment on column public.place_names.valid_to is
  'Machine-comparable upper date when known; valid_to_text and precision preserve source wording/uncertainty.';
comment on column public.place_names.citation_id is
  'Forward-compatible citation identifier; no foreign key until a canonical citation entity exists.';

create table if not exists public.place_external_identifiers (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text not null,
  external_identifier text not null,
  source_url text,
  is_primary boolean not null default false,
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_external_identifiers_provider_check
    check (char_length(btrim(provider)) between 1 and 160),
  constraint place_external_identifiers_value_check
    check (char_length(btrim(external_identifier)) between 1 and 500),
  constraint place_external_identifiers_source_url_check
    check (source_url is null or (char_length(source_url) <= 2000 and source_url ~* '^https?://')),
  constraint place_external_identifiers_lock_version_check
    check (lock_version > 0),
  constraint place_external_identifiers_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint place_external_identifiers_metadata_size_check
    check (octet_length(metadata::text) <= 100000)
);

comment on table public.place_external_identifiers is
  'Searchable provider identifiers such as Wikidata, GeoNames, or OpenStreetMap IDs. Uniqueness is enforced per scope.';

create table if not exists public.place_types (
  code text primary key,
  label_uk text not null,
  description text not null default '',
  sort_order integer not null default 1000,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_types_code_check
    check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_types_label_check
    check (char_length(btrim(label_uk)) between 1 and 200),
  constraint place_types_description_check
    check (char_length(description) <= 2000)
);

comment on table public.place_types is
  'Global controlled vocabulary for settlement, administrative, religious, archival, and other place types.';

insert into public.place_types (code, label_uk, sort_order) values
  ('settlement', 'населений пункт', 5),
  ('hamlet', 'хутір', 10),
  ('small_settlement', 'присілок', 20),
  ('village', 'село', 30),
  ('town', 'містечко', 40),
  ('city', 'місто', 50),
  ('sloboda', 'слобода', 60),
  ('colony', 'колонія', 70),
  ('folwark', 'фільварок', 80),
  ('estate', 'маєток', 90),
  ('parish', 'парафія', 100),
  ('volost', 'волость', 110),
  ('county', 'повіт', 120),
  ('governorate', 'губернія', 130),
  ('okrug', 'округ', 140),
  ('district', 'район', 150),
  ('region', 'область', 160),
  ('community', 'громада', 170),
  ('country', 'держава', 180),
  ('cemetery', 'кладовище', 190),
  ('church', 'церква', 200),
  ('monastery', 'монастир', 210),
  ('military_unit', 'військова частина', 220),
  ('manor', 'маєток / двір', 230),
  ('other', 'інше', 1000)
on conflict (code) do update set
  label_uk = excluded.label_uk,
  sort_order = excluded.sort_order,
  updated_at = now();

create table if not exists public.place_type_assignments (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  place_type_code text not null references public.place_types(code) on update restrict on delete restrict,
  valid_from date,
  valid_to date,
  valid_from_text text,
  valid_to_text text,
  valid_from_precision text,
  valid_to_precision text,
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  citation_id uuid,
  source_reference text,
  confidence smallint default 50,
  is_primary boolean not null default false,
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_type_assignments_type_code_check
    check (place_type_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_type_assignments_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint place_type_assignments_valid_from_text_check
    check (valid_from_text is null or char_length(valid_from_text) <= 500),
  constraint place_type_assignments_valid_to_text_check
    check (valid_to_text is null or char_length(valid_to_text) <= 500),
  constraint place_type_assignments_valid_from_precision_check
    check (
      valid_from_precision is null
      or valid_from_precision in ('day', 'month', 'year', 'circa', 'before', 'after', 'range', 'unknown')
    ),
  constraint place_type_assignments_valid_to_precision_check
    check (
      valid_to_precision is null
      or valid_to_precision in ('day', 'month', 'year', 'circa', 'before', 'after', 'range', 'unknown')
    ),
  constraint place_type_assignments_source_reference_check
    check (source_reference is null or char_length(source_reference) <= 2000),
  constraint place_type_assignments_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint place_type_assignments_note_check
    check (char_length(note) <= 10000),
  constraint place_type_assignments_lock_version_check
    check (lock_version > 0),
  constraint place_type_assignments_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint place_type_assignments_metadata_size_check
    check (octet_length(metadata::text) <= 100000)
);

comment on table public.place_type_assignments is
  'Time-bounded place classifications (village, parish, county, province, church, cemetery, and future codes).';

create table if not exists public.place_hierarchy_relations (
  id uuid primary key default gen_random_uuid(),
  child_place_id uuid not null references public.places(id) on delete cascade,
  parent_place_id uuid not null references public.places(id) on delete restrict,
  project_id uuid references public.projects(id) on delete cascade,
  relation_type text not null default 'administrative_parent',
  valid_from date,
  valid_to date,
  valid_from_text text,
  valid_to_text text,
  valid_from_precision text,
  valid_to_precision text,
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  citation_id uuid,
  source_reference text,
  confidence smallint default 50,
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_hierarchy_relations_not_self_check
    check (child_place_id <> parent_place_id),
  constraint place_hierarchy_relations_type_check
    check (relation_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_hierarchy_relations_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint place_hierarchy_relations_valid_from_text_check
    check (valid_from_text is null or char_length(valid_from_text) <= 500),
  constraint place_hierarchy_relations_valid_to_text_check
    check (valid_to_text is null or char_length(valid_to_text) <= 500),
  constraint place_hierarchy_relations_valid_from_precision_check
    check (
      valid_from_precision is null
      or valid_from_precision in ('day', 'month', 'year', 'circa', 'before', 'after', 'range', 'unknown')
    ),
  constraint place_hierarchy_relations_valid_to_precision_check
    check (
      valid_to_precision is null
      or valid_to_precision in ('day', 'month', 'year', 'circa', 'before', 'after', 'range', 'unknown')
    ),
  constraint place_hierarchy_relations_source_reference_check
    check (source_reference is null or char_length(source_reference) <= 2000),
  constraint place_hierarchy_relations_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint place_hierarchy_relations_note_check
    check (char_length(note) <= 10000),
  constraint place_hierarchy_relations_lock_version_check
    check (lock_version > 0),
  constraint place_hierarchy_relations_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint place_hierarchy_relations_metadata_size_check
    check (octet_length(metadata::text) <= 100000)
);

comment on table public.place_hierarchy_relations is
  'Time-aware child-to-parent administrative relations. Overlap is retained as evidence and resolved as ambiguity, never silently discarded.';
comment on column public.place_hierarchy_relations.project_id is
  'Derived from the child place. A project child may point to the same project or a verified global parent; a global child may only point globally.';

create table if not exists public.place_change_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  target_place_id uuid references public.places(id) on delete set null,
  request_type text not null,
  proposed_changes jsonb not null,
  reason text not null default '',
  status text not null default 'submitted',
  created_by uuid not null references public.profiles(user_id) on delete cascade,
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '',
  lock_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_change_requests_type_check
    check (request_type in (
      'create_global', 'update_place', 'add_name', 'update_name',
      'add_external_identifier', 'add_type_assignment',
      'add_hierarchy_relation', 'merge_places'
    )),
  constraint place_change_requests_payload_object_check
    check (jsonb_typeof(proposed_changes) = 'object'),
  constraint place_change_requests_payload_size_check
    check (octet_length(proposed_changes::text) <= 200000),
  constraint place_change_requests_reason_check
    check (char_length(reason) <= 10000),
  constraint place_change_requests_status_check
    check (status in ('submitted', 'in_review', 'approved', 'rejected', 'cancelled')),
  constraint place_change_requests_review_state_check
    check (
      (status in ('submitted', 'cancelled') and reviewed_at is null)
      or (status in ('in_review', 'approved', 'rejected'))
    ),
  constraint place_change_requests_review_note_check
    check (char_length(review_note) <= 10000),
  constraint place_change_requests_lock_version_check
    check (lock_version > 0)
);

comment on table public.place_change_requests is
  'Project-authored proposals for shared catalogue changes. Authenticated clients cannot directly mutate global places or approve requests.';

create table if not exists security_private.historical_place_audit_log (
  id bigint generated always as identity primary key,
  entity_table text not null,
  entity_id uuid,
  place_id uuid,
  project_id uuid,
  actor_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  before_data jsonb,
  after_data jsonb,
  transaction_id bigint not null default pg_catalog.txid_current(),
  created_at timestamptz not null default now()
);

comment on table security_private.historical_place_audit_log is
  'Private immutable before/after audit for the historical-place foundation. Never expose through PostgREST.';

create index if not exists places_project_status_updated_idx
  on public.places (project_id, status, updated_at desc, id);
create index if not exists places_global_status_updated_idx
  on public.places (status, updated_at desc, id)
  where project_id is null;
create index if not exists places_search_text_trgm_idx
  on public.places using gin (search_text extensions.gin_trgm_ops);
create index if not exists places_coordinates_idx
  on public.places (latitude, longitude)
  where latitude is not null and longitude is not null;
create index if not exists places_merged_target_idx
  on public.places (merged_into_place_id)
  where merged_into_place_id is not null;

create index if not exists place_names_place_primary_idx
  on public.place_names (place_id, is_primary desc, valid_from, valid_to, id);
create index if not exists place_names_project_updated_idx
  on public.place_names (project_id, updated_at desc, id);
create index if not exists place_names_search_text_trgm_idx
  on public.place_names using gin (search_text extensions.gin_trgm_ops);
create index if not exists place_names_valid_period_idx
  on public.place_names (place_id, valid_from, valid_to)
  where valid_from is not null or valid_to is not null;
create index if not exists place_names_source_document_idx
  on public.place_names (source_document_id)
  where source_document_id is not null;
create index if not exists place_names_source_finding_idx
  on public.place_names (source_finding_id)
  where source_finding_id is not null;

create unique index if not exists place_external_identifiers_global_key_idx
  on public.place_external_identifiers (lower(provider), external_identifier)
  where project_id is null;
create unique index if not exists place_external_identifiers_project_key_idx
  on public.place_external_identifiers (project_id, lower(provider), external_identifier)
  where project_id is not null;
create index if not exists place_external_identifiers_place_idx
  on public.place_external_identifiers (place_id, is_primary desc, id);

create index if not exists place_type_assignments_place_period_idx
  on public.place_type_assignments (place_id, valid_from, valid_to, is_primary desc, id);
create index if not exists place_type_assignments_project_updated_idx
  on public.place_type_assignments (project_id, updated_at desc, id);

create index if not exists place_hierarchy_relations_child_period_idx
  on public.place_hierarchy_relations (child_place_id, valid_from, valid_to, id);
create index if not exists place_hierarchy_relations_parent_period_idx
  on public.place_hierarchy_relations (parent_place_id, valid_from, valid_to, id);
create index if not exists place_hierarchy_relations_project_updated_idx
  on public.place_hierarchy_relations (project_id, updated_at desc, id);

create index if not exists place_change_requests_project_status_idx
  on public.place_change_requests (project_id, status, updated_at desc, id);
create index if not exists place_change_requests_target_idx
  on public.place_change_requests (target_place_id, status, updated_at desc)
  where target_place_id is not null;

create index if not exists historical_place_audit_entity_idx
  on security_private.historical_place_audit_log (entity_table, entity_id, created_at desc, id desc);
create index if not exists historical_place_audit_place_idx
  on security_private.historical_place_audit_log (place_id, created_at desc, id desc)
  where place_id is not null;
create index if not exists historical_place_audit_project_idx
  on security_private.historical_place_audit_log (project_id, created_at desc, id desc)
  where project_id is not null;

create or replace function security_private.validate_historical_place_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  target_project_id uuid;
begin
  new.canonical_name := btrim(new.canonical_name);
  new.modern_name := btrim(new.modern_name);

  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;

  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    raise exception 'PLACE_SCOPE_IMMUTABLE' using errcode = '22023';
  end if;

  if new.is_public and new.published_at is null then
    new.published_at := now();
  elsif not new.is_public then
    new.published_at := null;
  end if;

  if new.merged_into_place_id is not null then
    select place_row.project_id
    into target_project_id
    from public.places place_row
    where place_row.id = new.merged_into_place_id;

    if not found then
      raise exception 'PLACE_MERGE_TARGET_NOT_FOUND' using errcode = '23503';
    end if;
    if new.project_id is null and target_project_id is not null then
      raise exception 'GLOBAL_PLACE_MERGE_TARGET_MUST_BE_GLOBAL' using errcode = '22023';
    end if;
    if new.project_id is not null
       and target_project_id is not null
       and target_project_id <> new.project_id then
      raise exception 'PROJECT_PLACE_MERGE_TARGET_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function security_private.set_historical_place_child_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  parent_project_id uuid;
  row_data jsonb;
  document_project_id uuid;
  finding_project_id uuid;
begin
  select place_row.project_id
  into parent_project_id
  from public.places place_row
  where place_row.id = new.place_id;

  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = '23503';
  end if;

  new.project_id := parent_project_id;
  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;
  row_data := to_jsonb(new);

  if row_data ? 'source_document_id'
     and nullif(row_data ->> 'source_document_id', '') is not null then
    if parent_project_id is null then
      raise exception 'GLOBAL_PLACE_PRIVATE_DOCUMENT_SOURCE_FORBIDDEN' using errcode = '22023';
    end if;
    select document_row.project_id
    into document_project_id
    from public.documents document_row
    where document_row.id = (row_data ->> 'source_document_id')::uuid;
    if not found or document_project_id <> parent_project_id then
      raise exception 'PLACE_DOCUMENT_SOURCE_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if row_data ? 'source_finding_id'
     and nullif(row_data ->> 'source_finding_id', '') is not null then
    if parent_project_id is null then
      raise exception 'GLOBAL_PLACE_PRIVATE_FINDING_SOURCE_FORBIDDEN' using errcode = '22023';
    end if;
    select finding_row.project_id
    into finding_project_id
    from public.findings finding_row
    where finding_row.id = (row_data ->> 'source_finding_id')::uuid;
    if not found or finding_project_id <> parent_project_id then
      raise exception 'PLACE_FINDING_SOURCE_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function security_private.set_historical_place_hierarchy_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  child_project_id uuid;
  parent_project_id uuid;
  document_project_id uuid;
  finding_project_id uuid;
begin
  select place_row.project_id
  into child_project_id
  from public.places place_row
  where place_row.id = new.child_place_id;
  if not found then
    raise exception 'CHILD_PLACE_NOT_FOUND' using errcode = '23503';
  end if;

  select place_row.project_id
  into parent_project_id
  from public.places place_row
  where place_row.id = new.parent_place_id;
  if not found then
    raise exception 'PARENT_PLACE_NOT_FOUND' using errcode = '23503';
  end if;

  if child_project_id is null and parent_project_id is not null then
    raise exception 'GLOBAL_HIERARCHY_PARENT_MUST_BE_GLOBAL' using errcode = '22023';
  end if;
  if child_project_id is not null
     and parent_project_id is not null
     and child_project_id <> parent_project_id then
    raise exception 'HIERARCHY_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
  end if;

  new.project_id := child_project_id;
  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;

  if new.source_document_id is not null then
    if child_project_id is null then
      raise exception 'GLOBAL_HIERARCHY_PRIVATE_DOCUMENT_SOURCE_FORBIDDEN' using errcode = '22023';
    end if;
    select document_row.project_id
    into document_project_id
    from public.documents document_row
    where document_row.id = new.source_document_id;
    if not found or document_project_id <> child_project_id then
      raise exception 'HIERARCHY_DOCUMENT_SOURCE_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if new.source_finding_id is not null then
    if child_project_id is null then
      raise exception 'GLOBAL_HIERARCHY_PRIVATE_FINDING_SOURCE_FORBIDDEN' using errcode = '22023';
    end if;
    select finding_row.project_id
    into finding_project_id
    from public.findings finding_row
    where finding_row.id = new.source_finding_id;
    if not found or finding_project_id <> child_project_id then
      raise exception 'HIERARCHY_FINDING_SOURCE_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function security_private.validate_historical_place_change_request_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  target_project_id uuid;
begin
  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;

  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    raise exception 'PLACE_CHANGE_REQUEST_SCOPE_IMMUTABLE' using errcode = '22023';
  end if;

  if new.target_place_id is not null then
    select place_row.project_id
    into target_project_id
    from public.places place_row
    where place_row.id = new.target_place_id;
    if not found then
      raise exception 'PLACE_CHANGE_REQUEST_TARGET_NOT_FOUND' using errcode = '23503';
    end if;
    if target_project_id is not null and target_project_id <> new.project_id then
      raise exception 'PLACE_CHANGE_REQUEST_TARGET_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if new.status = 'submitted' then
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_note := '';
  end if;

  return new;
end;
$function$;

create or replace function security_private.prepare_historical_place_name_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  new.name := btrim(new.name);
  if new.original_text = '' then
    new.original_text := new.name;
  end if;
  return new;
end;
$function$;

create or replace function security_private.touch_historical_place_row_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  new.updated_at := now();
  new.lock_version := old.lock_version + 1;
  return new;
end;
$function$;

-- Every Place identity has one transaction-scoped advisory lock.  All callers
-- sort UUIDs before locking, so overlapping multi-Place writes cannot invert
-- lock order.  Hash collisions only serialize unrelated writes; they cannot
-- weaken correctness because the original UUID remains the data identity.
create or replace function security_private.lock_historical_place_ids_v1(
  p_place_ids uuid[],
  p_wait boolean default true
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  place_id_to_lock uuid;
  advisory_key bigint;
begin
  for place_id_to_lock in
    select distinct candidate.place_id
    from pg_catalog.unnest(coalesce(p_place_ids, array[]::uuid[])) candidate(place_id)
    where candidate.place_id is not null
    order by candidate.place_id
  loop
    advisory_key := pg_catalog.hashtextextended(
      'tracker_rodu_historical_place_v1:' || place_id_to_lock::text,
      0
    );
    if coalesce(p_wait, true) then
      perform pg_catalog.pg_advisory_xact_lock(advisory_key);
    elsif not pg_catalog.pg_try_advisory_xact_lock(advisory_key) then
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

-- Row triggers are the fail-safe for direct SQL/table writes.  UPDATE/DELETE
-- row locks are already held by the time a BEFORE ROW trigger runs, therefore
-- this path must never wait for an advisory lock: it fails with a retryable
-- serialization error instead of forming row-lock/advisory-lock deadlocks.
-- Versioned RPCs acquire the same locks in blocking mode before their DML.
create or replace function security_private.lock_historical_place_child_write_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  old_row jsonb := '{}'::jsonb;
  new_row jsonb := '{}'::jsonb;
  referenced_place_ids uuid[] := array[]::uuid[];
  new_place_ids uuid[] := array[]::uuid[];
  merged_place_id uuid;
begin
  if tg_op <> 'INSERT' then old_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_row := to_jsonb(new); end if;

  select coalesce(pg_catalog.array_agg(distinct reference_row.place_id order by reference_row.place_id), array[]::uuid[])
  into referenced_place_ids
  from (
    select nullif(candidate.row_data ->> candidate.key_name, '')::uuid as place_id
    from (values (old_row), (new_row)) row_value(row_data)
    cross join pg_catalog.unnest(array[
      'place_id', 'child_place_id', 'parent_place_id',
      'related_place_id', 'parish_place_id'
    ]::text[]) key_value(key_name)
    cross join lateral (select row_value.row_data, key_value.key_name) candidate
    where candidate.row_data ? candidate.key_name
      and nullif(candidate.row_data ->> candidate.key_name, '') is not null
  ) reference_row
  where reference_row.place_id is not null;

  if not security_private.lock_historical_place_ids_v1(referenced_place_ids, false) then
    raise exception 'HISTORICAL_PLACE_WRITE_BUSY'
      using errcode = '40001',
        detail = 'A Place merge or another ordered Place write is in progress. Retry the transaction.';
  end if;

  if tg_op <> 'DELETE' then
    select coalesce(pg_catalog.array_agg(distinct reference_row.place_id order by reference_row.place_id), array[]::uuid[])
    into new_place_ids
    from (
      select nullif(new_row ->> key_value.key_name, '')::uuid as place_id
      from pg_catalog.unnest(array[
        'place_id', 'child_place_id', 'parent_place_id',
        'related_place_id', 'parish_place_id'
      ]::text[]) key_value(key_name)
      where new_row ? key_value.key_name
        and nullif(new_row ->> key_value.key_name, '') is not null
    ) reference_row
    where reference_row.place_id is not null;

    select place_row.id
    into merged_place_id
    from public.places place_row
    where place_row.id = any(new_place_ids)
      and place_row.status = 'merged'
    order by place_row.id
    limit 1;
    if found then
      raise exception 'PLACE_REFERENCE_MERGED'
        using errcode = '22023',
          detail = 'Use the merged_into_place_id target instead of ' || merged_place_id::text || '.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

create or replace function security_private.audit_historical_place_entity_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  before_row jsonb;
  after_row jsonb;
  audit_row jsonb;
  audit_entity_id uuid;
  audit_place_id uuid;
  audit_project_id uuid;
begin
  if tg_op = 'DELETE' then
    before_row := to_jsonb(old);
    after_row := null;
    audit_row := before_row;
  elsif tg_op = 'INSERT' then
    before_row := null;
    after_row := to_jsonb(new);
    audit_row := after_row;
  else
    before_row := to_jsonb(old);
    after_row := to_jsonb(new);
    audit_row := after_row;
  end if;

  audit_entity_id := nullif(audit_row ->> 'id', '')::uuid;
  audit_project_id := nullif(audit_row ->> 'project_id', '')::uuid;

  if tg_table_name = 'places' then
    audit_place_id := audit_entity_id;
  else
    audit_place_id := coalesce(
      nullif(audit_row ->> 'place_id', '')::uuid,
      nullif(audit_row ->> 'child_place_id', '')::uuid,
      nullif(audit_row ->> 'target_place_id', '')::uuid
    );
  end if;

  insert into security_private.historical_place_audit_log (
    entity_table, entity_id, place_id, project_id, actor_id,
    action, before_data, after_data
  ) values (
    tg_table_name, audit_entity_id, audit_place_id, audit_project_id, auth.uid(),
    lower(tg_op), before_row, after_row
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

-- The generic project-deletion worker removes rows in bounded CTID batches.
-- A merged Place has a deliberate RESTRICT self-reference, so during the
-- already-authorized project deletion/restore transaction only, detach aliases
-- before their target is removed. Ordinary Place deletion keeps RESTRICT.
create or replace function security_private.prepare_historical_place_project_delete_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if old.project_id is null
     or current_setting('app.project_deletion', true) is distinct from 'on' then
    return old;
  end if;

  update public.places referencing_place
  set
    status = 'archived',
    merged_into_place_id = null
  where referencing_place.project_id = old.project_id
    and referencing_place.merged_into_place_id = old.id;

  return old;
end;
$function$;

drop trigger if exists places_05_prepare_project_delete on public.places;
create trigger places_05_prepare_project_delete
before delete on public.places
for each row execute function
  security_private.prepare_historical_place_project_delete_v1();

drop trigger if exists places_10_validate on public.places;
create trigger places_10_validate
before insert or update on public.places
for each row execute function security_private.validate_historical_place_v1();

drop trigger if exists places_20_touch on public.places;
create trigger places_20_touch
before update on public.places
for each row execute function security_private.touch_historical_place_row_v1();

drop trigger if exists place_names_05_prepare on public.place_names;
create trigger place_names_05_prepare
before insert or update on public.place_names
for each row execute function security_private.prepare_historical_place_name_v1();

drop trigger if exists place_types_set_updated_at on public.place_types;
create trigger place_types_set_updated_at
before update on public.place_types
for each row execute function public.set_updated_at();

do $do$
declare
  table_name text;
begin
  foreach table_name in array array[
    'place_names',
    'place_external_identifiers',
    'place_type_assignments'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_10_scope', table_name);
    execute format(
      'create trigger %I before insert or update on public.%I
       for each row execute function security_private.set_historical_place_child_scope_v1()',
      table_name || '_10_scope', table_name
    );
  end loop;
end;
$do$;

drop trigger if exists place_hierarchy_relations_10_scope on public.place_hierarchy_relations;
create trigger place_hierarchy_relations_10_scope
before insert or update on public.place_hierarchy_relations
for each row execute function security_private.set_historical_place_hierarchy_scope_v1();

do $place_write_locks$
declare
  table_name text;
begin
  foreach table_name in array array[
    'place_names',
    'place_external_identifiers',
    'place_type_assignments',
    'place_hierarchy_relations'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      table_name || '_12_historical_place_lock',
      table_name
    );
    execute format(
      'create trigger %I before insert or update or delete on public.%I
       for each row execute function security_private.lock_historical_place_child_write_v1()',
      table_name || '_12_historical_place_lock',
      table_name
    );
  end loop;
end;
$place_write_locks$;

drop trigger if exists place_change_requests_10_validate on public.place_change_requests;
create trigger place_change_requests_10_validate
before insert or update on public.place_change_requests
for each row execute function security_private.validate_historical_place_change_request_v1();

do $do$
declare
  table_name text;
begin
  foreach table_name in array array[
    'place_names',
    'place_external_identifiers',
    'place_type_assignments',
    'place_hierarchy_relations',
    'place_change_requests'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_20_touch', table_name);
    execute format(
      'create trigger %I before update on public.%I
       for each row execute function security_private.touch_historical_place_row_v1()',
      table_name || '_20_touch', table_name
    );
  end loop;
end;
$do$;

do $do$
declare
  table_name text;
begin
  foreach table_name in array array[
    'places',
    'place_names',
    'place_external_identifiers',
    'place_type_assignments',
    'place_hierarchy_relations',
    'place_change_requests'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_90_audit', table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
       for each row execute function security_private.audit_historical_place_entity_v1()',
      table_name || '_90_audit', table_name
    );
  end loop;
end;
$do$;

alter table public.places enable row level security;
alter table public.place_names enable row level security;
alter table public.place_external_identifiers enable row level security;
alter table public.place_types enable row level security;
alter table public.place_type_assignments enable row level security;
alter table public.place_hierarchy_relations enable row level security;
alter table public.place_change_requests enable row level security;

drop policy if exists places_public_published_select on public.places;
create policy places_public_published_select
on public.places for select to anon
using (project_id is null and is_public);

drop policy if exists places_authenticated_select on public.places;
create policy places_authenticated_select
on public.places for select to authenticated
using (
  (project_id is null and status = 'active' and verification_status = 'verified')
  or (project_id is not null and public.is_project_member(project_id))
);

drop policy if exists places_project_insert on public.places;
create policy places_project_insert
on public.places for insert to authenticated
with check (project_id is not null and public.can_edit_project(project_id));

drop policy if exists places_project_update on public.places;
create policy places_project_update
on public.places for update to authenticated
using (project_id is not null and public.can_edit_project(project_id))
with check (project_id is not null and public.can_edit_project(project_id));

drop policy if exists places_project_delete on public.places;
create policy places_project_delete
on public.places for delete to authenticated
using (project_id is not null and public.can_edit_project(project_id));

drop policy if exists place_names_public_published_select on public.place_names;
create policy place_names_public_published_select
on public.place_names for select to anon
using (
  project_id is null
  and exists (
    select 1 from public.places place_row
    where place_row.id = place_names.place_id
      and place_row.project_id is null
      and place_row.is_public
  )
);

drop policy if exists place_names_authenticated_select on public.place_names;
create policy place_names_authenticated_select
on public.place_names for select to authenticated
using (
  (project_id is null and exists (
    select 1 from public.places place_row
    where place_row.id = place_names.place_id
      and place_row.project_id is null
      and place_row.status = 'active'
      and place_row.verification_status = 'verified'
  ))
  or (project_id is not null and public.is_project_member(project_id))
);

drop policy if exists place_names_project_insert on public.place_names;
create policy place_names_project_insert
on public.place_names for insert to authenticated
with check (project_id is not null and public.can_edit_project(project_id));

drop policy if exists place_names_project_update on public.place_names;
create policy place_names_project_update
on public.place_names for update to authenticated
using (project_id is not null and public.can_edit_project(project_id))
with check (project_id is not null and public.can_edit_project(project_id));

drop policy if exists place_names_project_delete on public.place_names;
create policy place_names_project_delete
on public.place_names for delete to authenticated
using (project_id is not null and public.can_edit_project(project_id));

drop policy if exists place_types_authenticated_select on public.place_types;
create policy place_types_authenticated_select
on public.place_types for select to authenticated
using (true);

do $do$
declare
  table_name text;
  place_column text;
begin
  foreach table_name in array array[
    'place_external_identifiers',
    'place_type_assignments'
  ] loop
    place_column := 'place_id';
    execute format('drop policy if exists %I on public.%I', table_name || '_authenticated_select', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (
         (project_id is null and exists (
           select 1 from public.places place_row
           where place_row.id = %I.%I
             and place_row.project_id is null
             and place_row.status = ''active''
             and place_row.verification_status = ''verified''
         ))
         or (project_id is not null and public.is_project_member(project_id))
       )',
      table_name || '_authenticated_select', table_name, table_name, place_column
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_project_insert', table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated
       with check (project_id is not null and public.can_edit_project(project_id))',
      table_name || '_project_insert', table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_project_update', table_name);
    execute format(
      'create policy %I on public.%I for update to authenticated
       using (project_id is not null and public.can_edit_project(project_id))
       with check (project_id is not null and public.can_edit_project(project_id))',
      table_name || '_project_update', table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_project_delete', table_name);
    execute format(
      'create policy %I on public.%I for delete to authenticated
       using (project_id is not null and public.can_edit_project(project_id))',
      table_name || '_project_delete', table_name
    );
  end loop;
end;
$do$;

drop policy if exists place_hierarchy_relations_authenticated_select on public.place_hierarchy_relations;
create policy place_hierarchy_relations_authenticated_select
on public.place_hierarchy_relations for select to authenticated
using (
  (project_id is null and exists (
    select 1
    from public.places child_place
    join public.places parent_place on parent_place.id = place_hierarchy_relations.parent_place_id
    where child_place.id = place_hierarchy_relations.child_place_id
      and child_place.project_id is null
      and parent_place.project_id is null
      and child_place.status = 'active'
      and child_place.verification_status = 'verified'
      and parent_place.status = 'active'
      and parent_place.verification_status = 'verified'
  ))
  or (project_id is not null and public.is_project_member(project_id))
);

drop policy if exists place_hierarchy_relations_project_insert on public.place_hierarchy_relations;
create policy place_hierarchy_relations_project_insert
on public.place_hierarchy_relations for insert to authenticated
with check (
  project_id is not null
  and public.can_edit_project(project_id)
  and exists (
    select 1
    from public.places parent_place
    where parent_place.id = place_hierarchy_relations.parent_place_id
      and (
        parent_place.project_id = place_hierarchy_relations.project_id
        or (
          parent_place.project_id is null
          and parent_place.status = 'active'
          and parent_place.verification_status = 'verified'
        )
      )
  )
);

drop policy if exists place_hierarchy_relations_project_update on public.place_hierarchy_relations;
create policy place_hierarchy_relations_project_update
on public.place_hierarchy_relations for update to authenticated
using (project_id is not null and public.can_edit_project(project_id))
with check (
  project_id is not null
  and public.can_edit_project(project_id)
  and exists (
    select 1
    from public.places parent_place
    where parent_place.id = place_hierarchy_relations.parent_place_id
      and (
        parent_place.project_id = place_hierarchy_relations.project_id
        or (
          parent_place.project_id is null
          and parent_place.status = 'active'
          and parent_place.verification_status = 'verified'
        )
      )
  )
);

drop policy if exists place_hierarchy_relations_project_delete on public.place_hierarchy_relations;
create policy place_hierarchy_relations_project_delete
on public.place_hierarchy_relations for delete to authenticated
using (project_id is not null and public.can_edit_project(project_id));

drop policy if exists place_change_requests_project_select on public.place_change_requests;
create policy place_change_requests_project_select
on public.place_change_requests for select to authenticated
using (public.is_project_member(project_id));

drop policy if exists place_change_requests_project_submit on public.place_change_requests;
create policy place_change_requests_project_submit
on public.place_change_requests for insert to authenticated
with check (
  public.can_edit_project(project_id)
  and created_by = auth.uid()
  and status = 'submitted'
  and reviewed_by is null
  and reviewed_at is null
);

create or replace function security_private.search_places_v1(
  p_query text,
  p_at_date date default null,
  p_project_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
declare
  raw_query text := btrim(coalesce(p_query, ''));
  normalized_query text;
  bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  caller_is_authenticated boolean := auth.uid() is not null or caller_is_service;
begin
  if char_length(raw_query) > 200 then
    raise exception 'PLACE_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  normalized_query := public.historical_place_search_normalize_v1(raw_query);
  if char_length(normalized_query) < 2 then
    return '[]'::jsonb;
  end if;

  if p_project_id is not null
     and not caller_is_service
     and (auth.uid() is null or not public.is_project_member(p_project_id)) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    with visible_places as (
      select place_row.*
      from public.places place_row
      where place_row.status not in ('merged', 'archived')
        and (
          (
            place_row.project_id is null
            and (
              (
                caller_is_authenticated
                and place_row.status = 'active'
                and place_row.verification_status = 'verified'
              )
              or (not caller_is_authenticated and place_row.is_public)
            )
          )
          or (
            caller_is_authenticated
            and p_project_id is not null
            and place_row.project_id = p_project_id
          )
        )
    ), name_matches as (
      select
        place_row.id place_id,
        name_row.name matched_name,
        case
          when name_row.search_text = normalized_query then 0
          when name_row.search_text like normalized_query || '%' then 1
          when name_row.search_text like '%' || normalized_query || '%' then 2
          else 3
        end match_rank,
        extensions.similarity(name_row.search_text, normalized_query) match_score,
        case
          when p_at_date is null then 0
          when (name_row.valid_from is null or name_row.valid_from <= p_at_date)
           and (name_row.valid_to is null or name_row.valid_to >= p_at_date) then 0
          else 1
        end date_rank
      from visible_places place_row
      join public.place_names name_row on name_row.place_id = place_row.id
      where name_row.search_text like '%' || normalized_query || '%'
         or name_row.search_text % normalized_query
    ), canonical_matches as (
      select
        place_row.id place_id,
        place_row.canonical_name matched_name,
        case
          when place_row.search_text = normalized_query then 0
          when place_row.search_text like normalized_query || '%' then 1
          when place_row.search_text like '%' || normalized_query || '%' then 2
          else 3
        end match_rank,
        extensions.similarity(place_row.search_text, normalized_query) match_score,
        0 date_rank
      from visible_places place_row
      where place_row.search_text like '%' || normalized_query || '%'
         or place_row.search_text % normalized_query
    ), all_matches as (
      select * from name_matches
      union all
      select * from canonical_matches
    ), ranked as (
      select distinct on (match_row.place_id)
        match_row.place_id,
        match_row.matched_name,
        match_row.match_rank,
        match_row.match_score,
        match_row.date_rank
      from all_matches match_row
      order by match_row.place_id, match_row.date_rank, match_row.match_rank,
        match_row.match_score desc, match_row.matched_name
    ), limited as (
      select
        place_row.*,
        ranked.matched_name,
        ranked.match_rank,
        ranked.match_score,
        ranked.date_rank
      from ranked
      join visible_places place_row on place_row.id = ranked.place_id
      order by ranked.date_rank, ranked.match_rank, ranked.match_score desc,
        place_row.canonical_name, place_row.id
      limit bounded_limit
    )
    select jsonb_agg(
      jsonb_build_object(
        'id', place_row.id,
        'projectId', place_row.project_id,
        'scope', case when place_row.project_id is null then 'global' else 'project' end,
        'canonicalName', place_row.canonical_name,
        'modernName', nullif(place_row.modern_name, ''),
        'displayName', coalesce(
          (
            select name_row.name
            from public.place_names name_row
            where name_row.place_id = place_row.id
              and name_row.is_primary
              and (
                p_at_date is null
                or (
                  (name_row.valid_from is null or name_row.valid_from <= p_at_date)
                  and (name_row.valid_to is null or name_row.valid_to >= p_at_date)
                )
              )
            order by
              case when p_at_date is not null then 0 else 1 end,
              name_row.valid_from desc nulls last,
              name_row.updated_at desc,
              name_row.id
            limit 1
          ),
          case
            when p_at_date is null then nullif(place_row.modern_name, '')
            else place_row.canonical_name
          end,
          place_row.canonical_name
        ),
        'matchedName', place_row.matched_name,
        'status', place_row.status,
        'verificationStatus', place_row.verification_status,
        'isPublic', place_row.is_public,
        'latitude', place_row.latitude,
        'longitude', place_row.longitude,
        'placeType', (
          select type_row.place_type_code
          from public.place_type_assignments type_row
          where type_row.place_id = place_row.id
            and (
              p_at_date is null
              or (
                (type_row.valid_from is null or type_row.valid_from <= p_at_date)
                and (type_row.valid_to is null or type_row.valid_to >= p_at_date)
              )
            )
          order by type_row.is_primary desc,
            type_row.valid_from desc nulls last,
            type_row.updated_at desc,
            type_row.id
          limit 1
        ),
        'atDate', p_at_date
      )
      order by place_row.date_rank, place_row.match_rank, place_row.match_score desc,
        place_row.canonical_name, place_row.id
    )
    from limited place_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.create_project_place_v1(
  p_project_id uuid,
  p_input jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  canonical_name_value text;
  modern_name_value text;
  description_value text;
  language_code_value text;
  latitude_value numeric;
  longitude_value numeric;
  needs_identification_value boolean;
  names_input jsonb;
  name_input jsonb;
  name_value text;
  original_text_value text;
  name_type_value text;
  name_language_value text;
  valid_from_value date;
  valid_to_value date;
  valid_from_text_value text;
  valid_to_text_value text;
  valid_from_precision_value text;
  valid_to_precision_value text;
  source_document_id_value uuid;
  source_finding_id_value uuid;
  citation_id_value uuid;
  source_reference_value text;
  confidence_value smallint;
  note_value text;
  metadata_value jsonb;
  is_primary_value boolean;
  names_have_primary boolean := false;
  name_index integer := 0;
  created_place public.places;
  created_name public.place_names;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null or not public.can_edit_project(p_project_id) then
    raise exception 'PROJECT_EDIT_REQUIRED' using errcode = '42501';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'PLACE_INPUT_OBJECT_REQUIRED' using errcode = '22023';
  end if;
  if octet_length(p_input::text) > 250000 then
    raise exception 'PLACE_INPUT_TOO_LARGE' using errcode = '22023';
  end if;

  canonical_name_value := btrim(coalesce(
    p_input ->> 'canonical_name',
    p_input ->> 'canonicalName',
    ''
  ));
  modern_name_value := btrim(coalesce(
    p_input ->> 'modern_name',
    p_input ->> 'modernName',
    ''
  ));
  description_value := coalesce(p_input ->> 'description', '');
  language_code_value := nullif(btrim(coalesce(
    p_input ->> 'language_code',
    p_input ->> 'languageCode',
    ''
  )), '');
  needs_identification_value := coalesce((coalesce(
    p_input ->> 'needs_identification',
    p_input ->> 'needsIdentification'
  ))::boolean, false);
  names_input := coalesce(p_input -> 'names', '[]'::jsonb);

  if jsonb_typeof(names_input) <> 'array' then
    raise exception 'PLACE_NAMES_ARRAY_REQUIRED' using errcode = '22023';
  end if;
  if jsonb_array_length(names_input) > 50 then
    raise exception 'PLACE_NAMES_LIMIT_EXCEEDED' using errcode = '22023';
  end if;
  if jsonb_array_length(names_input) > 0 then
    select exists (
      select 1
      from jsonb_array_elements(names_input) as expanded(item)
      where coalesce((coalesce(
        expanded.item ->> 'is_primary',
        expanded.item ->> 'isPrimary'
      ))::boolean, false)
    ) into names_have_primary;
  end if;

  if p_input ? 'latitude' and jsonb_typeof(p_input -> 'latitude') <> 'null' then
    latitude_value := (p_input ->> 'latitude')::numeric;
  end if;
  if p_input ? 'longitude' and jsonb_typeof(p_input -> 'longitude') <> 'null' then
    longitude_value := (p_input ->> 'longitude')::numeric;
  end if;

  if char_length(canonical_name_value) not between 1 and 500 then
    raise exception 'PLACE_CANONICAL_NAME_INVALID' using errcode = '22023';
  end if;
  if char_length(modern_name_value) > 500 or char_length(description_value) > 20000 then
    raise exception 'PLACE_INPUT_TOO_LONG' using errcode = '22023';
  end if;
  if (latitude_value is null) <> (longitude_value is null)
     or (latitude_value is not null and latitude_value not between -90 and 90)
     or (longitude_value is not null and longitude_value not between -180 and 180) then
    raise exception 'PLACE_COORDINATES_INVALID' using errcode = '22023';
  end if;

  insert into public.places (
    project_id, canonical_name, modern_name, description,
    latitude, longitude, status, created_by
  ) values (
    p_project_id,
    canonical_name_value,
    modern_name_value,
    description_value,
    latitude_value,
    longitude_value,
    case when needs_identification_value then 'needs_review' else 'active' end,
    auth.uid()
  )
  returning * into created_place;

  if jsonb_array_length(names_input) = 0 then
    insert into public.place_names (
      place_id, name, original_text, language_code,
      name_type, confidence, is_primary, created_by
    ) values (
      created_place.id,
      canonical_name_value,
      canonical_name_value,
      language_code_value,
      'canonical',
      50,
      true,
      auth.uid()
    )
    returning * into created_name;
  else
    for name_input in
      select expanded.item
      from jsonb_array_elements(names_input) as expanded(item)
    loop
      name_index := name_index + 1;
      if jsonb_typeof(name_input) <> 'object' then
        raise exception 'PLACE_NAME_INPUT_OBJECT_REQUIRED' using errcode = '22023';
      end if;

      original_text_value := coalesce(
        name_input ->> 'original_text',
        name_input ->> 'originalText',
        name_input ->> 'name',
        ''
      );
      name_value := btrim(coalesce(
        name_input ->> 'name',
        name_input ->> 'original_text',
        name_input ->> 'originalText',
        ''
      ));
      name_type_value := btrim(coalesce(
        name_input ->> 'name_type',
        name_input ->> 'nameType',
        'variant'
      ));
      name_language_value := nullif(btrim(coalesce(
        name_input ->> 'language_code',
        name_input ->> 'languageCode',
        language_code_value,
        ''
      )), '');
      valid_from_value := nullif(coalesce(
        name_input ->> 'valid_from',
        name_input ->> 'validFrom'
      ), '')::date;
      valid_to_value := nullif(coalesce(
        name_input ->> 'valid_to',
        name_input ->> 'validTo'
      ), '')::date;
      valid_from_text_value := nullif(coalesce(
        name_input ->> 'valid_from_text',
        name_input ->> 'validFromText',
        name_input ->> 'date_original_text',
        name_input ->> 'dateOriginalText'
      ), '');
      valid_to_text_value := nullif(coalesce(
        name_input ->> 'valid_to_text',
        name_input ->> 'validToText'
      ), '');
      valid_from_precision_value := nullif(coalesce(
        name_input ->> 'valid_from_precision',
        name_input ->> 'validFromPrecision',
        name_input ->> 'date_precision',
        name_input ->> 'datePrecision'
      ), '');
      valid_to_precision_value := nullif(coalesce(
        name_input ->> 'valid_to_precision',
        name_input ->> 'validToPrecision',
        name_input ->> 'date_precision',
        name_input ->> 'datePrecision'
      ), '');
      source_document_id_value := nullif(coalesce(
        name_input ->> 'source_document_id',
        name_input ->> 'sourceDocumentId'
      ), '')::uuid;
      source_finding_id_value := nullif(coalesce(
        name_input ->> 'source_finding_id',
        name_input ->> 'sourceFindingId'
      ), '')::uuid;
      citation_id_value := nullif(coalesce(
        name_input ->> 'citation_id',
        name_input ->> 'citationId'
      ), '')::uuid;
      source_reference_value := nullif(coalesce(
        name_input ->> 'source_reference',
        name_input ->> 'sourceReference'
      ), '');
      confidence_value := coalesce((name_input ->> 'confidence')::smallint, 50);
      note_value := coalesce(name_input ->> 'note', '');
      metadata_value := coalesce(name_input -> 'metadata', '{}'::jsonb);
      is_primary_value := coalesce((coalesce(
        name_input ->> 'is_primary',
        name_input ->> 'isPrimary'
      ))::boolean, false) or (name_index = 1 and not names_have_primary);

      if char_length(name_value) not between 1 and 500
         or char_length(original_text_value) not between 1 and 2000 then
        raise exception 'PLACE_NAME_VALUE_INVALID' using errcode = '22023';
      end if;
      if valid_from_value is not null
         and valid_to_value is not null
         and valid_from_value > valid_to_value then
        raise exception 'PLACE_NAME_VALID_PERIOD_INVALID' using errcode = '22023';
      end if;
      if confidence_value not between 0 and 100 then
        raise exception 'PLACE_NAME_CONFIDENCE_INVALID' using errcode = '22023';
      end if;
      if jsonb_typeof(metadata_value) <> 'object'
         or octet_length(metadata_value::text) > 100000 then
        raise exception 'PLACE_NAME_METADATA_INVALID' using errcode = '22023';
      end if;

      insert into public.place_names (
        place_id, name, original_text, language_code, name_type,
        valid_from, valid_to, valid_from_text, valid_to_text,
        valid_from_precision, valid_to_precision,
        source_document_id, source_finding_id, citation_id, source_reference,
        confidence, is_primary, note, metadata, created_by
      ) values (
        created_place.id, name_value, original_text_value,
        name_language_value, name_type_value,
        valid_from_value, valid_to_value,
        valid_from_text_value, valid_to_text_value,
        valid_from_precision_value, valid_to_precision_value,
        source_document_id_value, source_finding_id_value,
        citation_id_value, source_reference_value,
        confidence_value, is_primary_value, note_value, metadata_value, auth.uid()
      );
    end loop;

    select name_row.*
    into created_name
    from public.place_names name_row
    where name_row.place_id = created_place.id
    order by name_row.is_primary desc, name_row.created_at, name_row.id
    limit 1;
  end if;

  return jsonb_build_object(
    'place', jsonb_build_object(
      'id', created_place.id,
      'projectId', created_place.project_id,
      'scope', 'project',
      'canonicalName', created_place.canonical_name,
      'modernName', nullif(created_place.modern_name, ''),
      'description', created_place.description,
      'status', created_place.status,
      'verificationStatus', created_place.verification_status,
      'isPublic', created_place.is_public,
      'latitude', created_place.latitude,
      'longitude', created_place.longitude,
      'lockVersion', created_place.lock_version,
      'createdAt', created_place.created_at,
      'updatedAt', created_place.updated_at
    ),
    'primaryName', jsonb_build_object(
      'id', created_name.id,
      'placeId', created_name.place_id,
      'name', created_name.name,
      'originalText', created_name.original_text,
      'languageCode', created_name.language_code,
      'nameType', created_name.name_type,
      'validFrom', created_name.valid_from,
      'validTo', created_name.valid_to,
      'validFromText', created_name.valid_from_text,
      'validToText', created_name.valid_to_text,
      'validFromPrecision', created_name.valid_from_precision,
      'validToPrecision', created_name.valid_to_precision,
      'confidence', created_name.confidence,
      'isPrimary', created_name.is_primary,
      'lockVersion', created_name.lock_version
    )
  );
end;
$function$;

create or replace function security_private.resolve_place_hierarchy_v1(
  p_place_id uuid,
  p_at_date date default null,
  p_max_depth integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  bounded_depth integer := least(greatest(coalesce(p_max_depth, 12), 1), 32);
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  root_place public.places;
  hierarchy_rows jsonb;
  hierarchy_count integer;
  cycle_detected boolean;
  ambiguous_detected boolean;
  truncated_detected boolean;
  resolution_status text;
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;

  select place_row.*
  into root_place
  from public.places place_row
  where place_row.id = p_place_id;

  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not caller_is_service and not (
    (
      root_place.project_id is null
      and root_place.status = 'active'
      and root_place.verification_status = 'verified'
    )
    or (root_place.project_id is not null and public.is_project_member(root_place.project_id))
  ) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  with recursive hierarchy_walk as (
    select
      0 depth,
      root_place.id place_id,
      null::uuid relation_id,
      null::text relation_type,
      null::date valid_from,
      null::date valid_to,
      null::text valid_from_text,
      null::text valid_to_text,
      null::smallint confidence,
      array[root_place.id]::uuid[] path,
      false cycle_detected
    union all
    select
      walk.depth + 1,
      relation.parent_place_id,
      relation.id,
      relation.relation_type,
      relation.valid_from,
      relation.valid_to,
      relation.valid_from_text,
      relation.valid_to_text,
      relation.confidence,
      walk.path || relation.parent_place_id,
      relation.parent_place_id = any(walk.path)
    from hierarchy_walk walk
    join public.place_hierarchy_relations relation
      on relation.child_place_id = walk.place_id
     and (
       p_at_date is null
       or (
         (relation.valid_from is null or relation.valid_from <= p_at_date)
         and (relation.valid_to is null or relation.valid_to >= p_at_date)
       )
     )
    join public.places parent_place on parent_place.id = relation.parent_place_id
    where walk.depth < bounded_depth
      and not walk.cycle_detected
      and (
        caller_is_service
        or (
          relation.project_id is null
          and parent_place.project_id is null
          and parent_place.status = 'active'
          and parent_place.verification_status = 'verified'
        )
        or (
          relation.project_id is not null
          and relation.project_id = root_place.project_id
          and public.is_project_member(relation.project_id)
          and (
            parent_place.project_id = relation.project_id
            or (
              parent_place.project_id is null
              and parent_place.status = 'active'
              and parent_place.verification_status = 'verified'
            )
          )
        )
      )
  ), walk_stats as (
    select
      count(*) filter (where hierarchy_walk.depth > 0)::integer hierarchy_count,
      coalesce(bool_or(hierarchy_walk.cycle_detected), false) cycle_detected,
      exists (
        select 1
        from hierarchy_walk branch
        where branch.depth > 0
        group by branch.depth
        having count(*) > 1
      ) ambiguous_detected,
      exists (
        select 1
        from hierarchy_walk leaf
        join public.place_hierarchy_relations further
          on further.child_place_id = leaf.place_id
         and (
           p_at_date is null
           or (
             (further.valid_from is null or further.valid_from <= p_at_date)
             and (further.valid_to is null or further.valid_to >= p_at_date)
           )
         )
        where leaf.depth = bounded_depth
          and not leaf.cycle_detected
      ) truncated_detected
    from hierarchy_walk
  ), hierarchy_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'depth', walk.depth,
        'relationId', walk.relation_id,
        'relationType', walk.relation_type,
        'place', jsonb_build_object(
          'id', place_row.id,
          'projectId', place_row.project_id,
          'scope', case when place_row.project_id is null then 'global' else 'project' end,
          'canonicalName', place_row.canonical_name,
          'modernName', nullif(place_row.modern_name, ''),
          'displayName', coalesce(
            (
              select name_row.name
              from public.place_names name_row
              where name_row.place_id = place_row.id
                and name_row.is_primary
                and (
                  p_at_date is null
                  or (
                    (name_row.valid_from is null or name_row.valid_from <= p_at_date)
                    and (name_row.valid_to is null or name_row.valid_to >= p_at_date)
                  )
                )
              order by name_row.valid_from desc nulls last,
                name_row.updated_at desc,
                name_row.id
              limit 1
            ),
            case
              when p_at_date is null then nullif(place_row.modern_name, '')
              else place_row.canonical_name
            end,
            place_row.canonical_name
          ),
          'status', place_row.status,
          'verificationStatus', place_row.verification_status,
          'isPublic', place_row.is_public,
          'latitude', place_row.latitude,
          'longitude', place_row.longitude
        ),
        'validFrom', walk.valid_from,
        'validTo', walk.valid_to,
        'validFromText', walk.valid_from_text,
        'validToText', walk.valid_to_text,
        'confidence', walk.confidence,
        'cycleDetected', walk.cycle_detected,
        'path', to_jsonb(walk.path)
      ) order by walk.depth, walk.path, walk.relation_id
    ), '[]'::jsonb) value
    from hierarchy_walk walk
    join public.places place_row on place_row.id = walk.place_id
    where walk.depth > 0
  )
  select
    hierarchy_json.value,
    walk_stats.hierarchy_count,
    walk_stats.cycle_detected,
    walk_stats.ambiguous_detected,
    walk_stats.truncated_detected
  into
    hierarchy_rows,
    hierarchy_count,
    cycle_detected,
    ambiguous_detected,
    truncated_detected
  from hierarchy_json cross join walk_stats;

  resolution_status := case
    when cycle_detected then 'cycle_detected'
    when truncated_detected then 'truncated'
    when ambiguous_detected then 'ambiguous'
    when hierarchy_count = 0 then 'unknown'
    else 'resolved'
  end;

  return jsonb_build_object(
    'status', resolution_status,
    'atDate', p_at_date,
    'maxDepth', bounded_depth,
    'cycleDetected', cycle_detected,
    'ambiguous', ambiguous_detected,
    'truncated', truncated_detected,
    'place', jsonb_build_object(
      'id', root_place.id,
      'projectId', root_place.project_id,
      'scope', case when root_place.project_id is null then 'global' else 'project' end,
      'canonicalName', root_place.canonical_name,
      'modernName', nullif(root_place.modern_name, ''),
      'status', root_place.status,
      'verificationStatus', root_place.verification_status,
      'isPublic', root_place.is_public,
      'latitude', root_place.latitude,
      'longitude', root_place.longitude
    ),
    'hierarchy', hierarchy_rows
  );
end;
$function$;

-- Public API functions remain SECURITY INVOKER so exposed-schema security
-- audits do not report callable SECURITY DEFINER functions. The narrowly
-- granted implementations live outside the exposed public schema and perform
-- their own visibility checks before reading catalogue rows.
create or replace function public.search_places_v1(
  p_query text,
  p_at_date date default null,
  p_project_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.search_places_v1($1, $2, $3, $4);
$wrapper$;

create or replace function public.resolve_place_hierarchy_v1(
  p_place_id uuid,
  p_at_date date default null,
  p_max_depth integer default 12
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.resolve_place_hierarchy_v1($1, $2, $3);
$wrapper$;

revoke all on function public.search_places_v1(text,date,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.create_project_place_v1(uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_place_hierarchy_v1(uuid,date,integer)
  from public, anon, authenticated, service_role;

grant execute on function public.search_places_v1(text,date,uuid,integer)
  to anon, authenticated, service_role;
grant execute on function public.create_project_place_v1(uuid,jsonb)
  to authenticated, service_role;
grant execute on function public.resolve_place_hierarchy_v1(uuid,date,integer)
  to authenticated, service_role;

grant usage on schema security_private to anon, authenticated, service_role;
revoke all on function security_private.search_places_v1(text,date,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.resolve_place_hierarchy_v1(uuid,date,integer)
  from public, anon, authenticated, service_role;
grant execute on function security_private.search_places_v1(text,date,uuid,integer)
  to anon, authenticated, service_role;
grant execute on function security_private.resolve_place_hierarchy_v1(uuid,date,integer)
  to authenticated, service_role;

revoke all on function security_private.validate_historical_place_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.prepare_historical_place_project_delete_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.set_historical_place_child_scope_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.set_historical_place_hierarchy_scope_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.validate_historical_place_change_request_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.prepare_historical_place_name_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.touch_historical_place_row_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.lock_historical_place_ids_v1(uuid[],boolean)
  from public, anon, authenticated, service_role;
revoke all on function security_private.lock_historical_place_child_write_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.audit_historical_place_entity_v1()
  from public, anon, authenticated, service_role;

revoke all on table public.places from public, anon, authenticated;
revoke all on table public.place_names from public, anon, authenticated;
revoke all on table public.place_external_identifiers from public, anon, authenticated;
revoke all on table public.place_types from public, anon, authenticated;
revoke all on table public.place_type_assignments from public, anon, authenticated;
revoke all on table public.place_hierarchy_relations from public, anon, authenticated;
revoke all on table public.place_change_requests from public, anon, authenticated;

-- Anonymous access is intentionally column-limited: only the public identity
-- and published name timeline are exposed, never provenance, project links,
-- audit rows, hierarchy assertions, or related private record counts.
grant select (
  id, canonical_name, modern_name, description, latitude, longitude,
  status, verification_status, is_public, published_at, created_at, updated_at
) on public.places to anon;
grant select (
  id, place_id, name, language_code, name_type,
  valid_from, valid_to, valid_from_text, valid_to_text,
  valid_from_precision, valid_to_precision,
  confidence, is_primary, created_at, updated_at
) on public.place_names to anon;

grant select, insert, update, delete on public.places to authenticated;
grant select, insert, update, delete on public.place_names to authenticated;
grant select, insert, update, delete on public.place_external_identifiers to authenticated;
grant select on public.place_types to authenticated;
grant select, insert, update, delete on public.place_type_assignments to authenticated;
grant select, insert, update, delete on public.place_hierarchy_relations to authenticated;
grant select, insert on public.place_change_requests to authenticated;

grant all on table public.places to service_role;
grant all on table public.place_names to service_role;
grant all on table public.place_external_identifiers to service_role;
grant all on table public.place_types to service_role;
grant all on table public.place_type_assignments to service_role;
grant all on table public.place_hierarchy_relations to service_role;
grant all on table public.place_change_requests to service_role;

revoke all on table security_private.historical_place_audit_log
  from public, anon, authenticated, service_role;
grant select on table security_private.historical_place_audit_log to service_role;
revoke all on sequence security_private.historical_place_audit_log_id_seq
  from public, anon, authenticated, service_role;
grant select, usage on sequence security_private.historical_place_audit_log_id_seq
  to service_role;

-- The asynchronous project-deletion/restore worker is an explicit contract:
-- every public table that owns project data must have a deterministic phase.
-- Place dependants are removed after person events (which may reference a
-- Place) and before the owning project-private Place rows.
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
    'place_change_requests',
    'place_external_identifiers',
    'place_hierarchy_relations',
    'place_names',
    'place_type_assignments',
    'places',
    'person_names',
    'association_relationships',
    'parent_child_relationships',
    'parent_sets',
    'partner_relationships',
    'family_group_members',
    'family_groups',
    'family_tree_persons',
    'gedcom_import_batches',
    'family_tree_user_preferences',
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

do $$
declare
  uncovered_tables text[] := private.project_deletion_uncovered_table_names();
begin
  if coalesce(cardinality(uncovered_tables), 0) > 0 then
    raise exception 'PROJECT_DELETION_PHASES_MISSING_TABLES: %',
      array_to_string(uncovered_tables, ', ');
  end if;
end;
$$;

analyze public.places;
analyze public.place_names;
analyze public.place_external_identifiers;
analyze public.place_types;
analyze public.place_type_assignments;
analyze public.place_hierarchy_relations;
analyze public.place_change_requests;

commit;
