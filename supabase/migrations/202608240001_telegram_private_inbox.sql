begin;

-- Telegram is an account-level private capture channel.  It is deliberately
-- separate from projects, Stage-0 imports and public Zagulyaky sources: a bot
-- update can contain a private chat, an unpublished photo or a link that must
-- never become catalogue data by accident.

create table if not exists public.telegram_account_links (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique,
  private_chat_id bigint not null,
  telegram_username text check (telegram_username is null or char_length(telegram_username) <= 128),
  display_name text check (display_name is null or char_length(display_name) <= 256),
  active_mode text not null default 'note' check (active_mode in ('note', 'zagulyaka')),
  ai_opt_in boolean not null default false,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists telegram_account_links_private_chat_idx
  on public.telegram_account_links(private_chat_id);

create table if not exists public.telegram_link_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  ai_opt_in boolean not null default false,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '1 hour')
);

create index if not exists telegram_link_tokens_owner_active_idx
  on public.telegram_link_tokens(owner_id, expires_at desc)
  where consumed_at is null;

-- A browser double-click or two tabs must not create two usable /start
-- codes for the same account.  The creator also takes an advisory lock, but
-- this index remains the durable final guard.
create unique index if not exists telegram_link_tokens_one_active_owner_idx
  on public.telegram_link_tokens(owner_id)
  where consumed_at is null;

create table if not exists public.telegram_intakes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  telegram_update_id bigint not null unique,
  telegram_user_id bigint not null,
  private_chat_id bigint not null,
  telegram_message_id bigint not null,
  intent text not null check (intent in ('note', 'zagulyaka')),
  message_text text not null default '' check (char_length(message_text) <= 12000),
  -- Trusted, normalized forwarding context from the Telegram webhook. This
  -- retains a public-channel permalink and a human-readable origin label
  -- without storing private chat IDs or raw Telegram update payloads.
  source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object' and octet_length(source_metadata::text) <= 4096),
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'materialized', 'retry', 'completed', 'failed', 'rejected'
  )),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  claimed_by text check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9._:-]{1,120}$'),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  result_count integer not null default 0 check (result_count >= 0),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{3,100}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_intakes_owner_created_idx
  on public.telegram_intakes(owner_id, created_at desc);
create index if not exists telegram_intakes_queue_idx
  on public.telegram_intakes(status, next_attempt_at, created_at, id)
  where status in ('queued', 'retry');
create index if not exists telegram_intakes_lease_idx
  on public.telegram_intakes(lease_expires_at)
  where status in ('processing', 'materialized');

create table if not exists public.telegram_intake_media (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references public.telegram_intakes(id) on delete cascade,
  telegram_file_id text not null check (char_length(telegram_file_id) between 1 and 512),
  telegram_file_unique_id text not null check (char_length(telegram_file_unique_id) between 1 and 512),
  file_name text not null default 'telegram-photo' check (char_length(file_name) between 1 and 255),
  declared_mime_type text,
  declared_byte_size bigint check (declared_byte_size is null or declared_byte_size between 1 and 20971520),
  actual_mime_type text,
  actual_byte_size bigint check (actual_byte_size is null or actual_byte_size between 1 and 20971520),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'attached', 'rejected', 'failed')),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{3,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intake_id, telegram_file_unique_id),
  check (
    (status = 'attached' and actual_mime_type is not null
      and actual_byte_size is not null and sha256 is not null)
    or status <> 'attached'
  )
);

create index if not exists telegram_intake_media_intake_idx
  on public.telegram_intake_media(intake_id, created_at, id);

-- A single Telegram photo may be evidence for several separate person or
-- document drafts.  This relation keeps that private provenance without
-- exposing Telegram identifiers through public catalogue sources.
create table if not exists public.telegram_intake_media_attachments (
  intake_media_id uuid not null references public.telegram_intake_media(id) on delete cascade,
  record_id uuid not null references public.zagulyaky_records(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- A reservation is written before the worker uploads.  The durable fence
  -- below outlives this FK row, so an upload that loses its record/account
  -- midway through can still be removed without ever reusing its path.
  storage_path text not null check (char_length(storage_path) between 3 and 500 and position('..' in storage_path) = 0),
  reservation_token uuid not null,
  upload_lease_expires_at timestamptz not null,
  file_name text not null check (char_length(file_name) between 1 and 240),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size between 1 and 20971520),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'attached')),
  attachment_id uuid references public.zagulyaky_attachments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (intake_media_id, record_id),
  unique (attachment_id),
  unique (storage_path),
  check ((status = 'attached' and attachment_id is not null) or (status = 'pending' and attachment_id is null)),
  check (storage_path like (owner_id::text || '/' || record_id::text || '/%'))
);

-- Do not add foreign keys here.  A pending object can finish uploading after
-- its intake, draft or account was deleted.  This fence is the remaining
-- authority to remove that object, and its unguessable reservation token
-- prevents a stale worker from touching a later upload.
create table if not exists public.telegram_media_upload_fences (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null,
  intake_media_id uuid not null,
  record_id uuid not null,
  owner_id uuid not null,
  storage_path text not null unique check (
    char_length(storage_path) between 3 and 500
    and position('..' in storage_path) = 0
    and storage_path like (owner_id::text || '/' || record_id::text || '/%')
  ),
  reservation_token uuid not null unique,
  intake_claim_token uuid not null,
  upload_lease_expires_at timestamptz not null,
  cleanup_status text not null default 'reserved'
    check (cleanup_status in ('reserved', 'cleanup_requested', 'cleanup_processing')),
  cleanup_requested_at timestamptz,
  cleanup_next_attempt_at timestamptz,
  cleanup_claim_token uuid,
  cleanup_lease_expires_at timestamptz,
  cleanup_attempt_count integer not null default 0 check (cleanup_attempt_count between 0 and 1000),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{3,100}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (cleanup_status = 'reserved'
      and cleanup_requested_at is null and cleanup_next_attempt_at is null
      and cleanup_claim_token is null and cleanup_lease_expires_at is null)
    or (cleanup_status = 'cleanup_requested'
      and cleanup_requested_at is not null and cleanup_next_attempt_at is not null
      and cleanup_claim_token is null and cleanup_lease_expires_at is null)
    or (cleanup_status = 'cleanup_processing'
      and cleanup_requested_at is not null and cleanup_next_attempt_at is null
      and cleanup_claim_token is not null and cleanup_lease_expires_at is not null)
  )
);

create index if not exists telegram_media_upload_fences_cleanup_due_idx
  on public.telegram_media_upload_fences(cleanup_status, cleanup_next_attempt_at, created_at, id)
  where cleanup_status = 'cleanup_requested';
create index if not exists telegram_media_upload_fences_cleanup_lease_idx
  on public.telegram_media_upload_fences(cleanup_lease_expires_at)
  where cleanup_status = 'cleanup_processing';
create index if not exists telegram_media_upload_fences_intake_idx
  on public.telegram_media_upload_fences(intake_id, intake_claim_token, upload_lease_expires_at);

create table if not exists public.telegram_saved_notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  intake_id uuid unique references public.telegram_intakes(id) on delete set null,
  title text not null check (char_length(title) between 1 and 240),
  body_text text not null default '' check (char_length(body_text) <= 12000),
  source_url text check (source_url is null or (char_length(source_url) <= 2048 and source_url ~* '^https?://')),
  source_platform text not null default 'other' check (source_platform in ('telegram', 'facebook', 'web', 'other')),
  -- Unlike a manually editable title, these fields preserve the original
  -- forwarded channel/page label and the narrow, normalized forward context.
  source_label text check (source_label is null or char_length(source_label) between 1 and 300),
  source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object' and octet_length(source_metadata::text) <= 4096),
  status text not null default 'inbox' check (status in ('inbox', 'reviewing', 'saved', 'archived', 'converted')),
  source_status text not null default 'unverified' check (source_status in ('unverified', 'available', 'unavailable', 'changed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_saved_notes_owner_filter_idx
  on public.telegram_saved_notes(owner_id, status, priority, updated_at desc, id);
create index if not exists telegram_saved_notes_owner_source_idx
  on public.telegram_saved_notes(owner_id, source_platform, source_status, updated_at desc, id);

-- This durable, service-only marker deliberately has no foreign key to
-- auth.users.  It lets the profile-delete trigger find private Telegram
-- drafts even when an administrator deletes auth.users directly and Postgres
-- cascades the candidate rows before the profile trigger has inspected them.
create table if not exists public.telegram_zagulyaky_draft_origins (
  record_id uuid primary key references public.zagulyaky_records(id) on delete cascade,
  owner_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists telegram_zagulyaky_draft_origins_owner_idx
  on public.telegram_zagulyaky_draft_origins(owner_id, record_id);

create table if not exists public.telegram_zagulyaky_candidates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  intake_id uuid not null references public.telegram_intakes(id) on delete cascade,
  candidate_key text not null check (candidate_key ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('person', 'document')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  status text not null default 'materialized' check (status in ('materialized', 'rejected')),
  draft_input jsonb not null check (jsonb_typeof(draft_input) = 'object'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  materialized_record_id uuid references public.zagulyaky_records(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intake_id, candidate_key),
  check ((status = 'materialized' and materialized_record_id is not null) or status = 'rejected')
);

create index if not exists telegram_zagulyaky_candidates_owner_idx
  on public.telegram_zagulyaky_candidates(owner_id, created_at desc, id);
create index if not exists telegram_zagulyaky_candidates_record_idx
  on public.telegram_zagulyaky_candidates(materialized_record_id)
  where materialized_record_id is not null;

drop trigger if exists telegram_account_links_set_updated_at on public.telegram_account_links;
create trigger telegram_account_links_set_updated_at
before update on public.telegram_account_links
for each row execute function public.set_updated_at();

drop trigger if exists telegram_intakes_set_updated_at on public.telegram_intakes;
create trigger telegram_intakes_set_updated_at
before update on public.telegram_intakes
for each row execute function public.set_updated_at();

drop trigger if exists telegram_intake_media_set_updated_at on public.telegram_intake_media;
create trigger telegram_intake_media_set_updated_at
before update on public.telegram_intake_media
for each row execute function public.set_updated_at();

drop trigger if exists telegram_media_upload_fences_set_updated_at on public.telegram_media_upload_fences;
create trigger telegram_media_upload_fences_set_updated_at
before update on public.telegram_media_upload_fences
for each row execute function public.set_updated_at();

drop trigger if exists telegram_saved_notes_set_updated_at on public.telegram_saved_notes;
create trigger telegram_saved_notes_set_updated_at
before update on public.telegram_saved_notes
for each row execute function public.set_updated_at();

drop trigger if exists telegram_zagulyaky_candidates_set_updated_at on public.telegram_zagulyaky_candidates;
create trigger telegram_zagulyaky_candidates_set_updated_at
before update on public.telegram_zagulyaky_candidates
for each row execute function public.set_updated_at();

-- Bot data stays inaccessible to direct browser queries.  The authenticated
-- API is composed only of narrow owner-scoped functions below.
alter table public.telegram_account_links enable row level security;
alter table public.telegram_link_tokens enable row level security;
alter table public.telegram_intakes enable row level security;
alter table public.telegram_intake_media enable row level security;
alter table public.telegram_intake_media_attachments enable row level security;
alter table public.telegram_media_upload_fences enable row level security;
alter table public.telegram_saved_notes enable row level security;
alter table public.telegram_zagulyaky_draft_origins enable row level security;
alter table public.telegram_zagulyaky_candidates enable row level security;

revoke all on table public.telegram_account_links from public, anon, authenticated;
revoke all on table public.telegram_link_tokens from public, anon, authenticated;
revoke all on table public.telegram_intakes from public, anon, authenticated;
revoke all on table public.telegram_intake_media from public, anon, authenticated;
revoke all on table public.telegram_intake_media_attachments from public, anon, authenticated;
revoke all on table public.telegram_media_upload_fences from public, anon, authenticated;
revoke all on table public.telegram_saved_notes from public, anon, authenticated;
revoke all on table public.telegram_zagulyaky_draft_origins from public, anon, authenticated;
revoke all on table public.telegram_zagulyaky_candidates from public, anon, authenticated;
grant all on table public.telegram_account_links to service_role;
grant all on table public.telegram_link_tokens to service_role;
grant all on table public.telegram_intakes to service_role;
grant all on table public.telegram_intake_media to service_role;
grant all on table public.telegram_intake_media_attachments to service_role;
grant all on table public.telegram_media_upload_fences to service_role;
grant all on table public.telegram_saved_notes to service_role;
grant all on table public.telegram_zagulyaky_draft_origins to service_role;
grant all on table public.telegram_zagulyaky_candidates to service_role;

-- Photos are never written to a Telegram-only bucket.  After validation the
-- worker puts every accepted image directly into the existing owner-scoped
-- `zagulyaky-private/<owner>/<record>/...` location, then records it as a
-- normal private draft attachment.  That reuses the established delivery and
-- cleanup workflow instead of leaving a second, orphan-prone media store.

create or replace function security_private.telegram_sha256_v1(p_value text)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  digest_value text;
begin
  if p_value is null then
    raise exception 'TELEGRAM_HASH_INPUT_REQUIRED' using errcode = '22023';
  end if;
  if to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute 'select encode(extensions.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into digest_value using p_value;
  elsif to_regprocedure('public.digest(bytea,text)') is not null then
    execute 'select encode(public.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into digest_value using p_value;
  else
    raise exception 'PGCRYPTO_DIGEST_REQUIRED' using errcode = '55000';
  end if;
  return digest_value;
end;
$function$;

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
  if p_maximum < 1 then
    raise exception 'TELEGRAM_TEXT_LIMIT_INVALID' using errcode = '22023';
  end if;
  if position(chr(0) in normalized) > 0 or char_length(normalized) > p_maximum then
    raise exception 'TELEGRAM_TEXT_INVALID' using errcode = '22023';
  end if;
  if p_required and normalized = '' then
    raise exception 'TELEGRAM_TEXT_REQUIRED' using errcode = '22023';
  end if;
  return normalized;
end;
$function$;

-- Forward origin data comes from Telegram's `forward_origin` object. Keep a
-- deliberately small allow-list: a saved note needs a label and, for public
-- channels only, a canonical permalink. Private chat/channel identifiers and
-- arbitrary webhook payload fields must never be retained here.
create or replace function security_private.telegram_source_metadata_v1(p_value jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  source_value jsonb := coalesce(p_value, '{}'::jsonb);
  forwarded_value jsonb;
  origin_type_value text;
  source_title_value text;
  source_username_value text;
  source_chat_type_value text;
  source_message_id_value bigint;
  public_permalink_value text;
begin
  if jsonb_typeof(source_value) <> 'object' or octet_length(source_value::text) > 4096 then
    raise exception 'TELEGRAM_SOURCE_METADATA_INVALID' using errcode = '22023';
  end if;

  forwarded_value := source_value -> 'forwarded';
  if forwarded_value is null then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(forwarded_value) <> 'boolean' then
    raise exception 'TELEGRAM_SOURCE_METADATA_INVALID' using errcode = '22023';
  end if;
  if not coalesce((source_value ->> 'forwarded')::boolean, false) then
    return '{}'::jsonb;
  end if;

  if (source_value ? 'originType' and jsonb_typeof(source_value -> 'originType') not in ('string', 'null'))
    or (source_value ? 'sourceTitle' and jsonb_typeof(source_value -> 'sourceTitle') not in ('string', 'null'))
    or (source_value ? 'sourceUsername' and jsonb_typeof(source_value -> 'sourceUsername') not in ('string', 'null'))
    or (source_value ? 'sourceChatType' and jsonb_typeof(source_value -> 'sourceChatType') not in ('string', 'null'))
    or (source_value ? 'originalPlatform' and jsonb_typeof(source_value -> 'originalPlatform') not in ('string', 'null'))
    or (source_value ? 'publicPermalink' and jsonb_typeof(source_value -> 'publicPermalink') not in ('string', 'null'))
    or (source_value ? 'originalMessageId' and jsonb_typeof(source_value -> 'originalMessageId') not in ('number', 'null')) then
    raise exception 'TELEGRAM_SOURCE_METADATA_INVALID' using errcode = '22023';
  end if;

  origin_type_value := lower(security_private.telegram_safe_text_v1(source_value ->> 'originType', 20));
  if origin_type_value not in ('channel', 'chat', 'user', 'hidden_user') then origin_type_value := ''; end if;
  source_title_value := nullif(security_private.telegram_safe_text_v1(source_value ->> 'sourceTitle', 300), '');
  source_username_value := regexp_replace(
    security_private.telegram_safe_text_v1(source_value ->> 'sourceUsername', 64), '^@+', ''
  );
  if source_username_value !~ '^[A-Za-z][A-Za-z0-9_]{4,63}$' then source_username_value := ''; end if;
  source_chat_type_value := lower(security_private.telegram_safe_text_v1(source_value ->> 'sourceChatType', 20));
  if source_chat_type_value not in ('channel', 'group', 'supergroup', 'private') then source_chat_type_value := ''; end if;
  public_permalink_value := nullif(security_private.telegram_safe_text_v1(source_value ->> 'publicPermalink', 2048), '');
  -- The worker constructs only this public form from a public username and a
  -- message ID. Never turn private `t.me/c/...` or invite links into a source.
  if public_permalink_value !~* '^https://t[.]me/[A-Za-z][A-Za-z0-9_]{4,63}/[1-9][0-9]{0,18}$' then
    public_permalink_value := '';
  end if;

  -- A forwarded person's/profile's details and a private chat title are not
  -- needed to save a bookmark. Retain human-readable provenance only for a
  -- channel or a Telegram group/supergroup.
  if origin_type_value not in ('channel', 'chat')
    or (origin_type_value = 'chat' and source_chat_type_value not in ('channel', 'group', 'supergroup')) then
    source_title_value := null;
    source_username_value := '';
    source_chat_type_value := '';
    public_permalink_value := '';
  elsif origin_type_value = 'channel' then
    source_chat_type_value := 'channel';
  else
    -- Telegram only provides a safe canonical post permalink for a public
    -- channel; never fabricate a public URL for a group/chat forward.
    public_permalink_value := '';
  end if;

  if source_value ? 'originalMessageId' and jsonb_typeof(source_value -> 'originalMessageId') = 'number' then
    if source_value ->> 'originalMessageId' !~ '^[1-9][0-9]{0,18}$' then
      raise exception 'TELEGRAM_SOURCE_METADATA_INVALID' using errcode = '22023';
    end if;
    begin
      source_message_id_value := (source_value ->> 'originalMessageId')::bigint;
    exception when numeric_value_out_of_range then
      raise exception 'TELEGRAM_SOURCE_METADATA_INVALID' using errcode = '22023';
    end;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'forwarded', true,
    'originType', nullif(origin_type_value, ''),
    'sourceTitle', source_title_value,
    'sourceUsername', nullif(source_username_value, ''),
    'sourceChatType', nullif(source_chat_type_value, ''),
    'originalPlatform', 'telegram',
    'originalMessageId', source_message_id_value,
    'publicPermalink', nullif(public_permalink_value, '')
  ));
end;
$function$;

create or replace function security_private.telegram_link_code_v1()
returns text
language sql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$function$;

-- Existing Zagulyaky attachment cleanup starts from a persisted attachment
-- row. Telegram has an earlier upload interval, so its own fence is retained
-- until an attachment is atomically linked or a service worker removes it.
create or replace function security_private.enqueue_telegram_pending_attachment_cleanup_v1(
  p_record_id uuid,
  p_owner_id uuid,
  p_storage_path text,
  p_reservation_token uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  normalized_path text := security_private.telegram_safe_text_v1(p_storage_path, 500, true);
begin
  if p_record_id is null or p_owner_id is null or p_reservation_token is null
    or left(normalized_path, char_length(p_owner_id::text || '/' || p_record_id::text || '/'))
      <> p_owner_id::text || '/' || p_record_id::text || '/'
    or normalized_path like '/%' or normalized_path like '%..%' then
    raise exception 'TELEGRAM_MEDIA_CLEANUP_PATH_INVALID' using errcode = '22023';
  end if;
  update public.telegram_media_upload_fences fence
  set cleanup_status = case
        when fence.cleanup_status = 'cleanup_processing' then 'cleanup_processing'
        else 'cleanup_requested'
      end,
      cleanup_requested_at = coalesce(fence.cleanup_requested_at, clock_timestamp()),
      cleanup_next_attempt_at = case
        when fence.cleanup_status = 'cleanup_processing' then fence.cleanup_next_attempt_at
        else greatest(fence.upload_lease_expires_at + interval '60 seconds', clock_timestamp())
      end,
      cleanup_claim_token = case
        when fence.cleanup_status = 'cleanup_processing' then fence.cleanup_claim_token else null
      end,
      cleanup_lease_expires_at = case
        when fence.cleanup_status = 'cleanup_processing' then fence.cleanup_lease_expires_at else null
      end,
      last_error_code = null,
      updated_at = clock_timestamp()
  where fence.record_id = p_record_id
    and fence.owner_id = p_owner_id
    and fence.storage_path = normalized_path
    and fence.reservation_token = p_reservation_token;
end;
$function$;

create or replace function security_private.enqueue_telegram_terminal_media_cleanup_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  pending_relation public.telegram_intake_media_attachments;
begin
  if new.status not in ('failed', 'rejected') or old.status = new.status then
    return new;
  end if;
  for pending_relation in
    select relation.*
    from public.telegram_intake_media_attachments relation
    join public.telegram_intake_media media_row on media_row.id = relation.intake_media_id
    where media_row.intake_id = new.id and relation.status = 'pending'
  loop
    perform security_private.enqueue_telegram_pending_attachment_cleanup_v1(
      pending_relation.record_id, pending_relation.owner_id, pending_relation.storage_path,
      pending_relation.reservation_token
    );
  end loop;
  return new;
end;
$function$;

create or replace function security_private.enqueue_telegram_deleted_pending_attachment_cleanup_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if old.status = 'pending' then
    perform security_private.enqueue_telegram_pending_attachment_cleanup_v1(
      old.record_id, old.owner_id, old.storage_path, old.reservation_token
    );
  end if;
  return old;
end;
$function$;

drop trigger if exists telegram_intakes_terminal_media_cleanup on public.telegram_intakes;
create trigger telegram_intakes_terminal_media_cleanup
after update of status on public.telegram_intakes
for each row execute function security_private.enqueue_telegram_terminal_media_cleanup_v1();

drop trigger if exists telegram_pending_attachment_cleanup on public.telegram_intake_media_attachments;
create trigger telegram_pending_attachment_cleanup
before delete on public.telegram_intake_media_attachments
for each row execute function security_private.enqueue_telegram_deleted_pending_attachment_cleanup_v1();

-- `zagulyaky_records.created_by` intentionally becomes NULL when an account
-- goes away, because published historical records remain public.  Telegram
-- drafts are different: they can contain private messages/photos, so remove
-- only the unpublished bot-created records before that attribution is lost.
-- The ordinary attachment cleanup outbox handles attached objects; pending
-- uploads are retained by the no-FK fence through the relation delete trigger.
create or replace function security_private.delete_private_telegram_drafts_on_profile_delete_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  draft_record record;
  attachment_row record;
  source_ids uuid[];
begin
  for draft_record in
    select record_row.id
    from public.zagulyaky_records record_row
    join public.telegram_zagulyaky_draft_origins origin
      on origin.record_id = record_row.id
    where record_row.status <> 'published'
      and origin.owner_id = old.user_id
    for update
  loop
    for attachment_row in
      select attachment.id, attachment.record_id, attachment.created_by,
             attachment.storage_bucket, attachment.storage_path
      from public.zagulyaky_attachments attachment
      where attachment.record_id = draft_record.id
        and attachment.storage_bucket = 'zagulyaky-private'
        and not attachment.is_public_derivative
    loop
      perform security_private.enqueue_zagulyaky_storage_cleanup_v1(
        attachment_row.record_id,
        attachment_row.id,
        coalesce(attachment_row.created_by, old.user_id),
        attachment_row.storage_bucket,
        attachment_row.storage_path
      );
    end loop;

    select coalesce(array_agg(link.source_id), '{}'::uuid[])
    into source_ids
    from public.zagulyaky_record_sources link
    where link.record_id = draft_record.id;

    delete from public.zagulyaky_records where id = draft_record.id;

    delete from public.zagulyaky_sources source_row
    where source_row.id = any(source_ids)
      and not exists (
        select 1 from public.zagulyaky_record_sources remaining
        where remaining.source_id = source_row.id
      );
  end loop;

  -- Published cards deliberately survive account deletion as historical
  -- catalogue material.  Their Telegram origin marker is only a private
  -- cleanup aid, not public provenance, so remove it once it can no longer
  -- be needed and avoid retaining the deleted account UUID.
  delete from public.telegram_zagulyaky_draft_origins
  where owner_id = old.user_id;

  return old;
end;
$function$;

drop trigger if exists profiles_delete_private_telegram_drafts on public.profiles;
create trigger profiles_delete_private_telegram_drafts
before delete on public.profiles
for each row execute function security_private.delete_private_telegram_drafts_on_profile_delete_v1();

create or replace function security_private.create_my_telegram_link_v1(
  p_ai_opt_in boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  link_code text;
  expires_at_value timestamptz := now() + interval '15 minutes';
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_ai_opt_in is null then
    raise exception 'TELEGRAM_AI_OPT_IN_REQUIRED' using errcode = '22023';
  end if;

  -- Serialise code rotation for one account before deleting the previous
  -- code.  The unique partial index above is the secondary guard.
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  -- Only one usable deep-link code exists for an account.  The raw value is
  -- returned once to the browser; the database retains only a hash.
  delete from public.telegram_link_tokens
  where owner_id = current_user_id and consumed_at is null;

  link_code := security_private.telegram_link_code_v1();
  insert into public.telegram_link_tokens(owner_id, token_hash, ai_opt_in, expires_at)
  values (current_user_id, security_private.telegram_sha256_v1(link_code), p_ai_opt_in, expires_at_value);

  return jsonb_build_object(
    'startCode', link_code,
    'expiresAt', expires_at_value,
    'linked', exists(select 1 from public.telegram_account_links where owner_id = current_user_id),
    'aiOptIn', p_ai_opt_in
  );
end;
$function$;

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
      active_mode = case when coalesce(p_ai_opt_in, false) then active_mode else 'note' end
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

create or replace function security_private.get_my_telegram_link_status_v1()
returns jsonb
language plpgsql
stable
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
  select * into link_row from public.telegram_account_links where owner_id = current_user_id;
  if not found then
    return jsonb_build_object('linked', false, 'telegramUsername', null, 'displayName', null, 'linkedAt', null, 'aiOptIn', false);
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
  delete from public.telegram_link_tokens where owner_id = current_user_id and consumed_at is null;
  -- Unlinking is a privacy action: queued/retry work must not be processed
  -- later under a detached Telegram identity.  Already completed private
  -- notes and drafts remain the owner's data.
  update public.telegram_intakes
  set status = 'rejected', completed_at = now(), claim_token = null,
      claimed_by = null, claimed_at = null, lease_expires_at = null,
      last_error_code = 'TELEGRAM_LINK_REVOKED'
  where owner_id = current_user_id
    and status in ('queued', 'retry', 'processing', 'materialized');
  delete from public.telegram_account_links where owner_id = current_user_id;
end;
$function$;

-- The following service-only functions are callable only by a server client
-- that already verified Telegram's webhook secret.  They never trust a
-- Telegram username as an identity.
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
    owner_id, telegram_user_id, private_chat_id, telegram_username, display_name, ai_opt_in, linked_at
  ) values (
    token_row.owner_id, p_telegram_user_id, p_private_chat_id,
    nullif(security_private.telegram_safe_text_v1(p_telegram_username, 128), ''),
    nullif(security_private.telegram_safe_text_v1(p_display_name, 256), ''), token_row.ai_opt_in, now()
  )
  on conflict (owner_id) do update
  set telegram_user_id = excluded.telegram_user_id,
      private_chat_id = excluded.private_chat_id,
      telegram_username = excluded.telegram_username,
      display_name = excluded.display_name,
      ai_opt_in = excluded.ai_opt_in,
      linked_at = now();

  update public.telegram_link_tokens set consumed_at = now() where id = token_row.id;
  return jsonb_build_object('linked', true, 'ownerId', token_row.owner_id);
end;
$function$;

create or replace function security_private.service_set_telegram_active_mode_v1(
  p_telegram_user_id bigint,
  p_private_chat_id bigint,
  p_mode text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  normalized_mode text := lower(security_private.telegram_safe_text_v1(p_mode, 20, true));
  owner_value uuid;
  ai_enabled boolean;
begin
  if normalized_mode not in ('note', 'zagulyaka') then
    raise exception 'TELEGRAM_MODE_INVALID' using errcode = '22023';
  end if;
  select owner_id, ai_opt_in into owner_value, ai_enabled
  from public.telegram_account_links
  where telegram_user_id = p_telegram_user_id and private_chat_id = p_private_chat_id
  for update;
  if owner_value is null then
    return jsonb_build_object('linked', false, 'mode', 'note');
  end if;
  if normalized_mode = 'zagulyaka' and not ai_enabled then
    return jsonb_build_object('linked', true, 'mode', 'note', 'reason', 'ai_not_enabled');
  end if;
  update public.telegram_account_links
  set active_mode = normalized_mode
  where owner_id = owner_value;
  return jsonb_build_object('linked', true, 'mode', normalized_mode);
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
  if normalized_text = '' and (p_media is null or jsonb_typeof(p_media) <> 'object') then
    return jsonb_build_object('linked', true, 'accepted', false, 'reason', 'empty');
  end if;

  active_intent := link_row.active_mode;
  -- Saving a private note never transfers it to a model.  AI opt-in is
  -- required only for the explicit `/zagulyaka` flow.
  if active_intent = 'zagulyaka' and not link_row.ai_opt_in then
    return jsonb_build_object('linked', true, 'accepted', false, 'reason', 'ai_not_enabled');
  end if;
  -- A photo is evidence for a Zagulyaka draft, not an unbounded general
  -- messenger attachment store. A forwarded channel post with a textual
  -- caption is useful as a bookmark, so retain only its text/provenance and
  -- deliberately omit its media. Photo-only forwards and ordinary note
  -- photos remain rejected until the user explicitly selects /zagulyaka.
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
  ) on conflict (telegram_update_id) do nothing
  returning id into intake_id_value;

  if intake_id_value is null then
    return jsonb_build_object('linked', true, 'accepted', true, 'duplicate', true, 'intent', active_intent);
  end if;

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

  -- /zagulyaka affects the next submission only.  A later forwarded link is
  -- safely captured as a note unless the user explicitly switches back.
  if active_intent = 'zagulyaka' then
    update public.telegram_account_links set active_mode = 'note' where owner_id = link_row.owner_id;
  end if;
  return jsonb_build_object(
    'linked', true, 'accepted', true, 'duplicate', false, 'intent', active_intent,
    'intakeId', intake_id_value, 'mediaOmitted', media_omitted
  );
end;
$function$;

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
  token uuid := gen_random_uuid();
  normalized_worker text := security_private.telegram_safe_text_v1(p_worker_id, 120, true);
  media_value jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'TELEGRAM_LEASE_INVALID' using errcode = '22023';
  end if;

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

create or replace function security_private.service_complete_telegram_note_v1(
  p_intake_id uuid,
  p_claim_token uuid,
  p_title text,
  p_body_text text,
  p_source_url text default null,
  p_source_platform text default 'other',
  p_source_label text default null,
  p_source_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  intake_row public.telegram_intakes;
  note_id_value uuid;
  normalized_title text := security_private.telegram_safe_text_v1(p_title, 240, true);
  normalized_body text := security_private.telegram_safe_text_v1(p_body_text, 12000);
  normalized_url text := nullif(security_private.telegram_safe_text_v1(p_source_url, 2048), '');
  normalized_platform text := lower(security_private.telegram_safe_text_v1(p_source_platform, 20, true));
  requested_label text := nullif(security_private.telegram_safe_text_v1(p_source_label, 300), '');
  normalized_label text;
  normalized_metadata jsonb;
begin
  select * into intake_row from public.telegram_intakes where id = p_intake_id for update;
  if not found or intake_row.status <> 'processing' or intake_row.intent <> 'note'
    or intake_row.claim_token is distinct from p_claim_token or intake_row.lease_expires_at < now() then
    raise exception 'TELEGRAM_INTAKE_CLAIM_INVALID' using errcode = '40001';
  end if;
  if normalized_url is not null and normalized_url !~* '^https?://' then
    raise exception 'TELEGRAM_NOTE_URL_INVALID' using errcode = '22023';
  end if;
  if normalized_platform not in ('telegram', 'facebook', 'web', 'other') then
    normalized_platform := 'other';
  end if;
  -- Prefer the source context captured by the webhook. The optional worker
  -- payload only supports legacy queued rows created before that column
  -- existed; it cannot overwrite a captured forward origin.
  normalized_metadata := security_private.telegram_source_metadata_v1(intake_row.source_metadata);
  if normalized_metadata = '{}'::jsonb then
    normalized_metadata := security_private.telegram_source_metadata_v1(p_source_metadata);
  end if;
  if coalesce(normalized_metadata ->> 'originType', '') in ('channel', 'chat') then
    normalized_label := coalesce(
      requested_label,
      nullif(security_private.telegram_safe_text_v1(normalized_metadata ->> 'sourceTitle', 300), '')
    );
  else
    normalized_label := null;
  end if;
  insert into public.telegram_saved_notes(
    owner_id, intake_id, title, body_text, source_url, source_platform, source_label, source_metadata
  ) values (
    intake_row.owner_id, intake_row.id, normalized_title, normalized_body,
    normalized_url, normalized_platform, normalized_label, normalized_metadata
  )
  on conflict (intake_id) do update
  set title = excluded.title,
      body_text = excluded.body_text,
      source_url = excluded.source_url,
      source_platform = excluded.source_platform,
      source_label = excluded.source_label,
      source_metadata = excluded.source_metadata,
      updated_at = now()
  returning id into note_id_value;
  update public.telegram_intakes
  set status = 'completed', result_count = 1, completed_at = now(), claim_token = null,
      lease_expires_at = null, last_error_code = null
  where id = intake_row.id;
  return jsonb_build_object('noteId', note_id_value, 'status', 'completed');
end;
$function$;

create or replace function security_private.telegram_candidate_text_v1(
  p_candidate jsonb,
  p_field text,
  p_maximum integer,
  p_required boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if p_candidate is null or jsonb_typeof(p_candidate) <> 'object' then
    raise exception 'TELEGRAM_CANDIDATE_INVALID' using errcode = '22023';
  end if;
  return security_private.telegram_safe_text_v1(p_candidate ->> p_field, p_maximum, p_required);
end;
$function$;

create or replace function security_private.service_complete_telegram_zagulyaka_v1(
  p_intake_id uuid,
  p_claim_token uuid,
  p_candidates jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  intake_row public.telegram_intakes;
  candidate jsonb;
  candidate_index integer := 0;
  candidate_kind text;
  candidate_confidence numeric;
  candidate_title text;
  candidate_original_text text;
  candidate_normalized_text text;
  candidate_reason text;
  candidate_name text;
  candidate_normalized_name text;
  candidate_gender text;
  candidate_event_type text;
  candidate_event_role text;
  candidate_event_role_custom text;
  candidate_origin_place text;
  candidate_found_place text;
  candidate_official_place text;
  candidate_document_type text;
  candidate_institution text;
  candidate_archive_ref text;
  candidate_page_label text;
  candidate_page_range text;
  candidate_source_title text;
  candidate_source_url text;
  candidate_source_platform text;
  candidate_source_type text;
  candidate_permission_status text;
  candidate_event_date text;
  candidate_year_from integer;
  candidate_year_to integer;
  candidate_possible_living boolean;
  candidate_record_types text[];
  candidate_warnings jsonb;
  candidate_key_value text;
  candidate_row_id uuid;
  record_id_value uuid;
  source_id_value uuid;
  result_records jsonb := '[]'::jsonb;
begin
  select * into intake_row from public.telegram_intakes where id = p_intake_id for update;
  if not found or intake_row.status not in ('processing', 'materialized') or intake_row.intent <> 'zagulyaka'
    or intake_row.claim_token is distinct from p_claim_token or intake_row.lease_expires_at < now() then
    raise exception 'TELEGRAM_INTAKE_CLAIM_INVALID' using errcode = '40001';
  end if;
  -- Repeated delivery after a photo-upload failure must reuse the same drafts
  -- rather than ask the model again or create a second card.  It can happen
  -- after `service_fail_...` changed materialized back to retry/processing.
  if intake_row.status = 'materialized' or exists (
    select 1 from public.telegram_zagulyaky_candidates existing_candidate
    where existing_candidate.intake_id = intake_row.id
  ) then
    select coalesce(jsonb_agg(existing_candidate.materialized_record_id order by existing_candidate.created_at, existing_candidate.id), '[]'::jsonb)
    into result_records
    from public.telegram_zagulyaky_candidates existing_candidate
    where existing_candidate.intake_id = intake_row.id
      and existing_candidate.materialized_record_id is not null;
    update public.telegram_intakes
    set status = 'materialized', result_count = jsonb_array_length(result_records), last_error_code = null
    where id = intake_row.id;
    return jsonb_build_object('status', 'materialized', 'recordIds', result_records, 'candidateCount', jsonb_array_length(result_records));
  end if;
  -- A queued item may have been claimed while its owner unlinked Telegram or
  -- withdrew AI permission.  Never materialize a model result after that.
  if not exists (
    select 1
    from public.telegram_account_links link_row
    where link_row.owner_id = intake_row.owner_id
      and link_row.telegram_user_id = intake_row.telegram_user_id
      and link_row.private_chat_id = intake_row.private_chat_id
      and link_row.ai_opt_in
  ) then
    update public.telegram_intakes
    set status = 'rejected', completed_at = now(), claim_token = null,
        claimed_by = null, claimed_at = null, lease_expires_at = null,
        last_error_code = 'TELEGRAM_AI_PERMISSION_REVOKED'
    where id = intake_row.id;
    return jsonb_build_object('status', 'rejected', 'recordIds', '[]'::jsonb, 'candidateCount', 0);
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 20 then
    raise exception 'TELEGRAM_CANDIDATES_INVALID' using errcode = '22023';
  end if;

  for candidate in select value from jsonb_array_elements(p_candidates) loop
    candidate_index := candidate_index + 1;
    candidate_kind := lower(security_private.telegram_candidate_text_v1(candidate, 'kind', 20, true));
    if candidate_kind not in ('person', 'document') then
      raise exception 'TELEGRAM_CANDIDATE_KIND_INVALID' using errcode = '22023';
    end if;
    if jsonb_typeof(candidate -> 'confidence') <> 'number'
      or coalesce(candidate ->> 'confidence', '') !~ '^(0([.][0-9]+)?|1([.]0+)?)$' then
      raise exception 'TELEGRAM_CANDIDATE_CONFIDENCE_INVALID' using errcode = '22023';
    end if;
    candidate_confidence := (candidate ->> 'confidence')::numeric;
    candidate_title := security_private.telegram_candidate_text_v1(candidate, 'title', 300, false);
    candidate_name := security_private.telegram_candidate_text_v1(candidate, 'originalName', 300, candidate_kind = 'person');
    candidate_normalized_name := security_private.telegram_candidate_text_v1(candidate, 'normalizedNameUk', 300, false);
    candidate_original_text := security_private.telegram_candidate_text_v1(candidate, 'originalText', 12000, true);
    candidate_normalized_text := security_private.telegram_candidate_text_v1(candidate, 'normalizedTextUk', 12000, false);
    candidate_reason := security_private.telegram_candidate_text_v1(candidate, 'reason', 1000, true);
    candidate_gender := lower(security_private.telegram_candidate_text_v1(candidate, 'gender', 20, false));
    if candidate_gender not in ('male', 'female', 'unknown', '') then candidate_gender := 'unknown'; end if;
    candidate_event_type := lower(security_private.telegram_candidate_text_v1(candidate, 'eventType', 40, false));
    if candidate_event_type not in ('birth','baptism','marriage','death','burial','residence','census','military','migration','witness','godparent','other','') then
      candidate_event_type := '';
    end if;
    candidate_event_role := lower(security_private.telegram_candidate_text_v1(candidate, 'eventRoleCode', 40, false));
    if candidate_event_role not in (
      'subject','newborn','baptized','groom','bride','groom_father','groom_mother','bride_father','bride_mother',
      'deceased','resident','household_head','household_member','military_person','migrant','godparent','godchild',
      'father','mother','parent','child','spouse','witness','pledger','officiant','registrar','midwife','informant',
      'owner','commander','official','other',''
    ) then candidate_event_role := ''; end if;
    candidate_event_role_custom := security_private.telegram_candidate_text_v1(candidate, 'eventRoleCustomText', 160, false);
    if candidate_event_role <> 'other' then candidate_event_role_custom := ''; end if;
    -- `other` is valid only with a human-readable custom role in the
    -- existing participant constraint.  A blank model default should remain
    -- unspecified instead of rolling back every candidate in the intake.
    if candidate_event_role = 'other' and char_length(candidate_event_role_custom) < 2 then
      candidate_event_role := '';
      candidate_event_role_custom := '';
    end if;
    candidate_event_date := security_private.telegram_candidate_text_v1(candidate, 'eventDateText', 160, false);
    candidate_origin_place := security_private.telegram_candidate_text_v1(candidate, 'originPlace', 500, false);
    candidate_found_place := security_private.telegram_candidate_text_v1(candidate, 'foundPlace', 500, false);
    candidate_official_place := security_private.telegram_candidate_text_v1(candidate, 'officialPlace', 500, false);
    candidate_document_type := security_private.telegram_candidate_text_v1(candidate, 'documentType', 240, false);
    candidate_institution := security_private.telegram_candidate_text_v1(candidate, 'institutionName', 240, false);
    candidate_archive_ref := security_private.telegram_candidate_text_v1(candidate, 'archiveReference', 500, false);
    candidate_page_label := security_private.telegram_candidate_text_v1(candidate, 'pageLabel', 80, false);
    candidate_page_range := security_private.telegram_candidate_text_v1(candidate, 'pageRange', 80, false);
    candidate_source_title := security_private.telegram_candidate_text_v1(candidate, 'sourceTitle', 300, false);
    candidate_source_url := nullif(security_private.telegram_candidate_text_v1(candidate, 'sourceUrl', 2048, false), '');
    if candidate_source_url is not null and candidate_source_url !~* '^https?://' then
      raise exception 'TELEGRAM_CANDIDATE_SOURCE_URL_INVALID' using errcode = '22023';
    end if;
    -- Private Telegram channel and invite URLs may be useful only inside the
    -- sender's chat, never as a public catalogue source.
    if candidate_source_url ~* '^https?://(www[.])?(t[.]me|telegram[.]me)/(c/|joinchat/|[+])' then
      candidate_source_url := null;
    end if;
    candidate_source_platform := lower(security_private.telegram_candidate_text_v1(candidate, 'sourcePlatform', 20, false));
    if candidate_source_platform not in ('telegram', 'facebook', 'web', 'other', '') then candidate_source_platform := 'other'; end if;
    if candidate_source_platform = '' then candidate_source_platform := null; end if;
    candidate_possible_living := lower(coalesce(candidate ->> 'possibleLivingPerson', 'false')) in ('true', 't', '1');
    candidate_year_from := case when candidate ->> 'eventYearFrom' ~ '^\d{1,4}$' then (candidate ->> 'eventYearFrom')::integer end;
    candidate_year_to := case when candidate ->> 'eventYearTo' ~ '^\d{1,4}$' then (candidate ->> 'eventYearTo')::integer end;
    if candidate_year_from is not null and candidate_year_from not between 1 and 2200 then candidate_year_from := null; end if;
    if candidate_year_to is not null and candidate_year_to not between 1 and 2200 then candidate_year_to := null; end if;
    if candidate_year_from is not null and candidate_year_to is not null and candidate_year_to < candidate_year_from then
      raise exception 'TELEGRAM_CANDIDATE_YEAR_RANGE_INVALID' using errcode = '22023';
    end if;
    select coalesce(array_agg(security_private.telegram_safe_text_v1(value #>> '{}', 120, true)), '{}'::text[])
    into candidate_record_types
    from jsonb_array_elements(case when jsonb_typeof(candidate -> 'recordTypes') = 'array' then candidate -> 'recordTypes' else '[]'::jsonb end);
    if coalesce(array_length(candidate_record_types, 1), 0) > 8 then
      raise exception 'TELEGRAM_CANDIDATE_RECORD_TYPES_LIMIT' using errcode = '22023';
    end if;
    candidate_warnings := case when jsonb_typeof(candidate -> 'warnings') = 'array' then candidate -> 'warnings' else '[]'::jsonb end;
    if jsonb_array_length(candidate_warnings) > 12 then candidate_warnings := '[]'::jsonb; end if;
    candidate_key_value := security_private.telegram_sha256_v1(
      jsonb_build_object('kind', candidate_kind, 'title', lower(candidate_title), 'name', lower(candidate_name),
        'eventType', candidate_event_type, 'eventDate', candidate_event_date, 'origin', lower(candidate_origin_place),
        'document', lower(candidate_document_type), 'sourceUrl', lower(coalesce(candidate_source_url, '')))::text
    );

    -- A model may repeat a candidate in one response.  Never create a second
    -- draft before the uniqueness constraint gets a chance to reject it.
    select existing_candidate.materialized_record_id
    into record_id_value
    from public.telegram_zagulyaky_candidates existing_candidate
    where existing_candidate.intake_id = intake_row.id
      and existing_candidate.candidate_key = candidate_key_value;
    if record_id_value is not null then
      result_records := result_records || jsonb_build_array(record_id_value);
      continue;
    end if;

    insert into public.zagulyaky_records(
      kind, status, verification_status, privacy_status, title, original_text, normalized_text,
      event_type, event_date_text, event_year_from, event_year_to, date_precision,
      source_location_text, source_location_normalized, found_location_text, found_location_normalized,
      classification_reason, possible_living_person, created_by
    ) values (
      candidate_kind, 'draft', 'unverified', case when candidate_possible_living then 'requires_consent' else 'pending' end,
      coalesce(nullif(candidate_title, ''), case when candidate_kind = 'person' then candidate_name else 'Згаданий документ' end),
      candidate_original_text, candidate_normalized_text,
      nullif(candidate_event_type, ''), nullif(candidate_event_date, ''), candidate_year_from, candidate_year_to, 'unknown',
      nullif(case when candidate_kind = 'person' then candidate_origin_place else candidate_official_place end, ''),
      nullif(case when candidate_kind = 'person' then candidate_origin_place else candidate_official_place end, ''),
      nullif(candidate_found_place, ''), nullif(candidate_found_place, ''), candidate_reason,
      candidate_possible_living, intake_row.owner_id
    ) returning id into record_id_value;

    insert into public.telegram_zagulyaky_draft_origins(record_id, owner_id)
    values (record_id_value, intake_row.owner_id)
    on conflict (record_id) do nothing;

    if candidate_kind = 'person' then
      insert into public.zagulyaky_participants(
        record_id, role, event_role_code, event_role_custom, original_full_name,
        normalized_uk_full_name, sex, origin_text, notes, sort_order
      ) values (
        record_id_value, 'subject', nullif(candidate_event_role, ''), nullif(candidate_event_role_custom, ''),
        candidate_name, candidate_normalized_name, nullif(candidate_gender, ''), nullif(candidate_origin_place, ''),
        '', 0
      );
    else
      insert into public.zagulyaky_document_discoveries(
        record_id, official_location_text, discovered_location_text, record_types,
        factual_year_from, factual_year_to, page_from, page_to, notes
      ) values (
        record_id_value, candidate_official_place, candidate_found_place, candidate_record_types,
        candidate_year_from, candidate_year_to, nullif(candidate_page_label, ''), nullif(candidate_page_range, ''), ''
      );
    end if;

    -- Every draft has a source record.  The generic private-source label is
    -- intentionally non-identifying and lets the ordinary submission flow
    -- require a source without leaking chat/user identifiers.  If the user
    -- supplied an http(s) original-post link, the model/worker passes it
    -- through as a normal source URL that a moderator can decide to publish.
    candidate_source_type := case
      when candidate_source_platform in ('telegram', 'facebook') then 'social_post'
      when candidate_source_platform = 'web' then 'website'
      when candidate_archive_ref <> '' or candidate_institution <> '' then 'archive'
      else 'other'
    end;
    candidate_permission_status := case
      when candidate_source_url is not null then 'link_only'
      else 'restricted'
    end;
    insert into public.zagulyaky_sources(
      source_type, title, archive_name, citation, source_url, source_platform,
      permission_status, metadata, created_by
    ) values (
      candidate_source_type,
      coalesce(
        nullif(candidate_source_title, ''),
        nullif(candidate_institution, ''),
        case when candidate_source_url is not null then 'Посилання, надіслане користувачем'
          else 'Надіслано через приватний Telegram-бот' end
      ),
      nullif(candidate_institution, ''),
      coalesce(nullif(candidate_archive_ref, ''),
        case when candidate_source_url is null
          then 'Приватне надсилання через Telegram-бот; вміст доступний автору та модерації.'
          else '' end),
      candidate_source_url, candidate_source_platform,
      candidate_permission_status, '{}'::jsonb, intake_row.owner_id
    ) returning id into source_id_value;
    insert into public.zagulyaky_record_sources(record_id, source_id, is_primary)
    values (record_id_value, source_id_value, true);

    insert into public.telegram_zagulyaky_candidates(
      owner_id, intake_id, candidate_key, kind, confidence, status, draft_input, warnings, materialized_record_id
    ) values (
      intake_row.owner_id, intake_row.id, candidate_key_value, candidate_kind, candidate_confidence,
      'materialized', candidate, candidate_warnings, record_id_value
    ) on conflict (intake_id, candidate_key) do update
    set updated_at = now()
    returning id into candidate_row_id;

    -- The base-row insert happened before its structured detail, source and
    -- participant rows existed.  Touch it now so the normal version trigger
    -- captures a complete owner-reviewable snapshot.
    update public.zagulyaky_records
    set updated_at = now()
    where id = record_id_value;
    result_records := result_records || jsonb_build_array(record_id_value);
  end loop;

  update public.telegram_intakes
  set status = 'materialized', result_count = jsonb_array_length(result_records), last_error_code = null
  where id = intake_row.id;
  return jsonb_build_object('status', 'materialized', 'recordIds', result_records, 'candidateCount', jsonb_array_length(result_records));
end;
$function$;

create or replace function security_private.service_renew_telegram_intake_lease_v1(
  p_intake_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  intake_row public.telegram_intakes;
  renewed_lease_expires_at timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 300 then
    raise exception 'TELEGRAM_LEASE_INVALID' using errcode = '22023';
  end if;
  select * into intake_row
  from public.telegram_intakes
  where id = p_intake_id
  for update;
  if not found or intake_row.status not in ('processing', 'materialized')
    or intake_row.claim_token is distinct from p_claim_token
    or intake_row.lease_expires_at < now() then
    raise exception 'TELEGRAM_INTAKE_CLAIM_INVALID' using errcode = '40001';
  end if;
  renewed_lease_expires_at := clock_timestamp() + make_interval(secs => p_lease_seconds);
  update public.telegram_intakes
  set lease_expires_at = renewed_lease_expires_at
  where id = intake_row.id;
  -- A worker can renew only fences from its exact intake claim.  The extra
  -- minute is a cleanup fence for a bounded upload request that started just
  -- before the intake lease was renewed or lost.
  update public.telegram_media_upload_fences fence
  set upload_lease_expires_at = renewed_lease_expires_at + interval '60 seconds'
  where fence.intake_id = intake_row.id
    and fence.intake_claim_token = p_claim_token
    and fence.cleanup_status = 'reserved';
  return jsonb_build_object('leaseExpiresAt', renewed_lease_expires_at);
end;
$function$;

create or replace function security_private.service_reserve_telegram_media_attachment_v1(
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
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  intake_row public.telegram_intakes;
  media_row public.telegram_intake_media;
  reservation public.telegram_intake_media_attachments;
  previous_fence public.telegram_media_upload_fences;
  normalized_name text := security_private.telegram_safe_text_v1(p_file_name, 240, true);
  normalized_mime text := lower(security_private.telegram_safe_text_v1(p_mime_type, 100, true));
  normalized_hash text := lower(security_private.telegram_safe_text_v1(p_sha256, 64, true));
  reservation_token_value uuid;
  storage_path_value text;
  upload_lease_expires_at_value timestamptz;
  intake_lease_expires_at_value timestamptz;
  extension_value text;
  has_reservation boolean := false;
  has_previous_fence boolean := false;
begin
  select * into intake_row
  from public.telegram_intakes
  where id = p_intake_id
  for update;
  if not found or intake_row.status <> 'materialized' or intake_row.intent <> 'zagulyaka'
    or intake_row.claim_token is distinct from p_claim_token or intake_row.lease_expires_at < now() then
    raise exception 'TELEGRAM_INTAKE_CLAIM_INVALID' using errcode = '40001';
  end if;
  if normalized_mime not in ('image/jpeg', 'image/png', 'image/webp')
    or normalized_hash !~ '^[0-9a-f]{64}$' or p_byte_size is null or p_byte_size not between 1 and 20971520 then
    raise exception 'TELEGRAM_MEDIA_ATTACHMENT_INVALID' using errcode = '22023';
  end if;
  select * into media_row
  from public.telegram_intake_media
  where id = p_media_id and intake_id = intake_row.id
  for update;
  if not found or media_row.status not in ('pending', 'attached') then
    raise exception 'TELEGRAM_MEDIA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if media_row.status = 'attached' and (
    media_row.actual_mime_type is distinct from normalized_mime
    or media_row.actual_byte_size is distinct from p_byte_size
    or media_row.sha256 is distinct from normalized_hash
  ) then
    raise exception 'TELEGRAM_MEDIA_CONTENT_MISMATCH' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.telegram_zagulyaky_candidates candidate_row
    where candidate_row.intake_id = intake_row.id
      and candidate_row.materialized_record_id = p_record_id
  ) then
    raise exception 'TELEGRAM_MEDIA_RECORD_INVALID' using errcode = '22023';
  end if;
  select * into reservation
  from public.telegram_intake_media_attachments relation
  where relation.intake_media_id = media_row.id and relation.record_id = p_record_id
  for update;
  has_reservation := found;
  if has_reservation then
    if reservation.owner_id is distinct from intake_row.owner_id
      or reservation.file_name is distinct from normalized_name
      or reservation.mime_type is distinct from normalized_mime
      or reservation.byte_size is distinct from p_byte_size
      or reservation.sha256 is distinct from normalized_hash then
      raise exception 'TELEGRAM_MEDIA_RESERVATION_MISMATCH' using errcode = '22023';
    end if;
    if reservation.status = 'attached' and reservation.attachment_id is not null then
      return jsonb_build_object(
        'recordId', p_record_id,
        'storagePath', reservation.storage_path,
        'status', 'attached',
        'attachmentId', reservation.attachment_id,
        'reservationToken', null
      );
    end if;

    select * into previous_fence
    from public.telegram_media_upload_fences fence
    where fence.storage_path = reservation.storage_path
      and fence.reservation_token = reservation.reservation_token
    for update;
    has_previous_fence := found;

    if has_previous_fence and previous_fence.cleanup_status = 'reserved'
      and previous_fence.intake_id = intake_row.id
      and previous_fence.intake_media_id = media_row.id
      and previous_fence.record_id = p_record_id
      and previous_fence.owner_id = intake_row.owner_id
      and previous_fence.intake_claim_token = p_claim_token
      and previous_fence.upload_lease_expires_at > clock_timestamp() then
      intake_lease_expires_at_value := clock_timestamp() + interval '300 seconds';
      upload_lease_expires_at_value := intake_lease_expires_at_value + interval '60 seconds';
      update public.telegram_intakes
      set lease_expires_at = intake_lease_expires_at_value
      where id = intake_row.id;
      update public.telegram_intake_media_attachments
      set upload_lease_expires_at = upload_lease_expires_at_value
      where intake_media_id = media_row.id and record_id = p_record_id;
      update public.telegram_media_upload_fences
      set upload_lease_expires_at = upload_lease_expires_at_value
      where id = previous_fence.id;
      return jsonb_build_object(
        'recordId', p_record_id,
        'storagePath', reservation.storage_path,
        'status', 'pending',
        'attachmentId', null,
        'reservationToken', reservation.reservation_token
      );
    end if;

    -- Preserve a row even if an earlier partial migration lost its fence.  It
    -- is cleanup-only and cannot be attached because it has no current claim.
    if not has_previous_fence then
      insert into public.telegram_media_upload_fences(
        intake_id, intake_media_id, record_id, owner_id, storage_path,
        reservation_token, intake_claim_token, upload_lease_expires_at,
        cleanup_status, cleanup_requested_at, cleanup_next_attempt_at
      ) values (
        intake_row.id, media_row.id, p_record_id, intake_row.owner_id, reservation.storage_path,
        reservation.reservation_token, p_claim_token, greatest(reservation.upload_lease_expires_at, clock_timestamp()),
        'cleanup_requested', clock_timestamp(), greatest(reservation.upload_lease_expires_at + interval '60 seconds', clock_timestamp())
      ) on conflict (storage_path) do nothing;
    elsif previous_fence.cleanup_status <> 'cleanup_processing' then
      update public.telegram_media_upload_fences
      set cleanup_status = 'cleanup_requested',
          cleanup_requested_at = coalesce(cleanup_requested_at, clock_timestamp()),
          cleanup_next_attempt_at = greatest(upload_lease_expires_at + interval '60 seconds', clock_timestamp()),
          cleanup_claim_token = null,
          cleanup_lease_expires_at = null,
          last_error_code = null
      where id = previous_fence.id;
    end if;
  end if;

  extension_value := case normalized_mime
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    else 'webp'
  end;
  reservation_token_value := gen_random_uuid();
  storage_path_value := intake_row.owner_id::text || '/' || p_record_id::text
    || '/telegram/' || media_row.id::text || '/' || reservation_token_value::text || '.' || extension_value;
  intake_lease_expires_at_value := clock_timestamp() + interval '300 seconds';
  upload_lease_expires_at_value := intake_lease_expires_at_value + interval '60 seconds';

  if has_reservation then
    update public.telegram_intake_media_attachments
    set owner_id = intake_row.owner_id,
        storage_path = storage_path_value,
        reservation_token = reservation_token_value,
        upload_lease_expires_at = upload_lease_expires_at_value,
        file_name = normalized_name,
        mime_type = normalized_mime,
        byte_size = p_byte_size,
        sha256 = normalized_hash,
        status = 'pending',
        attachment_id = null
    where intake_media_id = media_row.id and record_id = p_record_id;
  else
    insert into public.telegram_intake_media_attachments(
      intake_media_id, record_id, owner_id, storage_path, reservation_token,
      upload_lease_expires_at, file_name, mime_type, byte_size, sha256, status
    ) values (
      media_row.id, p_record_id, intake_row.owner_id, storage_path_value, reservation_token_value,
      upload_lease_expires_at_value, normalized_name, normalized_mime, p_byte_size, normalized_hash, 'pending'
    );
  end if;
  insert into public.telegram_media_upload_fences(
    intake_id, intake_media_id, record_id, owner_id, storage_path,
    reservation_token, intake_claim_token, upload_lease_expires_at
  ) values (
    intake_row.id, media_row.id, p_record_id, intake_row.owner_id, storage_path_value,
    reservation_token_value, p_claim_token, upload_lease_expires_at_value
  );
  update public.telegram_intakes
  set lease_expires_at = intake_lease_expires_at_value
  where id = intake_row.id;
  return jsonb_build_object(
    'recordId', p_record_id,
    'storagePath', storage_path_value,
    'status', 'pending',
    'attachmentId', null,
    'reservationToken', reservation_token_value
  );
end;
$function$;

create or replace function security_private.service_attach_telegram_media_to_zagulyaka_v1(
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
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, storage, pg_temp
as $function$
declare
  intake_row public.telegram_intakes;
  media_row public.telegram_intake_media;
  primary_source_id uuid;
  attachment_row public.zagulyaky_attachments;
  reservation public.telegram_intake_media_attachments;
  fence_row public.telegram_media_upload_fences;
  normalized_name text := security_private.telegram_safe_text_v1(p_file_name, 240, true);
  normalized_mime text := lower(security_private.telegram_safe_text_v1(p_mime_type, 100, true));
  normalized_hash text := lower(security_private.telegram_safe_text_v1(p_sha256, 64, true));
begin
  select * into intake_row
  from public.telegram_intakes
  where id = p_intake_id
  for update;
  if not found or intake_row.status <> 'materialized' or intake_row.intent <> 'zagulyaka'
    or intake_row.claim_token is distinct from p_claim_token or intake_row.lease_expires_at < now() then
    raise exception 'TELEGRAM_INTAKE_CLAIM_INVALID' using errcode = '40001';
  end if;
  if normalized_mime not in ('image/jpeg', 'image/png', 'image/webp')
    or normalized_hash !~ '^[0-9a-f]{64}$' or p_byte_size is null or p_byte_size not between 1 and 20971520 then
    raise exception 'TELEGRAM_MEDIA_ATTACHMENT_INVALID' using errcode = '22023';
  end if;
  select * into media_row
  from public.telegram_intake_media
  where id = p_media_id and intake_id = intake_row.id
  for update;
  if not found or media_row.status not in ('pending', 'attached') then
    raise exception 'TELEGRAM_MEDIA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if media_row.status = 'attached' and (
    media_row.actual_mime_type is distinct from normalized_mime
    or media_row.actual_byte_size is distinct from p_byte_size
    or media_row.sha256 is distinct from normalized_hash
  ) then
    raise exception 'TELEGRAM_MEDIA_CONTENT_MISMATCH' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.telegram_zagulyaky_candidates candidate_row
    where candidate_row.intake_id = intake_row.id
      and candidate_row.materialized_record_id = p_record_id
  ) then
    raise exception 'TELEGRAM_MEDIA_RECORD_INVALID' using errcode = '22023';
  end if;
  select link.source_id into primary_source_id
  from public.zagulyaky_record_sources link
  where link.record_id = p_record_id and link.is_primary
  limit 1;
  if primary_source_id is null then
    raise exception 'TELEGRAM_MEDIA_SOURCE_MISSING' using errcode = '23514';
  end if;

  select * into reservation
  from public.telegram_intake_media_attachments relation
  where relation.intake_media_id = media_row.id and relation.record_id = p_record_id
  for update;
  if not found then
    raise exception 'TELEGRAM_MEDIA_RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if reservation.owner_id is distinct from intake_row.owner_id
    or reservation.file_name is distinct from normalized_name
    or reservation.mime_type is distinct from normalized_mime
    or reservation.byte_size is distinct from p_byte_size
    or reservation.sha256 is distinct from normalized_hash then
    raise exception 'TELEGRAM_MEDIA_RESERVATION_MISMATCH' using errcode = '22023';
  end if;
  if reservation.status = 'attached' and reservation.attachment_id is not null then
    return jsonb_build_object('attachmentId', reservation.attachment_id, 'recordId', p_record_id, 'duplicate', true);
  end if;
  if p_reservation_token is null or reservation.reservation_token is distinct from p_reservation_token then
    raise exception 'TELEGRAM_MEDIA_RESERVATION_TOKEN_INVALID' using errcode = '40001';
  end if;
  select * into fence_row
  from public.telegram_media_upload_fences fence
  where fence.intake_id = intake_row.id
    and fence.intake_media_id = media_row.id
    and fence.record_id = p_record_id
    and fence.owner_id = intake_row.owner_id
    and fence.storage_path = reservation.storage_path
    and fence.reservation_token = p_reservation_token
  for update;
  if not found or fence_row.intake_claim_token is distinct from p_claim_token
    or fence_row.cleanup_status <> 'reserved'
    or fence_row.upload_lease_expires_at < clock_timestamp() then
    raise exception 'TELEGRAM_MEDIA_FENCE_INVALID' using errcode = '40001';
  end if;
  if not exists (
    select 1 from storage.objects object_row
    where object_row.bucket_id = 'zagulyaky-private'
      and object_row.name = fence_row.storage_path
  ) then
    raise exception 'TELEGRAM_MEDIA_OBJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.zagulyaky_attachments(
    record_id, source_id, storage_bucket, storage_path, file_name, mime_type,
    byte_size, sha256, is_public_derivative, metadata, created_by
  ) values (
    p_record_id, primary_source_id, 'zagulyaky-private', fence_row.storage_path, normalized_name,
    normalized_mime, p_byte_size, normalized_hash, false, '{}'::jsonb, intake_row.owner_id
  ) returning * into attachment_row;
  update public.telegram_intake_media_attachments
  set attachment_id = attachment_row.id, status = 'attached'
  where intake_media_id = media_row.id and record_id = p_record_id;
  update public.telegram_intake_media
  set actual_mime_type = normalized_mime, actual_byte_size = p_byte_size,
      sha256 = normalized_hash, status = 'attached', last_error_code = null
  where id = media_row.id;
  delete from public.telegram_media_upload_fences
  where id = fence_row.id
    and reservation_token = p_reservation_token
    and cleanup_status = 'reserved';
  if not found then
    raise exception 'TELEGRAM_MEDIA_FENCE_INVALID' using errcode = '40001';
  end if;
  -- Include the generated private attachment in the standard version history.
  update public.zagulyaky_records set updated_at = now() where id = p_record_id;
  return jsonb_build_object('attachmentId', attachment_row.id, 'recordId', p_record_id, 'duplicate', false);
end;
$function$;

-- Claiming occurs only after the upload lease and its grace period.  The
-- worker holds a separate short cleanup lease, so a stale finalizer cannot
-- delete a newer reservation or report another worker's result.
create or replace function security_private.service_claim_telegram_media_cleanup_v1(
  p_limit integer default 10
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  safe_limit integer := coalesce(p_limit, 10);
  result_tasks jsonb;
begin
  if safe_limit not between 1 and 20 then
    raise exception 'TELEGRAM_MEDIA_CLEANUP_LIMIT_INVALID' using errcode = '22023';
  end if;

  -- An interrupted remover never gains authority forever.  The physical
  -- object path is unique per reservation, so retrying this same fence is
  -- safe after the cleanup lease expires.
  update public.telegram_media_upload_fences fence
  set cleanup_status = 'cleanup_requested',
      cleanup_next_attempt_at = clock_timestamp(),
      cleanup_claim_token = null,
      cleanup_lease_expires_at = null,
      last_error_code = coalesce(fence.last_error_code, 'TELEGRAM_MEDIA_CLEANUP_LEASE_EXPIRED')
  where fence.cleanup_status = 'cleanup_processing'
    and fence.cleanup_lease_expires_at < clock_timestamp();

  with candidates as (
    select fence.id
    from public.telegram_media_upload_fences fence
    where fence.cleanup_status = 'cleanup_requested'
      and fence.cleanup_next_attempt_at <= clock_timestamp()
      and fence.upload_lease_expires_at + interval '60 seconds' <= clock_timestamp()
    order by fence.cleanup_next_attempt_at, fence.created_at, fence.id
    for update skip locked
    limit safe_limit
  ), claimed as (
    update public.telegram_media_upload_fences fence
    set cleanup_status = 'cleanup_processing',
        cleanup_attempt_count = fence.cleanup_attempt_count + 1,
        cleanup_next_attempt_at = null,
        cleanup_claim_token = gen_random_uuid(),
        cleanup_lease_expires_at = clock_timestamp() + interval '60 seconds',
        last_error_code = null
    from candidates
    where fence.id = candidates.id
    returning fence.id, fence.storage_path, fence.cleanup_claim_token
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'fenceId', claimed.id,
    'storageBucket', 'zagulyaky-private',
    'storagePath', claimed.storage_path,
    'claimToken', claimed.cleanup_claim_token
  ) order by claimed.id), '[]'::jsonb)
  into result_tasks
  from claimed;

  return jsonb_build_object('tasks', result_tasks);
end;
$function$;

create or replace function security_private.service_finalize_telegram_media_cleanup_v1(
  p_fence_id uuid,
  p_claim_token uuid,
  p_removed boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  fence_row public.telegram_media_upload_fences;
  normalized_code text := upper(nullif(security_private.telegram_safe_text_v1(p_error_code, 100), ''));
  retry_delay_seconds integer;
begin
  if p_fence_id is null or p_claim_token is null then
    raise exception 'TELEGRAM_MEDIA_CLEANUP_CLAIM_REQUIRED' using errcode = '22023';
  end if;
  if not coalesce(p_removed, false) and (normalized_code is null or normalized_code !~ '^[A-Z0-9_]{3,100}$') then
    raise exception 'TELEGRAM_MEDIA_CLEANUP_ERROR_INVALID' using errcode = '22023';
  end if;
  select * into fence_row
  from public.telegram_media_upload_fences
  where id = p_fence_id
  for update;
  if not found or fence_row.cleanup_status <> 'cleanup_processing'
    or fence_row.cleanup_claim_token is distinct from p_claim_token
    or fence_row.cleanup_lease_expires_at < clock_timestamp() then
    raise exception 'TELEGRAM_MEDIA_CLEANUP_CLAIM_INVALID' using errcode = '40001';
  end if;

  if coalesce(p_removed, false) then
    delete from public.telegram_media_upload_fences
    where id = fence_row.id
      and cleanup_claim_token = p_claim_token
      and cleanup_status = 'cleanup_processing';
    if not found then
      raise exception 'TELEGRAM_MEDIA_CLEANUP_CLAIM_INVALID' using errcode = '40001';
    end if;
    return jsonb_build_object('status', 'removed');
  end if;

  retry_delay_seconds := least(3600, 30 * (2 ^ least(6, fence_row.cleanup_attempt_count))::integer);
  update public.telegram_media_upload_fences
  set cleanup_status = 'cleanup_requested',
      cleanup_next_attempt_at = clock_timestamp() + make_interval(secs => retry_delay_seconds),
      cleanup_claim_token = null,
      cleanup_lease_expires_at = null,
      last_error_code = normalized_code
  where id = fence_row.id
    and cleanup_claim_token = p_claim_token
    and cleanup_status = 'cleanup_processing';
  return jsonb_build_object('status', 'retry');
end;
$function$;

create or replace function security_private.service_finalize_telegram_zagulyaka_v1(
  p_intake_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  intake_row public.telegram_intakes;
  result_records jsonb;
begin
  select * into intake_row
  from public.telegram_intakes
  where id = p_intake_id
  for update;
  if not found or intake_row.status <> 'materialized' or intake_row.intent <> 'zagulyaka'
    or intake_row.claim_token is distinct from p_claim_token or intake_row.lease_expires_at < now() then
    raise exception 'TELEGRAM_INTAKE_CLAIM_INVALID' using errcode = '40001';
  end if;
  select coalesce(jsonb_agg(candidate_row.materialized_record_id order by candidate_row.created_at, candidate_row.id), '[]'::jsonb)
  into result_records
  from public.telegram_zagulyaky_candidates candidate_row
  where candidate_row.intake_id = intake_row.id
    and candidate_row.materialized_record_id is not null;

  if jsonb_array_length(result_records) = 0 then
    update public.telegram_intake_media
    set status = 'rejected', last_error_code = 'TELEGRAM_NO_CANDIDATES'
    where intake_id = intake_row.id and status = 'pending';
  elsif exists (
    -- One source photo is copied into every separate person/document draft
    -- produced from the same message.  Checking only media.status would let
    -- a partial retry finalize after its first successful copy.
    select 1
    from public.telegram_intake_media media_row
    cross join public.telegram_zagulyaky_candidates candidate_row
    left join public.telegram_intake_media_attachments relation
      on relation.intake_media_id = media_row.id
      and relation.record_id = candidate_row.materialized_record_id
    where media_row.intake_id = intake_row.id
      and candidate_row.intake_id = intake_row.id
      and candidate_row.materialized_record_id is not null
      and media_row.status in ('pending', 'attached')
      and relation.attachment_id is null
  ) then
    raise exception 'TELEGRAM_MEDIA_ATTACHMENT_REQUIRED' using errcode = '23514';
  end if;

  update public.telegram_intakes
  set status = 'completed', result_count = jsonb_array_length(result_records), completed_at = now(),
      claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
      last_error_code = null
  where id = intake_row.id;
  return jsonb_build_object('status', 'completed', 'recordIds', result_records, 'candidateCount', jsonb_array_length(result_records));
end;
$function$;

create or replace function security_private.service_fail_telegram_intake_v1(
  p_intake_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  intake_row public.telegram_intakes;
  normalized_code text := upper(security_private.telegram_safe_text_v1(p_error_code, 100, true));
  next_status text;
begin
  if normalized_code !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'TELEGRAM_ERROR_CODE_INVALID' using errcode = '22023';
  end if;
  select * into intake_row from public.telegram_intakes where id = p_intake_id for update;
  if not found or intake_row.status not in ('processing', 'materialized')
    or intake_row.claim_token is distinct from p_claim_token
    or intake_row.lease_expires_at < now() then
    raise exception 'TELEGRAM_INTAKE_CLAIM_INVALID' using errcode = '40001';
  end if;
  next_status := case when p_retryable and intake_row.attempt_count < intake_row.max_attempts then 'retry' else 'failed' end;
  update public.telegram_intakes
  set status = next_status, next_attempt_at = case when next_status = 'retry'
        then now() + make_interval(secs => least(300, 15 * intake_row.attempt_count)) else next_attempt_at end,
      claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
      last_error_code = normalized_code, completed_at = case when next_status = 'failed' then now() else null end
  where id = intake_row.id;
  return jsonb_build_object('status', next_status);
end;
$function$;

create or replace function security_private.list_my_telegram_notes_v1(
  p_status text default null,
  p_source_status text default null,
  p_priority text default null,
  p_source_platform text default null,
  p_query text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_status text := nullif(lower(security_private.telegram_safe_text_v1(p_status, 30)), '');
  normalized_source_status text := nullif(lower(security_private.telegram_safe_text_v1(p_source_status, 30)), '');
  normalized_priority text := nullif(lower(security_private.telegram_safe_text_v1(p_priority, 30)), '');
  normalized_platform text := nullif(lower(security_private.telegram_safe_text_v1(p_source_platform, 30)), '');
  normalized_query text := lower(security_private.telegram_safe_text_v1(p_query, 160));
  result jsonb;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'TELEGRAM_LIST_LIMIT_INVALID' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', note.id, 'title', note.title, 'body', note.body_text, 'sourceUrl', note.source_url,
    'sourcePlatform', note.source_platform, 'sourceLabel', note.source_label,
    'sourceMetadata', note.source_metadata, 'status', note.status, 'sourceStatus', note.source_status,
    'priority', note.priority, 'createdAt', note.created_at, 'updatedAt', note.updated_at
  ) order by note.updated_at desc, note.id), '[]'::jsonb)
  into result
  from (
    select * from public.telegram_saved_notes note
    where note.owner_id = current_user_id
      and (normalized_status is null or note.status = normalized_status)
      and (normalized_source_status is null or note.source_status = normalized_source_status)
      and (normalized_priority is null or note.priority = normalized_priority)
      and (normalized_platform is null or note.source_platform = normalized_platform)
      and (normalized_query = '' or position(normalized_query in lower(concat_ws(
        ' ', note.title, note.body_text, note.source_url, note.source_label,
        note.source_metadata ->> 'sourceUsername'
      ))) > 0)
    order by note.updated_at desc, note.id
    limit p_limit
  ) note;
  return result;
end;
$function$;

create or replace function security_private.update_my_telegram_note_v1(
  p_note_id uuid,
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
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if normalized_status not in ('inbox','reviewing','saved','archived','converted')
    or normalized_source_status not in ('unverified','available','unavailable','changed')
    or normalized_priority not in ('low','normal','high','urgent')
    or normalized_platform not in ('telegram','facebook','web','other') then
    raise exception 'TELEGRAM_NOTE_ENUM_INVALID' using errcode = '22023';
  end if;
  if normalized_url is not null and normalized_url !~* '^https?://' then
    raise exception 'TELEGRAM_NOTE_URL_INVALID' using errcode = '22023';
  end if;
  update public.telegram_saved_notes
  set title = security_private.telegram_safe_text_v1(p_title, 240, true),
      body_text = security_private.telegram_safe_text_v1(p_body, 12000),
      status = normalized_status, source_status = normalized_source_status, priority = normalized_priority,
      source_url = normalized_url, source_platform = normalized_platform
  where id = p_note_id and owner_id = current_user_id
  returning * into note_row;
  if not found then raise exception 'TELEGRAM_NOTE_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', note_row.id, 'title', note_row.title, 'body', note_row.body_text, 'sourceUrl', note_row.source_url,
    'sourcePlatform', note_row.source_platform, 'sourceLabel', note_row.source_label,
    'sourceMetadata', note_row.source_metadata, 'status', note_row.status, 'sourceStatus', note_row.source_status,
    'priority', note_row.priority, 'createdAt', note_row.created_at, 'updatedAt', note_row.updated_at
  );
end;
$function$;

-- Public facades keep auth.uid() from the caller, while service facades have
-- no authenticated/anonymous grants and can be called only with a server key.
create or replace function public.create_my_telegram_link_v1(p_ai_opt_in boolean default true)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.create_my_telegram_link_v1($1) $$;

create or replace function public.get_my_telegram_link_status_v1()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.get_my_telegram_link_status_v1() $$;

create or replace function public.set_my_telegram_ai_opt_in_v1(p_ai_opt_in boolean)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.set_my_telegram_ai_opt_in_v1($1) $$;

create or replace function public.unlink_my_telegram_account_v1()
returns void language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.unlink_my_telegram_account_v1() $$;

create or replace function public.list_my_telegram_notes_v1(
  p_status text default null, p_source_status text default null, p_priority text default null,
  p_source_platform text default null, p_query text default null, p_limit integer default 100
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.list_my_telegram_notes_v1($1,$2,$3,$4,$5,$6) $$;

create or replace function public.update_my_telegram_note_v1(
  p_note_id uuid, p_title text, p_body text, p_status text, p_source_status text, p_priority text,
  p_source_url text default null, p_source_platform text default 'other'
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.update_my_telegram_note_v1($1,$2,$3,$4,$5,$6,$7,$8) $$;

create or replace function public.service_consume_telegram_link_v1(
  p_start_code text, p_telegram_user_id bigint, p_private_chat_id bigint,
  p_telegram_username text default null, p_display_name text default null
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_consume_telegram_link_v1($1,$2,$3,$4,$5) $$;

create or replace function public.service_set_telegram_active_mode_v1(
  p_telegram_user_id bigint, p_private_chat_id bigint, p_mode text
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_set_telegram_active_mode_v1($1,$2,$3) $$;

create or replace function public.service_enqueue_telegram_message_v1(
  p_update_id bigint, p_telegram_user_id bigint, p_private_chat_id bigint,
  p_message_id bigint, p_message_text text default '', p_media jsonb default null,
  p_source_metadata jsonb default '{}'::jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_enqueue_telegram_message_v1($1,$2,$3,$4,$5,$6,$7) $$;

create or replace function public.service_claim_telegram_intake_v1(
  p_worker_id text default 'telegram-inbox', p_lease_seconds integer default 120
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_claim_telegram_intake_v1($1,$2) $$;

create or replace function public.service_renew_telegram_intake_lease_v1(
  p_intake_id uuid, p_claim_token uuid, p_lease_seconds integer default 300
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_renew_telegram_intake_lease_v1($1,$2,$3) $$;

create or replace function public.service_complete_telegram_note_v1(
  p_intake_id uuid, p_claim_token uuid, p_title text, p_body_text text,
  p_source_url text default null, p_source_platform text default 'other',
  p_source_label text default null, p_source_metadata jsonb default '{}'::jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_complete_telegram_note_v1($1,$2,$3,$4,$5,$6,$7,$8) $$;

create or replace function public.service_complete_telegram_zagulyaka_v1(
  p_intake_id uuid, p_claim_token uuid, p_candidates jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_complete_telegram_zagulyaka_v1($1,$2,$3) $$;

create or replace function public.service_attach_telegram_media_to_zagulyaka_v1(
  p_intake_id uuid, p_claim_token uuid, p_media_id uuid, p_record_id uuid,
  p_reservation_token uuid, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_attach_telegram_media_to_zagulyaka_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) $$;

create or replace function public.service_reserve_telegram_media_attachment_v1(
  p_intake_id uuid, p_claim_token uuid, p_media_id uuid, p_record_id uuid,
  p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_reserve_telegram_media_attachment_v1($1,$2,$3,$4,$5,$6,$7,$8) $$;

create or replace function public.service_claim_telegram_media_cleanup_v1(
  p_limit integer default 10
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_claim_telegram_media_cleanup_v1($1) $$;

create or replace function public.service_finalize_telegram_media_cleanup_v1(
  p_fence_id uuid, p_claim_token uuid, p_removed boolean, p_error_code text default null
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_finalize_telegram_media_cleanup_v1($1,$2,$3,$4) $$;

create or replace function public.service_finalize_telegram_zagulyaka_v1(
  p_intake_id uuid, p_claim_token uuid
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_finalize_telegram_zagulyaka_v1($1,$2) $$;

create or replace function public.service_fail_telegram_intake_v1(
  p_intake_id uuid, p_claim_token uuid, p_error_code text, p_retryable boolean default true
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.service_fail_telegram_intake_v1($1,$2,$3,$4) $$;

revoke all on function security_private.telegram_sha256_v1(text) from public, anon, authenticated, service_role;
revoke all on function security_private.telegram_safe_text_v1(text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.telegram_source_metadata_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.telegram_link_code_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.enqueue_telegram_pending_attachment_cleanup_v1(uuid,uuid,text,uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.enqueue_telegram_terminal_media_cleanup_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.enqueue_telegram_deleted_pending_attachment_cleanup_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.delete_private_telegram_drafts_on_profile_delete_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.create_my_telegram_link_v1(boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.set_my_telegram_ai_opt_in_v1(boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.get_my_telegram_link_status_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.unlink_my_telegram_account_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.service_consume_telegram_link_v1(text,bigint,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function security_private.service_set_telegram_active_mode_v1(bigint,bigint,text) from public, anon, authenticated, service_role;
revoke all on function security_private.service_enqueue_telegram_message_v1(bigint,bigint,bigint,bigint,text,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.service_claim_telegram_intake_v1(text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.service_renew_telegram_intake_lease_v1(uuid,uuid,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.service_complete_telegram_note_v1(uuid,uuid,text,text,text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.telegram_candidate_text_v1(jsonb,text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.service_complete_telegram_zagulyaka_v1(uuid,uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.service_attach_telegram_media_to_zagulyaka_v1(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function security_private.service_reserve_telegram_media_attachment_v1(uuid,uuid,uuid,uuid,text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function security_private.service_claim_telegram_media_cleanup_v1(integer) from public, anon, authenticated, service_role;
revoke all on function security_private.service_finalize_telegram_media_cleanup_v1(uuid,uuid,boolean,text) from public, anon, authenticated, service_role;
revoke all on function security_private.service_finalize_telegram_zagulyaka_v1(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.service_fail_telegram_intake_v1(uuid,uuid,text,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.list_my_telegram_notes_v1(text,text,text,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.update_my_telegram_note_v1(uuid,text,text,text,text,text,text,text) from public, anon, authenticated, service_role;

grant execute on function security_private.create_my_telegram_link_v1(boolean) to authenticated, service_role;
grant execute on function security_private.set_my_telegram_ai_opt_in_v1(boolean) to authenticated, service_role;
grant execute on function security_private.get_my_telegram_link_status_v1() to authenticated, service_role;
grant execute on function security_private.unlink_my_telegram_account_v1() to authenticated, service_role;
grant execute on function security_private.list_my_telegram_notes_v1(text,text,text,text,text,integer) to authenticated, service_role;
grant execute on function security_private.update_my_telegram_note_v1(uuid,text,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function security_private.service_consume_telegram_link_v1(text,bigint,bigint,text,text) to service_role;
grant execute on function security_private.service_set_telegram_active_mode_v1(bigint,bigint,text) to service_role;
grant execute on function security_private.service_enqueue_telegram_message_v1(bigint,bigint,bigint,bigint,text,jsonb,jsonb) to service_role;
grant execute on function security_private.service_claim_telegram_intake_v1(text,integer) to service_role;
grant execute on function security_private.service_renew_telegram_intake_lease_v1(uuid,uuid,integer) to service_role;
grant execute on function security_private.service_complete_telegram_note_v1(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function security_private.service_complete_telegram_zagulyaka_v1(uuid,uuid,jsonb) to service_role;
grant execute on function security_private.service_attach_telegram_media_to_zagulyaka_v1(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text) to service_role;
grant execute on function security_private.service_reserve_telegram_media_attachment_v1(uuid,uuid,uuid,uuid,text,text,bigint,text) to service_role;
grant execute on function security_private.service_claim_telegram_media_cleanup_v1(integer) to service_role;
grant execute on function security_private.service_finalize_telegram_media_cleanup_v1(uuid,uuid,boolean,text) to service_role;
grant execute on function security_private.service_finalize_telegram_zagulyaka_v1(uuid,uuid) to service_role;
grant execute on function security_private.service_fail_telegram_intake_v1(uuid,uuid,text,boolean) to service_role;

revoke all on function public.create_my_telegram_link_v1(boolean) from public, anon, authenticated, service_role;
revoke all on function public.set_my_telegram_ai_opt_in_v1(boolean) from public, anon, authenticated, service_role;
revoke all on function public.get_my_telegram_link_status_v1() from public, anon, authenticated, service_role;
revoke all on function public.unlink_my_telegram_account_v1() from public, anon, authenticated, service_role;
revoke all on function public.list_my_telegram_notes_v1(text,text,text,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.update_my_telegram_note_v1(uuid,text,text,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.service_consume_telegram_link_v1(text,bigint,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function public.service_set_telegram_active_mode_v1(bigint,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.service_enqueue_telegram_message_v1(bigint,bigint,bigint,bigint,text,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.service_claim_telegram_intake_v1(text,integer) from public, anon, authenticated, service_role;
revoke all on function public.service_renew_telegram_intake_lease_v1(uuid,uuid,integer) from public, anon, authenticated, service_role;
revoke all on function public.service_complete_telegram_note_v1(uuid,uuid,text,text,text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.service_complete_telegram_zagulyaka_v1(uuid,uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.service_attach_telegram_media_to_zagulyaka_v1(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.service_reserve_telegram_media_attachment_v1(uuid,uuid,uuid,uuid,text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.service_claim_telegram_media_cleanup_v1(integer) from public, anon, authenticated, service_role;
revoke all on function public.service_finalize_telegram_media_cleanup_v1(uuid,uuid,boolean,text) from public, anon, authenticated, service_role;
revoke all on function public.service_finalize_telegram_zagulyaka_v1(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.service_fail_telegram_intake_v1(uuid,uuid,text,boolean) from public, anon, authenticated, service_role;

grant execute on function public.create_my_telegram_link_v1(boolean) to authenticated, service_role;
grant execute on function public.set_my_telegram_ai_opt_in_v1(boolean) to authenticated, service_role;
grant execute on function public.get_my_telegram_link_status_v1() to authenticated, service_role;
grant execute on function public.unlink_my_telegram_account_v1() to authenticated, service_role;
grant execute on function public.list_my_telegram_notes_v1(text,text,text,text,text,integer) to authenticated, service_role;
grant execute on function public.update_my_telegram_note_v1(uuid,text,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.service_consume_telegram_link_v1(text,bigint,bigint,text,text) to service_role;
grant execute on function public.service_set_telegram_active_mode_v1(bigint,bigint,text) to service_role;
grant execute on function public.service_enqueue_telegram_message_v1(bigint,bigint,bigint,bigint,text,jsonb,jsonb) to service_role;
grant execute on function public.service_claim_telegram_intake_v1(text,integer) to service_role;
grant execute on function public.service_renew_telegram_intake_lease_v1(uuid,uuid,integer) to service_role;
grant execute on function public.service_complete_telegram_note_v1(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.service_complete_telegram_zagulyaka_v1(uuid,uuid,jsonb) to service_role;
grant execute on function public.service_attach_telegram_media_to_zagulyaka_v1(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text) to service_role;
grant execute on function public.service_reserve_telegram_media_attachment_v1(uuid,uuid,uuid,uuid,text,text,bigint,text) to service_role;
grant execute on function public.service_claim_telegram_media_cleanup_v1(integer) to service_role;
grant execute on function public.service_finalize_telegram_media_cleanup_v1(uuid,uuid,boolean,text) to service_role;
grant execute on function public.service_finalize_telegram_zagulyaka_v1(uuid,uuid) to service_role;
grant execute on function public.service_fail_telegram_intake_v1(uuid,uuid,text,boolean) to service_role;

notify pgrst, 'reload schema';
commit;
