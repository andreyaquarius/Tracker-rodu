begin;

create table if not exists public.user_genehelp_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  genehelp_request_id text not null,
  title text,
  description text not null default '',
  status jsonb not null default '{}'::jsonb,
  links jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  response jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_genehelp_requests_user_request_unique
    unique (user_id, genehelp_request_id)
);

alter table public.user_genehelp_requests enable row level security;

revoke all on public.user_genehelp_requests from anon, authenticated;
grant select, insert, update, delete on public.user_genehelp_requests to service_role;

create index if not exists user_genehelp_requests_user_created_idx
on public.user_genehelp_requests (user_id, created_at desc);

drop trigger if exists user_genehelp_requests_set_updated_at on public.user_genehelp_requests;
create trigger user_genehelp_requests_set_updated_at
before update on public.user_genehelp_requests
for each row execute function public.set_updated_at();

commit;
