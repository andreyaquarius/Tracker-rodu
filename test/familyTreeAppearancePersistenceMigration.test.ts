import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608110001_family_tree_user_preferences.sql",
    import.meta.url,
  ),
  "utf8",
);

test("tree appearance is private per user and bound to a real project tree", () => {
  assert.match(
    migration,
    /create table if not exists public\.family_tree_user_preferences/i,
  );
  assert.match(migration, /primary key \(user_id, tree_id\)/i);
  assert.match(
    migration,
    /foreign key \(tree_id, project_id\)[\s\S]*?references public\.family_trees\(id, project_id\) on delete cascade/i,
  );
  assert.match(
    migration,
    /appearance jsonb not null default '\{\}'::jsonb[\s\S]*?jsonb_typeof\(appearance\) = 'object'/i,
  );
  assert.doesNotMatch(migration, /family_trees[\s\S]{0,80}set settings/i);
});

test("tree appearance RLS lets every project member manage only their own row", () => {
  assert.match(
    migration,
    /alter table public\.family_tree_user_preferences enable row level security/i,
  );
  for (const operation of ["select", "insert", "update", "delete"]) {
    assert.match(
      migration,
      new RegExp(
        `family_tree_user_preferences_${operation}_own[\\s\\S]*?user_id = \\(select auth\\.uid\\(\\)\\)[\\s\\S]*?public\\.is_project_member\\(project_id\\)`,
        "i",
      ),
    );
  }
  assert.match(
    migration,
    /revoke all on public\.family_tree_user_preferences from public, anon/i,
  );
  assert.match(
    migration,
    /grant select, insert, update, delete[\s\S]*?to authenticated/i,
  );
});

test("tree appearance timestamps are maintained server-side", () => {
  assert.match(
    migration,
    /family_tree_user_preferences_set_updated_at[\s\S]*?public\.set_updated_at\(\)/i,
  );
});
