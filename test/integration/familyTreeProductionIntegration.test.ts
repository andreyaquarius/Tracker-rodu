import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mergeNeighborhood } from "../../src/features/family-tree-view/data/neighborhoodClient.ts";
import { moveFamilyTreeFocus, pushFamilyTreeFocus } from "../../src/utils/familyTreeFocusHistory.ts";

test("visual focus history never rewrites the home person and truncates forward history", () => {
  const homePersonId = "home";
  let state = { history: [homePersonId], index: 0 };
  state = pushFamilyTreeFocus(state.history, state.index, "father");
  state = pushFamilyTreeFocus(state.history, state.index, "grandmother");
  assert.deepEqual(state, { history: ["home", "father", "grandmother"], index: 2 });

  state = moveFamilyTreeFocus(state.history, state.index, -1);
  assert.equal(state.history[state.index], "father");
  state = pushFamilyTreeFocus(state.history, state.index, "uncle");
  assert.deepEqual(state, { history: ["home", "father", "uncle"], index: 2 });
  assert.equal(state.history[0], homePersonId);
});

test("repeated branch responses merge idempotently without duplicating canonical people", () => {
  const previous = {
    persons: [{ id: "focus", displayName: "Focus" }],
    unions: [],
    parentChildRelations: [],
    continuations: [{ id: "next", personId: "focus", direction: "children" as const, token: "cursor-1" }],
    graphVersion: "7",
    permissionFingerprint: "viewer:masked",
  };
  const page = {
    persons: [
      { id: "focus", displayName: "Focus" },
      { id: "child", displayName: "Child" },
    ],
    unions: [{ id: "parent-set:1", kind: "parent-set" as const, memberIds: ["focus"] }],
    parentChildRelations: [{ id: "r1", parentId: "focus", childId: "child", unionId: "parent-set:1", kind: "biological" as const }],
    continuations: [],
    graphVersion: "7",
    permissionFingerprint: "viewer:masked",
  };
  const once = mergeNeighborhood(previous, page, ["cursor-1"]);
  const twice = mergeNeighborhood(once, page, ["cursor-1"]);
  assert.deepEqual(twice, once);
  assert.equal(twice.persons.length, 2);
});

test("migration contract authorizes first, locks a stable version, masks viewers, and bounds work", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/202607100001_family_tree_neighborhood.sql", import.meta.url),
    "utf8",
  );
  const rpcStart = sql.indexOf("create or replace function public.get_family_tree_neighborhood_v1");
  const rpcEnd = sql.indexOf("create or replace function public.can_read_exact_family_tree_person", rpcStart);
  const rpc = sql.slice(rpcStart, rpcEnd);

  assert.ok(rpcStart >= 0 && rpcEnd > rpcStart);
  assert.ok(rpc.indexOf("auth.uid() is null") < rpc.indexOf("create temporary table"));
  assert.match(rpc, /for share;/i);
  assert.match(rpc, /requested_max_nodes := greatest\(1, least\([^;]+, 600\)\)/s);
  assert.match(rpc, /permission_fingerprint/);
  assert.match(rpc, /Приватна особа/);
  assert.doesNotMatch(rpc, /custom_fields/i);
  assert.doesNotMatch(rpc, /'notes'/i);
  assert.match(sql, /create policy persons_select[\s\S]+can_read_exact_family_tree_person/);
  assert.match(sql, /create policy parent_sets_select_members[\s\S]+can_read_exact_parent_set/);
  assert.match(sql, /before insert or update of[\s\S]+parent_set_id[\s\S]+execute function public\.prevent_bloodline_parent_cycle/);
});

test("production renderer requires an explicit production flag but is always enabled locally", () => {
  const page = readFileSync(new URL("../../src/pages/FamilyTreePage.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(page, /useProductionRenderer = false/);
  assert.match(page, /return <ProductionFamilyTreePage/);
  assert.match(page, /return <LegacyFamilyTreePage/);
  assert.match(
    app,
    /shouldUseProductionFamilyTreeRenderer\(\s*featureFlags,\s*import\.meta\.env\.DEV,\s*\)/,
  );
  assert.doesNotMatch(app, /featureFlags\.family_tree_renderer_v2 !== false/);
});

test("family tree routes person opens to V2 profiles while preserving legacy windows", () => {
  const page = readFileSync(
    new URL("../../src/pages/FamilyTreePage.tsx", import.meta.url),
    "utf8",
  );
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const windows = readFileSync(
    new URL("../../src/hooks/useFamilyTreeRecordWindows.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /ProductionFamilyTreePageWithWindows/);
  assert.match(page, /allowNavigationFallback: false/);
  assert.match(
    page,
    /props\.personProfileNavigationEnabled && props\.onOpenPerson[\s\S]*?\? props\.onOpenPerson[\s\S]*?: openPersonCardWindow/,
  );
  assert.match(
    page,
    /if \(personProfileNavigationEnabled && onOpenPerson\) \{[\s\S]*?onOpenPerson\(personId\);[\s\S]*?return;/,
  );
  assert.match(
    app,
    /onOpenPerson=\{\(personId\) => openRelatedRecord\("persons", personId\)\}[\s\S]*?personProfileNavigationEnabled=\{personsModuleV2Enabled\}/,
  );
  assert.match(windows, /<PersonCardModal/);
  assert.match(windows, /onOpenRelated=\{openRelatedRecordWindow\}/);
  assert.match(windows, /onCreateRelated=\{openRelatedCreateWindow\}/);
});
