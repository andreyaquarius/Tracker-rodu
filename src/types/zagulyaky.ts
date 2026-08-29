import type { GeoPoint } from "./index";

export type ZagulyakaKind = "person" | "document";

export type ZagulyakaWorkflowStatus =
  | "draft"
  | "pending_review"
  | "needs_changes"
  | "published"
  | "rejected"
  | "withdrawn"
  | "merged"
  | "archived";

export type ZagulyakaVerificationStatus =
  | "unverified"
  | "plausible"
  | "corroborated"
  | "verified"
  | "disputed";

export type ZagulyakaEventType =
  | "birth"
  | "baptism"
  | "marriage"
  | "death"
  | "burial"
  | "residence"
  | "census"
  | "military"
  | "migration"
  | "witness"
  | "godparent"
  | "other";

/**
 * Stable, display-independent identifiers for a person's role in an event.
 *
 * `subject` is retained for records created before explicit event roles were
 * introduced. New records should normally use the event-specific roles (for
 * example, `groom`, `bride`, or the gender-neutral `witness`).
 */
export type ZagulyakaEventRoleCode =
  | "subject"
  | "newborn"
  | "baptized"
  | "groom"
  | "bride"
  | "pledger"
  | "groom_father"
  | "groom_mother"
  | "bride_father"
  | "bride_mother"
  | "deceased"
  | "resident"
  | "household_head"
  | "household_member"
  | "military_person"
  | "migrant"
  | "godparent"
  | "godchild"
  | "father"
  | "mother"
  | "parent"
  | "child"
  | "spouse"
  | "witness"
  | "officiant"
  | "registrar"
  | "midwife"
  | "informant"
  | "owner"
  | "commander"
  | "official"
  | "other";

export type ZagulyakaDatePrecision =
  | "exact"
  | "month"
  | "year"
  | "range"
  | "approximate"
  | "before"
  | "after"
  | "unknown";

export interface ZagulyakyStats {
  peopleCount: number;
  documentCount: number;
  placesCount: number;
  archiveCount: number;
  earliestYear: number | null;
  latestYear: number | null;
  verifiedCount: number;
  contributorsCount: number;
  addedLast30Days: number;
}

export interface ZagulyakaPersonListItem {
  id: string;
  slug: string;
  displayName: string;
  originalName: string;
  normalizedNameUk: string;
  gender: "male" | "female" | "unknown";
  birthYear: number | null;
  originPlace: string;
  foundPlace: string;
  eventType: ZagulyakaEventType;
  eventDateLabel: string;
  eventYear: number | null;
  sourceCitation: string;
  pageLabel: string;
  verificationStatus: ZagulyakaVerificationStatus;
  confirmationsCount: number;
  publishedAt: string;
}

export interface ZagulyakaDocumentListItem {
  id: string;
  slug: string;
  title: string;
  documentType: string;
  institutionName: string;
  officialPlace: string;
  foundPlaces: string[];
  actualYearFrom: number | null;
  actualYearTo: number | null;
  archiveReference: string;
  pageRange: string;
  recordTypes: string[];
  verificationStatus: ZagulyakaVerificationStatus;
  confirmationsCount: number;
  publishedAt: string;
}

export interface ZagulyakaParticipant {
  id: string;
  role: string;
  /** A stable role code; an empty value is possible for legacy records. */
  eventRoleCode: ZagulyakaEventRoleCode | "";
  /** Free text is used only when `eventRoleCode` is `other`. */
  eventRoleCustomText: string;
  originalName: string;
  normalizedNameUk: string;
  note: string;
}

export interface ZagulyakaSource {
  id: string;
  institutionName: string;
  archiveReference: string;
  sourceTitle: string;
  sourceUrl: string;
  pageLabel: string;
  accessRequiresLogin: boolean;
}

export interface ZagulyakaDetail {
  id: string;
  slug: string;
  kind: ZagulyakaKind;
  title: string;
  summary: string;
  originalText: string;
  normalizedTextUk: string;
  originalName: string;
  normalizedNameUk: string;
  gender: "male" | "female" | "unknown";
  eventType: ZagulyakaEventType | null;
  eventDateLabel: string;
  eventYearFrom: number | null;
  eventYearTo: number | null;
  datePrecision: ZagulyakaDatePrecision;
  originPlace: string;
  foundPlace: string;
  /** Confirmed map point, kept separately from the historical place wording. */
  originGeo: GeoPoint | null;
  /** Confirmed map point, kept separately from the historical place wording. */
  foundGeo: GeoPoint | null;
  officialPlace: string;
  documentType: string;
  pageRange: string;
  recordTypes: string[];
  reason: string;
  verificationStatus: ZagulyakaVerificationStatus;
  confirmationsCount: number;
  contributor: string | null;
  /**
   * An explicitly approved public link to the original Facebook post.
   *
   * This is deliberately separate from a source URL: private source-link
   * metadata remains private unless the protected publication workflow returns this
   * field in the public detail projection.
   */
  originalPostUrl: string;
  source: ZagulyakaSource | null;
  participants: ZagulyakaParticipant[];
  publicMedia: Array<{
    id: string;
    name: string;
    mimeType: string;
    url: string;
    alt: string;
    /** The metadata is public, but a short-lived delivery URL was unavailable. */
    deliveryUnavailable?: boolean;
  }>;
  publishedAt: string;
  updatedAt: string;
}

export interface ZagulyakyPeopleFilters {
  query: string;
  originPlace: string;
  foundPlace: string;
  /**
   * Opaque selectors issued by the public settlement explorer. They make a
   * connection click exact even when the visible source text spells the same
   * settlement differently. They are never shown as editable user input.
   */
  originPlaceKey: string;
  foundPlaceKey: string;
  eventType: ZagulyakaEventType | "";
  eventRole: ZagulyakaEventRoleCode | "";
  yearFrom: number | null;
  yearTo: number | null;
  verificationStatus: ZagulyakaVerificationStatus | "";
}

export interface ZagulyakyDocumentFilters {
  query: string;
  institutionName: string;
  officialPlace: string;
  foundPlace: string;
  documentType: string;
  yearFrom: number | null;
  yearTo: number | null;
  verificationStatus: ZagulyakaVerificationStatus | "";
}

/**
 * A confirmed public settlement extracted from a published person's
 * `origin_geo` or `found_geo` map point.  The key is an opaque server-issued
 * identity; it deliberately is not a record or author identifier.
 */
export interface ZagulyakyPublicSettlement {
  key: string;
  label: string;
  geo: GeoPoint | null;
  recordCount: number;
  originRecordCount: number;
  foundRecordCount: number;
}

export type ZagulyakyPlaceConnectionDirection = "incoming" | "outgoing" | "local";

export interface ZagulyakyPlaceConnectionFilters {
  eventType: ZagulyakaEventType | "";
  eventRole: ZagulyakaEventRoleCode | "";
  yearFrom: number | null;
  yearTo: number | null;
}

/**
 * A public relationship between exactly two confirmed map points on a person
 * Zagulyaka: origin and the place where the record was found.  It is never a
 * claimed travel route.
 */
export interface ZagulyakyPlaceConnection {
  key: string;
  direction: ZagulyakyPlaceConnectionDirection;
  relatedPlace: ZagulyakyPublicSettlement;
  recordCount: number;
  eventTypes: ZagulyakaEventType[];
  yearFrom: number | null;
  yearTo: number | null;
  sampleRecords: Array<{
    slug: string;
    title: string;
    eventType: ZagulyakaEventType | null;
    eventDateText: string;
    eventYearFrom: number | null;
    eventYearTo: number | null;
  }>;
}

export interface ZagulyakyPlaceConnectionGroup {
  placeCount: number;
  recordCount: number;
  hasMore: boolean;
  items: ZagulyakyPlaceConnection[];
}

export interface ZagulyakyPlaceConnections {
  place: ZagulyakyPublicSettlement;
  incoming: ZagulyakyPlaceConnectionGroup;
  outgoing: ZagulyakyPlaceConnectionGroup;
  local: ZagulyakyPlaceConnectionGroup;
}

export interface ZagulyakySearchResult<T> {
  items: T[];
  nextCursor: ZagulyakySearchCursor | null;
  pageSize: number;
}

export interface ZagulyakySearchCursor {
  publishedAt: string;
  id: string;
}

export interface ZagulyakaDraftHandle {
  id: string;
  lockVersion: number;
}

export interface ZagulyakaEditableDraft {
  handle: ZagulyakaDraftHandle;
  input: ZagulyakaDraftInput;
  rightsConfirmed: boolean;
  attachments: ZagulyakaDraftAttachment[];
}

export interface ZagulyakaDraftAttachment {
  id: string;
  storageBucket: string;
  storagePath: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  isPublicDerivative: boolean;
}

/**
 * A private, reusable "where this record was found" shortcut owned by the
 * current author.  It is copied into a draft and is never referenced by a
 * public Zagulyaka record.
 */
export interface ZagulyakaSavedPlace {
  id: string;
  name: string;
  geo: GeoPoint;
  createdAt: string;
  updatedAt: string;
}

/** A private reusable archive/file/source shortcut owned by the author. */
export interface ZagulyakaSavedSourcePreset {
  id: string;
  institutionName: string;
  archiveReference: string;
  sourceTitle: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
}

export type ZagulyakaSavedSourcePresetInput = Pick<
  ZagulyakaSavedSourcePreset,
  "institutionName" | "archiveReference" | "sourceTitle" | "sourceUrl"
>;

export interface ZagulyakaDraftSummary {
  id: string;
  kind: ZagulyakaKind;
  title: string;
  /** Safe human-readable place metadata for the compact private record card. */
  foundPlace: string;
  originPlace: string;
  status: ZagulyakaWorkflowStatus;
  rejectionReason: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  publishedSlug: string | null;
  lockVersion: number;
}

export interface ZagulyakaDraftInput {
  kind: ZagulyakaKind;
  title: string;
  originalName: string;
  normalizedNameUk: string;
  gender: "male" | "female" | "unknown";
  eventType: ZagulyakaEventType | "";
  eventRoleCode: ZagulyakaEventRoleCode | "";
  eventRoleCustomText: string;
  eventDateText: string;
  eventYearFrom: number | null;
  eventYearTo: number | null;
  datePrecision: ZagulyakaDatePrecision;
  originPlace: string;
  foundPlace: string;
  /** Optional map pins; they never replace the source wording above. */
  originGeo: GeoPoint | null;
  foundGeo: GeoPoint | null;
  officialPlace: string;
  documentType: string;
  institutionName: string;
  archiveReference: string;
  pageLabel: string;
  pageRange: string;
  sourceTitle: string;
  sourceUrl: string;
  originalText: string;
  normalizedTextUk: string;
  reason: string;
  recordTypes: string[];
  possibleLivingPerson: boolean;
  publicAttribution: boolean;
  publicAttributionName: string;
}

export const emptyZagulyakaDraft = (kind: ZagulyakaKind): ZagulyakaDraftInput => ({
  kind,
  title: "",
  originalName: "",
  normalizedNameUk: "",
  gender: "unknown",
  eventType: "",
  eventRoleCode: "",
  eventRoleCustomText: "",
  eventDateText: "",
  eventYearFrom: null,
  eventYearTo: null,
  datePrecision: "unknown",
  originPlace: "",
  foundPlace: "",
  originGeo: null,
  foundGeo: null,
  officialPlace: "",
  documentType: "",
  institutionName: "",
  archiveReference: "",
  pageLabel: "",
  pageRange: "",
  sourceTitle: "",
  sourceUrl: "",
  originalText: "",
  normalizedTextUk: "",
  reason: "",
  recordTypes: [],
  possibleLivingPerson: false,
  publicAttribution: false,
  publicAttributionName: "",
});
