import type { EntityId } from "../types";
import type { FamilyTree, FamilyTreePrivacyStatus } from "../types/familyTree";
import { getSupabaseClient } from "./supabaseAuth.ts";
import {
  isDeceasedAdminPerson,
  isLivingAdminPerson,
  isUnknownVitalStatusAdminPerson,
} from "../utils/familyTreeAdminStats.ts";

export interface FamilyTreeAdminSummary {
  tree: FamilyTree;
  rootPersonName: string;
  stats: {
    persons: number;
    families: number;
    surnames: number;
    partnerRelationships: number;
    parentChildRelationships: number;
    associationRelationships: number;
    livingPersons: number;
    deceasedPersons: number;
    unknownVitalStatusPersons: number;
    issues: number;
  };
  surnames: string[];
  mergeHistory: FamilyTreeMergeHistorySummary[];
}

export interface FamilyTreeMergeHistorySummary {
  id: EntityId;
  treeId: EntityId | null;
  sourceTreeId: EntityId | null;
  targetTreeId: EntityId | null;
  survivorPersonId: EntityId | null;
  mergedPersonId: EntityId | null;
  movedPersons: number;
  notes: string;
  createdAt: string;
}

type FamilyTreeRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  title: string;
  description: string;
  root_person_id: string | null;
  is_default: boolean;
  privacy_status: string;
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type TreeMemberRow = {
  tree_id: string;
  person_id: string;
  member_role?: string;
  display_order?: number;
  notes?: string;
};

type PersonRow = {
  id: string;
  surname: string | null;
  full_name: string | null;
  given_name: string | null;
  patronymic: string | null;
  is_living: boolean | null;
  death_date: string | null;
};

type TreeIdRow = { id: string; root_person_id?: string | null; is_default?: boolean | null };

type MergeHistoryRow = {
  id: string;
  tree_id: string | null;
  survivor_person_id: string | null;
  merged_person_id: string | null;
  moved_edges: unknown;
  notes: string;
  created_at: string;
};

const FAMILY_TREE_SELECT =
  "id, project_id, research_id, title, description, root_person_id, is_default, privacy_status, settings, created_at, updated_at";
const TREE_MEMBER_SELECT = "tree_id, person_id, member_role, display_order, notes";
const FAMILY_TREE_SCOPED_DELETE_TABLES = [
  "legacy_person_relation_graph_edges",
  "family_tree_research_issues",
  "tree_layout_positions",
  "association_relationships",
  "parent_child_relationships",
  "partner_relationships",
  "parent_sets",
  "family_groups",
  "family_tree_persons",
];

export async function readFamilyTreeAdminSummaries(projectId: EntityId): Promise<FamilyTreeAdminSummary[]> {
  const client = getSupabaseClient();
  const treesResult = await client
    .from("family_trees")
    .select(FAMILY_TREE_SELECT)
    .eq("project_id", projectId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (treesResult.error) {
    if (isMissingFamilyTreeTableError(treesResult.error)) return [];
    throw treesResult.error;
  }

  const trees = ((treesResult.data ?? []) as FamilyTreeRow[]).map(treeFromRow);
  if (!trees.length) return [];
  const treeIds = trees.map((tree) => tree.id);

  const [
    membersResult,
    groupsResult,
    partnersResult,
    parentChildrenResult,
    associationsResult,
    issuesResult,
    mergeHistoryResult,
  ] = await Promise.all([
    client
      .from("family_tree_persons")
      .select(TREE_MEMBER_SELECT)
      .eq("project_id", projectId)
      .in("tree_id", treeIds),
    client
      .from("family_groups")
      .select("id, tree_id")
      .eq("project_id", projectId)
      .in("tree_id", treeIds),
    client
      .from("partner_relationships")
      .select("id, tree_id")
      .eq("project_id", projectId)
      .in("tree_id", treeIds),
    client
      .from("parent_child_relationships")
      .select("id, tree_id")
      .eq("project_id", projectId)
      .in("tree_id", treeIds),
    client
      .from("association_relationships")
      .select("id, tree_id")
      .eq("project_id", projectId)
      .in("tree_id", treeIds),
    client
      .from("family_tree_research_issues")
      .select("id, tree_id")
      .eq("project_id", projectId)
      .in("tree_id", treeIds)
      .neq("status", "resolved"),
    client
      .from("family_tree_merge_history")
      .select("id, tree_id, survivor_person_id, merged_person_id, moved_edges, notes, created_at")
      .eq("project_id", projectId)
      .in("tree_id", treeIds)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  for (const result of [membersResult, groupsResult, partnersResult, parentChildrenResult, associationsResult, issuesResult, mergeHistoryResult]) {
    if (result.error) {
      if (isMissingFamilyTreeTableError(result.error)) return [];
      throw result.error;
    }
  }

  const members = (membersResult.data ?? []) as TreeMemberRow[];
  const personIds = Array.from(new Set([
    ...members.map((member) => member.person_id),
    ...trees.map((tree) => tree.rootPersonId).filter((id): id is string => Boolean(id)),
  ]));
  const people = personIds.length
    ? await readPeopleForAdmin(projectId, personIds)
    : [];
  const peopleById = new Map(people.map((person) => [person.id, person]));

  return trees.map((tree) => {
    const treeMembers = members.filter((member) => member.tree_id === tree.id);
    const memberPeople = treeMembers
      .map((member) => peopleById.get(member.person_id))
      .filter((person): person is PersonRow => Boolean(person));
    const surnames = Array.from(new Set(
      memberPeople
        .map((person) => person.surname?.trim() ?? "")
        .filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, "uk"));

    return {
      tree,
      rootPersonName: tree.rootPersonId ? personDisplayName(peopleById.get(tree.rootPersonId)) : "",
      stats: {
        persons: treeMembers.length,
        families: countByTree(groupsResult.data, tree.id),
        surnames: surnames.length,
        partnerRelationships: countByTree(partnersResult.data, tree.id),
        parentChildRelationships: countByTree(parentChildrenResult.data, tree.id),
        associationRelationships: countByTree(associationsResult.data, tree.id),
        livingPersons: memberPeople.filter(isLivingAdminPerson).length,
        deceasedPersons: memberPeople.filter(isDeceasedAdminPerson).length,
        unknownVitalStatusPersons: memberPeople.filter(isUnknownVitalStatusAdminPerson).length,
        issues: countByTree(issuesResult.data, tree.id),
      },
      surnames,
      mergeHistory: ((mergeHistoryResult.data ?? []) as MergeHistoryRow[])
        .filter((record) => record.tree_id === tree.id)
        .map(mergeHistoryFromRow),
    };
  });
}

export async function createFamilyTree(input: {
  projectId: EntityId;
  title: string;
  description?: string;
  rootPersonId?: EntityId | null;
}): Promise<FamilyTree> {
  const client = getSupabaseClient();
  const existing = await client
    .from("family_trees")
    .select("id")
    .eq("project_id", input.projectId)
    .limit(1);
  if (existing.error) throw existing.error;

  const title = input.title.trim() || "Нове дерево";
  const { data, error } = await client
    .from("family_trees")
    .insert({
      project_id: input.projectId,
      title,
      description: input.description?.trim() ?? "",
      root_person_id: input.rootPersonId || null,
      is_default: !(existing.data as TreeIdRow[] | null)?.length,
      privacy_status: "private",
      settings: { source: "family_tree_admin" },
    })
    .select(FAMILY_TREE_SELECT)
    .single();
  if (error) throw error;

  const tree = treeFromRow(data as FamilyTreeRow);
  if (input.rootPersonId) {
    await client
      .from("family_tree_persons")
      .upsert(
        {
          project_id: input.projectId,
          tree_id: tree.id,
          person_id: input.rootPersonId,
          member_role: "root",
        },
        { onConflict: "tree_id,person_id" },
      )
      .throwOnError();
  }
  return tree;
}

export async function setDefaultFamilyTree(input: {
  projectId: EntityId;
  treeId: EntityId;
}): Promise<void> {
  const client = getSupabaseClient();
  const clear = await client
    .from("family_trees")
    .update({ is_default: false })
    .eq("project_id", input.projectId)
    .neq("id", input.treeId);
  if (clear.error) throw clear.error;
  const set = await client
    .from("family_trees")
    .update({ is_default: true })
    .eq("project_id", input.projectId)
    .eq("id", input.treeId);
  if (set.error) throw set.error;
}

export async function deleteFamilyTree(input: {
  projectId: EntityId;
  treeId: EntityId;
}): Promise<EntityId | null> {
  const client = getSupabaseClient();
  const treeResult = await client
    .from("family_trees")
    .select("id, is_default")
    .eq("project_id", input.projectId)
    .eq("id", input.treeId)
    .maybeSingle();
  if (treeResult.error) throw treeResult.error;

  const wasDefault = Boolean((treeResult.data as TreeIdRow | null)?.is_default);
  await deleteFamilyTreeScopedRows(input.projectId, input.treeId);
  const remove = await client
    .from("family_trees")
    .delete()
    .eq("project_id", input.projectId)
    .eq("id", input.treeId);
  if (remove.error) throw remove.error;

  const fallback = await client
    .from("family_trees")
    .select("id")
    .eq("project_id", input.projectId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (fallback.error) throw fallback.error;
  const fallbackId = (fallback.data as TreeIdRow | null)?.id ?? null;
  if (wasDefault && fallbackId) await setDefaultFamilyTree({ projectId: input.projectId, treeId: fallbackId });
  return fallbackId;
}

async function deleteFamilyTreeScopedRows(projectId: EntityId, treeId: EntityId): Promise<void> {
  const client = getSupabaseClient();
  for (const table of FAMILY_TREE_SCOPED_DELETE_TABLES) {
    const { error } = await client
      .from(table)
      .delete()
      .eq("project_id", projectId)
      .eq("tree_id", treeId);
    if (error) {
      if (isMissingFamilyTreeTableError(error)) continue;
      throw error;
    }
  }
}

export async function mergeFamilyTrees(input: {
  projectId: EntityId;
  sourceTreeId: EntityId;
  targetTreeId: EntityId;
}): Promise<void> {
  if (input.sourceTreeId === input.targetTreeId) return;
  const client = getSupabaseClient();
  const [sourceTree, targetTree, sourceMembersResult, targetMembersResult] = await Promise.all([
    client
      .from("family_trees")
      .select("id, root_person_id, is_default")
      .eq("project_id", input.projectId)
      .eq("id", input.sourceTreeId)
      .maybeSingle(),
    client
      .from("family_trees")
      .select("id, root_person_id, is_default")
      .eq("project_id", input.projectId)
      .eq("id", input.targetTreeId)
      .maybeSingle(),
    client
      .from("family_tree_persons")
      .select(TREE_MEMBER_SELECT)
      .eq("project_id", input.projectId)
      .eq("tree_id", input.sourceTreeId),
    client
      .from("family_tree_persons")
      .select("person_id")
      .eq("project_id", input.projectId)
      .eq("tree_id", input.targetTreeId),
  ]);
  for (const result of [sourceTree, targetTree, sourceMembersResult, targetMembersResult]) {
    if (result.error) throw result.error;
  }
  if (!(sourceTree.data as TreeIdRow | null)?.id || !(targetTree.data as TreeIdRow | null)?.id) {
    throw new Error("Не вдалося знайти одне з дерев для об’єднання.");
  }

  const targetMemberIds = new Set(((targetMembersResult.data ?? []) as Array<{ person_id: string }>).map((row) => row.person_id));
  const sourceMembers = (sourceMembersResult.data ?? []) as TreeMemberRow[];
  const missingMembers = sourceMembers
    .filter((member) => !targetMemberIds.has(member.person_id))
    .map((member) => ({
      project_id: input.projectId,
      tree_id: input.targetTreeId,
      person_id: member.person_id,
      member_role: member.member_role ?? "member",
      display_order: member.display_order ?? 0,
      notes: member.notes ?? "",
    }));
  if (missingMembers.length) {
    const insert = await client.from("family_tree_persons").insert(missingMembers);
    if (insert.error) throw insert.error;
  }

  await updateTreeId("family_groups", input.projectId, input.sourceTreeId, input.targetTreeId);
  await updateTreeId("parent_sets", input.projectId, input.sourceTreeId, input.targetTreeId);
  await updateTreeId("partner_relationships", input.projectId, input.sourceTreeId, input.targetTreeId);
  await updateTreeId("parent_child_relationships", input.projectId, input.sourceTreeId, input.targetTreeId);
  await updateTreeId("association_relationships", input.projectId, input.sourceTreeId, input.targetTreeId);
  await updateTreeId("family_tree_research_issues", input.projectId, input.sourceTreeId, input.targetTreeId);
  await updateTreeId("legacy_person_relation_graph_edges", input.projectId, input.sourceTreeId, input.targetTreeId);

  const removeLayout = await client
    .from("tree_layout_positions")
    .delete()
    .eq("project_id", input.projectId)
    .eq("tree_id", input.sourceTreeId);
  if (removeLayout.error) throw removeLayout.error;

  const target = targetTree.data as TreeIdRow;
  const source = sourceTree.data as TreeIdRow;
  if (!target.root_person_id && source.root_person_id) {
    const root = await client
      .from("family_trees")
      .update({ root_person_id: source.root_person_id })
      .eq("project_id", input.projectId)
      .eq("id", input.targetTreeId);
    if (root.error) throw root.error;
  }
  if (source.is_default) await setDefaultFamilyTree({ projectId: input.projectId, treeId: input.targetTreeId });

  await writeFamilyTreeMergeHistory({
    projectId: input.projectId,
    sourceTreeId: input.sourceTreeId,
    targetTreeId: input.targetTreeId,
    sourceRootPersonId: source.root_person_id ?? null,
    targetRootPersonId: target.root_person_id ?? null,
    movedMemberIds: missingMembers.map((member) => member.person_id),
  });

  const removeSource = await client
    .from("family_trees")
    .delete()
    .eq("project_id", input.projectId)
    .eq("id", input.sourceTreeId);
  if (removeSource.error) throw removeSource.error;
}

async function writeFamilyTreeMergeHistory(input: {
  projectId: EntityId;
  sourceTreeId: EntityId;
  targetTreeId: EntityId;
  sourceRootPersonId: EntityId | null;
  targetRootPersonId: EntityId | null;
  movedMemberIds: EntityId[];
}): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("family_tree_merge_history")
    .insert({
      project_id: input.projectId,
      tree_id: input.targetTreeId,
      survivor_person_id: input.targetRootPersonId,
      merged_person_id: input.sourceRootPersonId,
      moved_edges: [
        {
          type: "tree_merge",
          sourceTreeId: input.sourceTreeId,
          targetTreeId: input.targetTreeId,
          movedPersonIds: input.movedMemberIds,
        },
      ],
      notes: `Об’єднано дерево ${input.sourceTreeId} з деревом ${input.targetTreeId}. Перенесено осіб: ${input.movedMemberIds.length}.`,
    });
  if (error) {
    if (isMissingFamilyTreeTableError(error)) return;
    throw error;
  }
}

async function updateTreeId(
  table: string,
  projectId: EntityId,
  sourceTreeId: EntityId,
  targetTreeId: EntityId,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from(table)
    .update({ tree_id: targetTreeId })
    .eq("project_id", projectId)
    .eq("tree_id", sourceTreeId);
  if (error) throw error;
}

async function readPeopleForAdmin(projectId: EntityId, personIds: EntityId[]): Promise<PersonRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("persons")
    .select("id, surname, full_name, given_name, patronymic, is_living, death_date")
    .eq("project_id", projectId)
    .in("id", personIds);
  if (error) throw error;
  return (data ?? []) as PersonRow[];
}

function treeFromRow(row: FamilyTreeRow): FamilyTree {
  return {
    id: row.id,
    projectId: row.project_id,
    researchId: row.research_id,
    title: row.title,
    description: row.description,
    rootPersonId: row.root_person_id,
    isDefault: row.is_default,
    privacyStatus: asPrivacyStatus(row.privacy_status),
    settings: row.settings ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mergeHistoryFromRow(row: MergeHistoryRow): FamilyTreeMergeHistorySummary {
  const payload = Array.isArray(row.moved_edges) ? row.moved_edges[0] : null;
  const payloadRecord = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const movedPersonIds = Array.isArray(payloadRecord.movedPersonIds) ? payloadRecord.movedPersonIds : [];
  return {
    id: row.id,
    treeId: row.tree_id,
    sourceTreeId: typeof payloadRecord.sourceTreeId === "string" ? payloadRecord.sourceTreeId : null,
    targetTreeId: typeof payloadRecord.targetTreeId === "string" ? payloadRecord.targetTreeId : row.tree_id,
    survivorPersonId: row.survivor_person_id,
    mergedPersonId: row.merged_person_id,
    movedPersons: movedPersonIds.length,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function personDisplayName(person: PersonRow | undefined): string {
  if (!person) return "";
  return person.full_name || [person.surname, person.given_name, person.patronymic].filter(Boolean).join(" ");
}

function countByTree(rows: unknown, treeId: EntityId): number {
  if (!Array.isArray(rows)) return 0;
  return rows.filter((row) => (row as { tree_id?: string }).tree_id === treeId).length;
}

function asPrivacyStatus(value: unknown): FamilyTreePrivacyStatus {
  return value === "project" || value === "public" || value === "confidential" ? value : "private";
}

function isMissingFamilyTreeTableError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return (
    text.includes("family_trees") ||
    text.includes("family_tree_persons") ||
    text.includes("family_groups") ||
    text.includes("parent_sets") ||
    text.includes("partner_relationships") ||
    text.includes("parent_child_relationships") ||
    text.includes("association_relationships") ||
    text.includes("tree_layout_positions") ||
    text.includes("family_tree_merge_history") ||
    text.includes("legacy_person_relation_graph_edges") ||
    text.includes("family_tree_research_issues")
  ) && (text.includes("does not exist") || text.includes("schema cache") || text.includes("PGRST205"));
}
