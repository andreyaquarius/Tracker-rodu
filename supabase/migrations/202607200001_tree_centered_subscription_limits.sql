begin;

-- Tree-centred subscriptions.
--
-- Capacity belongs to the account that owns a project. A person is counted
-- once because public.persons is the canonical profile table even when that
-- profile is linked to several family trees. Viewers are intentionally not a
-- billable seat; only distinct editors across all projects owned by an account
-- consume editors_total.

update public.subscription_plans
set name = case code
      when 'free' then 'Старт'
      when 'researcher' then 'Дослідник'
      when 'professional' then 'Професійний'
      else name
    end,
    description = case code
      when 'free' then 'Одне родове дерево до 500 осіб для початку дослідження.'
      when 'researcher' then 'До 15 000 осіб, дерева без тарифного ліміту та 2 редактори.'
      when 'professional' then 'Особи і дерева без тарифного ліміту та 5 редакторів.'
      else description
    end,
    updated_at = now()
where code in ('free', 'researcher', 'professional');

with configured(code, limit_key, limit_value, is_unlimited) as (
  values
    -- Free keeps one workspace/research and standard modules, but has no
    -- custom schema or generic table-import allowance. GEDCOM uses its own
    -- import path and is governed by persons_total/family_trees_total.
    ('free', 'projects', 1, false),
    ('free', 'researches_total', 1, false),
    ('free', 'researches_per_project', 1, false),
    ('free', 'records_per_standard_section', null, true),
    ('free', 'project_members', null, true),
    ('free', 'custom_sections_per_project', 0, false),
    ('free', 'custom_fields_per_project', 0, false),
    ('free', 'table_imports_per_month', 0, false),
    ('free', 'persons_total', 500, false),
    ('free', 'family_trees_total', 1, false),
    ('free', 'editors_total', 0, false),
    ('free', 'ai_credits_per_month', 5, false),
    ('free', 'hypothesis_ai_reviews_per_month', 5, false),

    -- Paid plans no longer carry hidden project/research/record/import or
    -- custom-schema quotas. Operational rate limits remain separate from
    -- commercial subscription limits.
    ('researcher', 'projects', null, true),
    ('researcher', 'researches_total', null, true),
    ('researcher', 'researches_per_project', null, true),
    ('researcher', 'records_per_standard_section', null, true),
    ('researcher', 'project_members', null, true),
    ('researcher', 'custom_sections_per_project', null, true),
    ('researcher', 'custom_fields_per_project', null, true),
    ('researcher', 'table_imports_per_month', null, true),
    ('researcher', 'persons_total', 15000, false),
    ('researcher', 'family_trees_total', null, true),
    ('researcher', 'editors_total', 2, false),
    ('researcher', 'ai_credits_per_month', 50, false),
    ('researcher', 'hypothesis_ai_reviews_per_month', 50, false),

    ('professional', 'projects', null, true),
    ('professional', 'researches_total', null, true),
    ('professional', 'researches_per_project', null, true),
    ('professional', 'records_per_standard_section', null, true),
    ('professional', 'project_members', null, true),
    ('professional', 'custom_sections_per_project', null, true),
    ('professional', 'custom_fields_per_project', null, true),
    ('professional', 'table_imports_per_month', null, true),
    ('professional', 'persons_total', null, true),
    ('professional', 'family_trees_total', null, true),
    ('professional', 'editors_total', 5, false),
    ('professional', 'ai_credits_per_month', 100, false),
    ('professional', 'hypothesis_ai_reviews_per_month', 100, false)
)
insert into public.plan_limits (plan_id, limit_key, limit_value, is_unlimited)
select plan.id, configured.limit_key, configured.limit_value, configured.is_unlimited
from configured
join public.subscription_plans plan on plan.code = configured.code
on conflict (plan_id, limit_key) do update
set limit_value = excluded.limit_value,
    is_unlimited = excluded.is_unlimited,
    updated_at = now();

-- Seed and trigger installation must observe one consistent write boundary.
-- Without these locks, a person/tree/editor committed between the backfill and
-- CREATE TRIGGER could be missing from the durable counters forever.
lock table public.projects,
  public.persons,
  public.family_trees,
  public.project_members,
  public.project_invitations
in share row exclusive mode;

-- Persisted counters make capacity changes atomic under concurrent statements.
-- They are internal implementation state, not a second source of product data:
-- this migration seeds them from the canonical tables and statement-level
-- triggers maintain them transactionally afterwards.
create table if not exists private.subscription_capacity_counters (
  owner_id uuid not null references public.profiles(user_id) on delete cascade,
  capacity_key text not null check (capacity_key in ('persons_total', 'family_trees_total', 'editors_total')),
  used bigint not null default 0 check (used >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, capacity_key)
);

revoke all on table private.subscription_capacity_counters
  from public, anon, authenticated, service_role;

-- Keep the immutable billing owner next to the internal counters. The mapping
-- intentionally survives project deletion long enough for cascading child
-- DELETE statement triggers to release their counters; project UUIDs are never
-- reused, so retaining the tiny tombstone is safe and avoids cascade ordering
-- assumptions.
create table if not exists private.subscription_capacity_projects (
  project_id uuid primary key,
  owner_id uuid not null
);

revoke all on table private.subscription_capacity_projects
  from public, anon, authenticated, service_role;

insert into private.subscription_capacity_projects (project_id, owner_id)
select project.id, project.owner_id
from public.projects project
on conflict (project_id) do update set owner_id = excluded.owner_id;

with capacity_keys(capacity_key) as (
  values
    ('persons_total'::text),
    ('family_trees_total'::text),
    ('editors_total'::text)
), seeded as (
  select
    profile.user_id as owner_id,
    capacity.capacity_key,
    case capacity.capacity_key
      when 'persons_total' then (
        select count(*)::bigint
        from public.projects project
        join public.persons person on person.project_id = project.id
        where project.owner_id = profile.user_id
      )
      when 'family_trees_total' then (
        select count(*)::bigint
        from public.projects project
        join public.family_trees tree on tree.project_id = project.id
        where project.owner_id = profile.user_id
      )
      else 0::bigint
    end as used
  from public.profiles profile
  cross join capacity_keys capacity
)
insert into private.subscription_capacity_counters (owner_id, capacity_key, used)
select owner_id, capacity_key, used
from seeded
on conflict (owner_id, capacity_key) do update
set used = excluded.used,
    updated_at = clock_timestamp();

-- A trial retains the Professional feature set, five editor seats and 100 AI
-- credits, but it must not be an unlimited data-ingestion window. The override
-- is evaluated by every server-side quota check and never deletes data when a
-- trial expires or an account downgrades.
create or replace function public.get_user_plan_limits(user_uuid uuid)
returns table (limit_key text, limit_value integer, is_unlimited boolean)
language sql
volatile
security definer
set search_path = ''
as $$
  with effective as (
    select
      public.get_user_active_plan(user_uuid) as plan_code,
      coalesce((
        select subscription.status = 'trialing'
          and subscription.trial_ends_at > now()
        from public.user_subscriptions subscription
        where subscription.user_id = user_uuid
      ), false) as is_active_trial
  )
  select
    limits.limit_key,
    case
      when effective.is_active_trial and limits.limit_key = 'persons_total'
        then 15000
      else limits.limit_value
    end as limit_value,
    case
      when effective.is_active_trial and limits.limit_key = 'persons_total'
        then false
      else limits.is_unlimited
    end as is_unlimited
  from effective
  join public.subscription_plans plan on plan.code = effective.plan_code
  join public.plan_limits limits on limits.plan_id = plan.id;
$$;

-- Preserve an already-started AI usage bucket across an in-period upgrade.
-- New buckets follow the subscription/trial billing dates; accounts without a
-- billing period use a calendar month.
create or replace function security_private.get_ai_usage_period(user_uuid uuid)
returns table (period_start date, period_end date)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  existing_start date;
  existing_end date;
  subscription_row public.user_subscriptions%rowtype;
begin
  select usage.period_start, usage.period_end
    into existing_start, existing_end
  from public.subscription_usage usage
  where usage.user_id = user_uuid
    and usage.usage_key = 'ai_credits_per_month'
    and current_date >= usage.period_start
    and current_date < usage.period_end
  order by usage.period_start, usage.period_end desc
  limit 1;

  if existing_start is not null then
    return query select existing_start, existing_end;
    return;
  end if;

  select subscription.*
    into subscription_row
  from public.user_subscriptions subscription
  where subscription.user_id = user_uuid;

  if subscription_row.status = 'trialing'
     and subscription_row.trial_ends_at > now() then
    existing_start := coalesce(
      subscription_row.trial_started_at::date,
      subscription_row.started_at::date,
      current_date
    );
    existing_end := coalesce(
      subscription_row.trial_ends_at::date,
      existing_start + 30
    );
  elsif subscription_row.status = 'active'
        and (subscription_row.current_period_end is null
             or subscription_row.current_period_end > now())
        and subscription_row.current_period_start is not null
        and subscription_row.current_period_end is not null then
    existing_start := subscription_row.current_period_start::date;
    existing_end := subscription_row.current_period_end::date;
  else
    existing_start := date_trunc('month', now())::date;
    existing_end := (date_trunc('month', now()) + interval '1 month')::date;
  end if;

  if existing_end <= existing_start then
    existing_end := existing_start + 1;
  end if;

  return query select existing_start, existing_end;
end;
$$;

create or replace function security_private.editor_identity_from_email(target_email text)
returns text
language sql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
  with normalized as (
    select lower(pg_catalog.btrim(coalesce(target_email, ''))) as email
  )
  select coalesce(
    (
      -- Resolve through the Auth identity, never through mutable profiles.email.
      -- Requiring a canonical Auth address also prevents whitespace lookalikes
      -- from merging otherwise distinct accounts. VOLATILE is intentional so
      -- the profile INSERT trigger can see the auth.users row created by the
      -- outer signup statement rather than reusing its pre-insert snapshot.
      select 'user:' || auth_user.id::text
      from auth.users auth_user
      cross join normalized
      where auth_user.email = pg_catalog.btrim(auth_user.email)
        and lower(auth_user.email) = normalized.email
      limit 1
    ),
    'email:' || normalized.email
  )
  from normalized;
$$;

create or replace function security_private.editor_identity_from_user(target_user_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  -- Membership identity is deliberately independent of mutable profile data.
  select 'user:' || target_user_id::text;
$$;

create table if not exists private.subscription_editor_identities (
  owner_id uuid not null references public.profiles(user_id) on delete cascade,
  identity_key text not null,
  member_refs integer not null default 0 check (member_refs >= 0),
  invitation_refs integer not null default 0 check (invitation_refs >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, identity_key),
  check (member_refs + invitation_refs > 0)
);

revoke all on table private.subscription_editor_identities
  from public, anon, authenticated, service_role;

-- Invitation identities must be durable as well: an invitation can outlive a
-- profile email change or predate account registration. The row trigger below
-- owns this map (including cleanup on DELETE); no FK to the invitation is used
-- because project cascades must still be able to read the mapping while they
-- release editor counters.
create table if not exists private.subscription_editor_invitation_identities (
  invitation_id uuid primary key,
  owner_id uuid not null references public.profiles(user_id) on delete cascade,
  identity_key text not null,
  updated_at timestamptz not null default clock_timestamp()
);

revoke all on table private.subscription_editor_invitation_identities
  from public, anon, authenticated, service_role;

-- Invitations which expired before this migration must not occupy an editor
-- seat in the initial registry. Future expired invitations are normalized by
-- a trigger below and are lazily expired before a new editor seat is claimed.
update public.project_invitations invitation
set status = 'expired'
where invitation.status = 'pending'
  and invitation.expires_at <= now();

-- This migration is intentionally safe to reapply to a local database where
-- an earlier draft was already installed. The public write-boundary lock near
-- the top is still held, so rebuild the derived editor registry without races
-- and remove stale email identities/counter drift from that draft.
delete from private.subscription_editor_invitation_identities;

delete from private.subscription_editor_identities;

insert into private.subscription_editor_invitation_identities (
  invitation_id,
  owner_id,
  identity_key
)
select
  invitation.id,
  project.owner_id,
  security_private.editor_identity_from_email(invitation.email)
from public.project_invitations invitation
join public.projects project on project.id = invitation.project_id
where invitation.role = 'editor'
  and invitation.status = 'pending'
  and invitation.expires_at > now()
on conflict (invitation_id) do update
set owner_id = excluded.owner_id,
    identity_key = excluded.identity_key,
    updated_at = clock_timestamp();

with contributions as (
  select
    project.owner_id,
    security_private.editor_identity_from_user(member.user_id) as identity_key,
    count(*)::integer as member_refs,
    0::integer as invitation_refs
  from public.projects project
  join public.project_members member on member.project_id = project.id
  where member.role = 'editor'
    and member.user_id <> project.owner_id
  group by project.owner_id, security_private.editor_identity_from_user(member.user_id)

  union all

  select
    project.owner_id,
    invitation_identity.identity_key,
    0::integer,
    count(*)::integer
  from public.projects project
  join public.project_invitations invitation on invitation.project_id = project.id
  join private.subscription_editor_invitation_identities invitation_identity
    on invitation_identity.invitation_id = invitation.id
  where invitation.role = 'editor'
    and invitation.status = 'pending'
    and invitation.expires_at > now()
    and invitation_identity.identity_key
        <> security_private.editor_identity_from_user(project.owner_id)
  group by project.owner_id, invitation_identity.identity_key
), aggregated as (
  select
    owner_id,
    identity_key,
    sum(member_refs)::integer as member_refs,
    sum(invitation_refs)::integer as invitation_refs
  from contributions
  group by owner_id, identity_key
)
insert into private.subscription_editor_identities (
  owner_id,
  identity_key,
  member_refs,
  invitation_refs
)
select owner_id, identity_key, member_refs, invitation_refs
from aggregated
on conflict (owner_id, identity_key) do update
set member_refs = excluded.member_refs,
    invitation_refs = excluded.invitation_refs,
    updated_at = clock_timestamp();

update private.subscription_capacity_counters counter
set used = editor_count.used,
    updated_at = clock_timestamp()
from (
  select
    profile.user_id as owner_id,
    count(identity.identity_key)::bigint as used
  from public.profiles profile
  left join private.subscription_editor_identities identity
    on identity.owner_id = profile.user_id
  group by profile.user_id
) editor_count
where counter.owner_id = editor_count.owner_id
  and counter.capacity_key = 'editors_total';

create or replace function security_private.owner_editor_count(owner_uuid uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with editor_identities(identity_key) as (
    select security_private.editor_identity_from_user(member.user_id)
    from public.projects project
    join public.project_members member on member.project_id = project.id
    where project.owner_id = owner_uuid
      and member.role = 'editor'
      and member.user_id <> owner_uuid

    union

    select coalesce(
      invitation_identity.identity_key,
      security_private.editor_identity_from_email(invitation.email)
    )
    from public.projects project
    join public.project_invitations invitation on invitation.project_id = project.id
    left join private.subscription_editor_invitation_identities invitation_identity
      on invitation_identity.invitation_id = invitation.id
    where project.owner_id = owner_uuid
      and invitation.role = 'editor'
      and invitation.status = 'pending'
      and invitation.expires_at > now()
      and coalesce(
            invitation_identity.identity_key,
            security_private.editor_identity_from_email(invitation.email)
          )
          <> security_private.editor_identity_from_user(owner_uuid)
  )
  select count(*)::integer from editor_identities;
$$;

-- People registered by a sealed GEDCOM import reserve capacity before the
-- first browser batch writes public.persons. This prevents a parallel manual
-- insert from consuming capacity already promised to an all-or-nothing import.
create or replace function security_private.owner_person_reservations(owner_uuid uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
  select count(*)::integer
  from private.gedcom_import_operation_entities entity
  join private.gedcom_import_operations operation
    on operation.id = entity.operation_id
   and operation.project_id = entity.project_id
  join public.projects project on project.id = entity.project_id
  where project.owner_id = owner_uuid
    and operation.status = 'importing'
    and entity.entity_type = 'person'
    and entity.rolled_back_at is null
    and not exists (
      select 1
      from public.persons person
      where person.id = entity.entity_id
    );
$$;

-- Every sealed GEDCOM creates one rollback-owned family tree. Until that row
-- exists, the active operation reserves one tree slot. The settings lookup
-- also covers the short interval between INSERT and journal registration, so
-- the tree is never counted both as persisted usage and as a reservation.
create or replace function security_private.owner_tree_reservations(owner_uuid uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
  select count(*)::integer
  from private.gedcom_import_operations operation
  join public.projects project on project.id = operation.project_id
  where project.owner_id = owner_uuid
    and operation.status = 'importing'
    and not exists (
      select 1
      from public.family_trees tree
      where tree.project_id = operation.project_id
        and tree.settings ->> 'rollback_operation_id' = operation.id::text
    );
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  result integer := 0;
  ai_period_start date;
begin
  case limit_key
    when 'projects' then
      select count(*)::integer into result
      from public.projects project
      where project.owner_id = user_uuid;
    when 'family_trees_total' then
      select least(counter.used, 2147483647)::integer into result
      from private.subscription_capacity_counters counter
      where counter.owner_id = user_uuid
        and counter.capacity_key = 'family_trees_total';
    when 'persons_total' then
      select least(counter.used, 2147483647)::integer into result
      from private.subscription_capacity_counters counter
      where counter.owner_id = user_uuid
        and counter.capacity_key = 'persons_total';
    when 'editors_total' then
      result := security_private.owner_editor_count(user_uuid);
    when 'researches_total' then
      select count(*)::integer into result
      from public.researches research
      join public.projects project on project.id = research.project_id
      where project.owner_id = user_uuid;
    when 'researches_per_project' then
      select count(*)::integer into result
      from public.researches research
      where research.project_id = project_uuid;
    when 'records_per_standard_section' then
      if project_uuid is not null then
        select coalesce(max((quota.value->>'used')::integer), 0)
          into result
        from jsonb_each(public.standard_section_record_quotas(project_uuid)) as quota;
      end if;
    when 'project_members' then
      -- Compatibility metric only. It no longer gates invitations because
      -- viewers are unlimited and editors use editors_total account-wide.
      select count(*)::integer into result
      from public.project_members member
      where member.project_id = project_uuid
        and member.role <> 'owner';
    when 'custom_sections_per_project' then
      select count(*)::integer into result
      from public.custom_sections section
      where section.project_id = project_uuid;
    when 'custom_fields_per_project' then
      select count(*)::integer into result
      from public.custom_field_definitions definition
      where definition.project_id = project_uuid;
    when 'table_imports_per_month' then
      select coalesce(max(usage.used), 0) into result
      from public.subscription_usage usage
      where usage.user_id = user_uuid
        and usage.usage_key = limit_key
        and usage.period_start = date_trunc('month', now())::date;
    when 'hypothesis_ai_reviews_per_month' then
      -- Legacy clients see the same shared AI pool rather than a second quota.
      select period.period_start into ai_period_start
      from security_private.get_ai_usage_period(user_uuid) period;
      select coalesce(max(usage.used), 0) into result
      from public.subscription_usage usage
      where usage.user_id = user_uuid
        and usage.usage_key = 'ai_credits_per_month'
        and usage.period_start = ai_period_start;
    when 'ai_credits_per_month' then
      select period.period_start into ai_period_start
      from security_private.get_ai_usage_period(user_uuid) period;
      select coalesce(max(usage.used), 0) into result
      from public.subscription_usage usage
      where usage.user_id = user_uuid
        and usage.usage_key = 'ai_credits_per_month'
        and usage.period_start = ai_period_start;
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
set search_path = pg_catalog, public, pg_temp
as $$
  select case feature_key
    when 'custom_sections' then public.check_plan_limit(user_uuid, 'custom_sections_per_project', project_uuid)
    when 'custom_fields' then public.check_plan_limit(user_uuid, 'custom_fields_per_project', project_uuid)
    when 'table_import' then public.check_plan_limit(user_uuid, 'table_imports_per_month', project_uuid)
    when 'ai_credit' then public.check_plan_limit(user_uuid, 'ai_credits_per_month', project_uuid)
    when 'hypothesis_ai_review' then public.check_plan_limit(user_uuid, 'ai_credits_per_month', project_uuid)
    when 'persons' then public.check_plan_limit(user_uuid, 'persons_total', project_uuid)
    when 'family_trees' then public.check_plan_limit(user_uuid, 'family_trees_total', project_uuid)
    when 'editors' then public.check_plan_limit(user_uuid, 'editors_total', project_uuid)
    -- Legacy project_members is deliberately unlimited so a viewer invite is
    -- never mistaken for a paid editor seat.
    when 'project_members' then true
    else true
  end;
$$;

create or replace function security_private.enforce_owned_capacity_statement()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  capacity_change record;
  quota_key text;
  limit_record record;
  persisted_used bigint;
  reserved_capacity bigint;
begin
  quota_key := case tg_table_name
    when 'persons' then 'persons_total'
    when 'family_trees' then 'family_trees_total'
    else null
  end;
  if quota_key is null then
    raise exception 'ACCOUNT_CAPACITY_TABLE_INVALID' using errcode = '55000';
  end if;

  -- Aggregate the statement delta by account. UPDATE only transfers capacity
  -- when old/new projects have different owners; normal profile/tree edits
  -- therefore cost no counter writes or account-wide scans.
  for capacity_change in
    execute case tg_op
      when 'INSERT' then $query$
        select project.owner_id, count(*)::bigint as delta
        from account_capacity_new_rows changed
        join private.subscription_capacity_projects project
          on project.project_id = changed.project_id
        group by project.owner_id
        order by project.owner_id
      $query$
      when 'DELETE' then $query$
        select project.owner_id, -count(*)::bigint as delta
        from account_capacity_old_rows changed
        join private.subscription_capacity_projects project
          on project.project_id = changed.project_id
        group by project.owner_id
        order by project.owner_id
      $query$
      when 'UPDATE' then $query$
        with transfers as (
          select
            old_project.owner_id as old_owner_id,
            new_project.owner_id as new_owner_id
          from account_capacity_old_rows old_row
          join account_capacity_new_rows new_row on new_row.id = old_row.id
          join private.subscription_capacity_projects old_project
            on old_project.project_id = old_row.project_id
          join private.subscription_capacity_projects new_project
            on new_project.project_id = new_row.project_id
          where old_project.owner_id is distinct from new_project.owner_id
        ), deltas as (
          select old_owner_id as owner_id, -count(*)::bigint as delta
          from transfers
          group by old_owner_id
          union all
          select new_owner_id as owner_id, count(*)::bigint as delta
          from transfers
          group by new_owner_id
        )
        select owner_id, sum(delta)::bigint as delta
        from deltas
        group by owner_id
        having sum(delta) <> 0
        order by owner_id
      $query$
      else $query$
        select null::uuid as owner_id, 0::bigint as delta where false
      $query$
    end
  loop
    insert into private.subscription_capacity_counters (
      owner_id,
      capacity_key,
      used
    ) values (
      capacity_change.owner_id,
      quota_key,
      0
    )
    on conflict (owner_id, capacity_key) do nothing;

    -- UPDATE takes a real row lock. A concurrent statement sees the latest
    -- counter value through PostgreSQL's update recheck, so capacity cannot be
    -- exceeded by stale statement snapshots.
    update private.subscription_capacity_counters counter
    set used = counter.used + capacity_change.delta,
        updated_at = clock_timestamp()
    where counter.owner_id = capacity_change.owner_id
      and counter.capacity_key = quota_key
      and counter.used + capacity_change.delta >= 0
    returning counter.used into persisted_used;

    if not found then
      raise exception 'ACCOUNT_CAPACITY_COUNTER_INVALID:%', quota_key
        using errcode = '55000';
    end if;

    if capacity_change.delta <= 0 then
      continue;
    end if;

    select limits.limit_value, limits.is_unlimited
      into limit_record
    from public.get_user_plan_limits(capacity_change.owner_id) limits
    where limits.limit_key = quota_key;

    if not found then
      raise exception 'PLAN_LIMIT_REACHED:%', quota_key using errcode = 'P0001';
    end if;
    if limit_record.is_unlimited then
      continue;
    end if;

    -- Remaining sealed GEDCOM capacity is counted only while the corresponding
    -- canonical row is absent, so a persisted import row replaces rather than
    -- duplicates its reservation.
    reserved_capacity := case
      when quota_key = 'persons_total'
        then security_private.owner_person_reservations(capacity_change.owner_id)
      when quota_key = 'family_trees_total'
        then security_private.owner_tree_reservations(capacity_change.owner_id)
      else 0
    end;

    if persisted_used + reserved_capacity > coalesce(limit_record.limit_value, 0) then
      raise exception 'PLAN_LIMIT_REACHED:%', quota_key
        using errcode = 'P0001',
              detail = format(
                'used=%s reserved=%s projected=%s limit=%s',
                persisted_used,
                reserved_capacity,
                persisted_used + reserved_capacity,
                limit_record.limit_value
              );
    end if;
  end loop;

  return null;
end;
$$;

drop trigger if exists persons_account_capacity_insert on public.persons;
drop trigger if exists persons_z_account_capacity_insert on public.persons;
-- PostgreSQL runs same-kind triggers in name order. Keep the GEDCOM import
-- write fence (persons_insert_...) ahead of the quota trigger so every path,
-- including seal and rollback, takes operation-row -> capacity-counter locks.
create trigger persons_z_account_capacity_insert
after insert on public.persons
referencing new table as account_capacity_new_rows
for each statement execute function security_private.enforce_owned_capacity_statement();

drop trigger if exists persons_account_capacity_update on public.persons;
drop trigger if exists persons_z_account_capacity_update on public.persons;
create trigger persons_z_account_capacity_update
after update on public.persons
referencing old table as account_capacity_old_rows new table as account_capacity_new_rows
for each statement execute function security_private.enforce_owned_capacity_statement();

drop trigger if exists persons_account_capacity_delete on public.persons;
drop trigger if exists persons_z_account_capacity_delete on public.persons;
create trigger persons_z_account_capacity_delete
after delete on public.persons
referencing old table as account_capacity_old_rows
for each statement execute function security_private.enforce_owned_capacity_statement();

drop trigger if exists family_trees_account_capacity_insert on public.family_trees;
create trigger family_trees_account_capacity_insert
after insert on public.family_trees
referencing new table as account_capacity_new_rows
for each statement execute function security_private.enforce_owned_capacity_statement();

drop trigger if exists family_trees_account_capacity_update on public.family_trees;
create trigger family_trees_account_capacity_update
after update on public.family_trees
referencing old table as account_capacity_old_rows new table as account_capacity_new_rows
for each statement execute function security_private.enforce_owned_capacity_statement();

drop trigger if exists family_trees_account_capacity_delete on public.family_trees;
create trigger family_trees_account_capacity_delete
after delete on public.family_trees
referencing old table as account_capacity_old_rows
for each statement execute function security_private.enforce_owned_capacity_statement();

-- Project ownership is not a supported transfer operation. Without this guard
-- a single owner_id update could move every contained person/tree around the
-- account counters without touching the child tables.
create or replace function security_private.prevent_project_owner_transfer()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'PROJECT_OWNER_TRANSFER_NOT_SUPPORTED' using errcode = '0A000';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_prevent_owner_transfer on public.projects;
create trigger projects_prevent_owner_transfer
before update of owner_id on public.projects
for each row execute function security_private.prevent_project_owner_transfer();

create or replace function security_private.register_project_capacity_owner()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, private, pg_temp
as $$
begin
  insert into private.subscription_capacity_projects (project_id, owner_id)
  values (new.id, new.owner_id)
  on conflict (project_id) do update set owner_id = excluded.owner_id;
  return new;
end;
$$;

drop trigger if exists projects_register_capacity_owner on public.projects;
create trigger projects_register_capacity_owner
after insert on public.projects
for each row execute function security_private.register_project_capacity_owner();

create or replace function security_private.normalize_project_invitation_expiry()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  if new.status = 'pending' and new.expires_at <= now() then
    new.status := 'expired';
  end if;
  return new;
end;
$$;

drop trigger if exists project_invitations_normalize_expiry on public.project_invitations;
create trigger project_invitations_normalize_expiry
before insert or update of status, expires_at on public.project_invitations
for each row execute function security_private.normalize_project_invitation_expiry();

create or replace function security_private.enforce_editor_capacity_after_write()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  old_owner_id uuid;
  new_owner_id uuid;
  old_identity text;
  new_identity text;
  mapped_owner_id uuid;
  mapped_identity text;
  resolved_identity text;
  old_contributes boolean := false;
  new_contributes boolean := false;
  old_is_member boolean := false;
  new_is_member boolean := false;
  registry_member_refs integer;
  registry_invitation_refs integer;
  identity_created boolean;
  editor_limit integer;
  editor_unlimited boolean;
  updated_used bigint;
begin
  if tg_table_name = 'project_members' then
    if tg_op <> 'INSERT' then
      select coalesce(
        (
          select capacity_project.owner_id
          from private.subscription_capacity_projects capacity_project
          where capacity_project.project_id = old.project_id
        ),
        public.project_owner_id(old.project_id)
      ) into old_owner_id;

      old_contributes := old.role = 'editor'
        and old_owner_id is not null
        and old.user_id <> old_owner_id;
      if old_contributes then
        old_identity := security_private.editor_identity_from_user(old.user_id);
        old_is_member := true;
      end if;
    end if;

    if tg_op <> 'DELETE' then
      select coalesce(
        (
          select capacity_project.owner_id
          from private.subscription_capacity_projects capacity_project
          where capacity_project.project_id = new.project_id
        ),
        public.project_owner_id(new.project_id)
      ) into new_owner_id;

      if new_owner_id is null then
        raise exception 'PROJECT_OWNER_NOT_FOUND' using errcode = '23503';
      end if;

      new_contributes := new.role = 'editor' and new.user_id <> new_owner_id;
      if new_contributes then
        new_identity := security_private.editor_identity_from_user(new.user_id);
        new_is_member := true;
      end if;
    end if;
  elsif tg_table_name = 'project_invitations' then
    if tg_op <> 'INSERT' then
      select invitation_identity.owner_id, invitation_identity.identity_key
        into mapped_owner_id, mapped_identity
      from private.subscription_editor_invitation_identities invitation_identity
      where invitation_identity.invitation_id = old.id;

      old_owner_id := coalesce(
        mapped_owner_id,
        (
          select capacity_project.owner_id
          from private.subscription_capacity_projects capacity_project
          where capacity_project.project_id = old.project_id
        ),
        public.project_owner_id(old.project_id)
      );
      old_identity := coalesce(
        mapped_identity,
        security_private.editor_identity_from_email(old.email)
      );
      old_contributes := old.role = 'editor'
        and old.status = 'pending'
        and old_owner_id is not null
        and old_identity <> security_private.editor_identity_from_user(old_owner_id);
    end if;

    if tg_op <> 'DELETE' then
      select coalesce(
        (
          select capacity_project.owner_id
          from private.subscription_capacity_projects capacity_project
          where capacity_project.project_id = new.project_id
        ),
        public.project_owner_id(new.project_id)
      ) into new_owner_id;

      if new_owner_id is null then
        raise exception 'PROJECT_OWNER_NOT_FOUND' using errcode = '23503';
      end if;

      resolved_identity := security_private.editor_identity_from_email(new.email);
      new_identity := case
        -- Keep every durable identity stable for same-address row changes.
        -- A profile-registration/acceptance reconciliation below upgrades all
        -- matching email references as one set, avoiding a temporary extra
        -- seat when several invitations share the unresolved address.
        when tg_op = 'UPDATE'
          and new.email is not distinct from old.email
          and mapped_identity is not null
          then mapped_identity
        else resolved_identity
      end;
      new_contributes := new.role = 'editor'
        and new.status = 'pending'
        and new.expires_at > now()
        and new_identity <> security_private.editor_identity_from_user(new_owner_id);
    end if;
  else
    raise exception 'EDITOR_CAPACITY_TABLE_INVALID' using errcode = '55000';
  end if;

  -- Moving a single reference between projects of the same owner, or changing
  -- fields which do not alter the normalized identity, consumes the same seat.
  if old_contributes
     and new_contributes
     and old_owner_id = new_owner_id
     and old_identity = new_identity
     and old_is_member = new_is_member then
    if tg_table_name = 'project_invitations' then
      insert into private.subscription_editor_invitation_identities (
        invitation_id,
        owner_id,
        identity_key
      ) values (
        new.id,
        new_owner_id,
        new_identity
      )
      on conflict (invitation_id) do update
      set owner_id = excluded.owner_id,
          identity_key = excluded.identity_key,
          updated_at = clock_timestamp();
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Release the OLD reference first. If adding the NEW reference later fails,
  -- PostgreSQL rolls this change and the caller's row change back together.
  if old_contributes then
    select identity.member_refs, identity.invitation_refs
      into registry_member_refs, registry_invitation_refs
    from private.subscription_editor_identities identity
    where identity.owner_id = old_owner_id
      and identity.identity_key = old_identity
    for update;

    if found
       and ((old_is_member and registry_member_refs > 0)
            or (not old_is_member and registry_invitation_refs > 0)) then
      if registry_member_refs + registry_invitation_refs = 1 then
        delete from private.subscription_editor_identities identity
        where identity.owner_id = old_owner_id
          and identity.identity_key = old_identity;

        update private.subscription_capacity_counters counter
        set used = greatest(counter.used - 1, 0),
            updated_at = clock_timestamp()
        where counter.owner_id = old_owner_id
          and counter.capacity_key = 'editors_total';
      else
        update private.subscription_editor_identities identity
        set member_refs = identity.member_refs - case when old_is_member then 1 else 0 end,
            invitation_refs = identity.invitation_refs - case when old_is_member then 0 else 1 end,
            updated_at = clock_timestamp()
        where identity.owner_id = old_owner_id
          and identity.identity_key = old_identity;
      end if;
    end if;
  end if;

  if new_contributes then
    -- Expiration is time-based, so no row change fires at the exact deadline.
    -- Before claiming a new seat, normalize every expired pending invitation
    -- owned by this account. The nested UPDATE triggers release their registry
    -- references and capacity counter in the same transaction.
    update public.project_invitations invitation
    set status = 'expired'
    from public.projects project
    where project.id = invitation.project_id
      and project.owner_id = new_owner_id
      and invitation.status = 'pending'
      and invitation.expires_at <= now();

    -- The identity row deduplicates the same editor across all owned projects.
    -- Its primary key serializes concurrent writes for the same identity; the
    -- owner counter row serializes concurrent writes for different identities.
    loop
      identity_created := null;
      insert into private.subscription_editor_identities (
        owner_id,
        identity_key,
        member_refs,
        invitation_refs
      ) values (
        new_owner_id,
        new_identity,
        case when new_is_member then 1 else 0 end,
        case when new_is_member then 0 else 1 end
      )
      on conflict (owner_id, identity_key) do nothing
      returning true into identity_created;

      exit when coalesce(identity_created, false);

      update private.subscription_editor_identities identity
      set member_refs = identity.member_refs + case when new_is_member then 1 else 0 end,
          invitation_refs = identity.invitation_refs + case when new_is_member then 0 else 1 end,
          updated_at = clock_timestamp()
      where identity.owner_id = new_owner_id
        and identity.identity_key = new_identity;

      exit when found;
      -- A concurrent DELETE may remove the row between the conflict check and
      -- UPDATE. Retry until this reference is durably represented.
    end loop;

    if coalesce(identity_created, false) then
      select limits.limit_value, limits.is_unlimited
        into editor_limit, editor_unlimited
      from public.get_user_plan_limits(new_owner_id) limits
      where limits.limit_key = 'editors_total';

      if not found then
        raise exception 'PLAN_LIMIT_REACHED:editors_total' using errcode = 'P0001';
      end if;

      insert into private.subscription_capacity_counters (
        owner_id,
        capacity_key,
        used
      ) values (
        new_owner_id,
        'editors_total',
        0
      )
      on conflict (owner_id, capacity_key) do nothing;

      updated_used := null;
      update private.subscription_capacity_counters counter
      set used = counter.used + 1,
          updated_at = clock_timestamp()
      where counter.owner_id = new_owner_id
        and counter.capacity_key = 'editors_total'
        and (
          editor_unlimited
          or counter.used + 1 <= coalesce(editor_limit, 0)
        )
      returning counter.used into updated_used;

      if updated_used is null then
        raise exception 'PLAN_LIMIT_REACHED:editors_total'
          using errcode = 'P0001',
                detail = format(
                  'used=%s limit=%s',
                  security_private.owner_editor_count(new_owner_id),
                  coalesce(editor_limit, 0)
                );
      end if;
    end if;
  end if;

  if tg_table_name = 'project_invitations' then
    if tg_op = 'DELETE' then
      delete from private.subscription_editor_invitation_identities invitation_identity
      where invitation_identity.invitation_id = old.id;
    elsif new.role <> 'editor' then
      delete from private.subscription_editor_invitation_identities invitation_identity
      where invitation_identity.invitation_id = new.id;
    else
      insert into private.subscription_editor_invitation_identities (
        invitation_id,
        owner_id,
        identity_key
      ) values (
        new.id,
        new_owner_id,
        new_identity
      )
      on conflict (invitation_id) do update
      set owner_id = excluded.owner_id,
          identity_key = excluded.identity_key,
          updated_at = clock_timestamp();
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Legacy membership triggers treated every invitation/member as a paid seat
-- and also applied project rank after downgrade. They would block viewers on
-- an over-limit account. Normal RLS still restricts membership management to
-- project owners; the editor-only triggers below enforce the new commercial
-- seat rule.
drop trigger if exists project_members_plan_limit on public.project_members;
drop trigger if exists project_members_scoped_insert_access on public.project_members;
drop trigger if exists project_invitations_plan_limit on public.project_invitations;
drop trigger if exists project_invitations_scoped_insert_access on public.project_invitations;

-- A canonical person now belongs to the project/tree capacity and may be
-- shared by several researches. Requiring research_id on Free/Researcher is a
-- legacy section-centric rule and breaks both tree entry and GEDCOM import.
drop trigger if exists persons_require_research_scope on public.persons;

drop trigger if exists project_members_editor_capacity_insert on public.project_members;
create trigger project_members_editor_capacity_insert
after insert on public.project_members
for each row execute function security_private.enforce_editor_capacity_after_write();

drop trigger if exists project_members_editor_capacity_update on public.project_members;
create trigger project_members_editor_capacity_update
after update of project_id, user_id, role on public.project_members
for each row execute function security_private.enforce_editor_capacity_after_write();

drop trigger if exists project_members_editor_capacity_delete on public.project_members;
create trigger project_members_editor_capacity_delete
after delete on public.project_members
for each row execute function security_private.enforce_editor_capacity_after_write();

drop trigger if exists project_invitations_editor_capacity_insert on public.project_invitations;
create trigger project_invitations_editor_capacity_insert
after insert on public.project_invitations
for each row execute function security_private.enforce_editor_capacity_after_write();

drop trigger if exists project_invitations_editor_capacity_update on public.project_invitations;
create trigger project_invitations_editor_capacity_update
after update of project_id, email, role, status, expires_at on public.project_invitations
for each row execute function security_private.enforce_editor_capacity_after_write();

drop trigger if exists project_invitations_editor_capacity_delete on public.project_invitations;
create trigger project_invitations_editor_capacity_delete
after delete on public.project_invitations
for each row execute function security_private.enforce_editor_capacity_after_write();

-- Move every unresolved invitation for one authenticated address as a set.
-- Per-row conversion could briefly count both email:<address> and user:<uuid>
-- when several projects invited the same person, incorrectly rejecting the
-- conversion at a full seat limit. This routine locks the matching rows in a
-- deterministic order, transfers their registry references, and applies only
-- the final distinct-identity counter delta.
create or replace function security_private.reconcile_editor_invitations_for_user(
  target_user_id uuid,
  target_email text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  normalized_email text := lower(pg_catalog.btrim(coalesce(target_email, '')));
  old_identity text := 'email:' || lower(pg_catalog.btrim(coalesce(target_email, '')));
  new_identity text := 'user:' || target_user_id::text;
  owner_record record;
  moving_refs integer;
  old_member_refs integer;
  old_invitation_refs integer;
  new_member_refs integer;
  new_invitation_refs integer;
  old_total_after integer;
  new_total_after integer;
  distinct_delta integer;
  new_exists boolean;
  updated_used bigint;
begin
  if target_user_id is null or normalized_email = '' then
    raise exception 'EDITOR_IDENTITY_AUTH_MISMATCH' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = target_user_id
      and auth_user.email = pg_catalog.btrim(auth_user.email)
      and lower(auth_user.email) = normalized_email
  ) then
    raise exception 'EDITOR_IDENTITY_AUTH_MISMATCH' using errcode = '42501';
  end if;

  perform invitation.id
  from public.project_invitations invitation
  where invitation.role = 'editor'
    and lower(pg_catalog.btrim(invitation.email)) = normalized_email
  order by invitation.id
  for update;

  -- Legacy non-active invitations were deliberately omitted from the initial
  -- backfill. Give them a durable key before updating any matching mappings.
  insert into private.subscription_editor_invitation_identities (
    invitation_id,
    owner_id,
    identity_key
  )
  select invitation.id, project.owner_id, old_identity
  from public.project_invitations invitation
  join public.projects project on project.id = invitation.project_id
  where invitation.role = 'editor'
    and lower(pg_catalog.btrim(invitation.email)) = normalized_email
  on conflict (invitation_id) do nothing;

  for owner_record in
    select distinct invitation_identity.owner_id
    from private.subscription_editor_invitation_identities invitation_identity
    join public.project_invitations invitation
      on invitation.id = invitation_identity.invitation_id
    where invitation_identity.identity_key = old_identity
      and invitation.role = 'editor'
      and lower(pg_catalog.btrim(invitation.email)) = normalized_email
    order by invitation_identity.owner_id
  loop
    select count(*)::integer
      into moving_refs
    from private.subscription_editor_invitation_identities invitation_identity
    join public.project_invitations invitation
      on invitation.id = invitation_identity.invitation_id
    where invitation_identity.owner_id = owner_record.owner_id
      and invitation_identity.identity_key = old_identity
      and invitation.role = 'editor'
      and invitation.status = 'pending'
      and invitation.expires_at > now()
      and lower(pg_catalog.btrim(invitation.email)) = normalized_email;

    if moving_refs > 0 then
      perform 1
      from private.subscription_editor_identities identity
      where identity.owner_id = owner_record.owner_id
        and identity.identity_key in (old_identity, new_identity)
      order by identity.identity_key
      for update;

      select identity.member_refs, identity.invitation_refs
        into old_member_refs, old_invitation_refs
      from private.subscription_editor_identities identity
      where identity.owner_id = owner_record.owner_id
        and identity.identity_key = old_identity;

      if not found or old_invitation_refs < moving_refs then
        raise exception 'EDITOR_IDENTITY_REGISTRY_INVALID' using errcode = '55000';
      end if;

      select identity.member_refs, identity.invitation_refs
        into new_member_refs, new_invitation_refs
      from private.subscription_editor_identities identity
      where identity.owner_id = owner_record.owner_id
        and identity.identity_key = new_identity;
      new_exists := found;
      new_member_refs := coalesce(new_member_refs, 0);
      new_invitation_refs := coalesce(new_invitation_refs, 0);

      old_total_after := old_member_refs + old_invitation_refs - moving_refs;
      new_total_after := case
        when owner_record.owner_id = target_user_id
          then new_member_refs + new_invitation_refs
        else new_member_refs + new_invitation_refs + moving_refs
      end;
      distinct_delta :=
        (case when old_total_after > 0 then 1 else 0 end)
        + (case when new_total_after > 0 then 1 else 0 end)
        - 1
        - (case when new_exists then 1 else 0 end);

      if owner_record.owner_id <> target_user_id then
        if new_exists then
          update private.subscription_editor_identities identity
          set invitation_refs = identity.invitation_refs + moving_refs,
              updated_at = clock_timestamp()
          where identity.owner_id = owner_record.owner_id
            and identity.identity_key = new_identity;
        else
          insert into private.subscription_editor_identities (
            owner_id,
            identity_key,
            member_refs,
            invitation_refs
          ) values (
            owner_record.owner_id,
            new_identity,
            0,
            moving_refs
          );
        end if;
      end if;

      if old_total_after = 0 then
        delete from private.subscription_editor_identities identity
        where identity.owner_id = owner_record.owner_id
          and identity.identity_key = old_identity;
      else
        update private.subscription_editor_identities identity
        set invitation_refs = identity.invitation_refs - moving_refs,
            updated_at = clock_timestamp()
        where identity.owner_id = owner_record.owner_id
          and identity.identity_key = old_identity;
      end if;

      -- Reconciliation must merge or rename an existing identity, never grow
      -- the owner's distinct editor set. A positive delta signals drift rather
      -- than a legitimate capacity request.
      if distinct_delta > 0 then
        raise exception 'EDITOR_IDENTITY_REGISTRY_INVALID' using errcode = '55000';
      elsif distinct_delta < 0 then
        updated_used := null;
        update private.subscription_capacity_counters counter
        set used = counter.used + distinct_delta,
            updated_at = clock_timestamp()
        where counter.owner_id = owner_record.owner_id
          and counter.capacity_key = 'editors_total'
          and counter.used + distinct_delta >= 0
        returning counter.used into updated_used;

        if updated_used is null then
          raise exception 'EDITOR_IDENTITY_REGISTRY_INVALID' using errcode = '55000';
        end if;
      end if;
    end if;

    update private.subscription_editor_invitation_identities invitation_identity
    set identity_key = new_identity,
        updated_at = clock_timestamp()
    from public.project_invitations invitation
    where invitation.id = invitation_identity.invitation_id
      and invitation_identity.owner_id = owner_record.owner_id
      and invitation_identity.identity_key = old_identity
      and invitation.role = 'editor'
      and lower(pg_catalog.btrim(invitation.email)) = normalized_email;
  end loop;
end;
$$;

-- An invitation can be created before its recipient registers. Once Auth has
-- created the account and the public profile is inserted (or synchronized
-- after an Auth email change), upgrade all matching invitations atomically.
create or replace function security_private.reconcile_editor_invitations_after_profile_write()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  normalized_email text := lower(pg_catalog.btrim(coalesce(new.email, '')));
begin
  if normalized_email = ''
     or not exists (
       select 1
       from auth.users auth_user
       where auth_user.id = new.user_id
         and auth_user.email = pg_catalog.btrim(auth_user.email)
         and lower(auth_user.email) = normalized_email
     ) then
    return new;
  end if;

  perform security_private.reconcile_editor_invitations_for_user(
    new.user_id,
    normalized_email
  );

  return new;
end;
$$;

drop trigger if exists profiles_reconcile_editor_invitation_identity on public.profiles;
create trigger profiles_reconcile_editor_invitation_identity
after insert or update of email on public.profiles
for each row execute function security_private.reconcile_editor_invitations_after_profile_write();

-- Accepting an invitation replaces its pending invitation reference with the
-- authenticated user's membership reference. Release the pending reference
-- first so a full editor pool never needs a temporary extra seat; statement
-- rollback restores the invitation if membership creation fails.
create or replace function security_private.accept_project_invitation(invitation_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, security_private, pg_temp
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

  current_email := lower(pg_catalog.btrim(coalesce(auth.jwt() ->> 'email', '')));
  if current_email = '' then
    raise exception 'Authenticated email is required' using errcode = '42501';
  end if;

  -- Read once for a clear early error. Reconciliation below locks every
  -- matching editor invitation in UUID order before this row is revalidated.
  select candidate.*
    into invitation
  from public.project_invitations candidate
  where candidate.id = invitation_id;

  if invitation.id is null
     or invitation.status <> 'pending'
     or invitation.expires_at <= now()
     or lower(pg_catalog.btrim(invitation.email)) <> current_email then
    raise exception 'Invitation is invalid or expired' using errcode = 'P0001';
  end if;

  perform security_private.reconcile_editor_invitations_for_user(
    auth.uid(),
    current_email
  );

  select candidate.*
    into invitation
  from public.project_invitations candidate
  where candidate.id = invitation_id
  for update;

  if invitation.id is null
     or invitation.status <> 'pending'
     or invitation.expires_at <= now()
     or lower(pg_catalog.btrim(invitation.email)) <> current_email then
    raise exception 'Invitation is invalid or expired' using errcode = 'P0001';
  end if;

  if security_private.is_project_owner(invitation.project_id) then
    raise exception 'Project owner cannot accept a lower role' using errcode = '42501';
  end if;

  update public.project_invitations candidate
  set status = 'accepted',
      accepted_by = auth.uid(),
      accepted_at = now()
  where candidate.id = invitation.id;

  insert into public.project_members (project_id, user_id, role, invited_by)
  values (invitation.project_id, auth.uid(), invitation.role, invitation.invited_by)
  on conflict (project_id, user_id)
  do update set role = excluded.role, invited_by = excluded.invited_by;

  return invitation.project_id;
end;
$$;

-- Reject an oversized GEDCOM as one operation before its first public.persons
-- insert. Registered person UUIDs are the durable preflight manifest.
create or replace function security_private.seal_gedcom_import_operation(target_operation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  operation private.gedcom_import_operations%rowtype;
  target_owner_id uuid;
  person_limit record;
  tree_limit record;
  current_people bigint;
  current_trees bigint;
  reserved_people bigint;
  reserved_trees bigint;
  incoming_people bigint;
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  -- The persons_z_account_capacity_* triggers run after the GEDCOM write
  -- fence, so person batches, rollback and sealing all use the same
  -- operation-row -> capacity-counter lock order.
  select candidate.* into operation
  from private.gedcom_import_operations candidate
  where candidate.id = target_operation_id
  for update;

  if operation.id is null then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_FOUND' using errcode = '22023';
  end if;
  if operation.status <> 'preparing' then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_PREPARING' using errcode = '55000';
  end if;

  target_owner_id := public.project_owner_id(operation.project_id);

  insert into private.subscription_capacity_counters (owner_id, capacity_key, used)
  values
    (target_owner_id, 'persons_total', 0),
    (target_owner_id, 'family_trees_total', 0)
  on conflict (owner_id, capacity_key) do nothing;

  -- Lock both durable counters before checking. Capacity statement triggers
  -- update these same rows, making GEDCOM preflight and ordinary writes
  -- serializable without relying on a potentially stale statement snapshot.
  select counter.used into current_people
  from private.subscription_capacity_counters counter
  where counter.owner_id = target_owner_id
    and counter.capacity_key = 'persons_total'
  for update;

  select counter.used into current_trees
  from private.subscription_capacity_counters counter
  where counter.owner_id = target_owner_id
    and counter.capacity_key = 'family_trees_total'
  for update;

  select limits.limit_value, limits.is_unlimited
    into person_limit
  from public.get_user_plan_limits(target_owner_id) limits
  where limits.limit_key = 'persons_total';

  if not found then
    raise exception 'GEDCOM_PERSON_LIMIT_REACHED'
      using errcode = 'P0001', detail = 'PLAN_LIMIT_REACHED:persons_total';
  end if;

  select limits.limit_value, limits.is_unlimited
    into tree_limit
  from public.get_user_plan_limits(target_owner_id) limits
  where limits.limit_key = 'family_trees_total';

  if not found then
    raise exception 'GEDCOM_TREE_LIMIT_REACHED'
      using errcode = 'P0001', detail = 'PLAN_LIMIT_REACHED:family_trees_total';
  end if;

  select count(*)::integer
    into incoming_people
  from private.gedcom_import_operation_entities entity
  where entity.operation_id = operation.id
    and entity.entity_type = 'person'
    and entity.rolled_back_at is null;

  reserved_people := security_private.owner_person_reservations(target_owner_id);
  reserved_trees := security_private.owner_tree_reservations(target_owner_id);

  if not person_limit.is_unlimited
     and current_people + reserved_people + incoming_people
         > coalesce(person_limit.limit_value, 0) then
    raise exception 'GEDCOM_PERSON_LIMIT_REACHED'
      using errcode = 'P0001',
            detail = 'PLAN_LIMIT_REACHED:persons_total',
            hint = format(
              'used=%s reserved=%s incoming=%s limit=%s',
              current_people,
              reserved_people,
              incoming_people,
              coalesce(person_limit.limit_value, 0)
            );
  end if;

  -- createImportedFamilyTree always creates one rollback-owned tree. Reserve
  -- it here so Free with an existing tree fails before any person batch.
  if not tree_limit.is_unlimited
     and current_trees + reserved_trees + 1
         > coalesce(tree_limit.limit_value, 0) then
    raise exception 'GEDCOM_TREE_LIMIT_REACHED'
      using errcode = 'P0001',
            detail = 'PLAN_LIMIT_REACHED:family_trees_total',
            hint = format(
              'used=%s reserved=%s incoming=1 limit=%s',
              current_trees,
              reserved_trees,
              coalesce(tree_limit.limit_value, 0)
            );
  end if;

  update private.gedcom_import_operations
  set status = 'importing',
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = operation.id;

  return private.gedcom_import_operation_payload(operation.id);
end;
$$;

-- AI credits belong to the project owner. The acting editor is retained in
-- performed_by and metadata for audit. A null project id keeps the legacy
-- account-scoped behaviour and charges the authenticated actor.
create or replace function security_private.begin_ai_credit_usage(
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
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  billing_owner_id uuid;
  normalized_credits integer := greatest(1, least(coalesce(credits_requested, 1), 1000));
  current_used integer := 0;
  next_used integer := 0;
  limit_record record;
  usage_period_start date;
  usage_period_end date;
begin
  if actor_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if target_project_id is not null then
    if not security_private.can_edit_project(target_project_id) then
      raise exception 'Access denied' using errcode = '42501';
    end if;
    billing_owner_id := public.project_owner_id(target_project_id);
    if billing_owner_id is null then
      raise exception 'PROJECT_OWNER_NOT_FOUND' using errcode = '23503';
    end if;
  else
    billing_owner_id := actor_id;
  end if;

  if security_private.is_app_admin(actor_id) then
    return public.get_plan_usage(billing_owner_id, 'ai_credits_per_month', target_project_id);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(billing_owner_id::text || ':ai_credits_per_month', 0)
  );

  select period.period_start, period.period_end
    into usage_period_start, usage_period_end
  from security_private.get_ai_usage_period(billing_owner_id) period;

  select limits.limit_value, limits.is_unlimited
    into limit_record
  from public.get_user_plan_limits(billing_owner_id) limits
  where limits.limit_key = 'ai_credits_per_month';

  if not found then
    raise exception 'AI_CREDITS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  current_used := public.get_plan_usage(
    billing_owner_id,
    'ai_credits_per_month',
    target_project_id
  );

  if not limit_record.is_unlimited
     and current_used + normalized_credits > coalesce(limit_record.limit_value, 0) then
    perform public.log_subscription_event(
      billing_owner_id,
      'ai_credits_blocked',
      null,
      null,
      null,
      jsonb_build_object(
        'limit_key', 'ai_credits_per_month',
        'feature_key', feature_key,
        'project_id', target_project_id,
        'actor_id', actor_id,
        'billing_owner_id', billing_owner_id,
        'credits_requested', normalized_credits,
        'used', current_used,
        'limit', coalesce(limit_record.limit_value, 0)
      ),
      actor_id
    );
    raise exception 'AI_CREDITS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  insert into public.subscription_usage (
    user_id,
    usage_key,
    period_start,
    period_end,
    used
  ) values (
    billing_owner_id,
    'ai_credits_per_month',
    usage_period_start,
    usage_period_end,
    normalized_credits
  )
  on conflict (user_id, usage_key, period_start)
  do update set
    used = public.subscription_usage.used + normalized_credits,
    updated_at = now()
  where limit_record.is_unlimited
     or public.subscription_usage.used + normalized_credits
          <= coalesce(limit_record.limit_value, 0)
  returning used into next_used;

  -- The ON CONFLICT row lock is the final quota authority. If another Edge
  -- call consumed the remaining credits after our diagnostic pre-check, the
  -- conditional update returns no row and this transaction cannot overspend.
  if not found then
    raise exception 'AI_CREDITS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  perform public.log_subscription_event(
    billing_owner_id,
    'ai_credits_used',
    null,
    null,
    null,
    jsonb_build_object(
      'limit_key', 'ai_credits_per_month',
      'feature_key', feature_key,
      'project_id', target_project_id,
      'actor_id', actor_id,
      'billing_owner_id', billing_owner_id,
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

create or replace function security_private.subscription_limit_snapshot(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(
      limits.limit_key,
      jsonb_build_object(
        'value', limits.limit_value,
        'isUnlimited', limits.is_unlimited
      )
    ),
    '{}'::jsonb
  )
  from public.get_user_plan_limits(target_user_id) limits;
$$;

create or replace function security_private.subscription_usage_snapshot(
  target_user_id uuid,
  target_project_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'projects', public.get_plan_usage(target_user_id, 'projects', target_project_id),
    'familyTreesTotal', public.get_plan_usage(target_user_id, 'family_trees_total', target_project_id),
    'personsTotal', public.get_plan_usage(target_user_id, 'persons_total', target_project_id),
    'editorsTotal', public.get_plan_usage(target_user_id, 'editors_total', target_project_id),
    'researchesTotal', public.get_plan_usage(target_user_id, 'researches_total', target_project_id),
    'researchesPerProject', public.get_plan_usage(target_user_id, 'researches_per_project', target_project_id),
    'recordsPerStandardSection', public.get_plan_usage(target_user_id, 'records_per_standard_section', target_project_id),
    'projectMembers', public.get_plan_usage(target_user_id, 'project_members', target_project_id),
    'customSectionsPerProject', public.get_plan_usage(target_user_id, 'custom_sections_per_project', target_project_id),
    'customFieldsPerProject', public.get_plan_usage(target_user_id, 'custom_fields_per_project', target_project_id),
    'tableImportsPerMonth', public.get_plan_usage(target_user_id, 'table_imports_per_month', target_project_id),
    'aiCreditsPerMonth', public.get_plan_usage(target_user_id, 'ai_credits_per_month', target_project_id),
    'hypothesisAiReviewsPerMonth', public.get_plan_usage(target_user_id, 'hypothesis_ai_reviews_per_month', target_project_id)
  );
$$;

create or replace function security_private.get_my_subscription_context(
  target_project_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  user_id uuid := auth.uid();
  effective record;
  project_owner uuid := null;
  project_owner_plan text := null;
  result jsonb;
  limits jsonb;
  usage jsonb;
  project_capacity jsonb := null;
  section_quotas jsonb := '{}'::jsonb;
  project_mode text := null;
begin
  if user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if target_project_id is not null
     and not security_private.is_project_member(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  select * into effective
  from public.get_user_effective_subscription(user_id);

  limits := security_private.subscription_limit_snapshot(user_id);
  usage := security_private.subscription_usage_snapshot(user_id, target_project_id);

  if target_project_id is not null then
    project_mode := public.project_subscription_access_mode(target_project_id);
    section_quotas := public.standard_section_record_quotas(target_project_id);
    project_owner := public.project_owner_id(target_project_id);
    project_owner_plan := public.get_user_active_plan(project_owner);
    project_capacity := jsonb_build_object(
      'ownerId', project_owner,
      'effectivePlanCode', project_owner_plan,
      'limits', security_private.subscription_limit_snapshot(project_owner),
      'usage', security_private.subscription_usage_snapshot(project_owner, target_project_id)
    );
  end if;

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
    'projectCapacity', project_capacity,
    'sectionQuotas', section_quotas,
    'isAdmin', security_private.is_app_admin(user_id),
    'projectAccessMode', project_mode,
    'canCreateProjectRecords', coalesce(project_mode = 'FULL', true),
    'serverNow', now()
  ) into result
  from public.subscription_plans plan
  where plan.code = effective.effective_plan_code;

  return result;
end;
$$;

-- Family tree and Persons V2 are core plan features now. Existing restrictive
-- RLS policies still require the normal project membership/role policies;
-- this entitlement predicate merely stops requiring a per-user beta row.
create or replace function security_private.can_use_family_tree_feature()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select auth.uid() is not null;
$$;

create index if not exists project_invitations_editor_capacity_idx
  on public.project_invitations (project_id, status, role, expires_at, email);

revoke all on function
  security_private.get_ai_usage_period(uuid),
  security_private.editor_identity_from_email(text),
  security_private.editor_identity_from_user(uuid),
  security_private.owner_editor_count(uuid),
  security_private.owner_person_reservations(uuid),
  security_private.owner_tree_reservations(uuid),
  security_private.enforce_owned_capacity_statement(),
  security_private.prevent_project_owner_transfer(),
  security_private.register_project_capacity_owner(),
  security_private.normalize_project_invitation_expiry(),
  security_private.enforce_editor_capacity_after_write(),
  security_private.reconcile_editor_invitations_for_user(uuid, text),
  security_private.reconcile_editor_invitations_after_profile_write(),
  security_private.subscription_limit_snapshot(uuid),
  security_private.subscription_usage_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Keep existing public RPC signatures and grants. CREATE OR REPLACE preserves
-- the private implementations' ACLs established by the API-isolation
-- migration, while their public SECURITY INVOKER facades remain unchanged.

commit;
