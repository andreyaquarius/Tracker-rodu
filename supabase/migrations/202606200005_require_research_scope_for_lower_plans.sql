begin;

create or replace function public.enforce_research_required_by_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_uuid uuid;
  active_plan text;
begin
  owner_uuid := public.project_owner_id(new.project_id);
  active_plan := public.get_user_active_plan(owner_uuid);

  if active_plan in ('free', 'researcher') and new.research_id is null then
    raise exception 'RESEARCH_REQUIRED_BY_PLAN' using errcode = 'P0001';
  end if;

  if new.research_id is not null and not exists (
    select 1
    from public.researches research
    where research.id = new.research_id
      and research.project_id = new.project_id
  ) then
    raise exception 'INVALID_RESEARCH_REFERENCE' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_research_required_by_plan() from public, anon, authenticated;

drop trigger if exists documents_require_research_scope on public.documents;
create trigger documents_require_research_scope
  before insert or update on public.documents
  for each row execute function public.enforce_research_required_by_plan();

drop trigger if exists year_matrix_require_research_scope on public.year_matrix;
create trigger year_matrix_require_research_scope
  before insert or update on public.year_matrix
  for each row execute function public.enforce_research_required_by_plan();

drop trigger if exists tasks_require_research_scope on public.tasks;
create trigger tasks_require_research_scope
  before insert or update on public.tasks
  for each row execute function public.enforce_research_required_by_plan();

drop trigger if exists findings_require_research_scope on public.findings;
create trigger findings_require_research_scope
  before insert or update on public.findings
  for each row execute function public.enforce_research_required_by_plan();

drop trigger if exists hypotheses_require_research_scope on public.hypotheses;
create trigger hypotheses_require_research_scope
  before insert or update on public.hypotheses
  for each row execute function public.enforce_research_required_by_plan();

drop trigger if exists archive_requests_require_research_scope on public.archive_requests;
create trigger archive_requests_require_research_scope
  before insert or update on public.archive_requests
  for each row execute function public.enforce_research_required_by_plan();

drop trigger if exists persons_require_research_scope on public.persons;
create trigger persons_require_research_scope
  before insert or update on public.persons
  for each row execute function public.enforce_research_required_by_plan();

commit;
