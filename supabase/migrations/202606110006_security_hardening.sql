begin;

-- Use an empty search path so function object references cannot be shadowed
-- by objects created in another schema.
alter function public.set_updated_at()
  set search_path = '';

alter function public.storage_project_id(text)
  set search_path = '';

alter function public.handle_new_user()
  set search_path = '';

alter function public.add_project_owner()
  set search_path = '';

alter function public.is_project_member(uuid)
  set search_path = '';

alter function public.can_edit_project(uuid)
  set search_path = '';

alter function public.is_project_owner(uuid)
  set search_path = '';

alter function public.accept_project_invitation(uuid)
  set search_path = '';

-- Trigger-only functions must never be callable through the client roles.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.add_project_owner() from public, anon, authenticated;

-- RLS helpers and the invitation RPC are intentionally available only to
-- authenticated users. Each function derives identity from auth.uid()/JWT.
revoke execute on function public.is_project_member(uuid) from public, anon;
revoke execute on function public.can_edit_project(uuid) from public, anon;
revoke execute on function public.is_project_owner(uuid) from public, anon;
revoke execute on function public.accept_project_invitation(uuid) from public, anon;

grant execute on function public.is_project_member(uuid) to authenticated;
grant execute on function public.can_edit_project(uuid) to authenticated;
grant execute on function public.is_project_owner(uuid) to authenticated;
grant execute on function public.accept_project_invitation(uuid) to authenticated;

commit;
