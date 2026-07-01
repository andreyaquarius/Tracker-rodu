import test from "node:test";
import assert from "node:assert/strict";
import type { Person, PersonRelation } from "../src/types/index.ts";
import {
  buildFamilyTreeProjection,
  deriveFamilyTreePersonNames,
  deriveFamilyTreePersonTimelineEvents,
} from "../src/utils/familyTreeProjection.ts";

const now = "2026-06-29T00:00:00.000Z";

function person(id: string, overrides: Partial<Person> = {}): Person {
  return {
    id,
    researchId: "",
    status: "доведена" as Person["status"],
    gender: "невідомо" as Person["gender"],
    surname: "",
    givenName: "",
    patronymic: "",
    fullName: "",
    nameVariants: "",
    surnameVariants: "",
    birthDate: "",
    birthYearFrom: "",
    birthYearTo: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathYearFrom: "",
    deathYearTo: "",
    deathPlace: "",
    residencePlaces: "",
    socialStatus: "",
    religion: "",
    occupation: "",
    isLiving: false,
    privacyStatus: "private",
    notes: "",
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    events: [],
    customFields: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function relation(
  id: string,
  personId: string,
  relatedPersonId: string,
  relationType: PersonRelation["relationType"],
  status: PersonRelation["status"] = "доведено" as PersonRelation["status"],
): PersonRelation {
  return {
    id,
    personId,
    relatedPersonId,
    relationType,
    status,
    evidenceText: "",
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

test("derives primary and variant names without losing original spelling", () => {
  const target = person("p1", {
    surname: "Гурський",
    givenName: "Григорій",
    patronymic: "Іванович",
    nameVariants: "Грицько; Hryhorii",
    surnameVariants: "Гурскі, Gurski",
  });

  const names = deriveFamilyTreePersonNames("project", target);

  assert.equal(names[0].isPrimary, true);
  assert.equal(names[0].fullName, "Гурський Григорій Іванович");
  assert.equal(names.some((name) => name.originalText === "Hryhorii" && name.nameType === "alias"), true);
  assert.equal(names.some((name) => name.surname === "Gurski" && name.nameType === "surname_variant"), true);
});

test("derives timeline events from existing person fields and custom events", () => {
  const target = person("p1", {
    birthDate: "1896-xx-06",
    birthPlace: "Трубіївка",
    deathYearFrom: "1941",
    deathYearTo: "1945",
    residencePlaces: "Трубіївка; Ружин",
    events: [
      {
        id: "military",
        personId: "p1",
        type: "military",
        title: "Служба",
        date: "1917",
        placeName: "Київ",
        geo: null,
        notes: "Згадка у документі",
      },
    ],
  });

  const events = deriveFamilyTreePersonTimelineEvents("project", target);

  assert.equal(events.some((event) => event.eventType === "birth" && event.placeName === "Трубіївка"), true);
  assert.equal(events.some((event) => event.eventType === "death" && event.dateText === "1941-1945"), true);
  assert.equal(events.filter((event) => event.eventType === "residence").length, 2);
  assert.equal(events.some((event) => event.eventType === "military" && event.title === "Служба"), true);
});

test("builds graph projection from legacy parent and partner relations", () => {
  const child = person("child", { surname: "Гурський", givenName: "Григорій" });
  const father = person("father", { surname: "Гурський", givenName: "Іван" });
  const mother = person("mother", { surname: "Гурська", givenName: "Євдокія" });
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    persons: [child, father, mother],
    legacyRelations: [
      relation("father-link", "child", "father", "батько" as PersonRelation["relationType"]),
      relation("mother-link", "child", "mother", "мати" as PersonRelation["relationType"]),
      relation("spouse-link", "father", "mother", "дружина" as PersonRelation["relationType"]),
    ],
  });

  assert.equal(projection.nodes.length, 3);
  assert.equal(projection.stats.parentChildEdges, 2);
  assert.equal(projection.stats.partnerEdges, 1);
  assert.equal(projection.parentChildEdges.some((edge) => edge.fromPersonId === "father" && edge.toPersonId === "child"), true);
});

test("reports missing people and duplicate projected edges", () => {
  const child = person("child", { surname: "Гурський", givenName: "Григорій" });
  const father = person("father", { surname: "Гурський", givenName: "Іван" });
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    persons: [child, father],
    legacyRelations: [
      relation("father-one", "child", "father", "батько" as PersonRelation["relationType"]),
      relation("father-two", "child", "father", "батько" as PersonRelation["relationType"]),
      relation("missing", "child", "absent", "мати" as PersonRelation["relationType"]),
    ],
  });

  assert.equal(projection.stats.parentChildEdges, 1);
  assert.equal(projection.stats.skippedLegacyRelations, 1);
  assert.equal(projection.issues.some((issue) => issue.code === "duplicate_legacy_edge"), true);
  assert.equal(projection.issues.some((issue) => issue.code === "legacy_relation_missing_related_person"), true);
});
