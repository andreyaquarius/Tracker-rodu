import type { CustomFieldValues, Person } from "../types";
import {
  GEDCOM_EDUCATION_CUSTOM_FIELD,
  GEDCOM_NATIONALITY_CUSTOM_FIELD,
  parseGedcomMetadata,
  stringifyGedcomMetadata,
} from "./gedcomMetadata.ts";

export function personNationality(person: Pick<Person, "customFields">): string {
  const value = person.customFields?.[GEDCOM_NATIONALITY_CUSTOM_FIELD];
  return typeof value === "string" ? value.trim() : "";
}

export function personEducation(person: Pick<Person, "customFields">): string[] {
  const value = person.customFields?.[GEDCOM_EDUCATION_CUSTOM_FIELD];
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = parseGedcomMetadata<unknown>(value, null);
  if (Array.isArray(parsed)) {
    return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return value.split(/[;\n]+/).map((item) => item.trim()).filter(Boolean);
}

export function withPersonStandardFields(
  customFields: CustomFieldValues,
  values: { nationality: string; education: string | string[] },
): CustomFieldValues {
  const education = Array.isArray(values.education)
    ? values.education
    : values.education.split(/[;\n]+/);
  return {
    ...customFields,
    [GEDCOM_NATIONALITY_CUSTOM_FIELD]: values.nationality.trim(),
    [GEDCOM_EDUCATION_CUSTOM_FIELD]: stringifyGedcomMetadata(
      education.map((item) => item.trim()).filter(Boolean),
    ),
  };
}
