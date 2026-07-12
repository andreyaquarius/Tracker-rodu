import type { Person } from "../types";
import type { GedcomImportDraft } from "../types/familyTree";
import type { GedcomAppImportBuildResult } from "./gedcomAppImport";

export type GedcomImportReport = {
  persons: number;
  relations: number;
  findings: number;
  families: number;
  livingPersons: number;
  deceasedPersons: number;
  unknownVitalStatusPersons: number;
  warnings: number;
  potentialDuplicates: number;
  sources: number;
  citations: number;
  media: number;
  preservedRecords: number;
};

export function buildGedcomImportReport(
  draft: GedcomImportDraft,
  built: GedcomAppImportBuildResult,
): GedcomImportReport {
  const vitalStats = draft.people.reduce(
    (acc, person) => {
      if (person.isLiving) acc.livingPersons += 1;
      else if (person.events.some((event) => ["death", "burial", "cremation"].includes(event.eventType))) {
        acc.deceasedPersons += 1;
      } else {
        acc.unknownVitalStatusPersons += 1;
      }
      return acc;
    },
    { livingPersons: 0, deceasedPersons: 0, unknownVitalStatusPersons: 0 },
  );

  return {
    persons: built.people.length,
    relations: built.relations.length,
    findings: built.findings.length,
    families: draft.families.length,
    livingPersons: vitalStats.livingPersons,
    deceasedPersons: vitalStats.deceasedPersons,
    unknownVitalStatusPersons: vitalStats.unknownVitalStatusPersons,
    warnings: built.warnings.length,
    potentialDuplicates: countPotentialDuplicatePeople(built.people),
    sources: draft.sources?.length ?? 0,
    citations: draft.people.reduce(
      (total, person) => total + (person.citations?.length ?? 0) + person.events.reduce(
        (eventTotal, event) => eventTotal + (event.citations?.length ?? 0),
        0,
      ),
      0,
    ),
    media: draft.people.reduce(
      (total, person) => total + (person.media?.length ?? 0) + person.events.reduce(
        (eventTotal, event) => eventTotal + (event.media?.length ?? 0),
        0,
      ),
      0,
    ),
    preservedRecords: draft.preservedRecords?.length ?? 0,
  };
}

export function formatGedcomImportReport(report: GedcomImportReport): string {
  return [
    `Осіб: ${report.persons}`,
    `Зв’язків: ${report.relations}`,
    `Сімей: ${report.families}`,
    `Джерел: ${report.sources}`,
    `Цитувань: ${report.citations}`,
    `Медіафайлів: ${report.media}`,
    `Архівовано сирих записів: ${report.preservedRecords}`,
    `Створено знахідок: ${report.findings}`,
    `Живих: ${report.livingPersons}`,
    `Померлих: ${report.deceasedPersons}`,
    `Невідомий статус: ${report.unknownVitalStatusPersons}`,
    `Можливих дублів: ${report.potentialDuplicates}`,
    `Попереджень: ${report.warnings}`,
  ].join("\n");
}

function countPotentialDuplicatePeople(people: Person[]): number {
  const groups = new Map<string, number>();
  for (const person of people) {
    const name = normalizePersonName(person);
    if (name.length < 5) continue;
    const birthYear = person.birthDate.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)?.[1] ?? "unknown";
    const key = `${name}|${birthYear}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return Array.from(groups.values()).filter((count) => count > 1).length;
}

function normalizePersonName(person: Person): string {
  return (person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" "))
    .toLocaleLowerCase("uk")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
