import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mergeNeighborhood, type NeighborhoodResponse } from "../../src/features/family-tree-view/data/neighborhoodClient.ts";
import { layoutFamilyGraph } from "../../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import type { FamilyGraphData, ParentChildRelation, TreePerson } from "../../src/features/family-tree-view/types.ts";
import { moveFamilyTreeFocus, pushFamilyTreeFocus } from "../../src/utils/familyTreeFocusHistory.ts";

function person(id: string): TreePerson {
  return { id, displayName: `Особа ${id}` };
}

function noOverlaps(graph: FamilyGraphData, focusPersonId: string): boolean {
  const layout = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId,
      ancestorDepth: 7,
      descendantDepth: 3,
      collateralDepth: 1,
      maxVisibleNodes: 400,
    },
  });
  return layout.nodes.every((left, index) => layout.nodes.slice(index + 1).every((right) => !(
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  )));
}

test("initial neighborhood -> branch expansion -> reroot/back is stable and idempotent", () => {
  const children = Array.from({ length: 14 }, (_, index) => `child-${index + 1}`);
  const relations: ParentChildRelation[] = children.flatMap((childId) => [
    { id: `father-${childId}`, parentId: "father", childId, unionId: "partnership:parents", kind: "biological", role: "father" },
    { id: `mother-${childId}`, parentId: "mother", childId, unionId: "partnership:parents", kind: "biological", role: "mother" },
  ]);
  const initial: NeighborhoodResponse = {
    persons: [person("father"), person("mother"), ...children.map(person)],
    unions: [{ id: "partnership:parents", kind: "partnership", memberIds: ["father", "mother"] }],
    parentChildRelations: relations,
    continuations: [{ id: "more", personId: "child-1", direction: "children", token: "cursor-more", hiddenCount: 1 }],
    graphVersion: "12",
    permissionFingerprint: "project-editor:private-visible:v1",
  };
  assert.equal(noOverlaps(initial, "father"), true);

  const expanded: NeighborhoodResponse = {
    persons: [person("child-1"), person("grandchild")],
    unions: [{ id: "parent-set:grandchild", kind: "parent-set", memberIds: ["child-1"] }],
    parentChildRelations: [{ id: "next", parentId: "child-1", childId: "grandchild", unionId: "parent-set:grandchild", kind: "biological" }],
    continuations: [],
    graphVersion: "12",
    permissionFingerprint: "project-editor:private-visible:v1",
  };
  const once = mergeNeighborhood(initial, expanded, ["cursor-more"]);
  const twice = mergeNeighborhood(once, expanded, ["cursor-more"]);
  assert.deepEqual(twice, once);
  assert.equal(noOverlaps(once, "father"), true);

  let focus = { history: ["father"], index: 0 };
  focus = pushFamilyTreeFocus(focus.history, focus.index, "grandchild");
  assert.equal(focus.history[focus.index], "grandchild");
  assert.equal(layoutFamilyGraph({ graph: once, options: { focusPersonId: "grandchild", ancestorDepth: 7 } }).focusOccurrenceId !== undefined, true);
  focus = moveFamilyTreeFocus(focus.history, focus.index, -1);
  assert.equal(focus.history[focus.index], "father");
});

test("renderer source preserves Canvas, semantic-list, reduced-motion, and DOM budget contracts", () => {
  const viewport = readFileSync(new URL("../../src/features/family-tree-view/react/FamilyTreeViewport.tsx", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("../../src/features/family-tree-view/react/TreeEdgeCanvas.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../../src/features/family-tree-view/layout/layoutEngine.ts", import.meta.url), "utf8");
  const directGrid = readFileSync(new URL("../../src/features/family-tree-view/layout/directAncestorLayout.ts", import.meta.url), "utf8");
  const personCard = readFileSync(new URL("../../src/features/family-tree-view/react/PersonCard.tsx", import.meta.url), "utf8");
  const semanticList = readFileSync(new URL("../../src/features/family-tree-view/react/FamilyTreeSemanticList.tsx", import.meta.url), "utf8");
  const renderLimits = readFileSync(new URL("../../src/features/family-tree-view/react/renderLimits.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../src/features/family-tree-view/react/familyTree.css", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../src/pages/ProductionFamilyTreePage.tsx", import.meta.url), "utf8");
  assert.match(viewport, /TreeEdgeCanvas/);
  assert.match(viewport, /FamilyTreeSemanticList/);
  assert.match(viewport, /normalizeRenderedNodeLimit/);
  assert.match(renderLimits, /MAX_RENDERED_FAMILY_TREE_NODES\s*=\s*600/);
  assert.match(canvas, /<canvas/);
  assert.match(
    canvas,
    /case "union-stem":\s*case "siblings-bus":\s*return \{ color: palette\.structure, width: 2\.05, minimumWidth: 1\.35, dash: \[\] \};/,
  );
  assert.match(canvas, /case "continuation":[\s\S]*color: palette\.continuation,[\s\S]*minimumWidth: 0\.75,/);
  assert.match(canvas, /edgePaintOrder\(left\.kind\) - edgePaintOrder\(right\.kind\)/);
  assert.match(canvas, /style\.minimumWidth/);
  assert.match(canvas, /edge\.points\.forEach/);
  assert.match(canvas, /renderedJunctions\.has\(junctionKey\)/);
  assert.match(layout, /applyDirectAncestorGrid/);
  assert.match(layout, /positionAuxiliaryNodes/);
  assert.match(layout, /const busCenters = \[unionX, \.\.\.childCenters\]/);
  assert.match(directGrid, /paternal\.right \+ halfGap/);
  assert.match(directGrid, /halfGap - maternal\.left/);
  assert.match(css, /--ft-edge-structure:/);
  assert.match(css, /--ft-edge-partnership:/);
  assert.match(css, /--ft-edge-continuation:/);
  assert.match(css, /--ft-edge-continuation-node:/);
  assert.match(semanticList, /<ul>/);
  assert.match(semanticList, /<button/);
  assert.match(personCard, /aria-expanded=\{presentation\.expanded\}/);
  assert.match(personCard, /Згорнути відкриті гілки/);
  assert.match(semanticList, /onTogglePersonBranches/);
  assert.match(semanticList, /Розгорнути гілки/);
  assert.match(viewport, /collapsedBranchPersonIds/);
  assert.match(viewport, /onTogglePersonBranches/);
  assert.match(page, /neighborhood\.branchTogglePersonIds/);
  assert.match(page, /onTogglePersonBranches=\{togglePersonBranches\}/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("production tree viewport fills its host without reserving empty optional rows", () => {
  const page = readFileSync(new URL("../../src/pages/ProductionFamilyTreePage.tsx", import.meta.url), "utf8");
  const appCss = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
  const camera = readFileSync(new URL("../../src/features/family-tree-view/react/useTreeCamera.ts", import.meta.url), "utf8");

  assert.match(page, /className="family-tree-v2-viewport"/);
  assert.match(
    appCss,
    /\.family-tree-v2-shell\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;[^}]*height:\s*auto;/s,
  );
  assert.doesNotMatch(
    appCss,
    /\.family-tree-v2-shell\s*\{[^}]*grid-template-rows:[^}]*560px/s,
  );
  assert.match(
    appCss,
    /\.family-tree-v2-shell\s*>\s*\.family-tree-v2-viewport\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;[^}]*height:\s*auto;/s,
  );
  assert.match(
    appCss,
    /\.family-tree-v2-shell:fullscreen\s*\{[^}]*height:\s*100vh;[^}]*min-height:\s*0;/s,
  );
  assert.match(
    appCss,
    /@media\s*\(max-width:\s*850px\)[\s\S]*?\.family-tree-v2-shell\s*\{[^}]*min-height:\s*620px;[^}]*height:\s*calc\(100dvh - 118px\);/,
  );
  assert.match(camera, /new ResizeObserver/);
  assert.match(camera, /observer\.observe\(element\)/);
});

test("production tree defaults to ancestors while descendants and cousins remain explicit opt-ins", () => {
  const page = readFileSync(
    new URL("../../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );
  const neighborhoodHook = readFileSync(
    new URL(
      "../../src/features/family-tree-view/react/useFamilyTreeNeighborhood.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(page, /const \[ancestorDepth, setAncestorDepth\] = useState\(7\);/);
  assert.match(page, /const \[descendantDepth, setDescendantDepth\] = useState\(0\);/);
  assert.match(page, /const \[collateralDepth, setCollateralDepth\] = useState\(0\);/);
  assert.match(
    page,
    /value=\{descendantDepth\}[\s\S]*?setDescendantDepth\(nonNegativeInteger\(event\.target\.value, 0\)\)/,
  );
  assert.match(
    page,
    /checked=\{collateralDepth > 0\}[\s\S]*?setCollateralDepth\(event\.target\.checked \? 1 : 0\)/,
  );

  // The RPC owns the loaded scope. The production layout renders every entity
  // already returned by the initial request or a per-person branch request.
  assert.match(
    page,
    /ancestorDepth:\s*MAX_RENDERED_FAMILY_TREE_NODES,[\s\S]*?descendantDepth:\s*MAX_RENDERED_FAMILY_TREE_NODES,[\s\S]*?collateralDepth:\s*MAX_RENDERED_FAMILY_TREE_NODES/,
  );

  // A server cursor loads only the direction attached to that card. Its page
  // is restricted to the remaining render capacity, while local layout-only
  // markers never trigger a global base reload that would drop merged branches.
  assert.match(neighborhoodHook, /const branchMaxNodes = boundedBranchNodeLimit\(/);
  assert.match(neighborhoodHook, /maxNodes: branchMaxNodes/);
  assert.doesNotMatch(page, /setMaxNodes/);
  assert.match(page, /token\.endsWith\(":other-parent-sets"\)/);
  assert.match(page, /await neighborhood\.expandContinuation\(token, node\);/);
});
