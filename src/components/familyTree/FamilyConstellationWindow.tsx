import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Modal } from "../Modal";
import { AncestorChartColorControls } from "./AncestorChartColorControls.tsx";
import { StarryAnimationToggle } from "./StarryBackgroundToggle.tsx";
import { createTrackerNeighborhoodClient } from "../../services/familyTreeNeighborhoodService.ts";
import type { FamilyTreeNeighborhoodClient } from "../../features/family-tree-view/data/neighborhoodClient.ts";
import { useFamilyTreeNeighborhood } from "../../features/family-tree-view/react/useFamilyTreeNeighborhood.ts";
import { useTreeCamera } from "../../features/family-tree-view/react/useTreeCamera.ts";
import { applyFamilyTreeNameDisplay, type FamilyTreeNameProfile } from "../../features/family-tree-view/adapters/familyTreeNameDisplay.ts";
import { familyTreeChartColorCssVariables, resolveFamilyTreeChartColorScheme } from "../../features/family-tree-view/appearance/familyTreeChartColorScheme.ts";
import { DEFAULT_FAMILY_TREE_APPEARANCE, normalizeFamilyTreeAppearance, type FamilyTreeAppearancePreferences } from "../../utils/familyTreeAppearance.ts";
import { TRACKER_RODU_CHART_BRAND_NAME, TRACKER_RODU_CHART_LOGO_URL } from "../../features/family-tree-view/export/familyTreeChartBrand.ts";
import { MAX_CONSTELLATION_PERSONS, constellationLife, type ConstellationNode } from "../../features/family-tree-view/constellation/constellationModel.ts";
import { CONSTELLATION_ROLE_LABELS, constellationHitTest, constellationLabels, constellationTone } from "../../features/family-tree-view/constellation/constellationPresentation.ts";
import { useConstellationScene } from "../../features/family-tree-view/constellation/useConstellationScene.ts";
import { ConstellationCanvas } from "../../features/family-tree-view/constellation/ConstellationCanvas.tsx";
import { buildConstellationTimeModel, projectConstellationTime, constellationTimeEdgeLabel, CONSTELLATION_LIFE_LABELS, type ConstellationTimeProfile } from "../../features/family-tree-view/constellation/constellationTime.ts";
import { ConstellationTimeControls, ConstellationTimeDetails } from "../../features/family-tree-view/constellation/ConstellationTimeControls.tsx";
import { buildConstellationPlacesModel, buildConstellationPlacesScene, constellationPlaceHitTest, constellationPlaceLabels, constellationPeopleCount, constellationRecordCount, constellationVisiblePlaceLinks } from "../../features/family-tree-view/constellation/constellationPlaces.ts";
import { ConstellationPlacesCanvas } from "../../features/family-tree-view/constellation/ConstellationPlacesCanvas.tsx";
import { ConstellationPlacesControls, ConstellationPlacesDetails } from "../../features/family-tree-view/constellation/ConstellationPlacesPanels.tsx";
import { buildConstellationTour, constellationThemeColors, type ConstellationTheme, type ConstellationMode } from "../../features/family-tree-view/constellation/constellationCinema.ts";
import { ConstellationStarfield, useConstellationMotionEnvironment } from "../../features/family-tree-view/constellation/ConstellationStarfield.tsx";
import { useConstellationFlight } from "../../features/family-tree-view/constellation/useConstellationFlight.ts";
import { useConstellationFullscreen } from "../../features/family-tree-view/constellation/useConstellationFullscreen.ts";
import { ConstellationPresentationControls } from "../../features/family-tree-view/constellation/ConstellationPresentationControls.tsx";
import { exportConstellationFrame } from "../../features/family-tree-view/constellation/constellationFrameExport.ts";
import type { CameraState } from "../../features/family-tree-view/types.ts";
import "../../features/family-tree-view/constellation/constellation.css";

interface FocusResult { personId: string; label: string; detail?: string }
interface Props {
  treeId: string;
  focusPersonId: string;
  appearancePreferences?: FamilyTreeAppearancePreferences;
  nameProfiles?: readonly FamilyTreeNameProfile[];
  timeProfiles?: readonly ConstellationTimeProfile[];
  /** Test/preview injection uses the same permission-scoped loader contract. */
  client?: FamilyTreeNeighborhoodClient;
  searchFocusPersons?: (query: string) => readonly FocusResult[];
  onFocusPersonChange?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onClose: () => void;
}

const EMPTY_PROFILES: readonly FamilyTreeNameProfile[] = [];
const EMPTY_TIME_PROFILES: readonly ConstellationTimeProfile[] = [];
const INITIAL_DEPTHS = { ancestors: 4, descendants: 2, relatives: true };
// Dense relationship graphs need a wider overview range than large tree cards.
const CONSTELLATION_ZOOM_LIMITS = { min: 0.0001, max: 4 };

export function FamilyConstellationWindow({ treeId, focusPersonId, appearancePreferences,
  nameProfiles = EMPTY_PROFILES, timeProfiles = EMPTY_TIME_PROFILES, client: providedClient, searchFocusPersons,
  onFocusPersonChange, onOpenPerson, onClose }: Props) {
  const client = useMemo(() => providedClient ?? createTrackerNeighborhoodClient(), [providedClient]);
  const inheritedAppearance = useMemo(() => normalizeFamilyTreeAppearance(appearancePreferences ?? DEFAULT_FAMILY_TREE_APPEARANCE), [appearancePreferences]);
  const [localAppearance, setLocalAppearance] = useState<FamilyTreeAppearancePreferences>();
  const appearance = localAppearance ?? inheritedAppearance;
  const [theme, setTheme] = useState<ConstellationTheme>("night");
  const colors = useMemo(() => constellationThemeColors(resolveFamilyTreeChartColorScheme(appearance), theme), [appearance, theme]);
  const [depths, setDepths] = useState(INITIAL_DEPTHS);
  const [draftDepths, setDraftDepths] = useState(INITIAL_DEPTHS);
  const windowRef = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const fullscreen = useConstellationFullscreen(windowRef, () => {
    if (presentationBefore.current) finishPresentation(false);
    else fullscreenButton.current?.focus({ preventScroll: true });
  });
  const [textured, setTextured] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const [mode, setMode] = useState<ConstellationMode>("family");
  const [starsMoving, setStarsMoving] = useState(appearancePreferences?.starryAnimation ?? true);
  const motion = useConstellationMotionEnvironment();
  const [presenting, setPresenting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [tourIndex, setTourIndex] = useState(0);
  const [flightTrigger, setFlightTrigger] = useState(0);
  const [tourSeconds, setTourSeconds] = useState(7);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const presentationBefore = useRef<{ camera: CameraState; fullscreen: boolean; selectedId: string; selectedPlaceId?: string; year: number } | undefined>(undefined);
  const presentationButton = useRef<HTMLButtonElement>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>();
  const [pinnedPlaceId, setPinnedPlaceId] = useState<string>();
  const [placesOnlyPerson, setPlacesOnlyPerson] = useState(false);
  const [showOtherTransitions, setShowOtherTransitions] = useState(false);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const currentYear = new Date().getFullYear();
  const [selectedId, setSelectedId] = useState(focusPersonId);
  const [query, setQuery] = useState("");
  const [listQuery, setListQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [listLimit, setListLimit] = useState(60);
  const searchId = useId();
  const instructionsId = useId();
  const sidebarId = useId();
  const sidebarRef = useRef<HTMLElement>(null);
  const neighborhood = useFamilyTreeNeighborhood({ client, treeId, focusPersonId,
    sessionKey: "constellation", structuralOnly: true, ancestorDepth: depths.ancestors,
    descendantDepth: depths.descendants, collateralDepth: depths.relatives ? 1 : 0,
    maxNodes: MAX_CONSTELLATION_PERSONS });
  const graph = useMemo(() => applyFamilyTreeNameDisplay(neighborhood.graph, inheritedAppearance, nameProfiles), [neighborhood.graph, inheritedAppearance, nameProfiles]);
  const layout = useConstellationScene(graph, focusPersonId);
  const scene = neighborhood.loading || neighborhood.error ? undefined : layout.scene;
  const timeModel = useMemo(() => buildConstellationTimeModel(scene, graph, timeProfiles, currentYear), [scene, graph, timeProfiles, currentYear]);
  const selectedYear = timeModel.range ? Math.max(timeModel.range.min, Math.min(timeModel.range.max, year)) : year;
  const timeSlice = useMemo(() => mode === "time" ? projectConstellationTime(timeModel, selectedYear) : undefined, [timeModel, selectedYear, mode]);
  const busy = neighborhood.loading || layout.loading;
  const error = neighborhood.error ? "Не вдалося завантажити родинні зв’язки. Перевірте з’єднання та повторіть спробу." : layout.error;
  const camera = useTreeCamera(undefined, CONSTELLATION_ZOOM_LIMITS);
  const flight = useConstellationFlight(camera);
  const fittedScene = useRef<{ space: "family" | "places"; scene: object } | undefined>(undefined);
  const savedCameras = useRef<Partial<Record<"family" | "places", { scene: object; camera: CameraState }>>>({});
  const pendingPlace = useRef<string | undefined>(undefined);
  const pointerStarts = useRef(new Map<number, { x: number; y: number; personId?: string; placeId?: string }>());
  const pointerMoved = useRef(false);
  const selected = scene?.nodes.find(node => node.id === selectedId) ?? scene?.nodes.find(node => node.id === focusPersonId);
  const placesModel = useMemo(() => buildConstellationPlacesModel(timeModel), [timeModel]);
  const placesFilterPersonId = placesOnlyPerson ? selected?.id ?? focusPersonId : undefined;
  const placesScene = useMemo(() => buildConstellationPlacesScene(placesModel, placesFilterPersonId, pinnedPlaceId), [placesModel, placesFilterPersonId, pinnedPlaceId]);
  const selectedPlace = placesScene.nodes.find(node => node.id === selectedPlaceId)?.place ?? placesScene.nodes[0]?.place;
  const placeLinks = useMemo(() => constellationVisiblePlaceLinks(placesScene, selected?.id ?? focusPersonId, showOtherTransitions && !placesOnlyPerson), [placesScene, selected?.id, focusPersonId, showOtherTransitions, placesOnlyPerson]);
  const activeScene = mode === "places" ? placesScene : scene;
  const tour = useMemo(() => buildConstellationTour(mode, scene, timeModel, placesScene), [mode, scene, timeModel, placesScene]);
  const tourStep = tour.steps[tourIndex];
  const manualPresentation = presenting && !playing && (mode === "places" ? selectedPlace?.id !== tourStep?.placeId : selected?.id !== tourStep?.personId);
  const presentationStep = manualPresentation ? mode === "places" && selectedPlace ? { id: selectedPlace.id, x: 0, y: 0,
    title: selectedPlace.label, detail: `${constellationPeopleCount(selectedPlace.personIds.length)} · ${constellationRecordCount(selectedPlace.events.length)} подій. Схема згадок, не географічна мапа.` }
    : selected ? { id: selected.id, x: selected.x, y: selected.y, title: selected.person.displayName,
      detail: [mode === "time" ? `Час · ${selectedYear}` : CONSTELLATION_ROLE_LABELS[selected.role], constellationLife(selected.person)].filter(Boolean).join(" · ") } : tourStep : tourStep;
  const placeLabels = useMemo(() => mode === "places" && showNames ? constellationPlaceLabels(placesScene, camera.camera, camera.viewportSize, selectedPlace?.id) : [], [mode, showNames, placesScene, camera.camera, camera.viewportSize, selectedPlace?.id]);
  const personColors = useMemo(() => new Map(scene?.nodes.map(node => [node.id, constellationTone(node, colors).stroke]) ?? []), [scene, colors]);
  const selectedPath = selected && scene?.paths[selected.id];
  const nodesById = useMemo(() => new Map(scene?.nodes.map(node => [node.id, node]) ?? []), [scene]);
  const edgesById = useMemo(() => new Map(scene?.edges.map(edge => [edge.id, edge]) ?? []), [scene]);
  const labels = useMemo(() => scene && showNames ? constellationLabels(scene, camera.camera, camera.viewportSize, selected?.id ?? focusPersonId) : [], [scene, showNames, camera.camera, camera.viewportSize, selected?.id, focusPersonId]);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("uk");
    if (!normalized) return [];
    const local: FocusResult[] = (scene?.nodes ?? []).filter(node => `${node.person.displayName} ${constellationLife(node.person)}`.toLocaleLowerCase("uk").includes(normalized))
      .map(node => ({ personId: node.id, label: node.person.displayName, detail: constellationLife(node.person) }));
    // Prefer the rendered (possibly privacy-masked) name over profile search data.
    const combined = new Map(local.map(result => [result.personId, result]));
    for (const result of searchFocusPersons?.(query) ?? []) {
      if (combined.has(result.personId)) continue;
      const node = scene?.nodes.find(candidate => candidate.id === result.personId);
      if (node?.person.isPrivate) continue;
      combined.set(result.personId, node ? { personId: node.id, label: node.person.displayName, detail: constellationLife(node.person) } : result);
    }
    return [...combined.values()].slice(0, 12);
  }, [query, scene, searchFocusPersons]);
  const listedNodes = useMemo(() => (scene?.nodes ?? []).filter(node => node.person.displayName.toLocaleLowerCase("uk").includes(listQuery.trim().toLocaleLowerCase("uk")))
    .sort((a, b) => a.distance - b.distance || a.person.displayName.localeCompare(b.person.displayName, "uk")), [scene, listQuery]);
  const depthChanged = depths.ancestors !== draftDepths.ancestors || depths.descendants !== draftDepths.descendants || depths.relatives !== draftDepths.relatives;

  useEffect(() => { setSelectedId(focusPersonId); setQuery(""); setSelectedPlaceId(undefined); setPinnedPlaceId(undefined); pendingPlace.current = undefined; }, [focusPersonId, treeId]);
  useEffect(() => {
    const space = mode === "places" ? "places" : "family";
    if (presenting || !activeScene?.nodes.length || camera.viewportSize.width <= 1 || camera.viewportSize.height <= 1 || (fittedScene.current?.scene === activeScene && fittedScene.current.space === space)) return;
    fittedScene.current = { scene: activeScene, space };
    const pending = space === "places" && pendingPlace.current ? placesScene.nodes.find(node => node.id === pendingPlace.current) : undefined;
    const saved = savedCameras.current[space];
    if (pending) {
      pendingPlace.current = undefined;
      camera.compensateWorldShift({ x: pending.x - camera.camera.x, y: pending.y - camera.camera.y });
      if (camera.camera.zoom < 0.7) camera.zoomBy(0.7 / camera.camera.zoom);
    } else if (saved?.scene === activeScene) {
      camera.compensateWorldShift({ x: saved.camera.x - camera.camera.x, y: saved.camera.y - camera.camera.y });
      camera.zoomBy(saved.camera.zoom / camera.camera.zoom);
    } else camera.fitBounds(activeScene.bounds, 42);
  }, [activeScene, mode, placesScene, camera.fitBounds, camera.viewportSize, camera.camera, camera.compensateWorldShift, camera.zoomBy, presenting]);

  const pausePresentation = () => { setPlaying(false); flight.cancel(); };
  const finishPresentation = (restoreFullscreen = true) => {
    pausePresentation(); setPresenting(false); setExportMessage("");
    const before = presentationBefore.current;
    presentationBefore.current = undefined;
    if (before) {
      setSelectedId(before.selectedId); setSelectedPlaceId(before.selectedPlaceId); setYear(before.year);
      flight.fly(before.camera, false);
    }
    if (!restoreFullscreen || !before?.fullscreen) void fullscreen.exit();
    requestAnimationFrame(() => presentationButton.current?.focus({ preventScroll: true }));
  };
  const startPresentation = () => {
    if (!tour.steps.length) return;
    presentationBefore.current = { camera: { ...camera.camera }, fullscreen: fullscreen.active, selectedId, selectedPlaceId, year };
    setTourIndex(0); setPresenting(true); setPlaying(!motion.reducedMotion); setExportMessage("");
    void fullscreen.enter();
    requestAnimationFrame(() => camera.containerRef.current?.focus({ preventScroll: true }));
  };
  const nextTourStep = (delta: number) => { pausePresentation(); setExportMessage(""); setTourIndex(index => Math.max(0, Math.min(tour.steps.length - 1, index + delta))); };
  const toggleTour = () => {
    setExportMessage("");
    if (playing) pausePresentation();
    else { if (tourIndex >= tour.steps.length - 1) setTourIndex(0); setFlightTrigger(value => value + 1); setPlaying(true); }
  };
  useEffect(() => {
    if (!presenting || !tourStep) return;
    if (tourStep.personId) setSelectedId(tourStep.personId);
    if (tourStep.placeId) setSelectedPlaceId(tourStep.placeId);
    if (tourStep.year !== undefined) setYear(tourStep.year);
    const zoom = mode === "places" ? 0.85 : camera.viewportSize.width < 500 ? 0.7 : 1.05;
    // Leave room above the map center; the story and transport controls live below the canvas.
    flight.fly({ x: tourStep.x, y: tourStep.y + 25 / zoom, zoom }, !motion.reducedMotion && motion.visible);
    return flight.cancel;
  }, [presenting, tourStep, flightTrigger, mode, motion.reducedMotion, flight.fly, flight.cancel]);
  useEffect(() => {
    if (!presenting || !playing || !motion.visible) return;
    const timer = window.setTimeout(() => {
      if (tourIndex >= tour.steps.length - 1) setPlaying(false);
      else setTourIndex(index => index + 1);
    }, tourSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [presenting, playing, motion.visible, tourIndex, tour.steps.length, tourSeconds]);
  useEffect(() => { if (!motion.visible || motion.reducedMotion) { setPlaying(false); flight.cancel(); } }, [motion.visible, motion.reducedMotion, flight.cancel]);
  useEffect(() => {
    setPlaying(false); setPresenting(false); flight.cancel();
    const before = presentationBefore.current;
    presentationBefore.current = undefined;
    if (before && !before.fullscreen) void fullscreen.exit();
  }, [treeId, focusPersonId, flight.cancel, fullscreen.exit]);
  useEffect(() => {
    if (presenting && !tour.steps.length) {
      finishPresentation();
    }
  }, [presenting, tour.steps.length, flight.cancel]);

  const toggleFullscreen = () => {
    if (fullscreen.active) void fullscreen.exit();
    else void fullscreen.enter();
  };
  const closeWindow = async () => { await fullscreen.exit(); onClose(); };
  const openPerson = async (personId: string) => { await fullscreen.exit(); onClose(); onOpenPerson?.(personId); };
  useEffect(() => {
    if (!fullscreen.active && !presenting) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const dialog = windowRef.current?.closest(".constellation-modal");
      if (!dialog?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation();
      if (presenting) finishPresentation(false);
      else { void fullscreen.exit(); fullscreenButton.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [fullscreen.active, fullscreen.exit, presenting]);

  const saveFrame = async () => {
    const viewport = camera.containerRef.current; if (!viewport) return;
    pausePresentation(); setExporting(true); setExportMessage("");
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await exportConstellationFrame(viewport, colors, presentationStep?.title ?? "Сузір’я роду", presentationStep?.detail ?? "Поточне завантажене оточення");
      setExportMessage("PNG збережено: поточний кадр із назвою та логотипом Трекера Роду.");
    } catch (error) { setExportMessage(error instanceof Error ? error.message : "Не вдалося зберегти кадр. Спробуйте ще раз."); }
    finally { setExporting(false); }
  };

  const changeMode = (next: typeof mode) => {
    pausePresentation();
    const space = mode === "places" ? "places" : "family";
    if (activeScene) savedCameras.current[space] = { scene: activeScene, camera: { ...camera.camera } };
    setMode(next);
  };
  const showMapOnMobile = () => {
    if (window.matchMedia("(max-width: 650px), (max-height: 520px)").matches) camera.containerRef.current?.scrollIntoView({ block: "center" });
  };
  const choosePlace = (id: string, personId = selected?.id ?? focusPersonId) => {
    const place = placesModel.places.get(id); if (!place) return;
    setSelectedPlaceId(id);
    if (placesOnlyPerson && !place.personIds.includes(personId)) setPlacesOnlyPerson(false);
    const node = placesScene.nodes.find(node => node.id === id);
    if (node) {
      camera.compensateWorldShift({ x: node.x - camera.camera.x, y: node.y - camera.camera.y });
      if (camera.camera.zoom < 0.7) camera.zoomBy(0.7 / camera.camera.zoom);
    } else { pendingPlace.current = id; setPinnedPlaceId(id); }
    showMapOnMobile();
  };

  const centerPerson = (node: ConstellationNode, readable = false) => {
    setSelectedId(node.id);
    if (mode === "places") {
      const placeId = placesModel.journeys.get(node.id)?.observations[0]?.placeId;
      if (placeId) choosePlace(placeId, node.id);
      return;
    }
    camera.compensateWorldShift({ x: node.x - camera.camera.x, y: node.y - camera.camera.y });
    const readingZoom = camera.viewportSize.width < 500 ? 0.65 : 0.9;
    if (readable && camera.camera.zoom < readingZoom) camera.zoomBy(readingZoom / camera.camera.zoom);
    showMapOnMobile();
  };
  const chooseResult = (result: FocusResult) => {
    const node = nodesById.get(result.personId);
    if (node) centerPerson(node, true);
    else onFocusPersonChange?.(result.personId);
    setQuery("");
  };
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, canceled = false) => {
    const start = pointerStarts.current.get(event.pointerId);
    const clicked = !canceled && start && !pointerMoved.current && pointerStarts.current.size === 1;
    pointerStarts.current.delete(event.pointerId);
    camera.onPointerUp(event);
    if (!clicked || !scene) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (mode === "places") {
      const placeId = start.placeId ?? constellationPlaceHitTest(placesScene, camera.camera, camera.viewportSize, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      if (placeId) setSelectedPlaceId(placeId);
      return;
    }
    const personId = start.personId ?? constellationHitTest(scene, camera.camera, camera.viewportSize, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (personId) setSelectedId(personId);
  };

  return <Modal title="Сузір’я роду" onClose={() => void closeWindow()} className={`constellation-modal constellation-theme-${theme}${presenting ? " constellation-modal-presenting" : ""}`} mode="window" viewportBounded minimizable={false} fullscreen={fullscreen.active}
    headerActions={<button ref={fullscreenButton} type="button" className="constellation-fullscreen-toggle" disabled={fullscreen.pending}
      aria-label={fullscreen.active ? "Вийти з повного екрана" : "На весь екран"} aria-pressed={fullscreen.active}
      title={fullscreen.active ? "Вийти з повного екрана (Esc)" : "Розгорнути сузір’я на весь екран"} onClick={toggleFullscreen}>
      <span aria-hidden="true">⛶</span><span className="constellation-fullscreen-label">{fullscreen.active ? "Вийти з повного екрана" : "На весь екран"}</span>
    </button>}>
    <div ref={windowRef} className={`constellation-window${presenting ? " is-presenting" : ""}`} style={familyTreeChartColorCssVariables(colors) as CSSProperties}
      onKeyDownCapture={event => {
        if (!presenting) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishPresentation(false); }
        else if (event.target instanceof Element && event.target.matches("input, select, textarea")) return;
        else if (event.key === " " && event.target instanceof Element && !event.target.closest("button")) { event.preventDefault(); event.stopPropagation(); toggleTour(); }
        else if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); nextTourStep(event.key === "ArrowLeft" ? -1 : 1); }
      }}>
      <div className="constellation-toolbar">
        <div className="constellation-modes" role="group" aria-label="Режим сузір’я">
          <button type="button" aria-pressed={mode === "family"} onClick={() => changeMode("family")}>Рід</button>
          <button type="button" aria-pressed={mode === "time"} onClick={() => changeMode("time")}>Час</button>
          <button type="button" aria-pressed={mode === "places"} onClick={() => changeMode("places")}>Місця</button>
        </div>
        <div className="constellation-search">
          <label htmlFor={searchId}>Знайти особу</label>
          <input id={searchId} type="search" value={query} autoComplete="off" placeholder="Ім’я, прізвище або рік…"
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === "Escape") { event.stopPropagation(); setQuery(""); }
              if (event.key === "Enter" && results[0]) { event.preventDefault(); chooseResult(results[0]); }
            }} />
          {query.trim() ? <div className="constellation-search-results" aria-label="Результати пошуку">
            {results.length ? results.map(result => <button type="button" key={result.personId} disabled={!nodesById.has(result.personId) && !onFocusPersonChange} onClick={() => chooseResult(result)}>
              <strong>{result.label}</strong><small>{result.detail || (nodesById.has(result.personId) ? "Показати на мапі" : "Побудувати навколо цієї особи")}</small>
            </button>) : <p>Осіб не знайдено.</p>}
          </div> : null}
        </div>
        <div className="constellation-controls" aria-label="Керування мапою">
          <div className="constellation-zoom">
            <button type="button" aria-label="Зменшити масштаб" onClick={() => camera.zoomBy(1 / 1.25)}>−</button>
            <output aria-label="Масштаб">{camera.camera.zoom < 0.01 ? (camera.camera.zoom * 100).toFixed(2) : Math.round(camera.camera.zoom * 100)}%</output>
            <button type="button" aria-label="Збільшити масштаб" onClick={() => camera.zoomBy(1.25)}>+</button>
          </div>
          <button type="button" disabled={!activeScene?.nodes.length} onClick={() => activeScene && camera.fitBounds(activeScene.bounds, 42)}>Вмістити</button>
          <button type="button" disabled={mode === "places" ? !selectedPlace : !selected} onClick={() => mode === "places" ? selectedPlace && choosePlace(selectedPlace.id) : selected && centerPerson(selected, true)}>{mode === "places" ? "Читати назви" : "Читати імена"}</button>
        </div>
        <StarryAnimationToggle enabled={starsMoving} skyEnabled={textured} onChange={setStarsMoving} />
        <details className="constellation-options">
          <summary>Параметри</summary>
          <div className="constellation-options-panel">
            <strong>Обсяг сузір’я</strong>
            <p>Показуємо зв’язки навколо центральної особи, до {MAX_CONSTELLATION_PERSONS} осіб за раз.</p>
            <div className="constellation-depths">
              <label>Поколінь предків<select aria-label="Поколінь предків" value={draftDepths.ancestors} onChange={event => setDraftDepths(value => ({ ...value, ancestors: Number(event.target.value) }))}>
                {Array.from({ length: 13 }, (_, index) => <option key={index} value={index}>{index}</option>)}
              </select></label>
              <label>Поколінь нащадків<select aria-label="Поколінь нащадків" value={draftDepths.descendants} onChange={event => setDraftDepths(value => ({ ...value, descendants: Number(event.target.value) }))}>
                {Array.from({ length: 7 }, (_, index) => <option key={index} value={index}>{index}</option>)}
              </select></label>
            </div>
            <label className="constellation-check"><input type="checkbox" checked={draftDepths.relatives} onChange={event => setDraftDepths(value => ({ ...value, relatives: event.target.checked }))} />Бічні родинні гілки</label>
            <button type="button" disabled={busy || !depthChanged} onClick={() => setDepths({ ...draftDepths })}>Побудувати</button>
            <hr />
            <strong>Оформлення</strong>
            <div className="constellation-modes" role="group" aria-label="Тема сузір’я">
              <button type="button" aria-pressed={theme === "night"} onClick={() => setTheme("night")}>Нічне небо</button>
              <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Світла</button>
            </div>
            <label className="constellation-check"><input type="checkbox" checked={showNames} onChange={event => setShowNames(event.target.checked)} />{mode === "places" ? "Показувати назви місць" : "Показувати імена на мапі"}</label>
            <label className="constellation-check"><input type="checkbox" checked={textured} onChange={event => setTextured(event.target.checked)} />Зоряне тло</label>
            <label className="constellation-check"><input type="checkbox" checked={starsMoving && !motion.reducedMotion} disabled={motion.reducedMotion || !textured} onChange={event => setStarsMoving(event.target.checked)} />Рух зірок і комет</label>
            <small>{motion.reducedMotion ? "Система просить зменшити рух: анімацію вимкнено." : "Плавний рух зірок і рідкісні комети з випадковими напрямками, кольорами та паузами. Без спалахів; у прихованій вкладці рух зупиняється."} Кольори гілок походять із налаштувань дерева; нічна тема підсилює їх для темного тла.</small>
          </div>
        </details>
        <AncestorChartColorControls appearance={appearance} inheritedAppearance={inheritedAppearance} dirty={!!localAppearance}
          onChange={setLocalAppearance} onReset={() => setLocalAppearance(undefined)} />
        <button ref={presentationButton} type="button" className="constellation-launch" disabled={busy || !tour.steps.length || fullscreen.pending} onClick={startPresentation}>▶ Презентація</button>
        {fullscreen.message ? <p className="constellation-fullscreen-message" role="status">{fullscreen.message}</p> : null}
      </div>
      {timeSlice ? <ConstellationTimeControls model={timeModel} slice={timeSlice} onYearChange={setYear} /> : null}
      {mode === "places" ? <ConstellationPlacesControls model={placesModel} onlyPerson={placesOnlyPerson} showAllLinks={showOtherTransitions}
        onOnlyPersonChange={setPlacesOnlyPerson} onShowAllLinksChange={setShowOtherTransitions} onSelectPlace={choosePlace} /> : null}
      <div className="constellation-body">
        <div className="constellation-map-area">
          <div className="constellation-mobile-person">
            <button type="button" disabled={mode === "places" ? !selectedPlace : !selected} aria-label={mode === "places" ? "Відомості про вибране місце" : "Відомості про вибрану особу"} aria-controls={sidebarId} onClick={() => {
              sidebarRef.current?.scrollIntoView({ block: "start" });
              sidebarRef.current?.focus({ preventScroll: true });
            }}><span>{mode === "places" ? selectedPlace?.label ?? "Виберіть місце" : selected?.person.displayName ?? "Виберіть особу"}</span><strong>Відомості ↓</strong></button>
          </div>
          <div ref={camera.containerRef} className={`constellation-viewport${textured ? " constellation-viewport-textured" : ""}`}
            role="region" aria-label={mode === "places" ? "Інтерактивна схема місць роду" : "Інтерактивна мапа родинних зв’язків"} aria-describedby={instructionsId} aria-busy={busy} tabIndex={0}
            onPointerDown={event => {
              if (event.button !== 0) return;
              pausePresentation();
              if (!pointerStarts.current.size) pointerMoved.current = false;
              else pointerMoved.current = true;
              const personId = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-person-id]")?.dataset.personId : undefined;
              const placeId = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-place-id]")?.dataset.placeId : undefined;
              pointerStarts.current.set(event.pointerId, { x: event.clientX, y: event.clientY, personId, placeId });
              camera.onPointerDown(event);
            }}
            onPointerMove={event => {
              const start = pointerStarts.current.get(event.pointerId);
              if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) pointerMoved.current = true;
              camera.onPointerMove(event);
            }}
            onPointerUp={event => finishPointer(event)} onPointerCancel={event => finishPointer(event, true)}
            onWheelCapture={pausePresentation}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) return;
              if (["+", "=", "-", "Home", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) pausePresentation();
              if (["+", "=", "-", "Home", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
              if (event.key === "+" || event.key === "=") camera.zoomBy(1.25);
              if (event.key === "-") camera.zoomBy(1 / 1.25);
              if (event.key === "Home" && activeScene) camera.fitBounds(activeScene.bounds, 42);
              const step = 80 / camera.camera.zoom;
              if (event.key.startsWith("Arrow")) camera.compensateWorldShift({ x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 });
            }}>
            <ConstellationStarfield width={camera.viewportSize.width} height={camera.viewportSize.height} theme={theme} enabled={textured}
              moving={starsMoving && motion.visible && !motion.reducedMotion} />
            {mode === "places" ? placesScene.nodes.length ? <>
              <ConstellationPlacesCanvas scene={placesScene} camera={camera.camera} width={camera.viewportSize.width} height={camera.viewportSize.height}
                selectedPlaceId={selectedPlace?.id} selectedPersonId={selected?.id} links={placeLinks.links} colors={colors} textured={false} luminous={theme === "night"} personColors={personColors} />
              <div className="constellation-labels">
                {placeLabels.map(({ node, x, y, width }) => <button type="button" key={node.id} data-place-id={node.id}
                  className={`constellation-person-label constellation-place-label${node.id === selectedPlace?.id ? " is-selected" : ""}`}
                  style={{ left: x, top: y, width, "--constellation-person-stroke": colors.focus.stroke } as CSSProperties}
                  aria-pressed={node.id === selectedPlace?.id} title={`${node.place.label}\n${node.place.personIds.length} осіб · ${node.place.events.length} записів\n${node.place.canonicalId ? "Уточнене місце" : "Неуточнений запис місця"}`}
                  onClick={event => { if (event.detail === 0) setSelectedPlaceId(node.id); }}>
                  <strong>{node.place.label}</strong><small>{constellationPeopleCount(node.place.personIds.length)} · {constellationRecordCount(node.place.events.length)}{node.place.migrationEventCount ? " · ◇" : ""}</small>
                </button>)}
              </div>
              <span className="constellation-map-caption" aria-hidden="true">МІСЦЯ РОДУ · СХЕМА ЗГАДОК, НЕ ГЕОГРАФІЧНА МАПА</span>
            </> : null : scene?.nodes.length ? <>
              <ConstellationCanvas scene={scene} camera={camera.camera} width={camera.viewportSize.width} height={camera.viewportSize.height} selectedId={selected?.id ?? focusPersonId} colors={colors} textured={false} luminous={theme === "night"} timeSlice={timeSlice} />
              <div className="constellation-labels">
                {labels.map(({ node, x, y, width }) => <button type="button" key={node.id} data-person-id={node.id}
                  className={`constellation-person-label${node.id === selected?.id ? " is-selected" : ""}`}
                  style={{ left: x, top: y, width, "--constellation-person-stroke": constellationTone(node, colors).stroke } as CSSProperties}
                  data-time-state={timeSlice?.persons.get(node.id)?.state}
                  aria-pressed={node.id === selected?.id} title={`${node.person.displayName}\n${constellationLife(node.person)}${timeSlice ? `\n${timeSlice.year}: ${CONSTELLATION_LIFE_LABELS[timeSlice.persons.get(node.id)?.state ?? "unknown"]}` : ""}`}
                  onClick={event => { if (event.detail === 0) setSelectedId(node.id); }}>
                  <strong>{node.person.displayName}</strong><small>{timeSlice ? CONSTELLATION_LIFE_LABELS[timeSlice.persons.get(node.id)?.state ?? "unknown"] : constellationLife(node.person)}</small>
                </button>)}
              </div>
              <span className="constellation-map-caption" aria-hidden="true">{timeSlice ? `ЧАС · ${timeSlice.year} · ПОДІЇ ТА ПАМ’ЯТЬ ПОКОЛІНЬ` : "РОДИННІ ЗВ’ЯЗКИ · ОСОБИ, ЩО ЄДНАЮТЬ ПОКОЛІННЯ"}</span>
              {timeSlice ? <span className="constellation-map-year" aria-hidden="true">{timeSlice.year}</span> : null}
            </> : null}
            {busy || error || !activeScene?.nodes.length ? <div className="constellation-state" role={error ? "alert" : "status"}>
              <span aria-hidden="true">✧</span><strong>{error || (busy ? "Будуємо сузір’я вашого роду…" : mode === "places" && scene?.nodes.length ? placesOnlyPerson ? "У вибраної особи немає доступних місць" : "У завантажених осіб ще немає місць" : "Немає доступних даних для цієї особи")}</strong>
              {busy ? <small>Завантажуємо лише вибране родинне оточення.</small> : error || !scene?.nodes.length ? <button type="button" onClick={neighborhood.reload}>Спробувати ще раз</button> : placesOnlyPerson ? <button type="button" onClick={() => setPlacesOnlyPerson(false)}>Показати всі місця</button> : <small>Місця з’являться після додавання їх у події осіб.</small>}
            </div> : null}
            <div className="constellation-brand"><img src={TRACKER_RODU_CHART_LOGO_URL} alt="" /><div><strong>{TRACKER_RODU_CHART_BRAND_NAME}</strong><small>Сузір’я роду</small></div></div>
          </div>
          <div className="constellation-map-footer">
            <p id={instructionsId}>Тягніть мапу · масштабуйте колесом або двома пальцями · натисніть на {mode === "places" ? "місце" : "особу"}. Клавіатура: стрілки, + / −, Home.</p>
            {mode === "places" ? <div className="constellation-legend"><span>Число в колі — особи</span><span><i className="is-partner" />Послідовні згадки</span><span>◇ Еміграція / імміграція</span><span>Пунктирне коло — неуточнене місце</span></div> : <div className="constellation-legend"><span><i />Батьки → діти</span><span><i className="is-partner" />Партнерство</span><span><i className="is-other" />Інші типи батьківства</span></div>}
            <p role="status">{mode === "places" ? `${placesScene.nodes.length} груп місць на схемі${placesScene.omittedCount ? ` · ще ${placesScene.omittedCount} доступні через пошук і список` : ""} · Підсвічено: ${selected?.person.displayName ?? "—"}` : scene ? `${scene.nodes.length} осіб · ${scene.edges.length} зв’язків` : ""}{scene && (graph.persons.length >= MAX_CONSTELLATION_PERSONS || scene.omittedCount > 0) ? " · Показано обмежене оточення. Змініть центр, щоб дослідити інші гілки." : ""}</p>
            {mode === "places" && placeLinks.omittedCount ? <p>{placeLinks.omittedCount} ліній приховано для читабельності. Повні послідовності доступні в панелі особи.</p> : null}
          </div>
        </div>
        <aside ref={sidebarRef} id={sidebarId} tabIndex={-1} className="constellation-sidebar" aria-label={mode === "places" ? "Вибране місце" : "Вибрана особа"}>
          {mode === "places" ? <ConstellationPlacesDetails model={placesModel} place={selectedPlace} selectedPersonId={selected?.id ?? focusPersonId}
            nameOf={id => nodesById.get(id)?.person.displayName ?? "Особа"} onSelectPlace={choosePlace} onSelectPerson={setSelectedId}
            onOpenPerson={selected && onOpenPerson ? id => void openPerson(id) : undefined}
            onMakeCentral={selected && selected.id !== focusPersonId ? onFocusPersonChange : undefined}
            onYearSelect={(value, id) => { setSelectedId(id); setYear(value); changeMode("time"); sidebarRef.current?.scrollTo({ top: 0 }); }} /> : selected ? <>
            <span className="constellation-eyebrow">{CONSTELLATION_ROLE_LABELS[selected.role]}</span>
            <div className="constellation-person-mark" style={{ backgroundColor: constellationTone(selected, colors).fill, color: constellationTone(selected, colors).foreground }} aria-hidden="true">{selected.person.displayName.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join("")}</div>
            <h3>{selected.person.displayName}</h3>
            <p>{constellationLife(selected.person) || "Дати не вказано"}</p>
            {selected.role === "ancestor" || selected.role === "descendant" ? <p className="constellation-generation">Покоління <strong>{Math.abs(selected.generation)}</strong></p> : null}
            <div className="constellation-person-actions">
              {onOpenPerson ? <button type="button" className="constellation-primary" onClick={() => void openPerson(selected.id)}>Відкрити картку особи</button> : null}
              {onFocusPersonChange && selected.id !== focusPersonId ? <button type="button" onClick={() => onFocusPersonChange(selected.id)}>Зробити центральною</button> : null}
              <button type="button" onClick={() => centerPerson(selected, true)}>Знайти на мапі</button>
            </div>
            {timeSlice ? <ConstellationTimeDetails model={timeModel} slice={timeSlice} selectedId={selected.id}
              nameOf={id => nodesById.get(id)?.person.displayName ?? "Особа"} onYearChange={setYear}
              onSelect={id => { const node = nodesById.get(id); if (node) centerPerson(node, true); }} /> : null}
            {selectedPath && selectedPath.personIds.length > 1 ? <div className="constellation-connection">
              <h4>Шлях від центральної особи</h4>
              <small>Найкоротший у завантаженому оточенні. Колір і лінія позначають гілку та тип зв’язку, а не його доведеність.</small>
              <ol>{selectedPath.personIds.map((id, index) => <li key={id}>
                {index > 0 ? <span>{constellationTimeEdgeLabel(edgesById.get(selectedPath.edgeIds[index - 1]!), timeSlice)}</span> : null}
                <button type="button" onClick={() => { const node = nodesById.get(id); if (node) centerPerson(node, true); }}>{nodesById.get(id)?.person.displayName}</button>
              </li>)}</ol>
            </div> : <p className="constellation-intro">Предки розташовані вгорі, нащадки — внизу, партнери та бічні гілки — обабіч. Виберіть людину, щоб підсвітити шлях до неї.</p>}
          </> : <p>Тут з’являться дані вибраної особи.</p>}
          <details className="constellation-list" open={listOpen} onToggle={event => setListOpen(event.currentTarget.open)}>
            <summary>Список осіб{scene ? ` (${scene.nodes.length})` : ""}</summary>
            {listOpen ? <>
              <label>Пошук у сузір’ї<input type="search" value={listQuery} onChange={event => { setListQuery(event.target.value); setListLimit(60); }} /></label>
              <ul>{listedNodes.slice(0, listLimit).map(node => <li key={node.id}><button type="button" aria-pressed={node.id === selected?.id} onClick={() => centerPerson(node, true)}>{node.person.displayName}<small>{CONSTELLATION_ROLE_LABELS[node.role]}</small></button></li>)}</ul>
              {!listedNodes.length ? <p>Осіб не знайдено.</p> : null}
              {listedNodes.length > listLimit ? <button type="button" onClick={() => setListLimit(value => value + 60)}>Показати ще</button> : null}
            </> : null}
          </details>
        </aside>
      </div>
      {presenting ? <ConstellationPresentationControls tour={tour} index={tourIndex} step={presentationStep} manual={manualPresentation} playing={playing} seconds={tourSeconds}
        reducedMotion={motion.reducedMotion} starsMoving={starsMoving && textured && !motion.reducedMotion} exporting={exporting} message={exportMessage || fullscreen.message}
        onPlay={toggleTour} onPrevious={() => nextTourStep(-1)} onNext={() => nextTourStep(1)} onSpeed={setTourSeconds}
        onStars={() => { setTextured(true); setStarsMoving(value => !value); }} onExport={() => void saveFrame()} onExit={() => finishPresentation()} /> : null}
    </div>
  </Modal>;
}
