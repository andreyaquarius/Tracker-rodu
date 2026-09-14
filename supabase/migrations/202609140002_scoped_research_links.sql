begin;
set local lock_timeout = '5s';

create unique index if not exists tasks_id_project_scope_uq on public.tasks(id, project_id);
create unique index if not exists persons_id_project_scope_uq on public.persons(id, project_id);
create unique index if not exists hypotheses_id_project_scope_uq on public.hypotheses(id, project_id);
create unique index if not exists documents_id_project_scope_uq on public.documents(id, project_id);
create unique index if not exists findings_id_project_scope_uq on public.findings(id, project_id);

-- NOT VALID protects all new writes immediately without deleting historical
-- bad links. A clean database is validated below; dirty links remain hidden
-- and require an owner-reviewed repair, never automatic reassignment.
alter table public.task_persons
  add constraint task_persons_scoped_task_fk foreign key (task_id, project_id) references public.tasks(id, project_id) on delete cascade not valid,
  add constraint task_persons_scoped_person_fk foreign key (person_id, project_id) references public.persons(id, project_id) on delete cascade not valid;

-- Generated columns form a server-controlled whitelist. Real FKs also handle
-- concurrent deletion/project moves, unlike a check-then-write trigger.
alter table public.hypothesis_links
  add column person_target_id uuid generated always as (case when target_type='person' then target_id end) stored,
  add column document_target_id uuid generated always as (case when target_type='document' then target_id end) stored,
  add column finding_target_id uuid generated always as (case when target_type='finding' then target_id end) stored;
alter table public.hypothesis_links
  add constraint hypothesis_links_scoped_hypothesis_fk foreign key (hypothesis_id, project_id) references public.hypotheses(id, project_id) on delete cascade not valid,
  add constraint hypothesis_links_scoped_person_fk foreign key (person_target_id, project_id) references public.persons(id, project_id) on delete cascade not valid,
  add constraint hypothesis_links_scoped_document_fk foreign key (document_target_id, project_id) references public.documents(id, project_id) on delete cascade not valid,
  add constraint hypothesis_links_scoped_finding_fk foreign key (finding_target_id, project_id) references public.findings(id, project_id) on delete cascade not valid;
create index hypothesis_links_person_scope_idx on public.hypothesis_links(person_target_id, project_id) where person_target_id is not null;
create index hypothesis_links_document_scope_idx on public.hypothesis_links(document_target_id, project_id) where document_target_id is not null;
create index hypothesis_links_finding_scope_idx on public.hypothesis_links(finding_target_id, project_id) where finding_target_id is not null;

create policy task_persons_valid_scope on public.task_persons as restrictive for select to authenticated using (
  exists (select 1 from public.tasks t where t.id=task_id and t.project_id=task_persons.project_id)
  and exists (select 1 from public.persons p where p.id=person_id and p.project_id=task_persons.project_id)
);
create policy hypothesis_links_valid_scope on public.hypothesis_links as restrictive for select to authenticated using (
  exists (select 1 from public.hypotheses h where h.id=hypothesis_id and h.project_id=hypothesis_links.project_id)
  and case target_type
    when 'person' then exists(select 1 from public.persons p where p.id=target_id and p.project_id=hypothesis_links.project_id)
    when 'document' then exists(select 1 from public.documents d where d.id=target_id and d.project_id=hypothesis_links.project_id)
    when 'finding' then exists(select 1 from public.findings f where f.id=target_id and f.project_id=hypothesis_links.project_id)
    else false end
);

do $$ declare c record; begin
  for c in select conrelid::regclass as tbl, conname from pg_constraint
    where conname in ('task_persons_scoped_task_fk','task_persons_scoped_person_fk',
      'hypothesis_links_scoped_hypothesis_fk','hypothesis_links_scoped_person_fk',
      'hypothesis_links_scoped_document_fk','hypothesis_links_scoped_finding_fk')
  loop
    begin execute format('alter table %s validate constraint %I', c.tbl, c.conname);
    exception when foreign_key_violation then
      raise warning 'Historical links require owner review: %.%. New writes are protected; invalid rows were not deleted.', c.tbl, c.conname;
    end;
  end loop;
end $$;
commit;
