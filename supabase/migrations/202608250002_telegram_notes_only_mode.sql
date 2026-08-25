begin;

-- Temporary product mode: Telegram remains a private capture channel for
-- Notes only.  Keep all already-created Zagulyaky cards and drafts intact,
-- but prevent any unfinished or stale Telegram job from creating more.
update public.telegram_account_links
set ai_opt_in = false,
    active_mode = 'note'
where ai_opt_in = true
   or active_mode <> 'note';

update public.telegram_link_tokens
set ai_opt_in = false
where consumed_at is null
  and ai_opt_in = true;

-- Do not delete the intake, candidates or an existing private draft.  The
-- terminal status preserves the private audit trail while stops the worker
-- from claiming queued/retry work or finishing a stale materialization.
update public.telegram_intakes
set status = 'rejected',
    completed_at = coalesce(completed_at, clock_timestamp()),
    next_attempt_at = clock_timestamp(),
    claim_token = null,
    claimed_by = null,
    claimed_at = null,
    lease_expires_at = null,
    last_error_code = 'TELEGRAM_ZAGULYAKA_DISABLED'
where intent = 'zagulyaka'
  and status in ('queued', 'retry', 'processing', 'materialized');

-- Stale browser builds must not be able to re-enable the retired AI mode.
-- The public compatibility facade intentionally ignores p_ai_opt_in while
-- retaining the existing caller-authentication contract.
create or replace function public.create_my_telegram_link_v1(p_ai_opt_in boolean default false)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $$ select security_private.create_my_telegram_link_v1(false) $$;

create or replace function public.set_my_telegram_ai_opt_in_v1(p_ai_opt_in boolean)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $$ select security_private.set_my_telegram_ai_opt_in_v1(false) $$;

-- Never retain a new Telegram media id while the bot is in Notes-only mode.
-- A new Edge build also auto-selects Note; this facade makes old webhook
-- deployments safe during the rollout window.
create or replace function public.service_enqueue_telegram_message_v1(
  p_update_id bigint,
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_message_id bigint,
  p_message_text text default '',
  p_media jsonb default null,
  p_source_metadata jsonb default '{}'::jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $$ select security_private.service_enqueue_telegram_message_v1($1,$2,$3,$4,$5,null,$7) $$;

-- Old inline buttons can remain in Telegram chats.  A Zagulyaka click is a
-- normal, non-retryable response rather than a database error or queue job.
create or replace function public.service_choose_telegram_intake_intent_v1(
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_choice_token uuid,
  p_intent text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if lower(btrim(coalesce(p_intent, ''))) = 'zagulyaka' then
    return jsonb_build_object(
      'linked', exists(
        select 1
        from public.telegram_account_links link_row
        where link_row.telegram_user_id = p_telegram_user_id
          and link_row.private_chat_id = p_private_chat_id
      ),
      'selected', false,
      'reason', 'zagulyaka_disabled'
    );
  end if;
  return security_private.service_choose_telegram_intake_intent_v1(
    p_telegram_user_id,
    p_private_chat_id,
    p_choice_token,
    p_intent
  );
end;
$function$;

create or replace function public.service_set_telegram_active_mode_v1(
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_mode text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if lower(btrim(coalesce(p_mode, ''))) = 'zagulyaka' then
    update public.telegram_account_links
    set active_mode = 'note',
        ai_opt_in = false
    where telegram_user_id = p_telegram_user_id
      and private_chat_id = p_private_chat_id;
    return jsonb_build_object(
      'linked', found,
      'mode', 'note',
      'reason', 'zagulyaka_disabled'
    );
  end if;
  return security_private.service_set_telegram_active_mode_v1(
    p_telegram_user_id,
    p_private_chat_id,
    'note'
  );
end;
$function$;

-- These wrappers make a deployed worker from an earlier release harmless.
-- They return shapes the old worker accepts, so it does not retry or create a
-- database error loop while the updated worker is being deployed.
create or replace function public.service_complete_telegram_zagulyaka_v1(
  p_intake_id uuid,
  p_claim_token uuid,
  p_candidates jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $function$
begin
  update public.telegram_intakes
  set status = 'rejected',
      completed_at = coalesce(completed_at, clock_timestamp()),
      next_attempt_at = clock_timestamp(),
      claim_token = null,
      claimed_by = null,
      claimed_at = null,
      lease_expires_at = null,
      last_error_code = 'TELEGRAM_ZAGULYAKA_DISABLED'
  where id = p_intake_id
    and intent = 'zagulyaka'
    and (
      status in ('queued', 'retry')
      or (
        status in ('processing', 'materialized')
        and claim_token is not distinct from p_claim_token
      )
    );
  return jsonb_build_object(
    'status', 'rejected',
    'recordIds', '[]'::jsonb,
    'candidateCount', 0,
    'reason', 'zagulyaka_disabled'
  );
end;
$function$;

create or replace function public.service_reserve_telegram_media_attachment_v1(
  p_intake_id uuid,
  p_claim_token uuid,
  p_media_id uuid,
  p_record_id uuid,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'status', 'attached',
    'attachmentId', p_record_id,
    'storagePath', 'telegram-disabled/' || coalesce(p_media_id::text, 'not-set'),
    'reservationToken', null,
    'reason', 'zagulyaka_disabled'
  )
$$;

create or replace function public.service_attach_telegram_media_to_zagulyaka_v1(
  p_intake_id uuid,
  p_claim_token uuid,
  p_media_id uuid,
  p_record_id uuid,
  p_reservation_token uuid,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $$ select jsonb_build_object('status', 'rejected', 'reason', 'zagulyaka_disabled') $$;

create or replace function public.service_finalize_telegram_zagulyaka_v1(
  p_intake_id uuid,
  p_claim_token uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $$ select jsonb_build_object('status', 'rejected', 'reason', 'zagulyaka_disabled') $$;

revoke all on function public.create_my_telegram_link_v1(boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.set_my_telegram_ai_opt_in_v1(boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.service_enqueue_telegram_message_v1(bigint,bigint,bigint,bigint,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_set_telegram_active_mode_v1(bigint,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_complete_telegram_zagulyaka_v1(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.service_reserve_telegram_media_attachment_v1(uuid,uuid,uuid,uuid,text,text,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_attach_telegram_media_to_zagulyaka_v1(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_finalize_telegram_zagulyaka_v1(uuid,uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.create_my_telegram_link_v1(boolean)
  to authenticated, service_role;
grant execute on function public.set_my_telegram_ai_opt_in_v1(boolean)
  to authenticated, service_role;
grant execute on function public.service_enqueue_telegram_message_v1(bigint,bigint,bigint,bigint,text,jsonb,jsonb)
  to service_role;
grant execute on function public.service_choose_telegram_intake_intent_v1(bigint,bigint,uuid,text)
  to service_role;
grant execute on function public.service_set_telegram_active_mode_v1(bigint,bigint,text)
  to service_role;
grant execute on function public.service_complete_telegram_zagulyaka_v1(uuid,uuid,jsonb)
  to service_role;
grant execute on function public.service_reserve_telegram_media_attachment_v1(uuid,uuid,uuid,uuid,text,text,bigint,text)
  to service_role;
grant execute on function public.service_attach_telegram_media_to_zagulyaka_v1(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text)
  to service_role;
grant execute on function public.service_finalize_telegram_zagulyaka_v1(uuid,uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;
