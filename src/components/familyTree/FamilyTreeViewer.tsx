import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { FamilyTreeGraphDto, ParentRoleLabel } from "../../types/familyTree";
import type {
  FamilyTreeLayoutEdge,
  FamilyTreeLayoutNode,
  FamilyTreeLayoutPlaceholder,
  FamilyTreeViewerLayout,
} from "../../utils/familyTreeViewerLayout";
import {
  buildFamilyTreeLayoutFamilyUnits,
  edgeDashArray,
} from "../../utils/familyTreeViewerLayout";
import {
  centerViewportOnRect,
  clampScale,
  familyTreeViewportStorageKey,
  fitViewportToBounds,
  initialFamilyTreeViewport,
  readStoredFamilyTreeViewport,
  zoomViewportAtPoint,
  type FamilyTreeViewportState,
  useFamilyTreeViewport,
} from "../../hooks/useFamilyTreeViewport";
import {
  layoutVisibleInViewport,
  visibleLayoutForViewport,
} from "../../utils/familyTreeRenderWindow";
import { calculateVisualBounds } from "../../utils/familyTreeVisualLayout";
import { FamilyTreeEdgeLayer } from "./FamilyTreeEdgeLayer";
import { FamilyTreeNodeCard } from "./FamilyTreeNodeCard";
import { FamilyTreeEmptyState } from "./FamilyTreeStates";
import type { FamilyTreeBuilderAction } from "../../services/familyTreeMutationService";
import {
  availableFamilyTreeActionsForPerson,
  emptyFamilyTreeRelationFlags,
  familyTreeRelationFlagsByPerson,
} from "../../utils/familyTreeActions";
import { familyTreeKinshipLabel } from "../../utils/familyTreeKinship";

type PlaceholderCard = Omit<FamilyTreeLayoutPlaceholder, "row" | "column">;

const COMPACT_PLACEHOLDER_SIZE = 44;
const SHOW_INLINE_PARENT_PLACEHOLDERS = false;
const ACTION_MENU_BUTTON_SIZE = 36;
const MANUAL_POSITION_STORAGE_PREFIX = "family-tree-manual-positions-v3";

type ManualNodePosition = {
  x: number;
  y: number;
};

type ManualNodePositionMap = Record<string, ManualNodePosition>;

export function FamilyTreeViewer({
  graph,
  layout,
  selectedOccurrenceId,
  focusOccurrenceId,
  highlightedOccurrenceIds,
  highlightedRelationshipId,
  issuesCount,
  onSelectOccurrence,
  onAction,
  onExpandGeneration,
  onOpenIssues,
}: {
  graph: FamilyTreeGraphDto;
  layout: FamilyTreeViewerLayout;
  selectedOccurrenceId: string;
  focusOccurrenceId?: string;
  highlightedOccurrenceIds: string[];
  highlightedRelationshipId: string;
  issuesCount?: number;
  onSelectOccurrence: (occurrenceId: string) => void;
  onAction?: (action: FamilyTreeBuilderAction, occurrenceId: string) => void;
  onExpandGeneration?: (direction: "up" | "down" | "side", occurrenceId: string) => void;
  onOpenIssues?: () => void;
}) {
  const viewerShellRef = useRef<HTMLElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const panRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    viewportX: 0,
    viewportY: 0,
    moved: false,
    suppressClick: false,
  });
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState("");
  const storageKey = familyTreeViewportStorageKey({
    treeId: graph.treeId,
    rootPersonId: graph.rootPersonId ?? "",
    mode: graph.mode,
  });
  const { viewport, setViewport, reset } = useFamilyTreeViewport(storageKey);
  const manualPositionStorageKey = manualPositionsStorageKey({
    treeId: graph.treeId,
    rootPersonId: graph.rootPersonId ?? "",
    mode: graph.mode,
  });
  const [manualPositions, setManualPositions] = useState<ManualNodePositionMap>(() =>
    readManualNodePositions(manualPositionStorageKey),
  );
  const manualDragRef = useRef({
    pointerId: -1,
    occurrenceId: "",
    items: [] as Array<{ occurrenceId: string; startX: number; startY: number }>,
    startClientX: 0,
    startClientY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const manualPositionKeyRef = useRef(manualPositionStorageKey);
  const skipManualPositionPersistRef = useRef(false);
  const suppressNodeClickRef = useRef(false);
  useEffect(() => {
    if (manualPositionKeyRef.current === manualPositionStorageKey) return;
    manualPositionKeyRef.current = manualPositionStorageKey;
    skipManualPositionPersistRef.current = true;
    setManualPositions(readManualNodePositions(manualPositionStorageKey));
  }, [manualPositionStorageKey]);
  useEffect(() => {
    if (skipManualPositionPersistRef.current) {
      skipManualPositionPersistRef.current = false;
      return;
    }
    persistManualNodePositions(manualPositionStorageKey, manualPositions);
  }, [manualPositionStorageKey, manualPositions]);
  const visualLayout = useMemo(
    () => applyManualNodePositions(layout, manualPositions),
    [layout, manualPositions],
  );
  const highlightedSet = useMemo(() => new Set(highlightedOccurrenceIds), [highlightedOccurrenceIds]);
  const rootNode = useMemo(
    () => visualLayout.nodes.find((node) => node.occurrence.id === visualLayout.rootOccurrenceId) ?? visualLayout.nodes[0] ?? null,
    [visualLayout],
  );
  const placeholders = useMemo<FamilyTreeLayoutPlaceholder[]>(() => visualLayout.placeholders ?? [], [visualLayout.placeholders]);
  const kinshipLabels = useMemo(
    () => new Map(visualLayout.nodes.map((node) => [
      node.occurrence.id,
      familyTreeKinshipLabel(graph, node.occurrence, node.person),
    ])),
    [graph, visualLayout.nodes],
  );
  const openActionMenuNode = useMemo(
    () => visualLayout.nodes.find((node) => node.occurrence.id === openActionMenuId) ?? null,
    [visualLayout.nodes, openActionMenuId],
  );
  const openActionMenuItems = useMemo(
    () => openActionMenuNode ? actionMenuItems(graph, openActionMenuNode) : [],
    [graph, openActionMenuNode],
  );
  const focusedNode = useMemo(
    () => focusOccurrenceId ? visualLayout.nodes.find((node) => node.occurrence.id === focusOccurrenceId) ?? null : null,
    [focusOccurrenceId, visualLayout.nodes],
  );
  const originX = -visualLayout.minX;
  const originY = -visualLayout.minY;
  const canvasWidth = Math.max(1, visualLayout.maxX - visualLayout.minX);
  const canvasHeight = Math.max(1, visualLayout.maxY - visualLayout.minY);
  const nodeDensity = nodeDensityForScale(viewport.scale);
  const renderedLayout = useMemo(
    () => visibleLayoutForViewport(
      visualLayout,
      viewport,
      viewportElement ? { width: viewportElement.clientWidth, height: viewportElement.clientHeight } : null,
      {
        selectedOccurrenceId,
        focusOccurrenceId,
        openActionMenuId,
        highlightedOccurrenceIds,
      },
      {
        visualScale: 1,
      },
    ),
    [focusOccurrenceId, highlightedOccurrenceIds, openActionMenuId, selectedOccurrenceId, viewport, viewportElement, visualLayout],
  );
  const renderedPlaceholders = useMemo(
    () => placeholders.filter((placeholder) => renderedLayout.visibleOccurrenceIds.has(placeholder.targetOccurrenceId)),
    [placeholders, renderedLayout.visibleOccurrenceIds],
  );
  const layoutSignature = [
    visualLayout.minX,
    visualLayout.minY,
    visualLayout.maxX,
    visualLayout.maxY,
    visualLayout.rootOccurrenceId ?? "",
    visualLayout.nodes.length,
  ].join("|");

  useEffect(() => {
    const updateFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === viewerShellRef.current);
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    setOpenActionMenuId("");
  }, [graph.treeId, graph.rootPersonId, graph.mode]);

  useEffect(() => {
    if (!openActionMenuId) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".family-tree-action-menu, .family-tree-placeholder-card-menu")) return;
      setOpenActionMenuId("");
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenActionMenuId("");
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openActionMenuId]);

  // Колесо миші: React реєструє onWheel як passive, тому preventDefault там не
  // працює і сторінка прокручується. Вішаємо нативний non-passive слухач.
  useEffect(() => {
    if (!viewportElement) return;
    const handleWheel = (event: WheelEvent) => {
      if (shouldIgnoreZoomTarget(event.target)) return;
      event.preventDefault();
      const rect = viewportElement.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      setViewport((current) => zoomViewportAtPoint(current, point, current.scale * factor));
    };
    viewportElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewportElement.removeEventListener("wheel", handleWheel);
  }, [viewportElement, setViewport]);

  // Ініціалізація/валідація viewport: центруємо корінь при першому показі,
  // а відновлений або поточний viewport перевіряємо — чи видно дерево взагалі.
  const initializedKeyRef = useRef("");
  useEffect(() => {
    if (!viewportElement || !rootNode) return;
    const rect = viewportElement.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const isFirstForKey = initializedKeyRef.current !== storageKey;
    initializedKeyRef.current = storageKey;
    const stored = readStoredFamilyTreeViewport(storageKey);
    setViewport((current) => {
      const base = isFirstForKey ? stored ?? current : current;
      const hasTrustedBase = !isFirstForKey || Boolean(stored);
      if (hasTrustedBase && layoutVisibleInViewport(visualLayout, base, rect.width, rect.height)) {
        return base;
      }
      if (!hasTrustedBase) {
        return initialViewportForVisualLayout({
          layout: visualLayout,
          rootNode,
          viewportWidth: rect.width,
          viewportHeight: rect.height,
          padding: 60,
        });
      }
      return centerViewportOnRect({
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        targetX: rootNode.x,
        targetY: rootNode.y,
        targetWidth: rootNode.width,
        targetHeight: rootNode.height,
        scale: clampScale(base.scale),
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, layoutSignature, viewportElement, setViewport]);

  useEffect(() => {
    if (!viewportElement || !focusedNode) return;
    const rect = viewportElement.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    setViewport((current) => centerViewportOnRect({
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      targetX: focusedNode.x,
      targetY: focusedNode.y,
      targetWidth: focusedNode.width,
      targetHeight: focusedNode.height,
      scale: current.scale,
    }));
  }, [focusOccurrenceId, focusedNode, viewportElement, setViewport]);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || shouldIgnorePanTarget(event.target)) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewportX: viewport.x,
      viewportY: viewport.y,
      moved: false,
      suppressClick: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) pan.moved = true;
    if (!pan.moved) return;
    setViewport((current) => ({
      ...current,
      x: pan.viewportX + deltaX,
      y: pan.viewportY + deltaY,
    }));
    event.preventDefault();
  };

  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panRef.current = {
      pointerId: -1,
      startX: 0,
      startY: 0,
      viewportX: 0,
      viewportY: 0,
      moved: false,
      suppressClick: pan.moved,
    };
    setIsPanning(false);
  };

  const suppressClickAfterPan = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!panRef.current.suppressClick) return;
    panRef.current.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const startNodeMove = (event: ReactPointerEvent<HTMLDivElement>, node: FamilyTreeLayoutNode) => {
    if (event.button !== 0 || shouldIgnoreNodeMoveTarget(event.target)) return;
    const moveGroup = horizontalMoveGroupForNode(visualLayout, node);
    manualDragRef.current = {
      pointerId: event.pointerId,
      occurrenceId: node.occurrence.id,
      items: moveGroup.map((groupNode) => ({
        occurrenceId: groupNode.occurrence.id,
        startX: groupNode.x,
        startY: groupNode.y,
      })),
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.x,
      startY: node.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNode = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = manualDragRef.current;
    if (drag.pointerId !== event.pointerId || !drag.occurrenceId) return;
    const deltaX = (event.clientX - drag.startClientX) / viewport.scale;
    const deltaY = (event.clientY - drag.startClientY) / viewport.scale;
    if (Math.abs(deltaX) < 2 && Math.abs(deltaY) < 2 && !drag.moved) return;
    drag.moved = true;
    suppressNodeClickRef.current = true;
    setManualPositions((current) => {
      const next = { ...current };
      for (const item of drag.items) {
        next[item.occurrenceId] = {
          x: Math.round((item.startX + deltaX) * 10) / 10,
          y: item.startY,
        };
      }
      return next;
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const stopNodeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = manualDragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    manualDragRef.current = {
      pointerId: -1,
      occurrenceId: "",
      items: [],
      startClientX: 0,
      startClientY: 0,
      startX: 0,
      startY: 0,
      moved: false,
    };
  };

  const shouldSuppressNodeSelect = () => {
    if (!suppressNodeClickRef.current) return false;
    suppressNodeClickRef.current = false;
    return true;
  };

  const resetManualPositions = () => {
    setManualPositions({});
  };

  const copyManualPositions = async () => {
    const payload = manualPositionExportPayload(graph, visualLayout, manualPositions);
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Скопіюйте позиції дерева", text);
    }
  };

  const zoomFromCenter = (factor: number) => {
    if (!viewportElement) return;
    const rect = viewportElement.getBoundingClientRect();
    const point = { x: rect.width / 2, y: rect.height / 2 };
    setViewport((current) => zoomViewportAtPoint(current, point, current.scale * factor));
  };

  const centerRoot = () => {
    if (!viewportElement || !rootNode) return;
    const rect = viewportElement.getBoundingClientRect();
    setViewport((current) => centerViewportOnRect({
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      targetX: rootNode.x,
      targetY: rootNode.y,
      targetWidth: rootNode.width,
      targetHeight: rootNode.height,
      scale: current.scale,
    }));
  };

  const fitGraph = () => {
    if (!viewportElement) return;
    const rect = viewportElement.getBoundingClientRect();
    setViewport(fitViewportToVisualLayout({
      layout: visualLayout,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      padding: 60,
    }));
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (viewerShellRef.current?.requestFullscreen) {
      void viewerShellRef.current.requestFullscreen();
    }
  };

  if (!graph.tree) {
    return (
      <FamilyTreeEmptyState
        title="Дерево ще не створено"
        description="Підготовчі таблиці вже є, але в цьому проєкті поки немає жодного запису family_trees."
      />
    );
  }
  if (!graph.rootPersonId) {
    return (
      <FamilyTreeEmptyState
        title="Не вибрано кореневу особу"
        description="Для дерева потрібно вказати центральну особу або додати хоча б одну особу до складу дерева."
      />
    );
  }
  if (!visualLayout.nodes.length) {
    return (
      <FamilyTreeEmptyState
        title="Немає вузлів для показу"
        description="Граф завантажився, але для поточного режиму не знайдено осіб або зв'язків."
      />
    );
  }

  return (
    <section ref={viewerShellRef} className="panel family-tree-viewer">
      <div className="family-tree-viewport-controls" data-no-pan>
        <button type="button" onClick={() => zoomFromCenter(0.9)} aria-label="Зменшити масштаб">-</button>
        <strong>{Math.round(viewport.scale * 100)}%</strong>
        <button type="button" onClick={() => zoomFromCenter(1.1)} aria-label="Збільшити масштаб">+</button>
        <button type="button" onClick={centerRoot}>До центру</button>
        <button type="button" onClick={fitGraph}>Показати все</button>
        <button type="button" onClick={reset}>100%</button>
        {Object.keys(manualPositions).length ? (
          <button type="button" onClick={resetManualPositions}>Скинути позиції</button>
        ) : null}
        {Object.keys(manualPositions).length ? (
          <button type="button" onClick={copyManualPositions}>Скопіювати схему</button>
        ) : null}
        {onOpenIssues ? (
          <button type="button" onClick={onOpenIssues}>Перевірка {issuesCount ?? 0}</button>
        ) : null}
        <button type="button" onClick={toggleFullscreen}>{isFullscreen ? "Згорнути" : "На весь екран"}</button>
      </div>
      <div
        ref={setViewportElement}
        className={["family-tree-viewer-scroll", isPanning ? "is-panning" : ""].filter(Boolean).join(" ")}
        onClickCapture={suppressClickAfterPan}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
        onLostPointerCapture={() => setIsPanning(false)}
      >
        <div
          className="family-tree-canvas"
          style={{
            width: canvasWidth,
            height: canvasHeight,
            transform: `translate3d(${roundForCssTransform(viewport.x + visualLayout.minX * viewport.scale)}px, ${roundForCssTransform(viewport.y + visualLayout.minY * viewport.scale)}px, 0) scale(${viewport.scale})`,
          }}
        >
          <FamilyTreeEdgeLayer
            edges={renderedLayout.edges}
            familyUnits={renderedLayout.familyUnits}
            placeholders={renderedPlaceholders}
            highlightedRelationshipId={highlightedRelationshipId}
            offsetX={originX}
            offsetY={originY}
          />
          {renderedLayout.nodes.map((node) => (
            <FamilyTreeNodeCard
              key={node.occurrence.id}
              node={node}
              offsetX={originX}
              offsetY={originY}
              selected={selectedOccurrenceId === node.occurrence.id}
              highlighted={highlightedSet.has(node.occurrence.id)}
              relationshipLabel={kinshipLabels.get(node.occurrence.id)}
              density={nodeDensity}
              visualScale={1}
              onSelect={onSelectOccurrence}
              onExpandHiddenRelatives={onExpandGeneration}
              onMovePointerDown={startNodeMove}
              onMovePointerMove={moveNode}
              onMovePointerUp={stopNodeMove}
              shouldSuppressSelect={shouldSuppressNodeSelect}
            />
          ))}
          {onAction ? renderedPlaceholders.map((placeholder) => (
            <button
              key={placeholder.id}
              type="button"
              className={[
                "family-tree-placeholder-card",
                placeholder.action === "open_menu" ? "family-tree-placeholder-card-menu" : "",
              ].filter(Boolean).join(" ")}
              style={{
                left: placeholder.x + originX,
                top: placeholder.y + originY,
                width: placeholder.width,
                height: placeholder.height,
                "--tree-placeholder-scale": 1,
              } as CSSProperties}
              title={placeholder.label.replace(/^\+\s*/, "")}
              aria-label={placeholder.label.replace(/^\+\s*/, "")}
              data-no-pan
              onClick={(event) => {
                event.stopPropagation();
                if (placeholder.action === "open_menu") {
                  setOpenActionMenuId((current) =>
                    current === placeholder.targetOccurrenceId ? "" : placeholder.targetOccurrenceId,
                  );
                  return;
                }
                setOpenActionMenuId("");
                onAction(placeholder.action, placeholder.targetOccurrenceId);
              }}
            >
              {placeholder.action === "open_menu" ? "+" : (
                <span className="family-tree-placeholder-card-label">
                  <strong>+</strong>
                  <span>{placeholder.label.replace(/^\+\s*/, "")}</span>
                </span>
              )}
            </button>
          )) : null}
          {onAction && openActionMenuNode && openActionMenuItems.length ? (
            <div
              className="family-tree-action-menu"
              style={actionMenuStyle(openActionMenuNode, originX, originY)}
              data-no-pan
            >
              {openActionMenuItems.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenActionMenuId("");
                    onAction(item.action, openActionMenuNode.occurrence.id);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {!visualLayout.edges.length && visualLayout.nodes.length > 1 ? (
        <div className="family-tree-viewer-note">
          Для вибраних фільтрів немає видимих зв'язків між показаними особами.
        </div>
      ) : null}
    </section>
  );
}

function roundForCssTransform(value: number): number {
  return Math.round(value * 100) / 100;
}

function manualPositionsStorageKey(input: {
  treeId: string;
  rootPersonId: string;
  mode: string;
}): string {
  return `${MANUAL_POSITION_STORAGE_PREFIX}:${input.treeId || "no-tree"}:${input.rootPersonId || "no-root"}:${input.mode}`;
}

function readManualNodePositions(storageKey: string): ManualNodePositionMap {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    const result: ManualNodePositionMap = {};
    for (const [occurrenceId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const point = value as Partial<ManualNodePosition>;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      result[occurrenceId] = { x, y };
    }
    return result;
  } catch {
    return {};
  }
}

function persistManualNodePositions(storageKey: string, positions: ManualNodePositionMap) {
  if (typeof window === "undefined") return;
  try {
    const compactEntries = Object.entries(positions)
      .filter(([, point]) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map(([occurrenceId, point]) => [
        occurrenceId,
        {
          x: Math.round(point.x * 10) / 10,
          y: Math.round(point.y * 10) / 10,
        },
      ] as const);
    if (!compactEntries.length) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(compactEntries)));
  } catch {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Manual visual positions are helpful but not critical if storage quota is full.
    }
  }
}

function manualPositionExportPayload(
  graph: FamilyTreeGraphDto,
  layout: FamilyTreeViewerLayout,
  manualPositions: ManualNodePositionMap,
) {
  const manualIds = new Set(Object.keys(manualPositions));
  return {
    version: 1,
    treeId: graph.treeId,
    rootPersonId: graph.rootPersonId,
    mode: graph.mode,
    positions: layout.nodes
      .filter((node) => manualIds.has(node.occurrence.id))
      .sort((left, right) => left.occurrence.generation - right.occurrence.generation || left.x - right.x)
      .map((node) => ({
        occurrenceId: node.occurrence.id,
        personId: node.person.personId,
        name: node.person.displayName,
        generation: node.occurrence.generation,
        x: Math.round(node.x * 10) / 10,
        y: Math.round(node.y * 10) / 10,
      })),
  };
}

function applyManualNodePositions(
  layout: FamilyTreeViewerLayout,
  positions: ManualNodePositionMap,
): FamilyTreeViewerLayout {
  const nodeByOccurrence = new Map(layout.nodes.map((node) => [node.occurrence.id, node]));
  const activePositions = new Map(
    Object.entries(positions)
      .filter(([occurrenceId, point]) =>
        nodeByOccurrence.has(occurrenceId) &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y),
      ),
  );
  if (!activePositions.size) return layout;

  const deltaByOccurrence = new Map<string, { x: number; y: number }>();
  const nodes = layout.nodes.map((node) => {
    const manual = activePositions.get(node.occurrence.id);
    if (!manual) return node;
    deltaByOccurrence.set(node.occurrence.id, {
      x: manual.x - node.x,
      y: manual.y - node.y,
    });
    return {
      ...node,
      x: manual.x,
      y: manual.y,
    };
  });
  const movedNodeByOccurrence = new Map(nodes.map((node) => [node.occurrence.id, node]));
  const edges = layout.edges.map((edge) => {
    const from = movedNodeByOccurrence.get(edge.from.occurrence.id) ?? edge.from;
    const to = movedNodeByOccurrence.get(edge.to.occurrence.id) ?? edge.to;
    return {
      ...edge,
      from,
      to,
      path: manualEdgePath(edge, from, to),
      dashArray: edgeDashArray(edge.edge),
    };
  });
  const placeholders = layout.placeholders?.map((placeholder) => {
    const anchoredParentPlaceholder = manualMissingParentPlaceholder(placeholder, edges);
    if (anchoredParentPlaceholder) {
      const target = movedNodeByOccurrence.get(placeholder.targetOccurrenceId);
      return {
        ...placeholder,
        ...anchoredParentPlaceholder,
        connectionPath: target
          ? manualPlaceholderConnectionPath(placeholder.action, anchoredParentPlaceholder, target)
          : placeholder.connectionPath,
      };
    }
    const delta = deltaByOccurrence.get(placeholder.targetOccurrenceId);
    if (!delta) return placeholder;
    const target = movedNodeByOccurrence.get(placeholder.targetOccurrenceId);
    const movedPlaceholder = {
      ...placeholder,
      x: placeholder.x + delta.x,
      y: placeholder.y + delta.y,
    };
    return {
      ...movedPlaceholder,
      connectionPath: target && placeholder.action !== "open_menu"
        ? manualPlaceholderConnectionPath(placeholder.action, movedPlaceholder, target)
        : placeholder.connectionPath,
    };
  });
  const alignedPlaceholders = alignManualPlaceholdersToRows(placeholders ?? [], nodes);
  const familyUnits = buildFamilyTreeLayoutFamilyUnits(edges);
  const bounds = visualLayoutBounds(nodes, alignedPlaceholders);
  return {
    ...layout,
    nodes,
    edges,
    familyUnits,
    placeholders: alignedPlaceholders,
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    width: Math.max(720, bounds.maxX - bounds.minX),
    height: Math.max(420, bounds.maxY - bounds.minY),
  };
}

function manualEdgePath(
  edge: FamilyTreeLayoutEdge,
  from: FamilyTreeLayoutNode,
  to: FamilyTreeLayoutNode,
): string {
  if (edge.edge.kind === "partner") {
    const fromCenterY = from.y + from.height / 2;
    const toCenterY = to.y + to.height / 2;
    const fromLeft = from.x + from.width / 2 <= to.x + to.width / 2;
    const startX = fromLeft ? from.x + from.width : from.x;
    const endX = fromLeft ? to.x : to.x + to.width;
    const midY = (fromCenterY + toCenterY) / 2;
    return fromCenterY === toCenterY
      ? `M ${startX} ${fromCenterY} H ${endX}`
      : `M ${startX} ${fromCenterY} V ${midY} H ${endX} V ${toCenterY}`;
  }
  const fromCenterX = from.x + from.width / 2;
  const toCenterX = to.x + to.width / 2;
  const startY = from.y < to.y ? from.y + from.height : from.y;
  const endY = from.y < to.y ? to.y : to.y + to.height;
  const midY = (startY + endY) / 2;
  return `M ${fromCenterX} ${startY} V ${midY} H ${toCenterX} V ${endY}`;
}

function manualPlaceholderConnectionPath(
  action: FamilyTreeLayoutPlaceholder["action"],
  placeholder: { x: number; y: number; width: number; height: number },
  node: { x: number; y: number; width: number; height: number },
): string {
  if (action === "add_partner") {
    const nodeCenterY = node.y + node.height / 2;
    if (placeholder.x >= node.x + node.width) {
      return `M ${node.x + node.width} ${nodeCenterY} H ${placeholder.x}`;
    }
    if (placeholder.x + placeholder.width <= node.x) {
      return `M ${node.x} ${nodeCenterY} H ${placeholder.x + placeholder.width}`;
    }
    const placeholderCenterX = placeholder.x + placeholder.width / 2;
    const placeholderCenterY = placeholder.y + placeholder.height / 2;
    return `M ${node.x + node.width / 2} ${nodeCenterY} V ${placeholderCenterY} H ${placeholderCenterX}`;
  }
  if (action === "add_child") {
    const startX = node.x + node.width / 2;
    const startY = node.y + node.height;
    const endX = placeholder.x + placeholder.width / 2;
    const endY = placeholder.y;
    const midY = startY + Math.max(12, (endY - startY) / 2);
    return `M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`;
  }
  const startX = placeholder.x + placeholder.width / 2;
  const startY = placeholder.y + placeholder.height;
  const endX = node.x + node.width / 2;
  const endY = node.y;
  const midY = startY + Math.max(16, (endY - startY) / 2);
  return `M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`;
}

function manualMissingParentPlaceholder(
  placeholder: FamilyTreeLayoutPlaceholder,
  edges: FamilyTreeLayoutEdge[],
): { x: number; y: number; width: number; height: number } | null {
  if (placeholder.action !== "add_father" && placeholder.action !== "add_mother") return null;
  const knownParentSide = placeholder.action === "add_father" ? 1 : 0;
  const knownParentEdge = edges.find((edge) =>
    edge.edge.kind === "parent_child" &&
    edge.to.occurrence.id === placeholder.targetOccurrenceId &&
    manualParentSideForEdge(edge) === knownParentSide
  );
  if (!knownParentEdge) return null;
  const knownParent = knownParentEdge.from;
  const gap = Math.max(14, Math.round(knownParent.width * 0.08));
  const x = placeholder.action === "add_father"
    ? knownParent.x - gap - placeholder.width
    : knownParent.x + knownParent.width + gap;
  return {
    x,
    y: knownParent.y + (knownParent.height - placeholder.height) / 2,
    width: placeholder.width,
    height: placeholder.height,
  };
}

function manualParentSideForEdge(edge: FamilyTreeLayoutEdge): number {
  const role = String(edge.edge.parentRoleLabel ?? edge.edge.metadata?.parentRoleLabel ?? "").toLocaleLowerCase("uk");
  if (role.includes("\u0431\u0430\u0442") || role.includes("father")) return 0;
  if (role.includes("\u043c\u0430\u0442") || role.includes("mother")) return 1;
  return 2;
}

function alignManualPlaceholdersToRows(
  placeholders: FamilyTreeLayoutPlaceholder[],
  nodes: FamilyTreeLayoutNode[],
): FamilyTreeLayoutPlaceholder[] {
  if (!placeholders.length) return placeholders;
  const nodesByGeneration = new Map<number, FamilyTreeLayoutNode[]>();
  for (const node of nodes) {
    const row = nodesByGeneration.get(node.occurrence.generation) ?? [];
    row.push(node);
    nodesByGeneration.set(node.occurrence.generation, row);
  }
  const placeholdersByRow = new Map<number, FamilyTreeLayoutPlaceholder[]>();
  for (const placeholder of placeholders) {
    const row = placeholdersByRow.get(placeholder.row) ?? [];
    row.push(placeholder);
    placeholdersByRow.set(placeholder.row, row);
  }
  const rowAnchorCenterY = new Map<number, number>();
  for (const [rowIndex, rowPlaceholders] of placeholdersByRow.entries()) {
    const rowNodes = nodesByGeneration.get(rowIndex) ?? [];
    if (rowNodes.length) {
      const centers = rowNodes
        .map((node) => node.y + node.height / 2)
        .sort((left, right) => left - right);
      rowAnchorCenterY.set(rowIndex, centers[Math.floor(centers.length / 2)]);
      continue;
    }
    const visiblePlaceholders = rowPlaceholders.filter((placeholder) => placeholder.action !== "open_menu");
    if (!visiblePlaceholders.length) continue;
    const centers = visiblePlaceholders
      .map((placeholder) => placeholder.y + placeholder.height / 2)
      .sort((left, right) => left - right);
    rowAnchorCenterY.set(rowIndex, centers[Math.floor(centers.length / 2)]);
  }
  const nodeByOccurrence = new Map(nodes.map((node) => [node.occurrence.id, node]));
  return placeholders.map((placeholder) => {
    if (placeholder.action === "open_menu") return placeholder;
    const centerY = rowAnchorCenterY.get(placeholder.row);
    if (centerY === undefined) return placeholder;
    const aligned = {
      ...placeholder,
      y: centerY - placeholder.height / 2,
    };
    const target = nodeByOccurrence.get(placeholder.targetOccurrenceId);
    return {
      ...aligned,
      connectionPath: target
        ? manualPlaceholderConnectionPath(aligned.action, aligned, target)
        : aligned.connectionPath,
    };
  });
}

function visualLayoutBounds(
  nodes: FamilyTreeLayoutNode[],
  placeholders: FamilyTreeLayoutPlaceholder[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  const items = [
    ...nodes.map((node) => ({
      minX: node.x,
      minY: node.y,
      maxX: node.x + node.width,
      maxY: node.y + node.height,
    })),
    ...placeholders.map((placeholder) => ({
      minX: placeholder.x,
      minY: placeholder.y,
      maxX: placeholder.x + placeholder.width,
      maxY: placeholder.y + placeholder.height,
    })),
  ];
  if (!items.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const padding = 52;
  return {
    minX: Math.min(...items.map((item) => item.minX)) - padding,
    minY: Math.min(...items.map((item) => item.minY)) - padding,
    maxX: Math.max(...items.map((item) => item.maxX)) + padding,
    maxY: Math.max(...items.map((item) => item.maxY)) + padding,
  };
}

function horizontalMoveGroupForNode(
  layout: FamilyTreeViewerLayout,
  node: FamilyTreeLayoutNode,
): FamilyTreeLayoutNode[] {
  const nodeByOccurrence = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const occurrenceIds = new Set([node.occurrence.id]);
  for (const unit of layout.familyUnits) {
    if (!unit.parentOccurrenceIds.includes(node.occurrence.id)) continue;
    for (const parentOccurrenceId of unit.parentOccurrenceIds) {
      const parent = nodeByOccurrence.get(parentOccurrenceId);
      if (parent && isSameMoveRow(node, parent)) {
        occurrenceIds.add(parentOccurrenceId);
      }
    }
  }
  for (const edge of layout.edges) {
    if (edge.edge.kind !== "partner") continue;
    const fromId = edge.from.occurrence.id;
    const toId = edge.to.occurrence.id;
    const partnerId = fromId === node.occurrence.id ? toId : toId === node.occurrence.id ? fromId : "";
    if (!partnerId) continue;
    const partner = nodeByOccurrence.get(partnerId);
    if (partner && isSameMoveRow(node, partner)) {
      occurrenceIds.add(partnerId);
    }
  }
  return [...occurrenceIds]
    .map((occurrenceId) => nodeByOccurrence.get(occurrenceId))
    .filter((item): item is FamilyTreeLayoutNode => Boolean(item))
    .sort((left, right) => left.x - right.x || left.occurrence.id.localeCompare(right.occurrence.id, "uk"));
}

function isSameMoveRow(left: FamilyTreeLayoutNode, right: FamilyTreeLayoutNode): boolean {
  if (left.occurrence.generation === right.occurrence.generation) return true;
  return Math.abs(left.y - right.y) <= Math.max(2, Math.min(left.height, right.height) * 0.25);
}

function shouldIgnoreNodeMoveTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, select, textarea, a"));
}

function nodeDensityForScale(scale: number): "normal" | "compact" | "mini" {
  if (scale <= 0.22) return "mini";
  if (scale <= 0.44) return "compact";
  return "normal";
}

function initialViewportForVisualLayout({
  layout,
  rootNode,
  viewportWidth,
  viewportHeight,
  padding,
}: {
  layout: FamilyTreeViewerLayout;
  rootNode: FamilyTreeLayoutNode;
  viewportWidth: number;
  viewportHeight: number;
  padding: number;
}): FamilyTreeViewportState {
  const base = initialFamilyTreeViewport({
    viewportWidth,
    viewportHeight,
    minX: layout.minX,
    minY: layout.minY,
    maxX: layout.maxX,
    maxY: layout.maxY,
    rootX: rootNode.x,
    rootY: rootNode.y,
    rootWidth: rootNode.width,
    rootHeight: rootNode.height,
    padding,
  });
  const visualScale = worldVisualScaleForViewport(base.scale);
  if (visualScale <= 1) return base;
  return fitViewportToVisualLayout({
    layout,
    viewportWidth,
    viewportHeight,
    padding,
    baseScale: base.scale,
  });
}

function fitViewportToVisualLayout({
  layout,
  viewportWidth,
  viewportHeight,
  padding,
  baseScale,
}: {
  layout: FamilyTreeViewerLayout;
  viewportWidth: number;
  viewportHeight: number;
  padding: number;
  baseScale?: number;
}): FamilyTreeViewportState {
  const base = baseScale === undefined
    ? fitViewportToBounds({
      viewportWidth,
      viewportHeight,
      minX: layout.minX,
      minY: layout.minY,
      maxX: layout.maxX,
      maxY: layout.maxY,
      padding,
    })
    : { x: 0, y: 0, scale: baseScale };
  const bounds = calculateVisualBounds(layout, worldVisualScaleForViewport(base.scale));
  return fitViewportToBounds({
    viewportWidth,
    viewportHeight,
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    padding,
  });
}

function worldVisualScaleForViewport(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? 1 : 1;
}

function actionMenuStyle(
  node: FamilyTreeLayoutNode,
  offsetX: number,
  offsetY: number,
): CSSProperties {
  return {
    left: node.x + node.width + 12 + offsetX,
    top: node.y + node.height - 2 + offsetY,
    "--tree-action-menu-scale": 1,
  } as CSSProperties;
}

function buildActionPlaceholderCards(
  graph: FamilyTreeGraphDto,
  nodes: FamilyTreeLayoutNode[],
): PlaceholderCard[] {
  const placeholders: PlaceholderCard[] = [];
  const edgeByPerson = familyTreeRelationFlagsByPerson(graph);
  for (const node of nodes) {
    const flags = edgeByPerson.get(node.person.personId) ?? emptyFamilyTreeRelationFlags();
    if (SHOW_INLINE_PARENT_PLACEHOLDERS && flags.biologicalFathers === 0) {
      placeholders.push({
        id: `${node.occurrence.id}:father`,
        action: "add_father",
        label: "+ Додати батька",
        targetOccurrenceId: node.occurrence.id,
        x: node.x + node.width / 2 - COMPACT_PLACEHOLDER_SIZE - 8,
        y: node.y - COMPACT_PLACEHOLDER_SIZE - 14,
        width: COMPACT_PLACEHOLDER_SIZE,
        height: COMPACT_PLACEHOLDER_SIZE,
      });
    }
    if (SHOW_INLINE_PARENT_PLACEHOLDERS && flags.biologicalMothers === 0) {
      placeholders.push({
        id: `${node.occurrence.id}:mother`,
        action: "add_mother",
        label: "+ Додати матір",
        targetOccurrenceId: node.occurrence.id,
        x: node.x + node.width / 2 + 8,
        y: node.y - COMPACT_PLACEHOLDER_SIZE - 14,
        width: COMPACT_PLACEHOLDER_SIZE,
        height: COMPACT_PLACEHOLDER_SIZE,
      });
    }
    placeholders.push({
      id: `${node.occurrence.id}:menu`,
      action: "open_menu",
      label: "+ Додати родича",
      targetOccurrenceId: node.occurrence.id,
      x: node.x + node.width - ACTION_MENU_BUTTON_SIZE / 2,
      y: node.y + node.height - ACTION_MENU_BUTTON_SIZE / 2,
      width: ACTION_MENU_BUTTON_SIZE,
      height: ACTION_MENU_BUTTON_SIZE,
    });
  }
  return placeholders;
}

type ActionMenuItem = {
  action: FamilyTreeBuilderAction;
  label: string;
};

function actionMenuItems(graph: FamilyTreeGraphDto, node: FamilyTreeLayoutNode): ActionMenuItem[] {
  {
    const actionFlags = familyTreeRelationFlagsByPerson(graph).get(node.person.personId) ?? emptyFamilyTreeRelationFlags();
    return availableFamilyTreeActionsForPerson(graph, node.person.personId)
      .map((item) => ({
        action: item.action,
        label: actionMenuLabel(item.action, actionFlags.partners),
      }));
  }
  const flags = relationFlagsByPerson(graph).get(node.person.personId) ?? emptyRelationFlags();
  const items: ActionMenuItem[] = [];
  if (flags.fathers === 0) items.push({ action: "add_father", label: "Додати батька" });
  if (flags.mothers === 0) items.push({ action: "add_mother", label: "Додати матір" });
  items.push({ action: "add_partner", label: flags.partners > 0 ? "Додати ще партнера" : "Додати партнера" });
  items.push({ action: "add_child", label: "Додати дитину" });
  if (flags.parents > 0) items.push({ action: "add_sibling", label: "Додати брата або сестру" });
  return items;
}

function actionMenuLabel(action: FamilyTreeBuilderAction, partnersCount: number): string {
  if (action === "add_father") return "Додати батька";
  if (action === "add_mother") return "Додати матір";
  if (action === "add_partner") return partnersCount > 0 ? "Додати ще партнера" : "Додати партнера";
  if (action === "add_child") return "Додати дитину";
  if (action === "add_sibling") return "Додати брата або сестру";
  return "Додати";
}

type RelationFlags = {
  parents: number;
  fathers: number;
  mothers: number;
  partners: number;
  children: number;
};

function emptyRelationFlags(): RelationFlags {
  return {
    parents: 0,
    fathers: 0,
    mothers: 0,
    partners: 0,
    children: 0,
  };
}

function relationFlagsByPerson(graph: FamilyTreeGraphDto): Map<string, RelationFlags> {
  const result = new Map<string, RelationFlags>();
  const personById = new Map(graph.nodes.map((node) => [node.personId, node]));
  const countedRelationships = new Set<string>();
  const flagsFor = (personId: string) => {
    const current = result.get(personId) ?? emptyRelationFlags();
    result.set(personId, current);
    return current;
  };
  for (const edge of graph.edges) {
    // Одна relationship може мати кілька ребер (по одному на пару occurrences).
    const dedupeKey = `${edge.kind}:${edge.relationshipId}`;
    if (countedRelationships.has(dedupeKey)) continue;
    countedRelationships.add(dedupeKey);
    if (edge.kind === "parent_child") {
      const childFlags = flagsFor(edge.toPersonId);
      childFlags.parents += 1;
      const role = parentRoleFromEdge(edge, personById.get(edge.fromPersonId)?.gender);
      if (role === "father") childFlags.fathers += 1;
      else if (role === "mother") childFlags.mothers += 1;
      flagsFor(edge.fromPersonId).children += 1;
    } else if (edge.kind === "partner") {
      flagsFor(edge.fromPersonId).partners += 1;
      flagsFor(edge.toPersonId).partners += 1;
    }
  }
  for (const group of graph.groups) {
    for (const personId of group.partnerIds) {
      if (!personId) continue;
      flagsFor(personId).partners += Math.max(1, group.partnerIds.length - 1);
    }
    if (group.parentIds.length > 1) {
      for (const personId of group.parentIds) {
        flagsFor(personId).partners += group.parentIds.length - 1;
      }
    }
  }
  return result;
}

function parentRoleFromEdge(
  edge: FamilyTreeGraphDto["edges"][number],
  parentGender: string | undefined,
): "father" | "mother" | "parent" {
  const role = String(edge.parentRoleLabel ?? edge.metadata?.parentRoleLabel ?? edge.metadata?.parent_role_label ?? "").toLowerCase() as ParentRoleLabel | "";
  if (["father", "stepfather", "adoptive_father"].includes(role)) return "father";
  if (["mother", "stepmother", "adoptive_mother"].includes(role)) return "mother";
  const gender = (parentGender ?? "").toLocaleLowerCase("uk");
  if (["чоловік", "чоловіча", "male", "m", "man"].includes(gender)) return "father";
  if (["жінка", "жіноча", "female", "f", "woman"].includes(gender)) return "mother";
  if (["чоловік", "male", "m", "man"].includes(gender)) return "father";
  if (["жінка", "female", "f", "woman"].includes(gender)) return "mother";
  return "parent";
}

function shouldIgnorePanTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(
    "a, button, input, select, textarea, [data-no-pan]",
  ));
}

function shouldIgnoreZoomTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(
    ".family-tree-viewport-controls, .family-tree-action-menu",
  ));
}
