begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Cache the authenticated user once per statement instead of evaluating
-- auth.uid() for every candidate row.  Keep the existing roles, commands and
-- authorization predicates unchanged.
alter policy zagulyaky_saved_places_owner_only
on public.zagulyaky_saved_places
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

alter policy zagulyaky_saved_source_presets_owner_only
on public.zagulyaky_saved_source_presets
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

alter policy place_change_requests_project_submit
on public.place_change_requests
with check (
  public.can_edit_project(project_id)
  and created_by = (select auth.uid())
  and status = 'submitted'
  and reviewed_by is null
  and reviewed_at is null
);

commit;
