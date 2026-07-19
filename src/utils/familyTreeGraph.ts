import type { PersonRelation } from "../types/index.ts";
import type {
  AssociationRelationship,
  AssociationRelationshipType,
  EvidenceStatus,
  FamilyTreeGraphEdgeIntent,
  FamilyTreeGraphIssue,
  FamilyTreeLineStyle,
  ParentChildRelationship,
  ParentChildRelationshipType,
  ParentRoleLabel,
  ParentSetType,
  PartnerRelationship,
  PartnerRelationshipType,
} from "../types/familyTree.ts";

type ParentChildDefinition = {
  parentSetType: ParentSetType;
  parentRoleLabel: ParentRoleLabel;
  isBloodline: boolean;
  isLegal: boolean;
  isSocial: boolean;
  lineStyle: FamilyTreeLineStyle;
  gedcomPedi: "BIRTH" | "ADOPTED" | "FOSTER" | "OTHER";
};

export const PARENT_CHILD_DEFINITIONS: Record<ParentChildRelationshipType, ParentChildDefinition> = {
  biological: {
    parentSetType: "biological",
    parentRoleLabel: "parent",
    isBloodline: true,
    isLegal: false,
    isSocial: true,
    lineStyle: "solid",
    gedcomPedi: "BIRTH",
  },
  genetic_father: {
    parentSetType: "genetic",
    parentRoleLabel: "father",
    isBloodline: true,
    isLegal: false,
    isSocial: false,
    lineStyle: "solid",
    gedcomPedi: "OTHER",
  },
  genetic_mother: {
    parentSetType: "genetic",
    parentRoleLabel: "mother",
    isBloodline: true,
    isLegal: false,
    isSocial: false,
    lineStyle: "solid",
    gedcomPedi: "OTHER",
  },
  gestational_parent: {
    parentSetType: "birth_or_gestational",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: false,
    isSocial: false,
    lineStyle: "annotated",
    gedcomPedi: "OTHER",
  },
  birth_parent: {
    parentSetType: "birth_or_gestational",
    parentRoleLabel: "parent",
    isBloodline: true,
    isLegal: false,
    isSocial: true,
    lineStyle: "solid",
    gedcomPedi: "BIRTH",
  },
  adoptive: {
    parentSetType: "adoptive",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: true,
    isSocial: true,
    lineStyle: "dashed",
    gedcomPedi: "ADOPTED",
  },
  foster: {
    parentSetType: "foster",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: false,
    isSocial: true,
    lineStyle: "dashed",
    gedcomPedi: "FOSTER",
  },
  step: {
    parentSetType: "step",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: false,
    isSocial: true,
    lineStyle: "dotted",
    gedcomPedi: "OTHER",
  },
  guardian: {
    parentSetType: "guardian",
    parentRoleLabel: "guardian",
    isBloodline: false,
    isLegal: true,
    isSocial: true,
    lineStyle: "dashed",
    gedcomPedi: "OTHER",
  },
  social_parent: {
    parentSetType: "social",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: false,
    isSocial: true,
    lineStyle: "dashed",
    gedcomPedi: "OTHER",
  },
  legal_parent: {
    parentSetType: "legal",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: true,
    isSocial: false,
    lineStyle: "dashed",
    gedcomPedi: "OTHER",
  },
  donor: {
    parentSetType: "genetic",
    parentRoleLabel: "parent",
    isBloodline: true,
    isLegal: false,
    isSocial: false,
    lineStyle: "annotated",
    gedcomPedi: "OTHER",
  },
  surrogate: {
    parentSetType: "birth_or_gestational",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: false,
    isSocial: false,
    lineStyle: "annotated",
    gedcomPedi: "OTHER",
  },
  presumed: {
    parentSetType: "unknown",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: false,
    isSocial: false,
    lineStyle: "thin",
    gedcomPedi: "OTHER",
  },
  unknown: {
    parentSetType: "unknown",
    parentRoleLabel: "parent",
    isBloodline: false,
    isLegal: false,
    isSocial: false,
    lineStyle: "thin",
    gedcomPedi: "OTHER",
  },
  other: {
    parentSetType: "other",
    parentRoleLabel: "custom",
    isBloodline: false,
    isLegal: false,
    isSocial: false,
    lineStyle: "annotated",
    gedcomPedi: "OTHER",
  },
};

export const PARTNER_RELATION_LINE_STYLE: Record<PartnerRelationshipType, FamilyTreeLineStyle> = {
  marriage: "solid",
  civil_partnership: "solid",
  cohabitation: "dashed",
  engagement: "dotted",
  dating: "dotted",
  temporary_relationship: "dotted",
  divorced: "annotated",
  separated: "annotated",
  annulled: "annotated",
  widowhood: "annotated",
  unknown: "thin",
  other: "annotated",
};

export function parentChildDefaults(
  relationshipType: ParentChildRelationshipType,
  parentRoleLabel?: ParentRoleLabel,
): ParentChildDefinition {
  const base = PARENT_CHILD_DEFINITIONS[relationshipType];
  return {
    ...base,
    parentRoleLabel: parentRoleLabel ?? base.parentRoleLabel,
  };
}

export function lineStyleForParentChildType(
  relationshipType: ParentChildRelationshipType,
): FamilyTreeLineStyle {
  return PARENT_CHILD_DEFINITIONS[relationshipType].lineStyle;
}

export function legacyRelationToGraphIntent(
  relation: PersonRelation,
): FamilyTreeGraphEdgeIntent | null {
  const status = legacyEvidenceStatus(relation.status);
  const confidence = confidenceForEvidenceStatus(status);
  const parentFromRelated = (
    relationshipType: ParentChildRelationshipType,
    parentRoleLabel: ParentRoleLabel,
  ): FamilyTreeGraphEdgeIntent => {
    const defaults = parentChildDefaults(relationshipType, parentRoleLabel);
    return {
      kind: "parent_child",
      fromPersonId: relation.relatedPersonId,
      toPersonId: relation.personId,
      relationshipType,
      parentRoleLabel: defaults.parentRoleLabel,
      parentSetType: defaults.parentSetType,
      evidenceStatus: status,
      confidence,
      isBloodline: defaults.isBloodline,
      isLegal: defaults.isLegal,
      isSocial: defaults.isSocial,
      lineStyle: defaults.lineStyle,
      legacyRelationId: relation.id,
    };
  };
  const childFromRelated = (
    relationshipType: ParentChildRelationshipType,
    parentRoleLabel: ParentRoleLabel,
  ): FamilyTreeGraphEdgeIntent => {
    const defaults = parentChildDefaults(relationshipType, parentRoleLabel);
    return {
      kind: "parent_child",
      fromPersonId: relation.personId,
      toPersonId: relation.relatedPersonId,
      relationshipType,
      parentRoleLabel: defaults.parentRoleLabel,
      parentSetType: defaults.parentSetType,
      evidenceStatus: status,
      confidence,
      isBloodline: defaults.isBloodline,
      isLegal: defaults.isLegal,
      isSocial: defaults.isSocial,
      lineStyle: defaults.lineStyle,
      legacyRelationId: relation.id,
    };
  };
  const partner = (relationshipType: PartnerRelationshipType): FamilyTreeGraphEdgeIntent => ({
    kind: "partner",
    fromPersonId: relation.personId,
    toPersonId: relation.relatedPersonId,
    relationshipType,
    evidenceStatus: status,
    confidence,
    lineStyle: PARTNER_RELATION_LINE_STYLE[relationshipType],
    legacyRelationId: relation.id,
  });
  const associationRelatedToPerson = (
    associationType: AssociationRelationshipType,
  ): FamilyTreeGraphEdgeIntent => ({
    kind: "association",
    fromPersonId: relation.relatedPersonId,
    toPersonId: relation.personId,
    relationshipType: associationType,
    evidenceStatus: status,
    confidence,
    lineStyle: "annotated",
    legacyRelationId: relation.id,
  });
  const associationPersonToRelated = (
    associationType: AssociationRelationshipType,
  ): FamilyTreeGraphEdgeIntent => ({
    kind: "association",
    fromPersonId: relation.personId,
    toPersonId: relation.relatedPersonId,
    relationshipType: associationType,
    evidenceStatus: status,
    confidence,
    lineStyle: "annotated",
    legacyRelationId: relation.id,
  });

  switch (relation.relationType) {
    case "батько":
      return parentFromRelated("biological", "father");
    case "мати":
      return parentFromRelated("biological", "mother");
    case "батько або мати":
      return parentFromRelated("presumed", "parent");
    case "вітчим":
      return parentFromRelated("step", "stepfather");
    case "мачуха":
      return parentFromRelated("step", "stepmother");
    case "опікун":
      return parentFromRelated("guardian", "guardian");
    case "усиновлювач":
      return parentFromRelated("adoptive", "parent");
    case "дитина":
    case "син":
    case "донька":
      return childFromRelated("biological", "parent");
    case "пасинок":
      return childFromRelated("step", "stepfather");
    case "падчерка":
      return childFromRelated("step", "stepmother");
    case "підопічний":
      return childFromRelated("guardian", "guardian");
    case "усиновлена дитина":
      return childFromRelated("adoptive", "parent");
    case "чоловік":
    case "дружина":
    case "подружжя":
      return partner("marriage");
    case "хрещений":
    case "хрещена":
      return associationRelatedToPerson("godparent");
    case "хрещеник":
    case "хрещениця":
      return associationPersonToRelated("godparent");
    case "свідок":
      return associationRelatedToPerson("witness");
    case "поручитель":
      return associationRelatedToPerson("witness");
    case "священник":
    case "духовна особа":
      return associationRelatedToPerson("clergy");
    case "посадова особа":
    case "повитуха":
    case "особа, яка повідомила":
      return associationRelatedToPerson("official");
    case "голова господарства":
      return associationRelatedToPerson("household_member");
    case "член господарства":
    case "наймит або служник":
      return associationPersonToRelated("household_member");
    case "брат":
    case "сестра":
    case "брат або сестра":
    case "родич":
      return associationPersonToRelated("possible_relative");
    case "інше":
      return associationPersonToRelated("other");
    default:
      return null;
  }
}

export function validateFamilyGraph(input: {
  parentChildRelationships: ParentChildRelationship[];
  partnerRelationships?: PartnerRelationship[];
  associationRelationships?: AssociationRelationship[];
}): FamilyTreeGraphIssue[] {
  const issues: FamilyTreeGraphIssue[] = [];
  const seenParentChild = new Set<string>();

  for (const relation of input.parentChildRelationships) {
    if (relation.parentId === relation.childId) {
      issues.push({
        severity: "critical",
        code: "parent_child_self_relation",
        message: "Person cannot be a parent of themselves.",
        personIds: [relation.parentId],
        relationshipIds: [relation.id],
      });
    }

    const duplicateKey = [
      relation.treeId,
      relation.parentId,
      relation.childId,
      relation.relationshipType,
      relation.parentSetId,
    ].join(":");
    if (seenParentChild.has(duplicateKey)) {
      issues.push({
        severity: "warning",
        code: "duplicate_parent_child_relationship",
        message: "The same parent-child relationship is present more than once.",
        personIds: [relation.parentId, relation.childId],
        relationshipIds: [relation.id],
      });
    }
    seenParentChild.add(duplicateKey);
  }

  for (const relation of input.partnerRelationships ?? []) {
    if (relation.personAId === relation.personBId) {
      issues.push({
        severity: "critical",
        code: "partner_self_relation",
        message: "Person cannot be their own partner.",
        personIds: [relation.personAId],
        relationshipIds: [relation.id],
      });
    }
  }

  for (const relation of input.associationRelationships ?? []) {
    if (relation.personAId === relation.personBId) {
      issues.push({
        severity: "warning",
        code: "association_self_relation",
        message: "Association points to the same person on both sides.",
        personIds: [relation.personAId],
        relationshipIds: [relation.id],
      });
    }
  }

  for (const cycle of findBloodlineCycles(input.parentChildRelationships)) {
    issues.push({
      severity: "critical",
      code: "bloodline_cycle",
      message: "Bloodline parent-child relationships contain a cycle.",
      personIds: cycle,
    });
  }

  return issues;
}

export function findBloodlineCycles(
  relationships: ParentChildRelationship[],
): string[][] {
  const byParent = new Map<string, string[]>();
  for (const relation of relationships) {
    if (!relation.isBloodline || relation.evidenceStatus === "disproven") continue;
    const children = byParent.get(relation.parentId) ?? [];
    children.push(relation.childId);
    byParent.set(relation.parentId, children);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];

  const visit = (personId: string) => {
    if (visiting.has(personId)) {
      const start = path.indexOf(personId);
      cycles.push(start >= 0 ? path.slice(start).concat(personId) : [personId]);
      return;
    }
    if (visited.has(personId)) return;

    visiting.add(personId);
    path.push(personId);
    for (const childId of byParent.get(personId) ?? []) {
      visit(childId);
    }
    path.pop();
    visiting.delete(personId);
    visited.add(personId);
  };

  for (const personId of byParent.keys()) {
    visit(personId);
  }

  return cycles;
}

function legacyEvidenceStatus(status: PersonRelation["status"]): EvidenceStatus {
  switch (status) {
    case "доведено":
      return "proven";
    case "імовірно":
      return "likely";
    case "сумнівно":
      return "disputed";
    case "спростовано":
      return "disproven";
    case "гіпотеза":
    default:
      return "unknown";
  }
}

function confidenceForEvidenceStatus(status: EvidenceStatus): number {
  switch (status) {
    case "proven":
      return 100;
    case "likely":
      return 75;
    case "disputed":
      return 35;
    case "disproven":
      return 0;
    case "unknown":
    default:
      return 50;
  }
}
