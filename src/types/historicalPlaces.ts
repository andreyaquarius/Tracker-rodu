/**
 * Visibility boundary of a historical place.
 *
 * Global places belong to the shared catalogue. Project places remain inside
 * the project that created them until a separate, moderated promotion flow is
 * introduced.
 */
export type PlaceScope = "global" | "project";

export type PlaceStatus = "active" | "needs_review" | "merged" | "archived";

export type PlaceVerificationStatus =
  | "unverified"
  | "plausible"
  | "verified"
  | "disputed";

export type PlaceNameType =
  | "canonical"
  | "modern"
  | "historical"
  | "official"
  | "unofficial"
  | "local"
  | "pre_reform"
  | "soviet"
  | "source_error"
  | "variant"
  | "other";

export type PlaceNameDatePrecision =
  | "day"
  | "month"
  | "year"
  | "range"
  | "circa"
  | "before"
  | "after"
  | "unknown";

/**
 * A lossless temporal hint for historical-place lookup.  `atDate` remains
 * supported by every caller, while a year/range can travel to newer RPCs
 * without being silently converted to an invented day.
 */
export interface HistoricalPlaceTemporalContext {
  exactDate?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  originalText?: string;
  precision?: PlaceNameDatePrecision | null;
}

export interface PlaceName {
  id: string;
  placeId: string;
  name: string;
  /** Exact spelling supplied by the source or user; never normalized in place. */
  originalText: string;
  languageCode: string;
  nameType: PlaceNameType;
  validFrom: string | null;
  validTo: string | null;
  validFromText: string | null;
  validToText: string | null;
  validFromPrecision: PlaceNameDatePrecision | null;
  validToPrecision: PlaceNameDatePrecision | null;
  /** Convenient aggregate for clients that do not render both date bounds. */
  datePrecision: PlaceNameDatePrecision;
  sourceDocumentId: string | null;
  sourceFindingId: string | null;
  citationId: string | null;
  sourceReference: string | null;
  confidence: number;
  isPrimary: boolean;
  note: string;
  metadata: Record<string, unknown>;
  lockVersion: number;
}

export interface HistoricalPlaceRedirect {
  /** Immediate merge target retained by the source row. */
  targetPlaceId: string;
  /** Final readable target after following a bounded redirect chain. */
  finalTargetPlaceId: string;
  hopCount: number;
}

/** A compact place projection suitable for autocomplete and relation paths. */
export interface PlaceSummary {
  id: string;
  projectId: string | null;
  scope: PlaceScope;
  status: PlaceStatus;
  verificationStatus: PlaceVerificationStatus;
  /** Publication is separate from catalogue ownership and verification. */
  isPublic: boolean;
  /** Present only for the deliberately minimal projection of a merged global Place. */
  isRedirect?: boolean;
  mergedIntoPlaceId?: string | null;
  redirect?: HistoricalPlaceRedirect | null;
  publishedAt: string | null;
  canonicalName: string;
  /** Date-aware label returned by search/resolve; falls back to the canonical name. */
  displayName: string;
  /** Date used by a date-aware search projection, if supplied. */
  atDate: string | null;
  modernName: string;
  placeType: string;
  latitude: number | null;
  longitude: number | null;
  currentCountry: string;
  currentAdmin: string;
  /** Date-aware administrative path returned by autocomplete/profile RPCs. */
  hierarchy: PlaceHierarchyNode[];
  wikidataId: string | null;
  geonamesId: string | null;
  externalIds: Record<string, string>;
  /** Distance supplied only by coordinate searches. */
  distanceKm?: number | null;
  /** Administrative filter echoed by the search projection. */
  ancestorPlaceId?: string | null;
  description: string;
  /** Name that matched the search query, if it differs from the canonical one. */
  matchedName: string;
  matchedNameType: PlaceNameType | null;
  /** Historical/alternative names returned by the search projection. */
  names: PlaceName[];
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceHierarchyNode {
  place: PlaceSummary;
  relationId: string | null;
  relationType: string;
  depth: number;
  validFrom: string | null;
  validTo: string | null;
  validFromText: string | null;
  validToText: string | null;
  sourceId: string | null;
  confidence: number;
  cycleDetected: boolean;
  path: string[];
}

export interface PlaceHierarchyCandidate {
  id: string;
  label: string;
  confidence: number;
  reason: string;
  hierarchy: PlaceHierarchyNode[];
}

interface PlaceHierarchyResolutionBase {
  placeId: string;
  atDate: string | null;
  place: PlaceSummary | null;
  maxDepth: number;
  cycleDetected: boolean;
  ambiguousDetected: boolean;
  requiresExactDate: boolean;
  truncated: boolean;
}

export type PlaceHierarchyResolution =
  | (PlaceHierarchyResolutionBase & {
    status: "resolved";
    hierarchy: PlaceHierarchyNode[];
    candidates: [];
    message: null;
  })
  | (PlaceHierarchyResolutionBase & {
    status: "ambiguous";
    hierarchy: PlaceHierarchyNode[];
    candidates: PlaceHierarchyCandidate[];
    message: string;
  })
  | (PlaceHierarchyResolutionBase & {
    status: "unknown";
    hierarchy: [];
    candidates: [];
    message: string;
  });

export interface PlaceSearchInput {
  query: string;
  projectId?: string | null;
  atDate?: string | null;
  temporalContext?: HistoricalPlaceTemporalContext | null;
  ancestorPlaceId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  radiusKm?: number | null;
  limit?: number;
}

export interface CreatePlaceNameInput {
  name: string;
  originalText?: string;
  languageCode?: string;
  nameType?: PlaceNameType;
  validFrom?: string | null;
  validTo?: string | null;
  validFromText?: string | null;
  validToText?: string | null;
  validFromPrecision?: PlaceNameDatePrecision | null;
  validToPrecision?: PlaceNameDatePrecision | null;
  sourceDocumentId?: string | null;
  sourceFindingId?: string | null;
  citationId?: string | null;
  datePrecision?: PlaceNameDatePrecision;
  sourceReference?: string | null;
  confidence?: number;
  isPrimary?: boolean;
  note?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateProjectPlaceInput {
  projectId: string;
  canonicalName: string;
  modernName?: string;
  description?: string;
  languageCode?: string;
  placeType?: string;
  latitude?: number | null;
  longitude?: number | null;
  currentCountry?: string;
  currentAdmin?: string;
  wikidataId?: string | null;
  geonamesId?: string | null;
  externalIds?: Record<string, string>;
  verificationStatus?: PlaceVerificationStatus;
  status?: PlaceStatus;
  /** Marks a newly entered source wording that still needs identification. */
  needsIdentification?: boolean;
  names?: CreatePlaceNameInput[];
  /** Optional dated parent relation created in the same transaction as Place. */
  parentRelation?: CreateProjectPlaceParentRelationInput;
}

export interface CreateProjectPlaceParentRelationInput {
  parentPlaceId: string;
  relationType?: string;
  validFrom?: string | null;
  validTo?: string | null;
  validFromText?: string | null;
  validToText?: string | null;
  validFromPrecision?: PlaceNameDatePrecision | null;
  validToPrecision?: PlaceNameDatePrecision | null;
  sourceDocumentId?: string | null;
  sourceFindingId?: string | null;
  citationId?: string | null;
  sourceReference?: string | null;
  confidence?: number;
  note?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvePlaceHierarchyInput {
  placeId: string;
  atDate?: string | null;
  temporalContext?: HistoricalPlaceTemporalContext | null;
  maxDepth?: number;
}

/** One dated administrative path shown in the place history timeline. */
export interface PlaceHierarchyHistoryEntry {
  id: string;
  validFrom: string | null;
  validTo: string | null;
  validFromText: string | null;
  validToText: string | null;
  relationType: string;
  confidence: number;
  hierarchy: PlaceHierarchyNode[];
  sourceId: string | null;
  note: string;
}

export interface HistoricalPlaceProfileCounts {
  names: number;
  hierarchyRelations: number;
  people: number;
  events: number;
  documents: number;
  relatedPlaces: number;
}

/** Read model returned by get_place_profile_v1. */
export interface HistoricalPlaceProfile {
  place: PlaceSummary;
  atDate: string | null;
  names: PlaceName[];
  hierarchy: PlaceHierarchyResolution;
  counts: HistoricalPlaceProfileCounts;
}

/**
 * Value kept by HistoricalPlaceField. The exact source wording is deliberately
 * independent from the selected catalogue place and must not be normalized.
 */
export interface HistoricalPlaceFieldValue {
  placeId: string | null;
  originalText: string;
  place: PlaceSummary | null;
  /** Persisted label used when the full Place projection is not loaded yet. */
  placeDisplayName?: string;
}

export interface HistoricalPlaceBoundary extends HistoricalPlaceDatedEvidence {
  id: string;
  placeId: string;
  boundaryType: string;
  geometryGeojson: Record<string, unknown>;
  geometryType: string;
  srid: number;
  validFromPrecision: PlaceNameDatePrecision | null;
  validToPrecision: PlaceNameDatePrecision | null;
  sourceDocumentId: string | null;
  sourceFindingId: string | null;
  citationId: string | null;
}

export type PersonEventPlaceResolutionStatus = "unresolved" | "confirmed" | "needs_review";

export interface PersonEventPlaceLinkResult {
  eventId: string;
  projectId: string;
  personId: string;
  placeId: string | null;
  placeOriginalText: string;
  resolutionStatus: PersonEventPlaceResolutionStatus;
  updatedAt: string;
}

export interface SetPersonEventPlaceInput {
  eventId: string;
  placeId: string;
  /** Undefined preserves the server's current exact wording. Empty is explicit. */
  placeOriginalText?: string;
  resolutionStatus?: Exclude<PersonEventPlaceResolutionStatus, "unresolved">;
  expectedUpdatedAt?: string | null;
}

export interface ClearPersonEventPlaceInput {
  eventId: string;
  preserveOriginalText?: boolean;
  expectedUpdatedAt?: string | null;
}

export interface HistoricalPlaceDatedEvidence {
  validFrom: string | null;
  validTo: string | null;
  validFromText: string | null;
  validToText: string | null;
  confidence: number;
  originalText: string;
  note: string;
  sourceReference: string | null;
  lockVersion: number;
}

export interface HistoricalPlaceRelated extends HistoricalPlaceDatedEvidence {
  id: string;
  direction: "incoming" | "outgoing";
  relationType: string;
  place: PlaceSummary;
}

export interface HistoricalPlaceParish extends HistoricalPlaceDatedEvidence {
  id: string;
  direction: "settlementToParish" | "parishToSettlement";
  religion: string;
  relationType: string;
  place: PlaceSummary;
}

export interface HistoricalArchiveResource {
  id: string;
  parentResourceId: string | null;
  resourceType: "archive" | "fund" | "inventory" | "file" | "catalogue" | "external_resource";
  title: string;
  archiveName: string;
  fund: string;
  inventory: string;
  fileReference: string;
  catalogueReference: string;
  url: string | null;
  description: string;
  sourceReference: string | null;
  originalText: string;
}

export interface HistoricalPlaceArchive extends HistoricalPlaceDatedEvidence {
  id: string;
  relationType: string;
  resource: HistoricalArchiveResource;
}

export interface HistoricalPlaceDocument {
  linkId: string;
  documentId: string;
  title: string;
  documentType: string;
  archive: string;
  fund: string;
  fileReference: string;
  yearFrom: number | null;
  yearTo: number | null;
  url: string | null;
  relationType: string;
  originalText: string;
  sourceReference: string | null;
  confidence: number;
  note: string;
  updatedAt: string;
}

/** Lightweight project document used by historical-place source selectors. */
export interface HistoricalPlaceDocumentOption {
  id: string;
  title: string;
}

export interface HistoricalPlaceExternalIdentifier {
  id: string;
  placeId: string;
  provider: string;
  externalIdentifier: string;
  sourceUrl: string | null;
  isPrimary: boolean;
  lockVersion: number;
}

export interface HistoricalPlacePerson {
  personId: string;
  fullName: string;
  surname: string;
  givenName: string;
  patronymic: string;
  eventCount: number;
  eventTypes: string[];
}

export interface HistoricalPlaceEvent {
  eventId: string;
  personId: string;
  personName: string;
  eventType: string;
  title: string;
  eventDate: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  dateText: string;
  placeName: string;
  /** Exact document/user wording; never replaced by the canonical place. */
  placeOriginalText: string;
  placeResolutionStatus: PersonEventPlaceResolutionStatus;
  eventRole: string;
  evidenceStatus: string;
  confidence: number;
  sourceDocumentId: string | null;
  sourceFindingId: string | null;
  updatedAt: string;
}

export interface HistoricalPlaceMapContext {
  place: PlaceSummary | null;
  boundaries: HistoricalPlaceBoundary[];
  documents: HistoricalPlaceDocument[];
  events: HistoricalPlaceEvent[];
  atDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  temporalMode: "exact_date" | "period" | "all_time";
}

export interface HistoricalPlaceMergeSnapshotCounts {
  names: number;
  boundaries: number;
  typeAssignments: number;
  hierarchyAsChild: number;
  hierarchyAsParent: number;
  relatedOutgoing: number;
  relatedIncoming: number;
  parishAsSettlement: number;
  parishAsParish: number;
  archives: number;
  visibleDocuments: number;
  visibleEvents: number;
  visiblePeople: number;
}

/** Complete administrative evidence returned specifically for merge review. */
export interface HistoricalPlaceMergeAdminContext {
  atDate: string | null;
  currentHierarchy: PlaceHierarchyResolution;
  /** Every readable ancestor path, including historical alternatives. */
  ancestors: PlaceHierarchyNode[];
  history: PlaceHierarchyHistoryEntry[];
}

export interface HistoricalPlaceMergeSnapshot {
  place: PlaceSummary;
  counts: HistoricalPlaceMergeSnapshotCounts;
  names: PlaceName[];
  people: HistoricalPlacePerson[];
  documents: HistoricalPlaceDocument[];
  /** Newer merge previews include the effective administrative path. */
  hierarchy?: PlaceHierarchyNode[];
  /** Full, typed context used by the irreversible merge confirmation. */
  adminContext: HistoricalPlaceMergeAdminContext | null;
}

export interface HistoricalPlaceMergePreview {
  source: HistoricalPlaceMergeSnapshot;
  target: HistoricalPlaceMergeSnapshot;
  canMerge: boolean;
  requiresChangeRequest: boolean;
  preservationPreview: {
    hierarchySelfLinks: number;
    genericSelfLinks: number;
    parishSelfLinks: number;
  };
}

export interface MergeHistoricalPlacesInput {
  sourcePlaceId: string;
  targetPlaceId: string;
  expectedSourceLockVersion: number;
  expectedTargetLockVersion: number;
  reason?: string;
}

export interface HistoricalPlaceMergeResult {
  operationId: string;
  sourcePlaceId: string;
  targetPlaceId: string;
  sourceRedirectStatus: "merged";
  transferCounts: Record<string, number>;
  targetLockVersion: number;
}

export interface PatchHistoricalPlaceInput {
  placeId: string;
  expectedLockVersion: number;
  patch: Partial<Pick<PlaceSummary, "canonicalName" | "modernName" | "description" | "placeType" | "latitude" | "longitude" | "currentCountry" | "currentAdmin" | "wikidataId" | "geonamesId" | "externalIds" | "status" | "verificationStatus">>;
}

export interface AddHistoricalPlaceNameInput extends CreatePlaceNameInput {
  placeId: string;
  /** Required exact source spelling. It becomes immutable after creation. */
  originalText: string;
}

export interface UpdateHistoricalPlaceNameInput {
  nameId: string;
  expectedLockVersion: number;
  /** originalText is intentionally impossible to patch. */
  patch: Omit<CreatePlaceNameInput, "originalText">;
}

export interface HistoricalPlaceRelationInput {
  placeId: string;
  relatedPlaceId: string;
  relationType?: string;
  religion?: string;
  validFrom?: string | null;
  validTo?: string | null;
  validFromText?: string | null;
  validToText?: string | null;
  validFromPrecision?: PlaceNameDatePrecision | null;
  validToPrecision?: PlaceNameDatePrecision | null;
  sourceDocumentId?: string | null;
  sourceFindingId?: string | null;
  citationId?: string | null;
  sourceReference?: string | null;
  originalText?: string;
  confidence?: number;
  note?: string;
}

export interface AddHistoricalPlaceBoundaryInput {
  placeId: string;
  boundaryType?: string;
  geometryGeojson: Record<string, unknown>;
  validFrom?: string | null;
  validTo?: string | null;
  validFromText?: string | null;
  validToText?: string | null;
  validFromPrecision?: PlaceNameDatePrecision | null;
  validToPrecision?: PlaceNameDatePrecision | null;
  sourceDocumentId?: string | null;
  sourceFindingId?: string | null;
  citationId?: string | null;
  sourceReference?: string | null;
  confidence?: number;
  originalText: string;
  note?: string;
}

export interface CreateHistoricalArchiveInput {
  projectId: string;
  resourceType: HistoricalArchiveResource["resourceType"];
  title: string;
  archiveName?: string;
  fund?: string;
  inventory?: string;
  fileReference?: string;
  catalogueReference?: string;
  url?: string | null;
  description?: string;
  sourceReference?: string | null;
  originalText?: string;
}

export interface AddDocumentPlaceLinkInput {
  documentId: string;
  placeId: string;
  relationType?: string;
  /** Required exact wording in the document. */
  originalText: string;
  validFrom?: string | null;
  validTo?: string | null;
  sourceReference?: string | null;
  confidence?: number;
  note?: string;
}

export interface HistoricalPlaceAuditEntry {
  id: number;
  entityTable: string;
  entityId: string;
  placeId: string;
  projectId: string;
  actorId: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}
