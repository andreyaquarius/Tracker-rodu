import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonSocialCircleV1.tsx", import.meta.url),
  "utf8",
);

test("social-circle editor preserves provenance fields and blocks generated assertions", () => {
  assert.match(component, /sourceRoleLabel:\s*relation\.sourceRoleLabel/u);
  assert.match(component, /targetRoleLabel:\s*relation\.targetRoleLabel/u);
  assert.match(component, /metadata:\s*relation\.metadata/u);
  assert.match(component, /sourceRoleLabel:\s*useTypeRoles[\s\S]*?selectedType\?\.sourceRoleUk/u);
  assert.match(component, /targetRoleLabel:\s*useTypeRoles[\s\S]*?selectedType\?\.targetRoleUk/u);
  assert.match(component, /endpointsReversed\s*\?\s*editor\.targetRoleLabel\s*:\s*editor\.sourceRoleLabel/u);
  assert.match(component, /endpointsReversed\s*\?\s*editor\.sourceRoleLabel\s*:\s*editor\.targetRoleLabel/u);
  assert.match(component, /isClientWritableAssertion\(relation\.assertionKind\)/u);
  assert.match(component, /kind === "manual" \|\| kind === "research_hypothesis"/u);
  assert.match(
    component,
    /disabled=\{saving \|\| !isClientWritableAssertion\(relation\.assertionKind\)\}/u,
  );
  assert.match(component, /зміна й архівування лише через знахідку або інше джерело/u);
  assert.match(
    component,
    /if \(!isClientWritableAssertion\(relation\.assertionKind\)\)[\s\S]*?архівується через знахідку чи інше джерело/u,
  );
});

test("social-circle editor requires exact godparent and wedding-side roles", () => {
  assert.match(component, /isLegacyAmbiguousSocialRelationTypeCode\(type\.code\)/u);
  assert.match(component, /Хрещений батько/u);
  assert.match(component, /Хрещена мати/u);
  assert.match(component, /Свідок по нареченій/u);
  assert.match(component, /Свідок по нареченому/u);
  assert.match(component, /Хто виконує роль щодо іншої особи\?/u);
  assert.match(component, /Перша особа виконує зазначену роль щодо другої конкретної особи/u);
});

test("social-circle cards describe the related person's role relative to center", () => {
  assert.match(component, /const relatedIsSource = relation\.sourcePersonId !== centerId/u);
  assert.match(component, /const relatedIsSource = edge\.sourcePersonId !== centerId/u);
  assert.match(component, /relatedPersonSocialRoleLabel\(\{/u);
});

test("social-circle mutations ignore stale completion after the focused person changes", () => {
  assert.match(component, /const activeContextKey = useRef\(contextKey\)/u);
  assert.match(component, /const mutationSequence = useRef\(0\)/u);
  assert.match(component, /activeContextKey\.current === operationContextKey/u);
  assert.match(component, /mutationSequence\.current === operationId/u);
  assert.match(component, /if \(!operationIsCurrent\(\)\) return/u);
});

test("social-circle editor uses complete dates and avoids creator-only privacy promises", () => {
  assert.match(component, /<input\s+type="date"\s+value=\{value\.validFrom\}/u);
  assert.match(component, /<input\s+type="date"\s+value=\{value\.validTo\}/u);
  assert.doesNotMatch(component, /РРРР-ММ-ДД або РРРР/u);
  assert.doesNotMatch(component, /Лише я/u);
});

test("social-circle graph never opens masked people", () => {
  assert.match(component, /activatable:\s*!node\.masked/u);
  assert.match(component, /if \(node\.activatable === false\) return/u);
});
