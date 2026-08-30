import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getSharedResearchGraphView } from "../../services/contextRelationsService.ts";
import type {
  ResearchGraphEdge,
  ResearchGraphNode,
  ResearchGraphNodeId,
  SharedResearchGraphView,
} from "../../types/contextGraph.ts";
import { isResearchGraphShareToken } from "../../utils/appRoutes.ts";
import { buildResearchGraphLayout } from "./researchGraphModel.ts";
import {
  clampResearchGraphZoom,
  clampResearchGraphViewport,
  RESEARCH_GRAPH_MAX_ZOOM,
  RESEARCH_GRAPH_MIN_ZOOM,
  RESEARCH_GRAPH_ZOOM_STEP,
} from "./researchGraphSavedViewModel.ts";
import "./SharedResearchGraphPage.css";

export interface SharedResearchGraphPageProps {
  token: string;
}

/** Anonymous, server-sanitized and deliberately action-free graph viewer. */
export function SharedResearchGraphPage({ token }: SharedResearchGraphPageProps) {
  const headingId = useId();
  const markerId = useId().replace(/:/gu, "");
  const requestSequence = useRef(0);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pendingViewport = useRef<SharedResearchGraphView["view"]["viewport"] | null>(null);
  const [sharedView, setSharedView] = useState<SharedResearchGraphView | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    setSharedView(null);
    setSelectedNodeId("");
    if (!isResearchGraphShareToken(token)) {
      setLoading(false);
      setError(INACTIVE_LINK_MESSAGE);
      return;
    }
    try {
      const result = await getSharedResearchGraphView(token);
      if (sequence !== requestSequence.current) return;
      if (Date.parse(result.share.expiresAt) <= Date.now()) {
        setError(INACTIVE_LINK_MESSAGE);
        return;
      }
      setSharedView(result);
      setSelectedNodeId(result.graph.centerNodeId);
      setZoom(clampResearchGraphZoom(result.view.zoom));
      pendingViewport.current = result.view.viewport;
    } catch {
      if (sequence === requestSequence.current) setError(INACTIVE_LINK_MESSAGE);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { requestSequence.current += 1; };
    // `load` intentionally belongs to this exact opaque token only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const layout = useMemo(() => {
    if (!sharedView) return null;
    const nodes = sharedView.graph.nodes.map(toLayoutNode);
    const edges = sharedView.graph.edges.map(toLayoutEdge);
    return buildResearchGraphLayout(nodes, edges, sharedView.view.layoutId);
  }, [sharedView]);
  const selectedNode = sharedView?.graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdges = selectedNode && sharedView
    ? sharedView.graph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    : [];

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = pendingViewport.current;
    if (!canvas || !layout || !viewport) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const clamped = clampResearchGraphViewport(viewport, {
        scrollWidth: canvas.scrollWidth,
        scrollHeight: canvas.scrollHeight,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
      });
      canvas.scrollTo({ left: clamped.x, top: clamped.y });
      pendingViewport.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layout, zoom]);

  const changeZoom = (delta: number) => setZoom((current) => clampResearchGraphZoom(current + delta));
  const handleKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      changeZoom(RESEARCH_GRAPH_ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      changeZoom(-RESEARCH_GRAPH_ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      setZoom(1);
      event.currentTarget.scrollTo({ left: 0, top: 0 });
    }
  };

  return (
    <main className="shared-research-graph" aria-labelledby={headingId}>
      <header className="shared-research-graph__header">
        <span>Трекер Роду · доступ лише для перегляду</span>
        <h1 id={headingId}>{sharedView?.view.title || "Спільний дослідницький граф"}</h1>
        <p>Це окремий публічний зріз, а не доступ до проєкту чи карток осіб.</p>
      </header>

      <div className="shared-research-graph__privacy" role="note">
        <strong>Приватність застосована сервером.</strong>
        Відображаються лише явно публічні померлі особи із записаною датою смерті.
        Живі особи, непублічні записи та пов’язані з ними зв’язки повністю вилучені з цього перегляду.
      </div>

      {loading ? (
        <section className="shared-research-graph__state" role="status">
          <span className="shared-research-graph__spinner" aria-hidden="true" />
          <strong>Завантажуємо безпечний зріз графа…</strong>
        </section>
      ) : error || !sharedView || !layout ? (
        <section className="shared-research-graph__state is-error" role="alert">
          <strong>{INACTIVE_LINK_MESSAGE}</strong>
          <p>Попросіть власника проєкту створити нове посилання.</p>
        </section>
      ) : (
        <>
          <section className="shared-research-graph__summary" aria-label="Відомості про спільний граф">
            <span><b>{sharedView.graph.nodes.length}</b> публічних вузлів</span>
            <span><b>{sharedView.graph.edges.length}</b> публічних зв’язків</span>
            <span>Посилання діє до <b>{dateTimeLabel(sharedView.share.expiresAt)}</b></span>
          </section>

          <section className="shared-research-graph__workspace">
            <div className="shared-research-graph__graph-column">
              <div className="shared-research-graph__tools" aria-label="Масштаб графа">
                <span>{sharedLayoutLabel(sharedView.view.layoutId)}</span>
                <div>
                  <button
                    type="button"
                    aria-label="Зменшити масштаб графа"
                    onClick={() => changeZoom(-RESEARCH_GRAPH_ZOOM_STEP)}
                    disabled={zoom <= RESEARCH_GRAPH_MIN_ZOOM}
                  >−</button>
                  <output aria-live="polite">{Math.round(zoom * 100)}%</output>
                  <button
                    type="button"
                    aria-label="Збільшити масштаб графа"
                    onClick={() => changeZoom(RESEARCH_GRAPH_ZOOM_STEP)}
                    disabled={zoom >= RESEARCH_GRAPH_MAX_ZOOM}
                  >+</button>
                  <button type="button" onClick={() => setZoom(1)}>100%</button>
                </div>
              </div>
              <div
                ref={canvasRef}
                className="shared-research-graph__canvas"
                role="region"
                aria-label={`Публічний дослідницький граф · ${sharedLayoutLabel(sharedView.view.layoutId)}`}
                tabIndex={0}
                onKeyDown={handleKeyboard}
              >
                <svg
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  style={{
                    minWidth: `${Math.round(Math.max(760, layout.width) * zoom)}px`,
                    width: `${Math.round(Math.max(760, layout.width) * zoom)}px`,
                  }}
                  role="img"
                  aria-label={`${layout.nodes.length} публічних вузлів і ${layout.edges.length} зв’язків`}
                >
                  <defs>
                    <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" className="shared-research-graph__arrow" />
                    </marker>
                  </defs>
                  <g className="shared-research-graph__edges" aria-hidden="true">
                    {layout.edges.map((edge) => (
                      <path
                        key={edge.id}
                        d={edge.path}
                        className={`is-${edge.evidenceStatus}${edge.assertionKind === "research_hypothesis" ? " is-hypothesis" : ""}`}
                        markerEnd={edge.directionality === "directed" ? `url(#${markerId})` : undefined}
                      />
                    ))}
                  </g>
                  {layout.nodes.map((node) => (
                    <g
                      key={node.id}
                      className={`shared-research-graph__node is-${node.entityType}${node.isCenter ? " is-center" : ""}${node.id === selectedNodeId ? " is-selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={node.id === selectedNodeId}
                      aria-label={`${entityTypeLabel(node.entityType)}: ${node.label}`}
                      onClick={() => setSelectedNodeId(node.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedNodeId(node.id);
                        }
                      }}
                    >
                      {node.isCenter ? (
                        <circle cx={node.x} cy={node.y} r={node.height / 2} />
                      ) : (
                        <rect x={node.x - node.width / 2} y={node.y - node.height / 2} width={node.width} height={node.height} rx="24" />
                      )}
                      <text x={node.x} y={node.y - 2} textAnchor="middle">{compactLabel(node.label, 19)}</text>
                      {node.secondaryLabel ? (
                        <text className="is-secondary" x={node.x} y={node.y + 17} textAnchor="middle">
                          {compactLabel(node.secondaryLabel, 21)}
                        </text>
                      ) : null}
                    </g>
                  ))}
                </svg>
              </div>

              <details className="shared-research-graph__list">
                <summary>Доступний список вузлів ({sharedView.graph.nodes.length})</summary>
                <ol>
                  {sharedView.graph.nodes.map((node) => (
                    <li key={node.id}>
                      <button type="button" onClick={() => setSelectedNodeId(node.id)} aria-pressed={node.id === selectedNodeId}>
                        <strong>{node.label}</strong>
                        <span>{entityTypeLabel(node.entityType)}{node.secondaryLabel ? ` · ${node.secondaryLabel}` : ""}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </details>
            </div>

            <aside className="shared-research-graph__detail" aria-label="Пояснення вибраного публічного вузла">
              <h2>Вибраний вузол</h2>
              {selectedNode ? (
                <>
                  <strong>{selectedNode.label}</strong>
                  <span>{entityTypeLabel(selectedNode.entityType)}</span>
                  {selectedNode.secondaryLabel ? <p>{selectedNode.secondaryLabel}</p> : null}
                  <h3>Публічні зв’язки ({selectedEdges.length})</h3>
                  {selectedEdges.length ? (
                    <ul>
                      {selectedEdges.map((edge) => <li key={edge.id}>{edge.label}</li>)}
                    </ul>
                  ) : <p>Немає доступних зв’язків.</p>}
                </>
              ) : <p>Оберіть вузол на схемі або у списку.</p>}
            </aside>
          </section>
        </>
      )}
    </main>
  );
}

const INACTIVE_LINK_MESSAGE = "Це посилання недійсне або більше не активне.";

function toLayoutNode(node: SharedResearchGraphView["graph"]["nodes"][number]): ResearchGraphNode {
  return {
    id: node.id as ResearchGraphNodeId,
    entityType: node.entityType,
    entityId: node.id,
    label: node.label,
    secondaryLabel: node.secondaryLabel,
    isCenter: node.isCenter,
    masked: false,
    depth: node.depth,
    metadata: {},
  };
}

function toLayoutEdge(edge: SharedResearchGraphView["graph"]["edges"][number]): ResearchGraphEdge {
  return {
    id: edge.id,
    source: edge.source as ResearchGraphNodeId,
    target: edge.target as ResearchGraphNodeId,
    sourceEntityType: "person",
    sourceEntityId: edge.source,
    targetEntityType: "person",
    targetEntityId: edge.target,
    relationTypeId: "",
    relationTypeCode: "",
    relationTypeLabel: edge.label,
    relationCategory: "social",
    directionality: edge.directionality,
    sourceRoleLabel: "",
    targetRoleLabel: "",
    validFrom: "",
    validTo: "",
    periodText: "",
    evidenceStatus: edge.evidenceStatus,
    confidence: edge.confidence,
    privacyStatus: "public",
    assertionKind: edge.assertionKind,
    evidenceCount: 0,
    generated: edge.generated,
    lockVersion: 1,
    metadata: {},
  };
}

function compactLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 1))}…` : value;
}

function entityTypeLabel(value: string): string {
  return value === "person" ? "Особа" : "Місце";
}

function sharedLayoutLabel(value: SharedResearchGraphView["view"]["layoutId"]): string {
  if (value === "hierarchical") return "Ієрархічний макет";
  if (value === "force") return "Силовий макет";
  return "Радіальний макет";
}

function dateTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("uk-UA", { dateStyle: "long", timeStyle: "short" }).format(date)
    : "невідомої дати";
}
