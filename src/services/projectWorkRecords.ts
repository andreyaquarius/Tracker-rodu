import type {
  CustomFieldValues,
  Finding,
  FindingParticipant,
  ScanAttachment,
  TaskRecord,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import {
  asProjectPage,
  pageRange,
  type ProjectPage,
} from "./projectPagination";

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
  _researchIds: Set<string>,
  _documentIds: Set<string>,
) {
  return {
    id: task.id,
    project_id: projectId,
    research_id: task.researchId || null,
    person_name: task.personName,
    title: task.title,
    description: task.description,
    place: task.place,
    year_from: task.yearFrom,
    year_to: task.yearTo,
    document_type: task.documentType,
    document_id: task.documentId || null,
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
  const customRecord = asRecord(row.custom_fields);
  const meta = asRecord(customRecord[FINDING_META_KEY]);
  const customFields = { ...customRecord };
  delete customFields[FINDING_META_KEY];
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    documentId: row.document_id ?? "",
    findingType: row.finding_type,
    eventDate: row.event_date,
    people: row.people,
    personsText: row.persons_text,
    personIds: Array.isArray(meta.personIds) ? (meta.personIds as string[]) : [],
    participants,
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
    customFields: customFields as CustomFieldValues,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findingToRow(
  projectId: string,
  finding: Finding,
  _researchIds: Set<string>,
  _documentIds: Set<string>,
  _personIds: Set<string>,
) {
  return {
    id: finding.id,
    project_id: projectId,
    research_id: finding.researchId || null,
    document_id: finding.documentId || null,
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
      ...(finding.customFields ?? {}),
      [FINDING_META_KEY]: {
        personIds: finding.personIds,
        scans: finding.scans ?? [],
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

export async function listProjectTasks(
  projectId: string,
  page = 0,
): Promise<ProjectPage<TaskRecord>> {
  const client = getSupabaseClient();
  const { from, to } = pageRange(page);
  const tasksResult = await client
    .from("tasks")
    .select(TASK_SELECT)
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .range(from, to);
  if (tasksResult.error) throw tasksResult.error;
  const taskRows = tasksResult.data as TaskRow[];
  const taskIds = taskRows.map((row) => row.id);
  const taskPersonsResult = taskIds.length
    ? await client
        .from("task_persons")
        .select("task_id, person_id")
        .eq("project_id", projectId)
        .in("task_id", taskIds)
        .limit(500)
    : { data: [], error: null };
  if (taskPersonsResult.error) throw taskPersonsResult.error;
  const taskPersonMap = new Map<string, string[]>();
  for (const row of taskPersonsResult.data as TaskPersonRow[]) {
    taskPersonMap.set(row.task_id, [...(taskPersonMap.get(row.task_id) ?? []), row.person_id]);
  }
  return asProjectPage(taskRows.map((row) =>
    taskFromRow(row, taskPersonMap.get(row.id) ?? []),
  ));
}

export async function listProjectFindings(
  projectId: string,
  page = 0,
): Promise<ProjectPage<Finding>> {
  const client = getSupabaseClient();
  const { from, to } = pageRange(page);
  const findingsResult = await client
    .from("findings")
    .select(FINDING_SELECT)
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .range(from, to);
  if (findingsResult.error) throw findingsResult.error;
  const findingRows = findingsResult.data as FindingRow[];
  const findingIds = findingRows.map((row) => row.id);
  const participantsResult = findingIds.length
    ? await client
        .from("finding_participants")
        .select("id, finding_id, person_id, name, role, notes")
        .eq("project_id", projectId)
        .in("finding_id", findingIds)
        .order("created_at", { ascending: true })
        .limit(500)
    : { data: [], error: null };
  if (participantsResult.error) throw participantsResult.error;
  const participantMap = new Map<string, FindingParticipant[]>();
  for (const row of participantsResult.data as FindingParticipantRow[]) {
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

  return asProjectPage(
    findingRows.map((row) =>
      findingFromRow(row, participantMap.get(row.id) ?? []),
    ),
  );
}

async function replaceTaskPersons(
  projectId: string,
  task: TaskRecord,
  _validPersonIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  const { error: deleteError } = await client
    .from("task_persons")
    .delete()
    .eq("project_id", projectId)
    .eq("task_id", task.id);
  if (deleteError) throw deleteError;
  const personIds = [...new Set(task.personIds)];
  if (!personIds.length) return;
  const { error } = await client.from("task_persons").insert(
    personIds.map((personId) => ({
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
  const { error: deleteError } = await client
    .from("finding_participants")
    .delete()
    .eq("project_id", projectId)
    .eq("finding_id", finding.id);
  if (deleteError) throw deleteError;
  if (!finding.participants.length) return;
  const { error } = await client
    .from("finding_participants")
    .insert(
      finding.participants.map((participant) =>
        participantToRow(projectId, finding.id, participant),
      ),
    );
  if (error) throw error;
}

export async function importProjectWorkRecords(
  projectId: string,
  tasks: TaskRecord[],
  findings: Finding[],
  researchIds: Set<string>,
  documentIds: Set<string>,
  personIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  if (tasks.length) {
    const { error } = await client
      .from("tasks")
      .upsert(
        tasks.map((task) => taskToRow(projectId, task, researchIds, documentIds)),
        { onConflict: "id" },
      );
    if (error) throw error;
    for (const task of tasks) {
      await replaceTaskPersons(projectId, task, personIds);
    }
  }
  if (findings.length) {
    const { error } = await client
      .from("findings")
      .upsert(
        findings.map((finding) =>
          findingToRow(projectId, finding, researchIds, documentIds, personIds),
        ),
        { onConflict: "id" },
      );
    if (error) throw error;
    for (const finding of findings) {
      await replaceFindingParticipants(projectId, finding);
    }
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
    task.personIds,
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
  localStorage.setItem(
    `${CACHE_PREFIX}${projectId}`,
    JSON.stringify({ tasks, findings }),
  );
}

export function clearProjectWorkRecordsCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
