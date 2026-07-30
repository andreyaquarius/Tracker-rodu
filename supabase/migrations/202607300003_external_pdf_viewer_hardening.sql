begin;

-- Keep persistence-safe URL rules at the database boundary as well as in the
-- browser. This prevents a direct PostgREST write from storing credentials or
-- short-lived signed URLs in long-lived document metadata.
create or replace function private.external_pdf_query_name_is_sensitive(raw_name text)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  normalized_name text;
begin
  -- Percent-encoded parameter names are rejected fail-closed. Legitimate
  -- source parameters use ordinary ASCII names, while decoding every possible
  -- mixed encoding in SQL would create parser discrepancies with URL().
  if pg_catalog.strpos(raw_name, '%') > 0 then
    return true;
  end if;

  normalized_name := pg_catalog.regexp_replace(
    pg_catalog.lower(raw_name),
    '[^a-z0-9]',
    '',
    'g'
  );

  return normalized_name = any (array[
      'accesstoken',
      'authtoken',
      'authorization',
      'awsaccesskeyid',
      'credential',
      'credentials',
      'googleaccessid',
      'idtoken',
      'key',
      'keypairid',
      'oauth',
      'oauthsignature',
      'password',
      'passwd',
      'privatekey',
      'refreshtoken',
      'resourcekey',
      'secret',
      'secretkey',
      'securitytoken',
      'sessiontoken',
      'signature',
      'signedurl',
      'sig',
      'token'
    ]::text[])
    or normalized_name like 'xamz%'
    or normalized_name like 'xgoog%'
    or pg_catalog.strpos(normalized_name, 'token') > 0
    or pg_catalog.strpos(normalized_name, 'signature') > 0
    or normalized_name ~ '^(api|access|secret|private|resource|signing|developer|subscription)key(id)?$';
end;
$$;

create or replace function private.external_pdf_url_is_persistence_safe(target_url text)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  query_text text;
  query_part text;
  parameter_name text;
begin
  if target_url <> pg_catalog.btrim(target_url)
    or pg_catalog.length(target_url) > 8192
    or target_url !~* '^https://'
    or target_url ~ '[[:cntrl:]]'
    or target_url ~ '#'
    or target_url ~* '^https://[^/?#]*@'
  then
    return false;
  end if;

  query_text := case
    when pg_catalog.strpos(target_url, '?') = 0 then ''
    else pg_catalog.substr(
      target_url,
      pg_catalog.strpos(target_url, '?') + 1
    )
  end;
  if query_text = '' then
    return true;
  end if;

  foreach query_part in array pg_catalog.regexp_split_to_array(query_text, '[&;]')
  loop
    parameter_name := pg_catalog.split_part(query_part, '=', 1);
    if private.external_pdf_query_name_is_sensitive(parameter_name) then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function private.external_pdf_fingerprint_is_persistence_safe(payload jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(payload) = 'object'
    and pg_catalog.pg_column_size(payload) <= 8192
    and not exists (
      select 1
      from pg_catalog.jsonb_each(payload) as entry(key, value)
      where entry.key <> all (array[
        'sha1', 'md5', 'etag', 'revisionId', 'modifiedTime',
        'lastModified', 'contentLength'
      ]::text[])
        or case
          when entry.key = 'contentLength' then
            pg_catalog.jsonb_typeof(entry.value) not in ('number', 'null')
            or (
              pg_catalog.jsonb_typeof(entry.value) = 'number'
              and (
                (entry.value #>> '{}')::numeric < 0
                or (entry.value #>> '{}')::numeric > 9007199254740991
              )
            )
          else
            pg_catalog.jsonb_typeof(entry.value) not in ('string', 'null')
            or pg_catalog.length(entry.value #>> '{}') > 1024
        end
    );
$$;

create or replace function private.external_pdf_validation_metadata_is_persistence_safe(payload jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(payload) = 'object'
    and pg_catalog.pg_column_size(payload) <= 1024
    and not exists (
      select 1
      from pg_catalog.jsonb_each(payload) as entry(key, value)
      where entry.key <> 'requiresUrlRemediation'
        or pg_catalog.jsonb_typeof(entry.value) <> 'boolean'
    );
$$;

-- Existing rows are scrubbed without copying unsafe values into an audit
-- table. A remediation marker records which row/columns need user review.
create table if not exists private.external_pdf_url_remediation_queue (
  table_name text not null,
  row_id uuid not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  unsafe_columns text[] not null,
  detected_at timestamptz not null default now(),
  primary key (table_name, row_id)
);

revoke all on private.external_pdf_url_remediation_queue
  from public, anon, authenticated;

-- The queue represents unresolved remediation work, not an append-only audit.
-- A rerun must not re-invalidate a source or remove a replacement snapshot that
-- an editor has already repaired since the previous migration attempt.
delete from private.external_pdf_url_remediation_queue as queue
where queue.table_name = 'document_sources'
  and not exists (
    select 1
    from public.document_sources as source
    where source.id = queue.row_id
      and (
        not private.external_pdf_url_is_persistence_safe(source.original_url)
        or (
          source.canonical_url is not null
          and not private.external_pdf_url_is_persistence_safe(source.canonical_url)
        )
        or (
          source.source_page_url is not null
          and not private.external_pdf_url_is_persistence_safe(source.source_page_url)
        )
        or (
          source.status = 'invalid'
          and coalesce(
            source.validation_metadata ->> 'requiresUrlRemediation',
            'false'
          ) = 'true'
        )
      )
  );

delete from private.external_pdf_url_remediation_queue as queue
where queue.table_name = 'finding_document_references'
  and not exists (
    select 1
    from public.finding_document_references as reference
    where reference.id = queue.row_id
      and (
        reference.snapshot_url is null
        or not private.external_pdf_url_is_persistence_safe(reference.snapshot_url)
      )
  );

create or replace function private.scrub_external_pdf_persistence_url(target_url text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  cleaned_url text;
  base_url text;
  query_text text;
  query_part text;
  parameter_name text;
  normalized_name text;
  kept_parts text[] := array[]::text[];
  signed_url boolean := false;
  companion_names constant text[] := array[
    'algorithm', 'credential', 'date', 'expires', 'keypairid', 'policy',
    'signedheaders', 'se', 'sip', 'sp', 'spr', 'sr', 'st', 'sv'
  ]::text[];
begin
  cleaned_url := pg_catalog.btrim(target_url);
  cleaned_url := pg_catalog.split_part(cleaned_url, '#', 1);
  cleaned_url := pg_catalog.regexp_replace(
    cleaned_url,
    '^(https://)[^/?#]*@',
    E'\\1',
    'i'
  );
  base_url := pg_catalog.split_part(cleaned_url, '?', 1);
  query_text := case
    when pg_catalog.strpos(cleaned_url, '?') = 0 then ''
    else pg_catalog.substr(
      cleaned_url,
      pg_catalog.strpos(cleaned_url, '?') + 1
    )
  end;

  if query_text <> '' then
    foreach query_part in array pg_catalog.regexp_split_to_array(query_text, '[&;]')
    loop
      parameter_name := pg_catalog.split_part(query_part, '=', 1);
      normalized_name := pg_catalog.regexp_replace(
        pg_catalog.lower(parameter_name),
        '[^a-z0-9]',
        '',
        'g'
      );
      if normalized_name like 'xamz%'
        or normalized_name like 'xgoog%'
        or normalized_name = any (array[
          'awsaccesskeyid', 'googleaccessid', 'signature', 'oauthsignature', 'sig'
        ]::text[])
      then
        signed_url := true;
        exit;
      end if;
    end loop;

    foreach query_part in array pg_catalog.regexp_split_to_array(query_text, '[&;]')
    loop
      parameter_name := pg_catalog.split_part(query_part, '=', 1);
      normalized_name := pg_catalog.regexp_replace(
        pg_catalog.lower(parameter_name),
        '[^a-z0-9]',
        '',
        'g'
      );
      if private.external_pdf_query_name_is_sensitive(parameter_name)
        or (signed_url and normalized_name = any (companion_names))
      then
        continue;
      end if;
      kept_parts := pg_catalog.array_append(kept_parts, query_part);
    end loop;
  end if;

  cleaned_url := base_url;
  if coalesce(pg_catalog.array_length(kept_parts, 1), 0) > 0 then
    cleaned_url := cleaned_url || '?' || pg_catalog.array_to_string(kept_parts, '&');
  end if;

  if private.external_pdf_url_is_persistence_safe(cleaned_url) then
    return cleaned_url;
  end if;
  return null;
end;
$$;

insert into private.external_pdf_url_remediation_queue (
  table_name,
  row_id,
  project_id,
  unsafe_columns
)
select
  'document_sources',
  source.id,
  source.project_id,
  pg_catalog.array_remove(array[
    case when not private.external_pdf_url_is_persistence_safe(source.original_url)
      then 'original_url' end,
    case when source.canonical_url is not null
      and not private.external_pdf_url_is_persistence_safe(source.canonical_url)
      then 'canonical_url' end,
    case when source.source_page_url is not null
      and not private.external_pdf_url_is_persistence_safe(source.source_page_url)
      then 'source_page_url' end
  ]::text[], null)
from public.document_sources as source
where not private.external_pdf_url_is_persistence_safe(source.original_url)
  or (
    source.canonical_url is not null
    and not private.external_pdf_url_is_persistence_safe(source.canonical_url)
  )
  or (
    source.source_page_url is not null
    and not private.external_pdf_url_is_persistence_safe(source.source_page_url)
  )
on conflict (table_name, row_id) do update
set
  unsafe_columns = excluded.unsafe_columns,
  detected_at = excluded.detected_at;

update public.document_sources as source
set
  original_url = case
    when private.external_pdf_url_is_persistence_safe(source.original_url)
      then source.original_url
    else coalesce(
      private.scrub_external_pdf_persistence_url(source.original_url),
      'https://invalid.invalid/removed/' || source.id::text
    )
  end,
  canonical_url = case
    when source.canonical_url is null
      or private.external_pdf_url_is_persistence_safe(source.canonical_url)
      then source.canonical_url
    else private.scrub_external_pdf_persistence_url(source.canonical_url)
  end,
  source_page_url = case
    when source.source_page_url is null
      or private.external_pdf_url_is_persistence_safe(source.source_page_url)
      then source.source_page_url
    else private.scrub_external_pdf_persistence_url(source.source_page_url)
  end,
  status = 'invalid',
  validation_error_code = 'SENSITIVE_URL_NOT_PERSISTABLE',
  validation_metadata = coalesce(source.validation_metadata, '{}'::jsonb)
    || pg_catalog.jsonb_build_object('requiresUrlRemediation', true)
where exists (
  select 1
  from private.external_pdf_url_remediation_queue as queue
  where queue.table_name = 'document_sources'
    and queue.row_id = source.id
)
  and (
    not private.external_pdf_url_is_persistence_safe(source.original_url)
    or (
      source.canonical_url is not null
      and not private.external_pdf_url_is_persistence_safe(source.canonical_url)
    )
    or (
      source.source_page_url is not null
      and not private.external_pdf_url_is_persistence_safe(source.source_page_url)
    )
  );

insert into private.external_pdf_url_remediation_queue (
  table_name,
  row_id,
  project_id,
  unsafe_columns
)
select
  'finding_document_references',
  reference.id,
  reference.project_id,
  array['snapshot_url']::text[]
from public.finding_document_references as reference
where reference.snapshot_url is not null
  and not private.external_pdf_url_is_persistence_safe(reference.snapshot_url)
on conflict (table_name, row_id) do update
set
  unsafe_columns = excluded.unsafe_columns,
  detected_at = excluded.detected_at;

-- An unsafe derivative link is removed, while the page/crop provenance remains
-- intact and can be re-exported by the user later.
update public.finding_document_references as reference
set
  snapshot_provider = null,
  snapshot_file_id = null,
  snapshot_url = null,
  snapshot_mime_type = null
where exists (
  select 1
  from private.external_pdf_url_remediation_queue as queue
  where queue.table_name = 'finding_document_references'
    and queue.row_id = reference.id
)
  and reference.snapshot_url is not null
  and not private.external_pdf_url_is_persistence_safe(reference.snapshot_url);

-- Recreate named guards instead of trusting a pre-existing object with the
-- same name but a weaker definition (possible after manual schema changes).
alter table public.document_sources
  drop constraint if exists document_sources_persistence_safe_urls_check;
alter table public.document_sources
  add constraint document_sources_persistence_safe_urls_check
  check (
    private.external_pdf_url_is_persistence_safe(original_url)
    and (
      canonical_url is null
      or private.external_pdf_url_is_persistence_safe(canonical_url)
    )
    and (
      source_page_url is null
      or private.external_pdf_url_is_persistence_safe(source_page_url)
    )
  ) not valid;

alter table public.document_sources
  validate constraint document_sources_persistence_safe_urls_check;

alter table public.finding_document_references
  drop constraint if exists finding_document_references_persistence_safe_snapshot_check;
alter table public.finding_document_references
  add constraint finding_document_references_persistence_safe_snapshot_check
  check (
    snapshot_url is null
    or private.external_pdf_url_is_persistence_safe(snapshot_url)
  ) not valid;

alter table public.finding_document_references
  validate constraint finding_document_references_persistence_safe_snapshot_check;

-- Fingerprints have a deliberately small provider-neutral schema. Arbitrary
-- JSON is not needed here and could otherwise become a long-lived hiding place
-- for OAuth material or signed URLs through direct PostgREST writes.
update public.document_sources
set fingerprint = '{}'::jsonb
where not private.external_pdf_fingerprint_is_persistence_safe(fingerprint);

update public.finding_document_references
set source_fingerprint = '{}'::jsonb
where not private.external_pdf_fingerprint_is_persistence_safe(source_fingerprint);

update public.document_sources
set validation_metadata = case
  when pg_catalog.jsonb_typeof(validation_metadata -> 'requiresUrlRemediation') = 'boolean'
    then pg_catalog.jsonb_build_object(
      'requiresUrlRemediation',
      validation_metadata -> 'requiresUrlRemediation'
    )
  else '{}'::jsonb
end
where not private.external_pdf_validation_metadata_is_persistence_safe(validation_metadata);

alter table public.document_sources
  drop constraint if exists document_sources_safe_metadata_check;
alter table public.document_sources
  add constraint document_sources_safe_metadata_check
  check (
    private.external_pdf_fingerprint_is_persistence_safe(fingerprint)
    and private.external_pdf_validation_metadata_is_persistence_safe(validation_metadata)
  ) not valid;
alter table public.document_sources
  validate constraint document_sources_safe_metadata_check;

alter table public.finding_document_references
  drop constraint if exists finding_document_references_safe_fingerprint_check;
alter table public.finding_document_references
  add constraint finding_document_references_safe_fingerprint_check
  check (
    private.external_pdf_fingerprint_is_persistence_safe(source_fingerprint)
  ) not valid;
alter table public.finding_document_references
  validate constraint finding_document_references_safe_fingerprint_check;

-- A generated, bounded SHA-256 key gives every provider source a stable natural
-- identity without placing an arbitrarily long URL in a btree index.
create or replace function private.document_source_identity_key(
  source_provider text,
  source_provider_file_id text,
  source_canonical_url text,
  source_original_url text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.lower(pg_catalog.btrim(source_provider)) || pg_catalog.chr(31)
        || case
          when nullif(pg_catalog.btrim(source_provider_file_id), '') is not null
            then 'file' || pg_catalog.chr(31) || pg_catalog.btrim(source_provider_file_id)
          else 'url' || pg_catalog.chr(31)
            || pg_catalog.btrim(coalesce(source_canonical_url, source_original_url))
        end,
        'UTF8'
      )
    ),
    'hex'
  );
$$;

alter table public.document_sources
  add column if not exists source_identity_key text
  generated always as (
    private.document_source_identity_key(
      provider,
      provider_file_id,
      canonical_url,
      original_url
    )
  ) stored;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    join pg_catalog.pg_attrdef as default_expression
      on default_expression.adrelid = attribute.attrelid
      and default_expression.adnum = attribute.attnum
    where attribute.attrelid = 'public.document_sources'::regclass
      and attribute.attname = 'source_identity_key'
      and attribute.attgenerated = 's'
      and pg_catalog.pg_get_expr(
        default_expression.adbin,
        default_expression.adrelid
      ) like '%document_source_identity_key%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'DOCUMENT_SOURCE_IDENTITY_COLUMN_DEFINITION_MISMATCH';
  end if;
end;
$$;

alter table public.document_sources
  alter column source_identity_key set not null;

-- Keep a recovery record for every merged source and all of its finding
-- references. URL fields are deliberately omitted so the audit cannot retain a
-- credential removed above.
create table if not exists private.document_source_merge_audit (
  duplicate_source_id uuid primary key,
  survivor_source_id uuid not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_identity_key text not null,
  source_snapshot jsonb not null,
  reference_snapshots jsonb not null default '[]'::jsonb,
  merged_at timestamptz not null default now()
);

revoke all on private.document_source_merge_audit
  from public, anon, authenticated;

create index if not exists document_source_merge_audit_project_idx
  on private.document_source_merge_audit (project_id, merged_at desc);

create table if not exists private.document_source_reference_merge_audit (
  reference_id uuid primary key,
  survivor_source_id uuid not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  reference_snapshot jsonb not null,
  merged_at timestamptz not null default now()
);

revoke all on private.document_source_reference_merge_audit
  from public, anon, authenticated;

create index if not exists document_source_reference_merge_audit_project_idx
  on private.document_source_reference_merge_audit (project_id, merged_at desc);

create temporary table external_pdf_source_merge_map
on commit drop
as
with ranked as (
  select
    source.id as source_id,
    source.project_id,
    source.document_id,
    source.source_identity_key,
    pg_catalog.first_value(source.id) over identity_group as survivor_source_id,
    pg_catalog.count(*) over (
      partition by source.project_id, source.document_id, source.source_identity_key
    ) as identity_count
  from public.document_sources as source
  window identity_group as (
    partition by source.project_id, source.document_id, source.source_identity_key
    order by
      case source.status
        when 'active' then 0
        when 'needs_auth' then 1
        when 'changed' then 2
        when 'unavailable' then 3
        else 4
      end,
      source.created_at,
      source.id
  )
)
select
  source_id,
  survivor_source_id,
  project_id,
  document_id,
  source_identity_key
from ranked
where identity_count > 1;

create unique index external_pdf_source_merge_map_source_idx
  on external_pdf_source_merge_map (source_id);

insert into private.document_source_merge_audit (
  duplicate_source_id,
  survivor_source_id,
  project_id,
  source_identity_key,
  source_snapshot,
  reference_snapshots
)
select
  duplicate.id,
  merge_map.survivor_source_id,
  duplicate.project_id,
  duplicate.source_identity_key,
  pg_catalog.to_jsonb(duplicate)
    - 'original_url'
    - 'canonical_url'
    - 'source_page_url',
  coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(reference) - 'snapshot_url'
      order by reference.created_at, reference.id
    )
    from public.finding_document_references as reference
    where reference.document_source_id = duplicate.id
  ), '[]'::jsonb)
from external_pdf_source_merge_map as merge_map
join public.document_sources as duplicate
  on duplicate.id = merge_map.source_id
where merge_map.source_id <> merge_map.survivor_source_id
on conflict (duplicate_source_id) do nothing;

-- Preserve useful metadata that exists only on a duplicate before removing it.
-- The survivor's existing values always win; the best duplicate only fills
-- missing fields, while non-secret JSON metadata is merged conservatively.
with best_duplicate as (
  select distinct on (merge_map.survivor_source_id)
    merge_map.survivor_source_id,
    candidate.source_page_url,
    candidate.provider_host,
    candidate.provider_file_id,
    candidate.provider_file_title,
    candidate.display_name,
    candidate.file_size_bytes,
    candidate.page_count,
    candidate.initial_page,
    candidate.fingerprint,
    candidate.last_validated_at,
    candidate.validation_error_code,
    candidate.validation_metadata
  from external_pdf_source_merge_map as merge_map
  join public.document_sources as candidate
    on candidate.id = merge_map.source_id
  where merge_map.source_id <> merge_map.survivor_source_id
  order by
    merge_map.survivor_source_id,
    (
      (candidate.source_page_url is not null)::integer
      + (candidate.provider_host is not null)::integer
      + (candidate.provider_file_id is not null)::integer
      + (candidate.provider_file_title is not null)::integer
      + (candidate.display_name is not null)::integer
      + (candidate.file_size_bytes is not null)::integer
      + (candidate.page_count is not null)::integer
      + (candidate.initial_page is not null)::integer
      + (candidate.fingerprint <> '{}'::jsonb)::integer
    ) desc,
    candidate.last_validated_at desc nulls last,
    candidate.updated_at desc,
    candidate.id
)
update public.document_sources as survivor
set
  source_page_url = coalesce(survivor.source_page_url, best.source_page_url),
  provider_host = coalesce(survivor.provider_host, best.provider_host),
  provider_file_id = coalesce(survivor.provider_file_id, best.provider_file_id),
  provider_file_title = coalesce(
    survivor.provider_file_title,
    best.provider_file_title
  ),
  display_name = coalesce(survivor.display_name, best.display_name),
  file_size_bytes = coalesce(survivor.file_size_bytes, best.file_size_bytes),
  page_count = case
    when survivor.page_count is not null then survivor.page_count
    when best.page_count is null then null
    when survivor.initial_page is null
      or survivor.initial_page <= best.page_count then best.page_count
    else null
  end,
  initial_page = case
    when survivor.initial_page is not null then survivor.initial_page
    when best.initial_page is null then null
    when coalesce(survivor.page_count, best.page_count) is null
      or best.initial_page <= coalesce(survivor.page_count, best.page_count)
      then best.initial_page
    else null
  end,
  fingerprint = case
    when survivor.fingerprint = '{}'::jsonb then best.fingerprint
    else survivor.fingerprint
  end,
  last_validated_at = case
    when survivor.last_validated_at is null then best.last_validated_at
    when best.last_validated_at is null then survivor.last_validated_at
    else greatest(survivor.last_validated_at, best.last_validated_at)
  end,
  validation_error_code = coalesce(
    survivor.validation_error_code,
    best.validation_error_code
  ),
  validation_metadata = coalesce(best.validation_metadata, '{}'::jsonb)
    || survivor.validation_metadata
from best_duplicate as best
where survivor.id = best.survivor_source_id;

-- Merging source IDs can make two retry-safe references identical. Preserve
-- the richest/newest one and keep every removed row in the private audit above.
create temporary table external_pdf_reference_merge_rank
on commit drop
as
select
  reference.id,
  reference.project_id,
  merge_map.survivor_source_id,
  pg_catalog.row_number() over (
    partition by
      reference.project_id,
      reference.finding_id,
      merge_map.survivor_source_id,
      reference.page_index
    order by
      (reference.snapshot_provider is not null) desc,
      (reference.selection is not null) desc,
      reference.updated_at desc,
      reference.id
  ) as merge_rank
from public.finding_document_references as reference
join external_pdf_source_merge_map as merge_map
  on merge_map.source_id = reference.document_source_id;

-- Record every reference that will actually be removed, including a reference
-- that was originally attached to the survivor but loses to a richer duplicate.
-- URL-bearing snapshot metadata is deliberately excluded.
insert into private.document_source_reference_merge_audit (
  reference_id,
  survivor_source_id,
  project_id,
  reference_snapshot
)
select
  reference.id,
  ranked.survivor_source_id,
  ranked.project_id,
  pg_catalog.to_jsonb(reference) - 'snapshot_url'
from external_pdf_reference_merge_rank as ranked
join public.finding_document_references as reference
  on reference.id = ranked.id
where ranked.merge_rank > 1
on conflict (reference_id) do nothing;

delete from public.finding_document_references as reference
using external_pdf_reference_merge_rank as ranked
where ranked.id = reference.id
  and ranked.merge_rank > 1;

update public.finding_document_references as reference
set document_source_id = merge_map.survivor_source_id
from external_pdf_source_merge_map as merge_map
where merge_map.source_id = reference.document_source_id
  and merge_map.source_id <> merge_map.survivor_source_id;

delete from public.document_sources as source
using external_pdf_source_merge_map as merge_map
where source.id = merge_map.source_id
  and merge_map.source_id <> merge_map.survivor_source_id;

create unique index if not exists document_sources_natural_identity_unique
  on public.document_sources (
    project_id,
    document_id,
    source_identity_key
  );

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_index as source_index
    where source_index.indexrelid =
      'public.document_sources_natural_identity_unique'::regclass
      and source_index.indisunique
      and source_index.indisvalid
      and pg_catalog.pg_get_indexdef(source_index.indexrelid)
        like '%(project_id, document_id, source_identity_key)%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'DOCUMENT_SOURCE_IDENTITY_INDEX_DEFINITION_MISMATCH';
  end if;
end;
$$;

-- created_by is owned by the authenticated insert, never by client-supplied
-- metadata. Service-role/admin migrations may insert on behalf of a real
-- profile, but no role may rewrite authorship after creation.
create or replace function private.enforce_external_pdf_created_by()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  request_user_id uuid := auth.uid();
  service_context boolean := current_user = any (
    array['postgres', 'service_role', 'supabase_admin']::name[]
  ) or coalesce(auth.role(), '') = 'service_role';
begin
  if tg_op = 'UPDATE' then
    if new.created_by is distinct from old.created_by then
      raise exception using
        errcode = '22023',
        message = 'CREATED_BY_IMMUTABLE';
    end if;
    return new;
  end if;

  if not service_context and (
    request_user_id is null
    or new.created_by is distinct from request_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'CREATED_BY_MUST_MATCH_AUTH_USER';
  end if;
  return new;
end;
$$;

drop trigger if exists document_sources_enforce_created_by
  on public.document_sources;
create trigger document_sources_enforce_created_by
before insert or update of created_by on public.document_sources
for each row execute function private.enforce_external_pdf_created_by();

drop trigger if exists finding_document_references_enforce_created_by
  on public.finding_document_references;
create trigger finding_document_references_enforce_created_by
before insert or update of created_by on public.finding_document_references
for each row execute function private.enforce_external_pdf_created_by();

drop policy if exists document_sources_insert_editors
  on public.document_sources;
create policy document_sources_insert_editors
on public.document_sources for insert to authenticated
with check (
  (select public.can_edit_project(project_id))
  and created_by = (select auth.uid())
);

drop policy if exists finding_document_references_insert_editors
  on public.finding_document_references;
create policy finding_document_references_insert_editors
on public.finding_document_references for insert to authenticated
with check (
  (select public.can_edit_project(project_id))
  and created_by = (select auth.uid())
);

-- A metadata probe performs outbound DNS and HTTP work. Keep one atomic,
-- durable rate bucket per user/project so parallel Edge instances cannot bypass
-- the resource limit. The table is private and contains no URL or document
-- metadata.
create table if not exists private.external_pdf_probe_rate_limits (
  user_id uuid not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

revoke all on private.external_pdf_probe_rate_limits
  from public, anon, authenticated;

create or replace function public.reserve_external_pdf_probe(
  target_user_id uuid,
  target_project_id uuid,
  target_max_requests integer,
  target_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  now_value timestamptz := pg_catalog.clock_timestamp();
  window_length interval;
  resulting_count integer;
begin
  if target_user_id is null or target_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'PDF_PROBE_SCOPE_INVALID';
  end if;
  if target_max_requests is null
    or target_max_requests < 1
    or target_max_requests > 1000
    or target_window_seconds is null
    or target_window_seconds < 10
    or target_window_seconds > 3600
  then
    raise exception using
      errcode = '22023',
      message = 'PDF_PROBE_LIMIT_INVALID';
  end if;

  window_length := target_window_seconds * interval '1 second';

  insert into private.external_pdf_probe_rate_limits as bucket (
    user_id,
    project_id,
    window_started_at,
    request_count,
    updated_at
  ) values (
    target_user_id,
    target_project_id,
    now_value,
    1,
    now_value
  )
  on conflict (user_id, project_id) do update
  set
    window_started_at = case
      when bucket.window_started_at <= now_value - window_length then now_value
      else bucket.window_started_at
    end,
    request_count = case
      when bucket.window_started_at <= now_value - window_length then 1
      when bucket.request_count >= 2147483647 then 2147483647
      else bucket.request_count + 1
    end,
    updated_at = now_value
  returning request_count into resulting_count;

  return resulting_count <= target_max_requests;
end;
$$;

comment on function public.reserve_external_pdf_probe(uuid, uuid, integer, integer)
is 'Atomically reserves one bounded outbound PDF metadata probe for a user/project window.';

revoke all on function public.reserve_external_pdf_probe(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_external_pdf_probe(uuid, uuid, integer, integer)
  to service_role;

-- Session creation and the active-session bound live in one database
-- transaction. The per-user/project advisory lock prevents concurrent browser
-- tabs from racing past the cap.
create index if not exists pdf_access_sessions_user_project_expiry_idx
  on public.pdf_access_sessions (user_id, project_id, expires_at, created_at);

create or replace function public.create_pdf_access_session(
  target_token_hash text,
  target_project_id uuid,
  target_document_id uuid,
  target_document_source_id uuid,
  target_user_id uuid,
  target_provider text,
  target_upstream_host text,
  target_source_fingerprint jsonb,
  target_max_requests integer,
  target_expires_at timestamptz,
  target_max_active_sessions integer
)
returns setof public.pdf_access_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_session_count integer;
begin
  if target_max_active_sessions is null
    or target_max_active_sessions < 1
    or target_max_active_sessions > 64
  then
    raise exception using
      errcode = '22023',
      message = 'PDF_ACTIVE_SESSION_CAP_INVALID';
  end if;
  if target_expires_at <= pg_catalog.now() then
    raise exception using
      errcode = '22023',
      message = 'PDF_ACCESS_SESSION_EXPIRY_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      target_user_id::text || ':' || target_project_id::text,
      0
    )
  );

  delete from public.pdf_access_sessions as session
  where session.user_id = target_user_id
    and session.project_id = target_project_id
    and (
      session.expires_at <= pg_catalog.now()
      or session.request_count >= session.max_requests
    );

  select pg_catalog.count(*)::integer
  into active_session_count
  from public.pdf_access_sessions as session
  where session.user_id = target_user_id
    and session.project_id = target_project_id
    and session.expires_at > pg_catalog.now()
    and session.request_count < session.max_requests;

  if active_session_count >= target_max_active_sessions then
    raise exception using
      errcode = 'P0001',
      message = 'PDF_ACTIVE_SESSION_LIMIT';
  end if;

  return query
  insert into public.pdf_access_sessions as session (
    token_hash,
    project_id,
    document_id,
    document_source_id,
    user_id,
    provider,
    upstream_host,
    source_fingerprint,
    max_requests,
    expires_at
  ) values (
    target_token_hash,
    target_project_id,
    target_document_id,
    target_document_source_id,
    target_user_id,
    target_provider,
    target_upstream_host,
    coalesce(target_source_fingerprint, '{}'::jsonb),
    target_max_requests,
    target_expires_at
  )
  returning session.*;
end;
$$;

comment on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer
) is
  'Atomically creates a short-lived PDF session under a bounded per-user/project active-session cap.';

revoke all on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer
) to service_role;

revoke execute on function private.external_pdf_query_name_is_sensitive(text)
  from public, anon, authenticated;
revoke execute on function private.external_pdf_url_is_persistence_safe(text)
  from public, anon, authenticated;
revoke execute on function private.external_pdf_fingerprint_is_persistence_safe(jsonb)
  from public, anon, authenticated;
revoke execute on function private.external_pdf_validation_metadata_is_persistence_safe(jsonb)
  from public, anon, authenticated;
revoke execute on function private.scrub_external_pdf_persistence_url(text)
  from public, anon, authenticated;
revoke execute on function private.document_source_identity_key(text, text, text, text)
  from public, anon, authenticated;
revoke execute on function private.enforce_external_pdf_created_by()
  from public, anon, authenticated;

-- PostgreSQL checks EXECUTE on functions used by stored generated columns and
-- CHECK expressions at write time. Grant only the pure validators/identity
-- helper needed by authenticated table writes. The private schema remains
-- outside the exposed API schemas and retains its existing restricted USAGE.
grant execute on function private.external_pdf_query_name_is_sensitive(text)
  to authenticated, service_role;
grant execute on function private.external_pdf_url_is_persistence_safe(text)
  to authenticated, service_role;
grant execute on function private.external_pdf_fingerprint_is_persistence_safe(jsonb)
  to authenticated, service_role;
grant execute on function private.external_pdf_validation_metadata_is_persistence_safe(jsonb)
  to authenticated, service_role;
grant execute on function private.document_source_identity_key(text, text, text, text)
  to authenticated, service_role;

commit;
