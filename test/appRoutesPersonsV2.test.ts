import assert from "node:assert/strict";
import test from "node:test";
import {
  familyTreePath,
  parseAppRoute,
  parseFamilyTreeRouteFocus,
  personPath,
} from "../src/utils/appRoutes.ts";

test("parses routed person profile, editor and new-person paths", () => {
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
