import assert from "node:assert/strict";
import test from "node:test";
import {
  cooccurrencePeriodLabel,
  cooccurrenceSharedSourceLabel,
  cooccurrenceSourceKindLabel,
  cooccurrenceStrengthLabel,
  defaultCooccurrenceFilterDraft,
  mergeCooccurrencePages,
  parseCooccurrenceFilterDraft,
} from "../src/features/context-graph/cooccurrenceModel.ts";
import type {
  PersonContextCooccurrence,
  PersonContextCooccurrencesPage,
} from "../src/types/contextGraph.ts";

test("co-occurrence filters default to repeated sources and stay within the RPC budget", () => {
  const defaults = defaultCooccurrenceFilterDraft();
  assert.deepEqual(defaults, { yearFrom: "", yearTo: "", minShared: "2" });
  assert.deepEqual(parseCooccurrenceFilterDraft(defaults), {
    yearFrom: undefined,
    yearTo: undefined,
    minShared: 2,
    limit: 20,
    offset: 0,
  });
  assert.equal(parseCooccurrenceFilterDraft({
    yearFrom: "1850",
    yearTo: "1900",
    minShared: "3",
  }, 500).limit, 100);
});

test("co-occurrence filters reject invalid years, ranges and shared-source thresholds", () => {
  assert.throws(
    () => parseCooccurrenceFilterDraft({ yearFrom: "1901", yearTo: "1900", minShared: "2" }),
    /Початковий рік не може бути пізнішим/u,
  );
  assert.throws(
    () => parseCooccurrenceFilterDraft({ yearFrom: "18.5", yearTo: "", minShared: "2" }),
    /початковий рік.*цілим числом/u,
  );
  assert.throws(
    () => parseCooccurrenceFilterDraft({ yearFrom: "", yearTo: "", minShared: "0" }),
    /від 1 до 1000/u,
  );
});

test("co-occurrence presentation labels do not imply probability or kinship", () => {
  assert.equal(cooccurrencePeriodLabel({ firstYear: 1863, lastYear: 1863 }), "1863");
  assert.equal(cooccurrencePeriodLabel({ firstYear: 1850, lastYear: 1870 }), "1850–1870");
  assert.equal(cooccurrencePeriodLabel({ firstYear: null, lastYear: null }), "Роки не визначено");
  assert.equal(cooccurrenceStrengthLabel(21), "21 бал");
  assert.equal(cooccurrenceStrengthLabel(22), "22 бали");
  assert.equal(cooccurrenceStrengthLabel(25), "25 балів");
  assert.equal(cooccurrenceSharedSourceLabel(2), "2 спільні джерела");
  assert.equal(cooccurrenceSourceKindLabel("finding"), "Знахідка");
  assert.equal(cooccurrenceSourceKindLabel("document"), "Документ");
  assert.equal(cooccurrenceSourceKindLabel("event"), "Подія");
});

test("co-occurrence pagination appends unique candidates and adopts the latest page state", () => {
  const current = page([item("person-a", 10), item("person-b", 20)], 4, true);
  const next = page([item("person-b", 25), item("person-c", 15)], 4, false);
  const merged = mergeCooccurrencePages(current, next);
  assert.deepEqual(merged.items.map((value) => value.personId), ["person-a", "person-b", "person-c"]);
  assert.equal(merged.items[1]?.relationStrength, 25);
  assert.equal(merged.total, 4);
  assert.equal(merged.truncated, false);
});

test("an empty continuation cannot leave an endless show-more state", () => {
  const merged = mergeCooccurrencePages(
    page([item("person-a", 10)], 2, true),
    page([], 2, true),
  );
  assert.equal(merged.truncated, false);
});

test("a duplicate-only continuation is treated as zero progress", () => {
  const merged = mergeCooccurrencePages(
    page([item("person-a", 10), item("person-b", 20)], 3, true),
    page([item("person-b", 25)], 3, true),
  );
  assert.deepEqual(merged.items.map((value) => value.personId), ["person-a", "person-b"]);
  assert.equal(merged.items[1]?.relationStrength, 25);
  assert.equal(merged.truncated, false);
});

function item(personId: string, relationStrength: number): PersonContextCooccurrence {
  return {
    personId,
    displayName: personId,
    masked: false,
    sharedFindingCount: 1,
    sharedDocumentCount: 0,
    sharedEventCount: 0,
    sharedSourceCount: 1,
    relationStrength,
    firstYear: null,
    lastYear: null,
    topSources: [],
  };
}

function page(
  items: PersonContextCooccurrence[],
  total: number,
  truncated: boolean,
): PersonContextCooccurrencesPage {
  return {
    centerPersonId: "center",
    algorithmVersion: "cooccurrence_v1",
    items,
    total,
    truncated,
  };
}
