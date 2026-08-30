import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const moduleSource = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);

function sourceBetween(start: string, end: string): string {
  const startIndex = moduleSource.indexOf(start);
  const endIndex = moduleSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return moduleSource.slice(startIndex, endIndex);
}

test("context routes render through an isolated lightweight component", () => {
  const router = sourceBetween(
    "export function PersonsModuleV2",
    "function PersonContextRouteV2",
  );
  assert.match(router, /props\.target\.mode === "context"/u);
  assert.match(router, /return <PersonContextRouteV2 \{\.\.\.props\} \/>/u);
  assert.match(router, /return <PersonsModuleV2StandardRoutes \{\.\.\.props\} \/>/u);
});

test("context route does not mount legacy person detail and catalogue loaders", () => {
  const contextRoute = sourceBetween(
    "function PersonContextRouteV2",
    "function PersonsModuleV2StandardRoutes",
  );

  assert.match(contextRoute, /<PersonContextWorkspaceV1/u);
  assert.match(contextRoute, /center=\{routePerson\}/u);
  assert.match(contextRoute, /useProjectRoutePerson\(projectId, target\.personId, listedRoutePerson\)/u);
  assert.match(contextRoute, /persons=\{contextPersons\}/u);
  assert.match(contextRoute, /canEdit=\{!readOnly\}/u);
  assert.doesNotMatch(
    contextRoute,
    /(?:listPersonLinkedRecords|listProjectPersonNames|listProjectDocumentsByIds|loadProjectPersonSummaries|loadProjectPersonPedigreeOrder|listProjectPersonMarriages|listProjectGedcomImportDatasets|useEffect)\s*\(/u,
  );
});

test("only research context builds project-wide research target options", () => {
  const contextRoute = sourceBetween(
    "function PersonContextRouteV2",
    "function PersonsModuleV2StandardRoutes",
  );
  const viewDeclaration = contextRoute.indexOf('const contextView = target.contextView ?? "social";');
  const targetMemo = contextRoute.indexOf("const researchTargets = useMemo<ResearchGraphTargetOption[]>");

  assert.ok(viewDeclaration >= 0 && targetMemo > viewDeclaration);
  assert.match(
    contextRoute,
    /const researchTargets = useMemo<ResearchGraphTargetOption\[\]>\(\s*\(\) => contextView === "research"\s*\? buildResearchGraphTargetOptions\(db, contextPersons\)\s*: \[\]/u,
  );
});

test("focused person context omits the generic hierarchy header to maximize graph space", () => {
  assert.match(
    appSource,
    /const isFocusedPersonContext = page === "persons"[\s\S]*?route\.personMode === "context"/u,
  );
  assert.match(
    appSource,
    /isHierarchyPage\(page\) && !isFocusedPersonContext/u,
  );
});

test("person-id routes hydrate only the requested person and ignore stale requests", () => {
  const resolver = sourceBetween(
    "function useProjectRoutePerson",
    "function RoutePersonLookupV2",
  );
  const standardRoutes = sourceBetween(
    "function PersonsModuleV2StandardRoutes",
    "function RootPersonDeletionDialogV2",
  );

  assert.match(resolver, /getProjectPerson\(projectId, personId\)/u);
  assert.match(resolver, /let active = true/u);
  assert.match(resolver, /if \(!active\) return/u);
  assert.match(resolver, /current\.requestKey === requestKey/u);
  assert.doesNotMatch(resolver, /listProjectPeople|loadProjectPersonSummaries/u);
  assert.match(standardRoutes, /useProjectRoutePerson\(projectId, target\.personId, listedRoutePerson\)/u);
  assert.match(standardRoutes, /persons=\{routePersons\}/u);
  assert.match(standardRoutes, /<RoutePersonLookupV2/u);
});

test("profile and editor routes retain the existing detail, name and document loading", () => {
  const standardRoutes = moduleSource.slice(
    moduleSource.indexOf("function PersonsModuleV2StandardRoutes"),
  );

  assert.match(standardRoutes, /listPersonLinkedRecords\(projectId, detailPersonId\)/u);
  assert.match(standardRoutes, /listProjectPersonNames\(projectId, detailPersonId\)/u);
  assert.match(standardRoutes, /listProjectDocumentsByIds\(projectId, documentIds\)/u);
  assert.match(standardRoutes, /if \(target\.mode === "edit" \|\| target\.mode === "new"\)/u);
  assert.match(standardRoutes, /if \(target\.mode === "profile"\)/u);
});
