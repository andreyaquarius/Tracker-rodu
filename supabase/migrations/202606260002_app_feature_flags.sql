begin;

create table if not exists public.app_feature_flags (
  key text primary key,
  title text not null,
  description text,
  is_enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.app_feature_flags (key, title, description, is_enabled)
values (
  'genehelp_public',
  'GeneHelp для всіх користувачів',
  'Показує кнопку "Попросити допомоги в GeneHelp" усім користувачам. Адміністратор бачить її завжди.',
  false
)
on conflict (key) do update
set
  title = excluded.title,
  description = excluded.description;

alter table public.app_feature_flags enable row level security;

revoke all on public.app_feature_flags from anon, authenticated;
grant select, insert, update, delete on public.app_feature_flags to service_role;

drop trigger if exists app_feature_flags_set_updated_at on public.app_feature_flags;
create trigger app_feature_flags_set_updated_at
before update on public.app_feature_flags
for each row execute function public.set_updated_at();

create or replace function public.get_app_feature_flags()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, is_enabled), '{}'::jsonb)
  from public.app_feature_flags;
$$;

create or replace function public.admin_list_feature_flags()
returns table (
  key text,
  title text,
  description text,
  is_enabled boolean,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED';
  end if;

  return query
  select
    flag.key,
    flag.title,
    flag.description,
    flag.is_enabled,
    flag.updated_at
  from public.app_feature_flags flag
  order by flag.title;
end;
$$;

create or replace function public.admin_set_feature_flag(
  target_key text,
  target_is_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED';
  end if;

  update public.app_feature_flags
  set
    is_enabled = target_is_enabled,
    updated_by = auth.uid(),
    updated_at = now()
  where key = target_key;

  if not found then
    raise exception 'UNKNOWN_FEATURE_FLAG:%', target_key;
  end if;
end;
$$;

revoke execute on function public.get_app_feature_flags() from public, anon;
revoke execute on function public.admin_list_feature_flags() from public, anon;
revoke execute on function public.admin_set_feature_flag(text, boolean) from public, anon;
grant execute on function public.get_app_feature_flags() to authenticated;
grant execute on function public.admin_list_feature_flags() to authenticated;
grant execute on function public.admin_set_feature_flag(text, boolean) to authenticated;

commit;
