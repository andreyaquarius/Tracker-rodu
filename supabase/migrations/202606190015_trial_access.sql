begin;

create table if not exists public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('free', 'researcher', 'professional')),
  name text not null,
  description text,
  is_active boolean not null default true,
  price_monthly numeric(12, 2),
  price_yearly numeric(12, 2),
  currency text not null default 'UAH',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_limits (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.subscription_plans(id) on delete cascade,
  limit_key text not null,
  limit_value integer check (limit_value is null or limit_value >= 0),
  is_unlimited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, limit_key)
);

create table if not exists public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(user_id) on delete cascade,
  plan_id uuid not null references public.subscription_plans(id),
  status text not null check (status in ('active', 'trialing', 'past_due', 'cancelled', 'expired')),
  started_at timestamptz not null default now(),
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_granted_at timestamptz,
  trial_used boolean not null default false,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  payment_provider text,
  provider_customer_id text,
  provider_subscription_id text,
  provider_payment_id text,
  provider_event_id text,
  payment_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_subscriptions_provider_subscription_unique
  on public.user_subscriptions (payment_provider, provider_subscription_id)
  where provider_subscription_id is not null;

create table if not exists public.subscription_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  usage_key text not null,
  period_start date not null,
  period_end date not null,
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  unique (user_id, usage_key, period_start)
);

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_type text not null,
  previous_plan_id uuid references public.subscription_plans(id),
  new_plan_id uuid references public.subscription_plans(id),
  subscription_id uuid references public.user_subscriptions(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  performed_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now()
);

create table if not exists public.app_admins (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  granted_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now()
);

insert into public.subscription_plans
  (code, name, description, is_active, price_monthly, price_yearly, currency, sort_order)
values
  ('free', 'Безкоштовний', 'Базові інструменти для одного дослідження.', true, 0, 0, 'UAH', 10),
  ('researcher', 'Дослідник', 'Розширені можливості для приватного дослідника.', true, null, null, 'UAH', 20),
  ('professional', 'Професійний', 'Повний доступ і командна робота без бізнес-лімітів.', true, null, null, 'UAH', 30)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  sort_order = excluded.sort_order,
  updated_at = now();

with configured(code, limit_key, limit_value, is_unlimited) as (
  values
    ('free', 'projects', 1, false),
    ('free', 'researches_total', 1, false),
    ('free', 'researches_per_project', 1, false),
    ('free', 'project_members', 0, false),
    ('free', 'custom_sections_per_project', 0, false),
    ('free', 'custom_fields_per_project', 0, false),
    ('free', 'table_imports_per_month', 0, false),
    ('free', 'hypothesis_ai_reviews_per_month', 0, false),
    ('researcher', 'projects', 5, false),
    ('researcher', 'researches_total', null, true),
    ('researcher', 'researches_per_project', 10, false),
    ('researcher', 'project_members', 3, false),
    ('researcher', 'custom_sections_per_project', 5, false),
    ('researcher', 'custom_fields_per_project', 20, false),
    ('researcher', 'table_imports_per_month', 20, false),
    ('researcher', 'hypothesis_ai_reviews_per_month', 5, false),
    ('professional', 'projects', null, true),
    ('professional', 'researches_total', null, true),
    ('professional', 'researches_per_project', null, true),
    ('professional', 'project_members', null, true),
    ('professional', 'custom_sections_per_project', null, true),
    ('professional', 'custom_fields_per_project', null, true),
    ('professional', 'table_imports_per_month', null, true),
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

create or replace function public.is_app_admin(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_admins where user_id = target_user_id);
$$;

create or replace function public.get_user_active_plan(user_uuid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
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
  select 'free'
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
    plan.code,
    public.get_user_active_plan(user_uuid),
    case
      when subscription.status = 'trialing' and subscription.trial_ends_at <= now() then 'expired'
      when subscription.status = 'active'
        and subscription.current_period_end is not null
        and subscription.current_period_end <= now() then 'expired'
      else subscription.status
    end,
    subscription.current_period_start,
    subscription.current_period_end,
    subscription.trial_started_at,
    subscription.trial_ends_at,
    subscription.trial_used
  from public.user_subscriptions subscription
  join public.subscription_plans plan on plan.id = subscription.plan_id
  where subscription.user_id = user_uuid;
$$;

create or replace function public.get_user_plan_limits(user_uuid uuid)
returns table (limit_key text, limit_value integer, is_unlimited boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select limits.limit_key, limits.limit_value, limits.is_unlimited
  from public.plan_limits limits
  join public.subscription_plans plan on plan.id = limits.plan_id
  where plan.code = public.get_user_active_plan(user_uuid);
$$;

create or replace function public.project_owner_id(target_project_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select owner_id from public.projects where id = target_project_id;
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

create or replace function public.check_plan_limit(
  user_uuid uuid,
  requested_limit_key text,
  project_uuid uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    limit_row.is_unlimited
    or public.get_plan_usage(user_uuid, requested_limit_key, project_uuid) < limit_row.limit_value,
    false
  )
  from public.get_user_plan_limits(user_uuid) limit_row
  where limit_row.limit_key = requested_limit_key;
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

create or replace function public.log_subscription_event(
  target_user_id uuid,
  target_event_type text,
  previous_plan uuid default null,
  new_plan uuid default null,
  target_subscription uuid default null,
  event_metadata jsonb default '{}'::jsonb,
  actor uuid default auth.uid()
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.subscription_events (
    user_id, event_type, previous_plan_id, new_plan_id,
    subscription_id, metadata, performed_by
  ) values (
    target_user_id, target_event_type, previous_plan, new_plan,
    target_subscription, coalesce(event_metadata, '{}'::jsonb), actor
  );
$$;

create or replace function public.enforce_plan_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  key text;
  target_project_id uuid;
  allowed boolean;
  member_limit integer;
  member_limit_unlimited boolean;
  reserved_members integer;
  record_exists boolean := false;
begin
  if tg_table_name = 'project_members' then
    select exists (
      select 1 from public.project_members
      where project_id = new.project_id and user_id = new.user_id
    ) into record_exists;
  else
    execute format('select exists (select 1 from public.%I where id = $1)', tg_table_name)
      into record_exists using new.id;
  end if;
  if record_exists then return new; end if;

  if tg_table_name = 'projects' then
    owner_id := new.owner_id;
    key := 'projects';
    target_project_id := null;
  else
    owner_id := public.project_owner_id(new.project_id);
    target_project_id := new.project_id;
    key := case tg_table_name
      when 'researches' then 'researches_per_project'
      when 'custom_sections' then 'custom_sections_per_project'
      when 'custom_field_definitions' then 'custom_fields_per_project'
      when 'project_invitations' then 'project_members'
      when 'project_members' then 'project_members'
      else null
    end;
  end if;

  if key is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(owner_id::text || ':' || key, 0)
    );
  end if;

  allowed := key is null or public.check_plan_limit(owner_id, key, target_project_id);
  if tg_table_name = 'researches' and allowed then
    allowed := public.check_plan_limit(owner_id, 'researches_total', target_project_id);
    if not allowed then key := 'researches_total'; end if;
  end if;
  if tg_table_name = 'project_invitations' then
    select limit_value, is_unlimited into member_limit, member_limit_unlimited
    from public.get_user_plan_limits(owner_id) where limit_key = 'project_members';
    select (
      (select count(*) from public.project_members where project_id = target_project_id and role <> 'owner')
      + (select count(*) from public.project_invitations where project_id = target_project_id and status = 'pending')
    )::integer into reserved_members;
    allowed := coalesce(member_limit_unlimited or reserved_members < member_limit, false);
  end if;

  if not allowed then
    perform public.log_subscription_event(
      owner_id,
      case key
        when 'projects' then 'project_creation_blocked'
        when 'researches_per_project' then 'research_creation_blocked'
        when 'custom_sections_per_project' then 'custom_section_blocked'
        when 'custom_fields_per_project' then 'custom_field_blocked'
        when 'project_members' then 'member_invitation_blocked'
        else 'plan_limit_reached'
      end,
      null, null, null,
      jsonb_build_object('limit_key', key, 'project_id', target_project_id)
    );
    raise exception 'PLAN_LIMIT_REACHED:%', key using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_plan_limit on public.projects;
create trigger projects_plan_limit before insert on public.projects
  for each row execute function public.enforce_plan_insert();
drop trigger if exists researches_plan_limit on public.researches;
create trigger researches_plan_limit before insert on public.researches
  for each row execute function public.enforce_plan_insert();
drop trigger if exists custom_sections_plan_limit on public.custom_sections;
create trigger custom_sections_plan_limit before insert on public.custom_sections
  for each row execute function public.enforce_plan_insert();
drop trigger if exists custom_field_definitions_plan_limit on public.custom_field_definitions;
create trigger custom_field_definitions_plan_limit before insert on public.custom_field_definitions
  for each row execute function public.enforce_plan_insert();
drop trigger if exists custom_section_fields_plan_limit on public.custom_section_fields;
drop trigger if exists project_invitations_plan_limit on public.project_invitations;
create trigger project_invitations_plan_limit before insert on public.project_invitations
  for each row execute function public.enforce_plan_insert();
drop trigger if exists project_members_plan_limit on public.project_members;
create trigger project_members_plan_limit before insert on public.project_members
  for each row when (new.role <> 'owner') execute function public.enforce_plan_insert();

create or replace function public.begin_table_import(target_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  current_used integer;
  period_start date := date_trunc('month', now())::date;
  period_end date := (date_trunc('month', now()) + interval '1 month')::date;
begin
  if not public.can_edit_project(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  owner_id := public.project_owner_id(target_project_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(owner_id::text || ':table_imports_per_month', 0)
  );
  if not public.can_use_feature(owner_id, 'table_import', target_project_id) then
    perform public.log_subscription_event(
      owner_id, 'table_import_blocked', null, null, null,
      jsonb_build_object('limit_key', 'table_imports_per_month', 'project_id', target_project_id)
    );
    raise exception 'PLAN_LIMIT_REACHED:table_imports_per_month' using errcode = 'P0001';
  end if;

  insert into public.subscription_usage (user_id, usage_key, period_start, period_end, used)
  values (owner_id, 'table_imports_per_month', period_start, period_end, 1)
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

create or replace function public.admin_set_subscription(
  target_user_id uuid,
  target_plan_code text,
  target_status text default 'active',
  target_period_end timestamptz default null,
  grant_trial boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  plan_id uuid;
  previous_plan uuid;
  subscription_id uuid;
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  select id into plan_id from public.subscription_plans where code = target_plan_code and is_active;
  if plan_id is null then raise exception 'Unknown subscription plan'; end if;
  select user_subscriptions.plan_id into previous_plan
  from public.user_subscriptions where user_id = target_user_id;

  insert into public.user_subscriptions (
    user_id, plan_id, status, started_at, current_period_start, current_period_end,
    trial_started_at, trial_ends_at, trial_granted_at, trial_used
  ) values (
    target_user_id, plan_id,
    case when grant_trial then 'trialing' else target_status end,
    now(), case when grant_trial then null else now() end, target_period_end,
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
  returning id into subscription_id;
  perform public.log_subscription_event(
    target_user_id,
    case when grant_trial then 'trial_manually_granted' else 'subscription_changed' end,
    previous_plan, plan_id, subscription_id,
    jsonb_build_object('source', 'admin', 'status', target_status), auth.uid()
  );
  return subscription_id;
end;
$$;

create or replace function public.admin_list_subscriptions()
returns table (
  user_id uuid,
  email text,
  display_name text,
  plan_code text,
  status text,
  trial_ends_at timestamptz,
  current_period_end timestamptz
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
      when subscription.status = 'trialing' and subscription.trial_ends_at <= now() then 'expired'
      when subscription.status = 'active'
        and subscription.current_period_end is not null
        and subscription.current_period_end <= now() then 'expired'
      else subscription.status
    end,
    subscription.trial_ends_at,
    subscription.current_period_end
  from public.profiles profile
  join public.user_subscriptions subscription on subscription.user_id = profile.user_id
  order by profile.created_at desc;
end;
$$;

-- Existing users receive free access. Only users created after this trigger is
-- installed receive the automatic professional trial.
insert into public.user_subscriptions (user_id, plan_id, status, trial_used)
select profile.user_id, plan.id, 'active', false
from public.profiles profile
join public.subscription_plans plan on plan.code = 'free'
on conflict (user_id) do nothing;

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

-- Restore project data access after the earlier local trial experiment: an
-- expired trial now falls back to free instead of hiding all existing data.
create or replace function public.is_project_member(target_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members
    where project_id = target_project_id and user_id = auth.uid()
  );
$$;
create or replace function public.can_edit_project(target_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members
    where project_id = target_project_id and user_id = auth.uid()
      and role in ('owner', 'editor')
  );
$$;
create or replace function public.is_project_owner(target_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects
    where id = target_project_id and owner_id = auth.uid()
  );
$$;

-- Restore invitation access and acceptance without the old all-or-nothing
-- trial predicate before removing has_active_access(). Plan limits are enforced
-- by the project_members insert trigger against the project owner's plan.
drop policy if exists invitations_select_owner_or_recipient on public.project_invitations;
create policy invitations_select_owner_or_recipient
on public.project_invitations for select to authenticated
using (
  public.is_project_owner(project_id)
  or lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
);

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
    raise exception 'Authentication required';
  end if;

  current_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  select *
  into invitation
  from public.project_invitations
  where id = invitation_id
  for update;

  if not found
     or invitation.status <> 'pending'
     or invitation.expires_at <= now()
     or lower(invitation.email) <> current_email then
    raise exception 'Invitation is invalid or expired';
  end if;

  if exists (
    select 1 from public.projects
    where id = invitation.project_id and owner_id = auth.uid()
  ) then
    raise exception 'Project owner cannot accept a lower role';
  end if;

  insert into public.project_members (project_id, user_id, role, invited_by)
  values (invitation.project_id, auth.uid(), invitation.role, invitation.invited_by)
  on conflict (project_id, user_id)
  do update set role = excluded.role, invited_by = excluded.invited_by;

  update public.project_invitations
  set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
  where id = invitation.id;

  return invitation.project_id;
end;
$$;

drop trigger if exists profiles_protect_access_fields on public.profiles;
drop function if exists public.protect_profile_access_fields();
drop function if exists public.get_my_access_status();

-- Detach policies created by the earlier local trial migration from
-- has_active_access() before dropping that function.
drop policy if exists profiles_select_related on public.profiles;
create policy profiles_select_related on public.profiles for select to authenticated using (
  user_id = auth.uid() or exists (
    select 1 from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.user_id
  )
);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner on public.projects for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists user_ai_settings_select_own on public.user_ai_settings;
create policy user_ai_settings_select_own on public.user_ai_settings for select to authenticated
  using (user_id = auth.uid());
drop policy if exists user_ai_settings_insert_own on public.user_ai_settings;
create policy user_ai_settings_insert_own on public.user_ai_settings for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists user_ai_settings_update_own on public.user_ai_settings;
create policy user_ai_settings_update_own on public.user_ai_settings for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists user_ai_settings_delete_own on public.user_ai_settings;
create policy user_ai_settings_delete_own on public.user_ai_settings for delete to authenticated
  using (user_id = auth.uid());

drop function if exists public.has_active_access();

alter table public.subscription_plans enable row level security;
alter table public.plan_limits enable row level security;
alter table public.user_subscriptions enable row level security;
alter table public.subscription_usage enable row level security;
alter table public.subscription_events enable row level security;
alter table public.app_admins enable row level security;

drop policy if exists subscription_plans_read on public.subscription_plans;
create policy subscription_plans_read on public.subscription_plans
  for select to authenticated using (is_active or public.is_app_admin());
drop policy if exists plan_limits_read on public.plan_limits;
create policy plan_limits_read on public.plan_limits
  for select to authenticated using (true);
drop policy if exists user_subscriptions_read_own on public.user_subscriptions;
create policy user_subscriptions_read_own on public.user_subscriptions
  for select to authenticated using (user_id = auth.uid() or public.is_app_admin());
drop policy if exists subscription_usage_read_own on public.subscription_usage;
create policy subscription_usage_read_own on public.subscription_usage
  for select to authenticated using (user_id = auth.uid() or public.is_app_admin());
drop policy if exists subscription_events_read_own on public.subscription_events;
create policy subscription_events_read_own on public.subscription_events
  for select to authenticated using (user_id = auth.uid() or public.is_app_admin());
drop policy if exists app_admins_read_self on public.app_admins;
create policy app_admins_read_self on public.app_admins
  for select to authenticated using (user_id = auth.uid());

-- Restore profile and AI policies if the previous local trial migration was applied.
drop policy if exists profiles_select_related on public.profiles;
create policy profiles_select_related on public.profiles for select to authenticated using (
  user_id = auth.uid() or exists (
    select 1 from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.user_id
  )
);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner on public.projects for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists user_ai_settings_select_own on public.user_ai_settings;
create policy user_ai_settings_select_own on public.user_ai_settings for select to authenticated
  using (user_id = auth.uid());
drop policy if exists user_ai_settings_insert_own on public.user_ai_settings;
create policy user_ai_settings_insert_own on public.user_ai_settings for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists user_ai_settings_update_own on public.user_ai_settings;
create policy user_ai_settings_update_own on public.user_ai_settings for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists user_ai_settings_delete_own on public.user_ai_settings;
create policy user_ai_settings_delete_own on public.user_ai_settings for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.subscription_plans, public.plan_limits, public.user_subscriptions,
  public.subscription_usage, public.subscription_events, public.app_admins from anon;
grant select on public.subscription_plans, public.plan_limits, public.user_subscriptions,
  public.subscription_usage, public.subscription_events, public.app_admins to authenticated;

revoke execute on function public.is_app_admin(uuid) from public, anon;
revoke execute on function public.get_user_active_plan(uuid) from public, anon, authenticated;
revoke execute on function public.get_user_effective_subscription(uuid) from public, anon, authenticated;
revoke execute on function public.get_user_plan_limits(uuid) from public, anon, authenticated;
revoke execute on function public.project_owner_id(uuid) from public, anon, authenticated;
revoke execute on function public.get_plan_usage(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.check_plan_limit(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.can_use_feature(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.log_subscription_event(uuid, text, uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.enforce_plan_insert() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.get_my_subscription_context(uuid) from public, anon;
revoke execute on function public.begin_table_import(uuid) from public, anon;
revoke execute on function public.begin_hypothesis_ai_review(uuid) from public, anon;
revoke execute on function public.admin_set_subscription(uuid, text, text, timestamptz, boolean) from public, anon;
revoke execute on function public.admin_list_subscriptions() from public, anon;
grant execute on function public.is_app_admin(uuid) to authenticated;
grant execute on function public.get_my_subscription_context(uuid) to authenticated;
grant execute on function public.begin_table_import(uuid) to authenticated;
grant execute on function public.begin_hypothesis_ai_review(uuid) to authenticated;
grant execute on function public.admin_set_subscription(uuid, text, text, timestamptz, boolean) to authenticated;
grant execute on function public.admin_list_subscriptions() to authenticated;

commit;
