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
  ContextEvidenceStatus,
  DocumentaryGraphEdge,
  DocumentaryGraphEntityType,
  DocumentaryGraphNode,
  PersonDocumentaryGraphFilters,
  PersonDocumentaryGraphSnapshot,
} from "../../types/contextGraph.ts";
import { buildDocumentaryGraphLayeredLayout } from "./documentaryGraphModel.ts";
import "./PersonDocumentaryGraphV1.css";

interface DocumentaryGraphServiceModule {
  getPersonDocumentaryGraph(
    projectId: string,
    centerPersonId: string,
    filters?: PersonDocumentaryGraphFilters,
  ): Promise<PersonDocumentaryGraphSnapshot>;
}

let servicePromise: Promise<DocumentaryGraphServiceModule> | undefined;

async function loadDocumentaryGraphService(): Promise<DocumentaryGraphServiceModule> {
  servicePromise ??= import("../../services/contextRelationsService.ts")
    .then((module) => {
      const service = module as unknown as Partial<DocumentaryGraphServiceModule>;
      if (typeof service.getPersonDocumentaryGraph !== "function") {
        throw new Error("Документальний граф ще не доступний у цій версії застосунку.");
      }
      return service as DocumentaryGraphServiceModule;
    });
  return servicePromise;
}

interface FilterState {
  depth: 1 | 2;
  entityTypes: DocumentaryGraphEntityType[];
  eventType: string;
  evidenceStatus: ContextEvidenceStatus | "all";
  placeId: string;
  yearFrom: string;
  yearTo: string;
}

interface AppliedFilterState {
  contextKey: string;
  value: FilterState;
}

interface PlaceFilterOption {
  id: string;
  label: string;
}

export interface PersonDocumentaryGraphV1Props {
  projectId: string;
  center: Person;
  onBack?: () => void;
  /** Re-centers the documentary graph around another person. */
  onFocusPerson?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onOpenFinding?: (findingId: string) => void;
  onOpenPlace?: (placeId: string) => void;
}

export function PersonDocumentaryGraphV1({
  projectId,
  center,
  onBack,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
  onOpenPlace,
}: PersonDocumentaryGraphV1Props) {
  const headingId = useId();
  const detailHeadingId = useId();
  const requestSequence = useRef(0);
  const contextKey = `${projectId}:${center.id}`;
  const activeContextKey = useRef(contextKey);
  activeContextKey.current = contextKey;

  const [filterDraft, setFilterDraft] = useState<FilterState>(defaultFilters);
  const [appliedFilterState, setAppliedFilterState] = useState<AppliedFilterState>(() => ({
    contextKey,
    value: defaultFilters(),
  }));
  const [placeOptions, setPlaceOptions] = useState<PlaceFilterOption[]>([]);
  const [snapshot, setSnapshot] = useState<PersonDocumentaryGraphSnapshot | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const activeAppliedFilters = appliedFilterState.contextKey === contextKey
    ? appliedFilterState.value
    : null;

  const loadGraph = useCallback(async (filters: FilterState) => {
    const sequence = ++requestSequence.current;
    const requestContextKey = contextKey;
    setLoading(true);
    setLoadError("");
    setSnapshot(null);
    try {
      const service = await loadDocumentaryGraphService();
      const graph = await service.getPersonDocumentaryGraph(
        projectId,
        center.id,
        toServiceFilters(filters),
      );
      if (
        sequence !== requestSequence.current
        || requestContextKey !== activeContextKey.current
      ) return;
      setSnapshot(graph);
      setPlaceOptions((current) => mergePlaceOptions(current, graph.nodes));
      setSelectedNodeId((current) => (
        graph.nodes.some((node) => node.id === current)
          ? current
          : graph.centerNodeId
      ));
    } catch (error) {
      if (
        sequence !== requestSequence.current
        || requestContextKey !== activeContextKey.current
      ) return;
      setLoadError(errorMessage(error, "Не вдалося завантажити документальний граф."));
    } finally {
      if (
        sequence === requestSequence.current
        && requestContextKey === activeContextKey.current
      ) setLoading(false);
    }
  }, [center.id, contextKey, projectId]);

  useEffect(() => {
    if (appliedFilterState.contextKey === contextKey) return;
    const next = defaultFilters();
    setFilterDraft(defaultFilters());
    setAppliedFilterState({ contextKey, value: next });
    setPlaceOptions([]);
    setSelectedNodeId("");
    setSnapshot(null);
    setLoadError("");
  }, [appliedFilterState.contextKey, contextKey]);

  useEffect(() => {
    if (!activeAppliedFilters) return undefined;
    void loadGraph(activeAppliedFilters);
    return () => {
      requestSequence.current += 1;
    };
  }, [activeAppliedFilters, loadGraph]);

  const layout = useMemo(
    () => snapshot
      ? buildDocumentaryGraphLayeredLayout(snapshot.nodes, snapshot.edges)
      : null,
    [snapshot],
  );
  const nodesById = useMemo(
    () => new Map(snapshot?.nodes.map((node) => [node.id, node]) ?? []),
    [snapshot],
  );
  const selectedNode = selectedNodeId
    ? nodesById.get(selectedNodeId as DocumentaryGraphNode["id"]) ?? null
    : null;
  const selectedEdges = useMemo(
    () => selectedNode
      ? (snapshot?.edges ?? []).filter(
        (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
      )
      : [],
    [selectedNode, snapshot?.edges],
  );

  const applyFilters = () => {
    const yearFrom = parseOptionalYear(filterDraft.yearFrom);
    const yearTo = parseOptionalYear(filterDraft.yearTo);
    if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
      setLoadError("Початковий рік не може бути пізнішим за кінцевий.");
      return;
    }
    setLoadError("");
    setAppliedFilterState({ contextKey, value: copyFilters(filterDraft) });
  };

  const resetFilters = () => {
    const next = defaultFilters();
    setFilterDraft(next);
    setAppliedFilterState({ contextKey, value: copyFilters(next) });
    setLoadError("");
  };

  const toggleEntityType = (entityType: DocumentaryGraphEntityType) => {
    setFilterDraft((current) => {
      const includes = current.entityTypes.includes(entityType);
      if (includes && current.entityTypes.length === 1) return current;
      const nextTypes = includes
        ? current.entityTypes.filter((item) => item !== entityType)
        : [...current.entityTypes, entityType];
      return { ...current, entityTypes: nextTypes };
    });
  };

  return (
    <section className="documentary-graph-v1" aria-labelledby={headingId}>
      <form
        className="documentary-graph-v1__filters"
        aria-labelledby={headingId}
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <div className="documentary-graph-v1__toolbar">
          <div className="documentary-graph-v1__identity">
            {onBack ? (
              <button type="button" className="documentary-graph-v1__button is-secondary" onClick={onBack}>
                ← Назад
              </button>
            ) : null}
            <div className="documentary-graph-v1__compact-heading">
              <h2 id={headingId}>Документи</h2>
              <span title={personDisplayName(center)}>{personDisplayName(center)}</span>
            </div>
          </div>
          <fieldset className="documentary-graph-v1__depth-filter">
            <legend>Глибина</legend>
            <label title="1 · прямі згадки">
              <input
                type="radio"
                name="documentary-depth"
                value="1"
                aria-label="1 · прямі згадки"
                checked={filterDraft.depth === 1}
                onChange={() => setFilterDraft((current) => ({ ...current, depth: 1 }))}
              />
              <span>1</span>
            </label>
            <label title="2 · пов’язані особи та місця">
              <input
                type="radio"
                name="documentary-depth"
                value="2"
                aria-label="2 · пов’язані особи та місця"
                checked={filterDraft.depth === 2}
                onChange={() => setFilterDraft((current) => ({ ...current, depth: 2 }))}
              />
              <span>2</span>
            </label>
          </fieldset>
          <div className="documentary-graph-v1__filter-actions">
            <button type="submit" className="documentary-graph-v1__button is-primary" disabled={loading}>
              Застосувати
            </button>
            <button type="button" className="documentary-graph-v1__button is-secondary" onClick={resetFilters} disabled={loading}>
              Скинути
            </button>
          </div>
        </div>

        <div className="documentary-graph-v1__disclosures">
          <details className="documentary-graph-v1__path-guide">
            <summary>Як читати граф</summary>
            <div>
              <p>
                Простежте шлях від людини до джерела її згадки. Схема не змінює родинне дерево.
              </p>
              <ol className="documentary-graph-v1__path" aria-label="Ланцюжок документального графа">
                <li>Особа</li>
                <li>Знахідка або подія</li>
                <li>Документ</li>
                <li>Місце</li>
              </ol>
            </div>
          </details>

          <details className="documentary-graph-v1__advanced-filters">
          <summary>
            <span>Додаткові фільтри</span>
            <small>Типи вузлів, події, підтвердження, місце й роки</small>
          </summary>
          <div className="documentary-graph-v1__advanced-content">
            <fieldset className="documentary-graph-v1__entity-filter">
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

            <div className="documentary-graph-v1__field-grid">
              <label>
                <span>Тип події особи</span>
                <select
                  value={filterDraft.eventType}
                  onChange={(event) => setFilterDraft((current) => ({
                    ...current,
                    eventType: event.target.value,
                  }))}
                >
                  <option value="all">Усі події</option>
                  {EVENT_TYPE_OPTIONS.map((option) => (
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
                    evidenceStatus: event.target.value as ContextEvidenceStatus | "all",
                  }))}
                >
                  <option value="all">Усі стани</option>
                  {EVIDENCE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Канонічне місце</span>
                <select
                  value={filterDraft.placeId}
                  disabled={placeOptions.length === 0}
                  onChange={(event) => setFilterDraft((current) => ({
                    ...current,
                    placeId: event.target.value,
                  }))}
                >
                  <option value="">
                    {placeOptions.length ? "Усі підтверджені місця" : "Підтверджених місць ще немає"}
                  </option>
                  {placeOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <small>Назви взято з підтверджених місць поточного графа.</small>
              </label>
              <label>
                <span>Рік від</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="9999"
                  value={filterDraft.yearFrom}
                  onChange={(event) => setFilterDraft((current) => ({
                    ...current,
                    yearFrom: event.target.value,
                  }))}
                  placeholder="Наприклад: 1850"
                />
              </label>
              <label>
                <span>Рік до</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="9999"
                  value={filterDraft.yearTo}
                  onChange={(event) => setFilterDraft((current) => ({
                    ...current,
                    yearTo: event.target.value,
                  }))}
                  placeholder="Наприклад: 1900"
                />
              </label>
            </div>
          </div>
          </details>
        </div>
      </form>

      {loadError ? (
        <div className="documentary-graph-v1__message is-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => {
              if (activeAppliedFilters) void loadGraph(activeAppliedFilters);
            }}
            disabled={loading || !activeAppliedFilters}
          >
            Повторити
          </button>
        </div>
      ) : null}

      {snapshot?.truncated || snapshot?.edgesTruncated ? (
        <div className="documentary-graph-v1__message is-warning" role="status">
          Показано лише частину великого графа.
          {snapshot.truncated ? " Досягнуто межі 100 вузлів." : ""}
          {snapshot.edgesTruncated ? " Досягнуто межі зв’язків." : ""}
          {" "}Уточніть фільтри, щоб побачити потрібний фрагмент.
        </div>
      ) : null}

      <div className="documentary-graph-v1__workspace">
        <div className="documentary-graph-v1__canvas-column">
          <div className="documentary-graph-v1__legend" aria-label="Позначення типів вузлів">
            {ENTITY_TYPE_OPTIONS.map((option) => (
              <span key={option.value} className={`is-${option.value}`}>
                <i aria-hidden="true" />{option.label}
              </span>
            ))}
          </div>
          <div
            className="documentary-graph-v1__canvas"
            role="region"
            aria-label="Інтерактивна схема документального контексту"
            tabIndex={layout && layout.width > 960 ? 0 : undefined}
          >
            {loading ? (
              <DocumentaryGraphSkeleton />
            ) : layout && layout.nodes.length ? (
              <svg
                className="documentary-graph-v1__graph"
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                style={{ minWidth: `${Math.max(760, layout.width)}px` }}
                role="img"
                aria-label={`Документальний контекст особи ${personDisplayName(center)}: ${layout.nodes.length} вузлів і ${layout.edges.length} зв’язків`}
              >
                <g className="documentary-graph-v1__edges" aria-hidden="true">
                  {layout.edges.map((edge) => (
                    <path
                      key={edge.id}
                      className={`${edge.generated ? "is-generated " : ""}${selectedEdgeClass(edge, selectedNodeId)}`.trim()}
                      d={edge.path}
                    />
                  ))}
                </g>
                {layout.nodes.map((node) => (
                  <GraphNode
                    key={node.id}
                    node={node}
                    selected={node.id === selectedNodeId}
                    onActivate={() => setSelectedNodeId(node.id)}
                  />
                ))}
              </svg>
            ) : (
              <div className="documentary-graph-v1__empty">
                <span aria-hidden="true">⌕</span>
                <strong>За цими умовами підтверджених зв’язків немає</strong>
                <p>Змініть глибину, період або типи вузлів і застосуйте фільтри.</p>
              </div>
            )}
          </div>

          {!loading && snapshot?.nodes.length ? (
            <details className="documentary-graph-v1__accessible-list">
              <summary>Список вузлів графа ({snapshot.nodes.length})</summary>
              <ol>
                {snapshot.nodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      aria-pressed={node.id === selectedNodeId}
                      onClick={() => setSelectedNodeId(node.id)}
                    >
                      <strong>{nodeDisplayLabel(node)}</strong>
                      <span>{entityTypeLabel(node.entityType)}{node.secondaryLabel ? ` · ${node.secondaryLabel}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>

        <aside className="documentary-graph-v1__detail" aria-labelledby={detailHeadingId}>
          <h3 id={detailHeadingId}>Відомості про вузол</h3>
          {selectedNode ? (
            <NodeDetail
              node={selectedNode}
              edges={selectedEdges}
              nodesById={nodesById}
              isCenter={selectedNode.id === snapshot?.centerNodeId}
              onFocusPerson={onFocusPerson}
              onOpenPerson={onOpenPerson}
              onOpenDocument={onOpenDocument}
              onOpenFinding={onOpenFinding}
              onOpenPlace={onOpenPlace}
            />
          ) : (
            <p className="documentary-graph-v1__detail-empty">
              Оберіть вузол на схемі або у доступному списку.
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

type LayoutResult = ReturnType<typeof buildDocumentaryGraphLayeredLayout>;
type LayoutNode = LayoutResult["nodes"][number];
type LayoutEdge = LayoutResult["edges"][number];

function GraphNode({
  node,
  selected,
  onActivate,
}: {
  node: LayoutNode;
  selected: boolean;
  onActivate: () => void;
}) {
  const className = [
    "documentary-graph-v1__node",
    `is-${node.entityType}`,
    selected ? "is-selected" : "",
    node.masked ? "is-masked" : "",
  ].filter(Boolean).join(" ");
  const width = node.width;
  const height = node.height;
  const x = node.x;
  const y = node.y;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const displayLabel = nodeDisplayLabel(node);
  const title = `${entityTypeLabel(node.entityType)}: ${displayLabel}${node.secondaryLabel ? `. ${node.secondaryLabel}` : ""}`;

  return (
    <g
      className={className}
      role="button"
      tabIndex={0}
      aria-label={`${selected ? "Обрано. " : ""}${title}`}
      aria-pressed={selected}
      onClick={onActivate}
      onKeyDown={(event) => activateWithKeyboard(event, onActivate)}
    >
      <title>{title}</title>
      {node.entityType === "person" ? (
        <circle cx={x} cy={y} r={Math.min(halfWidth, halfHeight)} />
      ) : node.entityType === "finding" ? (
        <rect x={x - halfWidth} y={y - halfHeight} width={width} height={height} rx="18" />
      ) : node.entityType === "document" ? (
        <g className="documentary-graph-v1__document-shape" aria-hidden="true">
          <path d={`M ${x - halfWidth} ${y - halfHeight} H ${x + halfWidth - 18} L ${x + halfWidth} ${y - halfHeight + 18} V ${y + halfHeight} H ${x - halfWidth} Z`} />
          <path className="is-fold" d={`M ${x + halfWidth - 18} ${y - halfHeight} V ${y - halfHeight + 18} H ${x + halfWidth}`} />
        </g>
      ) : node.entityType === "person_event" ? (
        <polygon points={`${x},${y - halfHeight} ${x + halfWidth},${y} ${x},${y + halfHeight} ${x - halfWidth},${y}`} />
      ) : (
        <g className="documentary-graph-v1__place-shape" aria-hidden="true">
          <path d={`M ${x} ${y + halfHeight} C ${x - 8} ${y + 10}, ${x - halfWidth} ${y - 2}, ${x - halfWidth} ${y - 14} A ${halfWidth} ${halfHeight - 8} 0 1 1 ${x + halfWidth} ${y - 14} C ${x + halfWidth} ${y - 2}, ${x + 8} ${y + 10}, ${x} ${y + halfHeight} Z`} />
          <circle className="is-hole" cx={x} cy={y - 13} r="8" />
        </g>
      )}
      <text className="documentary-graph-v1__node-label" x={x} y={y - 2} textAnchor="middle">
        {compactLabel(displayLabel, node.entityType === "person_event" ? 15 : 18)}
      </text>
      {node.secondaryLabel ? (
        <text className="documentary-graph-v1__node-secondary" x={x} y={y + 17} textAnchor="middle">
          {compactLabel(node.secondaryLabel, 20)}
        </text>
      ) : null}
    </g>
  );
}

function NodeDetail({
  node,
  edges,
  nodesById,
  isCenter,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
  onOpenPlace,
}: {
  node: DocumentaryGraphNode;
  edges: DocumentaryGraphEdge[];
  nodesById: Map<DocumentaryGraphNode["id"], DocumentaryGraphNode>;
  isCenter: boolean;
  onFocusPerson?: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onOpenFinding?: (findingId: string) => void;
  onOpenPlace?: (placeId: string) => void;
}) {
  const eventOwnerId = metadataText(node.metadata, [
    "personId",
    "person_id",
    "ownerPersonId",
    "owner_person_id",
  ]);
  const period = metadataText(node.metadata, ["period", "date", "eventDate", "event_date"]);
  const status = metadataText(node.metadata, ["status", "evidenceStatus", "evidence_status"]);
  const eventRole = metadataText(node.metadata, ["eventRole", "event_role", "role"]);

  return (
    <div className="documentary-graph-v1__detail-content">
      <span className={`documentary-graph-v1__entity-badge is-${node.entityType}`}>
        {entityTypeLabel(node.entityType)}
      </span>
      <strong>{nodeDisplayLabel(node)}</strong>
      {node.secondaryLabel ? <p>{node.secondaryLabel}</p> : null}
      {period ? <p><b>Період:</b> {period}</p> : null}
      {status ? <p><b>Стан:</b> {statusDisplayLabel(status)}</p> : null}
      {node.entityType === "person_event" && eventRole ? (
        <p><b>Роль у події:</b> {roleDisplayLabel(eventRole)}</p>
      ) : null}
      {node.masked ? (
        <p className="documentary-graph-v1__privacy-note">
          Дані цієї живої або приватної особи приховано правилами проєкту.
        </p>
      ) : null}

      {!node.masked ? (
        <div className="documentary-graph-v1__detail-actions">
          {node.entityType === "person" && !isCenter && onFocusPerson ? (
            <button type="button" onClick={() => onFocusPerson(node.entityId)}>Зробити центром</button>
          ) : null}
          {node.entityType === "person" && onOpenPerson ? (
            <button type="button" onClick={() => onOpenPerson(node.entityId)}>Відкрити картку особи</button>
          ) : null}
          {node.entityType === "document" && onOpenDocument ? (
            <button type="button" onClick={() => onOpenDocument(node.entityId)}>Відкрити документ</button>
          ) : null}
          {node.entityType === "finding" && onOpenFinding ? (
            <button type="button" onClick={() => onOpenFinding(node.entityId)}>Відкрити знахідку</button>
          ) : null}
          {node.entityType === "place" && onOpenPlace ? (
            <button type="button" onClick={() => onOpenPlace(node.entityId)}>Відкрити місце</button>
          ) : null}
          {node.entityType === "person_event" && eventOwnerId && onOpenPerson ? (
            <button type="button" onClick={() => onOpenPerson(eventOwnerId)}>Відкрити особу цієї події</button>
          ) : null}
        </div>
      ) : null}

      <div className="documentary-graph-v1__evidence-list">
        <h4>Чому вузол тут</h4>
        {edges.length ? (
          <ul>
            {edges.map((edge) => {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const other = nodesById.get(otherId);
              return (
                <li key={edge.id}>
                  <span className={`is-${edge.status}`}>{evidenceStatusLabel(edge.status)}</span>
                  <strong>{edgeDisplayLabel(edge)}</strong>
                  <small>
                    {other ? nodeDisplayLabel(other) : "Пов’язаний вузол"}
                    {edge.sourceCount > 1 ? ` · джерел: ${edge.sourceCount}` : ""}
                    {edge.generated ? " · створено системою" : ""}
                  </small>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>Це центральна особа поточного графа.</p>
        )}
      </div>
    </div>
  );
}

function DocumentaryGraphSkeleton() {
  return (
    <div className="documentary-graph-v1__skeleton" aria-label="Завантаження документального графа">
      <span className="is-center" />
      <span className="is-one" />
      <span className="is-two" />
      <span className="is-three" />
      <span className="is-four" />
    </div>
  );
}

function defaultFilters(): FilterState {
  return {
    depth: 2,
    entityTypes: ENTITY_TYPE_OPTIONS.map((option) => option.value),
    eventType: "all",
    evidenceStatus: "all",
    placeId: "",
    yearFrom: "",
    yearTo: "",
  };
}

function copyFilters(value: FilterState): FilterState {
  return { ...value, entityTypes: [...value.entityTypes] };
}

function toServiceFilters(value: FilterState): PersonDocumentaryGraphFilters {
  const yearFrom = parseOptionalYear(value.yearFrom);
  const yearTo = parseOptionalYear(value.yearTo);
  return {
    depth: value.depth,
    entityTypes: value.entityTypes,
    eventTypes: value.eventType === "all" ? undefined : [value.eventType],
    evidenceStatuses: value.evidenceStatus === "all" ? undefined : [value.evidenceStatus],
    placeId: value.placeId || undefined,
    yearFrom: yearFrom ?? undefined,
    yearTo: yearTo ?? undefined,
    maxNodes: 100,
    maxEdges: 250,
  };
}

function parseOptionalYear(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 9999 ? parsed : null;
}

function selectedEdgeClass(edge: LayoutEdge, selectedNodeId: string): string {
  return selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId)
    ? "is-selected"
    : "";
}

function activateWithKeyboard(event: ReactKeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function compactLabel(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function personDisplayName(person: Person): string {
  return person.fullName.trim()
    || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")
    || "Особа";
}

function metadataText(metadata: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function entityTypeLabel(value: DocumentaryGraphEntityType): string {
  return ENTITY_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? "Вузол";
}

function nodeDisplayLabel(node: DocumentaryGraphNode): string {
  if (node.entityType !== "person_event") return node.label;
  return EVENT_TYPE_OPTIONS.find((option) => option.value === node.label.trim().toLowerCase())?.label
    ?? (/\p{Script=Cyrillic}/u.test(node.label) ? node.label : "Інша подія");
}

function evidenceStatusLabel(value: ContextEvidenceStatus): string {
  return EVIDENCE_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? "Не перевірено";
}

function statusDisplayLabel(value: string): string {
  const normalized = normalizedCode(value);
  const evidenceLabel = EVIDENCE_STATUS_OPTIONS.find((option) => option.value === normalized)?.label;
  if (evidenceLabel) return evidenceLabel;
  return STATUS_LABELS[normalized]
    ?? (/\p{Script=Cyrillic}/u.test(value) ? readableLabel(value, "Стан не вказано") : "Інший стан");
}

function edgeDisplayLabel(edge: DocumentaryGraphEdge): string {
  if (edge.relationType !== "has_participant") {
    return edge.label || relationTypeLabel(edge.relationType);
  }
  return roleDisplayLabel(edge.label);
}

function roleDisplayLabel(value: string): string {
  const normalized = normalizedCode(value);
  if (ROLE_LABELS[normalized]) return ROLE_LABELS[normalized];
  if (/\p{Script=Cyrillic}/u.test(value)) return value;
  return "учасник";
}

function relationTypeLabel(value: string): string {
  return RELATION_LABELS[value] ?? readableLabel(value, "Документальний зв’язок");
}

function normalizedCode(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function readableLabel(value: string, fallback: string): string {
  const readable = value.trim().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ");
  if (!readable) return fallback;
  return `${readable.charAt(0).toLocaleUpperCase("uk-UA")}${readable.slice(1)}`;
}

function mergePlaceOptions(
  current: readonly PlaceFilterOption[],
  nodes: readonly DocumentaryGraphNode[],
): PlaceFilterOption[] {
  const options = new Map(current.map((option) => [option.id, option] as const));
  nodes.forEach((node) => {
    if (node.entityType !== "place" || !node.entityId) return;
    const label = [node.label, node.secondaryLabel]
      .map((part) => part.trim())
      .filter((part, index, all) => Boolean(part) && all.indexOf(part) === index)
      .join(" · ");
    options.set(node.entityId, { id: node.entityId, label: label || "Місце без назви" });
  });
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label, "uk-UA"));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

const ENTITY_TYPE_OPTIONS: ReadonlyArray<{
  value: DocumentaryGraphEntityType;
  label: string;
}> = [
  { value: "person", label: "Особи" },
  { value: "finding", label: "Знахідки" },
  { value: "person_event", label: "Події особи" },
  { value: "document", label: "Документи" },
  { value: "place", label: "Місця" },
];

const EVIDENCE_STATUS_OPTIONS: ReadonlyArray<{
  value: ContextEvidenceStatus;
  label: string;
}> = [
  { value: "unknown", label: "Не перевірено" },
  { value: "likely", label: "Ймовірно" },
  { value: "proven", label: "Підтверджено" },
  { value: "disputed", label: "Спірно" },
  { value: "disproven", label: "Спростовано" },
];

const EVENT_TYPE_OPTIONS = [
  { value: "birth", label: "Народження" },
  { value: "baptism", label: "Хрещення" },
  { value: "marriage", label: "Шлюб" },
  { value: "residence", label: "Проживання" },
  { value: "census", label: "Перепис" },
  { value: "revision_list", label: "Ревізька казка" },
  { value: "confession_list", label: "Сповідний розпис" },
  { value: "military", label: "Військова служба" },
  { value: "occupation", label: "Заняття" },
  { value: "death", label: "Смерть" },
  { value: "burial", label: "Поховання" },
  { value: "mention", label: "Згадка" },
  { value: "other", label: "Інша подія" },
] as const;

const STATUS_LABELS: Record<string, string> = {
  draft: "Чернетка",
  pending: "Очікує перевірки",
  pending_review: "Очікує перевірки",
  needs_review: "Потребує перевірки",
  verified: "Перевірено",
  confirmed: "Підтверджено",
  rejected: "Відхилено",
  private: "Приватний",
  public: "Публічний",
};

const ROLE_LABELS: Record<string, string> = {
  participant: "учасник",
  person: "особа",
  principal: "головна особа",
  child: "дитина",
  newborn: "новонароджена дитина",
  deceased: "померла особа",
  father: "батько",
  mother: "мати",
  parent: "хтось із батьків",
  husband: "чоловік",
  wife: "дружина",
  spouse: "хтось із подружжя",
  groom: "наречений",
  bride: "наречена",
  witness: "свідок",
  godparent: "хрещений батько або мати",
  godfather: "хрещений батько",
  godmother: "хрещена мати",
  priest: "священник",
  informant: "заявник",
};

const RELATION_LABELS: Record<string, string> = {
  person_finding: "особу згадано у знахідці",
  person_event: "подія належить особі",
  person_document: "особу пов’язано з документом",
  finding_document: "знахідка походить із документа",
  finding_person: "співучасник тієї самої знахідки",
  event_document: "подію підтверджує документ",
  event_finding: "подію підтверджує знахідка",
  event_place: "подія відбулася у місці",
  document_place: "документ пов’язано з місцем",
  linked_to_finding: "пов’язано зі знахідкою",
  has_event: "подія особи",
  documented_in: "зафіксовано в документі",
  recorded_in: "записано в документі",
  has_participant: "учасник знахідки",
  supported_by_document: "підтверджено документом",
  supported_by_finding: "підтверджено знахідкою",
  occurred_at: "відбулося у місці",
  mentions_place: "згадує місце",
};
