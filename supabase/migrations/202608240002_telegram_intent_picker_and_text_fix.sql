begin;

-- PostgreSQL text values cannot contain U+0000.  Constructing a NUL value in a text
-- validation expression therefore raises SQLSTATE 54000 for every request,
-- including an otherwise ordinary /start code.  The webhook already rejects
-- NUL bytes before they reach Postgres, so retain the useful bounds without
-- constructing an impossible text value.
create or replace function security_private.telegram_safe_text_v1(
  p_value text,
  p_maximum integer,
  p_required boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  normalized text := btrim(coalesce(p_value, ''));
begin
  if p_maximum is null or p_maximum < 1 then
    raise exception 'TELEGRAM_TEXT_LIMIT_INVALID' using errcode = '22023';
  end if;
  if char_length(normalized) > p_maximum then
    raise exception 'TELEGRAM_TEXT_INVALID' using errcode = '22023';
  end if;
  if p_required and normalized = '' then
    raise exception 'TELEGRAM_TEXT_REQUIRED' using errcode = '22023';
  end if;
  return normalized;
end;
$function$;

-- A material must be intentionally classified before it is saved or sent to
-- the worker.  `choose` is an account-local, single-next-message state, not
-- an intake status, so an unclassified message never enters the queue.
alter table public.telegram_account_links
  drop constraint if exists telegram_account_links_active_mode_check;

alter table public.telegram_account_links
  add constraint telegram_account_links_active_mode_check
  check (active_mode in ('choose', 'note', 'zagulyaka'));

alter table public.telegram_account_links
  alter column active_mode set default 'choose';

-- Existing linked users also receive an explicit choice on their next item.
update public.telegram_account_links
set active_mode = 'choose';

create or replace function security_private.set_my_telegram_ai_opt_in_v1(
  p_ai_opt_in boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  link_row public.telegram_account_links;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  update public.telegram_account_links
  set ai_opt_in = coalesce(p_ai_opt_in, false),
      active_mode = case when coalesce(p_ai_opt_in, false) then active_mode else 'choose' end
  where owner_id = current_user_id
  returning * into link_row;
  if not found then
    raise exception 'TELEGRAM_ACCOUNT_NOT_LINKED' using errcode = 'P0002';
  end if;
  if not link_row.ai_opt_in then
    -- Do not send queued text or photos to an AI provider after the owner
    -- withdrew this optional processing permission.  A race that was already
    -- in an external model call is blocked again by materialization below.
    update public.telegram_intakes
    set status = 'rejected', completed_at = now(), claim_token = null,
        claimed_by = null, claimed_at = null, lease_expires_at = null,
        last_error_code = 'TELEGRAM_AI_OPT_OUT'
    where owner_id = current_user_id
      and intent = 'zagulyaka'
      and status in ('queued', 'retry', 'processing', 'materialized');
  end if;
  return jsonb_build_object(
    'linked', true,
    'telegramUsername', link_row.telegram_username,
    'displayName', link_row.display_name,
    'linkedAt', link_row.linked_at,
    'aiOptIn', link_row.ai_opt_in
  );
end;
$function$;

create or replace function security_private.service_consume_telegram_link_v1(
  p_start_code text,
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_telegram_username text default null,
  p_display_name text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  token_row public.telegram_link_tokens;
  existing_owner uuid;
  normalized_code text := security_private.telegram_safe_text_v1(p_start_code, 160, true);
begin
  if p_telegram_user_id is null or p_private_chat_id is null then
    raise exception 'TELEGRAM_ID_REQUIRED' using errcode = '22023';
  end if;

  select * into token_row
  from public.telegram_link_tokens
  where token_hash = security_private.telegram_sha256_v1(normalized_code)
    and consumed_at is null
    and expires_at > now()
  for update;
  if not found then
    return jsonb_build_object('linked', false, 'reason', 'invalid_or_expired');
  end if;

  select owner_id into existing_owner
  from public.telegram_account_links
  where telegram_user_id = p_telegram_user_id
  for update;
  if existing_owner is not null and existing_owner <> token_row.owner_id then
    return jsonb_build_object('linked', false, 'reason', 'already_linked');
  end if;

  insert into public.telegram_account_links(
    owner_id, telegram_user_id, private_chat_id, telegram_username, display_name, ai_opt_in, active_mode, linked_at
  ) values (
    token_row.owner_id, p_telegram_user_id, p_private_chat_id,
    nullif(security_private.telegram_safe_text_v1(p_telegram_username, 128), ''),
    nullif(security_private.telegram_safe_text_v1(p_display_name, 256), ''), token_row.ai_opt_in, 'choose', now()
  )
  on conflict (owner_id) do update
  set telegram_user_id = excluded.telegram_user_id,
      private_chat_id = excluded.private_chat_id,
      telegram_username = excluded.telegram_username,
      display_name = excluded.display_name,
      ai_opt_in = excluded.ai_opt_in,
      active_mode = 'choose',
      linked_at = now();

  update public.telegram_link_tokens set consumed_at = now() where id = token_row.id;
  return jsonb_build_object('linked', true, 'ownerId', token_row.owner_id);
end;
$function$;

create or replace function security_private.service_enqueue_telegram_message_v1(
  p_update_id bigint,
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_message_id bigint,
  p_message_text text default '',
  p_media jsonb default null,
  p_source_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  link_row public.telegram_account_links;
  intake_id_value uuid;
  duplicate_intent text;
  active_intent text;
  normalized_text text := security_private.telegram_safe_text_v1(p_message_text, 12000);
  normalized_source_metadata jsonb := security_private.telegram_source_metadata_v1(p_source_metadata);
  file_id_value text;
  unique_id_value text;
  file_name_value text;
  mime_value text;
  byte_size_value bigint;
  media_omitted boolean := false;
begin
  if p_update_id is null or p_message_id is null or p_telegram_user_id is null or p_private_chat_id is null then
    raise exception 'TELEGRAM_UPDATE_INVALID' using errcode = '22023';
  end if;
  select * into link_row from public.telegram_account_links
  where telegram_user_id = p_telegram_user_id and private_chat_id = p_private_chat_id
  for update;
  if not found then
    return jsonb_build_object('linked', false);
  end if;

  -- Telegram may repeat a completed delivery.  Check this before the current
  -- mode so an old retry cannot consume or overwrite a newer choice.
  select intent into duplicate_intent
  from public.telegram_intakes
  where telegram_update_id = p_update_id
  limit 1;
  if found then
    return jsonb_build_object(
      'linked', true, 'accepted', true, 'duplicate', true, 'intent', duplicate_intent
    );
  end if;

  if normalized_text = '' and (p_media is null or jsonb_typeof(p_media) <> 'object') then
    return jsonb_build_object('linked', true, 'accepted', false, 'reason', 'empty');
  end if;

  active_intent := link_row.active_mode;
  if active_intent = 'choose' then
    return jsonb_build_object('linked', true, 'accepted', false, 'reason', 'choice_required');
  end if;
  -- Saving a private note never transfers it to a model.  AI opt-in is
  -- required only for the explicit Zagulyaka selection.
  if active_intent = 'zagulyaka' and not link_row.ai_opt_in then
    return jsonb_build_object('linked', true, 'accepted', false, 'reason', 'ai_not_enabled');
  end if;
  -- A photo is evidence for a Zagulyaka draft, not an unbounded general
  -- messenger attachment store. A forwarded channel post with a textual
  -- caption is useful as a bookmark, so retain only its text/provenance and
  -- deliberately omit its media.
  if active_intent = 'note' and p_media is not null then
    if normalized_text <> '' and coalesce((normalized_source_metadata ->> 'forwarded')::boolean, false) then
      if jsonb_typeof(p_media) <> 'object' then
        raise exception 'TELEGRAM_MEDIA_INVALID' using errcode = '22023';
      end if;
      media_omitted := true;
    else
      return jsonb_build_object('linked', true, 'accepted', false, 'reason', 'photo_requires_zagulyaka');
    end if;
  end if;

  insert into public.telegram_intakes(
    owner_id, telegram_update_id, telegram_user_id, private_chat_id,
    telegram_message_id, intent, message_text, source_metadata
  ) values (
    link_row.owner_id, p_update_id, p_telegram_user_id, p_private_chat_id,
    p_message_id, active_intent, normalized_text, normalized_source_metadata
  ) returning id into intake_id_value;

  if p_media is not null and not media_omitted then
    if jsonb_typeof(p_media) <> 'object' then
      raise exception 'TELEGRAM_MEDIA_INVALID' using errcode = '22023';
    end if;
    file_id_value := security_private.telegram_safe_text_v1(p_media ->> 'fileId', 512, true);
    unique_id_value := security_private.telegram_safe_text_v1(p_media ->> 'fileUniqueId', 512, true);
    file_name_value := coalesce(nullif(security_private.telegram_safe_text_v1(p_media ->> 'fileName', 255), ''), 'telegram-photo');
    mime_value := nullif(lower(security_private.telegram_safe_text_v1(p_media ->> 'mimeType', 100)), '');
    if mime_value is not null and mime_value not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception 'TELEGRAM_MEDIA_TYPE_INVALID' using errcode = '22023';
    end if;
    if p_media ->> 'byteSize' ~ '^\d{1,8}$' then
      byte_size_value := (p_media ->> 'byteSize')::bigint;
      if byte_size_value > 20971520 then
        raise exception 'TELEGRAM_MEDIA_TOO_LARGE' using errcode = '22023';
      end if;
    end if;
    insert into public.telegram_intake_media(
      intake_id, telegram_file_id, telegram_file_unique_id, file_name, declared_mime_type, declared_byte_size
    ) values (
      intake_id_value, file_id_value, unique_id_value, file_name_value, mime_value, byte_size_value
    );
  end if;

  -- Every successful material consumes its explicit choice.  The next post
  -- cannot become a note or AI task until the owner selects again.
  update public.telegram_account_links
  set active_mode = 'choose'
  where owner_id = link_row.owner_id;

  return jsonb_build_object(
    'linked', true, 'accepted', true, 'duplicate', false, 'intent', active_intent,
    'intakeId', intake_id_value, 'mediaOmitted', media_omitted
  );
end;
$function$;

notify pgrst, 'reload schema';
commit;
