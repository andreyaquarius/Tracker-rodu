import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Modal } from "../Modal.tsx";
import { AncestorChartColorControls } from "./AncestorChartColorControls.tsx";
import { FamilyTreeChartBrand } from "./FamilyTreeChartBrand.tsx";
import type { FamilyTreeNeighborhoodClient } from "../../features/family-tree-view/data/neighborhoodClient.ts";
import { useFamilyTreeNeighborhood } from "../../features/family-tree-view/react/useFamilyTreeNeighborhood.ts";
import { useProgressiveDescendantGraph } from "../../features/family-tree-view/react/useProgressiveDescendantGraph.ts";
import {
  FAN_CHART_FOCUS_RADIUS,
  FAN_CHART_RING_WIDTH,
  MAX_ANCESTOR_FAN_GENERATIONS,
  MAX_DESCENDANT_FAN_GENERATIONS,
  MAX_FAN_CHART_OCCURRENCES,
  buildFanChartModel,
  fanChartSectorGapDegrees,
  type FanChartDirection,
  type FanChartOccurrence,
} from "../../features/family-tree-view/fan/fanChartLayout.ts";
import { planFanChartSectorLabel } from "../../features/family-tree-view/fan/fanChartLabels.ts";
import {
  FAN_CHART_EXPORT_OPTIONS,
  exportFanChart,
  type FanChartExportFormat,
} from "../../features/family-tree-view/fan/fanChartExport.ts";
import {
  applyFamilyTreeNameDisplay,
  type FamilyTreeNameDisplayPreferences,
  type FamilyTreeNameProfile,
} from "../../features/family-tree-view/adapters/familyTreeNameDisplay.ts";
import type { ParentRelationshipKind } from "../../features/family-tree-view/types.ts";
import { formatCircularAncestorLife } from "../../features/family-tree-view/circular/circularAncestorChartLabels.ts";
import { createTrackerNeighborhoodClient } from "../../services/familyTreeNeighborhoodService.ts";
import {
  ancestorChartToneForOccurrence,
  familyTreeChartColorCssVariables,
  resolveFamilyTreeChartColorScheme,
  type FamilyTreeChartTone,
} from "../../features/family-tree-view/appearance/familyTreeChartColorScheme.ts";
import {
  DEFAULT_FAMILY_TREE_APPEARANCE,
  normalizeFamilyTreeAppearance,
  type FamilyTreeAppearancePreferences,
} from "../../utils/familyTreeAppearance.ts";
import { familyTreeChartBrandScreenPlacement } from "../../features/family-tree-view/export/familyTreeChartBrand.ts";

const DEFAULT_ANCESTOR_GENERATIONS = 7;
const DEFAULT_DESCENDANT_GENERATIONS = 5;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1024;
const TARGET_LABEL_SCREEN_SIZE = 8;

export interface FanGenealogyFocusResult {
  personId: string;
  label: string;
  detail?: string;
}

interface FanGenealogyChartWindowProps {
  treeId: string;
  direction: FanChartDirection;
  focusPersonId: string;
  focusPersonLabel?: string;
  nameDisplayPreferences?: FamilyTreeNameDisplayPreferences;
  appearancePreferences?: FamilyTreeAppearancePreferences;
  nameProfiles?: readonly FamilyTreeNameProfile[];
  /** Optional dependency injection used by isolated previews and tests. */
  client?: FamilyTreeNeighborhoodClient;
  searchFocusPersons?: (query: string) => readonly FanGenealogyFocusResult[];
  onFocusPersonChange?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onClose: () => void;
}

interface FanCamera {
  zoom: number;
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  cameraX: number;
  cameraY: number;
  occurrenceId?: string;
  moved: boolean;
}

export function FanGenealogyChartWindow({
  treeId,
  direction,
  focusPersonId,
  focusPersonLabel,
  nameDisplayPreferences,
  appearancePreferences,
  nameProfiles = [],
  client: providedClient,
  searchFocusPersons,
  onFocusPersonChange,
  onOpenPerson,
  onClose,
}: FanGenealogyChartWindowProps) {
  const defaultGenerations = direction === "ancestors"
    ? DEFAULT_ANCESTOR_GENERATIONS
    : DEFAULT_DESCENDANT_GENERATIONS;
  const maxGenerations = direction === "ancestors"
    ? MAX_ANCESTOR_FAN_GENERATIONS
    : MAX_DESCENDANT_FAN_GENERATIONS;
  const client = useMemo(
    () => providedClient ?? createTrackerNeighborhoodClient(),
    [providedClient],
  );
  const [draftGenerations, setDraftGenerations] = useState(defaultGenerations);
  const [generations, setGenerations] = useState(defaultGenerations);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState("");
  const [showAccessibleList, setShowAccessibleList] = useState(false);
  const [focusPickerOpen, setFocusPickerOpen] = useState(false);
  const [focusSearchQuery, setFocusSearchQuery] = useState("");
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [exportPending, setExportPending] = useState(false);
  const [exportFeedback, setExportFeedback] = useState("");
  const [exportError, setExportError] = useState("");
  const inheritedAppearance = useMemo(
    () => normalizeFamilyTreeAppearance(
      appearancePreferences ?? DEFAULT_FAMILY_TREE_APPEARANCE,
    ),
    [appearancePreferences],
  );
  const [chartAppearance, setChartAppearance] = useState(inheritedAppearance);
  const [chartColorsDirty, setChartColorsDirty] = useState(false);
  const [camera, setCamera] = useState<FanCamera>({ zoom: 1, x: 0, y: 0 });
  const [svgSize, setSvgSize] = useState({ width: 1, height: 1 });
  const chartId = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fullscreenTargetRef = useRef<HTMLDivElement | null>(null);
  const fullscreenPendingRef = useRef(false);
  const dragRef = useRef<DragState | undefined>(undefined);
  const lastPointerGestureDraggedRef = useRef(false);

  useEffect(() => {
    setChartAppearance(inheritedAppearance);
    setChartColorsDirty(false);
  }, [inheritedAppearance]);

  const chartColorScheme = useMemo(
    () => resolveFamilyTreeChartColorScheme(chartAppearance),
    [chartAppearance],
  );
  const chartColorStyle = useMemo(
    () => familyTreeChartColorCssVariables(chartColorScheme) as CSSProperties,
    [chartColorScheme],
  );

  const neighborhood = useFamilyTreeNeighborhood({
    client,
    treeId,
    focusPersonId,
    sessionKey: `fan-${direction}:${focusPersonId}`,
    ancestorDepth: direction === "ancestors" ? generations : 0,
    // Descendants are streamed generation by generation below. The base read
    // only supplies the selected root and its current graph scope.
    descendantDepth: 0,
    collateralDepth: 0,
    maxNodes: MAX_FAN_CHART_OCCURRENCES,
    structuralOnly: true,
  });
  const descendantSeedReady = direction === "descendants" &&
    neighborhood.graph.persons.some((person) => person.id === focusPersonId);
  const progressiveDescendants = useProgressiveDescendantGraph({
    client,
    treeId,
    rootPersonId: focusPersonId,
    enabled: descendantSeedReady,
    sessionKey: `fan-descendants:${focusPersonId}`,
    maxGenerations: generations,
    pageSize: 200,
    maxPersons: MAX_FAN_CHART_OCCURRENCES,
    initialGraph: neighborhood.graph,
    knownGraphVersion: neighborhood.graph.graphVersion,
    permissionFingerprint: neighborhood.graph.permissionFingerprint,
  });
  const sourceGraph = direction === "descendants"
    ? progressiveDescendants.graph
    : neighborhood.graph;
  const descendantGraphReady = direction !== "descendants" ||
    sourceGraph.persons.some((person) => person.id === focusPersonId);
  const chartLoading = neighborhood.loading || (
    direction === "descendants" &&
    (!descendantGraphReady || progressiveDescendants.loading)
  );
  const chartError = neighborhood.error ?? (
    direction === "descendants" ? progressiveDescendants.error : undefined
  );
  const displayGraph = useMemo(
    () => applyFamilyTreeNameDisplay(
      sourceGraph,
      nameDisplayPreferences ?? inheritedAppearance,
      nameProfiles,
    ),
    [inheritedAppearance, nameDisplayPreferences, nameProfiles, sourceGraph],
  );
  const model = useMemo(
    () => buildFanChartModel(displayGraph, focusPersonId, generations, direction),
    [direction, displayGraph, focusPersonId, generations],
  );
  const occurrenceById = useMemo(
    () => new Map(model.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence])),
    [model.occurrences],
  );
  const selectedOccurrence = occurrenceById.get(selectedOccurrenceId) ?? model.occurrences[0];
  const selectedOccurrenceTone = direction === "ancestors" && selectedOccurrence?.slot
    ? ancestorChartToneForOccurrence(chartColorScheme, {
        slot: selectedOccurrence.slot,
        generation: selectedOccurrence.generation,
      })
    : undefined;
  const selectedPath = useMemo(() => {
    const path = new Set<string>();
    let occurrence: FanChartOccurrence | undefined = selectedOccurrence;
    while (occurrence) {
      path.add(occurrence.occurrenceId);
      occurrence = occurrence.parentOccurrenceId
        ? occurrenceById.get(occurrence.parentOccurrenceId)
        : undefined;
    }
    return path;
  }, [occurrenceById, selectedOccurrence]);
  const currentFocusLabel = model.occurrences[0]?.person.displayName || focusPersonLabel || "Особа";
  const normalizedFocusSearch = focusSearchQuery.trim();
  const focusSearchResults = useMemo(
    () => normalizedFocusSearch && searchFocusPersons
      ? searchFocusPersons(normalizedFocusSearch).slice(0, 12)
      : [],
    [normalizedFocusSearch, searchFocusPersons],
  );
  const visibleGenerations = Math.max(
    1,
    model.occurrences.reduce(
      (maximum, occurrence) => Math.max(maximum, occurrence.generation),
      0,
    ),
  );
  const chartRadius = FAN_CHART_FOCUS_RADIUS + visibleGenerations * FAN_CHART_RING_WIDTH;
  const worldLeft = -chartRadius - 42;
  const worldRight = chartRadius + 42;
  const worldTop = direction === "ancestors"
    ? -chartRadius - 42
    : -FAN_CHART_FOCUS_RADIUS - 42;
  const worldBottom = direction === "ancestors"
    ? FAN_CHART_FOCUS_RADIUS + 42
    : chartRadius + 42;
  const worldWidth = worldRight - worldLeft;
  const worldHeight = worldBottom - worldTop;
  const baseCenterY = (worldTop + worldBottom) / 2;
  const viewWidth = worldWidth / camera.zoom;
  const viewHeight = worldHeight / camera.zoom;
  const chartBrandPlacement = familyTreeChartBrandScreenPlacement(
    {
      x: camera.x - viewWidth / 2,
      y: baseCenterY + camera.y - viewHeight / 2,
      width: viewWidth,
      height: viewHeight,
    },
    svgSize,
    direction === "descendants" ? "top-right" : "bottom-right",
  );
  const fitPixelsPerWorld = Math.max(
    1e-6,
    Math.min(svgSize.width / worldWidth, svgSize.height / worldHeight),
  );
  const smallestRenderedName = useMemo(() => {
    if (direction !== "ancestors") return TARGET_LABEL_SCREEN_SIZE;
    const renderedSizes = model.occurrences
      .filter((occurrence) => occurrence.generation > 0)
      .map((occurrence) => planFanChartSectorLabel(occurrence).renderedNameFontSize)
      .filter((value) => Number.isFinite(value) && value > 0);
    return renderedSizes.length ? Math.min(...renderedSizes) : TARGET_LABEL_SCREEN_SIZE;
  }, [direction, model.occurrences]);
  const rawReadableLabelZoom = direction === "ancestors"
    ? TARGET_LABEL_SCREEN_SIZE / (smallestRenderedName * fitPixelsPerWorld)
    : 1;
  const readableLabelZoom = Math.min(
    MAX_ZOOM,
    Math.max(1, Math.ceil(rawReadableLabelZoom * 100) / 100),
  );
  const relationKind = selectedOccurrence?.relationId
    ? displayGraph.parentChildRelations.find((relation) => relation.id === selectedOccurrence.relationId)?.kind
    : undefined;
  const fullscreen = nativeFullscreen || fallbackFullscreen;
  const chartWarnings = useMemo(() => {
    const partialDirection = direction === "ancestors" ? "parents" : "children";
    const partial = displayGraph.continuations?.some(
      (continuation) => continuation.direction === partialDirection,
    ) || (direction === "descendants" && progressiveDescendants.truncated);
    return [...new Set([
      ...model.warnings,
      ...(partial
        ? [direction === "ancestors"
          ? "Показано завантажену частину великого родоводу. За межею серверного ліміту можуть бути додаткові предки."
          : "Показано завантажену частину великого родоводу. Зменште кількість поколінь або відкрийте іншу центральну особу, щоб перевірити віддалені гілки."]
        : []),
      ...(direction === "ancestors" && rawReadableLabelZoom > MAX_ZOOM
        ? ["У найвужчих секторах повний текст збережено у векторі, але для читання може знадобитися експорт SVG або доступний список."]
        : []),
    ])].slice(0, 4);
  }, [
    direction,
    displayGraph.continuations,
    model.warnings,
    progressiveDescendants.truncated,
    rawReadableLabelZoom,
  ]);

  function resetCamera() {
    setCamera({ zoom: 1, x: 0, y: 0 });
  }

  function reloadChart() {
    if (neighborhood.error || direction === "ancestors") {
      neighborhood.reload();
      return;
    }
    progressiveDescendants.reload();
  }

  function setZoom(nextZoom: number) {
    setCamera((current) => ({
      ...current,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom)),
    }));
  }

  async function saveChart(format: FanChartExportFormat) {
    const sourceSvg = svgRef.current;
    if (!sourceSvg || !model.occurrences.length || exportPending) return;

    setExportPending(true);
    setExportFeedback("");
    setExportError("");
    try {
      const message = await exportFanChart({
        sourceSvg,
        worldBounds: {
          x: worldLeft,
          y: worldTop,
          width: worldWidth,
          height: worldHeight,
        },
        format,
        direction,
        focusLabel: currentFocusLabel,
        generations,
        personCount: Math.max(0, model.occurrences.length - 1),
        generatedAtLabel: new Intl.DateTimeFormat("uk-UA", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date()),
      });
      setExportFeedback(message);
    } catch (error) {
      setExportError(
        error instanceof Error
          ? error.message
          : "Не вдалося зберегти віялову діаграму.",
      );
    } finally {
      setExportPending(false);
    }
  }

  function changeChartFocus(personId: string) {
    setFocusPickerOpen(false);
    setFocusSearchQuery("");
    setSelectedOccurrenceId("");
    resetCamera();
    if (personId !== focusPersonId) onFocusPersonChange?.(personId);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const occurrenceElement = event.target instanceof Element
      ? event.target.closest<SVGGElement>("[data-occurrence-id]")
      : null;
    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointerGestureDraggedRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      cameraX: camera.x,
      cameraY: camera.y,
      occurrenceId: occurrenceElement?.dataset.occurrenceId,
      moved: false,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.clientX;
    const deltaY = event.clientY - drag.clientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    lastPointerGestureDraggedRef.current = true;
    const bounds = event.currentTarget.getBoundingClientRect();
    setCamera((current) => ({
      ...current,
      x: drag.cameraX - deltaX * viewWidth / Math.max(1, bounds.width),
      y: drag.cameraY - deltaY * viewHeight / Math.max(1, bounds.height),
    }));
  }

  function stopDragging(event: ReactPointerEvent<SVGSVGElement>, select: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (select && !drag.moved && drag.occurrenceId) {
      setSelectedOccurrenceId(drag.occurrenceId);
    }
  }

  function handleCanvasKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const panX = viewWidth * 0.08;
    const panY = viewHeight * 0.08;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(camera.zoom * 1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom(camera.zoom / 1.2);
    } else if (event.key === "0" || event.key === "Home") {
      event.preventDefault();
      resetCamera();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setCamera((current) => ({
        ...current,
        x: current.x + (event.key === "ArrowLeft" ? -panX : panX),
      }));
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setCamera((current) => ({
        ...current,
        y: current.y + (event.key === "ArrowUp" ? -panY : panY),
      }));
    }
  }

  async function leaveNativeFullscreen() {
    if (
      document.fullscreenElement === fullscreenTargetRef.current &&
      document.exitFullscreen
    ) {
      await document.exitFullscreen().catch(() => undefined);
    }
  }

  async function toggleFullscreen() {
    if (fullscreenPendingRef.current) return;
    fullscreenPendingRef.current = true;
    setFullscreenPending(true);
    try {
      const target = fullscreenTargetRef.current;
      if (nativeFullscreen && document.fullscreenElement !== target) {
        setNativeFullscreen(false);
        return;
      }
      if (document.fullscreenElement === fullscreenTargetRef.current) {
        await leaveNativeFullscreen();
        return;
      }
      if (fallbackFullscreen) {
        setFallbackFullscreen(false);
        return;
      }
      if (!target?.requestFullscreen || document.fullscreenEnabled === false) {
        setFallbackFullscreen(true);
        return;
      }
      try {
        await target.requestFullscreen({ navigationUI: "hide" });
      } catch {
        setFallbackFullscreen(true);
      }
    } finally {
      fullscreenPendingRef.current = false;
      setFullscreenPending(false);
    }
  }

  async function closeWindow() {
    await leaveNativeFullscreen();
    onClose();
  }

  async function openPerson(personId: string) {
    setFallbackFullscreen(false);
    await leaveNativeFullscreen();
    onOpenPerson?.(personId);
  }

  useEffect(() => {
    const nextDefault = direction === "ancestors"
      ? DEFAULT_ANCESTOR_GENERATIONS
      : DEFAULT_DESCENDANT_GENERATIONS;
    setDraftGenerations(nextDefault);
    setGenerations(nextDefault);
    setSelectedOccurrenceId("");
    setExportFeedback("");
    setExportError("");
    resetCamera();
  }, [direction]);

  useEffect(() => {
    setSelectedOccurrenceId("");
    setFocusPickerOpen(false);
    setFocusSearchQuery("");
    setExportFeedback("");
    setExportError("");
    resetCamera();
  }, [focusPersonId]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const updateSize = () => {
      const bounds = svg.getBoundingClientRect();
      setSvgSize({
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const multiplier = event.deltaY < 0 ? 1.18 : 1 / 1.18;
      setCamera((current) => ({
        ...current,
        zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * multiplier)),
      }));
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      const ownFullscreen = document.fullscreenElement === fullscreenTargetRef.current;
      setNativeFullscreen(ownFullscreen);
      if (ownFullscreen) setFallbackFullscreen(false);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    syncFullscreenState();
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    if (!fallbackFullscreen && !nativeFullscreen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (fallbackFullscreen) setFallbackFullscreen(false);
        if (
          nativeFullscreen &&
          document.fullscreenElement !== fullscreenTargetRef.current
        ) {
          setNativeFullscreen(false);
        }
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [fallbackFullscreen, nativeFullscreen]);

  return (
    <Modal
      title={direction === "ancestors" ? "Віялова діаграма предків" : "Віялова діаграма нащадків"}
      className="circular-ancestor-modal fan-genealogy-modal"
      mode="window"
      fullscreen={fallbackFullscreen}
      onClose={() => void closeWindow()}
    >
      <div
        ref={fullscreenTargetRef}
        className={`circular-ancestor-window fan-genealogy-window is-${direction}`}
      >
        <header className={`circular-ancestor-toolbar ${focusPickerOpen ? "is-focus-picker-open" : ""}`}>
          <div className="circular-ancestor-intro">
            <span className="eyebrow">Центральна особа</span>
            {searchFocusPersons && onFocusPersonChange ? (
              <button
                type="button"
                className="circular-ancestor-focus-trigger"
                aria-haspopup="listbox"
                aria-expanded={focusPickerOpen}
                aria-controls={`${chartId}-fan-focus-results`}
                onClick={() => setFocusPickerOpen((current) => !current)}
              >
                <span>{currentFocusLabel}</span>
                <span aria-hidden="true">⌄</span>
              </button>
            ) : <strong>{currentFocusLabel}</strong>}
            <small>
              {direction === "ancestors"
                ? "Батьківська гілка ліворуч, материнська — праворуч."
                : "Показано лише нащадків цієї особи; сторонні родини партнерів не додаються."}
            </small>
            {focusPickerOpen && searchFocusPersons && onFocusPersonChange ? (
              <div className="circular-ancestor-focus-popover">
                <label>
                  <span>Знайти іншу особу</span>
                  <input
                    type="search"
                    value={focusSearchQuery}
                    placeholder="Ім’я, прізвище, рік або місце"
                    aria-controls={`${chartId}-fan-focus-results`}
                    autoFocus
                    onChange={(event) => setFocusSearchQuery(event.target.value)}
                  />
                </label>
                <div
                  id={`${chartId}-fan-focus-results`}
                  className="circular-ancestor-focus-results"
                  role="listbox"
                  aria-label="Результати пошуку центральної особи"
                >
                  {!normalizedFocusSearch ? (
                    <div className="circular-ancestor-focus-empty">Введіть ім’я, рік або місце.</div>
                  ) : focusSearchResults.length ? focusSearchResults.map((person) => (
                    <button
                      key={person.personId}
                      type="button"
                      role="option"
                      aria-selected={person.personId === focusPersonId}
                      onClick={() => changeChartFocus(person.personId)}
                    >
                      <strong>{person.label}</strong>
                      <small>{person.detail || "Без дат"}</small>
                    </button>
                  )) : (
                    <div className="circular-ancestor-focus-empty">Збігів не знайдено.</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <div className="circular-ancestor-build-controls">
            <label className="circular-ancestor-generation-control">
              <span>{direction === "ancestors" ? "Поколінь предків" : "Поколінь нащадків"}</span>
              <select
                value={draftGenerations}
                onChange={(event) => setDraftGenerations(Number(event.target.value))}
              >
                {Array.from({ length: maxGenerations }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button circular-ancestor-build-button"
              disabled={draftGenerations === generations || chartLoading}
              onClick={() => {
                setGenerations(draftGenerations);
                setSelectedOccurrenceId("");
                setExportFeedback("");
                setExportError("");
                resetCamera();
              }}
            >
              Побудувати
            </button>
          </div>
          <div className="circular-ancestor-navigation">
            <div className="circular-ancestor-camera-controls" role="group" aria-label="Керування діаграмою">
              <div className="circular-ancestor-zoom-controls" role="group" aria-label="Масштаб діаграми">
                <button type="button" onClick={() => setZoom(camera.zoom / 1.25)} aria-label="Зменшити масштаб">−</button>
                <span>{Math.round(camera.zoom * 100)}%</span>
                <button type="button" onClick={() => setZoom(camera.zoom * 1.25)} aria-label="Збільшити масштаб">+</button>
                <button type="button" onClick={resetCamera}>Вмістити</button>
                {direction === "ancestors" ? (
                  <button
                    type="button"
                    className="circular-ancestor-readable-zoom"
                    onClick={() => setCamera((current) => ({
                      ...current,
                      zoom: readableLabelZoom,
                    }))}
                    title={`Масштаб для читання найвужчих підписів: ${Math.round(readableLabelZoom * 100)}%`}
                  >
                    Читати · {Math.round(readableLabelZoom * 100)}%
                  </button>
                ) : null}
              </div>
              <div className="circular-ancestor-view-controls" role="group" aria-label="Вигляд і збереження діаграми">
                {direction === "ancestors" ? (
                  <AncestorChartColorControls
                    appearance={chartAppearance}
                    inheritedAppearance={inheritedAppearance}
                    dirty={chartColorsDirty}
                    onChange={(nextAppearance) => {
                      setChartAppearance(nextAppearance);
                      setChartColorsDirty(true);
                    }}
                    onReset={() => {
                      setChartAppearance(inheritedAppearance);
                      setChartColorsDirty(false);
                    }}
                  />
                ) : null}
                <button
                  type="button"
                  disabled={fullscreenPending}
                  aria-pressed={fullscreen}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? "Згорнути" : "На весь екран"}
                </button>
                <details className="circular-ancestor-export-menu">
                  <summary
                    aria-label="Зберегти або надрукувати віялову діаграму"
                    aria-disabled={exportPending || chartLoading || !model.occurrences.length}
                    title="Зберегти / PDF"
                    onClick={(event) => {
                      if (exportPending || chartLoading || !model.occurrences.length) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <span aria-hidden="true">{exportPending ? "…" : "⇩"}</span>
                  </summary>
                  <div role="menu" aria-label="Формат збереження віялової діаграми">
                    {FAN_CHART_EXPORT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitem"
                        disabled={exportPending || chartLoading || !model.occurrences.length}
                        onClick={(event) => {
                          event.currentTarget.closest("details")?.removeAttribute("open");
                          void saveChart(option.value);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </details>
              </div>
            </div>
            <button
              type="button"
              className="button button-secondary circular-ancestor-list-toggle"
              aria-expanded={showAccessibleList}
              onClick={() => setShowAccessibleList((current) => !current)}
            >
              {showAccessibleList ? "Сховати список" : "Доступний список"}
            </button>
          </div>
        </header>

        <div className="circular-ancestor-status" aria-live="polite">
          {chartLoading
            ? direction === "descendants" && descendantSeedReady
              ? `Завантажуємо покоління нащадків: ${Math.min(generations, progressiveDescendants.loadedGenerations)} із ${generations}…`
              : `Завантажуємо ${generations} поколінь…`
            : `${direction === "ancestors" ? "Предків" : "Нащадків"}: ${Math.max(0, model.occurrences.length - 1)}. ` +
              (direction === "ancestors"
                ? `Повні підписи збережені; для найвужчих секторів натисніть «Читати · ${Math.round(readableLabelZoom * 100)}%». `
                : "") +
              "Колесо масштабує лише діаграму; перетягування рухає полотно."}
          {exportFeedback ? <strong className="circular-ancestor-export-feedback"> {exportFeedback}</strong> : null}
        </div>
        {chartError ? (
          <div className="circular-ancestor-error" role="alert">
            <span>{chartError.message}</span>
            <button type="button" className="button button-secondary" onClick={reloadChart}>Спробувати ще раз</button>
          </div>
        ) : null}
        {exportError ? (
          <div className="circular-ancestor-error" role="alert">
            <span>{exportError}</span>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setExportError("")}
            >
              Закрити
            </button>
          </div>
        ) : null}
        {chartWarnings.length ? (
          <div className="circular-ancestor-warning" role="status">
            {chartWarnings.map((warning) => <span key={warning}>{warning}</span>)}
          </div>
        ) : null}

        <div className="circular-ancestor-content">
          <div
            className="circular-ancestor-canvas-wrap fan-genealogy-canvas-wrap"
            style={direction === "ancestors" ? chartColorStyle : undefined}
            tabIndex={0}
            aria-label={`Інтерактивна віялова діаграма ${direction === "ancestors" ? "предків" : "нащадків"}. Клавіші плюс і мінус змінюють масштаб, стрілки рухають полотно, Home вміщує діаграму.`}
            onKeyDown={handleCanvasKeyDown}
          >
            <div className="circular-ancestor-legend" aria-hidden="true">
              {direction === "ancestors" ? (
                <>
                  <span><i className="paternal" style={{ backgroundColor: chartColorScheme.paternal.fill }} /> Батьківська гілка</span>
                  <span><i className="maternal" style={{ backgroundColor: chartColorScheme.maternal.fill }} /> Материнська гілка</span>
                </>
              ) : <span><i className="descendant" /> Гілки дітей</span>}
              <span><i className="duplicate" style={direction === "ancestors" ? { backgroundColor: chartColorScheme.duplicate.fill } : undefined} /> Повторна особа</span>
            </div>
            <svg
              ref={svgRef}
              style={direction === "ancestors" ? chartColorStyle : undefined}
              className={`circular-ancestor-chart fan-genealogy-chart ${dragRef.current ? "is-dragging" : ""}`}
              viewBox={`${camera.x - viewWidth / 2} ${baseCenterY + camera.y - viewHeight / 2} ${viewWidth} ${viewHeight}`}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => stopDragging(event, true)}
              onPointerCancel={(event) => stopDragging(event, false)}
            >
              <defs>
                <filter id={`${chartId}-fan-shadow`} x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#173f36" floodOpacity=".18" />
                </filter>
              </defs>
              <g className="fan-genealogy-grid">
                {Array.from({ length: visibleGenerations }, (_, index) => index + 1).map((generation) => (
                  <path
                    key={generation}
                    d={fanArcPath(
                      FAN_CHART_FOCUS_RADIUS + generation * FAN_CHART_RING_WIDTH,
                      direction,
                    )}
                  />
                ))}
                <line
                  x1={-chartRadius}
                  y1={0}
                  x2={chartRadius}
                  y2={0}
                />
              </g>
              <g>
                {model.occurrences.filter((occurrence) => occurrence.generation > 0).map((occurrence) => (
                  <FanSector
                    key={occurrence.occurrenceId}
                    occurrence={occurrence}
                    chartId={chartId}
                    selected={occurrence.occurrenceId === selectedOccurrence?.occurrenceId}
                    highlighted={selectedPath.has(occurrence.occurrenceId)}
                    tone={direction === "ancestors" && occurrence.slot
                      ? ancestorChartToneForOccurrence(chartColorScheme, {
                          slot: occurrence.slot,
                          generation: occurrence.generation,
                        })
                      : undefined}
                    onSelect={() => {
                      if (lastPointerGestureDraggedRef.current) {
                        lastPointerGestureDraggedRef.current = false;
                        return;
                      }
                      setSelectedOccurrenceId(occurrence.occurrenceId);
                    }}
                  />
                ))}
              </g>
              {model.occurrences[0] ? (
                <FanFocusCard
                  occurrence={model.occurrences[0]}
                  chartId={chartId}
                  selected={selectedOccurrence?.occurrenceId === model.occurrences[0].occurrenceId}
                  tone={direction === "ancestors" ? chartColorScheme.focus : undefined}
                  onSelect={() => setSelectedOccurrenceId(model.occurrences[0]!.occurrenceId)}
                />
              ) : null}
              <FamilyTreeChartBrand placement={chartBrandPlacement} />
            </svg>
            {chartLoading && !model.occurrences.length ? (
              <div className="circular-ancestor-loading">Будуємо віялову діаграму…</div>
            ) : null}
          </div>

          <aside className="circular-ancestor-details">
            {selectedOccurrence ? (
              <>
                <span className="eyebrow">{fanGenerationLabel(direction, selectedOccurrence.generation)}</span>
                <div
                  className={`circular-ancestor-avatar ${selectedOccurrence.branch}`}
                  style={selectedOccurrenceTone ? {
                    color: selectedOccurrenceTone.foreground,
                    backgroundColor: selectedOccurrenceTone.fill,
                    borderColor: selectedOccurrenceTone.stroke,
                  } : undefined}
                >
                  {personInitials(selectedOccurrence.person.displayName)}
                </div>
                <h3>{selectedOccurrence.person.displayName}</h3>
                <p>{formatCircularAncestorLife(selectedOccurrence.person)}</p>
                <dl>
                  <div><dt>Покоління</dt><dd>{selectedOccurrence.generation}</dd></div>
                  {direction === "ancestors" ? (
                    <div><dt>Гілка</dt><dd>{fanBranchLabel(selectedOccurrence)}</dd></div>
                  ) : relationKind ? (
                    <div><dt>Зв’язок</dt><dd>{parentRelationLabel(relationKind)}</dd></div>
                  ) : null}
                  {selectedOccurrence.duplicate ? (
                    <div><dt>Позначка</dt><dd>Повторна особа</dd></div>
                  ) : null}
                </dl>
                <div className="circular-ancestor-details-actions">
                  {onOpenPerson ? (
                    <button type="button" className="button" onClick={() => void openPerson(selectedOccurrence.personId)}>
                      Відкрити картку особи
                    </button>
                  ) : null}
                  {onFocusPersonChange && selectedOccurrence.personId !== focusPersonId ? (
                    <button type="button" className="button button-secondary" onClick={() => changeChartFocus(selectedOccurrence.personId)}>
                      Зробити центральною
                    </button>
                  ) : null}
                </div>
              </>
            ) : <p>Дані центральної особи ще завантажуються.</p>}
          </aside>
        </div>

        {showAccessibleList ? (
          <div
            className="circular-ancestor-accessible-list"
            aria-label={direction === "ancestors" ? "Предки за поколіннями" : "Нащадки за поколіннями"}
          >
            {Array.from({ length: generations + 1 }, (_, generation) => {
              const occurrences = model.occurrences.filter((item) => item.generation === generation);
              if (!occurrences.length) return null;
              return (
                <section key={generation}>
                  <h3>{fanGenerationLabel(direction, generation)}</h3>
                  <div>
                    {occurrences.map((occurrence) => (
                      <button
                        type="button"
                        key={occurrence.occurrenceId}
                        className={occurrence.occurrenceId === selectedOccurrence?.occurrenceId ? "is-selected" : ""}
                        onClick={() => setSelectedOccurrenceId(occurrence.occurrenceId)}
                      >
                        <strong>{occurrence.person.displayName}</strong>
                        <small>
                          {direction === "ancestors"
                            ? fanBranchLabel(occurrence)
                            : occurrence.duplicate ? "Повторна особа" : `Гілка ${occurrence.index + 1}`}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function FanSector({
  occurrence,
  chartId,
  selected,
  highlighted,
  tone,
  onSelect,
}: {
  occurrence: FanChartOccurrence;
  chartId: string;
  selected: boolean;
  highlighted: boolean;
  tone?: FamilyTreeChartTone;
  onSelect: () => void;
}) {
  const path = fanAnnularSectorPath(occurrence);
  const label = planFanChartSectorLabel(occurrence);
  const labelPoint = fanPolarPoint(label.midRadius, label.midAngle);
  const clipPathId = `${chartId}-fan-clip-${safeSvgId(occurrence.occurrenceId)}`;
  const branchColor = fanSectorColor(occurrence);
  return (
    <g
      data-occurrence-id={occurrence.occurrenceId}
      className={[
        "fan-genealogy-sector",
        `is-${occurrence.branch}`,
        occurrence.duplicate ? "is-duplicate" : "",
        selected ? "is-selected" : "",
        highlighted ? "is-highlighted" : "",
      ].filter(Boolean).join(" ")}
      style={tone ? {
        "--ancestor-sector-fill": tone.fill,
        "--ancestor-sector-foreground": tone.foreground,
        "--ancestor-sector-stroke": tone.stroke,
      } as CSSProperties : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <title>{label.accessibleText}</title>
      <defs>
        <clipPath id={clipPathId}>
          <path d={path} />
        </clipPath>
      </defs>
      <path d={path} style={tone ? undefined : { fill: branchColor }} />
      {label.mode === "visible" ? (
        <g
          className="fan-genealogy-sector-label"
          clipPath={`url(#${clipPathId})`}
        >
          <g transform={`translate(${labelPoint.x} ${labelPoint.y}) rotate(${label.rotation}) scale(${label.glyphScale})`}>
            {label.lines.map((line, index) => (
              <text
                key={`${line.kind}:${line.text}:${index}`}
                className={line.kind === "name"
                  ? "circular-ancestor-label-name"
                  : "circular-ancestor-label-life"}
                x={0}
                y={line.y}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ fontSize: line.glyphFontSize }}
              >
                {line.text}
              </text>
            ))}
          </g>
        </g>
      ) : null}
      {occurrence.duplicate ? (() => {
        const point = fanPolarPoint(occurrence.outerRadius - 7, (occurrence.startAngle + occurrence.endAngle) / 2);
        return <circle className="fan-genealogy-duplicate-mark" cx={point.x} cy={point.y} r={3.2} />;
      })() : null}
    </g>
  );
}

function FanFocusCard({
  occurrence,
  chartId,
  selected,
  tone,
  onSelect,
}: {
  occurrence: FanChartOccurrence;
  chartId: string;
  selected: boolean;
  tone?: FamilyTreeChartTone;
  onSelect: () => void;
}) {
  const nameLines = splitFocusName(occurrence.person.displayName);
  const longestLine = Math.max(...nameLines.map((line) => line.length), 1);
  const fontSize = Math.min(13, Math.max(7, 118 / (longestLine * 0.62)));
  const life = formatCircularAncestorLife(occurrence.person);
  return (
    <g
      data-occurrence-id={occurrence.occurrenceId}
      className={`fan-genealogy-focus ${selected ? "is-selected" : ""}`}
      style={tone ? {
        "--ancestor-sector-fill": tone.fill,
        "--ancestor-sector-foreground": tone.foreground,
        "--ancestor-sector-stroke": tone.stroke,
      } as CSSProperties : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <title>{occurrence.person.displayName}, {life}, центральна особа</title>
      <circle r={FAN_CHART_FOCUS_RADIUS - 7} filter={`url(#${chartId}-fan-shadow)`} />
      <text className="fan-genealogy-focus-name" textAnchor="middle" style={{ fontSize }}>
        {nameLines.map((line, index) => (
          <tspan key={`${line}:${index}`} x={0} y={(index - (nameLines.length - 1) / 2) * (fontSize + 2) - 6}>
            {line}
          </tspan>
        ))}
      </text>
      <text className="fan-genealogy-focus-life" x={0} y={30} textAnchor="middle" style={{ fontSize: Math.max(5, fontSize * 0.72) }}>
        {life}
      </text>
    </g>
  );
}

function fanAnnularSectorPath(occurrence: FanChartOccurrence): string {
  const gap = fanChartSectorGapDegrees(occurrence.startAngle, occurrence.endAngle);
  const start = occurrence.startAngle + gap;
  const end = occurrence.endAngle - gap;
  const outerRadius = Math.max(occurrence.innerRadius + 2, occurrence.outerRadius - 1);
  const innerRadius = Math.max(1, occurrence.innerRadius + 1);
  const outerStart = fanPolarPoint(outerRadius, start);
  const outerEnd = fanPolarPoint(outerRadius, end);
  const innerEnd = fanPolarPoint(innerRadius, end);
  const innerStart = fanPolarPoint(innerRadius, start);
  const largeArc = end - start > 180 ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 0 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 1 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function fanArcPath(radius: number, direction: FanChartDirection): string {
  const start = fanPolarPoint(radius, direction === "ancestors" ? -180 : 0);
  const end = fanPolarPoint(radius, direction === "ancestors" ? 0 : 180);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 0 ${end.x} ${end.y}`;
}

function fanPolarPoint(radius: number, angle: number): { x: number; y: number } {
  const radians = angle * Math.PI / 180;
  return { x: -radius * Math.cos(radians), y: radius * Math.sin(radians) };
}

function fanSectorColor(occurrence: FanChartOccurrence): string {
  if (occurrence.branch === "paternal") return "#cde5e3";
  if (occurrence.branch === "maternal") return "#efd9e3";
  const palette = ["#d8e9df", "#e8ddc7", "#dce4f1", "#ead9e3", "#d9e9e8", "#eee2c3", "#dedcf0", "#e0e8cf"];
  const branchKey = occurrence.pathKey.split(">")[1] || occurrence.personId;
  let hash = 0;
  for (const character of branchKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

function splitFocusName(name: string): readonly string[] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.length ? parts : ["Особа"];
  const midpoint = Math.ceil(parts.length / 2);
  return [parts.slice(0, midpoint).join(" "), parts.slice(midpoint).join(" ")];
}

function safeSvgId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function personInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(
    (part) => part[0]?.toLocaleUpperCase("uk-UA") ?? "",
  ).join("") || "?";
}

function fanGenerationLabel(direction: FanChartDirection, generation: number): string {
  if (generation === 0) return "Центральна особа";
  return `${generation} покоління ${direction === "ancestors" ? "предків" : "нащадків"}`;
}

function fanBranchLabel(occurrence: FanChartOccurrence): string {
  if (occurrence.branch === "paternal") return "Батьківська";
  if (occurrence.branch === "maternal") return "Материнська";
  if (occurrence.branch === "descendant") return "Гілка нащадків";
  return "Центральна особа";
}

function parentRelationLabel(kind: ParentRelationshipKind): string {
  const labels: Partial<Record<ParentRelationshipKind, string>> = {
    biological: "Біологічний зв’язок",
    genetic_father: "Генетичний батько",
    genetic_mother: "Генетична мати",
    gestational_parent: "Гестаційний зв’язок",
    birth_parent: "Батько/мати при народженні",
    adoptive: "Усиновлення",
    foster: "Прийомне батьківство",
    step: "Зведений батько/мати",
    guardian: "Опікунство",
    social_parent: "Соціальне батьківство",
    legal_parent: "Юридичне батьківство",
    donor: "Донорство",
    surrogate: "Сурогатне материнство",
    presumed: "Ймовірне батьківство",
    unknown: "Тип не уточнено",
    other: "Інший батьківсько-дитячий зв’язок",
  };
  return labels[kind] ?? kind;
}
