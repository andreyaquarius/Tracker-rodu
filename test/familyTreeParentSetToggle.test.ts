import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { layoutDirectPedigree } from "../src/features/family-tree-view/layout/layoutDirectPedigree.ts";
import { familyTreeLayoutAnchorShift } from "../src/features/family-tree-view/react/useFamilyTreeLayout.ts";
import { shouldFallbackFamilyTreeNeighborhoodRpc } from "../src/utils/familyTreeNeighborhoodRpc.ts";
import type { FamilyGraphData, LayoutResult } from "../src/features/family-tree-view/types.ts";

const graph: FamilyGraphData = {
  persons: ["child", "father", "mother", "adoptive-father", "adoptive-mother", "grandfather"].map(id => ({ id, displayName: id })),
  unions: [
    { id: "bio", kind: "parent-set", memberIds: ["father", "mother"] },
    { id: "adoptive", kind: "parent-set", memberIds: ["adoptive-father", "adoptive-mother"] },
    { id: "grandparents", kind: "parent-set", memberIds: ["grandfather"] },
  ],
  parentChildRelations: [
    { id: "r1", parentId: "father", childId: "child", unionId: "bio", kind: "biological" },
    { id: "r2", parentId: "mother", childId: "child", unionId: "bio", kind: "biological" },
    { id: "r3", parentId: "adoptive-father", childId: "child", unionId: "adoptive", kind: "adoptive" },
    { id: "r4", parentId: "adoptive-mother", childId: "child", unionId: "adoptive", kind: "adoptive" },
    { id: "r5", parentId: "grandfather", childId: "adoptive-father", unionId: "grandparents", kind: "biological" },
  ],
};

for (const [mode, calculate] of [["classic", layoutFamilyGraph], ["direct", layoutDirectPedigree]] as const) {
  test(`${mode}: all parent sets overrides a saved selection and repeated toggles restore it`, () => {
    const original = structuredClone(graph);
    const activeParentSetByChild = { child: "adoptive" };
    let previous: LayoutResult | undefined;
    for (const showAllParentSets of [false, true, false, true, false]) {
      const layout = calculate({ graph, options: {
        focusPersonId: "child", ancestorDepth: 7, descendantDepth: 0, collateralDepth: 0,
        maxVisibleNodes: 600, showAllParentSets, activeParentSetByChild,
        ...(previous ? { previousPositions: previous.nodes.map(({ occurrenceId, x, y }) => ({ occurrenceId, x, y })) } : {}),
      } });
      const people = new Set(layout.nodes.map(node => node.personId).filter(Boolean));
      assert.deepEqual(people, new Set(showAllParentSets
        ? graph.persons.map(person => person.id)
        : ["child", "adoptive-father", "adoptive-mother", "grandfather"]));
      assert.ok(layout.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
      assert.ok(layout.nodes.some(node => node.occurrenceId === layout.focusOccurrenceId));
      previous = layout;
    }
    assert.deepEqual(activeParentSetByChild, { child: "adoptive" });
    assert.deepEqual(graph, original, "display changes must not mutate canonical data");
  });
}

test("parent-set reflow preserves the focus position; changing focus still recenters", () => {
  const before = layoutFamilyGraph({ graph, options: { focusPersonId: "child", ancestorDepth: 7 } });
  const after = { ...before, nodes: before.nodes.map(node => ({ ...node, x: node.x + 720, y: node.y - 360 })) };
  assert.deepEqual(familyTreeLayoutAnchorShift(before, after), { x: 720, y: -360 });
  assert.deepEqual(familyTreeLayoutAnchorShift(before, after, "removed-continuation"), { x: 720, y: -360 });
  assert.equal(familyTreeLayoutAnchorShift(undefined, after), undefined);
  const otherFocus = after.nodes.find(node => node.personId === "father")!;
  assert.equal(familyTreeLayoutAnchorShift(before, { ...after, focusOccurrenceId: otherFocus.occurrenceId }), undefined);
});

test("only absent RPCs fall back; timeouts, permissions and scope conflicts never repeat v1", () => {
  for (const code of ["PGRST202", "42883"]) assert.equal(shouldFallbackFamilyTreeNeighborhoodRpc({ code }), true);
  for (const code of ["57014", "42501", "40001", "40P01", "55P03", "P0001", ""]) {
    assert.equal(shouldFallbackFamilyTreeNeighborhoodRpc({ code, message: "canceling statement due to statement timeout" }), false);
  }
  for (const value of [null, undefined, [], "57014", { message: "statement timeout" }]) {
    assert.equal(shouldFallbackFamilyTreeNeighborhoodRpc(value), false);
  }
});

test("a base-load error keeps the tree toolbar available to recover display settings", () => {
  const page = readFileSync(new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /return <FamilyTreeErrorState message=\{neighborhood\.error\.message\}/);
  assert.match(page, /activeError && !graph\.persons\.length \? \(/);
  assert.match(page, /!viewPreferencesReady \|\| showAllParentSets/);
});

test("seven ancestor generations with alternative sets survive on/off/on in both layouts", () => {
  const persons = Array.from({ length: 255 }, (_, n) => ({ id: `p${n+1}`, displayName: `Person ${n+1}` }));
  const unions: FamilyGraphData["unions"][number][] = [];
  const relations: FamilyGraphData["parentChildRelations"][number][] = [];
  for (let child = 1; child <= 127; child++) {
    const unionId = `bio:p${child}`;
    unions.push({ id: unionId, kind: "parent-set", memberIds: [`p${child*2}`, `p${child*2+1}`] });
    for (const parent of [child*2, child*2+1]) {
      relations.push({ id: `r${parent}`, parentId: `p${parent}`, childId: `p${child}`, unionId, kind: "biological" });
    }
  }
  for (const child of [1,2,4,8,16,32,64]) {
    const unionId = `adoptive:p${child}`;
    const memberIds = [`a${child}`, `b${child}`];
    unions.push({ id: unionId, kind: "parent-set", memberIds });
    for (const parentId of memberIds) {
      persons.push({ id: parentId, displayName: parentId });
      relations.push({ id: `r${parentId}`, parentId, childId: `p${child}`, unionId, kind: "adoptive" });
    }
  }
  const pedigree: FamilyGraphData = { persons, unions, parentChildRelations: relations };
  for (const calculate of [layoutFamilyGraph, layoutDirectPedigree]) {
    for (const showAllParentSets of [false,true,false,true]) {
      const result = calculate({ graph: pedigree, options: {
        focusPersonId: "p1", ancestorDepth: 7, descendantDepth: 0, collateralDepth: 0,
        showAllParentSets, activeParentSetByChild: {p1:"bio:p1"}, maxVisibleNodes: 600,
      } });
      assert.equal(new Set(result.nodes.filter(node => node.kind === "person").map(node => node.personId)).size,
        showAllParentSets ? 269 : 255);
      assert.ok(result.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
    }
  }
});

test("SQL upgrade keeps continuation semantics and changes planning only inside the private implementation", () => {
  const sql = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const old = sql("202607100002_family_tree_neighborhood_performance");
  const fix = sql("202609070002_family_tree_neighborhood_timeout_fix");
  const helper = (source: string) => {
    const start = source.indexOf("create or replace function public.family_tree_populate_continuations_v2(");
    return source.slice(start, source.indexOf("$$;", source.indexOf("as $$", start)+5)+3);
  };
  assert.equal(helper(fix), helper(old)
    .replace("visible_members as materialized", "visible_members as not materialized")
    .replace("readable_parent_relations as materialized", "readable_parent_relations as not materialized")
    .replace("readable_partnerships as materialized", "readable_partnerships as not materialized"));
  const statements = fix.replace(/--[^\n]*/g, "");
  assert.match(statements, /alter function public\.get_family_tree_neighborhood_v1_feature_impl\(jsonb\)\s+set plan_cache_mode = 'force_generic_plan'/);
  assert.doesNotMatch(statements, /statement_timeout|alter role|alter system|disable row level security|grant execute/i);
});
