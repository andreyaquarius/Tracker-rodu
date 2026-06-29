begin;

-- Performance Advisor follow-up:
-- keep one permissive policy per role/action on app_announcements.
-- Published announcements are visible to users; admins can also see drafts.

drop policy if exists app_announcements_read_published on public.app_announcements;
drop policy if exists app_announcements_admin_manage on public.app_announcements;
drop policy if exists app_announcements_select_published_or_admin on public.app_announcements;
drop policy if exists app_announcements_admin_insert on public.app_announcements;
drop policy if exists app_announcements_admin_update on public.app_announcements;
drop policy if exists app_announcements_admin_delete on public.app_announcements;

create policy app_announcements_select_published_or_admin
on public.app_announcements
for select
to authenticated
using (
  is_published
  or (select public.is_app_admin((select auth.uid())))
);

create policy app_announcements_admin_insert
on public.app_announcements
for insert
to authenticated
with check ((select public.is_app_admin((select auth.uid()))));

create policy app_announcements_admin_update
on public.app_announcements
for update
to authenticated
using ((select public.is_app_admin((select auth.uid()))))
with check ((select public.is_app_admin((select auth.uid()))));

create policy app_announcements_admin_delete
on public.app_announcements
for delete
to authenticated
using ((select public.is_app_admin((select auth.uid()))));

commit;
