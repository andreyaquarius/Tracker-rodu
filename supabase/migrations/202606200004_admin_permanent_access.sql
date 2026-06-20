begin;

create or replace function public.get_user_active_plan(user_uuid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.is_app_admin(user_uuid) then 'professional'
    when subscription.status = 'trialing' and subscription.trial_ends_at > now()
      then 'professional'
    when subscription.status = 'active'
      and (subscription.current_period_end is null or subscription.current_period_end > now())
      then plan.code
    else 'free'
  end
  from public.user_subscriptions subscription
  join public.subscription_plans plan on plan.id = subscription.plan_id
  where subscription.user_id = user_uuid
  union all
  select case when public.is_app_admin(user_uuid) then 'professional' else 'free' end
  where not exists (
    select 1 from public.user_subscriptions where user_id = user_uuid
  )
  limit 1;
$$;

create or replace function public.get_user_effective_subscription(user_uuid uuid)
returns table (
  subscription_id uuid,
  stored_plan_code text,
  effective_plan_code text,
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_used boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    subscription.id,
    case
      when public.is_app_admin(user_uuid) then 'professional'
      else coalesce(plan.code, 'free')
    end,
    public.get_user_active_plan(user_uuid),
    case
      when public.is_app_admin(user_uuid) then 'active'
      when subscription.status = 'trialing' and subscription.trial_ends_at <= now() then 'expired'
      when subscription.status = 'active'
        and subscription.current_period_end is not null
        and subscription.current_period_end <= now() then 'expired'
      else coalesce(subscription.status, 'active')
    end,
    subscription.current_period_start,
    case when public.is_app_admin(user_uuid) then null else subscription.current_period_end end,
    case when public.is_app_admin(user_uuid) then null else subscription.trial_started_at end,
    case when public.is_app_admin(user_uuid) then null else subscription.trial_ends_at end,
    coalesce(subscription.trial_used, false)
  from (select user_uuid as user_id) requested
  left join public.user_subscriptions subscription on subscription.user_id = requested.user_id
  left join public.subscription_plans plan on plan.id = subscription.plan_id;
$$;

drop function if exists public.admin_list_subscriptions();

create function public.admin_list_subscriptions()
returns table (
  user_id uuid,
  email text,
  display_name text,
  plan_code text,
  status text,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  is_admin boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  return query
  select
    profile.user_id,
    profile.email,
    profile.display_name,
    public.get_user_active_plan(profile.user_id),
    case
      when public.is_app_admin(profile.user_id) then 'active'
      when subscription.status = 'trialing' and subscription.trial_ends_at <= now() then 'expired'
      when subscription.status = 'active'
        and subscription.current_period_end is not null
        and subscription.current_period_end <= now() then 'expired'
      else coalesce(subscription.status, 'active')
    end,
    case when public.is_app_admin(profile.user_id) then null else subscription.trial_ends_at end,
    case when public.is_app_admin(profile.user_id) then null else subscription.current_period_end end,
    public.is_app_admin(profile.user_id)
  from public.profiles profile
  left join public.user_subscriptions subscription on subscription.user_id = profile.user_id
  order by public.is_app_admin(profile.user_id) desc, profile.created_at desc;
end;
$$;

revoke execute on function public.admin_list_subscriptions() from public, anon;
grant execute on function public.admin_list_subscriptions() to authenticated;

commit;
