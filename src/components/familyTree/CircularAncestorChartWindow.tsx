import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Modal } from "../Modal";
import type { FamilyTreeNeighborhoodClient } from "../../features/family-tree-view/data/neighborhoodClient";
import { useFamilyTreeNeighborhood } from "../../features/family-tree-view/react/useFamilyTreeNeighborhood";
import {
  buildCircularAncestorChartModel,
  CIRCULAR_ANCESTOR_FOCUS_RADIUS,
  CIRCULAR_ANCESTOR_RING_WIDTH,
  type CircularAncestorOccurrence,
} from "../../features/family-tree-view/circular/circularAncestorChartLayout";
import {
  formatCircularAncestorLife,
  planCircularAncestorLabel,
  recommendCircularAncestorLabelZoom,
} from "../../features/family-tree-view/circular/circularAncestorChartLabels";
import { createTrackerNeighborhoodClient } from "../../services/familyTreeNeighborhoodService";

const DEFAULT_GENERATIONS = 7;
const MAX_GENERATIONS = 16;
const MAX_CHART_PERSONS = 600;
const MAX_ZOOM = 1024;

interface CircularAncestorChartWindowProps {
  treeId: string;
  focusPersonId: string;
  focusPersonLabel?: string;
  /** Optional dependency injection used by isolated previews and tests. */
  client?: FamilyTreeNeighborhoodClient;
  searchFocusPersons?: (
    query: string,
  ) => readonly CircularAncestorFocusResult[];
  onFocusPersonChange?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onClose: () => void;
}

export interface CircularAncestorFocusResult {
  personId: string;
  label: string;
  detail?: string;
}

interface ChartCamera {
  zoom: number;
  x: number;
  y: number;
}

export function CircularAncestorChartWindow({
  treeId,
  focusPersonId,
  focusPersonLabel,
  client: providedClient,
  searchFocusPersons,
  onFocusPersonChange,
  onOpenPerson,
  onClose,
}: CircularAncestorChartWindowProps) {
  const client = useMemo(
    () => providedClient ?? createTrackerNeighborhoodClient(),
    [providedClient],
  );
  const [draftGenerations, setDraftGenerations] = useState(DEFAULT_GENERATIONS);
  const [generations, setGenerations] = useState(DEFAULT_GENERATIONS);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState("circular-ancestor:1");
  const [showAccessibleList, setShowAccessibleList] = useState(false);
  const [focusPickerOpen, setFocusPickerOpen] = useState(false);
  const [focusSearchQuery, setFocusSearchQuery] = useState("");
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [camera, setCamera] = useState<ChartCamera>({ zoom: 1, x: 0, y: 0 });
  const [svgSize, setSvgSize] = useState({ width: 1, height: 1 });
  const chartId = useId().replace(/:/g, "");
  const focusPickerRef = useRef<HTMLDivElement | null>(null);
  const focusSearchInputRef = useRef<HTMLInputElement | null>(null);
  const fullscreenTargetRef = useRef<HTMLDivElement | null>(null);
  const fullscreenPendingRef = useRef(false);
  const lastPointerGestureDraggedRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    cameraX: number;
    cameraY: number;
    occurrenceId?: string;
    moved: boolean;
  } | undefined>(undefined);

  const neighborhood = useFamilyTreeNeighborhood({
    client,
    treeId,
    focusPersonId,
    sessionKey: `circular-ancestors:${focusPersonId}`,
    ancestorDepth: generations,
    descendantDepth: 0,
    collateralDepth: 0,
    maxNodes: MAX_CHART_PERSONS,
  });
  const model = useMemo(
    () => buildCircularAncestorChartModel(
      neighborhood.graph,
      focusPersonId,
      generations,
    ),
    [focusPersonId, generations, neighborhood.graph],
  );
  const selectedOccurrence = model.occurrences.find(
    (occurrence) => occurrence.occurrenceId === selectedOccurrenceId,
  ) ?? model.occurrences[0];
  const currentFocusLabel = model.occurrences[0]?.person.displayName ||
    focusPersonLabel ||
    "Особа";
  const normalizedFocusSearch = focusSearchQuery.trim();
  const focusSearchResults = useMemo(
    () => normalizedFocusSearch && searchFocusPersons
      ? searchFocusPersons(normalizedFocusSearch).slice(0, 12)
      : [],
    [normalizedFocusSearch, searchFocusPersons],
  );
  const selectedPathSlots = useMemo(() => {
    const slots = new Set<number>();
    let slot = selectedOccurrence?.slot ?? 1;
    while (slot >= 1) {
      slots.add(slot);
      if (slot === 1) break;
      slot = Math.floor(slot / 2);
    }
    return slots;
  }, [selectedOccurrence?.slot]);

  const chartRadius = CIRCULAR_ANCESTOR_FOCUS_RADIUS +
    generations * CIRCULAR_ANCESTOR_RING_WIDTH;
  const worldSize = (chartRadius + 38) * 2;
  const viewSize = worldSize / camera.zoom;
  const fitPixelsPerWorld = Math.max(1, Math.min(svgSize.width, svgSize.height)) /
    worldSize;
  const labelZoomRecommendation = useMemo(
    () => recommendCircularAncestorLabelZoom(
      model.occurrences,
      fitPixelsPerWorld,
      {
        targetScreenFontSize: 8,
        maxGeneration: generations,
      },
    ),
    [fitPixelsPerWorld, generations, model.occurrences],
  );
  const readableLabelZoom = Math.min(
    MAX_ZOOM,
    Math.max(1, Math.ceil(labelZoomRecommendation.recommendedZoom * 100) / 100),
  );
  const rawChartWarnings = [
    ...(neighborhood.loading && !neighborhood.graph.persons.length
      ? []
      : model.warnings),
    ...(neighborhood.graph.persons.length >= MAX_CHART_PERSONS ||
    neighborhood.graph.continuations?.some((item) => item.direction === "parents")
      ? ["Діаграма показує завантажену частину великого родоводу. Відомі предки відображені на своїх точних місцях, але за межею серверного ліміту можуть бути ще особи."]
      : []),
    ...(labelZoomRecommendation.recommendedZoom > MAX_ZOOM
      ? ["Окремі дуже вузькі сектори потребують більшого масштабу, ніж дозволяє переглядач. Повні дані лишаються доступними у списку та картці особи."]
      : []),
  ];
  const uniqueChartWarnings = [...new Set(rawChartWarnings)];
  const chartWarnings = uniqueChartWarnings.length > 4
    ? [
        ...uniqueChartWarnings.slice(0, 3),
        `Ще попереджень: ${uniqueChartWarnings.length - 3}.`,
      ]
    : uniqueChartWarnings;
  const fullscreen = nativeFullscreen || fallbackFullscreen;

  function setZoom(nextZoom: number) {
    setCamera((current) => ({
      ...current,
      zoom: Math.min(MAX_ZOOM, Math.max(0.7, nextZoom)),
    }));
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const multiplier = event.deltaY < 0 ? 1.18 : 1 / 1.18;
    setCamera((current) => ({
      ...current,
      zoom: Math.min(MAX_ZOOM, Math.max(0.7, current.zoom * multiplier)),
    }));
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    lastPointerGestureDraggedRef.current = false;
    const occurrenceElement = event.target instanceof Element
      ? event.target.closest<SVGGElement>("[data-occurrence-id]")
      : null;
    event.currentTarget.setPointerCapture(event.pointerId);
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
    const unitsPerPixel = viewSize / Math.max(1, Math.min(bounds.width, bounds.height));
    setCamera((current) => ({
      ...current,
      x: drag.cameraX - deltaX * unitsPerPixel,
      y: drag.cameraY - deltaY * unitsPerPixel,
    }));
  }

  function stopDragging(
    event: ReactPointerEvent<SVGSVGElement>,
    selectOccurrence: boolean,
  ) {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (selectOccurrence && !drag.moved && drag.occurrenceId) {
      setSelectedOccurrenceId(drag.occurrenceId);
    }
  }

  function selectOccurrenceFromClick(occurrenceId: string) {
    if (lastPointerGestureDraggedRef.current) {
      lastPointerGestureDraggedRef.current = false;
      return;
    }
    setSelectedOccurrenceId(occurrenceId);
  }

  function changeChartFocus(personId: string) {
    setFocusPickerOpen(false);
    setFocusSearchQuery("");
    setSelectedOccurrenceId("circular-ancestor:1");
    if (personId !== focusPersonId) onFocusPersonChange?.(personId);
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
      if (document.fullscreenElement === fullscreenTargetRef.current) {
        await leaveNativeFullscreen();
        return;
      }

      if (fallbackFullscreen) {
        setFallbackFullscreen(false);
        return;
      }

      const target = fullscreenTargetRef.current;
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
    const svg = svgRef.current;
    if (!svg) return undefined;
    const updateSize = () => {
      const rect = svg.getBoundingClientRect();
      setSvgSize((current) =>
        Math.abs(current.width - rect.width) < 0.5 &&
        Math.abs(current.height - rect.height) < 0.5
          ? current
          : { width: rect.width, height: rect.height });
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
    setSelectedOccurrenceId("circular-ancestor:1");
    setFocusPickerOpen(false);
    setFocusSearchQuery("");
  }, [focusPersonId]);

  useEffect(() => {
    if (!focusPickerOpen) return undefined;
    focusSearchInputRef.current?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !focusPickerRef.current?.contains(event.target)
      ) {
        setFocusPickerOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setFocusPickerOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [focusPickerOpen]);

  useEffect(() => {
    const syncFullscreenState = () => {
      const isOwnFullscreen = document.fullscreenElement === fullscreenTargetRef.current;
      setNativeFullscreen(isOwnFullscreen);
      if (isOwnFullscreen) setFallbackFullscreen(false);
    };

    document.addEventListener("fullscreenchange", syncFullscreenState);
    syncFullscreenState();
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    if (!fallbackFullscreen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setFallbackFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fallbackFullscreen]);

  useEffect(() => {
    const target = fullscreenTargetRef.current;
    return () => {
      if (document.fullscreenElement === target && document.exitFullscreen) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  return (
    <Modal
      title="Кругова діаграма прямих предків"
      className="circular-ancestor-modal"
      mode="window"
      fullscreen={fallbackFullscreen}
      onClose={() => void closeWindow()}
    >
      <div ref={fullscreenTargetRef} className="circular-ancestor-window">
        <header className={`circular-ancestor-toolbar ${focusPickerOpen ? "is-focus-picker-open" : ""}`}>
          <div ref={focusPickerRef} className="circular-ancestor-intro">
            <span className="eyebrow">Центральна особа</span>
            {searchFocusPersons && onFocusPersonChange ? (
              <button
                type="button"
                className="circular-ancestor-focus-trigger"
                aria-haspopup="listbox"
                aria-expanded={focusPickerOpen}
                aria-controls={`${chartId}-focus-results`}
                onClick={() => setFocusPickerOpen((current) => !current)}
              >
                <span>{currentFocusLabel}</span>
                <span aria-hidden="true">⌄</span>
              </button>
            ) : (
              <strong>{currentFocusLabel}</strong>
            )}
            <small>Батьківська гілка розміщена ліворуч, материнська — праворуч.</small>
            {focusPickerOpen && searchFocusPersons && onFocusPersonChange ? (
              <div className="circular-ancestor-focus-popover">
                <label>
                  <span>Знайти іншу особу</span>
                  <input
                    ref={focusSearchInputRef}
                    type="search"
                    value={focusSearchQuery}
                    placeholder="Ім’я, прізвище, рік або місце"
                    aria-controls={`${chartId}-focus-results`}
                    onChange={(event) => setFocusSearchQuery(event.target.value)}
                  />
                </label>
                <div
                  id={`${chartId}-focus-results`}
                  className="circular-ancestor-focus-results"
                  role="listbox"
                  aria-label="Результати пошуку центральної особи"
                >
                  {!normalizedFocusSearch ? (
                    <div className="circular-ancestor-focus-empty">Введіть ім’я, рік або місце.</div>
                  ) : focusSearchResults.length ? (
                    focusSearchResults.map((person) => (
                      <button
                        key={person.personId}
                        type="button"
                        role="option"
                        aria-selected={person.personId === focusPersonId}
                        onClick={() => changeChartFocus(person.personId)}
                      >
                        <strong>{person.label}</strong>
                        <small>{person.detail || (person.personId === focusPersonId ? "Поточна центральна особа" : "Без дат")}</small>
                      </button>
                    ))
                  ) : (
                    <div className="circular-ancestor-focus-empty">Збігів не знайдено.</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <label className="circular-ancestor-generation-control">
            <span>Поколінь предків</span>
            <select
              value={draftGenerations}
              onChange={(event) => setDraftGenerations(Number(event.target.value))}
            >
              {Array.from({ length: MAX_GENERATIONS }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={draftGenerations === generations || neighborhood.loading}
            onClick={() => {
              setGenerations(draftGenerations);
              setSelectedOccurrenceId("circular-ancestor:1");
              setCamera({ zoom: 1, x: 0, y: 0 });
            }}
          >
            Побудувати
          </button>
          <div className="circular-ancestor-camera-controls" aria-label="Масштаб діаграми">
            <button type="button" onClick={() => setZoom(camera.zoom / 1.25)} aria-label="Зменшити масштаб">−</button>
            <span>{Math.round(camera.zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom(camera.zoom * 1.25)} aria-label="Збільшити масштаб">+</button>
            <button type="button" onClick={() => setCamera({ zoom: 1, x: 0, y: 0 })}>Вмістити</button>
            <button
              type="button"
              className="circular-ancestor-readable-zoom"
              onClick={() => setCamera((current) => ({
                ...current,
                zoom: readableLabelZoom,
              }))}
              title={`Мінімальний масштаб для всіх повних підписів: ${Math.round(readableLabelZoom * 100)}%`}
            >
              Читати · {Math.round(readableLabelZoom * 100)}%
            </button>
            <button type="button" onClick={() => setCamera((current) => ({ ...current, x: 0, y: 0 }))}>До центру</button>
            <button
              type="button"
              disabled={fullscreenPending}
              aria-pressed={fullscreen}
              aria-label={fullscreen ? "Вийти з повноекранного режиму" : "Розгорнути на весь екран"}
              title={fullscreen ? "Згорнути (Esc)" : "На весь екран"}
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? "Згорнути" : "На весь екран"}
            </button>
          </div>
          <button
            type="button"
            className="button button-secondary circular-ancestor-list-toggle"
            aria-expanded={showAccessibleList}
            onClick={() => setShowAccessibleList((current) => !current)}
          >
            {showAccessibleList ? "Сховати список" : "Доступний список"}
          </button>
        </header>

        <div className="circular-ancestor-status" aria-live="polite">
          {neighborhood.loading
            ? `Завантажуємо ${generations} поколінь…`
            : `Знайдено ${Math.max(0, model.occurrences.length - 1)} позицій предків у ${generations} поколіннях. ` +
              `Читабельний масштаб: ${Math.round(readableLabelZoom * 100)}%. ` +
              "Натисніть на особу в діаграмі, щоб відкрити її дії праворуч."}
        </div>

        {neighborhood.error ? (
          <div className="circular-ancestor-error" role="alert">
            <span>{neighborhood.error.message}</span>
            <button type="button" className="button button-secondary" onClick={neighborhood.reload}>Спробувати ще раз</button>
          </div>
        ) : null}
        {chartWarnings.length ? (
          <div className="circular-ancestor-warning" role="status">
            {chartWarnings.map((warning) => <span key={warning}>{warning}</span>)}
          </div>
        ) : null}

        <div className="circular-ancestor-content">
          <div className="circular-ancestor-canvas-wrap">
            <div className="circular-ancestor-legend" aria-label="Позначення гілок">
              <span><i className="paternal" /> Батьківська гілка</span>
              <span><i className="maternal" /> Материнська гілка</span>
              <span><i className="duplicate" /> Повторний предок</span>
            </div>
            <svg
              ref={svgRef}
              className={`circular-ancestor-chart ${dragRef.current ? "is-dragging" : ""}`}
              viewBox={`${camera.x - viewSize / 2} ${camera.y - viewSize / 2} ${viewSize} ${viewSize}`}
              aria-hidden="true"
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => stopDragging(event, true)}
              onPointerCancel={(event) => stopDragging(event, false)}
            >
              <defs>
                <filter id="circular-ancestor-shadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#173f36" floodOpacity=".18" />
                </filter>
              </defs>
              <g className="circular-ancestor-ring-grid">
                {Array.from({ length: generations }, (_, index) => index + 1).map((generation) => (
                  <circle
                    key={generation}
                    r={CIRCULAR_ANCESTOR_FOCUS_RADIUS + generation * CIRCULAR_ANCESTOR_RING_WIDTH}
                  />
                ))}
                <line x1={0} y1={-chartRadius} x2={0} y2={chartRadius} />
              </g>
              <g>
                {model.occurrences.filter((occurrence) => occurrence.generation > 0).map((occurrence) => (
                  <AncestorSector
                    key={occurrence.occurrenceId}
                    occurrence={occurrence}
                    chartId={chartId}
                    selected={occurrence.occurrenceId === selectedOccurrence?.occurrenceId}
                    highlighted={selectedPathSlots.has(occurrence.slot)}
                    onSelect={() => selectOccurrenceFromClick(occurrence.occurrenceId)}
                  />
                ))}
              </g>
              {model.occurrences[0] ? (
                <FocusAncestorCard
                  occurrence={model.occurrences[0]}
                  chartId={chartId}
                  selected={selectedOccurrence?.slot === 1}
                  onSelect={() => selectOccurrenceFromClick(model.occurrences[0]!.occurrenceId)}
                />
              ) : null}
            </svg>
            {neighborhood.loading && !model.occurrences.length ? (
              <div className="circular-ancestor-loading">Будуємо діаграму…</div>
            ) : null}
          </div>

          <aside className="circular-ancestor-details">
            {selectedOccurrence ? (
              <>
                <span className="eyebrow">{generationLabel(selectedOccurrence.generation)}</span>
                <div className={`circular-ancestor-avatar ${selectedOccurrence.branch}`}>
                  {personInitials(selectedOccurrence.person.displayName)}
                </div>
                <h3>{selectedOccurrence.person.displayName}</h3>
                <p>{formatCircularAncestorLife(selectedOccurrence.person)}</p>
                <dl>
                  <div><dt>Гілка</dt><dd>{branchLabel(selectedOccurrence.branch)}</dd></div>
                  <div><dt>Позиція</dt><dd>№ {selectedOccurrence.slot}</dd></div>
                  {selectedOccurrence.duplicate ? <div><dt>Позначка</dt><dd>Повторний предок</dd></div> : null}
                </dl>
                {onOpenPerson || onFocusPersonChange ? (
                  <div className="circular-ancestor-details-actions">
                    {onOpenPerson ? (
                      <button
                        type="button"
                        className="button"
                        onClick={() => void openPerson(selectedOccurrence.personId)}
                      >
                        Відкрити картку особи
                      </button>
                    ) : null}
                    {onFocusPersonChange && selectedOccurrence.personId !== focusPersonId ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => changeChartFocus(selectedOccurrence.personId)}
                      >
                        Зробити центральною
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p>Дані центральної особи ще завантажуються.</p>
            )}
          </aside>
        </div>

        {showAccessibleList ? (
          <div className="circular-ancestor-accessible-list" aria-label="Прямі предки за поколіннями">
            {Array.from({ length: generations + 1 }, (_, generation) => {
              const occurrences = model.occurrences.filter((item) => item.generation === generation);
              if (!occurrences.length) return null;
              return (
                <section key={generation}>
                  <h3>{generationLabel(generation)}</h3>
                  <div>
                    {occurrences.map((occurrence) => (
                      <button
                        type="button"
                        key={occurrence.occurrenceId}
                        className={occurrence.occurrenceId === selectedOccurrence?.occurrenceId ? "is-selected" : ""}
                        onClick={() => setSelectedOccurrenceId(occurrence.occurrenceId)}
                      >
                        <strong>{occurrence.person.displayName}</strong>
                        <small>{branchLabel(occurrence.branch)} · позиція № {occurrence.slot}</small>
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

function AncestorSector({
  occurrence,
  chartId,
  selected,
  highlighted,
  onSelect,
}: {
  occurrence: CircularAncestorOccurrence;
  chartId: string;
  selected: boolean;
  highlighted: boolean;
  onSelect: () => void;
}) {
  const midAngle = (occurrence.startAngle + occurrence.endAngle) / 2;
  const midRadius = (occurrence.innerRadius + occurrence.outerRadius) / 2;
  const labelPoint = polarPoint(midRadius, midAngle);
  const path = annularSectorPath(
    occurrence.innerRadius,
    occurrence.outerRadius,
    occurrence.startAngle,
    occurrence.endAngle,
  );
  const label = planCircularAncestorLabel(occurrence);
  const idBase = `${chartId}-ancestor-${occurrence.slot}`;
  const clipId = `${idBase}-clip`;
  const namePathId = `${idBase}-name-path`;
  const lifePathId = `${idBase}-life-path`;
  const nameRadius = midRadius - (label.lifeFontSize + label.lineGap) * 0.55;
  const lifeRadius = midRadius + (label.fontSize + label.lineGap) * 0.55;
  const radialRotation = uprightRadialRotation(midAngle);
  const labelPadding = Math.min(
    4,
    Math.max(1.5, (occurrence.outerRadius - occurrence.innerRadius) * 0.08),
  );
  const duplicatePoint = polarPoint(
    occurrence.outerRadius - 5,
    midAngle,
  );
  return (
    <g
      data-occurrence-id={occurrence.occurrenceId}
      className={[
        "circular-ancestor-sector",
        `is-${occurrence.branch}`,
        occurrence.duplicate ? "is-duplicate" : "",
        selected ? "is-selected" : "",
        highlighted ? "is-highlighted" : "",
      ].filter(Boolean).join(" ")}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <title>
        {label.name}, {label.life}, {generationLabel(occurrence.generation)}
      </title>
      <path d={path} />
      {label.mode !== "hidden" ? (
        <>
          <defs>
            <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
              <path d={path} />
            </clipPath>
            {label.mode === "curved" ? (
              <>
                <path
                  id={namePathId}
                  d={curvedLabelPath(
                    nameRadius,
                    occurrence.startAngle,
                    occurrence.endAngle,
                    labelPadding,
                  )}
                />
                <path
                  id={lifePathId}
                  d={curvedLabelPath(
                    lifeRadius,
                    occurrence.startAngle,
                    occurrence.endAngle,
                    labelPadding,
                  )}
                />
              </>
            ) : null}
          </defs>
          <g clipPath={`url(#${clipId})`} className={`circular-ancestor-sector-label is-${label.mode}`}>
            {label.mode === "curved" ? (
              <>
                <text
                  className="circular-ancestor-label-name"
                  style={{ fontSize: label.fontSize }}
                >
                  <textPath href={`#${namePathId}`} startOffset="50%" textAnchor="middle">
                    {label.name}
                  </textPath>
                </text>
                <text
                  className="circular-ancestor-label-life"
                  style={{ fontSize: label.lifeFontSize }}
                >
                  <textPath href={`#${lifePathId}`} startOffset="50%" textAnchor="middle">
                    {label.life}
                  </textPath>
                </text>
              </>
            ) : (
              <text
                className="circular-ancestor-label-radial"
                transform={`translate(${labelPoint.x} ${labelPoint.y}) rotate(${radialRotation})`}
                textAnchor="middle"
                dominantBaseline="central"
              >
                <tspan
                  className="circular-ancestor-label-name"
                  x={0}
                  y={-(label.lifeFontSize + label.lineGap) / 2}
                  style={{ fontSize: label.fontSize }}
                >
                  {label.name}
                </tspan>
                <tspan
                  className="circular-ancestor-label-life"
                  x={0}
                  y={(label.fontSize + label.lineGap) / 2}
                  style={{ fontSize: label.lifeFontSize }}
                >
                  {label.life}
                </tspan>
              </text>
            )}
          </g>
        </>
      ) : null}
      {occurrence.duplicate ? (
        <circle
          className="circular-ancestor-duplicate-mark"
          cx={duplicatePoint.x}
          cy={duplicatePoint.y}
          r={2.8}
        />
      ) : null}
    </g>
  );
}

function FocusAncestorCard({
  occurrence,
  chartId,
  selected,
  onSelect,
}: {
  occurrence: CircularAncestorOccurrence;
  chartId: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = planCircularAncestorLabel(occurrence);
  const clipId = `${chartId}-focus-clip`;
  const namePathId = `${chartId}-focus-name-path`;
  const lifePathId = `${chartId}-focus-life-path`;
  const namePathRadius = 54;
  const lifePathRadius = 50;
  const pathCapacity = Math.PI * 50;
  const focusFitScale = Math.min(
    1,
    pathCapacity / Math.max(1e-6, label.requiredLength),
  );
  return (
    <g
      data-occurrence-id={occurrence.occurrenceId}
      className={`circular-ancestor-focus ${selected ? "is-selected" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <title>{label.name}, {label.life}, центральна особа</title>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <circle r={62} />
        </clipPath>
        <path
          id={namePathId}
          d={`M ${-namePathRadius} 0 A ${namePathRadius} ${namePathRadius} 0 0 1 ${namePathRadius} 0`}
        />
        <path
          id={lifePathId}
          d={`M ${-lifePathRadius} 0 A ${lifePathRadius} ${lifePathRadius} 0 0 0 ${lifePathRadius} 0`}
        />
      </defs>
      <circle r={64} filter="url(#circular-ancestor-shadow)" />
      <g clipPath={`url(#${clipId})`} className="circular-ancestor-focus-label">
        <text
          className="circular-ancestor-label-name"
          style={{ fontSize: label.fontSize * focusFitScale }}
        >
          <textPath href={`#${namePathId}`} startOffset="50%" textAnchor="middle">
            {label.name}
          </textPath>
        </text>
        <text
          className="circular-ancestor-label-life"
          style={{ fontSize: label.lifeFontSize * focusFitScale }}
        >
          <textPath href={`#${lifePathId}`} startOffset="50%" textAnchor="middle">
            {label.life}
          </textPath>
        </text>
      </g>
      <text
        className="circular-ancestor-focus-initials"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fontSize: 22 }}
      >
        {personInitials(label.name)}
      </text>
    </g>
  );
}

function curvedLabelPath(
  radius: number,
  startAngle: number,
  endAngle: number,
  labelPadding: number,
): string {
  const sectorGap = sectorAngleGapDegrees(startAngle, endAngle);
  const textPadding = labelPadding / Math.max(1, radius) * 180 / Math.PI;
  const start = startAngle + sectorGap + textPadding;
  const end = endAngle - sectorGap - textPadding;
  const midAngle = (startAngle + endAngle) / 2;
  const tangentRotation = normalizeAngle(90 - midAngle);
  const reverse = tangentRotation > 90 && tangentRotation < 270;
  const from = polarPoint(radius, reverse ? end : start);
  const to = polarPoint(radius, reverse ? start : end);
  const span = Math.max(0, end - start);
  const largeArc = span > 180 ? 1 : 0;
  return [
    `M ${from.x} ${from.y}`,
    `A ${radius} ${radius} 0 ${largeArc} ${reverse ? 1 : 0} ${to.x} ${to.y}`,
  ].join(" ");
}

function uprightRadialRotation(midAngle: number): number {
  const rotation = 180 - midAngle;
  const normalized = normalizeAngle(rotation);
  return rotation + (normalized > 90 && normalized < 270 ? 180 : 0);
}

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function polarPoint(radius: number, angle: number): { x: number; y: number } {
  const radians = angle * Math.PI / 180;
  // Mirror the mathematical x-axis so the Ahnentafel father half is always
  // on the left and the mother half is always on the right.
  return { x: -radius * Math.cos(radians), y: radius * Math.sin(radians) };
}

function annularSectorPath(
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const angleGap = sectorAngleGapDegrees(startAngle, endAngle);
  const start = startAngle + angleGap;
  const end = endAngle - angleGap;
  const outerStart = polarPoint(outerRadius - 1, start);
  const outerEnd = polarPoint(outerRadius - 1, end);
  const innerEnd = polarPoint(innerRadius + 1, end);
  const innerStart = polarPoint(innerRadius + 1, start);
  const largeArc = end - start > 180 ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius - 1} ${outerRadius - 1} 0 ${largeArc} 0 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius + 1} ${innerRadius + 1} 0 ${largeArc} 1 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function sectorAngleGapDegrees(startAngle: number, endAngle: number): number {
  return Math.min(
    0.65,
    Math.max(0.003, Math.abs(endAngle - startAngle) * 0.055),
  );
}

function personInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("uk-UA") ?? "")
    .join("") || "?";
}

function branchLabel(branch: CircularAncestorOccurrence["branch"]): string {
  if (branch === "paternal") return "Батьківська";
  if (branch === "maternal") return "Материнська";
  return "Центральна особа";
}

function generationLabel(generation: number): string {
  if (generation === 0) return "Центральна особа";
  return `${generation} покоління предків`;
}
