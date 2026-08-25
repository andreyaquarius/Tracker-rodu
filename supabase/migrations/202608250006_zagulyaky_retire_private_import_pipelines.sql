begin;

-- The initial catalogue has been materialised.  Retire the one-off Facebook
-- and XLSX staging pipelines without touching the resulting catalogue cards.
--
-- One small piece of provenance must survive: a record can have a private
-- original Facebook-post URL which is later made public only after the usual
-- record/privacy/source gates.  Move that durable fact out of the tabular
-- import ledger before deleting the ledger itself.
create table if not exists public.zagulyaky_record_origins (
  record_id uuid primary key references public.zagulyaky_records(id) on delete cascade,
  origin_kind text not null default 'social_post'
    check (origin_kind in ('social_post')),
  source_platform text not null default 'facebook'
    check (char_length(source_platform) between 1 and 80),
  original_post_url_private text not null
    check (
      char_length(original_post_url_private) between 1 and 4000
      and original_post_url_private ~* '^https?://'
      and security_private.zagulyaky_is_facebook_post_url_v1(original_post_url_private)
    ),
  public_link_status text not null default 'private'
    check (public_link_status in ('private', 'approved', 'revoked')),
  source_id uuid unique references public.zagulyaky_sources(id) on delete set null,
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zagulyaky_record_origins_public_status_idx
  on public.zagulyaky_record_origins(public_link_status, reviewed_at desc);

alter table public.zagulyaky_record_origins enable row level security;
revoke all on table public.zagulyaky_record_origins from public, anon, authenticated;
grant all on table public.zagulyaky_record_origins to service_role;

insert into public.zagulyaky_record_origins (
  record_id,
  origin_kind,
  source_platform,
  original_post_url_private,
  public_link_status,
  source_id,
  reviewed_by,
  reviewed_at,
  created_at,
  updated_at
)
select
  legacy.record_id,
  'social_post',
  'facebook',
  legacy.facebook_post_url_private,
  legacy.public_link_status,
  legacy.source_id,
  legacy.reviewed_by,
  legacy.reviewed_at,
  legacy.created_at,
  legacy.updated_at
from public.zagulyaky_tabular_import_record_origins as legacy
on conflict (record_id) do update
set origin_kind = excluded.origin_kind,
    source_platform = excluded.source_platform,
    original_post_url_private = excluded.original_post_url_private,
    public_link_status = excluded.public_link_status,
    source_id = excluded.source_id,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

-- A failed transfer must leave all staging data intact.  This explicit check
-- is intentionally before any DROP statement.
do $verify_origin_transfer$
begin
  if exists (
    select 1
    from public.zagulyaky_tabular_import_record_origins as legacy
    left join public.zagulyaky_record_origins as retained
      on retained.record_id = legacy.record_id
    where retained.record_id is null
      or retained.original_post_url_private is distinct from legacy.facebook_post_url_private
      or retained.public_link_status is distinct from legacy.public_link_status
      or retained.source_id is distinct from legacy.source_id
  ) then
    raise exception 'ZAGULYAKY_ORIGIN_TRANSFER_INCOMPLETE';
  end if;
end;
$verify_origin_transfer$;

-- The normal approval action already created this relationship.  Reassert it
-- defensively before the old ledger goes away so a historical partial run
-- cannot orphan an otherwise valid original-link source.
insert into public.zagulyaky_record_sources(record_id, source_id, is_primary)
select origin_row.record_id, origin_row.source_id, false
from public.zagulyaky_record_origins as origin_row
where origin_row.source_id is not null
on conflict (record_id, source_id) do nothing;

-- The source rows that have already been explicitly approved remain linked to
-- their catalogue records.  Remove only an implementation marker that would
-- otherwise expose the retired pipeline in ordinary source metadata.
update public.zagulyaky_sources as source_row
set metadata = (source_row.metadata - 'tabularImport')
  || jsonb_build_object('originKind', 'facebook_post', 'legacyInitialBase', true)
from public.zagulyaky_record_origins as origin_row
where origin_row.source_id = source_row.id
  and source_row.metadata ? 'tabularImport';

-- Keep the public-card contract (`originalPostUrl`) unchanged.  The helper
-- still returns nothing unless the record is published/cleared and a
-- moderator previously approved the matching link-only Facebook source.
create or replace function security_private.zagulyaky_public_facebook_origin_v1(
  p_record_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select jsonb_build_object('originalPostUrl', origin_row.original_post_url_private)
  from public.zagulyaky_record_origins as origin_row
  join public.zagulyaky_records as record_row
    on record_row.id = origin_row.record_id
  join public.zagulyaky_sources as source_row
    on source_row.id = origin_row.source_id
  join public.zagulyaky_record_sources as record_source
    on record_source.record_id = record_row.id
    and record_source.source_id = source_row.id
  where origin_row.record_id = p_record_id
    and origin_row.origin_kind = 'social_post'
    and lower(origin_row.source_platform) = 'facebook'
    and origin_row.public_link_status = 'approved'
    and record_row.status = 'published'
    and record_row.privacy_status = 'cleared'
    and source_row.source_type = 'social_post'
    and lower(coalesce(source_row.source_platform, '')) = 'facebook'
    and source_row.source_url = origin_row.original_post_url_private
    and security_private.zagulyaky_is_facebook_post_url_v1(origin_row.original_post_url_private)
    and source_row.permission_status in ('link_only', 'permission_granted', 'public_domain')
  limit 1
$function$;

-- The ordinary moderation review remains available.  It now exposes only the
-- retained moderator-only original link, never the removed workbook/Facebook
-- raw text or batch identifiers.  Keep the JSON key for an in-flight browser
-- client while the UI labels it as a normal private source.
create or replace function security_private.admin_get_zagulyaka_review_bundle_v1(
  p_record_id uuid,
  p_version_limit integer default 40,
  p_action_limit integer default 80
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
  safe_version_limit integer := least(greatest(coalesce(p_version_limit, 40), 1), 100);
  safe_action_limit integer := least(greatest(coalesce(p_action_limit, 80), 1), 200);
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  if not exists (select 1 from public.zagulyaky_records where id = p_record_id) then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'record', to_jsonb(record_row) - 'search_vector',
    'sources', coalesce((
      select jsonb_agg((to_jsonb(source_row) - 'created_by') || jsonb_build_object('isPrimary', record_source.is_primary)
        order by record_source.is_primary desc, source_row.created_at, source_row.id)
      from public.zagulyaky_record_sources as record_source
      join public.zagulyaky_sources as source_row on source_row.id = record_source.source_id
      where record_source.record_id = record_row.id
    ), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(to_jsonb(participant_row) order by participant_row.sort_order, participant_row.id)
      from public.zagulyaky_participants as participant_row
      where participant_row.record_id = record_row.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(to_jsonb(discovery_row) order by discovery_row.id)
      from public.zagulyaky_document_discoveries as discovery_row
      where discovery_row.record_id = record_row.id
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(to_jsonb(attachment_row) - 'created_by' order by attachment_row.created_at, attachment_row.id)
      from public.zagulyaky_attachments as attachment_row
      where attachment_row.record_id = record_row.id
    ), '[]'::jsonb),
    'versions', coalesce((
      select jsonb_agg(to_jsonb(version_row) order by version_row.revision_no desc)
      from (
        select version_row.id, version_row.revision_no, version_row.snapshot,
          version_row.actor_id, version_row.created_at
        from public.zagulyaky_record_versions as version_row
        where version_row.record_id = record_row.id
        order by version_row.revision_no desc
        limit safe_version_limit
      ) as version_row
    ), '[]'::jsonb),
    'moderationActions', coalesce((
      select jsonb_agg(to_jsonb(action_row) order by action_row.created_at desc, action_row.id desc)
      from (
        select action_row.id, action_row.action, action_row.from_status, action_row.to_status,
          action_row.note, action_row.metadata, action_row.created_at
        from public.zagulyaky_moderation_actions as action_row
        where action_row.record_id = record_row.id
        order by action_row.created_at desc, action_row.id desc
        limit safe_action_limit
      ) as action_row
    ), '[]'::jsonb),
    'adminAudit', coalesce((
      select jsonb_agg(to_jsonb(audit_row) order by audit_row.created_at desc, audit_row.id desc)
      from (
        select audit_row.id, audit_row.action_code, audit_row.target_type, audit_row.target_id,
          audit_row.outcome, audit_row.sanitized_diff, audit_row.created_at
        from public.admin_audit_log as audit_row
        where audit_row.target_type = 'zagulyaky_record'
          and audit_row.target_id = record_row.id::text
        order by audit_row.created_at desc, audit_row.id desc
        limit safe_action_limit
      ) as audit_row
    ), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(to_jsonb(claim_row) order by claim_row.created_at desc, claim_row.id desc)
      from (
        select claim_row.id, claim_row.claim_type, claim_row.message, claim_row.status,
          claim_row.resolution_note, claim_row.resolved_at, claim_row.created_at, claim_row.updated_at
        from public.zagulyaky_claims as claim_row
        where claim_row.record_id = record_row.id
        order by claim_row.created_at desc, claim_row.id desc
        limit safe_action_limit
      ) as claim_row
    ), '[]'::jsonb),
    'privateImportOrigins', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sourcePlatform', origin_row.source_platform,
        'facebookPostUrl', origin_row.original_post_url_private,
        'sourceTitleOriginal', case
          when lower(origin_row.source_platform) = 'facebook' then 'Оригінальний допис у Facebook'
          else 'Оригінальний допис'
        end
      ) order by origin_row.created_at, origin_row.record_id)
      from public.zagulyaky_record_origins as origin_row
      where origin_row.record_id = record_row.id
    ), '[]'::jsonb)
  ) into result
  from public.zagulyaky_records as record_row
  where record_row.id = p_record_id;

  return result;
end;
$function$;

-- The origin-capture trigger belonged only to workbook materialisation.  Drop
-- it before removing its function and table.
drop trigger if exists zagulyaky_tabular_import_card_record_origin_capture
  on public.zagulyaky_tabular_import_card_records;

-- Remove only routines belonging to the retired pipelines.  The public
-- catalogue, ordinary draft creation, moderation, attachments, map, saved
-- places/sources and Telegram notes are intentionally outside this selector.
do $drop_retired_import_routines$
declare
  routine_row record;
begin
  for routine_row in
    select namespace_row.nspname as schema_name,
      procedure_row.proname as function_name,
      pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as identity_arguments
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where procedure_row.prokind = 'f'
      and namespace_row.nspname = 'public'
      and (
        procedure_row.proname like '%zagulyaky_ingestion%'
        or procedure_row.proname like '%zagulyaky_structuring%'
        or procedure_row.proname like '%zagulyaky_tabular%'
        or procedure_row.proname like '%zagulyaky_initial_base_bulk%'
        or procedure_row.proname in (
          'admin_begin_zagulyaky_facebook_import_v1',
          'service_ingest_zagulyaky_facebook_chunk_v1',
          'service_finalize_zagulyaky_facebook_import_v1',
          'admin_set_zagulyaka_tabular_facebook_origin_visibility_v1'
        )
      )
  loop
    execute format(
      'drop function if exists %I.%I(%s)',
      routine_row.schema_name,
      routine_row.function_name,
      routine_row.identity_arguments
    );
  end loop;

  for routine_row in
    select namespace_row.nspname as schema_name,
      procedure_row.proname as function_name,
      pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as identity_arguments
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where procedure_row.prokind = 'f'
      and namespace_row.nspname = 'security_private'
      and (
        procedure_row.proname like '%zagulyaky_ingestion%'
        or procedure_row.proname like '%zagulyaky_structuring%'
        or procedure_row.proname like '%zagulyaky_tabular%'
        or procedure_row.proname like '%zagulyaky_initial_base_bulk%'
        or procedure_row.proname like 'zagulyaky_structured_candidate_%'
        or procedure_row.proname like 'zagulyaky_commit_recovery_%'
        or procedure_row.proname like 'zagulyaky_import_%'
        or procedure_row.proname in (
          'admin_begin_zagulyaky_facebook_import_v1',
          'service_ingest_zagulyaky_facebook_chunk_v1',
          'service_finalize_zagulyaky_facebook_import_v1',
          'admin_set_zagulyaka_tabular_facebook_origin_visibility_v1',
          'capture_zagulyaky_tabular_record_origin_v1'
        )
      )
  loop
    execute format(
      'drop function if exists %I.%I(%s)',
      routine_row.schema_name,
      routine_row.function_name,
      routine_row.identity_arguments
    );
  end loop;
end;
$drop_retired_import_routines$;

-- Deleting these tables deletes only raw Facebook export/XLSX staging data,
-- validation receipts and abandoned job queues.  There is deliberately no
-- CASCADE here: the order makes every dependency explicit and protects the
-- materialised `zagulyaky_records` catalogue.
drop table if exists public.zagulyaky_tabular_import_record_origins;
drop table if exists public.zagulyaky_tabular_import_card_records;
drop table if exists public.zagulyaky_tabular_import_qc;
drop table if exists public.zagulyaky_tabular_import_chunks;
drop table if exists public.zagulyaky_tabular_import_participants;
drop table if exists public.zagulyaky_tabular_import_event_sources;
drop table if exists public.zagulyaky_tabular_import_cards;
drop table if exists public.zagulyaky_tabular_import_events;
drop table if exists public.zagulyaky_tabular_import_source_posts;
drop table if exists public.zagulyaky_tabular_import_batches;

drop table if exists public.zagulyaky_ingestion_structured_candidates;
drop table if exists public.zagulyaky_structuring_tasks;
drop table if exists public.zagulyaky_structuring_runs;
drop table if exists public.zagulyaky_ingestion_audit_events;
drop table if exists public.zagulyaky_ingestion_item_records;
drop table if exists public.zagulyaky_ingestion_attachments;
drop table if exists public.zagulyaky_ingestion_links;
drop table if exists public.zagulyaky_extraction_jobs;
drop table if exists public.zagulyaky_ingestion_item_errors;
drop table if exists public.zagulyaky_ingestion_chunks;
drop table if exists public.zagulyaky_ingestion_batch_items;
drop table if exists public.zagulyaky_ingestion_media_assets;
drop table if exists public.zagulyaky_ingestion_items;
drop table if exists public.zagulyaky_ingestion_batches;

-- The capability was dedicated to the removed import UI and must no longer be
-- assigned to any role.
delete from public.admin_role_permissions
where permission_code = 'zagulyaky.import';

revoke all on function security_private.zagulyaky_public_facebook_origin_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
