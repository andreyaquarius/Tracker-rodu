import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { familyTreeNeighborhoodRpcCandidates } from "../src/utils/familyTreeNeighborhoodRpc.ts";

const service = readFileSync(
  new URL("../src/services/familyTreeNeighborhoodService.ts", import.meta.url),
  "utf8",
);
const hook = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/useFamilyTreeNeighborhood.ts",
    import.meta.url,
  ),
  "utf8",
);

test("production neighborhood transport prefers v2 and falls back for a missing or timed-out RPC", () => {
  assert.deepEqual(familyTreeNeighborhoodRpcCandidates({}), [
    "get_family_tree_neighborhood_v2",
    "get_family_tree_neighborhood_v1",
  ]);
  assert.deepEqual(familyTreeNeighborhoodRpcCandidates({ structuralOnly: true }), [
    "get_family_tree_root_lineage_v1",
    "get_family_tree_neighborhood_v1",
  ]);
  assert.match(service, /!isMissingRpcFunction\(payload\) && !isDatabaseStatementTimeout\(payload\)/);
  assert.match(service, /code === "PGRST202" \|\| code === "42883"/);
  assert.match(service, /isDatabaseStatementTimeout/);
});

test("family expansion uses the dedicated scoped RPC and forwards cache guards", () => {
  assert.match(service, /get_family_tree_family_children_v1/);
  assert.match(service, /scope: request\.scope/);
  assert.match(service, /knownGraphVersion: request\.knownGraphVersion/);
  assert.match(service, /permissionFingerprint: request\.permissionFingerprint/);
});

test("hook exposes reversible family-scope expansion independent from person branches", () => {
  assert.match(hook, /expandFamilyContinuation/);
  assert.match(hook, /familyTreeFamilyBranchKey\(continuation\.scope\.id\)/);
  assert.match(hook, /collapseFamilyScope/);
  assert.match(hook, /toggleFamilyScope/);
  assert.match(hook, /activeFamilyScopeIds/);
  assert.match(hook, /collapsedFamilyScopeIds/);
});

test("hook primes the focus family and optional cousin descendants only after the base response", () => {
  assert.match(hook, /defaultVisibleFamilyPersonId\?: PersonId/);
  assert.match(hook, /includeCousinDescendantsByDefault\?: boolean/);
  assert.match(hook, /expandPersonContinuation/);
  assert.match(hook, /setBaseLoadRevision\(value => value \+ 1\)/);
  assert.match(hook, /nextDefaultBranchExpansion\(\{/);
  assert.match(hook, /focusPersonId: defaultVisibleFamilyPersonId/);
  assert.match(hook, /includeCousinDescendants:\s*includeCousinDescendantsByDefault/);
  assert.match(hook, /await expandPersonContinuation\(next\.continuation\)/);
  assert.match(hook, /await expandFamilyContinuation\(next\.continuation\)/);
});

test("hook exposes cancellation and aborts every request without clearing the loaded graph", () => {
  assert.match(hook, /canceled: boolean/);
  assert.match(hook, /cancel: \(\) => void/);
  assert.match(
    hook,
    /const baseControllerRef = useRef<AbortController \| undefined>\(undefined\)/,
  );

  const start = hook.indexOf("const cancel = useCallback");
  const end = hook.indexOf("const commit = useCallback", start);
  assert.ok(start >= 0 && end > start, "cancel callback must exist before commit");
  const cancel = hook.slice(start, end);

  const invalidate = cancel.indexOf("requestEpochRef.current += 1");
  const abortBase = cancel.indexOf("baseController?.abort()");
  const abortBranches = cancel.indexOf("abortBranches()");
  assert.ok(invalidate >= 0, "cancel must invalidate the active epoch");
  assert.ok(abortBase > invalidate, "base abort must follow epoch invalidation");
  assert.ok(abortBranches > abortBase, "branch aborts must follow the base abort");
  assert.match(cancel, /baseLoadingRef\.current = false/);
  assert.match(cancel, /setLoading\(false\)/);
  assert.match(cancel, /setError\(undefined\)/);
  assert.match(cancel, /setCanceled\(true\)/);
  assert.doesNotMatch(cancel, /setGraph\(|commit\(|baseGraphRef\.current\s*=/);

  assert.match(hook, /controller\.signal\.aborted \|\|[\s\S]*?epoch !== requestEpochRef\.current/);
  assert.match(hook, /canceled,[\s\S]*?cancel,[\s\S]*?expandContinuation/);
});

test("new base loads, reloads and branch expansions clear the canceled state", () => {
  const baseLoadStart = hook.indexOf("if (!enabled) return;");
  const baseLoadEnd = hook.indexOf("void client", baseLoadStart);
  assert.ok(baseLoadStart >= 0 && baseLoadEnd > baseLoadStart);
  assert.match(hook.slice(baseLoadStart, baseLoadEnd), /setCanceled\(false\)/);

  const personBranchStart = hook.indexOf("const expandPersonContinuation");
  const familyBranchStart = hook.indexOf("const expandFamilyContinuation");
  const togglesStart = hook.indexOf("const togglePersonBranches");
  assert.ok(
    personBranchStart >= 0 &&
      familyBranchStart > personBranchStart &&
      togglesStart > familyBranchStart,
  );
  assert.match(
    hook.slice(personBranchStart, familyBranchStart),
    /setCanceled\(false\)[\s\S]*?new AbortController\(\)/,
  );
  assert.match(
    hook.slice(familyBranchStart, togglesStart),
    /setCanceled\(false\)[\s\S]*?new AbortController\(\)/,
  );

  const reloadStart = hook.indexOf("const reload = useCallback");
  const reloadEnd = hook.indexOf("const scopeIsCurrent", reloadStart);
  assert.ok(reloadStart >= 0 && reloadEnd > reloadStart);
  assert.match(hook.slice(reloadStart, reloadEnd), /setCanceled\(false\)/);
  assert.match(hook.slice(reloadStart, reloadEnd), /setReloadKey\(/);
});
