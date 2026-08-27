import type { PersonName } from "../types";
import type { ProjectPersonNameDraft } from "./projectPersonNames.ts";

export interface FindingDocumentPersonNameInput {
  projectId: string;
  personId: string;
  findingId: string;
  documentId: string | null;
  /** Exact source spelling as confirmed by the user. Never normalize this value. */
  originalText: string;
  /** User-editable normalized/display spelling. */
  normalizedFullName: string;
  surname: string;
  givenName: string;
  patronymic: string;
}

export interface FindingDocumentPersonNameResult {
  name: PersonName;
  created: boolean;
}

export interface FindingPersonNameDependencies {
  listNames: (projectId: string, personId: string) => Promise<PersonName[]>;
  createName: (input: {
    projectId: string;
    personId: string;
    draft: ProjectPersonNameDraft;
  }) => Promise<PersonName>;
}

const pendingByExactSource = new Map<string, Promise<FindingDocumentPersonNameResult>>();

/**
 * Builds a non-primary, source-linked spelling. `originalText` is deliberately
 * copied byte-for-byte; only the separate normalized value is cleaned for display.
 */
export function findingDocumentPersonNameDraft(
  input: FindingDocumentPersonNameInput,
): ProjectPersonNameDraft {
  const normalizedFullName = input.normalizedFullName.trim().replace(/\s+/g, " ");
  if (!input.projectId || !input.personId || !input.findingId) {
    throw new Error("Для прив’язки імені потрібні збережені проєкт, особа та знахідка.");
  }
  if (!input.originalText.trim()) {
    throw new Error("Збережіть точне написання імені з джерела.");
  }
  if (!normalizedFullName) {
    throw new Error("Вкажіть нормалізоване повне ім’я.");
  }

  return {
    nameType: "document",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: input.surname.trim(),
    maidenSurname: "",
    givenName: input.givenName.trim(),
    patronymic: input.patronymic.trim(),
    prefix: "",
    suffix: "",
    nickname: "",
    fullName: normalizedFullName,
    fullNormalized: normalizedFullName,
    // Do not trim, collapse whitespace, transliterate, or otherwise alter this field.
    originalText: input.originalText,
    orthography: "",
    validFrom: "",
    validTo: "",
    datePrecision: "unknown",
    isPreferred: false,
    isSearchable: true,
    sourceDocumentId: input.documentId || null,
    sourceFindingId: input.findingId,
    sourceType: "finding",
    sourceId: input.findingId,
    citationId: null,
    documentFragmentId: null,
    evidenceStatus: "unknown",
    confidence: 50,
    notes: "Написання підтверджено користувачем у збереженій знахідці.",
    metadata: {
      captureWorkflow: "finding_person_name_v1",
      exactOriginalConfirmed: true,
    },
  };
}

export function findingPersonNameDedupeKey(input: FindingDocumentPersonNameInput): string {
  return JSON.stringify([
    input.projectId,
    input.personId,
    input.findingId,
    input.originalText,
  ]);
}

/**
 * Retry-safe browser workflow guard. It checks persisted names and also shares
 * an in-flight request so a double click cannot create two identical rows.
 */
export async function ensureFindingDocumentPersonName(
  input: FindingDocumentPersonNameInput,
  dependencies: FindingPersonNameDependencies,
): Promise<FindingDocumentPersonNameResult> {
  const draft = findingDocumentPersonNameDraft(input);
  const key = findingPersonNameDedupeKey(input);
  const pending = pendingByExactSource.get(key);
  if (pending) return pending;

  const request = (async () => {
    const names = await dependencies.listNames(input.projectId, input.personId);
    const existing = names.find((name) => (
      name.personId === input.personId
      && name.sourceFindingId === input.findingId
      && name.originalText === input.originalText
    ));
    if (existing) {
      const existingNormalized = (existing.fullNormalized || existing.fullName).trim().replace(/\s+/g, " ");
      if (existingNormalized && existingNormalized !== draft.fullNormalized) {
        throw new Error(
          `Це точне написання вже прив’язане як «${existingNormalized}». ` +
          "Щоб змінити нормалізований варіант, відкрийте імена в картці особи.",
        );
      }
      return { name: existing, created: false };
    }

    const name = await dependencies.createName({
      projectId: input.projectId,
      personId: input.personId,
      draft,
    });
    return { name, created: true };
  })();

  pendingByExactSource.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingByExactSource.get(key) === request) pendingByExactSource.delete(key);
  }
}
