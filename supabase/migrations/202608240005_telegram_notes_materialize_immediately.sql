begin;

-- A text/link note does not need AI or a background worker.  Materialize it
-- within the same transaction that consumes the one-time Telegram choice, so
-- the bot never says “sent to Notes” while the item is merely waiting in an
-- external scheduler.  The queue remains the only path for AI Zagulyaka
-- drafts and continues to process legacy queued note rows.
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
  note_claim_token uuid;
  note_metadata jsonb := '{}'::jsonb;
  note_source_url text;
  note_source_platform text := 'other';
  note_source_label text;
  note_title text;
  note_result jsonb;
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
  -- button cannot reroute an already private record.
  if intake_row.status <> 'awaiting_choice' or intake_row.intent <> 'pending_choice' then
    if intake_row.intent = normalized_intent then
      return jsonb_build_object(
        'linked', true, 'selected', true, 'duplicate', true, 'intent', intake_row.intent,
        'materialized', intake_row.status = 'completed'
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
  -- discarded before materialization. Any other photo remains pending so the
  -- owner can choose Zagulyaka without re-sending it.
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

  if normalized_intent = 'note' then
    -- Forward provenance was already narrowed and validated on receipt. It
    -- takes priority over any outbound link quoted in the forwarded post.
    note_metadata := security_private.telegram_source_metadata_v1(intake_row.source_metadata);
    if note_metadata <> '{}'::jsonb then
      note_source_url := nullif(note_metadata ->> 'publicPermalink', '');
      note_source_platform := 'telegram';
      if coalesce(note_metadata ->> 'originType', '') in ('channel', 'chat') then
        note_source_label := nullif(
          security_private.telegram_safe_text_v1(note_metadata ->> 'sourceTitle', 300),
          ''
        );
      end if;
    else
      -- Directly shared http(s) links stay useful as a clickable source. Do
      -- not promote a URL that looks credential-bearing into source_url.
      note_source_url := nullif((regexp_match(
        intake_row.message_text,
        'https?://[^[:space:]<>"''`]+',
        'i'
      ))[1], '');
      note_source_url := nullif(rtrim(coalesce(note_source_url, ''), '),.;:!?}]'), '');
      if note_source_url is not null and (
        char_length(note_source_url) > 2048
        or note_source_url !~* '^https?://[^/@[:space:]]+(/|$)'
        or note_source_url ~* '[?&](token|signature|secret|key|authorization|credential)='
      ) then
        note_source_url := null;
      end if;
      if note_source_url ~* '^https?://(www[.])?(t[.]me|telegram[.]me|telegram[.]org)(/|$)' then
        note_source_platform := 'telegram';
      elsif note_source_url ~* '^https?://(www[.])?(facebook[.]com|fb[.]com|fb[.]watch)(/|$)' then
        note_source_platform := 'facebook';
      elsif note_source_url is not null then
        note_source_platform := 'web';
      end if;
    end if;

    note_title := left(
      coalesce(
        nullif(btrim(regexp_replace(intake_row.message_text, '[[:space:]]+', ' ', 'g')), ''),
        note_source_label,
        note_source_url,
        'Нова нотатка'
      ),
      240
    );
    note_claim_token := gen_random_uuid();

    -- Reuse the fenced completion RPC: it validates and writes the owner-only
    -- note atomically, then marks this intake completed before this callback
    -- returns to Telegram.
    update public.telegram_intakes
    set intent = 'note',
        status = 'processing',
        choice_expires_at = null,
        next_attempt_at = clock_timestamp(),
        claim_token = note_claim_token,
        claimed_by = 'telegram-webhook',
        claimed_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + interval '60 seconds',
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

    select security_private.service_complete_telegram_note_v1(
      intake_row.id,
      note_claim_token,
      note_title,
      intake_row.message_text,
      note_source_url,
      note_source_platform,
      note_source_label,
      note_metadata
    ) into note_result;

    return jsonb_build_object(
      'linked', true, 'selected', true, 'duplicate', false,
      'intent', 'note', 'mediaOmitted', media_omitted,
      'materialized', true, 'noteId', note_result ->> 'noteId'
    );
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
    'intent', normalized_intent, 'mediaOmitted', media_omitted,
    'materialized', false
  );
end;
$function$;

revoke all on function security_private.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  from public, anon, authenticated, service_role;

grant execute on function security_private.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  to service_role;
grant execute on function public.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  to service_role;

notify pgrst, 'reload schema';
commit;
