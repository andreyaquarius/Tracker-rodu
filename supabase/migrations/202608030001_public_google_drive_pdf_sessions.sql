begin;

-- A public Drive share uses the server-only API key and therefore must not
-- carry an OAuth bearer. Bind each session to its source access mode so the
-- database can distinguish that flow from a private Drive session.
alter table public.pdf_access_sessions
  add column if not exists upstream_access_mode text;

update public.pdf_access_sessions
set upstream_access_mode = case
  when provider = 'google_drive' and upstream_authorization_ciphertext is not null
    then 'google_drive_api'
  else 'secure_proxy'
end
where upstream_access_mode is null;

alter table public.pdf_access_sessions
  alter column upstream_access_mode set not null;

alter table public.pdf_access_sessions
  drop constraint if exists pdf_access_sessions_upstream_access_mode_check;
alter table public.pdf_access_sessions
  add constraint pdf_access_sessions_upstream_access_mode_check
  check (
    upstream_access_mode in ('secure_proxy', 'google_drive_api')
    and (
      (provider = 'google_drive')
      or (provider in ('wikimedia', 'direct_pdf') and upstream_access_mode = 'secure_proxy')
    )
  );

alter table public.pdf_access_sessions
  drop constraint if exists pdf_access_sessions_upstream_authorization_check;
alter table public.pdf_access_sessions
  add constraint pdf_access_sessions_upstream_authorization_check
  check (
    (
      upstream_access_mode = 'google_drive_api'
      and provider = 'google_drive'
      and upstream_authorization_ciphertext is not null
      and pg_catalog.left(upstream_authorization_ciphertext, 3) = 'v1.'
      and pg_catalog.length(upstream_authorization_ciphertext) between 20 and 12000
    )
    or (
      upstream_access_mode = 'secure_proxy'
      and upstream_authorization_ciphertext is null
    )
  );

comment on column public.pdf_access_sessions.upstream_access_mode is
  'Access mode copied from the verified source. Public Drive uses secure_proxy without OAuth; private Drive uses google_drive_api with encrypted OAuth.';

drop function if exists public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, jsonb, integer, timestamptz, integer, text
);

create function public.create_pdf_access_session(
  target_token_hash text,
  target_project_id uuid,
  target_document_id uuid,
  target_document_source_id uuid,
  target_user_id uuid,
  target_provider text,
  target_upstream_access_mode text,
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
  if target_upstream_access_mode not in ('secure_proxy', 'google_drive_api')
    or (target_provider <> 'google_drive' and target_upstream_access_mode <> 'secure_proxy')
    or (
      target_upstream_access_mode = 'google_drive_api'
      and (
        target_provider <> 'google_drive'
        or nullif(pg_catalog.btrim(target_upstream_authorization_ciphertext), '') is null
      )
    )
    or (
      target_upstream_access_mode = 'secure_proxy'
      and target_upstream_authorization_ciphertext is not null
    )
  then
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
    upstream_access_mode,
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
    target_upstream_access_mode,
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
  text, uuid, uuid, uuid, uuid, text, text, text, jsonb, integer, timestamptz, integer, text
) is
  'Creates a bounded PDF gateway session and enforces the verified public/private Drive access mode.';

revoke all on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, text, jsonb, integer, timestamptz, integer, text
) from public, anon, authenticated;
grant execute on function public.create_pdf_access_session(
  text, uuid, uuid, uuid, uuid, text, text, text, jsonb, integer, timestamptz, integer, text
) to service_role;

commit;

-- Rollback (expire active sessions first):
-- delete from public.pdf_access_sessions;
-- drop function if exists public.create_pdf_access_session(
--   text, uuid, uuid, uuid, uuid, text, text, text, jsonb, integer, timestamptz, integer, text
-- );
-- alter table public.pdf_access_sessions drop constraint if exists pdf_access_sessions_upstream_access_mode_check;
-- alter table public.pdf_access_sessions drop column if exists upstream_access_mode;
