begin;

create table if not exists public.user_genehelp_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  genehelp_user_id text,
  genehelp_email text not null,
  genehelp_name text not null,
  encrypted_integration_token text not null,
  token_last4 text not null default '',
  created_in_genehelp boolean not null default false,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_genehelp_accounts enable row level security;

revoke all on public.user_genehelp_accounts from anon, authenticated;
grant select, insert, update, delete on public.user_genehelp_accounts to service_role;

drop trigger if exists user_genehelp_accounts_set_updated_at on public.user_genehelp_accounts;
create trigger user_genehelp_accounts_set_updated_at
before update on public.user_genehelp_accounts
for each row execute function public.set_updated_at();

commit;
