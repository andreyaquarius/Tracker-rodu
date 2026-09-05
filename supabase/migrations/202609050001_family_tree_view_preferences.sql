begin;

-- View depth and parent-set choices are deliberately isolated from the
-- existing appearance preference row. Both hooks may start at the same time;
-- separate rows prevent the first writer from creating a default value for
-- the other preference family.
create table if not exists public.family_tree_view_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  tree_id uuid not null references public.family_trees(id) on delete cascade,
  view_settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(view_settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, tree_id)
);

create index if not exists family_tree_view_preferences_tree_idx
  on public.family_tree_view_preferences (tree_id);

drop trigger if exists family_tree_view_preferences_set_updated_at
  on public.family_tree_view_preferences;
create trigger family_tree_view_preferences_set_updated_at
before update on public.family_tree_view_preferences
for each row execute function public.set_updated_at();

alter table public.family_tree_view_preferences enable row level security;

drop policy if exists family_tree_view_preferences_select_own
  on public.family_tree_view_preferences;
create policy family_tree_view_preferences_select_own
on public.family_tree_view_preferences for select to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.family_trees tree_scope
    where tree_scope.id = family_tree_view_preferences.tree_id
      and (select public.is_project_member(tree_scope.project_id))
  )
);

drop policy if exists family_tree_view_preferences_insert_own
  on public.family_tree_view_preferences;
create policy family_tree_view_preferences_insert_own
on public.family_tree_view_preferences for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.family_trees tree_scope
    where tree_scope.id = family_tree_view_preferences.tree_id
      and (select public.is_project_member(tree_scope.project_id))
  )
);

drop policy if exists family_tree_view_preferences_update_own
  on public.family_tree_view_preferences;
create policy family_tree_view_preferences_update_own
on public.family_tree_view_preferences for update to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.family_trees tree_scope
    where tree_scope.id = family_tree_view_preferences.tree_id
      and (select public.is_project_member(tree_scope.project_id))
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.family_trees tree_scope
    where tree_scope.id = family_tree_view_preferences.tree_id
      and (select public.is_project_member(tree_scope.project_id))
  )
);

drop policy if exists family_tree_view_preferences_delete_own
  on public.family_tree_view_preferences;
create policy family_tree_view_preferences_delete_own
on public.family_tree_view_preferences for delete to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.family_trees tree_scope
    where tree_scope.id = family_tree_view_preferences.tree_id
      and (select public.is_project_member(tree_scope.project_id))
  )
);

revoke all on public.family_tree_view_preferences from public, anon;
grant select, insert, update, delete
  on public.family_tree_view_preferences to authenticated;

commit;
