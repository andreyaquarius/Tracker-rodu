begin;

-- Supabase Performance Advisor: prevent auth.uid()/auth helpers from being
-- re-evaluated for every scanned row in RLS policies recreated by later
-- subscription/admin migrations.

drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_select_related on public.profiles;
create policy profiles_select_related
on public.profiles
for select
to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = profiles.user_id
  )
  or (select public.is_app_admin())
);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner
on public.projects
for insert
to authenticated
with check (owner_id = (select auth.uid()));

drop policy if exists user_ai_settings_select_own on public.user_ai_settings;
create policy user_ai_settings_select_own
on public.user_ai_settings
for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists user_ai_settings_insert_own on public.user_ai_settings;
create policy user_ai_settings_insert_own
on public.user_ai_settings
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists user_ai_settings_update_own on public.user_ai_settings;
create policy user_ai_settings_update_own
on public.user_ai_settings
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists user_ai_settings_delete_own on public.user_ai_settings;
create policy user_ai_settings_delete_own
on public.user_ai_settings
for delete
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists user_subscriptions_admin_manage on public.user_subscriptions;
drop policy if exists user_subscriptions_admin_insert on public.user_subscriptions;
drop policy if exists user_subscriptions_admin_update on public.user_subscriptions;
drop policy if exists user_subscriptions_admin_delete on public.user_subscriptions;
drop policy if exists user_subscriptions_read_own on public.user_subscriptions;

create policy user_subscriptions_read_own
on public.user_subscriptions
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select public.is_app_admin())
);

create policy user_subscriptions_admin_insert
on public.user_subscriptions
for insert
to authenticated
with check ((select public.is_app_admin()));

create policy user_subscriptions_admin_update
on public.user_subscriptions
for update
to authenticated
using ((select public.is_app_admin()))
with check ((select public.is_app_admin()));

create policy user_subscriptions_admin_delete
on public.user_subscriptions
for delete
to authenticated
using ((select public.is_app_admin()));

drop policy if exists subscription_usage_read_own on public.subscription_usage;
create policy subscription_usage_read_own
on public.subscription_usage
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select public.is_app_admin())
);

drop policy if exists subscription_events_read_own on public.subscription_events;
create policy subscription_events_read_own
on public.subscription_events
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select public.is_app_admin())
);

drop policy if exists subscription_events_admin_insert on public.subscription_events;
create policy subscription_events_admin_insert
on public.subscription_events
for insert
to authenticated
with check ((select public.is_app_admin()));

drop policy if exists app_admins_read_self on public.app_admins;
create policy app_admins_read_self
on public.app_admins
for select
to authenticated
using (user_id = (select auth.uid()));

commit;
