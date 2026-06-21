begin;

create or replace function public.cancel_my_subscription()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_user_id uuid := auth.uid();
  free_plan_id uuid;
  current_subscription_id uuid;
  previous_plan_id uuid;
  active_plan text;
  updated_subscription_id uuid;
begin
  if actor_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if public.is_app_admin(actor_user_id) then
    raise exception 'ADMIN_SUBSCRIPTION_MANAGED_EXTERNALLY' using errcode = '42501';
  end if;

  select id into free_plan_id
  from public.subscription_plans
  where code = 'free'
    and is_active;

  if free_plan_id is null then
    raise exception 'START_PLAN_NOT_CONFIGURED' using errcode = 'P0001';
  end if;

  active_plan := public.get_user_active_plan(actor_user_id);
  if active_plan = 'free' then
    return jsonb_build_object(
      'status', 'unchanged',
      'effectivePlanCode', 'free',
      'message', 'START_PLAN_HAS_NO_PAID_SUBSCRIPTION'
    );
  end if;

  select id, plan_id
    into current_subscription_id, previous_plan_id
  from public.user_subscriptions
  where user_subscriptions.user_id = actor_user_id
  for update;

  if current_subscription_id is null then
    insert into public.user_subscriptions (
      user_id,
      plan_id,
      status,
      started_at,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      cancelled_at
    )
    values (
      actor_user_id,
      free_plan_id,
      'active',
      now(),
      now(),
      null,
      false,
      now()
    )
    returning id into updated_subscription_id;
  else
    update public.user_subscriptions
    set
      plan_id = free_plan_id,
      status = 'active',
      current_period_start = now(),
      current_period_end = null,
      cancel_at_period_end = false,
      cancelled_at = now(),
      payment_status = 'cancelled',
      updated_at = now()
    where id = current_subscription_id
    returning id into updated_subscription_id;
  end if;

  insert into public.subscription_events (
    user_id,
    event_type,
    previous_plan_id,
    new_plan_id,
    subscription_id,
    metadata,
    performed_by
  )
  values (
    actor_user_id,
    'subscription_cancelled_by_user',
    previous_plan_id,
    free_plan_id,
    updated_subscription_id,
    jsonb_build_object('previous_effective_plan_code', active_plan),
    actor_user_id
  );

  return jsonb_build_object(
    'status', 'cancelled',
    'effectivePlanCode', 'free'
  );
end;
$$;

revoke execute on function public.cancel_my_subscription() from public, anon;
grant execute on function public.cancel_my_subscription() to authenticated;

commit;
