import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonSocialCircleV1.tsx", import.meta.url),
  "utf8",
);

test("person social circle groups repeated evidence into one visible connection per person", () => {
  assert.match(component, /const rawEdges:\s*ContextRelationshipGraphEdge\[\]\s*=\s*graphSnapshot\.edges\.map/u);
  assert.match(
    component,
    /groupContextRelationshipGraphEdgesByPair\(\s*rawEdges,\s*`person:\$\{center\.id\}`/u,
  );
  assert.match(component, /const roleCount = edges\.reduce/u);
  assert.match(component, /relationshipGraph\.edges\.length/u);
  assert.match(component, /relationshipGraph\.roleCount/u);
});

test("simple social graph keeps relationship labels inside person cards", () => {
  assert.match(component, /centerConnectionLabels="node"/u);
});
