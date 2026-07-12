export const GEDCOM_XREF_CUSTOM_FIELD = "__gedcomXref";
export const GEDCOM_RIN_CUSTOM_FIELD = "__gedcomRin";
export const GEDCOM_UID_CUSTOM_FIELD = "__gedcomUid";
export const GEDCOM_VITAL_STATUS_CUSTOM_FIELD = "__gedcomVitalStatus";
export const GEDCOM_NATIONALITY_CUSTOM_FIELD = "__gedcomNationality";
export const GEDCOM_EDUCATION_CUSTOM_FIELD = "__gedcomEducation";
export const GEDCOM_CITATIONS_CUSTOM_FIELD = "__gedcomCitations";
export const GEDCOM_MEDIA_CUSTOM_FIELD = "__gedcomMedia";
export const GEDCOM_RAW_RECORD_CUSTOM_FIELD = "__gedcomRawRecord";
export const GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD = "__gedcomImportSourceKey";
export const GEDCOM_ARCHIVE_REFERENCE_CUSTOM_FIELD = "__gedcomArchiveReference";
export const GEDCOM_ARCHIVE_ACT_RECORD_CUSTOM_FIELD = "__gedcomArchiveActRecord";

export function stringifyGedcomMetadata(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseGedcomMetadata<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
