import type { FamilyTreeGraphDto, ParentRoleLabel } from "../types/familyTree";
import type { FamilyTreeBuilderAction } from "../services/familyTreeMutationService";

export type FamilyTreeRelationFlags = {
  parents: number;
  fathers: number;
  mothers: number;
  biologicalFathers: number;
  biologicalMothers: number;
  partners: number;
  children: number;
};

export type FamilyTreePersonAction = {
  action: FamilyTreeBuilderAction;
  primary: boolean;
};

export function availableFamilyTreeActionsForPerson(
  graph: FamilyTreeGraphDto,
  personId: string,
): FamilyTreePersonAction[] {
  const flags = familyTreeRelationFlagsByPerson(graph).get(personId) ?? emptyFamilyTreeRelationFlags();
  const actions: FamilyTreePersonAction[] = [];
  if (flags.biologicalFathers === 0) actions.push({ action: "add_father", primary: true });
  if (flags.biologicalMothers === 0) actions.push({ action: "add_mother", primary: true });
  actions.push({ action: "add_partner", primary: flags.partners === 0 });
  actions.push({ action: "add_child", primary: true });
  if (flags.parents > 0) actions.push({ action: "add_sibling", primary: false });
  return actions;
}

export function familyTreeRelationFlagsByPerson(graph: FamilyTreeGraphDto): Map<string, FamilyTreeRelationFlags> {
  const result = new Map<string, FamilyTreeRelationFlags>();
  const personById = new Map(graph.nodes.map((node) => [node.personId, node]));
  const countedRelationships = new Set<string>();
  const flagsFor = (personId: string) => {
    const current = result.get(personId) ?? emptyFamilyTreeRelationFlags();
    result.set(personId, current);
    return current;
  };

  for (const edge of graph.edges) {
    const dedupeKey = `${edge.kind}:${edge.relationshipId}`;
    if (countedRelationships.has(dedupeKey)) continue;
    countedRelationships.add(dedupeKey);
    if (edge.kind === "parent_child") {
      const childFlags = flagsFor(edge.toPersonId);
      childFlags.parents += 1;
      const role = parentRoleFromEdge(edge, personById.get(edge.fromPersonId)?.gender);
      if (role === "father") childFlags.fathers += 1;
      else if (role === "mother") childFlags.mothers += 1;
      if (isBiologicalParentRelationship(edge.relationshipType)) {
        if (role === "father") childFlags.biologicalFathers += 1;
        else if (role === "mother") childFlags.biologicalMothers += 1;
      }
      flagsFor(edge.fromPersonId).children += 1;
    } else if (edge.kind === "partner") {
      flagsFor(edge.fromPersonId).partners += 1;
      flagsFor(edge.toPersonId).partners += 1;
    }
  }

  for (const group of graph.groups) {
    for (const partnerId of group.partnerIds) {
      if (!partnerId) continue;
      flagsFor(partnerId).partners += Math.max(1, group.partnerIds.length - 1);
    }
    if (group.parentIds.length > 1) {
      for (const parentId of group.parentIds) {
        flagsFor(parentId).partners += group.parentIds.length - 1;
      }
    }
  }

  return result;
}

export function emptyFamilyTreeRelationFlags(): FamilyTreeRelationFlags {
  return {
    parents: 0,
    fathers: 0,
    mothers: 0,
    biologicalFathers: 0,
    biologicalMothers: 0,
    partners: 0,
    children: 0,
  };
}

function isBiologicalParentRelationship(relationshipType: string): boolean {
  return [
    "biological",
    "birth_parent",
    "genetic_father",
    "genetic_mother",
    "gestational_parent",
  ].includes(relationshipType);
}

function parentRoleFromEdge(
  edge: FamilyTreeGraphDto["edges"][number],
  parentGender: string | undefined,
): "father" | "mother" | "parent" {
  if (edge.relationshipType === "genetic_father") return "father";
  if (edge.relationshipType === "genetic_mother") return "mother";
  const role = String(edge.parentRoleLabel ?? edge.metadata?.parentRoleLabel ?? edge.metadata?.parent_role_label ?? "")
    .trim()
    .toLocaleLowerCase("uk") as ParentRoleLabel | "";
  if (["father", "stepfather", "adoptive_father", "батько", "вітчим", "прийомний батько"].includes(role)) {
    return "father";
  }
  if (["mother", "stepmother", "adoptive_mother", "мати", "матір", "мачуха", "прийомна мати"].includes(role)) {
    return "mother";
  }
  const gender = (parentGender ?? "").trim().toLocaleLowerCase("uk");
  if (["чоловік", "чоловіча", "male", "m", "man"].includes(gender)) return "father";
  if (["жінка", "жіноча", "female", "f", "woman"].includes(gender)) return "mother";
  return "parent";
}
