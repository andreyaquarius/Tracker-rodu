"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type {
  CameraState,
  FamilyContinuation,
  FamilyGraphData,
  FamilyTreeLayoutOptions,
  LayoutNode,
  OccurrenceId,
} from "../types.ts";
import { FamilyTreeSemanticList } from "./FamilyTreeSemanticList.tsx";
import { FamilyBranchControl } from "./FamilyBranchControl.tsx";
import { PersonCard } from "./PersonCard.tsx";
import { TreeEdgeCanvas } from "./TreeEdgeCanvas.tsx";
import type { TreePersonPhotoSourceResolver } from "./personPhotoSourceCache.ts";
import { useFamilyTreeLayout } from "./useFamilyTreeLayout.ts";
import {
  allocateInteractiveMountBudget,
  normalizeRenderedNodeLimit,
} from "./renderLimits.ts";
import { useTreeCamera } from "./useTreeCamera.ts";
import {
  graphWithoutLegacyFamilyChildControls,
  positionFamilyContinuations,
} from "./familyContinuationLayout.ts";
import "./familyTree.css";

export interface FamilyTreeViewportProps {
  graph: FamilyGraphData;
  options: FamilyTreeLayoutOptions;
  className?: string;
  lineageColor?: string;
  lineagePalette?: readonly string[];
  selectedPersonId?: string;
  preserveAnchorOccurrenceId?: OccurrenceId;
  /** May lower, but never raise, the hard ceiling of 600 mounted cards. */
  maxRenderedNodes?: number;
  initialCamera?: CameraState;
  onCameraChange?: (camera: CameraState) => void;
  onOpenPerson?: (personId: string, occurrenceId: string) => void;
  onFocusPerson?: (personId: string) => void;
  onShowAllDescendants?: (personId: string, occurrenceId: string) => void;
  onAddRelative?: (personId: string) => void;
  branchTogglePersonIds?: ReadonlySet<string>;
  collapsedBranchPersonIds?: ReadonlySet<string>;
  onTogglePersonBranches?: (personId: string, occurrenceId: string) => void;
  onExpandContinuation?: (token: string, node: LayoutNode) => void;
  familyContinuationOwnerByScope?: ReadonlyMap<string, string>;
  onToggleFamilyContinuation?: (
    continuation: FamilyContinuation,
    anchorOccurrenceId?: OccurrenceId,
    ownerPersonId?: string,
  ) => void;
  onLayoutWarnings?: (messages: readonly string[]) => void;
  resolvePhotoSource?: TreePersonPhotoSourceResolver;
}

function intersectsNode(
  node: Pick<LayoutNode, "x" | "y" | "width" | "height">,
  viewport: { left: number; top: number; right: number; bottom: number },
  overscan: number,
): boolean {
  return !(
    node.x + node.width < viewport.left - overscan ||
    node.x > viewport.right + overscan ||
    node.y + node.height < viewport.top - overscan ||
    node.y > viewport.bottom + overscan
  );
}

export function FamilyTreeViewport({
  graph,
  options,
  className,
  lineageColor,
  lineagePalette,
  selectedPersonId,
  preserveAnchorOccurrenceId,
  maxRenderedNodes,
  initialCamera,
  onCameraChange,
  onOpenPerson,
  onFocusPerson,
  onShowAllDescendants,
  onAddRelative,
  branchTogglePersonIds,
  collapsedBranchPersonIds,
  onTogglePersonBranches,
  onExpandContinuation,
  familyContinuationOwnerByScope,
  onToggleFamilyContinuation,
  onLayoutWarnings,
  resolvePhotoSource,
}: FamilyTreeViewportProps): ReactElement {
  const layoutGraph = useMemo(
    () => graphWithoutLegacyFamilyChildControls(graph),
    [graph],
  );
  const layoutState = useFamilyTreeLayout({
    graph: layoutGraph,
    options,
    preserveAnchorOccurrenceId,
  });
  const camera = useTreeCamera(initialCamera);
  const people = useMemo(
    () => new Map(graph.persons.map(person => [person.id, person])),
    [graph.persons],
  );
  const [showList, setShowList] = useState(false);
  // A remounted viewport receives a saved camera when the user returns from a
  // family corridor. Mark that focus as already positioned so the normal
  // first-layout centering does not immediately overwrite the restored view.
  const fittedFocusRef = useRef<string | undefined>(
    initialCamera ? options.focusPersonId : undefined,
  );
  const renderedNodeLimit = normalizeRenderedNodeLimit(maxRenderedNodes);

  useEffect(() => {
    onCameraChange?.(camera.camera);
  }, [camera.camera, onCameraChange]);

  useEffect(() => {
    const layout = layoutState.layout;
    if (!layout) return;
    if (fittedFocusRef.current !== options.focusPersonId) {
      fittedFocusRef.current = options.focusPersonId;
      const focus = layout.nodes.find(
        node => node.occurrenceId === layout.focusOccurrenceId,
      );
      if (focus) camera.centerNode(focus);
      else camera.fitBounds(layout.bounds);
    }
  }, [
    camera.centerNode,
    camera.fitBounds,
    layoutState.layout,
    options.focusPersonId,
  ]);

  useLayoutEffect(() => {
    if (layoutState.anchorShift) {
      camera.compensateWorldShift(layoutState.anchorShift);
    }
  }, [camera.compensateWorldShift, layoutState.anchorShift]);

  useEffect(() => {
    if (layoutState.layout?.warnings.length) {
      onLayoutWarnings?.(
        layoutState.layout.warnings.map(warning => warning.message),
      );
    }
  }, [layoutState.layout?.warnings, onLayoutWarnings]);

  const visibleNodeCandidates = useMemo(() => {
    const overscan = 260 / camera.camera.zoom;
    const candidates = (layoutState.layout?.nodes ?? []).filter(node =>
      intersectsNode(node, camera.worldViewport, overscan),
    );
    if (candidates.length <= renderedNodeLimit) return candidates;

    const centerX = (camera.worldViewport.left + camera.worldViewport.right) / 2;
    const centerY = (camera.worldViewport.top + camera.worldViewport.bottom) / 2;
    return candidates
      .sort((left, right) => {
        const leftX = left.x + left.width / 2 - centerX;
        const leftY = left.y + left.height / 2 - centerY;
        const rightX = right.x + right.width / 2 - centerX;
        const rightY = right.y + right.height / 2 - centerY;
        return (
          leftX * leftX + leftY * leftY - (rightX * rightX + rightY * rightY) ||
          left.occurrenceId.localeCompare(right.occurrenceId)
        );
      });
  }, [
    camera.camera.zoom,
    camera.worldViewport,
    layoutState.layout?.nodes,
    renderedNodeLimit,
  ]);

  const occurrenceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of layoutState.layout?.nodes ?? []) {
      if (node.personId) counts.set(node.personId, (counts.get(node.personId) ?? 0) + 1);
    }
    return counts;
  }, [layoutState.layout?.nodes]);
  const hasDirectLineage = useMemo(
    () => (layoutState.layout?.nodes ?? []).some(
      node =>
        node.lineageRole === "focus" ||
        node.lineageRole === "direct-ancestor",
    ),
    [layoutState.layout?.nodes],
  );
  const familyControls = useMemo(
    () =>
      layoutState.layout
        ? positionFamilyContinuations(graph, layoutState.layout, {
            activeOwnerByScope: familyContinuationOwnerByScope,
          })
        : [],
    [familyContinuationOwnerByScope, graph, layoutState.layout],
  );
  const visibleFamilyControlCandidates = useMemo(() => {
    const overscan = 260 / camera.camera.zoom;
    return familyControls.filter(control =>
      intersectsNode(control, camera.worldViewport, overscan),
    );
  }, [camera.camera.zoom, camera.worldViewport, familyControls]);
  const mountedInteractive = useMemo(
    () => allocateInteractiveMountBudget(
      visibleNodeCandidates,
      visibleFamilyControlCandidates,
      renderedNodeLimit,
    ),
    [
      renderedNodeLimit,
      visibleFamilyControlCandidates,
      visibleNodeCandidates,
    ],
  );
  const visibleNodes = mountedInteractive.primary;
  const visibleFamilyControls = mountedInteractive.secondary;

  const compact = camera.camera.zoom < 0.48;
  const rootStyle = {
    "--ft-zoom": String(camera.camera.zoom),
    "--ft-direct-lineage-color": lineageColor ?? "#2f7465",
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `--ft-lineage-group-${index}`,
        lineagePalette?.[index] ?? lineageColor ?? "#2f7465",
      ]),
    ),
  } as CSSProperties;

  return (
    <section
      className={`ft-root${className ? ` ${className}` : ""}`}
      style={rootStyle}
      aria-label="Робочий простір родового дерева"
    >
      <div className="ft-toolbar" role="toolbar" aria-label="Керування полотном дерева">
        <span className="ft-toolbar-status" aria-live="polite">
          {layoutState.loading
            ? "Будую дерево…"
            : layoutState.error
              ? `Помилка: ${layoutState.error.message}`
              : `Змонтовано ${visibleNodes.length} із ${layoutState.layout?.nodes.length ?? 0} карток`}
        </span>
        {hasDirectLineage ? (
          <span className="ft-lineage-legend" aria-label="Кольором позначено фокусну особу та прямих предків">
            <span className="ft-lineage-swatch" aria-hidden="true" />
            Пряма гілка
          </span>
        ) : null}
        <button type="button" onClick={() => camera.zoomBy(0.82)} aria-label="Зменшити масштаб">
          −
        </button>
        <button type="button" onClick={() => camera.zoomBy(1.22)} aria-label="Збільшити масштаб">
          ＋
        </button>
        <button
          type="button"
          onClick={() => layoutState.layout && camera.fitBounds(layoutState.layout.bounds)}
        >
          Вмістити
        </button>
        <button
          type="button"
          onClick={() => {
            const focus = layoutState.layout?.nodes.find(
              node => node.occurrenceId === layoutState.layout?.focusOccurrenceId,
            );
            if (focus) camera.centerNode(focus);
          }}
        >
          До фокусу
        </button>
        <button type="button" onClick={() => setShowList(value => !value)}>
          {showList ? "Показати полотно" : "Доступний список"}
        </button>
      </div>

      {showList && layoutState.layout ? (
        <FamilyTreeSemanticList
          layout={layoutState.layout}
          people={people}
          onOpenPerson={onOpenPerson}
          onShowAllDescendants={onShowAllDescendants}
          branchTogglePersonIds={branchTogglePersonIds}
          collapsedBranchPersonIds={collapsedBranchPersonIds}
          onTogglePersonBranches={onTogglePersonBranches}
          familyContinuations={graph.familyContinuations}
          onToggleFamilyContinuation={onToggleFamilyContinuation}
          maxRenderedNodes={renderedNodeLimit}
        />
      ) : (
        <div
          ref={camera.containerRef}
          className="ft-viewport"
          onPointerDownCapture={camera.onPointerDown}
          onPointerMoveCapture={camera.onPointerMove}
          onPointerUpCapture={camera.onPointerUp}
          onPointerCancelCapture={camera.onPointerUp}
          onLostPointerCapture={camera.onPointerUp}
        >
          {layoutState.layout ? (
            <TreeEdgeCanvas
              width={camera.viewportSize.width}
              height={camera.viewportSize.height}
              camera={camera.camera}
              worldViewport={camera.worldViewport}
              edges={layoutState.layout.edges}
              unions={layoutState.layout.unions}
              generationBands={layoutState.layout.generationBands}
            />
          ) : null}

          <div className="ft-card-layer">
            {visibleNodes.map(node => {
              const screenX =
                (node.x - camera.camera.x) * camera.camera.zoom +
                camera.viewportSize.width / 2;
              const screenY =
                (node.y - camera.camera.y) * camera.camera.zoom +
                camera.viewportSize.height / 2;
              const style: CSSProperties = {
                width: node.width,
                height: node.height,
                transform: `translate3d(${screenX}px, ${screenY}px, 0) scale(${camera.camera.zoom})`,
              };
              return (
                <div
                  key={node.occurrenceId}
                  className="ft-card-position"
                  data-occurrence-id={node.occurrenceId}
                  data-person-id={node.personId}
                  style={style}
                  onPointerDown={event => event.stopPropagation()}
                >
                  <PersonCard
                    node={node}
                    person={
                      node.personId
                        ? people.get(node.personId)
                        : node.actionPersonId
                          ? people.get(node.actionPersonId)
                          : undefined
                    }
                    duplicateCount={node.personId ? occurrenceCounts.get(node.personId) ?? 1 : 0}
                    compact={compact}
                    selected={Boolean(node.personId && node.personId === selectedPersonId)}
                    branchesCollapsible={Boolean(
                      node.personId && branchTogglePersonIds?.has(node.personId),
                    )}
                    branchesCollapsed={Boolean(
                      node.personId && collapsedBranchPersonIds?.has(node.personId),
                    )}
                    onOpen={onOpenPerson}
                    onFocus={onFocusPerson}
                    onShowAllDescendants={onShowAllDescendants}
                    onAddRelative={onAddRelative}
                    onToggleBranches={onTogglePersonBranches}
                    onExpandContinuation={onExpandContinuation}
                    resolvePhotoSource={resolvePhotoSource}
                  />
                </div>
              );
            })}
            {visibleFamilyControls.map(control => {
              const screenX =
                (control.x - camera.camera.x) * camera.camera.zoom +
                camera.viewportSize.width / 2;
              const screenY =
                (control.y - camera.camera.y) * camera.camera.zoom +
                camera.viewportSize.height / 2;
              const style: CSSProperties = {
                width: control.width,
                height: control.height,
                transform: `translate3d(${screenX}px, ${screenY}px, 0) scale(${camera.camera.zoom})`,
              };
              return (
                <div
                  key={control.id}
                  className="ft-card-position ft-family-control-position"
                  data-family-scope-id={control.continuation.scope.id}
                  data-family-owner-person-id={control.ownerPersonId}
                  data-anchor-occurrence-id={control.anchorOccurrenceId}
                  style={style}
                  onPointerDown={event => event.stopPropagation()}
                >
                  <FamilyBranchControl
                    continuation={control.continuation}
                    people={people}
                    onToggle={continuation =>
                      onToggleFamilyContinuation?.(
                        continuation,
                        control.anchorOccurrenceId,
                        control.ownerPersonId,
                      )
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
