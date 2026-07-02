begin;

-- GeneHelp data is accessed only through the server-side Edge Function.
-- Keep direct browser/client access closed while satisfying Security Advisor's
-- "RLS enabled but no policy" check with explicit deny policies.

alter table public.user_genehelp_accounts enable row level security;
alter table public.user_genehelp_requests enable row level security;

revoke all on public.user_genehelp_accounts from public, anon, authenticated;
revoke all on public.user_genehelp_requests from public, anon, authenticated;

grant select, insert, update, delete on public.user_genehelp_accounts to service_role;
grant select, insert, update, delete on public.user_genehelp_requests to service_role;

drop policy if exists user_genehelp_accounts_no_direct_access
  on public.user_genehelp_accounts;
create policy user_genehelp_accounts_no_direct_access
  on public.user_genehelp_accounts
  for all
  to authenticated
  using (false)
  with check (false);

drop policy if exists user_genehelp_requests_no_direct_access
  on public.user_genehelp_requests;
create policy user_genehelp_requests_no_direct_access
  on public.user_genehelp_requests
  for all
  to authenticated
  using (false)
  with check (false);

commit;
