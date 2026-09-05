import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202609050001_family_tree_view_preferences.sql",
    import.meta.url,
  ),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/familyTreeViewPreferences.ts", import.meta.url),
  "utf8",
);
const hook = readFileSync(
  new URL("../src/hooks/useFamilyTreeViewPreferences.ts", import.meta.url),
  "utf8",
);
const databaseTest = readFileSync(
  new URL(
    "../supabase/tests/family_tree_view_preferences_test.sql",
    import.meta.url,
  ),
  "utf8",
);

test("view settings use an isolated private row with tree-scoped RLS", () => {
  assert.match(
    migration,
    /create table if not exists public\.family_tree_view_preferences[\s\S]*?user_id uuid not null[\s\S]*?tree_id uuid not null[\s\S]*?view_settings jsonb not null default '\{\}'::jsonb/i,
  );
  assert.match(
    migration,
    /jsonb_typeof\(view_settings\) = 'object'/i,
  );
  assert.match(
    migration,
    /user_id = \(select auth\.uid\(\)\)[\s\S]*?public\.is_project_member\(tree_scope\.project_id\)/i,
  );
  assert.match(migration, /references public\.family_trees\(id\) on delete cascade/i);
  assert.doesNotMatch(migration, /family_tree_user_preferences\b/i);
  assert.doesNotMatch(
    migration,
    /(?:alter|update)\s+table?\s*public\.family_trees[\s\S]{0,80}\bsettings\b/i,
  );
});

test("service reads and writes only view_settings without replacing appearance", () => {
  assert.match(service, /\.select\("view_settings, updated_at"\)/);
  assert.match(service, /\.from\("family_tree_view_preferences"\)/);
  assert.match(service, /view_settings: normalized/);
  assert.match(service, /onConflict: "user_id,tree_id"/);
  assert.doesNotMatch(service, /appearance\s*:/);
  assert.doesNotMatch(service, /project_id\s*:/);
  assert.match(service, /userId !== expectedUserId/);
});

test("hook scopes cache after auth, serializes saves and replays dirty state", () => {
  assert.match(
    hook,
    /getAuthenticatedFamilyTreeViewPreferenceUserId\(\)[\s\S]*?\.then\(async \(userId\)[\s\S]*?readFamilyTreeViewPreferenceCache\(\s*userId,/,
  );
  assert.match(hook, /sharedSaveChainsByScope\.get\(scopeKey\)/);
  assert.match(hook, /sharedSaveChainsByScope\.set\(scopeKey, settledOperation\)/);
  assert.match(hook, /latestSharedSaveByScope/);
  assert.match(hook, /acknowledgesCurrentDirtyValue/);
  assert.match(hook, /canApplyAcknowledgement = !currentCache\.found \|\| cacheMatchesSavedValue/);
  assert.match(
    hook,
    /currentCache\.found &&[\s\S]*?!cacheMatchesSavedValue[\s\S]*?currentCache\.preferences,[\s\S]*?true,[\s\S]*?setSyncState\("error"\)/,
  );
  assert.match(hook, /if \(cached\.dirty\)[\s\S]*?queueRemoteSave/);
  assert.match(
    hook,
    /if \(cached\.dirty\)[\s\S]*?setReady\(true\)[\s\S]*?return;[\s\S]*?loadFamilyTreeViewPreference/,
  );
  assert.match(hook, /editSequenceRef\.current !== editSequenceBeforeLoad/);
  assert.match(
    hook,
    /writeFamilyTreeViewPreferenceCache\([\s\S]*?next,[\s\S]*?true,[\s\S]*?\);[\s\S]*?queueRemoteSave/,
  );
  assert.match(
    hook,
    /stored\.preferences,[\s\S]*?false,[\s\S]*?\);/,
  );
});

test("database contract proves independent users and outsider denial", () => {
  assert.match(databaseTest, /select plan\(21\)/i);
  assert.match(
    databaseTest,
    /tree-view-owner@example\.test[\s\S]*?tree-view-member@example\.test[\s\S]*?tree-view-outsider@example\.test/i,
  );
  assert.match(
    databaseTest,
    /members of one shared tree retain different view settings/i,
  );
  assert.match(
    databaseTest,
    /the owner cannot query the second member view row/i,
  );
  assert.match(
    databaseTest,
    /throws_ok\([\s\S]*?'42501'[\s\S]*?an outsider cannot write view preferences/i,
  );
  assert.match(
    databaseTest,
    /updating the dedicated view row does not change appearance[\s\S]*?updating appearance does not change the dedicated view row/i,
  );
});
