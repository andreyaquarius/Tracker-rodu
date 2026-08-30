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
import {
  applyContextRelationshipGraphNodeOffsets,
  buildBoundedContextRelationshipGraph,
  buildContextRelationshipGraphLayout,
  clampGraphZoom,
  projectContextRelationshipGraph2D,
  projectContextRelationshipGraph3D,
  wrapContextRelationshipGraphLabel,
  type ContextRelationshipGraphEdge,
  type ContextRelationshipGraphLayoutBuilder,
  type ContextRelationshipGraphNode,
  type ContextRelationshipGraphNodeOffsets,
  type ContextRelationshipGraphProjectionEdge,
  type ContextRelationshipGraphProjectionNode,
} from "./contextRelationshipGraphModel.ts";
import "./ContextRelationshipGraphV1.css";

export type ContextRelationshipGraphMode = "2d" | "3d";
export type ContextRelationshipGraphCenterConnectionLabels = "edge" | "node";

export interface ContextRelationshipGraphV1Props {
  centerNode: ContextRelationshipGraphNode;
  nodes: readonly ContextRelationshipGraphNode[];
  edges: readonly ContextRelationshipGraphEdge[];
  title?: string;
  initialMode?: ContextRelationshipGraphMode;
  /** Put first-level roles inside peripheral person cards in simple person-centred graphs. */
  centerConnectionLabels?: ContextRelationshipGraphCenterConnectionLabels;
  maxNodes?: number;
  maxEdges?: number;
  layoutBuilder?: ContextRelationshipGraphLayoutBuilder;
  onNodeSelect?: (node: ContextRelationshipGraphNode) => void;
  onNodeActivate?: (node: ContextRelationshipGraphNode) => void;
  onEdgeSelect?: (edge: ContextRelationshipGraphEdge) => void;
}

interface GraphViewState {
  zoom: number;
  panX: number;
  panY: number;
  yaw: number;
  pitch: number;
}

type GraphSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string };

interface SceneDragState {
  pointerId: number;
  mode: "pan" | "rotate";
  startClientX: number;
  startClientY: number;
  startGraphX: number;
  startGraphY: number;
  panX: number;
  panY: number;
  yaw: number;
  pitch: number;
}

interface NodeDragState {
  pointerId: number;
  nodeId: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

interface GraphNodePresentation {
  node: ContextRelationshipGraphProjectionNode;
  width: number;
  height: number;
  shapeOpacity: number;
  labelLines: string[];
  labelStartY: number;
  footerLines: string[];
  footerStartY: number;
}

interface GraphEdgePresentation {
  edge: ContextRelationshipGraphProjectionEdge;
  path: string;
  labelX: number;
  labelY: number;
  labelWidth: number;
  labelHeight: number;
  labelLines: string[];
  labelAnchorX: number;
  labelAnchorY: number;
  leaderPath?: string;
}

interface GraphRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const DEFAULT_VIEW: GraphViewState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  yaw: -0.52,
  pitch: 0.28,
};

export function ContextRelationshipGraphV1({
  centerNode,
  nodes,
  edges,
  title = "Зв’язки та оточення",
  initialMode = "2d",
  centerConnectionLabels = "edge",
  maxNodes = 120,
  maxEdges = 320,
  layoutBuilder = buildContextRelationshipGraphLayout,
  onNodeSelect,
  onNodeActivate,
  onEdgeSelect,
}: ContextRelationshipGraphV1Props) {
  const headingId = useId();
  const instanceId = useId().replace(/[^a-z0-9_-]/giu, "");
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const sceneGroupRef = useRef<SVGGElement | null>(null);
  const sceneDragState = useRef<SceneDragState | null>(null);
  const nodeDragState = useRef<NodeDragState | null>(null);
  const [mode, setMode] = useState<ContextRelationshipGraphMode>(initialMode);
  const [view, setView] = useState<GraphViewState>(DEFAULT_VIEW);
  const [nodeOffsets, setNodeOffsets] = useState<ContextRelationshipGraphNodeOffsets>({});
  const [sceneDragging, setSceneDragging] = useState(false);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [selection, setSelection] = useState<GraphSelection>({ kind: "node", id: centerNode.id });

  const graph = useMemo(
    () => buildBoundedContextRelationshipGraph(centerNode, nodes, edges, { maxNodes, maxEdges }),
    [centerNode, edges, maxEdges, maxNodes, nodes],
  );
  const layout = useMemo(() => layoutBuilder(graph), [graph, layoutBuilder]);
  const projection = useMemo(() => {
    const projectionView = {
      zoom: 1,
      panX: 0,
      panY: 0,
      yaw: view.yaw,
      pitch: view.pitch,
    };
    const projected = mode === "3d"
      ? projectContextRelationshipGraph3D(layout, projectionView)
      : projectContextRelationshipGraph2D(layout, projectionView);
    return applyContextRelationshipGraphNodeOffsets(projected, nodeOffsets);
  }, [layout, mode, nodeOffsets, view.pitch, view.yaw]);
  const sceneTransform = useMemo(() => [
    `translate(${halfPixel(view.panX)} ${halfPixel(view.panY)})`,
    `translate(${halfPixel(layout.centerX)} ${halfPixel(layout.centerY)})`,
    `scale(${clampGraphZoom(view.zoom)})`,
    `translate(${-halfPixel(layout.centerX)} ${-halfPixel(layout.centerY)})`,
  ].join(" "), [layout.centerX, layout.centerY, view.panX, view.panY, view.zoom]);
  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const centerConnectionByNodeId = useMemo(() => {
    const result = new Map<string, ContextRelationshipGraphEdge>();
    graph.edges.forEach((edge) => {
      if (edge.labelVisibility === "details-only") return;
      if (edge.sourceId === graph.centerNodeId) result.set(edge.targetId, edge);
      else if (edge.targetId === graph.centerNodeId) result.set(edge.sourceId, edge);
    });
    return result;
  }, [graph.centerNodeId, graph.edges]);
  const nodePresentations = useMemo(
    () => projection.nodes.map((node) => buildGraphNodePresentation(
      node,
      node.id === graph.centerNodeId,
      mode,
      node.id === graph.centerNodeId
        ? "центр"
        : centerConnectionLabels === "node" && node.kind === "person"
          ? centerConnectionByNodeId.get(node.id)?.label ?? node.subtitle ?? "особа"
          : node.kind === "group" ? node.subtitle ?? "група" : node.subtitle ?? "особа",
    )),
    [centerConnectionByNodeId, centerConnectionLabels, graph.centerNodeId, mode, projection.nodes],
  );
  const renderedNodePresentations = useMemo(() => {
    if (!draggingNodeId) return nodePresentations;
    const active = nodePresentations.find(({ node }) => node.id === draggingNodeId);
    if (!active) return nodePresentations;
    return [
      ...nodePresentations.filter(({ node }) => node.id !== draggingNodeId),
      active,
    ];
  }, [draggingNodeId, nodePresentations]);
  const visibleEdgeLabelIds = useMemo(() => new Set(
    projection.edges
      .filter((edge) => {
        if (edge.labelVisibility === "details-only") return false;
        if (centerConnectionLabels === "edge") return true;
        return edge.sourceId !== graph.centerNodeId && edge.targetId !== graph.centerNodeId;
      })
      .map((edge) => edge.id),
  ), [centerConnectionLabels, graph.centerNodeId, projection.edges]);
  const edgePresentations = useMemo(
    () => buildGraphEdgePresentations(
      projection.edges,
      nodePresentations,
      visibleEdgeLabelIds,
      { width: layout.width, height: layout.height },
    ),
    [layout.height, layout.width, nodePresentations, projection.edges, visibleEdgeLabelIds],
  );
  const selectedNode = selection.kind === "node"
    ? nodesById.get(selection.id)
    : undefined;
  const selectedEdge = selection.kind === "edge"
    ? graph.edges.find((edge) => edge.id === selection.id)
    : undefined;

  useEffect(() => {
    setSelection({ kind: "node", id: centerNode.id });
    setView(DEFAULT_VIEW);
    setNodeOffsets({});
    sceneDragState.current = null;
    nodeDragState.current = null;
    setSceneDragging(false);
    setDraggingNodeId(null);
  }, [centerNode.id]);

  useEffect(() => {
    if (selection.kind === "node" && nodesById.has(selection.id)) return;
    if (selection.kind === "edge" && graph.edges.some((edge) => edge.id === selection.id)) return;
    setSelection({ kind: "node", id: centerNode.id });
  }, [centerNode.id, graph.edges, nodesById, selection]);

  useEffect(() => {
    const updateFullscreenState = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleCanvasWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const deltaUnit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(1, canvas.clientHeight)
          : 1;
      const pixelDelta = clamp(event.deltaY * deltaUnit, -220, 220);
      const factor = clamp(Math.exp(-pixelDelta * 0.0011), 0.84, 1.18);
      setView((current) => ({ ...current, zoom: clampGraphZoom(current.zoom * factor) }));
    };
    canvas.addEventListener("wheel", handleCanvasWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleCanvasWheel);
  }, []);

  const resetCamera = () => setView(DEFAULT_VIEW);
  const resetView = () => {
    setView(DEFAULT_VIEW);
    setNodeOffsets({});
  };
  const changeZoom = (factor: number) => {
    setView((current) => ({ ...current, zoom: clampGraphZoom(current.zoom * factor) }));
  };
  const selectNode = (node: ContextRelationshipGraphNode) => {
    setSelection({ kind: "node", id: node.id });
    onNodeSelect?.(node);
  };
  const selectEdge = (edge: ContextRelationshipGraphEdge) => {
    setSelection({ kind: "edge", id: edge.id });
    onEdgeSelect?.(edge);
  };

  const handleKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const zoomIn = event.key === "+" || event.key === "=" || event.key === "Add";
    const zoomOut = event.key === "-" || event.key === "_" || event.key === "Subtract";
    if (zoomIn || zoomOut) {
      event.preventDefault();
      changeZoom(zoomIn ? 1.12 : 1 / 1.12);
      return;
    }
    if (event.key === "Home" || event.key === "0") {
      event.preventDefault();
      resetView();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    setView((current) => {
      if (mode === "3d") {
        const yawDelta = event.key === "ArrowLeft" ? -0.1 : event.key === "ArrowRight" ? 0.1 : 0;
        const pitchDelta = event.key === "ArrowUp" ? -0.08 : event.key === "ArrowDown" ? 0.08 : 0;
        return {
          ...current,
          yaw: current.yaw + yawDelta,
          pitch: clamp(current.pitch + pitchDelta, -1.25, 1.25),
        };
      }
      const step = 24;
      return {
        ...current,
        panX: current.panX + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
        panY: current.panY + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
      };
    });
  };

  const startSceneDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || sceneDragState.current || nodeDragState.current) return;
    event.preventDefault();
    const point = graphPointerPoint(event.currentTarget, event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    sceneDragState.current = {
      pointerId: event.pointerId,
      mode: mode === "3d" && event.shiftKey ? "rotate" : "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startGraphX: point.x,
      startGraphY: point.y,
      panX: view.panX,
      panY: view.panY,
      yaw: view.yaw,
      pitch: view.pitch,
    };
    setSceneDragging(true);
  };
  const updateSceneDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = sceneDragState.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (start.mode === "rotate" && mode === "3d") {
      const yaw = start.yaw + (event.clientX - start.startClientX) * 0.009;
      const pitch = clamp(start.pitch + (event.clientY - start.startClientY) * 0.007, -1.25, 1.25);
      setView((current) => ({ ...current, yaw, pitch }));
      return;
    }
    const point = graphPointerPoint(event.currentTarget, event.clientX, event.clientY);
    setView((current) => ({
      ...current,
      panX: start.panX + point.x - start.startGraphX,
      panY: start.panY + point.y - start.startGraphY,
    }));
  };
  const finishSceneDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (sceneDragState.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    sceneDragState.current = null;
    setSceneDragging(false);
  };
  const startNodeDrag = (
    nodeId: string,
    event: ReactPointerEvent<SVGGElement>,
  ) => {
    if (event.button !== 0 || nodeDragState.current || sceneDragState.current) return;
    const sceneGroup = sceneGroupRef.current;
    if (!sceneGroup) return;
    event.preventDefault();
    event.stopPropagation();
    const point = graphPointerPoint(sceneGroup, event.clientX, event.clientY);
    const currentOffset = nodeOffsets[nodeId] ?? { x: 0, y: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    nodeDragState.current = {
      pointerId: event.pointerId,
      nodeId,
      startX: point.x,
      startY: point.y,
      offsetX: currentOffset.x,
      offsetY: currentOffset.y,
    };
    setDraggingNodeId(nodeId);
  };
  const updateNodeDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const start = nodeDragState.current;
    const sceneGroup = sceneGroupRef.current;
    if (!start || start.pointerId !== event.pointerId || !sceneGroup) return;
    event.preventDefault();
    event.stopPropagation();
    const point = graphPointerPoint(sceneGroup, event.clientX, event.clientY);
    setNodeOffsets((current) => ({
      ...current,
      [start.nodeId]: {
        x: halfPixel(start.offsetX + point.x - start.startX),
        y: halfPixel(start.offsetY + point.y - start.startY),
      },
    }));
  };
  const finishNodeDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const start = nodeDragState.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    nodeDragState.current = null;
    setDraggingNodeId(null);
  };
  const toggleFullscreen = async () => {
    const element = rootRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement === element) {
        await document.exitFullscreen();
      } else if (element.requestFullscreen) {
        await element.requestFullscreen();
      } else {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <section ref={rootRef} className="context-relationship-graph-v1" aria-labelledby={headingId}>
      <header className="context-relationship-graph-v1__toolbar" aria-label="Назва і керування графом">
        <div className="context-relationship-graph-v1__title">
          <h2 id={headingId}>{title}</h2>
          <span>Центр: {centerNode.label}</span>
        </div>
        <div className="context-relationship-graph-v1__controls">
          <div className="context-relationship-graph-v1__mode" aria-label="Режим відображення">
            {(["2d", "3d"] as const).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                aria-pressed={mode === nextMode}
                onClick={() => {
                  setMode(nextMode);
                  resetCamera();
                }}
              >
                {nextMode === "2d" ? "2D" : "3D"}
              </button>
            ))}
          </div>
          <div className="context-relationship-graph-v1__zoom" aria-label="Масштаб графа">
            <button type="button" onClick={() => changeZoom(1 / 1.12)} aria-label="Зменшити масштаб">−</button>
            <output aria-live="polite">{Math.round(view.zoom * 100)}%</output>
            <button type="button" onClick={() => changeZoom(1.12)} aria-label="Збільшити масштаб">+</button>
          </div>
          <button
            type="button"
            className="context-relationship-graph-v1__reset"
            onClick={resetView}
            aria-label="Підігнати й скинути"
            title="Повернути початковий масштаб і положення"
          >
            Скинути
          </button>
          <button
            type="button"
            className="context-relationship-graph-v1__fullscreen"
            onClick={() => void toggleFullscreen()}
            aria-label={fullscreen ? "Вийти з повноекранного режиму" : "Розгорнути граф на весь екран"}
            title={fullscreen ? "Вийти з повноекранного режиму" : "На весь екран"}
          >
            <span aria-hidden="true">{fullscreen ? "↙" : "⛶"}</span>
          </button>
        </div>
      </header>

      {(graph.omittedNodeCount || graph.omittedEdgeCount) ? (
        <p className="context-relationship-graph-v1__limit" role="status">
          Для швидкої роботи приховано: {graph.omittedNodeCount} вузлів і {graph.omittedEdgeCount} зв’язків.
        </p>
      ) : null}

      <div className="context-relationship-graph-v1__workspace">
        <div
          ref={canvasRef}
          className={`context-relationship-graph-v1__canvas is-${mode}${sceneDragging || draggingNodeId ? " is-dragging" : ""}${sceneDragging ? " is-dragging-scene" : ""}${draggingNodeId ? " is-dragging-node" : ""}`}
          role="application"
          aria-label={`${mode.toUpperCase()} граф зв’язків. Використовуйте стрілки, плюс, мінус і Home.`}
          tabIndex={0}
          onKeyDown={handleKeyboard}
        >
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            onPointerDown={startSceneDrag}
            onPointerMove={updateSceneDrag}
            onPointerUp={finishSceneDrag}
            onPointerCancel={finishSceneDrag}
            onLostPointerCapture={finishSceneDrag}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <marker
                id={`${instanceId}-arrow`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            <g
              ref={sceneGroupRef}
              className="context-relationship-graph-v1__scene"
              transform={sceneTransform}
            >
              <g className="context-relationship-graph-v1__edges">
              {edgePresentations.map((presentation) => {
                const { edge } = presentation;
                const showLabel = visibleEdgeLabelIds.has(edge.id);
                return (
                  <g
                    key={edge.id}
                    className={`context-relationship-graph-v1__edge${edge.lineStyle === "dashed" ? " is-dashed" : ""}${selection.kind === "edge" && selection.id === edge.id ? " is-selected" : ""}`}
                    data-edge-id={edge.id}
                    data-source-id={edge.sourceId}
                    data-target-id={edge.targetId}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectEdge(edge);
                    }}
                  >
                    <path
                      className="context-relationship-graph-v1__edge-line"
                      d={presentation.path}
                      markerEnd={edge.directed ? `url(#${instanceId}-arrow)` : undefined}
                      style={{ opacity: Math.max(0.56, edge.opacity) }}
                    />
                    <path className="context-relationship-graph-v1__edge-hit" d={presentation.path} />
                    {showLabel ? (
                      <>
                        {presentation.leaderPath ? (
                          <path
                            className="context-relationship-graph-v1__edge-label-leader"
                            d={presentation.leaderPath}
                          />
                        ) : null}
                        <g
                          className="context-relationship-graph-v1__edge-label-card"
                          transform={`translate(${presentation.labelX} ${presentation.labelY})`}
                        >
                          <title>{edge.label}</title>
                          <rect
                            x={-presentation.labelWidth / 2}
                            y={-presentation.labelHeight / 2}
                            width={presentation.labelWidth}
                            height={presentation.labelHeight}
                            rx="8"
                          />
                          <text
                            textAnchor="middle"
                            y={presentation.labelLines.length === 1 ? 4.5 : -4.5}
                          >
                            {presentation.labelLines.map((line, index) => (
                              <tspan key={`${edge.id}-label-${index}`} x="0" dy={index ? 15 : 0}>
                                {line}
                              </tspan>
                            ))}
                          </text>
                        </g>
                      </>
                    ) : (
                      <title>{edge.label}</title>
                    )}
                  </g>
                );
              })}
            </g>
            <g className="context-relationship-graph-v1__nodes">
              {renderedNodePresentations.map((presentation) => {
                const { node } = presentation;
                const isCenter = node.id === graph.centerNodeId;
                const selected = selection.kind === "node" && selection.id === node.id;
                const nodeStyle = {
                  "--context-relationship-node-color": node.color,
                } as CSSProperties;
                return (
                  <g
                    key={node.id}
                    className={`context-relationship-graph-v1__node is-${node.kind}${isCenter ? " is-center" : ""}${selected ? " is-selected" : ""}${draggingNodeId === node.id ? " is-dragging" : ""}`}
                    data-node-id={node.id}
                    transform={`translate(${halfPixel(node.screenX)} ${halfPixel(node.screenY)})`}
                    style={nodeStyle}
                    onPointerDown={(event) => startNodeDrag(node.id, event)}
                    onPointerMove={updateNodeDrag}
                    onPointerUp={finishNodeDrag}
                    onPointerCancel={finishNodeDrag}
                    onLostPointerCapture={finishNodeDrag}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectNode(node);
                    }}
                  >
                    <title>{node.label}</title>
                    <rect
                      className="context-relationship-graph-v1__node-card"
                      x={-presentation.width / 2}
                      y={-presentation.height / 2}
                      width={presentation.width}
                      height={presentation.height}
                      rx={node.kind === "group" ? 11 : 10}
                      style={{ opacity: presentation.shapeOpacity }}
                    />
                    <rect
                      className="context-relationship-graph-v1__node-accent"
                      x={-presentation.width / 2 + 6}
                      y={-presentation.height / 2 + 8}
                      width="4"
                      height={presentation.height - 16}
                      rx="2"
                    />
                    <text
                      className="context-relationship-graph-v1__node-label"
                      textAnchor="middle"
                      y={presentation.labelStartY}
                    >
                      {presentation.labelLines.map((line, index) => (
                        <tspan key={`${node.id}-name-${index}`} x="0" dy={index ? 13 : 0}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                    <text
                      className={`context-relationship-graph-v1__node-kind${!isCenter && centerConnectionLabels === "node" && centerConnectionByNodeId.has(node.id) ? " is-role" : ""}`}
                      textAnchor="middle"
                      y={presentation.footerStartY}
                    >
                      {presentation.footerLines.map((line, index) => (
                        <tspan key={`${node.id}-footer-${index}`} x="0" dy={index ? 10 : 0}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                  </g>
                );
              })}
            </g>
            </g>
          </svg>
          <p className="context-relationship-graph-v1__canvas-help">
            {mode === "3d"
              ? "Картку — окремо · тло — весь граф · Shift + тло — обертання · коліщатко — масштаб"
              : "Картку — окремо · тло — весь граф · коліщатко — масштаб"}
          </p>
        </div>

        <aside className="context-relationship-graph-v1__details" aria-live="polite">
          {selectedNode ? (
            <NodeDetails
              node={selectedNode}
              center={selectedNode.id === graph.centerNodeId}
              edges={graph.edges.filter((edge) => edge.sourceId === selectedNode.id || edge.targetId === selectedNode.id)}
              nodesById={nodesById}
              onActivate={onNodeActivate}
            />
          ) : selectedEdge ? (
            <EdgeDetails edge={selectedEdge} nodesById={nodesById} />
          ) : (
            <p>Оберіть людину, групу або підписаний зв’язок.</p>
          )}
        </aside>
      </div>

      <details className="context-relationship-graph-v1__fallback">
        <summary>Текстовий список людей, груп і зв’язків</summary>
        <div>
          <section aria-labelledby={`${instanceId}-nodes-title`}>
            <h3 id={`${instanceId}-nodes-title`}>Люди та групи</h3>
            <ul>
              {graph.nodes.map((node) => (
                <li key={node.id}>
                  <button type="button" onClick={() => selectNode(node)}>
                    <strong>{node.label}</strong>
                    <span>{node.id === graph.centerNodeId ? "Центр" : node.kind === "group" ? "Група" : "Особа"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby={`${instanceId}-edges-title`}>
            <h3 id={`${instanceId}-edges-title`}>Зв’язки</h3>
            <ul>
              {graph.edges.map((edge) => (
                <li key={edge.id}>
                  <button type="button" onClick={() => selectEdge(edge)}>
                    <strong>{edge.label}</strong>
                    <span>{nodesById.get(edge.sourceId)?.label} → {nodesById.get(edge.targetId)?.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </details>
    </section>
  );
}

function NodeDetails({
  node,
  center,
  edges,
  nodesById,
  onActivate,
}: {
  node: ContextRelationshipGraphNode;
  center: boolean;
  edges: readonly ContextRelationshipGraphEdge[];
  nodesById: ReadonlyMap<string, ContextRelationshipGraphNode>;
  onActivate?: (node: ContextRelationshipGraphNode) => void;
}) {
  return (
    <>
      <span className="context-relationship-graph-v1__details-eyebrow">
        {center ? "Центральна особа" : node.kind === "group" ? "Група" : "Особа"}
      </span>
      <h3>{node.label}</h3>
      {node.subtitle ? <p>{node.subtitle}</p> : null}
      {node.description ? <p>{node.description}</p> : null}
      <dl>
        <div><dt>Видимих зв’язків</dt><dd>{edges.length}</dd></div>
      </dl>
      {edges.length ? (
        <ul className="context-relationship-graph-v1__details-relations">
          {edges.slice(0, 6).map((edge) => {
            const otherId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
            return <li key={edge.id}><strong>{edge.label}</strong><span>{nodesById.get(otherId)?.label ?? otherId}</span></li>;
          })}
        </ul>
      ) : null}
      {onActivate && node.kind === "person" && node.activatable !== false ? (
        <button type="button" onClick={() => onActivate(node)}>Відкрити картку</button>
      ) : null}
    </>
  );
}

function EdgeDetails({
  edge,
  nodesById,
}: {
  edge: ContextRelationshipGraphEdge;
  nodesById: ReadonlyMap<string, ContextRelationshipGraphNode>;
}) {
  const sourceNode = nodesById.get(edge.sourceId);
  const targetNode = nodesById.get(edge.targetId);
  const sourceLabel = sourceNode?.label ?? edge.sourceId;
  const targetLabel = targetNode?.label ?? edge.targetId;
  const relationshipKind = sourceNode?.kind === "group" && targetNode?.kind === "group"
    ? "Зв’язок між групами прізвищ"
    : sourceNode?.kind === "group" || targetNode?.kind === "group"
      ? "Належність особи до групи"
      : "Зв’язок між людьми";
  const roleSummaries = edge.roles ?? [{ label: edge.label, count: edge.members?.length ?? 1 }];
  return (
    <>
      <span className="context-relationship-graph-v1__details-eyebrow">{relationshipKind}</span>
      <h3>{sourceLabel} — {targetLabel}</h3>
      <ul className="context-relationship-graph-v1__details-relations">
        {roleSummaries.map((role) => (
          <li key={role.label}>
            <strong>{role.label}</strong>
            <span>{role.count} {pluralizeVisibleRecords(role.count)}</span>
          </li>
        ))}
      </ul>
      {edge.members?.length ? (
        <p>Об’єднано {edge.members.length} {pluralizeVisibleRecords(edge.members.length)} з окремими доказами.</p>
      ) : null}
      {edge.description ? <p>{edge.description}</p> : null}
    </>
  );
}

function graphPointerPoint(
  element: SVGGraphicsElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const svg = element instanceof SVGSVGElement ? element : element.ownerSVGElement;
  const matrix = element.getScreenCTM();
  if (svg && matrix) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }
  const rect = element.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function buildGraphNodePresentation(
  node: ContextRelationshipGraphProjectionNode,
  center: boolean,
  mode: ContextRelationshipGraphMode,
  footerText: string,
): GraphNodePresentation {
  const maximumLines = node.kind === "group" ? 2 : 3;
  const maximumCharacters = node.kind === "group" ? 22 : 20;
  const labelLines = wrapContextRelationshipGraphLabel(
    node.label,
    maximumCharacters,
    maximumLines,
  ).lines;
  const footerLines = wrapContextRelationshipGraphLabel(footerText, 24, 2).lines;
  const baseWidth = center ? 170 : node.kind === "group" ? 150 : 158;
  const baseHeight = center ? 74 : node.kind === "group" ? 68 : footerLines.length > 1 ? 82 : 72;
  const longestNameLine = Math.max(...labelLines.map((line) => line.length), 1);
  const longestFooterLine = Math.max(...footerLines.map((line) => line.length), 1);
  const contentWidth = Math.max(
    longestNameLine * (node.kind === "group" ? 5.7 : 5.9) + 28,
    longestFooterLine * 4.7 + 28,
  );
  const contentHeight = 25 + labelLines.length * 13 + footerLines.length * 10;
  const depthScale = mode === "3d"
    ? clamp(0.92 + (node.scale - 1) * 0.55, 0.82, 1.18)
    : 1;
  const naturalWidth = clamp(
    Math.max(baseWidth, contentWidth),
    node.kind === "group" ? 142 : center ? 158 : 146,
    node.kind === "group" ? 176 : center ? 196 : 184,
  );
  const naturalHeight = clamp(
    Math.max(baseHeight, contentHeight),
    node.kind === "group" ? 64 : 68,
    node.kind === "group" ? 88 : 94,
  );
  const width = halfPixel(naturalWidth * depthScale);
  const height = halfPixel(naturalHeight * depthScale);
  return {
    node,
    width,
    height,
    shapeOpacity: center ? 1 : mode === "3d" ? clamp(node.opacity, 0.74, 1) : 1,
    labelLines,
    labelStartY: -8 - (labelLines.length - 1) * 6.5,
    footerLines,
    footerStartY: height / 2 - (footerLines.length > 1 ? 19 : 10),
  };
}

function buildGraphEdgePresentations(
  edges: readonly ContextRelationshipGraphProjectionEdge[],
  nodes: readonly GraphNodePresentation[],
  visibleLabelIds: ReadonlySet<string>,
  bounds: { width: number; height: number },
): GraphEdgePresentation[] {
  const nodesById = new Map(nodes.map((presentation) => [presentation.node.id, presentation]));
  const nodeObstacles = nodes.map((presentation) => graphRect(
    presentation.node.screenX,
    presentation.node.screenY,
    presentation.width + 14,
    presentation.height + 14,
  ));
  const occupiedLabels: GraphRect[] = [];
  const presentations = new Map<string, GraphEdgePresentation>();

  [...edges].sort((left, right) => left.id.localeCompare(right.id, "uk")).forEach((edge) => {
    const source = nodesById.get(edge.sourceId);
    const target = nodesById.get(edge.targetId);
    if (!source || !target) return;
    const labelLines = wrapContextRelationshipGraphLabel(edge.label, 28, 2).lines;
    const longestLine = Math.max(...labelLines.map((line) => line.length), 1);
    const labelWidth = halfPixel(clamp(longestLine * 7.2 + 24, 94, 236));
    const labelHeight = labelLines.length > 1 ? 47 : 30;
    const labelVisible = visibleLabelIds.has(edge.id);

    if (edge.sourceId === edge.targetId) {
      const x = source.node.screenX;
      const y = source.node.screenY;
      const labelX = halfPixel(x + source.width / 2 + labelWidth / 2 + 28);
      const labelY = halfPixel(y - source.height / 2 - 36);
      if (labelVisible) occupiedLabels.push(graphRect(labelX, labelY, labelWidth, labelHeight));
      presentations.set(edge.id, {
        edge,
        path: [
          `M ${halfPixel(x + source.width / 2 - 8)} ${halfPixel(y - 18)}`,
          `C ${halfPixel(x + source.width / 2 + 78)} ${halfPixel(y - 92)},`,
          `${halfPixel(x + source.width / 2 + 78)} ${halfPixel(y + 92)},`,
          `${halfPixel(x + source.width / 2 - 8)} ${halfPixel(y + 18)}`,
        ].join(" "),
        labelX,
        labelY,
        labelWidth,
        labelHeight,
        labelLines,
        labelAnchorX: labelX,
        labelAnchorY: labelY,
      });
      return;
    }

    const endpoints = trimmedCardEdge(source, target);
    const path = `M ${endpoints.sourceX} ${endpoints.sourceY} L ${endpoints.targetX} ${endpoints.targetY}`;
    const deltaX = endpoints.targetX - endpoints.sourceX;
    const deltaY = endpoints.targetY - endpoints.sourceY;
    const length = Math.max(1, Math.hypot(deltaX, deltaY));
    let normalX = -deltaY / length;
    let normalY = deltaX / length;
    if (normalX < 0 || (Math.abs(normalX) < 0.0001 && normalY < 0)) {
      normalX *= -1;
      normalY *= -1;
    }
    const midpointX = (endpoints.sourceX + endpoints.targetX) / 2;
    const midpointY = (endpoints.sourceY + endpoints.targetY) / 2;
    if (!labelVisible) {
      presentations.set(edge.id, {
        edge,
        path,
        labelX: halfPixel(midpointX),
        labelY: halfPixel(midpointY),
        labelWidth,
        labelHeight,
        labelLines,
        labelAnchorX: halfPixel(midpointX),
        labelAnchorY: halfPixel(midpointY),
      });
      return;
    }
    const tangentX = deltaX / length;
    const tangentY = deltaY / length;
    const preferredSide = stableVisualHash(edge.id) % 2 ? 1 : -1;
    const candidateOffsets = graphLabelCandidateOffsets(preferredSide, labelWidth, labelHeight);
    let labelX = midpointX;
    let labelY = midpointY;
    let labelRect = graphRect(labelX, labelY, labelWidth, labelHeight);
    let bestScore = Number.POSITIVE_INFINITY;
    let placed = false;
    for (const offset of candidateOffsets) {
      const candidateX = halfPixel(clamp(
        midpointX + normalX * offset.normal + tangentX * offset.tangent,
        labelWidth / 2 + 12,
        bounds.width - labelWidth / 2 - 12,
      ));
      const candidateY = halfPixel(clamp(
        midpointY + normalY * offset.normal + tangentY * offset.tangent,
        labelHeight / 2 + 12,
        bounds.height - labelHeight / 2 - 12,
      ));
      const candidateRect = graphRect(candidateX, candidateY, labelWidth, labelHeight);
      const touchesNode = nodeObstacles.some((obstacle) => rectsIntersect(candidateRect, obstacle));
      const touchesLabel = occupiedLabels.some((obstacle) => (
        rectsIntersect(candidateRect, inflateGraphRect(obstacle, 7))
      ));
      const score = nodeObstacles.reduce(
        (total, obstacle) => total + graphRectIntersectionArea(candidateRect, obstacle) * 2,
        0,
      ) + occupiedLabels.reduce(
        (total, obstacle) => total + graphRectIntersectionArea(candidateRect, inflateGraphRect(obstacle, 7)) * 4,
        0,
      ) + Math.hypot(candidateX - midpointX, candidateY - midpointY) * 0.02;
      if (score < bestScore) {
        bestScore = score;
        labelX = candidateX;
        labelY = candidateY;
        labelRect = candidateRect;
      }
      if (!touchesNode && !touchesLabel) {
        labelX = candidateX;
        labelY = candidateY;
        labelRect = candidateRect;
        placed = true;
        break;
      }
    }
    occupiedLabels.push(labelRect);
    const leaderDistance = Math.hypot(labelX - midpointX, labelY - midpointY);
    presentations.set(edge.id, {
      edge,
      path,
      labelX,
      labelY,
      labelWidth,
      labelHeight,
      labelLines,
      labelAnchorX: halfPixel(midpointX),
      labelAnchorY: halfPixel(midpointY),
      leaderPath: leaderDistance > 2
        ? `M ${halfPixel(midpointX)} ${halfPixel(midpointY)} L ${labelX} ${labelY}`
        : undefined,
    });
  });

  return edges.flatMap((edge) => {
    const presentation = presentations.get(edge.id);
    return presentation ? [presentation] : [];
  });
}

function graphLabelCandidateOffsets(
  preferredSide: number,
  labelWidth: number,
  labelHeight: number,
): Array<{ normal: number; tangent: number }> {
  const normalStep = Math.max(38, labelHeight + 12);
  const tangentStep = Math.max(52, Math.min(112, labelWidth * 0.48));
  const normalUnits = [0, preferredSide, -preferredSide, preferredSide * 2, -preferredSide * 2, preferredSide * 3, -preferredSide * 3, preferredSide * 4, -preferredSide * 4];
  const tangentUnits = [0, 1, -1, 2, -2, 3, -3];
  return normalUnits.flatMap((normalUnit) => tangentUnits.map((tangentUnit) => ({
    normal: normalUnit * normalStep,
    tangent: tangentUnit * tangentStep,
  }))).sort((left, right) => (
    Math.max(Math.abs(left.normal / normalStep), Math.abs(left.tangent / tangentStep))
      - Math.max(Math.abs(right.normal / normalStep), Math.abs(right.tangent / tangentStep))
    || Math.abs(left.normal) + Math.abs(left.tangent) - Math.abs(right.normal) - Math.abs(right.tangent)
  ));
}

function trimmedCardEdge(
  source: GraphNodePresentation,
  target: GraphNodePresentation,
): { sourceX: number; sourceY: number; targetX: number; targetY: number } {
  const deltaX = target.node.screenX - source.node.screenX;
  const deltaY = target.node.screenY - source.node.screenY;
  const sourceParameter = cardBoundaryParameter(deltaX, deltaY, source.width / 2 + 5, source.height / 2 + 5);
  const targetParameter = cardBoundaryParameter(deltaX, deltaY, target.width / 2 + 5, target.height / 2 + 5);
  const safeSource = Math.min(sourceParameter, 0.44);
  const safeTarget = Math.min(targetParameter, 0.44);
  return {
    sourceX: halfPixel(source.node.screenX + deltaX * safeSource),
    sourceY: halfPixel(source.node.screenY + deltaY * safeSource),
    targetX: halfPixel(target.node.screenX - deltaX * safeTarget),
    targetY: halfPixel(target.node.screenY - deltaY * safeTarget),
  };
}

function cardBoundaryParameter(deltaX: number, deltaY: number, radiusX: number, radiusY: number): number {
  const scale = Math.max(
    Math.abs(deltaX) / Math.max(1, radiusX),
    Math.abs(deltaY) / Math.max(1, radiusY),
  );
  return scale > 0 ? 1 / scale : 0;
}

function graphRect(x: number, y: number, width: number, height: number): GraphRect {
  return {
    left: x - width / 2,
    top: y - height / 2,
    right: x + width / 2,
    bottom: y + height / 2,
  };
}

function inflateGraphRect(rect: GraphRect, amount: number): GraphRect {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
  };
}

function rectsIntersect(left: GraphRect, right: GraphRect): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

function graphRectIntersectionArea(left: GraphRect, right: GraphRect): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function stableVisualHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function halfPixel(value: number): number {
  return Math.round(value * 2) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pluralizeVisibleRecords(count: number): string {
  const absolute = Math.abs(Math.trunc(count));
  const mod100 = absolute % 100;
  if (mod100 >= 11 && mod100 <= 14) return "записів";
  const mod10 = absolute % 10;
  if (mod10 === 1) return "запис";
  if (mod10 >= 2 && mod10 <= 4) return "записи";
  return "записів";
}
