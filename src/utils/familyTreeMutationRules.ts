import type {
  EvidenceStatus,
  ParentChildRelationshipType,
  ParentRoleLabel,
  ParentSetType,
  PartnerRelationshipStatus,
  PartnerRelationshipType,
} from "../types/familyTree";
import type { EntityId } from "../types";
import { PARENT_CHILD_DEFINITIONS } from "./familyTreeGraph.ts";

export type ParentSetSelectionRow = {
  id: string;
  family_group_id: string | null;
  set_type: string;
};

export type ParentChildCycleEdge = {
  parentId: EntityId;
  childId: EntityId;
  evidenceStatus?: EvidenceStatus;
};

export function selectReusableParentSet<T extends ParentSetSelectionRow>(
  parentSets: T[],
  setType: ParentSetType,
  familyGroupId: EntityId | null,
): T | null {
  return parentSets.find((set) =>
    set.set_type === setType &&
    set.family_group_id === familyGroupId
  ) ?? null;
}

export function wouldCreateParentChildCycle(
  parentId: EntityId,
  childId: EntityId,
  existingRelationships: readonly ParentChildCycleEdge[] = [],
  evidenceStatus: EvidenceStatus = "unknown",
): boolean {
  if (parentId === childId) return true;
  if (evidenceStatus === "disproven") return false;

  const childrenByParent = new Map<EntityId, EntityId[]>();
  for (const relationship of existingRelationships) {
    if (relationship.evidenceStatus === "disproven") continue;
    const children = childrenByParent.get(relationship.parentId) ?? [];
    children.push(relationship.childId);
    childrenByParent.set(relationship.parentId, children);
  }

  const pending: EntityId[] = [childId];
  const visited = new Set<EntityId>();
  while (pending.length) {
    const personId = pending.pop() as EntityId;
    if (personId === parentId) return true;
    if (visited.has(personId)) continue;
    visited.add(personId);
    for (const descendantId of childrenByParent.get(personId) ?? []) {
      if (!visited.has(descendantId)) pending.push(descendantId);
    }
  }
  return false;
}

export function assertCanCreateParentChild(
  parentId: EntityId,
  childId: EntityId,
  existingRelationships: readonly ParentChildCycleEdge[] = [],
  evidenceStatus: EvidenceStatus = "unknown",
): void {
  if (wouldCreateParentChildCycle(parentId, childId, existingRelationships, evidenceStatus)) {
    throw new Error("Батьківський зв’язок створює цикл у родовому дереві.");
  }
}

export function assertParentChildGraphAcyclic(
  relationships: readonly ParentChildCycleEdge[],
): void {
  const childrenByParent = new Map<EntityId, EntityId[]>();
  const indegree = new Map<EntityId, number>();

  for (const relationship of relationships) {
    if (relationship.parentId === relationship.childId) {
      throw new Error("Батьківський зв’язок створює цикл у родовому дереві.");
    }
    if (relationship.evidenceStatus === "disproven") continue;
    const children = childrenByParent.get(relationship.parentId) ?? [];
    children.push(relationship.childId);
    childrenByParent.set(relationship.parentId, children);
    if (!indegree.has(relationship.parentId)) indegree.set(relationship.parentId, 0);
    indegree.set(relationship.childId, (indegree.get(relationship.childId) ?? 0) + 1);
  }

  const pending = Array.from(indegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([personId]) => personId);
  let visitedCount = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const personId = pending[index];
    visitedCount += 1;
    for (const childId of childrenByParent.get(personId) ?? []) {
      const nextDegree = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, nextDegree);
      if (nextDegree === 0) pending.push(childId);
    }
  }

  if (visitedCount !== indegree.size) {
    throw new Error("Батьківські зв’язки містять цикл у родовому дереві.");
  }
}

export function assertNotSelfRelationship(firstPersonId: EntityId, secondPersonId: EntityId): void {
  if (firstPersonId === secondPersonId) {
    throw new Error("Не можна створити зв'язок особи із самою собою.");
  }
}

export function parentSetTypeForRelationship(type: ParentChildRelationshipType): ParentSetType {
  return PARENT_CHILD_DEFINITIONS[type].parentSetType;
}

export function parentRelationshipTraits(type: ParentChildRelationshipType): {
  isBloodline: boolean;
  isLegal: boolean;
  isSocial: boolean;
} {
  const definition = PARENT_CHILD_DEFINITIONS[type];
  return {
    isBloodline: definition.isBloodline,
    isLegal: definition.isLegal,
    isSocial: definition.isSocial,
  };
}

export function canAutoCreatePartnerRelationshipForParentType(
  type: ParentChildRelationshipType,
): boolean {
  return type === "biological" || type === "birth_parent";
}

export function roleLabelForParentIntent(
  intent: "father" | "mother" | "parent",
  relationshipType: ParentChildRelationshipType,
): ParentRoleLabel {
  if (relationshipType === "adoptive" && intent === "father") return "adoptive_father";
  if (relationshipType === "adoptive" && intent === "mother") return "adoptive_mother";
  if (relationshipType === "step" && intent === "father") return "stepfather";
  if (relationshipType === "step" && intent === "mother") return "stepmother";
  if (relationshipType === "guardian") return "guardian";
  if (intent === "father") return "father";
  if (intent === "mother") return "mother";
  return "parent";
}

export function confidenceForEvidence(status: EvidenceStatus): number {
  if (status === "proven") return 100;
  if (status === "likely") return 75;
  if (status === "disputed") return 35;
  if (status === "disproven") return 0;
  return 50;
}

export function statusForPartnerType(type: PartnerRelationshipType): PartnerRelationshipStatus {
  if (type === "divorced" || type === "separated" || type === "annulled" || type === "widowhood") return "ended";
  if (type === "unknown" || type === "other") return "unknown";
  return "active";
}

export function legacyParentRelationType(intent: "father" | "mother" | "parent"): string {
  if (intent === "father") return "батько";
  if (intent === "mother") return "мати";
  return "батько або мати";
}

export function legacyChildRelationType(gender: string): string {
  if (gender === "чоловік") return "син";
  if (gender === "жінка") return "донька";
  return "дитина";
}

export function legacySiblingRelationType(gender: string): string {
  if (gender === "чоловік") return "брат";
  if (gender === "жінка") return "сестра";
  return "брат або сестра";
}

export function legacySpouseRelationType(relatedGender: string): string {
  if (relatedGender === "чоловік") return "чоловік";
  if (relatedGender === "жінка") return "дружина";
  return "подружжя";
}

export function isLegacySpouseRelationType(value: string): boolean {
  return value === "чоловік" || value === "дружина" || value === "подружжя";
}

export function legacyStatusForEvidence(status: EvidenceStatus): string {
  if (status === "proven") return "доведено";
  if (status === "likely") return "імовірно";
  if (status === "disputed" || status === "unknown") return "сумнівно";
  if (status === "disproven") return "спростовано";
  return "гіпотеза";
}
