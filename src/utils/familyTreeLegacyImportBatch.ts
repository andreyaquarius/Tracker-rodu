import type { EntityId, PersonRelation } from "../types";
import type {
  FamilyGroupType,
  ParentChildRelationshipType,
  ParentRoleLabel,
  ParentSetType,
  PartnerRelationshipType,
} from "../types/familyTree";
import type { FamilyTreeProjectionEdge } from "./familyTreeProjection.ts";
import {
  confidenceForEvidence,
  parentRelationshipTraits,
  parentSetTypeForRelationship,
  statusForPartnerType,
} from "./familyTreeMutationRules.ts";

export const LEGACY_IMPORT_ROW_BATCH_SIZE = 200;
export const LEGACY_IMPORT_PARENT_EDGE_BATCH_SIZE = 100;

export interface LegacyFamilyTreeImportPlanInput {
  projectId: EntityId;
  treeId: EntityId;
  relations: readonly PersonRelation[];
  partnerEdges: readonly FamilyTreeProjectionEdge[];
  parentChildEdges: readonly FamilyTreeProjectionEdge[];
  idFactory?: () => EntityId;
}

export interface LegacyImportFamilyGroupRow {
  id: EntityId;
  project_id: EntityId;
  tree_id: EntityId;
  group_type: FamilyGroupType;
  display_label: string;
  primary_partner_1_id: EntityId | null;
  primary_partner_2_id: EntityId | null;
  metadata: Record<string, unknown>;
}

export interface LegacyImportFamilyGroupMemberRow {
  project_id: EntityId;
  family_group_id: EntityId;
  person_id: EntityId;
  member_role: "partner" | "parent" | "child";
  display_order: number;
}

export interface LegacyImportPartnerRelationshipRow {
  id: EntityId;
  project_id: EntityId;
  tree_id: EntityId;
  family_group_id: EntityId;
  person_a_id: EntityId;
  person_b_id: EntityId;
  relationship_type: PartnerRelationshipType;
  status: string;
  evidence_status: FamilyTreeProjectionEdge["evidenceStatus"];
  confidence: number;
  is_primary_for_display: boolean;
  privacy_status: "private";
  start_date: string;
  start_place: string;
  end_date: string;
  end_place: string;
  notes: string;
  metadata: Record<string, unknown>;
}

export interface LegacyImportParentSetRow {
  id: EntityId;
  project_id: EntityId;
  tree_id: EntityId;
  child_id: EntityId;
  family_group_id: EntityId | null;
  set_type: ParentSetType;
  is_preferred_for_display: boolean;
  is_default_for_pedigree: boolean;
  display_order: number;
  notes: string;
  metadata: Record<string, unknown>;
}

export interface LegacyImportParentChildRow {
  id: EntityId;
  project_id: EntityId;
  tree_id: EntityId;
  parent_id: EntityId;
  child_id: EntityId;
  parent_set_id: EntityId;
  family_group_id: EntityId | null;
  relationship_type: ParentChildRelationshipType;
  parent_role_label: ParentRoleLabel;
  evidence_status: FamilyTreeProjectionEdge["evidenceStatus"];
  confidence: number;
  is_primary_for_display: boolean;
  is_bloodline: boolean;
  is_legal: boolean;
  is_social: boolean;
  privacy_status: "private";
  notes: string;
  metadata: Record<string, unknown>;
}

export interface LegacyFamilyTreeImportPlan {
  familyGroups: LegacyImportFamilyGroupRow[];
  familyGroupMembers: LegacyImportFamilyGroupMemberRow[];
  partnerRelationships: LegacyImportPartnerRelationshipRow[];
  parentSets: LegacyImportParentSetRow[];
  /** Ancestor-first order keeps the database cycle trigger's recursive scan shallow. */
  parentChildRelationships: LegacyImportParentChildRow[];
}

export type LegacyImportMutationTable =
  | "family_groups"
  | "partner_relationships"
  | "parent_sets"
  | "parent_child_relationships"
  | "family_group_members";

export interface LegacyImportMutationBatch {
  table: LegacyImportMutationTable;
  mode: "insert" | "upsert";
  rows: object[];
}

interface ParentEdgeGroup {
  originalIndex: number;
  childId: EntityId;
  setType: ParentSetType;
  edges: FamilyTreeProjectionEdge[];
}

/**
 * Produces FK-safe rows without any database round trips. Callers insert the
 * returned collections in table dependency order and in bounded batches.
 */
export function buildLegacyFamilyTreeImportPlan(
  input: LegacyFamilyTreeImportPlanInput,
): LegacyFamilyTreeImportPlan {
  const idFactory = input.idFactory ?? (() => crypto.randomUUID());
  const relationById = new Map(input.relations.map((relation) => [relation.id, relation]));
  const familyGroups: LegacyImportFamilyGroupRow[] = [];
  const familyGroupMembers = new Map<string, LegacyImportFamilyGroupMemberRow>();
  const partnerRelationships: LegacyImportPartnerRelationshipRow[] = [];
  const parentSets: LegacyImportParentSetRow[] = [];
  const parentChildRelationships: LegacyImportParentChildRow[] = [];
  const familyGroupByXref = new Map<string, EntityId>();
  const familyGroupByPair = new Map<string, EntityId>();

  const addFamilyMember = (row: LegacyImportFamilyGroupMemberRow) => {
    familyGroupMembers.set(
      [row.family_group_id, row.person_id, row.member_role].join("|"),
      row,
    );
  };

  const ensureFamilyGroup = (
    parentIds: readonly EntityId[],
    familyXref: string | undefined,
    rawNotes: string | undefined,
  ): EntityId => {
    const parents = Array.from(new Set(parentIds));
    const pairKey = parents.length >= 2 ? personPairKey(parents[0], parents[1]) : "";
    const byXref = familyXref ? familyGroupByXref.get(familyXref) : undefined;
    if (byXref) return byXref;
    // A GEDCOM FAM record is a distinct union even when the same two people
    // partnered more than once. Pair fallback is only valid for records that
    // do not carry a FAM XREF.
    const byPair = !familyXref && pairKey ? familyGroupByPair.get(pairKey) : undefined;
    if (byPair) {
      return byPair;
    }

    const id = idFactory();
    // The schema permits only one `couple` group per person pair. Preserve a
    // repeated GEDCOM union as its own `other` group, linked to its own partner
    // relationship and familyXref, instead of merging or violating the index.
    const isRepeatedPair = Boolean(pairKey && familyGroupByPair.has(pairKey));
    familyGroups.push({
      id,
      project_id: input.projectId,
      tree_id: input.treeId,
      group_type: parents.length >= 2
        ? isRepeatedPair ? "other" : "couple"
        : "single_parent",
      display_label: "",
      primary_partner_1_id: parents[0] ?? null,
      primary_partner_2_id: parents[1] ?? null,
      metadata: familyXref
        ? { source: "gedcom_import", familyXref, rawNotes: rawNotes ?? "" }
        : { source: "gedcom_import" },
    });
    if (familyXref) familyGroupByXref.set(familyXref, id);
    if (pairKey && !familyGroupByPair.has(pairKey)) familyGroupByPair.set(pairKey, id);
    for (const [index, parentId] of parents.entries()) {
      addFamilyMember({
        project_id: input.projectId,
        family_group_id: id,
        person_id: parentId,
        member_role: parents.length >= 2 ? "partner" : "parent",
        display_order: index,
      });
    }
    return id;
  };

  for (const edge of input.partnerEdges) {
    const relation = edge.legacyRelationId ? relationById.get(edge.legacyRelationId) : undefined;
    const gedcom = relation?.gedcomMetadata;
    const familyGroupId = ensureFamilyGroup(
      [edge.fromPersonId, edge.toPersonId],
      gedcom?.familyXref,
      gedcom?.rawNotes,
    );
    const relationshipType = edge.relationshipType as PartnerRelationshipType;
    partnerRelationships.push({
      id: idFactory(),
      project_id: input.projectId,
      tree_id: input.treeId,
      family_group_id: familyGroupId,
      person_a_id: edge.fromPersonId,
      person_b_id: edge.toPersonId,
      relationship_type: relationshipType,
      status: statusForPartnerType(relationshipType),
      evidence_status: edge.evidenceStatus,
      confidence: confidenceForEvidence(edge.evidenceStatus),
      is_primary_for_display: true,
      privacy_status: "private",
      start_date: gedcom?.startDate ?? "",
      start_place: gedcom?.startPlace ?? "",
      end_date: gedcom?.endDate ?? "",
      end_place: gedcom?.endPlace ?? "",
      notes: gedcom?.rawNotes ?? "",
      metadata: {
        source: "gedcom_import",
        legacyRelationId: edge.legacyRelationId ?? "",
        ...(gedcom ? { familyXref: gedcom.familyXref } : {}),
      },
    });
  }

  const parentGroups = orderParentGroupsAncestorFirst(
    groupParentEdges(input.parentChildEdges),
    input.parentChildEdges,
  );
  const parentSetCountByChild = new Map<EntityId, number>();

  for (const group of parentGroups) {
    const parentIds = Array.from(new Set(group.edges.map((edge) => edge.fromPersonId)));
    const relations = group.edges.flatMap((edge) => {
      const relation = edge.legacyRelationId ? relationById.get(edge.legacyRelationId) : undefined;
      return relation ? [relation] : [];
    });
    const gedcom = relations.map((relation) => relation.gedcomMetadata).find(Boolean);
    let familyGroupId = gedcom?.familyXref
      ? familyGroupByXref.get(gedcom.familyXref) ?? null
      : null;
    if (!familyGroupId && !gedcom?.familyXref && parentIds.length === 2) {
      familyGroupId = familyGroupByPair.get(personPairKey(parentIds[0], parentIds[1])) ?? null;
    }
    if (!familyGroupId && gedcom?.familyXref) {
      familyGroupId = ensureFamilyGroup(parentIds, gedcom.familyXref, gedcom.rawNotes);
    }

    const parentSetId = idFactory();
    const displayOrder = parentSetCountByChild.get(group.childId) ?? 0;
    parentSetCountByChild.set(group.childId, displayOrder + 1);
    parentSets.push({
      id: parentSetId,
      project_id: input.projectId,
      tree_id: input.treeId,
      child_id: group.childId,
      family_group_id: familyGroupId,
      set_type: group.setType,
      is_preferred_for_display: displayOrder === 0,
      is_default_for_pedigree: displayOrder === 0,
      display_order: displayOrder,
      notes: gedcom?.rawNotes ?? "",
      metadata: gedcom
        ? { source: "gedcom_import", familyXref: gedcom.familyXref, pedigree: gedcom.pedigree }
        : { source: "family_tree_builder" },
    });

    for (const [index, edge] of uniqueParentEdges(group.edges).entries()) {
      const relationshipType = edge.relationshipType as ParentChildRelationshipType;
      const traits = parentRelationshipTraits(relationshipType);
      parentChildRelationships.push({
        id: idFactory(),
        project_id: input.projectId,
        tree_id: input.treeId,
        parent_id: edge.fromPersonId,
        child_id: edge.toPersonId,
        parent_set_id: parentSetId,
        family_group_id: familyGroupId,
        relationship_type: relationshipType,
        parent_role_label: edge.parentRoleLabel ?? "parent",
        evidence_status: edge.evidenceStatus,
        confidence: confidenceForEvidence(edge.evidenceStatus),
        is_primary_for_display: true,
        is_bloodline: traits.isBloodline,
        is_legal: traits.isLegal,
        is_social: traits.isSocial,
        privacy_status: "private",
        notes: gedcom?.rawNotes ?? "",
        metadata: {
          source: "gedcom_import",
          legacyRelationId: edge.legacyRelationId ?? "",
          ...(gedcom
            ? { familyXref: gedcom.familyXref, pedigree: gedcom.pedigree }
            : {}),
        },
      });
      if (familyGroupId) {
        addFamilyMember({
          project_id: input.projectId,
          family_group_id: familyGroupId,
          person_id: edge.fromPersonId,
          member_role: "parent",
          display_order: index,
        });
        addFamilyMember({
          project_id: input.projectId,
          family_group_id: familyGroupId,
          person_id: edge.toPersonId,
          member_role: "child",
          display_order: 10,
        });
      }
    }
  }

  return {
    familyGroups,
    familyGroupMembers: Array.from(familyGroupMembers.values()),
    partnerRelationships,
    parentSets,
    parentChildRelationships,
  };
}

export function chunkLegacyImportRows<T>(
  rows: readonly T[],
  size = LEGACY_IMPORT_ROW_BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > LEGACY_IMPORT_ROW_BATCH_SIZE) {
    throw new RangeError(`Legacy family-tree import batch size must be between 1 and ${LEGACY_IMPORT_ROW_BATCH_SIZE}.`);
  }
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

/**
 * Returns the exact HTTP mutation units in FK-safe order. Row-level database
 * triggers remain active because every unit is still a normal table mutation.
 */
export function buildLegacyImportMutationBatches(
  plan: LegacyFamilyTreeImportPlan,
): LegacyImportMutationBatch[] {
  const batches: LegacyImportMutationBatch[] = [];
  const append = (
    table: LegacyImportMutationTable,
    mode: LegacyImportMutationBatch["mode"],
    rows: readonly object[],
    batchSize = LEGACY_IMPORT_ROW_BATCH_SIZE,
  ) => {
    for (const batch of chunkLegacyImportRows(rows, batchSize)) {
      batches.push({ table, mode, rows: batch });
    }
  };

  append("family_groups", "insert", plan.familyGroups);
  append("partner_relationships", "insert", plan.partnerRelationships);
  append("parent_sets", "insert", plan.parentSets);
  append(
    "parent_child_relationships",
    "insert",
    plan.parentChildRelationships,
    LEGACY_IMPORT_PARENT_EDGE_BATCH_SIZE,
  );
  append("family_group_members", "upsert", plan.familyGroupMembers);
  return batches;
}

export function legacyImportExpectedSyncKeys(
  edges: readonly FamilyTreeProjectionEdge[],
): Set<string> {
  return new Set(edges.flatMap((edge) => edge.legacyRelationId
    ? [`${edge.legacyRelationId}|${edge.kind}`]
    : []));
}

function groupParentEdges(edges: readonly FamilyTreeProjectionEdge[]): ParentEdgeGroup[] {
  const groups = new Map<string, ParentEdgeGroup>();
  for (const [index, edge] of edges.entries()) {
    const setType = (edge.parentSetType
      ?? parentSetTypeForRelationship(edge.relationshipType as ParentChildRelationshipType)) as ParentSetType;
    const key = `${edge.toPersonId}|${setType}`;
    const group = groups.get(key) ?? {
      originalIndex: index,
      childId: edge.toPersonId,
      setType,
      edges: [],
    };
    group.edges.push(edge);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function orderParentGroupsAncestorFirst(
  groups: ParentEdgeGroup[],
  edges: readonly FamilyTreeProjectionEdge[],
): ParentEdgeGroup[] {
  const depth = topologicalDepthByPerson(edges);
  return [...groups].sort((first, second) =>
    (depth.get(first.childId) ?? 0) - (depth.get(second.childId) ?? 0)
    || first.originalIndex - second.originalIndex);
}

function topologicalDepthByPerson(
  edges: readonly FamilyTreeProjectionEdge[],
): Map<EntityId, number> {
  const indegree = new Map<EntityId, number>();
  const children = new Map<EntityId, EntityId[]>();
  const depth = new Map<EntityId, number>();
  const seenEdges = new Set<string>();

  for (const edge of edges) {
    indegree.set(edge.fromPersonId, indegree.get(edge.fromPersonId) ?? 0);
    indegree.set(edge.toPersonId, indegree.get(edge.toPersonId) ?? 0);
    depth.set(edge.fromPersonId, depth.get(edge.fromPersonId) ?? 0);
    depth.set(edge.toPersonId, depth.get(edge.toPersonId) ?? 0);
    const key = `${edge.fromPersonId}|${edge.toPersonId}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    children.set(edge.fromPersonId, [...(children.get(edge.fromPersonId) ?? []), edge.toPersonId]);
    indegree.set(edge.toPersonId, (indegree.get(edge.toPersonId) ?? 0) + 1);
  }

  const queue = Array.from(indegree.entries())
    .filter(([, count]) => count === 0)
    .map(([personId]) => personId);
  let index = 0;
  while (index < queue.length) {
    const parentId = queue[index++];
    const parentDepth = depth.get(parentId) ?? 0;
    for (const childId of children.get(parentId) ?? []) {
      depth.set(childId, Math.max(depth.get(childId) ?? 0, parentDepth + 1));
      const nextIndegree = (indegree.get(childId) ?? 1) - 1;
      indegree.set(childId, nextIndegree);
      if (nextIndegree === 0) queue.push(childId);
    }
  }
  return depth;
}

function uniqueParentEdges(edges: readonly FamilyTreeProjectionEdge[]): FamilyTreeProjectionEdge[] {
  const result: FamilyTreeProjectionEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = [
      edge.fromPersonId,
      edge.toPersonId,
      edge.relationshipType,
      edge.parentRoleLabel ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function personPairKey(first: EntityId, second: EntityId): string {
  return [first, second].sort().join("|");
}
