import type {
  EvidenceStatus,
  FamilyGroupType,
  FamilyTreePersonRole,
  FamilyTreePrivacyStatus,
  ParentChildRelationshipType,
  ParentRoleLabel,
  ParentSetType,
  PartnerRelationshipStatus,
  PartnerRelationshipType,
} from "../types/familyTree";
import type { EntityId, Person, PersonRelation } from "../types";
import { getSupabaseClient } from "./supabaseAuth.ts";
import { deleteFamilyTree } from "./familyTreeAdminService.ts";
import { registerGedcomImportTree } from "./gedcomImportOperation.ts";
import { buildFamilyTreeProjection } from "../utils/familyTreeProjection.ts";
import {
  buildLegacyFamilyTreeImportPlan,
  buildLegacyImportMutationBatches,
  LEGACY_IMPORT_ROW_BATCH_SIZE,
  legacyImportExpectedSyncKeys,
  type LegacyFamilyTreeImportPlan,
} from "../utils/familyTreeLegacyImportBatch.ts";
import {
  assertCanCreateParentChild,
  assertNotSelfRelationship,
  assertParentChildGraphAcyclic,
  canAutoCreatePartnerRelationshipForParentType,
  confidenceForEvidence,
  parentRelationshipTraits,
  parentSetTypeForRelationship,
  roleLabelForParentIntent,
  statusForPartnerType,
  legacyChildRelationType,
  legacyParentRelationType,
  legacySiblingRelationType,
  legacySpouseRelationType,
  legacyStatusForEvidence,
  isLegacySpouseRelationType,
  selectReusableParentSet,
} from "../utils/familyTreeMutationRules.ts";

export {
  assertCanCreateParentChild,
  assertNotSelfRelationship,
  assertParentChildGraphAcyclic,
  canAutoCreatePartnerRelationshipForParentType,
  confidenceForEvidence,
  parentRelationshipTraits,
  parentSetTypeForRelationship,
  roleLabelForParentIntent,
  statusForPartnerType,
} from "../utils/familyTreeMutationRules.ts";

export type FamilyTreeBuilderAction =
  | "create_root"
  | "add_father"
  | "add_mother"
  | "add_parent"
  | "add_partner"
  | "add_child"
  | "add_sibling";

export interface FamilyTreePersonMutationDraft {
  surname: string;
  maidenSurname?: string;
  givenName: string;
  patronymic: string;
  gender: string;
  birthDate: string;
  deathDate: string;
  isLiving: boolean;
  privacyStatus: FamilyTreePrivacyStatus;
}

export interface FamilyTreeMutationBaseInput {
  projectId: EntityId;
  treeId: EntityId;
}

export type FamilyTreeRelationshipKind =
  | "parent_child"
  | "partner"
  | "association";

export interface DeleteRelationshipInput extends FamilyTreeMutationBaseInput {
  kind: FamilyTreeRelationshipKind;
  relationshipId: EntityId;
}

export interface DeleteRelationshipResult {
  deleted: true;
  kind: FamilyTreeRelationshipKind;
  relationshipId: EntityId;
  deletedRelationshipIds: EntityId[];
  treeId: EntityId;
  leftPersonId: EntityId;
  rightPersonId: EntityId;
  remainingLogicalEdges: number;
  deletedMappings: number;
  deletedLegacyRelations: number;
  deletedLegacyRelationIds: EntityId[];
}

export type DetachableRelationshipDirection = "parent" | "child" | "partner";

export interface DetachableFamilyTreeRelationship {
  kind: Extract<FamilyTreeRelationshipKind, "parent_child" | "partner">;
  direction: DetachableRelationshipDirection;
  relationshipId: EntityId;
  relatedPersonId: EntityId;
  relationshipType: string;
  evidenceStatus: EvidenceStatus;
  parentRoleLabel?: ParentRoleLabel;
  parentSetId?: EntityId;
  familyGroupId?: EntityId | null;
}

export interface FamilyTreeCreateRootPersonInput {
  projectId: EntityId;
  treeId?: EntityId;
  person: FamilyTreePersonMutationDraft;
  title?: string;
}

export interface FamilyTreeCreateRootPersonResult {
  treeId: EntityId;
  personId: EntityId;
}

export interface FamilyTreeCreatePersonInput extends FamilyTreeMutationBaseInput {
  person: FamilyTreePersonMutationDraft;
  memberRole?: FamilyTreePersonRole;
  referencePersonId?: EntityId;
}

export interface AddParentToPersonInput extends FamilyTreeCreatePersonInput {
  childId: EntityId;
  parentIntent: "father" | "mother" | "parent";
  relationshipType: ParentChildRelationshipType;
  evidenceStatus: EvidenceStatus;
}

export interface AddPartnerToPersonInput extends FamilyTreeCreatePersonInput {
  personId: EntityId;
  relationshipType: PartnerRelationshipType;
  evidenceStatus: EvidenceStatus;
}

export interface AddChildToPersonInput extends FamilyTreeCreatePersonInput {
  parentId: EntityId;
  secondParentId?: EntityId;
  familyGroupId?: EntityId | null;
  relationshipType: ParentChildRelationshipType;
  evidenceStatus: EvidenceStatus;
}

export interface AddSiblingToPersonInput extends FamilyTreeCreatePersonInput {
  personId: EntityId;
  relationshipType: ParentChildRelationshipType;
  evidenceStatus: EvidenceStatus;
}

export interface AttachExistingParentToPersonInput extends FamilyTreeMutationBaseInput {
  childId: EntityId;
  parentId: EntityId;
  parentIntent: "father" | "mother" | "parent";
  relationshipType: ParentChildRelationshipType;
  evidenceStatus: EvidenceStatus;
}

export interface AttachExistingPartnerToPersonInput extends FamilyTreeMutationBaseInput {
  personId: EntityId;
  partnerId: EntityId;
  relationshipType: PartnerRelationshipType;
  evidenceStatus: EvidenceStatus;
}

export interface AttachExistingChildToPersonInput extends FamilyTreeMutationBaseInput {
  parentId: EntityId;
  childId: EntityId;
  secondParentId?: EntityId;
  familyGroupId?: EntityId | null;
  relationshipType: ParentChildRelationshipType;
  evidenceStatus: EvidenceStatus;
}

export interface CreateParentSetInput extends FamilyTreeMutationBaseInput {
  childId: EntityId;
  setType: ParentSetType;
  familyGroupId?: EntityId | null;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateFamilyTreeFromLegacyImportInput {
  projectId: EntityId;
  title: string;
  persons: Person[];
  relations: PersonRelation[];
  rootPersonId?: EntityId;
  /** Stable ownership key for removing exactly one GEDCOM dataset. */
  importSourceKey?: string;
  makeDefault?: boolean;
  /** Durable rollback operation used by GEDCOM imports. */
  rollbackOperationId?: EntityId;
}

export interface CreateFamilyTreeFromLegacyImportResult {
  treeId: EntityId;
  rootPersonId: EntityId;
  persons: number;
  parentChildRelationships: number;
  partnerRelationships: number;
}

type PersonInsertRow = {
  project_id: string;
  research_id: string | null;
  status: string;
  gender: string;
  surname: string;
  given_name: string;
  patronymic: string;
  full_name: string;
  birth_date: string;
  death_date: string;
  is_living: boolean;
  privacy_status: string;
  custom_fields: Record<string, unknown>;
};

type IdRow = { id: string };
type ResearchRow = { research_id: string | null };
type PersonGenderRow = { gender: string | null };
export type ParentSetRow = {
  id: string;
  family_group_id: string | null;
  set_type: string;
  is_preferred_for_display: boolean;
  is_default_for_pedigree: boolean;
  display_order: number;
};
type ParentRelationshipRow = {
  parent_id: string;
  child_id: string;
  parent_set_id: string;
  family_group_id: string | null;
};
type ParentChildCycleRow = {
  parent_id: string;
  child_id: string;
  evidence_status: EvidenceStatus;
};
type PartnerRelationshipRow = {
  id: string;
  family_group_id: string | null;
  person_a_id: string;
  person_b_id: string;
};
type DetachableParentRelationshipRow = ParentRelationshipRow & {
  id: string;
  relationship_type: string;
  parent_role_label: ParentRoleLabel;
  evidence_status: EvidenceStatus;
};
type DetachablePartnerRelationshipRow = PartnerRelationshipRow & {
  relationship_type: string;
  evidence_status: EvidenceStatus;
};
type FamilyGroupRow = {
  id: string;
  primary_partner_1_id: string | null;
  primary_partner_2_id: string | null;
};
type FamilyTreeIdRow = { id: string; root_person_id: string | null; is_default?: boolean | null };

const PERSON_SELECT = "id";
const PARENT_SET_SELECT = "id, family_group_id, set_type, is_preferred_for_display, is_default_for_pedigree, display_order";
const PARENT_RELATIONSHIP_SELECT = "parent_id, child_id, parent_set_id, family_group_id";
const PARTNER_RELATIONSHIP_SELECT = "id, family_group_id, person_a_id, person_b_id";
const FAMILY_GROUP_SELECT = "id, primary_partner_1_id, primary_partner_2_id";
const DETACHABLE_PARENT_RELATIONSHIP_SELECT =
  "id, parent_id, child_id, parent_set_id, family_group_id, relationship_type, parent_role_label, evidence_status";
const DETACHABLE_PARTNER_RELATIONSHIP_SELECT =
  "id, family_group_id, person_a_id, person_b_id, relationship_type, evidence_status";
const MAIDEN_SURNAME_KEY = "__trackerRoduMaidenSurname";

export async function createRootPersonInTree(
  input: FamilyTreeCreateRootPersonInput,
): Promise<FamilyTreeCreateRootPersonResult> {
  const treeId = await findOrCreateFamilyTree(input.projectId, input.treeId, input.title);
  const personId = await createPersonInTree({
    projectId: input.projectId,
    treeId,
    person: input.person,
    memberRole: "root",
  });
  await setFamilyTreeRoot({
    projectId: input.projectId,
    treeId,
    personId,
  });
  return { treeId, personId };
}

export async function setFamilyTreeRoot(input: {
  projectId: EntityId;
  treeId: EntityId;
  personId: EntityId;
}): Promise<void> {
  const client = getSupabaseClient();
  await ensureTreeMember({
    projectId: input.projectId,
    treeId: input.treeId,
    personId: input.personId,
    memberRole: "root",
  });
  const clearRoots = await client
    .from("family_tree_persons")
    .update({ member_role: "member" })
    .eq("project_id", input.projectId)
    .eq("tree_id", input.treeId)
    .eq("member_role", "root")
    .neq("person_id", input.personId);
  if (clearRoots.error) throw clearRoots.error;

  const { error } = await client
    .from("family_trees")
    .update({ root_person_id: input.personId })
    .eq("project_id", input.projectId)
    .eq("id", input.treeId);
  if (error) throw error;
}

export async function createPersonInTree(input: FamilyTreeCreatePersonInput): Promise<EntityId> {
  const personId = await createCanonicalPerson(input);
  await ensureTreeMember({
    projectId: input.projectId,
    treeId: input.treeId,
    personId,
    memberRole: input.memberRole ?? "member",
  });
  return personId;
}

export async function createFamilyTreeFromLegacyImport(
  input: CreateFamilyTreeFromLegacyImportInput,
): Promise<CreateFamilyTreeFromLegacyImportResult | null> {
  if (!input.persons.length) return null;
  const rootPersonId = input.rootPersonId && input.persons.some((person) => person.id === input.rootPersonId)
    ? input.rootPersonId
    : input.persons[0].id;
  const treeId = await createImportedFamilyTree({
    projectId: input.projectId,
    title: input.title,
    rootPersonId,
    makeDefault: input.makeDefault ?? true,
    rollbackOperationId: input.rollbackOperationId,
    importSourceKey: input.importSourceKey,
  });

  try {
  const projection = buildFamilyTreeProjection({
    projectId: input.projectId,
    treeId,
    persons: input.persons,
    legacyRelations: input.relations,
    includeIsolatedPersons: true,
  });
  assertParentChildGraphAcyclic(
    projection.parentChildEdges.map((edge) => ({
      parentId: edge.fromPersonId,
      childId: edge.toPersonId,
      evidenceStatus: edge.evidenceStatus,
    })),
  );
  await ensureTreeMembers(input.persons.map((person, index) => ({
    projectId: input.projectId,
    treeId,
    personId: person.id,
    memberRole: person.id === rootPersonId ? "root" : "member",
    displayOrder: index,
  })));

  const importEdges = [...projection.partnerEdges, ...projection.parentChildEdges];
  const syncCoverage = await readLegacyImportSyncCoverage(
    input.projectId,
    treeId,
    importEdges,
  );
  if (syncCoverage.complete) {
    return legacyImportResult(input, treeId, rootPersonId, projection);
  }

  // A newly created target tree has no rows to reconcile. Build all dependent
  // UUIDs locally and use bounded inserts instead of thousands of per-edge
  // SELECT/INSERT calls. Existing or partially synchronized trees retain the
  // conservative reconciliation path below.
  const targetTreeHasGraph = await familyTreeHasStoredGraph(input.projectId, treeId);
  if (syncCoverage.matched === 0 && !targetTreeHasGraph) {
    const plan = buildLegacyFamilyTreeImportPlan({
      projectId: input.projectId,
      treeId,
      relations: input.relations,
      partnerEdges: projection.partnerEdges,
      parentChildEdges: projection.parentChildEdges,
    });
    await persistLegacyFamilyTreeImportPlan(plan);
    return legacyImportResult(input, treeId, rootPersonId, projection);
  }

  const partnerFamilyGroupByPair = new Map<string, EntityId>();
  const familyGroupByGedcomXref = new Map<string, EntityId>();
  const legacyRelationById = new Map(input.relations.map((relation) => [relation.id, relation]));

  for (const edge of projection.partnerEdges) {
    const legacyRelation = edge.legacyRelationId ? legacyRelationById.get(edge.legacyRelationId) : undefined;
    const gedcom = legacyRelation?.gedcomMetadata;
    const familyGroupId = gedcom?.familyXref
      ? familyGroupByGedcomXref.get(gedcom.familyXref) ?? await createImportedFamilyGroup({
          projectId: input.projectId,
          treeId,
          parentIds: [edge.fromPersonId, edge.toPersonId],
          familyXref: gedcom.familyXref,
          rawNotes: gedcom.rawNotes,
        })
      : await findOrCreateCoupleFamilyGroup({
          projectId: input.projectId,
          treeId,
          personAId: edge.fromPersonId,
          personBId: edge.toPersonId,
        });
    if (gedcom?.familyXref) familyGroupByGedcomXref.set(gedcom.familyXref, familyGroupId);
    partnerFamilyGroupByPair.set(personPairKey(edge.fromPersonId, edge.toPersonId), familyGroupId);
    await createPartnerRelationship({
      projectId: input.projectId,
      treeId,
      familyGroupId,
      personAId: edge.fromPersonId,
      personBId: edge.toPersonId,
      relationshipType: edge.relationshipType as PartnerRelationshipType,
      evidenceStatus: edge.evidenceStatus,
      ensureMembers: false,
      startDate: gedcom?.startDate,
      startPlace: gedcom?.startPlace,
      endDate: gedcom?.endDate,
      endPlace: gedcom?.endPlace,
      notes: gedcom?.rawNotes,
      metadata: {
        source: "gedcom_import",
        legacyRelationId: edge.legacyRelationId ?? "",
        ...(gedcom ? { familyXref: gedcom.familyXref } : {}),
      },
    });
  }

  const parentEdgesBySet = groupParentEdgesForImport(projection.parentChildEdges);
  for (const [setKey, edges] of parentEdgesBySet.entries()) {
    const first = edges[0];
    if (!first) continue;
    const parentIds = Array.from(new Set(edges.map((edge) => edge.fromPersonId)));
    const legacyRelations = edges
      .map((edge) => edge.legacyRelationId ? legacyRelationById.get(edge.legacyRelationId) : undefined)
      .filter((relation): relation is PersonRelation => Boolean(relation));
    const gedcom = legacyRelations.map((relation) => relation.gedcomMetadata).find(Boolean);
    let familyGroupId = gedcom?.familyXref ? familyGroupByGedcomXref.get(gedcom.familyXref) ?? null : null;
    if (!familyGroupId && parentIds.length === 2) {
      familyGroupId = partnerFamilyGroupByPair.get(personPairKey(parentIds[0], parentIds[1])) ?? null;
    }
    if (!familyGroupId && gedcom?.familyXref) {
      familyGroupId = await createImportedFamilyGroup({
        projectId: input.projectId,
        treeId,
        parentIds,
        familyXref: gedcom.familyXref,
        rawNotes: gedcom.rawNotes,
      });
      familyGroupByGedcomXref.set(gedcom.familyXref, familyGroupId);
    }
    const parentSetId = await createParentSet({
      projectId: input.projectId,
      treeId,
      childId: first.toPersonId,
      setType: (first.parentSetType ?? parentSetTypeForRelationship(first.relationshipType as ParentChildRelationshipType)) as ParentSetType,
      familyGroupId,
      notes: gedcom?.rawNotes,
      metadata: gedcom ? { source: "gedcom_import", familyXref: gedcom.familyXref, pedigree: gedcom.pedigree } : undefined,
    });

    const uniqueEdges = uniqueParentChildImportEdges(edges);
    for (const [index, edge] of uniqueEdges.entries()) {
      await createParentChildRelationship({
        projectId: input.projectId,
        treeId,
        parentId: edge.fromPersonId,
        childId: edge.toPersonId,
        parentSetId,
        familyGroupId,
        relationshipType: edge.relationshipType as ParentChildRelationshipType,
        parentRoleLabel: edge.parentRoleLabel ?? "parent",
        evidenceStatus: edge.evidenceStatus,
        duplicateMode: "skip-check",
        ensureMembers: false,
        notes: gedcom?.rawNotes,
        metadata: {
          source: "gedcom_import",
          legacyRelationId: edge.legacyRelationId ?? "",
          ...(gedcom
            ? { familyXref: gedcom.familyXref, pedigree: gedcom.pedigree }
            : {}),
        },
      });
      if (familyGroupId) {
        await upsertFamilyGroupMember(input.projectId, familyGroupId, edge.fromPersonId, "parent", index);
      }
    }
  }

  return legacyImportResult(input, treeId, rootPersonId, projection);
  } catch (error) {
    try {
      await deleteFamilyTree({ projectId: input.projectId, treeId });
    } catch (cleanupError) {
      console.error("Failed to discard a partially created GEDCOM family tree", {
        projectId: input.projectId,
        treeId,
        cleanupError,
      });
    }
    throw error;
  }
}

export async function addParentToPerson(input: AddParentToPersonInput): Promise<EntityId> {
  const parentId = await createPersonInTree({ ...input, referencePersonId: input.childId });
  const parentSetId = await findOrCreateParentSet({
    projectId: input.projectId,
    treeId: input.treeId,
    childId: input.childId,
    setType: parentSetTypeForRelationship(input.relationshipType),
  });
  await createParentChildRelationship({
    projectId: input.projectId,
    treeId: input.treeId,
    parentId,
    childId: input.childId,
    parentSetId,
    familyGroupId: null,
    relationshipType: input.relationshipType,
    parentRoleLabel: roleLabelForParentIntent(input.parentIntent, input.relationshipType),
    evidenceStatus: input.evidenceStatus,
  });
  await upsertLegacyPersonRelation({
    projectId: input.projectId,
    personId: input.childId,
    relatedPersonId: parentId,
    relationType: legacyParentRelationType(input.parentIntent),
    evidenceStatus: input.evidenceStatus,
  });
  return parentId;
}

export async function addPartnerToPerson(input: AddPartnerToPersonInput): Promise<EntityId> {
  const partnerId = await createPersonInTree({ ...input, referencePersonId: input.personId });
  await ensurePartnerConnection({
    projectId: input.projectId,
    treeId: input.treeId,
    personAId: input.personId,
    personBId: partnerId,
    relationshipType: input.relationshipType,
    evidenceStatus: input.evidenceStatus,
  });
  return partnerId;
}

export async function addChildToPerson(input: AddChildToPersonInput): Promise<EntityId> {
  const childId = await createPersonInTree({ ...input, referencePersonId: input.parentId });
  const familyGroupId = await resolveParentSetFamilyGroup({
    projectId: input.projectId,
    treeId: input.treeId,
    firstParentId: input.parentId,
    secondParentId: input.secondParentId,
    preferredGroupId: input.familyGroupId,
  });
  const parentSetId = await createParentSet({
    projectId: input.projectId,
    treeId: input.treeId,
    childId,
    setType: parentSetTypeForRelationship(input.relationshipType),
    familyGroupId,
  });
  await createParentChildRelationship({
    projectId: input.projectId,
    treeId: input.treeId,
    parentId: input.parentId,
    childId,
    parentSetId,
    familyGroupId,
    relationshipType: input.relationshipType,
    parentRoleLabel: "parent",
    evidenceStatus: input.evidenceStatus,
  });
  await upsertLegacyPersonRelation({
    projectId: input.projectId,
    personId: input.parentId,
    relatedPersonId: childId,
    relationType: legacyChildRelationType(input.person.gender),
    evidenceStatus: input.evidenceStatus,
  });
  if (input.secondParentId) {
    await createParentChildRelationship({
      projectId: input.projectId,
      treeId: input.treeId,
      parentId: input.secondParentId,
      childId,
      parentSetId,
      familyGroupId,
      relationshipType: input.relationshipType,
      parentRoleLabel: "parent",
      evidenceStatus: input.evidenceStatus,
    });
    await upsertLegacyPersonRelation({
      projectId: input.projectId,
      personId: input.secondParentId,
      relatedPersonId: childId,
      relationType: legacyChildRelationType(input.person.gender),
      evidenceStatus: input.evidenceStatus,
    });
    await ensurePartnershipBackedBiologicalCoParents({
      projectId: input.projectId,
      treeId: input.treeId,
      firstParentId: input.parentId,
      secondParentId: input.secondParentId,
      familyGroupId,
      parentRelationshipType: input.relationshipType,
      evidenceStatus: input.evidenceStatus,
    });
  }
  return childId;
}

export async function addSiblingToPerson(input: AddSiblingToPersonInput): Promise<EntityId> {
  const parents = uniqueParentRelationshipRows(
    await readPreferredParents(input.projectId, input.treeId, input.personId),
  );
  if (!parents.length) {
    throw new Error("Спочатку додайте батьків або батьківський набір для вибраної особи.");
  }
  const siblingId = await createPersonInTree({ ...input, referencePersonId: input.personId });
  const firstParent = parents[0];
  const parentSetId = await createParentSet({
    projectId: input.projectId,
    treeId: input.treeId,
    childId: siblingId,
    setType: parentSetTypeForRelationship(input.relationshipType),
    familyGroupId: firstParent.family_group_id,
  });
  for (const parent of parents) {
    await createParentChildRelationship({
      projectId: input.projectId,
      treeId: input.treeId,
      parentId: parent.parent_id,
      childId: siblingId,
      parentSetId,
      familyGroupId: parent.family_group_id,
      relationshipType: input.relationshipType,
      parentRoleLabel: "parent",
      evidenceStatus: input.evidenceStatus,
    });
    await upsertLegacyPersonRelation({
      projectId: input.projectId,
      personId: siblingId,
      relatedPersonId: parent.parent_id,
      relationType: "батько або мати",
      evidenceStatus: input.evidenceStatus,
    });
  }
  await upsertLegacyPersonRelation({
    projectId: input.projectId,
    personId: input.personId,
    relatedPersonId: siblingId,
    relationType: legacySiblingRelationType(input.person.gender),
    evidenceStatus: input.evidenceStatus,
  });
  return siblingId;
}

export async function attachExistingParentToPerson(input: AttachExistingParentToPersonInput): Promise<EntityId> {
  await assertStoredParentChildMutationAcyclic({
    projectId: input.projectId,
    treeId: input.treeId,
    parentId: input.parentId,
    childId: input.childId,
    evidenceStatus: input.evidenceStatus,
  });
  const parentSetId = await findOrCreateParentSet({
    projectId: input.projectId,
    treeId: input.treeId,
    childId: input.childId,
    setType: parentSetTypeForRelationship(input.relationshipType),
  });
  await createParentChildRelationship({
    projectId: input.projectId,
    treeId: input.treeId,
    parentId: input.parentId,
    childId: input.childId,
    parentSetId,
    familyGroupId: null,
    relationshipType: input.relationshipType,
    parentRoleLabel: roleLabelForParentIntent(input.parentIntent, input.relationshipType),
    evidenceStatus: input.evidenceStatus,
    duplicateMode: "ignore",
  });
  await upsertLegacyPersonRelation({
    projectId: input.projectId,
    personId: input.childId,
    relatedPersonId: input.parentId,
    relationType: legacyParentRelationType(input.parentIntent),
    evidenceStatus: input.evidenceStatus,
  });
  return input.parentId;
}

export async function attachExistingPartnerToPerson(input: AttachExistingPartnerToPersonInput): Promise<EntityId> {
  await ensurePartnerConnection({
    projectId: input.projectId,
    treeId: input.treeId,
    personAId: input.personId,
    personBId: input.partnerId,
    relationshipType: input.relationshipType,
    evidenceStatus: input.evidenceStatus,
  });
  return input.partnerId;
}

export async function attachExistingChildToPerson(input: AttachExistingChildToPersonInput): Promise<EntityId> {
  await assertStoredParentChildMutationAcyclic({
    projectId: input.projectId,
    treeId: input.treeId,
    parentId: input.parentId,
    childId: input.childId,
    evidenceStatus: input.evidenceStatus,
  });
  if (input.secondParentId) {
    await assertStoredParentChildMutationAcyclic({
      projectId: input.projectId,
      treeId: input.treeId,
      parentId: input.secondParentId,
      childId: input.childId,
      evidenceStatus: input.evidenceStatus,
    });
  }
  const familyGroupId = await resolveParentSetFamilyGroup({
    projectId: input.projectId,
    treeId: input.treeId,
    firstParentId: input.parentId,
    secondParentId: input.secondParentId,
    preferredGroupId: input.familyGroupId,
  });
  const parentSetId = await findOrCreateParentSet({
    projectId: input.projectId,
    treeId: input.treeId,
    childId: input.childId,
    setType: parentSetTypeForRelationship(input.relationshipType),
    familyGroupId,
  });
  await createParentChildRelationship({
    projectId: input.projectId,
    treeId: input.treeId,
    parentId: input.parentId,
    childId: input.childId,
    parentSetId,
    familyGroupId,
    relationshipType: input.relationshipType,
    parentRoleLabel: "parent",
    evidenceStatus: input.evidenceStatus,
    duplicateMode: "ignore",
  });
  await upsertLegacyPersonRelation({
    projectId: input.projectId,
    personId: input.parentId,
    relatedPersonId: input.childId,
    relationType: legacyChildRelationType(await readPersonGender(input.projectId, input.childId)),
    evidenceStatus: input.evidenceStatus,
  });
  if (input.secondParentId) {
    await createParentChildRelationship({
      projectId: input.projectId,
      treeId: input.treeId,
      parentId: input.secondParentId,
      childId: input.childId,
      parentSetId,
      familyGroupId,
      relationshipType: input.relationshipType,
      parentRoleLabel: "parent",
      evidenceStatus: input.evidenceStatus,
      duplicateMode: "ignore",
    });
    await upsertLegacyPersonRelation({
      projectId: input.projectId,
      personId: input.secondParentId,
      relatedPersonId: input.childId,
      relationType: legacyChildRelationType(await readPersonGender(input.projectId, input.childId)),
      evidenceStatus: input.evidenceStatus,
    });
    await ensurePartnershipBackedBiologicalCoParents({
      projectId: input.projectId,
      treeId: input.treeId,
      firstParentId: input.parentId,
      secondParentId: input.secondParentId,
      familyGroupId,
      parentRelationshipType: input.relationshipType,
      evidenceStatus: input.evidenceStatus,
    });
  }
  return input.childId;
}

function uniqueParentRelationshipRows(rows: ParentRelationshipRow[]): ParentRelationshipRow[] {
  const byParent = new Map<EntityId, ParentRelationshipRow>();
  for (const row of rows) {
    if (!byParent.has(row.parent_id)) byParent.set(row.parent_id, row);
  }
  return Array.from(byParent.values());
}

async function resolveParentSetFamilyGroup(input: {
  projectId: EntityId;
  treeId: EntityId;
  firstParentId: EntityId;
  secondParentId?: EntityId;
  preferredGroupId?: EntityId | null;
}): Promise<EntityId | null> {
  if (!input.secondParentId) return input.preferredGroupId ?? null;
  if (input.preferredGroupId) return input.preferredGroupId;

  const existingPartnership = await readPartnerRelationship({
    projectId: input.projectId,
    treeId: input.treeId,
    personAId: input.firstParentId,
    personBId: input.secondParentId,
  });
  return existingPartnership?.family_group_id ?? null;
}

async function ensurePartnershipBackedBiologicalCoParents(input: {
  projectId: EntityId;
  treeId: EntityId;
  firstParentId: EntityId;
  secondParentId: EntityId;
  familyGroupId: EntityId | null;
  parentRelationshipType: ParentChildRelationshipType;
  evidenceStatus: EvidenceStatus;
}): Promise<void> {
  if (!canAutoCreatePartnerRelationshipForParentType(input.parentRelationshipType)) return;
  if (!input.familyGroupId) return;

  const existingPartnership = await readPartnerRelationship({
    projectId: input.projectId,
    treeId: input.treeId,
    personAId: input.firstParentId,
    personBId: input.secondParentId,
  });
  if (existingPartnership) return;

  const coupleGroup = await readCoupleFamilyGroup(
    input.projectId,
    input.treeId,
    input.firstParentId,
    input.secondParentId,
  );
  if (coupleGroup?.id !== input.familyGroupId) return;

  await ensurePartnerConnection({
    projectId: input.projectId,
    treeId: input.treeId,
    personAId: input.firstParentId,
    personBId: input.secondParentId,
    preferredGroupId: input.familyGroupId,
    relationshipType: "unknown",
    evidenceStatus: input.evidenceStatus,
  });
}

async function ensurePartnerConnection(input: {
  projectId: EntityId;
  treeId: EntityId;
  personAId: EntityId;
  personBId: EntityId;
  preferredGroupId?: EntityId;
  relationshipType: PartnerRelationshipType;
  evidenceStatus: EvidenceStatus;
}): Promise<EntityId> {
  const familyGroupId = await findOrCreateCoupleFamilyGroup({
    projectId: input.projectId,
    treeId: input.treeId,
    personAId: input.personAId,
    personBId: input.personBId,
    preferredGroupId: input.preferredGroupId,
  });
  await createPartnerRelationship({
    projectId: input.projectId,
    treeId: input.treeId,
    familyGroupId,
    personAId: input.personAId,
    personBId: input.personBId,
    relationshipType: input.relationshipType,
    evidenceStatus: input.evidenceStatus,
  });
  const relatedGender = await readPersonGender(input.projectId, input.personBId);
  await upsertLegacyPersonRelation({
    projectId: input.projectId,
    personId: input.personAId,
    relatedPersonId: input.personBId,
    relationType: legacySpouseRelationType(relatedGender),
    evidenceStatus: input.evidenceStatus,
  });
  return familyGroupId;
}

export async function createParentSet(input: CreateParentSetInput): Promise<EntityId> {
  const existingDefault = await hasDefaultParentSet(input.projectId, input.treeId, input.childId);
  const { data, error } = await getSupabaseClient()
    .from("parent_sets")
    .insert({
      project_id: input.projectId,
      tree_id: input.treeId,
      child_id: input.childId,
      family_group_id: input.familyGroupId ?? null,
      set_type: input.setType,
      is_preferred_for_display: !existingDefault,
      is_default_for_pedigree: !existingDefault,
      display_order: existingDefault ? 1 : 0,
      notes: input.notes ?? "",
      metadata: input.metadata ?? { source: "family_tree_builder" },
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as IdRow).id;
}

export async function updateParentChildRelationship(input: {
  projectId: EntityId;
  relationshipId: EntityId;
  relationshipType: ParentChildRelationshipType;
  parentRoleLabel: ParentRoleLabel;
  evidenceStatus: EvidenceStatus;
}): Promise<void> {
  const traits = parentRelationshipTraits(input.relationshipType);
  const { error } = await getSupabaseClient()
    .from("parent_child_relationships")
    .update({
      relationship_type: input.relationshipType,
      parent_role_label: input.parentRoleLabel,
      evidence_status: input.evidenceStatus,
      is_bloodline: traits.isBloodline,
      is_legal: traits.isLegal,
      is_social: traits.isSocial,
      confidence: confidenceForEvidence(input.evidenceStatus),
    })
    .eq("project_id", input.projectId)
    .eq("id", input.relationshipId);
  if (error) throw error;
}

export async function updatePartnerRelationship(input: {
  projectId: EntityId;
  relationshipId: EntityId;
  relationshipType: PartnerRelationshipType;
  evidenceStatus: EvidenceStatus;
  status?: PartnerRelationshipStatus;
}): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("partner_relationships")
    .update({
      relationship_type: input.relationshipType,
      evidence_status: input.evidenceStatus,
      status: input.status ?? statusForPartnerType(input.relationshipType),
      confidence: confidenceForEvidence(input.evidenceStatus),
    })
    .eq("project_id", input.projectId)
    .eq("id", input.relationshipId);
  if (error) throw error;
}

export async function listDetachableFamilyTreeRelationships(
  input: FamilyTreeMutationBaseInput & { personId: EntityId },
): Promise<DetachableFamilyTreeRelationship[]> {
  const client = getSupabaseClient();
  const [parents, children, partnersA, partnersB] = await Promise.all([
    client
      .from("parent_child_relationships")
      .select(DETACHABLE_PARENT_RELATIONSHIP_SELECT)
      .eq("project_id", input.projectId)
      .eq("tree_id", input.treeId)
      .eq("child_id", input.personId),
    client
      .from("parent_child_relationships")
      .select(DETACHABLE_PARENT_RELATIONSHIP_SELECT)
      .eq("project_id", input.projectId)
      .eq("tree_id", input.treeId)
      .eq("parent_id", input.personId),
    client
      .from("partner_relationships")
      .select(DETACHABLE_PARTNER_RELATIONSHIP_SELECT)
      .eq("project_id", input.projectId)
      .eq("tree_id", input.treeId)
      .eq("person_a_id", input.personId),
    client
      .from("partner_relationships")
      .select(DETACHABLE_PARTNER_RELATIONSHIP_SELECT)
      .eq("project_id", input.projectId)
      .eq("tree_id", input.treeId)
      .eq("person_b_id", input.personId),
  ]);
  for (const result of [parents, children, partnersA, partnersB]) {
    if (result.error) throw result.error;
  }

  const relationships: DetachableFamilyTreeRelationship[] = [];
  for (const row of (parents.data ?? []) as unknown as DetachableParentRelationshipRow[]) {
    relationships.push({
      kind: "parent_child",
      direction: "parent",
      relationshipId: row.id,
      relatedPersonId: row.parent_id,
      relationshipType: row.relationship_type,
      evidenceStatus: row.evidence_status,
      parentRoleLabel: row.parent_role_label,
      parentSetId: row.parent_set_id,
      familyGroupId: row.family_group_id,
    });
  }
  for (const row of (children.data ?? []) as unknown as DetachableParentRelationshipRow[]) {
    relationships.push({
      kind: "parent_child",
      direction: "child",
      relationshipId: row.id,
      relatedPersonId: row.child_id,
      relationshipType: row.relationship_type,
      evidenceStatus: row.evidence_status,
      parentRoleLabel: row.parent_role_label,
      parentSetId: row.parent_set_id,
      familyGroupId: row.family_group_id,
    });
  }
  for (const row of (partnersA.data ?? []) as unknown as DetachablePartnerRelationshipRow[]) {
    relationships.push({
      kind: "partner",
      direction: "partner",
      relationshipId: row.id,
      relatedPersonId: row.person_b_id,
      relationshipType: row.relationship_type,
      evidenceStatus: row.evidence_status,
      familyGroupId: row.family_group_id,
    });
  }
  for (const row of (partnersB.data ?? []) as unknown as DetachablePartnerRelationshipRow[]) {
    relationships.push({
      kind: "partner",
      direction: "partner",
      relationshipId: row.id,
      relatedPersonId: row.person_a_id,
      relationshipType: row.relationship_type,
      evidenceStatus: row.evidence_status,
      familyGroupId: row.family_group_id,
    });
  }
  return relationships.sort((left, right) => (
    left.kind.localeCompare(right.kind) ||
    left.direction.localeCompare(right.direction) ||
    left.relatedPersonId.localeCompare(right.relatedPersonId) ||
    left.relationshipId.localeCompare(right.relationshipId)
  ));
}

export async function deleteRelationship(
  input: DeleteRelationshipInput,
): Promise<DeleteRelationshipResult> {
  const { data, error } = await getSupabaseClient().rpc(
    "detach_family_tree_relationship",
    {
      target_project_id: input.projectId,
      target_tree_id: input.treeId,
      target_kind: input.kind,
      target_relationship_id: input.relationshipId,
    },
  );
  if (error) throw error;
  return parseDeleteRelationshipResult(data, input);
}

function parseDeleteRelationshipResult(
  value: unknown,
  input: DeleteRelationshipInput,
): DeleteRelationshipResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Сервер повернув некоректну відповідь після відв’язування особи.");
  }
  const record = value as Record<string, unknown>;
  const deletedRelationshipIds = stringArray(record.deletedRelationshipIds);
  const uniqueDeletedRelationshipIds = new Set(deletedRelationshipIds);
  const deletedLegacyRelationIds = Array.isArray(record.deletedLegacyRelationIds)
    ? record.deletedLegacyRelationIds.filter((id): id is string => typeof id === "string")
    : [];
  const leftPersonId = nonEmptyString(record.leftPersonId);
  const rightPersonId = nonEmptyString(record.rightPersonId);
  const remainingLogicalEdges = nonNegativeInteger(record.remainingLogicalEdges);
  const deletedMappings = nonNegativeInteger(record.deletedMappings);
  const deletedLegacyRelations = nonNegativeInteger(record.deletedLegacyRelations);
  if (
    record.deleted !== true ||
    record.kind !== input.kind ||
    record.relationshipId !== input.relationshipId ||
    record.treeId !== input.treeId ||
    !Array.isArray(record.deletedRelationshipIds) ||
    deletedRelationshipIds.length !== record.deletedRelationshipIds.length ||
    uniqueDeletedRelationshipIds.size !== deletedRelationshipIds.length ||
    !deletedRelationshipIds.includes(input.relationshipId) ||
    !leftPersonId ||
    !rightPersonId ||
    leftPersonId === rightPersonId ||
    remainingLogicalEdges !== 0 ||
    deletedMappings === null ||
    deletedLegacyRelations === null ||
    !Array.isArray(record.deletedLegacyRelationIds) ||
    deletedLegacyRelationIds.length !== record.deletedLegacyRelationIds.length
  ) {
    throw new Error("Сервер не підтвердив точне відв’язування вибраного зв’язку.");
  }
  return {
    deleted: true,
    kind: input.kind,
    relationshipId: input.relationshipId,
    deletedRelationshipIds,
    treeId: input.treeId,
    leftPersonId,
    rightPersonId,
    remainingLogicalEdges,
    deletedMappings,
    deletedLegacyRelations,
    deletedLegacyRelationIds,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

async function createCanonicalPerson(input: FamilyTreeCreatePersonInput): Promise<EntityId> {
  const row = await personDraftToRow(input);
  const { data, error } = await getSupabaseClient()
    .from("persons")
    .insert(row)
    .select(PERSON_SELECT)
    .single();
  if (error) throw error;
  return (data as IdRow).id;
}

async function findOrCreateFamilyTree(
  projectId: EntityId,
  preferredTreeId?: EntityId,
  title = "Родове дерево",
): Promise<EntityId> {
  const client = getSupabaseClient();
  if (preferredTreeId) {
    const { data, error } = await client
      .from("family_trees")
      .select("id, root_person_id")
      .eq("project_id", projectId)
      .eq("id", preferredTreeId)
      .maybeSingle();
    if (error) throw error;
    if ((data as FamilyTreeIdRow | null)?.id) return (data as FamilyTreeIdRow).id;
  }

  const existing = await client
    .from("family_trees")
    .select("id, root_person_id")
    .eq("project_id", projectId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;
  const existingId = (existing.data as FamilyTreeIdRow | null)?.id;
  if (existingId) return existingId;

  const { data, error } = await client
    .from("family_trees")
    .insert({
      project_id: projectId,
      title,
      description: "",
      is_default: true,
      privacy_status: "private",
      settings: { source: "family_tree_builder" },
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as IdRow).id;
}

async function personDraftToRow(input: FamilyTreeCreatePersonInput): Promise<PersonInsertRow> {
  const surname = input.person.surname.trim();
  const givenName = input.person.givenName.trim();
  const patronymic = input.person.patronymic.trim();
  const fullName = [surname, givenName, patronymic].filter(Boolean).join(" ");
  const maidenSurname = input.person.maidenSurname?.trim() ?? "";
  return {
    project_id: input.projectId,
    research_id: await resolveResearchId(input),
    status: "доведена",
    gender: input.person.gender || "невідомо",
    surname,
    given_name: givenName,
    patronymic,
    full_name: fullName,
    birth_date: input.person.birthDate.trim(),
    death_date: input.person.deathDate.trim(),
    is_living: input.person.isLiving,
    privacy_status: input.person.privacyStatus,
    custom_fields: {
      [MAIDEN_SURNAME_KEY]: maidenSurname,
      __familyTreeBuilder: {
        treeId: input.treeId,
        createdFrom: input.referencePersonId ?? null,
      },
    },
  };
}

async function upsertLegacyPersonRelation(input: {
  projectId: EntityId;
  personId: EntityId;
  relatedPersonId: EntityId;
  relationType: string;
  evidenceStatus: EvidenceStatus;
}): Promise<void> {
  if (input.personId === input.relatedPersonId) return;
  const client = getSupabaseClient();
  let existingQuery = client
    .from("person_relations")
    .select("id")
    .eq("project_id", input.projectId);

  if (isLegacySpouseRelationType(input.relationType)) {
    existingQuery = existingQuery
      .in("relation_type", ["чоловік", "дружина", "подружжя"])
      .or(
        `and(person_id.eq.${input.personId},related_person_id.eq.${input.relatedPersonId}),` +
        `and(person_id.eq.${input.relatedPersonId},related_person_id.eq.${input.personId})`,
      );
  } else {
    existingQuery = existingQuery
      .eq("person_id", input.personId)
      .eq("related_person_id", input.relatedPersonId)
      .eq("relation_type", input.relationType);
  }

  const existing = await existingQuery.limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data as IdRow[] | null)?.length) return;

  const { error } = await client
    .from("person_relations")
    .insert({
      project_id: input.projectId,
      person_id: input.personId,
      related_person_id: input.relatedPersonId,
      relation_type: input.relationType,
      status: legacyStatusForEvidence(input.evidenceStatus),
      evidence_text: "Створено з модуля родового дерева.",
      notes: "",
    });
  if (error) throw error;
}

async function readPersonGender(projectId: EntityId, personId: EntityId): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .from("persons")
    .select("gender")
    .eq("project_id", projectId)
    .eq("id", personId)
    .maybeSingle();
  if (error) throw error;
  return (data as PersonGenderRow | null)?.gender ?? "";
}

async function resolveResearchId(input: FamilyTreeCreatePersonInput): Promise<string | null> {
  const client = getSupabaseClient();
  if (input.referencePersonId) {
    const { data, error } = await client
      .from("persons")
      .select("research_id")
      .eq("project_id", input.projectId)
      .eq("id", input.referencePersonId)
      .maybeSingle();
    if (error) throw error;
    const researchId = (data as ResearchRow | null)?.research_id;
    if (researchId) return researchId;
  }

  const treeResult = await client
    .from("family_trees")
    .select("research_id")
    .eq("project_id", input.projectId)
    .eq("id", input.treeId)
    .maybeSingle();
  if (treeResult.error) throw treeResult.error;
  const treeResearchId = (treeResult.data as ResearchRow | null)?.research_id;
  if (treeResearchId) return treeResearchId;

  const firstResearch = await client
    .from("researches")
    .select("id")
    .eq("project_id", input.projectId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (firstResearch.error) throw firstResearch.error;
  return (firstResearch.data as IdRow | null)?.id ?? null;
}

async function createImportedFamilyTree(input: {
  projectId: EntityId;
  title: string;
  rootPersonId: EntityId;
  makeDefault: boolean;
  rollbackOperationId?: EntityId;
  importSourceKey?: string;
}): Promise<EntityId> {
  const client = getSupabaseClient();
  const existing = await client
    .from("family_trees")
    .select("id, root_person_id, is_default")
    .eq("project_id", input.projectId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (existing.error) throw existing.error;
  const existingTrees = (existing.data as FamilyTreeIdRow[] | null) ?? [];
  // A rollback-enabled import must own its tree row. Reusing a pre-existing
  // empty tree would make an import rollback delete or mutate user data.
  const reusableEmptyTree = input.rollbackOperationId
    ? undefined
    : existingTrees.find((tree) => !tree.root_person_id);
  const title = input.title.trim() || "GEDCOM import";

  if (reusableEmptyTree) {
    const { data, error } = await client
      .from("family_trees")
      .update({
        title,
        root_person_id: input.rootPersonId,
        privacy_status: "private",
        settings: {
          source: "gedcom_import",
          ...(input.importSourceKey ? { import_source_key: input.importSourceKey } : {}),
        },
      })
      .eq("project_id", input.projectId)
      .eq("id", reusableEmptyTree.id)
      .select("id")
      .single();
    if (error) throw error;
    const treeId = (data as IdRow).id;
    if (input.makeDefault) await setImportedFamilyTreeDefault(input.projectId, treeId);
    return treeId;
  }

  const { data, error } = await client
    .from("family_trees")
    .insert({
      project_id: input.projectId,
      title,
      description: "",
      root_person_id: input.rootPersonId,
      // Register rollback ownership before changing the project's default.
      is_default: input.rollbackOperationId ? false : !existingTrees.length,
      privacy_status: "private",
      settings: {
        source: "gedcom_import",
        ...(input.importSourceKey ? { import_source_key: input.importSourceKey } : {}),
        ...(input.rollbackOperationId
          ? { rollback_operation_id: input.rollbackOperationId }
          : {}),
      },
    })
    .select("id")
    .single();
  if (error) throw error;
  const treeId = (data as IdRow).id;
  try {
    if (input.rollbackOperationId) {
      await registerGedcomImportTree(input.rollbackOperationId, treeId);
    }
    if (input.makeDefault) await setImportedFamilyTreeDefault(input.projectId, treeId);
    return treeId;
  } catch (creationError) {
    try {
      await deleteFamilyTree({ projectId: input.projectId, treeId });
    } catch (cleanupError) {
      console.error("Failed to discard an unregistered GEDCOM family tree", {
        projectId: input.projectId,
        treeId,
        cleanupError,
      });
    }
    throw creationError;
  }
}

async function setImportedFamilyTreeDefault(projectId: EntityId, treeId: EntityId): Promise<void> {
  const client = getSupabaseClient();
  const clear = await client
    .from("family_trees")
    .update({ is_default: false })
    .eq("project_id", projectId)
    .neq("id", treeId);
  if (clear.error) throw clear.error;

  const set = await client
    .from("family_trees")
    .update({ is_default: true })
    .eq("project_id", projectId)
    .eq("id", treeId);
  if (set.error) throw set.error;
}

function legacyImportResult(
  input: CreateFamilyTreeFromLegacyImportInput,
  treeId: EntityId,
  rootPersonId: EntityId,
  projection: ReturnType<typeof buildFamilyTreeProjection>,
): CreateFamilyTreeFromLegacyImportResult {
  return {
    treeId,
    rootPersonId,
    persons: input.persons.length,
    parentChildRelationships: projection.parentChildEdges.length,
    partnerRelationships: projection.partnerEdges.length,
  };
}

async function readLegacyImportSyncCoverage(
  projectId: EntityId,
  treeId: EntityId,
  edges: ReturnType<typeof buildFamilyTreeProjection>["edges"],
): Promise<{ complete: boolean; matched: number }> {
  if (!edges.length) return { complete: true, matched: 0 };
  const expected = legacyImportExpectedSyncKeys(edges);
  // Every projected import edge normally owns one legacy relation ID. Do not
  // claim full coverage if a future projection produces a synthetic edge.
  const allEdgesAddressable = expected.size === edges.length;
  const matched = new Set<string>();
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await getSupabaseClient()
      .from("legacy_person_relation_graph_edges")
      .select("relation_id, edge_kind")
      .eq("project_id", projectId)
      .eq("tree_id", treeId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      // Graph foundation deployments can briefly precede the compatibility
      // mapping migration. In that state the batch planner is the fallback.
      if (isMissingLegacyGraphMapTableError(error)) {
        return { complete: false, matched: 0 };
      }
      throw error;
    }
    const page = (data ?? []) as Array<{ relation_id: EntityId; edge_kind: string }>;
    for (const row of page) {
      const key = `${row.relation_id}|${row.edge_kind}`;
      if (expected.has(key)) matched.add(key);
    }
    if (page.length < pageSize) break;
  }

  return {
    complete: allEdgesAddressable && matched.size === expected.size,
    matched: matched.size,
  };
}

function isMissingLegacyGraphMapTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = String(candidate.code ?? "");
  const message = String(candidate.message ?? "").toLowerCase();
  return code === "42P01"
    || code === "PGRST205"
    || (message.includes("legacy_person_relation_graph_edges")
      && (message.includes("does not exist") || message.includes("schema cache")));
}

async function familyTreeHasStoredGraph(projectId: EntityId, treeId: EntityId): Promise<boolean> {
  const client = getSupabaseClient();
  const results = await Promise.all([
    client.from("family_groups").select("id").eq("project_id", projectId).eq("tree_id", treeId).limit(1),
    client.from("partner_relationships").select("id").eq("project_id", projectId).eq("tree_id", treeId).limit(1),
    client.from("parent_sets").select("id").eq("project_id", projectId).eq("tree_id", treeId).limit(1),
    client.from("parent_child_relationships").select("id").eq("project_id", projectId).eq("tree_id", treeId).limit(1),
  ]);
  for (const result of results) {
    if (result.error) throw result.error;
    if ((result.data ?? []).length) return true;
  }
  return false;
}

async function persistLegacyFamilyTreeImportPlan(
  plan: LegacyFamilyTreeImportPlan,
): Promise<void> {
  for (const batch of buildLegacyImportMutationBatches(plan)) {
    const table = getSupabaseClient().from(batch.table);
    const result = batch.mode === "upsert"
      ? await table.upsert(batch.rows as never, {
          onConflict: "family_group_id,person_id,member_role",
        })
      : await table.insert(batch.rows as never);
    const { error } = result;
    if (error) throw error;
  }
}

async function ensureTreeMember(input: {
  projectId: EntityId;
  treeId: EntityId;
  personId: EntityId;
  memberRole?: FamilyTreePersonRole;
  displayOrder?: number;
}): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("family_tree_persons")
    .upsert(
      {
        project_id: input.projectId,
        tree_id: input.treeId,
        person_id: input.personId,
        member_role: input.memberRole ?? "member",
        display_order: input.displayOrder ?? 0,
      },
      { onConflict: "tree_id,person_id" },
    );
  if (error) throw error;
}

async function ensureTreeMembers(inputs: Array<{
  projectId: EntityId;
  treeId: EntityId;
  personId: EntityId;
  memberRole?: FamilyTreePersonRole;
  displayOrder?: number;
}>): Promise<void> {
  const client = getSupabaseClient();
  // Every inserted member fires the graph-version row trigger. Keep one SQL
  // statement below the safe trigger-heavy import ceiling.
  for (const batch of chunkArray(inputs, LEGACY_IMPORT_ROW_BATCH_SIZE)) {
    const { error } = await client
      .from("family_tree_persons")
      .upsert(
        batch.map((input) => ({
          project_id: input.projectId,
          tree_id: input.treeId,
          person_id: input.personId,
          member_role: input.memberRole ?? "member",
          display_order: input.displayOrder ?? 0,
        })),
        { onConflict: "tree_id,person_id" },
      );
    if (error) throw error;
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function groupParentEdgesForImport(
  edges: ReturnType<typeof buildFamilyTreeProjection>["parentChildEdges"],
): Map<string, ReturnType<typeof buildFamilyTreeProjection>["parentChildEdges"]> {
  const result = new Map<string, ReturnType<typeof buildFamilyTreeProjection>["parentChildEdges"]>();
  for (const edge of edges) {
    const key = [
      edge.toPersonId,
      edge.parentSetType ?? parentSetTypeForRelationship(edge.relationshipType as ParentChildRelationshipType),
    ].join("|");
    const group = result.get(key) ?? [];
    group.push(edge);
    result.set(key, group);
  }
  return result;
}

function uniqueParentChildImportEdges(
  edges: ReturnType<typeof buildFamilyTreeProjection>["parentChildEdges"],
): ReturnType<typeof buildFamilyTreeProjection>["parentChildEdges"] {
  const seen = new Set<string>();
  const result: ReturnType<typeof buildFamilyTreeProjection>["parentChildEdges"] = [];
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

async function createImportedFamilyGroup(input: {
  projectId: EntityId;
  treeId: EntityId;
  parentIds: EntityId[];
  familyXref: string;
  rawNotes?: string;
}): Promise<EntityId> {
  const parents = Array.from(new Set(input.parentIds));
  const { data, error } = await getSupabaseClient()
    .from("family_groups")
    .insert({
      project_id: input.projectId,
      tree_id: input.treeId,
      group_type: parents.length >= 2 ? "couple" satisfies FamilyGroupType : "single_parent" satisfies FamilyGroupType,
      display_label: "",
      primary_partner_1_id: parents[0] ?? null,
      primary_partner_2_id: parents[1] ?? null,
      metadata: {
        source: "gedcom_import",
        familyXref: input.familyXref,
        rawNotes: input.rawNotes ?? "",
      },
    })
    .select("id")
    .single();
  if (error) throw error;
  const familyGroupId = (data as IdRow).id;
  for (const [index, parentId] of parents.entries()) {
    await upsertFamilyGroupMember(
      input.projectId,
      familyGroupId,
      parentId,
      parents.length >= 2 ? "partner" : "parent",
      index,
    );
  }
  return familyGroupId;
}

async function findOrCreateParentSet(input: CreateParentSetInput): Promise<EntityId> {
  const { data, error } = await getSupabaseClient()
    .from("parent_sets")
    .select(PARENT_SET_SELECT)
    .eq("project_id", input.projectId)
    .eq("tree_id", input.treeId)
    .eq("child_id", input.childId)
    .order("is_default_for_pedigree", { ascending: false })
    .order("is_preferred_for_display", { ascending: false })
    .order("display_order", { ascending: true });
  if (error) throw error;

  const matching = selectReusableParentSet(data as ParentSetRow[], input.setType, input.familyGroupId ?? null);
  if (matching) return matching.id;
  return createParentSet(input);
}

async function hasDefaultParentSet(projectId: EntityId, treeId: EntityId, childId: EntityId): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .from("parent_sets")
    .select("id")
    .eq("project_id", projectId)
    .eq("tree_id", treeId)
    .eq("child_id", childId)
    .eq("is_default_for_pedigree", true)
    .limit(1);
  if (error) throw error;
  return Boolean((data as IdRow[]).length);
}

async function createParentChildRelationship(input: {
  projectId: EntityId;
  treeId: EntityId;
  parentId: EntityId;
  childId: EntityId;
  parentSetId: EntityId;
  familyGroupId: EntityId | null;
  relationshipType: ParentChildRelationshipType;
  parentRoleLabel: ParentRoleLabel;
  evidenceStatus: EvidenceStatus;
  duplicateMode?: "throw" | "ignore" | "skip-check";
  ensureMembers?: boolean;
  notes?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  assertCanCreateParentChild(input.parentId, input.childId);
  if (input.duplicateMode !== "skip-check") {
    const duplicate = await parentChildExists(input);
    if (duplicate) {
      if (input.duplicateMode === "ignore") return;
      throw new Error("Такий зв'язок батько-дитина вже існує в цьому дереві.");
    }
  }
  await assertStoredParentChildMutationAcyclic(input);
  if (input.ensureMembers !== false) {
    await ensureTreeMember({ projectId: input.projectId, treeId: input.treeId, personId: input.parentId });
    await ensureTreeMember({ projectId: input.projectId, treeId: input.treeId, personId: input.childId });
  }

  const traits = parentRelationshipTraits(input.relationshipType);
  const { error } = await getSupabaseClient()
    .from("parent_child_relationships")
    .insert({
      project_id: input.projectId,
      tree_id: input.treeId,
      parent_id: input.parentId,
      child_id: input.childId,
      parent_set_id: input.parentSetId,
      family_group_id: input.familyGroupId,
      relationship_type: input.relationshipType,
      parent_role_label: input.parentRoleLabel,
      evidence_status: input.evidenceStatus,
      confidence: confidenceForEvidence(input.evidenceStatus),
      is_primary_for_display: true,
      is_bloodline: traits.isBloodline,
      is_legal: traits.isLegal,
      is_social: traits.isSocial,
      privacy_status: "private",
      notes: input.notes ?? "",
      metadata: input.metadata ?? { source: "family_tree_builder" },
    });
  if (error) throw error;

  if (input.familyGroupId) {
    await upsertFamilyGroupMember(input.projectId, input.familyGroupId, input.parentId, "parent", 0);
    await upsertFamilyGroupMember(input.projectId, input.familyGroupId, input.childId, "child", 10);
  }
}

async function parentChildExists(input: {
  projectId: EntityId;
  treeId: EntityId;
  parentId: EntityId;
  childId: EntityId;
  relationshipType?: ParentChildRelationshipType;
}): Promise<boolean> {
  let request = getSupabaseClient()
    .from("parent_child_relationships")
    .select("id")
    .eq("project_id", input.projectId)
    .eq("tree_id", input.treeId)
    .eq("parent_id", input.parentId)
    .eq("child_id", input.childId)
    .limit(1);
  if (input.relationshipType) request = request.eq("relationship_type", input.relationshipType);
  const { data, error } = await request;
  if (error) throw error;
  return Boolean((data as IdRow[]).length);
}

async function assertStoredParentChildMutationAcyclic(input: {
  projectId: EntityId;
  treeId: EntityId;
  parentId: EntityId;
  childId: EntityId;
  evidenceStatus: EvidenceStatus;
}): Promise<void> {
  assertCanCreateParentChild(input.parentId, input.childId, [], input.evidenceStatus);
  if (input.evidenceStatus === "disproven") return;

  const pending: EntityId[] = [input.childId];
  const queued = new Set<EntityId>(pending);
  const expanded = new Set<EntityId>();
  const reachableRelationships: Array<{
    parentId: EntityId;
    childId: EntityId;
    evidenceStatus: EvidenceStatus;
  }> = [];
  let nextPendingIndex = 0;

  while (nextPendingIndex < pending.length) {
    const batch: EntityId[] = [];
    while (nextPendingIndex < pending.length && batch.length < 100) {
      const personId = pending[nextPendingIndex];
      nextPendingIndex += 1;
      if (expanded.has(personId)) continue;
      expanded.add(personId);
      batch.push(personId);
    }
    if (!batch.length) continue;

    const { data, error } = await getSupabaseClient()
      .from("parent_child_relationships")
      .select("parent_id, child_id, evidence_status")
      .eq("project_id", input.projectId)
      .eq("tree_id", input.treeId)
      .neq("evidence_status", "disproven")
      .in("parent_id", batch);
    if (error) throw error;

    for (const relationship of data as ParentChildCycleRow[]) {
      reachableRelationships.push({
        parentId: relationship.parent_id,
        childId: relationship.child_id,
        evidenceStatus: relationship.evidence_status,
      });
      if (relationship.child_id === input.parentId) {
        assertCanCreateParentChild(
          input.parentId,
          input.childId,
          reachableRelationships,
          input.evidenceStatus,
        );
      }
      if (!queued.has(relationship.child_id)) {
        queued.add(relationship.child_id);
        pending.push(relationship.child_id);
      }
    }
  }

  assertCanCreateParentChild(
    input.parentId,
    input.childId,
    reachableRelationships,
    input.evidenceStatus,
  );
}

async function readPreferredParents(
  projectId: EntityId,
  treeId: EntityId,
  childId: EntityId,
): Promise<ParentRelationshipRow[]> {
  const { data: sets, error: setError } = await getSupabaseClient()
    .from("parent_sets")
    .select(PARENT_SET_SELECT)
    .eq("project_id", projectId)
    .eq("tree_id", treeId)
    .eq("child_id", childId)
    .order("is_default_for_pedigree", { ascending: false })
    .order("is_preferred_for_display", { ascending: false })
    .order("display_order", { ascending: true })
    .limit(1);
  if (setError) throw setError;
  const parentSetId = (sets as ParentSetRow[])[0]?.id;
  if (!parentSetId) return [];

  const { data, error } = await getSupabaseClient()
    .from("parent_child_relationships")
    .select(PARENT_RELATIONSHIP_SELECT)
    .eq("project_id", projectId)
    .eq("tree_id", treeId)
    .eq("parent_set_id", parentSetId);
  if (error) throw error;
  return data as ParentRelationshipRow[];
}

async function findOrCreateCoupleFamilyGroup(input: {
  projectId: EntityId;
  treeId: EntityId;
  personAId: EntityId;
  personBId: EntityId;
  preferredGroupId?: EntityId;
}): Promise<EntityId> {
  assertNotSelfRelationship(input.personAId, input.personBId);
  if (input.preferredGroupId) return input.preferredGroupId;

  const existing = await readCoupleFamilyGroup(input.projectId, input.treeId, input.personAId, input.personBId);
  if (existing) return existing.id;

  const { data, error } = await getSupabaseClient()
    .from("family_groups")
    .insert({
      project_id: input.projectId,
      tree_id: input.treeId,
      group_type: "couple" satisfies FamilyGroupType,
      display_label: "",
      primary_partner_1_id: input.personAId,
      primary_partner_2_id: input.personBId,
      metadata: { source: "family_tree_builder" },
    })
    .select("id")
    .single();
  if (error) throw error;
  const familyGroupId = (data as IdRow).id;
  await upsertFamilyGroupMember(input.projectId, familyGroupId, input.personAId, "partner", 0);
  await upsertFamilyGroupMember(input.projectId, familyGroupId, input.personBId, "partner", 1);
  return familyGroupId;
}

async function readCoupleFamilyGroup(
  projectId: EntityId,
  treeId: EntityId,
  personAId: EntityId,
  personBId: EntityId,
): Promise<FamilyGroupRow | null> {
  const { data, error } = await getSupabaseClient()
    .from("family_groups")
    .select(FAMILY_GROUP_SELECT)
    .eq("project_id", projectId)
    .eq("tree_id", treeId)
    .eq("group_type", "couple")
    .or(
      `and(primary_partner_1_id.eq.${personAId},primary_partner_2_id.eq.${personBId}),and(primary_partner_1_id.eq.${personBId},primary_partner_2_id.eq.${personAId})`,
    )
    .limit(1);
  if (error) throw error;
  return (data as FamilyGroupRow[])[0] ?? null;
}

async function createPartnerRelationship(input: {
  projectId: EntityId;
  treeId: EntityId;
  familyGroupId: EntityId;
  personAId: EntityId;
  personBId: EntityId;
  relationshipType: PartnerRelationshipType;
  evidenceStatus: EvidenceStatus;
  ensureMembers?: boolean;
  startDate?: string;
  startPlace?: string;
  endDate?: string;
  endPlace?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  assertNotSelfRelationship(input.personAId, input.personBId);
  if (input.ensureMembers !== false) {
    await ensureTreeMember({ projectId: input.projectId, treeId: input.treeId, personId: input.personAId });
    await ensureTreeMember({ projectId: input.projectId, treeId: input.treeId, personId: input.personBId });
  }
  const existing = await readPartnerRelationship(input);
  if (existing) return;
  const { error } = await getSupabaseClient()
    .from("partner_relationships")
    .insert({
      project_id: input.projectId,
      tree_id: input.treeId,
      family_group_id: input.familyGroupId,
      person_a_id: input.personAId,
      person_b_id: input.personBId,
      relationship_type: input.relationshipType,
      status: statusForPartnerType(input.relationshipType),
      evidence_status: input.evidenceStatus,
      confidence: confidenceForEvidence(input.evidenceStatus),
      is_primary_for_display: true,
      privacy_status: "private",
      start_date: input.startDate ?? "",
      start_place: input.startPlace ?? "",
      end_date: input.endDate ?? "",
      end_place: input.endPlace ?? "",
      notes: input.notes ?? "",
      metadata: input.metadata ?? { source: "family_tree_builder" },
    });
  if (error) throw error;
  await upsertFamilyGroupMember(input.projectId, input.familyGroupId, input.personAId, "partner", 0);
  await upsertFamilyGroupMember(input.projectId, input.familyGroupId, input.personBId, "partner", 1);
}

async function readPartnerRelationship(input: {
  projectId: EntityId;
  treeId: EntityId;
  personAId: EntityId;
  personBId: EntityId;
  relationshipType?: PartnerRelationshipType;
}): Promise<PartnerRelationshipRow | null> {
  let request = getSupabaseClient()
    .from("partner_relationships")
    .select(PARTNER_RELATIONSHIP_SELECT)
    .eq("project_id", input.projectId)
    .eq("tree_id", input.treeId)
    .or(
      `and(person_a_id.eq.${input.personAId},person_b_id.eq.${input.personBId}),and(person_a_id.eq.${input.personBId},person_b_id.eq.${input.personAId})`,
    )
    .limit(1);
  if (input.relationshipType) request = request.eq("relationship_type", input.relationshipType);
  const { data, error } = await request;
  if (error) throw error;
  return (data as PartnerRelationshipRow[])[0] ?? null;
}

async function upsertFamilyGroupMember(
  projectId: EntityId,
  familyGroupId: EntityId,
  personId: EntityId,
  memberRole: "partner" | "parent" | "child",
  displayOrder: number,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("family_group_members")
    .upsert(
      {
        project_id: projectId,
        family_group_id: familyGroupId,
        person_id: personId,
        member_role: memberRole,
        display_order: displayOrder,
      },
      { onConflict: "family_group_id,person_id,member_role" },
    );
  if (error) throw error;
}
