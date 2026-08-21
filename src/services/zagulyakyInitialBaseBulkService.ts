import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest";
import { getSupabaseClient } from "./supabaseAuth";

/**
 * The initial tabular base is operated in bounded server-side chunks.  This
 * client intentionally receives only aggregate counters: no card titles,
 * original post text, Facebook URL or per-record eligibility details.
 */
export interface ZagulyakyInitialBaseBulkBatch {
  batchId: string;
  status: string;
  recordCount: number;
  draftCount: number;
  pendingReviewCount: number;
  publishedCount: number;
  updatedAt: string;
}

export interface ZagulyakyInitialBaseBulkBatchesPage {
  items: ZagulyakyInitialBaseBulkBatch[];
  total: number;
}

export interface ZagulyakyInitialBaseBulkExclusions {
  /** A source changed while a bounded server chunk was being processed. */
  sourceUnavailableInCallCount: number;
  /** A living-person clearance changed while a publish chunk was running. */
  livingClearanceMissingInCallCount: number;
  missingOriginCount: number;
  originApprovalPendingCount: number;
  originApprovalNeedsModeratorCount: number;
  requiredFieldsMissingCount: number;
  rightsNotRecordedCount: number;
  livingNeedsDocumentedConsentCount: number;
  privacyBlockedCount: number;
  originNotApprovedCount: number;
  statusCount: number;
  otherCount: number;
}

export interface ZagulyakyInitialBaseBulkSubmissionSummary {
  /** Records the owner can submit to moderation now. */
  availableForSubmission: number;
  remainingEligibleCount: number;
  /** Historical unknown place is deliberately a warning, not a blocker. */
  unknownFoundLocationCount: number;
  exclusions: ZagulyakyInitialBaseBulkExclusions;
}

export interface ZagulyakyInitialBaseBulkPublicationSummary {
  /** Records the moderator can publish after their explicit review decision. */
  availableForPublication: number;
  exclusions: ZagulyakyInitialBaseBulkExclusions;
}

export interface ZagulyakyInitialBaseBulkWarnings {
  unknownFoundLocationCount: number;
}

export interface ZagulyakyInitialBaseBulkSummary {
  batchId: string;
  batchStatus: string;
  recordCount: number;
  draftCount: number;
  needsChangesCount: number;
  pendingReviewCount: number;
  publishedCount: number;
  otherStatusCount: number;
  submission: ZagulyakyInitialBaseBulkSubmissionSummary;
  publication: ZagulyakyInitialBaseBulkPublicationSummary;
  warnings: ZagulyakyInitialBaseBulkWarnings;
}

export interface ZagulyakyInitialBaseBulkResult {
  batchId: string;
  action: "submit" | "publish";
  processedCount: number;
  remainingEligibleCount: number;
  excluded: ZagulyakyInitialBaseBulkExclusions;
  summary: ZagulyakyInitialBaseBulkSummary;
  replayed: boolean;
}

export const ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT = 250;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstRecord(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? record(value[0]) : record(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function valueFor(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return undefined;
}

function text(value: unknown, fallback = ""): string {
  const result = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return result || fallback;
}

function count(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.trunc(numberValue) : fallback;
}

function safeBatchId(value: unknown): string {
  const batchId = text(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(batchId)
    ? batchId
    : "";
}

function chunkLimit(value: number | undefined): number {
  return Math.min(ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT, Math.max(1, Math.trunc(value ?? ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT)));
}

function exclusions(value: unknown): ZagulyakyInitialBaseBulkExclusions {
  const row = record(value);
  return {
    sourceUnavailableInCallCount: count(valueFor(row, "sourceUnavailableInCallCount", "source_unavailable_in_call_count")),
    livingClearanceMissingInCallCount: count(valueFor(row, "livingClearanceMissingInCallCount", "living_clearance_missing_in_call_count")),
    missingOriginCount: count(valueFor(row, "missingOriginCount", "missing_origin_count")),
    originApprovalPendingCount: count(valueFor(row, "originApprovalPendingCount", "origin_approval_pending_count")),
    originApprovalNeedsModeratorCount: count(valueFor(row, "originApprovalNeedsModeratorCount", "origin_approval_needs_moderator_count")),
    requiredFieldsMissingCount: count(valueFor(row, "requiredFieldsMissingCount", "required_fields_missing_count")),
    rightsNotRecordedCount: count(valueFor(row, "rightsNotRecordedCount", "rights_not_recorded_count")),
    livingNeedsDocumentedConsentCount: count(valueFor(row, "livingNeedsDocumentedConsentCount", "living_needs_documented_consent_count")),
    privacyBlockedCount: count(valueFor(row, "privacyBlockedCount", "privacy_blocked_count")),
    originNotApprovedCount: count(valueFor(row, "originNotApprovedCount", "origin_not_approved_count")),
    statusCount: count(valueFor(row, "statusCount", "status_count")),
    // Do not infer an "other" total from arbitrary future fields.  The server
    // may add harmless counters such as `availableAfterAcknowledgement`; only
    // an explicitly named exclusion counter belongs in this bucket.
    otherCount: count(valueFor(row, "otherCount", "other_count")),
  };
}

function summary(value: unknown): ZagulyakyInitialBaseBulkSummary {
  const row = record(value);
  const statusCounts = record(valueFor(row, "statusCounts", "status_counts"));
  const submission = record(valueFor(row, "submission"));
  const publication = record(valueFor(row, "publication"));
  return {
    batchId: safeBatchId(valueFor(row, "batchId", "batch_id")),
    batchStatus: text(valueFor(row, "batchStatus", "batch_status")),
    recordCount: count(valueFor(row, "recordCount", "record_count")),
    draftCount: count(valueFor(statusCounts, "draft")),
    needsChangesCount: count(valueFor(statusCounts, "needsChanges", "needs_changes")),
    pendingReviewCount: count(valueFor(statusCounts, "pendingReview", "pending_review")),
    publishedCount: count(valueFor(statusCounts, "published")),
    otherStatusCount: count(valueFor(statusCounts, "other")),
    submission: {
      availableForSubmission: count(valueFor(
        submission,
        "availableForSubmission",
        "available_for_submission",
        // Old servers used this name when an author acknowledgement was still
        // required. It now means immediately eligible for moderation.
        "availableAfterAcknowledgement",
        "available_after_acknowledgement",
      )),
      remainingEligibleCount: count(valueFor(submission, "remainingEligibleCount", "remaining_eligible_count")),
      unknownFoundLocationCount: count(valueFor(submission, "unknownFoundLocationCount", "unknown_found_location_count")),
      exclusions: exclusions(submission),
    },
    publication: {
      availableForPublication: count(valueFor(
        publication,
        "availableForPublication",
        "available_for_publication",
        "availableAfterAcknowledgement",
        "available_after_acknowledgement",
      )),
      exclusions: exclusions(publication),
    },
    warnings: {
      unknownFoundLocationCount: count(valueFor(record(valueFor(row, "warnings")), "unknownFoundLocationCount", "unknown_found_location_count")),
    },
  };
}

function result(value: unknown, fallbackAction: ZagulyakyInitialBaseBulkResult["action"]): ZagulyakyInitialBaseBulkResult {
  const row = firstRecord(value);
  const parsedSummary = summary(valueFor(row, "summary"));
  const action = text(valueFor(row, "action"));
  return {
    batchId: safeBatchId(valueFor(row, "batchId", "batch_id")) || parsedSummary.batchId,
    action: action === "publish" ? "publish" : action === "submit" ? "submit" : fallbackAction,
    processedCount: count(valueFor(row, "processedCount", "processed_count")),
    remainingEligibleCount: count(valueFor(row, "remainingEligibleCount", "remaining_eligible_count")),
    excluded: exclusions(valueFor(row, "excluded")),
    summary: parsedSummary,
    replayed: valueFor(row, "replayed") === true,
  };
}

function batch(value: unknown): ZagulyakyInitialBaseBulkBatch {
  const row = record(value);
  return {
    batchId: safeBatchId(valueFor(row, "batchId", "batch_id")),
    status: text(valueFor(row, "status")),
    recordCount: count(valueFor(row, "recordCount", "record_count")),
    draftCount: count(valueFor(row, "draftCount", "draft_count")),
    pendingReviewCount: count(valueFor(row, "pendingReviewCount", "pending_review_count")),
    publishedCount: count(valueFor(row, "publishedCount", "published_count")),
    updatedAt: text(valueFor(row, "updatedAt", "updated_at")),
  };
}

async function authenticatedRpc<T>(
  name: string,
  parameters: Record<string, unknown>,
): Promise<T> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const response = await client.rpc(name, parameters);
      return { data: response.data, error: response.error };
    },
  );
  if (error) throw error;
  return data as T;
}

/** Returns only the caller's completed initial-base batch metadata. */
export async function loadMyZagulyakyInitialBaseBulkBatches(
  limit = 20,
  offset = 0,
): Promise<ZagulyakyInitialBaseBulkBatchesPage> {
  const data = await authenticatedRpc<unknown>("list_my_zagulyaky_initial_base_bulk_batches_v1", {
    p_limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
    p_offset: Math.max(Math.trunc(offset), 0),
  });
  const payload = firstRecord(data);
  const items = records(valueFor(payload, "items")).map(batch).filter((item) => Boolean(item.batchId));
  return {
    items,
    total: count(valueFor(payload, "total"), items.length),
  };
}

export async function loadMyZagulyakyInitialBaseBulkSummary(
  batchIdValue: string,
): Promise<ZagulyakyInitialBaseBulkSummary> {
  const batchId = safeBatchId(batchIdValue);
  if (!batchId) throw new Error("INITIAL_BASE_BULK_BATCH_NOT_FOUND");
  return summary(await authenticatedRpc<unknown>("get_my_zagulyaky_initial_base_bulk_summary_v1", {
    p_batch_id: batchId,
  }));
}

export async function loadAdminZagulyakyInitialBaseBulkSummary(
  batchIdValue: string,
): Promise<ZagulyakyInitialBaseBulkSummary> {
  const batchId = safeBatchId(batchIdValue);
  if (!batchId) throw new Error("INITIAL_BASE_BULK_BATCH_NOT_FOUND");
  return summary(await authenticatedRpc<unknown>("admin_get_zagulyaky_initial_base_bulk_summary_v1", {
    p_batch_id: batchId,
  }));
}

export async function submitMyZagulyakyTabularInitialBaseBatch(input: {
  batchId: string;
  limit?: number;
}): Promise<ZagulyakyInitialBaseBulkResult> {
  const batchId = safeBatchId(input.batchId);
  if (!batchId) throw new Error("INITIAL_BASE_BULK_BATCH_NOT_FOUND");
  return result(await authenticatedRpc<unknown>("submit_my_zagulyaky_tabular_initial_base_batch_v1", {
    p_batch_id: batchId,
    p_limit: chunkLimit(input.limit),
    // The deployed RPC preserves these legacy parameters for compatibility.
    // Historical records no longer use them as an author declaration, so this
    // client explicitly sends false until every old client has migrated.
    p_acknowledge_rights: false,
    p_acknowledge_public_origin_link: false,
  }), "submit");
}

export async function publishZagulyakyTabularInitialBaseBatch(input: {
  batchId: string;
  limit?: number;
  acknowledgePublication: boolean;
  acknowledgeNonLivingPrivacy: boolean;
}): Promise<ZagulyakyInitialBaseBulkResult> {
  const batchId = safeBatchId(input.batchId);
  if (!batchId) throw new Error("INITIAL_BASE_BULK_BATCH_NOT_FOUND");
  if (!input.acknowledgePublication || !input.acknowledgeNonLivingPrivacy) {
    throw new Error("INITIAL_BASE_BULK_PUBLISH_ACKNOWLEDGEMENT_REQUIRED");
  }
  return result(await authenticatedRpc<unknown>("admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1", {
    p_batch_id: batchId,
    p_limit: chunkLimit(input.limit),
    p_acknowledge_publication: true,
    p_acknowledge_non_living_privacy: true,
  }), "publish");
}
