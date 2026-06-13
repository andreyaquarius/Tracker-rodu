begin;

-- Performance fix for the data-access RLS policies.
--
-- Every per-project table was protected with a policy of the form
--   using (public.is_project_member(project_id))
-- where the helper receives the row's project_id column as its argument. Because
-- the argument depends on the row, PostgreSQL re-runs the SECURITY DEFINER helper
-- (and the auth.uid() call inside it) once for EVERY row that is scanned, so a
-- full table read costs N membership look-ups. Combined with the full-table loads
-- the client issues, larger projects exceed statement_timeout and PostgREST
-- aborts the request with "Warp server error: Thread killed by timeout manager".
--
-- Rewriting the checks as an IN (subquery) keeps the exact same semantics but lets
-- the planner evaluate the membership/role set once per statement (InitPlan)
-- instead of once per row. The projects / project_members / profiles / invitation
-- policies intentionally keep using the SECURITY DEFINER helpers: inlining them
-- there would recurse through those tables' own RLS.

do $$
declare
  t text;
  member_tables text[] := array[
    'researches', 'persons', 'person_relations', 'documents', 'year_matrix',
    'tasks', 'task_persons', 'findings', 'finding_participants', 'hypotheses',
    'hypothesis_links', 'archive_requests', 'archive_request_persons',
    'custom_records', 'record_links', 'attachments'
  ];
  owner_tables text[] := array[
    'custom_field_definitions', 'custom_sections', 'custom_section_fields'
  ];
  member_expr constant text :=
    'project_id in (select pm.project_id from public.project_members pm '
    'where pm.user_id = (select auth.uid()))';
  editor_expr constant text :=
    'project_id in (select pm.project_id from public.project_members pm '
    'where pm.user_id = (select auth.uid()) and pm.role in (''owner'', ''editor''))';
  owner_expr constant text :=
    'project_id in (select p.id from public.projects p '
    'where p.owner_id = (select auth.uid()))';
begin
  -- Member can read; editor/owner can write.
  foreach t in array member_tables loop
    execute format('alter policy %1$I_select on public.%1$I using (%2$s)', t, member_expr);
    execute format('alter policy %1$I_insert on public.%1$I with check (%2$s)', t, editor_expr);
    execute format('alter policy %1$I_update on public.%1$I using (%2$s) with check (%2$s)', t, editor_expr);
    execute format('alter policy %1$I_delete on public.%1$I using (%2$s)', t, editor_expr);
  end loop;

  -- Member can read; only the owner manages the custom structure.
  foreach t in array owner_tables loop
    execute format('alter policy %1$I_select on public.%1$I using (%2$s)', t, member_expr);
    execute format('alter policy %1$I_insert on public.%1$I with check (%2$s)', t, owner_expr);
    execute format('alter policy %1$I_update on public.%1$I using (%2$s) with check (%2$s)', t, owner_expr);
    execute format('alter policy %1$I_delete on public.%1$I using (%2$s)', t, owner_expr);
  end loop;
end;
$$;

-- activity_log uses bespoke policy names and keeps the extra actor_id guard.
alter policy activity_log_select_members on public.activity_log
  using (
    project_id in (
      select pm.project_id from public.project_members pm
      where pm.user_id = (select auth.uid())
    )
  );

alter policy activity_log_insert_editors on public.activity_log
  with check (
    project_id in (
      select pm.project_id from public.project_members pm
      where pm.user_id = (select auth.uid()) and pm.role in ('owner', 'editor')
    )
    and actor_id = (select auth.uid())
  );

commit;
