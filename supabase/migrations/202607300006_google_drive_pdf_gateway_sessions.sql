begin;

-- Private Drive PDF bytes are streamed through the same opaque gateway URL as
-- other external documents.  The short-lived GIS access token is encrypted
-- before it enters this service-only table and is deleted with the session.
alter table public.pdf_access_sessions
  add column if not exists upstream_authorization_ciphertext text;

alter table public.pdf_access_sessions
  drop constraint if exists pdf_access_sessions_provider_check;
alter table public.pdf_access_sessions
  add constraint pdf_access_sessions_provider_check
  check (provider in ('wikimedia', 'direct_pdf', 'google_drive'));

alter table public.pdf_access_sessions
  drop constraint if exists pdf_access_sessions_upstream_authorization_check;
alter table public.pdf_access_sessions
  add constraint pdf_access_sessions_upstream_authorization_check
  check (
    (
      provider = 'google_drive'
      and upstream_authorization_ciphertext is not null
      and pg_catalog.left(upstream_authorization_ciphertext, 3) = 'v1.'
      and pg_catalog.length(upstream_authorization_ciphertext) between 20 and 12000
    )
    or (
      provider <> 'google_drive'
      and upstream_authorization_ciphertext is null
    )
  );

comment on column public.pdf_access_sessions.upstream_authorization_ciphertext is
  'AES-GCM encrypted, short-lived upstream bearer used only by the Edge gateway; never returned to the browser.';

drop function if exists public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer
);

create function public.create_pdf_access_session(
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
  target_max_active_sessions integer,
  target_upstream_authorization_ciphertext text
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
  if (
    target_provider = 'google_drive'
    and nullif(pg_catalog.btrim(target_upstream_authorization_ciphertext), '') is null
  ) or (
    target_provider <> 'google_drive'
    and target_upstream_authorization_ciphertext is not null
  ) then
    raise exception using
      errcode = '22023',
      message = 'PDF_UPSTREAM_AUTHORIZATION_INVALID';
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
    expires_at,
    upstream_authorization_ciphertext
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
    target_expires_at,
    target_upstream_authorization_ciphertext
  )
  returning session.*;
end;
$$;

comment on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer, text
) is
  'Atomically creates a bounded PDF session and stores only encrypted, short-lived upstream authorization for Google Drive.';

revoke all on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer, text
) from public, anon, authenticated;
grant execute on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer, text
) to service_role;

commit;

-- Rollback (emergency only; first expire all Drive gateway sessions):
-- begin;
-- delete from public.pdf_access_sessions where provider = 'google_drive';
-- drop function if exists public.create_pdf_access_session(
--   text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer, text
-- );
-- alter table public.pdf_access_sessions drop constraint if exists pdf_access_sessions_upstream_authorization_check;
-- alter table public.pdf_access_sessions drop column if exists upstream_authorization_ciphertext;
-- alter table public.pdf_access_sessions drop constraint if exists pdf_access_sessions_provider_check;
-- alter table public.pdf_access_sessions add constraint pdf_access_sessions_provider_check
--   check (provider in ('wikimedia', 'direct_pdf'));
-- commit;
