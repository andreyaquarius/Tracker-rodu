import type { PersonName } from "../types/index.ts";

/**
 * Version 5 predates the serialized `personNames` collection. Missing data is
 * therefore a valid old backup, while a present malformed collection must be
 * rejected before restore clears any project rows.
 */
export function normalizeBackupPersonNames(value: unknown): PersonName[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Резервна копія містить пошкоджений список історичних імен.");
  }
  return value.map((item, index) => normalizeBackupPersonName(item, index));
}

function normalizeBackupPersonName(value: unknown, index: number): PersonName {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Резервна копія містить пошкоджений варіант імені №${index + 1}.`);
  }
  const item = value as Partial<PersonName>;
  if (!nonEmptyString(item.id) || !nonEmptyString(item.personId)) {
    throw new Error(`Варіант імені №${index + 1} не має коректного ідентифікатора особи.`);
  }
  const createdAt = stringOrEmpty(item.createdAt) || new Date().toISOString();
  return {
    id: item.id,
    projectId: stringOrEmpty(item.projectId),
    personId: item.personId,
    nameType: nonEmptyString(item.nameType) ? item.nameType : "unknown",
    languageCode: stringOrEmpty(item.languageCode),
    scriptCode: stringOrEmpty(item.scriptCode),
    surname: stringOrEmpty(item.surname),
    maidenSurname: stringOrEmpty(item.maidenSurname),
    givenName: stringOrEmpty(item.givenName),
    patronymic: stringOrEmpty(item.patronymic),
    prefix: stringOrEmpty(item.prefix),
    suffix: stringOrEmpty(item.suffix),
    nickname: stringOrEmpty(item.nickname),
    fullName: stringOrEmpty(item.fullName),
    fullNormalized: stringOrEmpty(item.fullNormalized),
    // Never trim, normalize or case-fold the source spelling.
    originalText: stringOrEmpty(item.originalText),
    orthography: stringOrEmpty(item.orthography),
    validFrom: stringOrEmpty(item.validFrom),
    validTo: stringOrEmpty(item.validTo),
    datePrecision: nonEmptyString(item.datePrecision) ? item.datePrecision : "unknown",
    isPrimary: item.isPrimary === true,
    isPreferred: item.isPreferred === true,
    isSearchable: item.isSearchable !== false,
    evidenceStatus: nonEmptyString(item.evidenceStatus) ? item.evidenceStatus : "unknown",
    confidence: Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(100, Math.round(item.confidence!)))
      : 50,
    sourceDocumentId: nullableBackupString(item.sourceDocumentId),
    sourceFindingId: nullableBackupString(item.sourceFindingId),
    sourceType: stringOrEmpty(item.sourceType),
    sourceId: nullableBackupString(item.sourceId),
    citationId: nullableBackupString(item.citationId),
    documentFragmentId: nullableBackupString(item.documentFragmentId),
    notes: stringOrEmpty(item.notes),
    metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? { ...item.metadata }
      : {},
    createdBy: nullableBackupString(item.createdBy),
    lockVersion: Number.isInteger(item.lockVersion) && item.lockVersion! > 0
      ? item.lockVersion!
      : 1,
    createdAt,
    updatedAt: stringOrEmpty(item.updatedAt) || createdAt,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableBackupString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
