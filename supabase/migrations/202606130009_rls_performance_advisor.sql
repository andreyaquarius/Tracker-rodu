begin;

alter policy profiles_select_related
on public.profiles
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = profiles.user_id
  )
);

alter policy profiles_update_self
on public.profiles
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

alter policy projects_insert_owner
on public.projects
with check (owner_id = (select auth.uid()));

alter policy projects_update_owner
on public.projects
using (public.is_project_owner(id))
with check (owner_id = (select auth.uid()));

alter policy project_members_update_owner
on public.project_members
using (
  public.is_project_owner(project_id)
  and user_id <> (select auth.uid())
)
with check (
  public.is_project_owner(project_id)
  and role <> 'owner'
);

alter policy project_members_delete_owner
on public.project_members
using (
  public.is_project_owner(project_id)
  and user_id <> (select auth.uid())
);

alter policy invitations_select_owner_or_recipient
on public.project_invitations
using (
  public.is_project_owner(project_id)
  or lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
);

drop policy if exists invitations_manage_owner
  on public.project_invitations;
drop policy if exists invitations_insert_owner
  on public.project_invitations;
drop policy if exists invitations_update_owner
  on public.project_invitations;
drop policy if exists invitations_delete_owner
  on public.project_invitations;

create policy invitations_insert_owner
on public.project_invitations for insert to authenticated
with check (public.is_project_owner(project_id));

create policy invitations_update_owner
on public.project_invitations for update to authenticated
using (public.is_project_owner(project_id))
with check (public.is_project_owner(project_id));

create policy invitations_delete_owner
on public.project_invitations for delete to authenticated
using (public.is_project_owner(project_id));

alter policy activity_log_insert_editors
on public.activity_log
with check (
  public.can_edit_project(project_id)
  and actor_id = (select auth.uid())
);

alter policy user_ai_settings_select_own
on public.user_ai_settings
using (user_id = (select auth.uid()));

alter policy user_ai_settings_insert_own
on public.user_ai_settings
with check (user_id = (select auth.uid()));

alter policy user_ai_settings_update_own
on public.user_ai_settings
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

alter policy user_ai_settings_delete_own
on public.user_ai_settings
using (user_id = (select auth.uid()));

alter policy ai_hypothesis_reviews_insert_members
on public.ai_hypothesis_reviews
with check (
  user_id = (select auth.uid())
  and workspace_id = project_id
  and public.is_project_member(project_id)
);

alter policy ai_hypothesis_reviews_delete_own
on public.ai_hypothesis_reviews
using (
  user_id = (select auth.uid())
  and public.is_project_member(project_id)
);

-- These were added by the earlier dashboard optimization. The original
-- user_id index and the primary key already cover the same access paths.
drop index if exists public.project_members_user_idx;
drop index if exists public.project_members_project_user_idx;

commit;
