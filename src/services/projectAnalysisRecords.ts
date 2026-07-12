import type {
  ArchiveRequest,
  CustomFieldValues,
  Hypothesis,
  ScanAttachment,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import { saveOptionalProjectCache } from "../utils/projectCache";

type HypothesisRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  title: string;
  description: string;
  to_verify: string;
  related_people: string;
  status: string;
  probability: string;
  arguments_for: string;
  arguments_against: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type HypothesisLinkRow = {
  hypothesis_id: string;
  target_type: "person" | "document" | "finding";
  target_id: string;
};

type ArchiveRequestRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  archive: string;
  archive_details: string;
  request_date: string;
  response_date: string;
  status: string;
  subject: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type ArchiveRequestPersonRow = {
  archive_request_id: string;
  person_id: string;
};

const HYPOTHESIS_SELECT =
  "id, project_id, research_id, title, description, to_verify, related_people, status, probability, arguments_for, arguments_against, notes, custom_fields, created_at, updated_at";
const ARCHIVE_REQUEST_SELECT =
  "id, project_id, research_id, archive, archive_details, request_date, response_date, status, subject, notes, custom_fields, created_at, updated_at";
const ARCHIVE_SCANS_KEY = "__trackerRoduArchiveScans";
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function hypothesisFromRow(
  row: HypothesisRow,
  links: HypothesisLinkRow[],
): Hypothesis {
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    title: row.title,
    description: row.description,
    argumentsFor: row.arguments_for,
    argumentsAgainst: row.arguments_against,
    toVerify: row.to_verify,
    relatedPeople: row.related_people,
    personIds: links
      .filter((link) => link.target_type === "person")
      .map((link) => link.target_id),
    documentIds: links
      .filter((link) => link.target_type === "document")
      .map((link) => link.target_id),
    findingIds: links
      .filter((link) => link.target_type === "finding")
      .map((link) => link.target_id),
    status: row.status,
    probability: row.probability,
    notes: row.notes,
    customFields: asRecord(row.custom_fields) as CustomFieldValues,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hypothesisToRow(
  projectId: string,
  hypothesis: Hypothesis,
  researchIds: Set<string>,
) {
  return {
    id: hypothesis.id,
    project_id: projectId,
    research_id: researchIds.has(hypothesis.researchId)
      ? hypothesis.researchId
      : null,
    title: hypothesis.title,
    description: hypothesis.description,
    to_verify: hypothesis.toVerify,
    related_people: hypothesis.relatedPeople,
    status: hypothesis.status,
    probability: hypothesis.probability,
    arguments_for: hypothesis.argumentsFor,
    arguments_against: hypothesis.argumentsAgainst,
    notes: hypothesis.notes,
    custom_fields: hypothesis.customFields ?? {},
    created_at: hypothesis.createdAt,
    updated_at: hypothesis.updatedAt,
  };
}

function archiveRequestFromRow(
  row: ArchiveRequestRow,
  personIds: string[],
): ArchiveRequest {
  const customRecord = asRecord(row.custom_fields);
  const scans = asRecord(customRecord[ARCHIVE_SCANS_KEY]);
  const customFields = { ...customRecord };
  delete customFields[ARCHIVE_SCANS_KEY];
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    personIds,
    archive: row.archive,
    archiveDetails: row.archive_details,
    requestDate: row.request_date,
    responseDate: row.response_date,
    subject: row.subject,
    status: row.status,
    notes: row.notes,
    requestScans: Array.isArray(scans.requestScans)
      ? (scans.requestScans as ScanAttachment[])
      : [],
    responseScans: Array.isArray(scans.responseScans)
      ? (scans.responseScans as ScanAttachment[])
      : [],
    customFields: customFields as CustomFieldValues,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function archiveRequestToRow(
  projectId: string,
  request: ArchiveRequest,
  researchIds: Set<string>,
) {
  return {
    id: request.id,
    project_id: projectId,
    research_id: researchIds.has(request.researchId) ? request.researchId : null,
    archive: request.archive,
    archive_details: request.archiveDetails,
    request_date: request.requestDate,
    response_date: request.responseDate,
    status: request.status,
    subject: request.subject,
    notes: request.notes,
    custom_fields: {
      ...(request.customFields ?? {}),
      [ARCHIVE_SCANS_KEY]: {
        requestScans: request.requestScans ?? [],
        responseScans: request.responseScans ?? [],
      },
    },
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

export async function listProjectAnalysisRecords(projectId: string): Promise<{
  hypotheses: Hypothesis[];
  archiveRequests: ArchiveRequest[];
}> {
  const client = getSupabaseClient();
  const [hypothesesResult, linksResult, requestsResult, requestPersonsResult] =
    await Promise.all([
      client
        .from("hypotheses")
        .select(HYPOTHESIS_SELECT)
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false }),
      client
        .from("hypothesis_links")
        .select("hypothesis_id, target_type, target_id")
        .eq("project_id", projectId),
      client
        .from("archive_requests")
        .select(ARCHIVE_REQUEST_SELECT)
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false }),
      client
        .from("archive_request_persons")
        .select("archive_request_id, person_id")
        .eq("project_id", projectId),
    ]);
  if (hypothesesResult.error) throw hypothesesResult.error;
  if (linksResult.error) throw linksResult.error;
  if (requestsResult.error) throw requestsResult.error;
  if (requestPersonsResult.error) throw requestPersonsResult.error;

  const linksByHypothesis = new Map<string, HypothesisLinkRow[]>();
  for (const link of linksResult.data as HypothesisLinkRow[]) {
    linksByHypothesis.set(link.hypothesis_id, [
      ...(linksByHypothesis.get(link.hypothesis_id) ?? []),
      link,
    ]);
  }
  const personsByRequest = new Map<string, string[]>();
  for (const link of requestPersonsResult.data as ArchiveRequestPersonRow[]) {
    personsByRequest.set(link.archive_request_id, [
      ...(personsByRequest.get(link.archive_request_id) ?? []),
      link.person_id,
    ]);
  }

  return {
    hypotheses: (hypothesesResult.data as HypothesisRow[]).map((row) =>
      hypothesisFromRow(row, linksByHypothesis.get(row.id) ?? []),
    ),
    archiveRequests: (requestsResult.data as ArchiveRequestRow[]).map((row) =>
      archiveRequestFromRow(row, personsByRequest.get(row.id) ?? []),
    ),
  };
}

async function replaceHypothesisLinks(
  projectId: string,
  hypothesis: Hypothesis,
  personIds: Set<string>,
  documentIds: Set<string>,
  findingIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  const existing = await client
    .from("hypothesis_links")
    .select("target_type, target_id")
    .eq("project_id", projectId)
    .eq("hypothesis_id", hypothesis.id);
  if (existing.error) throw existing.error;

  const links = [
    ...hypothesis.personIds
      .filter((id) => personIds.has(id))
      .map((targetId) => ({ target_type: "person", target_id: targetId })),
    ...hypothesis.documentIds
      .filter((id) => documentIds.has(id))
      .map((targetId) => ({ target_type: "document", target_id: targetId })),
    ...hypothesis.findingIds
      .filter((id) => findingIds.has(id))
      .map((targetId) => ({ target_type: "finding", target_id: targetId })),
  ];

  const linkKey = (link: { target_type: string; target_id: string }) =>
    `${link.target_type}:${link.target_id}`;
  const existingRows = existing.data as Array<{
    target_type: "person" | "document" | "finding";
    target_id: string;
  }>;
  const nextKeys = new Set(links.map(linkKey));
  const existingKeys = new Set(existingRows.map(linkKey));

  for (const link of existingRows.filter((item) => !nextKeys.has(linkKey(item)))) {
    const { error: deleteError } = await client
      .from("hypothesis_links")
      .delete()
      .eq("project_id", projectId)
      .eq("hypothesis_id", hypothesis.id)
      .eq("target_type", link.target_type)
      .eq("target_id", link.target_id);
    if (deleteError) throw deleteError;
  }

  const added = links.filter((link) => !existingKeys.has(linkKey(link)));
  if (!added.length) return;
  const { error } = await client.from("hypothesis_links").insert(
    added.map((link) => ({
      project_id: projectId,
      hypothesis_id: hypothesis.id,
      ...link,
    })),
  );
  if (error) throw error;
}

async function replaceArchiveRequestPersons(
  projectId: string,
  request: ArchiveRequest,
  personIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  const existing = await client
    .from("archive_request_persons")
    .select("person_id")
    .eq("project_id", projectId)
    .eq("archive_request_id", request.id);
  if (existing.error) throw existing.error;

  const validIds = [...new Set(request.personIds)].filter((id) => personIds.has(id));
  const nextIds = new Set(validIds);
  const existingIds = new Set((existing.data as Array<{ person_id: string }>).map((row) => row.person_id));
  const removedIds = [...existingIds].filter((id) => !nextIds.has(id));
  const addedIds = validIds.filter((id) => !existingIds.has(id));

  if (removedIds.length) {
    const { error: deleteError } = await client
      .from("archive_request_persons")
      .delete()
      .eq("project_id", projectId)
      .eq("archive_request_id", request.id)
      .in("person_id", removedIds);
    if (deleteError) throw deleteError;
  }
  if (!addedIds.length) return;
  const { error } = await client.from("archive_request_persons").insert(
    addedIds.map((personId) => ({
      project_id: projectId,
      archive_request_id: request.id,
      person_id: personId,
    })),
  );
  if (error) throw error;
}

export async function importProjectAnalysisRecords(
  projectId: string,
  hypotheses: Hypothesis[],
  archiveRequests: ArchiveRequest[],
  researchIds: Set<string>,
  personIds: Set<string>,
  documentIds: Set<string>,
  findingIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  if (hypotheses.length) {
    const { error } = await client
      .from("hypotheses")
      .upsert(
        hypotheses.map((hypothesis) =>
          hypothesisToRow(projectId, hypothesis, researchIds),
        ),
        { onConflict: "id" },
      );
    if (error) throw error;
    for (const hypothesis of hypotheses) {
      await replaceHypothesisLinks(
        projectId,
        hypothesis,
        personIds,
        documentIds,
        findingIds,
      );
    }
  }
  if (archiveRequests.length) {
    const { error } = await client
      .from("archive_requests")
      .upsert(
        archiveRequests.map((request) =>
          archiveRequestToRow(projectId, request, researchIds),
        ),
        { onConflict: "id" },
      );
    if (error) throw error;
    for (const request of archiveRequests) {
      await replaceArchiveRequestPersons(projectId, request, personIds);
    }
  }
}

export async function saveProjectHypothesis(
  projectId: string,
  hypothesis: Hypothesis,
  researchIds: Set<string>,
  personIds: Set<string>,
  documentIds: Set<string>,
  findingIds: Set<string>,
): Promise<Hypothesis> {
  const { data, error } = await getSupabaseClient()
    .from("hypotheses")
    .upsert(hypothesisToRow(projectId, hypothesis, researchIds), {
      onConflict: "id",
    })
    .select(HYPOTHESIS_SELECT)
    .single();
  if (error) throw error;
  await replaceHypothesisLinks(
    projectId,
    hypothesis,
    personIds,
    documentIds,
    findingIds,
  );
  return hypothesisFromRow(data as HypothesisRow, [
    ...hypothesis.personIds.map((target_id) => ({
      hypothesis_id: hypothesis.id,
      target_type: "person" as const,
      target_id,
    })),
    ...hypothesis.documentIds.map((target_id) => ({
      hypothesis_id: hypothesis.id,
      target_type: "document" as const,
      target_id,
    })),
    ...hypothesis.findingIds.map((target_id) => ({
      hypothesis_id: hypothesis.id,
      target_type: "finding" as const,
      target_id,
    })),
  ]);
}

export async function deleteProjectHypothesis(
  projectId: string,
  hypothesisId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("hypotheses")
    .delete()
    .eq("project_id", projectId)
    .eq("id", hypothesisId);
  if (error) throw error;
}

export async function saveProjectArchiveRequest(
  projectId: string,
  request: ArchiveRequest,
  researchIds: Set<string>,
  personIds: Set<string>,
): Promise<ArchiveRequest> {
  const { data, error } = await getSupabaseClient()
    .from("archive_requests")
    .upsert(archiveRequestToRow(projectId, request, researchIds), {
      onConflict: "id",
    })
    .select(ARCHIVE_REQUEST_SELECT)
    .single();
  if (error) throw error;
  await replaceArchiveRequestPersons(projectId, request, personIds);
  return archiveRequestFromRow(
    data as ArchiveRequestRow,
    request.personIds.filter((id) => personIds.has(id)),
  );
}

export async function deleteProjectArchiveRequest(
  projectId: string,
  requestId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("archive_requests")
    .delete()
    .eq("project_id", projectId)
    .eq("id", requestId);
  if (error) throw error;
}

export async function deleteProjectHypothesisTargetLinks(
  projectId: string,
  targetType: "person" | "document" | "finding",
  targetId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("hypothesis_links")
    .delete()
    .eq("project_id", projectId)
    .eq("target_type", targetType)
    .eq("target_id", targetId);
  if (error) throw error;
}

const CACHE_PREFIX = "tracker-rodu-project-analysis-records:";
const ANALYSIS_RECORDS_CACHE_MAX_CHARS = 500_000;

export function loadProjectAnalysisRecordsCache(projectId: string): {
  hypotheses: Hypothesis[];
  archiveRequests: ArchiveRequest[];
} {
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${projectId}`);
    if (!stored) return { hypotheses: [], archiveRequests: [] };
    const parsed = JSON.parse(stored) as {
      hypotheses?: unknown;
      archiveRequests?: unknown;
    };
    return {
      hypotheses: Array.isArray(parsed.hypotheses)
        ? (parsed.hypotheses as Hypothesis[])
        : [],
      archiveRequests: Array.isArray(parsed.archiveRequests)
        ? (parsed.archiveRequests as ArchiveRequest[])
        : [],
    };
  } catch {
    return { hypotheses: [], archiveRequests: [] };
  }
}

export function saveProjectAnalysisRecordsCache(
  projectId: string,
  hypotheses: Hypothesis[],
  archiveRequests: ArchiveRequest[],
): void {
  saveOptionalProjectCache(
    `${CACHE_PREFIX}${projectId}`,
    { hypotheses, archiveRequests },
    ANALYSIS_RECORDS_CACHE_MAX_CHARS,
  );
}

export function clearProjectAnalysisRecordsCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
