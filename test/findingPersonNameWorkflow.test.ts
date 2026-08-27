import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PersonName } from "../src/types/index.ts";
import {
  ensureFindingDocumentPersonName,
  findingDocumentPersonNameDraft,
  type FindingDocumentPersonNameInput,
} from "../src/services/findingPersonNameWorkflow.ts";

const baseInput: FindingDocumentPersonNameInput = {
  projectId: "project-1",
  personId: "person-1",
  findingId: "finding-1",
  documentId: "document-1",
  originalText: "  Іоаннъ\nКаленскій ",
  normalizedFullName: "  Каленський   Іван  Іванович ",
  surname: "Каленський",
  givenName: "Іван",
  patronymic: "Іванович",
};

function personName(overrides: Partial<PersonName> = {}): PersonName {
  return {
    id: "name-1",
    projectId: baseInput.projectId,
    personId: baseInput.personId,
    nameType: "document",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: baseInput.surname,
    maidenSurname: "",
    givenName: baseInput.givenName,
    patronymic: baseInput.patronymic,
    prefix: "",
    suffix: "",
    nickname: "",
    fullName: "Каленський Іван Іванович",
    fullNormalized: "Каленський Іван Іванович",
    originalText: baseInput.originalText,
    orthography: "",
    validFrom: "",
    validTo: "",
    datePrecision: "unknown",
    isPrimary: false,
    isPreferred: false,
    isSearchable: true,
    evidenceStatus: "unknown",
    confidence: 50,
    sourceDocumentId: baseInput.documentId,
    sourceFindingId: baseInput.findingId,
    sourceType: "finding",
    sourceId: baseInput.findingId,
    citationId: null,
    documentFragmentId: null,
    notes: "",
    metadata: {},
    createdBy: null,
    lockVersion: 1,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

test("finding name draft preserves the confirmed original exactly and links both sources", () => {
  const draft = findingDocumentPersonNameDraft(baseInput);

  assert.equal(draft.originalText, "  Іоаннъ\nКаленскій ");
  assert.equal(draft.fullName, "Каленський Іван Іванович");
  assert.equal(draft.fullNormalized, "Каленський Іван Іванович");
  assert.equal(draft.nameType, "document");
  assert.equal(draft.sourceFindingId, "finding-1");
  assert.equal(draft.sourceDocumentId, "document-1");
  assert.equal(draft.sourceType, "finding");
  assert.equal(draft.sourceId, "finding-1");
});

test("retry dedupe uses person + finding + byte-exact original text", async () => {
  const existing = personName();
  let createCalls = 0;
  const result = await ensureFindingDocumentPersonName(baseInput, {
    listNames: async () => [existing],
    createName: async () => {
      createCalls += 1;
      return personName({ id: "unexpected" });
    },
  });

  assert.equal(result.created, false);
  assert.equal(result.name, existing);
  assert.equal(createCalls, 0);
});

test("double confirmation shares one in-flight insert", async () => {
  const input = { ...baseInput, findingId: "finding-double-click" };
  let listCalls = 0;
  let createCalls = 0;
  const dependencies = {
    listNames: async () => {
      listCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    },
    createName: async () => {
      createCalls += 1;
      return personName({ id: "created-once", sourceFindingId: input.findingId });
    },
  };

  const [left, right] = await Promise.all([
    ensureFindingDocumentPersonName(input, dependencies),
    ensureFindingDocumentPersonName(input, dependencies),
  ]);

  assert.equal(listCalls, 1);
  assert.equal(createCalls, 1);
  assert.equal(left.name.id, "created-once");
  assert.equal(right.name.id, "created-once");
});

test("different exact source text is not silently collapsed", async () => {
  let createCalls = 0;
  const dependencies = {
    listNames: async () => [],
    createName: async ({ draft }: { draft: ReturnType<typeof findingDocumentPersonNameDraft> }) => {
      createCalls += 1;
      return personName({ id: `name-${createCalls}`, originalText: draft.originalText });
    },
  };

  await ensureFindingDocumentPersonName({ ...baseInput, originalText: "Іоаннъ" }, dependencies);
  await ensureFindingDocumentPersonName({ ...baseInput, originalText: " Іоаннъ" }, dependencies);
  assert.equal(createCalls, 2);
});

test("an exact retry surfaces a conflicting normalized spelling", async () => {
  await assert.rejects(
    ensureFindingDocumentPersonName(baseInput, {
      listNames: async () => [personName({ fullNormalized: "Іван Калинський" })],
      createName: async () => personName(),
    }),
    /вже прив’язане як «Іван Калинський»/,
  );
});

test("finding UI requires persistence and explicit confirmation before the name write", () => {
  const source = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Спочатку збережіть знахідку/);
  assert.match(source, /Точне написання у джерелі/);
  assert.match(source, /Нормалізоване повне ім’я/);
  assert.match(source, /Підтверджую, що поле «Точне написання у джерелі» перевірено/);
  assert.match(source, /targetMode: "existing"/);
  assert.match(source, /targetMode: "new"/);
  assert.match(source, /<fieldset disabled=\{findingNamePending\}>/);
  assert.match(
    source,
    /const findingSaved = await persistExistingFindingDraft\(nextForm\);[\s\S]*?await ensureFindingDocumentPersonName\(/,
  );

  const personForm = readFileSync(new URL("../src/components/PersonFormModal.tsx", import.meta.url), "utf8");
  assert.match(personForm, /const draftPersonIdRef = useRef\(person\?\.id \?\? createId\(\)\)/);
  assert.match(personForm, /if \(savePendingRef\.current\) return/);
  assert.match(personForm, /disabled=\{savePending\}/);
});
