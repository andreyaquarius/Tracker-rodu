begin;

-- A Telegram message is retained privately for a short time before the owner
-- classifies that exact material.  It must never reach the worker while the
-- choice is pending.
alter table public.telegram_intakes
  add column if not exists choice_token uuid,
  add column if not exists choice_expires_at timestamptz;

alter table public.telegram_intakes
  drop constraint if exists telegram_intakes_intent_check;

alter table public.telegram_intakes
  add constraint telegram_intakes_intent_check
  check (intent in ('pending_choice', 'note', 'zagulyaka', 'expired_choice'));

alter table public.telegram_intakes
  drop constraint if exists telegram_intakes_status_check;

alter table public.telegram_intakes
  add constraint telegram_intakes_status_check
  check (status in (
    'awaiting_choice', 'queued', 'processing', 'materialized', 'retry',
    'completed', 'failed', 'rejected'
  ));

alter table public.telegram_intakes
  drop constraint if exists telegram_intakes_choice_state_check;

alter table public.telegram_intakes
  add constraint telegram_intakes_choice_state_check
  check (
    (
      status = 'awaiting_choice'
      and intent = 'pending_choice'
      and choice_token is not null
      and choice_expires_at is not null
    )
    or
    (
      status <> 'awaiting_choice'
      and intent <> 'pending_choice'
      and choice_expires_at is null
    )
  );

create unique index if not exists telegram_intakes_choice_token_key
  on public.telegram_intakes(choice_token)
  where choice_token is not null;

create index if not exists telegram_intakes_awaiting_choice_expiry_idx
  on public.telegram_intakes(choice_expires_at, id)
  where status = 'awaiting_choice';

-- Keep a minimal tombstone for an expired Telegram update.  Deleting the row
-- outright would allow Telegram's delayed delivery of the same update to put
-- the private material back into the database after its time limit passed.
create or replace function security_private.expire_telegram_pending_choice_v1(
  p_intake_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  expired_id uuid;
begin
  update public.telegram_intakes
  set intent = 'expired_choice',
      status = 'rejected',
      message_text = '',
      source_metadata = '{}'::jsonb,
      choice_token = null,
      choice_expires_at = null,
      next_attempt_at = clock_timestamp(),
      claim_token = null,
      claimed_by = null,
      claimed_at = null,
      lease_expires_at = null,
      completed_at = clock_timestamp(),
      last_error_code = 'TELEGRAM_CHOICE_EXPIRED'
  where id = p_intake_id
    and status = 'awaiting_choice'
    and choice_expires_at <= clock_timestamp()
  returning id into expired_id;

  if expired_id is null then
    return false;
  end if;

  -- No media may outlive an unclassified private message. There cannot be
  -- stored attachments yet because the worker only sees queued records.
  delete from public.telegram_intake_media where intake_id = expired_id;
  return true;
end;
$function$;

-- Capture first, ask second.  The material stays in the owner's private
-- intake until a callback supplies its explicit destination.
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
  existing_intake public.telegram_intakes;
  intake_id_value uuid;
  choice_token_value uuid := gen_random_uuid();
  normalized_text text := security_private.telegram_safe_text_v1(p_message_text, 12000);
  normalized_source_metadata jsonb := security_private.telegram_source_metadata_v1(p_source_metadata);
  file_id_value text;
  unique_id_value text;
  file_name_value text;
  mime_value text;
  byte_size_value bigint;
begin
  if p_update_id is null or p_message_id is null or p_telegram_user_id is null or p_private_chat_id is null then
    raise exception 'TELEGRAM_UPDATE_INVALID' using errcode = '22023';
  end if;

  select * into link_row
  from public.telegram_account_links
  where telegram_user_id = p_telegram_user_id
    and private_chat_id = p_private_chat_id
  for update;
  if not found then
    return jsonb_build_object('linked', false);
  end if;

  -- An already persisted update is always idempotent. In particular, a
  -- Telegram retry must restore the existing picker instead of saving the
  -- material a second time.
  select * into existing_intake
  from public.telegram_intakes
  where telegram_update_id = p_update_id
  limit 1;
  if found then
    if existing_intake.status = 'awaiting_choice' then
      if existing_intake.choice_expires_at > clock_timestamp() then
        return jsonb_build_object(
          'linked', true, 'accepted', true, 'duplicate', true,
          'awaitingChoice', true, 'choiceToken', existing_intake.choice_token
        );
      end if;
      perform security_private.expire_telegram_pending_choice_v1(existing_intake.id);
      return jsonb_build_object(
        'linked', true, 'accepted', true, 'duplicate', true,
        'awaitingChoice', false, 'reason', 'expired'
      );
    end if;
    return jsonb_build_object(
      'linked', true, 'accepted', true, 'duplicate', true,
      'awaitingChoice', false,
      'intent', existing_intake.intent,
      'reason', case when existing_intake.intent = 'expired_choice' then 'expired' else null end
    );
  end if;

  if normalized_text = '' and (p_media is null or jsonb_typeof(p_media) <> 'object') then
    return jsonb_build_object('linked', true, 'accepted', false, 'reason', 'empty');
  end if;

  if p_media is not null then
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
  end if;

  insert into public.telegram_intakes(
    owner_id, telegram_update_id, telegram_user_id, private_chat_id,
    telegram_message_id, intent, message_text, source_metadata, status,
    choice_token, choice_expires_at
  ) values (
    link_row.owner_id, p_update_id, p_telegram_user_id, p_private_chat_id,
    p_message_id, 'pending_choice', normalized_text, normalized_source_metadata,
    'awaiting_choice', choice_token_value, clock_timestamp() + interval '15 minutes'
  ) on conflict (telegram_update_id) do nothing
  returning id into intake_id_value;

  if intake_id_value is null then
    -- A concurrent delivery won the unique-update race. Re-read its result
    -- without accepting a second copy of the material.
    select * into existing_intake
    from public.telegram_intakes
    where telegram_update_id = p_update_id
    limit 1;
    if found and existing_intake.status = 'awaiting_choice'
      and existing_intake.choice_expires_at > clock_timestamp() then
      return jsonb_build_object(
        'linked', true, 'accepted', true, 'duplicate', true,
        'awaitingChoice', true, 'choiceToken', existing_intake.choice_token
      );
    end if;
    return jsonb_build_object(
      'linked', true, 'accepted', true, 'duplicate', true,
      'awaitingChoice', false,
      'reason', case when found and existing_intake.intent = 'expired_choice' then 'expired' else null end
    );
  end if;

  if p_media is not null then
    insert into public.telegram_intake_media(
      intake_id, telegram_file_id, telegram_file_unique_id, file_name, declared_mime_type, declared_byte_size
    ) values (
      intake_id_value, file_id_value, unique_id_value, file_name_value, mime_value, byte_size_value
    );
  end if;

  return jsonb_build_object(
    'linked', true, 'accepted', true, 'duplicate', false,
    'awaitingChoice', true, 'choiceToken', choice_token_value
  );
end;
$function$;

-- The callback carries a one-time opaque token, but the database still binds
-- it to the linked Telegram user, private chat and owner before releasing any
-- material to the queue.
create or replace function security_private.service_choose_telegram_intake_intent_v1(
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_choice_token uuid,
  p_intent text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  link_row public.telegram_account_links;
  intake_row public.telegram_intakes;
  intake_id_value uuid;
  normalized_intent text := lower(security_private.telegram_safe_text_v1(p_intent, 20, true));
  media_omitted boolean := false;
begin
  if p_telegram_user_id is null or p_private_chat_id is null or p_choice_token is null then
    raise exception 'TELEGRAM_CHOICE_INVALID' using errcode = '22023';
  end if;
  if normalized_intent not in ('note', 'zagulyaka') then
    raise exception 'TELEGRAM_CHOICE_INVALID' using errcode = '22023';
  end if;

  select * into link_row
  from public.telegram_account_links
  where telegram_user_id = p_telegram_user_id
    and private_chat_id = p_private_chat_id
  for update;
  if not found then
    return jsonb_build_object('linked', false, 'selected', false);
  end if;

  select * into intake_row
  from public.telegram_intakes
  where choice_token = p_choice_token
    and owner_id = link_row.owner_id
    and telegram_user_id = p_telegram_user_id
    and private_chat_id = p_private_chat_id
  for update;
  if not found then
    return jsonb_build_object('linked', true, 'selected', false, 'reason', 'not_found');
  end if;
  intake_id_value := intake_row.id;

  if intake_row.status = 'awaiting_choice' and intake_row.choice_expires_at <= clock_timestamp() then
    perform security_private.expire_telegram_pending_choice_v1(intake_row.id);
    return jsonb_build_object('linked', true, 'selected', false, 'reason', 'expired');
  end if;

  -- The first valid selection is idempotent. A later click on the other
  -- button cannot reroute a queued/private record.
  if intake_row.status <> 'awaiting_choice' or intake_row.intent <> 'pending_choice' then
    if intake_row.intent = normalized_intent then
      return jsonb_build_object(
        'linked', true, 'selected', true, 'duplicate', true, 'intent', intake_row.intent
      );
    end if;
    return jsonb_build_object('linked', true, 'selected', false, 'reason', 'already_selected');
  end if;

  -- A Zagulyaka is the only path that sends user material to the AI worker.
  -- Recheck this at the exact moment the queue becomes eligible.
  if normalized_intent = 'zagulyaka' and not link_row.ai_opt_in then
    return jsonb_build_object('linked', true, 'selected', false, 'reason', 'ai_not_enabled');
  end if;

  -- Notes intentionally do not become a generic image store. A forwarded
  -- public post with a caption remains a useful text bookmark; its photo is
  -- discarded before queueing. Any other photo remains pending so the owner
  -- can choose Zagulyaka without re-sending it.
  if normalized_intent = 'note'
    and exists (select 1 from public.telegram_intake_media where intake_id = intake_row.id) then
    if intake_row.message_text <> ''
      and coalesce((intake_row.source_metadata ->> 'forwarded')::boolean, false) then
      delete from public.telegram_intake_media where intake_id = intake_row.id;
      media_omitted := true;
    else
      return jsonb_build_object('linked', true, 'selected', false, 'reason', 'photo_requires_zagulyaka');
    end if;
  end if;

  update public.telegram_intakes
  set intent = normalized_intent,
      status = 'queued',
      choice_expires_at = null,
      next_attempt_at = clock_timestamp(),
      last_error_code = null
  where id = intake_row.id
    and status = 'awaiting_choice'
    and intent = 'pending_choice'
    and choice_token = p_choice_token
    and choice_expires_at > clock_timestamp()
  returning * into intake_row;

  if not found then
    perform security_private.expire_telegram_pending_choice_v1(intake_id_value);
    return jsonb_build_object('linked', true, 'selected', false, 'reason', 'expired');
  end if;

  return jsonb_build_object(
    'linked', true, 'selected', true, 'duplicate', false,
    'intent', normalized_intent, 'mediaOmitted', media_omitted
  );
end;
$function$;

-- A Bot API delivery can fail after the material was safely captured. The
-- owner can send /pending to receive the latest unexpired picker again;
-- no content is exposed in the command response.
create or replace function security_private.service_get_telegram_pending_choice_v1(
  p_telegram_user_id bigint,
  p_private_chat_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  link_row public.telegram_account_links;
  intake_row public.telegram_intakes;
begin
  if p_telegram_user_id is null or p_private_chat_id is null then
    raise exception 'TELEGRAM_CHOICE_INVALID' using errcode = '22023';
  end if;

  select * into link_row
  from public.telegram_account_links
  where telegram_user_id = p_telegram_user_id
    and private_chat_id = p_private_chat_id
  for update;
  if not found then
    return jsonb_build_object('linked', false, 'pending', false);
  end if;

  select * into intake_row
  from public.telegram_intakes
  where owner_id = link_row.owner_id
    and telegram_user_id = p_telegram_user_id
    and private_chat_id = p_private_chat_id
    and status = 'awaiting_choice'
    and choice_expires_at > clock_timestamp()
  order by created_at desc, id desc
  limit 1;
  if not found then
    return jsonb_build_object('linked', true, 'pending', false);
  end if;

  return jsonb_build_object(
    'linked', true, 'pending', true,
    'choiceToken', intake_row.choice_token,
    'expiresAt', intake_row.choice_expires_at
  );
end;
$function$;

-- Privacy cleanup is intentionally part of the worker cadence. The callback
-- also checks expiry, so the material cannot be selected during the small
-- interval before this sweep runs.
create or replace function security_private.service_claim_telegram_intake_v1(
  p_worker_id text default 'telegram-inbox',
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  target public.telegram_intakes;
  expired_row record;
  token uuid := gen_random_uuid();
  normalized_worker text := security_private.telegram_safe_text_v1(p_worker_id, 120, true);
  media_value jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'TELEGRAM_LEASE_INVALID' using errcode = '22023';
  end if;

  -- Bounded expiry cleanup keeps an invocation short even after an outage.
  for expired_row in
    select id
    from public.telegram_intakes
    where status = 'awaiting_choice' and choice_expires_at <= clock_timestamp()
    order by choice_expires_at, id
    for update skip locked
    limit 50
  loop
    perform security_private.expire_telegram_pending_choice_v1(expired_row.id);
  end loop;

  update public.telegram_intakes
  set status = case when attempt_count < max_attempts then 'retry' else 'failed' end,
      next_attempt_at = now(), claim_token = null, claimed_by = null, claimed_at = null,
      lease_expires_at = null, last_error_code = coalesce(last_error_code, 'TELEGRAM_LEASE_EXPIRED')
  where status in ('processing', 'materialized') and lease_expires_at < now();

  select * into target
  from public.telegram_intakes
  where status in ('queued', 'retry') and next_attempt_at <= now()
  order by created_at, id
  for update skip locked
  limit 1;
  if not found then return null; end if;

  update public.telegram_intakes
  set status = 'processing', attempt_count = target.attempt_count + 1,
      claim_token = token, claimed_by = normalized_worker, claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds), last_error_code = null
  where id = target.id
  returning * into target;

  select jsonb_build_object(
    'id', media.id,
    'telegramFileId', media.telegram_file_id,
    'telegramFileUniqueId', media.telegram_file_unique_id,
    'fileName', media.file_name,
    'declaredMimeType', media.declared_mime_type,
    'declaredByteSize', media.declared_byte_size,
    'status', media.status
  ) into media_value
  from public.telegram_intake_media media
  where media.intake_id = target.id
  order by media.created_at, media.id
  limit 1;

  return jsonb_build_object(
    'intakeId', target.id, 'claimToken', token, 'ownerId', target.owner_id,
    'intent', target.intent, 'messageText', target.message_text,
    'sourceMetadata', target.source_metadata,
    'attemptCount', target.attempt_count, 'media', media_value,
    'alreadyMaterialized', exists (
      select 1 from public.telegram_zagulyaky_candidates candidate_row
      where candidate_row.intake_id = target.id
    )
  );
end;
$function$;

-- Unlinking must also eliminate the temporary, still-unclassified material.
-- Completed notes and drafts remain private account data as before.
create or replace function security_private.unlink_my_telegram_account_v1()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  -- Match the selector/enqueue lock order: account link first, then an
  -- intake. This prevents a concurrent callback from deadlocking unlink.
  perform 1
  from public.telegram_account_links
  where owner_id = current_user_id
  for update;
  delete from public.telegram_link_tokens where owner_id = current_user_id and consumed_at is null;
  delete from public.telegram_intakes
  where owner_id = current_user_id and status = 'awaiting_choice';
  update public.telegram_intakes
  set status = 'rejected', completed_at = now(), claim_token = null,
      claimed_by = null, claimed_at = null, lease_expires_at = null,
      last_error_code = 'TELEGRAM_LINK_REVOKED'
  where owner_id = current_user_id
    and status in ('queued', 'retry', 'processing', 'materialized');
  delete from public.telegram_account_links where owner_id = current_user_id;
end;
$function$;

create or replace function public.service_choose_telegram_intake_intent_v1(
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_choice_token uuid,
  p_intent text
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_choose_telegram_intake_intent_v1($1,$2,$3,$4) $$;

create or replace function public.service_get_telegram_pending_choice_v1(
  p_telegram_user_id bigint,
  p_private_chat_id bigint
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_get_telegram_pending_choice_v1($1,$2) $$;

revoke all on function security_private.expire_telegram_pending_choice_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.service_get_telegram_pending_choice_v1(bigint,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_get_telegram_pending_choice_v1(bigint,bigint)
  from public, anon, authenticated, service_role;

grant execute on function security_private.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  to service_role;
grant execute on function security_private.service_get_telegram_pending_choice_v1(bigint,bigint)
  to service_role;
grant execute on function public.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  to service_role;
grant execute on function public.service_get_telegram_pending_choice_v1(bigint,bigint)
  to service_role;

notify pgrst, 'reload schema';
commit;
