import type {
  ZagulyakaDetail,
  ZagulyakaDocumentListItem,
  ZagulyakaEditableDraft,
  ZagulyakaDraftHandle,
  ZagulyakaDraftAttachment,
  ZagulyakaDraftInput,
  ZagulyakaDraftSummary,
  ZagulyakaEventType,
  ZagulyakaPersonListItem,
  ZagulyakaSavedPlace,
  ZagulyakaSavedSourcePreset,
  ZagulyakaSavedSourcePresetInput,
  ZagulyakaVerificationStatus,
  ZagulyakaWorkflowStatus,
  ZagulyakyDocumentFilters,
  ZagulyakyPeopleFilters,
  ZagulyakySearchCursor,
  ZagulyakySearchResult,
  ZagulyakyStats,
} from "../types/zagulyaky";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest";
import { normalizeGeo } from "../utils/geo";
import { normalizeZagulyakaEventRoleCode } from "../utils/zagulyakyEventRoles";
import {
  markZagulyakaRecordFresh,
  runZagulyakaVersionedMutation,
} from "../utils/zagulyakyMutationCircuitBreaker";
import { invokeEdgeFunction } from "./edgeFunctions";
import { getSupabaseClient } from "./supabaseAuth";

const eventTypes = new Set<ZagulyakaEventType>([
  "birth", "baptism", "marriage", "death", "burial", "residence",
  "census", "military", "migration", "witness", "godparent", "other",
]);
const verificationStatuses = new Set<ZagulyakaVerificationStatus>([
  "unverified", "plausible", "corroborated", "verified", "disputed",
]);
const claimTypes = new Set(["correction", "privacy", "copyright", "abuse", "source_problem", "other"]);
const zagulyakaWorkflowStatuses: ZagulyakaWorkflowStatus[] = [
  "draft", "pending_review", "needs_changes", "published",
  "rejected", "withdrawn", "merged", "archived",
];

/** The largest allowed private-list page. Kept for callers that need a default. */
export const ZAGULYAKY_MY_RECORDS_PAGE_SIZE = 50;
export const ZAGULYAKY_MY_RECORDS_PAGE_SIZES = [10, 20, 50] as const;
export type ZagulyakyMyRecordsPageSize = typeof ZAGULYAKY_MY_RECORDS_PAGE_SIZES[number];

export interface ZagulyakyMyRecordsPage {
  items: ZagulyakaDraftSummary[];
  page: number;
  pageSize: ZagulyakyMyRecordsPageSize;
  /** Exact count after applying the selected workflow-status filter. */
  total: number;
  /** Exact count of every private Zagulyaka record created by the current user. */
  overallTotal: number;
  /** Counts for every workflow status across all of the current user's records. */
  statusCounts: Record<ZagulyakaWorkflowStatus, number>;
}

export interface LoadMyZagulyakyOptions {
  page?: number;
  pageSize?: number;
  status?: ZagulyakaWorkflowStatus | null;
}

export async function loadZagulyakyStats(): Promise<ZagulyakyStats> {
  const { data, error } = await getSupabaseClient().rpc("get_zagulyaky_public_stats_v1");
  if (error) throw error;
  const row = firstRecord(data);
  return {
    peopleCount: naturalNumber(value(row, "people", "peopleCount", "people_count")),
    documentCount: naturalNumber(value(row, "documents", "documentCount", "document_count")),
    placesCount: naturalNumber(value(row, "places", "placesCount", "places_count")),
    archiveCount: naturalNumber(value(row, "archives", "archiveCount", "archive_count")),
    earliestYear: nullableInteger(value(row, "yearFrom", "earliestYear", "earliest_year")),
    latestYear: nullableInteger(value(row, "yearTo", "latestYear", "latest_year")),
    verifiedCount: naturalNumber(value(row, "verified", "verifiedCount", "verified_count")),
    contributorsCount: naturalNumber(value(row, "contributors", "contributorsCount", "contributors_count")),
    addedLast30Days: naturalNumber(value(row, "addedLast30Days", "added_last_30_days")),
  };
}

export async function searchZagulyakyPeople(
  filters: ZagulyakyPeopleFilters,
  cursor: ZagulyakySearchCursor | null,
  pageSize: number,
): Promise<ZagulyakySearchResult<ZagulyakaPersonListItem>> {
  const safePageSize = clampPageSize(pageSize);
  const { data, error } = await getSupabaseClient().rpc("search_zagulyaky_people_v1", {
    p_query: nullableText(filters.query),
    p_filters: compactObject({
      sourceLocation: filters.originPlace,
      foundLocation: filters.foundPlace,
      eventType: filters.eventType,
      yearFrom: filters.yearFrom,
      yearTo: filters.yearTo,
      verificationStatus: filters.verificationStatus,
    }),
    p_limit: safePageSize,
    p_cursor_published_at: cursor?.publishedAt ?? null,
    p_cursor_id: cursor?.id ?? null,
  });
  if (error) throw error;
  const payload = searchPayload(data);
  return { items: payload.items.map(mapPersonListItem), nextCursor: payload.nextCursor, pageSize: safePageSize };
}

export async function searchZagulyakyDocuments(
  filters: ZagulyakyDocumentFilters,
  cursor: ZagulyakySearchCursor | null,
  pageSize: number,
): Promise<ZagulyakySearchResult<ZagulyakaDocumentListItem>> {
  const safePageSize = clampPageSize(pageSize);
  const { data, error } = await getSupabaseClient().rpc("search_zagulyaky_documents_v1", {
    p_query: nullableText([filters.query, filters.documentType].filter(Boolean).join(" ")),
    p_filters: compactObject({
      archiveName: filters.institutionName,
      sourceLocation: filters.officialPlace,
      foundLocation: filters.foundPlace,
      yearFrom: filters.yearFrom,
      yearTo: filters.yearTo,
      verificationStatus: filters.verificationStatus,
    }),
    p_limit: safePageSize,
    p_cursor_published_at: cursor?.publishedAt ?? null,
    p_cursor_id: cursor?.id ?? null,
  });
  if (error) throw error;
  const payload = searchPayload(data);
  return { items: payload.items.map(mapDocumentListItem), nextCursor: payload.nextCursor, pageSize: safePageSize };
}

export async function loadPublicZagulyaka(slug: string): Promise<ZagulyakaDetail | null> {
  const { data, error } = await getSupabaseClient().rpc("get_public_zagulyaka_v1", { p_slug: slug.trim() });
  if (error) throw error;
  const row = firstRecord(data);
  if (!Object.keys(row).length) return null;
  const detail = mapDetail(row);
  return {
    ...detail,
    publicMedia: await hydratePublicMedia(detail.publicMedia),
  };
}

export async function loadMyZagulyaky(
  expectedUserId?: string,
  options: LoadMyZagulyakyOptions = {},
): Promise<ZagulyakyMyRecordsPage> {
  const requestedPage = Math.trunc(options.page ?? 1);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const pageSize = myRecordsPageSize(options.pageSize);
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("get_my_zagulyaky_page_v1", {
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
        p_status: options.status ?? null,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  const payload = firstRecord(data);
  const items: ZagulyakaDraftSummary[] = records(value(payload, "items", "records")).map((row) => ({
    id: text(value(row, "id")),
    kind: text(value(row, "kind")) === "document" ? "document" : "person",
    title: text(value(row, "title"), "Без назви"),
    status: workflowStatus(value(row, "status")),
    rejectionReason: text(value(row, "moderation_note", "rejectionReason", "rejection_reason")),
    createdAt: text(value(row, "created_at", "createdAt")),
    updatedAt: text(value(row, "updated_at", "updatedAt")),
    submittedAt: nullableString(value(row, "submitted_at", "submittedAt")),
    publishedSlug: nullableString(value(row, "public_slug", "publishedSlug", "published_slug", "slug")),
    lockVersion: naturalNumber(value(row, "lock_version", "lockVersion")),
  }));
  for (const item of items) markZagulyakaRecordFresh("author", item.id);
  const total = naturalNumber(value(payload, "total"), items.length);
  return {
    items,
    page,
    pageSize: myRecordsPageSize(value(payload, "limit", "pageSize", "page_size")),
    total,
    overallTotal: Math.max(total, naturalNumber(value(payload, "overallTotal", "overall_total"), total)),
    statusCounts: workflowStatusCounts(value(payload, "statusCounts", "status_counts")),
  };
}

/**
 * Loads the current author's private shortcuts for the place where records
 * were found.  These are not linked to records: applying one copies a
 * snapshot into the open draft.
 */
export async function loadMyZagulyakySavedPlaces(
  expectedUserId?: string,
): Promise<ZagulyakaSavedPlace[]> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("list_my_zagulyaky_saved_places_v1", {
        p_query: null,
        p_limit: 100,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return records(data).map(mapSavedPlace);
}

export async function saveMyZagulyakySavedPlace(
  input: Pick<ZagulyakaSavedPlace, "name" | "geo"> & { id?: string },
  expectedUserId?: string,
): Promise<ZagulyakaSavedPlace> {
  const geo = mapPointPayload(input.geo);
  if (!input.name.trim() || !geo) {
    throw new Error("Щоб зберегти місце, вкажіть його назву та підтверджену точку на карті.");
  }
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("upsert_my_zagulyaky_saved_place_v1", {
        p_place: compactObject({ id: input.id?.trim(), name: input.name.trim(), geo }),
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return mapSavedPlace(firstRecord(data));
}

export async function deleteMyZagulyakySavedPlace(
  savedPlaceId: string,
  expectedUserId?: string,
): Promise<boolean> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("delete_my_zagulyaky_saved_place_v1", {
        p_place_id: savedPlaceId,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return Boolean(value(firstRecord(data), "deleted"));
}

/** Private reusable archive/file/source shortcuts for the current author. */
export async function loadMyZagulyakySavedSourcePresets(
  expectedUserId?: string,
): Promise<ZagulyakaSavedSourcePreset[]> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("list_my_zagulyaky_saved_source_presets_v1", {
        p_query: null,
        p_limit: 100,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return records(data).map(mapSavedSourcePreset);
}

export async function saveMyZagulyakySavedSourcePreset(
  input: ZagulyakaSavedSourcePresetInput & { id?: string },
  expectedUserId?: string,
): Promise<ZagulyakaSavedSourcePreset> {
  const hasSource = [
    input.institutionName,
    input.archiveReference,
    input.sourceTitle,
    input.sourceUrl,
  ].some((item) => item.trim());
  if (!hasSource) {
    throw new Error("Заповніть хоча б один реквізит справи або джерела перед збереженням.");
  }
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("upsert_my_zagulyaky_saved_source_preset_v1", {
        p_source: compactObject({
          id: input.id?.trim(),
          institutionName: input.institutionName.trim(),
          archiveReference: input.archiveReference.trim(),
          sourceTitle: input.sourceTitle.trim(),
          sourceUrl: input.sourceUrl.trim(),
        }),
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return mapSavedSourcePreset(firstRecord(data));
}

export async function deleteMyZagulyakySavedSourcePreset(
  savedSourceId: string,
  expectedUserId?: string,
): Promise<boolean> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("delete_my_zagulyaky_saved_source_preset_v1", {
        p_source_id: savedSourceId,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return Boolean(value(firstRecord(data), "deleted"));
}

export async function loadMyZagulyakaDraft(
  recordId: string,
  expectedUserId?: string,
): Promise<ZagulyakaEditableDraft> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("get_my_zagulyaka_draft_v1", {
        p_record_id: recordId,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  const draft = mapEditableDraft(firstRecord(data));
  markZagulyakaRecordFresh("author", recordId);
  return draft;
}

export async function createZagulyakaDraft(
  input: ZagulyakaDraftInput,
  expectedUserId?: string,
  rightsConfirmed = false,
): Promise<ZagulyakaDraftHandle> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("create_zagulyaka_draft_v1", {
        p_kind: input.kind,
        p_record: recordPatch(input, rightsConfirmed),
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return replaceDraftDetails(draftHandle(data), input, expectedUserId);
}

export async function saveZagulyakaDraft(
  handle: ZagulyakaDraftHandle,
  input: ZagulyakaDraftInput,
  expectedUserId?: string,
  rightsConfirmed = false,
): Promise<ZagulyakaDraftHandle> {
  return runZagulyakaVersionedMutation({
    scope: "author",
    recordIds: [handle.id],
    action: "save_draft",
  }, async () => {
    const client = getSupabaseClient();
    const { data, error } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.rpc("update_my_zagulyaka_draft_v1", {
          p_record_id: handle.id,
          p_expected_lock_version: handle.lockVersion,
          p_patch: recordPatch(input, rightsConfirmed),
        });
        return { data: result.data, error: result.error };
      },
      expectedUserId,
    );
    if (error) throw error;
    return replaceDraftDetails(draftHandle(data), input, expectedUserId);
  });
}

export async function submitZagulyakaDraft(
  handle: ZagulyakaDraftHandle,
  expectedUserId?: string,
): Promise<void> {
  return runZagulyakaVersionedMutation({
    scope: "author",
    recordIds: [handle.id],
    action: "submit_draft",
  }, async () => {
    const client = getSupabaseClient();
    const { error } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.rpc("submit_zagulyaka_v1", {
          p_record_id: handle.id,
          p_expected_lock_version: handle.lockVersion,
        });
        return { data: result.data, error: result.error };
      },
      expectedUserId,
    );
    if (error) throw error;
  });
}

export async function withdrawZagulyakaDraft(
  handle: ZagulyakaDraftHandle,
  expectedUserId?: string,
): Promise<ZagulyakaDraftHandle> {
  return runZagulyakaVersionedMutation({
    scope: "author",
    recordIds: [handle.id],
    action: "withdraw_draft",
  }, async () => {
    const client = getSupabaseClient();
    const { data, error } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.rpc("withdraw_zagulyaka_v1", {
          p_record_id: handle.id,
          p_expected_lock_version: handle.lockVersion,
        });
        return { data: result.data, error: result.error };
      },
      expectedUserId,
    );
    if (error) throw error;
    return draftHandle(data);
  });
}

export async function deleteMyZagulyakaDraft(
  handle: ZagulyakaDraftHandle,
  expectedUserId?: string,
): Promise<{ storageCleanupWakeSucceeded: boolean }> {
  return runZagulyakaVersionedMutation({
    scope: "author",
    recordIds: [handle.id],
    action: "delete_draft",
  }, async () => {
    const client = getSupabaseClient();
    const { data, error } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.rpc("delete_my_zagulyaka_draft_v3", {
          p_record_id: handle.id,
          p_expected_lock_version: handle.lockVersion,
        });
        return { data: result.data, error: result.error };
      },
      expectedUserId,
    );
    if (error) throw error;
    const storageCleanup = record(value(firstRecord(data), "storageCleanup", "storage_cleanup"));
    const queuedTaskCount = naturalNumber(value(storageCleanup, "queuedTaskCount", "queued_task_count"));
    // The database transaction has already committed a durable outbox task
    // before this best-effort wake-up. A temporary Edge/Storage outage must not
    // turn a successful deletion back into a client-visible failure.
    return {
      storageCleanupWakeSucceeded: queuedTaskCount === 0 || await wakeMyZagulyakyStorageCleanup(),
    };
  });
}

export async function uploadZagulyakaDraftAttachment(
  handle: ZagulyakaDraftHandle,
  file: File,
  expectedUserId: string,
): Promise<{ handle: ZagulyakaDraftHandle; attachment: ZagulyakaDraftAttachment }> {
  return runZagulyakaVersionedMutation({
    scope: "author",
    recordIds: [handle.id],
    action: "attach_file",
  }, async () => {
    validateAttachmentFile(file);
    const client = getSupabaseClient();
    const userId = expectedUserId.trim();
    if (!userId) throw new Error("Потрібна активна сесія для завантаження вкладення.");
    const storagePath = `${userId}/${handle.id}/${safeUploadId()}`;
    const sha256 = await sha256Hex(file);
    const { error: uploadError } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.storage.from("zagulyaky-private").upload(storagePath, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        });
        return { data: result.data, error: result.error };
      },
      userId,
    );
    if (uploadError) throw uploadError;

    const { data, error } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.rpc("attach_my_zagulyaka_file_v1", {
          p_record_id: handle.id,
          p_expected_lock_version: handle.lockVersion,
          p_storage_path: storagePath,
          p_file_name: file.name,
          p_mime_type: file.type,
          p_byte_size: file.size,
          p_sha256: sha256,
        });
        return { data: result.data, error: result.error };
      },
      userId,
    );
    if (error) {
      await client.storage.from("zagulyaky-private").remove([storagePath]).catch(() => undefined);
      throw error;
    }
    const payload = firstRecord(data);
    return {
      handle: {
        id: text(value(payload, "recordId", "record_id"), handle.id),
        lockVersion: naturalNumber(value(payload, "lockVersion", "lock_version"), handle.lockVersion),
      },
      attachment: mapDraftAttachment(record(value(payload, "attachment"))),
    };
  });
}

export async function deleteZagulyakaDraftAttachment(
  handle: ZagulyakaDraftHandle,
  attachmentId: string,
  expectedUserId?: string,
): Promise<ZagulyakaDraftHandle & { storageCleanupWakeSucceeded: boolean }> {
  return runZagulyakaVersionedMutation({
    scope: "author",
    recordIds: [handle.id],
    action: "delete_attachment",
  }, async () => {
    const client = getSupabaseClient();
    const { data, error } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.rpc("delete_my_zagulyaka_attachment_v2", {
          p_record_id: handle.id,
          p_attachment_id: attachmentId,
          p_expected_lock_version: handle.lockVersion,
        });
        return { data: result.data, error: result.error };
      },
      expectedUserId,
    );
    if (error) throw error;
    const payload = firstRecord(data);
    const storageCleanup = record(value(payload, "storageCleanup", "storage_cleanup"));
    const cleanupTaskId = text(value(storageCleanup, "taskId", "task_id"));
    return {
      id: text(value(payload, "recordId", "record_id"), handle.id),
      lockVersion: naturalNumber(value(payload, "lockVersion", "lock_version"), handle.lockVersion),
      storageCleanupWakeSucceeded: !cleanupTaskId || await wakeMyZagulyakyStorageCleanup(),
    };
  });
}

async function wakeMyZagulyakyStorageCleanup(): Promise<boolean> {
  try {
    await invokeEdgeFunction("zagulyaky-storage-cleanup", { action: "process_mine", limit: 20 }, {
      connectionErrorMessage: "Не вдалося тимчасово запустити очищення вкладень.",
    });
    return true;
  } catch {
    // The queued task is deliberately durable and is retried by the worker;
    // this request is merely the fast path for the current author.
    return false;
  }
}

export async function createZagulyakaClaim(
  recordId: string,
  claimType: "correction" | "privacy" | "copyright" | "abuse" | "source_problem" | "other",
  message: string,
  expectedUserId?: string,
): Promise<void> {
  if (!claimTypes.has(claimType)) throw new Error("Оберіть коректний тип уточнення.");
  if (message.trim().length < 10 || message.trim().length > 8_000) {
    throw new Error("Опишіть уточнення від 10 до 8 000 символів.");
  }
  const client = getSupabaseClient();
  const { error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("create_zagulyaka_claim_v1", {
        p_record_id: recordId,
        p_claim_type: claimType,
        p_message: message.trim(),
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
}

async function replaceDraftDetails(
  handle: ZagulyakaDraftHandle,
  input: ZagulyakaDraftInput,
  expectedUserId?: string,
): Promise<ZagulyakaDraftHandle> {
  return runZagulyakaVersionedMutation({
    scope: "author",
    recordIds: [handle.id],
    action: "replace_details",
  }, async () => {
    const client = getSupabaseClient();
    const { data, error } = await runAuthenticatedSupabaseRequest(
      client,
      async () => {
        const result = await client.rpc("replace_my_zagulyaka_details_v1", {
          p_record_id: handle.id,
          p_expected_lock_version: handle.lockVersion,
          p_sources: [sourcePayload(input)],
          p_participants: input.kind === "person" ? [participantPayload(input)] : [],
          p_document_discoveries: input.kind === "document" ? [documentDiscoveryPayload(input)] : [],
        });
        return { data: result.data, error: result.error };
      },
      expectedUserId,
    );
    if (error) throw error;
    return draftHandle(record(value(firstRecord(data), "record")));
  });
}

function recordPatch(input: ZagulyakaDraftInput, rightsConfirmed: boolean): Record<string, unknown> {
  return {
    title: input.title.trim(),
    summary: input.kind === "person" ? input.normalizedNameUk.trim() : input.documentType.trim(),
    originalText: input.originalText.trim(),
    normalizedText: input.normalizedTextUk.trim(),
    eventType: input.eventType || (input.kind === "document" ? "other" : null),
    eventDateText: input.eventDateText.trim(),
    eventYearFrom: input.eventYearFrom,
    eventYearTo: input.eventYearTo,
    datePrecision: input.datePrecision,
    sourceLocationText: input.kind === "person" ? input.originPlace.trim() : input.officialPlace.trim(),
    sourceLocationNormalized: input.kind === "person" ? input.originPlace.trim() : input.officialPlace.trim(),
    foundLocationText: input.foundPlace.trim(),
    foundLocationNormalized: input.foundPlace.trim(),
    classificationReason: input.reason.trim(),
    possibleLivingPerson: input.possibleLivingPerson,
    submissionTermsVersion: 1,
    rightsConfirmed,
    publicAttribution: input.publicAttribution,
    publicAttributionName: input.publicAttribution ? input.publicAttributionName.trim() : null,
    payload: {
      originalName: input.originalName.trim(), normalizedNameUk: input.normalizedNameUk.trim(),
      gender: input.gender, documentType: input.documentType.trim(), recordTypes: cleanedStrings(input.recordTypes),
      eventRoleCode: input.eventRoleCode || null,
      eventRoleCustomText: input.eventRoleCode === "other"
        ? input.eventRoleCustomText.trim() || null
        : null,
      // These transient keys are removed and canonicalised into protected
      // record columns by the database trigger.  Do not place map data into
      // the general, unbounded record payload.
      originGeo: mapPointPayload(input.originGeo),
      foundGeo: mapPointPayload(input.foundGeo),
    },
  };
}

function mapPointPayload(input: ZagulyakaDraftInput["originGeo"]): Record<string, unknown> | null {
  const point = normalizeGeo(input);
  if (!point) return null;
  return {
    displayName: point.displayName?.trim() || null,
    latitude: point.latitude,
    longitude: point.longitude,
    source: point.source,
    precision: point.precision ?? "unknown",
    provider: point.provider?.trim() || null,
    externalId: point.externalId?.trim() || null,
  };
}

function mapSavedPlace(row: Record<string, unknown>): ZagulyakaSavedPlace {
  const id = text(value(row, "id"));
  const name = text(value(row, "name"));
  const geo = normalizeGeo(value(row, "geo"));
  if (!id || !name || !geo) throw new Error("Сервер повернув некоректне збережене місце.");
  return {
    id,
    name,
    geo,
    createdAt: text(value(row, "createdAt", "created_at")),
    updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

function mapSavedSourcePreset(row: Record<string, unknown>): ZagulyakaSavedSourcePreset {
  const id = text(value(row, "id"));
  if (!id) throw new Error("Сервер повернув некоректно збережену справу.");
  return {
    id,
    institutionName: text(value(row, "institutionName", "institution_name")),
    archiveReference: text(value(row, "archiveReference", "archive_reference")),
    sourceTitle: text(value(row, "sourceTitle", "source_title")),
    sourceUrl: text(value(row, "sourceUrl", "source_url")),
    createdAt: text(value(row, "createdAt", "created_at")),
    updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

function sourcePayload(input: ZagulyakaDraftInput): Record<string, unknown> {
  return {
    sourceType: input.sourceUrl.trim() ? "website" : "archive",
    title: input.sourceTitle.trim() || input.institutionName.trim() || input.archiveReference.trim() || "Джерело",
    archiveName: input.institutionName.trim() || null,
    citation: input.archiveReference.trim(), sourceUrl: input.sourceUrl.trim() || null,
    pageFrom: input.kind === "person" ? input.pageLabel.trim() || null : input.pageRange.trim() || null,
    permissionStatus: input.sourceUrl.trim() ? "link_only" : "unknown",
  };
}

function participantPayload(input: ZagulyakaDraftInput): Record<string, unknown> {
  return {
    role: "subject", originalFullName: input.originalName.trim(), normalizedUkFullName: input.normalizedNameUk.trim(),
    sex: input.gender, originText: input.originPlace.trim(), residenceText: input.foundPlace.trim(),
    eventRoleCode: input.eventRoleCode || null,
    eventRoleCustom: input.eventRoleCode === "other"
      ? input.eventRoleCustomText.trim() || null
      : null,
  };
}

function documentDiscoveryPayload(input: ZagulyakaDraftInput): Record<string, unknown> {
  return {
    officialLocationText: input.officialPlace.trim(), discoveredLocationText: input.foundPlace.trim(),
    recordTypes: cleanedStrings(input.recordTypes), factualYearFrom: input.eventYearFrom,
    factualYearTo: input.eventYearTo, pageFrom: input.pageRange.trim() || null, notes: input.documentType.trim(),
  };
}

function mapPersonListItem(row: Record<string, unknown>): ZagulyakaPersonListItem {
  const subject = record(value(row, "subject"));
  const primarySource = record(value(row, "primarySource", "primary_source"));
  const originalName = text(value(subject, "originalFullName", "original_full_name"));
  const normalizedNameUk = text(value(subject, "normalizedUkFullName", "normalized_uk_full_name"));
  const displayName = normalizedNameUk || originalName || text(value(row, "title"), "Без імені");
  const rowEventType = eventType(value(row, "eventType", "event_type"));
  return {
    id: text(value(row, "id")), slug: text(value(row, "slug")), displayName,
    originalName, normalizedNameUk, gender: genderValue(value(subject, "sex")),
    birthYear: rowEventType === "birth" || rowEventType === "baptism"
      ? nullableInteger(value(row, "eventYearFrom", "event_year_from"))
      : null,
    originPlace: text(value(row, "sourceLocation", "source_location")),
    foundPlace: text(value(row, "foundLocation", "found_location")),
    eventType: rowEventType,
    eventDateLabel: text(value(row, "eventDateText", "event_date_text")),
    eventYear: nullableInteger(value(row, "eventYearFrom", "event_year_from")),
    sourceCitation: text(value(primarySource, "citation"), text(value(primarySource, "title"))),
    pageLabel: pageRange(primarySource),
    verificationStatus: verificationStatus(value(row, "verificationStatus", "verification_status")),
    confirmationsCount: naturalNumber(value(row, "confirmationCount", "confirmationsCount", "confirmations_count")),
    publishedAt: text(value(row, "publishedAt", "published_at")),
  };
}

function mapDocumentListItem(row: Record<string, unknown>): ZagulyakaDocumentListItem {
  const primarySource = record(value(row, "primarySource", "primary_source"));
  const discovery = record(value(row, "documentDiscovery", "document_discovery"));
  return {
    id: text(value(row, "id")), slug: text(value(row, "slug")), title: text(value(row, "title"), "Без назви"),
    documentType: text(value(row, "summary")),
    institutionName: text(value(primarySource, "archiveName", "archive_name")),
    officialPlace: text(value(discovery, "officialLocationText", "official_location_text"), text(value(row, "sourceLocation", "source_location"))),
    foundPlaces: [text(value(discovery, "discoveredLocationText", "discovered_location_text"), text(value(row, "foundLocation", "found_location")))].filter(Boolean),
    actualYearFrom: nullableInteger(value(discovery, "factualYearFrom", "factual_year_from") ?? value(row, "eventYearFrom", "event_year_from")),
    actualYearTo: nullableInteger(value(discovery, "factualYearTo", "factual_year_to") ?? value(row, "eventYearTo", "event_year_to")),
    archiveReference: text(value(primarySource, "citation")),
    pageRange: pageRange(discovery) || pageRange(primarySource),
    recordTypes: stringArray(value(discovery, "recordTypes", "record_types")),
    verificationStatus: verificationStatus(value(row, "verificationStatus", "verification_status")),
    confirmationsCount: naturalNumber(value(row, "confirmationCount", "confirmationsCount", "confirmations_count")),
    publishedAt: text(value(row, "publishedAt", "published_at")),
  };
}

function mapDetail(row: Record<string, unknown>): ZagulyakaDetail {
  const participants = records(value(row, "participants"));
  const subject = participants.find((item) => text(value(item, "role")) === "subject") ?? participants[0] ?? {};
  const sources = records(value(row, "sources"));
  const primarySource = sources.find((item) => Boolean(value(item, "isPrimary", "is_primary"))) ?? sources[0] ?? {};
  const discoveries = records(value(row, "documentDiscoveries", "document_discoveries"));
  const discovery = discoveries[0] ?? {};
  const attachments = records(value(row, "publicAttachments", "public_attachments"));
  return {
    id: text(value(row, "id")), slug: text(value(row, "slug")),
    kind: text(value(row, "kind")) === "document" ? "document" : "person",
    title: text(value(row, "title"), "Без назви"), summary: text(value(row, "summary")),
    originalText: text(value(row, "originalText", "original_text")),
    normalizedTextUk: text(value(row, "normalizedText", "normalized_text")),
    originalName: text(value(subject, "originalFullName", "original_full_name")),
    normalizedNameUk: text(value(subject, "normalizedUkFullName", "normalized_uk_full_name")),
    gender: genderValue(value(subject, "sex")),
    eventType: nullableEventType(value(row, "eventType", "event_type")),
    eventDateLabel: text(value(row, "eventDateText", "event_date_text")),
    eventYearFrom: nullableInteger(value(row, "eventYearFrom", "event_year_from")),
    eventYearTo: nullableInteger(value(row, "eventYearTo", "event_year_to")),
    datePrecision: datePrecision(value(row, "datePrecision", "date_precision")),
    // The source location may name a church or archive;
    // for a person, the participant's origin wording is the better label for
    // a deliberately confirmed origin pin.
    originPlace: text(
      value(subject, "originText", "origin_text"),
      text(value(row, "sourceLocationNormalized", "sourceLocationText", "source_location_normalized", "source_location_text")),
    ),
    foundPlace: text(value(row, "foundLocationNormalized", "foundLocationText", "found_location_normalized", "found_location_text")),
    originGeo: normalizeGeo(value(row, "originGeo", "origin_geo")),
    foundGeo: normalizeGeo(value(row, "foundGeo", "found_geo")),
    officialPlace: text(value(discovery, "officialLocationText", "official_location_text")),
    documentType: text(value(discovery, "notes"), text(value(row, "summary"))),
    pageRange: [text(value(discovery, "pageFrom", "page_from")), text(value(discovery, "pageTo", "page_to"))].filter(Boolean).join("–"),
    recordTypes: stringArray(value(discovery, "recordTypes", "record_types")),
    reason: text(value(row, "classificationReason", "classification_reason")),
    verificationStatus: verificationStatus(value(row, "verificationStatus", "verification_status")),
    confirmationsCount: naturalNumber(value(row, "confirmationCount", "confirmation_count")),
    contributor: nullableString(value(row, "contributor")),
    // The public RPC is the only source for this deliberately named field.
    // Do not fall back to private source-link metadata or generic source URLs.
    originalPostUrl: text(value(row, "originalPostUrl", "original_post_url")),
    source: Object.keys(primarySource).length ? {
      id: text(value(primarySource, "id")), institutionName: text(value(primarySource, "archiveName", "archive_name")),
      archiveReference: text(value(primarySource, "citation")), sourceTitle: text(value(primarySource, "title")),
      sourceUrl: text(value(primarySource, "sourceUrl", "source_url")),
      pageLabel: [text(value(primarySource, "pageFrom", "page_from")), text(value(primarySource, "pageTo", "page_to"))].filter(Boolean).join("–"),
      accessRequiresLogin: false,
    } : null,
    participants: participants.map((participant, index) => ({
      id: text(value(participant, "id"), `${index}`), role: text(value(participant, "role")),
      eventRoleCode: normalizeZagulyakaEventRoleCode(
        text(value(participant, "eventRoleCode", "event_role_code")),
      ),
      eventRoleCustomText: text(value(participant, "eventRoleCustom", "eventRoleCustomText", "event_role_custom")),
      originalName: text(value(participant, "originalFullName", "original_full_name")),
      normalizedNameUk: text(value(participant, "normalizedUkFullName", "normalized_uk_full_name")), note: text(value(participant, "notes")),
    })),
    publicMedia: attachments.map((media) => {
      const name = text(value(media, "fileName", "file_name"), "Файл");
      return { id: text(value(media, "id")), name, mimeType: text(value(media, "mimeType", "mime_type")), url: "", alt: name };
    }).filter((media) => Boolean(media.id)),
    publishedAt: text(value(row, "publishedAt", "published_at")), updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

async function hydratePublicMedia(media: ZagulyakaDetail["publicMedia"]): Promise<ZagulyakaDetail["publicMedia"]> {
  const client = getSupabaseClient();
  const delivered = await Promise.all(media.map(async (item) => {
    try {
      const { data, error } = await client.functions.invoke("zagulyaka-attachment", {
        body: { action: "delivery", attachmentId: item.id },
      });
      const url = !error ? text(value(record(data), "url")) : "";
      // The public record already says this attachment was approved. Do not
      // silently hide it when a short-lived delivery URL cannot be issued;
      // the detail view can then explain that the file is temporarily down.
      return url ? { ...item, url } : { ...item, deliveryUnavailable: true };
    } catch {
      return { ...item, deliveryUnavailable: true };
    }
  }));
  return delivered;
}

function mapEditableDraft(payload: Record<string, unknown>): ZagulyakaEditableDraft {
  const row = record(value(payload, "record"));
  const recordPayload = record(value(row, "payload"));
  const sources = records(value(payload, "sources"));
  const primarySource = sources.find((item) => Boolean(value(item, "isPrimary", "is_primary"))) ?? sources[0] ?? {};
  const participants = records(value(payload, "participants"));
  const subject = participants.find((item) => text(value(item, "role")) === "subject") ?? participants[0] ?? {};
  const discoveries = records(value(payload, "documentDiscoveries", "document_discoveries"));
  const attachments = records(value(payload, "attachments"));
  const discovery = discoveries[0] ?? {};
  const id = text(value(row, "id"));
  if (!id) throw new Error("Сервер не повернув чернетку загуляки.");
  const kind: ZagulyakaDraftInput["kind"] = text(value(row, "kind")) === "document" ? "document" : "person";
  const sourcePage = [
    text(value(primarySource, "pageFrom", "page_from")),
    text(value(primarySource, "pageTo", "page_to")),
  ].filter(Boolean).join("–");
  const discoveryPage = [
    text(value(discovery, "pageFrom", "page_from")),
    text(value(discovery, "pageTo", "page_to")),
  ].filter(Boolean).join("–");
  const editableEventType = nullableEventType(value(row, "eventType", "event_type"));
  const eventRoleCode = normalizeZagulyakaEventRoleCode(
    text(
      value(subject, "eventRoleCode", "event_role_code"),
      text(value(recordPayload, "eventRoleCode", "event_role_code")),
    ),
  );
  const eventRoleCustomText = text(
    value(subject, "eventRoleCustom", "eventRoleCustomText", "event_role_custom")
      ?? value(recordPayload, "eventRoleCustomText", "eventRoleCustom", "event_role_custom"),
  );

  return {
    handle: {
      id,
      lockVersion: naturalNumber(value(row, "lockVersion", "lock_version")),
    },
    rightsConfirmed: Boolean(value(row, "rightsConfirmedAt", "rights_confirmed_at")),
    attachments: attachments.map(mapDraftAttachment),
    input: {
      kind,
      title: text(value(row, "title")),
      originalName: text(value(recordPayload, "originalName"), text(value(subject, "originalFullName", "original_full_name"))),
      normalizedNameUk: text(value(recordPayload, "normalizedNameUk"), text(value(subject, "normalizedUkFullName", "normalized_uk_full_name"))),
      gender: genderValue(value(recordPayload, "gender", "sex") ?? value(subject, "sex")),
      eventType: editableEventType ?? "",
      eventRoleCode,
      eventRoleCustomText,
      eventDateText: text(value(row, "eventDateText", "event_date_text")),
      eventYearFrom: nullableInteger(value(row, "eventYearFrom", "event_year_from")),
      eventYearTo: nullableInteger(value(row, "eventYearTo", "event_year_to")),
      datePrecision: datePrecision(value(row, "datePrecision", "date_precision")),
      originPlace: text(
        value(subject, "originText", "origin_text"),
        text(value(row, "sourceLocationNormalized", "sourceLocationText", "source_location_normalized", "source_location_text")),
      ),
      foundPlace: text(value(row, "foundLocationNormalized", "foundLocationText", "found_location_normalized", "found_location_text"), text(value(discovery, "discoveredLocationText", "discovered_location_text"))),
      originGeo: normalizeGeo(value(row, "originGeo", "origin_geo")),
      foundGeo: normalizeGeo(value(row, "foundGeo", "found_geo")),
      officialPlace: text(value(discovery, "officialLocationText", "official_location_text")),
      documentType: text(value(recordPayload, "documentType"), text(value(discovery, "notes"), text(value(row, "summary")))),
      institutionName: text(value(primarySource, "archiveName", "archive_name")),
      archiveReference: text(value(primarySource, "citation")),
      pageLabel: kind === "person" ? sourcePage : "",
      pageRange: kind === "document" ? discoveryPage || sourcePage : "",
      sourceTitle: text(value(primarySource, "title")),
      sourceUrl: text(value(primarySource, "sourceUrl", "source_url")),
      originalText: text(value(row, "originalText", "original_text")),
      normalizedTextUk: text(value(row, "normalizedText", "normalized_text")),
      reason: text(value(row, "classificationReason", "classification_reason")),
      recordTypes: stringArray(value(recordPayload, "recordTypes", "record_types")).length
        ? stringArray(value(recordPayload, "recordTypes", "record_types"))
        : stringArray(value(discovery, "recordTypes", "record_types")),
      possibleLivingPerson: value(row, "possibleLivingPerson", "possible_living_person") === true,
      publicAttribution: value(row, "publicAttribution", "public_attribution") === true,
      publicAttributionName: text(value(row, "publicAttributionName", "public_attribution_name")),
    },
  };
}

function mapDraftAttachment(row: Record<string, unknown>): ZagulyakaDraftAttachment {
  return {
    id: text(value(row, "id")),
    storageBucket: text(value(row, "storageBucket", "storage_bucket")),
    storagePath: text(value(row, "storagePath", "storage_path")),
    fileName: text(value(row, "fileName", "file_name"), "Файл"),
    mimeType: text(value(row, "mimeType", "mime_type")),
    byteSize: naturalNumber(value(row, "byteSize", "byte_size")),
    isPublicDerivative: value(row, "isPublicDerivative", "is_public_derivative") === true,
  };
}

function searchPayload(data: unknown): { items: Record<string, unknown>[]; nextCursor: ZagulyakySearchCursor | null } {
  const payload = firstRecord(data);
  const cursor = record(value(payload, "nextCursor", "next_cursor"));
  const publishedAt = text(value(cursor, "publishedAt", "published_at"));
  const id = text(value(cursor, "id"));
  return { items: records(value(payload, "items", "records")), nextCursor: publishedAt && id ? { publishedAt, id } : null };
}

function draftHandle(data: unknown): ZagulyakaDraftHandle {
  const row = firstRecord(data);
  const id = text(value(row, "id"));
  if (!id) throw new Error("Сервер не повернув ідентифікатор чернетки.");
  return { id, lockVersion: naturalNumber(value(row, "lock_version", "lockVersion")) };
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== null && item !== undefined && item !== "")); }
function cleanedStrings(input: string[]): string[] { return input.map((item) => item.trim()).filter(Boolean); }
function pageRange(row: Record<string, unknown>): string {
  const from = text(value(row, "pageFrom", "page_from"));
  const to = text(value(row, "pageTo", "page_to"));
  return from && to && from !== to ? `${from}–${to}` : from || to;
}
function firstRecord(input: unknown): Record<string, unknown> { return Array.isArray(input) ? record(input[0]) : record(input); }
function records(input: unknown): Record<string, unknown>[] { return Array.isArray(input) ? input.map(record).filter((item) => Object.keys(item).length > 0) : []; }
function record(input: unknown): Record<string, unknown> { return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}; }
function value(row: Record<string, unknown>, ...keys: string[]): unknown { for (const key of keys) if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]; return undefined; }
function text(input: unknown, fallback = ""): string { const result = typeof input === "string" ? input.trim() : String(input ?? "").trim(); return result || fallback; }
function nullableText(input: unknown): string | null { return text(input) || null; }
function nullableString(input: unknown): string | null { return text(input) || null; }
function naturalNumber(input: unknown, fallback = 0): number { const result = Number(input); return Number.isFinite(result) && result >= 0 ? Math.trunc(result) : fallback; }
function nullableInteger(input: unknown): number | null { if (input === null || input === undefined || input === "") return null; const result = Number(input); return Number.isFinite(result) ? Math.trunc(result) : null; }
function stringArray(input: unknown): string[] { return Array.isArray(input) ? input.map((item) => text(item)).filter(Boolean) : []; }
function clampPageSize(input: number): number { return Math.max(10, Math.min(50, Math.trunc(input) || 20)); }
function myRecordsPageSize(input: unknown): ZagulyakyMyRecordsPageSize {
  const pageSize = Number(input);
  return ZAGULYAKY_MY_RECORDS_PAGE_SIZES.includes(pageSize as ZagulyakyMyRecordsPageSize)
    ? pageSize as ZagulyakyMyRecordsPageSize
    : ZAGULYAKY_MY_RECORDS_PAGE_SIZE;
}
function workflowStatusCounts(input: unknown): Record<ZagulyakaWorkflowStatus, number> {
  const row = record(input);
  return Object.fromEntries(
    zagulyakaWorkflowStatuses.map((status) => [status, naturalNumber(value(row, status))]),
  ) as Record<ZagulyakaWorkflowStatus, number>;
}
function eventType(input: unknown): ZagulyakaEventType { const result = text(input) as ZagulyakaEventType; return eventTypes.has(result) ? result : "other"; }
function nullableEventType(input: unknown): ZagulyakaEventType | null { const result = text(input) as ZagulyakaEventType; return eventTypes.has(result) ? result : null; }
function verificationStatus(input: unknown): ZagulyakaVerificationStatus { const result = text(input) as ZagulyakaVerificationStatus; return verificationStatuses.has(result) ? result : "unverified"; }
function genderValue(input: unknown): "male" | "female" | "unknown" { const result = text(input); return result === "male" || result === "female" ? result : "unknown"; }
function datePrecision(input: unknown): ZagulyakaDetail["datePrecision"] { const result = text(input); return ["exact", "month", "year", "range", "approximate", "before", "after"].includes(result) ? result as ZagulyakaDetail["datePrecision"] : "unknown"; }
function workflowStatus(input: unknown): ZagulyakaDraftSummary["status"] { const result = text(input); return ["draft", "pending_review", "needs_changes", "published", "rejected", "withdrawn", "merged", "archived"].includes(result) ? result as ZagulyakaDraftSummary["status"] : "draft"; }

function validateAttachmentFile(file: File): void {
  if (!file || !file.name) throw new Error("Оберіть файл вкладення.");
  if (file.size < 1 || file.size > 26_214_400) throw new Error("Вкладення має бути не більшим за 25 МБ.");
  if (!new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]).has(file.type)) {
    throw new Error("Можна додати лише JPG, PNG, WebP або PDF.");
  }
}

async function sha256Hex(file: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Браузер не підтримує перевірку цілісності вкладення.");
  const bytes = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
}

function safeUploadId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
