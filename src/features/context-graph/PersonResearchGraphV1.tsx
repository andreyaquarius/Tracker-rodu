import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Person } from "../../types";
import type {
  ContextAssertionKind,
  ContextEvidenceStatus,
  ContextRelationEvidenceV2,
  ContextRelationType,
  ContextRelationV2,
  ContextRelationV2Draft,
  ResearchGraphPlaceOption,
  ResearchGraphLayoutId,
  ResearchGraphSavedView,
  ResearchGraphSavedViewDraft,
  ResearchGraphSavedViewport,
  ResearchGraphTargetOption,
} from "../../types/contextGraph.ts";
import {
  buildResearchGraphLayout,
  filterResearchGraphSnapshot,
  isResearchHypothesisEdge,
  type PersonResearchGraphFilters,
  type PersonResearchGraphSnapshot,
  type ResearchGraphEdge,
  type ResearchGraphEntityType,
  type ResearchGraphLayoutNode,
  type ResearchGraphNode,
} from "./researchGraphModel.ts";
import {
  clampResearchGraphViewport,
  clampResearchGraphZoom,
  isResearchGraphLayoutId,
  RESEARCH_GRAPH_DEFAULT_LAYOUT_ID,
  RESEARCH_GRAPH_MAX_ZOOM,
  RESEARCH_GRAPH_MIN_ZOOM,
  RESEARCH_GRAPH_SAVED_VIEW_CONFIG_VERSION,
  RESEARCH_GRAPH_ZOOM_STEP,
  researchGraphSavedFiltersSupported,
} from "./researchGraphSavedViewModel.ts";
import { isLegacyAmbiguousSocialRelationTypeCode } from "./socialCircleModel.ts";
import { ResearchGraphShareManager } from "./ResearchGraphShareManager.tsx";
import "./PersonResearchGraphV1.css";

interface ResearchGraphServiceModule {
  getPersonResearchGraph(
    projectId: string,
    centerPersonId: string,
    filters?: PersonResearchGraphFilters,
  ): Promise<PersonResearchGraphSnapshot>;
  searchResearchGraphPlaces(
    projectId: string,
    query: string,
    options?: { focusDate?: string; focusYear?: number; limit?: number; signal?: AbortSignal },
  ): Promise<ResearchGraphPlaceOption[]>;
  resolveResearchGraphSavedPlace(
    projectId: string,
    placeId: string,
    options?: { focusDate?: string; focusYear?: number; signal?: AbortSignal },
  ): Promise<ResearchGraphPlaceOption | null>;
  listResearchGraphSavedViews(projectId: string): Promise<{ items: ResearchGraphSavedView[]; total: number }>;
  getResearchGraphSavedView(projectId: string, viewId: string): Promise<ResearchGraphSavedView>;
  saveResearchGraphSavedView(
    projectId: string,
    draft: ResearchGraphSavedViewDraft,
    expectedLockVersion?: number,
  ): Promise<ResearchGraphSavedView>;
  deleteResearchGraphSavedView(
    projectId: string,
    viewId: string,
    expectedLockVersion: number,
  ): Promise<void>;
  listContextRelationTypes(projectId: string, includeInactive?: boolean): Promise<ContextRelationType[]>;
  saveContextRelation(
    projectId: string,
    draft: ContextRelationV2Draft,
    expectedLockVersion?: number,
  ): Promise<ContextRelationV2>;
  archiveContextRelation(
    projectId: string,
    relationId: string,
    expectedLockVersion: number,
  ): Promise<ContextRelationV2>;
  getContextRelationEvidence(projectId: string, relationId: string): Promise<ContextRelationEvidenceV2[]>;
  saveContextRelationEvidence(
    projectId: string,
    draft: {
      relationId: string;
      evidenceEntityType: "document" | "finding";
      evidenceEntityId: string;
      sourceLocator?: string;
      excerpt?: string;
    },
  ): Promise<ContextRelationEvidenceV2>;
  archiveContextRelationEvidence(
    projectId: string,
    evidenceId: string,
    expectedLockVersion: number,
  ): Promise<ContextRelationEvidenceV2>;
}

let servicePromise: Promise<ResearchGraphServiceModule> | undefined;

async function loadResearchGraphService(): Promise<ResearchGraphServiceModule> {
  servicePromise ??= import("../../services/contextRelationsService.ts")
    .then((module) => {
      const service = module as unknown as Partial<ResearchGraphServiceModule>;
      if (typeof service.getPersonResearchGraph !== "function") {
        throw new Error("Дослідницький граф ще не доступний у цій версії застосунку.");
      }
      return service as ResearchGraphServiceModule;
    })
    .catch((error) => {
      servicePromise = undefined;
      throw error;
    });
  return servicePromise;
}

type AssertionFilter = ContextAssertionKind | "all";
type EvidenceFilter = ContextEvidenceStatus | "all";
type EvidencePresenceFilter = "all" | "yes" | "no";
type TemporalFocusMode = "all" | "year" | "date";

interface FilterState {
  depth: 1 | 2 | 3;
  entityTypes: ResearchGraphEntityType[];
  relationTypeId: string;
  evidenceStatus: EvidenceFilter;
  assertionKind: AssertionFilter;
  minConfidence: number;
  validFrom: string;
  validTo: string;
  hasEvidence: EvidencePresenceFilter;
  placeId: string;
  placeLabel: string;
  temporalMode: TemporalFocusMode;
  focusYear: number;
  focusDate: string;
  includeUndated: boolean;
}

interface AppliedFilterState {
  contextKey: string;
  value: FilterState;
}

interface PreparedSavedView {
  view: ResearchGraphSavedView;
  filters: FilterState;
}

type EditableTargetEntityType = ResearchGraphTargetOption["entityType"];

interface RelationEditorState {
  targetEntityType: EditableTargetEntityType;
  targetEntityId: string;
  relationTypeId: string;
  centerEndpoint: "source" | "target";
  assertionKind: "manual" | "research_hypothesis";
  evidenceStatus: ContextEvidenceStatus;
  confidence: number;
  validFrom: string;
  validTo: string;
  notes: string;
}

interface EvidenceEditorState {
  entityType: "document" | "finding";
  entityId: string;
  sourceLocator: string;
  excerpt: string;
}

export interface PersonResearchGraphV1Props {
  projectId: string;
  center: Person;
  targetOptions?: readonly ResearchGraphTargetOption[];
  canEdit?: boolean;
  readOnly?: boolean;
  canManageShareLinks?: boolean;
  onBack?: () => void;
  onFocusPerson?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onOpenFinding?: (findingId: string) => void;
  onOpenPlace?: (placeId: string) => void;
  onOpenHypothesis?: (hypothesisId: string) => void;
}

/**
 * A bounded read projection for hypotheses and the evidence that supports or
 * contradicts them. It deliberately never writes to the family-tree model.
 */
export function PersonResearchGraphV1({
  projectId,
  center,
  targetOptions = [],
  canEdit = false,
  readOnly = false,
  canManageShareLinks = false,
  onBack,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
  onOpenPlace,
  onOpenHypothesis,
}: PersonResearchGraphV1Props) {
  const headingId = useId();
  const filterHeadingId = useId();
  const detailHeadingId = useId();
  const savedViewsHeadingId = useId();
  const savedViewNameHelpId = useId();
  const placeListId = useId();
  const layoutPickerName = useId();
  const arrowMarkerId = useId().replace(/:/gu, "");
  const requestSequence = useRef(0);
  const evidenceRequestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const placeSearchSequence = useRef(0);
  const savedViewsRequestSequence = useRef(0);
  const savedViewMutationSequence = useRef(0);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pendingViewport = useRef<ResearchGraphSavedViewport | null>(null);
  const currentViewport = useRef<ResearchGraphSavedViewport>({ x: 0, y: 0, width: 0, height: 0 });
  const pendingSavedView = useRef<PreparedSavedView | null>(null);
  const activeSelectedEdgeId = useRef("");
  const contextKey = `${projectId}:${center.id}`;
  const activeContextKey = useRef(contextKey);
  activeContextKey.current = contextKey;
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const [filterDraft, setFilterDraft] = useState<FilterState>(defaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilterState>(() => ({
    contextKey,
    value: defaultFilters(),
  }));
  const [snapshot, setSnapshot] = useState<PersonResearchGraphSnapshot | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [relationTypes, setRelationTypes] = useState<ContextRelationType[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDraft, setEditorDraft] = useState<RelationEditorState>(() => defaultRelationEditor());
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationMessage, setMutationMessage] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [evidence, setEvidence] = useState<ContextRelationEvidenceV2[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");
  const [evidenceDraft, setEvidenceDraft] = useState<EvidenceEditorState>(() => defaultEvidenceEditor());
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeOptions, setPlaceOptions] = useState<ResearchGraphPlaceOption[]>([]);
  const [placeSearchLoading, setPlaceSearchLoading] = useState(false);
  const [placeSearchError, setPlaceSearchError] = useState("");
  const [savedViews, setSavedViews] = useState<ResearchGraphSavedView[]>([]);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [savedViewsError, setSavedViewsError] = useState("");
  const [savedViewMutationBusy, setSavedViewMutationBusy] = useState(false);
  const [savedViewMessage, setSavedViewMessage] = useState("");
  const [savedViewName, setSavedViewName] = useState("");
  const [selectedSavedViewId, setSelectedSavedViewId] = useState("");
  const [sharingSavedViewId, setSharingSavedViewId] = useState("");
  const [layoutId, setLayoutId] = useState<ResearchGraphLayoutId>(RESEARCH_GRAPH_DEFAULT_LAYOUT_ID);
  const [zoom, setZoom] = useState(1);

  const activeFilters = appliedFilters.contextKey === contextKey
    ? appliedFilters.value
    : null;

  const loadGraph = useCallback(async (filters: FilterState) => {
    const sequence = ++requestSequence.current;
    const requestContextKey = contextKey;
    setLoading(true);
    setLoadError("");
    setSnapshot(null);
    try {
      const service = await loadResearchGraphService();
      const result = await service.getPersonResearchGraph(
        projectId,
        center.id,
        toServiceFilters(filters),
      );
      if (sequence !== requestSequence.current || requestContextKey !== activeContextKey.current) return;
      setSnapshot(result);
      const centerNodeId = result.nodes.find((node) => node.isCenter)?.id ?? result.nodes[0]?.id ?? "";
      setSelectedNodeId(centerNodeId);
    } catch (error) {
      if (sequence !== requestSequence.current || requestContextKey !== activeContextKey.current) return;
      setLoadError(errorMessage(error, "Не вдалося завантажити дослідницький граф."));
    } finally {
      if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) {
        setLoading(false);
      }
    }
  }, [center.id, contextKey, projectId]);

  const restorePreparedSavedView = useCallback((prepared: PreparedSavedView) => {
    const nextFilters = copyFilters(prepared.filters);
    setSnapshot(null);
    setSelectedNodeId("");
    setSelectedEdgeId("");
    setEvidence([]);
    setEvidenceError("");
    setFilterDraft(nextFilters);
    setAppliedFilters({ contextKey, value: copyFilters(nextFilters) });
    setSelectedSavedViewId(prepared.view.id);
    setSavedViewName(prepared.view.name);
    setLayoutId(prepared.view.viewState.layoutId);
    setZoom(clampResearchGraphZoom(prepared.view.viewState.zoom));
    pendingViewport.current = { ...prepared.view.viewState.viewport };
    currentViewport.current = { ...prepared.view.viewState.viewport };
    setPlaceQuery(nextFilters.placeLabel);
    setPlaceOptions([]);
    setPlaceSearchError("");
    setLoadError("");
    setSavedViewsError("");
    setSavedViewMessage(`Представлення «${prepared.view.name}» завантажено.`);
  }, [contextKey]);

  useEffect(() => {
    if (appliedFilters.contextKey === contextKey) return;
    const prepared = pendingSavedView.current;
    if (prepared?.view.projectId === projectId && prepared.view.centerEntityId === center.id) {
      pendingSavedView.current = null;
      mutationSequence.current += 1;
      evidenceRequestSequence.current += 1;
      placeSearchSequence.current += 1;
      setEditorOpen(false);
      setMutationBusy(false);
      setSavedViewMutationBusy(false);
      setMutationMessage("");
      setSelectedEdgeId("");
      setEvidence([]);
      setEvidenceError("");
      restorePreparedSavedView(prepared);
      return;
    }
    const next = defaultFilters();
    pendingSavedView.current = null;
    savedViewMutationSequence.current += 1;
    setSavedViewMutationBusy(false);
    setFilterDraft(next);
    setAppliedFilters({ contextKey, value: copyFilters(next) });
    setSnapshot(null);
    setSelectedNodeId("");
    setLoadError("");
    setEditorOpen(false);
    mutationSequence.current += 1;
    setMutationBusy(false);
    setMutationMessage("");
    setSelectedEdgeId("");
    setEvidence([]);
    setEvidenceError("");
    placeSearchSequence.current += 1;
    setPlaceQuery("");
    setPlaceOptions([]);
    setPlaceSearchLoading(false);
    setPlaceSearchError("");
    setSelectedSavedViewId("");
    setSharingSavedViewId("");
    setSavedViewName("");
    setSavedViewMessage("");
    setLayoutId(RESEARCH_GRAPH_DEFAULT_LAYOUT_ID);
    setZoom(1);
    pendingViewport.current = null;
    currentViewport.current = { x: 0, y: 0, width: 0, height: 0 };
  }, [appliedFilters.contextKey, center.id, contextKey, restorePreparedSavedView]);

  useEffect(() => {
    const sequence = ++savedViewsRequestSequence.current;
    savedViewMutationSequence.current += 1;
    setSavedViews([]);
    setSavedViewsLoading(true);
    setSavedViewsError("");
    setSavedViewMessage("");
    setSelectedSavedViewId("");
    setSharingSavedViewId("");
    setSavedViewName("");
    void loadResearchGraphService()
      .then((service) => service.listResearchGraphSavedViews(projectId))
      .then((page) => {
        if (sequence !== savedViewsRequestSequence.current) return;
        setSavedViews(page.items);
      })
      .catch((error) => {
        if (sequence !== savedViewsRequestSequence.current) return;
        setSavedViewsError(errorMessage(error, "Не вдалося завантажити збережені представлення."));
      })
      .finally(() => {
        if (sequence === savedViewsRequestSequence.current) setSavedViewsLoading(false);
      });
    return () => { savedViewsRequestSequence.current += 1; };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setRelationTypes([]);
    void loadResearchGraphService()
      .then((service) => service.listContextRelationTypes(projectId))
      .then((items) => {
        if (!cancelled) setRelationTypes(items.filter((item) => item.isActive));
      })
      .catch((error) => {
        if (!cancelled && canEdit && !readOnly) {
          setMutationMessage(errorMessage(error, "Не вдалося завантажити типи контекстних зв’язків."));
        }
      });
    return () => { cancelled = true; };
  }, [canEdit, projectId, readOnly]);

  useEffect(() => {
    const query = placeQuery.trim();
    const sequence = ++placeSearchSequence.current;
    const requestContextKey = contextKey;
    if (filterDraft.placeId && query === filterDraft.placeLabel) {
      setPlaceOptions([]);
      setPlaceSearchLoading(false);
      setPlaceSearchError("");
      return undefined;
    }
    if (query.length < 2) {
      setPlaceOptions([]);
      setPlaceSearchLoading(false);
      setPlaceSearchError("");
      return undefined;
    }
    const controller = new AbortController();
    setPlaceSearchLoading(true);
    setPlaceSearchError("");
    const timer = window.setTimeout(() => {
      void loadResearchGraphService()
        .then((service) => service.searchResearchGraphPlaces(projectId, query, {
          focusDate: filterDraft.temporalMode === "date" && !exactHistoricalDateError(filterDraft.focusDate)
            ? filterDraft.focusDate.trim()
            : undefined,
          focusYear: filterDraft.temporalMode === "year" ? filterDraft.focusYear : undefined,
          limit: 12,
          signal: controller.signal,
        }))
        .then((items) => {
          if (sequence !== placeSearchSequence.current || requestContextKey !== activeContextKey.current) return;
          setPlaceOptions(items);
        })
        .catch((error) => {
          if (isAbortError(error) || sequence !== placeSearchSequence.current || requestContextKey !== activeContextKey.current) return;
          setPlaceSearchError(errorMessage(error, "Не вдалося знайти місце в історичному каталозі."));
        })
        .finally(() => {
          if (sequence === placeSearchSequence.current && requestContextKey === activeContextKey.current) {
            setPlaceSearchLoading(false);
          }
        });
    }, 280);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    contextKey,
    filterDraft.focusDate,
    filterDraft.focusYear,
    filterDraft.placeId,
    filterDraft.placeLabel,
    filterDraft.temporalMode,
    placeQuery,
    projectId,
  ]);

  useEffect(() => {
    if (!activeFilters) return undefined;
    void loadGraph(activeFilters);
    return () => {
      requestSequence.current += 1;
    };
  }, [activeFilters, loadGraph]);

  const visibleSnapshot = useMemo(() => (
    snapshot && activeFilters
      ? filterResearchGraphSnapshot(snapshot, {
        entityTypes: activeFilters.entityTypes,
        relationTypeIds: activeFilters.relationTypeId === "all"
          ? undefined
          : [activeFilters.relationTypeId],
        evidenceStatuses: activeFilters.evidenceStatus === "all"
          ? undefined
          : [activeFilters.evidenceStatus],
        assertionKinds: activeFilters.assertionKind === "all"
          ? undefined
          : [activeFilters.assertionKind],
        confidenceMin: activeFilters.minConfidence,
        maxNodes: snapshot.limits.maxNodes,
        maxEdges: snapshot.limits.maxEdges,
      })
      : null
  ), [activeFilters, snapshot]);
  const layout = useMemo(() => {
    if (!visibleSnapshot) return null;
    return buildResearchGraphLayout(visibleSnapshot.nodes, visibleSnapshot.edges, layoutId);
  }, [layoutId, visibleSnapshot]);

  useEffect(() => {
    if (!layout || !pendingViewport.current) return undefined;
    const requested = pendingViewport.current;
    const frame = window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas || !pendingViewport.current) return;
      const clamped = clampResearchGraphViewport(requested, {
        scrollWidth: canvas.scrollWidth,
        scrollHeight: canvas.scrollHeight,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
      });
      canvas.scrollTo({ left: clamped.x, top: clamped.y, behavior: "auto" });
      currentViewport.current = clamped;
      pendingViewport.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layout, zoom]);
  const nodesById = useMemo(
    () => new Map(visibleSnapshot?.nodes.map((node) => [node.id, node]) ?? []),
    [visibleSnapshot],
  );
  const selectedNode = selectedNodeId
    ? nodesById.get(selectedNodeId as ResearchGraphNode["id"]) ?? null
    : null;
  const selectedEdges = useMemo(
    () => selectedNode
      ? (visibleSnapshot?.edges ?? []).filter(
        (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
      )
      : [],
    [selectedNode, visibleSnapshot?.edges],
  );
  const selectedEdge = selectedEdgeId
    ? selectedEdges.find((edge) => edge.id === selectedEdgeId) ?? null
    : null;
  activeSelectedEdgeId.current = selectedEdge?.id ?? "";
  const relationTypesById = useMemo(
    () => new Map(relationTypes.map((item) => [item.id, item] as const)),
    [relationTypes],
  );
  const targetsByKey = useMemo(
    () => new Map(targetOptions.map((item) => [`${item.entityType}:${item.entityId}`, item] as const)),
    [targetOptions],
  );
  const availableTargetTypes = useMemo(
    () => EDITABLE_TARGET_TYPE_OPTIONS.filter((type) => targetOptions.some((item) => (
      item.entityType === type.value && !(type.value === "person" && item.entityId === center.id)
    ))),
    [center.id, targetOptions],
  );
  const unavailableTargetTypes = useMemo(
    () => EDITABLE_TARGET_TYPE_OPTIONS.filter((type) => !availableTargetTypes.some((item) => item.value === type.value)),
    [availableTargetTypes],
  );
  const availableTargets = useMemo(
    () => targetOptions.filter((item) => (
      item.entityType === editorDraft.targetEntityType
      && !(item.entityType === "person" && item.entityId === center.id)
    )),
    [center.id, editorDraft.targetEntityType, targetOptions],
  );
  const evidenceTargets = useMemo(
    () => targetOptions.filter((item) => item.entityType === evidenceDraft.entityType),
    [evidenceDraft.entityType, targetOptions],
  );
  const editorRelationTypes = useMemo(
    () => relationTypes.filter((type) => contextRelationTypeSupportsTarget(type, editorDraft.targetEntityType)),
    [editorDraft.targetEntityType, relationTypes],
  );
  const editorRelationType = relationTypesById.get(editorDraft.relationTypeId);
  const editorTarget = targetsByKey.get(`${editorDraft.targetEntityType}:${editorDraft.targetEntityId}`);

  useEffect(() => {
    if (selectedEdges.some((edge) => edge.id === selectedEdgeId)) return;
    setSelectedEdgeId(selectedEdges[0]?.id ?? "");
  }, [selectedEdgeId, selectedEdges]);

  useEffect(() => {
    const sequence = ++evidenceRequestSequence.current;
    setEvidence([]);
    setEvidenceError("");
    if (!selectedEdge) {
      setEvidenceLoading(false);
      return undefined;
    }
    setEvidenceLoading(true);
    void loadResearchGraphService()
      .then((service) => service.getContextRelationEvidence(projectId, selectedEdge.id))
      .then((items) => {
        if (sequence === evidenceRequestSequence.current) setEvidence(items);
      })
      .catch((error) => {
        if (sequence === evidenceRequestSequence.current) {
          setEvidenceError(errorMessage(error, "Не вдалося завантажити деталі доказів."));
        }
      })
      .finally(() => {
        if (sequence === evidenceRequestSequence.current) setEvidenceLoading(false);
      });
    return () => { evidenceRequestSequence.current += 1; };
  }, [projectId, selectedEdge]);

  const applyFilters = () => {
    const dateError = partialHistoricalDateRangeError(filterDraft.validFrom, filterDraft.validTo);
    const focusError = temporalFocusError(filterDraft);
    const placeError = placeQuery.trim() && !filterDraft.placeId
      ? "Оберіть конкретне місце з результатів історичного каталогу або очистьте поле."
      : "";
    if (dateError || focusError || placeError) {
      setLoadError(dateError || focusError || placeError);
      return;
    }
    setLoadError("");
    setAppliedFilters({ contextKey, value: copyFilters(filterDraft) });
  };

  const resetFilters = () => {
    const next = defaultFilters();
    setFilterDraft(next);
    setAppliedFilters({ contextKey, value: copyFilters(next) });
    setPlaceQuery("");
    setPlaceOptions([]);
    setPlaceSearchError("");
    setLoadError("");
  };

  const toggleEntityType = (entityType: ResearchGraphEntityType) => {
    setFilterDraft((current) => {
      const includes = current.entityTypes.includes(entityType);
      if (includes && current.entityTypes.length === 1) return current;
      return {
        ...current,
        entityTypes: includes
          ? current.entityTypes.filter((item) => item !== entityType)
          : [...current.entityTypes, entityType],
      };
    });
  };

  const updateTemporalFocus = (
    patch: Partial<Pick<FilterState, "temporalMode" | "focusYear" | "focusDate">>,
  ) => {
    placeSearchSequence.current += 1;
    setFilterDraft((current) => ({
      ...current,
      ...patch,
      placeId: "",
      placeLabel: "",
    }));
    setPlaceQuery("");
    setPlaceOptions([]);
    setPlaceSearchError("");
  };

  const openRelationEditor = () => {
    const nextType = availableTargetTypes[0]?.value ?? "person";
    const nextTarget = targetOptions.find((item) => (
      item.entityType === nextType && !(nextType === "person" && item.entityId === center.id)
    ));
    setEditorDraft({
      ...defaultRelationEditor(),
      targetEntityType: nextType,
      targetEntityId: nextTarget?.entityId ?? "",
      relationTypeId: relationTypes.find((type) => contextRelationTypeSupportsTarget(type, nextType))?.id ?? "",
    });
    setMutationMessage("");
    setEditorOpen(true);
  };

  const submitRelation = async () => {
    const dateError = partialHistoricalDateRangeError(editorDraft.validFrom, editorDraft.validTo);
    if (dateError) {
      setMutationMessage(dateError);
      return;
    }
    if (!editorDraft.targetEntityId || !editorDraft.relationTypeId) {
      setMutationMessage("Оберіть пов’язаний запис і тип зв’язку.");
      return;
    }
    const relationType = relationTypesById.get(editorDraft.relationTypeId);
    const centerIsSource = relationTypeRequiresCenterAsSource(relationType)
      || relationType?.directionality !== "directed"
      || editorDraft.centerEndpoint === "source";
    const sequence = ++mutationSequence.current;
    const requestContextKey = contextKey;
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const service = await loadResearchGraphService();
      await service.saveContextRelation(projectId, {
        relationTypeId: editorDraft.relationTypeId,
        sourceEntityType: centerIsSource ? "person" : editorDraft.targetEntityType,
        sourceEntityId: centerIsSource ? center.id : editorDraft.targetEntityId,
        targetEntityType: centerIsSource ? editorDraft.targetEntityType : "person",
        targetEntityId: centerIsSource ? editorDraft.targetEntityId : center.id,
        sourceRoleLabel: relationType?.sourceRoleUk ?? "",
        targetRoleLabel: relationType?.targetRoleUk ?? "",
        assertionKind: editorDraft.assertionKind,
        evidenceStatus: editorDraft.evidenceStatus,
        confidence: editorDraft.confidence,
        validFrom: editorDraft.validFrom,
        validTo: editorDraft.validTo,
        privacyStatus: "project",
        notes: editorDraft.notes,
        metadata: {
          createdFrom: "person_research_graph_v1",
          editorCenterPersonId: center.id,
          editorCenterEndpoint: centerIsSource ? "source" : "target",
        },
      });
      if (sequence !== mutationSequence.current || requestContextKey !== activeContextKey.current) return;
      const nextFilters: FilterState = {
        ...filterDraft,
        entityTypes: [...new Set<ResearchGraphEntityType>([
          "person",
          editorDraft.targetEntityType,
          ...filterDraft.entityTypes,
        ])],
        assertionKind: editorDraft.assertionKind,
        evidenceStatus: "all",
        minConfidence: 0,
        validFrom: "",
        validTo: "",
        hasEvidence: "all",
      };
      setFilterDraft(nextFilters);
      setAppliedFilters({ contextKey, value: copyFilters(nextFilters) });
      setEditorOpen(false);
      setMutationMessage("Контекстне твердження збережено. Родове дерево не змінено.");
    } catch (error) {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setMutationMessage(errorMessage(error, "Не вдалося зберегти контекстне твердження."));
      }
    } finally {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setMutationBusy(false);
      }
    }
  };

  const archiveSelectedRelation = async () => {
    if (
      !selectedEdge
      || !isManuallyManagedResearchEdge(selectedEdge)
      || !window.confirm("Архівувати це контекстне твердження? Родове дерево не зміниться.")
    ) return;
    const sequence = ++mutationSequence.current;
    const requestContextKey = contextKey;
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const service = await loadResearchGraphService();
      await service.archiveContextRelation(projectId, selectedEdge.id, selectedEdge.lockVersion);
      if (sequence !== mutationSequence.current || requestContextKey !== activeContextKey.current) return;
      setSelectedEdgeId("");
      setMutationMessage("Контекстне твердження архівовано.");
      if (activeFilters) await loadGraph(activeFilters);
    } catch (error) {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setMutationMessage(errorMessage(error, "Не вдалося архівувати контекстне твердження."));
      }
    } finally {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setMutationBusy(false);
      }
    }
  };

  const addEvidence = async () => {
    if (!selectedEdge || !evidenceDraft.entityId) {
      setEvidenceError("Оберіть документ або знахідку з проєкту.");
      return;
    }
    const relationId = selectedEdge.id;
    const sequence = ++mutationSequence.current;
    const requestContextKey = contextKey;
    setMutationBusy(true);
    setEvidenceError("");
    try {
      const service = await loadResearchGraphService();
      const saved = await service.saveContextRelationEvidence(projectId, {
        relationId,
        evidenceEntityType: evidenceDraft.entityType,
        evidenceEntityId: evidenceDraft.entityId,
        sourceLocator: evidenceDraft.sourceLocator,
        excerpt: evidenceDraft.excerpt,
      });
      if (sequence !== mutationSequence.current || requestContextKey !== activeContextKey.current) return;
      if (activeSelectedEdgeId.current === relationId) {
        setEvidence((current) => [...current.filter((item) => item.id !== saved.id), saved]);
        setEvidenceDraft(defaultEvidenceEditor());
      }
      setSnapshot((current) => current ? {
        ...current,
        edges: current.edges.map((edge) => edge.id === relationId
          ? { ...edge, evidenceCount: edge.evidenceCount + 1 }
          : edge),
      } : current);
    } catch (error) {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setEvidenceError(errorMessage(error, "Не вдалося додати доказ."));
      }
    } finally {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setMutationBusy(false);
      }
    }
  };

  const archiveEvidence = async (item: ContextRelationEvidenceV2) => {
    if (item.evidenceSource !== "generic") return;
    const relationId = selectedEdge?.id ?? "";
    if (!window.confirm("Прибрати цей доказ із твердження?")) return;
    const sequence = ++mutationSequence.current;
    const requestContextKey = contextKey;
    setMutationBusy(true);
    setEvidenceError("");
    try {
      const service = await loadResearchGraphService();
      await service.archiveContextRelationEvidence(projectId, item.id, item.lockVersion);
      if (sequence !== mutationSequence.current || requestContextKey !== activeContextKey.current) return;
      if (activeSelectedEdgeId.current === relationId) {
        setEvidence((current) => current.filter((candidate) => candidate.id !== item.id));
      }
      setSnapshot((current) => current ? {
        ...current,
        edges: current.edges.map((edge) => edge.id === relationId
          ? { ...edge, evidenceCount: Math.max(0, edge.evidenceCount - 1) }
          : edge),
      } : current);
    } catch (error) {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setEvidenceError(errorMessage(error, "Не вдалося прибрати доказ."));
      }
    } finally {
      if (sequence === mutationSequence.current && requestContextKey === activeContextKey.current) {
        setMutationBusy(false);
      }
    }
  };

  const saveCurrentView = async () => {
    if (!activeFilters) {
      setSavedViewsError("Спочатку дочекайтеся завантаження поточного графа.");
      return;
    }
    const normalizedName = savedViewName.trim();
    if (!normalizedName) {
      setSavedViewsError("Вкажіть назву представлення графа.");
      return;
    }
    const selectedView = savedViews.find((view) => view.id === selectedSavedViewId);
    const canvas = canvasRef.current;
    const viewport = canvas
      ? clampResearchGraphViewport({
        x: canvas.scrollLeft,
        y: canvas.scrollTop,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      }, {
        scrollWidth: canvas.scrollWidth,
        scrollHeight: canvas.scrollHeight,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
      })
      : { ...currentViewport.current };
    const sequence = ++savedViewMutationSequence.current;
    const requestProjectId = projectId;
    setSavedViewMutationBusy(true);
    setSavedViewsError("");
    setSavedViewMessage("");
    try {
      const service = await loadResearchGraphService();
      const saved = await service.saveResearchGraphSavedView(projectId, {
        configVersion: RESEARCH_GRAPH_SAVED_VIEW_CONFIG_VERSION,
        ...(selectedView ? { id: selectedView.id } : {}),
        name: normalizedName,
        description: selectedView?.description ?? "",
        centerEntityType: "person",
        centerEntityId: center.id,
        filters: toSavedViewFilters(activeFilters),
        viewState: {
          layoutId,
          zoom: clampResearchGraphZoom(zoom),
          viewport,
        },
      }, selectedView?.lockVersion);
      if (sequence !== savedViewMutationSequence.current || requestProjectId !== activeProjectId.current) return;
      setSavedViews((current) => [
        saved,
        ...current.filter((view) => view.id !== saved.id),
      ].sort(compareSavedViews));
      setSelectedSavedViewId(saved.id);
      setSavedViewName(saved.name);
      setSavedViewMessage(selectedView
        ? `Представлення «${saved.name}» оновлено.`
        : `Представлення «${saved.name}» збережено.`);
    } catch (error) {
      if (sequence === savedViewMutationSequence.current && requestProjectId === activeProjectId.current) {
        setSavedViewsError(errorMessage(error, "Не вдалося зберегти представлення графа."));
      }
    } finally {
      if (sequence === savedViewMutationSequence.current && requestProjectId === activeProjectId.current) {
        setSavedViewMutationBusy(false);
      }
    }
  };

  const loadSavedView = async (candidate: ResearchGraphSavedView) => {
    const sequence = ++savedViewMutationSequence.current;
    const requestProjectId = projectId;
    const requestContextKey = contextKey;
    setSavedViewMutationBusy(true);
    setSavedViewsError("");
    setSavedViewMessage("");
    try {
      const service = await loadResearchGraphService();
      const view = await service.getResearchGraphSavedView(projectId, candidate.id);
      if (view.configVersion !== RESEARCH_GRAPH_SAVED_VIEW_CONFIG_VERSION) {
        throw new Error("Це представлення створено для іншої версії графа й потребує оновлення.");
      }
      if (!isResearchGraphLayoutId(view.viewState.layoutId)) {
        throw new Error("Це представлення використовує ще не підтримуваний макет і не може бути завантажене частково.");
      }
      if (!researchGraphSavedFiltersSupported(view.filters)) {
        throw new Error("Набір фільтрів цього представлення не підтримується поточною версією і потребує оновлення.");
      }
      const refreshedRelationTypes = view.filters.relationTypeIds.length
        ? await service.listContextRelationTypes(projectId)
        : null;
      const currentRelationTypes = refreshedRelationTypes ?? relationTypes;
      if (view.filters.relationTypeIds.some((id) => !currentRelationTypes.some((type) => type.id === id && type.isActive))) {
        throw new Error("Збережений тип зв’язку більше недоступний. Представлення потребує оновлення й не було застосоване.");
      }
      const savedPlaceId = view.filters.placeIds[0] ?? "";
      const place = savedPlaceId
        ? await service.resolveResearchGraphSavedPlace(projectId, savedPlaceId, {
          focusDate: view.filters.focusDate || undefined,
          focusYear: view.filters.focusYear ?? undefined,
        })
        : null;
      if (savedPlaceId && !place) {
        throw new Error("Збережений фільтр місця видалено, об’єднано або він більше недоступний. Представлення потребує оновлення й не було застосоване.");
      }
      if (
        sequence !== savedViewMutationSequence.current
        || requestProjectId !== activeProjectId.current
        || requestContextKey !== activeContextKey.current
      ) return;
      if (refreshedRelationTypes) {
        setRelationTypes(refreshedRelationTypes.filter((type) => type.isActive));
      }
      const prepared: PreparedSavedView = {
        view,
        filters: fromSavedViewFilters(view, place),
      };
      if (view.centerEntityId !== center.id) {
        if (!onFocusPerson) {
          throw new Error("Неможливо перейти до центральної особи цього представлення з поточного екрана.");
        }
        pendingSavedView.current = prepared;
        setSavedViewMessage(`Переходимо до центральної особи представлення «${view.name}»…`);
        onFocusPerson(view.centerEntityId);
        return;
      }
      restorePreparedSavedView(prepared);
    } catch (error) {
      if (
        sequence === savedViewMutationSequence.current
        && requestProjectId === activeProjectId.current
        && requestContextKey === activeContextKey.current
      ) {
        pendingSavedView.current = null;
        setSavedViewsError(errorMessage(error, "Не вдалося завантажити представлення графа."));
      }
    } finally {
      if (
        sequence === savedViewMutationSequence.current
        && requestProjectId === activeProjectId.current
        && requestContextKey === activeContextKey.current
      ) {
        setSavedViewMutationBusy(false);
      }
    }
  };

  const deleteSavedView = async (view: ResearchGraphSavedView) => {
    if (!window.confirm(`Видалити особисте представлення «${view.name}»?`)) return;
    const sequence = ++savedViewMutationSequence.current;
    const requestProjectId = projectId;
    setSavedViewMutationBusy(true);
    setSavedViewsError("");
    setSavedViewMessage("");
    try {
      const service = await loadResearchGraphService();
      await service.deleteResearchGraphSavedView(projectId, view.id, view.lockVersion);
      if (sequence !== savedViewMutationSequence.current || requestProjectId !== activeProjectId.current) return;
      setSavedViews((current) => current.filter((item) => item.id !== view.id));
      if (sharingSavedViewId === view.id) setSharingSavedViewId("");
      if (selectedSavedViewId === view.id) {
        setSelectedSavedViewId("");
        setSavedViewName("");
      }
      setSavedViewMessage(`Представлення «${view.name}» видалено.`);
    } catch (error) {
      if (sequence === savedViewMutationSequence.current && requestProjectId === activeProjectId.current) {
        setSavedViewsError(errorMessage(error, "Не вдалося видалити представлення графа."));
      }
    } finally {
      if (sequence === savedViewMutationSequence.current && requestProjectId === activeProjectId.current) {
        setSavedViewMutationBusy(false);
      }
    }
  };

  const startNewSavedView = () => {
    setSelectedSavedViewId("");
    setSavedViewName("");
    setSavedViewsError("");
    setSavedViewMessage("Введіть назву, щоб зберегти поточні умови й положення графа як нове представлення.");
  };

  const changeZoom = (delta: number) => {
    setZoom((current) => clampResearchGraphZoom(current + delta));
  };

  const selectLayout = (nextLayoutId: ResearchGraphLayoutId) => {
    if (nextLayoutId === layoutId) return;
    setLayoutId(nextLayoutId);
    setZoom(1);
    pendingViewport.current = { x: 0, y: 0, width: 0, height: 0 };
    currentViewport.current = { x: 0, y: 0, width: 0, height: 0 };
  };

  const resetViewport = () => {
    setZoom(1);
    pendingViewport.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.scrollTo({ left: 0, top: 0, behavior: "auto" });
      currentViewport.current = {
        x: 0,
        y: 0,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      };
    } else {
      currentViewport.current = { x: 0, y: 0, width: 0, height: 0 };
    }
  };

  const handleCanvasKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      changeZoom(RESEARCH_GRAPH_ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      changeZoom(-RESEARCH_GRAPH_ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      resetViewport();
    }
  };

  return (
    <section className="research-graph-v1" aria-labelledby={headingId}>
      <header className="research-graph-v1__header">
        <div>
          <span className="research-graph-v1__eyebrow">Контекстний граф · дослідницькі твердження</span>
          <h2 id={headingId}>Дослідницький граф: {personDisplayName(center)}</h2>
          <p>
            Тут гіпотези, суперечності та їхні джерела показані окремо від
            родинного дерева. Пунктир означає припущення, а не доведений факт.
          </p>
        </div>
        {onBack ? (
          <button type="button" className="research-graph-v1__button is-secondary" onClick={onBack}>
            ← Назад
          </button>
        ) : null}
      </header>

      <div className="research-graph-v1__warning" role="note">
        <strong>Дослідницька гіпотеза не змінює родинні зв’язки.</strong>
        Підтверджуйте її лише після перевірки наведених документів і знахідок.
      </div>

      <section className="research-graph-v1__saved-views" aria-labelledby={savedViewsHeadingId}>
        <div className="research-graph-v1__saved-views-heading">
          <div>
            <h3 id={savedViewsHeadingId}>Збережені представлення</h3>
            <p>Особисті набори центру, фільтрів, макета, масштабу та положення графа.</p>
          </div>
          {selectedSavedViewId ? (
            <button
              type="button"
              className="research-graph-v1__button is-secondary"
              onClick={startNewSavedView}
              disabled={savedViewMutationBusy}
            >
              + Нове представлення
            </button>
          ) : null}
        </div>
        <form
          className="research-graph-v1__saved-view-form"
          onSubmit={(event) => { event.preventDefault(); void saveCurrentView(); }}
        >
          <label>
            <span>Назва представлення</span>
            <input
              type="text"
              value={savedViewName}
              maxLength={120}
              aria-describedby={savedViewNameHelpId}
              placeholder="Наприклад: Поручителі Каленських 1850–1900"
              onChange={(event) => setSavedViewName(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="research-graph-v1__button is-primary"
            disabled={savedViewMutationBusy || !activeFilters}
          >
            {savedViewMutationBusy
              ? "Зберігаємо…"
              : selectedSavedViewId
                ? "Оновити представлення"
                : "Зберегти представлення"}
          </button>
          <small id={savedViewNameHelpId}>
            Зберігається лише конфігурація. Імена вузлів, підписи й приватний текст до представлення не копіюються.
          </small>
        </form>
        {savedViewsError ? <p className="research-graph-v1__saved-view-status is-error" role="alert">{savedViewsError}</p> : null}
        {savedViewMessage ? <p className="research-graph-v1__saved-view-status" role="status">{savedViewMessage}</p> : null}
        {savedViewsLoading ? (
          <p className="research-graph-v1__saved-view-empty" role="status">Завантажуємо особисті представлення…</p>
        ) : savedViews.length ? (
          <ul className="research-graph-v1__saved-view-list" aria-label="Особисті збережені представлення">
            {savedViews.map((view) => (
              <li key={view.id} className={view.id === selectedSavedViewId ? "is-selected" : ""}>
                <div>
                  <strong>{view.name}</strong>
                  <span>
                    {view.centerEntityId === center.id ? "Поточна центральна особа" : "Інша центральна особа"}
                    {` · ${researchGraphLayoutLabel(view.viewState.layoutId)}`}
                    {view.updatedAt ? ` · оновлено ${savedViewDateLabel(view.updatedAt)}` : ""}
                  </span>
                </div>
                <div className="research-graph-v1__saved-view-actions">
                  <button
                    type="button"
                    onClick={() => { void loadSavedView(view); }}
                    disabled={savedViewMutationBusy}
                  >
                    Завантажити
                  </button>
                  {canManageShareLinks ? (
                    <button
                      type="button"
                      aria-expanded={sharingSavedViewId === view.id}
                      onClick={() => setSharingSavedViewId((current) => current === view.id ? "" : view.id)}
                      disabled={savedViewMutationBusy}
                    >
                      Поділитися
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => { void deleteSavedView(view); }}
                    disabled={savedViewMutationBusy}
                  >
                    Видалити
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : !savedViewsError ? (
          <p className="research-graph-v1__saved-view-empty">Збережених представлень ще немає.</p>
        ) : null}
        {canManageShareLinks && sharingSavedViewId ? (
          (() => {
            const sharingView = savedViews.find((view) => view.id === sharingSavedViewId);
            return sharingView ? (
              <ResearchGraphShareManager
                projectId={projectId}
                view={sharingView}
                onClose={() => setSharingSavedViewId("")}
              />
            ) : null;
          })()
        ) : null}
      </section>

      {canEdit && !readOnly ? (
        <section className="research-graph-v1__editor" aria-label="Ручне контекстне твердження">
          <div className="research-graph-v1__editor-heading">
            <div>
              <strong>Нове контекстне твердження</strong>
              <p>Оберіть готовий запис проєкту — вводити технічний ID вручну не потрібно.</p>
            </div>
            <button
              type="button"
              className="research-graph-v1__button is-secondary"
              onClick={() => editorOpen ? setEditorOpen(false) : openRelationEditor()}
              disabled={mutationBusy || !availableTargetTypes.length || !relationTypes.length}
            >
              {editorOpen ? "Закрити" : "+ Додати твердження"}
            </button>
          </div>
          {unavailableTargetTypes.length ? (
            <p className="research-graph-v1__editor-note">
              Зараз без доступних записів: {unavailableTargetTypes.map((item) => item.label).join(", ")}.
              Додайте відповідні записи до проєкту — після цього вони з’являться у виборі.
              Джерела, архіви й сімейні групи буде підключено після появи окремих каталогів.
            </p>
          ) : null}
          {editorOpen ? (
            <form
              className="research-graph-v1__editor-form"
              onSubmit={(event) => { event.preventDefault(); void submitRelation(); }}
            >
              <label>
                <span>Тип пов’язаного запису</span>
                <select
                  value={editorDraft.targetEntityType}
                  onChange={(event) => {
                    const entityType = event.target.value as EditableTargetEntityType;
                    const first = targetOptions.find((item) => (
                      item.entityType === entityType
                      && !(entityType === "person" && item.entityId === center.id)
                    ));
                    setEditorDraft((current) => ({
                      ...current,
                      targetEntityType: entityType,
                      targetEntityId: first?.entityId ?? "",
                      relationTypeId: relationTypes.find((type) => contextRelationTypeSupportsTarget(type, entityType))?.id ?? "",
                      centerEndpoint: "source",
                    }));
                  }}
                >
                  {availableTargetTypes.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Пов’язаний запис</span>
                <select
                  required
                  value={editorDraft.targetEntityId}
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    targetEntityId: event.target.value,
                  }))}
                >
                  <option value="">Оберіть запис</option>
                  {availableTargets.map((option) => (
                    <option key={`${option.entityType}:${option.entityId}`} value={option.entityId}>
                      {option.label}{option.secondaryLabel ? ` · ${option.secondaryLabel}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Тип зв’язку</span>
                <select
                  required
                  value={editorDraft.relationTypeId}
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    relationTypeId: event.target.value,
                    centerEndpoint: "source",
                  }))}
                >
                  <option value="">Оберіть тип</option>
                  {editorRelationTypes.map((type) => (
                    <option key={type.id} value={type.id}>{relationTypeEditorLabel(type)}</option>
                  ))}
                </select>
              </label>
              {editorRelationType?.directionality === "directed"
                && !relationTypeRequiresCenterAsSource(editorRelationType) ? (
                <label>
                  <span>Роль центральної особи</span>
                  <select
                    value={editorDraft.centerEndpoint}
                    onChange={(event) => setEditorDraft((current) => ({
                      ...current,
                      centerEndpoint: event.target.value as RelationEditorState["centerEndpoint"],
                    }))}
                  >
                    <option value="source">
                      {editorRelationType.sourceRoleUk || editorRelationType.labelUk || "Початкова сторона"}
                    </option>
                    <option value="target">
                      {editorRelationType.targetRoleUk || editorRelationType.inverseLabelUk || "Пов’язана сторона"}
                    </option>
                  </select>
                </label>
              ) : null}
              {editorRelationType && editorTarget ? (
                <p className="research-graph-v1__direction-preview is-wide" role="note">
                  <b>{editorDraft.centerEndpoint === "target" && editorRelationType.directionality === "directed"
                    ? editorTarget.label
                    : personDisplayName(center)}</b>
                  <span aria-hidden="true">{editorRelationType.directionality === "symmetric" ? " ↔ " : " → "}</span>
                  <b>{editorDraft.centerEndpoint === "target" && editorRelationType.directionality === "directed"
                    ? personDisplayName(center)
                    : editorTarget.label}</b>
                </p>
              ) : null}
              <label>
                <span>Тип твердження</span>
                <select
                  value={editorDraft.assertionKind}
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    assertionKind: event.target.value as RelationEditorState["assertionKind"],
                  }))}
                >
                  <option value="research_hypothesis">Дослідницька гіпотеза</option>
                  <option value="manual">Перевірене ручне твердження</option>
                </select>
              </label>
              <label>
                <span>Стан доказу</span>
                <select
                  value={editorDraft.evidenceStatus}
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    evidenceStatus: event.target.value as ContextEvidenceStatus,
                  }))}
                >
                  {EVIDENCE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="research-graph-v1__confidence">
                <span>Впевненість: <b>{editorDraft.confidence}%</b></span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={editorDraft.confidence}
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    confidence: Number(event.target.value),
                  }))}
                />
              </label>
              <label>
                <span>Дата від</span>
                <input
                  value={editorDraft.validFrom}
                  inputMode="numeric"
                  pattern="\d{4}(-\d{2}(-\d{2})?)?"
                  placeholder="РРРР / РРРР-ММ / РРРР-ММ-ДД"
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    validFrom: event.target.value,
                  }))}
                />
              </label>
              <label>
                <span>Дата до</span>
                <input
                  value={editorDraft.validTo}
                  inputMode="numeric"
                  pattern="\d{4}(-\d{2}(-\d{2})?)?"
                  placeholder="РРРР / РРРР-ММ / РРРР-ММ-ДД"
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    validTo: event.target.value,
                  }))}
                />
              </label>
              <label className="is-wide">
                <span>Примітка дослідника</span>
                <textarea
                  rows={2}
                  value={editorDraft.notes}
                  onChange={(event) => setEditorDraft((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))}
                />
              </label>
              <div className="research-graph-v1__editor-actions is-wide">
                <button type="submit" className="research-graph-v1__button is-primary" disabled={mutationBusy}>
                  {mutationBusy ? "Зберігаємо…" : "Зберегти твердження"}
                </button>
                <small>Ця дія не створює родинного зв’язку й не змінює родове дерево.</small>
              </div>
            </form>
          ) : null}
          {mutationMessage ? <p className="research-graph-v1__editor-message" role="status">{mutationMessage}</p> : null}
        </section>
      ) : null}

      <form
        className="research-graph-v1__filters"
        aria-labelledby={filterHeadingId}
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <h3 id={filterHeadingId}>Умови дослідження</h3>
        <fieldset className="research-graph-v1__depth-filter">
          <legend>Глибина</legend>
          {([1, 2, 3] as const).map((depth) => (
            <label key={depth}>
              <input
                type="radio"
                name="research-depth"
                value={depth}
                checked={filterDraft.depth === depth}
                onChange={() => setFilterDraft((current) => ({ ...current, depth }))}
              />
              <span>{depth}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="research-graph-v1__entity-filter">
          <legend>Типи вузлів</legend>
          {ENTITY_TYPE_OPTIONS.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={filterDraft.entityTypes.includes(option.value)}
                disabled={filterDraft.entityTypes.length === 1 && filterDraft.entityTypes[0] === option.value}
                onChange={() => toggleEntityType(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>

        <div className="research-graph-v1__field-grid">
          <label>
            <span>Тип зв’язку</span>
            <select
              value={filterDraft.relationTypeId}
              onChange={(event) => setFilterDraft((current) => ({
                ...current,
                relationTypeId: event.target.value,
              }))}
            >
              <option value="all">Усі типи зв’язків</option>
              {relationTypes.map((type) => (
                <option key={type.id} value={type.id}>{relationTypeEditorLabel(type)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Тип твердження</span>
            <select
              value={filterDraft.assertionKind}
              onChange={(event) => setFilterDraft((current) => ({
                ...current,
                assertionKind: event.target.value as AssertionFilter,
              }))}
            >
              {ASSERTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Стан доказу</span>
            <select
              value={filterDraft.evidenceStatus}
              onChange={(event) => setFilterDraft((current) => ({
                ...current,
                evidenceStatus: event.target.value as EvidenceFilter,
              }))}
            >
              <option value="all">Усі стани</option>
              {EVIDENCE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Наявність доказу</span>
            <select
              value={filterDraft.hasEvidence}
              onChange={(event) => setFilterDraft((current) => ({
                ...current,
                hasEvidence: event.target.value as EvidencePresenceFilter,
              }))}
            >
              <option value="all">Неважливо</option>
              <option value="yes">Є джерело або знахідка</option>
              <option value="no">Ще без доказу</option>
            </select>
          </label>
          <label>
            <span>Дата від</span>
            <input
              type="text"
              inputMode="numeric"
              value={filterDraft.validFrom}
              onChange={(event) => setFilterDraft((current) => ({ ...current, validFrom: event.target.value }))}
              placeholder="РРРР / РРРР-ММ / РРРР-ММ-ДД"
              pattern="\d{4}(-\d{2}(-\d{2})?)?"
            />
          </label>
          <label>
            <span>Дата до</span>
            <input
              type="text"
              inputMode="numeric"
              value={filterDraft.validTo}
              onChange={(event) => setFilterDraft((current) => ({ ...current, validTo: event.target.value }))}
              placeholder="РРРР / РРРР-ММ / РРРР-ММ-ДД"
              pattern="\d{4}(-\d{2}(-\d{2})?)?"
            />
          </label>
          <label className="research-graph-v1__confidence">
            <span>Мінімальна впевненість: <b>{filterDraft.minConfidence}%</b></span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={filterDraft.minConfidence}
              onChange={(event) => setFilterDraft((current) => ({
                ...current,
                minConfidence: Number(event.target.value),
              }))}
            />
          </label>

          <fieldset className="research-graph-v1__temporal-filter is-wide">
            <legend>Часовий зріз</legend>
            <div className="research-graph-v1__temporal-modes">
              {([
                ["all", "Весь час"],
                ["year", "Конкретний рік"],
                ["date", "Точна дата"],
              ] as const).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="research-temporal-focus"
                    value={value}
                    checked={filterDraft.temporalMode === value}
                    onChange={() => updateTemporalFocus({ temporalMode: value })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {filterDraft.temporalMode === "year" ? (
              <div className="research-graph-v1__year-focus">
                <label>
                  <span>Рік: <b>{filterDraft.focusYear}</b></span>
                  <input
                    type="range"
                    min="1"
                    max="9999"
                    step="1"
                    value={Math.min(9999, Math.max(1, filterDraft.focusYear || 1))}
                    onChange={(event) => updateTemporalFocus({ focusYear: Number(event.target.value) })}
                    aria-label="Рік часового зрізу"
                  />
                </label>
                <label>
                  <span>Ввести рік</span>
                  <input
                    type="number"
                    min="1"
                    max="9999"
                    inputMode="numeric"
                    value={filterDraft.focusYear || ""}
                    onChange={(event) => updateTemporalFocus({ focusYear: Number(event.target.value) })}
                  />
                </label>
              </div>
            ) : null}
            {filterDraft.temporalMode === "date" ? (
              <label className="research-graph-v1__exact-date">
                <span>Дата станом на</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={filterDraft.focusDate}
                  onChange={(event) => updateTemporalFocus({ focusDate: event.target.value })}
                  placeholder="РРРР-ММ-ДД"
                  pattern="\d{4}-\d{2}-\d{2}"
                />
              </label>
            ) : null}
            {filterDraft.temporalMode !== "all" ? (
              <label className="research-graph-v1__include-undated">
                <input
                  type="checkbox"
                  checked={filterDraft.includeUndated}
                  onChange={(event) => setFilterDraft((current) => ({
                    ...current,
                    includeUndated: event.target.checked,
                  }))}
                />
                <span>Показувати зв’язки без дати</span>
              </label>
            ) : null}
            <small>
              {filterDraft.temporalMode === "all"
                ? "Показано зв’язки за весь доступний період."
                : "Назви осіб і місць для цього часу повертає сервер з історичних записів; браузер їх не вигадує."}
            </small>
          </fieldset>

          <div className="research-graph-v1__place-filter is-wide">
            <label>
              <span>Конкретне місце</span>
              <input
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-controls={placeListId}
                aria-expanded={placeOptions.length > 0}
                value={placeQuery}
                onChange={(event) => {
                  const value = event.target.value;
                  setPlaceQuery(value);
                  setFilterDraft((current) => ({ ...current, placeId: "", placeLabel: "" }));
                }}
                placeholder="Почніть вводити назву з каталогу"
                autoComplete="off"
              />
            </label>
            {filterDraft.placeId ? (
              <div className="research-graph-v1__selected-place" role="status">
                <span>Обрано: <b>{filterDraft.placeLabel}</b></span>
                <button
                  type="button"
                  onClick={() => {
                    setFilterDraft((current) => ({ ...current, placeId: "", placeLabel: "" }));
                    setPlaceQuery("");
                    setPlaceOptions([]);
                  }}
                >
                  Прибрати
                </button>
              </div>
            ) : null}
            {placeSearchLoading ? <small role="status">Шукаємо в історичному каталозі…</small> : null}
            {placeSearchError ? <small className="research-graph-v1__inline-error" role="alert">{placeSearchError}</small> : null}
            {!placeSearchLoading && placeQuery.trim().length >= 2 && !filterDraft.placeId && !placeOptions.length && !placeSearchError ? (
              <small role="status">Збігів у доступному каталозі не знайдено.</small>
            ) : null}
            {placeOptions.length ? (
              <ul id={placeListId} className="research-graph-v1__place-options" role="listbox" aria-label="Знайдені історичні місця">
                {placeOptions.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={filterDraft.placeId === option.id}
                      onClick={() => {
                        setFilterDraft((current) => ({
                          ...current,
                          placeId: option.id,
                          placeLabel: option.label,
                        }));
                        setPlaceQuery(option.label);
                        setPlaceOptions([]);
                        setPlaceSearchError("");
                      }}
                    >
                      <strong>{option.label}</strong>
                      {option.secondaryLabel ? <small>{option.secondaryLabel}</small> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        <div className="research-graph-v1__filter-actions">
          <button type="submit" className="research-graph-v1__button is-primary" disabled={loading}>
            Застосувати
          </button>
          <button type="button" className="research-graph-v1__button is-secondary" onClick={resetFilters} disabled={loading}>
            Скинути
          </button>
        </div>
      </form>

      {activeFilters ? (
        <div className="research-graph-v1__active-filters" role="status" aria-label="Застосований часовий і просторовий зріз">
          <span><b>Час:</b> {temporalFocusLabel(activeFilters)}</span>
          <span><b>Місце:</b> {activeFilters.placeLabel || "усі місця"}</span>
          <span>
            <b>Тип зв’язку:</b>{" "}
            {activeFilters.relationTypeId === "all"
              ? "усі типи"
              : relationTypesById.get(activeFilters.relationTypeId)?.labelUk || "вибраний тип"}
          </span>
        </div>
      ) : null}

      {loadError ? (
        <div className="research-graph-v1__message is-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => activeFilters && void loadGraph(activeFilters)}
            disabled={loading || !activeFilters}
          >
            Повторити
          </button>
        </div>
      ) : null}

      {visibleSnapshot?.truncated.nodes || visibleSnapshot?.truncated.edges ? (
        <div className="research-graph-v1__message is-warning" role="status">
          Великий граф обмежено до {visibleSnapshot.limits.maxNodes} вузлів і {visibleSnapshot.limits.maxEdges} зв’язків.
          Уточніть фільтри, щоб дослідити інший фрагмент.
        </div>
      ) : null}

      <div className="research-graph-v1__workspace">
        <div className="research-graph-v1__canvas-column">
          <div className="research-graph-v1__viewport-tools" aria-label="Масштаб і положення графа">
            <fieldset className="research-graph-v1__layout-picker">
              <legend>Макет графа</legend>
              <div role="radiogroup" aria-label="Спосіб розташування вузлів">
                {RESEARCH_GRAPH_LAYOUT_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={layoutId === option.value ? "is-active" : ""}
                    title={option.description}
                  >
                    <input
                      type="radio"
                      name={layoutPickerName}
                      value={option.value}
                      checked={layoutId === option.value}
                      onChange={() => selectLayout(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <button
                type="button"
                onClick={() => changeZoom(-RESEARCH_GRAPH_ZOOM_STEP)}
                disabled={zoom <= RESEARCH_GRAPH_MIN_ZOOM}
                aria-label="Зменшити масштаб графа"
              >
                −
              </button>
              <output aria-live="polite" aria-label="Поточний масштаб графа">{Math.round(zoom * 100)}%</output>
              <button
                type="button"
                onClick={() => changeZoom(RESEARCH_GRAPH_ZOOM_STEP)}
                disabled={zoom >= RESEARCH_GRAPH_MAX_ZOOM}
                aria-label="Збільшити масштаб графа"
              >
                +
              </button>
              <button type="button" onClick={resetViewport}>Скинути вигляд</button>
            </div>
            <small>
              {researchGraphLayoutDescription(layoutId)} Клавіші +/− змінюють масштаб, 0 скидає масштаб і прокрутку.
            </small>
          </div>
          <div className="research-graph-v1__legend" aria-label="Умовні позначення">
            <span className="is-hypothesis"><i aria-hidden="true" />Гіпотеза</span>
            <span className="is-proven"><i aria-hidden="true" />Підтверджено</span>
            <span className="is-disputed"><i aria-hidden="true" />Спірно або спростовано</span>
            <span className="is-generated"><i aria-hidden="true" />Створено системою</span>
          </div>
          <div
            ref={canvasRef}
            className="research-graph-v1__canvas"
            role="region"
            aria-label={`Інтерактивний дослідницький граф · ${researchGraphLayoutLabel(layoutId)}`}
            tabIndex={layout ? 0 : undefined}
            onKeyDown={handleCanvasKeyboard}
            onScroll={(event) => {
              const canvas = event.currentTarget;
              currentViewport.current = {
                x: canvas.scrollLeft,
                y: canvas.scrollTop,
                width: canvas.clientWidth,
                height: canvas.clientHeight,
              };
            }}
          >
            {loading ? (
              <ResearchGraphSkeleton />
            ) : layout && layout.nodes.length > 1 ? (
              <svg
                className="research-graph-v1__graph"
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                style={{
                  minWidth: `${Math.round(Math.max(760, layout.width) * zoom)}px`,
                  width: `${Math.round(Math.max(760, layout.width) * zoom)}px`,
                }}
                role="img"
                aria-label={`Дослідницький граф особи ${personDisplayName(center)}: ${layout.nodes.length} вузлів і ${layout.edges.length} зв’язків`}
              >
                <defs>
                  <marker
                    id={arrowMarkerId}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" className="research-graph-v1__arrow" />
                  </marker>
                </defs>
                <g className="research-graph-v1__edges" aria-hidden="true">
                  {layout.edges.map((edge) => (
                    <path
                      key={edge.id}
                      d={edge.path}
                      className={edgeClassName(edge, selectedNodeId)}
                      markerEnd={edge.directionality === "directed" ? `url(#${arrowMarkerId})` : undefined}
                    />
                  ))}
                </g>
                {layout.nodes.map((node) => (
                  <ResearchGraphNodeView
                    key={node.id}
                    node={node}
                    selected={node.id === selectedNodeId}
                    onActivate={() => setSelectedNodeId(node.id)}
                  />
                ))}
              </svg>
            ) : (
              <div className="research-graph-v1__empty">
                <span aria-hidden="true">◇</span>
                <strong>Для цієї особи дослідницьких тверджень не знайдено</strong>
                <p>
                  Створіть зв’язок як «Дослідницьку гіпотезу» або змініть
                  фільтр типу твердження на «Усі».
                </p>
              </div>
            )}
          </div>

          {!loading && visibleSnapshot?.nodes.length ? (
            <details className="research-graph-v1__accessible-list">
              <summary>Список вузлів ({visibleSnapshot.nodes.length})</summary>
              <ol>
                {visibleSnapshot.nodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      aria-pressed={node.id === selectedNodeId}
                      onClick={() => setSelectedNodeId(node.id)}
                    >
                      <strong>{node.label || "Вузол без назви"}</strong>
                      <span>{entityTypeLabel(node.entityType)}{node.secondaryLabel ? ` · ${node.secondaryLabel}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>

        <aside className="research-graph-v1__detail" aria-labelledby={detailHeadingId}>
          <h3 id={detailHeadingId}>Пояснення вибраного вузла</h3>
          {selectedNode ? (
            <ResearchNodeDetail
              node={selectedNode}
              edges={selectedEdges}
              selectedEdgeId={selectedEdgeId}
              onSelectEdge={setSelectedEdgeId}
              nodesById={nodesById}
              relationTypesById={relationTypesById}
              targetOptionsByKey={targetsByKey}
              evidence={evidence}
              evidenceLoading={evidenceLoading}
              evidenceError={evidenceError}
              evidenceDraft={evidenceDraft}
              evidenceTargets={evidenceTargets}
              canEdit={canEdit && !readOnly}
              canArchiveRelation={Boolean(selectedEdge && isManuallyManagedResearchEdge(selectedEdge))}
              mutationBusy={mutationBusy}
              onEvidenceDraftChange={setEvidenceDraft}
              onAddEvidence={() => void addEvidence()}
              onArchiveEvidence={(item) => void archiveEvidence(item)}
              onArchiveRelation={() => void archiveSelectedRelation()}
              onFocusPerson={onFocusPerson}
              onOpenPerson={onOpenPerson}
              onOpenDocument={onOpenDocument}
              onOpenFinding={onOpenFinding}
              onOpenPlace={onOpenPlace}
              onOpenHypothesis={onOpenHypothesis}
            />
          ) : (
            <p className="research-graph-v1__detail-empty">Оберіть вузол на схемі або у списку.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

function ResearchGraphNodeView({
  node,
  selected,
  onActivate,
}: {
  node: ResearchGraphLayoutNode;
  selected: boolean;
  onActivate: () => void;
}) {
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  const className = [
    "research-graph-v1__node",
    `is-${node.entityType}`,
    node.isCenter ? "is-center" : "",
    node.masked ? "is-masked" : "",
    selected ? "is-selected" : "",
  ].filter(Boolean).join(" ");
  const label = node.label || "Вузол без назви";

  return (
    <g
      className={className}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${entityTypeLabel(node.entityType)}: ${label}`}
      onClick={onActivate}
      onKeyDown={(event) => activateWithKeyboard(event, onActivate)}
    >
      <title>{entityTypeLabel(node.entityType)}: {label}</title>
      {node.isCenter ? (
        <circle cx={node.x} cy={node.y} r={halfHeight} />
      ) : node.entityType === "hypothesis" ? (
        <polygon points={`${node.x},${node.y - halfHeight} ${node.x + halfWidth},${node.y} ${node.x},${node.y + halfHeight} ${node.x - halfWidth},${node.y}`} />
      ) : node.entityType === "event" ? (
        <polygon points={`${node.x - halfWidth + 16},${node.y - halfHeight} ${node.x + halfWidth - 16},${node.y - halfHeight} ${node.x + halfWidth},${node.y} ${node.x + halfWidth - 16},${node.y + halfHeight} ${node.x - halfWidth + 16},${node.y + halfHeight} ${node.x - halfWidth},${node.y}`} />
      ) : (
        <rect
          x={node.x - halfWidth}
          y={node.y - halfHeight}
          width={node.width}
          height={node.height}
          rx={node.entityType === "person" ? 28 : 13}
        />
      )}
      <text className="research-graph-v1__node-label" x={node.x} y={node.y - 2} textAnchor="middle">
        {compactLabel(label, node.entityType === "hypothesis" ? 12 : 19)}
      </text>
      {node.secondaryLabel ? (
        <text className="research-graph-v1__node-secondary" x={node.x} y={node.y + 17} textAnchor="middle">
          {compactLabel(node.secondaryLabel, 21)}
        </text>
      ) : null}
    </g>
  );
}

function ResearchNodeDetail({
  node,
  edges,
  selectedEdgeId,
  onSelectEdge,
  nodesById,
  relationTypesById,
  targetOptionsByKey,
  evidence,
  evidenceLoading,
  evidenceError,
  evidenceDraft,
  evidenceTargets,
  canEdit,
  canArchiveRelation,
  mutationBusy,
  onEvidenceDraftChange,
  onAddEvidence,
  onArchiveEvidence,
  onArchiveRelation,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
  onOpenPlace,
  onOpenHypothesis,
}: {
  node: ResearchGraphNode;
  edges: ResearchGraphEdge[];
  selectedEdgeId: string;
  onSelectEdge: (edgeId: string) => void;
  nodesById: Map<ResearchGraphNode["id"], ResearchGraphNode>;
  relationTypesById: Map<string, ContextRelationType>;
  targetOptionsByKey: Map<string, ResearchGraphTargetOption>;
  evidence: ContextRelationEvidenceV2[];
  evidenceLoading: boolean;
  evidenceError: string;
  evidenceDraft: EvidenceEditorState;
  evidenceTargets: readonly ResearchGraphTargetOption[];
  canEdit: boolean;
  canArchiveRelation: boolean;
  mutationBusy: boolean;
  onEvidenceDraftChange: (value: EvidenceEditorState) => void;
  onAddEvidence: () => void;
  onArchiveEvidence: (item: ContextRelationEvidenceV2) => void;
  onArchiveRelation: () => void;
  onFocusPerson?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onOpenFinding?: (findingId: string) => void;
  onOpenPlace?: (placeId: string) => void;
  onOpenHypothesis?: (hypothesisId: string) => void;
}) {
  const description = metadataText(node.metadata, ["description", "statement", "notes", "summary"]);
  const status = metadataText(node.metadata, ["status", "evidenceStatus", "evidence_status"]);
  const temporalLabelApplied = node.metadata.temporalLabelApplied === true
    || node.metadata.temporal_label_applied === true;
  const temporalPlaceType = metadataText(node.metadata, ["temporalPlaceType", "temporal_place_type"])
    || metadataNestedLabel(node.metadata, ["temporalPlaceType", "temporal_place_type"]);
  const temporalHierarchy = metadataTextList(node.metadata, ["temporalHierarchy", "temporal_hierarchy"]);
  const legacyTemporalAmbiguous = node.metadata.temporalAmbiguous === true
    || node.metadata.temporal_ambiguous === true;
  const temporalContextAmbiguous = node.metadata.temporalContextAmbiguous === true
    || node.metadata.temporal_context_ambiguous === true;
  const temporalNameAmbiguous = node.metadata.temporalNameAmbiguous === true
    || node.metadata.temporal_name_ambiguous === true;
  const temporalPlaceTypeAmbiguous = node.metadata.temporalPlaceTypeAmbiguous === true
    || node.metadata.temporal_place_type_ambiguous === true;
  const temporalHierarchyAmbiguous = node.metadata.temporalHierarchyAmbiguous === true
    || node.metadata.temporal_hierarchy_ambiguous === true;
  const temporalContextOnlyAmbiguous = (legacyTemporalAmbiguous || temporalContextAmbiguous)
    && !temporalNameAmbiguous
    && !temporalPlaceTypeAmbiguous
    && !temporalHierarchyAmbiguous;
  const temporalHierarchyTruncated = node.metadata.temporalHierarchyTruncated === true
    || node.metadata.temporal_hierarchy_truncated === true;
  const redirectPlaceId = metadataText(node.metadata, ["redirectPlaceId", "redirect_place_id"]);
  const mergedFromPlaceId = metadataText(node.metadata, ["mergedFromPlaceId", "merged_from_place_id"]);
  const targetOption = targetOptionsByKey.get(`${node.entityType}:${node.entityId}`);
  const eventPersonId = metadataText(node.metadata, ["personId", "person_id", "ownerPersonId"])
    || targetOption?.ownerPersonId
    || "";
  const sourceDocumentId = metadataText(node.metadata, ["documentId", "document_id"]);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  return (
    <div className="research-graph-v1__detail-content">
      <span className={`research-graph-v1__entity-badge is-${node.entityType}`}>
        {entityTypeLabel(node.entityType)}
      </span>
      <strong>{node.label || "Вузол без назви"}</strong>
      {temporalLabelApplied ? (
        <small className="research-graph-v1__temporal-label-note">Історична назва для вибраного часового зрізу</small>
      ) : null}
      {temporalNameAmbiguous ? (
        <div className="research-graph-v1__temporal-ambiguity-note" role="note">
          {node.entityType === "person"
            ? "Для цього часу знайдено кілька варіантів імені особи — показано найкраще ранжований варіант."
            : "Для цього часу знайдено кілька варіантів назви — показано найкраще ранжований варіант."}
        </div>
      ) : null}
      {node.entityType === "place" && (
        temporalPlaceType
        || temporalHierarchy
        || temporalPlaceTypeAmbiguous
        || temporalHierarchyAmbiguous
        || temporalContextOnlyAmbiguous
        || temporalHierarchyTruncated
      ) ? (
        <div
          className={`research-graph-v1__temporal-place ${
            temporalPlaceTypeAmbiguous || temporalHierarchyAmbiguous || temporalContextOnlyAmbiguous ? "is-ambiguous" : ""
          }`}
          role="note"
        >
          {temporalPlaceType ? <span><b>Тип на той час:</b> {temporalPlaceType}</span> : null}
          {temporalHierarchy ? <span><b>Адміністративна належність:</b> {temporalHierarchy}</span> : null}
          {temporalPlaceTypeAmbiguous ? <span>Для цього часу існує кілька можливих типів місця — перевірте картку місця.</span> : null}
          {temporalHierarchyAmbiguous ? <span>Для цього часу існує кілька можливих адміністративних шляхів — перевірте картку місця.</span> : null}
          {temporalContextOnlyAmbiguous ? <span>Часовий контекст місця неоднозначний — перевірте картку місця.</span> : null}
          {temporalHierarchyTruncated ? <span>Показано скорочений адміністративний контекст — повні рівні й альтернативні шляхи доступні в картці місця.</span> : null}
        </div>
      ) : null}
      {node.entityType === "place" && (redirectPlaceId || mergedFromPlaceId) ? (
        <small className="research-graph-v1__temporal-label-note">Це місце об’єднано з актуальною карткою каталогу.</small>
      ) : null}
      {node.secondaryLabel ? <p>{node.secondaryLabel}</p> : null}
      {description ? <p>{description}</p> : null}
      {status ? <p><b>Стан:</b> {status}</p> : null}
      {node.masked ? (
        <p className="research-graph-v1__privacy-note">Приватні дані приховано правилами проєкту.</p>
      ) : null}

      {!node.masked ? (
        <div className="research-graph-v1__detail-actions">
          {node.entityType === "person" && !node.isCenter && onFocusPerson ? (
            <button type="button" onClick={() => onFocusPerson(node.entityId)}>Зробити центром</button>
          ) : null}
          {node.entityType === "person" && onOpenPerson ? (
            <button type="button" onClick={() => onOpenPerson(node.entityId)}>Відкрити особу</button>
          ) : null}
          {node.entityType === "document" && onOpenDocument ? (
            <button type="button" onClick={() => onOpenDocument(node.entityId)}>Відкрити документ</button>
          ) : null}
          {node.entityType === "finding" && onOpenFinding ? (
            <button type="button" onClick={() => onOpenFinding(node.entityId)}>Відкрити знахідку</button>
          ) : null}
          {node.entityType === "place" && onOpenPlace ? (
            <button type="button" onClick={() => onOpenPlace(redirectPlaceId || node.entityId)}>Відкрити місце</button>
          ) : null}
          {node.entityType === "hypothesis" && onOpenHypothesis ? (
            <button type="button" onClick={() => onOpenHypothesis(node.entityId)}>Відкрити гіпотезу</button>
          ) : null}
          {node.entityType === "event" && eventPersonId && onOpenPerson ? (
            <button type="button" onClick={() => onOpenPerson(eventPersonId)}>Відкрити особу події</button>
          ) : null}
          {node.entityType === "source" && sourceDocumentId && onOpenDocument ? (
            <button type="button" onClick={() => onOpenDocument(sourceDocumentId)}>Відкрити документ джерела</button>
          ) : null}
        </div>
      ) : null}

      <div className="research-graph-v1__evidence-list">
        <h4>Твердження та докази</h4>
        {edges.length ? (
          <ul>
            {edges.map((edge) => {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const other = nodesById.get(otherId);
              const relationType = relationTypesById.get(edge.relationTypeId);
              const directionSymbol = edge.directionality === "symmetric"
                ? "↔"
                : edge.source === node.id ? "→" : "←";
              const contextualLabel = contextualRelationLabel(edge, node.id, relationType);
              return (
                <li
                  key={edge.id}
                  className={`${isResearchHypothesisEdge(edge) ? "is-hypothesis" : ""} ${edge.id === selectedEdgeId ? "is-selected" : ""}`}
                >
                  <button type="button" onClick={() => onSelectEdge(edge.id)} aria-pressed={edge.id === selectedEdgeId}>
                    <span className={`is-${edge.evidenceStatus}`}>{evidenceStatusLabel(edge.evidenceStatus)}</span>
                    <strong>{contextualLabel}</strong>
                    <small><b aria-hidden="true">{directionSymbol}</b> {other?.label || "Пов’язаний вузол"}</small>
                    <dl>
                      <div><dt>Впевненість</dt><dd>{Math.round(edge.confidence)}%</dd></div>
                      <div><dt>Докази</dt><dd>{edge.evidenceCount}</dd></div>
                      <div><dt>Походження</dt><dd>{assertionKindLabel(edge.assertionKind)}</dd></div>
                    </dl>
                    {edge.periodText ? <small>Період: {edge.periodText}</small> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>Для вибраного вузла зв’язки за цими фільтрами не знайдено.</p>
        )}

        {selectedEdge ? (
          <section className="research-graph-v1__selected-evidence" aria-label="Докази вибраного твердження">
            <div className="research-graph-v1__selected-evidence-heading">
              <h5>Докази вибраного твердження</h5>
              {canEdit && canArchiveRelation ? (
                <button type="button" className="is-danger" disabled={mutationBusy} onClick={onArchiveRelation}>
                  Архівувати твердження
                </button>
              ) : null}
            </div>
            {canEdit && !canArchiveRelation ? (
              <p className="research-graph-v1__editor-note">
                Автоматичне або імпортоване твердження редагується у знахідці чи вихідному записі.
              </p>
            ) : null}
            {evidenceLoading ? <p>Завантажуємо докази…</p> : null}
            {evidenceError ? <p className="research-graph-v1__inline-error" role="alert">{evidenceError}</p> : null}
            {!evidenceLoading && !evidenceError && evidence.length === 0 ? (
              <p>До цього твердження ще не додано окремого документа або знахідки.</p>
            ) : null}
            {evidence.length ? (
              <ul>
                {evidence.map((evidence) => {
                  const evidenceOption = evidence.evidenceEntityType && evidence.evidenceEntityId
                    ? targetOptionsByKey.get(`${evidence.evidenceEntityType}:${evidence.evidenceEntityId}`)
                    : undefined;
                  const evidenceLabel = evidenceOption?.label
                    || (evidence.evidenceEntityType ? `${entityTypeLabel(evidence.evidenceEntityType)} · запис недоступний у поточному каталозі` : "Цитата або уривок");
                  return (
                    <li key={evidence.id}>
                      <strong>{evidenceLabel}</strong>
                      {evidence.sourceLocator ? <small>Місце в джерелі: {evidence.sourceLocator}</small> : null}
                      {evidence.excerpt ? <p>{evidence.excerpt}</p> : null}
                      <div>
                        {evidence.evidenceEntityType === "document" && evidence.evidenceEntityId && onOpenDocument ? (
                          <button type="button" onClick={() => onOpenDocument(evidence.evidenceEntityId!)}>Відкрити документ</button>
                        ) : null}
                        {evidence.evidenceEntityType === "finding" && evidence.evidenceEntityId && onOpenFinding ? (
                          <button type="button" onClick={() => onOpenFinding(evidence.evidenceEntityId!)}>Відкрити знахідку</button>
                        ) : null}
                        {canEdit && evidence.evidenceSource === "generic" ? (
                          <button type="button" className="is-danger" disabled={mutationBusy} onClick={() => onArchiveEvidence(evidence)}>
                            Прибрати доказ
                          </button>
                        ) : null}
                      </div>
                      {evidence.evidenceSource === "person_v1" ? (
                        <small>Автоматичний доказ із соціального зв’язку редагується у відповідному записі.</small>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {canEdit ? (
              <form
                className="research-graph-v1__evidence-editor"
                onSubmit={(event) => { event.preventDefault(); onAddEvidence(); }}
              >
                <strong>Додати доказ із проєкту</strong>
                <label>
                  <span>Тип</span>
                  <select
                    value={evidenceDraft.entityType}
                    onChange={(event) => onEvidenceDraftChange({
                      ...evidenceDraft,
                      entityType: event.target.value as EvidenceEditorState["entityType"],
                      entityId: "",
                    })}
                  >
                    <option value="document">Документ</option>
                    <option value="finding">Знахідка</option>
                  </select>
                </label>
                <label>
                  <span>Запис</span>
                  <select
                    required
                    value={evidenceDraft.entityId}
                    onChange={(event) => onEvidenceDraftChange({ ...evidenceDraft, entityId: event.target.value })}
                  >
                    <option value="">Оберіть запис</option>
                    {evidenceTargets.map((option) => (
                      <option key={`${option.entityType}:${option.entityId}`} value={option.entityId}>
                        {option.label}{option.secondaryLabel ? ` · ${option.secondaryLabel}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Сторінка / місце</span>
                  <input
                    value={evidenceDraft.sourceLocator}
                    onChange={(event) => onEvidenceDraftChange({ ...evidenceDraft, sourceLocator: event.target.value })}
                  />
                </label>
                <label>
                  <span>Короткий уривок</span>
                  <textarea
                    rows={2}
                    value={evidenceDraft.excerpt}
                    onChange={(event) => onEvidenceDraftChange({ ...evidenceDraft, excerpt: event.target.value })}
                  />
                </label>
                <button type="submit" disabled={mutationBusy || !evidenceTargets.length}>Додати доказ</button>
              </form>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ResearchGraphSkeleton() {
  return (
    <div className="research-graph-v1__skeleton" aria-label="Завантаження дослідницького графа">
      <span className="is-center" /><span className="is-one" />
      <span className="is-two" /><span className="is-three" /><span className="is-four" />
    </div>
  );
}

function defaultFilters(): FilterState {
  return {
    depth: 2,
    entityTypes: ENTITY_TYPE_OPTIONS.map((option) => option.value),
    relationTypeId: "all",
    evidenceStatus: "all",
    assertionKind: "research_hypothesis",
    minConfidence: 0,
    validFrom: "",
    validTo: "",
    hasEvidence: "all",
    placeId: "",
    placeLabel: "",
    temporalMode: "all",
    focusYear: DEFAULT_FOCUS_YEAR,
    focusDate: "",
    includeUndated: false,
  };
}

function defaultRelationEditor(): RelationEditorState {
  return {
    targetEntityType: "person",
    targetEntityId: "",
    relationTypeId: "",
    centerEndpoint: "source",
    assertionKind: "research_hypothesis",
    evidenceStatus: "unknown",
    confidence: 50,
    validFrom: "",
    validTo: "",
    notes: "",
  };
}

function defaultEvidenceEditor(): EvidenceEditorState {
  return { entityType: "document", entityId: "", sourceLocator: "", excerpt: "" };
}

function partialHistoricalDateRangeError(validFrom: string, validTo: string): string {
  const from = partialHistoricalDateBound(validFrom, "start");
  const to = partialHistoricalDateBound(validTo, "end");
  if (from === null || to === null) {
    return "Вкажіть дату у форматі РРРР, РРРР-ММ або РРРР-ММ-ДД.";
  }
  return from && to && from > to ? "Початкова дата не може бути пізнішою за кінцеву." : "";
}

function temporalFocusError(filters: FilterState): string {
  if (filters.temporalMode === "all") return "";
  if (filters.temporalMode === "year") {
    return Number.isInteger(filters.focusYear) && filters.focusYear >= 1 && filters.focusYear <= 9999
      ? ""
      : "Вкажіть рік часового зрізу від 1 до 9999.";
  }
  return exactHistoricalDateError(filters.focusDate);
}

function exactHistoricalDateError(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    return "Вкажіть точну дату часового зрізу у форматі РРРР-ММ-ДД.";
  }
  return partialHistoricalDateBound(normalized, "start") === null
    ? "Вкажіть коректну точну дату часового зрізу."
    : "";
}

function partialHistoricalDateBound(value: string, boundary: "start" | "end"): string | null {
  const normalized = value.trim();
  if (!normalized) return "";
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : boundary === "start" ? 1 : 12;
  const maximumDay = daysInHistoricalMonth(year, month);
  const day = match[3] ? Number(match[3]) : boundary === "start" ? 1 : maximumDay;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > maximumDay) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInHistoricalMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function copyFilters(value: FilterState): FilterState {
  return { ...value, entityTypes: [...value.entityTypes] };
}

function toSavedViewFilters(value: FilterState): ResearchGraphSavedView["filters"] {
  return {
    depth: value.depth,
    entityTypes: [...value.entityTypes],
    relationTypeIds: value.relationTypeId === "all" ? [] : [value.relationTypeId],
    evidenceStatuses: value.evidenceStatus === "all" ? [] : [value.evidenceStatus],
    assertionKinds: value.assertionKind === "all" ? [] : [value.assertionKind],
    validFrom: value.validFrom.trim(),
    validTo: value.validTo.trim(),
    minConfidence: value.minConfidence,
    hasEvidence: value.hasEvidence === "all" ? null : value.hasEvidence === "yes",
    focusDate: value.temporalMode === "date" ? value.focusDate.trim() : "",
    focusYear: value.temporalMode === "year" ? value.focusYear : null,
    placeIds: value.placeId ? [value.placeId] : [],
    includeUndated: value.temporalMode === "all" ? false : value.includeUndated,
    maxNodes: 100,
    maxEdges: 220,
  };
}

function fromSavedViewFilters(
  view: ResearchGraphSavedView,
  place: ResearchGraphPlaceOption | null,
): FilterState {
  const filters = view.filters;
  const temporalMode: TemporalFocusMode = filters.focusDate
    ? "date"
    : filters.focusYear !== null
      ? "year"
      : "all";
  return {
    depth: filters.depth,
    entityTypes: [...filters.entityTypes],
    relationTypeId: filters.relationTypeIds[0] ?? "all",
    evidenceStatus: filters.evidenceStatuses[0] ?? "all",
    assertionKind: filters.assertionKinds[0] ?? "all",
    minConfidence: filters.minConfidence,
    validFrom: filters.validFrom,
    validTo: filters.validTo,
    hasEvidence: filters.hasEvidence === null ? "all" : filters.hasEvidence ? "yes" : "no",
    placeId: place?.id ?? "",
    placeLabel: place?.label ?? "",
    temporalMode,
    focusYear: filters.focusYear ?? DEFAULT_FOCUS_YEAR,
    focusDate: filters.focusDate,
    includeUndated: temporalMode === "all" ? false : filters.includeUndated,
  };
}

function compareSavedViews(left: ResearchGraphSavedView, right: ResearchGraphSavedView): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || left.name.localeCompare(right.name, "uk-UA");
}

function savedViewDateLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "нещодавно";
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(timestamp));
}

function toServiceFilters(value: FilterState): PersonResearchGraphFilters {
  return {
    depth: value.depth,
    entityTypes: value.entityTypes,
    relationTypeIds: value.relationTypeId === "all" ? undefined : [value.relationTypeId],
    evidenceStatuses: value.evidenceStatus === "all" ? undefined : [value.evidenceStatus],
    assertionKinds: value.assertionKind === "all" ? undefined : [value.assertionKind],
    minConfidence: value.minConfidence,
    validFrom: value.validFrom.trim() || undefined,
    validTo: value.validTo.trim() || undefined,
    hasEvidence: value.hasEvidence === "all" ? undefined : value.hasEvidence === "yes",
    focusDate: value.temporalMode === "date" ? value.focusDate.trim() : undefined,
    focusYear: value.temporalMode === "year" ? value.focusYear : undefined,
    placeIds: value.placeId ? [value.placeId] : undefined,
    includeUndated: value.temporalMode === "all" ? false : value.includeUndated,
    maxNodes: 100,
    maxEdges: 220,
  };
}

function temporalFocusLabel(value: FilterState): string {
  if (value.temporalMode === "year") return `станом на ${value.focusYear} рік`;
  if (value.temporalMode === "date") return `станом на ${value.focusDate}`;
  return "весь доступний період";
}

function edgeClassName(edge: ResearchGraphEdge, selectedNodeId: string): string {
  return [
    `is-${edge.evidenceStatus}`,
    isResearchHypothesisEdge(edge) ? "is-hypothesis" : "",
    edge.generated ? "is-generated" : "",
    edge.source === selectedNodeId || edge.target === selectedNodeId ? "is-selected" : "",
  ].filter(Boolean).join(" ");
}

function contextualRelationLabel(
  edge: ResearchGraphEdge,
  selectedNodeId: ResearchGraphNode["id"],
  relationType?: ContextRelationType,
): string {
  if (edge.directionality === "symmetric") {
    return edge.relationTypeLabel || readableCode(edge.relationTypeCode);
  }
  if (edge.source === selectedNodeId) {
    return edge.sourceRoleLabel
      || relationType?.sourceRoleUk
      || edge.relationTypeLabel
      || readableCode(edge.relationTypeCode);
  }
  return edge.targetRoleLabel
    || relationType?.inverseLabelUk
    || relationType?.targetRoleUk
    || `Зворотний зв’язок: ${edge.relationTypeLabel || readableCode(edge.relationTypeCode)}`;
}

function isManuallyManagedResearchEdge(edge: ResearchGraphEdge): boolean {
  return edge.assertionKind === "manual" || edge.assertionKind === "research_hypothesis";
}

function contextRelationTypeSupportsTarget(
  relationType: ContextRelationType,
  targetType: EditableTargetEntityType,
): boolean {
  // These catalogue rows remain readable for imported historical data, but
  // the backend deliberately rejects them for new manual assertions. Keep
  // the editor aligned with that rule and require an exact role instead.
  if (isLegacyAmbiguousSocialRelationTypeCode(relationType.code)) return false;
  if (!relationType.isSystem || relationType.code === "other") return true;
  switch (relationType.code) {
    case "supports_hypothesis":
    case "contradicts_hypothesis":
      return targetType === "hypothesis";
    case "documented_in":
      return targetType === "document";
    case "located_at":
      return targetType === "place";
    case "held_by_repository":
    case "derived_from_source":
      return false;
    default:
      return targetType === "person";
  }
}

function relationTypeRequiresCenterAsSource(relationType?: ContextRelationType): boolean {
  return relationType?.isSystem === true && (
    relationType.code === "supports_hypothesis"
    || relationType.code === "contradicts_hypothesis"
    || relationType.code === "documented_in"
    || relationType.code === "located_at"
  );
}

function relationTypeEditorLabel(relationType: ContextRelationType): string {
  if (relationType.code === "caregiver") return "Доглядальник або неформальний опікун";
  if (relationType.code === "guardian_non_parent") return "Офіційний опікун без батьківства";
  return relationType.labelUk || readableCode(relationType.code);
}

function activateWithKeyboard(event: ReactKeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function personDisplayName(person: Person): string {
  return person.fullName.trim()
    || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")
    || "Особа";
}

function compactLabel(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function metadataText(metadata: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function metadataTextList(metadata: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (!Array.isArray(value)) continue;
    const labels = value.map((item) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      const row = item as Record<string, unknown>;
      return metadataText(row, ["label", "displayName", "display_name", "name"]);
    }).filter(Boolean);
    if (labels.length) return labels.join(" → ");
  }
  return "";
}

function metadataNestedLabel(metadata: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = metadata[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const label = metadataText(value as Record<string, unknown>, ["label", "name", "code"]);
    if (label) return label;
  }
  return "";
}

function entityTypeLabel(value: ResearchGraphEntityType): string {
  return ENTITY_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? "Вузол";
}

function evidenceStatusLabel(value: ContextEvidenceStatus): string {
  return EVIDENCE_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? "Не перевірено";
}

function assertionKindLabel(value: ContextAssertionKind): string {
  return ASSERTION_OPTIONS.find((option) => option.value === value)?.label ?? "Твердження";
}

function readableCode(value: string): string {
  const result = value.trim().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ");
  return result ? `${result.charAt(0).toLocaleUpperCase("uk-UA")}${result.slice(1)}` : "Контекстний зв’язок";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

const DEFAULT_FOCUS_YEAR = 1900;

const RESEARCH_GRAPH_LAYOUT_OPTIONS: ReadonlyArray<{
  value: ResearchGraphLayoutId;
  label: string;
  description: string;
}> = [
  {
    value: "radial",
    label: "Радіальний",
    description: "Центральна особа залишається посередині, а пов’язані вузли розташовуються кільцями.",
  },
  {
    value: "hierarchical",
    label: "Ієрархічний",
    description: "Вузли розташовуються стабільними рівнями від центральної особи зверху вниз.",
  },
  {
    value: "force",
    label: "Силовий",
    description: "Пов’язані групи збираються ближче одна до одної без випадкової зміни позицій.",
  },
];

function researchGraphLayoutLabel(value: ResearchGraphLayoutId): string {
  return RESEARCH_GRAPH_LAYOUT_OPTIONS.find((option) => option.value === value)?.label ?? "Макет графа";
}

function researchGraphLayoutDescription(value: ResearchGraphLayoutId): string {
  return RESEARCH_GRAPH_LAYOUT_OPTIONS.find((option) => option.value === value)?.description ?? "";
}

const ENTITY_TYPE_OPTIONS: ReadonlyArray<{ value: ResearchGraphEntityType; label: string }> = [
  { value: "hypothesis", label: "Гіпотези" },
  { value: "person", label: "Особи" },
  { value: "family", label: "Сім’ї" },
  { value: "finding", label: "Знахідки" },
  { value: "event", label: "Події" },
  { value: "document", label: "Документи" },
  { value: "source", label: "Джерела" },
  { value: "repository", label: "Архіви" },
  { value: "place", label: "Місця" },
];

const EDITABLE_TARGET_TYPE_OPTIONS: ReadonlyArray<{
  value: EditableTargetEntityType;
  label: string;
}> = [
  { value: "person", label: "Особа" },
  { value: "document", label: "Документ" },
  { value: "finding", label: "Знахідка" },
  { value: "place", label: "Історичне місце" },
  { value: "hypothesis", label: "Гіпотеза" },
  { value: "event", label: "Подія особи" },
];

const EVIDENCE_STATUS_OPTIONS: ReadonlyArray<{ value: ContextEvidenceStatus; label: string }> = [
  { value: "unknown", label: "Не перевірено" },
  { value: "likely", label: "Ймовірно" },
  { value: "proven", label: "Підтверджено" },
  { value: "disputed", label: "Спірно" },
  { value: "disproven", label: "Спростовано" },
];

const ASSERTION_OPTIONS: ReadonlyArray<{ value: AssertionFilter; label: string }> = [
  { value: "research_hypothesis", label: "Лише дослідницькі гіпотези" },
  { value: "all", label: "Усі твердження" },
  { value: "manual", label: "Внесено дослідником" },
  { value: "generated", label: "Створено системою" },
  { value: "legacy_import", label: "Імпортовані" },
];
