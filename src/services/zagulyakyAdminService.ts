import { getSupabaseClient } from "./supabaseAuth.ts";
import {
  markZagulyakaRecordFresh,
  runZagulyakaVersionedMutation,
} from "../utils/zagulyakyMutationCircuitBreaker";

export type ZagulyakaModerationStatus =
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

export type ZagulyakaPrivacyStatus =
  | "pending"
  | "cleared"
  | "blocked"
  | "requires_consent";

export type ZagulyakaModerationAction =
  | "publish"
  | "request_changes"
  | "reject"
  | "archive"
  | "restore";

export interface AdminZagulyakaQueueItem {
  id: string;
  kind: "person" | "document";
  status: ZagulyakaModerationStatus;
  verificationStatus: ZagulyakaVerificationStatus;
  privacyStatus: ZagulyakaPrivacyStatus;
  title: string;
  summary: string;
  eventType: string | null;
  eventDateText: string | null;
  eventYearFrom: number | null;
  eventYearTo: number | null;
  sourceLocationText: string | null;
  foundLocationText: string | null;
  classificationReason: string;
  lockVersion: number;
  submittedAt: string | null;
  possibleLivingPerson: boolean;
  rightsConfirmedAt: string | null;
  sourceCount: number;
  duplicateCandidateCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminZagulyakaQueuePage {
  items: AdminZagulyakaQueueItem[];
  total: number;
}

export interface AdminZagulyakaDetail {
  record: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  /**
   * Admin-review-only provenance from the tabular import ledger. This never
   * belongs to a public record projection, search result or staging list.
   */
  privateImportOrigins: AdminZagulyakaPrivateImportOrigin[];
  participants: Array<Record<string, unknown>>;
  documentDiscoveries: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  versions: AdminZagulyakaVersion[];
  moderationActions: AdminZagulyakaModerationHistoryItem[];
  adminAudit: AdminZagulyakaAuditEntry[];
  claims: Array<Record<string, unknown>>;
}

export interface AdminZagulyakaPrivateImportOrigin {
  cardKey: string;
  eventKey: string;
  postKey: string;
  sourcePlatform: string;
  sourceDateText: string;
  facebookPostUrl: string;
  sourceCollectionUrl: string;
  sourceTitleOriginal: string;
  postOriginalText: string;
  eventTypeOriginal: string;
  eventDateOriginal: string;
  eventPlaceOriginal: string;
  eventOriginalText: string;
}

export interface AdminZagulyakaVersion {
  id: number;
  revisionNo: number;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface AdminZagulyakaModerationHistoryItem {
  id: number;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminZagulyakaAuditEntry {
  id: number;
  actionCode: string;
  targetType: string | null;
  targetId: string | null;
  outcome: "success" | "failure" | "denied" | string;
  sanitizedDiff: Record<string, unknown>;
  createdAt: string;
}

export type ZagulyakaDuplicateCandidateStatus = "pending" | "confirmed" | "dismissed";

export interface AdminZagulyakaDuplicateRecord {
  id: string;
  kind: "person" | "document";
  status: ZagulyakaModerationStatus;
  privacyStatus: ZagulyakaPrivacyStatus;
  title: string;
  publicSlug: string | null;
  lockVersion: number;
  updatedAt: string;
}

export interface AdminZagulyakaDuplicateCandidate {
  recordId: string;
  candidateRecordId: string;
  score: number;
  reasons: unknown[];
  status: ZagulyakaDuplicateCandidateStatus;
  reviewedAt: string | null;
  createdAt: string;
  record: AdminZagulyakaDuplicateRecord;
  candidate: AdminZagulyakaDuplicateRecord;
}

export interface AdminZagulyakaDuplicateCandidatesPage {
  items: AdminZagulyakaDuplicateCandidate[];
  total: number;
}

export interface AdminZagulyakaDuplicateCandidateMutation {
  recordId: string;
  candidateRecordId: string;
  score: number;
  reasons: unknown[];
  status: ZagulyakaDuplicateCandidateStatus;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CreateAdminZagulyakaDuplicateCandidateInput {
  recordId: string;
  candidateRecordId: string;
  score: number;
  reasons: unknown[];
}

export interface ResolveAdminZagulyakaDuplicateCandidateInput {
  recordId: string;
  candidateRecordId: string;
  status: Exclude<ZagulyakaDuplicateCandidateStatus, "pending">;
  note: string;
}

export interface MergeAdminZagulyakaDuplicateInput {
  survivorRecordId: string;
  mergedRecordId: string;
  survivorExpectedLockVersion: number;
  mergedExpectedLockVersion: number;
  note: string;
}

export interface AdminZagulyakaDuplicateMergeResult {
  survivor: Record<string, unknown>;
  merged: Record<string, unknown>;
}

export type ZagulyakaClaimStatus = "open" | "reviewing" | "resolved" | "rejected";
export type ZagulyakaClaimRecordAction = "none" | "privacy_block" | "archive";

export interface AdminZagulyakaClaim {
  id: string;
  recordId: string;
  recordSlug: string | null;
  recordTitle: string;
  claimType: string;
  message: string;
  status: ZagulyakaClaimStatus;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminZagulyakaClaimsPage {
  items: AdminZagulyakaClaim[];
  total: number;
}

export interface ReviewZagulyakaInput {
  recordId: string;
  expectedLockVersion: number;
  action: ZagulyakaModerationAction;
  note?: string;
  verificationStatus?: ZagulyakaVerificationStatus | null;
  privacyStatus?: ZagulyakaPrivacyStatus | null;
  publicSlug?: string | null;
}

export interface AdminZagulyakaPrivacyClearance {
  recordId: string;
  reviewStatus: "missing" | "pending" | "approved" | "revoked" | "rejected";
  publicationBasis: "documented_consent" | null;
  consentObtainedAt: string | null;
  evidenceReference: string;
  privateNote: string;
  reviewedAt: string | null;
  revokedAt: string | null;
  publicVisibilityRestored: boolean;
  clearanceCurrent: boolean;
}

export interface AdminZagulyakaAttachmentAccess {
  url: string;
  expiresIn: number;
  fileName: string;
  mimeType: string;
}

/**
 * Private Stage 0 is intentionally a separate workflow from the public
 * catalogue. These types describe the narrow, admin-only projection returned
 * by the ingestion reviewer RPCs; the browser never queries the underlying
 * ingestion tables directly.
 */
export type AdminZagulyakyIngestionBatchStatus =
  | "received"
  | "processing"
  | "dry_run_complete"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled"
  | "unknown";

export type AdminZagulyakyIngestionStageStatus =
  | "staged"
  | "quarantined"
  | "structured"
  | "linked"
  | "ignored"
  | "unknown";

export type AdminZagulyakyIngestionFlag =
  | "has_attachments"
  | "requires_ocr"
  | "requires_source_refetch";

export interface AdminZagulyakyIngestionBatch {
  id: string;
  sourceFileName: string;
  sourcePlatform: string;
  importMode: "dry_run" | "commit" | "unknown";
  status: AdminZagulyakyIngestionBatchStatus;
  expectedItemCount: number;
  processedItemCount: number;
  stagedItemCount: number;
  duplicateItemCount: number;
  quarantinedItemCount: number;
  failedItemCount: number;
  receivedAt: string | null;
  completedAt: string | null;
}

export interface AdminZagulyakyIngestionBatchesPage {
  items: AdminZagulyakyIngestionBatch[];
  total: number;
}

export interface AdminZagulyakyIngestionItem {
  id: string;
  batchId: string;
  sourceItemIndex: number | null;
  externalId: string;
  stageStatus: AdminZagulyakyIngestionStageStatus;
  quarantined: boolean;
  declaredAttachmentCount: number;
  attachmentCount: number;
  linkCount: number;
  requiresOcr: boolean;
  requiresSourceRefetch: boolean;
  sourceIncomplete: boolean;
  textTruncated: boolean;
  possibleLivingPerson: boolean;
  sourceDateText: string;
  sourcePublishedAt: string | null;
  /** A server-bounded, plain-text scan aid (never the full private text). */
  textPreview: string;
  lastSeenAt: string | null;
}

export interface AdminZagulyakyIngestionItemsPage {
  items: AdminZagulyakyIngestionItem[];
  total: number;
}

export interface AdminZagulyakyIngestionAttachment {
  id: string;
  sourceIndex: number | null;
  assetId: string;
  altText: string;
  originalCdnUrl: string;
  photoPageUrl: string;
  width: number | null;
  height: number | null;
  downloadStatus: string;
  rightsStatus: string;
}

export interface AdminZagulyakyIngestionLink {
  id: string;
  sourceIndex: number | null;
  rawUrl: string;
  normalizedUrl: string;
  label: string;
  linkKind: string;
  requiresSafeFetch: boolean;
}

export interface AdminZagulyakyIngestionJob {
  id: string;
  jobType: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdminZagulyakyIngestionItemError {
  errorCode: string;
  errorDetail: string;
  sourceItemIndex: number | null;
  createdAt: string | null;
}

/**
 * A bounded, admin-only rendering of the extraction associated with one
 * imported post. It is deliberately kept inside the selected source item:
 * this is review data, not a second public catalogue projection.
 */
export type AdminZagulyakyStructuredCandidateKind = "person" | "document" | "unknown";

export interface AdminZagulyakyStructuredCandidateParticipant {
  structuralRole: string;
  eventRoleCode: string;
  eventRoleCustom: string;
  originalFullName: string;
  normalizedUkFullName: string;
  surname: string;
  givenName: string;
  patronymic: string;
  originText: string;
  residenceText: string;
  socialEstateText: string;
}

export interface AdminZagulyakyStructuredCandidate {
  id: string;
  kind: AdminZagulyakyStructuredCandidateKind;
  status: string;
  title: string;
  classificationReason: string;
  confidence: number | null;
  possibleLivingPerson: boolean;
  eventType: string;
  eventDateText: string;
  eventYearFrom: number | null;
  eventYearTo: number | null;
  eventLocationText: string;
  /** Some source adapters return these on the candidate rather than a participant. */
  originText: string;
  residenceText: string;
  socialEstateText: string;
  participants: AdminZagulyakyStructuredCandidateParticipant[];
}

export interface AdminZagulyakyIngestionItemDetail {
  item: AdminZagulyakyIngestionItem;
  sourceAuthorLabel: string;
  sourceUrl: string;
  /** An allowlisted Facebook post URL from the protected item-detail RPC. */
  facebookPostUrl: string;
  sourceCollectionUrl: string;
  candidateYears: number[];
  rawText: string;
  rawTextTruncatedForDisplay: boolean;
  /** Optional until the item-detail RPC is upgraded; an empty array is safe. */
  structuredCandidates: AdminZagulyakyStructuredCandidate[];
  attachments: AdminZagulyakyIngestionAttachment[];
  links: AdminZagulyakyIngestionLink[];
  extractionJobs: AdminZagulyakyIngestionJob[];
  errors: AdminZagulyakyIngestionItemError[];
}

export interface LoadAdminZagulyakyIngestionItemsInput {
  batchId: string;
  query?: string | null;
  stageStatus?: AdminZagulyakyIngestionStageStatus | null;
  quarantined?: boolean | null;
  flag?: AdminZagulyakyIngestionFlag | null;
  limit?: number;
  offset?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function nullableInteger(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isInteger(parsed) ? parsed : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function valueFor(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return undefined;
}

function pageRows(value: unknown, ...keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return records(value);
  const payload = record(value);
  for (const key of keys) {
    const candidate = valueFor(payload, key);
    if (Array.isArray(candidate)) return records(candidate);
  }
  return [];
}

function safeTimestamp(value: unknown): string | null {
  const candidate = nullableText(value);
  return candidate && candidate.length <= 80 && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function safeUuid(value: unknown): string {
  const candidate = text(value).trim();
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(candidate)
    ? candidate
    : "";
}

function safePrivateText(value: unknown, maximum = 1_500): string {
  if (typeof value !== "string") return "";
  // Private text is rendered only by the reviewer component, but bounded here
  // to keep an unusually large social post from locking up the admin page.
  return value.replace(/\u0000/gu, "").slice(0, maximum);
}

/**
 * The review-bundle RPC deliberately returns this data only to a moderator.
 * Keep a second browser-side bound before retaining it in React state: a
 * malformed response must not make the review view hold an unbounded social
 * post or URL. URL protocols are validated again at the render boundary.
 */
function privateImportOrigin(value: unknown): AdminZagulyakaPrivateImportOrigin {
  const row = record(value);
  return {
    cardKey: safePrivateText(row.cardKey, 200),
    eventKey: safePrivateText(row.eventKey, 200),
    postKey: safePrivateText(row.postKey, 200),
    sourcePlatform: safePrivateText(row.sourcePlatform, 120),
    sourceDateText: safePrivateText(row.sourceDateText, 500),
    facebookPostUrl: safePrivateText(row.facebookPostUrl, 4_000),
    sourceCollectionUrl: safePrivateText(row.sourceCollectionUrl, 4_000),
    sourceTitleOriginal: safePrivateText(row.sourceTitleOriginal, 2_000),
    postOriginalText: safePrivateText(row.postOriginalText, 12_000),
    eventTypeOriginal: safePrivateText(row.eventTypeOriginal, 500),
    eventDateOriginal: safePrivateText(row.eventDateOriginal, 500),
    eventPlaceOriginal: safePrivateText(row.eventPlaceOriginal, 4_000),
    eventOriginalText: safePrivateText(row.eventOriginalText, 12_000),
  };
}

function nullableIndex(value: unknown): number | null {
  const candidate = nullableInteger(value);
  return candidate !== null && candidate >= 0 ? candidate : null;
}

function safeBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function ingestionBatchStatus(value: unknown): AdminZagulyakyIngestionBatchStatus {
  const candidate = text(value);
  return [
    "received",
    "processing",
    "dry_run_complete",
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
  ].includes(candidate)
    ? candidate as AdminZagulyakyIngestionBatchStatus
    : "unknown";
}

function ingestionStageStatus(value: unknown): AdminZagulyakyIngestionStageStatus {
  const candidate = text(value);
  return ["staged", "quarantined", "structured", "linked", "ignored"].includes(candidate)
    ? candidate as AdminZagulyakyIngestionStageStatus
    : "unknown";
}

function ingestionBatchItem(value: unknown): AdminZagulyakyIngestionBatch {
  const row = record(value);
  const importMode = text(valueFor(row, "importMode", "import_mode"));
  return {
    id: safeUuid(valueFor(row, "id", "batchId", "batch_id")),
    sourceFileName: safePrivateText(valueFor(row, "sourceFileName", "source_file_name"), 255) || "Файл без назви",
    sourcePlatform: safePrivateText(valueFor(row, "sourcePlatform", "source_platform"), 80) || "facebook_group_json",
    importMode: importMode === "dry_run" || importMode === "commit" ? importMode : "unknown",
    status: ingestionBatchStatus(valueFor(row, "status")),
    expectedItemCount: Math.max(0, integer(valueFor(row, "expectedItemCount", "expected_item_count"))),
    processedItemCount: Math.max(0, integer(valueFor(row, "processedItemCount", "processed_item_count"))),
    stagedItemCount: Math.max(0, integer(valueFor(row, "stagedItemCount", "staged_item_count"))),
    duplicateItemCount: Math.max(0, integer(valueFor(row, "duplicateItemCount", "duplicate_item_count"))),
    quarantinedItemCount: Math.max(0, integer(valueFor(row, "quarantinedItemCount", "quarantined_item_count"))),
    failedItemCount: Math.max(0, integer(valueFor(row, "failedItemCount", "failed_item_count"))),
    receivedAt: safeTimestamp(valueFor(row, "receivedAt", "received_at")),
    completedAt: safeTimestamp(valueFor(row, "completedAt", "completed_at")),
  };
}

function ingestionItem(value: unknown, defaultBatchId = ""): AdminZagulyakyIngestionItem {
  const row = record(value);
  const flags = record(valueFor(row, "flags"));
  const source = record(valueFor(row, "source"));
  const declaredAttachmentCount = Math.max(0, integer(valueFor(
    row,
    "declaredAttachmentCount",
    "declared_attachment_count",
  )));
  return {
    id: safeUuid(valueFor(row, "id", "itemId", "item_id")),
    batchId: safeUuid(valueFor(row, "batchId", "batch_id")) || defaultBatchId,
    sourceItemIndex: nullableIndex(valueFor(row, "sourceItemIndex", "source_item_index")),
    externalId: safePrivateText(valueFor(row, "externalId", "external_id"), 255),
    stageStatus: ingestionStageStatus(valueFor(row, "stageStatus", "stage_status")),
    quarantined: safeBoolean(valueFor(row, "quarantined")),
    declaredAttachmentCount,
    attachmentCount: Math.max(0, integer(valueFor(row, "attachmentCount", "attachment_count"), declaredAttachmentCount)),
    linkCount: Math.max(0, integer(valueFor(row, "linkCount", "link_count"))),
    requiresOcr: safeBoolean(valueFor(row, "requiresOcr", "requires_ocr") ?? valueFor(flags, "requiresOcr", "requires_ocr")),
    requiresSourceRefetch: safeBoolean(valueFor(row, "requiresSourceRefetch", "requires_source_refetch") ?? valueFor(flags, "requiresSourceRefetch", "requires_source_refetch")),
    sourceIncomplete: safeBoolean(valueFor(row, "sourceIncomplete", "source_incomplete") ?? valueFor(flags, "sourceIncomplete", "source_incomplete")),
    textTruncated: safeBoolean(valueFor(row, "textTruncated", "text_truncated") ?? valueFor(flags, "textTruncated", "text_truncated")),
    possibleLivingPerson: safeBoolean(valueFor(row, "possibleLivingPerson", "possible_living_person") ?? valueFor(flags, "possibleLivingPerson", "possible_living_person")),
    sourceDateText: safePrivateText(valueFor(row, "sourceDateText", "source_date_text") ?? valueFor(source, "sourceDateText", "source_date_text"), 500),
    sourcePublishedAt: safeTimestamp(valueFor(row, "sourcePublishedAt", "source_published_at") ?? valueFor(source, "sourcePublishedAt", "source_published_at")),
    textPreview: safePrivateText(valueFor(row, "textPreview", "text_preview"), 360),
    lastSeenAt: safeTimestamp(valueFor(row, "lastSeenAt", "last_seen_at", "updatedAt", "updated_at")),
  };
}

function ingestionAttachment(value: unknown): AdminZagulyakyIngestionAttachment {
  const row = record(value);
  const asset = record(valueFor(row, "asset", "mediaAsset", "media_asset"));
  return {
    id: safeUuid(valueFor(row, "id", "attachmentId", "attachment_id")),
    sourceIndex: nullableIndex(valueFor(row, "sourceIndex", "source_index")),
    assetId: safeUuid(valueFor(row, "assetId", "asset_id")) || safeUuid(valueFor(asset, "id", "assetId", "asset_id")),
    altText: safePrivateText(valueFor(row, "altText", "alt_text"), 1_500),
    originalCdnUrl: safePrivateText(valueFor(row, "originalCdnUrl", "original_cdn_url") ?? valueFor(asset, "originalCdnUrl", "original_cdn_url"), 4_000),
    photoPageUrl: safePrivateText(valueFor(row, "photoPageUrl", "photo_page_url") ?? valueFor(asset, "photoPageUrl", "photo_page_url"), 4_000),
    width: nullableIndex(valueFor(row, "width")),
    height: nullableIndex(valueFor(row, "height")),
    downloadStatus: safePrivateText(valueFor(row, "downloadStatus", "download_status") ?? valueFor(asset, "downloadStatus", "download_status"), 80),
    rightsStatus: safePrivateText(valueFor(row, "rightsStatus", "rights_status") ?? valueFor(asset, "rightsStatus", "rights_status"), 80),
  };
}

function ingestionLink(value: unknown): AdminZagulyakyIngestionLink {
  const row = record(value);
  return {
    id: safeUuid(valueFor(row, "id", "linkId", "link_id")),
    sourceIndex: nullableIndex(valueFor(row, "sourceIndex", "source_index")),
    rawUrl: safePrivateText(valueFor(row, "rawUrl", "raw_url"), 4_000),
    normalizedUrl: safePrivateText(valueFor(row, "normalizedUrl", "normalized_url"), 4_000),
    label: safePrivateText(valueFor(row, "label"), 1_500),
    linkKind: safePrivateText(valueFor(row, "linkKind", "link_kind"), 80),
    requiresSafeFetch: safeBoolean(valueFor(row, "requiresSafeFetch", "requires_safe_fetch")),
  };
}

function ingestionJob(value: unknown): AdminZagulyakyIngestionJob {
  const row = record(value);
  return {
    id: safeUuid(valueFor(row, "id", "jobId", "job_id")),
    jobType: safePrivateText(valueFor(row, "jobType", "job_type"), 80),
    status: safePrivateText(valueFor(row, "status"), 80),
    attemptCount: Math.max(0, integer(valueFor(row, "attemptCount", "attempt_count"))),
    lastErrorCode: safePrivateText(valueFor(row, "lastErrorCode", "last_error_code"), 100),
    createdAt: safeTimestamp(valueFor(row, "createdAt", "created_at")),
    updatedAt: safeTimestamp(valueFor(row, "updatedAt", "updated_at")),
  };
}

function ingestionItemError(value: unknown): AdminZagulyakyIngestionItemError {
  const row = record(value);
  return {
    errorCode: safePrivateText(valueFor(row, "errorCode", "error_code"), 100),
    errorDetail: safePrivateText(valueFor(row, "errorDetail", "error_detail"), 500),
    sourceItemIndex: nullableIndex(valueFor(row, "sourceItemIndex", "source_item_index")),
    createdAt: safeTimestamp(valueFor(row, "createdAt", "created_at")),
  };
}

function structuredCandidateKind(value: unknown): AdminZagulyakyStructuredCandidateKind {
  const candidate = text(value).trim();
  return candidate === "person" || candidate === "document" ? candidate : "unknown";
}

function structuredCandidateConfidence(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.min(1, Math.max(0, candidate)) : null;
}

function structuredCandidateParticipant(value: unknown): AdminZagulyakyStructuredCandidateParticipant {
  const row = record(value);
  return {
    structuralRole: safePrivateText(valueFor(row, "structuralRole", "structural_role"), 40),
    eventRoleCode: safePrivateText(valueFor(row, "eventRoleCode", "event_role_code"), 40),
    eventRoleCustom: safePrivateText(valueFor(row, "eventRoleCustom", "eventRoleCustomText", "event_role_custom"), 160),
    originalFullName: safePrivateText(valueFor(row, "originalFullName", "original_full_name", "fullName", "full_name"), 300),
    normalizedUkFullName: safePrivateText(valueFor(row, "normalizedUkFullName", "normalized_uk_full_name"), 300),
    surname: safePrivateText(valueFor(row, "surname"), 160),
    givenName: safePrivateText(valueFor(row, "givenName", "given_name"), 160),
    patronymic: safePrivateText(valueFor(row, "patronymic"), 160),
    originText: safePrivateText(valueFor(row, "originText", "origin_text"), 500),
    residenceText: safePrivateText(valueFor(row, "residenceText", "residence_text"), 500),
    socialEstateText: safePrivateText(valueFor(row, "socialEstateText", "social_estate_text"), 300),
  };
}

/**
 * The detail RPC is rolled out independently from the browser. Accept both
 * the stored `candidateData` envelope and a future flattened projection so a
 * harmlessly older response simply renders no extracted fields instead of
 * breaking the private reviewer.
 */
function structuredCandidate(value: unknown): AdminZagulyakyStructuredCandidate {
  const row = record(value);
  const candidateData = record(valueFor(row, "candidateData", "candidate_data", "data"));
  const candidate = Object.keys(candidateData).length ? candidateData : row;
  const event = record(valueFor(candidate, "event") ?? valueFor(row, "event"));
  const candidateValue = (...keys: string[]): unknown => valueFor(candidate, ...keys) ?? valueFor(row, ...keys);
  const participants = unknownArray(candidateValue("participants"))
    .map(structuredCandidateParticipant)
    .filter((participant) => Boolean(
      participant.originalFullName
      || participant.normalizedUkFullName
      || participant.surname
      || participant.givenName
      || participant.eventRoleCode
      || participant.structuralRole,
    ))
    .slice(0, 30);

  return {
    id: safeUuid(valueFor(row, "candidateId", "candidate_id", "id")),
    kind: structuredCandidateKind(candidateValue("kind")),
    status: safePrivateText(valueFor(row, "status"), 40),
    title: safePrivateText(candidateValue("title"), 500),
    classificationReason: safePrivateText(candidateValue("classificationReason", "classification_reason"), 1_000),
    confidence: structuredCandidateConfidence(candidateValue("confidence")),
    possibleLivingPerson: safeBoolean(candidateValue("possibleLivingPerson", "possible_living_person")),
    eventType: safePrivateText(valueFor(event, "type", "eventType", "event_type") ?? candidateValue("eventType", "event_type"), 80),
    eventDateText: safePrivateText(valueFor(event, "dateText", "eventDateText", "event_date_text") ?? candidateValue("eventDateText", "event_date_text"), 500),
    eventYearFrom: nullableInteger(valueFor(event, "yearFrom", "eventYearFrom", "event_year_from") ?? candidateValue("eventYearFrom", "event_year_from")),
    eventYearTo: nullableInteger(valueFor(event, "yearTo", "eventYearTo", "event_year_to") ?? candidateValue("eventYearTo", "event_year_to")),
    eventLocationText: safePrivateText(valueFor(event, "placeText", "eventPlaceText", "eventLocationText", "event_place_text", "event_location_text") ?? candidateValue("eventPlaceText", "eventLocationText", "event_place_text", "event_location_text"), 500),
    originText: safePrivateText(candidateValue("originText", "origin_text"), 500),
    residenceText: safePrivateText(candidateValue("residenceText", "residence_text"), 500),
    socialEstateText: safePrivateText(candidateValue("socialEstateText", "social_estate_text"), 300),
    participants,
  };
}

function queueItem(value: unknown): AdminZagulyakaQueueItem {
  const row = record(value);
  return {
    id: text(row.id),
    kind: row.kind === "document" ? "document" : "person",
    status: text(row.status, "draft") as ZagulyakaModerationStatus,
    verificationStatus: text(row.verification_status, "unverified") as ZagulyakaVerificationStatus,
    privacyStatus: text(row.privacy_status, "pending") as ZagulyakaPrivacyStatus,
    title: text(row.title, "Без назви"),
    summary: text(row.summary),
    eventType: nullableText(row.event_type),
    eventDateText: nullableText(row.event_date_text),
    eventYearFrom: nullableInteger(row.event_year_from),
    eventYearTo: nullableInteger(row.event_year_to),
    sourceLocationText: nullableText(row.source_location_text),
    foundLocationText: nullableText(row.found_location_text),
    classificationReason: text(row.classification_reason),
    lockVersion: Math.max(1, integer(row.lock_version, 1)),
    submittedAt: nullableText(row.submitted_at),
    possibleLivingPerson: row.possible_living_person === true,
    rightsConfirmedAt: nullableText(row.rights_confirmed_at),
    sourceCount: Math.max(0, integer(row.source_count)),
    duplicateCandidateCount: Math.max(0, integer(row.duplicate_candidate_count)),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function claimItem(value: unknown): AdminZagulyakaClaim {
  const row = record(value);
  return {
    id: text(row.id),
    recordId: text(row.record_id),
    recordSlug: nullableText(row.public_slug),
    recordTitle: text(row.record_title, "Без назви"),
    claimType: text(row.claim_type, "other"),
    message: text(row.message),
    status: text(row.status, "open") as ZagulyakaClaimStatus,
    resolutionNote: nullableText(row.resolution_note),
    resolvedAt: nullableText(row.resolved_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function versionItem(value: unknown): AdminZagulyakaVersion {
  const row = record(value);
  return {
    id: Math.max(0, integer(row.id)),
    revisionNo: Math.max(0, integer(row.revision_no)),
    snapshot: record(row.snapshot),
    createdAt: text(row.created_at),
  };
}

function moderationHistoryItem(value: unknown): AdminZagulyakaModerationHistoryItem {
  const row = record(value);
  return {
    id: Math.max(0, integer(row.id)),
    action: text(row.action),
    fromStatus: nullableText(row.from_status),
    toStatus: nullableText(row.to_status),
    note: text(row.note),
    metadata: record(row.metadata),
    createdAt: text(row.created_at),
  };
}

function auditItem(value: unknown): AdminZagulyakaAuditEntry {
  const row = record(value);
  return {
    id: Math.max(0, integer(row.id)),
    actionCode: text(row.action_code),
    targetType: nullableText(row.target_type),
    targetId: nullableText(row.target_id),
    outcome: text(row.outcome, "success"),
    sanitizedDiff: record(row.sanitized_diff),
    createdAt: text(row.created_at),
  };
}

function duplicateRecord(value: unknown): AdminZagulyakaDuplicateRecord {
  const row = record(value);
  return {
    id: text(row.id),
    kind: row.kind === "document" ? "document" : "person",
    status: text(row.status, "draft") as ZagulyakaModerationStatus,
    privacyStatus: text(row.privacyStatus, "pending") as ZagulyakaPrivacyStatus,
    title: text(row.title, "Без назви"),
    publicSlug: nullableText(row.publicSlug),
    lockVersion: Math.max(1, integer(row.lockVersion, 1)),
    updatedAt: text(row.updatedAt),
  };
}

function duplicateCandidateItem(value: unknown): AdminZagulyakaDuplicateCandidate {
  const row = record(value);
  return {
    recordId: text(row.record_id),
    candidateRecordId: text(row.candidate_record_id),
    score: Math.min(1, Math.max(0, finiteNumber(row.score))),
    reasons: unknownArray(row.reasons),
    status: text(row.status, "pending") as ZagulyakaDuplicateCandidateStatus,
    reviewedAt: nullableText(row.reviewed_at),
    createdAt: text(row.created_at),
    record: duplicateRecord(row.record),
    candidate: duplicateRecord(row.candidate),
  };
}

function duplicateCandidateMutation(value: unknown): AdminZagulyakaDuplicateCandidateMutation {
  const row = record(value);
  return {
    recordId: text(row.record_id),
    candidateRecordId: text(row.candidate_record_id),
    score: Math.min(1, Math.max(0, finiteNumber(row.score))),
    reasons: unknownArray(row.reasons),
    status: text(row.status, "pending") as ZagulyakaDuplicateCandidateStatus,
    reviewedAt: nullableText(row.reviewed_at),
    createdAt: text(row.created_at),
  };
}

function privacyClearance(value: unknown): AdminZagulyakaPrivacyClearance {
  const row = record(value);
  const reviewStatus = text(row.reviewStatus, "missing");
  return {
    recordId: text(row.recordId),
    reviewStatus: ["missing", "pending", "approved", "revoked", "rejected"].includes(reviewStatus)
      ? reviewStatus as AdminZagulyakaPrivacyClearance["reviewStatus"]
      : "missing",
    publicationBasis: text(row.publicationBasis) === "documented_consent" ? "documented_consent" : null,
    consentObtainedAt: nullableText(row.consentObtainedAt),
    evidenceReference: text(row.evidenceReference),
    privateNote: text(row.privateNote),
    reviewedAt: nullableText(row.reviewedAt),
    revokedAt: nullableText(row.revokedAt),
    publicVisibilityRestored: row.publicVisibilityRestored === true,
    clearanceCurrent: row.clearanceCurrent === true,
  };
}

async function invokeAttachmentWorkflow(
  action: "preview" | "publish" | "revoke",
  attachmentId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseClient().functions.invoke("zagulyaka-attachment", {
    body: { action, attachmentId },
  });
  const payload = record(data);
  if (text(payload.error)) throw new Error(text(payload.error));
  // functions-js deliberately exposes a non-2xx Edge response as an error and
  // leaves `data` empty. Preserve our small server error code so the moderator
  // sees the useful Ukrainian explanation instead of a generic HTTP message.
  if (error) {
    const code = await edgeFunctionErrorCode(error);
    if (code) throw new Error(code);
    throw error;
  }
  return payload;
}

async function edgeFunctionErrorCode(error: unknown): Promise<string> {
  if (!error || typeof error !== "object" || !("context" in error)) return "";
  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== "object") return "";
  const response = context as {
    clone?: () => { json?: () => Promise<unknown> };
    json?: () => Promise<unknown>;
  };
  const readable = typeof response.clone === "function" ? response.clone() : response;
  if (typeof readable.json !== "function") return "";
  try {
    return text(record(await readable.json()).error);
  } catch {
    return "";
  }
}

export async function loadAdminZagulyakyQueue(
  status: ZagulyakaModerationStatus | null = "pending_review",
  limit = 25,
  offset = 0,
): Promise<AdminZagulyakaQueuePage> {
  const { data, error } = await getSupabaseClient().rpc("admin_list_zagulyaky_queue_v1", {
    p_status: status,
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    p_offset: Math.max(Math.trunc(offset), 0),
  });
  if (error) throw error;
  const payload = record(data);
  const items = records(payload.items).map(queueItem);
  for (const item of items) markZagulyakaRecordFresh("admin", item.id);
  return {
    items,
    total: Math.max(0, integer(payload.total)),
  };
}

export async function loadAdminZagulyakaDetail(recordId: string): Promise<AdminZagulyakaDetail> {
  const { data, error } = await getSupabaseClient().rpc("admin_get_zagulyaka_review_bundle_v1", {
    p_record_id: recordId,
    p_version_limit: 40,
    p_action_limit: 80,
  });
  if (error) throw error;
  const payload = record(data);
  const detail = {
    record: record(payload.record),
    sources: records(payload.sources),
    privateImportOrigins: records(payload.privateImportOrigins).map(privateImportOrigin),
    participants: records(payload.participants),
    documentDiscoveries: records(payload.documentDiscoveries),
    attachments: records(payload.attachments),
    versions: records(payload.versions).map(versionItem),
    moderationActions: records(payload.moderationActions).map(moderationHistoryItem),
    adminAudit: records(payload.adminAudit).map(auditItem),
    claims: records(payload.claims),
  };
  markZagulyakaRecordFresh("admin", recordId);
  return detail;
}

export async function loadAdminZagulyakaPrivacyClearance(recordId: string): Promise<AdminZagulyakaPrivacyClearance> {
  const { data, error } = await getSupabaseClient().rpc("admin_get_zagulyaka_privacy_clearance_v1", {
    p_record_id: recordId,
  });
  if (error) throw error;
  return privacyClearance(data);
}

export async function recordAdminZagulyakaLivingConsent(input: {
  recordId: string;
  consentObtainedAt: string;
  evidenceReference: string;
  privateNote?: string;
}): Promise<AdminZagulyakaPrivacyClearance> {
  const { data, error } = await getSupabaseClient().rpc("admin_record_zagulyaka_living_consent_v1", {
    p_record_id: input.recordId,
    p_consent_obtained_at: input.consentObtainedAt,
    p_evidence_reference: input.evidenceReference.trim(),
    p_private_note: input.privateNote?.trim() ?? "",
  });
  if (error) throw error;
  return privacyClearance(data);
}

export async function previewAdminZagulyakaAttachment(attachmentId: string): Promise<AdminZagulyakaAttachmentAccess> {
  const payload = await invokeAttachmentWorkflow("preview", attachmentId);
  const url = text(payload.url);
  if (!url) throw new Error("ATTACHMENT_NOT_AVAILABLE");
  return {
    url,
    expiresIn: Math.max(1, integer(payload.expiresIn, 300)),
    fileName: text(payload.fileName, "Вкладення"),
    mimeType: text(payload.mimeType),
  };
}

export async function publishAdminZagulyakaAttachment(attachmentId: string): Promise<void> {
  await invokeAttachmentWorkflow("publish", attachmentId);
}

export async function revokeAdminZagulyakaAttachment(attachmentId: string): Promise<void> {
  await invokeAttachmentWorkflow("revoke", attachmentId);
}

export async function reviewAdminZagulyaka(input: ReviewZagulyakaInput): Promise<AdminZagulyakaQueueItem> {
  return runZagulyakaVersionedMutation({
    scope: "admin",
    recordIds: [input.recordId],
    action: "review_record",
  }, async () => {
    const { data, error } = await getSupabaseClient().rpc("admin_review_zagulyaka_v1", {
      p_record_id: input.recordId,
      p_expected_lock_version: input.expectedLockVersion,
      p_action: input.action,
      p_note: input.note?.trim() ?? "",
      p_verification_status: input.verificationStatus ?? null,
      p_privacy_status: input.privacyStatus ?? null,
      p_public_slug: input.publicSlug?.trim() || null,
    });
    if (error) throw error;
    return queueItem(data);
  });
}

export async function loadAdminZagulyakyClaims(
  status: ZagulyakaClaimStatus | null = "open",
  limit = 25,
  offset = 0,
): Promise<AdminZagulyakaClaimsPage> {
  const { data, error } = await getSupabaseClient().rpc("admin_list_zagulyaky_claims_v1", {
    p_status: status,
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    p_offset: Math.max(Math.trunc(offset), 0),
  });
  if (error) throw error;
  const payload = record(data);
  return {
    items: records(payload.items).map(claimItem),
    total: Math.max(0, integer(payload.total)),
  };
}

export async function resolveAdminZagulyakaClaim(
  claimId: string,
  status: Exclude<ZagulyakaClaimStatus, "open">,
  resolutionNote = "",
  recordAction: ZagulyakaClaimRecordAction = "none",
): Promise<AdminZagulyakaClaim> {
  const { data, error } = await getSupabaseClient().rpc("admin_resolve_zagulyaka_claim_v2", {
    p_claim_id: claimId,
    p_status: status,
    p_resolution_note: resolutionNote.trim(),
    p_record_action: recordAction,
  });
  if (error) throw error;
  return claimItem(record(data).claim);
}

export async function loadAdminZagulyakaDuplicateCandidates(
  recordId: string | null,
  status: ZagulyakaDuplicateCandidateStatus | null = "pending",
  limit = 25,
  offset = 0,
): Promise<AdminZagulyakaDuplicateCandidatesPage> {
  const { data, error } = await getSupabaseClient().rpc("admin_list_zagulyaky_duplicate_candidates_v1", {
    p_record_id: recordId,
    p_status: status,
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    p_offset: Math.max(Math.trunc(offset), 0),
  });
  if (error) throw error;
  const payload = record(data);
  const items = records(payload.items).map(duplicateCandidateItem);
  for (const item of items) {
    markZagulyakaRecordFresh("admin", item.recordId);
    markZagulyakaRecordFresh("admin", item.candidateRecordId);
  }
  return {
    items,
    total: Math.max(0, integer(payload.total)),
  };
}

export async function createAdminZagulyakaDuplicateCandidate(
  input: CreateAdminZagulyakaDuplicateCandidateInput,
): Promise<AdminZagulyakaDuplicateCandidateMutation> {
  const { data, error } = await getSupabaseClient().rpc("admin_create_zagulyaka_duplicate_candidate_v1", {
    p_record_id: input.recordId,
    p_candidate_record_id: input.candidateRecordId,
    p_score: Math.min(1, Math.max(0, input.score)),
    p_reasons: input.reasons,
  });
  if (error) throw error;
  return duplicateCandidateMutation(data);
}

export async function resolveAdminZagulyakaDuplicateCandidate(
  input: ResolveAdminZagulyakaDuplicateCandidateInput,
): Promise<AdminZagulyakaDuplicateCandidateMutation> {
  const { data, error } = await getSupabaseClient().rpc("admin_resolve_zagulyaka_duplicate_candidate_v1", {
    p_record_id: input.recordId,
    p_candidate_record_id: input.candidateRecordId,
    p_status: input.status,
    p_note: input.note.trim(),
  });
  if (error) throw error;
  return duplicateCandidateMutation(data);
}

export async function mergeAdminZagulyakaDuplicate(
  input: MergeAdminZagulyakaDuplicateInput,
): Promise<AdminZagulyakaDuplicateMergeResult> {
  return runZagulyakaVersionedMutation({
    scope: "admin",
    recordIds: [input.survivorRecordId, input.mergedRecordId],
    action: "merge_duplicate",
  }, async () => {
    const { data, error } = await getSupabaseClient().rpc("admin_merge_zagulyaka_duplicate_v1", {
      p_survivor_record_id: input.survivorRecordId,
      p_merged_record_id: input.mergedRecordId,
      p_survivor_expected_lock_version: Math.max(1, Math.trunc(input.survivorExpectedLockVersion)),
      p_merged_expected_lock_version: Math.max(1, Math.trunc(input.mergedExpectedLockVersion)),
      p_note: input.note.trim(),
    });
    if (error) throw error;
    const payload = record(data);
    return {
      survivor: record(payload.survivor),
      merged: record(payload.merged),
    };
  });
}

/**
 * Lists only the metadata needed to choose an import batch. The RPC is
 * permission-gated server-side; this client intentionally receives neither a
 * file body nor a source checksum/payload.
 */
export async function loadAdminZagulyakyIngestionBatches(
  status: AdminZagulyakyIngestionBatchStatus | null = null,
  limit = 25,
  offset = 0,
): Promise<AdminZagulyakyIngestionBatchesPage> {
  const safeStatus = status && status !== "unknown" ? status : null;
  const { data, error } = await getSupabaseClient().rpc("admin_list_zagulyaky_ingestion_batches_v1", {
    p_status: safeStatus,
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    p_offset: Math.max(Math.trunc(offset), 0),
  });
  if (error) throw error;
  const payload = record(data);
  const items = pageRows(data, "items", "batches").map(ingestionBatchItem).filter((item) => Boolean(item.id));
  return {
    items,
    total: Math.max(0, integer(valueFor(payload, "total", "totalCount", "total_count"), items.length)),
  };
}

/**
 * Lists a narrow review projection for one private batch. Search and all
 * filters are evaluated by the security-definer RPC; the browser has no
 * direct access to Stage 0 tables.
 */
export async function loadAdminZagulyakyIngestionItems(
  input: LoadAdminZagulyakyIngestionItemsInput,
): Promise<AdminZagulyakyIngestionItemsPage> {
  const batchId = safeUuid(input.batchId);
  if (!batchId) throw new Error("INGESTION_BATCH_NOT_FOUND");
  const stageStatus = input.stageStatus && input.stageStatus !== "unknown" ? input.stageStatus : null;
  const flag = input.flag === "has_attachments"
    || input.flag === "requires_ocr"
    || input.flag === "requires_source_refetch"
    ? input.flag
    : null;
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 160) : "";
  const { data, error } = await getSupabaseClient().rpc("admin_list_zagulyaky_ingestion_items_v1", {
    p_batch_id: batchId,
    p_query: query || null,
    p_stage_status: stageStatus,
    p_quarantined: typeof input.quarantined === "boolean" ? input.quarantined : null,
    p_flag: flag,
    p_limit: Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), 100),
    p_offset: Math.max(Math.trunc(input.offset ?? 0), 0),
  });
  if (error) throw error;
  const payload = record(data);
  const items = pageRows(data, "items").map((value) => ingestionItem(value, batchId)).filter((item) => Boolean(item.id));
  return {
    items,
    total: Math.max(0, integer(valueFor(payload, "total", "totalCount", "total_count"), items.length)),
  };
}

/**
 * Fetches one explicitly selected private source item. Deliberately ignored:
 * the raw source JSON object and all image bytes. Text, URL metadata and
 * attachment/job state are enough for a moderator to decide the next step.
 */
export async function loadAdminZagulyakyIngestionItemDetail(
  batchIdValue: string,
  itemIdValue: string,
): Promise<AdminZagulyakyIngestionItemDetail> {
  const batchId = safeUuid(batchIdValue);
  const itemId = safeUuid(itemIdValue);
  if (!batchId || !itemId) throw new Error("INGESTION_ITEM_NOT_FOUND");
  const { data, error } = await getSupabaseClient().rpc("admin_get_zagulyaky_ingestion_item_v1", {
    p_batch_id: batchId,
    p_item_id: itemId,
  });
  if (error) throw error;
  const payload = record(data);
  const itemRow = record(valueFor(payload, "item"));
  const effectiveItemRow = Object.keys(itemRow).length ? itemRow : payload;
  const source = record(valueFor(effectiveItemRow, "source"));
  const content = record(valueFor(effectiveItemRow, "content"));
  const item = ingestionItem(effectiveItemRow, batchId);
  if (!item.id) throw new Error("INGESTION_ITEM_NOT_FOUND");
  const rawTextValue = valueFor(content, "rawText", "raw_text") ?? valueFor(effectiveItemRow, "rawText", "raw_text");
  const rawText = safePrivateText(rawTextValue, 16_000);
  const rawTextTruncatedForDisplay = safeBoolean(valueFor(content, "rawTextTruncatedForReview", "raw_text_truncated_for_review"))
    || (typeof rawTextValue === "string" && rawTextValue.length > rawText.length);
  const candidateYears = unknownArray(valueFor(source, "candidateYears", "candidate_years") ?? valueFor(effectiveItemRow, "candidateYears", "candidate_years"))
    .map((value) => nullableInteger(value))
    .filter((value): value is number => value !== null && value >= 1 && value <= 9_999)
    .slice(0, 50);
  const structuredCandidateRows = pageRows(payload, "structuredCandidates", "structured_candidates", "candidates");
  const itemStructuredCandidateRows = structuredCandidateRows.length
    ? structuredCandidateRows
    : pageRows(effectiveItemRow, "structuredCandidates", "structured_candidates", "candidates");
  return {
    item,
    sourceAuthorLabel: safePrivateText(valueFor(source, "sourceAuthorLabel", "source_author_label") ?? valueFor(effectiveItemRow, "sourceAuthorLabel", "source_author_label"), 500),
    sourceUrl: safePrivateText(valueFor(source, "sourceUrl", "source_url") ?? valueFor(effectiveItemRow, "sourceUrl", "source_url"), 4_000),
    facebookPostUrl: safePrivateText(valueFor(source, "facebookPostUrl", "facebook_post_url") ?? valueFor(effectiveItemRow, "facebookPostUrl", "facebook_post_url"), 4_000),
    sourceCollectionUrl: safePrivateText(valueFor(source, "sourceCollectionUrl", "source_collection_url") ?? valueFor(effectiveItemRow, "sourceCollectionUrl", "source_collection_url"), 4_000),
    candidateYears,
    rawText,
    rawTextTruncatedForDisplay,
    structuredCandidates: itemStructuredCandidateRows
      .map(structuredCandidate)
      .filter((candidate) => Boolean(candidate.id || candidate.title || candidate.participants.length))
      .slice(0, 50),
    attachments: pageRows(payload, "attachments").map(ingestionAttachment),
    links: pageRows(payload, "links").map(ingestionLink),
    extractionJobs: pageRows(payload, "extractionJobs", "extraction_jobs", "jobs").map(ingestionJob),
    errors: pageRows(payload, "errors", "itemErrors", "item_errors").map(ingestionItemError),
  };
}
