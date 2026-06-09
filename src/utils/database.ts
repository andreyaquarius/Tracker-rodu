import type {
  AppDatabase,
  CustomFieldDefinition,
  CustomFieldModule,
  CustomFieldType,
  CustomSectionDefinition,
  CustomSectionField,
  CustomSectionRecord,
  FindingParticipant,
} from "../types";
import { nowIso } from "./dateHelpers";
import { createId } from "./id";
import { participantSummary } from "./findingParticipants";
import { normalizeCustomFieldValues } from "./customFields";

export function createEmptyDatabase(): AppDatabase {
  return {
    version: 5,
    appName: "Трекер Роду",
    tagline: "Не губи сліди свого роду",
    updatedAt: nowIso(),
    researches: [],
    documents: [],
    yearMatrix: [],
    tasks: [],
    findings: [],
    hypotheses: [],
    archiveRequests: [],
    persons: [],
    personRelations: [],
    customSections: [],
    customSectionRecords: [],
    activityLog: [],
    settings: {
      researcherName: "",
      compactTables: false,
      lastAutomaticBackupAt: null,
      customFields: [],
    },
  };
}

export function normalizeDatabase(value: unknown): AppDatabase {
  if (!value || typeof value !== "object") {
    throw new Error("Файл не містить коректної бази даних.");
  }
  const candidate = value as Omit<Partial<AppDatabase>, "version"> & { version?: number };
  const supportedAppName =
    candidate.appName === "Трекер Роду" ||
    (candidate.appName as string | undefined) === "Родовий Навігатор";
  if (
    !supportedAppName ||
    (
      candidate.version !== 1 &&
      candidate.version !== 2 &&
      candidate.version !== 3 &&
      candidate.version !== 4 &&
      candidate.version !== 5
    )
  ) {
    throw new Error("Непідтримуваний формат або версія бази.");
  }
  const empty = createEmptyDatabase();
  const hypotheses = (Array.isArray(candidate.hypotheses) ? candidate.hypotheses : []).map((item) => ({
    ...item,
    documentIds: normalizeIds(item.documentIds),
    findingIds: normalizeIds(item.findingIds),
    personIds: normalizeIds(item.personIds),
    customFields: normalizeCustomFieldValues(item.customFields),
  }));
  const yearMatrix = (Array.isArray(candidate.yearMatrix) ? candidate.yearMatrix : []).map((item) => ({
    ...item,
    documentId: typeof item.documentId === "string" ? item.documentId : "",
    customFields: normalizeCustomFieldValues(item.customFields),
  }));
  const documents = (Array.isArray(candidate.documents) ? candidate.documents : []).map((item) => ({
    ...item,
    scans: Array.isArray(item.scans) ? item.scans : [],
    customFields: normalizeCustomFieldValues(item.customFields),
  }));
  const findings = (Array.isArray(candidate.findings) ? candidate.findings : []).map((item) => {
    const participants = normalizeParticipants(item.participants, item.people);
    return {
      ...item,
      participants,
      people: participantSummary(participants),
      personsText: typeof item.personsText === "string" ? item.personsText : item.people ?? "",
      personIds: normalizeIds(item.personIds),
      scans: Array.isArray(item.scans) ? item.scans : [],
      customFields: normalizeCustomFieldValues(item.customFields),
    };
  });
  const tasks = (Array.isArray(candidate.tasks) ? candidate.tasks : []).map((item) => ({
    ...item,
    personIds: normalizeIds(item.personIds),
    customFields: normalizeCustomFieldValues(item.customFields),
  }));
  const archiveRequests = (
    Array.isArray(candidate.archiveRequests) ? candidate.archiveRequests : []
  ).map((item) => ({
    ...item,
    personIds: normalizeIds(item.personIds),
    archiveDetails: typeof item.archiveDetails === "string" ? item.archiveDetails : "",
    responseDate: typeof item.responseDate === "string" ? item.responseDate : "",
    requestScans: Array.isArray(item.requestScans) ? item.requestScans : [],
    responseScans: Array.isArray(item.responseScans) ? item.responseScans : [],
    customFields: normalizeCustomFieldValues(item.customFields),
  }));
  const persons = (Array.isArray(candidate.persons) ? candidate.persons : []).map((item) => ({
    ...item,
    birthScans: Array.isArray(item.birthScans) ? item.birthScans : [],
    marriageScans: Array.isArray(item.marriageScans) ? item.marriageScans : [],
    deathScans: Array.isArray(item.deathScans) ? item.deathScans : [],
    mentionScans: Array.isArray(item.mentionScans) ? item.mentionScans : [],
    customFields: normalizeCustomFieldValues(item.customFields),
  }));
  const researches = (Array.isArray(candidate.researches) ? candidate.researches : []).map((item) => ({
    ...item,
    customFields: normalizeCustomFieldValues(item.customFields),
  }));
  const customSections = normalizeCustomSections(candidate.customSections);
  const sectionIds = new Set(customSections.map((section) => section.id));
  const customSectionRecords = normalizeCustomSectionRecords(
    candidate.customSectionRecords,
    sectionIds,
  );
  return {
    ...empty,
    ...candidate,
    version: 5,
    appName: "Трекер Роду",
    tagline: "Не губи сліди свого роду",
    researches,
    documents,
    yearMatrix,
    tasks,
    findings,
    hypotheses,
    archiveRequests,
    persons,
    personRelations: Array.isArray(candidate.personRelations) ? candidate.personRelations : [],
    customSections,
    customSectionRecords,
    activityLog: Array.isArray(candidate.activityLog) ? candidate.activityLog : [],
    settings: {
      ...empty.settings,
      ...(candidate.settings ?? {}),
      customFields: normalizeCustomFieldDefinitions(candidate.settings?.customFields),
    },
  };
}

function normalizeCustomSections(value: unknown): CustomSectionDefinition[] {
  if (!Array.isArray(value)) return [];
  const types = new Set([
    "text",
    "textarea",
    "number",
    "year",
    "date",
    "time",
    "approximate-date",
    "place",
    "select",
    "multiselect",
    "boolean",
    "url",
    "email",
    "tel",
    "attachments",
    "relation",
    "url",
    "attachments",
    "relation",
  ]);
  return value
    .filter((item): item is Partial<CustomSectionDefinition> => Boolean(item && typeof item === "object"))
    .filter((item) => typeof item.id === "string" && typeof item.name === "string")
    .map((item) => {
      const fields = Array.isArray(item.fields)
        ? item.fields
          .filter((field) => Boolean(field && typeof field === "object"))
          .filter(
            (field) =>
              typeof field.id === "string" &&
              typeof field.label === "string" &&
              typeof field.type === "string" &&
              types.has(field.type),
          )
          .map((field) => ({
            id: field.id!,
            label: field.label!.trim() || "Поле",
            type: field.type as CustomSectionField["type"],
            required: Boolean(field.required),
            options: Array.isArray(field.options)
              ? field.options.filter((option): option is string => typeof option === "string")
              : [],
            relationTarget: typeof field.relationTarget === "string"
              ? field.relationTarget
              : undefined,
          }))
        : [];
      return {
        id: item.id!,
        name: item.name!.trim() || "Власний розділ",
        singularName: typeof item.singularName === "string" && item.singularName.trim()
          ? item.singularName.trim()
          : "запис",
        description: typeof item.description === "string" ? item.description : "",
        icon: normalizeSectionIcon(item.icon),
        titleFieldId: typeof item.titleFieldId === "string" && fields.some((field) => field.id === item.titleFieldId)
          ? item.titleFieldId
          : fields[0]?.id ?? "",
        fields,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
      };
    });
}

function normalizeSectionIcon(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "folder";
  const icon = value.trim();
  const legacy: Record<string, string> = {
    Р: "folder",
    І: "village",
    Б: "building",
    Х: "calendar",
    У: "landmark",
    С: "microphone",
  };
  return legacy[icon] ?? icon;
}

function normalizeCustomSectionRecords(
  value: unknown,
  sectionIds: Set<string>,
): CustomSectionRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<CustomSectionRecord> => Boolean(item && typeof item === "object"))
    .filter(
      (item) =>
        typeof item.id === "string" &&
        typeof item.sectionId === "string" &&
        sectionIds.has(item.sectionId),
    )
    .map((item) => ({
      id: item.id!,
      sectionId: item.sectionId!,
      values: item.values && typeof item.values === "object" && !Array.isArray(item.values)
        ? item.values as CustomSectionRecord["values"]
        : {},
      createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
    }));
}

function normalizeCustomFieldDefinitions(value: unknown): CustomFieldDefinition[] {
  if (!Array.isArray(value)) return [];
  const modules = new Set<CustomFieldModule>([
    "researches",
    "documents",
    "persons",
    "findings",
    "tasks",
    "hypotheses",
    "archiveRequests",
    "yearMatrix",
  ]);
  const types = new Set<CustomFieldType>([
    "text",
    "textarea",
    "number",
    "date",
    "select",
    "boolean",
  ]);
  return value
    .filter((item): item is Partial<CustomFieldDefinition> => Boolean(item && typeof item === "object"))
    .filter(
      (item) =>
        typeof item.id === "string" &&
        typeof item.module === "string" &&
        modules.has(item.module as CustomFieldModule) &&
        typeof item.label === "string" &&
        item.label.trim() !== "" &&
        typeof item.type === "string" &&
        types.has(item.type as CustomFieldType),
    )
    .map((item) => ({
      id: item.id!,
      module: item.module as CustomFieldModule,
      label: item.label!.trim(),
      type: item.type as CustomFieldType,
      options: Array.isArray(item.options)
        ? item.options.filter((option): option is string => typeof option === "string" && option.trim() !== "")
        : [],
      relationTarget: typeof item.relationTarget === "string"
        ? item.relationTarget
        : undefined,
    }));
}

function normalizeParticipants(value: unknown, legacyPeople: unknown): FindingParticipant[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Partial<FindingParticipant> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        id: typeof item.id === "string" && item.id ? item.id : createId(),
        role: typeof item.role === "string" && item.role ? item.role : "Інша особа",
        name: typeof item.name === "string" ? item.name : "",
        notes: typeof item.notes === "string" ? item.notes : "",
      }));
  }
  if (typeof legacyPeople === "string" && legacyPeople.trim()) {
    return [{
      id: createId(),
      role: "Згадана особа",
      name: legacyPeople.trim(),
      notes: "Перенесено зі старого поля осіб",
    }];
  }
  return [];
}

function normalizeIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
