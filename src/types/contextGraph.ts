export type ContextRelationCategory =
  | "church"
  | "household"
  | "social"
  | "military"
  | "documentary"
  | "research"
  | "occupation"
  | "education"
  | "other";

export type ContextRelationDirectionality = "directed" | "symmetric";

/**
 * System relation types whose wording identifies one unambiguous social role.
 * The older `godparent` and `witness` codes remain readable for imported data,
 * but new manual assertions use one of these concrete codes.
 */
export type ContextSpecificSocialRelationTypeCode =
  | "godfather"
  | "godmother"
  | "sponsor_for_bride"
  | "sponsor_for_groom"
  | "witness_for_bride"
  | "witness_for_groom"
  | "event_witness";

export type ContextLegacyAmbiguousRelationTypeCode = "godparent" | "sponsor" | "witness";

export type ContextEvidenceStatus =
  | "proven"
  | "likely"
  | "disputed"
  | "disproven"
  | "unknown";

export type ContextPrivacyStatus =
  | "private"
  | "project"
  | "public"
  | "confidential";

export type ContextAssertionKind =
  | "manual"
  | "legacy_import"
  | "generated"
  | "research_hypothesis";

export type ContextEvidenceKind =
  | "document"
  | "finding"
  | "event"
  | "citation"
  | "document_fragment"
  | "legacy_text"
  | "note"
  | "other";

export interface ContextRelationType {
  id: string;
  projectId: string | null;
  code: string;
  category: ContextRelationCategory;
  directionality: ContextRelationDirectionality;
  labelUk: string;
  inverseCode: string;
  inverseLabelUk: string;
  sourceRoleUk: string;
  targetRoleUk: string;
  iconToken: string;
  colorRole: string;
  isSystem: boolean;
  isActive: boolean;
  lockVersion: number;
}

export interface ContextRelationEvidence {
  id: string;
  projectId: string;
  relationId: string;
  evidenceKind: ContextEvidenceKind;
  sourceDocumentId: string | null;
  sourceFindingId: string | null;
  sourceEventId: string | null;
  findingParticipantId: string | null;
  citationId: string | null;
  documentFragmentId: string | null;
  sourceLocator: string;
  excerpt: string;
  notes: string;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PersonContextRelation {
  id: string;
  projectId: string;
  relationTypeId: string;
  relationTypeCode: string;
  relationTypeLabel: string;
  relationCategory: ContextRelationCategory;
  directionality: ContextRelationDirectionality;
  sourcePersonId: string;
  targetPersonId: string;
  sourceRoleLabel: string;
  targetRoleLabel: string;
  validFrom: string;
  validTo: string;
  periodText: string;
  evidenceStatus: ContextEvidenceStatus;
  confidence: number;
  privacyStatus: ContextPrivacyStatus;
  assertionKind: ContextAssertionKind;
  notes: string;
  metadata: Record<string, unknown>;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  evidenceCount: number;
  evidence: ContextRelationEvidence[];
}

export interface PersonContextRelationsPage {
  items: PersonContextRelation[];
  total: number;
  revision: number;
}

export interface PersonContextRelationDraft {
  id?: string;
  relationTypeId: string;
  sourcePersonId: string;
  targetPersonId: string;
  sourceRoleLabel?: string;
  targetRoleLabel?: string;
  validFrom?: string;
  validTo?: string;
  periodText?: string;
  evidenceStatus?: ContextEvidenceStatus;
  confidence?: number;
  privacyStatus?: ContextPrivacyStatus;
  assertionKind?: "manual" | "research_hypothesis";
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextGraphPersonNode {
  id: string;
  entityType: "person";
  isCenter: boolean;
  displayName: string;
  givenName: string;
  surname: string;
  patronymic: string;
  gender: string;
  isLiving: boolean;
  isPrivate: boolean;
  masked: boolean;
  degree: number;
}

export interface ContextGraphPersonEdge {
  id: string;
  sourcePersonId: string;
  targetPersonId: string;
  relationTypeId: string;
  relationTypeCode: string;
  relationTypeLabel: string;
  category: ContextRelationCategory;
  directionality: ContextRelationDirectionality;
  sourceRoleLabel: string;
  targetRoleLabel: string;
  validFrom: string;
  validTo: string;
  periodText: string;
  evidenceStatus: ContextEvidenceStatus;
  confidence: number;
  privacyStatus: ContextPrivacyStatus;
  assertionKind: ContextAssertionKind;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonContextGraphSnapshot {
  centerPersonId: string;
  nodes: ContextGraphPersonNode[];
  edges: ContextGraphPersonEdge[];
  revision: number;
  truncated: boolean;
  edgesTruncated: boolean;
}

export interface PersonContextGraphFilters {
  maxNodes?: number;
  maxEdges?: number;
  relationTypeIds?: readonly string[];
  evidenceStatuses?: readonly ContextEvidenceStatus[];
  validFrom?: string;
  validTo?: string;
}

export type ContextCooccurrenceSourceKind = "finding" | "document" | "event";

export interface PersonContextCooccurrenceSource {
  kind: ContextCooccurrenceSourceKind;
  id: string;
  label: string;
  year: number | null;
}

/**
 * A calculated co-occurrence is a read model, not a persisted relation. The
 * score only ranks repeated shared sources and must never be interpreted as a
 * probability of kinship.
 */
export interface PersonContextCooccurrence {
  personId: string;
  displayName: string;
  masked: boolean;
  sharedFindingCount: number;
  sharedDocumentCount: number;
  sharedEventCount: number;
  sharedSourceCount: number;
  relationStrength: number;
  firstYear: number | null;
  lastYear: number | null;
  topSources: PersonContextCooccurrenceSource[];
}

export interface PersonContextCooccurrencesPage {
  centerPersonId: string;
  algorithmVersion: "cooccurrence_v1";
  items: PersonContextCooccurrence[];
  total: number;
  truncated: boolean;
}

export interface PersonContextCooccurrenceFilters {
  yearFrom?: number;
  yearTo?: number;
  placeId?: string;
  minShared?: number;
  limit?: number;
  offset?: number;
}

export type ChurchRoleNetworkSourceKind =
  | "finding"
  | "document"
  | "event"
  | "document_fragment"
  | "citation";

export type ChurchRoleNetworkRolePreset =
  | "godparents-sponsors"
  | "godparents"
  | "sponsors"
  | "witnesses"
  | "all-ritual";

export interface ChurchRoleNetworkGroup {
  key: string;
  label: string;
  normalizedSurname: string;
  memberCount: number;
}

export interface ChurchRoleNetworkRoleCount {
  code: string;
  label: string;
  count: number;
}

export interface ChurchRoleNetworkSource {
  kind: ChurchRoleNetworkSourceKind;
  id: string;
  label: string;
  year: number | null;
}

export interface ChurchRoleNetworkSample {
  relationId: string;
  roleCode: string;
  roleLabel: string;
  sourcePersonId: string;
  sourceDisplayName: string;
  targetPersonId: string;
  targetDisplayName: string;
  direction: "incoming" | "outgoing";
  assertionKind: ContextAssertionKind;
  evidenceStatus: ContextEvidenceStatus;
  confidence: number;
  year: number | null;
  evidenceCount: number;
  source: ChurchRoleNetworkSource | null;
}

/**
 * A surname cluster is a calculated research aid. It deliberately is not a
 * family group and must never be persisted as proof of kinship.
 */
export interface PersonChurchRoleNetworkItem {
  counterpartGroup: ChurchRoleNetworkGroup;
  occurrenceCount: number;
  relationCount: number;
  personPairCount: number;
  sourcePersonCount: number;
  targetPersonCount: number;
  incomingCount: number;
  outgoingCount: number;
  roleCounts: ChurchRoleNetworkRoleCount[];
  firstYear: number | null;
  lastYear: number | null;
  ambiguousRoleCount: number;
  generatedCount: number;
  manualCount: number;
  samples: ChurchRoleNetworkSample[];
  sources: ChurchRoleNetworkSource[];
}

export interface PersonChurchRoleNetworkPage {
  centerPersonId: string;
  algorithmVersion: "church_role_network_v1";
  groupingKind: "surname_cluster";
  groupingIsGenealogicalFact: false;
  centerGroup: ChurchRoleNetworkGroup | null;
  items: PersonChurchRoleNetworkItem[];
  total: number;
  truncated: boolean;
  capReasons: string[];
  sameGroupOccurrenceCount: number;
  omittedWithoutSurnameCount: number;
}

export interface PersonChurchRoleNetworkFilters {
  roleCodes?: readonly string[];
  yearFrom?: number;
  yearTo?: number;
  evidenceStatuses?: readonly ContextEvidenceStatus[];
  minOccurrences?: number;
  limit?: number;
  offset?: number;
}

/** Entity kinds returned by the bounded documentary graph projection. */
export type DocumentaryGraphEntityType =
  | "person"
  | "finding"
  | "person_event"
  | "document"
  | "place";

/**
 * IDs are namespaced because UUIDs are unique only inside one entity table.
 * Keeping the namespace in the public contract prevents a Person and a
 * Document with an equal UUID from collapsing into one visual node.
 */
export type DocumentaryGraphNodeId = `${DocumentaryGraphEntityType}:${string}`;

export interface DocumentaryGraphNode {
  id: DocumentaryGraphNodeId;
  entityType: DocumentaryGraphEntityType;
  entityId: string;
  label: string;
  secondaryLabel: string;
  depth: number;
  masked: boolean;
  /** Only an allowlisted server projection; never a complete entity row. */
  metadata: Record<string, unknown>;
}

export interface DocumentaryGraphEdge {
  id: string;
  source: DocumentaryGraphNodeId;
  target: DocumentaryGraphNodeId;
  relationType: string;
  label: string;
  status: ContextEvidenceStatus;
  confidence: number;
  sourceCount: number;
  generated: boolean;
  /** Only an allowlisted server projection; never source excerpts or notes. */
  metadata: Record<string, unknown>;
}

export interface PersonDocumentaryGraphSnapshot {
  centerNodeId: DocumentaryGraphNodeId;
  nodes: DocumentaryGraphNode[];
  edges: DocumentaryGraphEdge[];
  generatedAt: string;
  snapshotUpdatedAt: string;
  truncated: boolean;
  edgesTruncated: boolean;
}

export interface PersonDocumentaryGraphFilters {
  depth?: 1 | 2;
  entityTypes?: readonly DocumentaryGraphEntityType[];
  eventTypes?: readonly string[];
  evidenceStatuses?: readonly ContextEvidenceStatus[];
  yearFrom?: number;
  yearTo?: number;
  placeId?: string;
  maxNodes?: number;
  maxEdges?: number;
}

/**
 * Entity kinds exposed by the research/context projection. This contract is
 * deliberately separate from DocumentaryGraphEntityType: the documentary
 * view stays a compact read model while research assertions may connect any
 * supported contextual entity without changing the family-tree graph.
 */
export type ResearchGraphEntityType =
  | "person"
  | "family"
  | "place"
  | "event"
  | "document"
  | "finding"
  | "source"
  | "repository"
  | "hypothesis";

export type ResearchGraphNodeId = `${ResearchGraphEntityType}:${string}`;

export interface ResearchGraphNode {
  id: ResearchGraphNodeId;
  entityType: ResearchGraphEntityType;
  entityId: string;
  label: string;
  secondaryLabel: string;
  isCenter: boolean;
  masked: boolean;
  depth: 0 | 1 | 2 | 3;
  /** Allowlisted display metadata only; complete entity rows are never exposed. */
  metadata: Record<string, unknown>;
}

export interface ResearchGraphEdge {
  id: string;
  source: ResearchGraphNodeId;
  target: ResearchGraphNodeId;
  sourceEntityType: ResearchGraphEntityType;
  sourceEntityId: string;
  targetEntityType: ResearchGraphEntityType;
  targetEntityId: string;
  relationTypeId: string;
  relationTypeCode: string;
  relationTypeLabel: string;
  relationCategory: ContextRelationCategory;
  directionality: ContextRelationDirectionality;
  sourceRoleLabel: string;
  targetRoleLabel: string;
  validFrom: string;
  validTo: string;
  periodText: string;
  evidenceStatus: ContextEvidenceStatus;
  confidence: number;
  privacyStatus: ContextPrivacyStatus;
  assertionKind: ContextAssertionKind;
  evidenceCount: number;
  generated: boolean;
  lockVersion: number;
  /** Reproducible algorithm/origin metadata; private notes are not projected. */
  metadata: Record<string, unknown>;
}

export interface PersonResearchGraphSnapshot {
  projectId: string;
  center: {
    entityType: "person";
    entityId: string;
  };
  depth: 1 | 2 | 3;
  revision: number;
  nodes: ResearchGraphNode[];
  edges: ResearchGraphEdge[];
  limits: {
    maxNodes: number;
    maxEdges: number;
  };
  truncated: {
    nodes: boolean;
    edges: boolean;
  };
  /** Echoed by v2 so the client can reject a mismatched temporal/place projection. */
  filters: {
    focusDate: string | null;
    focusYear: number | null;
    placeIds: string[];
    includeUndated: boolean;
  };
}

export interface PersonResearchGraphFilters {
  depth?: 1 | 2 | 3;
  entityTypes?: readonly ResearchGraphEntityType[];
  relationTypeIds?: readonly string[];
  evidenceStatuses?: readonly ContextEvidenceStatus[];
  assertionKinds?: readonly ContextAssertionKind[];
  validFrom?: string;
  validTo?: string;
  minConfidence?: number;
  hasEvidence?: boolean;
  /** Exactly one temporal focus can be active. Missing values mean "all time". */
  focusDate?: string;
  focusYear?: number;
  placeIds?: readonly string[];
  includeUndated?: boolean;
  maxNodes?: number;
  maxEdges?: number;
}

export type ResearchGraphLayoutId = "hierarchical" | "force" | "radial";

/** Server-allowlisted filter state stored in a personal graph view. */
export interface ResearchGraphSavedViewFilters {
  depth: 1 | 2 | 3;
  entityTypes: ResearchGraphEntityType[];
  relationTypeIds: string[];
  evidenceStatuses: ContextEvidenceStatus[];
  assertionKinds: ContextAssertionKind[];
  validFrom: string;
  validTo: string;
  minConfidence: number;
  hasEvidence: boolean | null;
  focusDate: string;
  focusYear: number | null;
  placeIds: string[];
  includeUndated: boolean;
  maxNodes: number;
  maxEdges: number;
}

export interface ResearchGraphSavedViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResearchGraphSavedViewState {
  layoutId: ResearchGraphLayoutId;
  zoom: number;
  viewport: ResearchGraphSavedViewport;
}

export interface ResearchGraphSavedView {
  configVersion: 1;
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  description: string;
  centerEntityType: "person";
  centerEntityId: string;
  filters: ResearchGraphSavedViewFilters;
  viewState: ResearchGraphSavedViewState;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchGraphSavedViewsPage {
  items: ResearchGraphSavedView[];
  total: number;
}

export interface ResearchGraphSavedViewDraft {
  configVersion: 1;
  id?: string;
  name: string;
  description?: string;
  centerEntityType: "person";
  centerEntityId: string;
  filters: ResearchGraphSavedViewFilters;
  viewState: ResearchGraphSavedViewState;
}

/** Anonymous bearer links are intentionally read-only and owner managed. */
export type ResearchGraphShareAccessMode = "public_readonly";

export type ResearchGraphShareStatus = "active" | "suspended" | "expired" | "revoked";

/**
 * Owner-facing metadata. The raw bearer token is deliberately absent: it is
 * returned once by the create/rotate RPC and is never listable afterwards.
 */
export interface ResearchGraphViewShare {
  id: string;
  projectId: string;
  savedViewId: string;
  accessMode: ResearchGraphShareAccessMode;
  publicTitle: string;
  status: ResearchGraphShareStatus;
  active: boolean;
  expiresAt: string;
  revokedAt: string | null;
  sourceViewLockVersion: number;
  lockVersion: number;
  createdAt: string;
  rotatedAt: string;
  updatedAt: string;
}

export interface ResearchGraphViewSharesPage {
  items: ResearchGraphViewShare[];
  total: number;
}

export interface ResearchGraphViewShareDraft {
  savedViewId: string;
  accessMode: ResearchGraphShareAccessMode;
  expiresAt: string;
  publicTitle: string;
  /** Null creates the first row; rotate/republish must compare the listed row. */
  expectedLockVersion: number | null;
}

export interface ResearchGraphViewShareCreated {
  share: ResearchGraphViewShare;
  /** One-time bearer secret. Keep in component memory only. */
  token: string;
}

export type SharedResearchGraphEntityType = "person" | "place";

export interface SharedResearchGraphNode {
  /** Share-scoped opaque identifier; never a project entity UUID. */
  id: string;
  entityType: SharedResearchGraphEntityType;
  label: string;
  secondaryLabel: string;
  isCenter: boolean;
  masked: boolean;
  depth: 0 | 1 | 2 | 3;
}

export interface SharedResearchGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  directionality: ContextRelationDirectionality;
  evidenceStatus: ContextEvidenceStatus;
  assertionKind: ContextAssertionKind;
  confidence: number;
  generated: boolean;
}

/** Strictly server-sanitized payload for the anonymous share viewer. */
export interface SharedResearchGraphView {
  share: {
    accessMode: ResearchGraphShareAccessMode;
    expiresAt: string;
  };
  view: {
    /** Separately confirmed public title; never the private saved-view name. */
    title: string;
    layoutId: ResearchGraphLayoutId;
    zoom: number;
    viewport: ResearchGraphSavedViewport;
  };
  graph: {
    centerNodeId: string;
    nodes: SharedResearchGraphNode[];
    edges: SharedResearchGraphEdge[];
  };
}

/** A named catalogue option. Its UUID remains an internal request value. */
export interface ResearchGraphPlaceOption {
  id: string;
  label: string;
  secondaryLabel: string;
}

/** A user-selectable entity already available in the current project cache. */
export interface ResearchGraphTargetOption {
  entityType: Extract<
    ResearchGraphEntityType,
    "person" | "document" | "finding" | "place" | "hypothesis" | "event"
  >;
  entityId: string;
  label: string;
  secondaryLabel?: string;
  /** Used only to open an event through its owning person when no event page exists. */
  ownerPersonId?: string;
}

export interface ContextRelationV2 {
  id: string;
  projectId: string;
  relationTypeId: string;
  relationTypeCode: string;
  relationTypeLabel: string;
  relationCategory: ContextRelationCategory;
  directionality: ContextRelationDirectionality;
  sourceEntityType: ResearchGraphEntityType;
  sourceEntityId: string;
  targetEntityType: ResearchGraphEntityType;
  targetEntityId: string;
  sourceRoleLabel: string;
  targetRoleLabel: string;
  validFrom: string;
  validTo: string;
  periodText: string;
  evidenceStatus: ContextEvidenceStatus;
  confidence: number;
  privacyStatus: ContextPrivacyStatus;
  assertionKind: ContextAssertionKind;
  notes: string;
  metadata: Record<string, unknown>;
  personContextRelationId: string | null;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  evidenceCount: number;
}

export interface ContextRelationV2Draft {
  id?: string;
  relationTypeId: string;
  sourceEntityType: ResearchGraphEntityType;
  sourceEntityId: string;
  targetEntityType: ResearchGraphEntityType;
  targetEntityId: string;
  sourceRoleLabel?: string;
  targetRoleLabel?: string;
  validFrom?: string;
  validTo?: string;
  periodText?: string;
  evidenceStatus?: ContextEvidenceStatus;
  confidence?: number;
  privacyStatus?: ContextPrivacyStatus;
  assertionKind?: "manual" | "research_hypothesis";
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextRelationEvidenceV2 {
  id: string;
  projectId: string;
  relationId: string;
  /** Generic evidence can be edited here; projected v1 evidence stays read-only. */
  evidenceSource: "generic" | "person_v1" | "unknown";
  evidenceEntityType: ResearchGraphEntityType | null;
  evidenceEntityId: string | null;
  citationId: string | null;
  documentFragmentId: string | null;
  sourceLocator: string;
  excerpt: string;
  notes: string;
  metadata: Record<string, unknown>;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ContextRelationEvidenceV2Draft {
  id?: string;
  relationId: string;
  evidenceEntityType?: ResearchGraphEntityType;
  evidenceEntityId?: string;
  citationId?: string;
  documentFragmentId?: string;
  sourceLocator?: string;
  excerpt?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}
