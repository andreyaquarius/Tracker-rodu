import type {
  AppDatabase,
  AppEntity,
  ArchiveRequest,
  CollectionKey,
  DocumentRecord,
  Finding,
  Hypothesis,
  Person,
  Research,
  TaskRecord,
  YearMatrixRecord,
} from "../types";
import type { PageKey } from "../components/Sidebar";
import { primaryParticipantName } from "./findingParticipants";

export interface GlobalSearchResult {
  id: string;
  module: CollectionKey;
  page: PageKey;
  moduleLabel: string;
  title: string;
  description: string;
  searchText: string;
}

const moduleLabels: Record<CollectionKey, string> = {
  researches: "Дослідження",
  documents: "Документи",
  yearMatrix: "Матриця років",
  tasks: "Завдання",
  findings: "Знахідки",
  hypotheses: "Гіпотези",
  archiveRequests: "Запити в архів",
  persons: "Особи",
};

export function searchDatabase(db: AppDatabase, query: string): GlobalSearchResult[] {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length < 2) return [];

  const results: GlobalSearchResult[] = [];
  const addCollection = (collection: CollectionKey, items: AppEntity[]) => {
    for (const entity of items) {
      const result = createResult(db, collection, entity);
      if (result.searchText.includes(normalizedQuery)) results.push(result);
    }
  };

  addCollection("researches", db.researches);
  addCollection("documents", db.documents);
  addCollection("yearMatrix", db.yearMatrix);
  addCollection("tasks", db.tasks);
  addCollection("findings", db.findings);
  addCollection("hypotheses", db.hypotheses);
  addCollection("archiveRequests", db.archiveRequests);
  addCollection("persons", db.persons);

  return results
    .sort((a, b) => relevance(b, normalizedQuery) - relevance(a, normalizedQuery))
    .slice(0, 30);
}

function createResult(
  db: AppDatabase,
  module: CollectionKey,
  entity: AppEntity,
): GlobalSearchResult {
  const research = "researchId" in entity
    ? db.researches.find((item) => item.id === entity.researchId)
    : undefined;
  const relatedText = relationText(db, entity);
  return {
    id: entity.id,
    module,
    page: module,
    moduleLabel: moduleLabels[module],
    title: entityTitle(module, entity),
    description: entityDescription(module, entity, research),
    searchText: normalize(`${flatten(entity)} ${research?.title ?? ""} ${relatedText}`),
  };
}

function entityTitle(module: CollectionKey, entity: AppEntity): string {
  switch (module) {
    case "researches":
      return (entity as Research).title || "Дослідження без назви";
    case "documents":
      return (entity as DocumentRecord).title || "Документ без назви";
    case "yearMatrix": {
      const year = entity as YearMatrixRecord;
      return `${year.year || "Рік не вказано"} · ${year.documentType || "Тип не вказано"}`;
    }
    case "tasks":
      return (entity as TaskRecord).title || "Завдання без назви";
    case "findings": {
      const finding = entity as Finding;
      return primaryParticipantName(finding.participants) || finding.summary || "Знахідка";
    }
    case "hypotheses":
      return (entity as Hypothesis).title || "Гіпотеза без назви";
    case "archiveRequests": {
      const request = entity as ArchiveRequest;
      return request.subject || `Запит до ${request.archive || "архіву"}`;
    }
    case "persons": {
      const person = entity as Person;
      return person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") || "Особа без імені";
    }
  }
}

function entityDescription(
  module: CollectionKey,
  entity: AppEntity,
  research?: Research,
): string {
  switch (module) {
    case "researches": {
      const item = entity as Research;
      return [item.surnames, item.places, item.status].filter(Boolean).join(" · ");
    }
    case "documents": {
      const item = entity as DocumentRecord;
      return [item.documentType, period(item.yearFrom, item.yearTo), item.archive, item.place]
        .filter(Boolean).join(" · ");
    }
    case "yearMatrix": {
      const item = entity as YearMatrixRecord;
      return [research?.title, item.place, item.status].filter(Boolean).join(" · ");
    }
    case "tasks": {
      const item = entity as TaskRecord;
      return [item.personName, item.place, item.priority, item.status].filter(Boolean).join(" · ");
    }
    case "findings": {
      const item = entity as Finding;
      return [item.findingType, item.eventDate, item.place, research?.title].filter(Boolean).join(" · ");
    }
    case "hypotheses": {
      const item = entity as Hypothesis;
      return [item.relatedPeople, item.probability, item.status].filter(Boolean).join(" · ");
    }
    case "archiveRequests": {
      const item = entity as ArchiveRequest;
      return [item.archive, item.requestDate, item.status, research?.title].filter(Boolean).join(" · ");
    }
    case "persons": {
      const item = entity as Person;
      const years = [
        item.birthDate?.slice(0, 4) || item.birthYearFrom,
        item.deathDate?.slice(0, 4) || item.deathYearTo,
      ].filter(Boolean).join("–");
      return [years, item.birthPlace, item.residencePlaces, item.status].filter(Boolean).join(" · ");
    }
  }
}

function relationText(db: AppDatabase, entity: AppEntity): string {
  const record = entity as unknown as Record<string, unknown>;
  const ids = [
    typeof record.documentId === "string" ? record.documentId : "",
    ...(Array.isArray(record.documentIds) ? record.documentIds : []),
  ].filter((value): value is string => typeof value === "string" && Boolean(value));
  const findingIds = Array.isArray(record.findingIds) ? record.findingIds : [];
  const personIds = Array.isArray(record.personIds) ? record.personIds : [];
  return [
    ...db.documents.filter((item) => ids.includes(item.id)).map((item) => flatten(item)),
    ...db.findings
      .filter((item) => findingIds.includes(item.id))
      .map((item) => flatten(item)),
    ...db.persons
      .filter((item) => personIds.includes(item.id))
      .map((item) => flatten(item)),
  ].join(" ");
}

function flatten(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (typeof value === "object") return Object.values(value).map(flatten).join(" ");
  return "";
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("uk");
}

function relevance(result: GlobalSearchResult, query: string): number {
  const title = normalize(result.title);
  if (title === query) return 4;
  if (title.startsWith(query)) return 3;
  if (title.includes(query)) return 2;
  return 1;
}

function period(from: string, to: string): string {
  if (from && to && from !== to) return `${from}–${to}`;
  return from || to;
}
