import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PersonEvent } from "../src/types/index.ts";
import { normalizePersonEvents } from "../src/utils/geo.ts";

const personEditorSource = readFileSync(
  new URL("../src/features/persons-v2/PersonEditorV2.tsx", import.meta.url),
  "utf8",
);
const legacyPersonFormSource = readFileSync(
  new URL("../src/components/PersonFormModal.tsx", import.meta.url),
  "utf8",
);
const eventEditorSource = readFileSync(
  new URL("../src/components/PersonEventsEditor.tsx", import.meta.url),
  "utf8",
);

test("person editors expose the event address as a house-number field", () => {
  for (const eventType of ["birth", "marriage", "death"] as const) {
    assert.match(
      personEditorSource,
      new RegExp(`event\\.id === "${eventType}"\\)\\?\\.address`),
      `${eventType} must read its saved house number`,
    );
    assert.match(
      personEditorSource,
      new RegExp(`patchEvent\\(\\s*"${eventType}",[\\s\\S]*?address: event\\.target\\.value \\|\\| null`),
      `${eventType} must update its canonical event address`,
    );
    assert.match(
      legacyPersonFormSource,
      new RegExp(`updateCoreEventAddress\\("${eventType}", event\\.target\\.value\\)`),
      `${eventType} must remain editable in the compact person form`,
    );
  }

  assert.match(personEditorSource, /value=\{mapEvent\.address \?\? ""\}/);
  assert.match(eventEditorSource, /Номер будинку \/ точна адреса/);
});

test("a canonical life event preserves the entered house number", () => {
  const saved: PersonEvent[] = [{
    id: "birth",
    personId: "person-1",
    type: "birth",
    title: "Народження",
    date: "1872",
    placeName: "Трубіївка",
    address: "буд. 27-А",
    geo: null,
    notes: null,
  }];

  const normalized = normalizePersonEvents(saved, {
    id: "person-1",
    birthDate: "1872",
    birthPlace: "Трубіївка",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathPlace: "",
    residencePlaces: "",
  });

  assert.equal(
    normalized.find((event) => event.id === "birth")?.address,
    "буд. 27-А",
  );
});
