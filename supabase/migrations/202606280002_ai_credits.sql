begin;

with configured(code, limit_value) as (
  values
    ('free', 5),
    ('researcher', 50),
    ('professional', 100)
)
insert into public.plan_limits (plan_id, limit_key, limit_value, is_unlimited)
select plans.id, 'ai_credits_per_month', configured.limit_value, false
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
set search_path = public
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
    when 'records_per_standard_section' then
      if project_uuid is not null then
        select coalesce(max((quota.value->>'used')::integer), 0)
          into result
        from jsonb_each(public.standard_section_record_quotas(project_uuid)) as quota;
      end if;
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
    when 'ai_credits_per_month' then
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
set search_path = public
as $$
  select case feature_key
    when 'custom_sections' then public.check_plan_limit(user_uuid, 'custom_sections_per_project', project_uuid)
    when 'custom_fields' then public.check_plan_limit(user_uuid, 'custom_fields_per_project', project_uuid)
    when 'table_import' then public.check_plan_limit(user_uuid, 'table_imports_per_month', project_uuid)
    when 'ai_credit' then public.check_plan_limit(user_uuid, 'ai_credits_per_month', project_uuid)
    when 'hypothesis_ai_review' then public.check_plan_limit(user_uuid, 'ai_credits_per_month', project_uuid)
    when 'project_members' then public.check_plan_limit(user_uuid, 'project_members', project_uuid)
    else true
  end;
$$;

create or replace function public.begin_ai_credit_usage(
  target_project_id uuid,
  feature_key text,
  credits_requested integer default 1,
  input_chars integer default 0,
  output_chars integer default 0,
  model text default null,
  metadata jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  normalized_credits integer := greatest(1, least(coalesce(credits_requested, 1), 1000));
  current_used integer := 0;
  next_used integer := 0;
  limit_record record;
  usage_period_start date := date_trunc('month', now())::date;
  usage_period_end date := (date_trunc('month', now()) + interval '1 month')::date;
begin
  if actor_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not public.can_edit_project(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  if public.is_app_admin(actor_id) then
    return public.get_plan_usage(actor_id, 'ai_credits_per_month', target_project_id);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(actor_id::text || ':ai_credits_per_month', 0)
  );

  select *
    into limit_record
  from public.get_user_plan_limits(actor_id)
  where limit_key = 'ai_credits_per_month';

  if not found then
    perform public.log_subscription_event(
      actor_id,
      'ai_credits_blocked',
      null,
      null,
      null,
      jsonb_build_object(
        'limit_key', 'ai_credits_per_month',
        'feature_key', feature_key,
        'project_id', target_project_id
      ),
      actor_id
    );
    raise exception 'PLAN_LIMIT_REACHED:ai_credits_per_month' using errcode = 'P0001';
  end if;

  current_used := public.get_plan_usage(actor_id, 'ai_credits_per_month', target_project_id);

  if not limit_record.is_unlimited and current_used + normalized_credits > coalesce(limit_record.limit_value, 0) then
    perform public.log_subscription_event(
      actor_id,
      'ai_credits_blocked',
      null,
      null,
      null,
      jsonb_build_object(
        'limit_key', 'ai_credits_per_month',
        'feature_key', feature_key,
        'project_id', target_project_id,
        'credits_requested', normalized_credits,
        'used', current_used,
        'limit', limit_record.limit_value
      ),
      actor_id
    );
    raise exception 'AI_CREDITS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  insert into public.subscription_usage (user_id, usage_key, period_start, period_end, used)
  values (actor_id, 'ai_credits_per_month', usage_period_start, usage_period_end, normalized_credits)
  on conflict (user_id, usage_key, period_start)
  do update set used = public.subscription_usage.used + normalized_credits, updated_at = now()
  returning used into next_used;

  perform public.log_subscription_event(
    actor_id,
    'ai_credits_used',
    null,
    null,
    null,
    jsonb_build_object(
      'limit_key', 'ai_credits_per_month',
      'feature_key', feature_key,
      'project_id', target_project_id,
      'credits', normalized_credits,
      'input_chars', greatest(0, coalesce(input_chars, 0)),
      'output_chars', greatest(0, coalesce(output_chars, 0)),
      'model', model,
      'metadata', coalesce(metadata, '{}'::jsonb)
    ),
    actor_id
  );

  return next_used;
end;
$$;

create or replace function public.begin_hypothesis_ai_review(target_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.begin_ai_credit_usage(
    target_project_id,
    'hypothesis_review',
    1,
    0,
    0,
    null,
    jsonb_build_object('legacy_limit_key', 'hypothesis_ai_reviews_per_month')
  );
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
    'aiCreditsPerMonth', public.get_plan_usage(user_id, 'ai_credits_per_month', target_project_id),
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

revoke execute on function public.begin_ai_credit_usage(uuid, text, integer, integer, integer, text, jsonb) from public, anon;
grant execute on function public.begin_ai_credit_usage(uuid, text, integer, integer, integer, text, jsonb) to authenticated;

commit;
