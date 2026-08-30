import type {
  ContextAssertionKind,
  ContextEvidenceKind,
  ContextEvidenceStatus,
  ContextPrivacyStatus,
  ContextRelationCategory,
  ContextRelationDirectionality,
  ContextRelationEvidence,
  ContextRelationEvidenceV2,
  ContextRelationEvidenceV2Draft,
  ContextRelationType,
  ContextRelationV2,
  ContextRelationV2Draft,
  ChurchRoleNetworkGroup,
  ChurchRoleNetworkRoleCount,
  ChurchRoleNetworkSample,
  ChurchRoleNetworkSource,
  DocumentaryGraphEdge,
  DocumentaryGraphEntityType,
  DocumentaryGraphNode,
  DocumentaryGraphNodeId,
  ContextGraphPersonEdge,
  ContextGraphPersonNode,
  PersonContextGraphFilters,
  PersonContextGraphSnapshot,
  PersonContextCooccurrence,
  PersonContextCooccurrenceFilters,
  PersonContextCooccurrenceSource,
  PersonContextCooccurrencesPage,
  PersonContextRelation,
  PersonContextRelationDraft,
  PersonContextRelationsPage,
  PersonChurchRoleNetworkFilters,
  PersonChurchRoleNetworkItem,
  PersonChurchRoleNetworkPage,
  PersonDocumentaryGraphFilters,
  PersonDocumentaryGraphSnapshot,
  PersonResearchGraphFilters,
  PersonResearchGraphSnapshot,
  ResearchGraphEdge,
  ResearchGraphEntityType,
  ResearchGraphNode,
  ResearchGraphNodeId,
  ResearchGraphPlaceOption,
  ResearchGraphSavedView,
  ResearchGraphSavedViewDraft,
  ResearchGraphSavedViewFilters,
  ResearchGraphSavedViewsPage,
  ResearchGraphSavedViewState,
  ResearchGraphViewShare,
  ResearchGraphViewShareCreated,
  ResearchGraphViewShareDraft,
  ResearchGraphViewSharesPage,
  SharedResearchGraphEdge,
  SharedResearchGraphNode,
  SharedResearchGraphView,
} from "../types/contextGraph.ts";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest.ts";
import { isResearchGraphShareToken } from "../utils/appRoutes.ts";
import { getAnonymousSupabaseClient, getSupabaseClient } from "./supabaseAuth.ts";
import {
  mapContextRelationEvidencePage,
  mapContextRelationEvidenceV2,
} from "./contextRelationEvidenceMapper.ts";

type JsonRecord = Record<string, unknown>;

export async function listContextRelationTypes(
  projectId: string,
  includeInactive = false,
): Promise<ContextRelationType[]> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("list_context_relation_types_v1", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_include_inactive: includeInactive,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  return rows(data).map(mapContextRelationType).filter((item) => Boolean(item.id));
}

export async function listPersonContextRelations(
  projectId: string,
  personId: string,
  options: { includeDeleted?: boolean; limit?: number; offset?: number } = {},
): Promise<PersonContextRelationsPage> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("list_person_context_relation_summaries_v1", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_person_id: requiredId(personId, "особу"),
      p_include_deleted: options.includeDeleted ?? false,
      p_limit: boundedInteger(options.limit, 1, 500, 100),
      p_offset: boundedInteger(options.offset, 0, 100_000, 0),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const payload = record(data);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    items: items.map(mapPersonContextRelation).filter((item) => Boolean(item.id)),
    total: integer(payload.total),
    revision: integer(payload.revision),
  };
}

export async function getPersonContextGraph(
  projectId: string,
  centerPersonId: string,
  filters: PersonContextGraphFilters = {},
): Promise<PersonContextGraphSnapshot> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("get_person_context_graph_v1", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_center_person_id: requiredId(centerPersonId, "центральну особу"),
      p_depth: 1,
      p_max_nodes: boundedInteger(filters.maxNodes, 1, 100, 100),
      p_relation_type_ids: nonEmptyTexts(filters.relationTypeIds),
      p_evidence_statuses: nonEmptyTexts(filters.evidenceStatuses),
      p_valid_from: nullableText(filters.validFrom),
      p_valid_to: nullableText(filters.validTo),
      p_max_edges: boundedInteger(filters.maxEdges, 1, 500, 250),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const payload = record(data);
  return {
    centerPersonId: text(payload.centerPersonId ?? payload.center_person_id, centerPersonId),
    nodes: (Array.isArray(payload.nodes) ? payload.nodes : [])
      .map(mapContextGraphPersonNode)
      .filter((item) => Boolean(item.id)),
    edges: (Array.isArray(payload.edges) ? payload.edges : [])
      .map(mapContextGraphPersonEdge)
      .filter((item) => Boolean(item.id)),
    revision: integer(payload.revision),
    truncated: booleanValue(payload.truncated),
    edgesTruncated: booleanValue(payload.edgesTruncated ?? payload.edges_truncated),
  };
}

/**
 * Returns a bounded calculated ranking of people who occur in the same
 * findings, documents or structured events as the selected person. The RPC is
 * read-only: these rows are not persisted as person-to-person relations.
 */
export async function listPersonContextCooccurrencesV1(
  projectId: string,
  centerPersonId: string,
  filters: PersonContextCooccurrenceFilters = {},
): Promise<PersonContextCooccurrencesPage> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedPersonId = requiredId(centerPersonId, "центральну особу");
  const yearFrom = optionalBoundedInteger(filters.yearFrom, 1, 9999);
  const yearTo = optionalBoundedInteger(filters.yearTo, 1, 9999);
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    throw new Error("Початковий рік не може бути пізнішим за кінцевий.");
  }

  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("list_person_context_cooccurrences_v1", {
      p_project_id: normalizedProjectId,
      p_person_id: normalizedPersonId,
      p_year_from: yearFrom,
      p_year_to: yearTo,
      p_place_id: nullableText(filters.placeId),
      p_min_shared: boundedInteger(filters.minShared, 1, 1000, 1),
      p_limit: boundedInteger(filters.limit, 1, 100, 20),
      p_offset: boundedInteger(filters.offset, 0, 100_000, 0),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;

  const payload = record(data);
  const returnedCenterId = text(payload.centerPersonId ?? payload.center_person_id).trim();
  if (returnedCenterId && returnedCenterId !== normalizedPersonId) {
    throw new Error("Сервер повернув спільні згадки для іншої центральної особи.");
  }
  const returnedAlgorithm = text(payload.algorithmVersion ?? payload.algorithm_version).trim();
  if (returnedAlgorithm && returnedAlgorithm !== "cooccurrence_v1") {
    throw new Error("Сервер повернув непідтримувану версію розрахунку спільних згадок.");
  }

  const uniqueItems = new Map<string, PersonContextCooccurrence>();
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  rawItems.forEach((value) => {
    const item = mapPersonContextCooccurrence(value, normalizedPersonId);
    if (item && !uniqueItems.has(item.personId)) uniqueItems.set(item.personId, item);
  });

  return {
    centerPersonId: normalizedPersonId,
    algorithmVersion: "cooccurrence_v1",
    items: [...uniqueItems.values()],
    total: nonNegativeInteger(payload.total),
    truncated: booleanValue(payload.truncated),
  };
}

/**
 * Returns a bounded research projection of repeated church-role links grouped
 * by normalized surname. Surname clusters are hints only and are never written
 * to the genealogical family graph.
 */
export async function listPersonChurchRoleNetworkV1(
  projectId: string,
  centerPersonId: string,
  filters: PersonChurchRoleNetworkFilters = {},
): Promise<PersonChurchRoleNetworkPage> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedPersonId = requiredId(centerPersonId, "центральну особу");
  const yearFrom = optionalBoundedInteger(filters.yearFrom, 1, 9999);
  const yearTo = optionalBoundedInteger(filters.yearTo, 1, 9999);
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    throw new Error("Початковий рік не може бути пізнішим за кінцевий.");
  }

  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("list_person_church_role_network_v1", {
      p_project_id: normalizedProjectId,
      p_person_id: normalizedPersonId,
      p_role_codes: nonEmptyTexts(filters.roleCodes),
      p_year_from: yearFrom,
      p_year_to: yearTo,
      p_evidence_statuses: nonEmptyTexts(filters.evidenceStatuses),
      p_min_occurrences: boundedInteger(filters.minOccurrences, 1, 1000, 2),
      p_limit: boundedInteger(filters.limit, 1, 100, 20),
      p_offset: boundedInteger(filters.offset, 0, 100_000, 0),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;

  const payload = record(data);
  const returnedCenterId = text(payload.centerPersonId ?? payload.center_person_id).trim();
  if (returnedCenterId && returnedCenterId !== normalizedPersonId) {
    throw new Error("Сервер повернув мережу церковних ролей для іншої центральної особи.");
  }
  const algorithmVersion = text(payload.algorithmVersion ?? payload.algorithm_version).trim();
  if (algorithmVersion && algorithmVersion !== "church_role_network_v1") {
    throw new Error("Сервер повернув непідтримувану версію мережі церковних ролей.");
  }
  const groupingKind = text(payload.groupingKind ?? payload.grouping_kind).trim();
  if (groupingKind && groupingKind !== "surname_cluster") {
    throw new Error("Сервер повернув непідтримуваний спосіб групування мережі.");
  }
  if (booleanValue(payload.groupingIsGenealogicalFact ?? payload.grouping_is_genealogical_fact)) {
    throw new Error("Групування за прізвищем не може позначатися як встановлений факт споріднення.");
  }

  const centerGroup = mapChurchRoleNetworkGroup(payload.centerGroup ?? payload.center_group);
  const uniqueItems = new Map<string, PersonChurchRoleNetworkItem>();
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  rawItems.forEach((value) => {
    const item = mapChurchRoleNetworkItem(value);
    if (!item || item.counterpartGroup.key === centerGroup?.key) return;
    if (!uniqueItems.has(item.counterpartGroup.key)) uniqueItems.set(item.counterpartGroup.key, item);
  });

  return {
    centerPersonId: normalizedPersonId,
    algorithmVersion: "church_role_network_v1",
    groupingKind: "surname_cluster",
    groupingIsGenealogicalFact: false,
    centerGroup,
    items: [...uniqueItems.values()],
    total: nonNegativeInteger(payload.total),
    truncated: booleanValue(payload.truncated),
    capReasons: uniqueTexts(payload.capReasons ?? payload.cap_reasons),
    sameGroupOccurrenceCount: nonNegativeInteger(
      payload.sameGroupOccurrenceCount ?? payload.same_group_occurrence_count,
    ),
    omittedWithoutSurnameCount: nonNegativeInteger(
      payload.omittedWithoutSurnameCount ?? payload.omitted_without_surname_count,
    ),
  };
}

/**
 * Loads the bounded, read-only documentary context projection for one person.
 * The RPC performs project access and privacy filtering before returning JSON;
 * this mapper additionally rejects malformed or dangling graph records so a
 * partial response cannot break the visual layer.
 */
export async function getPersonDocumentaryGraph(
  projectId: string,
  centerPersonId: string,
  filters: PersonDocumentaryGraphFilters = {},
): Promise<PersonDocumentaryGraphSnapshot> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedPersonId = requiredId(centerPersonId, "центральну особу");
  const yearFrom = optionalBoundedInteger(filters.yearFrom, 1, 9999);
  const yearTo = optionalBoundedInteger(filters.yearTo, 1, 9999);
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    throw new Error("Початковий рік не може бути пізнішим за кінцевий.");
  }

  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("get_person_documentary_context_graph_v1", {
      p_project_id: normalizedProjectId,
      p_center_person_id: normalizedPersonId,
      p_depth: documentaryDepth(filters.depth),
      p_entity_types: documentaryEntityTypes(filters.entityTypes),
      p_event_types: nonEmptyTexts(filters.eventTypes),
      p_evidence_statuses: documentaryEvidenceStatuses(filters.evidenceStatuses),
      p_year_from: yearFrom,
      p_year_to: yearTo,
      p_place_id: nullableText(filters.placeId),
      p_max_nodes: boundedInteger(filters.maxNodes, 1, 100, 100),
      p_max_edges: boundedInteger(filters.maxEdges, 1, 500, 250),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;

  const payload = record(data);
  const expectedCenterNodeId = `person:${normalizedPersonId}` as DocumentaryGraphNodeId;
  const serverCenterNodeId = documentaryNodeId(payload.centerNodeId ?? payload.center_node_id);
  if (serverCenterNodeId && serverCenterNodeId !== expectedCenterNodeId) {
    throw new Error("Сервер повернув документальний граф для іншої центральної особи.");
  }
  const mappedNodes = (Array.isArray(payload.nodes) ? payload.nodes : [])
    .map(mapDocumentaryGraphNode)
    .filter((node): node is DocumentaryGraphNode => node !== null);
  const uniqueNodes = deduplicateDocumentaryNodes(mappedNodes);
  if (!uniqueNodes.some((node) => node.id === expectedCenterNodeId)) {
    uniqueNodes.unshift({
      id: expectedCenterNodeId,
      entityType: "person",
      entityId: normalizedPersonId,
      label: "Особа",
      secondaryLabel: "",
      depth: 0,
      masked: true,
      metadata: { isCenter: true },
    });
  }
  const nodeIds = new Set(uniqueNodes.map((node) => node.id));
  const mappedEdges = (Array.isArray(payload.edges) ? payload.edges : [])
    .map(mapDocumentaryGraphEdge)
    .filter((edge): edge is DocumentaryGraphEdge => edge !== null)
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  return {
    centerNodeId: expectedCenterNodeId,
    nodes: uniqueNodes,
    edges: deduplicateDocumentaryEdges(mappedEdges),
    generatedAt: text(payload.generatedAt ?? payload.generated_at),
    snapshotUpdatedAt: text(payload.snapshotUpdatedAt ?? payload.snapshot_updated_at),
    truncated: booleanValue(payload.truncated),
    edgesTruncated: booleanValue(payload.edgesTruncated ?? payload.edges_truncated),
  };
}

/**
 * Loads the bounded polymorphic research projection around one person. The
 * backend applies project/privacy rules before the response is assembled; the
 * client still validates namespaced IDs and drops malformed or dangling edges
 * so graph rendering cannot accidentally cross entity scopes.
 */
export async function getPersonResearchGraph(
  projectId: string,
  centerPersonId: string,
  filters: PersonResearchGraphFilters = {},
): Promise<PersonResearchGraphSnapshot> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedPersonId = requiredId(centerPersonId, "центральну особу");
  const validFrom = normalizeHistoricalDate(filters.validFrom, "start", "початкову дату");
  const validTo = normalizeHistoricalDate(filters.validTo, "end", "кінцеву дату");
  if (validFrom && validTo && validFrom > validTo) {
    throw new Error("Початкова дата не може бути пізнішою за кінцеву.");
  }
  const focusDate = normalizeExactHistoricalDate(filters.focusDate, "дату часового зрізу");
  const focusYear = optionalHistoricalYear(filters.focusYear, "рік часового зрізу");
  if (focusDate && focusYear !== null) {
    throw new Error("Оберіть або рік, або точну дату часового зрізу, але не обидва одночасно.");
  }
  const placeIds = uniqueNonEmptyTexts(filters.placeIds);
  const depth = researchDepth(filters.depth);
  const maxNodes = boundedInteger(filters.maxNodes, 1, 100, 100);
  const maxEdges = boundedInteger(filters.maxEdges, 1, 250, 250);
  let usedResearchGraphVersion: 1 | 2 = 2;

  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const sharedParameters = {
      p_project_id: normalizedProjectId,
      p_center_person_id: normalizedPersonId,
      p_depth: depth,
      p_entity_types: researchEntityTypes(filters.entityTypes),
      p_relation_type_ids: nonEmptyTexts(filters.relationTypeIds),
      p_evidence_statuses: documentaryEvidenceStatuses(filters.evidenceStatuses),
      p_assertion_kinds: researchAssertionKinds(filters.assertionKinds),
      // PostgREST casts these parameters to `date` before entering the RPC.
      // An empty string therefore fails with SQLSTATE 22P02; absent filters
      // must cross the wire as JSON null instead.
      p_valid_from: validFrom || null,
      p_valid_to: validTo || null,
      p_min_confidence: optionalBoundedInteger(filters.minConfidence, 0, 100),
      p_has_evidence: typeof filters.hasEvidence === "boolean" ? filters.hasEvidence : null,
      p_max_nodes: maxNodes,
      p_max_edges: maxEdges,
    };
    const modern = await client.rpc("get_person_research_context_graph_v2", {
      ...sharedParameters,
      p_focus_date: focusDate || null,
      p_focus_year: focusYear,
      p_place_ids: placeIds.length ? placeIds : null,
      p_include_undated: filters.includeUndated === true,
    });
    if (!modern.error || !isMissingResearchGraphV2Error(modern.error)) {
      usedResearchGraphVersion = 2;
      return { data: modern.data, error: modern.error };
    }

    if (
      validFrom
      || validTo
      || focusDate
      || focusYear !== null
      || placeIds.length
      || filters.includeUndated === true
    ) {
      usedResearchGraphVersion = 2;
      return { data: modern.data, error: modern.error };
    }

    // A narrow rolling-deploy fallback. New temporal/place filters are never
    // silently ignored: they require v2 and therefore do not enter this path.
    usedResearchGraphVersion = 1;
    const legacy = await client.rpc("get_person_research_context_graph_v1", sharedParameters);
    return { data: legacy.data, error: legacy.error };
  });
  if (error) {
    if (isMissingResearchGraphV2Error(error) && (
      validFrom
      || validTo
      || focusDate
      || focusYear !== null
      || placeIds.length
      || filters.includeUndated === true
    )) {
      throw new Error("Фільтри дат, часового зрізу й місця стануть доступними після застосування міграції дослідницького графа v2.");
    }
    throw error;
  }

  const payload = record(data);
  const returnedProjectId = text(payload.projectId ?? payload.project_id).trim();
  if (returnedProjectId !== normalizedProjectId) {
    throw new Error("Сервер повернув дослідницький граф іншого проєкту.");
  }
  const centerPayload = record(payload.center);
  const returnedCenterType = researchEntityType(
    centerPayload.entityType ?? centerPayload.entity_type,
  );
  const returnedCenterId = text(
    centerPayload.entityId ?? centerPayload.entity_id,
  ).trim();
  if (returnedCenterType !== "person" || returnedCenterId !== normalizedPersonId) {
    throw new Error("Сервер повернув дослідницький граф для іншої центральної особи.");
  }

  const expectedCenterNodeId = `person:${normalizedPersonId}` as ResearchGraphNodeId;
  const uniqueNodes = deduplicateResearchNodes(
    (Array.isArray(payload.nodes) ? payload.nodes : [])
      .map(mapResearchGraphNode)
      .filter((node): node is ResearchGraphNode => node !== null),
  );
  const centerNode = uniqueNodes.find((node) => node.id === expectedCenterNodeId);
  if (!centerNode || !centerNode.isCenter || centerNode.depth !== 0) {
    throw new Error("Сервер не повернув коректний центральний вузол дослідницького графа.");
  }
  const nodeIds = new Set(uniqueNodes.map((node) => node.id));
  const uniqueEdges = deduplicateResearchEdges(
    (Array.isArray(payload.edges) ? payload.edges : [])
      .map(mapResearchGraphEdge)
      .filter((edge): edge is ResearchGraphEdge => edge !== null)
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  );
  const limits = record(payload.limits);
  const truncated = record(payload.truncated);
  const returnedFilters = record(payload.filters);
  const returnedFocusDate = cleanText(returnedFilters.focusDate ?? returnedFilters.focus_date) || null;
  const returnedFocusYear = nullableYear(returnedFilters.focusYear ?? returnedFilters.focus_year);
  const returnedPlaceIds = uniqueTexts(returnedFilters.placeIds ?? returnedFilters.place_ids);
  const returnedIncludeUndated = booleanValue(
    returnedFilters.includeUndated ?? returnedFilters.include_undated,
  );
  if (usedResearchGraphVersion === 2 && (
    returnedFocusDate !== (focusDate || null)
    || returnedFocusYear !== focusYear
    || !sameTextSet(returnedPlaceIds, placeIds)
    || returnedIncludeUndated !== (filters.includeUndated === true)
  )) {
    throw new Error("Сервер повернув дослідницький граф для іншого часового зрізу або місця.");
  }

  return {
    projectId: normalizedProjectId,
    center: { entityType: "person", entityId: normalizedPersonId },
    depth,
    revision: nonNegativeInteger(payload.revision),
    nodes: uniqueNodes,
    edges: uniqueEdges,
    limits: {
      maxNodes: boundedInteger(limits.maxNodes ?? limits.max_nodes, 1, 100, maxNodes),
      maxEdges: boundedInteger(limits.maxEdges ?? limits.max_edges, 1, 250, maxEdges),
    },
    truncated: {
      nodes: booleanValue(truncated.nodes ?? payload.nodesTruncated ?? payload.nodes_truncated),
      edges: booleanValue(truncated.edges ?? payload.edgesTruncated ?? payload.edges_truncated),
    },
    filters: {
      focusDate: focusDate || null,
      focusYear,
      placeIds,
      includeUndated: filters.includeUndated === true,
    },
  };
}

/** Searches the named historical-place catalogue without exposing IDs as user input. */
export async function searchResearchGraphPlaces(
  projectId: string,
  query: string,
  options: { focusDate?: string; focusYear?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<ResearchGraphPlaceOption[]> {
  const normalizedQuery = cleanText(query);
  if (normalizedQuery.length < 2) return [];
  const focusDate = normalizeExactHistoricalDate(options.focusDate, "дату пошуку місця");
  const focusYear = optionalHistoricalYear(options.focusYear, "рік пошуку місця");
  if (focusDate && focusYear !== null) {
    throw new Error("Для пошуку місця оберіть або рік, або точну дату.");
  }
  const { searchPlaces } = await import("./historicalPlacesService.ts");
  const focusYearText = focusYear === null ? "" : String(focusYear).padStart(4, "0");
  const places = await searchPlaces({
    query: normalizedQuery,
    projectId: requiredId(projectId, "проєкт"),
    atDate: focusDate || null,
    temporalContext: focusDate
      ? { exactDate: focusDate, precision: "day" }
      : focusYearText
        ? {
          periodFrom: `${focusYearText}-01-01`,
          periodTo: `${focusYearText}-12-31`,
          precision: "year",
        }
        : null,
    limit: boundedInteger(options.limit, 1, 30, 12),
  }, options.signal);
  const unique = new Map<string, ResearchGraphPlaceOption>();
  places.forEach((place) => {
    const id = place.id.trim();
    if (!id || unique.has(id)) return;
    const hierarchy = place.hierarchy
      .map((item) => item.place.displayName || item.place.canonicalName)
      .filter(Boolean)
      .join(" · ");
    unique.set(id, {
      id,
      label: place.displayName || place.canonicalName || "Місце без назви",
      secondaryLabel: hierarchy || place.currentAdmin || place.modernName || "Історичний каталог",
    });
  });
  return [...unique.values()];
}

/** Re-resolves a saved canonical place ID; no display label is persisted in a view. */
export async function resolveResearchGraphSavedPlace(
  projectId: string,
  placeId: string,
  options: { focusDate?: string; focusYear?: number; signal?: AbortSignal } = {},
): Promise<ResearchGraphPlaceOption | null> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedPlaceId = requiredId(placeId, "історичне місце");
  const focusDate = normalizeExactHistoricalDate(options.focusDate, "дату пошуку місця");
  const focusYear = optionalHistoricalYear(options.focusYear, "рік пошуку місця");
  if (focusDate && focusYear !== null) throw new Error("Для місця не можна застосувати два часові зрізи.");
  const { getHistoricalPlaceProfile } = await import("./historicalPlacesService.ts");
  const yearText = focusYear === null ? "" : String(focusYear).padStart(4, "0");
  const profile = await getHistoricalPlaceProfile(
    normalizedPlaceId,
    focusDate || null,
    options.signal,
    focusDate
      ? { exactDate: focusDate, precision: "day" }
      : yearText
        ? {
          periodFrom: `${yearText}-01-01`,
          periodTo: `${yearText}-12-31`,
          precision: "year",
        }
        : null,
  );
  const place = profile.place;
  if (
    place.id !== normalizedPlaceId
    || place.status === "merged"
    || place.status === "archived"
    || place.isRedirect
    || (place.scope === "project" && place.projectId !== normalizedProjectId)
  ) return null;
  const hierarchy = profile.hierarchy.hierarchy
    .map((item) => item.place.displayName || item.place.canonicalName)
    .filter(Boolean)
    .join(" · ");
  return {
    id: normalizedPlaceId,
    label: place.displayName || place.canonicalName || "Історичне місце",
    secondaryLabel: hierarchy || place.currentAdmin || place.modernName || "Історичний каталог",
  };
}

/** Lists only the signed-in member's personal views for the selected project. */
export async function listResearchGraphSavedViews(
  projectId: string,
  options: {
    centerPersonId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ResearchGraphSavedViewsPage> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const centerPersonId = nullableText(options.centerPersonId);
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("list_context_graph_saved_views_v1", {
      p_project_id: normalizedProjectId,
      p_center_entity_type: centerPersonId ? "person" : null,
      p_center_entity_id: centerPersonId,
      p_limit: boundedInteger(options.limit, 1, 50, 50),
      p_offset: boundedInteger(options.offset, 0, 100_000, 0),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphSavedViewError(error);
  const payload = record(data);
  const unique = new Map<string, ResearchGraphSavedView>();
  const responseItems = rows(payload);
  let invalidItemFound = false;
  responseItems.forEach((value) => {
    const view = mapResearchGraphSavedView(value, normalizedProjectId);
    if (!view) {
      invalidItemFound = true;
      return;
    }
    if (!unique.has(view.id)) unique.set(view.id, view);
  });
  if (invalidItemFound) {
    throw new Error("Одне зі збережених представлень має непідтримувану конфігурацію. Оновіть або видаліть його після міграції.");
  }
  return {
    items: [...unique.values()],
    total: nonNegativeInteger(payload.total),
  };
}

/** Reloads one personal view before applying it so stale list data is never trusted. */
export async function getResearchGraphSavedView(
  projectId: string,
  viewId: string,
): Promise<ResearchGraphSavedView> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedViewId = requiredId(viewId, "збережене представлення");
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("get_context_graph_saved_view_v1", {
      p_project_id: normalizedProjectId,
      p_view_id: normalizedViewId,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphSavedViewError(error);
  const view = mapResearchGraphSavedView(data, normalizedProjectId);
  if (!view || view.id !== normalizedViewId) {
    throw new Error("Збережене представлення має непідтримувану або пошкоджену конфігурацію.");
  }
  return view;
}

export async function saveResearchGraphSavedView(
  projectId: string,
  draft: ResearchGraphSavedViewDraft,
  expectedLockVersion?: number,
): Promise<ResearchGraphSavedView> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const payload = normalizeResearchGraphSavedViewDraft(draft);
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("save_context_graph_saved_view_v1", {
      p_project_id: normalizedProjectId,
      p_payload: payload,
      p_expected_lock_version: expectedLockVersion ?? null,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphSavedViewError(error);
  const view = mapResearchGraphSavedView(data, normalizedProjectId);
  if (!view || (draft.id && view.id !== draft.id)) {
    throw new Error("Сервер не повернув збережене представлення графа.");
  }
  return view;
}

export async function deleteResearchGraphSavedView(
  projectId: string,
  viewId: string,
  expectedLockVersion: number,
): Promise<void> {
  const normalizedViewId = requiredId(viewId, "збережене представлення");
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("delete_context_graph_saved_view_v1", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_view_id: normalizedViewId,
      p_expected_lock_version: positiveInteger(expectedLockVersion),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphSavedViewError(error);
  const payload = record(data);
  if (text(payload.id).trim() !== normalizedViewId || payload.deleted !== true) {
    throw new Error("Сервер не підтвердив видалення представлення графа.");
  }
}

/** Lists owner-visible metadata only; bearer tokens are never returned here. */
export async function listResearchGraphViewShares(
  projectId: string,
  savedViewId: string,
): Promise<ResearchGraphViewSharesPage> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedViewId = requiredId(savedViewId, "збережене представлення");
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("list_context_graph_view_shares_v1", {
      p_project_id: normalizedProjectId,
      p_view_id: normalizedViewId,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphShareError(error);
  const payload = record(data);
  const items = rows(payload)
    .map((value) => mapResearchGraphViewShare(value, normalizedProjectId, normalizedViewId))
    .filter((value): value is ResearchGraphViewShare => value !== null);
  if (items.length !== rows(payload).length) {
    throw new Error("Сервер повернув пошкоджені метадані посилання на граф.");
  }
  return { items, total: nonNegativeInteger(payload.total ?? items.length) };
}

/**
 * Creates or rotates the single anonymous link. The token is deliberately
 * returned only from this call and must remain in component memory.
 */
export async function createResearchGraphViewShare(
  projectId: string,
  draft: ResearchGraphViewShareDraft,
): Promise<ResearchGraphViewShareCreated> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedViewId = requiredId(draft.savedViewId, "збережене представлення");
  if (draft.accessMode !== "public_readonly") {
    throw new Error("Непідтримуваний режим доступу до графа.");
  }
  const expiresAt = normalizeResearchGraphShareExpiry(draft.expiresAt);
  const publicTitle = normalizeResearchGraphPublicTitle(draft.publicTitle);
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("create_context_graph_view_share_v1", {
      p_project_id: normalizedProjectId,
      p_view_id: normalizedViewId,
      p_access_mode: "public_readonly",
      p_expires_at: expiresAt,
      p_public_title: publicTitle,
      p_expected_lock_version: draft.expectedLockVersion === null
        ? null
        : positiveInteger(draft.expectedLockVersion),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphShareError(error);
  const payload = record(data);
  const share = mapResearchGraphViewShare(
    payload.share,
    normalizedProjectId,
    normalizedViewId,
  );
  const token = cleanText(payload.token);
  if (!share || !isResearchGraphShareToken(token)) {
    throw new Error("Сервер не повернув нове безпечне посилання на граф.");
  }
  return { share, token };
}

export async function updateResearchGraphViewShare(
  projectId: string,
  share: Pick<ResearchGraphViewShare, "id" | "savedViewId" | "lockVersion">,
  draft: Pick<ResearchGraphViewShareDraft, "accessMode" | "expiresAt" | "publicTitle">,
): Promise<ResearchGraphViewShare> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedShareId = requiredId(share.id, "посилання");
  const normalizedViewId = requiredId(share.savedViewId, "збережене представлення");
  if (draft.accessMode !== "public_readonly") throw new Error("Непідтримуваний режим доступу до графа.");
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("update_context_graph_view_share_v1", {
      p_project_id: normalizedProjectId,
      p_share_id: normalizedShareId,
      p_access_mode: "public_readonly",
      p_expires_at: normalizeResearchGraphShareExpiry(draft.expiresAt),
      p_public_title: normalizeResearchGraphPublicTitle(draft.publicTitle),
      p_expected_lock_version: positiveInteger(share.lockVersion),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphShareError(error);
  const payload = record(data);
  const updated = mapResearchGraphViewShare(payload.share, normalizedProjectId, normalizedViewId);
  if (!updated || updated.id !== normalizedShareId) {
    throw new Error("Сервер не підтвердив оновлення посилання.");
  }
  return updated;
}

export async function revokeResearchGraphViewShare(
  projectId: string,
  share: Pick<ResearchGraphViewShare, "id" | "savedViewId" | "lockVersion">,
): Promise<ResearchGraphViewShare> {
  const normalizedProjectId = requiredId(projectId, "проєкт");
  const normalizedShareId = requiredId(share.id, "посилання");
  const normalizedViewId = requiredId(share.savedViewId, "збережене представлення");
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("revoke_context_graph_view_share_v1", {
      p_project_id: normalizedProjectId,
      p_share_id: normalizedShareId,
      p_expected_lock_version: positiveInteger(share.lockVersion),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw researchGraphShareError(error);
  const payload = record(data);
  const revoked = mapResearchGraphViewShare(
    payload.share ?? payload,
    normalizedProjectId,
    normalizedViewId,
  );
  if (!revoked || revoked.id !== normalizedShareId || revoked.status !== "revoked") {
    throw new Error("Сервер не підтвердив відкликання посилання.");
  }
  return revoked;
}

/**
 * Anonymous boundary: no authenticated project RPC is called and no project
 * identifiers are accepted from the route. The server must return an already
 * privacy-sanitized snapshot for this exact bearer token.
 */
export async function getSharedResearchGraphView(token: string): Promise<SharedResearchGraphView> {
  const normalizedToken = token.trim();
  if (!isResearchGraphShareToken(normalizedToken)) {
    throw new Error("Некоректне або пошкоджене посилання на граф.");
  }
  const client = getAnonymousSupabaseClient();
  const { data, error } = await client.rpc("get_shared_context_graph_view_v1", {
    p_token: normalizedToken,
  });
  if (error) throw researchGraphShareError(error);
  const result = mapSharedResearchGraphView(data);
  if (!result) {
    throw new Error("Сервер повернув непідтримуване або небезпечне представлення графа.");
  }
  return result;
}

/** Saves a polymorphic contextual assertion without touching family-tree data. */
export async function saveContextRelation(
  projectId: string,
  draft: ContextRelationV2Draft,
  expectedLockVersion?: number,
): Promise<ContextRelationV2> {
  const sourceEntityId = requiredId(draft.sourceEntityId, "початковий об’єкт");
  const targetEntityId = requiredId(draft.targetEntityId, "пов’язаний об’єкт");
  if (!draft.relationTypeId.trim()) throw new Error("Оберіть тип контекстного зв’язку.");
  if (draft.sourceEntityType === draft.targetEntityType && sourceEntityId === targetEntityId) {
    throw new Error("Не можна пов’язати об’єкт із самим собою.");
  }
  const validFrom = normalizeHistoricalDate(draft.validFrom, "start", "початкову дату");
  const validTo = normalizeHistoricalDate(draft.validTo, "end", "кінцеву дату");
  if (validFrom && validTo && validFrom > validTo) {
    throw new Error("Початкова дата не може бути пізнішою за кінцеву.");
  }
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("save_context_relation_v2", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_payload: {
        ...(draft.id ? { id: draft.id } : {}),
        relationTypeId: draft.relationTypeId,
        sourceEntityType: draft.sourceEntityType,
        sourceEntityId,
        targetEntityType: draft.targetEntityType,
        targetEntityId,
        sourceRoleLabel: cleanText(draft.sourceRoleLabel),
        targetRoleLabel: cleanText(draft.targetRoleLabel),
        validFrom,
        validTo,
        periodText: cleanText(draft.periodText) || historicalPeriodText(draft.validFrom, draft.validTo),
        evidenceStatus: draft.evidenceStatus ?? "unknown",
        confidence: boundedInteger(draft.confidence, 0, 100, 0),
        privacyStatus: draft.privacyStatus ?? "project",
        assertionKind: draft.assertionKind ?? "research_hypothesis",
        notes: cleanText(draft.notes),
        metadata: draft.metadata ?? {},
      },
      p_expected_lock_version: expectedLockVersion ?? null,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const saved = mapContextRelationV2(data);
  if (!saved) throw new Error("Сервер не повернув збережене контекстне твердження.");
  return saved;
}

export async function archiveContextRelation(
  projectId: string,
  relationId: string,
  expectedLockVersion: number,
): Promise<ContextRelationV2> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("archive_context_relation_v2", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_relation_id: requiredId(relationId, "зв’язок"),
      p_expected_lock_version: positiveInteger(expectedLockVersion),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const saved = mapContextRelationV2(data);
  if (!saved) throw new Error("Сервер не повернув архівоване контекстне твердження.");
  return saved;
}

/**
 * Loads allowlisted evidence rows for one relation. The read RPC is kept
 * separate so a graph snapshot never exposes excerpts or researcher notes.
 */
export async function getContextRelationEvidence(
  projectId: string,
  relationId: string,
): Promise<ContextRelationEvidenceV2[]> {
  const requestedProjectId = requiredId(projectId, "проєкт");
  const requestedRelationId = requiredId(relationId, "зв’язок");
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("get_context_relation_evidence_v2", {
      p_project_id: requestedProjectId,
      p_relation_id: requestedRelationId,
      p_limit: 100,
      p_offset: 0,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  return mapContextRelationEvidencePage(data, {
    projectId: requestedProjectId,
    relationId: requestedRelationId,
  });
}

export async function saveContextRelationEvidence(
  projectId: string,
  draft: ContextRelationEvidenceV2Draft,
  expectedLockVersion?: number,
): Promise<ContextRelationEvidenceV2> {
  if (!draft.relationId.trim()) throw new Error("Не вказано контекстний зв’язок.");
  if (draft.evidenceEntityType && !draft.evidenceEntityId?.trim()) {
    throw new Error("Оберіть конкретний документ або знахідку.");
  }
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("save_context_relation_evidence_v2", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_payload: {
        ...(draft.id ? { id: draft.id } : {}),
        relationId: draft.relationId,
        evidenceEntityType: draft.evidenceEntityType ?? null,
        evidenceEntityId: nullableText(draft.evidenceEntityId),
        citationId: nullableText(draft.citationId),
        documentFragmentId: nullableText(draft.documentFragmentId),
        sourceLocator: cleanText(draft.sourceLocator),
        excerpt: cleanText(draft.excerpt),
        notes: cleanText(draft.notes),
        metadata: draft.metadata ?? {},
      },
      p_expected_lock_version: expectedLockVersion ?? null,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const saved = mapContextRelationEvidenceV2(data);
  if (!saved) throw new Error("Сервер не повернув збережений доказ.");
  return saved;
}

export async function archiveContextRelationEvidence(
  projectId: string,
  evidenceId: string,
  expectedLockVersion: number,
): Promise<ContextRelationEvidenceV2> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("archive_context_relation_evidence_v2", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_evidence_id: requiredId(evidenceId, "доказ"),
      p_expected_lock_version: positiveInteger(expectedLockVersion),
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const saved = mapContextRelationEvidenceV2(data);
  if (!saved) throw new Error("Сервер не повернув архівований доказ.");
  return saved;
}

export async function savePersonContextRelation(
  projectId: string,
  draft: PersonContextRelationDraft,
  expectedLockVersion?: number,
): Promise<PersonContextRelation> {
  if (!draft.relationTypeId) throw new Error("Оберіть тип контекстного зв’язку.");
  if (!draft.sourcePersonId || !draft.targetPersonId) {
    throw new Error("Оберіть обидві пов’язані особи.");
  }
  if (draft.sourcePersonId === draft.targetPersonId) {
    throw new Error("Не можна створити контекстний зв’язок особи із самою собою.");
  }
  validateIsoDate(draft.validFrom, "початкову дату");
  validateIsoDate(draft.validTo, "кінцеву дату");
  if (draft.id && (
    draft.sourceRoleLabel === undefined
    || draft.targetRoleLabel === undefined
    || draft.assertionKind === undefined
    || draft.metadata === undefined
  )) {
    throw new Error(
      "Редагування потребує повного provenance-контексту: ролей, походження твердження та metadata.",
    );
  }
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("save_person_context_relation_v1", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_payload: {
        ...(draft.id ? { id: draft.id } : {}),
        relationTypeId: draft.relationTypeId,
        sourcePersonId: draft.sourcePersonId,
        targetPersonId: draft.targetPersonId,
        sourceRoleLabel: cleanText(draft.sourceRoleLabel),
        targetRoleLabel: cleanText(draft.targetRoleLabel),
        validFrom: cleanText(draft.validFrom),
        validTo: cleanText(draft.validTo),
        periodText: cleanText(draft.periodText),
        evidenceStatus: draft.evidenceStatus ?? "unknown",
        confidence: boundedInteger(draft.confidence, 0, 100, 0),
        privacyStatus: draft.privacyStatus ?? "project",
        assertionKind: draft.assertionKind ?? "manual",
        notes: cleanText(draft.notes),
        metadata: draft.metadata ?? {},
      },
      p_expected_lock_version: expectedLockVersion ?? null,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  const saved = mapPersonContextRelation(record(data));
  if (!saved.id) throw new Error("Сервер не повернув збережений контекстний зв’язок.");
  return saved;
}

export async function archivePersonContextRelation(
  projectId: string,
  relationId: string,
  expectedLockVersion: number,
): Promise<PersonContextRelation> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    const result = await client.rpc("archive_person_context_relation_v1", {
      p_project_id: requiredId(projectId, "проєкт"),
      p_relation_id: requiredId(relationId, "зв’язок"),
      p_expected_lock_version: expectedLockVersion,
    });
    return { data: result.data, error: result.error };
  });
  if (error) throw error;
  return mapPersonContextRelation(record(data));
}

function mapContextRelationType(value: unknown): ContextRelationType {
  const row = record(value);
  return {
    id: text(row.id),
    projectId: nullableText(row.projectId ?? row.project_id),
    code: text(row.code),
    category: relationCategory(row.category),
    directionality: directionality(row.directionality),
    labelUk: text(row.labelUk ?? row.label_uk),
    inverseCode: text(row.inverseCode ?? row.inverse_code),
    inverseLabelUk: text(row.inverseLabelUk ?? row.inverse_label_uk),
    sourceRoleUk: text(row.sourceRoleUk ?? row.source_role_uk),
    targetRoleUk: text(row.targetRoleUk ?? row.target_role_uk),
    iconToken: text(row.iconToken ?? row.icon_token),
    colorRole: text(row.colorRole ?? row.color_role, "context"),
    isSystem: booleanValue(row.isSystem ?? row.is_system),
    isActive: booleanValue(row.isActive ?? row.is_active, true),
    lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
  };
}

function mapPersonContextRelation(value: unknown): PersonContextRelation {
  const row = record(value);
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const mappedEvidence = evidence.map(mapContextEvidence).filter((item) => Boolean(item.id));
  const rawEvidenceCount = row.evidenceCount ?? row.evidence_count;
  return {
    id: text(row.id),
    projectId: text(row.projectId ?? row.project_id),
    relationTypeId: text(row.relationTypeId ?? row.relation_type_id),
    relationTypeCode: text(row.relationTypeCode ?? row.relation_type_code),
    relationTypeLabel: text(row.relationTypeLabel ?? row.relation_type_label, "Контекстний зв’язок"),
    relationCategory: relationCategory(row.relationCategory ?? row.relation_category),
    directionality: directionality(row.directionality),
    sourcePersonId: text(row.sourcePersonId ?? row.source_person_id),
    targetPersonId: text(row.targetPersonId ?? row.target_person_id),
    sourceRoleLabel: text(row.sourceRoleLabel ?? row.source_role_label),
    targetRoleLabel: text(row.targetRoleLabel ?? row.target_role_label),
    validFrom: text(row.validFrom ?? row.valid_from),
    validTo: text(row.validTo ?? row.valid_to),
    periodText: text(row.periodText ?? row.period_text),
    evidenceStatus: evidenceStatus(row.evidenceStatus ?? row.evidence_status),
    confidence: boundedInteger(row.confidence, 0, 100, 0),
    privacyStatus: privacyStatus(row.privacyStatus ?? row.privacy_status),
    assertionKind: assertionKind(row.assertionKind ?? row.assertion_kind),
    notes: text(row.notes),
    metadata: record(row.metadata),
    lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
    createdAt: text(row.createdAt ?? row.created_at),
    updatedAt: text(row.updatedAt ?? row.updated_at),
    deletedAt: nullableText(row.deletedAt ?? row.deleted_at),
    evidenceCount: rawEvidenceCount === undefined || rawEvidenceCount === null
      ? mappedEvidence.length
      : Math.max(0, integer(rawEvidenceCount)),
    evidence: mappedEvidence,
  };
}

function mapContextEvidence(value: unknown): ContextRelationEvidence {
  const row = record(value);
  return {
    id: text(row.id),
    projectId: text(row.projectId ?? row.project_id),
    relationId: text(row.relationId ?? row.relation_id),
    evidenceKind: evidenceKind(row.evidenceKind ?? row.evidence_kind),
    sourceDocumentId: nullableText(row.sourceDocumentId ?? row.source_document_id),
    sourceFindingId: nullableText(row.sourceFindingId ?? row.source_finding_id),
    sourceEventId: nullableText(row.sourceEventId ?? row.source_event_id),
    findingParticipantId: nullableText(row.findingParticipantId ?? row.finding_participant_id),
    citationId: nullableText(row.citationId ?? row.citation_id),
    documentFragmentId: nullableText(row.documentFragmentId ?? row.document_fragment_id),
    sourceLocator: text(row.sourceLocator ?? row.source_locator),
    excerpt: text(row.excerpt),
    notes: text(row.notes),
    lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
    createdAt: text(row.createdAt ?? row.created_at),
    updatedAt: text(row.updatedAt ?? row.updated_at),
    deletedAt: nullableText(row.deletedAt ?? row.deleted_at),
  };
}

function mapContextGraphPersonNode(value: unknown): ContextGraphPersonNode {
  const row = record(value);
  return {
    id: text(row.id),
    entityType: "person",
    isCenter: booleanValue(row.isCenter ?? row.is_center),
    displayName: text(row.displayName ?? row.display_name, "Особа"),
    givenName: text(row.givenName ?? row.given_name),
    surname: text(row.surname),
    patronymic: text(row.patronymic),
    gender: text(row.gender),
    isLiving: booleanValue(row.isLiving ?? row.is_living),
    isPrivate: booleanValue(row.isPrivate ?? row.is_private),
    masked: booleanValue(row.masked),
    degree: Math.max(0, integer(row.degree)),
  };
}

function mapContextGraphPersonEdge(value: unknown): ContextGraphPersonEdge {
  const row = record(value);
  return {
    id: text(row.id),
    sourcePersonId: text(row.sourcePersonId ?? row.source_person_id),
    targetPersonId: text(row.targetPersonId ?? row.target_person_id),
    relationTypeId: text(row.relationTypeId ?? row.relation_type_id),
    relationTypeCode: text(row.relationTypeCode ?? row.relation_type_code),
    relationTypeLabel: text(row.relationTypeLabel ?? row.relation_type_label, "Контекстний зв’язок"),
    category: relationCategory(row.category),
    directionality: directionality(row.directionality),
    sourceRoleLabel: text(row.sourceRoleLabel ?? row.source_role_label),
    targetRoleLabel: text(row.targetRoleLabel ?? row.target_role_label),
    validFrom: text(row.validFrom ?? row.valid_from),
    validTo: text(row.validTo ?? row.valid_to),
    periodText: text(row.periodText ?? row.period_text),
    evidenceStatus: evidenceStatus(row.evidenceStatus ?? row.evidence_status),
    confidence: boundedInteger(row.confidence, 0, 100, 0),
    privacyStatus: privacyStatus(row.privacyStatus ?? row.privacy_status),
    assertionKind: assertionKind(row.assertionKind ?? row.assertion_kind),
    evidenceCount: Math.max(0, integer(row.evidenceCount ?? row.evidence_count)),
    createdAt: text(row.createdAt ?? row.created_at),
    updatedAt: text(row.updatedAt ?? row.updated_at),
  };
}

function mapPersonContextCooccurrence(
  value: unknown,
  centerPersonId: string,
): PersonContextCooccurrence | null {
  const row = record(value);
  const personId = text(row.personId ?? row.person_id).trim();
  if (!personId || personId === centerPersonId) return null;

  const uniqueSources = new Map<string, PersonContextCooccurrenceSource>();
  const rawSources = Array.isArray(row.topSources ?? row.top_sources)
    ? row.topSources ?? row.top_sources
    : [];
  (rawSources as unknown[]).slice(0, 5).forEach((source) => {
    const mapped = mapPersonContextCooccurrenceSource(source);
    if (mapped) uniqueSources.set(`${mapped.kind}:${mapped.id}`, mapped);
  });

  return {
    personId,
    displayName: text(row.displayName ?? row.display_name).trim() || "Приватна особа",
    masked: booleanValue(row.masked),
    sharedFindingCount: nonNegativeInteger(row.sharedFindingCount ?? row.shared_finding_count),
    sharedDocumentCount: nonNegativeInteger(row.sharedDocumentCount ?? row.shared_document_count),
    sharedEventCount: nonNegativeInteger(row.sharedEventCount ?? row.shared_event_count),
    sharedSourceCount: nonNegativeInteger(row.sharedSourceCount ?? row.shared_source_count),
    relationStrength: nonNegativeInteger(row.relationStrength ?? row.relation_strength),
    firstYear: nullableYear(row.firstYear ?? row.first_year),
    lastYear: nullableYear(row.lastYear ?? row.last_year),
    topSources: [...uniqueSources.values()],
  };
}

function mapPersonContextCooccurrenceSource(value: unknown): PersonContextCooccurrenceSource | null {
  const row = record(value);
  const kind = row.kind;
  const id = text(row.id).trim();
  if ((kind !== "finding" && kind !== "document" && kind !== "event") || !id) return null;
  return {
    kind,
    id,
    label: text(row.label).trim() || cooccurrenceSourceFallbackLabel(kind),
    year: nullableYear(row.year),
  };
}

function mapChurchRoleNetworkGroup(value: unknown): ChurchRoleNetworkGroup | null {
  const row = record(value);
  const key = text(row.key).trim();
  if (!key) return null;
  return {
    key,
    label: text(row.label).trim() || "Кластер без назви",
    normalizedSurname: text(row.normalizedSurname ?? row.normalized_surname).trim(),
    memberCount: nonNegativeInteger(row.memberCount ?? row.member_count),
  };
}

function mapChurchRoleNetworkItem(value: unknown): PersonChurchRoleNetworkItem | null {
  const row = record(value);
  const counterpartGroup = mapChurchRoleNetworkGroup(
    row.counterpartGroup ?? row.counterpart_group,
  );
  if (!counterpartGroup) return null;

  const samples = new Map<string, ChurchRoleNetworkSample>();
  const rawSamples = Array.isArray(row.samples) ? row.samples : [];
  rawSamples.slice(0, 5).forEach((sample) => {
    const mapped = mapChurchRoleNetworkSample(sample);
    if (mapped && !samples.has(mapped.relationId)) samples.set(mapped.relationId, mapped);
  });

  const sources = new Map<string, ChurchRoleNetworkSource>();
  const rawSources = Array.isArray(row.sources) ? row.sources : [];
  rawSources.slice(0, 5).forEach((source) => {
    const mapped = mapChurchRoleNetworkSource(source);
    if (mapped) sources.set(`${mapped.kind}:${mapped.id}`, mapped);
  });
  samples.forEach((sample) => {
    if (sample.source && sources.size < 5) {
      sources.set(`${sample.source.kind}:${sample.source.id}`, sample.source);
    }
  });

  return {
    counterpartGroup,
    occurrenceCount: nonNegativeInteger(row.occurrenceCount ?? row.occurrence_count),
    relationCount: nonNegativeInteger(row.relationCount ?? row.relation_count),
    personPairCount: nonNegativeInteger(row.personPairCount ?? row.person_pair_count),
    sourcePersonCount: nonNegativeInteger(row.sourcePersonCount ?? row.source_person_count),
    targetPersonCount: nonNegativeInteger(row.targetPersonCount ?? row.target_person_count),
    incomingCount: nonNegativeInteger(row.incomingCount ?? row.incoming_count),
    outgoingCount: nonNegativeInteger(row.outgoingCount ?? row.outgoing_count),
    roleCounts: mapChurchRoleNetworkRoleCounts(row.roleCounts ?? row.role_counts),
    firstYear: nullableYear(row.firstYear ?? row.first_year),
    lastYear: nullableYear(row.lastYear ?? row.last_year),
    ambiguousRoleCount: nonNegativeInteger(
      row.ambiguousRoleCount ?? row.ambiguous_role_count ?? row.ambiguousCount ?? row.ambiguous_count,
    ),
    generatedCount: nonNegativeInteger(row.generatedCount ?? row.generated_count),
    manualCount: nonNegativeInteger(row.manualCount ?? row.manual_count),
    samples: [...samples.values()],
    sources: [...sources.values()].slice(0, 5),
  };
}

function mapChurchRoleNetworkRoleCounts(value: unknown): ChurchRoleNetworkRoleCount[] {
  const mapped = new Map<string, ChurchRoleNetworkRoleCount>();
  if (Array.isArray(value)) {
    value.forEach((candidate) => {
      const row = record(candidate);
      const code = text(row.code).trim();
      if (!code) return;
      mapped.set(code, {
        code,
        label: text(row.label).trim() || churchRoleFallbackLabel(code),
        count: nonNegativeInteger(row.count),
      });
    });
  } else {
    Object.entries(record(value)).forEach(([code, count]) => {
      if (!code.trim()) return;
      mapped.set(code, {
        code,
        label: churchRoleFallbackLabel(code),
        count: nonNegativeInteger(count),
      });
    });
  }
  return [...mapped.values()]
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "uk"));
}

function mapChurchRoleNetworkSample(value: unknown): ChurchRoleNetworkSample | null {
  const row = record(value);
  const relationId = text(row.relationId ?? row.relation_id).trim();
  const sourcePersonId = text(row.sourcePersonId ?? row.source_person_id).trim();
  const targetPersonId = text(row.targetPersonId ?? row.target_person_id).trim();
  if (!relationId || !sourcePersonId || !targetPersonId || sourcePersonId === targetPersonId) return null;
  return {
    relationId,
    roleCode: text(row.roleCode ?? row.role_code).trim(),
    roleLabel: text(row.roleLabel ?? row.role_label).trim() || "Контекстний зв’язок",
    sourcePersonId,
    sourceDisplayName: text(row.sourceDisplayName ?? row.source_display_name).trim() || "Приватна особа",
    targetPersonId,
    targetDisplayName: text(row.targetDisplayName ?? row.target_display_name).trim() || "Приватна особа",
    direction: (row.direction === "incoming" ? "incoming" : "outgoing"),
    assertionKind: assertionKind(row.assertionKind ?? row.assertion_kind),
    evidenceStatus: evidenceStatus(row.evidenceStatus ?? row.evidence_status),
    confidence: boundedInteger(row.confidence, 0, 100, 0),
    year: nullableYear(row.year),
    evidenceCount: nonNegativeInteger(row.evidenceCount ?? row.evidence_count),
    source: mapChurchRoleNetworkSource(row.source),
  };
}

function mapChurchRoleNetworkSource(value: unknown): ChurchRoleNetworkSource | null {
  const row = record(value);
  const kind = row.kind;
  const id = text(row.id).trim();
  if (
    (
      kind !== "finding"
      && kind !== "document"
      && kind !== "event"
      && kind !== "document_fragment"
      && kind !== "citation"
    )
    || !id
  ) return null;
  return {
    kind,
    id,
    label: text(row.label).trim() || churchRoleSourceFallbackLabel(kind),
    year: nullableYear(row.year),
  };
}

function churchRoleFallbackLabel(code: string): string {
  const labels: Readonly<Record<string, string>> = {
    godfather: "Хрещений батько",
    godmother: "Хрещена мати",
    godparent: "Хрещена особа — роль потребує уточнення",
    sponsor_for_bride: "Поручитель по нареченій",
    sponsor_for_groom: "Поручитель по нареченому",
    sponsor: "Поручитель — сторона потребує уточнення",
    witness_for_bride: "Свідок по нареченій",
    witness_for_groom: "Свідок по нареченому",
    witness: "Свідок — сторона потребує уточнення",
  };
  return labels[code] ?? code;
}

function churchRoleSourceFallbackLabel(kind: ChurchRoleNetworkSource["kind"]): string {
  if (kind === "finding") return "Знахідка";
  if (kind === "document") return "Документ";
  if (kind === "document_fragment") return "Фрагмент документа";
  if (kind === "citation") return "Цитата";
  return "Подія";
}

function cooccurrenceSourceFallbackLabel(kind: PersonContextCooccurrenceSource["kind"]): string {
  if (kind === "finding") return "Спільна знахідка";
  if (kind === "document") return "Спільний документ";
  return "Спільна подія";
}

function mapDocumentaryGraphNode(value: unknown): DocumentaryGraphNode | null {
  const row = record(value);
  const id = documentaryNodeId(row.id);
  const entityType = documentaryEntityType(row.entityType ?? row.entity_type);
  const entityId = text(row.entityId ?? row.entity_id).trim();
  if (!id || !entityType || !entityId || id !== `${entityType}:${entityId}`) return null;
  return {
    id,
    entityType,
    entityId,
    label: text(row.label).trim() || documentaryNodeFallbackLabel(entityType),
    secondaryLabel: text(row.secondaryLabel ?? row.secondary_label).trim(),
    depth: boundedInteger(row.depth, 0, 2, documentaryNodeDefaultDepth(entityType, row.metadata)),
    masked: booleanValue(row.masked),
    metadata: record(row.metadata),
  };
}

function mapDocumentaryGraphEdge(value: unknown): DocumentaryGraphEdge | null {
  const row = record(value);
  const id = text(row.id).trim();
  const source = documentaryNodeId(row.source ?? row.source_id);
  const target = documentaryNodeId(row.target ?? row.target_id);
  if (!id || !source || !target || source === target) return null;
  return {
    id,
    source,
    target,
    relationType: text(row.relationType ?? row.relation_type).trim() || "related",
    label: text(row.label).trim() || "пов’язано",
    status: evidenceStatus(row.status ?? row.evidenceStatus ?? row.evidence_status),
    confidence: boundedInteger(row.confidence, 0, 100, 0),
    sourceCount: Math.max(0, integer(row.sourceCount ?? row.source_count)),
    generated: booleanValue(row.generated),
    metadata: record(row.metadata),
  };
}

function documentaryNodeId(value: unknown): DocumentaryGraphNodeId | null {
  const candidate = text(value).trim();
  const match = /^(person|finding|person_event|document|place):([^:\s]+)$/u.exec(candidate);
  return match ? candidate as DocumentaryGraphNodeId : null;
}

function documentaryEntityType(value: unknown): DocumentaryGraphEntityType | null {
  return value === "person" || value === "finding" || value === "person_event"
    || value === "document" || value === "place"
    ? value
    : null;
}

function documentaryEntityTypes(
  values: readonly DocumentaryGraphEntityType[] | undefined,
): DocumentaryGraphEntityType[] | null {
  const result = (values ?? [])
    .map(documentaryEntityType)
    .filter((value): value is DocumentaryGraphEntityType => value !== null);
  return result.length ? [...new Set(result)] : null;
}

function documentaryEvidenceStatuses(
  values: readonly ContextEvidenceStatus[] | undefined,
): ContextEvidenceStatus[] | null {
  const result = (values ?? []).filter((value): value is ContextEvidenceStatus => (
    value === "proven" || value === "likely" || value === "disputed"
    || value === "disproven" || value === "unknown"
  ));
  return result.length ? [...new Set(result)] : null;
}

function documentaryDepth(value: unknown): 1 | 2 {
  return value === 1 ? 1 : 2;
}

function documentaryNodeFallbackLabel(entityType: DocumentaryGraphEntityType): string {
  switch (entityType) {
    case "person": return "Особа";
    case "finding": return "Знахідка";
    case "person_event": return "Подія особи";
    case "document": return "Документ";
    case "place": return "Місце";
  }
}

function documentaryNodeDefaultDepth(
  entityType: DocumentaryGraphEntityType,
  metadata: unknown,
): number {
  if (entityType === "person") return record(metadata).isCenter === true ? 0 : 2;
  return entityType === "place" ? 2 : 1;
}

function deduplicateDocumentaryNodes(nodes: readonly DocumentaryGraphNode[]): DocumentaryGraphNode[] {
  const uniqueNodes = new Map<DocumentaryGraphNodeId, DocumentaryGraphNode>();
  nodes.forEach((node) => {
    if (!uniqueNodes.has(node.id)) uniqueNodes.set(node.id, node);
  });
  return [...uniqueNodes.values()];
}

function deduplicateDocumentaryEdges(edges: readonly DocumentaryGraphEdge[]): DocumentaryGraphEdge[] {
  const uniqueEdges = new Map<string, DocumentaryGraphEdge>();
  edges.forEach((edge) => {
    if (!uniqueEdges.has(edge.id)) uniqueEdges.set(edge.id, edge);
  });
  return [...uniqueEdges.values()];
}

function mapResearchGraphNode(value: unknown): ResearchGraphNode | null {
  const row = record(value);
  const id = researchNodeId(row.id);
  const entityType = researchEntityType(row.entityType ?? row.entity_type);
  const entityId = text(row.entityId ?? row.entity_id).trim();
  if (!id || !entityType || !entityId || id !== `${entityType}:${entityId}`) return null;
  return {
    id,
    entityType,
    entityId,
    label: text(row.label).trim() || researchNodeFallbackLabel(entityType),
    secondaryLabel: text(row.secondaryLabel ?? row.secondary_label).trim(),
    isCenter: booleanValue(row.isCenter ?? row.is_center),
    masked: booleanValue(row.masked),
    depth: researchNodeDepth(row.depth, booleanValue(row.isCenter ?? row.is_center)),
    metadata: record(row.metadata),
  };
}

function mapResearchGraphEdge(value: unknown): ResearchGraphEdge | null {
  const row = record(value);
  const id = text(row.id).trim();
  const source = researchNodeId(row.source ?? row.source_id);
  const target = researchNodeId(row.target ?? row.target_id);
  if (!id || !source || !target || source === target) return null;
  const sourceParts = researchNodeIdParts(source);
  const targetParts = researchNodeIdParts(target);
  if (!sourceParts || !targetParts) return null;
  const sourceEntityType = researchEntityType(
    row.sourceEntityType ?? row.source_entity_type,
  ) ?? sourceParts.entityType;
  const targetEntityType = researchEntityType(
    row.targetEntityType ?? row.target_entity_type,
  ) ?? targetParts.entityType;
  const sourceEntityId = text(
    row.sourceEntityId ?? row.source_entity_id,
    sourceParts.entityId,
  ).trim();
  const targetEntityId = text(
    row.targetEntityId ?? row.target_entity_id,
    targetParts.entityId,
  ).trim();
  if (
    sourceEntityType !== sourceParts.entityType
    || targetEntityType !== targetParts.entityType
    || sourceEntityId !== sourceParts.entityId
    || targetEntityId !== targetParts.entityId
  ) return null;
  const kind = assertionKind(row.assertionKind ?? row.assertion_kind);
  return {
    id,
    source,
    target,
    sourceEntityType,
    sourceEntityId,
    targetEntityType,
    targetEntityId,
    relationTypeId: text(row.relationTypeId ?? row.relation_type_id).trim(),
    relationTypeCode: text(row.relationTypeCode ?? row.relation_type_code).trim(),
    relationTypeLabel: text(
      row.relationTypeLabel ?? row.relation_type_label,
      "Контекстний зв’язок",
    ).trim() || "Контекстний зв’язок",
    relationCategory: relationCategory(row.relationCategory ?? row.relation_category),
    directionality: directionality(row.directionality),
    sourceRoleLabel: text(row.sourceRoleLabel ?? row.source_role_label).trim(),
    targetRoleLabel: text(row.targetRoleLabel ?? row.target_role_label).trim(),
    validFrom: text(row.validFrom ?? row.valid_from).trim(),
    validTo: text(row.validTo ?? row.valid_to).trim(),
    periodText: text(row.periodText ?? row.period_text).trim(),
    evidenceStatus: evidenceStatus(row.evidenceStatus ?? row.evidence_status),
    confidence: boundedInteger(row.confidence, 0, 100, 0),
    privacyStatus: privacyStatus(row.privacyStatus ?? row.privacy_status),
    assertionKind: kind,
    evidenceCount: nonNegativeInteger(row.evidenceCount ?? row.evidence_count),
    generated: booleanValue(row.generated, kind === "generated"),
    lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
    metadata: record(row.metadata),
  };
}

function mapContextRelationV2(value: unknown): ContextRelationV2 | null {
  const row = record(value);
  const id = text(row.id).trim();
  const projectId = text(row.projectId ?? row.project_id).trim();
  const sourceEntityType = researchEntityType(row.sourceEntityType ?? row.source_entity_type);
  const targetEntityType = researchEntityType(row.targetEntityType ?? row.target_entity_type);
  const sourceEntityId = text(row.sourceEntityId ?? row.source_entity_id).trim();
  const targetEntityId = text(row.targetEntityId ?? row.target_entity_id).trim();
  if (!id || !projectId || !sourceEntityType || !targetEntityType || !sourceEntityId || !targetEntityId) {
    return null;
  }
  return {
    id,
    projectId,
    relationTypeId: text(row.relationTypeId ?? row.relation_type_id).trim(),
    relationTypeCode: text(row.relationTypeCode ?? row.relation_type_code).trim(),
    relationTypeLabel: text(row.relationTypeLabel ?? row.relation_type_label, "Контекстний зв’язок").trim(),
    relationCategory: relationCategory(row.relationCategory ?? row.relation_category),
    directionality: directionality(row.directionality),
    sourceEntityType,
    sourceEntityId,
    targetEntityType,
    targetEntityId,
    sourceRoleLabel: text(row.sourceRoleLabel ?? row.source_role_label).trim(),
    targetRoleLabel: text(row.targetRoleLabel ?? row.target_role_label).trim(),
    validFrom: text(row.validFrom ?? row.valid_from).trim(),
    validTo: text(row.validTo ?? row.valid_to).trim(),
    periodText: text(row.periodText ?? row.period_text).trim(),
    evidenceStatus: evidenceStatus(row.evidenceStatus ?? row.evidence_status),
    confidence: boundedInteger(row.confidence, 0, 100, 0),
    privacyStatus: privacyStatus(row.privacyStatus ?? row.privacy_status),
    assertionKind: assertionKind(row.assertionKind ?? row.assertion_kind),
    notes: text(row.notes),
    metadata: record(row.metadata),
    personContextRelationId: nullableText(row.personContextRelationId ?? row.person_context_relation_id),
    lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
    createdAt: text(row.createdAt ?? row.created_at),
    updatedAt: text(row.updatedAt ?? row.updated_at),
    deletedAt: nullableText(row.deletedAt ?? row.deleted_at),
    evidenceCount: nonNegativeInteger(row.evidenceCount ?? row.evidence_count),
  };
}

function researchNodeId(value: unknown): ResearchGraphNodeId | null {
  const candidate = text(value).trim();
  const match = /^(person|family|place|event|document|finding|source|repository|hypothesis):([^:\s]+)$/u
    .exec(candidate);
  return match ? candidate as ResearchGraphNodeId : null;
}

function researchNodeIdParts(
  id: ResearchGraphNodeId,
): { entityType: ResearchGraphEntityType; entityId: string } | null {
  const separator = id.indexOf(":");
  const entityType = researchEntityType(id.slice(0, separator));
  const entityId = id.slice(separator + 1).trim();
  return entityType && entityId ? { entityType, entityId } : null;
}

function researchEntityType(value: unknown): ResearchGraphEntityType | null {
  return value === "person" || value === "family" || value === "place"
    || value === "event" || value === "document" || value === "finding"
    || value === "source" || value === "repository" || value === "hypothesis"
    ? value
    : null;
}

function researchEntityTypes(
  values: readonly ResearchGraphEntityType[] | undefined,
): ResearchGraphEntityType[] | null {
  const result = (values ?? [])
    .map(researchEntityType)
    .filter((value): value is ResearchGraphEntityType => value !== null);
  return result.length ? [...new Set(result)] : null;
}

function researchAssertionKinds(
  values: readonly ContextAssertionKind[] | undefined,
): ContextAssertionKind[] | null {
  const result = (values ?? []).filter((value): value is ContextAssertionKind => (
    value === "manual" || value === "legacy_import" || value === "generated"
    || value === "research_hypothesis"
  ));
  return result.length ? [...new Set(result)] : null;
}

function researchDepth(value: unknown): 1 | 2 | 3 {
  return value === 1 || value === 3 ? value : 2;
}

function researchNodeDepth(value: unknown, isCenter: boolean): 0 | 1 | 2 | 3 {
  if (isCenter) return 0;
  return value === 2 || value === 3 ? value : 1;
}

function researchNodeFallbackLabel(entityType: ResearchGraphEntityType): string {
  switch (entityType) {
    case "person": return "Особа";
    case "family": return "Сімейна група";
    case "place": return "Місце";
    case "event": return "Подія";
    case "document": return "Документ";
    case "finding": return "Знахідка";
    case "source": return "Джерело";
    case "repository": return "Архів або сховище";
    case "hypothesis": return "Гіпотеза";
  }
}

function deduplicateResearchNodes(nodes: readonly ResearchGraphNode[]): ResearchGraphNode[] {
  const uniqueNodes = new Map<ResearchGraphNodeId, ResearchGraphNode>();
  nodes.forEach((node) => {
    if (!uniqueNodes.has(node.id)) uniqueNodes.set(node.id, node);
  });
  return [...uniqueNodes.values()];
}

function deduplicateResearchEdges(edges: readonly ResearchGraphEdge[]): ResearchGraphEdge[] {
  const uniqueEdges = new Map<string, ResearchGraphEdge>();
  edges.forEach((edge) => {
    if (!uniqueEdges.has(edge.id)) uniqueEdges.set(edge.id, edge);
  });
  return [...uniqueEdges.values()];
}

function mapResearchGraphSavedView(
  value: unknown,
  expectedProjectId: string,
): ResearchGraphSavedView | null {
  try {
    const row = record(value);
    if (integer(row.configVersion ?? row.config_version) !== 1) return null;
    const id = cleanText(row.id);
    const projectId = cleanText(row.projectId ?? row.project_id);
    const ownerId = cleanText(row.ownerId ?? row.owner_id);
    const name = cleanText(row.name);
    const centerEntityType = cleanText(row.centerEntityType ?? row.center_entity_type);
    const centerEntityId = cleanText(row.centerEntityId ?? row.center_entity_id);
    if (
      !id
      || projectId !== expectedProjectId
      || !ownerId
      || !name
      || centerEntityType !== "person"
      || !centerEntityId
    ) return null;
    return {
      configVersion: 1,
      id,
      projectId,
      ownerId,
      name,
      description: cleanText(row.description),
      centerEntityType: "person",
      centerEntityId,
      filters: normalizeResearchGraphSavedViewFilters(record(row.filters)),
      viewState: normalizeResearchGraphSavedViewState(record(row.viewState ?? row.view_state)),
      lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
      createdAt: cleanText(row.createdAt ?? row.created_at),
      updatedAt: cleanText(row.updatedAt ?? row.updated_at),
    };
  } catch {
    return null;
  }
}

function mapResearchGraphViewShare(
  value: unknown,
  expectedProjectId: string,
  expectedViewId: string,
): ResearchGraphViewShare | null {
  const row = record(value);
  const id = cleanText(row.id);
  const accessMode = cleanText(row.accessMode ?? row.access_mode);
  const status = cleanText(row.status);
  const publicTitle = cleanText(row.publicTitle ?? row.public_title);
  const active = row.active === true;
  const expiresAt = isoTimestamp(row.expiresAt ?? row.expires_at);
  const revokedAt = isoTimestamp(row.revokedAt ?? row.revoked_at, true);
  if (
    !id
    || accessMode !== "public_readonly"
    || !publicTitle
    || publicTitle.length > 120
    || (status !== "active" && status !== "suspended" && status !== "expired" && status !== "revoked")
    || active !== (status === "active")
    || !expiresAt
  ) return null;
  return {
    id,
    projectId: expectedProjectId,
    savedViewId: expectedViewId,
    accessMode: "public_readonly",
    publicTitle,
    status,
    active,
    expiresAt,
    revokedAt: revokedAt || null,
    sourceViewLockVersion: positiveInteger(row.sourceViewLockVersion ?? row.source_view_lock_version),
    lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
    createdAt: isoTimestamp(row.createdAt ?? row.created_at),
    rotatedAt: isoTimestamp(row.rotatedAt ?? row.rotated_at),
    updatedAt: isoTimestamp(row.updatedAt ?? row.updated_at),
  };
}

function normalizeResearchGraphShareExpiry(value: unknown): string {
  const normalized = isoTimestamp(value);
  if (!normalized) throw new Error("Вкажіть строк дії посилання.");
  const timestamp = Date.parse(normalized);
  const now = Date.now();
  if (timestamp < now + 4 * 60_000) {
    throw new Error("Посилання має діяти щонайменше 5 хвилин.");
  }
  if (timestamp > now + 91 * 24 * 60 * 60_000) {
    throw new Error("Посилання може діяти не довше 90 днів.");
  }
  return normalized;
}

function normalizeResearchGraphPublicTitle(value: unknown): string {
  const normalized = cleanText(value);
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("Публічна назва має містити від 1 до 120 видимих символів.");
  }
  return normalized;
}

function mapSharedResearchGraphView(value: unknown): SharedResearchGraphView | null {
  const payload = record(value);
  const shareRow = record(payload.share);
  const viewRow = record(payload.view);
  const graphRow = record(payload.graph);
  const accessMode = cleanText(shareRow.accessMode ?? shareRow.access_mode);
  const expiresAt = isoTimestamp(shareRow.expiresAt ?? shareRow.expires_at);
  const publicTitle = cleanText(viewRow.title);
  const layoutId = optionalResearchGraphLayoutId(viewRow.layoutId ?? viewRow.layout_id);
  if (
    accessMode !== "public_readonly"
    || !expiresAt
    || !publicTitle
    || publicTitle.length > 120
    || !layoutId
  ) return null;

  const rawNodes = Array.isArray(graphRow.nodes) ? graphRow.nodes : [];
  const nodes = rawNodes
    .map(mapSharedResearchGraphNode)
    .filter((node): node is SharedResearchGraphNode => node !== null);
  if (!nodes.length || nodes.length !== rawNodes.length || nodes.length > 100) return null;
  const uniqueNodes = new Map(nodes.map((node) => [node.id, node] as const));
  if (uniqueNodes.size !== nodes.length) return null;
  const centerNodeId = cleanText(graphRow.centerNodeId ?? graphRow.center_node_id);
  const centerNode = uniqueNodes.get(centerNodeId);
  if (!centerNode || !centerNode.isCenter || centerNode.depth !== 0) return null;

  const rawEdges = Array.isArray(graphRow.edges) ? graphRow.edges : [];
  const edges = rawEdges
    .map(mapSharedResearchGraphEdge)
    .filter((edge): edge is SharedResearchGraphEdge => edge !== null);
  if (edges.length !== rawEdges.length || edges.length > 220) return null;
  const uniqueEdges = new Map(edges.map((edge) => [edge.id, edge] as const));
  if (
    uniqueEdges.size !== edges.length
    || edges.some((edge) => !uniqueNodes.has(edge.source) || !uniqueNodes.has(edge.target))
  ) return null;
  return {
    share: { accessMode: "public_readonly", expiresAt },
    view: {
      title: publicTitle,
      layoutId,
      zoom: boundedFiniteNumber(viewRow.zoom, 0.5, 2, 1),
      viewport: normalizeResearchGraphSavedViewState({
        layoutId,
        zoom: viewRow.zoom,
        viewport: viewRow.viewport,
      }).viewport,
    },
    graph: {
      centerNodeId,
      nodes: [...uniqueNodes.values()],
      edges: [...uniqueEdges.values()],
    },
  };
}

function mapSharedResearchGraphNode(value: unknown): SharedResearchGraphNode | null {
  const row = record(value);
  const id = cleanText(row.id);
  const entityType = cleanText(row.type);
  const isCenter = row.isCenter === true || row.is_center === true;
  const depth = researchNodeDepth(row.depth, isCenter);
  if (
    !id
    || !/^[A-Za-z0-9_-]{43}$/u.test(id)
    || (entityType !== "person" && entityType !== "place")
    || row.masked === true
  ) return null;
  return {
    id,
    entityType,
    label: cleanText(row.label) || (entityType === "person" ? "Особа" : "Місце"),
    secondaryLabel: cleanText(row.secondary),
    isCenter,
    masked: false,
    depth,
  };
}

function mapSharedResearchGraphEdge(value: unknown): SharedResearchGraphEdge | null {
  const row = record(value);
  const id = cleanText(row.id);
  const source = cleanText(row.source ?? row.source_id);
  const target = cleanText(row.target ?? row.target_id);
  const direction = cleanText(row.directionality);
  const status = cleanText(row.status);
  const kind = cleanText(row.assertionKind ?? row.assertion_kind);
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(id)
    || !/^[A-Za-z0-9_-]{43}$/u.test(source)
    || !/^[A-Za-z0-9_-]{43}$/u.test(target)
    || source === target
    || (direction !== "directed" && direction !== "symmetric")
    || !["proven", "likely", "disputed", "disproven", "unknown"].includes(status)
    || !["manual", "legacy_import", "generated", "research_hypothesis"].includes(kind)
  ) return null;
  return {
    id,
    source,
    target,
    label: cleanText(row.label ?? row.relationTypeLabel ?? row.relation_type_label) || "Публічний зв’язок",
    directionality: direction,
    evidenceStatus: status as ContextEvidenceStatus,
    assertionKind: kind as ContextAssertionKind,
    confidence: boundedInteger(row.confidence, 0, 100, 0),
    generated: row.generated === true || kind === "generated",
  };
}

function isoTimestamp(value: unknown, allowEmpty = false): string {
  const normalized = cleanText(value);
  if (!normalized) return allowEmpty ? "" : "";
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function normalizeResearchGraphSavedViewDraft(
  draft: ResearchGraphSavedViewDraft,
): Record<string, unknown> {
  if (draft.configVersion !== 1) {
    throw new Error("Непідтримувана версія конфігурації представлення графа.");
  }
  const name = draft.name.trim();
  const description = cleanText(draft.description);
  if (!name) throw new Error("Вкажіть назву представлення графа.");
  if (name.length > 120) throw new Error("Назва представлення може містити не більше 120 символів.");
  if (description.length > 500) throw new Error("Опис представлення може містити не більше 500 символів.");
  if (draft.centerEntityType !== "person") {
    throw new Error("Ця версія може зберігати представлення лише навколо особи.");
  }
  const filters = normalizeResearchGraphSavedViewFilters(draft.filters);
  return {
    configVersion: 1,
    ...(draft.id ? { id: requiredId(draft.id, "збережене представлення") } : {}),
    name,
    description,
    centerEntityType: "person",
    centerEntityId: requiredId(draft.centerEntityId, "центральну особу"),
    filters: {
      ...filters,
      // PostgREST casts these JSON fields to PostgreSQL dates inside the RPC.
      // Empty strings are not dates, so absent optional bounds must cross the
      // transport boundary as JSON null and map back to "" in the read model.
      validFrom: filters.validFrom || null,
      validTo: filters.validTo || null,
      focusDate: filters.focusDate || null,
    },
    viewState: normalizeResearchGraphSavedViewState(draft.viewState),
  };
}

function normalizeResearchGraphSavedViewFilters(value: unknown): ResearchGraphSavedViewFilters {
  const row = record(value);
  const validFrom = normalizeHistoricalDate(
    row.validFrom ?? row.valid_from,
    "start",
    "початкову дату",
  );
  const validTo = normalizeHistoricalDate(
    row.validTo ?? row.valid_to,
    "end",
    "кінцеву дату",
  );
  if (validFrom && validTo && validFrom > validTo) {
    throw new Error("Збережене представлення містить некоректний діапазон дат.");
  }
  const focusDate = normalizeExactHistoricalDate(
    row.focusDate ?? row.focus_date,
    "дату часового зрізу",
  );
  const focusYear = optionalHistoricalYear(
    row.focusYear ?? row.focus_year,
    "рік часового зрізу",
  );
  if (focusDate && focusYear !== null) {
    throw new Error("Збережене представлення містить два часові зрізи одночасно.");
  }
  const rawEntityTypes = row.entityTypes ?? row.entity_types;
  const rawEvidenceStatuses = row.evidenceStatuses ?? row.evidence_statuses;
  const rawAssertionKinds = row.assertionKinds ?? row.assertion_kinds;
  const entityTypes = researchEntityTypes(
    Array.isArray(rawEntityTypes) ? rawEntityTypes as ResearchGraphEntityType[] : [],
  ) ?? [];
  const evidenceStatuses = documentaryEvidenceStatuses(
    Array.isArray(rawEvidenceStatuses) ? rawEvidenceStatuses as ContextEvidenceStatus[] : [],
  ) ?? [];
  const assertionKinds = researchAssertionKinds(
    Array.isArray(rawAssertionKinds) ? rawAssertionKinds as ContextAssertionKind[] : [],
  ) ?? [];
  const rawHasEvidence = row.hasEvidence ?? row.has_evidence;
  return {
    depth: researchDepth(row.depth),
    entityTypes,
    relationTypeIds: uniqueTexts(row.relationTypeIds ?? row.relation_type_ids),
    evidenceStatuses,
    assertionKinds,
    validFrom,
    validTo,
    minConfidence: boundedInteger(row.minConfidence ?? row.min_confidence, 0, 100, 0),
    hasEvidence: typeof rawHasEvidence === "boolean" ? rawHasEvidence : null,
    focusDate,
    focusYear,
    placeIds: uniqueTexts(row.placeIds ?? row.place_ids).slice(0, 50),
    includeUndated: booleanValue(row.includeUndated ?? row.include_undated),
    maxNodes: boundedInteger(row.maxNodes ?? row.max_nodes, 1, 100, 100),
    maxEdges: boundedInteger(row.maxEdges ?? row.max_edges, 1, 250, 220),
  };
}

function normalizeResearchGraphSavedViewState(value: unknown): ResearchGraphSavedViewState {
  const row = record(value);
  const viewport = record(row.viewport);
  return {
    layoutId: researchGraphLayoutId(row.layoutId ?? row.layout_id),
    zoom: boundedFiniteNumber(row.zoom, 0.5, 2, 1),
    viewport: {
      x: boundedFiniteNumber(viewport.x, 0, 10_000_000, 0),
      y: boundedFiniteNumber(viewport.y, 0, 10_000_000, 0),
      width: boundedFiniteNumber(viewport.width, 0, 100_000, 0),
      height: boundedFiniteNumber(viewport.height, 0, 100_000, 0),
    },
  };
}

function researchGraphLayoutId(value: unknown): ResearchGraphSavedViewState["layoutId"] {
  const layoutId = optionalResearchGraphLayoutId(value);
  if (layoutId) return layoutId;
  throw new Error("Непідтримуваний макет збереженого представлення графа.");
}

function optionalResearchGraphLayoutId(
  value: unknown,
): ResearchGraphSavedViewState["layoutId"] | null {
  return value === "radial" || value === "hierarchical" || value === "force"
    ? value
    : null;
}

function researchGraphSavedViewError(error: unknown): unknown {
  const payload = record(error);
  const code = cleanText(payload.code).toUpperCase();
  const description = [payload.message, payload.details, payload.hint, error instanceof Error ? error.message : ""]
    .map((item) => cleanText(item).toLocaleLowerCase("en-US"))
    .filter(Boolean)
    .join(" ");
  const mentionsSavedViews = description.includes("context_graph_saved_view")
    || description.includes("context_graph_saved_views");
  if ((code === "PGRST202" || code === "42883" || code === "42P01") && mentionsSavedViews) {
    return new Error("Збережені представлення стануть доступними після застосування міграції графа.");
  }
  if (description.includes("name_exists") || description.includes("duplicate name")) {
    return new Error("Особисте представлення з такою назвою вже існує. Виберіть іншу назву.");
  }
  if (description.includes("quota_exceeded") || description.includes("view quota")) {
    return new Error("Досягнуто ліміт у 50 особистих представлень для цього проєкту. Видаліть непотрібне представлення.");
  }
  if (description.includes("version_conflict") || description.includes("lock version")) {
    return new Error("Представлення вже змінено в іншій вкладці. Перезавантажте список перед повторним редагуванням.");
  }
  if (description.includes("center_stale")) {
    return new Error("Центральна особа цього представлення більше недоступна. Представлення потребує оновлення.");
  }
  if (
    description.includes("filter_stale")
    || description.includes("relation_stale")
    || description.includes("place_stale")
    || description.includes("place_not_canonical")
  ) {
    return new Error("Один зі збережених фільтрів більше недоступний. Представлення потребує оновлення й не було застосоване.");
  }
  if (description.includes("config_version_unsupported") || description.includes("unsupported config")) {
    return new Error("Версія конфігурації цього представлення не підтримується поточною версією застосунку.");
  }
  if (description.includes("context_graph_saved_view_not_found")) {
    return new Error("Представлення не знайдено або воно належить іншому користувачу.");
  }
  return error;
}

function researchGraphShareError(error: unknown): unknown {
  const payload = record(error);
  const code = cleanText(payload.code).toUpperCase();
  const description = [payload.message, payload.details, payload.hint, error instanceof Error ? error.message : ""]
    .map((item) => cleanText(item).toLocaleLowerCase("en-US"))
    .filter(Boolean)
    .join(" ");
  if (
    (code === "PGRST202" || code === "42883" || code === "42P01")
    && description.includes("context_graph")
    && description.includes("share")
  ) {
    return new Error("Поширення графа стане доступним після застосування міграції share links.");
  }
  if (
    description.includes("context_graph_share_unavailable")
    || description.includes("expired")
    || description.includes("revoked")
    || description.includes("token_invalid")
  ) {
    // Do not reveal whether a bearer token existed, expired or was revoked.
    return new Error("Це посилання недійсне або більше не активне.");
  }
  if (description.includes("owner_required") || description.includes("permission_denied")) {
    return new Error("Керувати публічними посиланнями може лише власник проєкту.");
  }
  if (description.includes("auth_required")) {
    return new Error("Увійдіть до облікового запису, щоб керувати посиланнями.");
  }
  if (description.includes("view_not_found") || description.includes("context_graph_share_not_found")) {
    return new Error("Посилання або збережене представлення більше не доступне. Оновіть список.");
  }
  if (description.includes("version_conflict") || description.includes("lock version")) {
    return new Error("Посилання вже змінено в іншій вкладці. Оновіть список і повторіть дію.");
  }
  if (description.includes("expiry") || description.includes("expires_at")) {
    return new Error("Оберіть строк дії посилання від 5 хвилин до 90 днів.");
  }
  if (description.includes("public_title_invalid")) {
    return new Error("Публічна назва має містити від 1 до 120 видимих символів.");
  }
  if (description.includes("access_mode_invalid")) {
    return new Error("Сервер не підтримує запитаний режим поширення графа.");
  }
  if (description.includes("expected_lock_required")) {
    return new Error("Не вдалося безпечно перевірити версію посилання. Оновіть список.");
  }
  if (description.includes("center_not_public") || description.includes("privacy")) {
    return new Error("Це представлення не можна опублікувати через налаштування приватності центральної особи.");
  }
  return error;
}

function rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const payload = record(value);
  return Array.isArray(payload.items) ? payload.items : [];
}

function nonEmptyTexts(values: readonly unknown[] | undefined): string[] | null {
  const result = (values ?? []).map((value) => text(value).trim()).filter(Boolean);
  return result.length ? [...new Set(result)] : null;
}

function uniqueNonEmptyTexts(values: readonly unknown[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => text(value).trim()).filter(Boolean))];
}

function sameTextSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}

function uniqueTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item).trim()).filter(Boolean))];
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim();
  return result || null;
}

function cleanText(value: unknown): string {
  return text(value).trim();
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function nullableYear(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 9999 ? parsed : null;
}

function optionalHistoricalYear(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 9999) {
    throw new Error(`Вкажіть коректний ${label} від 1 до 9999.`);
  }
  return parsed;
}

function positiveInteger(value: unknown): number {
  return Math.max(1, integer(value));
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function boundedFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function optionalBoundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function requiredId(value: string, label: string): string {
  const id = value.trim();
  if (!id) throw new Error(`Не вказано ${label}.`);
  return id;
}

function normalizeHistoricalDate(
  value: unknown,
  boundary: "start" | "end",
  label: string,
): string {
  const normalized = cleanText(value);
  if (!normalized) return "";
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(normalized);
  if (!match) {
    throw new Error(`Вкажіть ${label} у форматі РРРР, РРРР-ММ або РРРР-ММ-ДД.`);
  }
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : boundary === "start" ? 1 : 12;
  const maximumDay = historicalDaysInMonth(year, month);
  const day = match[3] ? Number(match[3]) : boundary === "start" ? 1 : maximumDay;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > maximumDay) {
    throw new Error(`Вкажіть коректну ${label}.`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeExactHistoricalDate(value: unknown, label: string): string {
  const normalized = cleanText(value);
  if (!normalized) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new Error(`Вкажіть ${label} у форматі РРРР-ММ-ДД.`);
  }
  return normalizeHistoricalDate(normalized, "start", label);
}

function historicalDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isMissingResearchGraphV2Error(error: unknown): boolean {
  const payload = record(error);
  const code = cleanText(payload.code).toUpperCase();
  const description = [payload.message, payload.details, payload.hint, error instanceof Error ? error.message : ""]
    .map((value) => cleanText(value).toLocaleLowerCase("en-US"))
    .filter(Boolean)
    .join(" ");
  if (code === "PGRST202" || code === "42883") return true;
  return description.includes("get_person_research_context_graph_v2")
    && (description.includes("schema cache")
      || description.includes("does not exist")
      || description.includes("could not find the function")
      || description.includes("undefined function"));
}

function historicalPeriodText(validFrom: unknown, validTo: unknown): string {
  const from = cleanText(validFrom);
  const to = cleanText(validTo);
  if (!from && !to) return "";
  if (from && to && from === to) return from;
  return [from || "…", to || "…"].join(" — ");
}

function validateIsoDate(value: unknown, label: string): void {
  const normalized = cleanText(value);
  if (!normalized) return;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new Error(`Вкажіть ${label} повністю у форматі РРРР-ММ-ДД.`);
  }
  const [year, month, day] = normalized.split("-").map(Number);
  if (year < 1) {
    throw new Error(`Вкажіть коректну ${label}.`);
  }
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`Вкажіть коректну ${label}.`);
  }
}

function relationCategory(value: unknown): ContextRelationCategory {
  return value === "church" || value === "household" || value === "social"
    || value === "military" || value === "documentary" || value === "research"
    || value === "occupation" || value === "education" || value === "other"
    ? value
    : "other";
}

function directionality(value: unknown): ContextRelationDirectionality {
  return value === "symmetric" ? "symmetric" : "directed";
}

function evidenceStatus(value: unknown): ContextEvidenceStatus {
  return value === "proven" || value === "likely" || value === "disputed"
    || value === "disproven" || value === "unknown"
    ? value
    : "unknown";
}

function privacyStatus(value: unknown): ContextPrivacyStatus {
  return value === "private" || value === "public" || value === "confidential"
    ? value
    : "project";
}

function assertionKind(value: unknown): ContextAssertionKind {
  return value === "legacy_import" || value === "generated" || value === "research_hypothesis"
    ? value
    : "manual";
}

function evidenceKind(value: unknown): ContextEvidenceKind {
  return value === "document" || value === "finding" || value === "event"
    || value === "citation" || value === "document_fragment" || value === "legacy_text"
    || value === "note" || value === "other"
    ? value
    : "other";
}
