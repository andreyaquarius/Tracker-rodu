import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Person, PersonRelation } from "../src/types/index.ts";
import { mergeProjectPersonSnapshot } from "../src/utils/projectPersonSnapshot.ts";

function person(id: string, fullName: string): Person {
  return { id, fullName } as Person;
}

function relation(id: string, personId: string, relatedPersonId: string): PersonRelation {
  return {
    id,
    personId,
    relatedPersonId,
    relationType: "інше",
    status: "доведено",
    evidenceText: "",
    notes: "",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

test("created tree person snapshot becomes immediately available without dropping unrelated state", () => {
  const unrelatedPerson = person("other", "Інша особа");
  const stalePerson = person("created", "Чернетка");
  const savedPerson = person("created", "Створена особа");
  const unrelatedRelation = relation("unrelated", "other", "third");
  const staleRelation = relation("stale", "created", "old-parent");
  const freshRelation = relation("fresh", "parent", "created");

  const result = mergeProjectPersonSnapshot(
    [unrelatedPerson, stalePerson],
    [unrelatedRelation, staleRelation],
    savedPerson,
    [freshRelation, freshRelation],
  );

  assert.deepEqual(result.persons, [unrelatedPerson, savedPerson]);
  assert.deepEqual(result.relations, [unrelatedRelation, freshRelation]);

  const inserted = mergeProjectPersonSnapshot(
    [unrelatedPerson],
    [unrelatedRelation],
    savedPerson,
    [freshRelation],
  );
  assert.deepEqual(inserted.persons, [savedPerson, unrelatedPerson]);
});

test("all tree person creation paths synchronize App state before closing the builder", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const production = readFileSync(
    new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );
  const legacy = readFileSync(
    new URL("../src/pages/FamilyTreePage.tsx", import.meta.url),
    "utf8",
  );
  const service = readFileSync(
    new URL("../src/services/projectPeople.ts", import.meta.url),
    "utf8",
  );

  assert.equal(production.match(/await onPersonCreated\?\.\(/g)?.length, 2);
  assert.equal(legacy.match(/await onPersonCreated\?\.\(/g)?.length, 2);
  assert.match(
    app,
    /onPersonCreated=\{async \(personId\) => \{[\s\S]*?await syncFamilyTreeCreatedPerson\(personId\)/,
  );
  assert.match(
    app,
    /if \(!projectPersonsRef\.current\.some[\s\S]*?await syncFamilyTreeCreatedPerson[\s\S]*?openRelatedRecord\("persons"/,
  );
  assert.match(service, /\.eq\("person_id", personId\)/);
  assert.match(service, /\.eq\("related_person_id", personId\)/);
});
