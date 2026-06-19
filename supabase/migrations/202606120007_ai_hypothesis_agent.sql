begin;

create table if not exists public.user_ai_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  provider text not null default 'google_gemini'
    check (provider = 'google_gemini'),
  encrypted_api_key text not null,
  api_key_last4 text not null default '',
  model text not null default 'gemini-3.5-flash',
  mode text not null default 'fast'
    check (mode in ('fast', 'detailed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_hypothesis_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  hypothesis_id uuid not null references public.hypotheses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'google_gemini',
  model text not null default '',
  mode text not null default 'fast',
  input_summary jsonb not null default '{}'::jsonb,
  result_json jsonb not null default '{}'::jsonb,
  result_text text not null default '',
  created_at timestamptz not null default now(),
  constraint ai_review_workspace_project_match check (workspace_id = project_id)
);

create index if not exists ai_hypothesis_reviews_project_idx
  on public.ai_hypothesis_reviews (project_id, hypothesis_id, created_at desc);
create index if not exists ai_hypothesis_reviews_user_idx
  on public.ai_hypothesis_reviews (user_id, created_at desc);

alter table public.user_ai_settings enable row level security;
alter table public.ai_hypothesis_reviews enable row level security;

drop policy if exists user_ai_settings_select_own on public.user_ai_settings;
create policy user_ai_settings_select_own
on public.user_ai_settings for select to authenticated
using (user_id = auth.uid());

drop policy if exists user_ai_settings_insert_own on public.user_ai_settings;
create policy user_ai_settings_insert_own
on public.user_ai_settings for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists user_ai_settings_update_own on public.user_ai_settings;
create policy user_ai_settings_update_own
on public.user_ai_settings for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists user_ai_settings_delete_own on public.user_ai_settings;
create policy user_ai_settings_delete_own
on public.user_ai_settings for delete to authenticated
using (user_id = auth.uid());

drop policy if exists ai_hypothesis_reviews_select_members on public.ai_hypothesis_reviews;
create policy ai_hypothesis_reviews_select_members
on public.ai_hypothesis_reviews for select to authenticated
using (public.is_project_member(project_id));

drop policy if exists ai_hypothesis_reviews_insert_members on public.ai_hypothesis_reviews;
create policy ai_hypothesis_reviews_insert_members
on public.ai_hypothesis_reviews for insert to authenticated
with check (
  user_id = auth.uid()
  and workspace_id = project_id
  and public.is_project_member(project_id)
);

drop policy if exists ai_hypothesis_reviews_delete_own on public.ai_hypothesis_reviews;
create policy ai_hypothesis_reviews_delete_own
on public.ai_hypothesis_reviews for delete to authenticated
using (
  user_id = auth.uid()
  and public.is_project_member(project_id)
);

drop trigger if exists user_ai_settings_set_updated_at on public.user_ai_settings;
create trigger user_ai_settings_set_updated_at
before update on public.user_ai_settings
for each row execute function public.set_updated_at();

commit;
