begin;

-- Notes created in the Tracker Rodu interface live beside notes received from
-- Telegram.  The legacy table name reflects the original inbox feature, but
-- a manually created note has no intake and no Telegram-specific provenance.
create or replace function security_private.create_my_telegram_note_v1(
  p_title text,
  p_body text,
  p_status text,
  p_source_status text,
  p_priority text,
  p_source_url text default null,
  p_source_platform text default 'other'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  note_row public.telegram_saved_notes;
  normalized_status text := lower(security_private.telegram_safe_text_v1(p_status, 30, true));
  normalized_source_status text := lower(security_private.telegram_safe_text_v1(p_source_status, 30, true));
  normalized_priority text := lower(security_private.telegram_safe_text_v1(p_priority, 30, true));
  normalized_url text := nullif(security_private.telegram_safe_text_v1(p_source_url, 2048), '');
  normalized_platform text := lower(security_private.telegram_safe_text_v1(p_source_platform, 20, true));
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if normalized_status not in ('inbox','reviewing','saved','archived','converted')
    or normalized_source_status not in ('unverified','available','unavailable','changed')
    or normalized_priority not in ('low','normal','high','urgent')
    or normalized_platform not in ('telegram','facebook','web','other') then
    raise exception 'TELEGRAM_NOTE_ENUM_INVALID' using errcode = '22023';
  end if;

  if normalized_url is not null and normalized_url !~* '^https?://' then
    raise exception 'TELEGRAM_NOTE_URL_INVALID' using errcode = '22023';
  end if;

  insert into public.telegram_saved_notes (
    owner_id,
    intake_id,
    title,
    body_text,
    source_url,
    source_platform,
    source_label,
    source_metadata,
    status,
    source_status,
    priority
  ) values (
    current_user_id,
    null,
    security_private.telegram_safe_text_v1(p_title, 240, true),
    security_private.telegram_safe_text_v1(p_body, 12000),
    normalized_url,
    normalized_platform,
    null,
    '{}'::jsonb,
    normalized_status,
    normalized_source_status,
    normalized_priority
  )
  returning * into note_row;

  return jsonb_build_object(
    'id', note_row.id,
    'title', note_row.title,
    'body', note_row.body_text,
    'sourceUrl', note_row.source_url,
    'sourcePlatform', note_row.source_platform,
    'sourceLabel', note_row.source_label,
    'sourceMetadata', note_row.source_metadata,
    'status', note_row.status,
    'sourceStatus', note_row.source_status,
    'priority', note_row.priority,
    'createdAt', note_row.created_at,
    'updatedAt', note_row.updated_at
  );
end;
$function$;

create or replace function public.create_my_telegram_note_v1(
  p_title text,
  p_body text,
  p_status text,
  p_source_status text,
  p_priority text,
  p_source_url text default null,
  p_source_platform text default 'other'
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $$
  select security_private.create_my_telegram_note_v1($1,$2,$3,$4,$5,$6,$7)
$$;

revoke all on function security_private.create_my_telegram_note_v1(text,text,text,text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.create_my_telegram_note_v1(text,text,text,text,text,text,text)
  to authenticated, service_role;

revoke all on function public.create_my_telegram_note_v1(text,text,text,text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_my_telegram_note_v1(text,text,text,text,text,text,text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
