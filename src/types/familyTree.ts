import type { DocumentRecord, EntityId, Finding, GeoPoint } from "./index";

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

export type FamilyTreePersonNameType =
  | "primary"
  | "birth"
  | "married"
  | "alias"
  | "original"
  | "transliteration"
  | "religious"
  | "patronymic_variant"
  | "surname_variant"
  | "other";

export interface FamilyTreePersonName {
  id: EntityId;
  projectId: EntityId;
  personId: EntityId;
  nameType: FamilyTreePersonNameType;
  languageCode: string;
  scriptCode: string;
  surname: string;
  givenName: string;
  patronymic: string;
  fullName: string;
  originalText: string;
  isPrimary: boolean;
  isPreferred: boolean;
  evidenceStatus: EvidenceStatus;
  confidence: number;
  sourceDocumentId: EntityId | null;
  sourceFindingId: EntityId | null;
  notes: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type FamilyTreePersonTimelineEventType =
  | "birth"
  | "baptism"
  | "christening"
  | "marriage"
  | "divorce"
  | "residence"
  | "census"
  | "revision_list"
  | "confession_list"
  | "household_register"
  | "immigration"
  | "emigration"
  | "military"
  | "occupation"
  | "education"
  | "nationality"
  | "death"
  | "burial"
  | "cremation"
  | "probate"
  | "mention"
  | "other";

export interface FamilyTreePersonTimelineEvent {
  id: EntityId;
  projectId: EntityId;
  personId: EntityId;
  eventType: FamilyTreePersonTimelineEventType;
  title: string;
  eventDate: string;
  dateFrom: string;
  dateTo: string;
  dateText: string;
  placeName: string;
  geo: GeoPoint | null;
  eventRole: string;
  evidenceStatus: EvidenceStatus;
  confidence: number;
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

export type FamilyTreeGraphMode = "family" | "ancestors" | "descendants" | "direct-line" | "compact";

export type FamilyTreeGraphIssueCode =
  | "selfRelationship"
  | "duplicateParentChild"
  | "biologicalCycle"
  | "repeatedAncestor"
  | "missingPreferredParentSet"
  | "privateLivingPersonVisible"
  | "missingRootPerson"
  | "missingTree"
  | (string & {});

export type FamilyTreeEdgeVisibility = "visible" | "faded" | "hidden";

export interface FamilyTreeGraphQuery {
  projectId: EntityId;
  treeId?: EntityId;
  rootPersonId?: EntityId;
  mode: FamilyTreeGraphMode;
  maxDepth?: number;
  unlimitedDepth?: boolean;
  /** Окрема глибина поколінь угору (family-режим); типово maxDepth. */
  maxDepthUp?: number;
  /** Окрема глибина поколінь униз (family-режим); типово maxDepth. */
  maxDepthDown?: number;
  includeAssociations?: boolean;
  includeDisproven?: boolean;
  includePrivateLiving?: boolean;
  problemsMode?: boolean;
}

export interface FamilyTreeEdgeStyleDto {
  lineStyle: Extract<FamilyTreeLineStyle, "solid" | "dashed" | "dotted">;
  visibility: FamilyTreeEdgeVisibility;
  marker?: "warning" | "disproven";
}

export interface FamilyTreeOccurrenceDto {
  id: string;
  personId: EntityId;
  mode: FamilyTreeGraphMode;
  path: EntityId[];
  generation: number;
  depth: number;
  duplicateIndex: number;
  isRepeated: boolean;
  hiddenParentsCount?: number;
  hiddenChildrenCount?: number;
  hiddenSideBranchesCount?: number;
  sideBranchesExpanded?: boolean;
  familyGroupId?: EntityId | null;
  parentSetId?: EntityId | null;
  layout?: {
    x: number;
    y: number;
    isCollapsed: boolean;
  };
}

export interface FamilyTreeNodeDto {
  personId: EntityId;
  displayName: string;
  primaryName: FamilyTreePersonName | null;
  names: FamilyTreePersonName[];
  events: FamilyTreePersonTimelineEvent[];
  gender: string;
  status: string;
  isLiving: boolean;
  privacyStatus: FamilyTreePrivacyStatus;
  redacted: boolean;
  memberRole?: FamilyTreePersonRole;
  occurrenceIds: string[];
  /** Full, non-rendering profile data used by archival formats such as GEDCOM. */
  metadata?: Record<string, unknown>;
}

export interface FamilyTreeEdgeDto {
  id: string;
  kind: FamilyTreeEdgeKind;
  relationshipId: EntityId;
  fromPersonId: EntityId;
  toPersonId: EntityId;
  fromOccurrenceId?: string;
  toOccurrenceId?: string;
  relationshipType: string;
  parentRoleLabel?: ParentRoleLabel;
  evidenceStatus: EvidenceStatus;
  confidence: number;
  isBloodline?: boolean;
  parentSetId?: EntityId | null;
  familyGroupId?: EntityId | null;
  sourceDocumentId?: EntityId | null;
  sourceFindingId?: EntityId | null;
  style: FamilyTreeEdgeStyleDto;
  metadata: Record<string, unknown>;
}

export interface FamilyTreeGroupDto {
  id: EntityId;
  treeId: EntityId;
  groupType: FamilyGroupType | ParentSetType;
  label: string;
  primaryPartnerIds: EntityId[];
  partnerIds: EntityId[];
  parentIds: EntityId[];
  childIds: EntityId[];
  memberIds: EntityId[];
  parentSetIds: EntityId[];
  metadata: Record<string, unknown>;
}

export interface FamilyTreeIssueDto {
  code: FamilyTreeGraphIssueCode;
  severity: FamilyTreeGraphIssue["severity"];
  message: string;
  personIds: EntityId[];
  relationshipIds: EntityId[];
  occurrenceIds: string[];
  metadata: Record<string, unknown>;
}

export interface FamilyTreeGraphDto {
  projectId: EntityId;
  treeId: EntityId;
  mode: FamilyTreeGraphMode;
  rootPersonId: EntityId | null;
  tree: FamilyTree | null;
  availablePersons: FamilyTreeNodeDto[];
  nodes: FamilyTreeNodeDto[];
  occurrences: FamilyTreeOccurrenceDto[];
  edges: FamilyTreeEdgeDto[];
  groups: FamilyTreeGroupDto[];
  issues: FamilyTreeIssueDto[];
  stats: {
    persons: number;
    occurrences: number;
    edges: number;
    groups: number;
    issues: number;
    repeatedPersons: number;
    hiddenDisprovenEdges: number;
  };
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

export interface GedcomExportOptions {
  sourceName?: string;
  submitterName?: string;
  createdAt?: Date | string;
  gedcomVersion?: "5.5.1" | "7.0";
  includeAssociations?: boolean;
  rootPersonId?: EntityId;
  /** Raw imported records used to retain vendor extensions, citations and media. */
  preservedRecords?: GedcomPreservedRecord[];
  documents?: DocumentRecord[];
  findings?: Finding[];
}

export interface GedcomExportResult {
  text: string;
  individualXrefs: Record<EntityId, string>;
  familyXrefs: Record<string, string>;
  warnings: FamilyTreeGraphIssue[];
}

export interface GedcomLine {
  level: number;
  pointer: string | null;
  tag: string;
  value: string;
  raw: string;
  lineNumber: number;
  parentIndex: number | null;
}

export interface GedcomRecord {
  pointer: string | null;
  tag: string;
  value: string;
  lineIndex: number;
  lineNumber: number;
}

export interface GedcomParseResult {
  lines: GedcomLine[];
  records: GedcomRecord[];
  warnings: FamilyTreeGraphIssue[];
}

export interface GedcomSummary {
  individuals: number;
  families: number;
  sources: number;
  notes: number;
  repositories: number;
  submitters: number;
  characterEncoding: string | null;
  gedcomVersion: string | null;
}

export type GedcomImportGender = "male" | "female" | "unknown";

export interface GedcomImportNameDraft {
  nameType: FamilyTreePersonNameType;
  surname: string;
  givenName: string;
  patronymic: string;
  fullName: string;
  originalText: string;
}

export interface GedcomPreservedLine {
  level: number;
  pointer: string | null;
  tag: string;
  value: string;
}

export interface GedcomPreservedRecord {
  order: number;
  pointer: string | null;
  tag: string;
  value: string;
  lines: GedcomPreservedLine[];
  /** Filled after persistence for records mapped to a Tracker entity. */
  internalId?: EntityId;
  internalTable?: string;
}

export interface GedcomImportCitationDraft {
  sourceXref: string;
  page: string;
  url: string;
  eventType: string;
  role: string;
  quality: string;
  dataDate: string;
  text: string;
  notes: string;
}

export interface GedcomImportMediaDraft {
  file: string;
  format: string;
  title: string;
  fileSize: string;
  photoRin: string;
  isPrimary: boolean;
  isPersonalPhoto: boolean;
}

export interface GedcomImportSourceDraft {
  xref: string;
  title: string;
  author: string;
  publication: string;
  text: string;
  url: string;
  sourceType: string;
  mediaType: string;
  rin: string;
}

export interface GedcomImportEventDraft {
  eventType: FamilyTreePersonTimelineEventType;
  /** Original GEDCOM tag and value are kept separately from TYPE. */
  tag?: string;
  value?: string;
  title?: string;
  eventDate: string;
  dateText: string;
  placeName: string;
  geo: GeoPoint | null;
  notes: string;
  age?: string;
  cause?: string;
  address?: string;
  citations?: GedcomImportCitationDraft[];
  media?: GedcomImportMediaDraft[];
}

export interface GedcomImportPersonDraft {
  xref: string;
  gender: GedcomImportGender;
  isLiving: boolean;
  privacyStatus: FamilyTreePrivacyStatus;
  names: GedcomImportNameDraft[];
  events: GedcomImportEventDraft[];
  fams: string[];
  famc: Array<{
    familyXref: string;
    pedigree: "birth" | "adopted" | "foster" | "sealing" | "other" | null;
  }>;
  notes?: string;
  nationality?: string;
  religion?: string;
  education?: string[];
  rin?: string;
  uid?: string;
  vitalStatus?: "living" | "deceased" | "unknown";
  citations?: GedcomImportCitationDraft[];
  media?: GedcomImportMediaDraft[];
  rawLineNumber: number;
}

export interface GedcomImportFamilyDraft {
  xref: string;
  partnerXrefs: string[];
  childXrefs: string[];
  events: GedcomImportEventDraft[];
  notes?: string;
  rin?: string;
  uid?: string;
  citations?: GedcomImportCitationDraft[];
  rawLineNumber: number;
}

export interface GedcomImportParentChildDraft {
  familyXref: string;
  parentXref: string;
  childXref: string;
  relationshipType: ParentChildRelationshipType;
  parentRoleLabel: ParentRoleLabel;
  pedigree: "birth" | "adopted" | "foster" | "sealing" | "other" | null;
  notes?: string;
}

export interface GedcomImportPartnerDraft {
  familyXref: string;
  personAXref: string;
  personBXref: string;
  relationshipType: PartnerRelationshipType;
  eventDate: string;
  placeName: string;
  endDate?: string;
  endPlaceName?: string;
  notes?: string;
}

export interface GedcomImportDraft {
  rootPersonXref?: string;
  people: GedcomImportPersonDraft[];
  families: GedcomImportFamilyDraft[];
  parentChildRelationships: GedcomImportParentChildDraft[];
  partnerRelationships: GedcomImportPartnerDraft[];
  sources?: GedcomImportSourceDraft[];
  preservedRecords?: GedcomPreservedRecord[];
  unmappedRecords: GedcomRecord[];
  summary: GedcomSummary;
  warnings: FamilyTreeGraphIssue[];
}
