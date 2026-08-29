begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

create extension if not exists postgis with schema extensions;

-- GeoJSON remains the lossless source representation.  PostGIS geometry is a
-- deterministic, indexed-ready projection for maps and later spatial search;
-- it can always be rebuilt from geometry_geojson without altering evidence.
create table if not exists public.place_boundaries (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  boundary_type text not null default 'historical_boundary',
  geometry_geojson jsonb not null,
  geometry extensions.geometry(MultiPolygon, 4326)
    generated always as (
      extensions.st_multi(
        extensions.st_setsrid(
          extensions.st_geomfromgeojson(geometry_geojson::text),
          4326
        )
      )
    ) stored,
  geometry_format text not null default 'geojson',
  coordinate_reference_system text not null default 'EPSG:4326',
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
  original_text text not null default '',
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_boundaries_type_check
    check (boundary_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_boundaries_geojson_check
    check (
      jsonb_typeof(geometry_geojson) = 'object'
      and geometry_geojson ->> 'type' in ('Polygon', 'MultiPolygon')
      and jsonb_typeof(geometry_geojson -> 'coordinates') = 'array'
      and jsonb_array_length(geometry_geojson -> 'coordinates') > 0
    ),
  constraint place_boundaries_geometry_format_check
    check (geometry_format = 'geojson'),
  constraint place_boundaries_crs_check
    check (coordinate_reference_system = 'EPSG:4326'),
  constraint place_boundaries_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint place_boundaries_precision_check
    check (
      (valid_from_precision is null or valid_from_precision in
        ('day','month','year','circa','before','after','range','unknown'))
      and
      (valid_to_precision is null or valid_to_precision in
        ('day','month','year','circa','before','after','range','unknown'))
    ),
  constraint place_boundaries_text_check
    check (
      char_length(coalesce(valid_from_text, '')) <= 500
      and char_length(coalesce(valid_to_text, '')) <= 500
      and char_length(coalesce(source_reference, '')) <= 2000
      and char_length(original_text) <= 20000
      and char_length(note) <= 10000
    ),
  constraint place_boundaries_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint place_boundaries_lock_version_check check (lock_version > 0),
  constraint place_boundaries_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 100000)
);

comment on table public.place_boundaries is
  'Time-bounded Polygon/MultiPolygon evidence: lossless GeoJSON plus a generated PostGIS MultiPolygon projection in EPSG:4326.';
comment on column public.place_boundaries.geometry_geojson is
  'Lossless source geometry contract. The generated geometry column is disposable and may be rebuilt from it.';
comment on column public.place_boundaries.geometry is
  'Generated PostGIS projection for spatial indexes and map queries; never the only copy of source geometry.';

do $boundary_validity$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.place_boundaries'::regclass
      and constraint_row.conname = 'place_boundaries_geometry_valid_check'
  ) then
    alter table public.place_boundaries
      add constraint place_boundaries_geometry_valid_check
      check (
        not extensions.st_isempty(geometry)
        and extensions.st_isvalid(geometry)
        and extensions.st_xmin(extensions.box3d(geometry)) >= -180
        and extensions.st_xmax(extensions.box3d(geometry)) <= 180
        and extensions.st_ymin(extensions.box3d(geometry)) >= -90
        and extensions.st_ymax(extensions.box3d(geometry)) <= 90
      );
  end if;
end;
$boundary_validity$;

create table if not exists public.place_relations (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  related_place_id uuid not null references public.places(id) on delete restrict,
  project_id uuid references public.projects(id) on delete cascade,
  relation_type text not null,
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
  original_text text not null default '',
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_relations_not_self_check check (place_id <> related_place_id),
  constraint place_relations_type_check
    check (relation_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_relations_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint place_relations_precision_check
    check (
      (valid_from_precision is null or valid_from_precision in
        ('day','month','year','circa','before','after','range','unknown'))
      and
      (valid_to_precision is null or valid_to_precision in
        ('day','month','year','circa','before','after','range','unknown'))
    ),
  constraint place_relations_text_check
    check (
      char_length(coalesce(valid_from_text, '')) <= 500
      and char_length(coalesce(valid_to_text, '')) <= 500
      and char_length(coalesce(source_reference, '')) <= 2000
      and char_length(original_text) <= 20000
      and char_length(note) <= 10000
    ),
  constraint place_relations_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint place_relations_lock_version_check check (lock_version > 0),
  constraint place_relations_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 100000)
);

comment on table public.place_relations is
  'Directed, time-bounded generic links such as neighbouring settlement, estate, church, cemetery, or predecessor.';

create table if not exists public.place_parish_relations (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  parish_place_id uuid not null references public.places(id) on delete restrict,
  project_id uuid references public.projects(id) on delete cascade,
  religion text not null,
  relation_type text not null default 'belongs_to_parish',
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
  original_text text not null default '',
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_parish_relations_not_self_check check (place_id <> parish_place_id),
  constraint place_parish_relations_religion_check
    check (char_length(btrim(religion)) between 1 and 200),
  constraint place_parish_relations_type_check
    check (relation_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_parish_relations_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint place_parish_relations_precision_check
    check (
      (valid_from_precision is null or valid_from_precision in
        ('day','month','year','circa','before','after','range','unknown'))
      and
      (valid_to_precision is null or valid_to_precision in
        ('day','month','year','circa','before','after','range','unknown'))
    ),
  constraint place_parish_relations_text_check
    check (
      char_length(coalesce(valid_from_text, '')) <= 500
      and char_length(coalesce(valid_to_text, '')) <= 500
      and char_length(coalesce(source_reference, '')) <= 2000
      and char_length(original_text) <= 20000
      and char_length(note) <= 10000
    ),
  constraint place_parish_relations_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint place_parish_relations_lock_version_check check (lock_version > 0),
  constraint place_parish_relations_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 100000)
);

comment on table public.place_parish_relations is
  'Time-bounded settlement-to-parish membership. Concurrent relations for different religions are retained.';

create table if not exists public.archive_resources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  parent_resource_id uuid references public.archive_resources(id) on delete set null,
  resource_type text not null,
  title text not null,
  archive_name text not null default '',
  fund text not null default '',
  inventory text not null default '',
  file_reference text not null default '',
  catalogue_reference text not null default '',
  url text,
  description text not null default '',
  source_reference text,
  original_text text not null default '',
  status text not null default 'active',
  is_public boolean not null default false,
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint archive_resources_type_check
    check (resource_type in ('archive','fund','inventory','file','catalogue','external_resource')),
  constraint archive_resources_title_check
    check (char_length(btrim(title)) between 1 and 1000),
  constraint archive_resources_text_check
    check (
      char_length(archive_name) <= 1000
      and char_length(fund) <= 500
      and char_length(inventory) <= 500
      and char_length(file_reference) <= 500
      and char_length(catalogue_reference) <= 1000
      and char_length(description) <= 20000
      and char_length(coalesce(source_reference, '')) <= 2000
      and char_length(original_text) <= 20000
    ),
  constraint archive_resources_url_check
    check (url is null or (char_length(url) <= 4000 and url ~* '^https?://')),
  constraint archive_resources_status_check check (status in ('active','archived')),
  constraint archive_resources_public_scope_check
    check (not is_public or (project_id is null and status = 'active')),
  constraint archive_resources_lock_version_check check (lock_version > 0),
  constraint archive_resources_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 100000)
);

comment on table public.archive_resources is
  'Project-private or curated global archive/fund/inventory/file/catalogue resources. Global mutation is service-only.';

do $archive_parent_fk$
begin
  if exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.archive_resources'::regclass
      and constraint_row.conname = 'archive_resources_parent_resource_id_fkey'
      and constraint_row.confdeltype <> 'n'
  ) then
    alter table public.archive_resources
      drop constraint archive_resources_parent_resource_id_fkey;
    alter table public.archive_resources
      add constraint archive_resources_parent_resource_id_fkey
      foreign key (parent_resource_id)
      references public.archive_resources(id)
      on delete set null;
  end if;
end;
$archive_parent_fk$;

create table if not exists public.place_archive_relations (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  archive_resource_id uuid not null references public.archive_resources(id) on delete restrict,
  project_id uuid references public.projects(id) on delete cascade,
  relation_type text not null default 'has_materials',
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
  original_text text not null default '',
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint place_archive_relations_type_check
    check (relation_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint place_archive_relations_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint place_archive_relations_precision_check
    check (
      (valid_from_precision is null or valid_from_precision in
        ('day','month','year','circa','before','after','range','unknown'))
      and
      (valid_to_precision is null or valid_to_precision in
        ('day','month','year','circa','before','after','range','unknown'))
    ),
  constraint place_archive_relations_text_check
    check (
      char_length(coalesce(valid_from_text, '')) <= 500
      and char_length(coalesce(valid_to_text, '')) <= 500
      and char_length(coalesce(source_reference, '')) <= 2000
      and char_length(original_text) <= 20000
      and char_length(note) <= 10000
    ),
  constraint place_archive_relations_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint place_archive_relations_lock_version_check check (lock_version > 0),
  constraint place_archive_relations_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 100000)
);

create table if not exists public.document_place_links (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete cascade,
  relation_type text not null default 'mentions',
  original_text text not null default '',
  valid_from date,
  valid_to date,
  valid_from_text text,
  valid_to_text text,
  valid_from_precision text,
  valid_to_precision text,
  source_reference text,
  confidence smallint default 50,
  note text not null default '',
  created_by uuid references public.profiles(user_id) on delete set null,
  lock_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_place_links_type_check
    check (relation_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint document_place_links_original_text_check
    check (char_length(original_text) <= 20000),
  constraint document_place_links_valid_period_check
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  constraint document_place_links_precision_check
    check (
      (valid_from_precision is null or valid_from_precision in
        ('day','month','year','circa','before','after','range','unknown'))
      and
      (valid_to_precision is null or valid_to_precision in
        ('day','month','year','circa','before','after','range','unknown'))
    ),
  constraint document_place_links_text_check
    check (
      char_length(coalesce(valid_from_text, '')) <= 500
      and char_length(coalesce(valid_to_text, '')) <= 500
      and char_length(coalesce(source_reference, '')) <= 2000
      and char_length(note) <= 10000
    ),
  constraint document_place_links_confidence_check
    check (confidence is null or confidence between 0 and 100),
  constraint document_place_links_lock_version_check check (lock_version > 0),
  constraint document_place_links_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 100000)
);

comment on table public.document_place_links is
  'Confirmed or reviewed document-to-Place links. documents.place remains unchanged and original_text preserves the source spelling.';

create table if not exists public.place_merge_operations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  source_place_id uuid not null references public.places(id) on delete restrict,
  target_place_id uuid not null references public.places(id) on delete restrict,
  requested_by uuid references public.profiles(user_id) on delete set null,
  reason text not null default '',
  expected_source_lock_version integer not null,
  expected_target_lock_version integer not null,
  status text not null default 'running',
  preview jsonb not null,
  transfer_counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint place_merge_operations_not_self_check check (source_place_id <> target_place_id),
  constraint place_merge_operations_reason_check check (char_length(reason) <= 10000),
  constraint place_merge_operations_version_check
    check (expected_source_lock_version > 0 and expected_target_lock_version > 0),
  constraint place_merge_operations_status_check check (status in ('running','completed')),
  constraint place_merge_operations_json_check
    check (
      jsonb_typeof(preview) = 'object'
      and jsonb_typeof(transfer_counts) = 'object'
      and octet_length(preview::text) <= 1000000
      and octet_length(transfer_counts::text) <= 200000
    )
);

create table if not exists public.place_merge_preserved_rows (
  id bigint generated always as identity primary key,
  operation_id uuid not null references public.place_merge_operations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  entity_table text not null,
  original_entity_id uuid,
  preservation_reason text not null,
  row_data jsonb not null,
  created_at timestamptz not null default now(),
  constraint place_merge_preserved_rows_table_check
    check (entity_table in ('place_hierarchy_relations','place_relations','place_parish_relations')),
  constraint place_merge_preserved_rows_reason_check
    check (char_length(btrim(preservation_reason)) between 1 and 500),
  constraint place_merge_preserved_rows_data_check
    check (jsonb_typeof(row_data) = 'object' and octet_length(row_data::text) <= 250000)
);

comment on table public.place_merge_preserved_rows is
  'Exact row snapshots that cannot remain operational after ID substitution (for example a relation between the two duplicates becoming a self-link).';

create index if not exists place_boundaries_project_place_period_idx
  on public.place_boundaries (project_id, place_id, valid_from, valid_to, id);
create index if not exists place_boundaries_geometry_gist_idx
  on public.place_boundaries using gist (geometry);
create index if not exists place_relations_project_place_period_idx
  on public.place_relations (project_id, place_id, valid_from, valid_to, id);
create index if not exists place_relations_related_period_idx
  on public.place_relations (related_place_id, valid_from, valid_to, id);
create index if not exists place_parish_relations_project_place_period_idx
  on public.place_parish_relations (project_id, place_id, valid_from, valid_to, id);
create index if not exists place_parish_relations_parish_period_idx
  on public.place_parish_relations (parish_place_id, valid_from, valid_to, id);
create index if not exists archive_resources_project_status_idx
  on public.archive_resources (project_id, status, updated_at desc, id);
create index if not exists archive_resources_parent_idx
  on public.archive_resources (parent_resource_id, id) where parent_resource_id is not null;
create index if not exists place_archive_relations_project_place_period_idx
  on public.place_archive_relations (project_id, place_id, valid_from, valid_to, id);
create index if not exists place_archive_relations_resource_idx
  on public.place_archive_relations (archive_resource_id, id);
create index if not exists document_place_links_project_place_idx
  on public.document_place_links (project_id, place_id, document_id, id);
create index if not exists document_place_links_document_idx
  on public.document_place_links (document_id, place_id, id);
create index if not exists place_merge_operations_project_started_idx
  on public.place_merge_operations (project_id, started_at desc, id);
create index if not exists place_merge_operations_source_idx
  on public.place_merge_operations (source_place_id, started_at desc, id);
create index if not exists place_merge_operations_target_idx
  on public.place_merge_operations (target_place_id, started_at desc, id);
create index if not exists place_merge_preserved_rows_project_idx
  on public.place_merge_preserved_rows (project_id, operation_id, id);

create or replace function security_private.set_historical_place_relation_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  source_project_id uuid;
  target_project_id uuid;
  target_status text;
  target_verification_status text;
  target_place_id uuid;
  document_project_id uuid;
  finding_project_id uuid;
begin
  select place_row.project_id
  into source_project_id
  from public.places place_row
  where place_row.id = new.place_id;
  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = '23503';
  end if;

  if tg_table_name = 'place_relations' then
    target_place_id := new.related_place_id;
  elsif tg_table_name = 'place_parish_relations' then
    target_place_id := new.parish_place_id;
  else
    raise exception 'HISTORICAL_PLACE_RELATION_TABLE_UNSUPPORTED'
      using errcode = '0A000';
  end if;

  select place_row.project_id, place_row.status, place_row.verification_status
  into target_project_id, target_status, target_verification_status
  from public.places place_row
  where place_row.id = target_place_id;
  if not found then
    raise exception 'RELATED_PLACE_NOT_FOUND' using errcode = '23503';
  end if;

  if source_project_id is null and target_project_id is not null then
    raise exception 'GLOBAL_RELATION_TARGET_MUST_BE_GLOBAL' using errcode = '22023';
  end if;
  if source_project_id is not null
     and target_project_id is not null
     and source_project_id <> target_project_id then
    raise exception 'PLACE_RELATION_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if source_project_id is not null
     and target_project_id is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not (target_status = 'active' and target_verification_status = 'verified') then
    raise exception 'PLACE_RELATION_GLOBAL_TARGET_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  new.project_id := source_project_id;
  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;

  if new.source_document_id is not null then
    if source_project_id is null then
      raise exception 'GLOBAL_RELATION_PRIVATE_DOCUMENT_SOURCE_FORBIDDEN'
        using errcode = '22023';
    end if;
    select document_row.project_id into document_project_id
    from public.documents document_row
    where document_row.id = new.source_document_id;
    if not found or document_project_id <> source_project_id then
      raise exception 'PLACE_RELATION_DOCUMENT_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if new.source_finding_id is not null then
    if source_project_id is null then
      raise exception 'GLOBAL_RELATION_PRIVATE_FINDING_SOURCE_FORBIDDEN'
        using errcode = '22023';
    end if;
    select finding_row.project_id into finding_project_id
    from public.findings finding_row
    where finding_row.id = new.source_finding_id;
    if not found or finding_project_id <> source_project_id then
      raise exception 'PLACE_RELATION_FINDING_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function security_private.validate_archive_resource_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  parent_project_id uuid;
  parent_status text;
  parent_is_public boolean;
  archive_scope_lock_key bigint;
begin
  new.title := btrim(new.title);
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    raise exception 'ARCHIVE_RESOURCE_SCOPE_IMMUTABLE' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;

  if new.parent_resource_id = new.id then
    raise exception 'ARCHIVE_RESOURCE_PARENT_SELF_REFERENCE' using errcode = '22023';
  end if;
  if new.parent_resource_id is not null then
    -- Parent changes inside one scope are serialized so two concurrent writes
    -- cannot each validate against the other's previous parent and commit a
    -- cycle.  Project-private and global catalogues use separate lock keys.
    archive_scope_lock_key := pg_catalog.hashtextextended(
      'historical_archive_parent_v1:' || coalesce(new.project_id::text, 'global'),
      0
    );
    perform pg_catalog.pg_advisory_xact_lock(archive_scope_lock_key);

    select resource_row.project_id, resource_row.status, resource_row.is_public
    into parent_project_id, parent_status, parent_is_public
    from public.archive_resources resource_row
    where resource_row.id = new.parent_resource_id;
    if not found then
      raise exception 'ARCHIVE_PARENT_NOT_FOUND' using errcode = '23503';
    end if;
    if new.project_id is null and parent_project_id is not null then
      raise exception 'GLOBAL_ARCHIVE_PARENT_MUST_BE_GLOBAL' using errcode = '22023';
    end if;
    if new.project_id is not null and parent_project_id is not null
       and new.project_id <> parent_project_id then
      raise exception 'ARCHIVE_PARENT_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
    end if;
    if new.project_id is not null and parent_project_id is null
       and coalesce(auth.role(), '') <> 'service_role'
       and not (parent_status = 'active' and parent_is_public) then
      raise exception 'ARCHIVE_PARENT_ACCESS_REQUIRED' using errcode = '42501';
    end if;

    if exists (
      with recursive parent_chain as (
        select
          resource_row.id,
          resource_row.parent_resource_id,
          array[resource_row.id]::uuid[] as visited_ids,
          false as cycle_detected
        from public.archive_resources resource_row
        where resource_row.id = new.parent_resource_id

        union all

        select
          parent_row.id,
          parent_row.parent_resource_id,
          chain_row.visited_ids || parent_row.id,
          parent_row.id = any(chain_row.visited_ids)
        from parent_chain chain_row
        join public.archive_resources parent_row
          on parent_row.id = chain_row.parent_resource_id
        where not chain_row.cycle_detected
      )
      select 1
      from parent_chain chain_row
      where chain_row.id = new.id or chain_row.cycle_detected
    ) then
      raise exception 'ARCHIVE_RESOURCE_PARENT_CYCLE' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function security_private.set_place_archive_relation_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  place_project_id uuid;
  resource_project_id uuid;
  resource_status text;
  resource_is_public boolean;
  document_project_id uuid;
  finding_project_id uuid;
begin
  select place_row.project_id into place_project_id
  from public.places place_row where place_row.id = new.place_id;
  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = '23503';
  end if;

  select resource_row.project_id, resource_row.status, resource_row.is_public
  into resource_project_id, resource_status, resource_is_public
  from public.archive_resources resource_row
  where resource_row.id = new.archive_resource_id;
  if not found then
    raise exception 'ARCHIVE_RESOURCE_NOT_FOUND' using errcode = '23503';
  end if;

  if place_project_id is null and resource_project_id is not null then
    raise exception 'GLOBAL_PLACE_ARCHIVE_MUST_BE_GLOBAL' using errcode = '22023';
  end if;
  if place_project_id is not null and resource_project_id is not null
     and place_project_id <> resource_project_id then
    raise exception 'PLACE_ARCHIVE_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if place_project_id is not null and resource_project_id is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not (resource_status = 'active' and resource_is_public) then
    raise exception 'PLACE_ARCHIVE_RESOURCE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  new.project_id := place_project_id;
  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;

  if new.source_document_id is not null then
    if place_project_id is null then
      raise exception 'GLOBAL_PLACE_ARCHIVE_PRIVATE_DOCUMENT_FORBIDDEN'
        using errcode = '22023';
    end if;
    select document_row.project_id into document_project_id
    from public.documents document_row
    where document_row.id = new.source_document_id;
    if not found or document_project_id <> place_project_id then
      raise exception 'PLACE_ARCHIVE_DOCUMENT_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;
  if new.source_finding_id is not null then
    if place_project_id is null then
      raise exception 'GLOBAL_PLACE_ARCHIVE_PRIVATE_FINDING_FORBIDDEN'
        using errcode = '22023';
    end if;
    select finding_row.project_id into finding_project_id
    from public.findings finding_row
    where finding_row.id = new.source_finding_id;
    if not found or finding_project_id <> place_project_id then
      raise exception 'PLACE_ARCHIVE_FINDING_SCOPE_MISMATCH' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function security_private.set_document_place_link_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  document_project_id uuid;
  place_project_id uuid;
  place_status text;
  place_verification_status text;
begin
  select document_row.project_id into document_project_id
  from public.documents document_row where document_row.id = new.document_id;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = '23503';
  end if;

  select place_row.project_id, place_row.status, place_row.verification_status
  into place_project_id, place_status, place_verification_status
  from public.places place_row where place_row.id = new.place_id;
  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = '23503';
  end if;

  if place_project_id is not null and place_project_id <> document_project_id then
    raise exception 'DOCUMENT_PLACE_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if place_project_id is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not (place_status = 'active' and place_verification_status = 'verified') then
    raise exception 'DOCUMENT_PLACE_GLOBAL_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  new.project_id := document_project_id;
  if tg_op = 'INSERT' and coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;
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
    before_row := to_jsonb(old); after_row := null; audit_row := before_row;
  elsif tg_op = 'INSERT' then
    before_row := null; after_row := to_jsonb(new); audit_row := after_row;
  else
    before_row := to_jsonb(old); after_row := to_jsonb(new); audit_row := after_row;
  end if;

  audit_entity_id := nullif(audit_row ->> 'id', '')::uuid;
  audit_project_id := nullif(audit_row ->> 'project_id', '')::uuid;
  if tg_table_name = 'places' then
    audit_place_id := audit_entity_id;
  else
    audit_place_id := coalesce(
      nullif(audit_row ->> 'place_id', '')::uuid,
      nullif(audit_row ->> 'child_place_id', '')::uuid,
      nullif(audit_row ->> 'target_place_id', '')::uuid,
      nullif(audit_row ->> 'source_place_id', '')::uuid
    );
  end if;

  -- A direct FK cascade deletes the owning project before child AFTER DELETE
  -- triggers run.  The project's complete private audit history is already
  -- cascading away, so do not recreate an orphan audit row during teardown.
  if tg_op = 'DELETE'
     and audit_project_id is not null
     and not exists (
       select 1 from public.projects project_row
       where project_row.id = audit_project_id
     ) then
    return old;
  end if;

  insert into security_private.historical_place_audit_log (
    entity_table, entity_id, place_id, project_id, actor_id,
    action, before_data, after_data
  ) values (
    tg_table_name, audit_entity_id, audit_place_id, audit_project_id, auth.uid(),
    lower(tg_op), before_row, after_row
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

drop trigger if exists place_boundaries_10_scope on public.place_boundaries;
create trigger place_boundaries_10_scope
before insert or update on public.place_boundaries
for each row execute function security_private.set_historical_place_child_scope_v1();

drop trigger if exists place_relations_10_scope on public.place_relations;
create trigger place_relations_10_scope
before insert or update on public.place_relations
for each row execute function security_private.set_historical_place_relation_scope_v1();

drop trigger if exists place_parish_relations_10_scope on public.place_parish_relations;
create trigger place_parish_relations_10_scope
before insert or update on public.place_parish_relations
for each row execute function security_private.set_historical_place_relation_scope_v1();

drop trigger if exists archive_resources_10_scope on public.archive_resources;
create trigger archive_resources_10_scope
before insert or update on public.archive_resources
for each row execute function security_private.validate_archive_resource_scope_v1();

drop trigger if exists place_archive_relations_10_scope on public.place_archive_relations;
create trigger place_archive_relations_10_scope
before insert or update on public.place_archive_relations
for each row execute function security_private.set_place_archive_relation_scope_v1();

drop trigger if exists document_place_links_10_scope on public.document_place_links;
create trigger document_place_links_10_scope
before insert or update on public.document_place_links
for each row execute function security_private.set_document_place_link_scope_v1();

do $place_write_locks$
declare table_name text;
begin
  foreach table_name in array array[
    'place_boundaries',
    'place_relations',
    'place_parish_relations',
    'place_archive_relations',
    'document_place_links'
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

do $do$
declare table_name text;
begin
  foreach table_name in array array[
    'place_boundaries', 'place_relations', 'place_parish_relations',
    'archive_resources', 'place_archive_relations', 'document_place_links'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_20_touch', table_name);
    execute format(
      'create trigger %I before update on public.%I for each row execute function security_private.touch_historical_place_row_v1()',
      table_name || '_20_touch', table_name
    );
  end loop;
end;
$do$;

alter table public.place_boundaries enable row level security;
alter table public.place_relations enable row level security;
alter table public.place_parish_relations enable row level security;
alter table public.archive_resources enable row level security;
alter table public.place_archive_relations enable row level security;
alter table public.document_place_links enable row level security;
alter table public.place_merge_operations enable row level security;
alter table public.place_merge_preserved_rows enable row level security;

drop policy if exists place_boundaries_authenticated_select on public.place_boundaries;
create policy place_boundaries_authenticated_select
on public.place_boundaries for select to authenticated
using (
  (project_id is not null and public.is_project_member(project_id))
  or (
    project_id is null and exists (
      select 1 from public.places place_row
      where place_row.id = place_boundaries.place_id
        and place_row.project_id is null
        and place_row.status = 'active'
        and place_row.verification_status = 'verified'
    )
  )
);

drop policy if exists place_relations_authenticated_select on public.place_relations;
create policy place_relations_authenticated_select
on public.place_relations for select to authenticated
using (
  (project_id is not null and public.is_project_member(project_id))
  or (
    project_id is null and exists (
      select 1
      from public.places source_place
      join public.places target_place on target_place.id = place_relations.related_place_id
      where source_place.id = place_relations.place_id
        and source_place.project_id is null
        and target_place.project_id is null
        and source_place.status = 'active'
        and source_place.verification_status = 'verified'
        and target_place.status = 'active'
        and target_place.verification_status = 'verified'
    )
  )
);

drop policy if exists place_parish_relations_authenticated_select on public.place_parish_relations;
create policy place_parish_relations_authenticated_select
on public.place_parish_relations for select to authenticated
using (
  (project_id is not null and public.is_project_member(project_id))
  or (
    project_id is null and exists (
      select 1
      from public.places settlement_place
      join public.places parish_place on parish_place.id = place_parish_relations.parish_place_id
      where settlement_place.id = place_parish_relations.place_id
        and settlement_place.project_id is null
        and parish_place.project_id is null
        and settlement_place.status = 'active'
        and settlement_place.verification_status = 'verified'
        and parish_place.status = 'active'
        and parish_place.verification_status = 'verified'
    )
  )
);

drop policy if exists archive_resources_authenticated_select on public.archive_resources;
create policy archive_resources_authenticated_select
on public.archive_resources for select to authenticated
using (
  (project_id is not null and public.is_project_member(project_id))
  or (project_id is null and status = 'active' and is_public)
);

drop policy if exists place_archive_relations_authenticated_select on public.place_archive_relations;
create policy place_archive_relations_authenticated_select
on public.place_archive_relations for select to authenticated
using (
  (project_id is not null and public.is_project_member(project_id))
  or (
    project_id is null and exists (
      select 1
      from public.places place_row
      join public.archive_resources resource_row
        on resource_row.id = place_archive_relations.archive_resource_id
      where place_row.id = place_archive_relations.place_id
        and place_row.project_id is null
        and place_row.status = 'active'
        and place_row.verification_status = 'verified'
        and resource_row.project_id is null
        and resource_row.status = 'active'
        and resource_row.is_public
    )
  )
);

drop policy if exists document_place_links_project_select on public.document_place_links;
create policy document_place_links_project_select
on public.document_place_links for select to authenticated
using (public.is_project_member(project_id));

do $policies$
declare table_name text;
begin
  foreach table_name in array array[
    'place_boundaries', 'place_relations', 'place_parish_relations',
    'archive_resources', 'place_archive_relations', 'document_place_links'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_project_insert', table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (project_id is not null and public.can_edit_project(project_id))',
      table_name || '_project_insert', table_name
    );
    execute format('drop policy if exists %I on public.%I', table_name || '_project_update', table_name);
    execute format(
      'create policy %I on public.%I for update to authenticated using (project_id is not null and public.can_edit_project(project_id)) with check (project_id is not null and public.can_edit_project(project_id))',
      table_name || '_project_update', table_name
    );
    execute format('drop policy if exists %I on public.%I', table_name || '_project_delete', table_name);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (project_id is not null and public.can_edit_project(project_id))',
      table_name || '_project_delete', table_name
    );
  end loop;
end;
$policies$;

drop policy if exists place_merge_operations_project_select on public.place_merge_operations;
create policy place_merge_operations_project_select
on public.place_merge_operations for select to authenticated
using (project_id is not null and public.is_project_member(project_id));

drop policy if exists place_merge_preserved_rows_project_select on public.place_merge_preserved_rows;
create policy place_merge_preserved_rows_project_select
on public.place_merge_preserved_rows for select to authenticated
using (project_id is not null and public.is_project_member(project_id));

create or replace function security_private.list_place_boundaries_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then raise exception 'PLACE_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', boundary_row.id,
      'placeId', boundary_row.place_id,
      'boundaryType', boundary_row.boundary_type,
      'geometryGeojson', boundary_row.geometry_geojson,
      'srid', extensions.st_srid(boundary_row.geometry),
      'geometryType', extensions.geometrytype(boundary_row.geometry),
      'validFrom', boundary_row.valid_from,
      'validTo', boundary_row.valid_to,
      'validFromText', boundary_row.valid_from_text,
      'validToText', boundary_row.valid_to_text,
      'validFromPrecision', boundary_row.valid_from_precision,
      'validToPrecision', boundary_row.valid_to_precision,
      'sourceDocumentId', boundary_row.source_document_id,
      'sourceFindingId', boundary_row.source_finding_id,
      'citationId', boundary_row.citation_id,
      'sourceReference', boundary_row.source_reference,
      'confidence', boundary_row.confidence,
      'originalText', boundary_row.original_text,
      'note', boundary_row.note,
      'lockVersion', boundary_row.lock_version
    ) order by boundary_row.valid_from nulls first, boundary_row.valid_to nulls last, boundary_row.id)
    from public.place_boundaries boundary_row
    where boundary_row.place_id = p_place_id
      and (
        p_at_date is null
        or ((boundary_row.valid_from is null or boundary_row.valid_from <= p_at_date)
          and (boundary_row.valid_to is null or boundary_row.valid_to >= p_at_date))
      )
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_related_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then raise exception 'PLACE_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', relation_row.id,
      'direction', case when relation_row.place_id = p_place_id then 'outgoing' else 'incoming' end,
      'relationType', relation_row.relation_type,
      'place', jsonb_build_object(
        'id', other_place.id,
        'canonicalName', other_place.canonical_name,
        'modernName', nullif(other_place.modern_name, ''),
        'latitude', other_place.latitude,
        'longitude', other_place.longitude,
        'status', other_place.status,
        'verificationStatus', other_place.verification_status
      ),
      'validFrom', relation_row.valid_from,
      'validTo', relation_row.valid_to,
      'validFromText', relation_row.valid_from_text,
      'validToText', relation_row.valid_to_text,
      'validFromPrecision', relation_row.valid_from_precision,
      'validToPrecision', relation_row.valid_to_precision,
      'sourceDocumentId', relation_row.source_document_id,
      'sourceFindingId', relation_row.source_finding_id,
      'citationId', relation_row.citation_id,
      'sourceReference', relation_row.source_reference,
      'confidence', relation_row.confidence,
      'originalText', relation_row.original_text,
      'note', relation_row.note,
      'lockVersion', relation_row.lock_version
    ) order by relation_row.valid_from nulls first, other_place.canonical_name, relation_row.id)
    from public.place_relations relation_row
    join public.places other_place on other_place.id = case
      when relation_row.place_id = p_place_id then relation_row.related_place_id
      else relation_row.place_id
    end
    where (relation_row.place_id = p_place_id or relation_row.related_place_id = p_place_id)
      and security_private.can_read_historical_place_v1(other_place.id)
      and (
        p_at_date is null
        or ((relation_row.valid_from is null or relation_row.valid_from <= p_at_date)
          and (relation_row.valid_to is null or relation_row.valid_to >= p_at_date))
      )
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_parishes_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then raise exception 'PLACE_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', relation_row.id,
      'direction', case when relation_row.place_id = p_place_id then 'settlementToParish' else 'parishToSettlement' end,
      'religion', relation_row.religion,
      'relationType', relation_row.relation_type,
      'place', jsonb_build_object(
        'id', other_place.id,
        'canonicalName', other_place.canonical_name,
        'modernName', nullif(other_place.modern_name, ''),
        'latitude', other_place.latitude,
        'longitude', other_place.longitude
      ),
      'validFrom', relation_row.valid_from,
      'validTo', relation_row.valid_to,
      'validFromText', relation_row.valid_from_text,
      'validToText', relation_row.valid_to_text,
      'validFromPrecision', relation_row.valid_from_precision,
      'validToPrecision', relation_row.valid_to_precision,
      'sourceDocumentId', relation_row.source_document_id,
      'sourceFindingId', relation_row.source_finding_id,
      'citationId', relation_row.citation_id,
      'sourceReference', relation_row.source_reference,
      'confidence', relation_row.confidence,
      'originalText', relation_row.original_text,
      'note', relation_row.note,
      'lockVersion', relation_row.lock_version
    ) order by relation_row.valid_from nulls first, relation_row.religion, other_place.canonical_name, relation_row.id)
    from public.place_parish_relations relation_row
    join public.places other_place on other_place.id = case
      when relation_row.place_id = p_place_id then relation_row.parish_place_id
      else relation_row.place_id
    end
    where (relation_row.place_id = p_place_id or relation_row.parish_place_id = p_place_id)
      and security_private.can_read_historical_place_v1(other_place.id)
      and (
        p_at_date is null
        or ((relation_row.valid_from is null or relation_row.valid_from <= p_at_date)
          and (relation_row.valid_to is null or relation_row.valid_to >= p_at_date))
      )
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_archives_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then raise exception 'PLACE_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', relation_row.id,
      'relationType', relation_row.relation_type,
      'resource', jsonb_build_object(
        'id', resource_row.id,
        'parentResourceId', resource_row.parent_resource_id,
        'resourceType', resource_row.resource_type,
        'title', resource_row.title,
        'archiveName', resource_row.archive_name,
        'fund', resource_row.fund,
        'inventory', resource_row.inventory,
        'fileReference', resource_row.file_reference,
        'catalogueReference', resource_row.catalogue_reference,
        'url', resource_row.url,
        'description', resource_row.description,
        'sourceReference', resource_row.source_reference,
        'originalText', resource_row.original_text
      ),
      'validFrom', relation_row.valid_from,
      'validTo', relation_row.valid_to,
      'validFromText', relation_row.valid_from_text,
      'validToText', relation_row.valid_to_text,
      'validFromPrecision', relation_row.valid_from_precision,
      'validToPrecision', relation_row.valid_to_precision,
      'sourceDocumentId', relation_row.source_document_id,
      'sourceFindingId', relation_row.source_finding_id,
      'citationId', relation_row.citation_id,
      'sourceReference', relation_row.source_reference,
      'confidence', relation_row.confidence,
      'originalText', relation_row.original_text,
      'note', relation_row.note,
      'lockVersion', relation_row.lock_version
    ) order by resource_row.archive_name, resource_row.fund, resource_row.title, relation_row.id)
    from public.place_archive_relations relation_row
    join public.archive_resources resource_row
      on resource_row.id = relation_row.archive_resource_id
    where relation_row.place_id = p_place_id
      and (
        coalesce(auth.role(), '') = 'service_role'
        or (resource_row.project_id is not null and public.is_project_member(resource_row.project_id))
        or (resource_row.project_id is null and resource_row.status = 'active' and resource_row.is_public)
      )
      and (
        p_at_date is null
        or ((relation_row.valid_from is null or relation_row.valid_from <= p_at_date)
          and (relation_row.valid_to is null or relation_row.valid_to >= p_at_date))
      )
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_documents_v1(
  p_place_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
declare bounded_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then raise exception 'PLACE_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(page_row) order by page_row."updatedAt" desc, page_row."linkId")
    from (
      select
        link_row.id as "linkId",
        link_row.document_id as "documentId",
        document_row.title,
        document_row.document_type as "documentType",
        document_row.archive,
        document_row.fund,
        document_row.file_reference as "fileReference",
        document_row.year_from as "yearFrom",
        document_row.year_to as "yearTo",
        document_row.url,
        link_row.relation_type as "relationType",
        link_row.original_text as "originalText",
        link_row.source_reference as "sourceReference",
        link_row.confidence,
        link_row.note,
        link_row.updated_at as "updatedAt"
      from public.document_place_links link_row
      join public.documents document_row on document_row.id = link_row.document_id
      where link_row.place_id = p_place_id
        and (coalesce(auth.role(), '') = 'service_role' or public.is_project_member(link_row.project_id))
      order by link_row.updated_at desc, link_row.id
      limit bounded_limit offset bounded_offset
    ) page_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_people_v1(
  p_place_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
declare bounded_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then raise exception 'PLACE_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(page_row) order by page_row."fullName", page_row."personId")
    from (
      select
        person_row.id as "personId",
        person_row.full_name as "fullName",
        person_row.surname,
        person_row.given_name as "givenName",
        person_row.patronymic,
        count(event_row.id)::integer as "eventCount",
        jsonb_agg(distinct event_row.event_type) as "eventTypes"
      from public.person_timeline_events event_row
      join public.persons person_row
        on person_row.id = event_row.person_id and person_row.project_id = event_row.project_id
      where event_row.place_id = p_place_id
        and (coalesce(auth.role(), '') = 'service_role' or public.is_project_member(event_row.project_id))
      group by person_row.id, person_row.full_name, person_row.surname, person_row.given_name, person_row.patronymic
      order by person_row.full_name, person_row.id
      limit bounded_limit offset bounded_offset
    ) page_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_events_v1(
  p_place_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
declare bounded_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then raise exception 'PLACE_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(page_row) order by page_row."eventDate" nulls last, page_row."eventId")
    from (
      select
        event_row.id as "eventId",
        event_row.person_id as "personId",
        person_row.full_name as "personName",
        event_row.event_type as "eventType",
        event_row.title,
        nullif(event_row.event_date, '') as "eventDate",
        event_row.date_from as "dateFrom",
        event_row.date_to as "dateTo",
        event_row.date_text as "dateText",
        event_row.place_name as "placeName",
        event_row.place_original_text as "placeOriginalText",
        event_row.place_resolution_status as "placeResolutionStatus",
        event_row.event_role as "eventRole",
        event_row.evidence_status as "evidenceStatus",
        event_row.confidence,
        event_row.source_document_id as "sourceDocumentId",
        event_row.source_finding_id as "sourceFindingId",
        event_row.updated_at as "updatedAt"
      from public.person_timeline_events event_row
      join public.persons person_row
        on person_row.id = event_row.person_id and person_row.project_id = event_row.project_id
      where event_row.place_id = p_place_id
        and (coalesce(auth.role(), '') = 'service_role' or public.is_project_member(event_row.project_id))
      order by nullif(event_row.event_date, '') nulls last, event_row.id
      limit bounded_limit offset bounded_offset
    ) page_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.merge_place_snapshot_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare place_row public.places%rowtype;
begin
  select row_data.* into place_row
  from public.places row_data where row_data.id = p_place_id;
  if not found then raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not security_private.can_read_historical_place_v1(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'place', jsonb_build_object(
      'id', place_row.id,
      'projectId', place_row.project_id,
      'canonicalName', place_row.canonical_name,
      'modernName', nullif(place_row.modern_name, ''),
      'latitude', place_row.latitude,
      'longitude', place_row.longitude,
      'status', place_row.status,
      'verificationStatus', place_row.verification_status,
      'lockVersion', place_row.lock_version
    ),
    'counts', jsonb_build_object(
      'names', (select count(*) from public.place_names where place_id = p_place_id),
      'boundaries', (select count(*) from public.place_boundaries where place_id = p_place_id),
      'typeAssignments', (select count(*) from public.place_type_assignments where place_id = p_place_id),
      'externalIdentifiers', (select count(*) from public.place_external_identifiers where place_id = p_place_id),
      'hierarchyAsChild', (
        select count(*)
        from public.place_hierarchy_relations relation_row
        where relation_row.child_place_id = p_place_id
          and security_private.can_read_historical_place_v1(relation_row.parent_place_id)
      ),
      'hierarchyAsParent', (
        select count(*)
        from public.place_hierarchy_relations relation_row
        where relation_row.parent_place_id = p_place_id
          and security_private.can_read_historical_place_v1(relation_row.child_place_id)
      ),
      'relatedOutgoing', (
        select count(*)
        from public.place_relations relation_row
        where relation_row.place_id = p_place_id
          and security_private.can_read_historical_place_v1(relation_row.related_place_id)
      ),
      'relatedIncoming', (
        select count(*)
        from public.place_relations relation_row
        where relation_row.related_place_id = p_place_id
          and security_private.can_read_historical_place_v1(relation_row.place_id)
      ),
      'parishAsSettlement', (
        select count(*)
        from public.place_parish_relations relation_row
        where relation_row.place_id = p_place_id
          and security_private.can_read_historical_place_v1(relation_row.parish_place_id)
      ),
      'parishAsParish', (
        select count(*)
        from public.place_parish_relations relation_row
        where relation_row.parish_place_id = p_place_id
          and security_private.can_read_historical_place_v1(relation_row.place_id)
      ),
      'archives', (
        select count(*)
        from public.place_archive_relations relation_row
        join public.archive_resources resource_row
          on resource_row.id = relation_row.archive_resource_id
        where relation_row.place_id = p_place_id
          and (
            coalesce(auth.role(), '') = 'service_role'
            or (resource_row.project_id is not null and public.is_project_member(resource_row.project_id))
            or (resource_row.project_id is null and resource_row.status = 'active' and resource_row.is_public)
          )
      ),
      'visibleDocuments', (
        select count(*) from public.document_place_links link_row
        where link_row.place_id = p_place_id
          and (coalesce(auth.role(), '') = 'service_role' or public.is_project_member(link_row.project_id))
      ),
      'visibleEvents', (
        select count(*) from public.person_timeline_events event_row
        where event_row.place_id = p_place_id
          and (coalesce(auth.role(), '') = 'service_role' or public.is_project_member(event_row.project_id))
      ),
      'visiblePeople', (
        select count(distinct event_row.person_id) from public.person_timeline_events event_row
        where event_row.place_id = p_place_id
          and (coalesce(auth.role(), '') = 'service_role' or public.is_project_member(event_row.project_id))
      )
    ),
    'names', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sample.id, 'name', sample.name, 'originalText', sample.original_text,
        'languageCode', sample.language_code, 'nameType', sample.name_type,
        'validFrom', sample.valid_from, 'validTo', sample.valid_to,
        'isPrimary', sample.is_primary
      ) order by sample.is_primary desc, sample.valid_from nulls first, sample.id)
      from (
        select * from public.place_names
        where place_id = p_place_id
        order by is_primary desc, valid_from nulls first, id
        limit 50
      ) sample
    ), '[]'::jsonb),
    'hierarchy', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sample.id,
        'direction', sample.direction,
        'relationType', sample.relation_type,
        'otherPlaceId', sample.other_place_id,
        'otherPlaceName', other_place.canonical_name,
        'validFrom', sample.valid_from,
        'validTo', sample.valid_to
      ) order by sample.valid_from nulls first, sample.id)
      from (
        select relation_row.id, relation_row.relation_type,
          case when relation_row.child_place_id = p_place_id then 'child' else 'parent' end as direction,
          case when relation_row.child_place_id = p_place_id then relation_row.parent_place_id else relation_row.child_place_id end as other_place_id,
          relation_row.valid_from, relation_row.valid_to
        from public.place_hierarchy_relations relation_row
        where relation_row.child_place_id = p_place_id or relation_row.parent_place_id = p_place_id
        order by relation_row.valid_from nulls first, relation_row.id
        limit 50
      ) sample
      join public.places other_place on other_place.id = sample.other_place_id
      where security_private.can_read_historical_place_v1(other_place.id)
    ), '[]'::jsonb),
    'people', security_private.list_place_people_v1(p_place_id, 25, 0),
    'documents', security_private.list_place_documents_v1(p_place_id, 25, 0)
  );
end;
$function$;

create or replace function security_private.merge_places_preview_v1(
  p_source_place_id uuid,
  p_target_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  source_place public.places%rowtype;
  target_place public.places%rowtype;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  caller_can_merge boolean := false;
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_source_place_id is null or p_target_place_id is null then
    raise exception 'MERGE_PLACE_IDS_REQUIRED' using errcode = '22023';
  end if;
  if p_source_place_id = p_target_place_id then
    raise exception 'MERGE_PLACES_MUST_DIFFER' using errcode = '22023';
  end if;

  select row_data.* into source_place from public.places row_data
  where row_data.id = p_source_place_id;
  if not found then raise exception 'MERGE_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  select row_data.* into target_place from public.places row_data
  where row_data.id = p_target_place_id;
  if not found then raise exception 'MERGE_TARGET_NOT_FOUND' using errcode = 'P0002'; end if;

  if source_place.project_id is distinct from target_place.project_id then
    raise exception 'MERGE_PLACE_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if source_place.status = 'merged' or target_place.status = 'merged' then
    raise exception 'MERGE_REDIRECT_PLACE_FORBIDDEN' using errcode = '22023';
  end if;
  if target_place.status = 'archived' then
    raise exception 'MERGE_TARGET_ARCHIVED' using errcode = '22023';
  end if;

  if source_place.project_id is null then
    if not caller_is_service
       and (not security_private.can_read_historical_place_v1(source_place.id)
         or not security_private.can_read_historical_place_v1(target_place.id)) then
      raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
    end if;
    caller_can_merge := caller_is_service;
  else
    if not caller_is_service and not public.is_project_member(source_place.project_id) then
      raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
    end if;
    caller_can_merge := caller_is_service or public.can_edit_project(source_place.project_id);
  end if;

  return jsonb_build_object(
    'source', security_private.merge_place_snapshot_v1(source_place.id),
    'target', security_private.merge_place_snapshot_v1(target_place.id),
    'canMerge', caller_can_merge,
    'requiresChangeRequest', source_place.project_id is null and not caller_is_service,
    'preservationPreview', jsonb_build_object(
      'hierarchySelfLinks', (
        select count(*) from public.place_hierarchy_relations relation_row
        where (relation_row.child_place_id = source_place.id and relation_row.parent_place_id = target_place.id)
           or (relation_row.child_place_id = target_place.id and relation_row.parent_place_id = source_place.id)
      ),
      'genericSelfLinks', (
        select count(*) from public.place_relations relation_row
        where (relation_row.place_id = source_place.id and relation_row.related_place_id = target_place.id)
           or (relation_row.place_id = target_place.id and relation_row.related_place_id = source_place.id)
      ),
      'parishSelfLinks', (
        select count(*) from public.place_parish_relations relation_row
        where (relation_row.place_id = source_place.id and relation_row.parish_place_id = target_place.id)
           or (relation_row.place_id = target_place.id and relation_row.parish_place_id = source_place.id)
      )
    )
  );
end;
$function$;

create or replace function security_private.merge_places_v1(
  p_source_place_id uuid,
  p_target_place_id uuid,
  p_expected_source_lock_version integer,
  p_expected_target_lock_version integer,
  p_reason text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '30s'
as $function$
declare
  source_place public.places%rowtype;
  target_place public.places%rowtype;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  operation_id uuid := gen_random_uuid();
  preview_data jsonb;
  transfer_counts_data jsonb := '{}'::jsonb;
  affected integer;
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_source_place_id is null or p_target_place_id is null
     or p_expected_source_lock_version is null or p_expected_target_lock_version is null then
    raise exception 'MERGE_ARGUMENTS_REQUIRED' using errcode = '22023';
  end if;
  if p_source_place_id = p_target_place_id then
    raise exception 'MERGE_PLACES_MUST_DIFFER' using errcode = '22023';
  end if;
  if char_length(coalesce(p_reason, '')) > 10000 then
    raise exception 'MERGE_REASON_TOO_LONG' using errcode = '22023';
  end if;

  -- Advisory identity locks precede both row locks and the preview snapshot.
  -- UUID sorting happens inside the helper, so A->B and B->A requests cannot
  -- deadlock by acquiring the same identities in opposite order.
  perform security_private.lock_historical_place_ids_v1(
    array[p_source_place_id, p_target_place_id]::uuid[],
    true
  );

  perform 1 from public.places place_row
  where place_row.id in (p_source_place_id, p_target_place_id)
  order by place_row.id
  for update;

  select row_data.* into source_place from public.places row_data
  where row_data.id = p_source_place_id;
  if not found then raise exception 'MERGE_SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  select row_data.* into target_place from public.places row_data
  where row_data.id = p_target_place_id;
  if not found then raise exception 'MERGE_TARGET_NOT_FOUND' using errcode = 'P0002'; end if;

  if source_place.project_id is distinct from target_place.project_id then
    raise exception 'MERGE_PLACE_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if source_place.status = 'merged' or target_place.status = 'merged' then
    raise exception 'MERGE_REDIRECT_PLACE_FORBIDDEN' using errcode = '22023';
  end if;
  if target_place.status = 'archived' then
    raise exception 'MERGE_TARGET_ARCHIVED' using errcode = '22023';
  end if;
  if source_place.project_id is null and not caller_is_service then
    raise exception 'GLOBAL_PLACE_MERGE_CHANGE_REQUEST_REQUIRED' using errcode = '42501';
  end if;
  if source_place.project_id is not null and not caller_is_service
     and not public.can_edit_project(source_place.project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if source_place.lock_version <> p_expected_source_lock_version
     or target_place.lock_version <> p_expected_target_lock_version then
    raise exception 'PLACE_MERGE_VERSION_CONFLICT' using errcode = '40001';
  end if;

  preview_data := security_private.merge_places_preview_v1(source_place.id, target_place.id);

  insert into public.place_merge_operations (
    id, project_id, source_place_id, target_place_id, requested_by, reason,
    expected_source_lock_version, expected_target_lock_version, preview
  ) values (
    operation_id, source_place.project_id, source_place.id, target_place.id,
    auth.uid(), coalesce(p_reason, ''), source_place.lock_version,
    target_place.lock_version, preview_data
  );

  insert into public.place_merge_preserved_rows (
    operation_id, project_id, entity_table, original_entity_id,
    preservation_reason, row_data
  )
  select operation_id, source_place.project_id, 'place_hierarchy_relations',
    relation_row.id, 'ID substitution would create a hierarchy self-link',
    to_jsonb(relation_row)
  from public.place_hierarchy_relations relation_row
  where (relation_row.child_place_id = source_place.id and relation_row.parent_place_id = target_place.id)
     or (relation_row.child_place_id = target_place.id and relation_row.parent_place_id = source_place.id);
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('preservedHierarchySelfLinks', affected);
  delete from public.place_hierarchy_relations relation_row
  where (relation_row.child_place_id = source_place.id and relation_row.parent_place_id = target_place.id)
     or (relation_row.child_place_id = target_place.id and relation_row.parent_place_id = source_place.id);

  insert into public.place_merge_preserved_rows (
    operation_id, project_id, entity_table, original_entity_id,
    preservation_reason, row_data
  )
  select operation_id, source_place.project_id, 'place_relations', relation_row.id,
    'ID substitution would create a generic relation self-link', to_jsonb(relation_row)
  from public.place_relations relation_row
  where (relation_row.place_id = source_place.id and relation_row.related_place_id = target_place.id)
     or (relation_row.place_id = target_place.id and relation_row.related_place_id = source_place.id);
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('preservedGenericSelfLinks', affected);
  delete from public.place_relations relation_row
  where (relation_row.place_id = source_place.id and relation_row.related_place_id = target_place.id)
     or (relation_row.place_id = target_place.id and relation_row.related_place_id = source_place.id);

  insert into public.place_merge_preserved_rows (
    operation_id, project_id, entity_table, original_entity_id,
    preservation_reason, row_data
  )
  select operation_id, source_place.project_id, 'place_parish_relations', relation_row.id,
    'ID substitution would create a parish relation self-link', to_jsonb(relation_row)
  from public.place_parish_relations relation_row
  where (relation_row.place_id = source_place.id and relation_row.parish_place_id = target_place.id)
     or (relation_row.place_id = target_place.id and relation_row.parish_place_id = source_place.id);
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('preservedParishSelfLinks', affected);
  delete from public.place_parish_relations relation_row
  where (relation_row.place_id = source_place.id and relation_row.parish_place_id = target_place.id)
     or (relation_row.place_id = target_place.id and relation_row.parish_place_id = source_place.id);

  update public.place_names set place_id = target_place.id where place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('names', affected);

  update public.place_external_identifiers set place_id = target_place.id where place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('externalIdentifiers', affected);

  update public.place_type_assignments set place_id = target_place.id where place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('typeAssignments', affected);

  update public.place_boundaries set place_id = target_place.id where place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('boundaries', affected);

  update public.person_timeline_events set place_id = target_place.id where place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('personEvents', affected);

  update public.document_place_links set place_id = target_place.id where place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('documentLinks', affected);

  update public.place_archive_relations set place_id = target_place.id where place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('archiveLinks', affected);

  update public.place_hierarchy_relations
  set
    child_place_id = case when child_place_id = source_place.id then target_place.id else child_place_id end,
    parent_place_id = case when parent_place_id = source_place.id then target_place.id else parent_place_id end
  where child_place_id = source_place.id or parent_place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('hierarchyLinks', affected);

  update public.place_relations
  set
    place_id = case when place_id = source_place.id then target_place.id else place_id end,
    related_place_id = case when related_place_id = source_place.id then target_place.id else related_place_id end
  where place_id = source_place.id or related_place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('genericLinks', affected);

  update public.place_parish_relations
  set
    place_id = case when place_id = source_place.id then target_place.id else place_id end,
    parish_place_id = case when parish_place_id = source_place.id then target_place.id else parish_place_id end
  where place_id = source_place.id or parish_place_id = source_place.id;
  get diagnostics affected = row_count;
  transfer_counts_data := transfer_counts_data || jsonb_build_object('parishLinks', affected);

  update public.places target_row
  set metadata = jsonb_set(
    target_row.metadata,
    '{mergedSourcePlaceIds}',
    (case when jsonb_typeof(target_row.metadata -> 'mergedSourcePlaceIds') = 'array'
      then target_row.metadata -> 'mergedSourcePlaceIds' else '[]'::jsonb end)
      || jsonb_build_array(source_place.id),
    true
  )
  where target_row.id = target_place.id;

  update public.places source_row
  set
    status = 'merged',
    is_public = false,
    merged_into_place_id = target_place.id,
    metadata = source_row.metadata || jsonb_build_object(
      'mergeOperationId', operation_id,
      'mergedAt', pg_catalog.now()
    )
  where source_row.id = source_place.id;

  update public.place_merge_operations operation_row
  set
    status = 'completed',
    transfer_counts = transfer_counts_data,
    completed_at = pg_catalog.now()
  where operation_row.id = operation_id;

  return jsonb_build_object(
    'operationId', operation_id,
    'sourcePlaceId', source_place.id,
    'targetPlaceId', target_place.id,
    'sourceRedirectStatus', 'merged',
    'transferCounts', transfer_counts_data,
    'targetLockVersion', (
      select place_row.lock_version from public.places place_row where place_row.id = target_place.id
    )
  );
end;
$function$;

create or replace function public.list_place_boundaries_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_boundaries_v1($1, $2); $wrapper$;

create or replace function public.list_place_related_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_related_v1($1, $2); $wrapper$;

create or replace function public.list_place_parishes_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_parishes_v1($1, $2); $wrapper$;

create or replace function public.list_place_archives_v1(
  p_place_id uuid,
  p_at_date date default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_archives_v1($1, $2); $wrapper$;

create or replace function public.list_place_documents_v1(
  p_place_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_documents_v1($1, $2, $3); $wrapper$;

create or replace function public.list_place_people_v1(
  p_place_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_people_v1($1, $2, $3); $wrapper$;

create or replace function public.list_place_events_v1(
  p_place_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_events_v1($1, $2, $3); $wrapper$;

create or replace function public.merge_places_preview_v1(
  p_source_place_id uuid,
  p_target_place_id uuid
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.merge_places_preview_v1($1, $2); $wrapper$;

create or replace function public.merge_places_v1(
  p_source_place_id uuid,
  p_target_place_id uuid,
  p_expected_source_lock_version integer,
  p_expected_target_lock_version integer,
  p_reason text default ''
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$
  select security_private.merge_places_v1($1, $2, $3, $4, $5);
$wrapper$;

do $grants$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'security_private.list_place_boundaries_v1(uuid,date)',
    'security_private.list_place_related_v1(uuid,date)',
    'security_private.list_place_parishes_v1(uuid,date)',
    'security_private.list_place_archives_v1(uuid,date)',
    'security_private.list_place_documents_v1(uuid,integer,integer)',
    'security_private.list_place_people_v1(uuid,integer,integer)',
    'security_private.list_place_events_v1(uuid,integer,integer)',
    'security_private.merge_places_preview_v1(uuid,uuid)',
    'security_private.merge_places_v1(uuid,uuid,integer,integer,text)',
    'public.list_place_boundaries_v1(uuid,date)',
    'public.list_place_related_v1(uuid,date)',
    'public.list_place_parishes_v1(uuid,date)',
    'public.list_place_archives_v1(uuid,date)',
    'public.list_place_documents_v1(uuid,integer,integer)',
    'public.list_place_people_v1(uuid,integer,integer)',
    'public.list_place_events_v1(uuid,integer,integer)',
    'public.merge_places_preview_v1(uuid,uuid)',
    'public.merge_places_v1(uuid,uuid,integer,integer,text)'
  ] loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_signature
    );
    execute format(
      'grant execute on function %s to authenticated, service_role',
      function_signature
    );
  end loop;
end;
$grants$;

revoke all on function security_private.merge_place_snapshot_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.set_historical_place_relation_scope_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.validate_archive_resource_scope_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.set_place_archive_relation_scope_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.set_document_place_link_scope_v1()
  from public, anon, authenticated, service_role;

do $table_grants$
declare table_name text;
begin
  foreach table_name in array array[
    'place_boundaries', 'place_relations', 'place_parish_relations',
    'archive_resources', 'place_archive_relations', 'document_place_links',
    'place_merge_operations', 'place_merge_preserved_rows'
  ] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
  end loop;
end;
$table_grants$;

grant select, insert, update, delete on public.place_boundaries to authenticated;
grant select, insert, update, delete on public.place_relations to authenticated;
grant select, insert, update, delete on public.place_parish_relations to authenticated;
grant select, insert, update, delete on public.archive_resources to authenticated;
grant select, insert, update, delete on public.place_archive_relations to authenticated;
grant select, insert, update, delete on public.document_place_links to authenticated;
grant select on public.place_merge_operations to authenticated;
grant select on public.place_merge_preserved_rows to authenticated;

revoke all on sequence public.place_merge_preserved_rows_id_seq
  from public, anon, authenticated;
grant all on sequence public.place_merge_preserved_rows_id_seq to service_role;

-- Keep the resumable project-deletion contract complete.  Merge rows are
-- removed before Place rows because both operation FKs deliberately RESTRICT
-- ordinary deletion; all relationship tables precede their Place owners.
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
    'place_merge_preserved_rows',
    'place_merge_operations',
    'document_place_links',
    'place_archive_relations',
    'place_parish_relations',
    'place_relations',
    'place_boundaries',
    'archive_resources',
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

do $coverage$
declare uncovered_tables text[] := private.project_deletion_uncovered_table_names();
begin
  if coalesce(cardinality(uncovered_tables), 0) > 0 then
    raise exception 'PROJECT_DELETION_PHASES_MISSING_TABLES: %',
      array_to_string(uncovered_tables, ', ');
  end if;
end;
$coverage$;

do $audit_triggers$
declare table_name text;
begin
  foreach table_name in array array[
    'place_boundaries', 'place_relations', 'place_parish_relations',
    'archive_resources', 'place_archive_relations', 'document_place_links',
    'place_merge_operations'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_90_audit', table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function security_private.audit_historical_place_entity_v1()',
      table_name || '_90_audit', table_name
    );
  end loop;
end;
$audit_triggers$;

notify pgrst, 'reload schema';

analyze public.place_boundaries;
analyze public.place_relations;
analyze public.place_parish_relations;
analyze public.archive_resources;
analyze public.place_archive_relations;
analyze public.document_place_links;
analyze public.place_merge_operations;
analyze public.place_merge_preserved_rows;

commit;
