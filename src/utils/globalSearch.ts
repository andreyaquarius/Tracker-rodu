import Fuse, { type FuseResultMatch, type IFuseOptions } from "fuse.js";
import type {
  AppDatabase,
  AppEntity,
  ArchiveRequest,
  CollectionKey,
  CustomFieldDefinition,
  CustomFieldModule,
  CustomSectionField,
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
import { customRecordSearchText, customRecordTitle } from "./customSections";
import { customFieldModuleLabels } from "./customFields";
import { sectionAncestors } from "./sectionHierarchy";

export type HighlightRange = readonly [number, number];

export interface GlobalSearchResult {
  id: string;
  entityId?: string;
  module: string;
  page: PageKey;
  moduleLabel: string;
  title: string;
  description: string;
  titleMatches: HighlightRange[];
  descriptionMatches: HighlightRange[];
}

interface SearchDocument {
  id: string;
  entityId?: string;
  module: string;
  page: PageKey;
  moduleLabel: string;
  title: string;
  description: string;
  searchText: string;
}

export interface GlobalSearchIndex {
  search: (query: string) => GlobalSearchResult[];
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

const fuseOptions: IFuseOptions<SearchDocument> = {
  keys: [
    { name: "title", weight: 0.45 },
    { name: "description", weight: 0.25 },
    { name: "searchText", weight: 0.3 },
  ],
  includeMatches: true,
  includeScore: true,
  ignoreLocation: true,
  isCaseSensitive: false,
  minMatchCharLength: 2,
  threshold: 0.35,
};

export function createGlobalSearchIndex(db: AppDatabase): GlobalSearchIndex {
  const documents: SearchDocument[] = [];
  const addCollection = (collection: CollectionKey, items: AppEntity[]) => {
    for (const entity of items) documents.push(createDocument(db, collection, entity));
  };

  addCollection("researches", db.researches);
  addCollection("documents", db.documents);
  addCollection("yearMatrix", db.yearMatrix);
  addCollection("tasks", db.tasks);
  addCollection("findings", db.findings);
  addCollection("hypotheses", db.hypotheses);
  addCollection("persons", db.persons);
  addCollection("archiveRequests", db.archiveRequests);
  for (const field of db.settings.customFields) {
    documents.push(createCustomFieldDocument(field));
  }
  for (const section of db.customSections) {
    const path = sectionAncestors(db.customSections, section)
      .map((item) => item.label)
      .join(" → ");
    const fieldDefinitions = section.fields
      .map((field) => customSectionFieldSearchText(field))
      .join(" ");
    documents.push({
      id: `section:${section.id}`,
      module: `custom:${section.id}`,
      page: `custom:${section.id}`,
      moduleLabel: "Розділи",
      title: section.name,
      description: [path, section.description].filter(Boolean).join(" · "),
      searchText: `${path} ${section.name} ${section.singularName} ${section.description} ${fieldDefinitions}`,
    });
    for (const field of section.fields) {
      documents.push({
        id: `section-field:${section.id}:${field.id}`,
        module: `custom:${section.id}`,
        page: `custom:${section.id}`,
        moduleLabel: "Поля користувацьких розділів",
        title: field.label,
        description: `Поле розділу «${section.name}»${path ? ` · ${path}` : ""}`,
        searchText: `${path} ${section.name} ${section.description} ${customSectionFieldSearchText(field)}`,
      });
    }
    for (const record of db.customSectionRecords.filter((item) => item.sectionId === section.id)) {
      documents.push({
        id: record.id,
        entityId: record.id,
        module: `custom:${section.id}`,
        page: `custom:${section.id}`,
        moduleLabel: section.name,
        title: customRecordTitle(section, record),
        description: customRecordSearchText(db, section, record),
        searchText: customRecordSearchText(db, section, record),
      });
    }
  }

  const index = Fuse.createIndex(
    ["title", "description", "searchText"],
    documents,
  );
  const fuse = new Fuse(documents, fuseOptions, index);

  return {
    search(query) {
      const trimmed = query.trim();
      if (trimmed.length < 2) return [];
      return fuse.search(trimmed, { limit: 40 }).map(({ item, matches = [] }) => {
        const titleMatches = rangesFor(matches, "title");
        const descriptionRanges = rangesFor(matches, "description");
        if (descriptionRanges.length) {
          return {
            ...publicResult(item),
            description: item.description,
            titleMatches,
            descriptionMatches: descriptionRanges,
          };
        }
        const searchTextMatch = matches.find((match) => match.key === "searchText");
        const snippet = searchTextMatch ? matchSnippet(searchTextMatch) : null;
        return {
          ...publicResult(item),
          description: snippet?.text || item.description,
          titleMatches,
          descriptionMatches: snippet?.ranges ?? [],
        };
      });
    },
  };
}

function createDocument(
  db: AppDatabase,
  module: CollectionKey,
  entity: AppEntity,
): SearchDocument {
  const research = "researchId" in entity
    ? db.researches.find((item) => item.id === entity.researchId)
    : undefined;
  const relatedText = relationText(db, entity);
  const title = entityTitle(module, entity);
  const description = entityDescription(module, entity, research);
  return {
    id: entity.id,
    entityId: entity.id,
    module,
    page: module,
    moduleLabel: moduleLabels[module],
    title,
    description,
    searchText: `${flatten(entity)} ${customFieldValuesSearchText(db, module, entity)} ${research?.title ?? ""} ${relatedText}`.trim(),
  };
}

function createCustomFieldDocument(field: CustomFieldDefinition): SearchDocument {
  const moduleLabel = customFieldModuleLabels[field.module];
  return {
    id: `custom-field:${field.id}`,
    module: field.module,
    page: field.module,
    moduleLabel: "Додаткові поля",
    title: field.label,
    description: `Додаткове поле розділу «${moduleLabel}»`,
    searchText: `${moduleLabel} ${field.label} ${field.type} ${field.options.join(" ")}`,
  };
}

function customFieldValuesSearchText(
  db: AppDatabase,
  module: CustomFieldModule,
  entity: AppEntity,
): string {
  const values = (
    entity as unknown as { customFields?: Record<string, unknown> }
  ).customFields ?? {};
  return db.settings.customFields
    .filter((field) => field.module === module)
    .map((field) => `${field.label} ${field.options.join(" ")} ${flatten(values[field.id])}`)
    .join(" ");
}

function customSectionFieldSearchText(field: CustomSectionField): string {
  return [
    field.label,
    field.type,
    ...field.options,
    field.relationTarget ?? "",
  ].join(" ");
}

function publicResult(item: SearchDocument) {
  return {
    id: item.id,
    entityId: item.entityId,
    module: item.module,
    page: item.page,
    moduleLabel: item.moduleLabel,
    title: item.title,
  };
}

function rangesFor(matches: readonly FuseResultMatch[], key: string): HighlightRange[] {
  return matches
    .filter((match) => match.key === key)
    .flatMap((match) => match.indices);
}

function matchSnippet(match: FuseResultMatch): {
  text: string;
  ranges: HighlightRange[];
} | null {
  const value = match.value ?? "";
  const first = match.indices[0];
  if (!value || !first) return null;
  const start = Math.max(0, first[0] - 38);
  const end = Math.min(value.length, first[1] + 55);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  const text = `${prefix}${value.slice(start, end)}${suffix}`;
  const offset = prefix.length - start;
  const ranges = match.indices
    .filter(([from, to]) => to >= start && from < end)
    .map(([from, to]) => [
      Math.max(0, from + offset),
      Math.min(text.length - 1, to + offset),
    ] as const);
  return { text, ranges };
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
      return person.fullName ||
        [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") ||
        "Особа без імені";
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
    ...db.findings.filter((item) => findingIds.includes(item.id)).map((item) => flatten(item)),
    ...db.persons.filter((item) => personIds.includes(item.id)).map((item) => flatten(item)),
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

function period(from: string, to: string): string {
  if (from && to && from !== to) return `${from}–${to}`;
  return from || to;
}
