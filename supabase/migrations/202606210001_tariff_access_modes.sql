begin;

create or replace function public.plan_limit_allows_rank(
  user_uuid uuid,
  target_limit_key text,
  target_rank integer
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select limit_row.is_unlimited
      or (limit_row.limit_value is not null and target_rank <= limit_row.limit_value)
    from public.get_user_plan_limits(user_uuid) limit_row
    where limit_row.limit_key = target_limit_key
  ), false);
$$;

create or replace function public.project_tariff_rank(target_project_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.projects target
  join public.projects candidate on candidate.owner_id = target.owner_id
  where target.id = target_project_id
    and (
      candidate.created_at < target.created_at
      or (candidate.created_at = target.created_at and candidate.id <= target.id)
    );
$$;

create or replace function public.research_tariff_rank(target_research_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.researches target
  join public.researches candidate on candidate.project_id = target.project_id
  where target.id = target_research_id
    and (
      candidate.created_at < target.created_at
      or (candidate.created_at = target.created_at and candidate.id <= target.id)
    );
$$;

create or replace function public.research_total_tariff_rank(target_research_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.researches target
  join public.projects target_project on target_project.id = target.project_id
  join public.researches candidate on true
  join public.projects candidate_project on candidate_project.id = candidate.project_id
  where target.id = target_research_id
    and candidate_project.owner_id = target_project.owner_id
    and (
      candidate.created_at < target.created_at
      or (candidate.created_at = target.created_at and candidate.id <= target.id)
    );
$$;

create or replace function public.project_allows_new_records(target_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_uuid uuid;
  target_rank integer;
begin
  select owner_id into owner_uuid from public.projects where id = target_project_id;
  if owner_uuid is null then return false; end if;

  target_rank := public.project_tariff_rank(target_project_id);
  return public.plan_limit_allows_rank(owner_uuid, 'projects', target_rank);
end;
$$;

create or replace function public.research_allows_new_records(
  target_project_id uuid,
  target_research_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_uuid uuid;
  research_project_id uuid;
  project_rank integer;
  per_project_rank integer;
  total_rank integer;
begin
  if target_research_id is null then
    return public.project_allows_new_records(target_project_id);
  end if;

  select research.project_id, project.owner_id
    into research_project_id, owner_uuid
  from public.researches research
  join public.projects project on project.id = research.project_id
  where research.id = target_research_id;

  if owner_uuid is null or research_project_id <> target_project_id then
    return false;
  end if;

  project_rank := public.project_tariff_rank(target_project_id);
  per_project_rank := public.research_tariff_rank(target_research_id);
  total_rank := public.research_total_tariff_rank(target_research_id);

  return public.plan_limit_allows_rank(owner_uuid, 'projects', project_rank)
    and public.plan_limit_allows_rank(owner_uuid, 'researches_per_project', per_project_rank)
    and public.plan_limit_allows_rank(owner_uuid, 'researches_total', total_rank);
end;
$$;

create or replace function public.project_subscription_access_mode(target_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when target_project_id is null then 'NONE'
    when not public.can_edit_project(target_project_id) then 'READ_ONLY'
    when public.project_allows_new_records(target_project_id) then 'FULL'
    else 'MANAGE_EXISTING'
  end;
$$;

create or replace function public.research_subscription_access_mode(
  target_project_id uuid,
  target_research_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when target_project_id is null or target_research_id is null then public.project_subscription_access_mode(target_project_id)
    when not public.can_edit_project(target_project_id) then 'READ_ONLY'
    when public.research_allows_new_records(target_project_id, target_research_id) then 'FULL'
    else 'MANAGE_EXISTING'
  end;
$$;

create or replace function public.attachment_owner_research_id(
  target_owner_type text,
  target_owner_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result uuid;
begin
  case target_owner_type
    when 'researches' then
      result := target_owner_id;
    when 'persons' then
      select research_id into result from public.persons where id = target_owner_id;
    when 'documents' then
      select research_id into result from public.documents where id = target_owner_id;
    when 'yearMatrix' then
      select research_id into result from public.year_matrix where id = target_owner_id;
    when 'tasks' then
      select research_id into result from public.tasks where id = target_owner_id;
    when 'findings' then
      select research_id into result from public.findings where id = target_owner_id;
    when 'hypotheses' then
      select research_id into result from public.hypotheses where id = target_owner_id;
    when 'archiveRequests' then
      select research_id into result from public.archive_requests where id = target_owner_id;
    else
      result := null;
  end case;
  return result;
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

  return new;
end;
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
  if tg_table_name <> 'projects' and allowed and not public.project_allows_new_records(target_project_id) then
    allowed := false;
    key := 'projects';
  end if;
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
    allowed := coalesce(member_limit_unlimited or reserved_members < member_limit, false)
      and public.project_allows_new_records(target_project_id);
    if not allowed and key is null then key := 'project_members'; end if;
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

create or replace function public.begin_table_import(target_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  current_used integer;
  usage_period_start date := date_trunc('month', now())::date;
  usage_period_end date := (date_trunc('month', now()) + interval '1 month')::date;
begin
  if not public.can_edit_project(target_project_id) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  owner_id := public.project_owner_id(target_project_id);
  if not public.project_allows_new_records(target_project_id) then
    perform public.log_subscription_event(
      owner_id, 'table_import_blocked', null, null, null,
      jsonb_build_object('limit_key', 'projects', 'project_id', target_project_id)
    );
    raise exception 'PLAN_SCOPE_CREATE_BLOCKED:projects' using errcode = 'P0001';
  end if;
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
  values (owner_id, 'table_imports_per_month', usage_period_start, usage_period_end, 1)
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
  project_mode text := null;
begin
  if user_id is null then raise exception 'Authentication required'; end if;
  select * into effective from public.get_user_effective_subscription(user_id);
  if target_project_id is not null then
    project_mode := public.project_subscription_access_mode(target_project_id);
  end if;
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
    'projectAccessMode', project_mode,
    'canCreateProjectRecords', coalesce(project_mode = 'FULL', true),
    'serverNow', now()
  ) into result
  from public.subscription_plans plan
  where plan.code = effective.effective_plan_code;
  return result;
end;
$$;

drop trigger if exists persons_scoped_insert_access on public.persons;
create trigger persons_scoped_insert_access before insert on public.persons
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists person_relations_scoped_insert_access on public.person_relations;
create trigger person_relations_scoped_insert_access before insert on public.person_relations
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists documents_scoped_insert_access on public.documents;
create trigger documents_scoped_insert_access before insert on public.documents
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists year_matrix_scoped_insert_access on public.year_matrix;
create trigger year_matrix_scoped_insert_access before insert on public.year_matrix
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists tasks_scoped_insert_access on public.tasks;
create trigger tasks_scoped_insert_access before insert on public.tasks
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists task_persons_scoped_insert_access on public.task_persons;
create trigger task_persons_scoped_insert_access before insert on public.task_persons
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists findings_scoped_insert_access on public.findings;
create trigger findings_scoped_insert_access before insert on public.findings
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists finding_participants_scoped_insert_access on public.finding_participants;
create trigger finding_participants_scoped_insert_access before insert on public.finding_participants
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists hypotheses_scoped_insert_access on public.hypotheses;
create trigger hypotheses_scoped_insert_access before insert on public.hypotheses
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists hypothesis_links_scoped_insert_access on public.hypothesis_links;
create trigger hypothesis_links_scoped_insert_access before insert on public.hypothesis_links
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists archive_requests_scoped_insert_access on public.archive_requests;
create trigger archive_requests_scoped_insert_access before insert on public.archive_requests
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists archive_request_persons_scoped_insert_access on public.archive_request_persons;
create trigger archive_request_persons_scoped_insert_access before insert on public.archive_request_persons
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists custom_sections_scoped_insert_access on public.custom_sections;
create trigger custom_sections_scoped_insert_access before insert on public.custom_sections
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists custom_field_definitions_scoped_insert_access on public.custom_field_definitions;
create trigger custom_field_definitions_scoped_insert_access before insert on public.custom_field_definitions
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists custom_section_fields_scoped_insert_access on public.custom_section_fields;
create trigger custom_section_fields_scoped_insert_access before insert on public.custom_section_fields
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists custom_records_scoped_insert_access on public.custom_records;
create trigger custom_records_scoped_insert_access before insert on public.custom_records
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists record_links_scoped_insert_access on public.record_links;
create trigger record_links_scoped_insert_access before insert on public.record_links
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists attachments_scoped_insert_access on public.attachments;
create trigger attachments_scoped_insert_access before insert on public.attachments
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists project_invitations_scoped_insert_access on public.project_invitations;
create trigger project_invitations_scoped_insert_access before insert on public.project_invitations
  for each row execute function public.enforce_scoped_insert_access();

drop trigger if exists project_members_scoped_insert_access on public.project_members;
create trigger project_members_scoped_insert_access before insert on public.project_members
  for each row when (new.role <> 'owner') execute function public.enforce_scoped_insert_access();

create index if not exists projects_owner_created_id_idx
  on public.projects (owner_id, created_at, id);

create index if not exists researches_project_created_id_idx
  on public.researches (project_id, created_at, id);

revoke execute on function public.plan_limit_allows_rank(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.project_tariff_rank(uuid) from public, anon, authenticated;
revoke execute on function public.research_tariff_rank(uuid) from public, anon, authenticated;
revoke execute on function public.research_total_tariff_rank(uuid) from public, anon, authenticated;
revoke execute on function public.project_allows_new_records(uuid) from public, anon, authenticated;
revoke execute on function public.research_allows_new_records(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.project_subscription_access_mode(uuid) from public, anon, authenticated;
revoke execute on function public.research_subscription_access_mode(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.attachment_owner_research_id(text, uuid) from public, anon, authenticated;
revoke execute on function public.enforce_scoped_insert_access() from public, anon, authenticated;
revoke execute on function public.begin_table_import(uuid) from public, anon;
grant execute on function public.begin_table_import(uuid) to authenticated;
grant execute on function public.get_my_subscription_context(uuid) to authenticated;

commit;
