-- Read-only preflight for 202609140002_scoped_research_links.sql.
-- Run as a database administrator, not an end-user role (RLS would hide rows).
-- No genealogical text is returned and no records are deleted/reassigned.
begin read only;
set local statement_timeout = '30s';

select 'task_persons.task' as endpoint, count(*) as invalid_links
from public.task_persons l
where not exists (select 1 from public.tasks t where t.id=l.task_id and t.project_id=l.project_id)
union all
select 'task_persons.person', count(*) from public.task_persons l
where not exists (select 1 from public.persons p where p.id=l.person_id and p.project_id=l.project_id)
union all
select 'hypothesis_links.hypothesis', count(*) from public.hypothesis_links l
where not exists (select 1 from public.hypotheses h where h.id=l.hypothesis_id and h.project_id=l.project_id)
union all
select 'hypothesis_links.person', count(*) from public.hypothesis_links l
where l.target_type='person' and not exists (select 1 from public.persons p where p.id=l.target_id and p.project_id=l.project_id)
union all
select 'hypothesis_links.document', count(*) from public.hypothesis_links l
where l.target_type='document' and not exists (select 1 from public.documents d where d.id=l.target_id and d.project_id=l.project_id)
union all
select 'hypothesis_links.finding', count(*) from public.hypothesis_links l
where l.target_type='finding' and not exists (select 1 from public.findings f where f.id=l.target_id and f.project_id=l.project_id)
union all
select 'hypothesis_links.unsupported_type', count(*) from public.hypothesis_links l
where l.target_type is null or l.target_type not in ('person','document','finding');

-- Empty before migration; after migration all six rows should be validated.
-- NOT VALID still enforces new writes. Historical mismatches need owner review.
select c.conrelid::regclass as relation, c.conname as constraint_name, c.convalidated as validated
from pg_catalog.pg_constraint c
where c.conrelid in ('public.task_persons'::regclass, 'public.hypothesis_links'::regclass)
  and c.conname in ('task_persons_scoped_task_fk','task_persons_scoped_person_fk',
    'hypothesis_links_scoped_hypothesis_fk','hypothesis_links_scoped_person_fk',
    'hypothesis_links_scoped_document_fk','hypothesis_links_scoped_finding_fk')
order by relation, constraint_name;
rollback;
