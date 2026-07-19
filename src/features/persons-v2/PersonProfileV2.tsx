import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  ArchiveRequest,
  DocumentRecord,
  Finding,
  Hypothesis,
  Person,
  PersonRelation,
  Research,
  TaskRecord,
} from "../../types";
import {
  buildPersonTimeline,
  calculatePersonProfileCompleteness,
  personDisplayName,
  personInitials,
  personLifeYears,
  personMainPlaces,
  personRelationLabel,
  type PersonTimelineItem,
} from "./model";
import { PersonTimelineV2 } from "./PersonTimelineV2";
import { PersonLifeMapV2 } from "./PersonLifeMapV2.tsx";
import {
  resolvedFindingSourceUrl,
  stripFindingSourceUrls,
} from "../../utils/findingSourceUrl.ts";

export type PersonProfileTabV2 =
  | "overview"
  | "timeline"
  | "family"
  | "documents"
  | "findings"
  | "notes";

export type PersonProfileRelatedPageV2 =
  | "documents"
  | "findings"
  | "tasks"
  | "hypotheses"
  | "archiveRequests";

export type PersonProfileCreatableRelatedPageV2 = Exclude<
  PersonProfileRelatedPageV2,
  "documents"
>;

type PersonProfileRelatedRecordV2 =
  | DocumentRecord
  | Finding
  | TaskRecord
  | Hypothesis
  | ArchiveRequest;

export interface PersonProfileV2Props {
  person: Person;
  research?: Research | null;
  persons?: readonly Person[];
  relations?: readonly PersonRelation[];
  documents?: readonly DocumentRecord[];
  personDocumentIds?: readonly string[];
  findings?: readonly Finding[];
  tasks?: readonly TaskRecord[];
  hypotheses?: readonly Hypothesis[];
  archiveRequests?: readonly ArchiveRequest[];
  photoUrl?: string;
  photoUrlForPerson?: (person: Person) => string | undefined;
  directAncestor?: boolean;
  activeTab?: PersonProfileTabV2;
  defaultTab?: PersonProfileTabV2;
  onTabChange?: (tab: PersonProfileTabV2) => void;
  onBack?: () => void;
  onEdit?: (person: Person) => void;
  onShowInTree?: (person: Person) => void;
  onOpenMap?: (person: Person) => void;
  onAddEvent?: (person: Person) => void;
  onLinkDocument?: (person: Person) => void;
  onExport?: (person: Person) => void;
  onOpenPerson?: (person: Person) => void;
  onOpenDocument?: (document: DocumentRecord) => void;
  onOpenFinding?: (finding: Finding) => void;
  onOpenRelated?: (
    page: PersonProfileRelatedPageV2,
    record: PersonProfileRelatedRecordV2,
  ) => void;
  onBrowseRelated?: (page: PersonProfileRelatedPageV2) => void;
  onCreateRelated?: (
    page: PersonProfileCreatableRelatedPageV2,
    person: Person,
  ) => void;
  onSelectEvent?: (event: PersonTimelineItem) => void;
}

interface LinkedRelationV2 {
  relation: PersonRelation;
  person: Person | null;
  label: string;
}

const profileTabsV2: readonly PersonProfileTabV2[] = [
  "overview",
  "timeline",
  "family",
  "documents",
  "findings",
  "notes",
];

const profileTabLabelsV2: Record<PersonProfileTabV2, string> = {
  overview: "Огляд",
  timeline: "Хронологія",
  family: "Родина",
  documents: "Документи",
  findings: "Знахідки",
  notes: "Нотатки",
};

export function PersonProfileV2({
  person,
  research,
  persons = [],
  relations = [],
  documents = [],
  personDocumentIds = [],
  findings = [],
  tasks = [],
  hypotheses = [],
  archiveRequests = [],
  photoUrl,
  photoUrlForPerson,
  directAncestor = false,
  activeTab: controlledTab,
  defaultTab = "overview",
  onTabChange,
  onBack,
  onEdit,
  onShowInTree,
  onOpenMap,
  onAddEvent,
  onLinkDocument,
  onExport,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
  onOpenRelated,
  onBrowseRelated,
  onCreateRelated,
  onSelectEvent,
}: PersonProfileV2Props) {
  const componentId = useId().replace(/:/g, "");
  const [internalTab, setInternalTab] = useState<PersonProfileTabV2>(defaultTab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingKeyboardFocus = useRef<PersonProfileTabV2 | null>(null);
  const activeTab = controlledTab ?? internalTab;
  const name = personDisplayName(person);
  const completeness = useMemo(() => calculatePersonProfileCompleteness(person), [person]);
  const places = useMemo(() => personMainPlaces(person), [person]);
  const timeline = useMemo(() => buildPersonTimeline(person), [person]);
  const personsById = useMemo(
    () => new Map(persons.map((item) => [item.id, item])),
    [persons],
  );
  const linkedRelations = useMemo<LinkedRelationV2[]>(() => relations
    .filter((relation) => relation.personId === person.id || relation.relatedPersonId === person.id)
    .map((relation) => {
      const relatedId = relation.personId === person.id
        ? relation.relatedPersonId
        : relation.personId;
      const relatedPerson = personsById.get(relatedId) ?? null;
      return {
        relation,
        person: relatedPerson,
        label: personRelationLabel(relation, person.id, relatedPerson),
      };
    }), [person.id, personsById, relations]);
  const linkedFindings = useMemo(
    () => findings.filter((finding) => finding.personIds.includes(person.id)),
    [findings, person.id],
  );
  const linkedTasks = useMemo(
    () => tasks.filter((task) => task.personIds.includes(person.id)),
    [person.id, tasks],
  );
  const linkedHypotheses = useMemo(
    () => hypotheses.filter((hypothesis) => hypothesis.personIds.includes(person.id)),
    [hypotheses, person.id],
  );
  const linkedArchiveRequests = useMemo(
    () => archiveRequests.filter((request) => request.personIds.includes(person.id)),
    [archiveRequests, person.id],
  );
  const linkedDocumentIds = useMemo(() => new Set([
    ...personDocumentIds,
    ...linkedFindings.map((finding) => finding.documentId),
    ...linkedTasks.map((task) => task.documentId),
    ...linkedHypotheses.flatMap((hypothesis) => hypothesis.documentIds),
  ].filter(Boolean)), [linkedFindings, linkedHypotheses, linkedTasks, personDocumentIds]);
  const linkedDocuments = useMemo(
    () => documents.filter((document) => linkedDocumentIds.has(document.id)),
    [documents, linkedDocumentIds],
  );
  const attachmentCount = [
    ...person.birthScans,
    ...person.marriageScans,
    ...person.deathScans,
    ...person.mentionScans,
  ].length;

  const selectTab = (tab: PersonProfileTabV2) => {
    if (controlledTab === undefined) setInternalTab(tab);
    onTabChange?.(tab);
  };

  useEffect(() => {
    if (pendingKeyboardFocus.current !== activeTab) return;
    const index = profileTabsV2.indexOf(activeTab);
    tabRefs.current[index]?.focus();
    pendingKeyboardFocus.current = null;
  }, [activeTab]);

  const moveTabFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = profileTabsV2.indexOf(activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % profileTabsV2.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + profileTabsV2.length) % profileTabsV2.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = profileTabsV2.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = profileTabsV2[nextIndex];
    pendingKeyboardFocus.current = nextTab;
    selectTab(nextTab);
  };

  const tabCounts: Partial<Record<PersonProfileTabV2, number>> = {
    timeline: timeline.length,
    family: linkedRelations.length,
    documents: linkedDocuments.length,
    findings: linkedFindings.length,
  };

  return (
    <article className="persons-v2-profile" aria-labelledby={`${componentId}-title`}>
      <header className="panel persons-v2-profile__header">
        {onBack ? (
          <button type="button" className="button button-ghost persons-v2-profile__back" onClick={onBack}>
            ← Особи
          </button>
        ) : null}
        <div className="persons-v2-profile__identity">
          <div className="persons-v2-profile__photo">
            {photoUrl ? (
              <img src={photoUrl} alt={`Фото: ${name}`} />
            ) : (
              <span aria-hidden="true">{personInitials(person)}</span>
            )}
          </div>
          <div>
            <h1 id={`${componentId}-title`}>{name}</h1>
            <p>{personLifeYears(person) || "Роки життя не вказані"} · {person.gender}</p>
            <div className="persons-v2-profile__badges">
              <span className="status-pill">{person.status}</span>
              {directAncestor ? <span className="status-pill">Прямий предок</span> : null}
              <span className="status-pill">{privacyLabelV2(person.privacyStatus)}</span>
            </div>
            {research ? <small>Проєкт: {research.title}</small> : null}
          </div>
        </div>
        <div className="persons-v2-profile__header-actions">
          {onEdit ? (
            <button type="button" className="button button-primary" onClick={() => onEdit(person)}>
              Редагувати
            </button>
          ) : null}
          {onShowInTree ? (
            <button type="button" className="button button-secondary" onClick={() => onShowInTree(person)}>
              Показати в дереві
            </button>
          ) : null}
          {onAddEvent ? (
            <button type="button" className="button button-secondary" onClick={() => onAddEvent(person)}>
              Додати подію
            </button>
          ) : null}
          {onLinkDocument ? (
            <button type="button" className="button button-secondary" onClick={() => onLinkDocument(person)}>
              Пов’язати документ
            </button>
          ) : null}
          {onExport ? (
            <button type="button" className="button button-ghost" onClick={() => onExport(person)}>
              Експорт
            </button>
          ) : null}
        </div>
        <dl className="persons-v2-profile__summary">
          <div>
            <dt>Останнє редагування</dt>
            <dd>{formatDateTimeV2(person.updatedAt)}</dd>
          </div>
          <div>
            <dt>Повнота профілю</dt>
            <dd>{completeness.percent}%</dd>
          </div>
          <div>
            <dt>Джерела / документи</dt>
            <dd>{linkedDocuments.length + attachmentCount}</dd>
          </div>
        </dl>
      </header>

      <nav className="persons-v2-profile__tabs" role="tablist" aria-label="Розділи картки особи">
        {profileTabsV2.map((tab, index) => (
          <button
            type="button"
            role="tab"
            id={`${componentId}-tab-${tab}`}
            key={tab}
            aria-selected={activeTab === tab}
            aria-controls={`${componentId}-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            className={activeTab === tab ? "active" : ""}
            ref={(node) => { tabRefs.current[index] = node; }}
            onClick={() => selectTab(tab)}
            onKeyDown={moveTabFromKeyboard}
          >
            {profileTabLabelsV2[tab]}
            {tabCounts[tab] !== undefined ? <span> {tabCounts[tab]}</span> : null}
          </button>
        ))}
      </nav>

      {profileTabsV2.map((tab) => (
        <section
          key={tab}
          id={`${componentId}-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`${componentId}-tab-${tab}`}
          hidden={activeTab !== tab}
          className={`persons-v2-profile__panel is-${tab}`}
        >
          {activeTab === tab ? (
            <PersonProfilePanelV2
              tab={tab}
              person={person}
              places={places.all}
              completeness={completeness}
              timeline={timeline}
              relations={linkedRelations}
              documents={linkedDocuments}
              findings={linkedFindings}
              tasks={linkedTasks}
              hypotheses={linkedHypotheses}
              archiveRequests={linkedArchiveRequests}
              photoUrlForPerson={photoUrlForPerson}
              onSelectTab={selectTab}
              onAddEvent={onAddEvent}
              onOpenMap={onOpenMap}
              onLinkDocument={onLinkDocument}
              onOpenPerson={onOpenPerson}
              onOpenDocument={onOpenDocument}
              onOpenFinding={onOpenFinding}
              onOpenRelated={onOpenRelated}
              onBrowseRelated={onBrowseRelated}
              onCreateRelated={onCreateRelated}
              onSelectEvent={onSelectEvent}
            />
          ) : null}
        </section>
      ))}
    </article>
  );
}

interface PersonProfilePanelV2Props {
  tab: PersonProfileTabV2;
  person: Person;
  places: readonly string[];
  completeness: ReturnType<typeof calculatePersonProfileCompleteness>;
  timeline: readonly PersonTimelineItem[];
  relations: readonly LinkedRelationV2[];
  documents: readonly DocumentRecord[];
  findings: readonly Finding[];
  tasks: readonly TaskRecord[];
  hypotheses: readonly Hypothesis[];
  archiveRequests: readonly ArchiveRequest[];
  photoUrlForPerson?: (person: Person) => string | undefined;
  onSelectTab: (tab: PersonProfileTabV2) => void;
  onAddEvent?: (person: Person) => void;
  onOpenMap?: (person: Person) => void;
  onLinkDocument?: (person: Person) => void;
  onOpenPerson?: (person: Person) => void;
  onOpenDocument?: (document: DocumentRecord) => void;
  onOpenFinding?: (finding: Finding) => void;
  onOpenRelated?: (
    page: PersonProfileRelatedPageV2,
    record: PersonProfileRelatedRecordV2,
  ) => void;
  onBrowseRelated?: (page: PersonProfileRelatedPageV2) => void;
  onCreateRelated?: (
    page: PersonProfileCreatableRelatedPageV2,
    person: Person,
  ) => void;
  onSelectEvent?: (event: PersonTimelineItem) => void;
}

function PersonProfilePanelV2(props: PersonProfilePanelV2Props) {
  switch (props.tab) {
    case "overview": return <OverviewPanelV2 {...props} />;
    case "timeline": return <TimelinePanelV2 {...props} />;
    case "family": return <FamilyPanelV2 {...props} />;
    case "documents": return <DocumentsPanelV2 {...props} />;
    case "findings": return <FindingsPanelV2 {...props} />;
    case "notes": return <NotesPanelV2 {...props} />;
  }
}

function OverviewPanelV2(props: PersonProfilePanelV2Props) {
  const {
    person,
    places,
    completeness,
    timeline,
    relations,
    documents,
    findings,
    onSelectTab,
    onOpenPerson,
    onOpenDocument,
    onOpenRelated,
    onBrowseRelated,
    photoUrlForPerson,
  } = props;
  return (
    <div className="persons-v2-profile__overview-grid">
      <div className="persons-v2-profile__main-column">
        <ProfileSectionV2 title="Основна інформація">
          <dl className="persons-v2-profile__facts-grid">
            <ProfileFactV2 label="Ім’я при народженні" value={personDisplayName(person)} />
            <ProfileFactV2 label="Дата народження" value={person.birthDate || yearRangeV2(person.birthYearFrom, person.birthYearTo)} />
            <ProfileFactV2 label="Стать" value={person.gender} />
            <ProfileFactV2 label="Місце народження" value={person.birthPlace} />
            <ProfileFactV2 label="Дівоче прізвище" value={person.maidenSurname} />
            <ProfileFactV2 label="Дата смерті" value={person.isLiving ? "Жива особа" : person.deathDate || yearRangeV2(person.deathYearFrom, person.deathYearTo)} />
            <ProfileFactV2 label="По батькові" value={person.patronymic} />
            <ProfileFactV2 label="Місце смерті" value={person.isLiving ? "—" : person.deathPlace} />
          </dl>
        </ProfileSectionV2>

        <ProfileSectionV2
          title="Життєві події"
          action={<button type="button" className="button button-ghost" onClick={() => onSelectTab("timeline")}>Уся хронологія</button>}
        >
          <PersonTimelineV2 person={person} items={timeline.slice(0, 5)} />
        </ProfileSectionV2>

        <ProfileSectionV2
          title="Родинні зв’язки"
          action={<button type="button" className="button button-ghost" onClick={() => onSelectTab("family")}>Переглянути всі</button>}
        >
          {relations.length ? (
            <div className="persons-v2-profile__relative-cards">
              {relations.slice(0, 6).map(({ relation, person: relative, label }) => (
                <RelationCardV2
                  key={relation.id}
                  relation={relation}
                  relationLabel={label}
                  person={relative}
                  photoUrl={relative ? photoUrlForPerson?.(relative) : undefined}
                  onOpenPerson={onOpenPerson}
                />
              ))}
            </div>
          ) : <EmptyBlockV2 title="Зв’язків ще немає" text="Додайте родинний або дослідницький зв’язок у редакторі особи." />}
        </ProfileSectionV2>

        <ProfileSectionV2 title="Біографічна нотатка">
          <p className="persons-v2-profile__biography">{person.notes || "Біографічну нотатку ще не додано."}</p>
        </ProfileSectionV2>
      </div>

      <aside className="persons-v2-profile__side-column" aria-label="Зведення профілю">
        <ProfileSectionV2 title="Швидкі факти">
          <dl className="persons-v2-profile__quick-facts">
            <ProfileFactV2 label="Статус" value={person.status} />
            <ProfileFactV2 label="Професія" value={person.occupation} />
            <ProfileFactV2 label="Віросповідання" value={person.religion} />
            <ProfileFactV2 label="Соціальний стан" value={person.socialStatus} />
            <ProfileFactV2 label="Основні місця" value={places.slice(0, 3).join("; ")} />
          </dl>
        </ProfileSectionV2>
        <ProfileSectionV2 title="Якість даних">
          <div className="persons-v2-profile__quality-score">
            <strong>{completeness.percent}%</strong>
            <span>{completeness.completed} з {completeness.total} полів заповнено</span>
          </div>
          <progress max={100} value={completeness.percent}>{completeness.percent}%</progress>
          {completeness.missing.length ? (
            <details>
              <summary>Що варто додати ({completeness.missing.length})</summary>
              <ul>{completeness.missing.map((item) => <li key={item}>{item}</li>)}</ul>
            </details>
          ) : <p>Основні дані заповнені.</p>}
        </ProfileSectionV2>
        <ProfileSectionV2
          title={`Пов’язані документи (${documents.length})`}
          action={(
            <div className="persons-v2-profile__section-actions">
              <button type="button" className="button button-ghost" onClick={() => onSelectTab("documents")}>У картці</button>
              {onBrowseRelated ? (
                <button type="button" className="button button-secondary" onClick={() => onBrowseRelated("documents")}>Усі документи</button>
              ) : null}
            </div>
          )}
        >
          {documents.slice(0, 3).map((document) => {
            const openDocument = onOpenRelated
              ? () => onOpenRelated("documents", document)
              : onOpenDocument
                ? () => onOpenDocument(document)
                : undefined;
            const content = (
              <>
                <span>
                  <strong>{document.title}</strong>
                  <small>{document.archive || document.documentType || "Документ"}</small>
                </span>
                {openDocument ? (
                  <span className="persons-v2-profile__record-action" aria-hidden="true">
                    Відкрити →
                  </span>
                ) : null}
              </>
            );
            return openDocument ? (
              <button
                type="button"
                key={document.id}
                className="persons-v2-profile__overview-record"
                onClick={openDocument}
              >
                {content}
              </button>
            ) : (
              <div key={document.id} className="persons-v2-profile__overview-record">
                {content}
              </div>
            );
          })}
          {!documents.length ? <span>Документів поки немає.</span> : null}
        </ProfileSectionV2>
        <ProfileSectionV2
          title="Матеріали"
          action={<button type="button" className="button button-ghost" onClick={() => onSelectTab("findings")}>Переглянути знахідки</button>}
        >
          <dl className="persons-v2-profile__counts">
            <ProfileFactV2 label="Знахідки" value={String(findings.length)} />
            <ProfileFactV2 label="Події" value={String(timeline.length)} />
            <ProfileFactV2 label="Зв’язки" value={String(relations.length)} />
          </dl>
        </ProfileSectionV2>
      </aside>
    </div>
  );
}

function TimelinePanelV2({
  person,
  timeline,
  onAddEvent,
  onOpenMap,
  onSelectEvent,
}: PersonProfilePanelV2Props) {
  return (
    <div className="persons-v2-profile__timeline-layout">
      <ProfileSectionV2
        title="Хронологія життя"
        action={onAddEvent ? <button type="button" className="button button-primary" onClick={() => onAddEvent(person)}>+ Додати подію</button> : null}
      >
        <PersonTimelineV2 person={person} items={timeline} onSelectEvent={onSelectEvent} />
      </ProfileSectionV2>
      <PersonLifeMapV2
        timeline={timeline}
        onOpenFullMap={onOpenMap ? () => onOpenMap(person) : undefined}
      />
    </div>
  );
}

function FamilyPanelV2({ relations, onOpenPerson, photoUrlForPerson }: PersonProfilePanelV2Props) {
  return (
    <ProfileSectionV2 title={`Родина й пов’язані особи (${relations.length})`}>
      {relations.length ? (
        <div className="persons-v2-profile__relations-list">
          {relations.map(({ relation, person, label }) => (
            <RelationCardV2
              key={relation.id}
              relation={relation}
              relationLabel={label}
              person={person}
              photoUrl={person ? photoUrlForPerson?.(person) : undefined}
              onOpenPerson={onOpenPerson}
              detailed
            />
          ))}
        </div>
      ) : <EmptyBlockV2 title="Пов’язаних осіб немає" text="Зв’язки з’являться тут після додавання в редакторі." />}
    </ProfileSectionV2>
  );
}

function DocumentsPanelV2({
  person,
  documents,
  onLinkDocument,
  onOpenDocument,
  onOpenRelated,
  onBrowseRelated,
}: PersonProfilePanelV2Props) {
  return (
    <ProfileSectionV2
      title={`Пов’язані документи (${documents.length})`}
      action={onBrowseRelated || onLinkDocument ? (
        <div className="persons-v2-profile__section-actions">
          {onBrowseRelated ? (
            <button type="button" className="button button-secondary" onClick={() => onBrowseRelated("documents")}>Усі документи</button>
          ) : null}
          {onLinkDocument ? (
            <button type="button" className="button button-primary" onClick={() => onLinkDocument(person)}>+ Пов’язати документ</button>
          ) : null}
        </div>
      ) : null}
    >
      {documents.length ? (
        <div className="persons-v2-profile__document-grid">
          {documents.map((document) => {
            const openDocument = onOpenRelated
              ? () => onOpenRelated("documents", document)
              : onOpenDocument
                ? () => onOpenDocument(document)
                : undefined;
            return (
              <article key={document.id} className="panel persons-v2-profile__document-card">
                <h3>{document.title}</h3>
                <p>{[document.documentType, yearRangeV2(document.yearFrom, document.yearTo)].filter(Boolean).join(" · ") || "Без опису"}</p>
                <small>{[document.archive, document.fund, document.place].filter(Boolean).join(" · ")}</small>
                <span>{document.scans.length} сканів · {document.reviewStatus || "Статус не вказано"}</span>
                {openDocument ? <button type="button" className="button button-secondary" onClick={openDocument}>Відкрити</button> : null}
              </article>
            );
          })}
        </div>
      ) : <EmptyBlockV2 title="Документів ще немає" text="Документи з’являться тут після прив’язки через знахідку, завдання або гіпотезу." />}
    </ProfileSectionV2>
  );
}

function FindingsPanelV2({
  person,
  findings,
  onOpenFinding,
  onOpenRelated,
  onBrowseRelated,
  onCreateRelated,
}: PersonProfilePanelV2Props) {
  return (
    <ProfileSectionV2
      title={`Знахідки (${findings.length})`}
      action={(
        <RelatedSectionActionsV2
          browseLabel="Усі знахідки"
          createLabel="Додати знахідку"
          onBrowse={onBrowseRelated ? () => onBrowseRelated("findings") : undefined}
          onCreate={onCreateRelated ? () => onCreateRelated("findings", person) : undefined}
        />
      )}
    >
      {findings.length ? (
        <div className="persons-v2-profile__findings-list">
          {findings.map((finding) => {
            const openFinding = onOpenRelated
              ? () => onOpenRelated("findings", finding)
              : onOpenFinding
                ? () => onOpenFinding(finding)
                : undefined;
            const sourceUrl = resolvedFindingSourceUrl(finding);
            const title = stripFindingSourceUrls(finding.summary)
              || stripFindingSourceUrls(finding.description)
              || "Знахідка без назви";
            const reference = [
              stripFindingSourceUrls(finding.archive),
              stripFindingSourceUrls(finding.fund),
              stripFindingSourceUrls(finding.page)
                ? `с. ${stripFindingSourceUrls(finding.page)}`
                : "",
            ].filter(Boolean).join(" · ");
            return (
              <article key={finding.id} className="panel persons-v2-profile__finding-card">
                <div className="persons-v2-profile__finding-badges">
                  <span className="status-pill">{finding.findingType || "Знахідка"}</span>
                  {finding.needsReview ? <span className="status-pill">Потребує перевірки</span> : null}
                </div>
                <h3>{title}</h3>
                <p>{[finding.eventDate, finding.place].filter(Boolean).join(" · ") || "Дата й місце не вказані"}</p>
                {reference ? <small>{reference}</small> : null}
                <div className="persons-v2-profile__finding-actions">
                  {sourceUrl ? (
                    <a
                      className="persons-v2-profile__finding-source-link"
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Відкрити джерело ↗
                    </a>
                  ) : null}
                  {openFinding ? <button type="button" className="button button-secondary" onClick={openFinding}>Відкрити картку</button> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : <EmptyBlockV2 title="Знахідок ще немає" text="Знахідки з прив’язкою до особи відображатимуться тут." />}
    </ProfileSectionV2>
  );
}

function NotesPanelV2({
  person,
  tasks,
  hypotheses,
  archiveRequests,
  onOpenRelated,
  onBrowseRelated,
  onCreateRelated,
}: PersonProfilePanelV2Props) {
  return (
    <div className="persons-v2-profile__notes-grid">
      <ProfileSectionV2 title="Нотатки про особу">
        <p className="persons-v2-profile__note-text">{person.notes || "Нотаток ще немає."}</p>
      </ProfileSectionV2>
      <ProfileSectionV2
        title={`Пов’язані завдання (${tasks.length})`}
        action={(
          <RelatedSectionActionsV2
            browseLabel="Усі завдання"
            createLabel="Додати завдання"
            onBrowse={onBrowseRelated ? () => onBrowseRelated("tasks") : undefined}
            onCreate={onCreateRelated ? () => onCreateRelated("tasks", person) : undefined}
          />
        )}
      >
        <LinkedRecordListV2 records={tasks.map((task) => ({
          record: task,
          title: task.title || "Завдання без назви",
          meta: [task.status, task.priority, task.deadline].filter(Boolean).join(" · "),
        }))} onOpen={onOpenRelated ? (task) => onOpenRelated("tasks", task) : undefined} />
      </ProfileSectionV2>
      <ProfileSectionV2
        title={`Гіпотези (${hypotheses.length})`}
        action={(
          <RelatedSectionActionsV2
            browseLabel="Усі гіпотези"
            createLabel="Додати гіпотезу"
            onBrowse={onBrowseRelated ? () => onBrowseRelated("hypotheses") : undefined}
            onCreate={onCreateRelated ? () => onCreateRelated("hypotheses", person) : undefined}
          />
        )}
      >
        <LinkedRecordListV2 records={hypotheses.map((hypothesis) => ({
          record: hypothesis,
          title: hypothesis.title || "Гіпотеза без назви",
          meta: [hypothesis.status, hypothesis.probability].filter(Boolean).join(" · "),
        }))} onOpen={onOpenRelated ? (hypothesis) => onOpenRelated("hypotheses", hypothesis) : undefined} />
      </ProfileSectionV2>
      <ProfileSectionV2
        title={`Архівні запити (${archiveRequests.length})`}
        action={(
          <RelatedSectionActionsV2
            browseLabel="Усі запити"
            createLabel="Додати запит"
            onBrowse={onBrowseRelated ? () => onBrowseRelated("archiveRequests") : undefined}
            onCreate={onCreateRelated ? () => onCreateRelated("archiveRequests", person) : undefined}
          />
        )}
      >
        <LinkedRecordListV2 records={archiveRequests.map((request) => ({
          record: request,
          title: request.subject || "Архівний запит",
          meta: [request.archive, request.status, request.requestDate].filter(Boolean).join(" · "),
        }))} onOpen={onOpenRelated ? (request) => onOpenRelated("archiveRequests", request) : undefined} />
      </ProfileSectionV2>
    </div>
  );
}

function ProfileSectionV2({ title, action, children }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel persons-v2-profile__section">
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function ProfileFactV2({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value.trim() || "—"}</dd></div>;
}

function RelationCardV2({ relation, relationLabel, person, photoUrl, onOpenPerson, detailed = false }: {
  relation: PersonRelation;
  relationLabel: string;
  person: Person | null;
  photoUrl?: string;
  onOpenPerson?: (person: Person) => void;
  detailed?: boolean;
}) {
  const content = (
    <>
      <span className="persons-v2-profile__relative-avatar" aria-hidden="true">
        {photoUrl ? <img src={photoUrl} alt="" /> : person ? personInitials(person) : "?"}
      </span>
      <span>
        <strong>{person ? personDisplayName(person) : "Невідома або недоступна особа"}</strong>
        <small>{relationLabel} · {relation.status}</small>
        {person ? <small>{personLifeYears(person) || "Роки не вказані"}</small> : null}
        {detailed && relation.evidenceText ? <span>{relation.evidenceText}</span> : null}
        {detailed && relation.notes ? <span>{relation.notes}</span> : null}
      </span>
    </>
  );
  return person && onOpenPerson ? (
    <button type="button" className="persons-v2-profile__relative-card" onClick={() => onOpenPerson(person)}>
      {content}
    </button>
  ) : <article className="persons-v2-profile__relative-card">{content}</article>;
}

function EmptyBlockV2({ title, text }: { title: string; text: string }) {
  return <div className="empty-inline"><strong>{title}</strong><span>{text}</span></div>;
}

function RelatedSectionActionsV2({
  browseLabel,
  createLabel,
  onBrowse,
  onCreate,
}: {
  browseLabel: string;
  createLabel: string;
  onBrowse?: () => void;
  onCreate?: () => void;
}) {
  if (!onBrowse && !onCreate) return null;
  return (
    <div className="persons-v2-profile__section-actions">
      {onBrowse ? <button type="button" className="button button-secondary" onClick={onBrowse}>{browseLabel}</button> : null}
      {onCreate ? <button type="button" className="button button-primary" onClick={onCreate}>+ {createLabel}</button> : null}
    </div>
  );
}

function LinkedRecordListV2<T extends { id: string }>({
  records,
  onOpen,
}: {
  records: readonly { record: T; title: string; meta: string }[];
  onOpen?: (record: T) => void;
}) {
  if (!records.length) return <span>Немає пов’язаних записів.</span>;
  return (
    <ul className="persons-v2-profile__linked-records">
      {records.map(({ record, title, meta }) => (
        <li key={record.id}>
          {onOpen ? (
            <button
              type="button"
              className="persons-v2-profile__linked-record"
              onClick={() => onOpen(record)}
            >
              <span>
                <strong>{title}</strong>
                {meta ? <small>{meta}</small> : null}
              </span>
              <span aria-hidden="true">Відкрити →</span>
            </button>
          ) : (
            <span className="persons-v2-profile__linked-record">
              <span>
                <strong>{title}</strong>
                {meta ? <small>{meta}</small> : null}
              </span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function yearRangeV2(from: string, to: string): string {
  if (from && to && from !== to) return `${from}–${to}`;
  return from || to;
}

function privacyLabelV2(privacy: Person["privacyStatus"]): string {
  const labels: Record<Person["privacyStatus"], string> = {
    private: "Приватна",
    project: "У межах проєкту",
    public: "Публічна",
    confidential: "Конфіденційна",
  };
  return labels[privacy];
}

function formatDateTimeV2(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return new Intl.DateTimeFormat("uk-UA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
