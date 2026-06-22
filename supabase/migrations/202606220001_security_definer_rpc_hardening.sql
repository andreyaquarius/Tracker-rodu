begin;

-- Harden RPC functions flagged by Security Advisor.  Some SECURITY DEFINER
-- functions must remain callable by authenticated users because they are used
-- by RLS policies or perform controlled quota/account mutations.

create or replace function public.is_project_member(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and target_project_id is not null
    and exists (
      select 1
      from public.project_members
      where project_id = target_project_id
        and user_id = auth.uid()
    );
$$;

create or replace function public.can_edit_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and target_project_id is not null
    and exists (
      select 1
      from public.project_members
      where project_id = target_project_id
        and user_id = auth.uid()
        and role in ('owner', 'editor')
    );
$$;

create or replace function public.is_project_owner(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and target_project_id is not null
    and exists (
      select 1
      from public.projects
      where id = target_project_id
        and owner_id = auth.uid()
    );
$$;

create or replace function public.is_app_admin(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user_id is not null
    and (auth.uid() is not null or auth.role() = 'service_role')
    and exists (
      select 1
      from public.app_admins
      where user_id = target_user_id
    );
$$;

create or replace function public.accept_project_invitation(invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation public.project_invitations%rowtype;
  current_email text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if invitation_id is null then
    raise exception 'Invitation is invalid or expired' using errcode = 'P0001';
  end if;

  current_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if current_email = '' then
    raise exception 'Authenticated email is required' using errcode = '42501';
  end if;

  select *
    into invitation
  from public.project_invitations
  where id = invitation_id
  for update;

  if not found
     or invitation.status <> 'pending'
     or invitation.expires_at <= now()
     or lower(invitation.email) <> current_email then
    raise exception 'Invitation is invalid or expired' using errcode = 'P0001';
  end if;

  if public.is_project_owner(invitation.project_id) then
    raise exception 'Project owner cannot accept a lower role' using errcode = '42501';
  end if;

  insert into public.project_members (project_id, user_id, role, invited_by)
  values (invitation.project_id, auth.uid(), invitation.role, invitation.invited_by)
  on conflict (project_id, user_id)
  do update set role = excluded.role, invited_by = excluded.invited_by;

  update public.project_invitations
  set status = 'accepted',
      accepted_by = auth.uid(),
      accepted_at = now()
  where id = invitation.id;

  return invitation.project_id;
end;
$$;

-- Make administrative listing/update RPCs SECURITY INVOKER so authenticated
-- users can call the endpoint, but only app admins pass the function guard and
-- the supporting RLS policies below.

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin
on public.profiles for select to authenticated
using (public.is_app_admin(auth.uid()));

drop policy if exists user_subscriptions_admin_manage on public.user_subscriptions;
create policy user_subscriptions_admin_manage
on public.user_subscriptions for all to authenticated
using (public.is_app_admin(auth.uid()))
with check (public.is_app_admin(auth.uid()));

drop policy if exists subscription_events_admin_insert on public.subscription_events;
create policy subscription_events_admin_insert
on public.subscription_events for insert to authenticated
with check (public.is_app_admin(auth.uid()));

create or replace function public.admin_list_subscriptions()
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
security invoker
set search_path = public
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
    case
      when public.is_app_admin(profile.user_id) then 'professional'
      when subscription.status = 'trialing' and subscription.trial_ends_at > now() then 'professional'
      when subscription.status = 'active'
        and (subscription.current_period_end is null or subscription.current_period_end > now())
        then plan.code
      else 'free'
    end,
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
  left join public.subscription_plans plan on plan.id = subscription.plan_id
  order by public.is_app_admin(profile.user_id) desc, profile.created_at desc;
end;
$$;

create or replace function public.admin_set_subscription(
  target_user_id uuid,
  target_plan_code text,
  target_status text default 'active',
  target_period_end timestamptz default null,
  grant_trial boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  selected_plan_id uuid;
  previous_plan_id uuid;
  selected_subscription_id uuid;
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  if target_user_id is null then
    raise exception 'Target user is required' using errcode = 'P0001';
  end if;

  if public.is_app_admin(target_user_id) then
    raise exception 'ADMIN_SUBSCRIPTION_MANAGED_EXTERNALLY' using errcode = '42501';
  end if;

  if target_status not in ('active', 'trialing', 'past_due', 'cancelled', 'expired') then
    raise exception 'Unknown subscription status' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.profiles where profiles.user_id = target_user_id) then
    raise exception 'Target user was not found' using errcode = 'P0001';
  end if;

  select id
    into selected_plan_id
  from public.subscription_plans
  where code = target_plan_code
    and is_active;

  if selected_plan_id is null then
    raise exception 'Unknown subscription plan' using errcode = 'P0001';
  end if;

  select user_subscriptions.plan_id
    into previous_plan_id
  from public.user_subscriptions
  where user_id = target_user_id;

  insert into public.user_subscriptions (
    user_id,
    plan_id,
    status,
    started_at,
    current_period_start,
    current_period_end,
    trial_started_at,
    trial_ends_at,
    trial_granted_at,
    trial_used
  ) values (
    target_user_id,
    selected_plan_id,
    case when grant_trial then 'trialing' else target_status end,
    now(),
    case when grant_trial then null else now() end,
    case when grant_trial then null else target_period_end end,
    case when grant_trial then now() else null end,
    case when grant_trial then now() + interval '30 days' else null end,
    case when grant_trial then now() else null end,
    grant_trial
  )
  on conflict (user_id) do update set
    plan_id = excluded.plan_id,
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    trial_started_at = excluded.trial_started_at,
    trial_ends_at = excluded.trial_ends_at,
    trial_granted_at = coalesce(public.user_subscriptions.trial_granted_at, excluded.trial_granted_at),
    trial_used = public.user_subscriptions.trial_used or excluded.trial_used,
    updated_at = now()
  returning id into selected_subscription_id;

  insert into public.subscription_events (
    user_id,
    event_type,
    previous_plan_id,
    new_plan_id,
    subscription_id,
    metadata,
    performed_by
  ) values (
    target_user_id,
    case when grant_trial then 'trial_manually_granted' else 'subscription_changed' end,
    previous_plan_id,
    selected_plan_id,
    selected_subscription_id,
    jsonb_build_object('source', 'admin', 'status', target_status),
    auth.uid()
  );

  return selected_subscription_id;
end;
$$;

create or replace function public.begin_table_import(target_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
  current_used integer;
  usage_period_start date := date_trunc('month', now())::date;
  usage_period_end date := (date_trunc('month', now()) + interval '1 month')::date;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not public.can_edit_project(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  owner_id := public.project_owner_id(target_project_id);
  if owner_id is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  if not public.project_allows_new_records(target_project_id) then
    perform public.log_subscription_event(
      owner_id,
      'table_import_blocked',
      null,
      null,
      null,
      jsonb_build_object('limit_key', 'projects', 'project_id', target_project_id),
      auth.uid()
    );
    raise exception 'PLAN_SCOPE_CREATE_BLOCKED:projects' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(owner_id::text || ':table_imports_per_month', 0)
  );

  if not public.can_use_feature(owner_id, 'table_import', target_project_id) then
    perform public.log_subscription_event(
      owner_id,
      'table_import_blocked',
      null,
      null,
      null,
      jsonb_build_object('limit_key', 'table_imports_per_month', 'project_id', target_project_id),
      auth.uid()
    );
    raise exception 'PLAN_LIMIT_REACHED:table_imports_per_month' using errcode = 'P0001';
  end if;

  insert into public.subscription_usage (user_id, usage_key, period_start, period_end, used)
  values (owner_id, 'table_imports_per_month', usage_period_start, usage_period_end, 1)
  on conflict (user_id, usage_key, period_start)
  do update set used = public.subscription_usage.used + 1, updated_at = now()
  returning used into current_used;

  return current_used;
end;
$$;

create or replace function public.begin_hypothesis_ai_review(target_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_used integer;
  usage_period_start date := date_trunc('month', now())::date;
  usage_period_end date := (date_trunc('month', now()) + interval '1 month')::date;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not public.can_edit_project(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text || ':hypothesis_ai_reviews_per_month', 0)
  );

  if not public.can_use_feature(auth.uid(), 'hypothesis_ai_review', target_project_id) then
    perform public.log_subscription_event(
      auth.uid(),
      'hypothesis_ai_blocked',
      null,
      null,
      null,
      jsonb_build_object('limit_key', 'hypothesis_ai_reviews_per_month', 'project_id', target_project_id),
      auth.uid()
    );
    raise exception 'AI_HYPOTHESIS_ANALYSIS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  insert into public.subscription_usage (user_id, usage_key, period_start, period_end, used)
  values (auth.uid(), 'hypothesis_ai_reviews_per_month', usage_period_start, usage_period_end, 1)
  on conflict (user_id, usage_key, period_start)
  do update set used = public.subscription_usage.used + 1, updated_at = now()
  returning used into current_used;

  return current_used;
end;
$$;

create or replace function public.get_my_subscription_context(target_project_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  user_id uuid := auth.uid();
  effective record;
  result jsonb;
  limits jsonb;
  usage jsonb;
  section_quotas jsonb := '{}'::jsonb;
  project_mode text := null;
begin
  if user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if target_project_id is not null and not public.is_project_member(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  select * into effective from public.get_user_effective_subscription(user_id);

  if target_project_id is not null then
    project_mode := public.project_subscription_access_mode(target_project_id);
    section_quotas := public.standard_section_record_quotas(target_project_id);
  end if;

  select coalesce(jsonb_object_agg(limit_key, jsonb_build_object(
    'value', limit_value,
    'isUnlimited', is_unlimited
  )), '{}'::jsonb)
    into limits
  from public.get_user_plan_limits(user_id);

  select jsonb_build_object(
    'projects', public.get_plan_usage(user_id, 'projects', target_project_id),
    'researchesTotal', public.get_plan_usage(user_id, 'researches_total', target_project_id),
    'researchesPerProject', public.get_plan_usage(user_id, 'researches_per_project', target_project_id),
    'recordsPerStandardSection', public.get_plan_usage(user_id, 'records_per_standard_section', target_project_id),
    'projectMembers', public.get_plan_usage(user_id, 'project_members', target_project_id),
    'customSectionsPerProject', public.get_plan_usage(user_id, 'custom_sections_per_project', target_project_id),
    'customFieldsPerProject', public.get_plan_usage(user_id, 'custom_fields_per_project', target_project_id),
    'tableImportsPerMonth', public.get_plan_usage(user_id, 'table_imports_per_month', target_project_id),
    'hypothesisAiReviewsPerMonth', public.get_plan_usage(user_id, 'hypothesis_ai_reviews_per_month', target_project_id)
  ) into usage;

  select jsonb_build_object(
    'subscription', jsonb_build_object(
      'id', effective.subscription_id,
      'storedPlanCode', effective.stored_plan_code,
      'status', effective.status,
      'currentPeriodStart', effective.current_period_start,
      'currentPeriodEnd', effective.current_period_end,
      'trialStartedAt', effective.trial_started_at,
      'trialEndsAt', effective.trial_ends_at,
      'trialUsed', effective.trial_used
    ),
    'effectivePlanCode', effective.effective_plan_code,
    'plan', to_jsonb(plan),
    'limits', limits,
    'usage', usage,
    'sectionQuotas', section_quotas,
    'isAdmin', public.is_app_admin(user_id),
    'projectAccessMode', project_mode,
    'canCreateProjectRecords', coalesce(project_mode = 'FULL', true),
    'serverNow', now()
  ) into result
  from public.subscription_plans plan
  where plan.code = effective.effective_plan_code;

  return result;
end;
$$;

create or replace function public.cancel_my_subscription()
returns jsonb
language plpgsql
security definer
set search_path = public
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

  select id
    into free_plan_id
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

revoke execute on function public.accept_project_invitation(uuid) from public, anon;
revoke execute on function public.admin_list_subscriptions() from public, anon;
revoke execute on function public.admin_set_subscription(uuid, text, text, timestamptz, boolean) from public, anon;
revoke execute on function public.begin_hypothesis_ai_review(uuid) from public, anon;
revoke execute on function public.begin_table_import(uuid) from public, anon;
revoke execute on function public.can_edit_project(uuid) from public, anon;
revoke execute on function public.cancel_my_subscription() from public, anon;
revoke execute on function public.get_my_subscription_context(uuid) from public, anon;
revoke execute on function public.is_app_admin(uuid) from public, anon;
revoke execute on function public.is_project_member(uuid) from public, anon;
revoke execute on function public.is_project_owner(uuid) from public, anon;

grant execute on function public.accept_project_invitation(uuid) to authenticated;
grant execute on function public.admin_list_subscriptions() to authenticated;
grant execute on function public.admin_set_subscription(uuid, text, text, timestamptz, boolean) to authenticated;
grant execute on function public.begin_hypothesis_ai_review(uuid) to authenticated;
grant execute on function public.begin_table_import(uuid) to authenticated;
grant execute on function public.can_edit_project(uuid) to authenticated;
grant execute on function public.cancel_my_subscription() to authenticated;
grant execute on function public.get_my_subscription_context(uuid) to authenticated;
grant execute on function public.is_app_admin(uuid) to authenticated;
grant execute on function public.is_project_member(uuid) to authenticated;
grant execute on function public.is_project_owner(uuid) to authenticated;

commit;
