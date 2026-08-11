begin;

-- Private per-user tree appearance. This intentionally does not live in
-- family_trees.settings: collaborators may view the same tree with different
-- surname rules and colours, while one user's choices follow them to every
-- authenticated device.
create table if not exists public.family_tree_user_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  appearance jsonb not null default '{}'::jsonb
    check (jsonb_typeof(appearance) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, tree_id),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade
);

create index if not exists family_tree_user_preferences_project_idx
  on public.family_tree_user_preferences (project_id, tree_id);

drop trigger if exists family_tree_user_preferences_set_updated_at
  on public.family_tree_user_preferences;
create trigger family_tree_user_preferences_set_updated_at
before update on public.family_tree_user_preferences
for each row execute function public.set_updated_at();

alter table public.family_tree_user_preferences enable row level security;

drop policy if exists family_tree_user_preferences_select_own
  on public.family_tree_user_preferences;
create policy family_tree_user_preferences_select_own
on public.family_tree_user_preferences for select to authenticated
using (
  user_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

drop policy if exists family_tree_user_preferences_insert_own
  on public.family_tree_user_preferences;
create policy family_tree_user_preferences_insert_own
on public.family_tree_user_preferences for insert to authenticated
with check (
  user_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

drop policy if exists family_tree_user_preferences_update_own
  on public.family_tree_user_preferences;
create policy family_tree_user_preferences_update_own
on public.family_tree_user_preferences for update to authenticated
using (
  user_id = (select auth.uid())
  and (select public.is_project_member(project_id))
)
with check (
  user_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

drop policy if exists family_tree_user_preferences_delete_own
  on public.family_tree_user_preferences;
create policy family_tree_user_preferences_delete_own
on public.family_tree_user_preferences for delete to authenticated
using (
  user_id = (select auth.uid())
  and (select public.is_project_member(project_id))
);

revoke all on public.family_tree_user_preferences from public, anon;
grant select, insert, update, delete
  on public.family_tree_user_preferences to authenticated;

commit;
