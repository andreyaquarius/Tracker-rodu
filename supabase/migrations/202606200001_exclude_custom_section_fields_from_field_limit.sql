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
    else
      result := 0;
  end case;
  return coalesce(result, 0);
end;
$$;

drop trigger if exists custom_section_fields_plan_limit on public.custom_section_fields;

commit;
