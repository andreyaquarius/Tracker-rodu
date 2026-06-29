import type { EntityId } from "./index";

export type FamilyTreePrivacyStatus = "private" | "project" | "public" | "confidential";
export type EvidenceStatus = "proven" | "likely" | "disputed" | "disproven" | "unknown";

export interface FamilyTree {
  id: EntityId;
  projectId: EntityId;
  researchId: EntityId | null;
  title: string;
  description: string;
  rootPersonId: EntityId | null;
  isDefault: boolean;
  privacyStatus: FamilyTreePrivacyStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type FamilyTreePersonRole = "root" | "member" | "placeholder" | "hidden";

export interface FamilyTreePerson {
  treeId: EntityId;
  projectId: EntityId;
  personId: EntityId;
  memberRole: FamilyTreePersonRole;
  displayOrder: number;
  notes: string;
  createdAt: string;
}

export type FamilyGroupType =
  | "couple"
  | "single_parent"
  | "unknown_partner"
  | "adoption_family"
  | "foster_family"
  | "guardian_family"
  | "research_group"
  | "other";

export interface FamilyGroup {
  id: EntityId;
  projectId: EntityId;
  treeId: EntityId;
  groupType: FamilyGroupType;
  displayLabel: string;
  primaryPartner1Id: EntityId | null;
  primaryPartner2Id: EntityId | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type FamilyGroupMemberRole = "partner" | "parent" | "child" | "member" | "unknown";

export interface FamilyGroupMember {
  projectId: EntityId;
  familyGroupId: EntityId;
  personId: EntityId;
  memberRole: FamilyGroupMemberRole;
  displayOrder: number;
  notes: string;
  createdAt: string;
}

export type PartnerRelationshipType =
  | "marriage"
  | "civil_partnership"
  | "cohabitation"
  | "engagement"
  | "dating"
  | "temporary_relationship"
  | "divorced"
  | "separated"
  | "annulled"
  | "widowhood"
  | "unknown"
  | "other";

export type PartnerRelationshipStatus = "active" | "ended" | "unknown";

export interface PartnerRelationship {
  id: EntityId;
  projectId: EntityId;
  treeId: EntityId;
  familyGroupId: EntityId | null;
  personAId: EntityId;
  personBId: EntityId;
  relationshipType: PartnerRelationshipType;
  status: PartnerRelationshipStatus;
  startDate: string;
  startPlace: string;
  endDate: string;
  endPlace: string;
  evidenceStatus: EvidenceStatus;
  confidence: number;
  isPrimaryForDisplay: boolean;
  privacyStatus: FamilyTreePrivacyStatus;
  sourceDocumentId: EntityId | null;
  sourceFindingId: EntityId | null;
  notes: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ParentSetType =
  | "biological"
  | "genetic"
  | "birth_or_gestational"
  | "adoptive"
  | "foster"
  | "step"
  | "guardian"
  | "social"
  | "legal"
  | "unknown"
  | "other";

export interface ParentSet {
  id: EntityId;
  projectId: EntityId;
  treeId: EntityId;
  childId: EntityId;
  familyGroupId: EntityId | null;
  setType: ParentSetType;
  isPreferredForDisplay: boolean;
  isDefaultForPedigree: boolean;
  displayOrder: number;
  notes: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ParentChildRelationshipType =
  | "biological"
  | "genetic_father"
  | "genetic_mother"
  | "gestational_parent"
  | "birth_parent"
  | "adoptive"
  | "foster"
  | "step"
  | "guardian"
  | "social_parent"
  | "legal_parent"
  | "donor"
  | "surrogate"
  | "presumed"
  | "unknown"
  | "other";

export type ParentRoleLabel =
  | "father"
  | "mother"
  | "parent"
  | "guardian"
  | "stepfather"
  | "stepmother"
  | "adoptive_father"
  | "adoptive_mother"
  | "custom";

export interface ParentChildRelationship {
  id: EntityId;
  projectId: EntityId;
  treeId: EntityId;
  parentId: EntityId;
  childId: EntityId;
  parentSetId: EntityId;
  familyGroupId: EntityId | null;
  relationshipType: ParentChildRelationshipType;
  parentRoleLabel: ParentRoleLabel;
  startDate: string;
  endDate: string;
  evidenceStatus: EvidenceStatus;
  confidence: number;
  isPrimaryForDisplay: boolean;
  isBloodline: boolean;
  isLegal: boolean;
  isSocial: boolean;
  privacyStatus: FamilyTreePrivacyStatus;
  sourceDocumentId: EntityId | null;
  sourceFindingId: EntityId | null;
  notes: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type AssociationRelationshipType =
  | "godparent"
  | "witness"
  | "neighbor"
  | "household_member"
  | "caregiver"
  | "benefactor"
  | "namesake"
  | "mentioned_in_source"
  | "dna_match"
  | "possible_relative"
  | "guardian_non_parent"
  | "clergy"
  | "official"
  | "other";

export interface AssociationRelationship {
  id: EntityId;
  projectId: EntityId;
  treeId: EntityId;
  personAId: EntityId;
  personBId: EntityId;
  associationType: AssociationRelationshipType;
  personARoleLabel: string;
  personBRoleLabel: string;
  evidenceStatus: EvidenceStatus;
  confidence: number;
  privacyStatus: FamilyTreePrivacyStatus;
  sourceDocumentId: EntityId | null;
  sourceFindingId: EntityId | null;
  notes: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type FamilyTreeEdgeKind = "parent_child" | "partner" | "association";
export type FamilyTreeLineStyle = "solid" | "dashed" | "dotted" | "thin" | "annotated";

export interface FamilyTreeGraphIssue {
  severity: "info" | "warning" | "critical" | "needs_review";
  code: string;
  message: string;
  personIds?: EntityId[];
  relationshipIds?: EntityId[];
}

export interface FamilyTreeGraphEdgeIntent {
  kind: FamilyTreeEdgeKind;
  fromPersonId: EntityId;
  toPersonId: EntityId;
  relationshipType: ParentChildRelationshipType | PartnerRelationshipType | AssociationRelationshipType;
  parentRoleLabel?: ParentRoleLabel;
  parentSetType?: ParentSetType;
  evidenceStatus: EvidenceStatus;
  confidence: number;
  isBloodline?: boolean;
  isLegal?: boolean;
  isSocial?: boolean;
  lineStyle: FamilyTreeLineStyle;
  legacyRelationId?: EntityId;
}
