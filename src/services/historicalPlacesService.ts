import type {
  CreatePlaceNameInput,
  CreateProjectPlaceInput,
  HistoricalPlaceProfile,
  HistoricalPlaceProfileCounts,
  HistoricalPlaceRelated,
  HistoricalPlaceParish,
  HistoricalPlaceArchive,
  HistoricalArchiveResource,
  HistoricalPlaceDocument,
  HistoricalPlaceDocumentOption,
  HistoricalPlaceExternalIdentifier,
  HistoricalPlacePerson,
  HistoricalPlaceEvent,
  HistoricalPlaceMergePreview,
  HistoricalPlaceMergeAdminContext,
  HistoricalPlaceMergeSnapshot,
  HistoricalPlaceMergeSnapshotCounts,
  HistoricalPlaceMergeResult,
  MergeHistoricalPlacesInput,
  PlaceHierarchyCandidate,
  PlaceHierarchyHistoryEntry,
  PlaceHierarchyNode,
  PlaceHierarchyResolution,
  PlaceName,
  PlaceNameDatePrecision,
  PlaceNameType,
  PlaceScope,
  PlaceSearchInput,
  PlaceStatus,
  PlaceSummary,
  PlaceVerificationStatus,
  PersonEventPlaceLinkResult,
  SetPersonEventPlaceInput,
  ClearPersonEventPlaceInput,
  ResolvePlaceHierarchyInput,
  PatchHistoricalPlaceInput,
  AddHistoricalPlaceNameInput,
  UpdateHistoricalPlaceNameInput,
  HistoricalPlaceRelationInput,
  CreateHistoricalArchiveInput,
  AddDocumentPlaceLinkInput,
  HistoricalPlaceAuditEntry,
  HistoricalPlaceBoundary,
  AddHistoricalPlaceBoundaryInput,
  HistoricalPlaceTemporalContext,
  HistoricalPlaceMapContext,
} from "../types/historicalPlaces";
import { getSupabaseClient } from "./supabaseAuth";

export const HISTORICAL_PLACE_SEARCH_DEFAULT_LIMIT = 20;
export const HISTORICAL_PLACE_SEARCH_MAX_LIMIT = 50;
export const HISTORICAL_PLACE_CREATE_MAX_NAMES = 50;
export const HISTORICAL_PLACE_HIERARCHY_DEFAULT_MAX_DEPTH = 12;
export const HISTORICAL_PLACE_HIERARCHY_MAX_DEPTH = 32;
export const HISTORICAL_PLACE_DOCUMENT_OPTIONS_MAX_LIMIT = 500;

type HistoricalPlacesOperation =
  | "search"
  | "create"
  | "resolve"
  | "profile"
  | "names"
  | "history"
  | "boundaries"
  | "event-link"
  | "related"
  | "parishes"
  | "archives"
  | "documents"
  | "people"
  | "events"
  | "map"
  | "merge-preview"
  | "merge"
  | "write"
  | "legacy-import"
  | "audit";

export interface HistoricalPlaceLegacyImportSummary {
  candidateNames: number;
  candidateEvents: number;
  existingPlaces: number;
  placesToCreate: number;
  ambiguousNames: number;
  invalidNames: number;
  createdPlaces: number;
  linkedEvents: number;
  remainingNames: number;
  hasMore: boolean;
  applied: boolean;
}

const placeScopes = new Set<PlaceScope>(["global", "project"]);
const placeStatuses = new Set<PlaceStatus>([
  "active",
  "needs_review",
  "merged",
  "archived",
]);
const verificationStatuses = new Set<PlaceVerificationStatus>([
  "unverified",
  "plausible",
  "verified",
  "disputed",
]);
const placeNameTypes = new Set<PlaceNameType>([
  "canonical",
  "modern",
  "historical",
  "official",
  "unofficial",
  "local",
  "pre_reform",
  "soviet",
  "source_error",
  "variant",
  "other",
]);
const datePrecisions = new Set<PlaceNameDatePrecision>([
  "day",
  "month",
  "year",
  "range",
  "circa",
  "before",
  "after",
  "unknown",
]);

/** A stable, user-readable boundary around transport and RPC errors. */
export class HistoricalPlacesServiceError extends Error {
  readonly operation: HistoricalPlacesOperation;
  readonly code: string;

  constructor(
    operation: HistoricalPlacesOperation,
    message: string,
    code = "",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HistoricalPlacesServiceError";
    this.operation = operation;
    this.code = code;
  }
}

/** Search shared catalogue places and private places visible in one project. */
export async function searchPlaces(
  input: PlaceSearchInput,
  signal?: AbortSignal,
): Promise<PlaceSummary[]> {
  throwIfAborted(signal);
  const query = text(input.query);
  const hasCoordinateFilter = input.latitude !== null && input.latitude !== undefined
    && input.longitude !== null && input.longitude !== undefined
    && input.radiusKm !== null && input.radiusKm !== undefined;
  if (!query && !input.ancestorPlaceId && !hasCoordinateFilter) return [];

  const limit = boundedInteger(
    input.limit,
    1,
    HISTORICAL_PLACE_SEARCH_MAX_LIMIT,
    HISTORICAL_PLACE_SEARCH_DEFAULT_LIMIT,
  );
  const temporal = input.temporalContext ?? null;
  const exactDate = nullableText(temporal?.exactDate) ?? nullableText(input.atDate);
  let modernRequest = getSupabaseClient().rpc("search_places_v2", {
    p_query: query,
    p_at_date: exactDate,
    p_period_from: nullableText(temporal?.periodFrom),
    p_period_to: nullableText(temporal?.periodTo),
    p_date_precision: nullableText(temporal?.precision),
    p_project_id: nullableText(input.projectId),
    p_limit: limit,
    p_ancestor_place_id: nullableText(input.ancestorPlaceId),
    p_latitude: finiteCoordinate(input.latitude, -90, 90),
    p_longitude: finiteCoordinate(input.longitude, -180, 180),
    p_radius_km: input.radiusKm === null
      || input.radiusKm === undefined
      || !Number.isFinite(Number(input.radiusKm))
      ? null
      : Math.max(0, Number(input.radiusKm)),
  });
  if (signal) modernRequest = modernRequest.abortSignal(signal);
  let { data, error } = await modernRequest;
  if (error && isMissingRpcError(error)) {
    let legacyRequest = getSupabaseClient().rpc("search_places_v1", {
      p_query: query,
      p_at_date: exactDate,
      p_project_id: nullableText(input.projectId),
      p_limit: limit,
    });
    if (signal) legacyRequest = legacyRequest.abortSignal(signal);
    ({ data, error } = await legacyRequest);
  }
  throwIfAborted(signal);
  if (error) throw rpcServiceError("search", error);

  return responseRows(data, ["items", "places", "results"])
    .map((row) => placeSummary(row))
    .filter((place): place is PlaceSummary => Boolean(place))
    .slice(0, limit);
}

/** Compatibility alias for callers that prefer an explicit domain name. */
export const searchHistoricalPlaces = searchPlaces;

/**
 * Preview or apply an additive bridge from legacy person-event place text to
 * the project-private historical-place catalogue. Source wording remains in
 * `person_timeline_events.place_name`; imported links are marked for review.
 */
export async function bridgeLegacyPersonEventPlaces(
  projectId: string,
  apply: boolean,
  signal?: AbortSignal,
): Promise<HistoricalPlaceLegacyImportSummary> {
  throwIfAborted(signal);
  const safeProjectId = requiredText(
    projectId,
    "Оберіть проєкт для перенесення текстових місць.",
    "legacy-import",
  );
  let request = getSupabaseClient().rpc("bridge_legacy_person_event_places_v1", {
    p_project_id: safeProjectId,
    p_apply: apply,
    p_limit: 50,
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("legacy-import", error);
  const row = firstResponseRecord(data, ["result"]);
  return {
    candidateNames: nonNegativeInteger(value(row, "candidateNames", "candidate_names"), 0),
    candidateEvents: nonNegativeInteger(value(row, "candidateEvents", "candidate_events"), 0),
    existingPlaces: nonNegativeInteger(value(row, "existingPlaces", "existing_places"), 0),
    placesToCreate: nonNegativeInteger(value(row, "placesToCreate", "places_to_create"), 0),
    ambiguousNames: nonNegativeInteger(value(row, "ambiguousNames", "ambiguous_names"), 0),
    invalidNames: nonNegativeInteger(value(row, "invalidNames", "invalid_names"), 0),
    createdPlaces: nonNegativeInteger(value(row, "createdPlaces", "created_places"), 0),
    linkedEvents: nonNegativeInteger(value(row, "linkedEvents", "linked_events"), 0),
    remainingNames: nonNegativeInteger(value(row, "remainingNames", "remaining_names"), 0),
    hasMore: booleanValue(value(row, "hasMore", "has_more"), false),
    applied: booleanValue(value(row, "applied"), apply),
  };
}

/** Create an unshared place owned by the selected project. */
export async function createProjectPlace(
  input: CreateProjectPlaceInput,
  signal?: AbortSignal,
): Promise<PlaceSummary> {
  throwIfAborted(signal);
  const projectId = requiredText(input.projectId, "Оберіть проєкт для нового місця.");
  const canonicalName = requiredText(
    input.canonicalName,
    "Вкажіть основну назву нового місця.",
  );
  const coordinates = createCoordinates(input.latitude, input.longitude);
  const names = input.names ?? [];
  if (names.length > HISTORICAL_PLACE_CREATE_MAX_NAMES) {
    throw new HistoricalPlacesServiceError(
      "create",
      `До одного місця можна додати не більше ${HISTORICAL_PLACE_CREATE_MAX_NAMES} варіантів назви за один раз.`,
      "INVALID_INPUT",
    );
  }
  const parentRelation = input.parentRelation ? {
    parentPlaceId: requiredText(
      input.parentRelation.parentPlaceId,
      "Оберіть адміністративну одиницю для нового місця.",
      "create",
    ),
    relationType: input.parentRelation.relationType,
    validFrom: input.parentRelation.validFrom,
    validTo: input.parentRelation.validTo,
    validFromText: input.parentRelation.validFromText,
    validToText: input.parentRelation.validToText,
    validFromPrecision: input.parentRelation.validFromPrecision,
    validToPrecision: input.parentRelation.validToPrecision,
    sourceDocumentId: input.parentRelation.sourceDocumentId,
    sourceFindingId: input.parentRelation.sourceFindingId,
    citationId: input.parentRelation.citationId,
    sourceReference: input.parentRelation.sourceReference,
    confidence: input.parentRelation.confidence,
    note: input.parentRelation.note,
    metadata: input.parentRelation.metadata,
  } : null;
  const payload = {
    canonicalName,
    modernName: text(input.modernName),
    description: text(input.description),
    languageCode: nullableText(input.languageCode),
    placeType: text(input.placeType, "settlement"),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    currentCountry: text(input.currentCountry),
    currentAdmin: text(input.currentAdmin),
    wikidataId: nullableText(input.wikidataId),
    geonamesId: nullableText(input.geonamesId),
    externalIds: externalIds(input.externalIds),
    verificationStatus: verificationStatuses.has(input.verificationStatus as PlaceVerificationStatus)
      ? input.verificationStatus
      : "unverified",
    status: placeStatuses.has(input.status as PlaceStatus)
      ? input.status
      : input.needsIdentification === true ? "needs_review" : "active",
    needsIdentification: input.needsIdentification === true,
    names: names.map((name, index) => createPlaceNamePayload(name, index)),
    ...(parentRelation ? { parentRelation } : {}),
  };

  let request = getSupabaseClient().rpc("create_project_place_v2", {
    p_project_id: projectId,
    p_input: payload,
  });
  if (signal) request = request.abortSignal(signal);
  let { data, error } = await request;
  if (error && isMissingRpcError(error)) {
    if (createProjectPlaceRequiresV2(input)) {
      throw historicalPlacesMigrationRequired("create");
    }
    const legacyPayload = {
      canonicalName: payload.canonicalName,
      modernName: payload.modernName,
      description: payload.description,
      languageCode: payload.languageCode,
      latitude: payload.latitude,
      longitude: payload.longitude,
      needsIdentification: payload.needsIdentification,
      names: payload.names,
    };
    let legacyRequest = getSupabaseClient().rpc("create_project_place_v1", {
      p_project_id: projectId,
      p_input: legacyPayload,
    });
    if (signal) legacyRequest = legacyRequest.abortSignal(signal);
    ({ data, error } = await legacyRequest);
  }
  throwIfAborted(signal);
  if (error) throw rpcServiceError("create", error);

  const envelope = firstResponseRecord(data, []);
  const response = firstResponseRecord(data, ["place", "item", "result"]);
  const created = placeSummary(response, {
    projectId,
    scope: "project",
    status: payload.status,
    verificationStatus: payload.verificationStatus,
    isPublic: false,
    publishedAt: null,
    canonicalName,
    displayName: canonicalName,
    atDate: null,
    modernName: payload.modernName,
    placeType: payload.placeType,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    currentCountry: payload.currentCountry,
    currentAdmin: payload.currentAdmin,
    wikidataId: payload.wikidataId,
    geonamesId: payload.geonamesId,
    externalIds: payload.externalIds,
    description: payload.description,
    names: [],
    lockVersion: 0,
    createdAt: "",
    updatedAt: "",
  });
  if (!created) {
    throw new HistoricalPlacesServiceError(
      "create",
      "Місце створено, але сервер повернув неповні дані. Оновіть список місць.",
      "INVALID_RESPONSE",
    );
  }
  const primaryName = placeName(
    value(envelope, "primaryName", "primary_name"),
    created.id,
    0,
  );
  return primaryName ? { ...created, names: [primaryName] } : created;
}

/** Resolve the administrative path that was in force on the requested date. */
export async function resolvePlaceHierarchy(
  input: ResolvePlaceHierarchyInput,
  signal?: AbortSignal,
): Promise<PlaceHierarchyResolution> {
  throwIfAborted(signal);
  const placeId = requiredText(
    input.placeId,
    "Оберіть місце для визначення ієрархії.",
    "resolve",
  );
  const atDate = nullableText(input.atDate);
  const temporal = input.temporalContext ?? null;
  const maxDepth = boundedInteger(
    input.maxDepth,
    1,
    HISTORICAL_PLACE_HIERARCHY_MAX_DEPTH,
    HISTORICAL_PLACE_HIERARCHY_DEFAULT_MAX_DEPTH,
  );

  let data: unknown;
  let error: unknown;
  if (temporal && (temporal.periodFrom || temporal.periodTo) && !temporal.exactDate) {
    let periodRequest = getSupabaseClient().rpc("resolve_place_hierarchy_period_v1", {
      p_place_id: placeId,
      p_period_from: nullableText(temporal.periodFrom),
      p_period_to: nullableText(temporal.periodTo),
      p_max_depth: maxDepth,
    });
    if (signal) periodRequest = periodRequest.abortSignal(signal);
    ({ data, error } = await periodRequest);
    if (error && isMissingRpcError(error)) {
      let legacyRequest = getSupabaseClient().rpc("resolve_place_hierarchy_v1", {
        p_place_id: placeId,
        p_at_date: atDate,
        p_max_depth: maxDepth,
      });
      if (signal) legacyRequest = legacyRequest.abortSignal(signal);
      ({ data, error } = await legacyRequest);
    }
  } else {
    let request = getSupabaseClient().rpc("resolve_place_hierarchy_v1", {
      p_place_id: placeId,
      p_at_date: nullableText(temporal?.exactDate) ?? atDate,
      p_max_depth: maxDepth,
    });
    if (signal) request = request.abortSignal(signal);
    ({ data, error } = await request);
  }
  throwIfAborted(signal);
  if (error) throw rpcServiceError("resolve", error);

  return hierarchyResolution(data, placeId, atDate, maxDepth);
}

/** Load the safe profile projection for one place. */
export async function getHistoricalPlaceProfile(
  placeId: string,
  atDate?: string | null,
  signal?: AbortSignal,
  temporalContext?: HistoricalPlaceTemporalContext | null,
): Promise<HistoricalPlaceProfile> {
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", "profile");
  let request = getSupabaseClient().rpc("get_place_profile_v1", {
    p_place_id: id,
    p_at_date: nullableText(atDate),
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("profile", error);

  const envelope = firstResponseRecord(data, ["profile", "result"]);
  const basePlace = placeSummary(value(envelope, "place", "item"), { id })
    ?? placeSummary(envelope, { id });
  if (!basePlace) {
    throw new HistoricalPlacesServiceError(
      "profile",
      "Сервер повернув неповний профіль історичного місця.",
      "INVALID_RESPONSE",
    );
  }
  const responseAtDate = nullableText(value(envelope, "atDate", "at_date"))
    ?? nullableText(atDate);
  const names = records(value(envelope, "names", "activeNames", "active_names"))
    .map((row, index) => placeName(row, id, index))
    .filter((name): name is PlaceName => Boolean(name));
  const hierarchyInput = value(envelope, "hierarchy", "resolution");
  let hierarchy = hierarchyInput === undefined
    ? hierarchyResolution({}, id, responseAtDate, HISTORICAL_PLACE_HIERARCHY_DEFAULT_MAX_DEPTH)
    : hierarchyResolution(hierarchyInput, id, responseAtDate, HISTORICAL_PLACE_HIERARCHY_DEFAULT_MAX_DEPTH);
  if (
    !basePlace.isRedirect
    && temporalContext
    && (temporalContext.periodFrom || temporalContext.periodTo)
    && !temporalContext.exactDate
  ) {
    hierarchy = await resolvePlaceHierarchy({ placeId: id, temporalContext }, signal);
  }
  const identifiers = basePlace.isRedirect
    ? []
    : await listHistoricalPlaceExternalIdentifiers(id, signal);
  const externalIdentifierMap = identifiers.reduce<Record<string, string>>((result, identifier) => {
    // The server orders primary identifiers first. Preserve that choice when
    // historical non-primary values exist for the same provider.
    if (!(identifier.provider in result)) result[identifier.provider] = identifier.externalIdentifier;
    return result;
  }, {});
  const place = {
    ...basePlace,
    wikidataId: externalIdentifierMap.wikidata ?? basePlace.wikidataId,
    geonamesId: externalIdentifierMap.geonames ?? basePlace.geonamesId,
    externalIds: {
      ...basePlace.externalIds,
      ...externalIdentifierMap,
    },
  };
  return {
    place: names.length > 0 ? { ...place, names } : place,
    atDate: responseAtDate,
    names,
    hierarchy,
    counts: profileCounts(value(envelope, "counts", "totals")),
  };
}

/** Load persisted external IDs so the edit form never replaces them with blanks. */
export async function listHistoricalPlaceExternalIdentifiers(
  placeId: string,
  signal?: AbortSignal,
): Promise<HistoricalPlaceExternalIdentifier[]> {
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", "profile");
  let request = getSupabaseClient().rpc("list_place_external_identifiers_v1", {
    p_place_id: id,
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) {
    // Keep the profile readable during a coordinated frontend/database rollout.
    // Once the migration is present, all other failures remain actionable.
    if (isMissingRpcError(error)) return [];
    throw rpcServiceError("profile", error);
  }
  return responseRows(data, ["items", "identifiers", "results"])
    .map((row) => {
      const identifierId = text(value(row, "id"));
      const provider = text(value(row, "provider")).toLocaleLowerCase("uk-UA");
      const externalIdentifier = text(value(row, "externalIdentifier", "external_identifier"));
      if (!identifierId || !provider || !externalIdentifier) return null;
      return {
        id: identifierId,
        placeId: text(value(row, "placeId", "place_id"), id),
        provider,
        externalIdentifier,
        sourceUrl: nullableText(value(row, "sourceUrl", "source_url")),
        isPrimary: booleanValue(value(row, "isPrimary", "is_primary"), false),
        lockVersion: nonNegativeInteger(value(row, "lockVersion", "lock_version"), 1),
      } satisfies HistoricalPlaceExternalIdentifier;
    })
    .filter((item): item is HistoricalPlaceExternalIdentifier => Boolean(item));
}

/** Load every documented spelling without changing its exact source text. */
export async function listHistoricalPlaceNames(
  placeId: string,
  signal?: AbortSignal,
): Promise<PlaceName[]> {
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", "names");
  let request = getSupabaseClient().rpc("list_place_names_v1", { p_place_id: id });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("names", error);
  return responseRows(data, ["items", "names", "results"])
    .map((row, index) => placeName(row, id, index))
    .filter((name): name is PlaceName => Boolean(name));
}

/** Load the dated administrative paths used by the profile timeline. */
export async function listHistoricalPlaceHierarchyHistory(
  placeId: string,
  signal?: AbortSignal,
): Promise<PlaceHierarchyHistoryEntry[]> {
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", "history");
  let request = getSupabaseClient().rpc("list_place_hierarchy_history_v1", {
    p_place_id: id,
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("history", error);
  return responseRows(data, ["items", "history", "relations", "results"])
    .map((row, index) => hierarchyHistoryEntry(row, index))
    .filter((entry): entry is PlaceHierarchyHistoryEntry => Boolean(entry));
}

export async function listHistoricalPlaceBoundaries(
  placeId: string,
  atDate?: string | null,
  signal?: AbortSignal,
  temporalContext?: HistoricalPlaceTemporalContext | null,
): Promise<HistoricalPlaceBoundary[]> {
  const temporal = temporalContext ?? null;
  let rows: Record<string, unknown>[];
  if (temporal && (temporal.exactDate || temporal.periodFrom || temporal.periodTo)) {
    throwIfAborted(signal);
    const id = requiredText(placeId, "Оберіть історичне місце.", "boundaries");
    let request = getSupabaseClient().rpc("list_place_boundaries_v2", {
      p_place_id: id,
      p_at_date: nullableText(temporal.exactDate) ?? nullableText(atDate),
      p_period_from: nullableText(temporal.periodFrom),
      p_period_to: nullableText(temporal.periodTo),
    });
    if (signal) request = request.abortSignal(signal);
    const response = await request;
    if (response.error && isMissingRpcError(response.error)) {
      rows = await listPlaceDatedRpc("boundaries", "list_place_boundaries_v1", id, atDate, signal);
    } else {
      if (response.error) throw rpcServiceError("boundaries", response.error);
      rows = responseRows(response.data, ["items", "boundaries", "results"]);
    }
  } else {
    rows = await listPlaceDatedRpc("boundaries", "list_place_boundaries_v1", placeId, atDate, signal);
  }
  return rows
    .map((row) => historicalPlaceBoundary(row, placeId))
    .filter((item): item is HistoricalPlaceBoundary => Boolean(item));
}

export async function listHistoricalPlaceRelated(
  placeId: string,
  atDate?: string | null,
  signal?: AbortSignal,
): Promise<HistoricalPlaceRelated[]> {
  const rows = await listPlaceDatedRpc("related", "list_place_related_v1", placeId, atDate, signal);
  return rows.map((row) => {
    const place = placeSummary(value(row, "place"));
    if (!place) return null;
    const direction = text(value(row, "direction")) === "incoming" ? "incoming" : "outgoing";
    return {
      id: text(value(row, "id")),
      direction,
      relationType: text(value(row, "relationType", "relation_type"), "related"),
      place,
      ...datedEvidence(row),
    } satisfies HistoricalPlaceRelated;
  }).filter((item): item is HistoricalPlaceRelated => Boolean(item?.id));
}

export async function listHistoricalPlaceParishes(
  placeId: string,
  atDate?: string | null,
  signal?: AbortSignal,
): Promise<HistoricalPlaceParish[]> {
  const rows = await listPlaceDatedRpc("parishes", "list_place_parishes_v1", placeId, atDate, signal);
  return rows.map((row) => {
    const place = placeSummary(value(row, "place"));
    if (!place) return null;
    const direction = text(value(row, "direction")) === "parishToSettlement"
      ? "parishToSettlement"
      : "settlementToParish";
    return {
      id: text(value(row, "id")),
      direction,
      religion: text(value(row, "religion")),
      relationType: text(value(row, "relationType", "relation_type"), "belongs_to_parish"),
      place,
      ...datedEvidence(row),
    } satisfies HistoricalPlaceParish;
  }).filter((item): item is HistoricalPlaceParish => Boolean(item?.id));
}

export async function listHistoricalPlaceArchives(
  placeId: string,
  atDate?: string | null,
  signal?: AbortSignal,
): Promise<HistoricalPlaceArchive[]> {
  const rows = await listPlaceDatedRpc("archives", "list_place_archives_v1", placeId, atDate, signal);
  return rows.map((row) => {
    const resourceRow = record(value(row, "resource"));
    const id = text(value(row, "id"));
    const resourceId = text(value(resourceRow, "id"));
    if (!id || !resourceId) return null;
    const rawType = text(value(resourceRow, "resourceType", "resource_type"));
    const resourceTypes = new Set<HistoricalArchiveResource["resourceType"]>([
      "archive", "fund", "inventory", "file", "catalogue", "external_resource",
    ]);
    const resource: HistoricalArchiveResource = {
      id: resourceId,
      parentResourceId: nullableText(value(resourceRow, "parentResourceId", "parent_resource_id")),
      resourceType: resourceTypes.has(rawType as HistoricalArchiveResource["resourceType"])
        ? rawType as HistoricalArchiveResource["resourceType"]
        : "external_resource",
      title: text(value(resourceRow, "title")),
      archiveName: text(value(resourceRow, "archiveName", "archive_name")),
      fund: text(value(resourceRow, "fund")),
      inventory: text(value(resourceRow, "inventory")),
      fileReference: text(value(resourceRow, "fileReference", "file_reference")),
      catalogueReference: text(value(resourceRow, "catalogueReference", "catalogue_reference")),
      url: nullableText(value(resourceRow, "url")),
      description: exactText(value(resourceRow, "description")),
      sourceReference: nullableExactText(value(resourceRow, "sourceReference", "source_reference")),
      originalText: exactText(value(resourceRow, "originalText", "original_text")),
    };
    return {
      id,
      relationType: text(value(row, "relationType", "relation_type"), "has_materials"),
      resource,
      ...datedEvidence(row),
    } satisfies HistoricalPlaceArchive;
  }).filter((item): item is HistoricalPlaceArchive => Boolean(item));
}

export async function listHistoricalPlaceDocuments(
  placeId: string,
  limit = 100,
  offset = 0,
  signal?: AbortSignal,
  temporalContext?: HistoricalPlaceTemporalContext | null,
): Promise<HistoricalPlaceDocument[]> {
  const rows = await listPlaceTemporalPageRpc("documents", "list_place_documents_v2", "list_place_documents_v1", placeId, limit, offset, signal, temporalContext);
  return rows.map(historicalPlaceDocument).filter((item): item is HistoricalPlaceDocument => Boolean(item));
}

/**
 * Load source-document choices independently from the in-memory project cache.
 * Historical places can be opened from a bookmark before the Documents module,
 * so relying on that module's lazy state would leave every source selector empty.
 */
export async function listHistoricalPlaceDocumentOptions(
  projectId: string,
  limit = HISTORICAL_PLACE_DOCUMENT_OPTIONS_MAX_LIMIT,
  signal?: AbortSignal,
): Promise<HistoricalPlaceDocumentOption[]> {
  throwIfAborted(signal);
  const id = requiredText(projectId, "Оберіть проєкт.", "documents");
  let request = getSupabaseClient()
    .from("documents")
    .select("id,title")
    .eq("project_id", id)
    .order("updated_at", { ascending: false })
    .limit(boundedInteger(limit, 1, HISTORICAL_PLACE_DOCUMENT_OPTIONS_MAX_LIMIT, HISTORICAL_PLACE_DOCUMENT_OPTIONS_MAX_LIMIT));
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("documents", error);
  return records(data).map((row) => ({
    id: text(value(row, "id")),
    title: text(value(row, "title"), "Без назви"),
  })).filter((item) => Boolean(item.id));
}

export async function listHistoricalPlacePeople(
  placeId: string,
  limit = 100,
  offset = 0,
  signal?: AbortSignal,
): Promise<HistoricalPlacePerson[]> {
  const rows = await listPlacePageRpc("people", "list_place_people_v1", placeId, limit, offset, signal);
  return rows.map(historicalPlacePerson).filter((item): item is HistoricalPlacePerson => Boolean(item));
}

export async function listHistoricalPlaceEvents(
  placeId: string,
  limit = 100,
  offset = 0,
  signal?: AbortSignal,
  temporalContext?: HistoricalPlaceTemporalContext | null,
): Promise<HistoricalPlaceEvent[]> {
  const rows = await listPlaceTemporalPageRpc("events", "list_place_events_v2", "list_place_events_v1", placeId, limit, offset, signal, temporalContext);
  return rows.map(historicalPlaceEvent).filter((item): item is HistoricalPlaceEvent => Boolean(item));
}

/** One date-aware payload for the map, its boundary and contextual records. */
export async function getHistoricalPlaceMapContext(
  placeId: string,
  temporalContext?: HistoricalPlaceTemporalContext | null,
  limit = 100,
  signal?: AbortSignal,
): Promise<HistoricalPlaceMapContext> {
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", "map");
  const temporal = temporalContext ?? null;
  const exactDate = nullableText(temporal?.exactDate);
  const periodFrom = nullableText(temporal?.periodFrom);
  const periodTo = nullableText(temporal?.periodTo);
  let request = getSupabaseClient().rpc("get_place_map_context_v1", {
    p_place_id: id,
    p_at_date: exactDate,
    p_period_from: periodFrom,
    p_period_to: periodTo,
    p_limit: boundedInteger(limit, 1, 250, 100),
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error && !isMissingRpcError(error)) throw rpcServiceError("map", error);
  if (error) {
    const [boundaries, documents, events] = await Promise.all([
      listHistoricalPlaceBoundaries(id, exactDate, signal, temporal),
      listHistoricalPlaceDocuments(id, limit, 0, signal, temporal),
      listHistoricalPlaceEvents(id, limit, 0, signal, temporal),
    ]);
    return {
      place: null,
      boundaries,
      documents,
      events,
      atDate: exactDate,
      periodFrom,
      periodTo,
      temporalMode: exactDate ? "exact_date" : periodFrom ? "period" : "all_time",
    };
  }
  const row = firstResponseRecord(data, ["context", "result"]);
  const rawMode = text(value(row, "temporalMode", "temporal_mode"));
  return {
    place: placeSummary(value(row, "place")),
    boundaries: records(value(row, "boundaries"))
      .map((item) => historicalPlaceBoundary(item, id))
      .filter((item): item is HistoricalPlaceBoundary => Boolean(item)),
    documents: records(value(row, "documents"))
      .map(historicalPlaceDocument)
      .filter((item): item is HistoricalPlaceDocument => Boolean(item)),
    events: records(value(row, "events"))
      .map(historicalPlaceEvent)
      .filter((item): item is HistoricalPlaceEvent => Boolean(item)),
    atDate: nullableText(value(row, "atDate", "at_date")) ?? exactDate,
    periodFrom: nullableText(value(row, "periodFrom", "period_from")) ?? periodFrom,
    periodTo: nullableText(value(row, "periodTo", "period_to")) ?? periodTo,
    temporalMode: rawMode === "exact_date" || rawMode === "period"
      ? rawMode
      : "all_time",
  };
}

export async function previewHistoricalPlaceMerge(
  sourcePlaceId: string,
  targetPlaceId: string,
  signal?: AbortSignal,
): Promise<HistoricalPlaceMergePreview> {
  throwIfAborted(signal);
  const sourceId = requiredText(sourcePlaceId, "Оберіть місце-дубль.", "merge-preview");
  const targetId = requiredText(targetPlaceId, "Оберіть місце, яке потрібно зберегти.", "merge-preview");
  let request = getSupabaseClient().rpc("merge_places_preview_v1", {
    p_source_place_id: sourceId,
    p_target_place_id: targetId,
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("merge-preview", error);
  const row = firstResponseRecord(data, ["preview", "result"]);
  const source = mergeSnapshot(value(row, "source"));
  const target = mergeSnapshot(value(row, "target"));
  if (!source || !target) {
    throw new HistoricalPlacesServiceError("merge-preview", "Сервер повернув неповний попередній перегляд об’єднання.", "INVALID_RESPONSE");
  }
  const preservation = record(value(row, "preservationPreview", "preservation_preview"));
  return {
    source,
    target,
    canMerge: booleanValue(value(row, "canMerge", "can_merge"), false),
    requiresChangeRequest: booleanValue(value(row, "requiresChangeRequest", "requires_change_request"), false),
    preservationPreview: {
      hierarchySelfLinks: nonNegativeInteger(value(preservation, "hierarchySelfLinks", "hierarchy_self_links"), 0),
      genericSelfLinks: nonNegativeInteger(value(preservation, "genericSelfLinks", "generic_self_links"), 0),
      parishSelfLinks: nonNegativeInteger(value(preservation, "parishSelfLinks", "parish_self_links"), 0),
    },
  };
}

export async function mergeHistoricalPlaces(
  input: MergeHistoricalPlacesInput,
  signal?: AbortSignal,
): Promise<HistoricalPlaceMergeResult> {
  throwIfAborted(signal);
  const sourceId = requiredText(input.sourcePlaceId, "Оберіть місце-дубль.", "merge");
  const targetId = requiredText(input.targetPlaceId, "Оберіть місце, яке потрібно зберегти.", "merge");
  let request = getSupabaseClient().rpc("merge_places_v1", {
    p_source_place_id: sourceId,
    p_target_place_id: targetId,
    p_expected_source_lock_version: positiveLockVersion(input.expectedSourceLockVersion),
    p_expected_target_lock_version: positiveLockVersion(input.expectedTargetLockVersion),
    p_reason: exactText(input.reason),
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("merge", error);
  const row = firstResponseRecord(data, ["merge", "result"]);
  const operationId = text(value(row, "operationId", "operation_id"));
  if (!operationId) {
    throw new HistoricalPlacesServiceError("merge", "Сервер не підтвердив завершення об’єднання.", "INVALID_RESPONSE");
  }
  return {
    operationId,
    sourcePlaceId: text(value(row, "sourcePlaceId", "source_place_id"), sourceId),
    targetPlaceId: text(value(row, "targetPlaceId", "target_place_id"), targetId),
    sourceRedirectStatus: "merged",
    transferCounts: numberRecord(value(row, "transferCounts", "transfer_counts")),
    targetLockVersion: nonNegativeInteger(value(row, "targetLockVersion", "target_lock_version"), 0),
  };
}

async function listPlaceDatedRpc(
  operation: "related" | "parishes" | "archives" | "boundaries",
  rpcName: "list_place_related_v1" | "list_place_parishes_v1" | "list_place_archives_v1" | "list_place_boundaries_v1",
  placeId: string,
  atDate?: string | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", operation);
  let request = getSupabaseClient().rpc(rpcName, { p_place_id: id, p_at_date: nullableText(atDate) });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError(operation, error);
  return responseRows(data, ["items", "results"]);
}

async function listPlacePageRpc(
  operation: "documents" | "people" | "events",
  rpcName: "list_place_documents_v1" | "list_place_people_v1" | "list_place_events_v1",
  placeId: string,
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", operation);
  let request = getSupabaseClient().rpc(rpcName, {
    p_place_id: id,
    p_limit: boundedInteger(limit, 1, 250, 100),
    p_offset: boundedInteger(offset, 0, 1_000_000, 0),
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError(operation, error);
  return responseRows(data, ["items", "results"]);
}

async function listPlaceTemporalPageRpc(
  operation: "documents" | "events",
  modernRpcName: "list_place_documents_v2" | "list_place_events_v2",
  legacyRpcName: "list_place_documents_v1" | "list_place_events_v1",
  placeId: string,
  limit: number,
  offset: number,
  signal?: AbortSignal,
  temporalContext?: HistoricalPlaceTemporalContext | null,
): Promise<Record<string, unknown>[]> {
  if (!temporalContext?.periodFrom && !temporalContext?.periodTo && !temporalContext?.exactDate) {
    return listPlacePageRpc(operation, legacyRpcName, placeId, limit, offset, signal);
  }
  throwIfAborted(signal);
  const id = requiredText(placeId, "Оберіть історичне місце.", operation);
  let request = getSupabaseClient().rpc(modernRpcName, {
    p_place_id: id,
    p_period_from: nullableText(temporalContext.periodFrom) ?? nullableText(temporalContext.exactDate),
    p_period_to: nullableText(temporalContext.periodTo) ?? nullableText(temporalContext.exactDate),
    p_limit: boundedInteger(limit, 1, 250, 100),
    p_offset: boundedInteger(offset, 0, 1_000_000, 0),
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  if (error && isMissingRpcError(error)) {
    return listPlacePageRpc(operation, legacyRpcName, placeId, limit, offset, signal);
  }
  if (error) throw rpcServiceError(operation, error);
  return responseRows(data, ["items", "results"]);
}

async function writeRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getSupabaseClient().rpc(name, args);
  if (error) throw rpcServiceError("write", error);
  return data;
}

export async function patchHistoricalPlace(input: PatchHistoricalPlaceInput): Promise<PlaceSummary> {
  const placeId = requiredText(input.placeId, "Оберіть місце.", "write");
  let data: unknown;
  try {
    data = await writeRpc("patch_project_place_v2", {
      p_place_id: placeId,
      p_expected_lock_version: positiveLockVersion(input.expectedLockVersion, "write"),
      p_patch: input.patch,
    });
  } catch (cause) {
    if (!(cause instanceof HistoricalPlacesServiceError) || !isMissingRpcCode(cause.code)) throw cause;
    const legacyKeys = new Set([
      "canonicalName", "modernName", "description", "latitude", "longitude",
      "status", "verificationStatus",
    ]);
    const patchKeys = Object.keys(input.patch);
    if (patchKeys.some((key) => !legacyKeys.has(key))) {
      throw historicalPlacesMigrationRequired("write");
    }
    data = await writeRpc("patch_project_place_v1", {
      p_place_id: placeId,
      p_expected_lock_version: positiveLockVersion(input.expectedLockVersion, "write"),
      p_patch: input.patch,
    });
  }
  const parsed = placeSummary(firstResponseRecord(data, ["place", "result"]));
  if (!parsed) throw new HistoricalPlacesServiceError("write", "Сервер повернув неповні дані місця.", "INVALID_RESPONSE");
  return parsed;
}

function createProjectPlaceRequiresV2(input: CreateProjectPlaceInput): boolean {
  const derivedLegacyStatus = input.needsIdentification === true ? "needs_review" : "active";
  return input.placeType !== undefined
    || input.parentRelation !== undefined
    || Boolean(text(input.currentCountry))
    || Boolean(text(input.currentAdmin))
    || Boolean(nullableText(input.wikidataId))
    || Boolean(nullableText(input.geonamesId))
    || Object.keys(input.externalIds ?? {}).length > 0
    || (input.verificationStatus !== undefined && input.verificationStatus !== "unverified")
    || (input.status !== undefined && input.status !== derivedLegacyStatus)
    || (input.names ?? []).some((name) => name.nameType === "pre_reform" || name.nameType === "soviet");
}

function historicalPlacesMigrationRequired(
  operation: "create" | "write",
): HistoricalPlacesServiceError {
  return new HistoricalPlacesServiceError(
    operation,
    "Оновлена модель історичних місць ще не застосована в Supabase. Зміни не збережено, щоб не втратити нові поля. Застосуйте актуальні міграції та повторіть дію.",
    "MIGRATION_REQUIRED",
  );
}

export async function addHistoricalPlaceName(input: AddHistoricalPlaceNameInput): Promise<PlaceName> {
  const placeId = requiredText(input.placeId, "Оберіть місце.", "write");
  const originalText = requiredExactText(input.originalText, "Вкажіть точне написання з джерела.", "write");
  const data = await writeRpc("add_place_name_v1", {
    p_place_id: placeId,
    p_payload: { ...input, placeId: undefined, originalText },
  });
  const parsed = placeName(firstResponseRecord(data, ["name", "result"]), placeId, 0);
  if (!parsed) throw new HistoricalPlacesServiceError("write", "Сервер не підтвердив назву.", "INVALID_RESPONSE");
  return parsed;
}

export async function updateHistoricalPlaceName(input: UpdateHistoricalPlaceNameInput): Promise<PlaceName> {
  const data = await writeRpc("update_place_name_v1", {
    p_name_id: requiredText(input.nameId, "Оберіть назву.", "write"),
    p_expected_lock_version: positiveLockVersion(input.expectedLockVersion, "write"),
    p_patch: input.patch,
  });
  const parsed = placeName(firstResponseRecord(data, ["name", "result"]), "", 0);
  if (!parsed) throw new HistoricalPlacesServiceError("write", "Сервер не підтвердив зміну назви.", "INVALID_RESPONSE");
  return parsed;
}

function datedRelationPayload(input: HistoricalPlaceRelationInput) {
  return {
    relationType: input.relationType,
    validFrom: input.validFrom,
    validTo: input.validTo,
    validFromText: input.validFromText,
    validToText: input.validToText,
    validFromPrecision: input.validFromPrecision,
    validToPrecision: input.validToPrecision,
    sourceDocumentId: input.sourceDocumentId,
    sourceFindingId: input.sourceFindingId,
    citationId: input.citationId,
    sourceReference: input.sourceReference,
    confidence: input.confidence,
    note: input.note,
  };
}

export async function addHistoricalPlaceHierarchy(input: HistoricalPlaceRelationInput): Promise<void> {
  await writeRpc("add_place_hierarchy_relation_v1", {
    p_child_place_id: requiredText(input.placeId, "Оберіть дочірнє місце.", "write"),
    p_parent_place_id: requiredText(input.relatedPlaceId, "Оберіть адміністративний центр.", "write"),
    p_payload: datedRelationPayload(input),
  });
}

export async function addHistoricalPlaceParish(input: HistoricalPlaceRelationInput): Promise<void> {
  await writeRpc("add_place_parish_relation_v1", {
    p_place_id: requiredText(input.placeId, "Оберіть місце.", "write"),
    p_parish_place_id: requiredText(input.relatedPlaceId, "Оберіть парафію.", "write"),
    p_payload: {
      ...datedRelationPayload(input),
      religion: input.religion,
      originalText: input.originalText,
    },
  });
}

export async function addHistoricalPlaceRelated(input: HistoricalPlaceRelationInput): Promise<void> {
  await writeRpc("add_place_relation_v1", {
    p_place_id: requiredText(input.placeId, "Оберіть місце.", "write"),
    p_related_place_id: requiredText(input.relatedPlaceId, "Оберіть пов’язане місце.", "write"),
    p_payload: {
      ...datedRelationPayload(input),
      originalText: input.originalText,
    },
  });
}

export async function addHistoricalPlaceBoundary(input: AddHistoricalPlaceBoundaryInput): Promise<void> {
  const geometry = record(input.geometryGeojson);
  if (!Object.keys(geometry).length) {
    throw new HistoricalPlacesServiceError("write", "Додайте GeoJSON геометрію межі.", "INVALID_INPUT");
  }
  await writeRpc("add_place_boundary_v1", {
    p_place_id: requiredText(input.placeId, "Оберіть місце.", "write"),
    p_payload: {
      boundaryType: text(input.boundaryType, "historical_boundary"),
      geometryGeojson: geometry,
      validFrom: nullableText(input.validFrom),
      validTo: nullableText(input.validTo),
      validFromText: nullableExactText(input.validFromText),
      validToText: nullableExactText(input.validToText),
      validFromPrecision: nullableText(input.validFromPrecision),
      validToPrecision: nullableText(input.validToPrecision),
      sourceDocumentId: nullableText(input.sourceDocumentId),
      sourceFindingId: nullableText(input.sourceFindingId),
      citationId: nullableText(input.citationId),
      sourceReference: nullableExactText(input.sourceReference),
      confidence: confidence(input.confidence),
      originalText: requiredExactText(input.originalText, "Вкажіть походження або точний опис межі.", "write"),
      note: exactText(input.note),
    },
  });
}

export async function createHistoricalArchive(input: CreateHistoricalArchiveInput): Promise<HistoricalArchiveResource> {
  const data = await writeRpc("create_archive_resource_v1", {
    p_project_id: requiredText(input.projectId, "Оберіть проєкт.", "write"),
    p_payload: { ...input, projectId: undefined },
  });
  return historicalArchiveResourceResult(data, input);
}

/** Create the archive resource and its Place relation in one database transaction. */
export async function createAndLinkHistoricalPlaceArchive(
  placeId: string,
  input: CreateHistoricalArchiveInput,
  relationInput: Omit<HistoricalPlaceRelationInput, "placeId" | "relatedPlaceId">,
): Promise<HistoricalArchiveResource> {
  const data = await writeRpc("create_and_link_place_archive_resource_v1", {
    p_place_id: requiredText(placeId, "Оберіть місце.", "write"),
    p_resource_payload: { ...input, projectId: undefined },
    p_link_payload: relationInput,
  });
  return historicalArchiveResourceResult(data, input);
}

function historicalArchiveResourceResult(
  data: unknown,
  input: CreateHistoricalArchiveInput,
): HistoricalArchiveResource {
  const row = firstResponseRecord(data, ["resource", "result"]);
  return {
    id: requiredText(value(row, "id"), "Сервер не підтвердив архівний ресурс.", "write"),
    parentResourceId: nullableText(value(row, "parentResourceId", "parent_resource_id")),
    resourceType: text(value(row, "resourceType", "resource_type"), input.resourceType) as HistoricalArchiveResource["resourceType"],
    title: text(value(row, "title"), input.title), archiveName: text(value(row, "archiveName", "archive_name"), input.archiveName),
    fund: text(value(row, "fund"), input.fund), inventory: text(value(row, "inventory"), input.inventory), fileReference: text(value(row, "fileReference", "file_reference"), input.fileReference),
    catalogueReference: text(value(row, "catalogueReference", "catalogue_reference"), input.catalogueReference), url: input.url ?? null, description: input.description ?? "", sourceReference: input.sourceReference ?? null,
    originalText: text(value(row, "originalText", "original_text"), input.originalText),
  };
}

export async function linkHistoricalPlaceArchive(placeId: string, archiveResourceId: string, input: Omit<HistoricalPlaceRelationInput, "placeId" | "relatedPlaceId">): Promise<void> {
  await writeRpc("add_place_archive_relation_v1", { p_place_id: requiredText(placeId, "Оберіть місце.", "write"), p_archive_resource_id: requiredText(archiveResourceId, "Оберіть архів.", "write"), p_payload: input });
}

export async function addHistoricalDocumentPlaceLink(input: AddDocumentPlaceLinkInput): Promise<void> {
  await writeRpc("add_document_place_link_v1", {
    p_document_id: requiredText(input.documentId, "Оберіть документ.", "write"),
    p_place_id: requiredText(input.placeId, "Оберіть місце.", "write"),
    p_payload: { ...input, documentId: undefined, placeId: undefined, originalText: requiredExactText(input.originalText, "Вкажіть точний текст місця в документі.", "write") },
  });
}

export async function listHistoricalPlaceAudit(placeId: string, limit = 50, beforeId?: number | null): Promise<HistoricalPlaceAuditEntry[]> {
  const { data, error } = await getSupabaseClient().rpc("list_place_audit_history_v1", { p_place_id: requiredText(placeId, "Оберіть місце.", "audit"), p_limit: boundedInteger(limit, 1, 100, 50), p_before_id: beforeId ?? null });
  if (error) throw rpcServiceError("audit", error);
  return responseRows(data, ["items", "results"]).map((row) => ({
    id: nonNegativeInteger(value(row, "id"), 0), entityTable: text(value(row, "entityTable", "entity_table")), entityId: text(value(row, "entityId", "entity_id")),
    placeId: text(value(row, "placeId", "place_id")), projectId: text(value(row, "projectId", "project_id")), actorId: nullableText(value(row, "actorId", "actor_id")),
    action: text(value(row, "action")), before: Object.keys(record(value(row, "before"))).length ? record(value(row, "before")) : null,
    after: Object.keys(record(value(row, "after"))).length ? record(value(row, "after")) : null, createdAt: text(value(row, "createdAt", "created_at")),
  })).filter((entry) => entry.id > 0);
}

/** Confirm or review a canonical place identity without changing place_name. */
export async function setPersonEventPlace(
  input: SetPersonEventPlaceInput,
  signal?: AbortSignal,
): Promise<PersonEventPlaceLinkResult> {
  throwIfAborted(signal);
  const eventId = requiredText(input.eventId, "Оберіть подію особи.", "event-link");
  const placeId = requiredText(input.placeId, "Оберіть історичне місце.", "event-link");
  let request = getSupabaseClient().rpc("set_person_event_place_v1", {
    p_event_id: eventId,
    p_place_id: placeId,
    p_place_original_text: input.placeOriginalText === undefined
      ? null
      : input.placeOriginalText,
    p_resolution_status: input.resolutionStatus ?? "confirmed",
    p_expected_updated_at: nullableText(input.expectedUpdatedAt),
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("event-link", error);
  return personEventPlaceLinkResult(data, eventId);
}

/** Remove only the canonical identity; exact source wording is preserved by default. */
export async function clearPersonEventPlace(
  input: ClearPersonEventPlaceInput,
  signal?: AbortSignal,
): Promise<PersonEventPlaceLinkResult> {
  throwIfAborted(signal);
  const eventId = requiredText(input.eventId, "Оберіть подію особи.", "event-link");
  let request = getSupabaseClient().rpc("clear_person_event_place_v1", {
    p_event_id: eventId,
    p_preserve_original_text: input.preserveOriginalText !== false,
    p_expected_updated_at: nullableText(input.expectedUpdatedAt),
  });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  throwIfAborted(signal);
  if (error) throw rpcServiceError("event-link", error);
  return personEventPlaceLinkResult(data, eventId);
}

function personEventPlaceLinkResult(
  input: unknown,
  fallbackEventId: string,
): PersonEventPlaceLinkResult {
  const row = firstResponseRecord(input, ["event", "result"]);
  const eventId = text(value(row, "eventId", "event_id"), fallbackEventId);
  const resolutionStatus = text(value(row, "resolutionStatus", "resolution_status"));
  if (!eventId || !["unresolved", "confirmed", "needs_review"].includes(resolutionStatus)) {
    throw new HistoricalPlacesServiceError(
      "event-link",
      "Сервер повернув неповну прив’язку місця до події.",
      "INVALID_RESPONSE",
    );
  }
  return {
    eventId,
    projectId: text(value(row, "projectId", "project_id")),
    personId: text(value(row, "personId", "person_id")),
    placeId: nullableText(value(row, "placeId", "place_id")),
    placeOriginalText: exactText(value(row, "placeOriginalText", "place_original_text")),
    resolutionStatus: resolutionStatus as PersonEventPlaceLinkResult["resolutionStatus"],
    updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

function datedEvidence(row: Record<string, unknown>) {
  return {
    validFrom: nullableText(value(row, "validFrom", "valid_from")),
    validTo: nullableText(value(row, "validTo", "valid_to")),
    validFromText: nullableExactText(value(row, "validFromText", "valid_from_text")),
    validToText: nullableExactText(value(row, "validToText", "valid_to_text")),
    confidence: confidence(value(row, "confidence")),
    originalText: exactText(value(row, "originalText", "original_text")),
    note: exactText(value(row, "note", "notes")),
    sourceReference: nullableExactText(value(row, "sourceReference", "source_reference")),
    lockVersion: nonNegativeInteger(value(row, "lockVersion", "lock_version"), 0),
  };
}

function historicalPlaceBoundary(
  row: Record<string, unknown>,
  fallbackPlaceId: string,
): HistoricalPlaceBoundary | null {
  const id = text(value(row, "id"));
  const geometryGeojson = record(value(row, "geometryGeojson", "geometry_geojson", "geometry"));
  if (!id || Object.keys(geometryGeojson).length === 0) return null;
  const fromPrecision = text(value(row, "validFromPrecision", "valid_from_precision"));
  const toPrecision = text(value(row, "validToPrecision", "valid_to_precision"));
  return {
    id,
    placeId: text(value(row, "placeId", "place_id"), fallbackPlaceId),
    boundaryType: text(value(row, "boundaryType", "boundary_type"), "historical_boundary"),
    geometryGeojson,
    geometryType: text(value(row, "geometryType", "geometry_type", "geometryFormat", "geometry_format")),
    srid: nonNegativeInteger(value(row, "srid"), 4326),
    validFromPrecision: datePrecisions.has(fromPrecision as PlaceNameDatePrecision)
      ? fromPrecision as PlaceNameDatePrecision
      : null,
    validToPrecision: datePrecisions.has(toPrecision as PlaceNameDatePrecision)
      ? toPrecision as PlaceNameDatePrecision
      : null,
    sourceDocumentId: nullableText(value(row, "sourceDocumentId", "source_document_id")),
    sourceFindingId: nullableText(value(row, "sourceFindingId", "source_finding_id")),
    citationId: nullableText(value(row, "citationId", "citation_id")),
    ...datedEvidence(row),
  };
}

function historicalPlaceDocument(row: Record<string, unknown>): HistoricalPlaceDocument | null {
  const linkId = text(value(row, "linkId", "link_id"));
  const documentId = text(value(row, "documentId", "document_id"));
  if (!linkId || !documentId) return null;
  return {
    linkId,
    documentId,
    title: text(value(row, "title"), "Документ без назви"),
    documentType: text(value(row, "documentType", "document_type")),
    archive: text(value(row, "archive")),
    fund: text(value(row, "fund")),
    fileReference: text(value(row, "fileReference", "file_reference")),
    yearFrom: nullableInteger(value(row, "yearFrom", "year_from")),
    yearTo: nullableInteger(value(row, "yearTo", "year_to")),
    url: nullableText(value(row, "url")),
    relationType: text(value(row, "relationType", "relation_type"), "mentions"),
    originalText: exactText(value(row, "originalText", "original_text")),
    sourceReference: nullableExactText(value(row, "sourceReference", "source_reference")),
    confidence: confidence(value(row, "confidence")),
    note: exactText(value(row, "note")),
    updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

function historicalPlacePerson(row: Record<string, unknown>): HistoricalPlacePerson | null {
  const personId = text(value(row, "personId", "person_id"));
  if (!personId) return null;
  return {
    personId,
    fullName: text(value(row, "fullName", "full_name"), "Особа без імені"),
    surname: text(value(row, "surname")),
    givenName: text(value(row, "givenName", "given_name")),
    patronymic: text(value(row, "patronymic")),
    eventCount: nonNegativeInteger(value(row, "eventCount", "event_count"), 0),
    eventTypes: stringArray(value(row, "eventTypes", "event_types")),
  };
}

function historicalPlaceEvent(row: Record<string, unknown>): HistoricalPlaceEvent | null {
  const eventId = text(value(row, "eventId", "event_id"));
  const personId = text(value(row, "personId", "person_id"));
  if (!eventId || !personId) return null;
  const status = text(value(row, "placeResolutionStatus", "place_resolution_status"));
  return {
    eventId,
    personId,
    personName: text(value(row, "personName", "person_name"), "Особа без імені"),
    eventType: text(value(row, "eventType", "event_type")),
    title: text(value(row, "title")),
    eventDate: nullableText(value(row, "eventDate", "event_date")),
    dateFrom: nullableText(value(row, "dateFrom", "date_from")),
    dateTo: nullableText(value(row, "dateTo", "date_to")),
    dateText: exactText(value(row, "dateText", "date_text")),
    placeName: text(value(row, "placeName", "place_name")),
    placeOriginalText: exactText(value(row, "placeOriginalText", "place_original_text")),
    placeResolutionStatus: ["unresolved", "confirmed", "needs_review"].includes(status)
      ? status as HistoricalPlaceEvent["placeResolutionStatus"]
      : "unresolved",
    eventRole: text(value(row, "eventRole", "event_role")),
    evidenceStatus: text(value(row, "evidenceStatus", "evidence_status")),
    confidence: confidence(value(row, "confidence")),
    sourceDocumentId: nullableText(value(row, "sourceDocumentId", "source_document_id")),
    sourceFindingId: nullableText(value(row, "sourceFindingId", "source_finding_id")),
    updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

function mergeSnapshot(input: unknown): HistoricalPlaceMergeSnapshot | null {
  const row = record(input);
  const place = placeSummary(value(row, "place"));
  if (!place) return null;
  const adminContext = mergeAdminContext(
    value(row, "adminContext", "admin_context"),
    place.id,
  );
  return {
    place,
    counts: mergeSnapshotCounts(value(row, "counts")),
    names: records(value(row, "names"))
      .map((name, index) => placeName(name, place.id, index))
      .filter((name): name is PlaceName => Boolean(name)),
    people: records(value(row, "people"))
      .map(historicalPlacePerson)
      .filter((person): person is HistoricalPlacePerson => Boolean(person)),
    documents: records(value(row, "documents"))
      .map(historicalPlaceDocument)
      .filter((document): document is HistoricalPlaceDocument => Boolean(document)),
    hierarchy: hierarchyNodes(value(row, "hierarchy", "administrativeHierarchy", "administrative_hierarchy"), HISTORICAL_PLACE_HIERARCHY_DEFAULT_MAX_DEPTH),
    adminContext,
  };
}

function mergeAdminContext(
  input: unknown,
  placeId: string,
): HistoricalPlaceMergeAdminContext | null {
  const row = record(input);
  if (Object.keys(row).length === 0) return null;
  const atDate = nullableText(value(row, "atDate", "at_date"));
  const currentInput = value(row, "currentHierarchy", "current_hierarchy");
  const currentHierarchy = hierarchyResolution(
    currentInput,
    placeId,
    atDate,
    HISTORICAL_PLACE_HIERARCHY_MAX_DEPTH,
  );
  const ancestors = hierarchyNodes(
    value(row, "ancestors", "ancestorPaths", "ancestor_paths"),
    HISTORICAL_PLACE_HIERARCHY_MAX_DEPTH,
  );
  const history = records(value(row, "history", "hierarchyHistory", "hierarchy_history"))
    .map((item, index) => hierarchyHistoryEntry(item, index))
    .filter((item): item is PlaceHierarchyHistoryEntry => Boolean(item));
  return { atDate, currentHierarchy, ancestors, history };
}

function mergeSnapshotCounts(input: unknown): HistoricalPlaceMergeSnapshotCounts {
  const row = record(input);
  return {
    names: nonNegativeInteger(value(row, "names"), 0),
    boundaries: nonNegativeInteger(value(row, "boundaries"), 0),
    typeAssignments: nonNegativeInteger(value(row, "typeAssignments", "type_assignments"), 0),
    hierarchyAsChild: nonNegativeInteger(value(row, "hierarchyAsChild", "hierarchy_as_child"), 0),
    hierarchyAsParent: nonNegativeInteger(value(row, "hierarchyAsParent", "hierarchy_as_parent"), 0),
    relatedOutgoing: nonNegativeInteger(value(row, "relatedOutgoing", "related_outgoing"), 0),
    relatedIncoming: nonNegativeInteger(value(row, "relatedIncoming", "related_incoming"), 0),
    parishAsSettlement: nonNegativeInteger(value(row, "parishAsSettlement", "parish_as_settlement"), 0),
    parishAsParish: nonNegativeInteger(value(row, "parishAsParish", "parish_as_parish"), 0),
    archives: nonNegativeInteger(value(row, "archives"), 0),
    visibleDocuments: nonNegativeInteger(value(row, "visibleDocuments", "visible_documents"), 0),
    visibleEvents: nonNegativeInteger(value(row, "visibleEvents", "visible_events"), 0),
    visiblePeople: nonNegativeInteger(value(row, "visiblePeople", "visible_people"), 0),
  };
}

function numberRecord(input: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(input))
      .map(([key, item]) => [key, Number(item)] as const)
      .filter(([, item]) => Number.isFinite(item) && item >= 0),
  );
}

function profileCounts(input: unknown): HistoricalPlaceProfileCounts {
  const row = record(input);
  return {
    names: nonNegativeInteger(value(row, "names", "name_count"), 0),
    hierarchyRelations: nonNegativeInteger(
      value(row, "hierarchyRelations", "hierarchy_relations", "hierarchy_count"),
      0,
    ),
    people: nonNegativeInteger(value(row, "people", "people_count"), 0),
    events: nonNegativeInteger(
      value(row, "events", "events_count", "visiblePersonEvents", "visible_person_events"),
      0,
    ),
    documents: nonNegativeInteger(value(row, "documents", "documents_count"), 0),
    relatedPlaces: nonNegativeInteger(
      value(row, "relatedPlaces", "related_places", "related_count"),
      0,
    ),
  };
}

function hierarchyHistoryEntry(
  row: Record<string, unknown>,
  index: number,
): PlaceHierarchyHistoryEntry | null {
  let hierarchy = hierarchyNodes(
    value(row, "hierarchy", "path", "nodes", "parents"),
    HISTORICAL_PLACE_HIERARCHY_MAX_DEPTH,
  );
  if (hierarchy.length === 0) {
    const parent = hierarchyNode(row, 0);
    if (parent) hierarchy = [parent];
  }
  if (hierarchy.length === 0) return null;
  return {
    id: text(value(row, "id", "relationId", "relation_id"), `history-${index + 1}`),
    validFrom: nullableText(value(row, "validFrom", "valid_from")),
    validTo: nullableText(value(row, "validTo", "valid_to")),
    validFromText: nullableExactText(value(row, "validFromText", "valid_from_text")),
    validToText: nullableExactText(value(row, "validToText", "valid_to_text")),
    relationType: text(value(row, "relationType", "relation_type"), "administrative_parent"),
    confidence: confidence(value(row, "confidence")),
    hierarchy,
    sourceId: nullableText(value(row, "sourceId", "source_id")),
    note: exactText(value(row, "note", "notes")),
  };
}

function createPlaceNamePayload(
  input: CreatePlaceNameInput,
  index: number,
): Record<string, unknown> {
  const name = requiredText(
    input.name,
    `Варіант назви №${index + 1} не може бути порожнім.`,
  );
  const originalText = exactSourceText(input.originalText, name);
  const aggregatePrecision = normalizeDatePrecision(input.datePrecision);
  const validFromPrecision = nullableDatePrecision(input.validFromPrecision)
    ?? (aggregatePrecision === "unknown" ? null : aggregatePrecision);
  const validToPrecision = nullableDatePrecision(input.validToPrecision)
    ?? (aggregatePrecision === "unknown" ? null : aggregatePrecision);
  return {
    name,
    original_text: originalText,
    language_code: nullableText(input.languageCode),
    name_type: normalizePlaceNameType(input.nameType, "variant"),
    valid_from: nullableText(input.validFrom),
    valid_to: nullableText(input.validTo),
    valid_from_text: nullableExactText(input.validFromText),
    valid_to_text: nullableExactText(input.validToText),
    valid_from_precision: validFromPrecision,
    valid_to_precision: validToPrecision,
    source_document_id: nullableText(input.sourceDocumentId),
    source_finding_id: nullableText(input.sourceFindingId),
    citation_id: nullableText(input.citationId),
    source_reference: nullableExactText(input.sourceReference),
    confidence: confidence(input.confidence),
    is_primary: input.isPrimary === true,
    note: exactText(input.note),
    metadata: record(input.metadata),
  };
}

function hierarchyResolution(
  data: unknown,
  fallbackPlaceId: string,
  fallbackAtDate: string | null,
  maxDepth: number,
): PlaceHierarchyResolution {
  const rawArray = Array.isArray(data) ? data : null;
  const first = rawArray?.length === 1 ? record(rawArray[0]) : {};
  const firstLooksLikeEnvelope = Object.keys(first).some((key) => [
    "status",
    "resolution_status",
    "hierarchy",
    "path",
    "nodes",
    "candidates",
  ].includes(key));
  const envelope = rawArray
    ? (firstLooksLikeEnvelope ? first : {})
    : firstResponseRecord(data, ["resolution", "result"]);
  const hierarchyInput = rawArray && !firstLooksLikeEnvelope
    ? rawArray
    : value(envelope, "hierarchy", "path", "nodes");
  const hierarchy = hierarchyNodes(hierarchyInput, maxDepth);
  const candidates = records(value(envelope, "candidates", "alternatives", "matches"))
    .map((candidate, index) => hierarchyCandidate(candidate, index, maxDepth))
    .filter((candidate): candidate is PlaceHierarchyCandidate => Boolean(candidate));
  const responsePlaceId = text(value(envelope, "placeId", "place_id"), fallbackPlaceId);
  const nestedPlace = record(value(envelope, "place"));
  const place = Object.keys(nestedPlace).length > 0
    ? placeSummary(nestedPlace, { id: responsePlaceId })
    : placeSummary(envelope, { id: responsePlaceId });
  const atDate = nullableText(value(envelope, "atDate", "at_date")) ?? fallbackAtDate;
  const rawStatus = text(value(envelope, "status", "resolutionStatus", "resolution_status"))
    .toLowerCase();
  const cycleDetected = booleanValue(
    value(envelope, "cycleDetected", "cycle_detected"),
    rawStatus === "cycle_detected",
  );
  const truncated = booleanValue(
    value(envelope, "truncated", "truncatedDetected", "truncated_detected"),
    rawStatus === "truncated",
  );
  const ambiguousDetected = booleanValue(
    value(envelope, "ambiguous", "ambiguousDetected", "ambiguous_detected"),
    rawStatus === "ambiguous",
  );
  const requiresExactDate = booleanValue(
    value(envelope, "requiresExactDate", "requires_exact_date"),
    rawStatus === "ambiguous_period",
  );
  const effectiveStatus = rawStatus
    || (cycleDetected ? "cycle_detected" : truncated ? "truncated" : ambiguousDetected ? "ambiguous" : "");
  const status = resolutionStatus(effectiveStatus, hierarchy, candidates);
  const message = text(value(envelope, "message", "reason", "detail"));
  const responseMaxDepth = boundedInteger(
    value(envelope, "maxDepth", "max_depth"),
    1,
    HISTORICAL_PLACE_HIERARCHY_MAX_DEPTH,
    maxDepth,
  );
  const diagnostics = {
    maxDepth: responseMaxDepth,
    cycleDetected,
    ambiguousDetected,
    requiresExactDate,
    truncated,
  };

  if (status === "resolved") {
    return {
      status,
      placeId: responsePlaceId,
      atDate,
      place,
      ...diagnostics,
      hierarchy,
      candidates: [],
      message: null,
    };
  }
  if (status === "ambiguous") {
    return {
      status,
      placeId: responsePlaceId,
      atDate,
      place,
      ...diagnostics,
      hierarchy,
      candidates,
      message: message || hierarchyIssueMessage(effectiveStatus),
    };
  }
  return {
    status: "unknown",
    placeId: responsePlaceId,
    atDate,
    place,
    ...diagnostics,
    hierarchy: [],
    candidates: [],
    message: message || "Для вибраної дати адміністративну ієрархію ще не визначено.",
  };
}

function hierarchyNodes(input: unknown, maxDepth: number): PlaceHierarchyNode[] {
  return records(input)
    .map((row, index) => hierarchyNode(row, index))
    .filter((node): node is PlaceHierarchyNode => Boolean(node))
    .slice(0, maxDepth);
}

function hierarchyNode(
  row: Record<string, unknown>,
  index: number,
): PlaceHierarchyNode | null {
  const nested = record(value(row, "place", "parent", "ancestor", "parent_place"));
  const source = Object.keys(nested).length > 0
    ? { ...row, ...nested }
    : {
      ...row,
      id: value(row, "parentPlaceId", "parent_place_id", "placeId", "place_id", "id"),
      canonical_name: value(
        row,
        "parentCanonicalName",
        "parent_canonical_name",
        "parentName",
        "parent_name",
        "canonicalName",
        "canonical_name",
        "name",
      ),
      modern_name: value(row, "parentModernName", "parent_modern_name", "modernName", "modern_name"),
      place_type: value(row, "parentPlaceType", "parent_place_type", "placeType", "place_type"),
    };
  const place = placeSummary(source);
  if (!place) return null;
  return {
    place,
    relationId: nullableText(value(row, "relationId", "relation_id")),
    relationType: text(
      value(row, "relationType", "relation_type"),
      "administrative_parent",
    ),
    depth: nonNegativeInteger(value(row, "depth", "level"), index),
    validFrom: nullableText(value(row, "validFrom", "valid_from")),
    validTo: nullableText(value(row, "validTo", "valid_to")),
    validFromText: nullableExactText(value(row, "validFromText", "valid_from_text")),
    validToText: nullableExactText(value(row, "validToText", "valid_to_text")),
    sourceId: nullableText(value(row, "sourceId", "source_id")),
    confidence: confidence(value(row, "confidence")),
    cycleDetected: booleanValue(value(row, "cycleDetected", "cycle_detected"), false),
    path: stringArray(value(row, "path")),
  };
}

function hierarchyCandidate(
  row: Record<string, unknown>,
  index: number,
  maxDepth: number,
): PlaceHierarchyCandidate | null {
  const hierarchy = hierarchyNodes(
    value(row, "hierarchy", "path", "nodes"),
    maxDepth,
  );
  const id = text(value(row, "id", "candidateId", "candidate_id"), `candidate-${index + 1}`);
  const label = text(
    value(row, "label", "name"),
    hierarchy.map((node) => node.place.canonicalName).join(" → "),
  );
  if (!label && hierarchy.length === 0) return null;
  return {
    id,
    label,
    confidence: confidence(value(row, "confidence")),
    reason: text(value(row, "reason", "message")),
    hierarchy,
  };
}

function placeSummary(
  input: unknown,
  fallback: Partial<PlaceSummary> = {},
): PlaceSummary | null {
  const outer = record(input);
  const nested = record(value(outer, "place"));
  const row = Object.keys(nested).length > 0 ? { ...nested, ...outer } : outer;
  const id = text(value(row, "id", "placeId", "place_id"), fallback.id ?? "");
  const matchedName = text(
    value(row, "matchedName", "matched_name", "matchName", "match_name"),
    fallback.matchedName ?? "",
  );
  const canonicalName = text(
    value(row, "canonicalName", "canonical_name", "name", "label"),
    fallback.canonicalName ?? matchedName,
  );
  if (!id || !canonicalName) return null;

  const projectId = nullableText(
    value(row, "projectId", "project_id"),
  ) ?? fallback.projectId ?? null;
  const coordinates = responseCoordinates(row, fallback.latitude, fallback.longitude);
  const rawNames = arrayValue(
    value(
      row,
      "names",
      "placeNames",
      "place_names",
      "alternativeNames",
      "alternative_names",
      "historicalNames",
      "historical_names",
    ),
  );
  const names = rawNames.length > 0
    ? rawNames
      .map((item, index) => placeName(item, id, index))
      .filter((name): name is PlaceName => Boolean(name))
    : fallback.names ?? [];
  const rawHierarchy = value(row, "hierarchy", "administrativeHierarchy", "administrative_hierarchy");
  const hierarchyEnvelope = record(rawHierarchy);
  const hierarchy = hierarchyNodes(
    Array.isArray(rawHierarchy)
      ? rawHierarchy
      : value(hierarchyEnvelope, "hierarchy", "path", "nodes"),
    HISTORICAL_PLACE_HIERARCHY_DEFAULT_MAX_DEPTH,
  );
  const fallbackScope = fallback.scope ?? (projectId ? "project" : "global");
  const redirectRow = record(value(row, "redirect"));
  const redirectTargetPlaceId = text(
    value(redirectRow, "targetPlaceId", "target_place_id"),
  );
  const redirectFinalTargetPlaceId = text(
    value(redirectRow, "finalTargetPlaceId", "final_target_place_id"),
    redirectTargetPlaceId,
  );
  const isRedirect = booleanValue(
    value(row, "isRedirect", "is_redirect"),
    Boolean(redirectFinalTargetPlaceId),
  );

  return {
    id,
    projectId,
    scope: normalizeScope(value(row, "scope", "placeScope", "place_scope"), fallbackScope),
    status: normalizePlaceStatus(value(row, "status"), fallback.status),
    verificationStatus: normalizeVerificationStatus(
      value(row, "verificationStatus", "verification_status", "verification"),
      fallback.verificationStatus,
    ),
    isPublic: booleanValue(value(row, "isPublic", "is_public"), fallback.isPublic ?? false),
    isRedirect,
    mergedIntoPlaceId: nullableText(value(row, "mergedIntoPlaceId", "merged_into_place_id"))
      ?? (redirectTargetPlaceId || fallback.mergedIntoPlaceId || null),
    redirect: isRedirect && redirectFinalTargetPlaceId
      ? {
          targetPlaceId: redirectTargetPlaceId || redirectFinalTargetPlaceId,
          finalTargetPlaceId: redirectFinalTargetPlaceId,
          hopCount: nonNegativeInteger(value(redirectRow, "hopCount", "hop_count"), 0),
        }
      : fallback.redirect ?? null,
    publishedAt: nullableText(value(row, "publishedAt", "published_at"))
      ?? fallback.publishedAt ?? null,
    canonicalName,
    displayName: text(
      value(row, "displayName", "display_name"),
      fallback.displayName ?? canonicalName,
    ),
    atDate: nullableText(value(row, "atDate", "at_date")) ?? fallback.atDate ?? null,
    modernName: text(
      value(row, "modernName", "modern_name"),
      fallback.modernName ?? "",
    ),
    placeType: text(
      value(row, "placeType", "place_type", "type"),
      fallback.placeType ?? "other",
    ),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    currentCountry: displayText(
      value(row, "currentCountry", "current_country", "country"),
      fallback.currentCountry ?? "",
    ),
    currentAdmin: displayText(
      value(row, "currentAdmin", "current_admin", "administrativeContext", "administrative_context"),
      fallback.currentAdmin ?? "",
    ),
    hierarchy: hierarchy.length > 0 ? hierarchy : fallback.hierarchy ?? [],
    wikidataId: nullableText(value(row, "wikidataId", "wikidata_id"))
      ?? fallback.wikidataId ?? null,
    geonamesId: nullableText(value(row, "geonamesId", "geonames_id"))
      ?? fallback.geonamesId ?? null,
    externalIds: externalIds(value(row, "externalIds", "external_ids"), fallback.externalIds),
    distanceKm: nullableFiniteNumber(value(row, "distanceKm", "distance_km"))
      ?? fallback.distanceKm ?? null,
    ancestorPlaceId: nullableText(value(row, "ancestorPlaceId", "ancestor_place_id"))
      ?? fallback.ancestorPlaceId ?? null,
    description: text(value(row, "description"), fallback.description ?? ""),
    matchedName,
    matchedNameType: nullablePlaceNameType(
      value(row, "matchedNameType", "matched_name_type", "matchType", "match_type"),
      fallback.matchedNameType,
    ),
    names,
    lockVersion: nonNegativeInteger(
      value(row, "lockVersion", "lock_version"),
      fallback.lockVersion ?? 0,
    ),
    createdAt: text(value(row, "createdAt", "created_at"), fallback.createdAt ?? ""),
    updatedAt: text(value(row, "updatedAt", "updated_at"), fallback.updatedAt ?? ""),
  };
}

function placeName(input: unknown, placeId: string, index: number): PlaceName | null {
  if (typeof input === "string") {
    const name = text(input);
    if (!name) return null;
    return {
      id: `${placeId}:name:${index}`,
      placeId,
      name,
      originalText: name,
      languageCode: "",
      nameType: "historical",
      validFrom: null,
      validTo: null,
      validFromText: null,
      validToText: null,
      validFromPrecision: null,
      validToPrecision: null,
      datePrecision: "unknown",
      sourceDocumentId: null,
      sourceFindingId: null,
      citationId: null,
      sourceReference: null,
      confidence: 50,
      isPrimary: false,
      note: "",
      metadata: {},
      lockVersion: 0,
    };
  }
  const row = record(input);
  const name = text(value(row, "name", "value", "label"));
  if (!name) return null;
  return {
    id: text(value(row, "id", "nameId", "name_id"), `${placeId}:name:${index}`),
    placeId: text(value(row, "placeId", "place_id"), placeId),
    name,
    originalText: exactSourceText(value(row, "originalText", "original_text"), name),
    languageCode: text(value(row, "languageCode", "language_code", "language")),
    nameType: normalizePlaceNameType(value(row, "nameType", "name_type", "type")),
    validFrom: nullableText(value(row, "validFrom", "valid_from")),
    validTo: nullableText(value(row, "validTo", "valid_to")),
    validFromText: nullableExactText(value(row, "validFromText", "valid_from_text")),
    validToText: nullableExactText(value(row, "validToText", "valid_to_text")),
    validFromPrecision: nullableDatePrecision(value(
      row,
      "validFromPrecision",
      "valid_from_precision",
    )),
    validToPrecision: nullableDatePrecision(value(
      row,
      "validToPrecision",
      "valid_to_precision",
    )),
    datePrecision: aggregateDatePrecision(row),
    sourceDocumentId: nullableText(value(row, "sourceDocumentId", "source_document_id")),
    sourceFindingId: nullableText(value(row, "sourceFindingId", "source_finding_id")),
    citationId: nullableText(value(row, "citationId", "citation_id")),
    sourceReference: nullableExactText(value(row, "sourceReference", "source_reference")),
    confidence: confidence(value(row, "confidence")),
    isPrimary: value(row, "isPrimary", "is_primary") === true,
    note: exactText(value(row, "note", "notes")),
    metadata: record(value(row, "metadata")),
    lockVersion: nonNegativeInteger(value(row, "lockVersion", "lock_version"), 0),
  };
}

function responseRows(input: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(input)) {
    if (input.length === 1) {
      const wrapper = record(input[0]);
      const nested = value(wrapper, ...keys);
      if (Array.isArray(nested)) return records(nested);
    }
    return records(input);
  }
  const wrapper = record(input);
  const nested = value(wrapper, ...keys);
  if (Array.isArray(nested)) return records(nested);
  const data = value(wrapper, "data");
  if (Array.isArray(data)) return records(data);
  return Object.keys(wrapper).length > 0 ? [wrapper] : [];
}

function firstResponseRecord(input: unknown, keys: string[]): Record<string, unknown> {
  const first = Array.isArray(input) ? input[0] : input;
  if (typeof first === "string") return { id: first };
  const wrapper = record(first);
  const nested = value(wrapper, ...keys);
  // A direct JSON response can legitimately contain fields such as `name`.
  // Treat a scalar as an envelope only when it is the sole response field;
  // otherwise add_place_name_v1({ name: "…", ... }) would be reduced to an
  // id-only object and the successfully created name would look like a failure.
  if (typeof nested === "string" && Object.keys(wrapper).length === 1) return { id: nested };
  const nestedRecord = record(nested);
  if (Object.keys(nestedRecord).length > 0) return nestedRecord;
  const items = value(wrapper, "items", "places", "results");
  if (Array.isArray(items)) return record(items[0]);
  return wrapper;
}

function resolutionStatus(
  raw: string,
  hierarchy: PlaceHierarchyNode[],
  candidates: PlaceHierarchyCandidate[],
): PlaceHierarchyResolution["status"] {
  if (["resolved", "exact", "single"].includes(raw)) return "resolved";
  if ([
    "ambiguous",
    "multiple",
    "needs_review",
    "cycle_detected",
    "truncated",
    "ambiguous_period",
  ].includes(raw)) return "ambiguous";
  if (["unknown", "unresolved", "not_found", "missing"].includes(raw)) return "unknown";
  if (candidates.length > 0) return "ambiguous";
  return hierarchy.length > 0 ? "resolved" : "unknown";
}

function hierarchyIssueMessage(rawStatus: string): string {
  if (rawStatus === "ambiguous_period") {
    return "Упродовж вибраного року діяло кілька адміністративних ієрархій. Оберіть точну дату, щоб визначити одну з них.";
  }
  if (rawStatus === "cycle_detected") {
    return "В адміністративній ієрархії виявлено цикл. Частковий шлях не можна вважати підтвердженим.";
  }
  if (rawStatus === "truncated") {
    return "Адміністративна ієрархія довша за безпечну межу запиту. Показано лише частковий шлях.";
  }
  return "Для цієї дати знайдено кілька можливих адміністративних ієрархій.";
}

function normalizeScope(input: unknown, fallback: PlaceScope): PlaceScope {
  const value = text(input).toLowerCase();
  if (placeScopes.has(value as PlaceScope)) return value as PlaceScope;
  if (["public", "shared", "catalogue", "catalog"].includes(value)) return "global";
  if (["private", "local"].includes(value)) return "project";
  return fallback;
}

function normalizePlaceStatus(input: unknown, fallback: PlaceStatus = "active"): PlaceStatus {
  const value = text(input).toLowerCase();
  if (placeStatuses.has(value as PlaceStatus)) return value as PlaceStatus;
  if (["draft", "pending", "pending_review", "unresolved"].includes(value)) return "needs_review";
  if (["redirected", "duplicate"].includes(value)) return "merged";
  if (["inactive", "deleted"].includes(value)) return "archived";
  return fallback;
}

function normalizeVerificationStatus(
  input: unknown,
  fallback: PlaceVerificationStatus = "unverified",
): PlaceVerificationStatus {
  const value = text(input).toLowerCase();
  if (verificationStatuses.has(value as PlaceVerificationStatus)) {
    return value as PlaceVerificationStatus;
  }
  if (["likely", "suggested", "provisional"].includes(value)) return "plausible";
  if (["confirmed", "corroborated", "proven"].includes(value)) return "verified";
  if (["rejected", "disproven"].includes(value)) return "disputed";
  return fallback;
}

function normalizePlaceNameType(input: unknown, fallback: PlaceNameType = "other"): PlaceNameType {
  const value = text(input).toLowerCase().replaceAll("-", "_");
  if (placeNameTypes.has(value as PlaceNameType)) return value as PlaceNameType;
  if (["alternate", "alternative", "alias", "spelling_variant"].includes(value)) return "variant";
  if (["error", "document_error", "incorrect"].includes(value)) return "source_error";
  if (["pre1918", "pre_1918", "old_orthography"].includes(value)) return "pre_reform";
  if (["ussr", "soviet_era"].includes(value)) return "soviet";
  if (["polish", "latin"].includes(value)) return "historical";
  return fallback;
}

function nullablePlaceNameType(
  input: unknown,
  fallback: PlaceNameType | null | undefined,
): PlaceNameType | null {
  if (input === null || input === undefined || text(input) === "") return fallback ?? null;
  return normalizePlaceNameType(input);
}

function normalizeDatePrecision(input: unknown): PlaceNameDatePrecision {
  const value = text(input).toLowerCase();
  if (datePrecisions.has(value as PlaceNameDatePrecision)) return value as PlaceNameDatePrecision;
  if (value === "exact") return "day";
  if (["approximate", "about"].includes(value)) return "circa";
  if (["between", "interval"].includes(value)) return "range";
  return "unknown";
}

function nullableDatePrecision(input: unknown): PlaceNameDatePrecision | null {
  if (input === null || input === undefined || text(input) === "") return null;
  return normalizeDatePrecision(input);
}

function aggregateDatePrecision(row: Record<string, unknown>): PlaceNameDatePrecision {
  const direct = nullableDatePrecision(value(row, "datePrecision", "date_precision"));
  if (direct) return direct;
  const from = nullableDatePrecision(value(row, "validFromPrecision", "valid_from_precision"));
  const to = nullableDatePrecision(value(row, "validToPrecision", "valid_to_precision"));
  if (from && to && from !== to) return "range";
  return from ?? to ?? "unknown";
}

function createCoordinates(
  latitudeInput: unknown,
  longitudeInput: unknown,
): { latitude: number | null; longitude: number | null } {
  const latitudeMissing = latitudeInput === null || latitudeInput === undefined || latitudeInput === "";
  const longitudeMissing = longitudeInput === null || longitudeInput === undefined || longitudeInput === "";
  if (latitudeMissing && longitudeMissing) return { latitude: null, longitude: null };
  if (latitudeMissing || longitudeMissing) {
    throw new HistoricalPlacesServiceError(
      "create",
      "Для координат потрібно вказати і широту, і довготу.",
      "INVALID_COORDINATES",
    );
  }
  const latitude = Number(latitudeInput);
  const longitude = Number(longitudeInput);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new HistoricalPlacesServiceError(
      "create",
      "Координати місця мають бути числами: широта від −90 до 90, довгота від −180 до 180.",
      "INVALID_COORDINATES",
    );
  }
  return { latitude, longitude };
}

function responseCoordinates(
  row: Record<string, unknown>,
  fallbackLatitude?: number | null,
  fallbackLongitude?: number | null,
): { latitude: number | null; longitude: number | null } {
  const nested = record(value(row, "coordinates", "geo", "location"));
  const tuple = Array.isArray(value(row, "coordinates"))
    ? value(row, "coordinates") as unknown[]
    : [];
  const rawLatitude = value(row, "latitude", "lat")
    ?? value(nested, "latitude", "lat")
    ?? tuple[1]
    ?? fallbackLatitude;
  const rawLongitude = value(row, "longitude", "lng", "lon")
    ?? value(nested, "longitude", "lng", "lon")
    ?? tuple[0]
    ?? fallbackLongitude;
  const latitude = finiteCoordinate(rawLatitude, -90, 90);
  const longitude = finiteCoordinate(rawLongitude, -180, 180);
  return latitude === null || longitude === null
    ? { latitude: null, longitude: null }
    : { latitude, longitude };
}

function finiteCoordinate(input: unknown, min: number, max: number): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = Number(input);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function nullableFiniteNumber(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function confidence(input: unknown): number {
  if (input === null || input === undefined || input === "") return 50;
  const value = Number(input);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
}

function externalIds(
  input: unknown,
  fallback: Record<string, string> = {},
): Record<string, string> {
  const row = record(input);
  if (Object.keys(row).length === 0) return { ...fallback };
  return Object.fromEntries(
    Object.entries(row)
      .map(([key, value]) => [key.trim(), text(value)] as const)
      .filter(([key, value]) => Boolean(key && value)),
  );
}

function isMissingRpcCode(code: string): boolean {
  return code === "PGRST202" || code === "42883";
}

function isMissingRpcError(error: unknown): boolean {
  const details = errorDetails(error);
  return isMissingRpcCode(details.code)
    || (details.text.includes("schema cache") && details.text.includes("function"));
}

function rpcServiceError(
  operation: HistoricalPlacesOperation,
  error: unknown,
): HistoricalPlacesServiceError {
  const { code, message, text: details } = errorDetails(error);
  const actions: Record<HistoricalPlacesOperation, string> = {
    search: "виконати пошук історичних місць",
    create: "створити історичне місце",
    resolve: "визначити адміністративну ієрархію місця",
    profile: "завантажити профіль історичного місця",
    names: "завантажити історичні назви місця",
    history: "завантажити адміністративну історію місця",
    boundaries: "завантажити історичні межі місця",
    "event-link": "зберегти прив’язку місця до події",
    related: "завантажити пов’язані місця",
    parishes: "завантажити парафії місця",
    archives: "завантажити архівні ресурси місця",
    documents: "завантажити документи місця",
    people: "завантажити пов’язаних осіб",
    events: "завантажити події місця",
    map: "завантажити карту й часовий контекст місця",
    "merge-preview": "підготувати перегляд об’єднання місць",
    merge: "об’єднати місця",
    "legacy-import": "перенести текстові місця з подій осіб",
    write: "зберегти зміни історичного місця",
    audit: "завантажити історію змін місця",
  };
  const action = actions[operation];
  if (code === "PGRST202" || code === "42883"
    || (details.includes("schema cache") && details.includes("_places_v1"))) {
    return new HistoricalPlacesServiceError(
      operation,
      `Не вдалося ${action}: серверне оновлення історичних місць ще не застосоване.`,
      code,
      error,
    );
  }
  if (code === "42501" || code === "PGRST301") {
    return new HistoricalPlacesServiceError(
      operation,
      `Не вдалося ${action}: у вас немає доступу до цього проєкту або місця.`,
      code,
      error,
    );
  }
  if (code === "23505") {
    return new HistoricalPlacesServiceError(
      operation,
      "Таке місце вже існує. Знайдіть його в каталозі замість створення дубля.",
      code,
      error,
    );
  }
  if (code === "40001" || details.includes("place_merge_version_conflict")) {
    return new HistoricalPlacesServiceError(
      operation,
      operation === "merge"
        ? "Місця змінилися після попереднього перегляду. Оновіть перегляд і перевірте об’єднання ще раз."
        : "Запис уже змінив інший користувач. Оновіть дані й повторіть редагування.",
      code || "40001",
      error,
    );
  }
  if (code === "P0002" || details.includes("place_not_found")) {
    return new HistoricalPlacesServiceError(
      operation,
      "Місце не знайдено або воно вже недоступне.",
      code,
      error,
    );
  }
  if (code === "22023") {
    return new HistoricalPlacesServiceError(
      operation,
      inputErrorMessage(details, action),
      code,
      error,
    );
  }
  if (code === "57014" || details.includes("timeout")) {
    return new HistoricalPlacesServiceError(
      operation,
      `Не вдалося ${action}: сервер не встиг відповісти. Спробуйте уточнити запит.`,
      code,
      error,
    );
  }
  return new HistoricalPlacesServiceError(
    operation,
    `Не вдалося ${action}${message ? `: ${message}` : "."}`,
    code,
    error,
  );
}

function inputErrorMessage(details: string, action: string): string {
  if (details.includes("merge_places_must_differ")) {
    return "Для об’єднання потрібно вибрати два різні місця.";
  }
  if (details.includes("merge_place_scope_mismatch")) {
    return "Можна об’єднати лише приватні місця одного проєкту.";
  }
  if (details.includes("merge_target_archived") || details.includes("merge_redirect_place_forbidden")) {
    return "Вибране місце не може бути цільовим для об’єднання.";
  }
  if (details.includes("place_query_too_long")) {
    return "Пошуковий запит надто довгий. Скоротіть його до 200 символів.";
  }
  if (details.includes("place_canonical_name_invalid")) {
    return "Основна назва місця має містити від 1 до 500 символів.";
  }
  if (details.includes("place_coordinates_invalid")) {
    return "Перевірте координати: потрібні і широта, і довгота в допустимих межах.";
  }
  if (details.includes("place_names_limit_exceeded")) {
    return `До одного місця можна додати не більше ${HISTORICAL_PLACE_CREATE_MAX_NAMES} назв за один раз.`;
  }
  if (details.includes("place_name_valid_period_invalid")) {
    return "У варіанті назви початкова дата не може бути пізнішою за кінцеву.";
  }
  if (details.includes("place_name_value_invalid")) {
    return "Перевірте назву та її точне написання в джерелі.";
  }
  if (details.includes("place_name_confidence_invalid")) {
    return "Достовірність назви має бути числом від 0 до 100.";
  }
  if (details.includes("place_input_too_long") || details.includes("place_input_too_large")) {
    return "Дані місця надто великі. Скоротіть опис або кількість додаткових відомостей.";
  }
  return `Не вдалося ${action}: перевірте введені дані.`;
}

function errorDetails(error: unknown): { code: string; message: string; text: string } {
  const row = record(error);
  const code = text(row.code).toUpperCase();
  const message = text(row.message);
  return {
    code,
    message,
    text: [message, text(row.details), text(row.hint)].filter(Boolean).join(" ").toLowerCase(),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("The historical places request was aborted.", "AbortError");
}

function requiredText(
  input: unknown,
  message: string,
  operation: HistoricalPlacesOperation = "create",
): string {
  const value = text(input);
  if (value) return value;
  throw new HistoricalPlacesServiceError(operation, message, "INVALID_INPUT");
}

/** Validates non-blank evidence text without trimming the preserved value. */
function requiredExactText(
  input: unknown,
  message: string,
  operation: HistoricalPlacesOperation,
): string {
  if (typeof input === "string" && input.trim()) return input;
  throw new HistoricalPlacesServiceError(operation, message, "INVALID_INPUT");
}

function boundedInteger(
  input: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (input === null || input === undefined || input === "") return fallback;
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function positiveLockVersion(
  input: unknown,
  operation: "merge" | "write" = "merge",
): number {
  const value = Number(input);
  if (Number.isInteger(value) && value > 0) return value;
  throw new HistoricalPlacesServiceError(
    operation,
    operation === "merge"
      ? "Попередній перегляд об’єднання застарів. Оновіть його перед підтвердженням."
      : "Версія запису відсутня. Оновіть дані перед редагуванням.",
    "INVALID_INPUT",
  );
}

function nonNegativeInteger(input: unknown, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function nullableInteger(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const result = Number(input);
  return Number.isFinite(result) ? Math.trunc(result) : null;
}

function arrayValue(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function stringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.map((item) => text(item)).filter(Boolean) : [];
}

function records(input: unknown): Record<string, unknown>[] {
  return Array.isArray(input)
    ? input.map(record).filter((item) => Object.keys(item).length > 0)
    : [];
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function value(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return undefined;
}

function text(input: unknown, fallback = ""): string {
  if (typeof input === "string") return input.trim() || fallback;
  if (typeof input === "number" || typeof input === "bigint") return String(input);
  return fallback;
}

function exactText(input: unknown, fallback = ""): string {
  return typeof input === "string" ? input : fallback;
}

function nullableExactText(input: unknown): string | null {
  const value = exactText(input);
  return value.length > 0 ? value : null;
}

function exactSourceText(input: unknown, fallback: string): string {
  const value = exactText(input, fallback);
  return value.trim() ? value : fallback;
}

function nullableText(input: unknown): string | null {
  return text(input) || null;
}

function booleanValue(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  const value = text(input).toLowerCase();
  if (["true", "1", "yes"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  return fallback;
}

function displayText(input: unknown, fallback = ""): string {
  const direct = text(input);
  if (direct) return direct;
  if (Array.isArray(input)) {
    return input.map((item) => displayText(item)).filter(Boolean).join(", ") || fallback;
  }
  const row = record(input);
  const labelled = text(value(row, "label", "displayName", "display_name", "name"));
  if (labelled) return labelled;
  const values = Object.values(row).map((item) => text(item)).filter(Boolean);
  return values.join(", ") || fallback;
}
