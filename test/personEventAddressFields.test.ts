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

test("the person editor exposes and preserves a canonical cause of death", () => {
  assert.match(personEditorSource, /<span>Причина смерті<\/span>/u);
  assert.match(
    personEditorSource,
    /event\.id === "death"\)\?\.cause \?\? ""/u,
  );
  assert.match(
    personEditorSource,
    /patchEvent\(\s*"death",\s*\{ cause: event\.target\.value \|\| null \},\s*"death"/u,
  );

  const normalized = normalizePersonEvents([{
    id: "death",
    personId: "person-1",
    type: "death",
    title: "Смерть",
    date: "1983-02-23",
    placeName: "Вербівка",
    cause: "запалення легень",
    geo: null,
    notes: null,
  }], {
    id: "person-1",
    birthDate: "1922",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "1983-02-23",
    deathPlace: "Вербівка",
    residencePlaces: "",
  });

  assert.equal(
    normalized.find((event) => event.id === "death")?.cause,
    "запалення легень",
  );
});
