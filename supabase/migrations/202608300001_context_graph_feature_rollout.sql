begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Private rollout for the person-centred context graphs.  The global flag is
-- deliberately OFF on deployment.  Administrators can opt only their own
-- account into the preview without granting the feature to another admin.
alter table public.app_feature_flags
  add column if not exists supports_private_preview boolean not null default false;

insert into public.app_feature_flags (
  key,
  title,
  description,
  is_enabled,
  supports_private_preview
)
values (
  'person_context_graphs_v1',
  'Зв’язки та оточення особи (ТЗ №13)',
  'Приватне тестування соціальних, родових і документальних графів. «Для всіх» відкриває модуль усім авторизованим користувачам; «Лише мені» — тільки поточному адміністратору.',
  false,
  true
)
on conflict (key) do update
set title = excluded.title,
    description = excluded.description,
    supports_private_preview = excluded.supports_private_preview;

create table if not exists security_private.app_feature_user_access (
  feature_key text not null references public.app_feature_flags(key) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  granted_by uuid references public.profiles(user_id) on delete set null,
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (feature_key, user_id)
);

alter table security_private.app_feature_user_access enable row level security;

comment on table security_private.app_feature_user_access is
  'Private per-account preview allow-list. It never grants project data access by itself.';

revoke all on table security_private.app_feature_user_access
from public, anon, authenticated, service_role;
grant select, insert, update, delete on table security_private.app_feature_user_access
to service_role;

create or replace function security_private.app_feature_access_for_user_v1(
  p_feature_key text,
  p_user_id uuid,
  p_global_only boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce((
    select flag.is_enabled
      or (
        not coalesce(p_global_only, true)
        and p_user_id is not null
        and flag.supports_private_preview
        and exists (
          select 1
          from security_private.app_feature_user_access preview
          where preview.feature_key = flag.key
            and preview.user_id = p_user_id
        )
      )
    from public.app_feature_flags flag
    where flag.key = p_feature_key
  ), false);
$function$;

create or replace function security_private.get_my_app_feature_flags_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce(
    jsonb_object_agg(
      flag.key,
      security_private.app_feature_access_for_user_v1(
        flag.key,
        auth.uid(),
        false
      )
    ),
    '{}'::jsonb
  )
  from public.app_feature_flags flag;
$function$;

create or replace function security_private.get_my_app_feature_access_v1(
  p_feature_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  actor_id uuid := auth.uid();
  target_flag public.app_feature_flags%rowtype;
  preview_enabled boolean := false;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select flag.* into target_flag
  from public.app_feature_flags flag
  where flag.key = p_feature_key;

  if not found then
    raise exception 'UNKNOWN_FEATURE_FLAG:%', p_feature_key using errcode = 'P0002';
  end if;

  if target_flag.supports_private_preview then
    select exists (
      select 1
      from security_private.app_feature_user_access preview
      where preview.feature_key = target_flag.key
        and preview.user_id = actor_id
    ) into preview_enabled;
  end if;

  return jsonb_build_object(
    'key', target_flag.key,
    'globalEnabled', target_flag.is_enabled,
    'supportsPrivatePreview', target_flag.supports_private_preview,
    'previewEnabled', preview_enabled,
    'effectiveEnabled', target_flag.is_enabled or preview_enabled
  );
end;
$function$;

create or replace function security_private.admin_list_feature_flags_v1()
returns table (
  key text,
  title text,
  description text,
  is_enabled boolean,
  supports_private_preview boolean,
  is_preview_enabled boolean,
  is_effectively_enabled boolean,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare actor_id uuid := auth.uid();
begin
  if actor_id is null or not security_private.is_app_admin(actor_id) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    flag.key,
    flag.title,
    flag.description,
    flag.is_enabled,
    flag.supports_private_preview,
    flag.supports_private_preview
      and coalesce(preview.user_id is not null, false),
    security_private.app_feature_access_for_user_v1(
      flag.key,
      actor_id,
      false
    ),
    flag.updated_at
  from public.app_feature_flags flag
  left join security_private.app_feature_user_access preview
    on preview.feature_key = flag.key
   and preview.user_id = actor_id
  order by flag.title;
end;
$function$;

create or replace function security_private.admin_set_my_feature_preview_v1(
  p_feature_key text,
  p_is_enabled boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  actor_id uuid := auth.uid();
  preview_supported boolean;
begin
  if actor_id is null or not security_private.is_app_admin(actor_id) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_is_enabled is null then
    raise exception 'FEATURE_PREVIEW_STATE_REQUIRED' using errcode = '22023';
  end if;

  select flag.supports_private_preview
  into preview_supported
  from public.app_feature_flags flag
  where flag.key = p_feature_key;

  if not found then
    raise exception 'UNKNOWN_FEATURE_FLAG:%', p_feature_key using errcode = 'P0002';
  end if;
  if not preview_supported then
    raise exception 'PRIVATE_PREVIEW_NOT_SUPPORTED:%', p_feature_key using errcode = '22023';
  end if;

  if p_is_enabled then
    insert into security_private.app_feature_user_access (
      feature_key,
      user_id,
      granted_by,
      granted_at,
      updated_at
    ) values (
      p_feature_key,
      actor_id,
      actor_id,
      now(),
      now()
    )
    on conflict (feature_key, user_id) do update
    set granted_by = excluded.granted_by,
        updated_at = excluded.updated_at;
  else
    delete from security_private.app_feature_user_access preview
    where preview.feature_key = p_feature_key
      and preview.user_id = actor_id;
  end if;
end;
$function$;

create or replace function security_private.require_app_feature_global_v1(
  p_feature_key text
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
begin
  if not security_private.app_feature_access_for_user_v1(
    p_feature_key,
    null,
    true
  ) then
    raise exception 'APP_FEATURE_DISABLED:%', p_feature_key using errcode = '42501';
  end if;
end;
$function$;

-- The original bearer-token resolver must no longer be executable by an API
-- role directly: it validates the token, but predates the rollout flag.  Keep
-- the public facade SECURITY INVOKER and expose only this guarded private
-- entry point, so even an accidental future API-schema configuration cannot
-- bypass the global-off boundary.
create or replace function security_private.get_shared_context_graph_view_guarded_v1(
  p_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
begin
  perform security_private.require_app_feature_global_v1(
    'person_context_graphs_v1'
  );
  return security_private.get_shared_context_graph_view_v1(p_token);
end;
$function$;

-- Keep automated synchronizers and backfills alive under service_role, while
-- all browser-visible context RPCs fail closed before project data is read.
create or replace function security_private.require_context_project_access_v1(
  p_project_id uuid,
  p_write boolean default false
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare actor_id uuid := auth.uid();
begin
  if p_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    if not exists (select 1 from public.projects project where project.id = p_project_id) then
      raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
    end if;
    return;
  end if;
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not security_private.app_feature_access_for_user_v1(
    'person_context_graphs_v1',
    actor_id,
    false
  ) then
    raise exception 'APP_FEATURE_DISABLED:person_context_graphs_v1' using errcode = '42501';
  end if;
  if p_write then
    if not public.can_edit_project(p_project_id) then
      raise exception 'PROJECT_EDIT_REQUIRED' using errcode = '42501';
    end if;
  elsif not public.is_project_member(p_project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
end;
$function$;

create or replace function security_private.require_context_graph_share_project_owner_v1(
  p_project_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare actor_id uuid := auth.uid();
begin
  if auth.role() <> 'authenticated' or actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not security_private.app_feature_access_for_user_v1(
    'person_context_graphs_v1',
    actor_id,
    false
  ) then
    raise exception 'APP_FEATURE_DISABLED:person_context_graphs_v1' using errcode = '42501';
  end if;
  if p_project_id is null or not exists (
    select 1 from public.projects project
    where project.id = p_project_id and project.owner_id = actor_id
  ) then
    raise exception 'CONTEXT_GRAPH_SHARE_PROJECT_OWNER_REQUIRED'
      using errcode = '42501';
  end if;
  return actor_id;
end;
$function$;

create or replace function public.get_app_feature_flags()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.get_my_app_feature_flags_v1();
$function$;

create or replace function public.get_my_app_feature_access_v1(
  p_feature_key text
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.get_my_app_feature_access_v1($1);
$function$;

drop function if exists public.admin_list_feature_flags();
create function public.admin_list_feature_flags()
returns table (
  key text,
  title text,
  description text,
  is_enabled boolean,
  supports_private_preview boolean,
  is_preview_enabled boolean,
  is_effectively_enabled boolean,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select * from security_private.admin_list_feature_flags_v1();
$function$;

create or replace function public.admin_set_my_feature_preview_v1(
  p_feature_key text,
  p_is_enabled boolean
)
returns void
language sql
volatile
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.admin_set_my_feature_preview_v1($1, $2);
$function$;

create or replace function public.get_shared_context_graph_view_v1(
  p_token text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
begin
  return security_private.get_shared_context_graph_view_guarded_v1(p_token);
end;
$function$;

do $private_function_acl$
declare function_record record;
begin
  for function_record in
    select procedure.oid::regprocedure signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'security_private'
      and procedure.proname = any(array[
        'app_feature_access_for_user_v1',
        'get_my_app_feature_flags_v1',
        'get_my_app_feature_access_v1',
        'admin_list_feature_flags_v1',
        'admin_set_my_feature_preview_v1',
        'require_app_feature_global_v1',
        'get_shared_context_graph_view_guarded_v1'
      ]::text[])
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_record.signature
    );
  end loop;
end;
$private_function_acl$;

grant usage on schema security_private to anon, authenticated, service_role;
grant execute on function security_private.get_my_app_feature_flags_v1()
to authenticated;
grant execute on function security_private.get_my_app_feature_access_v1(text)
to authenticated;
grant execute on function security_private.admin_list_feature_flags_v1()
to authenticated;
grant execute on function security_private.admin_set_my_feature_preview_v1(text, boolean)
to authenticated;
grant execute on function security_private.require_app_feature_global_v1(text)
to anon, authenticated;
grant execute on function security_private.get_shared_context_graph_view_guarded_v1(text)
to anon, authenticated;

-- `202608290023` granted the pre-rollout resolver to API roles because the
-- old public facade called it directly.  The guarded resolver above replaces
-- that call and lets us close the bypass without making the public facade a
-- SECURITY DEFINER function.
revoke all on function security_private.get_shared_context_graph_view_v1(text)
from public, anon, authenticated, service_role;

revoke all on function public.get_app_feature_flags()
from public, anon, authenticated, service_role;
revoke all on function public.get_my_app_feature_access_v1(text)
from public, anon, authenticated, service_role;
revoke all on function public.admin_list_feature_flags()
from public, anon, authenticated, service_role;
revoke all on function public.admin_set_my_feature_preview_v1(text, boolean)
from public, anon, authenticated, service_role;

grant execute on function public.get_app_feature_flags()
to authenticated;
grant execute on function public.get_my_app_feature_access_v1(text)
to authenticated;
grant execute on function public.admin_list_feature_flags()
to authenticated;
grant execute on function public.admin_set_my_feature_preview_v1(text, boolean)
to authenticated;

-- Preserve the anonymous share facade grant, but it now requires the global
-- rollout flag and cannot expose a preview-only graph.
revoke all on function public.get_shared_context_graph_view_v1(text)
from public, anon, authenticated, service_role;
grant execute on function public.get_shared_context_graph_view_v1(text)
to anon, authenticated;

notify pgrst, 'reload schema';

commit;
