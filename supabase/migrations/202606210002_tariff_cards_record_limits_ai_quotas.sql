begin;

update public.subscription_plans
set
  name = case code
    when 'free' then 'Старт'
    when 'researcher' then 'Дослідник'
    when 'professional' then 'Професійний'
    else name
  end,
  description = case code
    when 'free' then 'Для першого родового дослідження.'
    when 'researcher' then 'Для системної особистої роботи.'
    when 'professional' then 'Для великих досліджень і командної роботи.'
    else description
  end,
  updated_at = now()
where code in ('free', 'researcher', 'professional');

with configured(code, limit_key, limit_value, is_unlimited) as (
  values
    ('free', 'projects', 1, false),
    ('free', 'researches_total', 1, false),
    ('free', 'researches_per_project', 1, false),
    ('free', 'records_per_standard_section', 500, false),
    ('free', 'project_members', 0, false),
    ('free', 'custom_sections_per_project', 0, false),
    ('free', 'custom_fields_per_project', 0, false),
    ('free', 'table_imports_per_month', 0, false),
    ('free', 'hypothesis_ai_reviews_per_month', 0, false),
    ('researcher', 'projects', 5, false),
    ('researcher', 'researches_total', null, true),
    ('researcher', 'researches_per_project', 10, false),
    ('researcher', 'records_per_standard_section', null, true),
    ('researcher', 'project_members', 3, false),
    ('researcher', 'custom_sections_per_project', 5, false),
    ('researcher', 'custom_fields_per_project', 20, false),
    ('researcher', 'table_imports_per_month', 20, false),
    ('researcher', 'hypothesis_ai_reviews_per_month', 20, false),
    ('professional', 'projects', null, true),
    ('professional', 'researches_total', null, true),
    ('professional', 'researches_per_project', null, true),
    ('professional', 'records_per_standard_section', null, true),
    ('professional', 'project_members', null, true),
    ('professional', 'custom_sections_per_project', null, true),
    ('professional', 'custom_fields_per_project', null, true),
    ('professional', 'table_imports_per_month', null, true),
    ('professional', 'hypothesis_ai_reviews_per_month', 50, false)
)
insert into public.plan_limits (plan_id, limit_key, limit_value, is_unlimited)
select plans.id, configured.limit_key, configured.limit_value, configured.is_unlimited
from configured
join public.subscription_plans plans on plans.code = configured.code
on conflict (plan_id, limit_key) do update set
  limit_value = excluded.limit_value,
  is_unlimited = excluded.is_unlimited,
  updated_at = now();

create index if not exists persons_project_research_idx
  on public.persons (project_id, research_id);
create index if not exists documents_project_research_idx
  on public.documents (project_id, research_id);
create index if not exists year_matrix_project_research_idx
  on public.year_matrix (project_id, research_id);
create index if not exists tasks_project_research_idx
  on public.tasks (project_id, research_id);
create index if not exists findings_project_research_idx
  on public.findings (project_id, research_id);
create index if not exists hypotheses_project_research_idx
  on public.hypotheses (project_id, research_id);
create index if not exists archive_requests_project_research_idx
  on public.archive_requests (project_id, research_id);

create or replace function public.standard_section_key_for_table(target_table_name text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case target_table_name
    when 'persons' then 'persons'
    when 'documents' then 'documents'
    when 'year_matrix' then 'year_matrix'
    when 'tasks' then 'tasks'
    when 'findings' then 'findings'
    when 'hypotheses' then 'hypotheses'
    when 'archive_requests' then 'archive_requests'
    else null
  end;
$$;

create or replace function public.standard_section_record_count(
  target_project_id uuid,
  target_research_id uuid,
  target_section_key text
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
  case target_section_key
    when 'persons' then
      select count(*)::integer into result
      from public.persons
      where project_id = target_project_id
        and (target_research_id is null or research_id = target_research_id);
    when 'documents' then
      select count(*)::integer into result
      from public.documents
      where project_id = target_project_id
        and (target_research_id is null or research_id = target_research_id);
    when 'year_matrix' then
      select count(*)::integer into result
      from public.year_matrix
      where project_id = target_project_id
        and (target_research_id is null or research_id = target_research_id);
    when 'tasks' then
      select count(*)::integer into result
      from public.tasks
      where project_id = target_project_id
        and (target_research_id is null or research_id = target_research_id);
    when 'findings' then
      select count(*)::integer into result
      from public.findings
      where project_id = target_project_id
        and (target_research_id is null or research_id = target_research_id);
    when 'hypotheses' then
      select count(*)::integer into result
      from public.hypotheses
      where project_id = target_project_id
        and (target_research_id is null or research_id = target_research_id);
    when 'archive_requests' then
      select count(*)::integer into result
      from public.archive_requests
      where project_id = target_project_id
        and (target_research_id is null or research_id = target_research_id);
    else
      result := 0;
  end case;

  return coalesce(result, 0);
end;
$$;

create or replace function public.standard_section_has_capacity(
  target_project_id uuid,
  target_research_id uuid,
  target_section_key text,
  requested_records integer default 1
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  owner_uuid uuid;
  configured_limit integer;
  configured_unlimited boolean;
  current_used integer;
begin
  owner_uuid := public.project_owner_id(target_project_id);
  if owner_uuid is null or target_section_key is null then
    return false;
  end if;

  select limit_value, is_unlimited
    into configured_limit, configured_unlimited
  from public.get_user_plan_limits(owner_uuid)
  where limit_key = 'records_per_standard_section';

  if coalesce(configured_unlimited, false) or configured_limit is null then
    return true;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      owner_uuid::text || ':records_per_standard_section:' ||
      target_project_id::text || ':' ||
      coalesce(target_research_id::text, 'project') || ':' ||
      target_section_key,
      0
    )
  );

  current_used := public.standard_section_record_count(
    target_project_id,
    target_research_id,
    target_section_key
  );

  return current_used + greatest(requested_records, 1) <= configured_limit;
end;
$$;

create or replace function public.standard_section_record_quotas(target_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_uuid uuid;
  configured_limit integer;
  configured_unlimited boolean;
  section_key text;
  current_used integer;
  remaining_count integer;
  section_can_create boolean;
  result jsonb := '{}'::jsonb;
begin
  owner_uuid := public.project_owner_id(target_project_id);
  if owner_uuid is null then
    return result;
  end if;

  select limit_value, is_unlimited
    into configured_limit, configured_unlimited
  from public.get_user_plan_limits(owner_uuid)
  where limit_key = 'records_per_standard_section';

  for section_key in
    select unnest(array[
      'persons',
      'documents',
      'year_matrix',
      'tasks',
      'findings',
      'hypotheses',
      'archive_requests'
    ])
  loop
    current_used := public.standard_section_record_count(target_project_id, null, section_key);
    section_can_create := coalesce(configured_unlimited, false)
      or configured_limit is null
      or current_used < configured_limit;
    remaining_count := case
      when coalesce(configured_unlimited, false) or configured_limit is null then null
      else greatest(0, configured_limit - current_used)
    end;
    result := result || jsonb_build_object(
      section_key,
      jsonb_build_object(
        'sectionKey', section_key,
        'used', current_used,
        'limit', case
          when coalesce(configured_unlimited, false) then null
          else configured_limit
        end,
        'remaining', remaining_count,
        'canCreate', section_can_create,
        'reason', case
          when section_can_create then null
          else 'PLAN_SECTION_RECORD_LIMIT_REACHED'
        end
      )
    );
  end loop;

  return result;
end;
$$;

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
    else
      result := 0;
  end case;
  return coalesce(result, 0);
end;
$$;

create or replace function public.enforce_scoped_insert_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb := to_jsonb(new);
  target_project_id uuid;
  target_research_id uuid;
  target_section_key text;
  blocked_relation boolean := false;
  owner_uuid uuid;
  record_exists boolean := false;
begin
  case tg_table_name
    when 'project_members' then
      select exists (
        select 1 from public.project_members
        where project_id = (payload->>'project_id')::uuid
          and user_id = (payload->>'user_id')::uuid
      ) into record_exists;
    when 'task_persons' then
      select exists (
        select 1 from public.task_persons
        where task_id = (payload->>'task_id')::uuid
          and person_id = (payload->>'person_id')::uuid
      ) into record_exists;
    when 'hypothesis_links' then
      select exists (
        select 1 from public.hypothesis_links
        where hypothesis_id = (payload->>'hypothesis_id')::uuid
          and target_type = payload->>'target_type'
          and target_id = (payload->>'target_id')::uuid
      ) into record_exists;
    when 'archive_request_persons' then
      select exists (
        select 1 from public.archive_request_persons
        where archive_request_id = (payload->>'archive_request_id')::uuid
          and person_id = (payload->>'person_id')::uuid
      ) into record_exists;
    else
      if payload ? 'id' then
        execute format('select exists (select 1 from public.%I where id = $1)', tg_table_name)
          into record_exists using (payload->>'id')::uuid;
      end if;
  end case;

  if record_exists then
    return new;
  end if;

  target_project_id := (payload->>'project_id')::uuid;
  owner_uuid := public.project_owner_id(target_project_id);

  if not public.project_allows_new_records(target_project_id) then
    perform public.log_subscription_event(
      owner_uuid, 'project_scope_create_blocked', null, null, null,
      jsonb_build_object('project_id', target_project_id, 'table', tg_table_name)
    );
    raise exception 'PLAN_SCOPE_CREATE_BLOCKED:projects' using errcode = 'P0001';
  end if;

  target_research_id := case
    when payload ? 'research_id' and payload->>'research_id' is not null
      then (payload->>'research_id')::uuid
    else null
  end;

  case tg_table_name
    when 'task_persons' then
      select research_id into target_research_id from public.tasks where id = (payload->>'task_id')::uuid;
    when 'finding_participants' then
      select research_id into target_research_id from public.findings where id = (payload->>'finding_id')::uuid;
    when 'hypothesis_links' then
      select research_id into target_research_id from public.hypotheses where id = (payload->>'hypothesis_id')::uuid;
    when 'archive_request_persons' then
      select research_id into target_research_id from public.archive_requests where id = (payload->>'archive_request_id')::uuid;
    when 'attachments' then
      target_research_id := public.attachment_owner_research_id(
        payload->>'owner_type',
        (payload->>'owner_id')::uuid
      );
    when 'person_relations' then
      select exists (
        select 1
        from public.persons person
        where person.project_id = target_project_id
          and person.id in (
            (payload->>'person_id')::uuid,
            (payload->>'related_person_id')::uuid
          )
          and person.research_id is not null
          and not public.research_allows_new_records(target_project_id, person.research_id)
      ) into blocked_relation;
    else
      null;
  end case;

  if blocked_relation or (
    target_research_id is not null
    and not public.research_allows_new_records(target_project_id, target_research_id)
  ) then
    perform public.log_subscription_event(
      owner_uuid, 'research_scope_create_blocked', null, null, null,
      jsonb_build_object(
        'project_id', target_project_id,
        'research_id', target_research_id,
        'table', tg_table_name
      )
    );
    raise exception 'PLAN_SCOPE_CREATE_BLOCKED:researches' using errcode = 'P0001';
  end if;

  target_section_key := public.standard_section_key_for_table(tg_table_name);
  if target_section_key is not null and not public.standard_section_has_capacity(
    target_project_id,
    target_research_id,
    target_section_key,
    1
  ) then
    perform public.log_subscription_event(
      owner_uuid, 'section_record_limit_reached', null, null, null,
      jsonb_build_object(
        'limit_key', 'records_per_standard_section',
        'section_key', target_section_key,
        'project_id', target_project_id,
        'research_id', target_research_id
      )
    );
    raise exception 'PLAN_SECTION_RECORD_LIMIT_REACHED:%', target_section_key using errcode = 'P0001';
  end if;

  return new;
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
  usage_period_start date := date_trunc('month', now())::date;
  usage_period_end date := (date_trunc('month', now()) + interval '1 month')::date;
begin
  if not public.can_edit_project(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text || ':hypothesis_ai_reviews_per_month', 0)
  );
  if not public.can_use_feature(auth.uid(), 'hypothesis_ai_review', target_project_id) then
    perform public.log_subscription_event(
      auth.uid(), 'hypothesis_ai_blocked', null, null, null,
      jsonb_build_object('limit_key', 'hypothesis_ai_reviews_per_month', 'project_id', target_project_id)
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
set search_path = ''
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
  if user_id is null then raise exception 'Authentication required'; end if;
  select * into effective from public.get_user_effective_subscription(user_id);
  if target_project_id is not null then
    project_mode := public.project_subscription_access_mode(target_project_id);
    section_quotas := public.standard_section_record_quotas(target_project_id);
  end if;
  select coalesce(jsonb_object_agg(limit_key, jsonb_build_object(
    'value', limit_value, 'isUnlimited', is_unlimited
  )), '{}'::jsonb) into limits
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

revoke execute on function public.standard_section_key_for_table(text) from public, anon, authenticated;
revoke execute on function public.standard_section_record_count(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.standard_section_has_capacity(uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.standard_section_record_quotas(uuid) from public, anon, authenticated;
revoke execute on function public.enforce_scoped_insert_access() from public, anon, authenticated;
revoke execute on function public.begin_hypothesis_ai_review(uuid) from public, anon;
grant execute on function public.begin_hypothesis_ai_review(uuid) to authenticated;
grant execute on function public.get_my_subscription_context(uuid) to authenticated;

commit;
