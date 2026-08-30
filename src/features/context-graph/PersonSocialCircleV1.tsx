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
  ContextEvidenceStatus,
  ContextGraphPersonEdge,
  ContextPrivacyStatus,
  ContextRelationType,
  PersonContextCooccurrenceFilters,
  PersonContextCooccurrencesPage,
  PersonContextGraphSnapshot,
  PersonContextRelation,
  PersonContextRelationDraft,
} from "../../types/contextGraph.ts";
import {
  compactSocialCircleLabel,
  isLegacyAmbiguousSocialRelationTypeCode,
  isSpecificSocialRelationTypeCode,
  relatedPersonSocialRoleLabel,
  relationTypeEditorLabel,
  specificReplacementCodesForLegacyRole,
} from "./socialCircleModel.ts";
import {
  cooccurrencePeriodLabel,
  cooccurrenceSharedSourceLabel,
  cooccurrenceSourceKindLabel,
  cooccurrenceStrengthLabel,
  defaultCooccurrenceFilterDraft,
  mergeCooccurrencePages,
  parseCooccurrenceFilterDraft,
  type CooccurrenceFilterDraft,
} from "./cooccurrenceModel.ts";
import { ContextRelationshipGraphV1 } from "./ContextRelationshipGraphV1.tsx";
/* Keep every evidence row, but collapse parallel rows into one visual connection. */
import {
  groupContextRelationshipGraphEdgesByPair,
  type ContextRelationshipGraphEdge,
  type ContextRelationshipGraphNode,
} from "./contextRelationshipGraphModel.ts";
import "./PersonSocialCircleV1.css";

type ContextRelationsService = typeof import("../../services/contextRelationsService.ts");

let servicePromise: Promise<ContextRelationsService> | undefined;

function loadContextRelationsService(): Promise<ContextRelationsService> {
  servicePromise ??= import("../../services/contextRelationsService.ts");
  return servicePromise;
}

type RelationDirection = "center-to-related" | "related-to-center";

interface RelationEditorState {
  relationId: string | null;
  lockVersion: number | null;
  relatedPersonId: string;
  direction: RelationDirection;
  originalDirection: RelationDirection;
  relationTypeId: string;
  sourceRoleLabel: string;
  targetRoleLabel: string;
  periodText: string;
  validFrom: string;
  validTo: string;
  evidenceStatus: ContextEvidenceStatus;
  confidence: number;
  privacyStatus: ContextPrivacyStatus;
  notes: string;
  assertionKind: "manual" | "research_hypothesis";
  metadata: Record<string, unknown>;
}

export interface PersonSocialCircleV1Props {
  projectId: string;
  center: Person;
  persons: readonly Person[];
  canEdit?: boolean;
  readOnly?: boolean;
  onBack?: () => void;
  /** Re-centers the social graph without implying navigation to the full profile. */
  onFocusPerson?: (person: Person) => void;
  /** Opens the person's full card from the relationship list. */
  onOpenPerson?: (person: Person) => void;
  /** ID-based navigation keeps calculated candidates usable without hydrating the full catalogue. */
  onFocusPersonById?: (personId: string) => void;
  onOpenPersonById?: (personId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onOpenFinding?: (findingId: string) => void;
}

export function PersonSocialCircleV1({
  projectId,
  center,
  persons,
  canEdit = false,
  readOnly = false,
  onBack,
  onFocusPerson,
  onOpenPerson,
  onFocusPersonById,
  onOpenPersonById,
  onOpenDocument,
  onOpenFinding,
}: PersonSocialCircleV1Props) {
  const filterTypeId = useId();
  const filterStatusId = useId();
  const editorHeadingId = useId();
  const requestSequence = useRef(0);
  const graphRequestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const contextKey = `${projectId}:${center.id}`;
  const activeContextKey = useRef(contextKey);
  activeContextKey.current = contextKey;
  const [relationTypes, setRelationTypes] = useState<ContextRelationType[]>([]);
  const [relations, setRelations] = useState<PersonContextRelation[]>([]);
  const [graphSnapshot, setGraphSnapshot] = useState<PersonContextGraphSnapshot>({
    centerPersonId: center.id,
    nodes: [],
    edges: [],
    revision: 0,
    truncated: false,
    edgesTruncated: false,
  });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [graphLoading, setGraphLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [graphError, setGraphError] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ContextEvidenceStatus | "all">("all");
  const [editor, setEditor] = useState<RelationEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState("");
  const mayEdit = canEdit && !readOnly;

  const personsById = useMemo(
    () => new Map(persons.map((person) => [person.id, person])),
    [persons],
  );
  const typesById = useMemo(
    () => new Map(relationTypes.map((type) => [type.id, type])),
    [relationTypes],
  );
  const createRelationTypes = useMemo(
    () => relationTypes.filter((type) => !isLegacyAmbiguousSocialRelationTypeCode(type.code)),
    [relationTypes],
  );
  const hasRelatedPersonCandidate = useMemo(
    () => persons.some((person) => person.id !== center.id),
    [center.id, persons],
  );
  const relatedPersonOptions = useMemo(
    () => editor
      ? persons
        .filter((person) => person.id !== center.id)
        .slice()
        .sort((left, right) => personDisplayName(left).localeCompare(personDisplayName(right), "uk"))
      : [],
    [center.id, editor !== null, persons],
  );

  const loadData = useCallback(async (showLoading = true) => {
    const sequence = ++requestSequence.current;
    if (showLoading) setLoading(true);
    setLoadError("");
    try {
      const service = await loadContextRelationsService();
      const [types, page] = await Promise.all([
        service.listContextRelationTypes(projectId),
        service.listPersonContextRelations(projectId, center.id, { limit: 500 }),
      ]);
      if (sequence !== requestSequence.current) return;
      setRelationTypes(types.filter((type) => type.isActive));
      setRelations(page.items.filter((relation) => !relation.deletedAt));
      setRevision((current) => Math.max(current, page.revision));
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setLoadError(errorMessage(error, "Не вдалося завантажити соціальні зв’язки особи."));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [center.id, projectId]);

  const loadGraph = useCallback(async (showLoading = true) => {
    const sequence = ++graphRequestSequence.current;
    if (showLoading) setGraphLoading(true);
    setGraphError("");
    try {
      const service = await loadContextRelationsService();
      const snapshot = await service.getPersonContextGraph(projectId, center.id, {
        maxNodes: 100,
        maxEdges: 250,
        relationTypeIds: typeFilter === "all" ? undefined : [typeFilter],
        evidenceStatuses: statusFilter === "all" ? undefined : [statusFilter],
      });
      if (sequence !== graphRequestSequence.current) return;
      setGraphSnapshot(snapshot);
      setRevision((current) => Math.max(current, snapshot.revision));
    } catch (error) {
      if (sequence !== graphRequestSequence.current) return;
      setGraphSnapshot({
        centerPersonId: center.id,
        nodes: [],
        edges: [],
        revision: 0,
        truncated: false,
        edgesTruncated: false,
      });
      setGraphError(errorMessage(error, "Не вдалося завантажити граф соціального кола."));
    } finally {
      if (sequence === graphRequestSequence.current) setGraphLoading(false);
    }
  }, [center.id, projectId, statusFilter, typeFilter]);

  useEffect(() => {
    void loadData();
    return () => {
      requestSequence.current += 1;
    };
  }, [loadData]);

  useEffect(() => {
    void loadGraph();
    return () => {
      graphRequestSequence.current += 1;
    };
  }, [loadGraph]);

  useEffect(() => {
    mutationSequence.current += 1;
    setSaving(false);
    setEditor(null);
    setMutationError("");
    setNotice("");
    setTypeFilter("all");
    setStatusFilter("all");
  }, [center.id, projectId]);

  const filteredRelations = useMemo(
    () => relations.filter((relation) => {
      if (typeFilter !== "all" && relation.relationTypeId !== typeFilter) return false;
      return statusFilter === "all" || relation.evidenceStatus === statusFilter;
    }),
    [relations, statusFilter, typeFilter],
  );

  const relationshipGraph = useMemo(() => {
    const categoryByPerson = new Map<string, ContextGraphPersonEdge["category"]>();
    graphSnapshot.edges.forEach((edge) => {
      if (edge.sourcePersonId !== center.id && !categoryByPerson.has(edge.sourcePersonId)) {
        categoryByPerson.set(edge.sourcePersonId, edge.category);
      }
      if (edge.targetPersonId !== center.id && !categoryByPerson.has(edge.targetPersonId)) {
        categoryByPerson.set(edge.targetPersonId, edge.category);
      }
    });
    const rawEdges: ContextRelationshipGraphEdge[] = graphSnapshot.edges.map((edge) => ({
      id: `relation:${edge.id}`,
      sourceId: `person:${edge.sourcePersonId}`,
      targetId: `person:${edge.targetPersonId}`,
      label: displayedGraphEdgeLabel(edge, center.id, typesById),
      description: [
        relationshipEdgePeriod(edge),
        evidenceStatusLabel(edge.evidenceStatus),
        `${edge.confidence}% впевненості`,
        `${edge.evidenceCount} ${pluralizeEvidence(edge.evidenceCount)}`,
      ].filter(Boolean).join(" · "),
      directed: edge.directionality === "directed",
    }));
    const edges = groupContextRelationshipGraphEdgesByPair(
      rawEdges,
      `person:${center.id}`,
    );
    const connectionByPerson = new Map<string, ContextRelationshipGraphEdge>();
    edges.forEach((edge) => {
      const personId = edge.sourceId === `person:${center.id}` ? edge.targetId : edge.sourceId;
      connectionByPerson.set(personId, edge);
    });
    const nodes: ContextRelationshipGraphNode[] = graphSnapshot.nodes.map((node) => ({
      id: `person:${node.id}`,
      label: node.displayName || "Приватна особа",
      kind: "person",
      activatable: !node.masked,
      subtitle: node.isCenter
        ? "Центральна особа"
        : connectionByPerson.get(`person:${node.id}`)?.label
          ?? `${node.degree} ${pluralizeRelations(node.degree)}`,
      description: node.masked
        ? "Дані цієї приватної особи приховано."
        : "Людина зі зв’язком першого рівня навколо вибраної особи.",
      color: node.isCenter
        ? "#2cc47d"
        : contextRelationshipColor(categoryByPerson.get(node.id)),
    }));
    const centerNode = nodes.find((node) => node.id === `person:${center.id}`) ?? {
      id: `person:${center.id}`,
      label: personDisplayName(center),
      kind: "person" as const,
      subtitle: "Центральна особа",
      color: "#2cc47d",
    };
    const roleCount = edges.reduce((total, edge) => total + (edge.roles?.length ?? 1), 0);
    return { centerNode, nodes, edges, roleCount };
  }, [center, graphSnapshot.edges, graphSnapshot.nodes, typesById]);

  const openCreate = () => {
    setMutationError("");
    setNotice("");
    setEditor(emptyEditor(createRelationTypes[0]?.id ?? ""));
  };

  const openEdit = (relation: PersonContextRelation) => {
    setMutationError("");
    setNotice("");
    if (!isClientWritableAssertion(relation.assertionKind)) {
      setMutationError(
        "Автоматично або імпортовано створений зв’язок не можна змінювати вручну. Відредагуйте його джерело.",
      );
      return;
    }
    setEditor(editorFromRelation(relation, center.id));
  };

  const submitEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || !mayEdit || saving) return;
    setMutationError("");
    setNotice("");
    if (!editor.relatedPersonId) {
      setMutationError("Оберіть пов’язану особу.");
      return;
    }
    if (!editor.relationTypeId) {
      setMutationError("Оберіть тип зв’язку.");
      return;
    }
    const selectedType = typesById.get(editor.relationTypeId);
    if (!selectedType) {
      setMutationError("Обраний тип зв’язку більше недоступний. Оберіть інший тип.");
      return;
    }
    if (isLegacyAmbiguousSocialRelationTypeCode(selectedType.code)) {
      setMutationError(
        selectedType.code === "godparent"
          ? "Уточніть конкретну роль: «Хрещений батько» або «Хрещена мати»."
          : "Уточніть сторону: «Свідок по нареченій» або «Свідок по нареченому».",
      );
      return;
    }
    const operationContextKey = contextKey;
    const operationId = ++mutationSequence.current;
    const operationIsCurrent = () => (
      activeContextKey.current === operationContextKey
      && mutationSequence.current === operationId
    );
    const draft = editorDraft(editor, center.id, selectedType);
    setSaving(true);
    try {
      const service = await loadContextRelationsService();
      await service.savePersonContextRelation(
        projectId,
        draft,
        editor.lockVersion ?? undefined,
      );
      if (!operationIsCurrent()) return;
      setEditor(null);
      setNotice(editor.relationId ? "Зв’язок оновлено." : "Зв’язок додано до соціального кола.");
      await Promise.all([loadData(false), loadGraph(false)]);
    } catch (error) {
      if (!operationIsCurrent()) return;
      setMutationError(errorMessage(error, "Не вдалося зберегти контекстний зв’язок."));
    } finally {
      if (operationIsCurrent()) setSaving(false);
    }
  };

  const archiveRelation = async (relation: PersonContextRelation) => {
    if (!mayEdit || saving) return;
    if (!isClientWritableAssertion(relation.assertionKind)) {
      setMutationError(
        "Автоматично або імпортовано створений зв’язок архівується через знахідку чи інше джерело.",
      );
      return;
    }
    const related = personsById.get(relatedPersonId(relation, center.id));
    const label = personDisplayName(related, "цю особу");
    if (!window.confirm(`Архівувати контекстний зв’язок з «${label}»?`)) return;
    const operationContextKey = contextKey;
    const operationId = ++mutationSequence.current;
    const operationIsCurrent = () => (
      activeContextKey.current === operationContextKey
      && mutationSequence.current === operationId
    );
    setMutationError("");
    setNotice("");
    setSaving(true);
    try {
      const service = await loadContextRelationsService();
      await service.archivePersonContextRelation(projectId, relation.id, relation.lockVersion);
      if (!operationIsCurrent()) return;
      if (editor?.relationId === relation.id) setEditor(null);
      setNotice("Зв’язок переміщено до архіву.");
      await Promise.all([loadData(false), loadGraph(false)]);
    } catch (error) {
      if (!operationIsCurrent()) return;
      setMutationError(errorMessage(error, "Не вдалося архівувати контекстний зв’язок."));
    } finally {
      if (operationIsCurrent()) setSaving(false);
    }
  };

  return (
    <section className="context-social-v1" aria-labelledby="context-social-v1-title">
      <header className="context-social-v1__header">
        <div className="context-social-v1__compact-title">
          <h2 id="context-social-v1-title">Люди поруч</h2>
          <span>
            {relationshipGraph.edges.length} {pluralizePeople(relationshipGraph.edges.length)} · {relationshipGraph.roleCount} {pluralizeRoles(relationshipGraph.roleCount)}
          </span>
        </div>
        <div className="context-social-v1__header-actions">
          {onBack ? (
            <button type="button" className="context-social-v1__button is-secondary" onClick={onBack}>
              ← Назад
            </button>
          ) : null}
          {mayEdit ? (
            <button
              type="button"
              className="context-social-v1__button is-primary"
              onClick={openCreate}
              disabled={loading || saving || !createRelationTypes.length || !hasRelatedPersonCandidate}
            >
              + Додати вручну
            </button>
          ) : null}
        </div>
      </header>

      <details className="context-social-v1__source-note">
        <summary>Як тут з’являються зв’язки?</summary>
        <div role="note">
          <strong>Більшість зв’язків додаються автоматично зі знахідок.</strong>
          <span>
            Вкажіть у знахідці учасників та їхні точні ролі — і вони з’являться тут.
            Ці зв’язки не створюють споріднення та не змінюють родове дерево.
          </span>
        </div>
      </details>

      {loadError ? (
        <div className="context-social-v1__message is-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadData()} disabled={loading}>Повторити</button>
        </div>
      ) : null}
      {notice ? <div className="context-social-v1__message is-success" role="status">{notice}</div> : null}
      {mutationError && !editor ? (
        <div className="context-social-v1__message is-error" role="alert">{mutationError}</div>
      ) : null}

      {editor ? (
        <RelationEditor
          headingId={editorHeadingId}
          value={editor}
          center={center}
          relationTypes={relationTypes}
          people={relatedPersonOptions}
          saving={saving}
          error={mutationError}
          onChange={setEditor}
          onCancel={() => {
            setEditor(null);
            setMutationError("");
          }}
          onSubmit={submitEditor}
        />
      ) : null}

      <div className="context-social-v1__content">
        <section className="context-social-v1__network" aria-label="Інтерактивна мережа людей і ролей">
          {graphError ? (
            <div className="context-social-v1__message is-error" role="alert">
              <span>{graphError}</span>
              <button type="button" onClick={() => void loadGraph()} disabled={graphLoading}>Повторити</button>
            </div>
          ) : null}
          {graphLoading ? (
            <SocialCircleSkeleton />
          ) : (
            <ContextRelationshipGraphV1
              centerNode={relationshipGraph.centerNode}
              nodes={relationshipGraph.nodes}
              edges={relationshipGraph.edges}
              title="Хто і як пов’язаний з цією особою"
              initialMode="3d"
              centerConnectionLabels="node"
              maxNodes={100}
              maxEdges={250}
              onNodeActivate={(node) => {
                if (node.activatable === false) return;
                const personId = node.id.startsWith("person:") ? node.id.slice(7) : "";
                if (!personId) return;
                if (onOpenPersonById) {
                  onOpenPersonById(personId);
                  return;
                }
                const person = personsById.get(personId);
                if (person) onOpenPerson?.(person);
              }}
            />
          )}
          {graphSnapshot.truncated ? (
            <p className="context-social-v1__truncated" role="status">
              Показано перші 100 доступних осіб. Уточніть фільтри, щоб звузити коло.
            </p>
          ) : null}
          {graphSnapshot.edgesTruncated ? (
            <p className="context-social-v1__truncated" role="status">
              Частину паралельних зв’язків приховано через безпечний ліміт. Уточніть фільтри, щоб побачити потрібні зв’язки.
            </p>
          ) : null}
        </section>

        <details className="context-social-v1__relations">
          <summary className="context-social-v1__relations-heading">
            <span id="context-social-v1-relations-title">
              <strong>Люди та їхні ролі</strong>
              <small>Список, фільтри та ручне редагування</small>
            </span>
            <b>{filteredRelations.length}</b>
          </summary>
          <details className="context-social-v1__disclosure context-social-v1__filter-disclosure">
            <summary>
              <span>
                <strong>Фільтри списку</strong>
                <small>Тип зв’язку та стан перевірки</small>
              </span>
            </summary>
            <div className="context-social-v1__filters" aria-label="Фільтри соціального кола">
              <label htmlFor={filterTypeId}>
                <span>Тип зв’язку</span>
                <select id={filterTypeId} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  <option value="all">Усі типи</option>
                  {relationTypes.map((type) => (
                    <option key={type.id} value={type.id}>{relationTypeEditorLabel(type.code, type.labelUk)}</option>
                  ))}
                </select>
              </label>
              <label htmlFor={filterStatusId}>
                <span>Стан перевірки</span>
                <select
                  id={filterStatusId}
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as ContextEvidenceStatus | "all")}
                >
                  <option value="all">Усі стани</option>
                  {EVIDENCE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="context-social-v1__filter-summary" aria-live="polite">
                <strong>{filteredRelations.length}</strong>
                <span>{pluralizeRelations(filteredRelations.length)}</span>
                {revision > 0 ? <small>Версія даних: {revision}</small> : null}
              </div>
            </div>
          </details>
          {loading ? (
            <div className="context-social-v1__card-skeletons" aria-label="Завантаження зв’язків">
              <span /><span /><span />
            </div>
          ) : filteredRelations.length ? (
            <ul className="context-social-v1__relation-list">
              {filteredRelations.map((relation) => {
                const personId = relatedPersonId(relation, center.id);
                const person = personsById.get(personId);
                return (
                  <li key={relation.id}>
                    <article className="context-social-v1__relation-card">
                      <div className="context-social-v1__relation-card-header">
                        <div>
                          <button
                            type="button"
                            className="context-social-v1__person-link"
                            disabled={!person || !onOpenPerson}
                            onClick={() => person && onOpenPerson?.(person)}
                          >
                            {personDisplayName(person, personId)}
                          </button>
                          <strong>{displayedRelationLabel(relation, center.id, typesById)}</strong>
                        </div>
                        <div className="context-social-v1__relation-badges">
                          <span className={`context-social-v1__status is-${relation.evidenceStatus}`}>
                            {evidenceStatusLabel(relation.evidenceStatus)}
                          </span>
                          <span className={`context-social-v1__assertion is-${relation.assertionKind}`}>
                            {assertionKindLabel(relation.assertionKind)}
                          </span>
                        </div>
                      </div>
                      <dl>
                        <div><dt>Період</dt><dd>{relationPeriod(relation)}</dd></div>
                        <div><dt>Впевненість</dt><dd>{relation.confidence}%</dd></div>
                        <div><dt>Доступ</dt><dd>{privacyLabel(relation.privacyStatus)}</dd></div>
                        <div><dt>Підстави</dt><dd>{relation.evidenceCount || "Немає"}</dd></div>
                      </dl>
                      {relation.notes ? <p className="context-social-v1__relation-notes">{relation.notes}</p> : null}
                      {mayEdit ? (
                        <div className="context-social-v1__relation-actions">
                          <button
                            type="button"
                            onClick={() => openEdit(relation)}
                            disabled={saving || !isClientWritableAssertion(relation.assertionKind)}
                            title={!isClientWritableAssertion(relation.assertionKind)
                              ? "Автоматичний або імпортований зв’язок редагується через його джерело."
                              : undefined}
                          >
                            Редагувати
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            onClick={() => void archiveRelation(relation)}
                            disabled={saving || !isClientWritableAssertion(relation.assertionKind)}
                            title={!isClientWritableAssertion(relation.assertionKind)
                              ? "Автоматичний або імпортований зв’язок архівується через його джерело."
                              : undefined}
                          >
                            Архівувати
                          </button>
                          {!isClientWritableAssertion(relation.assertionKind) ? (
                            <small className="context-social-v1__provenance-note">
                              {assertionKindLabel(relation.assertionKind)} · зміна й архівування лише через знахідку або інше джерело
                            </small>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="context-social-v1__relations-empty">
              Немає людей для показу. Додайте учасників і точні ролі у знахідці або створіть зв’язок вручну.
            </p>
          )}
        </details>
      </div>

      <PersonCooccurrencePanel
        projectId={projectId}
        center={center}
        persons={persons}
        onFocusPerson={onFocusPerson}
        onOpenPerson={onOpenPerson}
        onFocusPersonById={onFocusPersonById}
        onOpenPersonById={onOpenPersonById}
        onOpenDocument={onOpenDocument}
        onOpenFinding={onOpenFinding}
      />
    </section>
  );
}

interface AppliedCooccurrenceFilters {
  contextKey: string;
  value: PersonContextCooccurrenceFilters;
}

interface CooccurrenceRetryState {
  filters: PersonContextCooccurrenceFilters;
  append: boolean;
}

interface PersonCooccurrencePanelProps {
  projectId: string;
  center: Person;
  persons: readonly Person[];
  onFocusPerson?: (person: Person) => void;
  onOpenPerson?: (person: Person) => void;
  onFocusPersonById?: (personId: string) => void;
  onOpenPersonById?: (personId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onOpenFinding?: (findingId: string) => void;
}

function PersonCooccurrencePanel({
  projectId,
  center,
  persons,
  onFocusPerson,
  onOpenPerson,
  onFocusPersonById,
  onOpenPersonById,
  onOpenDocument,
  onOpenFinding,
}: PersonCooccurrencePanelProps) {
  const headingId = useId();
  const requestSequence = useRef(0);
  const contextKey = `${projectId}:${center.id}`;
  const activeContextKey = useRef(contextKey);
  activeContextKey.current = contextKey;
  const initialDraft = defaultCooccurrenceFilterDraft;
  const [filterDraft, setFilterDraft] = useState<CooccurrenceFilterDraft>(initialDraft);
  const [appliedFilters, setAppliedFilters] = useState<AppliedCooccurrenceFilters>(() => ({
    contextKey,
    value: parseCooccurrenceFilterDraft(initialDraft()),
  }));
  const [page, setPage] = useState<PersonContextCooccurrencesPage | null>(null);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [filterError, setFilterError] = useState("");
  const [retryState, setRetryState] = useState<CooccurrenceRetryState | null>(null);

  const personsById = useMemo(
    () => new Map(persons.map((person) => [person.id, person])),
    [persons],
  );
  const activeFilters = appliedFilters.contextKey === contextKey
    ? appliedFilters.value
    : null;
  const hasMoreResults = Boolean(
    page?.truncated && page.items.length < page.total,
  );
  const calculationLimited = Boolean(
    page?.truncated && page.items.length >= page.total,
  );

  const loadCooccurrences = useCallback(async (
    filters: PersonContextCooccurrenceFilters,
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
    }
    setLoadError("");
    setRetryState(null);
    try {
      const service = await loadContextRelationsService();
      const result = await service.listPersonContextCooccurrencesV1(
        projectId,
        center.id,
        filters,
      );
      if (
        sequence !== requestSequence.current
        || requestContextKey !== activeContextKey.current
      ) return;
      setPage((current) => append && current
        ? mergeCooccurrencePages(current, result)
        : result);
      setNextOffset((current) => append
        ? current + result.items.length
        : result.items.length);
    } catch (loadError) {
      if (
        sequence !== requestSequence.current
        || requestContextKey !== activeContextKey.current
      ) return;
      if (!append) setPage(null);
      setRetryState({ filters, append });
      setLoadError(errorMessage(loadError, "Не вдалося обчислити людей зі спільних згадок."));
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
    const nextDraft = defaultCooccurrenceFilterDraft();
    setFilterDraft(nextDraft);
    setAppliedFilters({
      contextKey,
      value: parseCooccurrenceFilterDraft(nextDraft),
    });
    setPage(null);
    setNextOffset(0);
    setLoadingMore(false);
    setLoadError("");
    setFilterError("");
    setRetryState(null);
  }, [appliedFilters.contextKey, contextKey]);

  useEffect(() => {
    if (!activeFilters) return undefined;
    void loadCooccurrences(activeFilters);
    return () => {
      requestSequence.current += 1;
    };
  }, [activeFilters, loadCooccurrences]);

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const next = parseCooccurrenceFilterDraft(filterDraft);
      setFilterError("");
      setAppliedFilters({ contextKey, value: next });
    } catch (validationError) {
      setFilterError(errorMessage(validationError, "Перевірте фільтри спільних згадок."));
    }
  };

  const resetFilters = () => {
    const nextDraft = defaultCooccurrenceFilterDraft();
    setFilterDraft(nextDraft);
    setLoadError("");
    setFilterError("");
    setRetryState(null);
    setAppliedFilters({
      contextKey,
      value: parseCooccurrenceFilterDraft(nextDraft),
    });
  };

  return (
    <details className="context-social-v1__cooccurrences context-social-v1__disclosure">
      <summary className="context-social-v1__cooccurrence-summary">
        <span>
          <strong>Повторювані згадки</strong>
          <small>Дослідницька аналітика людей, які часто трапляються в тих самих джерелах</small>
        </span>
        {page ? <b>{page.total}</b> : null}
      </summary>
      <div className="context-social-v1__cooccurrence-body">
        <header className="context-social-v1__cooccurrence-header">
        <div>
          <span className="context-social-v1__eyebrow">Інструмент для дослідників</span>
          <h3 id={headingId}>Хто часто зустрічається поруч</h3>
          <p>
            Рейтинг обчислюється зі спільних знахідок, документів і реальних структурованих подій.
            Це дослідницька підказка, а не доказ споріднення і не новий родинний зв’язок.
          </p>
        </div>
        {page ? (
          <div className="context-social-v1__cooccurrence-total" aria-live="polite">
            <strong>{page.total}</strong>
            <span>осіб у рейтингу</span>
          </div>
        ) : null}
        </header>

      <form className="context-social-v1__cooccurrence-filters" onSubmit={applyFilters}>
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
        <label>
          <span>Мінімум спільних джерел</span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="1000"
            required
            value={filterDraft.minShared}
            onChange={(event) => setFilterDraft((current) => ({
              ...current,
              minShared: event.target.value,
            }))}
          />
        </label>
        <div className="context-social-v1__cooccurrence-filter-actions">
          <button type="submit" className="context-social-v1__button is-primary" disabled={loading}>
            Застосувати
          </button>
          <button type="button" className="context-social-v1__button is-secondary" onClick={resetFilters} disabled={loading}>
            Скинути
          </button>
        </div>
      </form>

      {filterError ? (
        <div className="context-social-v1__message is-error" role="alert">
          {filterError}
        </div>
      ) : null}

      {loadError ? (
        <div className="context-social-v1__message is-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => retryState && void loadCooccurrences(retryState.filters, retryState.append)}
            disabled={loading || loadingMore || !retryState}
          >
            Повторити
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="context-social-v1__cooccurrence-skeleton" aria-label="Обчислення спільних згадок">
          <span /><span /><span />
        </div>
      ) : page?.items.length ? (
        <ol className="context-social-v1__cooccurrence-list">
          {page.items.map((item) => {
            const person = personsById.get(item.personId);
            const mayOpen = !item.masked && Boolean(onOpenPersonById || (person && onOpenPerson));
            const mayFocus = !item.masked && Boolean(onFocusPersonById || (person && onFocusPerson));
            return (
              <li key={item.personId}>
                <article className="context-social-v1__cooccurrence-card">
                  <div className="context-social-v1__cooccurrence-person">
                    <span className="context-social-v1__cooccurrence-rank" aria-hidden="true" />
                    <div>
                      <strong>{item.displayName}</strong>
                      <small>{cooccurrenceSharedSourceLabel(item.sharedSourceCount)}</small>
                    </div>
                    <span className="context-social-v1__cooccurrence-strength" title="Рейтинг повторюваності, не ймовірність споріднення">
                      {cooccurrenceStrengthLabel(item.relationStrength)}
                    </span>
                  </div>
                  <dl className="context-social-v1__cooccurrence-counts">
                    <div><dt>Знахідки</dt><dd>{item.sharedFindingCount}</dd></div>
                    <div><dt>Документи</dt><dd>{item.sharedDocumentCount}</dd></div>
                    <div title="Спільні структуровані події"><dt>Структуровані події</dt><dd>{item.sharedEventCount}</dd></div>
                    <div><dt>Період</dt><dd>{cooccurrencePeriodLabel(item)}</dd></div>
                  </dl>
                  {item.topSources.length ? (
                    <details className="context-social-v1__cooccurrence-source-details">
                      <summary>Показати спільні джерела ({item.topSources.length})</summary>
                      <ul className="context-social-v1__cooccurrence-sources">
                        {item.topSources.map((source) => {
                          const openSource = source.kind === "finding"
                            ? onOpenFinding
                            : source.kind === "document"
                              ? onOpenDocument
                              : undefined;
                          const content = (
                            <>
                              <span>{cooccurrenceSourceKindLabel(source.kind)}</span>
                              <b>{source.label}</b>
                              {source.year ? <time>{source.year}</time> : null}
                            </>
                          );
                          return (
                            <li key={`${source.kind}:${source.id}`}>
                              {openSource ? (
                                <button type="button" onClick={() => openSource(source.id)}>
                                  {content}
                                </button>
                              ) : (
                                <div>{content}</div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  ) : null}
                  <div className="context-social-v1__cooccurrence-actions">
                    <button
                      type="button"
                      disabled={!mayOpen}
                      onClick={() => {
                        if (item.masked) return;
                        if (onOpenPersonById) onOpenPersonById(item.personId);
                        else if (person) onOpenPerson?.(person);
                      }}
                    >
                      Відкрити особу
                    </button>
                    <button
                      type="button"
                      disabled={!mayFocus}
                      onClick={() => {
                        if (item.masked) return;
                        if (onFocusPersonById) onFocusPersonById(item.personId);
                        else if (person) onFocusPerson?.(person);
                      }}
                    >
                      Зробити центром
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="context-social-v1__cooccurrence-empty">
          <strong>Повторюваних спільних згадок не знайдено</strong>
          <p>Зменште мінімальну кількість джерел або розширте період.</p>
        </div>
      )}

      {hasMoreResults && page ? (
        <div className="context-social-v1__cooccurrence-more">
          <p role="status">
            Показано {page.items.length} результатів із {page.total}.
          </p>
          <button
            type="button"
            className="context-social-v1__button is-secondary"
            disabled={loading || loadingMore || !activeFilters}
            onClick={() => {
              if (!activeFilters) return;
              void loadCooccurrences({ ...activeFilters, offset: nextOffset }, true);
            }}
          >
            {loadingMore ? "Завантаження…" : "Показати ще"}
          </button>
        </div>
      ) : null}

      {calculationLimited ? (
        <p className="context-social-v1__cooccurrence-limit" role="status">
          Розрахунок обмежено, уточніть фільтри.
        </p>
      ) : null}
      </div>
    </details>
  );
}

interface RelationEditorProps {
  headingId: string;
  value: RelationEditorState;
  center: Person;
  relationTypes: readonly ContextRelationType[];
  people: readonly Person[];
  saving: boolean;
  error: string;
  onChange: (value: RelationEditorState) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function RelationEditor({
  headingId,
  value,
  center,
  relationTypes,
  people,
  saving,
  error,
  onChange,
  onCancel,
  onSubmit,
}: RelationEditorProps) {
  const selectedType = relationTypes.find((type) => type.id === value.relationTypeId);
  const selectedRelated = people.find((person) => person.id === value.relatedPersonId);
  const directed = selectedType?.directionality !== "symmetric";
  const isLegacyType = isLegacyAmbiguousSocialRelationTypeCode(selectedType?.code ?? "");
  const legacyReplacementCodes = specificReplacementCodesForLegacyRole(selectedType?.code ?? "");
  const availableTypes = relationTypes.filter((type) => (
    isLegacyType
      ? type.id === value.relationTypeId || legacyReplacementCodes.includes(
        type.code as (typeof legacyReplacementCodes)[number],
      )
      : !isLegacyAmbiguousSocialRelationTypeCode(type.code)
  ));
  const update = <Key extends keyof RelationEditorState>(key: Key, next: RelationEditorState[Key]) => {
    onChange({ ...value, [key]: next });
  };
  return (
    <section className="context-social-v1__editor" aria-labelledby={headingId}>
      <div className="context-social-v1__editor-heading">
        <div>
          <span className="context-social-v1__eyebrow">Ручне твердження</span>
          <h3 id={headingId}>{value.relationId ? "Редагувати зв’язок" : "Додати зв’язок"}</h3>
        </div>
        <button type="button" className="context-social-v1__editor-close" onClick={onCancel} aria-label="Закрити форму">×</button>
      </div>
      <form onSubmit={onSubmit}>
        <label className="is-wide">
          <span>Пов’язана особа</span>
          <select
            value={value.relatedPersonId}
            onChange={(event) => update("relatedPersonId", event.target.value)}
            required
            autoFocus
          >
            <option value="">Оберіть особу</option>
            {people.map((person) => <option key={person.id} value={person.id}>{personDisplayName(person)}</option>)}
          </select>
        </label>
        <label>
          <span>Тип зв’язку</span>
          <select
            value={value.relationTypeId}
            onChange={(event) => {
              const nextType = relationTypes.find((type) => type.id === event.target.value);
              onChange({
                ...value,
                relationTypeId: event.target.value,
                sourceRoleLabel: nextType?.sourceRoleUk ?? "",
                targetRoleLabel: nextType?.targetRoleUk ?? "",
              });
            }}
            required
          >
            <option value="">Оберіть тип</option>
            {availableTypes.map((type) => (
              <option
                key={type.id}
                value={type.id}
                disabled={isLegacyAmbiguousSocialRelationTypeCode(type.code)}
              >
                {relationTypeEditorLabel(type.code, type.labelUk)}
              </option>
            ))}
          </select>
          {isLegacyType ? (
            <small className="context-social-v1__role-warning">
              Старий запис збережено, але роль неоднозначна. Оберіть один із двох точних варіантів нижче у списку.
            </small>
          ) : null}
        </label>
        <label>
          <span>{directed ? "Хто виконує роль щодо іншої особи?" : "Напрямок"}</span>
          <select
            value={value.direction}
            onChange={(event) => update("direction", event.target.value as RelationDirection)}
            disabled={!directed}
          >
            <option value="center-to-related">
              {directionOptionLabel(center, selectedRelated, selectedType, true)}
            </option>
            <option value="related-to-center">
              {directionOptionLabel(center, selectedRelated, selectedType, false)}
            </option>
          </select>
          {!directed ? <small>Цей тип взаємний — напрямок не впливає на зміст.</small> : null}
          {directed ? (
            <small>Перша особа виконує зазначену роль щодо другої конкретної особи.</small>
          ) : null}
        </label>
        <label>
          <span>Період словами</span>
          <input
            value={value.periodText}
            onChange={(event) => update("periodText", event.target.value)}
            placeholder="Наприклад: близько 1890–1895"
          />
        </label>
        <label>
          <span>Дата від</span>
          <input
            type="date"
            value={value.validFrom}
            onChange={(event) => update("validFrom", event.target.value)}
          />
          <small>Для приблизної або неповної дати використайте поле «Період словами».</small>
        </label>
        <label>
          <span>Дата до</span>
          <input
            type="date"
            value={value.validTo}
            onChange={(event) => update("validTo", event.target.value)}
          />
          <small>Зберігається повна календарна дата.</small>
        </label>
        <label>
          <span>Стан перевірки</span>
          <select
            value={value.evidenceStatus}
            onChange={(event) => update("evidenceStatus", event.target.value as ContextEvidenceStatus)}
          >
            {EVIDENCE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>Характер твердження</span>
          <select
            value={value.assertionKind}
            onChange={(event) => update("assertionKind", event.target.value as RelationEditorState["assertionKind"])}
          >
            <option value="manual">Внесено вручну</option>
            <option value="research_hypothesis">Дослідницька гіпотеза</option>
          </select>
        </label>
        <label>
          <span>Доступ</span>
          <select
            value={value.privacyStatus}
            onChange={(event) => update("privacyStatus", event.target.value as ContextPrivacyStatus)}
          >
            {PRIVACY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="is-wide context-social-v1__confidence">
          <span>Впевненість: <output>{value.confidence}%</output></span>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={value.confidence}
            onChange={(event) => update("confidence", Number(event.target.value))}
          />
        </label>
        <label className="is-wide">
          <span>Примітка</span>
          <textarea rows={3} value={value.notes} onChange={(event) => update("notes", event.target.value)} />
        </label>
        {error ? <div className="context-social-v1__form-error is-wide" role="alert">{error}</div> : null}
        <div className="context-social-v1__editor-actions is-wide">
          <button type="button" className="context-social-v1__button is-secondary" onClick={onCancel} disabled={saving}>Скасувати</button>
          <button type="submit" className="context-social-v1__button is-primary" disabled={saving}>
            {saving ? "Збереження…" : value.relationId ? "Зберегти зміни" : "Додати зв’язок"}
          </button>
        </div>
      </form>
    </section>
  );
}

function SocialCircleSkeleton() {
  return (
    <div className="context-social-v1__graph-skeleton" aria-label="Завантаження соціального кола">
      <span className="is-center" />
      <span className="is-one" />
      <span className="is-two" />
      <span className="is-three" />
    </div>
  );
}

function emptyEditor(relationTypeId: string): RelationEditorState {
  return {
    relationId: null,
    lockVersion: null,
    relatedPersonId: "",
    direction: "center-to-related",
    originalDirection: "center-to-related",
    relationTypeId,
    sourceRoleLabel: "",
    targetRoleLabel: "",
    periodText: "",
    validFrom: "",
    validTo: "",
    evidenceStatus: "unknown",
    confidence: 50,
    privacyStatus: "project",
    notes: "",
    assertionKind: "manual",
    metadata: {},
  };
}

function editorFromRelation(relation: PersonContextRelation, centerId: string): RelationEditorState {
  const direction: RelationDirection = relation.sourcePersonId === centerId
    ? "center-to-related"
    : "related-to-center";
  return {
    relationId: relation.id,
    lockVersion: relation.lockVersion,
    relatedPersonId: relatedPersonId(relation, centerId),
    direction,
    originalDirection: direction,
    relationTypeId: relation.relationTypeId,
    sourceRoleLabel: relation.sourceRoleLabel,
    targetRoleLabel: relation.targetRoleLabel,
    periodText: relation.periodText,
    validFrom: relation.validFrom,
    validTo: relation.validTo,
    evidenceStatus: relation.evidenceStatus,
    confidence: relation.confidence,
    privacyStatus: relation.privacyStatus,
    notes: relation.notes,
    assertionKind: relation.assertionKind === "research_hypothesis" ? "research_hypothesis" : "manual",
    metadata: relation.metadata,
  };
}

function editorDraft(
  editor: RelationEditorState,
  centerId: string,
  selectedType?: ContextRelationType,
): PersonContextRelationDraft {
  const centerIsSource = editor.direction === "center-to-related";
  const endpointsReversed = editor.relationId !== null && editor.direction !== editor.originalDirection;
  const useTypeRoles = isSpecificSocialRelationTypeCode(selectedType?.code ?? "")
    || editor.relationId === null
    || (selectedType !== undefined && (
      selectedType.sourceRoleUk !== editor.sourceRoleLabel
      || selectedType.targetRoleUk !== editor.targetRoleLabel
    ));
  return {
    ...(editor.relationId ? { id: editor.relationId } : {}),
    relationTypeId: editor.relationTypeId,
    sourcePersonId: centerIsSource ? centerId : editor.relatedPersonId,
    targetPersonId: centerIsSource ? editor.relatedPersonId : centerId,
    sourceRoleLabel: useTypeRoles
      ? selectedType?.sourceRoleUk ?? editor.sourceRoleLabel
      : endpointsReversed ? editor.targetRoleLabel : editor.sourceRoleLabel,
    targetRoleLabel: useTypeRoles
      ? selectedType?.targetRoleUk ?? editor.targetRoleLabel
      : endpointsReversed ? editor.sourceRoleLabel : editor.targetRoleLabel,
    periodText: editor.periodText,
    validFrom: editor.validFrom,
    validTo: editor.validTo,
    evidenceStatus: editor.evidenceStatus,
    confidence: editor.confidence,
    privacyStatus: editor.privacyStatus,
    assertionKind: editor.assertionKind,
    notes: editor.notes,
    metadata: editor.metadata,
  };
}

function displayedRelationLabel(
  relation: PersonContextRelation,
  centerId: string,
  typesById: ReadonlyMap<string, ContextRelationType>,
): string {
  const type = typesById.get(relation.relationTypeId);
  const relatedIsSource = relation.sourcePersonId !== centerId;
  return relatedPersonSocialRoleLabel({
    relationTypeCode: relation.relationTypeCode || type?.code || "",
    relatedIsSource,
    sourceRoleLabel: relation.sourceRoleLabel,
    targetRoleLabel: relation.targetRoleLabel,
    fallbackSourceRoleLabel: type?.sourceRoleUk,
    fallbackTargetRoleLabel: type?.targetRoleUk,
    fallbackRelationLabel: relation.relationTypeLabel,
  });
}

function displayedGraphEdgeLabel(
  edge: ContextGraphPersonEdge,
  centerId: string,
  typesById: ReadonlyMap<string, ContextRelationType>,
): string {
  const type = typesById.get(edge.relationTypeId);
  const relatedIsSource = edge.sourcePersonId !== centerId;
  return relatedPersonSocialRoleLabel({
    relationTypeCode: edge.relationTypeCode || type?.code || "",
    relatedIsSource,
    sourceRoleLabel: edge.sourceRoleLabel,
    targetRoleLabel: edge.targetRoleLabel,
    fallbackSourceRoleLabel: type?.sourceRoleUk,
    fallbackTargetRoleLabel: type?.targetRoleUk,
    fallbackRelationLabel: edge.relationTypeLabel,
  });
}

function relatedPersonId(relation: PersonContextRelation, centerId: string): string {
  return relation.sourcePersonId === centerId ? relation.targetPersonId : relation.sourcePersonId;
}

function relationPeriod(relation: PersonContextRelation): string {
  if (relation.periodText) return relation.periodText;
  if (relation.validFrom && relation.validTo) return `${relation.validFrom} — ${relation.validTo}`;
  if (relation.validFrom) return `від ${relation.validFrom}`;
  if (relation.validTo) return `до ${relation.validTo}`;
  return "Не вказано";
}

function relationshipEdgePeriod(edge: ContextGraphPersonEdge): string {
  if (edge.periodText.trim()) return edge.periodText.trim();
  if (edge.validFrom && edge.validTo) return `${edge.validFrom} — ${edge.validTo}`;
  if (edge.validFrom) return `від ${edge.validFrom}`;
  if (edge.validTo) return `до ${edge.validTo}`;
  return "Період не вказано";
}

function contextRelationshipColor(category?: ContextGraphPersonEdge["category"]): string {
  switch (category) {
    case "church": return "#9d70ad";
    case "household": return "#c18a2d";
    case "social": return "#33806b";
    case "military": return "#747d4b";
    case "documentary": return "#527ca8";
    case "research": return "#a65b56";
    case "occupation": return "#8a7049";
    case "education": return "#537c91";
    case "other": return "#87938f";
    default: return "#33806b";
  }
}

function personDisplayName(person: Person | undefined, fallback = "Особа без імені"): string {
  if (!person) return fallback;
  return person.fullName.trim()
    || [person.surname, person.givenName, person.patronymic].map((value) => value.trim()).filter(Boolean).join(" ")
    || fallback;
}

function evidenceStatusLabel(status: ContextEvidenceStatus): string {
  return EVIDENCE_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? "Не перевірено";
}

function privacyLabel(status: ContextPrivacyStatus): string {
  return PRIVACY_OPTIONS.find((option) => option.value === status)?.label ?? "Проєкт";
}

function assertionKindLabel(kind: PersonContextRelation["assertionKind"]): string {
  if (kind === "research_hypothesis") return "Гіпотеза";
  if (kind === "generated") return "Автоматично";
  if (kind === "legacy_import") return "Імпортовано";
  return "Вручну";
}

function isClientWritableAssertion(kind: PersonContextRelation["assertionKind"]): boolean {
  return kind === "manual" || kind === "research_hypothesis";
}

function directionOptionLabel(
  center: Person,
  related: Person | undefined,
  relationType: ContextRelationType | undefined,
  centerIsSource: boolean,
): string {
  if (relationType?.directionality === "symmetric") return "Взаємний зв’язок";
  const centerName = compactSocialCircleLabel(personDisplayName(center), 24);
  const relatedName = compactSocialCircleLabel(personDisplayName(related, "Пов’язана особа"), 24);
  const sourceRole = relationType?.sourceRoleUk || relationType?.labelUk || "ініціатор зв’язку";
  const targetRole = relationType?.targetRoleUk || relationType?.inverseLabelUk || "пов’язана особа";
  return centerIsSource
    ? `${centerName} — ${sourceRole} для ${relatedName} (${targetRole})`
    : `${relatedName} — ${sourceRole} для ${centerName} (${targetRole})`;
}

function pluralizeRelations(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "зв’язок";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "зв’язки";
  return "зв’язків";
}

function pluralizePeople(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "людина";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "людини";
  return "людей";
}

function pluralizeRoles(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "роль";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "ролі";
  return "ролей";
}

function pluralizeEvidence(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "доказ";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "докази";
  return "доказів";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  return fallback;
}

const EVIDENCE_STATUS_OPTIONS: ReadonlyArray<{ value: ContextEvidenceStatus; label: string }> = [
  { value: "unknown", label: "Не перевірено" },
  { value: "likely", label: "Ймовірно" },
  { value: "proven", label: "Підтверджено" },
  { value: "disputed", label: "Спірно" },
  { value: "disproven", label: "Спростовано" },
];

const PRIVACY_OPTIONS: ReadonlyArray<{ value: ContextPrivacyStatus; label: string }> = [
  { value: "project", label: "Доступ у проєкті" },
  { value: "private", label: "Приватний запис у проєкті" },
  { value: "confidential", label: "Конфіденційний запис" },
  { value: "public", label: "Публічний запис" },
];
