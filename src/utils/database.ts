import type {
  AppDatabase,
  CustomFieldDefinition,
  CustomFieldModule,
  CustomFieldValue,
  CustomFieldValues,
  CustomFieldType,
  CustomSectionDefinition,
  CustomSectionField,
  CustomSectionRecord,
  CustomSectionRecordValue,
  FindingParticipant,
  ScanAttachment,
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
  if (
    candidate.appName !== "Трекер Роду" ||
    candidate.version !== 5
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

export function cloneDatabaseForProjectImport(source: AppDatabase): AppDatabase {
  const createMap = (items: Array<{ id: string }>) =>
    new Map(items.map((item) => [item.id, createId()]));
  const researches = createMap(source.researches);
  const documents = createMap(source.documents);
  const yearMatrix = createMap(source.yearMatrix);
  const tasks = createMap(source.tasks);
  const findings = createMap(source.findings);
  const hypotheses = createMap(source.hypotheses);
  const archiveRequests = createMap(source.archiveRequests);
  const persons = createMap(source.persons);
  const personRelations = createMap(source.personRelations);
  const customSections = createMap(source.customSections);
  const customRecords = createMap(source.customSectionRecords);
  const customFieldDefinitions = createMap(source.settings.customFields);
  const sectionFieldIds = new Map<string, string>();

  for (const section of source.customSections) {
    for (const field of section.fields) {
      sectionFieldIds.set(field.id, createId());
    }
  }

  const recordIds = new Map<string, string>([
    ...researches,
    ...documents,
    ...yearMatrix,
    ...tasks,
    ...findings,
    ...hypotheses,
    ...archiveRequests,
    ...persons,
    ...customRecords,
  ]);
  const mapRequired = (map: Map<string, string>, id: string) => {
    const mapped = map.get(id);
    if (!mapped) {
      throw new Error("Резервна копія містить пошкоджене посилання на запис.");
    }
    return mapped;
  };
  const mapReference = (map: Map<string, string>, id: string) =>
    id ? map.get(id) ?? "" : "";
  const mapReferences = (map: Map<string, string>, ids: string[]) =>
    ids.map((id) => map.get(id)).filter((id): id is string => Boolean(id));
  const mapRelationTarget = <T extends string | undefined>(target: T): T => {
    if (!target?.startsWith("custom:")) return target;
    const sectionId = target.slice("custom:".length);
    const mapped = customSections.get(sectionId);
    return (mapped ? `custom:${mapped}` : target) as T;
  };
  const mapScan = (scan: ScanAttachment): ScanAttachment => ({
    ...scan,
    id: createId(),
  });
  const mapScans = (scans: ScanAttachment[]) => scans.map(mapScan);
  const mapFieldValue = (
    type: CustomFieldType,
    value: CustomFieldValue | CustomSectionRecordValue,
  ): CustomFieldValue | CustomSectionRecordValue => {
    if (type === "attachments" && Array.isArray(value)) {
      return value
        .filter((item): item is ScanAttachment =>
          Boolean(item && typeof item === "object" && "storagePath" in item),
        )
        .map(mapScan);
    }
    if (type === "relation" && Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((id) => recordIds.get(id))
        .filter((id): id is string => Boolean(id));
    }
    return Array.isArray(value)
      ? value.slice() as string[] | ScanAttachment[]
      : value;
  };
  const standardDefinitions = new Map<CustomFieldModule, CustomFieldDefinition[]>();
  for (const definition of source.settings.customFields) {
    const definitions = standardDefinitions.get(definition.module) ?? [];
    definitions.push(definition);
    standardDefinitions.set(definition.module, definitions);
  }
  const mapCustomFields = (
    module: CustomFieldModule,
    values: CustomFieldValues,
  ): CustomFieldValues => {
    const result: CustomFieldValues = {};
    for (const definition of standardDefinitions.get(module) ?? []) {
      if (!(definition.id in values)) continue;
      const id = customFieldDefinitions.get(definition.id);
      if (!id) continue;
      result[id] = mapFieldValue(definition.type, values[definition.id]) as CustomFieldValue;
    }
    return result;
  };
  const mapSectionValues = (
    record: CustomSectionRecord,
  ): CustomSectionRecord["values"] => {
    const section = source.customSections.find((item) => item.id === record.sectionId);
    const result: CustomSectionRecord["values"] = {};
    for (const field of section?.fields ?? []) {
      if (!(field.id in record.values)) continue;
      const id = sectionFieldIds.get(field.id);
      if (!id) continue;
      result[id] = mapFieldValue(field.type, record.values[field.id]) as CustomSectionRecordValue;
    }
    return result;
  };

  return {
    ...source,
    updatedAt: nowIso(),
    researches: source.researches.map((item) => ({
      ...item,
      id: mapRequired(researches, item.id),
      customFields: mapCustomFields("researches", item.customFields),
    })),
    documents: source.documents.map((item) => ({
      ...item,
      id: mapRequired(documents, item.id),
      researchId: mapReference(researches, item.researchId),
      scans: mapScans(item.scans),
      customFields: mapCustomFields("documents", item.customFields),
    })),
    yearMatrix: source.yearMatrix.map((item) => ({
      ...item,
      id: mapRequired(yearMatrix, item.id),
      researchId: mapReference(researches, item.researchId),
      documentId: mapReference(documents, item.documentId),
      customFields: mapCustomFields("yearMatrix", item.customFields),
    })),
    tasks: source.tasks.map((item) => ({
      ...item,
      id: mapRequired(tasks, item.id),
      researchId: mapReference(researches, item.researchId),
      documentId: mapReference(documents, item.documentId),
      personIds: mapReferences(persons, item.personIds),
      customFields: mapCustomFields("tasks", item.customFields),
    })),
    findings: source.findings.map((item) => ({
      ...item,
      id: mapRequired(findings, item.id),
      researchId: mapReference(researches, item.researchId),
      documentId: mapReference(documents, item.documentId),
      personIds: mapReferences(persons, item.personIds),
      participants: item.participants.map((participant) => ({
        ...participant,
        id: createId(),
      })),
      scans: mapScans(item.scans),
      customFields: mapCustomFields("findings", item.customFields),
    })),
    hypotheses: source.hypotheses.map((item) => ({
      ...item,
      id: mapRequired(hypotheses, item.id),
      researchId: mapReference(researches, item.researchId),
      personIds: mapReferences(persons, item.personIds),
      documentIds: mapReferences(documents, item.documentIds),
      findingIds: mapReferences(findings, item.findingIds),
      customFields: mapCustomFields("hypotheses", item.customFields),
    })),
    archiveRequests: source.archiveRequests.map((item) => ({
      ...item,
      id: mapRequired(archiveRequests, item.id),
      researchId: mapReference(researches, item.researchId),
      personIds: mapReferences(persons, item.personIds),
      requestScans: mapScans(item.requestScans),
      responseScans: mapScans(item.responseScans),
      customFields: mapCustomFields("archiveRequests", item.customFields),
    })),
    persons: source.persons.map((item) => ({
      ...item,
      id: mapRequired(persons, item.id),
      researchId: mapReference(researches, item.researchId),
      birthScans: mapScans(item.birthScans),
      marriageScans: mapScans(item.marriageScans),
      deathScans: mapScans(item.deathScans),
      mentionScans: mapScans(item.mentionScans),
      customFields: mapCustomFields("persons", item.customFields),
    })),
    personRelations: source.personRelations
      .filter(
        (item) => persons.has(item.personId) && persons.has(item.relatedPersonId),
      )
      .map((item) => ({
        ...item,
        id: mapRequired(personRelations, item.id),
        personId: mapRequired(persons, item.personId),
        relatedPersonId: mapRequired(persons, item.relatedPersonId),
      })),
    customSections: source.customSections.map((section) => ({
      ...section,
      id: mapRequired(customSections, section.id),
      parentKey: section.parentKey?.startsWith("custom:")
        ? `custom:${mapReference(customSections, section.parentKey.slice("custom:".length))}`
        : section.parentKey,
      titleFieldId: mapReference(sectionFieldIds, section.titleFieldId),
      fields: section.fields.map((field) => ({
        ...field,
        id: mapRequired(sectionFieldIds, field.id),
        relationTarget: mapRelationTarget(field.relationTarget),
      })),
    })),
    customSectionRecords: source.customSectionRecords
      .filter((record) => customSections.has(record.sectionId))
      .map((record) => ({
        ...record,
        id: mapRequired(customRecords, record.id),
        sectionId: mapRequired(customSections, record.sectionId),
        values: mapSectionValues(record),
      })),
    activityLog: [],
    settings: {
      ...source.settings,
      lastAutomaticBackupAt: null,
      customFields: source.settings.customFields.map((definition) => ({
        ...definition,
        id: mapRequired(customFieldDefinitions, definition.id),
        relationTarget: mapRelationTarget(definition.relationTarget),
      })),
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
        parentKey: typeof item.parentKey === "string"
          ? item.parentKey as CustomSectionDefinition["parentKey"]
          : null,
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
  const iconAliases: Record<string, string> = {
    Р: "folder",
    І: "village",
    Б: "building",
    Х: "calendar",
    У: "landmark",
    С: "microphone",
  };
  return iconAliases[icon] ?? icon;
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

function normalizeParticipants(value: unknown, peopleText: unknown): FindingParticipant[] {
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
  if (typeof peopleText === "string" && peopleText.trim()) {
    return [{
      id: createId(),
      role: "Згадана особа",
      name: peopleText.trim(),
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
