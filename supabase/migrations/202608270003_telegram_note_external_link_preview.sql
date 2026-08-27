begin;

-- External page previews are prepared by the trusted Telegram Edge Function
-- only after the original private Note has been durably materialized.  Keep
-- the privileged update outside the exposed API schema and fence it to the
-- exact note/intake/source tuple.  The URL-only predicates are intentional:
-- a delayed preview must never overwrite a title or body the owner has
-- already edited.
create or replace function security_private.service_apply_telegram_note_preview_v1(
  p_note_id uuid,
  p_source_url text,
  p_title text,
  p_body_text text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  normalized_url text := nullif(security_private.telegram_safe_text_v1(p_source_url, 2048), '');
  normalized_title text := security_private.telegram_safe_text_v1(p_title, 240, true);
  normalized_body text := security_private.telegram_safe_text_v1(p_body_text, 12000, true);
  updated_note_id uuid;
begin
  if p_note_id is null or normalized_url is null
    or normalized_url !~* '^https?://'
    or position(normalized_url in normalized_body) = 0 then
    raise exception 'TELEGRAM_NOTE_PREVIEW_INVALID' using errcode = '22023';
  end if;

  update public.telegram_saved_notes as note
  set title = normalized_title,
      body_text = normalized_body,
      updated_at = clock_timestamp()
  from public.telegram_intakes as intake
  where note.id = p_note_id
    and note.intake_id = intake.id
    and note.owner_id = intake.owner_id
    and intake.intent = 'note'
    and intake.status = 'completed'
    and note.source_platform in ('web', 'facebook')
    and note.source_metadata = '{}'::jsonb
    and note.source_url = normalized_url
    and note.body_text = intake.message_text
    and note.title = left(
      coalesce(
        nullif(btrim(regexp_replace(intake.message_text, '[[:space:]]+', ' ', 'g')), ''),
        note.source_url,
        'Нова нотатка'
      ),
      240
    )
  returning note.id into updated_note_id;

  return jsonb_build_object(
    'updated', updated_note_id is not null,
    'noteId', updated_note_id
  );
end;
$function$;

create or replace function public.service_apply_telegram_note_preview_v1(
  p_note_id uuid,
  p_source_url text,
  p_title text,
  p_body_text text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.service_apply_telegram_note_preview_v1($1, $2, $3, $4);
$function$;

revoke all on function security_private.service_apply_telegram_note_preview_v1(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_apply_telegram_note_preview_v1(uuid,text,text,text)
  from public, anon, authenticated, service_role;

grant execute on function security_private.service_apply_telegram_note_preview_v1(uuid,text,text,text)
  to service_role;
grant execute on function public.service_apply_telegram_note_preview_v1(uuid,text,text,text)
  to service_role;

notify pgrst, 'reload schema';
commit;
