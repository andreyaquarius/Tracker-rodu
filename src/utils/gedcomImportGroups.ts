import type { Finding, Person, PersonRelation } from "../types";
import {
  GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD,
  GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD,
} from "./gedcomMetadata.ts";

export interface GedcomImportGroup {
  sourceKey: string;
  fileName: string;
  personIds: string[];
  relationIds: string[];
  findingIds: string[];
  personCount: number;
  relationCount: number;
  findingCount: number;
  importedAt: string;
}

export interface GedcomImportDatasetMarker {
  sourceKey: string;
  importedAt: string;
}

export function gedcomImportSourceKey(person: Person): string {
  const value = person.customFields?.[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD];
  return typeof value === "string" ? value.trim() : "";
}

export function buildGedcomImportGroups(
  persons: readonly Person[],
  relations: readonly PersonRelation[],
  findings: readonly Finding[] = [],
  datasetMarkers: readonly GedcomImportDatasetMarker[] = [],
): GedcomImportGroup[] {
  const groups = new Map<string, {
    sourceKey: string;
    fileName: string;
    personIds: string[];
    relationIds: string[];
    findingIds: string[];
    importedAt: string;
  }>();

  const ensureGroup = (sourceKey: string, fileName = "", importedAt = "") => {
    const existing = groups.get(sourceKey);
    if (existing) {
      if (!existing.fileName && fileName) existing.fileName = fileName;
      if (importedAt && (!existing.importedAt || importedAt < existing.importedAt)) {
        existing.importedAt = importedAt;
      }
      return existing;
    }
    const created = {
      sourceKey,
      fileName,
      personIds: [] as string[],
      relationIds: [] as string[],
      findingIds: [] as string[],
      importedAt,
    };
    groups.set(sourceKey, created);
    return created;
  };

  for (const person of persons) {
    const sourceKey = gedcomImportSourceKey(person);
    if (!sourceKey) continue;
    const rawFileName = person.customFields?.[GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD];
    const fileName = typeof rawFileName === "string" ? rawFileName.trim() : "";
    ensureGroup(sourceKey, fileName, person.createdAt).personIds.push(person.id);
  }

  for (const relation of relations) {
    const sourceKey = relation.gedcomMetadata?.importSourceKey?.trim() ?? "";
    if (!sourceKey) continue;
    ensureGroup(
      sourceKey,
      relation.gedcomMetadata?.importFileName?.trim() ?? "",
      relation.createdAt,
    ).relationIds.push(relation.id);
  }

  for (const finding of findings) {
    const rawSourceKey = finding.customFields?.[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD];
    const sourceKey = typeof rawSourceKey === "string" ? rawSourceKey.trim() : "";
    if (!sourceKey) continue;
    const rawFileName = finding.customFields?.[GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD];
    ensureGroup(
      sourceKey,
      typeof rawFileName === "string" ? rawFileName.trim() : "",
      finding.createdAt,
    ).findingIds.push(finding.id);
  }

  for (const marker of datasetMarkers) {
    const sourceKey = marker.sourceKey.trim();
    if (!sourceKey) continue;
    ensureGroup(sourceKey, "", marker.importedAt);
  }

  return [...groups.values()]
    .map((group) => {
      const personIds = new Set(group.personIds);
      const relationIds = new Set(group.relationIds);
      for (const relation of relations) {
        if (personIds.has(relation.personId) || personIds.has(relation.relatedPersonId)) {
          relationIds.add(relation.id);
        }
      }
      return {
        ...group,
        personIds: group.personIds,
        relationIds: [...relationIds],
        findingIds: group.findingIds,
        personCount: group.personIds.length,
        relationCount: relationIds.size,
        findingCount: group.findingIds.length,
      };
    })
    .sort((left, right) => (
      right.importedAt.localeCompare(left.importedAt)
      || left.fileName.localeCompare(right.fileName, "uk")
      || left.sourceKey.localeCompare(right.sourceKey)
    ));
}

export function gedcomImportDisplayName(group: GedcomImportGroup, index: number): string {
  if (group.fileName) return group.fileName;
  return `GEDCOM-імпорт ${index + 1}`;
}
