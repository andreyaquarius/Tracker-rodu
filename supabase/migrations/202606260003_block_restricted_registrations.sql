begin;

create or replace function public.is_restricted_registration_email(email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with normalized as (
    select regexp_replace(
      split_part(lower(btrim(coalesce(email, ''))), '@', 2),
      '\.+$',
      ''
    ) as domain
  )
  select domain = 'ru' or domain like '%.ru'
  from normalized;
$$;

create or replace function public.is_restricted_registration_country(country_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select upper(btrim(coalesce(country_code, ''))) in ('RU', 'RUS');
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  professional_plan_id uuid;
  subscription_id uuid;
begin
  if public.is_restricted_registration_email(new.email) then
    raise exception 'REGISTRATION_BLOCKED:EMAIL_DOMAIN' using errcode = 'P0001';
  end if;

  insert into public.profiles (user_id, email, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture', '')
  )
  on conflict (user_id) do update set
    email = excluded.email,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    updated_at = now();

  if not exists (select 1 from public.user_subscriptions where user_id = new.id) then
    select id into professional_plan_id from public.subscription_plans where code = 'professional';
    insert into public.user_subscriptions (
      user_id, plan_id, status, started_at,
      trial_started_at, trial_ends_at, trial_granted_at, trial_used
    ) values (
      new.id, professional_plan_id, 'trialing', now(),
      now(), now() + interval '30 days', now(), true
    ) returning id into subscription_id;
    perform public.log_subscription_event(
      new.id, 'trial_granted', null, professional_plan_id,
      subscription_id, jsonb_build_object('source', 'auth_trigger'), null
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.is_restricted_registration_email(text) from public, anon, authenticated;
revoke execute on function public.is_restricted_registration_country(text) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

commit;
