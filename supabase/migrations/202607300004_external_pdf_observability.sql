begin;

-- Privacy-safe operational events use an independent rate bucket. It contains
-- only the authentication scope required for abuse protection; no URL,
-- document/person identifier, file name, token, header, or event payload is
-- persisted in PostgreSQL.
create table if not exists private.external_pdf_telemetry_rate_limits (
  user_id uuid not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

revoke all on private.external_pdf_telemetry_rate_limits
  from public, anon, authenticated;

create or replace function public.reserve_external_pdf_telemetry_event(
  target_user_id uuid,
  target_project_id uuid,
  target_max_requests integer,
  target_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  now_value timestamptz := pg_catalog.clock_timestamp();
  window_length interval;
  resulting_count integer;
begin
  if target_user_id is null or target_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'PDF_TELEMETRY_SCOPE_INVALID';
  end if;
  if target_max_requests is null
    or target_max_requests < 10
    or target_max_requests > 2000
    or target_window_seconds is null
    or target_window_seconds < 10
    or target_window_seconds > 3600
  then
    raise exception using
      errcode = '22023',
      message = 'PDF_TELEMETRY_LIMIT_INVALID';
  end if;

  window_length := target_window_seconds * interval '1 second';

  insert into private.external_pdf_telemetry_rate_limits as bucket (
    user_id,
    project_id,
    window_started_at,
    request_count,
    updated_at
  ) values (
    target_user_id,
    target_project_id,
    now_value,
    1,
    now_value
  )
  on conflict (user_id, project_id) do update
  set
    window_started_at = case
      when bucket.window_started_at <= now_value - window_length then now_value
      else bucket.window_started_at
    end,
    request_count = case
      when bucket.window_started_at <= now_value - window_length then 1
      when bucket.request_count >= 2147483647 then 2147483647
      else bucket.request_count + 1
    end,
    updated_at = now_value
  returning request_count into resulting_count;

  return resulting_count <= target_max_requests;
end;
$$;

comment on function public.reserve_external_pdf_telemetry_event(uuid, uuid, integer, integer)
is 'Atomically reserves one privacy-safe external PDF operational event for a user/project window.';

revoke all on function public.reserve_external_pdf_telemetry_event(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_external_pdf_telemetry_event(uuid, uuid, integer, integer)
  to service_role;

commit;
