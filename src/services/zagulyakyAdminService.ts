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
   * Generic moderator-only source-link evidence. It is never part of a public
   * record projection or search result.
   */
  privateSourceLinks: AdminZagulyakaPrivateSourceLink[];
  participants: Array<Record<string, unknown>>;
  documentDiscoveries: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  versions: AdminZagulyakaVersion[];
  moderationActions: AdminZagulyakaModerationHistoryItem[];
  adminAudit: AdminZagulyakaAuditEntry[];
  claims: Array<Record<string, unknown>>;
}

export interface AdminZagulyakaPrivateSourceLink {
  sourcePlatform: string;
  facebookPostUrl: string;
  sourceTitleOriginal: string;
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

function safePrivateText(value: unknown, maximum = 1_500): string {
  if (typeof value !== "string") return "";
  // Source metadata is moderator-only, but stays bounded to keep a malformed
  // response from locking up the review page.
  return value.replace(/\u0000/gu, "").slice(0, maximum);
}

/** Generic moderator-only source-link evidence; never a public projection. */
function privateSourceLink(value: unknown): AdminZagulyakaPrivateSourceLink {
  const row = record(value);
  return {
    sourcePlatform: safePrivateText(row.sourcePlatform, 120),
    facebookPostUrl: safePrivateText(row.facebookPostUrl, 4_000),
    sourceTitleOriginal: safePrivateText(row.sourceTitleOriginal, 2_000),
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
    // The server retains the old JSON key only during the database migration.
    // The browser treats it as a neutral, moderator-only source-link list.
    privateSourceLinks: records(payload.privateImportOrigins).map(privateSourceLink),
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
