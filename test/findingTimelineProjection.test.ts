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
