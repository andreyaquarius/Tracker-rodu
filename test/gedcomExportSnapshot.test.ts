import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGedcomExportProjection,
  type GedcomExportSnapshot,
} from "../supabase/functions/_shared/gedcomExportSnapshot.ts";
import {
  exportFamilyTreeProjectionToGedcom,
  parseGedcom,
  summarizeGedcom,
} from "../src/utils/gedcom.ts";

test("server snapshot preserves people, events and reciprocal nuclear-family pointers", () => {
  const snapshot = nuclearSnapshot();
  const projection = buildGedcomExportProjection(snapshot);
  const result = exportFamilyTreeProjectionToGedcom(projection, {
    rootPersonId: "child",
    createdAt: "2026-07-19",
  });
  const summary = summarizeGedcom(parseGedcom(result.text));

  assert.equal(projection.nodes.length, 3);
  assert.equal(projection.partnerEdges.length, 1);
  assert.equal(projection.parentChildEdges.length, 2);
  assert.equal(summary.individuals, 3);
  assert.equal(summary.families, 1);
  assert.match(result.text, /1 BIRT\r\n2 DATE 1 JAN 2000\r\n2 PLAC Київ/);
  assert.match(result.text, /1 HUSB @I\d+@/);
  assert.match(result.text, /1 WIFE @I\d+@/);
  assert.match(result.text, /1 CHIL @I\d+@/);
  assert.match(result.text, /1 FAMC @F\d+@/);
  assert.match(result.text, /1 FAMS @F\d+@/);
  assert.equal(result.text.endsWith("0 TRLR\r\n"), true);
});

test("server snapshot adds profile events once and wraps long Unicode lines below 255 bytes", () => {
  const snapshot = nuclearSnapshot();
  snapshot.people[0].notes = `Архівна нотатка ${"їжак 🧬 ".repeat(300)}`;
  snapshot.people[0].custom_fields = {
    __trackerRoduPersonEvents: [
      { id: "saved-birth", type: "birth", date: "2000-01-01", placeName: "Київ" },
      { id: "saved-residence", type: "residence", date: "2020", placeName: "Львів" },
    ],
  };
  const projection = buildGedcomExportProjection(snapshot);
  const child = projection.nodes.find((node) => node.personId === "child")!;
  assert.equal(child.events.filter((event) => event.eventType === "birth").length, 1);
  assert.equal(child.events.filter((event) => event.eventType === "residence").length, 1);

  const text = exportFamilyTreeProjectionToGedcom(projection, { createdAt: "2026-07-19" }).text;
  const byteLengths = text.trimEnd().split(/\r?\n/).map((line) => Buffer.byteLength(line, "utf8"));
  assert.ok(Math.max(...byteLengths) <= 255);
  assert.match(text, / CONC /);
});

function nuclearSnapshot(): GedcomExportSnapshot {
  return {
    projectId: "project",
    treeId: "tree",
    rootPersonId: "child",
    people: [
      person("child", "Каленський", "Андрій", "2000-01-01", "Київ", "male"),
      person("father", "Каленський", "Леонід", "1970", "Черкаси", "male"),
      person("mother", "Каленська", "Олена", "1972", "Полтава", "female"),
    ],
    names: [],
    events: [{
      id: "child-birth",
      project_id: "project",
      person_id: "child",
      event_type: "birth",
      title: "Народження",
      event_date: "2000-01-01",
      date_from: "",
      date_to: "",
      date_text: "2000-01-01",
      place_name: "Київ",
      event_role: "subject",
      evidence_status: "proven",
      confidence: 100,
      notes: "",
      metadata: {},
    }],
    partnerRelationships: [{
      id: "parents",
      person_a_id: "father",
      person_b_id: "mother",
      family_group_id: "family",
      relationship_type: "marriage",
      evidence_status: "proven",
      confidence: 100,
    }],
    parentChildRelationships: [
      {
        id: "father-child",
        parent_id: "father",
        child_id: "child",
        parent_set_id: "parent-set",
        family_group_id: "family",
        relationship_type: "biological",
        parent_role_label: "father",
        evidence_status: "proven",
        confidence: 100,
        is_bloodline: true,
      },
      {
        id: "mother-child",
        parent_id: "mother",
        child_id: "child",
        parent_set_id: "parent-set",
        family_group_id: "family",
        relationship_type: "biological",
        parent_role_label: "mother",
        evidence_status: "proven",
        confidence: 100,
        is_bloodline: true,
      },
    ],
    associationRelationships: [],
    parentSets: [{ id: "parent-set", set_type: "biological" }],
  };
}

function person(
  id: string,
  surname: string,
  givenName: string,
  birthDate: string,
  birthPlace: string,
  gender: string,
) {
  return {
    id,
    project_id: "project",
    gender,
    status: "proven",
    surname,
    given_name: givenName,
    patronymic: "",
    full_name: `${surname} ${givenName}`,
    birth_date: birthDate,
    birth_year_from: "",
    birth_year_to: "",
    birth_place: birthPlace,
    death_date: "",
    death_year_from: "",
    death_year_to: "",
    death_place: "",
    custom_fields: {},
    is_living: false,
    privacy_status: "private",
  };
}
