import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Person } from "../../types";
import type {
  ChurchRoleNetworkSample,
  ChurchRoleNetworkSource,
  PersonChurchRoleNetworkFilters,
  PersonChurchRoleNetworkItem,
  PersonChurchRoleNetworkPage,
} from "../../types/contextGraph.ts";
import {
  CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS,
  CHURCH_ROLE_PRESET_OPTIONS,
  buildChurchRoleRelationshipGraph,
  churchRoleCapReasonLabel,
  churchRoleOccurrenceLabel,
  churchRolePeriodLabel,
  churchRoleProblemCapReasons,
  churchRoleSummary,
  compactChurchRoleLabel,
  defaultChurchRoleNetworkFilterDraft,
  mergeChurchRoleNetworkPages,
  parseChurchRoleNetworkFilterDraft,
  type ChurchRoleNetworkFilterDraft,
} from "./churchRoleNetworkModel.ts";
import { ContextRelationshipGraphV1 } from "./ContextRelationshipGraphV1.tsx";
import { buildChurchRoleRelationshipGraphLayout } from "./churchRoleRelationshipLayout.ts";
import "./PersonChurchRoleNetworkV1.css";

type ContextRelationsService = typeof import("../../services/contextRelationsService.ts");

let servicePromise: Promise<ContextRelationsService> | undefined;

function loadContextRelationsService(): Promise<ContextRelationsService> {
  servicePromise ??= import("../../services/contextRelationsService.ts");
  return servicePromise;
}

interface AppliedFilters {
  contextKey: string;
  value: PersonChurchRoleNetworkFilters;
}

interface RetryState {
  filters: PersonChurchRoleNetworkFilters;
  append: boolean;
}

export interface PersonChurchRoleNetworkV1Props {
  projectId: string;
  center: Person;
  onFocusPerson: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
  onOpenDocument: (documentId: string) => void;
  onOpenFinding: (findingId: string) => void;
}

export function PersonChurchRoleNetworkV1({
  projectId,
  center,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
}: PersonChurchRoleNetworkV1Props) {
  const headingId = useId();
  const requestSequence = useRef(0);
  const contextKey = `${projectId}:${center.id}`;
  const activeContextKey = useRef(contextKey);
  activeContextKey.current = contextKey;
  const initialDraft = defaultChurchRoleNetworkFilterDraft;
  const [draft, setDraft] = useState<ChurchRoleNetworkFilterDraft>(initialDraft);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters>(() => ({
    contextKey,
    value: parseChurchRoleNetworkFilterDraft(initialDraft()),
  }));
  const [page, setPage] = useState<PersonChurchRoleNetworkPage | null>(null);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [filterError, setFilterError] = useState("");
  const [retryState, setRetryState] = useState<RetryState | null>(null);
  const [selectedGroupKey, setSelectedGroupKey] = useState("");

  const activeFilters = appliedFilters.contextKey === contextKey
    ? appliedFilters.value
    : null;

  const loadNetwork = useCallback(async (
    filters: PersonChurchRoleNetworkFilters,
    append = false,
  ) => {
    const sequence = ++requestSequence.current;
    const requestContextKey = contextKey;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setLoadingMore(false);
      setPage(null);
      setNextOffset(0);
      setSelectedGroupKey("");
    }
    setLoadError("");
    setRetryState(null);
    try {
      const service = await loadContextRelationsService();
      const result = await service.listPersonChurchRoleNetworkV1(
        projectId,
        center.id,
        filters,
      );
      if (
        sequence !== requestSequence.current
        || requestContextKey !== activeContextKey.current
      ) return;
      setPage((current) => append && current
        ? mergeChurchRoleNetworkPages(current, result)
        : result);
      setNextOffset((current) => append
        ? current + result.items.length
        : result.items.length);
    } catch (error) {
      if (
        sequence !== requestSequence.current
        || requestContextKey !== activeContextKey.current
      ) return;
      if (!append) setPage(null);
      setRetryState({ filters, append });
      setLoadError(errorMessage(error, "Не вдалося побудувати мережу хрещених і поручителів."));
    } finally {
      if (
        sequence === requestSequence.current
        && requestContextKey === activeContextKey.current
      ) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [center.id, contextKey, projectId]);

  useEffect(() => {
    if (appliedFilters.contextKey === contextKey) return;
    const nextDraft = defaultChurchRoleNetworkFilterDraft();
    setDraft(nextDraft);
    setAppliedFilters({
      contextKey,
      value: parseChurchRoleNetworkFilterDraft(nextDraft),
    });
    setPage(null);
    setNextOffset(0);
    setLoadingMore(false);
    setLoadError("");
    setFilterError("");
    setRetryState(null);
    setSelectedGroupKey("");
  }, [appliedFilters.contextKey, contextKey]);

  useEffect(() => {
    if (!activeFilters) return undefined;
    void loadNetwork(activeFilters);
    return () => {
      requestSequence.current += 1;
    };
  }, [activeFilters, loadNetwork]);

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applyDraft(draft);
  };

  const applyDraft = (nextDraft: ChurchRoleNetworkFilterDraft) => {
    try {
      const next = parseChurchRoleNetworkFilterDraft(nextDraft);
      setFilterError("");
      setAppliedFilters({ contextKey, value: next });
    } catch (error) {
      setFilterError(errorMessage(error, "Перевірте фільтри мережі."));
    }
  };

  const resetFilters = () => {
    const nextDraft = defaultChurchRoleNetworkFilterDraft();
    setDraft(nextDraft);
    setLoadError("");
    setFilterError("");
    setRetryState(null);
    applyDraft(nextDraft);
  };

  const showSingleOccurrences = () => {
    const nextDraft = { ...draft, minOccurrences: "1" };
    setDraft(nextDraft);
    applyDraft(nextDraft);
  };

  const centerDisplayName = personDisplayName(center);
  const relationshipGraph = useMemo(
    () => page
      ? buildChurchRoleRelationshipGraph(page, { id: center.id, label: centerDisplayName })
      : null,
    [center.id, centerDisplayName, page],
  );
  const listItems = useMemo(() => {
    const items = page?.items ?? [];
    if (!selectedGroupKey) return items;
    return [...items].sort((left, right) => {
      if (left.counterpartGroup.key === selectedGroupKey) return -1;
      if (right.counterpartGroup.key === selectedGroupKey) return 1;
      return right.occurrenceCount - left.occurrenceCount;
    });
  }, [page?.items, selectedGroupKey]);
  const hasMore = Boolean(page?.truncated && page.items.length < page.total);
  const problemCapReasons = churchRoleProblemCapReasons(page?.capReasons ?? []);
  const calculationLimited = problemCapReasons.length > 0;
  const centerWithoutSurname = Boolean(
    page && !page.centerGroup && page.capReasons.includes("center_without_surname"),
  );
  const minOccurrences = Number(activeFilters?.minOccurrences ?? 2);

  return (
    <section className="church-role-network-v1" aria-labelledby={headingId}>
      <form className="church-role-network-v1__filters" onSubmit={applyFilters}>
        <h2 id={headingId}>
          <span>Роди й зв’язки</span>
          <small className="church-role-network-v1__surname-warning" role="note">
            Групування за прізвищем, не доказ споріднення.
          </small>
        </h2>
        <label className="is-wide">
          <span>Ролі</span>
          <select
            value={draft.preset}
            onChange={(event) => setDraft((current) => ({
              ...current,
              preset: event.target.value as ChurchRoleNetworkFilterDraft["preset"],
            }))}
          >
            {CHURCH_ROLE_PRESET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <div className="church-role-network-v1__filter-actions">
          <button type="submit" className="is-primary" disabled={loading}>Застосувати</button>
          <button type="button" onClick={resetFilters} disabled={loading}>Скинути</button>
        </div>
        <details className="church-role-network-v1__advanced-filters">
          <summary>
            <span>Додаткові фільтри</span>
            <small>Період і мінімальна кількість повторень</small>
          </summary>
          <div className="church-role-network-v1__advanced-grid">
            <label>
              <span>Рік від</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="9999"
                value={draft.yearFrom}
                placeholder="Наприклад: 1850"
                onChange={(event) => setDraft((current) => ({ ...current, yearFrom: event.target.value }))}
              />
            </label>
            <label>
              <span>Рік до</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="9999"
                value={draft.yearTo}
                placeholder="Наприклад: 1900"
                onChange={(event) => setDraft((current) => ({ ...current, yearTo: event.target.value }))}
              />
            </label>
            <label>
              <span>Мінімум повторень</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="1000"
                required
                value={draft.minOccurrences}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  minOccurrences: event.target.value,
                }))}
              />
            </label>
          </div>
        </details>
      </form>

      {filterError ? <div className="church-role-network-v1__message is-error" role="alert">{filterError}</div> : null}
      {loadError ? (
        <div className="church-role-network-v1__message is-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            disabled={loading || loadingMore || !retryState}
            onClick={() => retryState && void loadNetwork(retryState.filters, retryState.append)}
          >
            Повторити
          </button>
        </div>
      ) : null}

      {loading ? (
        <ChurchRoleNetworkSkeleton />
      ) : centerWithoutSurname ? (
        <div className="church-role-network-v1__empty">
          <span aria-hidden="true">◎</span>
          <strong>Для центральної особи не вказано прізвище</strong>
          <p>Додайте прізвище до картки особи, щоб побудувати дослідницькі кластери.</p>
          <button type="button" onClick={() => onOpenPerson(center.id)}>Відкрити картку особи</button>
        </div>
      ) : page?.items.length && relationshipGraph ? (
        <>
          {relationshipGraph.omittedGroupCount > 0 || relationshipGraph.omittedSampleCount > 0 ? (
            <p className="church-role-network-v1__graph-limit-note" role="note">
              Через безпечний ліміт графічну вибірку скорочено:
              {relationshipGraph.omittedGroupCount > 0
                ? ` не показано груп — ${relationshipGraph.omittedGroupCount}`
                : ""}
              {relationshipGraph.omittedGroupCount > 0 && relationshipGraph.omittedSampleCount > 0
                ? ";"
                : ""}
              {relationshipGraph.omittedSampleCount > 0
                ? ` точних прикладів — ${relationshipGraph.omittedSampleCount}`
                : ""}
              . Завантажені агрегати й деталі не видалено — вони доступні нижче.
            </p>
          ) : null}
          <ContextRelationshipGraphV1
            centerNode={relationshipGraph.centerNode}
            nodes={relationshipGraph.nodes}
            edges={relationshipGraph.edges}
            title={`Особа та зв’язки між родами · ${page.total}`}
            initialMode="3d"
            centerConnectionLabels="node"
            layoutBuilder={buildChurchRoleRelationshipGraphLayout}
            maxNodes={CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS.maxNodes}
            maxEdges={CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS.maxEdges}
            onNodeSelect={(node) => {
              const groupKey = relationshipGraph.groupKeyByNodeId[node.id];
              if (groupKey) setSelectedGroupKey(groupKey);
            }}
            onNodeActivate={(node) => {
              const personId = relationshipGraph.personIdByNodeId[node.id];
              if (personId) onOpenPerson(personId);
            }}
            onEdgeSelect={(edge) => {
              const groupKey = relationshipGraph.groupKeyByEdgeId[edge.id];
              if (groupKey) setSelectedGroupKey(groupKey);
            }}
          />

          <details className="church-role-network-v1__graph-scope">
            <summary>Як читати цей граф?</summary>
            <div role="note">
              <span>
                Граф починається з конкретної особи. Групи показують загальні підрахунки
                між прізвищами, а люди — до 5 точних прикладів на кожен рід. Це
                репрезентативна вибірка, не повний перелік і не доказ споріднення.
              </span>
            </div>
          </details>

          <details className="church-role-network-v1__result-details">
            <summary>
              <span>
                <strong>Детальні списки та джерела</strong>
                <small>Підрахунки, конкретні приклади й документи за кожним родом</small>
              </span>
              <b>{page.items.length}</b>
            </summary>
            <section className="church-role-network-v1__list" aria-label="Повторювані зв’язки за прізвищами">
              {listItems.map((item) => (
                <ChurchRoleNetworkCard
                  key={item.counterpartGroup.key}
                  item={item}
                  centerPersonId={center.id}
                  selected={item.counterpartGroup.key === selectedGroupKey}
                  onFocusPerson={onFocusPerson}
                  onOpenPerson={onOpenPerson}
                  onOpenDocument={onOpenDocument}
                  onOpenFinding={onOpenFinding}
                />
              ))}
            </section>
          </details>
        </>
      ) : page ? (
        <div className="church-role-network-v1__empty">
          <span aria-hidden="true">◎</span>
          <strong>{minOccurrences > 1 ? "Повторюваних зв’язків не знайдено" : "Церковних ролей ще не знайдено"}</strong>
          <p>
            {minOccurrences > 1
              ? "Спробуйте показати також поодинокі згадки або розширте період."
              : "Додайте точні ролі учасників до знахідки або створіть контекстний зв’язок."}
          </p>
          {minOccurrences > 1 ? (
            <button type="button" onClick={showSingleOccurrences}>Показати також поодинокі</button>
          ) : null}
        </div>
      ) : null}

      {page?.sameGroupOccurrenceCount ? (
        <p className="church-role-network-v1__notice" role="status">
          Ще {churchRoleOccurrenceLabel(page.sameGroupOccurrenceCount)} зафіксовано всередині того самого кластера прізвища.
        </p>
      ) : null}
      {page?.omittedWithoutSurnameCount ? (
        <p className="church-role-network-v1__notice" role="status">
          Не включено {page.omittedWithoutSurnameCount} осіб без прізвища — система не вгадує їхню групу.
        </p>
      ) : null}

      {hasMore && page && activeFilters ? (
        <div className="church-role-network-v1__more">
          <p role="status">Показано {page.items.length} результатів із {page.total}.</p>
          <button
            type="button"
            disabled={loading || loadingMore}
            onClick={() => void loadNetwork({ ...activeFilters, offset: nextOffset }, true)}
          >
            {loadingMore ? "Завантаження…" : "Показати ще"}
          </button>
        </div>
      ) : null}

      {calculationLimited && page ? (
        <div className="church-role-network-v1__limit" role="status">
          <strong>Розрахунок частково обмежено.</strong>
          <ul>
            {problemCapReasons
              .map((reason) => <li key={reason}>{churchRoleCapReasonLabel(reason)}</li>)}
          </ul>
          <span>Уточніть період або набір ролей, щоб звузити мережу.</span>
        </div>
      ) : null}
    </section>
  );
}

interface ChurchRoleNetworkCardProps {
  item: PersonChurchRoleNetworkItem;
  centerPersonId: string;
  selected: boolean;
  onFocusPerson: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
  onOpenDocument: (documentId: string) => void;
  onOpenFinding: (findingId: string) => void;
}

function ChurchRoleNetworkCard({
  item,
  centerPersonId,
  selected,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
}: ChurchRoleNetworkCardProps) {
  return (
    <article className={`church-role-network-v1__card${selected ? " is-selected" : ""}`}>
      <header>
        <div>
          <span>Кластер прізвища</span>
          <h3>{item.counterpartGroup.label}</h3>
          {item.counterpartGroup.memberCount ? (
            <small>{item.counterpartGroup.memberCount} осіб у видимій вибірці</small>
          ) : null}
        </div>
        <strong>{churchRoleOccurrenceLabel(item.occurrenceCount)}</strong>
      </header>
      <p className="church-role-network-v1__role-summary">{churchRoleSummary(item, 5)}</p>
      <dl>
        <div><dt>Конкретні зв’язки</dt><dd>{item.relationCount}</dd></div>
        <div><dt>Пари людей</dt><dd>{item.personPairCount}</dd></div>
        <div><dt>Період</dt><dd>{churchRolePeriodLabel(item)}</dd></div>
        <div><dt>Автоматично / вручну</dt><dd>{item.generatedCount} / {item.manualCount}</dd></div>
      </dl>
      <div className="church-role-network-v1__direction-summary">
        <span>До прізвищевої групи: {item.incomingCount}</span>
        <span>Від прізвищевої групи: {item.outgoingCount}</span>
      </div>
      {item.ambiguousRoleCount ? (
        <p className="church-role-network-v1__ambiguous" role="note">
          {item.ambiguousRoleCount} зв’язків мають загальну роль без уточнення сторони.
        </p>
      ) : null}

      {item.samples.length ? (
        <details className="church-role-network-v1__samples">
          <summary>Показати конкретні зв’язки ({item.samples.length})</summary>
          <ul>
            {item.samples.map((sample) => (
              <li key={sample.relationId}>
                <ChurchRoleSample
                  sample={sample}
                  centerPersonId={centerPersonId}
                  onFocusPerson={onFocusPerson}
                  onOpenPerson={onOpenPerson}
                  onOpenDocument={onOpenDocument}
                  onOpenFinding={onOpenFinding}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {item.sources.length ? (
        <details className="church-role-network-v1__sources">
          <summary>Приклади джерел ({item.sources.length})</summary>
          <ul>
            {item.sources.map((source) => (
              <li key={`${source.kind}:${source.id}`}>
                <SourceAction
                  source={source}
                  onOpenDocument={onOpenDocument}
                  onOpenFinding={onOpenFinding}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

interface ChurchRoleSampleProps {
  sample: ChurchRoleNetworkSample;
  centerPersonId: string;
  onFocusPerson: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
  onOpenDocument: (documentId: string) => void;
  onOpenFinding: (findingId: string) => void;
}

function ChurchRoleSample({
  sample,
  centerPersonId,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
}: ChurchRoleSampleProps) {
  const focusCandidates = uniquePeople(sample).filter((person) => person.id !== centerPersonId);
  return (
    <article className="church-role-network-v1__sample">
      <p>
        <button type="button" onClick={() => onOpenPerson(sample.sourcePersonId)}>
          {sample.sourceDisplayName}
        </button>
        <span> — </span>
        <strong>{sample.roleLabel}</strong>
        <span> для </span>
        <button type="button" onClick={() => onOpenPerson(sample.targetPersonId)}>
          {sample.targetDisplayName}
        </button>
      </p>
      <div className="church-role-network-v1__sample-meta">
        {sample.year ? <time>{sample.year}</time> : <span>Рік не встановлено</span>}
        <span>{evidenceStatusLabel(sample.evidenceStatus)}</span>
        <span>{sample.confidence}% впевненості</span>
        <span>{sample.evidenceCount} підстав</span>
      </div>
      {sample.source ? (
        <SourceAction
          source={sample.source}
          onOpenDocument={onOpenDocument}
          onOpenFinding={onOpenFinding}
        />
      ) : null}
      {focusCandidates.length ? (
        <div className="church-role-network-v1__sample-actions">
          {focusCandidates.map((person) => (
            <button key={person.id} type="button" onClick={() => onFocusPerson(person.id)}>
              Зробити центром: {compactChurchRoleLabel(person.label, 24)}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function SourceAction({
  source,
  onOpenDocument,
  onOpenFinding,
}: {
  source: ChurchRoleNetworkSource;
  onOpenDocument: (documentId: string) => void;
  onOpenFinding: (findingId: string) => void;
}) {
  const open = source.kind === "finding"
    ? () => onOpenFinding(source.id)
    : source.kind === "document"
      ? () => onOpenDocument(source.id)
      : null;
  const content = (
    <>
      <span>{sourceKindLabel(source.kind)}</span>
      <b>{source.label}</b>
      {source.year ? <time>{source.year}</time> : null}
    </>
  );
  return open ? <button type="button" onClick={open}>{content}</button> : <div>{content}</div>;
}

function ChurchRoleNetworkSkeleton() {
  return (
    <div className="church-role-network-v1__skeleton" aria-label="Завантаження мережі хрещених і поручителів">
      <span className="is-graph" />
      <div><span /><span /><span /></div>
    </div>
  );
}

function uniquePeople(sample: ChurchRoleNetworkSample): Array<{ id: string; label: string }> {
  const people = new Map<string, string>();
  people.set(sample.sourcePersonId, sample.sourceDisplayName);
  people.set(sample.targetPersonId, sample.targetDisplayName);
  return [...people].map(([id, label]) => ({ id, label }));
}

function sourceKindLabel(kind: ChurchRoleNetworkSource["kind"]): string {
  if (kind === "finding") return "Знахідка";
  if (kind === "document") return "Документ";
  if (kind === "document_fragment") return "Фрагмент документа";
  if (kind === "citation") return "Цитата";
  return "Подія";
}

function evidenceStatusLabel(status: ChurchRoleNetworkSample["evidenceStatus"]): string {
  if (status === "proven") return "Підтверджено";
  if (status === "likely") return "Імовірно";
  if (status === "disputed") return "Суперечливо";
  if (status === "disproven") return "Спростовано";
  return "Не перевірено";
}

function personDisplayName(person: Person): string {
  return person.fullName.trim()
    || [person.surname, person.givenName, person.patronymic]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ")
    || "Особа без імені";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  return fallback;
}
