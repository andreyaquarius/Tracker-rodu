import type {
  CustomFieldValues,
  DocumentFragmentSelection,
  Finding,
  FindingParticipant,
  ScanAttachment,
  TaskRecord,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import { FINDING_GEO_META_KEY, normalizeGeo, stripInternalGeoFields } from "../utils/geo";
import { sortFindingParticipants } from "../utils/findingParticipants";
import {
  discardOptionalProjectCache,
  saveOptionalProjectCache,
} from "../utils/projectCache";
import {
  chunkFindingImportRows,
  chunkImportRows,
  runImportBatches,
  withImportPhase,
  type ImportPhaseProgressOptions,
} from "../utils/importBatches.ts";
import {
  selectRowsByCursor,
  selectRowsInParallel,
} from "../utils/pagedRows.ts";

type TaskRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  person_name: string;
  title: string;
  description: string;
  place: string;
  year_from: string;
  year_to: string;
  document_type: string;
  document_id: string | null;
  status: string;
  priority: string;
  deadline: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type TaskPersonRow = {
  task_id: string;
  person_id: string;
};

type FindingRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  document_id: string | null;
  finding_type: string;
  event_date: string;
  people: string;
  persons_text: string;
  place: string;
  archive: string;
  fund: string;
  description: string;
  file_reference: string;
  page: string;
  summary: string;
  transcription: string;
  conclusion: string;
  reliability: string;
  needs_review: boolean;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type FindingParticipantRow = {
  id: string;
  finding_id: string;
  person_id: string | null;
  name: string;
  role: string;
  notes: string;
};

const TASK_SELECT =
  "id, project_id, research_id, person_name, title, description, place, year_from, year_to, document_type, document_id, status, priority, deadline, notes, custom_fields, created_at, updated_at";
const FINDING_SELECT =
  "id, project_id, research_id, document_id, finding_type, event_date, people, persons_text, place, archive, fund, description, file_reference, page, summary, transcription, conclusion, reliability, needs_review, notes, custom_fields, created_at, updated_at";
const FINDING_META_KEY = "__trackerRoduFindingMeta";
const IMPORT_REFERENCE_BATCH_ITEMS = 100;
const IMPORT_REFERENCE_BATCH_BYTES = 20_000;
const SELECT_BATCH_SIZE = 1_000;
const IMPORT_CONCURRENCY = 3;
const FINDING_IMPORT_CONCURRENCY = 4;
const REFERENCE_DELETE_CONCURRENCY = 2;
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function taskFromRow(row: TaskRow, personIds: string[]): TaskRecord {
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    personName: row.person_name,
    personIds,
    title: row.title,
    description: row.description,
    place: row.place,
    yearFrom: row.year_from,
    yearTo: row.year_to,
    documentType: row.document_type,
    documentId: row.document_id ?? "",
    status: row.status,
    priority: row.priority,
    deadline: row.deadline,
    notes: row.notes,
    customFields: asRecord(row.custom_fields) as CustomFieldValues,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskToRow(
  projectId: string,
  task: TaskRecord,
  researchIds: Set<string>,
  documentIds: Set<string>,
) {
  return {
    id: task.id,
    project_id: projectId,
    research_id: researchIds.has(task.researchId) ? task.researchId : null,
    person_name: task.personName,
    title: task.title,
    description: task.description,
    place: task.place,
    year_from: task.yearFrom,
    year_to: task.yearTo,
    document_type: task.documentType,
    document_id: documentIds.has(task.documentId) ? task.documentId : null,
    status: task.status,
    priority: task.priority,
    deadline: task.deadline,
    notes: task.notes,
    custom_fields: task.customFields ?? {},
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function findingFromRow(
  row: FindingRow,
  participants: FindingParticipant[],
): Finding {
  const sortedParticipants = sortFindingParticipants(participants, row.finding_type);
  const customRecord = asRecord(row.custom_fields);
  const meta = asRecord(customRecord[FINDING_META_KEY]);
  const customFields = { ...customRecord };
  delete customFields[FINDING_META_KEY];
  delete customFields[FINDING_GEO_META_KEY];
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    documentId: row.document_id ?? "",
    findingType: row.finding_type,
    eventDate: row.event_date,
    people: row.people,
    personsText: row.persons_text,
    personIds: Array.isArray(meta.personIds) ? (meta.personIds as string[]) : [],
    participants: sortedParticipants,
    place: row.place,
    archive: row.archive,
    fund: row.fund,
    description: row.description,
    file: row.file_reference,
    page: row.page,
    summary: row.summary,
    transcription: row.transcription,
    conclusion: row.conclusion,
    reliability: row.reliability,
    needsReview: row.needs_review,
    notes: row.notes,
    scans: Array.isArray(meta.scans) ? (meta.scans as ScanAttachment[]) : [],
    fragmentSelection: normalizeFragmentSelection(meta.fragmentSelection),
    geo: normalizeGeo(meta[FINDING_GEO_META_KEY] ?? customRecord[FINDING_GEO_META_KEY]),
    customFields: stripInternalGeoFields(customFields as CustomFieldValues),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findingToRow(
  projectId: string,
  finding: Finding,
  researchIds: Set<string>,
  documentIds: Set<string>,
  personIds: Set<string>,
) {
  return {
    id: finding.id,
    project_id: projectId,
    research_id: researchIds.has(finding.researchId) ? finding.researchId : null,
    document_id: documentIds.has(finding.documentId) ? finding.documentId : null,
    finding_type: finding.findingType,
    event_date: finding.eventDate,
    people: finding.people,
    persons_text: finding.personsText,
    place: finding.place,
    archive: finding.archive,
    fund: finding.fund,
    description: finding.description,
    file_reference: finding.file,
    page: finding.page,
    summary: finding.summary,
    transcription: finding.transcription,
    conclusion: finding.conclusion,
    reliability: finding.reliability,
    needs_review: finding.needsReview,
    notes: finding.notes,
    custom_fields: {
      ...stripInternalGeoFields(finding.customFields ?? {}),
      [FINDING_META_KEY]: {
        personIds: finding.personIds.filter((id) => personIds.has(id)),
        scans: finding.scans ?? [],
        fragmentSelection: finding.fragmentSelection ?? null,
        [FINDING_GEO_META_KEY]: finding.geo ?? null,
      },
    },
    created_at: finding.createdAt,
    updated_at: finding.updatedAt,
  };
}

function participantToRow(
  projectId: string,
  findingId: string,
  participant: FindingParticipant,
) {
  return {
    id: participant.id,
    project_id: projectId,
    finding_id: findingId,
    person_id: null,
    name: participant.name,
    role: participant.role,
    notes: participant.notes,
  };
}

export async function listProjectWorkRecords(projectId: string): Promise<{
  tasks: TaskRecord[];
  findings: Finding[];
}> {
  const client = getSupabaseClient();
  const [taskRows, taskPersonRows, findingRows, participantRows] =
    await Promise.all([
      selectRowsInParallel<TaskRow>(
        () => client.from("tasks").select(TASK_SELECT).eq("project_id", projectId)
          .order("updated_at", { ascending: false }).order("id", { ascending: true }),
        SELECT_BATCH_SIZE,
        1,
      ),
      selectRowsInParallel<TaskPersonRow>(
        () => client.from("task_persons").select("task_id, person_id").eq("project_id", projectId)
          .order("task_id", { ascending: true }).order("person_id", { ascending: true }),
        SELECT_BATCH_SIZE,
        1,
      ),
      selectRowsByCursor<FindingRow>(
        () => client.from("findings").select(FINDING_SELECT).eq("project_id", projectId)
          .order("id", { ascending: true }),
        "id",
        (row) => row.id,
        SELECT_BATCH_SIZE,
      ),
      selectRowsByCursor<FindingParticipantRow>(
        () => client.from("finding_participants")
          .select("id, finding_id, person_id, name, role, notes")
          .eq("project_id", projectId).order("id", { ascending: true }),
        "id",
        (row) => row.id,
        SELECT_BATCH_SIZE,
      ),
    ]);

  findingRows.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id)
  );

  const taskPersonMap = new Map<string, string[]>();
  for (const row of taskPersonRows) {
    taskPersonMap.set(row.task_id, [...(taskPersonMap.get(row.task_id) ?? []), row.person_id]);
  }
  const participantMap = new Map<string, FindingParticipant[]>();
  for (const row of participantRows) {
    const participant: FindingParticipant = {
      id: row.id,
      name: row.name,
      role: row.role,
      notes: row.notes,
    };
    participantMap.set(row.finding_id, [
      ...(participantMap.get(row.finding_id) ?? []),
      participant,
    ]);
  }

  return {
    tasks: taskRows.map((row) =>
      taskFromRow(row, taskPersonMap.get(row.id) ?? []),
    ),
    findings: findingRows.map((row) =>
      findingFromRow(row, participantMap.get(row.id) ?? []),
    ),
  };
}

function normalizeFragmentSelection(value: unknown): DocumentFragmentSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<DocumentFragmentSelection> & {
    rect?: Partial<DocumentFragmentSelection["rect"]>;
  };
  if (
    typeof record.documentId !== "string" ||
    typeof record.sourceFileId !== "string" ||
    typeof record.pageNumber !== "number" ||
    typeof record.rotation !== "number" ||
    typeof record.createdAt !== "string" ||
    !record.rect ||
    typeof record.rect.x !== "number" ||
    typeof record.rect.y !== "number" ||
    typeof record.rect.width !== "number" ||
    typeof record.rect.height !== "number"
  ) {
    return undefined;
  }

  return {
    documentId: record.documentId,
    sourceFileId: record.sourceFileId,
    pageNumber: record.pageNumber,
    rotation: record.rotation,
    rect: {
      x: clampUnit(record.rect.x),
      y: clampUnit(record.rect.y),
      width: clampUnit(record.rect.width),
      height: clampUnit(record.rect.height),
    },
    createdAt: record.createdAt,
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

async function replaceTaskPersons(
  projectId: string,
  task: TaskRecord,
  validPersonIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  const existing = await client
    .from("task_persons")
    .select("person_id")
    .eq("project_id", projectId)
    .eq("task_id", task.id);
  if (existing.error) throw existing.error;

  const personIds = [...new Set(task.personIds)].filter((id) => validPersonIds.has(id));
  const nextIds = new Set(personIds);
  const existingIds = new Set((existing.data as Array<{ person_id: string }>).map((row) => row.person_id));
  const removedIds = [...existingIds].filter((id) => !nextIds.has(id));
  const addedIds = personIds.filter((id) => !existingIds.has(id));

  if (removedIds.length) {
    const { error: deleteError } = await client
      .from("task_persons")
      .delete()
      .eq("project_id", projectId)
      .eq("task_id", task.id)
      .in("person_id", removedIds);
    if (deleteError) throw deleteError;
  }
  if (!addedIds.length) return;
  const { error } = await client.from("task_persons").insert(
    addedIds.map((personId) => ({
      project_id: projectId,
      task_id: task.id,
      person_id: personId,
    })),
  );
  if (error) throw error;
}

async function replaceFindingParticipants(
  projectId: string,
  finding: Finding,
): Promise<void> {
  const client = getSupabaseClient();
  const existing = await client
    .from("finding_participants")
    .select("id")
    .eq("project_id", projectId)
    .eq("finding_id", finding.id);
  if (existing.error) throw existing.error;

  const nextIds = new Set(finding.participants.map((participant) => participant.id));
  const removedIds = (existing.data as Array<{ id: string }>)
    .map((row) => row.id)
    .filter((id) => !nextIds.has(id));
  if (removedIds.length) {
    const { error: deleteError } = await client
      .from("finding_participants")
      .delete()
      .eq("project_id", projectId)
      .in("id", removedIds);
    if (deleteError) throw deleteError;
  }

  if (!finding.participants.length) return;
  const { error } = await client
    .from("finding_participants")
    .upsert(
      finding.participants.map((participant) =>
        participantToRow(projectId, finding.id, participant),
      ),
      { onConflict: "id" },
    );
  if (error) throw error;
}

async function replaceImportedTaskPersons(
  client: ReturnType<typeof getSupabaseClient>,
  projectId: string,
  tasks: TaskRecord[],
  validPersonIds: Set<string>,
  options: ImportPhaseProgressOptions,
): Promise<void> {
  const taskIds = tasks.map((task) => task.id);
  const deleteBatches = chunkImportRows(taskIds, {
    maxItems: IMPORT_REFERENCE_BATCH_ITEMS,
    maxBytes: IMPORT_REFERENCE_BATCH_BYTES,
  });
  await runImportBatches(deleteBatches, async (batch) => {
    const { error } = await client
      .from("task_persons")
      .delete()
      .eq("project_id", projectId)
      .in("task_id", batch);
    if (error) throw error;
  }, {
    concurrency: REFERENCE_DELETE_CONCURRENCY,
    onProgress: withImportPhase("task-person-delete", options.onProgress),
  });

  const rows = tasks.flatMap((task) =>
    [...new Set(task.personIds)]
      .filter((personId) => validPersonIds.has(personId))
      .map((personId) => ({
        project_id: projectId,
        task_id: task.id,
        person_id: personId,
      })),
  );
  await runImportBatches(chunkImportRows(rows), async (batch) => {
    const { error } = await client.from("task_persons").insert(batch);
    if (error) throw error;
  }, {
    concurrency: IMPORT_CONCURRENCY,
    onProgress: withImportPhase("task-person-insert", options.onProgress),
  });
}

async function replaceImportedFindingParticipants(
  client: ReturnType<typeof getSupabaseClient>,
  projectId: string,
  findings: Finding[],
  options: ImportPhaseProgressOptions,
): Promise<void> {
  const findingIds = findings.map((finding) => finding.id);
  const deleteBatches = chunkImportRows(findingIds, {
    maxItems: IMPORT_REFERENCE_BATCH_ITEMS,
    maxBytes: IMPORT_REFERENCE_BATCH_BYTES,
  });
  await runImportBatches(deleteBatches, async (batch) => {
    const { error } = await client
      .from("finding_participants")
      .delete()
      .eq("project_id", projectId)
      .in("finding_id", batch);
    if (error) throw error;
  }, {
    concurrency: REFERENCE_DELETE_CONCURRENCY,
    onProgress: withImportPhase("finding-participant-delete", options.onProgress),
  });

  const rows = findings.flatMap((finding) =>
    finding.participants.map((participant) => participantToRow(projectId, finding.id, participant)),
  );
  await runImportBatches(chunkImportRows(rows), async (batch) => {
    const { error } = await client
      .from("finding_participants")
      .upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }, {
    concurrency: FINDING_IMPORT_CONCURRENCY,
    onProgress: withImportPhase("finding-participant-upsert", options.onProgress),
  });
}

export async function importProjectWorkRecords(
  projectId: string,
  tasks: TaskRecord[],
  findings: Finding[],
  researchIds: Set<string>,
  documentIds: Set<string>,
  personIds: Set<string>,
  options: ImportPhaseProgressOptions = {},
): Promise<void> {
  const client = getSupabaseClient();
  const taskRows = tasks.map((task) => taskToRow(projectId, task, researchIds, documentIds));
  await runImportBatches(chunkImportRows(taskRows), async (batch) => {
    const { error } = await client
      .from("tasks")
      .upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }, {
    concurrency: IMPORT_CONCURRENCY,
    onProgress: withImportPhase("tasks", options.onProgress),
  });
  if (tasks.length) {
    await replaceImportedTaskPersons(client, projectId, tasks, personIds, options);
  }

  const findingRows = findings.map((finding) =>
    findingToRow(projectId, finding, researchIds, documentIds, personIds),
  );
  await runImportBatches(chunkFindingImportRows(findingRows), async (batch) => {
    const { error } = await client
      .from("findings")
      .upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }, {
    concurrency: FINDING_IMPORT_CONCURRENCY,
    onProgress: withImportPhase("findings", options.onProgress),
  });
  if (findings.length) {
    await replaceImportedFindingParticipants(client, projectId, findings, options);
  }
}

export async function saveProjectTask(
  projectId: string,
  task: TaskRecord,
  researchIds: Set<string>,
  documentIds: Set<string>,
  personIds: Set<string>,
): Promise<TaskRecord> {
  const { data, error } = await getSupabaseClient()
    .from("tasks")
    .upsert(taskToRow(projectId, task, researchIds, documentIds), { onConflict: "id" })
    .select(TASK_SELECT)
    .single();
  if (error) throw error;
  await replaceTaskPersons(projectId, task, personIds);
  return taskFromRow(
    data as TaskRow,
    task.personIds.filter((id) => personIds.has(id)),
  );
}

export async function deleteProjectTask(projectId: string, taskId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("tasks")
    .delete()
    .eq("project_id", projectId)
    .eq("id", taskId);
  if (error) throw error;
}

export async function saveProjectFinding(
  projectId: string,
  finding: Finding,
  researchIds: Set<string>,
  documentIds: Set<string>,
  personIds: Set<string>,
): Promise<Finding> {
  const { data, error } = await getSupabaseClient()
    .from("findings")
    .upsert(findingToRow(projectId, finding, researchIds, documentIds, personIds), {
      onConflict: "id",
    })
    .select(FINDING_SELECT)
    .single();
  if (error) throw error;
  await replaceFindingParticipants(projectId, finding);
  return findingFromRow(data as FindingRow, finding.participants);
}

export async function deleteProjectFinding(
  projectId: string,
  findingId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("findings")
    .delete()
    .eq("project_id", projectId)
    .eq("id", findingId);
  if (error) throw error;
}

const CACHE_PREFIX = "tracker-rodu-project-work-records:";
const WORK_RECORDS_CACHE_MAX_CHARS = 750_000;
const WORK_RECORDS_CACHE_MAX_RECORDS = 1_500;

export function loadProjectWorkRecordsCache(projectId: string): {
  tasks: TaskRecord[];
  findings: Finding[];
} {
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${projectId}`);
    if (!stored) return { tasks: [], findings: [] };
    const parsed = JSON.parse(stored) as { tasks?: unknown; findings?: unknown };
    return {
      tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as TaskRecord[]) : [],
      findings: Array.isArray(parsed.findings) ? (parsed.findings as Finding[]) : [],
    };
  } catch {
    return { tasks: [], findings: [] };
  }
}

export function saveProjectWorkRecordsCache(
  projectId: string,
  tasks: TaskRecord[],
  findings: Finding[],
): void {
  const key = `${CACHE_PREFIX}${projectId}`;
  if (tasks.length + findings.length > WORK_RECORDS_CACHE_MAX_RECORDS) {
    discardOptionalProjectCache(key);
    return;
  }
  saveOptionalProjectCache(
    key,
    { tasks, findings },
    WORK_RECORDS_CACHE_MAX_CHARS,
  );
}

export function clearProjectWorkRecordsCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
