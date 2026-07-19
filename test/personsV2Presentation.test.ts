import assert from "node:assert/strict";
import test from "node:test";
import {
  personEventTypeDisplayLabel,
  personTimelineDateDisplay,
  personTimelineDateTimeValue,
  personTimelineEventDisplaySubtitle,
  personTimelineEventDisplayTitle,
} from "../src/features/persons-v2/presentation.ts";

test("persons V2 localizes known summary event codes", () => {
  assert.equal(personEventTypeDisplayLabel("residence"), "Проживання");
  assert.equal(personEventTypeDisplayLabel("burial"), "Поховання");
  assert.equal(personEventTypeDisplayLabel("Military Service"), "Військова служба");
  assert.equal(personEventTypeDisplayLabel("Локальна подія"), "Локальна подія");
});

test("persons V2 formats exact and GEDCOM dates without changing stored data", () => {
  assert.equal(personTimelineDateDisplay("1863-03-22"), "22.03.1863");
  assert.equal(
    personTimelineDateDisplay("FROM ABT 1881 TO 13 DEC 1886"),
    "від бл. 1881 до 13 груд. 1886",
  );
  assert.equal(personTimelineDateDisplay("BET 1901 AND 1904"), "між 1901 і 1904");
  assert.equal(personTimelineDateDisplay("невідома весна"), "невідома весна");
  assert.equal(personTimelineDateTimeValue("1863-03-22"), "1863-03-22");
  assert.equal(personTimelineDateTimeValue("2024-02-29"), "2024-02-29");
  assert.equal(personTimelineDateTimeValue("2026-02-31"), undefined);
  assert.equal(personTimelineDateTimeValue("2026-99"), undefined);
  assert.equal(personTimelineDateTimeValue("FROM 1881 TO 1886"), undefined);
});

test("persons V2 uses canonical Ukrainian event titles and keeps meaningful custom detail", () => {
  const military = { type: "military" as const, title: "Military Service" };
  assert.equal(personTimelineEventDisplayTitle(military), "Військова служба");
  assert.equal(personTimelineEventDisplaySubtitle(military), "");

  const clarified = { type: "military" as const, title: "Служба у 17-му полку" };
  assert.equal(personTimelineEventDisplayTitle(clarified), "Військова служба");
  assert.equal(personTimelineEventDisplaySubtitle(clarified), "Служба у 17-му полку");

  const custom = { type: "other" as const, title: "Перша згадка у громаді" };
  assert.equal(personTimelineEventDisplayTitle(custom), "Перша згадка у громаді");
  assert.equal(personTimelineEventDisplaySubtitle(custom), "");
});
