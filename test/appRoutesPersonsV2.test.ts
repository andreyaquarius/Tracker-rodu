import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRouteLocation,
  familyTreeStatisticsPath,
  familyTreePath,
  parseAppRoute,
  parseFamilyTreeRouteFocus,
  personPath,
} from "../src/utils/appRoutes.ts";

test("parses routed person profile, editor, context and new-person paths", () => {
  assert.deepEqual(parseAppRoute("/projects/kalenski/persons/person-1"), {
    kind: "project",
    projectRef: "kalenski",
    page: "persons",
    personId: "person-1",
    personMode: "profile",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/persons/person-1/edit"), {
    kind: "project",
    projectRef: "kalenski",
    page: "persons",
    personId: "person-1",
    personMode: "edit",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/persons/person-1/context"), {
    kind: "project",
    projectRef: "kalenski",
    page: "persons",
    personId: "person-1",
    personMode: "context",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/persons/person-1/context/documentary"), {
    kind: "project",
    projectRef: "kalenski",
    page: "persons",
    personId: "person-1",
    personMode: "context",
    contextView: "documentary",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/persons/person-1/context/ritual"), {
    kind: "project",
    projectRef: "kalenski",
    page: "persons",
    personId: "person-1",
    personMode: "context",
    contextView: "ritual",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/persons/person-1/context/research"), {
    kind: "project",
    projectRef: "kalenski",
    page: "persons",
    personId: "person-1",
    personMode: "context",
    contextView: "research",
  });
  assert.deepEqual(parseAppRoute("/projects/kalenski/persons/new"), {
    kind: "project",
    projectRef: "kalenski",
    page: "persons",
    personMode: "new",
  });
});

test("builds encoded person paths", () => {
  assert.equal(personPath("Рід Каленських"), "/projects/%D0%A0%D1%96%D0%B4%20%D0%9A%D0%B0%D0%BB%D0%B5%D0%BD%D1%81%D1%8C%D0%BA%D0%B8%D1%85/persons");
  assert.equal(personPath("kalenski", "person/1"), "/projects/kalenski/persons/person%2F1");
  assert.equal(personPath("kalenski", "person/1", "edit"), "/projects/kalenski/persons/person%2F1/edit");
  assert.equal(personPath("kalenski", "person/1", "context"), "/projects/kalenski/persons/person%2F1/context");
  assert.equal(
    personPath("kalenski", "person/1", "context", "documentary"),
    "/projects/kalenski/persons/person%2F1/context/documentary",
  );
  assert.equal(
    personPath("kalenski", "person/1", "context", "ritual"),
    "/projects/kalenski/persons/person%2F1/context/ritual",
  );
  assert.equal(
    personPath("kalenski", "person/1", "context", "research"),
    "/projects/kalenski/persons/person%2F1/context/research",
  );
  assert.equal(personPath("kalenski", undefined, "new"), "/projects/kalenski/persons/new");
});

test("builds and parses a stable family-tree focus deep link", () => {
  assert.equal(
    familyTreePath("Рід Каленських", {
      treeId: "tree/1",
      focusPersonId: "person + 1",
    }),
    "/projects/%D0%A0%D1%96%D0%B4%20%D0%9A%D0%B0%D0%BB%D0%B5%D0%BD%D1%81%D1%8C%D0%BA%D0%B8%D1%85/rodove-derevo?treeId=tree%2F1&focusPersonId=person+%2B+1",
  );
  assert.deepEqual(
    parseFamilyTreeRouteFocus("?treeId=tree%2F1&focusPersonId=person+%2B+1"),
    { treeId: "tree/1", focusPersonId: "person + 1" },
  );
  assert.equal(familyTreePath("kalenski"), "/projects/kalenski/rodove-derevo");
});

test("family tree statistics has a stable nested route", () => {
  assert.equal(
    familyTreeStatisticsPath("Рід Каленських", "tree-1"),
    "/projects/%D0%A0%D1%96%D0%B4%20%D0%9A%D0%B0%D0%BB%D0%B5%D0%BD%D1%81%D1%8C%D0%BA%D0%B8%D1%85/rodove-derevo/statystyka?treeId=tree-1",
  );
  assert.deepEqual(
    parseAppRoute("/projects/kalenski/rodove-derevo/statystyka?treeId=tree-1"),
    {
      kind: "project",
      projectRef: "kalenski",
      page: "familyTree",
      familyTreeView: "statistics",
    },
  );
});

test("canonical statistics route does not append treeId repeatedly", () => {
  const route = familyTreeStatisticsPath("kalenski", "tree-1");
  assert.deepEqual(
    canonicalRouteLocation(route, "?treeId=tree-1", ""),
    {
      pathname: "/projects/kalenski/rodove-derevo/statystyka",
      search: "?treeId=tree-1",
      href: "/projects/kalenski/rodove-derevo/statystyka?treeId=tree-1",
    },
  );
  assert.equal(
    canonicalRouteLocation(route, "?treeId=tree-1?treeId=tree-1", "").href,
    "/projects/kalenski/rodove-derevo/statystyka?treeId=tree-1",
  );
});

test("feedback inbox is a stable account-level route", () => {
  assert.deepEqual(parseAppRoute("/feedback"), {
    kind: "settings",
    page: "feedback",
  });
});

test("admin panel routes are account-level and never parsed as project routes", () => {
  assert.deepEqual(parseAppRoute("/admin"), {
    kind: "admin",
    page: "overview",
  });
  assert.deepEqual(parseAppRoute("/admin/analytics"), {
    kind: "admin",
    page: "analytics",
  });
});
