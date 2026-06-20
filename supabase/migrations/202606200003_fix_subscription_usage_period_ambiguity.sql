begin;

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
  current_month_start date := date_trunc('month', now())::date;
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
      select coalesce(max(subscription_usage.used), 0) into result
      from public.subscription_usage
      where subscription_usage.user_id = user_uuid
        and subscription_usage.usage_key = limit_key
        and subscription_usage.period_start = current_month_start;
    when 'hypothesis_ai_reviews_per_month' then
      select coalesce(max(subscription_usage.used), 0) into result
      from public.subscription_usage
      where subscription_usage.user_id = user_uuid
        and subscription_usage.usage_key = limit_key
        and subscription_usage.period_start = current_month_start;
    else
      result := 0;
  end case;
  return coalesce(result, 0);
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
  values (auth.uid(), 'hypothesis_ai_reviews_per_month', usage_period_start, usage_period_end, 1)
  on conflict (user_id, usage_key, period_start)
  do update set used = public.subscription_usage.used + 1, updated_at = now()
  returning used into current_used;
  return current_used;
end;
$$;

revoke execute on function public.get_plan_usage(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.begin_table_import(uuid) from public, anon;
revoke execute on function public.begin_hypothesis_ai_review(uuid) from public, anon;
grant execute on function public.begin_table_import(uuid) to authenticated;
grant execute on function public.begin_hypothesis_ai_review(uuid) to authenticated;

commit;
