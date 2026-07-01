import Fuse, { type IFuseOptions } from "fuse.js";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  AppDatabase,
  AppEntity,
  ArchiveRequest,
  CustomFieldDefinition,
  Finding,
  Hypothesis,
  Person,
  PersonRelation,
  PersonRelationStatus,
  PersonRelationType,
  Research,
  ScanAttachment,
  TaskRecord,
} from "../types";
import { Modal } from "../components/Modal";
import { PersonFormModal } from "../components/PersonFormModal";
import { ScanAttachmentsView } from "../components/ScanAttachments";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import type { PageKey } from "../components/Sidebar";
import { deleteScanFile } from "../services/scanStorage";
import { CustomFieldsView } from "../components/CustomFields";
import { normalizeCustomFieldValues } from "../utils/customFields";
import { ExcelExportMenu } from "../components/ExcelExportMenu";
import { exportPersonsToExcel } from "../utils/excelExport";
import { TableDataImportButton } from "../components/TableDataImportButton";
import { PaginationControls } from "../components/PaginationControls";
import { usePagination } from "../hooks/usePagination";
import { useWorkspaceWindows } from "../components/WorkspaceWindows";

type PersonTab =
  | "overview"
  | "findings"
  | "tasks"
  | "hypotheses"
  | "archiveRequests"
  | "relations"
  | "notes";

type PersonWindow =
  | { windowId: string; kind: "view"; personId: string }
  | { windowId: string; kind: "edit"; personId: string }
  | { windowId: string; kind: "new" };

export function PersonsPage({
  db,
  persons,
  relations,
  researches,
  findings,
  tasks,
  hypotheses,
  archiveRequests,
  customFieldDefinitions = [],
  onAddCustomField,
  onDeleteCustomField,
  canAddCustomField = true,
  customFieldLimitMessage,
  initialSearch = "",
  initialOpenPersonId = "",
  onSavePerson,
  onImportRecords,
  onDeletePerson,
  onSaveRelation,
  onDeleteRelation,
  onOpenRelated,
  onCreateRelated,
  readOnly = false,
  canCreate = true,
  researchRequired = false,
  projectName = "Трекер Роду",
}: {
  db: AppDatabase;
  persons: Person[];
  relations: PersonRelation[];
  researches: Research[];
  findings: Finding[];
  tasks: TaskRecord[];
  hypotheses: Hypothesis[];
  archiveRequests: ArchiveRequest[];
  customFieldDefinitions?: CustomFieldDefinition[];
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  canAddCustomField?: boolean;
  customFieldLimitMessage?: string;
  initialSearch?: string;
  initialOpenPersonId?: string;
  onSavePerson: (person: Person) => void;
  onImportRecords: (collection: "persons", records: AppEntity[]) => Promise<void>;
  onDeletePerson: (id: string) => void;
  onSaveRelation: (relation: PersonRelation) => void;
  onDeleteRelation: (id: string) => void;
  onOpenRelated: (page: PageKey, entityId: string) => void;
  onCreateRelated: (page: PageKey, initialValues: Record<string, unknown>) => void;
  readOnly?: boolean;
  canCreate?: boolean;
  projectName?: string;
  researchRequired?: boolean;
}) {
  const canCreateRecords = !readOnly && canCreate;
  const [search, setSearch] = useState(initialSearch);
  const [researchFilter, setResearchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [genderFilter, setGenderFilter] = useState("");
  const [placeFilter, setPlaceFilter] = useState("");
  const [surnameFilter, setSurnameFilter] = useState("");
  const initialOpenRef = useRef("");
  const windowOwnerKey = "persons";
  const { openWindow: openWorkspaceWindow, closeWindows } = useWorkspaceWindows();

  useEffect(() => setSearch(initialSearch), [initialSearch]);
  useEffect(() => {
    if (!initialOpenPersonId) return;
    if (initialOpenRef.current === initialOpenPersonId) return;
    const person = persons.find((item) => item.id === initialOpenPersonId);
    if (person) {
      initialOpenRef.current = initialOpenPersonId;
      openViewWindow(person);
    }
  }, [initialOpenPersonId, persons]);
  useEffect(() => {
    if (!initialOpenPersonId) initialOpenRef.current = "";
  }, [initialOpenPersonId]);
  useEffect(() => {
    const existingIds = new Set(persons.map((person) => person.id));
    closeWindows((window) =>
      window.ownerKey === windowOwnerKey &&
      personIdFromWindowKey(window.logicalKey) !== null &&
      !existingIds.has(personIdFromWindowKey(window.logicalKey) ?? ""),
    );
  }, [closeWindows, persons]);
  const openViewWindow = (person: Person) => {
    openWorkspaceWindow({
      ownerKey: windowOwnerKey,
      logicalKey: personWindowKey({ windowId: "", kind: "view", personId: person.id }),
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <PersonCardModal
          db={db}
          person={person}
          persons={persons}
          researches={researches}
          customFieldDefinitions={customFieldDefinitions}
          relations={relations}
          findings={findings}
          tasks={tasks}
          hypotheses={hypotheses}
          archiveRequests={archiveRequests}
          onClose={close}
          onEdit={readOnly ? undefined : () => openEditWindow(person)}
          onSaveRelation={onSaveRelation}
          onDeleteRelation={onDeleteRelation}
          onOpenRelated={onOpenRelated}
          onCreateRelated={onCreateRelated}
          readOnly={readOnly}
          canCreate={canCreateRecords}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  };
  const openEditWindow = (person: Person) => {
    openWorkspaceWindow({
      ownerKey: windowOwnerKey,
      logicalKey: personWindowKey({ windowId: "", kind: "edit", personId: person.id }),
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <PersonFormModal
          db={db}
          person={person}
          researches={researches}
          researchRequired={researchRequired}
          customFieldDefinitions={customFieldDefinitions}
          onAddCustomField={onAddCustomField}
          onDeleteCustomField={onDeleteCustomField}
          canAddCustomField={canAddCustomField}
          customFieldLimitMessage={customFieldLimitMessage}
          onClose={close}
          onSave={(savedPerson) => {
            onSavePerson(savedPerson);
            close();
          }}
          modalMode="window"
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  };
  const openNewWindow = () => {
    const windowId = createId();
    openWorkspaceWindow({
      ownerKey: windowOwnerKey,
      logicalKey: personWindowKey({ windowId, kind: "new" }),
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <PersonFormModal
          db={db}
          person={null}
          researches={researches}
          researchRequired={researchRequired}
          customFieldDefinitions={customFieldDefinitions}
          onAddCustomField={onAddCustomField}
          onDeleteCustomField={onDeleteCustomField}
          canAddCustomField={canAddCustomField}
          customFieldLimitMessage={customFieldLimitMessage}
          onClose={close}
          onSave={(savedPerson) => {
            onSavePerson(savedPerson);
            close();
          }}
          modalMode="window"
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  };

  const filtered = useMemo(() => {
    const query = normalize(search);
    const place = normalize(placeFilter);
    const surname = normalize(surnameFilter);
    return persons.filter((person) => {
      const searchText = normalize([
        person.fullName,
        person.surname,
        person.givenName,
        person.patronymic,
        person.nameVariants,
        person.surnameVariants,
        person.birthPlace,
        person.marriagePlace,
        person.deathPlace,
        person.residencePlaces,
        person.notes,
      ].join(" "));
      const places = normalize(personPlaces(person));
      const surnames = normalize(`${person.surname} ${person.surnameVariants}`);
      return (
        (!query || searchText.includes(query)) &&
        (!researchFilter || person.researchId === researchFilter) &&
        (!statusFilter || person.status === statusFilter) &&
        (!genderFilter || person.gender === genderFilter) &&
        (!place || places.includes(place)) &&
        (!surname || surnames.includes(surname))
      );
    });
  }, [genderFilter, persons, placeFilter, researchFilter, search, statusFilter, surnameFilter]);
  const paginationResetKey = [
    search,
    researchFilter,
    statusFilter,
    genderFilter,
    placeFilter,
    surnameFilter,
  ].join("\u001f");
  const pagination = usePagination(filtered, paginationResetKey);

  const remove = async (person: Person) => {
    if (readOnly) return;
    if (window.confirm(`Видалити особу «${personDisplayName(person)}»? Пов’язані записи залишаться, але прив’язку буде прибрано.`)) {
      const scans = [
        ...(person.birthScans ?? []),
        ...(person.marriageScans ?? []),
        ...(person.deathScans ?? []),
        ...(person.mentionScans ?? []),
        ...customAttachmentScans(person.customFields, customFieldDefinitions),
      ];
      await Promise.allSettled(scans.map(deleteScanFile));
      onDeletePerson(person.id);
      closeWindows((window) =>
        window.ownerKey === windowOwnerKey &&
        personIdFromWindowKey(window.logicalKey) === person.id,
      );
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Робочий простір</span>
          <h1>Особи</h1>
          <p>Картки людей, варіанти імен, життєві події та зв’язки з доказами.</p>
        </div>
        <div className="page-heading-actions">
          <ExcelExportMenu
            filteredCount={filtered.length}
            totalCount={persons.length}
            onExportFiltered={() => exportPersonsToExcel(
              db,
              projectName,
              filtered,
              "filtered",
              customFieldDefinitions,
            )}
            onExportAll={() => exportPersonsToExcel(
              db,
              projectName,
              persons,
              "all",
              customFieldDefinitions,
            )}
          />
          {canCreateRecords ? (
            <TableDataImportButton
              collection="persons"
              db={db}
              fields={[]}
              customFieldDefinitions={customFieldDefinitions}
              onImport={(records) => onImportRecords("persons", records)}
            />
          ) : null}
          {canCreateRecords ? (
            <button className="button button-primary" onClick={openNewWindow}>+ Додати особу</button>
          ) : null}
        </div>
      </div>

      <section className="panel">
        <div className="filters persons-filters">
          <label className="search-field">
            <span>Пошук</span>
            <input
              value={search}
              placeholder="Ім’я, прізвище, варіант написання, місце або нотатка…"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            <span>Дослідження</span>
            <select value={researchFilter} onChange={(event) => setResearchFilter(event.target.value)}>
              <option value="">Усі дослідження</option>
              {researches.map((research) => <option key={research.id} value={research.id}>{research.title}</option>)}
            </select>
          </label>
          <label>
            <span>Статус</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">Усі статуси</option>
              {["доведена", "частково доведена", "гіпотетична", "сумнівна", "спростована"].map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
          <label>
            <span>Стать</span>
            <select value={genderFilter} onChange={(event) => setGenderFilter(event.target.value)}>
              <option value="">Будь-яка</option>
              {["чоловік", "жінка", "невідомо"].map((gender) => <option key={gender}>{gender}</option>)}
            </select>
          </label>
          <label>
            <span>Населений пункт</span>
            <input value={placeFilter} onChange={(event) => setPlaceFilter(event.target.value)} />
          </label>
          <label>
            <span>Прізвище</span>
            <input value={surnameFilter} onChange={(event) => setSurnameFilter(event.target.value)} />
          </label>
          <div className="result-count">{filtered.length} з {persons.length}</div>
        </div>

        {filtered.length ? (
          <>
            <PaginationControls
              totalItems={pagination.totalItems}
              page={pagination.page}
              pageCount={pagination.pageCount}
              pageSize={pagination.pageSize}
              startIndex={pagination.startIndex}
              endIndex={pagination.endIndex}
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Повне ім’я</th>
                    <th>Роки життя</th>
                    <th>Основні місця</th>
                    <th>Статус</th>
                    <th>Знахідки</th>
                    <th>Завдання</th>
                    <th>Гіпотези</th>
                    <th className="actions-column">Дії</th>
                  </tr>
                </thead>
                <tbody>
                  {pagination.pageItems.map((person) => (
                    <tr key={person.id} className="clickable-row" onClick={() => openViewWindow(person)}>
                      <td data-label="Повне ім’я"><strong>{personDisplayName(person)}</strong></td>
                      <td data-label="Роки життя">{lifeYears(person)}</td>
                      <td data-label="Основні місця">{personPlaces(person) || "—"}</td>
                      <td data-label="Статус"><span className="status-pill">{person.status}</span></td>
                      <td data-label="Знахідки">{linkedCount(findings, person.id)}</td>
                      <td data-label="Завдання">{linkedCount(tasks, person.id)}</td>
                      <td data-label="Гіпотези">{linkedCount(hypotheses, person.id)}</td>
                      <td data-label="Дії" className="row-actions" onClick={(event) => event.stopPropagation()}>
                        <button className="icon-button" title="Переглянути" onClick={() => openViewWindow(person)}>◉</button>
                        {!readOnly ? (
                          <>
                            <button className="icon-button" title="Редагувати" onClick={() => openEditWindow(person)}>✎</button>
                            <button className="icon-button danger" title="Видалити" onClick={() => void remove(person)}>×</button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationControls
              totalItems={pagination.totalItems}
              page={pagination.page}
              pageCount={pagination.pageCount}
              pageSize={pagination.pageSize}
              startIndex={pagination.startIndex}
              endIndex={pagination.endIndex}
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
          </>
        ) : (
          <div className="empty-state">
            {canCreateRecords ? (
              <button className="empty-mark" onClick={openNewWindow}>+</button>
            ) : null}
            <h2>Осіб не знайдено</h2>
            <p>Змініть фільтри або додайте першу картку особи.</p>
          </div>
        )}
      </section>

    </>
  );
}

function personWindowKey(window: PersonWindow): string {
  if (window.kind === "new") return window.windowId;
  return `${window.kind}:${window.personId}`;
}

function personIdFromWindowKey(logicalKey: string): string | null {
  const [kind, personId] = logicalKey.split(":");
  return (kind === "view" || kind === "edit") && personId ? personId : null;
}

function customAttachmentScans(
  values: unknown,
  definitions: CustomFieldDefinition[],
): ScanAttachment[] {
  if (!values || typeof values !== "object" || Array.isArray(values)) return [];
  const attachmentIds = new Set(
    definitions
      .filter((field) => field.type === "attachments")
      .map((field) => field.id),
  );
  return Object.entries(values)
    .filter(([id, value]) => attachmentIds.has(id) && Array.isArray(value))
    .flatMap(([, value]) => value as ScanAttachment[]);
}

function PersonCardModal({
  db,
  person,
  persons,
  researches,
  customFieldDefinitions,
  relations,
  findings,
  tasks,
  hypotheses,
  archiveRequests,
  onClose,
  onEdit,
  onSaveRelation,
  onDeleteRelation,
  onOpenRelated,
  onCreateRelated,
  readOnly,
  canCreate,
  stackIndex,
  dockIndex,
  onFocus,
}: {
  db: AppDatabase;
  person: Person;
  persons: Person[];
  researches: Research[];
  customFieldDefinitions: CustomFieldDefinition[];
  relations: PersonRelation[];
  findings: Finding[];
  tasks: TaskRecord[];
  hypotheses: Hypothesis[];
  archiveRequests: ArchiveRequest[];
  onClose: () => void;
  onEdit?: () => void;
  onSaveRelation: (relation: PersonRelation) => void;
  onDeleteRelation: (id: string) => void;
  onOpenRelated: (page: PageKey, entityId: string) => void;
  onCreateRelated: (page: PageKey, initialValues: Record<string, unknown>) => void;
  readOnly: boolean;
  canCreate: boolean;
  stackIndex: number;
  dockIndex: number;
  onFocus: () => void;
}) {
  const [tab, setTab] = useState<PersonTab>("overview");
  const [relationFormOpen, setRelationFormOpen] = useState(false);
  const linkedFindings = findings.filter((item) => item.personIds?.includes(person.id));
  const linkedTasks = tasks.filter((item) => item.personIds?.includes(person.id));
  const linkedHypotheses = hypotheses.filter((item) => item.personIds?.includes(person.id));
  const linkedArchiveRequests = archiveRequests.filter((item) => item.personIds?.includes(person.id));
  const linkedRelations = relations.filter(
    (item) => item.personId === person.id || item.relatedPersonId === person.id,
  );
  const tabs: Array<[PersonTab, string, number?]> = [
    ["overview", "Огляд"],
    ["findings", "Знахідки", linkedFindings.length],
    ["tasks", "Завдання", linkedTasks.length],
    ["hypotheses", "Гіпотези", linkedHypotheses.length],
    ["archiveRequests", "Запити в архів", linkedArchiveRequests.length],
    ["relations", "Зв’язки", linkedRelations.length],
    ["notes", "Нотатки"],
  ];

  return (
    <Modal
      title={personDisplayName(person)}
      onClose={onClose}
      mode="window"
      stackIndex={stackIndex}
      dockIndex={dockIndex}
      onFocus={onFocus}
    >
      <div className="person-card">
        <div className="person-tabs">
          {tabs.map(([key, label, count]) => (
            <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
              {label}{typeof count === "number" ? <span>{count}</span> : null}
            </button>
          ))}
        </div>
        <div className="person-tab-content">
          {tab === "overview" ? (
            <PersonOverview
              db={db}
              person={person}
              researches={researches}
              findings={linkedFindings}
              customFieldDefinitions={customFieldDefinitions}
              onOpenFinding={(findingId) => onOpenRelated("findings", findingId)}
            />
          ) : null}
          {tab === "findings" ? (
            <LinkedRecordsSection
              records={linkedFindings}
              type="finding"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("findings", findingDraftFor(person))}
              readOnly={!canCreate}
            />
          ) : null}
          {tab === "tasks" ? (
            <LinkedRecordsSection
              records={linkedTasks}
              type="task"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("tasks", taskDraftFor(person))}
              readOnly={!canCreate}
            />
          ) : null}
          {tab === "hypotheses" ? (
            <LinkedRecordsSection
              records={linkedHypotheses}
              type="hypothesis"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("hypotheses", hypothesisDraftFor(person))}
              readOnly={!canCreate}
            />
          ) : null}
          {tab === "archiveRequests" ? (
            <LinkedRecordsSection
              records={linkedArchiveRequests}
              type="archiveRequest"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("archiveRequests", archiveRequestDraftFor(person))}
              readOnly={!canCreate}
            />
          ) : null}
          {tab === "notes" ? (
            <div className="person-notes">{person.notes || "Нотаток поки немає."}</div>
          ) : null}
          {tab === "relations" ? (
            <div>
              <div className="section-heading">
                <div>
                  <h3>Зв’язки особи</h3>
                  <p>Прості спискові зв’язки з оцінкою доказовості.</p>
                </div>
                {canCreate ? (
                  <button className="button button-secondary" onClick={() => setRelationFormOpen(true)}>+ Додати зв’язок</button>
                ) : null}
              </div>
              {linkedRelations.length ? (
                <div className="relation-list">
                  {linkedRelations.map((relation) => {
                    const otherId = relation.personId === person.id ? relation.relatedPersonId : relation.personId;
                    const other = persons.find((item) => item.id === otherId);
                    const displayedRelationType = relationTypeForPerson(relation, person.id, other);
                    return (
                      <article key={relation.id}>
                        <div>
                          <strong>{displayedRelationType}: </strong>
                          {other ? (
                            <button
                              type="button"
                              className="inline-related-link"
                              onClick={() => onOpenRelated("persons", other.id)}
                            >
                              {personDisplayName(other)} →
                            </button>
                          ) : "Особа недоступна"}
                          <span className="status-pill">{relation.status}</span>
                          {relation.evidenceText ? <p>{relation.evidenceText}</p> : null}
                          {relation.notes ? <small>{relation.notes}</small> : null}
                        </div>
                        {!readOnly ? (
                          <button
                            className="icon-button danger"
                            title="Видалити зв’язок"
                            onClick={() => {
                              if (window.confirm("Видалити цей зв’язок?")) onDeleteRelation(relation.id);
                            }}
                          >×</button>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : <div className="empty-inline">Зв’язків поки немає.</div>}
            </div>
          ) : null}
        </div>
        <div className="details-actions">
          <button className="button button-ghost" onClick={onClose}>Закрити</button>
          {onEdit ? (
            <button className="button button-primary" onClick={onEdit}>Редагувати</button>
          ) : null}
        </div>
      </div>
      {relationFormOpen && canCreate ? (
        <RelationFormModal
          person={person}
          persons={persons}
          onClose={() => setRelationFormOpen(false)}
          onSave={(relation) => {
            onSaveRelation(relation);
            setRelationFormOpen(false);
          }}
        />
      ) : null}
    </Modal>
  );
}

function PersonOverview({
  db,
  person,
  researches,
  findings,
  customFieldDefinitions,
  onOpenFinding,
}: {
  db: AppDatabase;
  person: Person;
  researches: Research[];
  findings: Finding[];
  customFieldDefinitions: CustomFieldDefinition[];
  onOpenFinding: (findingId: string) => void;
}) {
  const research = researches.find((item) => item.id === person.researchId);
  const values = [
    ["Дослідження", research?.title || (person.researchId ? "Недоступне дослідження" : "Без прив’язки")],
    ["Статус", person.status],
    ["Стать", person.gender],
    ["Жива особа", person.isLiving ? "так" : "ні"],
    ["Приватність у дереві", personPrivacyStatusLabel(person.privacyStatus)],
    ["Прізвище", person.surname],
    ["Ім’я", person.givenName],
    ["По батькові", person.patronymic],
    ["Повне ім’я", person.fullName],
    ["Варіанти імені", person.nameVariants],
    ["Варіанти прізвища", person.surnameVariants],
    ["Дата народження", displayDate(person.birthDate)],
    ["Рік народження від", person.birthYearFrom],
    ["Рік народження до", person.birthYearTo],
    ["Місце народження", person.birthPlace],
    ["Дата шлюбу", displayDate(person.marriageDate)],
    ["Місце шлюбу", person.marriagePlace],
    ["Дата смерті", displayDate(person.deathDate)],
    ["Рік смерті від", person.deathYearFrom],
    ["Рік смерті до", person.deathYearTo],
    ["Місце смерті", person.deathPlace],
    ["Місця проживання", person.residencePlaces],
    ["Соціальний статус", person.socialStatus],
    ["Віросповідання", person.religion],
    ["Професія або заняття", person.occupation],
  ];
  const findingsWithFiles = findings.filter((finding) => finding.scans?.length);
  return (
    <div className="details-grid">
      {values.map(([label, value]) => (
        <div className="detail-item" key={label}>
          <span>{label}</span>
          <div className="detail-text">{value || "—"}</div>
        </div>
      ))}
      <div className="detail-item detail-wide">
        <span>Нотатки</span>
        <div className="detail-text">{person.notes || "—"}</div>
      </div>
      <div className="detail-item detail-wide person-scan-group">
        <span>Файли пов’язаних знахідок</span>
        {findingsWithFiles.length ? (
          <div className="person-finding-files">
            {findingsWithFiles.map((finding) => (
              <section key={finding.id}>
                <button
                  type="button"
                  className="person-finding-file-heading"
                  onClick={() => onOpenFinding(finding.id)}
                >
                  <strong>{finding.findingType || "Знахідка"}</strong>
                  <small>
                    {[displayDate(finding.eventDate), finding.place]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  <span>Відкрити знахідку →</span>
                </button>
                <ScanAttachmentsView scans={finding.scans ?? []} />
              </section>
            ))}
          </div>
        ) : (
          <div className="detail-text">
            У пов’язаних знахідках поки немає прикріплених файлів.
          </div>
        )}
      </div>
      <CustomFieldsView
        db={db}
        definitions={customFieldDefinitions}
        values={normalizeCustomFieldValues(person.customFields)}
      />
    </div>
  );
}

function personPrivacyStatusLabel(value: Person["privacyStatus"]): string {
  switch (value) {
    case "project":
      return "у межах проєкту";
    case "public":
      return "публічна";
    case "confidential":
      return "конфіденційна";
    case "private":
    default:
      return "приватна";
  }
}

function LinkedRecordsSection({
  records,
  type,
  onOpen,
  onAdd,
  readOnly,
}: {
  records: Array<Finding | TaskRecord | Hypothesis | ArchiveRequest>;
  type: "finding" | "task" | "hypothesis" | "archiveRequest";
  onOpen: (page: PageKey, entityId: string) => void;
  onAdd: () => void;
  readOnly: boolean;
}) {
  const labels = {
    finding: ["Знахідки особи", "Додати знахідку"],
    task: ["Завдання особи", "Додати завдання"],
    hypothesis: ["Гіпотези про особу", "Додати гіпотезу"],
    archiveRequest: ["Запити в архів про особу", "Додати запит"],
  } as const;
  const [title, buttonLabel] = labels[type];
  return (
    <div>
      <div className="section-heading person-records-heading">
        <div>
          <h3>{title}</h3>
          <p>Новий запис автоматично буде прив’язаний до цієї особи.</p>
        </div>
        {!readOnly ? (
          <button type="button" className="button button-secondary" onClick={onAdd}>
            + {buttonLabel}
          </button>
        ) : null}
      </div>
      <LinkedRecords records={records} type={type} onOpen={onOpen} />
    </div>
  );
}

function LinkedRecords({
  records,
  type,
  onOpen,
}: {
  records: Array<Finding | TaskRecord | Hypothesis | ArchiveRequest>;
  type: "finding" | "task" | "hypothesis" | "archiveRequest";
  onOpen: (page: PageKey, entityId: string) => void;
}) {
  if (!records.length) return <div className="empty-inline">Пов’язаних записів поки немає.</div>;
  return (
    <div className="person-linked-list">
      {records.map((record) => {
        const title = type === "finding"
          ? ((record as Finding).summary || (record as Finding).personsText || (record as Finding).findingType)
          : type === "archiveRequest"
            ? ((record as ArchiveRequest).subject || (record as ArchiveRequest).archive)
          : (record as TaskRecord | Hypothesis).title;
        const details = type === "finding"
          ? [(record as Finding).findingType, (record as Finding).eventDate, (record as Finding).place]
          : type === "task"
            ? [(record as TaskRecord).status, (record as TaskRecord).place]
            : type === "archiveRequest"
              ? [(record as ArchiveRequest).archive, (record as ArchiveRequest).requestDate, (record as ArchiveRequest).status]
            : [(record as Hypothesis).status, (record as Hypothesis).probability];
        return (
          <button
            type="button"
            className="person-linked-record"
            key={record.id}
            onClick={() => onOpen(
              type === "finding"
                ? "findings"
                : type === "task"
                  ? "tasks"
                  : type === "archiveRequest"
                    ? "archiveRequests"
                    : "hypotheses",
              record.id,
            )}
          >
            <strong>{title || "Запис без назви"}</strong>
            <small>{details.filter(Boolean).join(" · ")}</small>
            <span>Відкрити →</span>
          </button>
        );
      })}
    </div>
  );
}

const personRelationTypeOptions: PersonRelationType[] = [
  "батько",
  "мати",
  "батько або мати",
  "чоловік",
  "дружина",
  "подружжя",
  "дитина",
  "син",
  "донька",
  "брат",
  "сестра",
  "брат або сестра",
  "хрещений",
  "хрещена",
  "хрещеник",
  "хрещениця",
  "вітчим",
  "мачуха",
  "пасинок",
  "падчерка",
  "опікун",
  "підопічний",
  "усиновлювач",
  "усиновлена дитина",
  "свідок",
  "поручитель",
  "священник",
  "духовна особа",
  "посадова особа",
  "повитуха",
  "особа, яка повідомила",
  "голова господарства",
  "член господарства",
  "наймит або служник",
  "родич",
  "інше",
];

function RelationFormModal({
  person,
  persons,
  onClose,
  onSave,
}: {
  person: Person;
  persons: Person[];
  onClose: () => void;
  onSave: (relation: PersonRelation) => void;
}) {
  const [relatedPersonId, setRelatedPersonId] = useState("");
  const [selectionError, setSelectionError] = useState(false);
  const [relationType, setRelationType] = useState<PersonRelationType>("інше");
  const [status, setStatus] = useState<PersonRelationStatus>("гіпотеза");
  const [evidenceText, setEvidenceText] = useState("");
  const [notes, setNotes] = useState("");
  const availablePersons = useMemo(
    () => persons.filter((item) => item.id !== person.id),
    [person.id, persons],
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!relatedPersonId) {
      setSelectionError(true);
      return;
    }
    const timestamp = nowIso();
    onSave({
      id: createId(),
      personId: person.id,
      relatedPersonId,
      relationType,
      status,
      evidenceText,
      notes,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };
  return (
    <Modal title="Додати зв’язок" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <RelationPersonPicker
            persons={availablePersons}
            selectedId={relatedPersonId}
            error={selectionError}
            onChange={(id) => {
              setRelatedPersonId(id);
              setSelectionError(false);
            }}
          />
          <label>
            <span>Тип зв’язку</span>
            <select value={relationType} onChange={(event) => setRelationType(event.target.value as PersonRelationType)}>
              {personRelationTypeOptions.map((type) => <option key={type}>{type}</option>)}
            </select>
          </label>
          <label>
            <span>Статус</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as PersonRelationStatus)}>
              {["доведено", "імовірно", "гіпотеза", "сумнівно", "спростовано"].map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="field-wide">
            <span>Докази</span>
            <textarea rows={4} value={evidenceText} onChange={(event) => setEvidenceText(event.target.value)} />
          </label>
          <label className="field-wide">
            <span>Нотатки</span>
            <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button type="submit" className="button button-primary">Зберегти</button>
        </div>
      </form>
    </Modal>
  );
}

interface RelationPersonSearchDocument {
  id: string;
  person: Person;
  title: string;
  description: string;
  searchText: string;
}

const relationPersonSearchOptions: IFuseOptions<RelationPersonSearchDocument> = {
  keys: [
    { name: "title", weight: 0.5 },
    { name: "description", weight: 0.2 },
    { name: "searchText", weight: 0.3 },
  ],
  ignoreLocation: true,
  includeScore: true,
  isCaseSensitive: false,
  minMatchCharLength: 2,
  threshold: 0.35,
};

function RelationPersonPicker({
  persons,
  selectedId,
  error,
  onChange,
}: {
  persons: Person[];
  selectedId: string;
  error: boolean;
  onChange: (id: string) => void;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const documents = useMemo<RelationPersonSearchDocument[]>(
    () => persons.map((person) => {
      const title = personDisplayName(person);
      const places = personPlaces(person);
      const years = lifeYears(person);
      return {
        id: person.id,
        person,
        title,
        description: [years !== "—" ? years : "", places, person.status].filter(Boolean).join(" · "),
        searchText: [
          title,
          person.surname,
          person.givenName,
          person.patronymic,
          person.nameVariants,
          person.surnameVariants,
          places,
          person.notes,
        ].join(" "),
      };
    }),
    [persons],
  );
  const fuse = useMemo(
    () => new Fuse(
      documents,
      relationPersonSearchOptions,
      Fuse.createIndex(["title", "description", "searchText"], documents),
    ),
    [documents],
  );
  const selected = documents.find((item) => item.id === selectedId);
  const trimmedQuery = query.trim();
  const results = useMemo(
    () => trimmedQuery
      ? fuse.search(trimmedQuery, { limit: 12 }).map((result) => result.item)
      : documents.slice(0, 8),
    [documents, fuse, trimmedQuery],
  );

  return (
    <div className="field-wide relation-person-search">
      <label htmlFor={inputId}>
        <span>Пов’язана особа *</span>
      </label>
      <input
        id={inputId}
        value={query}
        autoComplete="off"
        placeholder="Введіть прізвище, ім’я або по батькові"
        aria-invalid={error}
        onChange={(event) => setQuery(event.target.value)}
      />
      {selected ? (
        <div className="relation-person-selected">
          <span>
            <strong>{selected.title}</strong>
            {selected.description ? <small>{selected.description}</small> : null}
          </span>
          <button type="button" className="text-button" onClick={() => onChange("")}>
            Змінити
          </button>
        </div>
      ) : null}
      {error ? (
        <small className="form-field-error">Виберіть особу зі списку результатів.</small>
      ) : null}
      <div className="relation-person-results" role="listbox" aria-label="Знайдені особи">
        {results.length ? (
          results.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === selectedId}
              className={item.id === selectedId ? "active" : ""}
              onClick={() => {
                onChange(item.id);
                setQuery(item.title);
              }}
            >
              <span>
                <strong>{item.title}</strong>
                {item.description ? <small>{item.description}</small> : null}
              </span>
            </button>
          ))
        ) : (
          <p>Осіб за цим запитом не знайдено.</p>
        )}
      </div>
    </div>
  );
}

function personDisplayName(person: Person): string {
  return person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") || "Особа без імені";
}

function relationTypeForPerson(
  relation: PersonRelation,
  currentPersonId: string,
  otherPerson?: Person,
): string {
  if (relation.personId === currentPersonId) {
    return relation.relationType;
  }

  switch (relation.relationType) {
    case "чоловік":
      return "дружина";
    case "дружина":
      return "чоловік";
    case "подружжя":
      return "подружжя";
    case "батько":
    case "мати":
    case "батько або мати":
      if (otherPerson?.gender === "чоловік") return "син";
      if (otherPerson?.gender === "жінка") return "донька";
      return "дитина";
    case "дитина":
    case "син":
    case "донька":
      if (otherPerson?.gender === "чоловік") return "батько";
      if (otherPerson?.gender === "жінка") return "мати";
      return "батько або мати";
    case "брат":
    case "сестра":
    case "брат або сестра":
      if (otherPerson?.gender === "чоловік") return "брат";
      if (otherPerson?.gender === "жінка") return "сестра";
      return "брат або сестра";
    case "хрещений":
    case "хрещена":
      if (otherPerson?.gender === "чоловік") return "хрещеник";
      if (otherPerson?.gender === "жінка") return "хрещениця";
      return "хрещеник";
    case "хрещеник":
    case "хрещениця":
      if (otherPerson?.gender === "жінка") return "хрещена";
      return "хрещений";
    case "вітчим":
    case "мачуха":
      if (otherPerson?.gender === "жінка") return "падчерка";
      return "пасинок";
    case "пасинок":
    case "падчерка":
      if (otherPerson?.gender === "жінка") return "мачуха";
      return "вітчим";
    case "опікун":
      return "підопічний";
    case "підопічний":
      return "опікун";
    case "усиновлювач":
      return "усиновлена дитина";
    case "усиновлена дитина":
      return "усиновлювач";
    case "голова господарства":
      return "член господарства";
    case "член господарства":
      return "голова господарства";
    case "наймит або служник":
      return "господар";
    case "свідок":
    case "поручитель":
    case "священник":
    case "духовна особа":
    case "посадова особа":
    case "повитуха":
    case "особа, яка повідомила":
      return "особа у записі";
    default:
      return relation.relationType;
  }
}

function lifeYears(person: Person): string {
  const birth = person.birthDate?.slice(0, 4) || yearRange(person.birthYearFrom, person.birthYearTo);
  const death = person.deathDate?.slice(0, 4) || yearRange(person.deathYearFrom, person.deathYearTo);
  if (birth && death) return `${birth} – ${death}`;
  if (birth) return `нар. ${birth}`;
  if (death) return `пом. ${death}`;
  return "—";
}

function yearRange(from: string, to: string): string {
  if (from && to && from !== to) return `${from}–${to}`;
  return from || to;
}

function displayDate(value: string): string {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function personPlaces(person: Person): string {
  return [...new Set([
    person.birthPlace,
    person.marriagePlace,
    person.deathPlace,
    ...person.residencePlaces.split(/[,;\n]/),
  ].map((item) => item.trim()).filter(Boolean))].join(", ");
}

function linkedCount(records: Array<{ personIds?: string[] }>, personId: string): number {
  return records.filter((record) => record.personIds?.includes(personId)).length;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("uk");
}

function findingDraftFor(person: Person): Record<string, unknown> {
  const name = personDisplayName(person);
  return {
    researchId: person.researchId,
    personIds: [person.id],
    personsText: name,
    participants: [{
      id: createId(),
      role: "Згадана особа",
      name,
      notes: "Додано з картки особи",
    }],
    place: person.birthPlace || person.residencePlaces.split(/[,;\n]/)[0]?.trim() || "",
  };
}

function taskDraftFor(person: Person): Record<string, unknown> {
  return {
    researchId: person.researchId,
    personIds: [person.id],
    personName: personDisplayName(person),
    place: person.birthPlace || person.residencePlaces.split(/[,;\n]/)[0]?.trim() || "",
  };
}

function hypothesisDraftFor(person: Person): Record<string, unknown> {
  return {
    researchId: person.researchId,
    personIds: [person.id],
    relatedPeople: personDisplayName(person),
  };
}

function archiveRequestDraftFor(person: Person): Record<string, unknown> {
  return {
    researchId: person.researchId,
    personIds: [person.id],
    subject: `Запит щодо ${personDisplayName(person)}`,
  };
}
