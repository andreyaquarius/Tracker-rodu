import Fuse, { type IFuseOptions } from "fuse.js";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  AppDatabase,
  AppEntity,
  ArchiveRequest,
  DocumentRecord,
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
import { formatDateForDisplay, nowIso } from "../utils/dateHelpers";
import type { PageKey } from "../components/Sidebar";
import { deleteScanFile, getScanPreviewSource } from "../services/scanStorage";
import { CustomFieldsView } from "../components/CustomFields";
import { normalizeCustomFieldValues } from "../utils/customFields";
import { ExcelExportMenu } from "../components/ExcelExportMenu";
import { exportPersonsToExcel } from "../utils/excelExport";
import { TableDataImportButton } from "../components/TableDataImportButton";
import { GedcomImportButton } from "../components/GedcomImportButton";
import { PaginationControls } from "../components/PaginationControls";
import { usePagination } from "../hooks/usePagination";
import { useWorkspaceWindows } from "../components/WorkspaceWindows";
import { createFamilyTreeFromLegacyImport } from "../services/familyTreeMutationService";
import { registerGedcomImportTree } from "../services/gedcomImportOperation.ts";
import type {
  GedcomImportExecutionOptions,
  GedcomImportReconciliationPayload,
  GedcomImportReconciliationResult,
} from "../utils/gedcomImportReconciliation.ts";
import type {
  GedcomPhotoBackupPlan,
  GedcomPhotoBackupProgress,
  GedcomPhotoBackupResult,
} from "../services/gedcomPhotoBackup.ts";
import {
  PERSON_RELATION_TYPES,
  normalizePersonRelation,
} from "../utils/personRelation";
import {
  isPhotoReferenceAvailable,
  personAvatarImageStyle,
  primaryPersonPhoto,
} from "../utils/personPhotos.ts";
import { PersonEventsView } from "../components/PersonEventsView.tsx";
import { personEducation, personNationality } from "../utils/personStandardFields.ts";
import { PERSON_STATUSES } from "../utils/personStatus.ts";
import {
  listPersonLinkedRecords,
  type PersonLinkedRecords,
} from "../services/projectPersonLinkedRecords.ts";
import {
  savePersonAndClose,
  type PersonSaveHandler,
} from "../features/persons-v2/contracts.ts";
import {
  archiveRequestDraftForPerson,
  findingDraftForPerson,
  hypothesisDraftForPerson,
  taskDraftForPerson,
} from "../utils/personRelatedRecordDrafts.ts";

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
  onImportGedcom,
  onBackupGedcomPhotos,
  onDeletePerson,
  onSaveRelation,
  onDeleteRelation,
  onOpenRelated,
  onCreateRelated,
  readOnly = false,
  canCreate = true,
  canCreateTree = true,
  canImportTable = true,
  onSubscriptionChanged,
  researchRequired = false,
  canUseGedcom = false,
  projectId,
  projectName = "Трекер Роду",
}: {
  db: AppDatabase;
  projectId?: string;
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
  onSavePerson: PersonSaveHandler;
  onImportRecords: (collection: "persons", records: AppEntity[]) => Promise<void>;
  onImportGedcom?: (
    input: GedcomImportReconciliationPayload,
    options?: GedcomImportExecutionOptions,
  ) => Promise<GedcomImportReconciliationResult | void>;
  onBackupGedcomPhotos?: (
    plan: GedcomPhotoBackupPlan,
    onProgress: (progress: GedcomPhotoBackupProgress) => void,
  ) => Promise<GedcomPhotoBackupResult>;
  onDeletePerson: (id: string) => void;
  onSaveRelation: (relation: PersonRelation) => Promise<PersonRelation | null> | PersonRelation | null | void;
  onDeleteRelation: (id: string) => void;
  onOpenRelated: (page: PageKey, entityId: string, entity?: AppEntity) => void;
  onCreateRelated: (page: PageKey, initialValues: Record<string, unknown>) => void;
  readOnly?: boolean;
  canCreate?: boolean;
  canCreateTree?: boolean;
  canImportTable?: boolean;
  onSubscriptionChanged?: () => void;
  projectName?: string;
  researchRequired?: boolean;
  canUseGedcom?: boolean;
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
          projectId={projectId}
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
          onSave={(savedPerson) => savePersonAndClose(onSavePerson, savedPerson, close)}
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
          onSave={(savedPerson) => savePersonAndClose(onSavePerson, savedPerson, close)}
          modalMode="window"
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  };

  const searchablePersons = useMemo(() => persons.map((person) => ({
    person,
    searchText: normalize([
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
      personNationality(person),
      personEducation(person).join(" "),
      ...(person.events ?? []).flatMap((event) => [
        event.title,
        event.value,
        event.date,
        event.placeName,
        event.age,
        event.cause,
        event.address,
        event.notes,
      ]),
      person.notes,
    ].join(" ")),
    places: normalize(personPlaces(person)),
    surnames: normalize(`${person.surname} ${person.surnameVariants}`),
  })), [persons]);
  const filtered = useMemo(() => {
    if (
      !search &&
      !researchFilter &&
      !statusFilter &&
      !genderFilter &&
      !placeFilter &&
      !surnameFilter
    ) {
      return persons;
    }
    const query = normalize(search);
    const place = normalize(placeFilter);
    const surname = normalize(surnameFilter);
    return searchablePersons.filter(({ person, searchText, places, surnames }) => (
        (!query || searchText.includes(query)) &&
        (!researchFilter || person.researchId === researchFilter) &&
        (!statusFilter || person.status === statusFilter) &&
        (!genderFilter || person.gender === genderFilter) &&
        (!place || places.includes(place)) &&
        (!surname || surnames.includes(surname))
      )).map(({ person }) => person);
  }, [genderFilter, persons, placeFilter, researchFilter, search, searchablePersons, statusFilter, surnameFilter]);
  const findingCounts = useMemo(() => linkedCountByPerson(findings), [findings]);
  const taskCounts = useMemo(() => linkedCountByPerson(tasks), [tasks]);
  const hypothesisCounts = useMemo(() => linkedCountByPerson(hypotheses), [hypotheses]);
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
        ...(person.photos ?? []),
        ...customAttachmentScans(person.customFields, customFieldDefinitions),
      ];
      await Promise.allSettled(scans.map((scan) => deleteScanFile(scan)));
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
          {canCreateRecords && canImportTable ? (
            <TableDataImportButton
              collection="persons"
              db={db}
              fields={[]}
              customFieldDefinitions={customFieldDefinitions}
              onImport={(records) => onImportRecords("persons", records)}
            />
          ) : null}
          {canUseGedcom ? (
            <GedcomImportButton
              key={`persons-gedcom-import:${projectId ?? "local"}`}
              disabled={!canCreateRecords || !canCreateTree}
              defaultResearchId={researchFilter || (researches.length === 1 ? researches[0].id : "")}
              researchRequired={researchRequired}
              onImportPersons={(records) => onImportRecords("persons", records)}
              onImportGedcom={onImportGedcom}
              onBackupGedcomPhotos={onBackupGedcomPhotos}
              onSaveRelation={onSaveRelation}
              onCreateFamilyTree={projectId ? async ({ fileName, people, relations, rootPersonId, importSourceKey, importOperationId }) => {
                const result = await createFamilyTreeFromLegacyImport({
                  projectId,
                  title: `GEDCOM: ${fileName}`,
                  persons: people,
                  relations,
                  rootPersonId,
                  importSourceKey,
                  rollbackOperationId: importOperationId,
                });
                if (result && importOperationId) {
                  // Keep this registration next to creation as a defensive,
                  // idempotent barrier before the callback returns.
                  await registerGedcomImportTree(importOperationId, result.treeId);
                }
                if (result) onSubscriptionChanged?.();
                return result ? { treeId: result.treeId } : undefined;
              } : undefined}
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
              {PERSON_STATUSES.map((status) => <option key={status}>{status}</option>)}
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
                      <td data-label="Знахідки">{findingCounts.get(person.id) ?? 0}</td>
                      <td data-label="Завдання">{taskCounts.get(person.id) ?? 0}</td>
                      <td data-label="Гіпотези">{hypothesisCounts.get(person.id) ?? 0}</td>
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

export function PersonCardModal({
  projectId,
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
  projectId?: string;
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
  onSaveRelation: (relation: PersonRelation) => Promise<PersonRelation | null> | PersonRelation | null | void;
  onDeleteRelation: (id: string) => void;
  onOpenRelated: (page: PageKey, entityId: string, entity?: AppEntity) => void;
  onCreateRelated: (page: PageKey, initialValues: Record<string, unknown>) => void;
  readOnly: boolean;
  canCreate: boolean;
  stackIndex: number;
  dockIndex: number;
  onFocus: () => void;
}) {
  const [tab, setTab] = useState<PersonTab>("overview");
  const [relationFormOpen, setRelationFormOpen] = useState(false);
  const [linkedReloadKey, setLinkedReloadKey] = useState(0);
  const [linkedLoading, setLinkedLoading] = useState(Boolean(projectId));
  const [linkedError, setLinkedError] = useState("");
  const [remoteLinkedRecords, setRemoteLinkedRecords] = useState<{
    personId: string;
    records: PersonLinkedRecords;
  } | null>(null);
  const localLinkedRecords = useMemo<PersonLinkedRecords>(() => ({
    findings: findings.filter((item) => item.personIds?.includes(person.id)),
    tasks: tasks.filter((item) => item.personIds?.includes(person.id)),
    hypotheses: hypotheses.filter((item) => item.personIds?.includes(person.id)),
    archiveRequests: archiveRequests.filter((item) => item.personIds?.includes(person.id)),
  }), [archiveRequests, findings, hypotheses, person.id, tasks]);
  const linkedRecords = remoteLinkedRecords?.personId === person.id
    ? remoteLinkedRecords.records
    : localLinkedRecords;
  const linkedFindings = linkedRecords.findings;
  const linkedTasks = linkedRecords.tasks;
  const linkedHypotheses = linkedRecords.hypotheses;
  const linkedArchiveRequests = linkedRecords.archiveRequests;

  useEffect(() => {
    if (!projectId) {
      setLinkedLoading(false);
      setLinkedError("");
      setRemoteLinkedRecords(null);
      return;
    }
    let active = true;
    setLinkedLoading(true);
    setLinkedError("");
    void listPersonLinkedRecords(projectId, person.id)
      .then((records) => {
        if (active) setRemoteLinkedRecords({ personId: person.id, records });
      })
      .catch(() => {
        if (!active) return;
        setLinkedError(
          "Не вдалося завантажити пов’язані записи особи. Спробуйте ще раз.",
        );
      })
      .finally(() => {
        if (active) setLinkedLoading(false);
      });
    return () => {
      active = false;
    };
  }, [linkedReloadKey, person.id, projectId]);
  const linkedRelationItems = useMemo(
    () => personRelationDisplayItems(relations, person.id),
    [person.id, relations],
  );
  const tabs: Array<[PersonTab, string, number?]> = [
    ["overview", "Огляд"],
    ["findings", "Знахідки", linkedFindings.length],
    ["tasks", "Завдання", linkedTasks.length],
    ["hypotheses", "Гіпотези", linkedHypotheses.length],
    ["archiveRequests", "Запити в архів", linkedArchiveRequests.length],
    ["relations", "Зв’язки", linkedRelationItems.length],
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
          {linkedLoading ? (
            <div className="empty-inline" role="status">
              Завантажуємо пов’язані записи особи…
            </div>
          ) : null}
          {linkedError ? (
            <div className="empty-inline" role="alert">
              <span>{linkedError}</span>{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => setLinkedReloadKey((value) => value + 1)}
              >
                Спробувати ще раз
              </button>
            </div>
          ) : null}
          {tab === "overview" ? (
            <PersonOverview
              db={db}
              person={person}
              researches={researches}
              findings={linkedFindings}
              customFieldDefinitions={customFieldDefinitions}
              onOpenFinding={(findingId) => onOpenRelated(
                "findings",
                findingId,
                linkedFindings.find((finding) => finding.id === findingId),
              )}
            />
          ) : null}
          {tab === "findings" ? (
            <LinkedRecordsSection
              records={linkedFindings}
              type="finding"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("findings", findingDraftForPerson(person))}
              readOnly={!canCreate}
            />
          ) : null}
          {tab === "tasks" ? (
            <LinkedRecordsSection
              records={linkedTasks}
              type="task"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("tasks", taskDraftForPerson(person))}
              readOnly={!canCreate}
            />
          ) : null}
          {tab === "hypotheses" ? (
            <LinkedRecordsSection
              records={linkedHypotheses}
              type="hypothesis"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("hypotheses", hypothesisDraftForPerson(person))}
              readOnly={!canCreate}
            />
          ) : null}
          {tab === "archiveRequests" ? (
            <LinkedRecordsSection
              records={linkedArchiveRequests}
              type="archiveRequest"
              onOpen={onOpenRelated}
              onAdd={() => onCreateRelated("archiveRequests", archiveRequestDraftForPerson(person))}
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
              {linkedRelationItems.length ? (
                <div className="relation-list">
                  {linkedRelationItems.map(({ relation, duplicateIds }) => {
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
                              if (window.confirm("Видалити цей зв’язок?")) {
                                [relation.id, ...duplicateIds].forEach(onDeleteRelation);
                              }
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
    ["Дівоче прізвище", person.maidenSurname],
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
    ...(!person.isLiving ? [
      ["Дата смерті", displayDate(person.deathDate)],
      ["Рік смерті від", person.deathYearFrom],
      ["Рік смерті до", person.deathYearTo],
      ["Місце смерті", person.deathPlace],
    ] : []),
    ["Місця проживання", person.residencePlaces],
    ["Соціальний статус", person.socialStatus],
    ["Віросповідання", person.religion],
    ["Професія або заняття", person.occupation],
    ["Національність", personNationality(person)],
    ["Освіта", personEducation(person).join("; ")],
  ];
  const findingsWithFiles = findings.filter((finding) => finding.scans?.length);
  const photos = person.photos ?? [];
  return (
    <div className="details-grid">
      {photos.length ? (
        <div className="detail-item detail-wide person-photo-section">
          <span>Фотографії</span>
          <PersonPrimaryPhoto person={person} />
          <ScanAttachmentsView scans={photos} />
        </div>
      ) : null}
      {values.map(([label, value]) => (
        <div className="detail-item" key={label}>
          <span>{label}</span>
          <div className="detail-text">{value || "—"}</div>
        </div>
      ))}
      <div className="detail-item detail-wide">
        <span>Інші життєві події та факти</span>
        <PersonEventsView events={person.events ?? []} />
      </div>
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

function PersonPrimaryPhoto({ person }: { person: Person }) {
  const photo = primaryPersonPhoto(person.photos, person.primaryPhotoId);
  const [source, setSource] = useState<{ url: string; revoke: boolean } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let currentUrl = "";
    let revoke = false;
    setSource(null);
    setError("");
    if (!photo || !isPhotoReferenceAvailable(photo)) {
      if (photo?.statusMessage) setError(photo.statusMessage);
      return () => undefined;
    }
    void getScanPreviewSource(photo)
      .then((preview) => {
        if (!active) {
          if (preview.revokeOnClose) URL.revokeObjectURL(preview.url);
          return;
        }
        if (preview.kind !== "image") {
          setError("Головне фото не є підтримуваним зображенням.");
          if (preview.revokeOnClose) URL.revokeObjectURL(preview.url);
          return;
        }
        currentUrl = preview.url;
        revoke = preview.revokeOnClose;
        setSource({ url: preview.url, revoke: preview.revokeOnClose });
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Не вдалося відкрити головне фото.");
      });
    return () => {
      active = false;
      if (revoke && currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [photo]);

  return (
    <div className="person-primary-photo">
      {source ? (
        <img
          src={source.url}
          alt={`Головне фото: ${personDisplayName(person)}`}
          style={personAvatarImageStyle(photo)}
          onError={() => {
            if (source.revoke) URL.revokeObjectURL(source.url);
            setSource(null);
            setError(
              "Фото більше недоступне за початковим посиланням. Відкрийте редагування особи та завантажте файл або збережіть доступну копію у Google Drive.",
            );
          }}
        />
      ) : (
        <div className="person-primary-photo-placeholder">{error || "Завантаження фото…"}</div>
      )}
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
  onOpen: (page: PageKey, entityId: string, entity?: AppEntity) => void;
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
  onOpen: (page: PageKey, entityId: string, entity?: AppEntity) => void;
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
          ? [
              (record as Finding).findingType,
              formatDateForDisplay((record as Finding).eventDate),
              (record as Finding).place,
            ]
          : type === "task"
            ? [(record as TaskRecord).status, (record as TaskRecord).place]
            : type === "archiveRequest"
              ? [
                  (record as ArchiveRequest).archive,
                  formatDateForDisplay((record as ArchiveRequest).requestDate),
                  (record as ArchiveRequest).status,
                ]
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
              record,
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
  ...PERSON_RELATION_TYPES,
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
    <Modal title="Додати зв’язок" className="person-relation-modal" onClose={onClose}>
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

type PersonRelationDisplayItem = {
  relation: PersonRelation;
  duplicateIds: string[];
};

function personRelationDisplayItems(relations: PersonRelation[], personId: string): PersonRelationDisplayItem[] {
  const result: PersonRelationDisplayItem[] = [];
  const spousePairs = new Map<string, PersonRelationDisplayItem>();

  for (const rawRelation of relations) {
    const relation = normalizePersonRelation(rawRelation);
    if (relation.personId !== personId && relation.relatedPersonId !== personId) continue;
    if (!isSpouseRelationType(relation.relationType)) {
      result.push({ relation, duplicateIds: [] });
      continue;
    }

    const otherId = relation.personId === personId ? relation.relatedPersonId : relation.personId;
    const pairKey = ["spouse", ...[personId, otherId].sort()].join(":");
    const existing = spousePairs.get(pairKey);
    if (existing) {
      existing.duplicateIds.push(relation.id);
      continue;
    }

    const item = { relation, duplicateIds: [] };
    spousePairs.set(pairKey, item);
    result.push(item);
  }

  return result;
}

function relationTypeForPerson(
  relation: PersonRelation,
  currentPersonId: string,
  otherPerson?: Person,
): string {
  if (isSpouseRelationType(relation.relationType)) {
    return spouseRelationTypeForRelatedPerson(otherPerson?.gender, relation.relationType);
  }
  if (relation.personId === currentPersonId) {
    return directParentRelationTypeForRelatedPerson(relation.relationType, otherPerson?.gender) ?? relation.relationType;
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

function isSpouseRelationType(value: PersonRelationType): boolean {
  return value === "чоловік" || value === "дружина" || value === "подружжя";
}

function directParentRelationTypeForRelatedPerson(
  relationType: PersonRelationType,
  relatedGender: Person["gender"] | undefined,
): string | null {
  if (relationType === "батько") return "Батько";
  if (relationType === "мати") return "Мати";
  if (relationType !== "батько або мати") return null;
  if (relatedGender === "чоловік") return "Батько";
  if (relatedGender === "жінка") return "Мати";
  return "Батько або мати";
}

function spouseRelationTypeForRelatedPerson(
  relatedGender: Person["gender"] | undefined,
  fallback: PersonRelationType,
): string {
  if (relatedGender === "чоловік") return "чоловік";
  if (relatedGender === "жінка") return "дружина";
  return fallback === "чоловік" || fallback === "дружина" ? fallback : "подружжя";
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
  return formatDateForDisplay(value);
}

function personPlaces(person: Person): string {
  return [...new Set([
    person.birthPlace,
    person.marriagePlace,
    person.deathPlace,
    ...person.residencePlaces.split(/[,;\n]/),
  ].map((item) => item.trim()).filter(Boolean))].join(", ");
}

function linkedCountByPerson(records: Array<{ personIds?: string[] }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const personId of new Set(record.personIds ?? [])) {
      counts.set(personId, (counts.get(personId) ?? 0) + 1);
    }
  }
  return counts;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("uk");
}
