import assert from "node:assert/strict";
import test from "node:test";
import type { Person, PersonName } from "../src/types/index.ts";
import {
  normalizePersonNameDisplayMode,
  personNameDisplayOptionsFromSettings,
  resolvePersonNameDisplay,
} from "../src/utils/personNameDisplay.ts";

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-1",
    researchId: "research-1",
    fullName: "Коваль  Іван Іванович",
    surname: "Коваль",
    maidenSurname: "",
    givenName: "Іван",
    patronymic: "Іванович",
    ...overrides,
  } as Person;
}

function name(id: string, overrides: Partial<PersonName> = {}): PersonName {
  return {
    id,
    projectId: "project-1",
    personId: "person-1",
    nameType: "variant",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: "",
    maidenSurname: "",
    givenName: "",
    patronymic: "",
    prefix: "",
    suffix: "",
    nickname: "",
    fullName: "",
    fullNormalized: "",
    originalText: "",
    orthography: "",
    validFrom: "",
    validTo: "",
    datePrecision: "unknown",
    isPrimary: false,
    isPreferred: false,
    isSearchable: true,
    evidenceStatus: "unknown",
    confidence: 50,
    sourceDocumentId: null,
    sourceFindingId: null,
    sourceType: "",
    sourceId: null,
    citationId: null,
    documentFragmentId: null,
    notes: "",
    metadata: {},
    createdBy: null,
    lockVersion: 0,
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

test("legacy card name remains the default even when historical names exist", () => {
  const result = resolvePersonNameDisplay(person(), [
    name("primary", { isPrimary: true, fullNormalized: "Jan Kowalski" }),
  ]);

  assert.equal(result.mode, "current");
  assert.equal(result.label, "Коваль Іван Іванович");
  assert.equal(result.selectedNameId, null);
  assert.equal(result.usedLegacyFallback, true);
});

test("primary and interface-language modes select additive PersonName records", () => {
  const names = [
    name("uk", { isPrimary: true, fullNormalized: "Коваль Іван" }),
    name("pl", {
      languageCode: "pl-PL",
      isPreferred: true,
      fullNormalized: "Jan Kowalski",
    }),
  ];

  assert.equal(
    resolvePersonNameDisplay(person(), names, { mode: "primary" }).label,
    "Коваль Іван",
  );
  assert.equal(
    resolvePersonNameDisplay(person(), names, {
      mode: "interface_language",
      interfaceLanguage: "pl",
    }).label,
    "Jan Kowalski",
  );
});

test("date mode selects a name whose inclusive validity interval covers the date", () => {
  const result = resolvePersonNameDisplay(person(), [
    name("early", {
      fullNormalized: "Іоанн Коваль",
      validFrom: "1870",
      validTo: "1899",
    }),
    name("later", {
      fullNormalized: "Іван Коваль",
      validFrom: "1900-01-01",
      validTo: "1930-12-31",
    }),
  ], {
    mode: "valid_at_date",
    referenceDate: "1888-05-10",
  });

  assert.equal(result.label, "Іоанн Коваль");
  assert.equal(result.selectedNameId, "early");
});

test("original mode returns exact source spelling without rewriting it", () => {
  const exact = "  Joannes  Kowal  ";
  const result = resolvePersonNameDisplay(person(), [
    name("projection", {
      isPrimary: true,
      nameType: "primary",
      originalText: "Коваль Іван Іванович",
      fullNormalized: "Коваль Іван Іванович",
      metadata: { source: "persons_projection_backfill" },
    }),
    name("source", {
      nameType: "document",
      originalText: exact,
      fullNormalized: "Іван Коваль",
      sourceDocumentId: "document-1",
    }),
  ], { mode: "original" });

  assert.equal(result.label, exact);
  assert.equal(result.selectedNameId, "source");
});

test("original mode falls back instead of presenting a managed projection as a source", () => {
  const result = resolvePersonNameDisplay(person(), [
    name("projection", {
      isPrimary: true,
      originalText: "Службова копія поточного ПІБ",
      fullNormalized: "Основне історичне ім’я",
      metadata: { source: "persons_projection" },
    }),
  ], { mode: "original" });

  assert.equal(result.label, "Коваль Іван Іванович");
  assert.equal(result.selectedNameId, null);
  assert.equal(result.usedLegacyFallback, true);
});

test("primary-with-variants exposes unique variants separately and inline", () => {
  const result = resolvePersonNameDisplay(person(), [
    name("primary", { isPrimary: true, fullNormalized: "Іван Коваль" }),
    name("duplicate", { fullNormalized: "  Іван   Коваль " }),
    name("variant", { fullNormalized: "Jan Kowalski", languageCode: "pl" }),
  ], { mode: "primary_with_variants" });

  assert.deepEqual(result.variantLabels, ["Jan Kowalski"]);
  assert.equal(result.inlineLabel, "Іван Коваль · Варіанти: Jan Kowalski");
});

test("unknown saved modes safely fall back to the unchanged current-name mode", () => {
  assert.equal(normalizePersonNameDisplayMode("future-mode"), "current");
  assert.equal(normalizePersonNameDisplayMode(undefined), "current");

  const legacySettings = {
    researcherName: "Дослідник",
    compactTables: true,
    lastAutomaticBackupAt: null,
    customFields: [],
  };
  assert.deepEqual(personNameDisplayOptionsFromSettings(legacySettings), {
    mode: "current",
    interfaceLanguage: "uk",
    referenceDate: "",
  });
});
