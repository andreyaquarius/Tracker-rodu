import type { EvidenceStatus } from "../types/familyTree.ts";
import {
  deletePersonMarriage,
  savePersonMarriage,
} from "./familyTreeMutationService.ts";
import { getSupabaseClient } from "./supabaseAuth.ts";

export interface ProjectPersonMarriage {
  id: string;
  projectId: string;
  treeId: string;
  personAId: string;
  personBId: string;
  date: string;
  place: string;
  address: string;
  evidenceStatus: EvidenceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPersonMarriageDraft {
  relationshipId?: string;
  partnerId: string;
  date: string;
  place: string;
  address: string;
}

export interface ProjectPersonMarriagesSnapshot {
  treeId: string;
  marriages: ProjectPersonMarriage[];
}

interface MarriageRow {
  id: string;
  project_id: string;
  tree_id: string;
  person_a_id: string;
  person_b_id: string;
  start_date: string;
  start_place: string;
  evidence_status: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

const MARRIAGE_SELECT =
  "id, project_id, tree_id, person_a_id, person_b_id, start_date, start_place, evidence_status, metadata, created_at, updated_at";
const PAGE_SIZE = 1000;

export async function listProjectPersonMarriages(
  projectId: string,
  preferredTreeId?: string,
): Promise<ProjectPersonMarriagesSnapshot> {
  const treeId = await resolveTreeId(projectId, preferredTreeId);
  if (!treeId) return { treeId: "", marriages: [] };

  const client = getSupabaseClient();
  const rows: MarriageRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from("partner_relationships")
      .select(MARRIAGE_SELECT)
      .eq("project_id", projectId)
      .eq("tree_id", treeId)
      .eq("relationship_type", "marriage")
      .order("start_date", { ascending: true })
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as MarriageRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return {
    treeId,
    marriages: rows.map(marriageFromRow),
  };
}

export async function saveProjectPersonMarriages(input: {
  projectId: string;
  treeId?: string;
  personId: string;
  marriages: readonly ProjectPersonMarriageDraft[];
  deletedRelationshipIds?: readonly string[];
}): Promise<ProjectPersonMarriagesSnapshot> {
  let treeId = input.treeId ?? "";
  if (treeId) {
    for (const relationshipId of new Set(input.deletedRelationshipIds ?? [])) {
      await deletePersonMarriage({
        projectId: input.projectId,
        treeId,
        relationshipId,
      });
    }
  }

  for (const marriage of input.marriages) {
    if (!marriage.partnerId) continue;
    const saved = await savePersonMarriage({
      projectId: input.projectId,
      treeId: treeId || undefined,
      relationshipId: marriage.relationshipId,
      personId: input.personId,
      partnerId: marriage.partnerId,
      startDate: marriage.date,
      startPlace: marriage.place,
      address: marriage.address,
      evidenceStatus: "proven",
    });
    treeId = saved.treeId;
  }

  return listProjectPersonMarriages(input.projectId, treeId || input.treeId);
}

function marriageFromRow(row: MarriageRow): ProjectPersonMarriage {
  const metadata = objectRecord(row.metadata);
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    personAId: row.person_a_id,
    personBId: row.person_b_id,
    date: row.start_date ?? "",
    place: row.start_place ?? "",
    address: typeof metadata.address === "string" ? metadata.address : "",
    evidenceStatus: evidenceStatus(row.evidence_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function resolveTreeId(projectId: string, preferredTreeId?: string): Promise<string> {
  const client = getSupabaseClient();
  if (preferredTreeId) {
    const { data, error } = await client
      .from("family_trees")
      .select("id")
      .eq("project_id", projectId)
      .eq("id", preferredTreeId)
      .maybeSingle();
    if (error) throw error;
    if (data?.id) return String(data.id);
  }
  const { data, error } = await client
    .from("family_trees")
    .select("id")
    .eq("project_id", projectId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ? String(data.id) : "";
}

function evidenceStatus(value: string): EvidenceStatus {
  return value === "proven"
    || value === "likely"
    || value === "disputed"
    || value === "disproven"
    ? value
    : "unknown";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
