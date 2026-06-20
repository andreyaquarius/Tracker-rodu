begin;

with configured(code, limit_key, limit_value, is_unlimited) as (
  values
    ('free', 'hypothesis_ai_reviews_per_month', 0, false),
    ('researcher', 'hypothesis_ai_reviews_per_month', 5, false),
    ('professional', 'hypothesis_ai_reviews_per_month', 10, false)
)
insert into public.plan_limits (plan_id, limit_key, limit_value, is_unlimited)
select plans.id, configured.limit_key, configured.limit_value, configured.is_unlimited
from configured
join public.subscription_plans plans on plans.code = configured.code
on conflict (plan_id, limit_key) do update set
  limit_value = excluded.limit_value,
  is_unlimited = excluded.is_unlimited,
  updated_at = now();

create or replace function public.get_plan_usage(
  user_uuid uuid,
  limit_key text,
  project_uuid uuid default null
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result integer := 0;
begin
  case limit_key
    when 'projects' then
      select count(*)::integer into result from public.projects where owner_id = user_uuid;
    when 'researches_total' then
      select count(*)::integer into result
      from public.researches research
      join public.projects project on project.id = research.project_id
      where project.owner_id = user_uuid;
    when 'researches_per_project' then
      select count(*)::integer into result from public.researches where project_id = project_uuid;
    when 'project_members' then
      select count(*)::integer into result
      from public.project_members where project_id = project_uuid and role <> 'owner';
    when 'custom_sections_per_project' then
      select count(*)::integer into result from public.custom_sections where project_id = project_uuid;
    when 'custom_fields_per_project' then
      select count(*)::integer into result
      from public.custom_field_definitions
      where project_id = project_uuid;
    when 'table_imports_per_month' then
      select coalesce(max(used), 0) into result
      from public.subscription_usage
      where user_id = user_uuid
        and usage_key = limit_key
        and period_start = date_trunc('month', now())::date;
    when 'hypothesis_ai_reviews_per_month' then
      select coalesce(max(used), 0) into result
      from public.subscription_usage
      where user_id = user_uuid
        and usage_key = limit_key
        and period_start = date_trunc('month', now())::date;
    else
      result := 0;
  end case;
  return coalesce(result, 0);
end;
$$;

create or replace function public.can_use_feature(
  user_uuid uuid,
  feature_key text,
  project_uuid uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case feature_key
    when 'custom_sections' then public.check_plan_limit(user_uuid, 'custom_sections_per_project', project_uuid)
    when 'custom_fields' then public.check_plan_limit(user_uuid, 'custom_fields_per_project', project_uuid)
    when 'table_import' then public.check_plan_limit(user_uuid, 'table_imports_per_month', project_uuid)
    when 'hypothesis_ai_review' then public.check_plan_limit(user_uuid, 'hypothesis_ai_reviews_per_month', project_uuid)
    when 'project_members' then public.check_plan_limit(user_uuid, 'project_members', project_uuid)
    else true
  end;
$$;

create or replace function public.begin_hypothesis_ai_review(target_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_used integer;
  period_start date := date_trunc('month', now())::date;
  period_end date := (date_trunc('month', now()) + interval '1 month')::date;
begin
  if not public.is_project_member(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text || ':hypothesis_ai_reviews_per_month', 0)
  );
  if not public.can_use_feature(auth.uid(), 'hypothesis_ai_review', target_project_id) then
    perform public.log_subscription_event(
      auth.uid(), 'hypothesis_ai_review_blocked', null, null, null,
      jsonb_build_object('limit_key', 'hypothesis_ai_reviews_per_month', 'project_id', target_project_id)
    );
    raise exception 'PLAN_LIMIT_REACHED:hypothesis_ai_reviews_per_month' using errcode = 'P0001';
  end if;

  insert into public.subscription_usage (user_id, usage_key, period_start, period_end, used)
  values (auth.uid(), 'hypothesis_ai_reviews_per_month', period_start, period_end, 1)
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
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  effective record;
  result jsonb;
  limits jsonb;
  usage jsonb;
begin
  if user_id is null then raise exception 'Authentication required'; end if;
  select * into effective from public.get_user_effective_subscription(user_id);
  select coalesce(jsonb_object_agg(limit_key, jsonb_build_object(
    'value', limit_value, 'isUnlimited', is_unlimited
  )), '{}'::jsonb) into limits
  from public.get_user_plan_limits(user_id);
  select jsonb_build_object(
    'projects', public.get_plan_usage(user_id, 'projects', target_project_id),
    'researchesTotal', public.get_plan_usage(user_id, 'researches_total', target_project_id),
    'researchesPerProject', public.get_plan_usage(user_id, 'researches_per_project', target_project_id),
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
    'isAdmin', public.is_app_admin(user_id),
    'serverNow', now()
  ) into result
  from public.subscription_plans plan
  where plan.code = effective.effective_plan_code;
  return result;
end;
$$;

revoke execute on function public.begin_hypothesis_ai_review(uuid) from public, anon;
grant execute on function public.begin_hypothesis_ai_review(uuid) to authenticated;

commit;
