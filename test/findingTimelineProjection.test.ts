import test from "node:test";
import assert from "node:assert/strict";
import type { Person, PersonEvent } from "../src/types/index.ts";
import { normalizePersonEvents, syncPersonEventsFromFields } from "../src/utils/geo.ts";
import { buildPersonTimeline, personTimelineAttachments } from "../src/features/persons-v2/model.ts";
import { personTimelineEventDisplayTitle, personTimelineEventDisplaySubtitle } from "../src/features/persons-v2/presentation.ts";
import { projectAttachmentMetadataRows } from "../src/services/projectAttachmentMetadataRows.ts";

const scan = { id: "scan-1", name: "Джерело.jpg", storage: "google-drive" as const, storagePath: "drive-1", mimeType: "image/jpeg", createdAt: "2026-09-06", size: 100,
  deleteOnRemove: false, referenceOwnerType: "findings" as const, referenceOwnerId: "finding-1" };
const event: PersonEvent = { id: "finding:finding-1", personId: "person-1", type: "marriage", date: "1892-01-24", placeName: "Вербівка", title: "шлюб",
  sourceFindingId: "finding-1", sourceDocumentId: "document-1", sourceSnapshot: { date: "1892-01-24" }, scans: [scan] };
const person = { id: "person-1", birthDate: "", birthPlace: "", deathDate: "", deathPlace: "", residencePlaces: "", marriageDate: event.date, marriagePlace: event.placeName,
  birthYearFrom: "", birthYearTo: "", deathYearFrom: "", deathYearTo: "", events: [event] } as Person;

test("source event identity and snapshot survive person editor normalization / save", () => {
  const normalized = normalizePersonEvents([event],person);
  const saved = syncPersonEventsFromFields({ ...person, events: normalized });
  const found = saved.filter((entry) => entry.sourceFindingId);
  assert.equal(found.length,1); assert.equal(found[0].id,event.id);
  assert.deepEqual(found[0].sourceSnapshot,event.sourceSnapshot);
  assert.equal(found[0].scans?.[0].deleteOnRemove,false);
});

test("shared marriage and source event merge without losing scans; distinct findings keep provenance", () => {
  const items = buildPersonTimeline(person,{ marriages: [{ id: "marriage-1", partnerName: "Васса", date: "1892-01-24", place: "Вербівка", address: "" }] });
  assert.equal(items.length,1); assert.equal(items[0].sourceFindingId,"finding-1");
  assert.equal(personTimelineAttachments(person,items[0])[0].id,scan.id);
  const twoSources = buildPersonTimeline({ ...person,events: [event,{ ...event,id: "finding:finding-2",sourceFindingId:"finding-2" }] });
  assert.equal(twoSources.length,2); assert.deepEqual(twoSources.map((item) => item.sourceFindingId),["finding-1","finding-2"]);
});

test("witness role and whose marriage are prominent in the timeline", () => {
  const witness = { ...event,type: "mention" as const,title: "Свідок · шлюб · Захарій Корзун, Васса Кучинська" };
  assert.equal(personTimelineEventDisplayTitle(witness),witness.title);
  assert.equal(personTimelineEventDisplaySubtitle(witness),"");
});

test("inherited scans never transfer attachment metadata ownership to a person", () => {
  assert.deepEqual(projectAttachmentMetadataRows("project-1","persons","person-1",{ [event.id]: [scan] }),[]);
  assert.equal(projectAttachmentMetadataRows("project-1","findings","finding-1",{ scans: [scan] }).length,1);
});

test("a finding corroborates a manual birth despite date formatting and missing place", () => {
  const manualScan = { ...scan, id: "manual-scan", storagePath: "manual-file", referenceOwnerType: "persons" as const, referenceOwnerId: person.id };
  const manual: PersonEvent = { id: "birth", personId: person.id, type: "birth", date: "24.01.1892", notes: "Ручне джерело FamilySearch", scans: [manualScan] };
  const sourced: PersonEvent = { ...event, type: "birth", notes: "Архівне підтвердження" };
  const value = { ...person, marriageDate: "", marriagePlace: "", birthDate: manual.date!, events: [manual, sourced] };
  const before = structuredClone(value);
  const items = buildPersonTimeline(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceFindingId, "finding-1");
  assert.equal(items[0].placeName, "Вербівка");
  assert.match(items[0].notes!, /Ручне джерело FamilySearch/);
  assert.match(items[0].notes!, /Архівне підтвердження/);
  assert.deepEqual(personTimelineAttachments(value, items[0]).map(value => value.id).sort(), ["manual-scan", "scan-1"]);
  assert.deepEqual(value, before, "Projection must not overwrite either original assertion");
});

test("finding-backed custom events merge with manual events without requiring a scalar core field", () => {
  const manual = { ...event, id: "manual-baptism", type: "baptism" as const, sourceFindingId: undefined, notes: "Ручна нотатка" };
  const sourced = { ...event, type: "baptism" as const, notes: "Джерело" };
  const value = { ...person, marriageDate: "", marriagePlace: "" };
  for (const events of [[manual, sourced], [sourced, manual]]) {
    const items = buildPersonTimeline({ ...value, events });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, manual.id);
    assert.equal(items[0].sourceFindingId, event.sourceFindingId);
    assert.match(items[0].notes!, /Ручна нотатка/);
    assert.match(items[0].notes!, /Джерело/);
  }
});

test("ambiguous or conflicting findings stay separate rather than overwriting manual facts", () => {
  const value = { ...person, marriageDate: "", marriagePlace: "", birthDate: "1892-01-24", birthPlace: "Вербівка" };
  for (const alternative of [{ date: "1893-01-24" }, { placeName: "Інше село" }]) {
    assert.equal(buildPersonTimeline({ ...value, events: [{ ...event, type: "birth", ...alternative }] }).length, 2);
  }
  const unknown = { ...event, type: "birth" as const, date: null, placeName: null };
  assert.equal(buildPersonTimeline({ ...value, events: [unknown] }).length, 2);
  const baptism = { ...event, type: "baptism" as const };
  assert.equal(buildPersonTimeline({ ...value, events: [baptism] }).length, 2, "Birth and baptism are different facts");
});

test("separate spouses on the same date must not be merged with the wrong finding", () => {
  const items = buildPersonTimeline({ ...person, events: [{ ...event, relatedPersonIds: [person.id, "partner-b"] }] }, {
    marriages: ["partner-a", "partner-b"].map(partnerId => ({ id: partnerId, partnerId, partnerName: partnerId, date: event.date!, place: event.placeName!, address: "" })),
  });
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.sourceFindingId)?.id, `${person.id}:marriage:partner-b`);
});
