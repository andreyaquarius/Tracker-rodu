begin;

-- PostgreSQL `text` values cannot contain a NUL byte.  The previous import
-- helpers tried to prove that fact by constructing the zero code point, but
-- PostgreSQL rejects that expression itself (SQLSTATE 54000) before an
-- ordinary workbook value can be accepted.  The Edge boundary already rejects
-- NUL input, so the correct database defence is to retain type/length
-- validation and remove the impossible in-database check.

create or replace function security_private.zagulyaky_tabular_import_text_v1(
  p_row jsonb,
  p_key text,
  p_max_length integer,
  p_required boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  raw_value jsonb;
  normalized_value text;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'INVALID_TABULAR_ROW' using errcode = '22023';
  end if;
  raw_value := p_row -> p_key;
  if raw_value is null or raw_value = 'null'::jsonb then
    if p_required then
      raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(raw_value) not in ('string', 'number', 'boolean') then
    raise exception 'TABULAR_FIELD_MUST_BE_SCALAR:%', p_key using errcode = '22023';
  end if;
  normalized_value := btrim(raw_value #>> '{}');
  if char_length(normalized_value) > p_max_length then
    raise exception 'TABULAR_FIELD_INVALID_LENGTH:%', p_key using errcode = '22023';
  end if;
  if normalized_value = '' then
    if p_required then
      raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  return normalized_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_raw_text_v1(
  p_row jsonb,
  p_key text,
  p_max_length integer,
  p_required boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  raw_value jsonb;
  result_value text;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'INVALID_TABULAR_ROW' using errcode = '22023';
  end if;
  raw_value := p_row -> p_key;
  if raw_value is null or raw_value = 'null'::jsonb then
    if p_required then
      raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(raw_value) <> 'string' then
    raise exception 'TABULAR_FIELD_MUST_BE_TEXT:%', p_key using errcode = '22023';
  end if;
  result_value := raw_value #>> '{}';
  if char_length(result_value) > p_max_length then
    raise exception 'TABULAR_FIELD_INVALID_LENGTH:%', p_key using errcode = '22023';
  end if;
  if p_required and btrim(result_value) = '' then
    raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
  end if;
  return result_value;
end;
$function$;

create or replace function security_private.admin_begin_zagulyaky_tabular_event_import_v1(
  p_source_file_name text,
  p_source_checksum text,
  p_expected_counts jsonb,
  p_import_mode text default 'dry_run'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_file_name text := btrim(coalesce(p_source_file_name, ''));
  normalized_checksum text := lower(btrim(coalesce(p_source_checksum, '')));
  normalized_import_mode text := lower(btrim(coalesce(p_import_mode, '')));
  expected_source_posts integer;
  expected_events integer;
  expected_participants integer;
  expected_event_sources integer;
  expected_cards integer;
  expected_qc integer;
  expected_no_card_events integer;
  batch_row public.zagulyaky_tabular_import_batches;
  created_new boolean := false;
begin
  if current_user_id is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if normalized_file_name = ''
    or normalized_file_name !~* '[.]xlsx$'
    or normalized_file_name ~ '[\\/]' then
    raise exception 'INVALID_TABULAR_SOURCE_FILE_NAME' using errcode = '22023';
  end if;
  if normalized_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TABULAR_SOURCE_CHECKSUM' using errcode = '22023';
  end if;
  if normalized_import_mode not in ('dry_run', 'commit') then
    raise exception 'INVALID_IMPORT_MODE' using errcode = '22023';
  end if;

  expected_source_posts := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'sourcePosts', 50000);
  expected_events := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'events', 200000);
  expected_participants := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'participants', 500000);
  expected_event_sources := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'eventSources', 500000);
  expected_cards := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'cards', 500000);
  expected_qc := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'qc', 500000);
  expected_no_card_events := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'eventsWithoutCards', 200000);

  insert into public.zagulyaky_tabular_import_batches(
    source_file_name, source_checksum, import_mode, status,
    expected_source_post_count, expected_event_count, expected_participant_count,
    expected_event_source_count, expected_card_count, expected_qc_count,
    expected_no_card_event_count, requested_by
  ) values (
    normalized_file_name, normalized_checksum, 'dry_run', 'received',
    expected_source_posts, expected_events, expected_participants,
    expected_event_sources, expected_cards, expected_qc,
    expected_no_card_events, current_user_id
  )
  on conflict (source_checksum) do nothing
  returning * into batch_row;

  if found then
    created_new := true;
  else
    select * into batch_row
    from public.zagulyaky_tabular_import_batches
    where source_checksum = normalized_checksum
    for update;

    if batch_row.expected_source_post_count <> expected_source_posts
      or batch_row.expected_event_count <> expected_events
      or batch_row.expected_participant_count <> expected_participants
      or batch_row.expected_event_source_count <> expected_event_sources
      or batch_row.expected_card_count <> expected_cards
      or batch_row.expected_qc_count <> expected_qc
      or batch_row.expected_no_card_event_count <> expected_no_card_events then
      raise exception 'TABULAR_SOURCE_CHECKSUM_METADATA_CONFLICT' using errcode = '23514';
    end if;
  end if;

  if created_new then
    if normalized_import_mode <> 'dry_run' then
      raise exception 'DRY_RUN_REQUIRED' using errcode = '23514';
    end if;
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', false);
  end if;

  if normalized_import_mode = 'dry_run' then
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', true);
  end if;

  if batch_row.status = 'dry_run_complete' then
    update public.zagulyaky_tabular_import_batches
    set import_mode = 'commit',
        status = 'commit_ready',
        commit_started_at = now(),
        requested_by = current_user_id,
        updated_at = now(),
        last_error_code = null
    where id = batch_row.id
    returning * into batch_row;
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', false);
  end if;

  if batch_row.status in ('commit_ready', 'commit_materializing', 'completed') then
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', true);
  end if;

  raise exception 'DRY_RUN_NOT_COMPLETE' using errcode = '23514';
end;
$function$;

-- CREATE OR REPLACE retains the existing owner and permissions.  Reassert
-- the original private-only ACL explicitly so this emergency fix cannot widen
-- access to parsers that process raw workbook text.
revoke all on function security_private.zagulyaky_tabular_import_text_v1(jsonb,text,integer,boolean)
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_raw_text_v1(jsonb,text,integer,boolean)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_begin_zagulyaky_tabular_event_import_v1(text,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.admin_begin_zagulyaky_tabular_event_import_v1(text,text,jsonb,text)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
