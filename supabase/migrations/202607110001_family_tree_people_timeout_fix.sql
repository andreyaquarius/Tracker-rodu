begin;

-- 202607100001 tightened privacy for living people, but its SELECT policies
-- called SECURITY DEFINER membership helpers once for every scanned row.
-- A project with a few thousand persons therefore performed thousands of
-- repeated project_members lookups while the people screen fetched several
-- pages at once. Keep the privacy rules, but let PostgreSQL materialize the
-- caller's project sets once per statement (InitPlan/hash subplans).

drop policy if exists persons_select on public.persons;
create policy persons_select on public.persons
for select to authenticated
using (
  project_id in (
    select member.project_id
    from public.project_members member
    where member.user_id = (select auth.uid())
      and member.role in ('owner', 'editor')
  )
  or (
    project_id in (
      select member.project_id
      from public.project_members member
      where member.user_id = (select auth.uid())
    )
    and not (
      is_living
      and privacy_status in ('private', 'confidential')
    )
  )
);

drop policy if exists person_relations_select on public.person_relations;
create policy person_relations_select on public.person_relations
for select to authenticated
using (
  project_id in (
    select member.project_id
    from public.project_members member
    where member.user_id = (select auth.uid())
  )
  and (project_id, person_id) in (
    select person.project_id, person.id
    from public.persons person
  )
  and (project_id, related_person_id) in (
    select person.project_id, person.id
    from public.persons person
  )
);

-- Match the client order exactly. Including id removes the final sort and
-- gives every page a stable order when many rows share updated_at.
create index if not exists persons_project_updated_id_idx
  on public.persons (project_id, updated_at desc, id asc);

create index if not exists person_relations_project_updated_id_idx
  on public.person_relations (project_id, updated_at desc, id asc);

commit;
