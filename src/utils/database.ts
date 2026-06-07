import type { AppDatabase, FindingParticipant } from "../types";
import { nowIso } from "./dateHelpers";
import { createId } from "./id";
import { participantSummary } from "./findingParticipants";

export function createEmptyDatabase(): AppDatabase {
  return {
    version: 3,
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
    activityLog: [],
    settings: {
      researcherName: "",
      compactTables: false,
      lastAutomaticBackupAt: null,
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
    (candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3)
  ) {
    throw new Error("Непідтримуваний формат або версія бази.");
  }
  const empty = createEmptyDatabase();
  const hypotheses = (Array.isArray(candidate.hypotheses) ? candidate.hypotheses : []).map((item) => ({
    ...item,
    documentIds: normalizeIds(item.documentIds),
    findingIds: normalizeIds(item.findingIds),
    personIds: normalizeIds(item.personIds),
  }));
  const yearMatrix = (Array.isArray(candidate.yearMatrix) ? candidate.yearMatrix : []).map((item) => ({
    ...item,
    documentId: typeof item.documentId === "string" ? item.documentId : "",
  }));
  const documents = (Array.isArray(candidate.documents) ? candidate.documents : []).map((item) => ({
    ...item,
    scans: Array.isArray(item.scans) ? item.scans : [],
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
    };
  });
  const tasks = (Array.isArray(candidate.tasks) ? candidate.tasks : []).map((item) => ({
    ...item,
    personIds: normalizeIds(item.personIds),
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
  }));
  const persons = (Array.isArray(candidate.persons) ? candidate.persons : []).map((item) => ({
    ...item,
    birthScans: Array.isArray(item.birthScans) ? item.birthScans : [],
    marriageScans: Array.isArray(item.marriageScans) ? item.marriageScans : [],
    deathScans: Array.isArray(item.deathScans) ? item.deathScans : [],
    mentionScans: Array.isArray(item.mentionScans) ? item.mentionScans : [],
  }));
  return {
    ...empty,
    ...candidate,
    version: 3,
    appName: "Трекер Роду",
    tagline: "Не губи сліди свого роду",
    researches: Array.isArray(candidate.researches) ? candidate.researches : [],
    documents,
    yearMatrix,
    tasks,
    findings,
    hypotheses,
    archiveRequests,
    persons,
    personRelations: Array.isArray(candidate.personRelations) ? candidate.personRelations : [],
    activityLog: Array.isArray(candidate.activityLog) ? candidate.activityLog : [],
    settings: { ...empty.settings, ...(candidate.settings ?? {}) },
  };
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
