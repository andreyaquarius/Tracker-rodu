import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  AppEntity,
  AppDatabase,
  CollectionKey,
  CustomFieldDefinition,
  CustomFieldValues,
  DocumentFragmentSelection,
  DocumentRecord,
  Finding,
  FindingParticipant,
  GeoPoint,
  Hypothesis,
  Person,
  PersonEvent,
  PersonEventType,
  PersonGender,
  PersonRelation,
  PersonRelationType,
  Research,
  ScanAttachment,
  TaskRecord,
} from "../types";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import { DataTable } from "../components/DataTable";
import { Modal } from "../components/Modal";
import type { EntityConfig, FieldConfig } from "./entityConfigs";
import {
  participantRoles,
  participantSummary,
  primaryParticipantName,
  sortFindingParticipants,
} from "../utils/findingParticipants";
import { PersonSelector } from "../components/PersonSelector";
import { PersonFormModal, type PersonInitialDraft } from "../components/PersonFormModal";
import {
  ScanAttachmentsEditor,
  ScanAttachmentsView,
} from "../components/ScanAttachments";
import type { DocumentScanViewerContext } from "../components/DocumentWorkspaceViewer";
import type { PageKey } from "../components/Sidebar";
import { deleteScanFile } from "../services/scanStorage";
import { CustomFieldsEditor, CustomFieldsView } from "../components/CustomFields";
import { InlineCustomFieldCreator } from "../components/InlineCustomFieldCreator";
import { HypothesisAiAgent } from "../components/HypothesisAiAgent";
import { FindingAiIndexingPanel } from "../components/FindingAiIndexingPanel";
import {
  definitionsForModule,
  normalizeCustomFieldValues,
  supportsCustomFields,
} from "../utils/customFields";
import { ExcelExportMenu } from "../components/ExcelExportMenu";
import { exportEntityRecordsToExcel } from "../utils/excelExport";
import { TableDataImportButton } from "../components/TableDataImportButton";
import { canImportCollection } from "../utils/tableDataImport";
import { sanitizeWebUrl } from "../utils/safeUrl";
import { GeoPlaceField } from "../components/GeoPlaceField";
import { PaginationControls } from "../components/PaginationControls";
import { usePagination } from "../hooks/usePagination";
import { useWorkspaceWindows } from "../components/WorkspaceWindows";

interface CrudPageProps {
  config: EntityConfig;
  db: AppDatabase;
  items: AppEntity[];
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons?: Person[];
  customFieldDefinitions?: CustomFieldDefinition[];
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  canAddCustomField?: boolean;
  customFieldLimitMessage?: string;
  initialSearch?: string;
  initialOpenEntityId?: string;
  initialCreateRequest?: {
    id: number;
    initialValues: Record<string, unknown>;
  };
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  onSavePerson?: (person: Person) => void | Promise<Person | null | void>;
  onSaveRelation?: (relation: PersonRelation) => void | Promise<PersonRelation | null | void>;
  onSave: (entity: AppEntity) => void | AppEntity | null | Promise<AppEntity | null | void>;
  onImportRecords?: (collection: CollectionKey, records: AppEntity[]) => Promise<void>;
  onDelete: (id: string) => void;
  onCreateBlocked?: () => void;
  projectId?: string;
  onCreateTask?: (task: TaskRecord) => void;
  readOnly?: boolean;
  canCreate?: boolean;
  projectName?: string;
  researchRequired?: boolean;
}

type FormValue =
  | string
  | boolean
  | string[]
  | FindingParticipant[]
  | ScanAttachment[]
  | DocumentFragmentSelection
  | GeoPoint
  | null;
type FormRecord = Record<string, FormValue>;
type EntityWindow =
  | { windowId: string; kind: "view"; entityId: string }
  | { windowId: string; kind: "edit"; entityId: string }
  | { windowId: string; kind: "new"; initialValues?: Record<string, unknown> };

type PersonSeed = {
  key: string;
  title: string;
  draft: PersonInitialDraft;
  participantId?: string;
  participantRole?: string;
};

type PersonSeedChoice = {
  key: string;
  title: string;
  description: string;
  draft: PersonInitialDraft;
  participantId?: string;
  participantRole?: string;
};

type CreatedFindingPerson = {
  participantId: string;
  participantRole: string;
  person: Person;
};

export function CrudPage({
  config,
  db,
  items,
  researches,
  documents,
  findings,
  persons = [],
  customFieldDefinitions = [],
  onAddCustomField,
  onDeleteCustomField,
  canAddCustomField = true,
  customFieldLimitMessage,
  initialSearch = "",
  initialOpenEntityId = "",
  initialCreateRequest,
  onOpenRelated,
  onOpenScanViewer,
  onSavePerson,
  onSaveRelation,
  onSave,
  onImportRecords,
  onDelete,
  onCreateBlocked,
  projectId = "",
  onCreateTask,
  readOnly = false,
  canCreate = true,
  researchRequired = false,
  projectName = "Трекер Роду",
}: CrudPageProps) {
  const canCreateRecords = !readOnly && canCreate;
  const canAttemptCreate = !readOnly;
  const [search, setSearch] = useState(initialSearch);
  const [researchFilter, setResearchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [archiveFilter, setArchiveFilter] = useState("");
  const [placeFilter, setPlaceFilter] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [documentTypeFilter, setDocumentTypeFilter] = useState("");
  const initialOpenRef = useRef("");
  const createRequestRef = useRef<number | null>(null);
  const windowOwnerKey = `${projectId || "local"}:${config.collection}`;
  const { openWindow: openWorkspaceWindow, closeWindows } = useWorkspaceWindows();

  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);
  useEffect(() => {
    if (!initialOpenEntityId) return;
    if (initialOpenRef.current === `${config.collection}:${initialOpenEntityId}`) return;
    const entity = items.find((item) => item.id === initialOpenEntityId);
    if (entity) {
      initialOpenRef.current = `${config.collection}:${initialOpenEntityId}`;
      openViewWindow(entity);
    }
  }, [config.collection, initialOpenEntityId, items]);
  useEffect(() => {
    if (!initialOpenEntityId) initialOpenRef.current = "";
  }, [initialOpenEntityId]);
  useEffect(() => {
    if (!initialCreateRequest || !canCreateRecords) return;
    if (createRequestRef.current === initialCreateRequest.id) return;
    createRequestRef.current = initialCreateRequest.id;
    openNewWindow(initialCreateRequest.initialValues);
  }, [canCreateRecords, initialCreateRequest?.id]);
  useEffect(() => {
    const existingIds = new Set(items.map((item) => item.id));
    closeWindows((window) =>
      window.ownerKey === windowOwnerKey &&
      crudEntityIdFromWindowKey(window.logicalKey) !== null &&
      !existingIds.has(crudEntityIdFromWindowKey(window.logicalKey) ?? ""),
    );
  }, [closeWindows, items, windowOwnerKey]);
  const openViewWindow = (entity: AppEntity) => {
    openWorkspaceWindow({
      ownerKey: windowOwnerKey,
      logicalKey: entityWindowKey({ windowId: "", kind: "view", entityId: entity.id }),
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <EntityDetailsModal
          config={config}
          db={db}
          entity={entity}
          researches={researches}
          documents={documents}
          findings={findings}
          persons={persons}
          customFieldDefinitions={customFieldDefinitions}
          onOpenRelated={onOpenRelated}
          onOpenScanViewer={onOpenScanViewer}
          projectId={projectId}
          canCreateTasks={canCreateRecords}
          onCreateTask={onCreateTask}
          onClose={close}
          onEdit={readOnly ? undefined : () => openEditWindow(entity)}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  };
  const openEditWindow = (entity: AppEntity) => {
    openWorkspaceWindow({
      ownerKey: windowOwnerKey,
      logicalKey: entityWindowKey({ windowId: "", kind: "edit", entityId: entity.id }),
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <EntityModal
          config={config}
          db={db}
          entity={entity}
          researches={researches}
          documents={documents}
          findings={findings}
          persons={persons}
          customFieldDefinitions={customFieldDefinitions}
          onAddCustomField={onAddCustomField}
          onDeleteCustomField={onDeleteCustomField}
          canAddCustomField={canAddCustomField}
          customFieldLimitMessage={customFieldLimitMessage}
          onSavePerson={onSavePerson}
          onSaveRelation={onSaveRelation}
          onPersist={onSave}
          onOpenScanViewer={onOpenScanViewer}
          researchRequired={researchRequired}
          onClose={close}
          onSave={(savedEntity) => {
            onSave(savedEntity);
            close();
          }}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  };
  const openNewWindow = (initialValues?: Record<string, unknown>) => {
    const windowId = createId();
    openWorkspaceWindow({
      ownerKey: windowOwnerKey,
      logicalKey: entityWindowKey({ windowId, kind: "new", initialValues }),
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <EntityModal
          config={config}
          db={db}
          entity={null}
          initialValues={initialValues}
          researches={researches}
          documents={documents}
          findings={findings}
          persons={persons}
          customFieldDefinitions={customFieldDefinitions}
          onAddCustomField={onAddCustomField}
          onDeleteCustomField={onDeleteCustomField}
          canAddCustomField={canAddCustomField}
          customFieldLimitMessage={customFieldLimitMessage}
          onSavePerson={onSavePerson}
          onSaveRelation={onSaveRelation}
          onPersist={onSave}
          onOpenScanViewer={onOpenScanViewer}
          researchRequired={researchRequired}
          onClose={close}
          onSave={(savedEntity) => {
            onSave(savedEntity);
            close();
          }}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  };
  const startNew = () => {
    if (readOnly) return;
    if (!canCreate) {
      onCreateBlocked?.();
      return;
    }
    openNewWindow();
  };

  const structuredFilterOptions = useMemo(() => {
    if (config.collection !== "documents" && config.collection !== "yearMatrix") {
      return { archives: [], places: [], documentTypes: [] };
    }
    const values = (key: string) => Array.from(new Set(
      items
        .map((item) => String((item as unknown as Record<string, unknown>)[key] ?? "").trim())
        .filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, "uk"));
    return {
      archives: values("archive"),
      places: values("place"),
      documentTypes: values("documentType"),
    };
  }, [config.collection, items]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("uk");
    return items.filter((item) => {
      const row = item as unknown as Record<string, unknown>;
      const matchesSearch =
        !query ||
        Object.values(row).some((value) => searchableValue(value).includes(query));
      const matchesResearch = !researchFilter || row.researchId === researchFilter;
      const statusValue = row.status ?? row.reviewStatus;
      const matchesStatus = !statusFilter || statusValue === statusFilter;
      const matchesArchive = config.collection !== "documents"
        || !archiveFilter
        || row.archive === archiveFilter;
      const matchesPlace = config.collection !== "yearMatrix"
        || !placeFilter
        || row.place === placeFilter;
      const matchesDocumentType = (
        config.collection !== "documents" && config.collection !== "yearMatrix"
      )
        || !documentTypeFilter
        || row.documentType === documentTypeFilter;
      const matchesYear = config.collection === "documents"
        ? documentMatchesYear(row, yearFilter)
        : config.collection === "yearMatrix"
          ? !yearFilter || String(row.year ?? "").trim() === yearFilter.trim()
          : true;
      return matchesSearch
        && matchesResearch
        && matchesStatus
        && matchesArchive
        && matchesPlace
        && matchesDocumentType
        && matchesYear;
    });
  }, [
    archiveFilter,
    config.collection,
    documentTypeFilter,
    items,
    placeFilter,
    researchFilter,
    search,
    statusFilter,
    yearFilter,
  ]);
  const hasActiveFilters = Boolean(
    search
      || researchFilter
      || statusFilter
      || (config.collection === "documents"
        && (archiveFilter || yearFilter || documentTypeFilter))
      || (config.collection === "yearMatrix"
        && (placeFilter || yearFilter || documentTypeFilter)),
  );
  const paginationResetKey = [
    config.collection,
    search,
    researchFilter,
    statusFilter,
    archiveFilter,
    placeFilter,
    yearFilter,
    documentTypeFilter,
  ].join("\u001f");
  const pagination = usePagination(filtered, paginationResetKey);

  const confirmDelete = async (entity: AppEntity) => {
    if (readOnly) return;
    if (window.confirm(`Видалити ${config.singular}? Цю дію не можна скасувати.`)) {
      const record = entity as unknown as Record<string, unknown>;
      const scans = Object.entries(record)
        .filter(([key, value]) => key.toLocaleLowerCase("uk").includes("scan") && Array.isArray(value))
        .flatMap(([, value]) => value as ScanAttachment[])
        .concat(customAttachmentScans(record.customFields, customFieldDefinitions, config.collection));
      await Promise.allSettled(scans.map(deleteScanFile));
      closeWindows((window) =>
        window.ownerKey === windowOwnerKey &&
        crudEntityIdFromWindowKey(window.logicalKey) === entity.id,
      );
      onDelete(entity.id);
    }
  };

  const quickStatus = (entity: AppEntity, status: string) => {
    if (readOnly) return;
    const key = config.statusKey;
    if (!key) return;
    if (config.collection === "archiveRequests" && key === "status" && status !== "чернетка") {
      const record = entity as unknown as Record<string, unknown>;
      if (!String(record.requestDate ?? "").trim()) {
        window.alert("Заповніть дату запиту перед зміною статусу.");
        return;
      }
    }
    onSave({
      ...(entity as unknown as Record<string, unknown>),
      [key]: status,
      __baseUpdatedAt: entity.updatedAt,
      updatedAt: nowIso(),
    } as unknown as AppEntity);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Робочий простір</span>
          <h1>{config.title}</h1>
          <p>{config.description}</p>
        </div>
        <div className="page-heading-actions">
          <ExcelExportMenu
            filteredCount={filtered.length}
            totalCount={items.length}
            onExportFiltered={() => exportEntityRecordsToExcel({
              db,
              collection: config.collection,
              title: config.title,
              projectName,
              records: filtered,
              fields: config.fields,
              scope: "filtered",
              customFieldDefinitions,
            })}
            onExportAll={() => exportEntityRecordsToExcel({
              db,
              collection: config.collection,
              title: config.title,
              projectName,
              records: items,
              fields: config.fields,
              scope: "all",
              customFieldDefinitions,
            })}
          />
          {canCreateRecords && onImportRecords && canImportCollection(config.collection) ? (
            <TableDataImportButton
              collection={config.collection}
              db={db}
              fields={config.fields}
              customFieldDefinitions={customFieldDefinitions}
              onImport={(records) => onImportRecords(config.collection, records)}
            />
          ) : null}
          {canAttemptCreate ? (
            <button className="button button-primary" onClick={startNew}>
              + Додати {config.singular}
            </button>
          ) : null}
        </div>
      </div>

      <section className="panel">
        <div className="filters">
          <label className="search-field">
            <span>Пошук</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={config.searchPlaceholder} />
          </label>
          {config.fields.some((field) => field.type === "research") ? (
            <label>
              <span>Дослідження</span>
              <select value={researchFilter} onChange={(event) => setResearchFilter(event.target.value)}>
                <option value="">Усі дослідження</option>
                {researches.map((research) => (
                  <option key={research.id} value={research.id}>{research.title}</option>
                ))}
              </select>
            </label>
          ) : null}
          {config.collection === "documents" ? (
            <>
              <label>
                <span>Архів</span>
                <select value={archiveFilter} onChange={(event) => setArchiveFilter(event.target.value)}>
                  <option value="">Усі архіви</option>
                  {structuredFilterOptions.archives.map((archive) => (
                    <option key={archive} value={archive}>{archive}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Рік</span>
                <input
                  type="number"
                  value={yearFilter}
                  onChange={(event) => setYearFilter(event.target.value)}
                  placeholder="Будь-який"
                />
              </label>
              <label>
                <span>Тип документа</span>
                <select value={documentTypeFilter} onChange={(event) => setDocumentTypeFilter(event.target.value)}>
                  <option value="">Усі типи</option>
                  {structuredFilterOptions.documentTypes.map((documentType) => (
                    <option key={documentType} value={documentType}>{documentType}</option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {config.collection === "yearMatrix" ? (
            <>
              <label>
                <span>Рік</span>
                <input
                  type="number"
                  value={yearFilter}
                  onChange={(event) => setYearFilter(event.target.value)}
                  placeholder="Будь-який"
                />
              </label>
              <label>
                <span>Населений пункт</span>
                <select value={placeFilter} onChange={(event) => setPlaceFilter(event.target.value)}>
                  <option value="">Усі населені пункти</option>
                  {structuredFilterOptions.places.map((place) => (
                    <option key={place} value={place}>{place}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Тип документа</span>
                <select value={documentTypeFilter} onChange={(event) => setDocumentTypeFilter(event.target.value)}>
                  <option value="">Усі типи</option>
                  {structuredFilterOptions.documentTypes.map((documentType) => (
                    <option key={documentType} value={documentType}>{documentType}</option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {config.statusOptions ? (
            <label>
              <span>Статус</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">Усі статуси</option>
                {config.statusOptions.map((status) => <option key={status}>{status}</option>)}
              </select>
            </label>
          ) : null}
          <div className="result-count">{filtered.length} з {items.length}</div>
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
            <DataTable
              items={pagination.pageItems}
              columns={config.columns}
              documents={documents}
              researches={researches}
              onView={openViewWindow}
              onEdit={openEditWindow}
              onDelete={(entity) => void confirmDelete(entity)}
              onOpenRelated={onOpenRelated}
              onQuickStatus={config.statusKey ? quickStatus : undefined}
              statusOptions={config.statusOptions}
              readOnly={readOnly}
            />
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
            {canAttemptCreate ? (
              <button
                type="button"
                className="empty-mark"
                onClick={startNew}
                aria-label={`Додати ${config.singular}`}
                title={`Додати ${config.singular}`}
              >
                +
              </button>
            ) : null}
            <h2>{hasActiveFilters ? "Нічого не знайдено" : config.emptyText}</h2>
            <p>
              {hasActiveFilters
                ? `Змініть фільтри${readOnly ? "." : ` або додайте ${config.singular}.`}`
                : readOnly
                  ? "У цьому розділі поки немає записів."
                  : `Натисніть плюс, щоб додати ${config.singular}.`}
            </p>
          </div>
        )}
      </section>

    </>
  );
}

function entityWindowKey(window: EntityWindow): string {
  if (window.kind === "new") return window.windowId;
  return `${window.kind}:${window.entityId}`;
}

function crudEntityIdFromWindowKey(logicalKey: string): string | null {
  const [kind, entityId] = logicalKey.split(":");
  return (kind === "view" || kind === "edit") && entityId ? entityId : null;
}

function documentMatchesYear(row: Record<string, unknown>, filter: string): boolean {
  if (!filter) return true;
  const requestedYear = Number(filter);
  const yearFrom = numericYear(row.yearFrom);
  const yearTo = numericYear(row.yearTo);

  if (Number.isFinite(requestedYear)) {
    if (Number.isFinite(yearFrom) && Number.isFinite(yearTo)) {
      return requestedYear >= Math.min(yearFrom, yearTo)
        && requestedYear <= Math.max(yearFrom, yearTo);
    }
    if (Number.isFinite(yearFrom)) return requestedYear === yearFrom;
    if (Number.isFinite(yearTo)) return requestedYear === yearTo;
  }

  const normalizedFilter = filter.trim();
  return String(row.yearFrom ?? "").trim() === normalizedFilter
    || String(row.yearTo ?? "").trim() === normalizedFilter;
}

function numericYear(value: unknown): number {
  const normalized = String(value ?? "").trim();
  return normalized ? Number(normalized) : Number.NaN;
}

function customAttachmentScans(
  values: unknown,
  definitions: CustomFieldDefinition[],
  module: string,
): ScanAttachment[] {
  if (!values || typeof values !== "object" || Array.isArray(values)) return [];
  const attachmentIds = new Set(
    definitions
      .filter((field) => field.module === module && field.type === "attachments")
      .map((field) => field.id),
  );
  return Object.entries(values)
    .filter(([id, value]) => attachmentIds.has(id) && Array.isArray(value))
    .flatMap(([, value]) => value as ScanAttachment[]);
}

function documentScanViewerContext(
  collection: CollectionKey,
  record: Record<string, unknown>,
): DocumentScanViewerContext | undefined {
  if (collection !== "documents") return undefined;
  const id = String(record.id ?? "").trim();
  if (!id) return undefined;
  return {
    source: "documents",
    document: {
      id,
      title: String(record.title ?? "Документ"),
      researchId: String(record.researchId ?? ""),
      documentType: String(record.documentType ?? ""),
      archive: String(record.archive ?? ""),
      fund: String(record.fund ?? ""),
      description: String(record.description ?? ""),
      file: String(record.file ?? ""),
      place: String(record.place ?? ""),
    },
  };
}

function scanDriveFolderPath(
  collection: CollectionKey,
  field: FieldConfig,
  record: Record<string, unknown>,
  persons: Person[],
): string[] | undefined {
  if (field.type !== "scans") return undefined;

  if (collection === "documents") {
    return compactDrivePath(["Документи", ...archiveReferenceFolderPath(record)]);
  }

  if (collection === "archiveRequests") {
    const fileGroup = field.key === "responseScans"
      ? "Відповіді архіву"
      : field.key === "requestScans"
        ? "Запити"
        : "";
    return compactDrivePath([
      "Запити в архів",
      String(record.archive ?? "").trim(),
      shortFolderSegment(record.subject, 90),
      fileGroup,
    ]);
  }

  if (collection === "findings") {
    return compactDrivePath([
      "Знахідки",
      findingPersonFolderName(record, persons),
      String(record.findingType ?? "").trim() || "Без типу",
      ...archiveReferenceFolderPath(record),
    ]);
  }

  return undefined;
}

function labeledFolderSegment(label: string, value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized ? `${label} ${normalized}` : "";
}

function archiveReferenceFolderPath(record: Record<string, unknown>): string[] {
  return [
    String(record.archive ?? "").trim(),
    labeledFolderSegment("Фонд", record.fund),
    labeledFolderSegment("Опис", record.description),
    labeledFolderSegment("Справа", record.file),
  ];
}

function compactDrivePath(segments: string[]): string[] {
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function shortFolderSegment(value: unknown, maxLength: number): string {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}…` : normalized;
}

function findingPersonFolderName(record: Record<string, unknown>, persons: Person[]): string {
  const participants = Array.isArray(record.participants)
    ? record.participants as FindingParticipant[]
    : [];
  const participantName = primaryParticipantName(participants, String(record.findingType ?? ""));
  if (participantName) return participantName;

  const personIds = Array.isArray(record.personIds) ? record.personIds as string[] : [];
  const linkedPerson = persons.find((person) => personIds.includes(person.id));
  if (linkedPerson) return personDisplayName(linkedPerson);

  const rawPersonText = shortFolderSegment(record.personsText ?? record.people, 90);
  return rawPersonText || "Без особи";
}

function personDisplayName(person: Person): string {
  return [
    String(person.surname ?? ""),
    String(person.givenName ?? ""),
    String(person.patronymic ?? ""),
  ].map((part) => part.trim()).filter(Boolean).join(" ") || person.fullName || "Без імені";
}

function requiresArchiveReferenceField(
  collection: CollectionKey,
  field: FieldConfig,
  fields: FieldConfig[],
  form: FormRecord,
): boolean {
  if (collection !== "documents" && collection !== "findings") return false;
  if (!["fund", "description", "file"].includes(field.key)) return false;
  const archiveField = fields.find((item) => item.key === "archive");
  return isKnownUkrainianArchive(String(form.archive ?? ""), archiveField);
}

function isKnownUkrainianArchive(value: string, archiveField?: FieldConfig): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  const options = archiveField?.suggestions ?? archiveField?.options ?? [];
  return options.some((option) => option === normalized && !isFreeArchiveOption(option));
}

function isFreeArchiveOption(value: string): boolean {
  return value.trim().toLocaleLowerCase("uk").startsWith("інший архів");
}

function missingArchiveReferenceLabels(
  collection: CollectionKey,
  fields: FieldConfig[],
  form: FormRecord,
): string[] {
  if (collection !== "documents" && collection !== "findings") return [];
  const archiveField = fields.find((item) => item.key === "archive");
  if (!isKnownUkrainianArchive(String(form.archive ?? ""), archiveField)) return [];
  return fields
    .filter((field) => ["fund", "description", "file"].includes(field.key))
    .filter((field) => !String(form[field.key] ?? "").trim())
    .map((field) => field.label);
}

function EntityDetailsModal({
  config,
  db,
  entity,
  researches,
  documents,
  findings,
  persons,
  customFieldDefinitions,
  onOpenRelated,
  onOpenScanViewer,
  projectId,
  canCreateTasks,
  onCreateTask,
  onClose,
  onEdit,
  stackIndex,
  dockIndex,
  onFocus,
}: {
  config: EntityConfig;
  db: AppDatabase;
  entity: AppEntity;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  customFieldDefinitions: CustomFieldDefinition[];
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  projectId: string;
  canCreateTasks: boolean;
  onCreateTask?: (task: TaskRecord) => void;
  onClose: () => void;
  onEdit?: () => void;
  stackIndex: number;
  dockIndex: number;
  onFocus: () => void;
}) {
  const record = entity as unknown as Record<string, unknown>;
  const customDefinitions = definitionsForModule(customFieldDefinitions, config.collection);
  const geo = config.collection === "findings" ? record.geo as GeoPoint | null | undefined : null;
  const visibleFields = config.fields.filter((field) => {
    const value = record[field.key];
    return value === true || (
      value !== false &&
      value !== null &&
      value !== undefined &&
      (Array.isArray(value) ? value.length > 0 : String(value).trim() !== "")
    );
  });

  return (
    <Modal
      title={getEntityTitle(config, record)}
      onClose={onClose}
      mode="window"
      stackIndex={stackIndex}
      dockIndex={dockIndex}
      onFocus={onFocus}
    >
      <div className="details-body">
        {visibleFields.length || customDefinitions.length || geo?.displayName ? (
          <div className="details-grid">
            {visibleFields.map((field) => (
              <div
                key={field.key}
                className={`detail-item ${field.wide || field.type === "textarea" ? "detail-wide" : ""}`}
              >
                <span>{field.label}</span>
                <DetailValue
                  field={field}
                  value={record[field.key]}
                  findingType={String(record.findingType ?? "")}
                  researches={researches}
                  documents={documents}
                  findings={findings}
                  persons={persons}
                  onOpenRelated={onOpenRelated}
                  onOpenScanViewer={onOpenScanViewer}
                  scanViewerContext={documentScanViewerContext(config.collection, record)}
                />
              </div>
            ))}
            <CustomFieldsView
              db={db}
              definitions={customDefinitions}
              values={normalizeCustomFieldValues(record.customFields)}
            />
            {geo?.displayName ? (
              <div className="detail-item detail-wide">
                <span>Місце на карті</span>
                <div className="detail-text">{geo.displayName}</div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="empty-inline">У цьому записі ще немає заповнених даних.</div>
        )}
        <div className="details-meta">
          <span>Створено: {formatEntityDate(entity.createdAt)}</span>
          <span>Оновлено: {formatEntityDate(entity.updatedAt)}</span>
        </div>
        <div className="details-actions">
          {config.collection === "hypotheses" && projectId ? (
            <HypothesisAiAgent
              hypothesis={entity as Hypothesis}
              db={db}
              canCreateTasks={canCreateTasks}
              onCreateTask={onCreateTask}
            />
          ) : null}
          <button type="button" className="button button-ghost" onClick={onClose}>
            Закрити
          </button>
          {onEdit ? (
            <button type="button" className="button button-primary" onClick={onEdit}>
              Редагувати
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function DetailValue({
  field,
  value,
  findingType,
  researches,
  documents,
  findings,
  persons,
  onOpenRelated,
  onOpenScanViewer,
  scanViewerContext,
}: {
  field: FieldConfig;
  value: unknown;
  findingType?: string;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  scanViewerContext?: DocumentScanViewerContext;
}) {
  if (field.type === "research") {
    const research = researches.find((item) => item.id === value);
    return research ? (
      <RelatedButton onClick={() => onOpenRelated?.("researches", research.id)}>
        {research.title}
      </RelatedButton>
    ) : <strong>Без прив’язки</strong>;
  }
  if (field.type === "checkbox") {
    return <strong>{value ? "Так" : "Ні"}</strong>;
  }
  if (field.type === "document") {
    const document = documents.find((item) => item.id === value);
    return document ? (
      <RelatedButton onClick={() => onOpenRelated?.("documents", document.id)}>
        {documentLabel(document)}
      </RelatedButton>
    ) : <strong>Не вибрано</strong>;
  }
  if (field.type === "documents") {
    const ids = Array.isArray(value) ? value : [];
    return (
      <div className="linked-items">
        {ids.map((id) => {
          const document = documents.find((item) => item.id === id);
          return document ? (
            <RelatedButton key={id} onClick={() => onOpenRelated?.("documents", document.id)}>
              {documentLabel(document)}
            </RelatedButton>
          ) : <span key={id}>Документ недоступний</span>;
        })}
      </div>
    );
  }
  if (field.type === "findings") {
    const ids = Array.isArray(value) ? value : [];
    return (
      <div className="linked-items">
        {ids.map((id) => {
          const finding = findings.find((item) => item.id === id);
          return finding ? (
            <RelatedButton key={id} onClick={() => onOpenRelated?.("findings", finding.id)}>
              {findingLabel(finding)}
            </RelatedButton>
          ) : <span key={id}>Знахідка недоступна</span>;
        })}
      </div>
    );
  }
  if (field.type === "persons") {
    const ids = Array.isArray(value) ? value : [];
    return (
      <div className="linked-items">
        {ids.map((id) => {
          const person = persons.find((item) => item.id === id);
          return person ? (
            <RelatedButton key={id} onClick={() => onOpenRelated?.("persons", person.id)}>
              {personName(person)}
            </RelatedButton>
          ) : <span key={id}>Особа недоступна</span>;
        })}
      </div>
    );
  }
  if (field.type === "scans") {
    const scans = Array.isArray(value) ? value as ScanAttachment[] : [];
    return (
      <ScanAttachmentsView
        scans={scans}
        onPreview={onOpenScanViewer ? (scan, scans) => onOpenScanViewer(scan, scanViewerContext, scans) : undefined}
      />
    );
  }
  if (field.type === "participants") {
    const participants = Array.isArray(value)
      ? sortFindingParticipants(value as FindingParticipant[], findingType ?? "")
      : [];
    return (
      <div className="participant-details">
        {participants.map((participant) => (
          <div key={participant.id}>
            <strong>{participant.role}</strong>
            <span>{participant.name}</span>
            {participant.notes ? <small>{participant.notes}</small> : null}
          </div>
        ))}
      </div>
    );
  }
  if (field.type === "url" && typeof value === "string") {
    const safeHref = sanitizeWebUrl(value);
    return safeHref ? (
      <a href={safeHref} target="_blank" rel="noreferrer noopener">
        Відкрити посилання ↗
      </a>
    ) : (
      <div className="detail-text">{value}</div>
    );
  }
  const text = String(value ?? "");
  const isStatus = field.key === "status" || field.key === "reviewStatus";
  return isStatus ? (
    <span className="status-pill">{text}</span>
  ) : (
    <div className="detail-text">{text}</div>
  );
}

function RelatedButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="related-record-button" onClick={onClick}>
      <span>{children}</span>
      <small>Відкрити →</small>
    </button>
  );
}

function getEntityTitle(config: EntityConfig, record: Record<string, unknown>): string {
  if (Array.isArray(record.participants)) {
    const participantName = primaryParticipantName(
      record.participants as FindingParticipant[],
      String(record.findingType ?? ""),
    );
    if (participantName) return participantName;
  }
  const preferredKeys = ["title", "subject", "people", "year", "personName"];
  const value = preferredKeys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value : `Перегляд: ${config.singular}`;
}

function formatEntityDate(value: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function EntityModal({
  config,
  db,
  entity,
  initialValues,
  researches,
  documents,
  findings,
  persons,
  customFieldDefinitions,
  onAddCustomField,
  onDeleteCustomField,
  canAddCustomField,
  customFieldLimitMessage,
  onSavePerson,
  onSaveRelation,
  onPersist,
  onOpenScanViewer,
  researchRequired,
  onClose,
  onSave,
  stackIndex,
  dockIndex,
  onFocus,
}: {
  config: EntityConfig;
  db: AppDatabase;
  entity: AppEntity | null;
  initialValues?: Record<string, unknown>;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  customFieldDefinitions: CustomFieldDefinition[];
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  canAddCustomField: boolean;
  customFieldLimitMessage?: string;
  onSavePerson?: (person: Person) => void | Promise<Person | null | void>;
  onSaveRelation?: (relation: PersonRelation) => void | Promise<PersonRelation | null | void>;
  onPersist?: (entity: AppEntity) => void | AppEntity | null | Promise<AppEntity | null | void>;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  researchRequired: boolean;
  onClose: () => void;
  onSave: (entity: AppEntity) => void | AppEntity | null | Promise<AppEntity | null | void>;
  stackIndex: number;
  dockIndex: number;
  onFocus: () => void;
}) {
  const initial = (entity ?? initialValues ?? {}) as unknown as FormRecord;
  const [form, setForm] = useState<FormRecord>(() => {
    const defaults: FormRecord = {};
    for (const field of config.fields) {
      defaults[field.key] = initial[field.key] ?? defaultFieldValue(field);
    }
    if (config.collection === "findings") {
      defaults.geo = (initial.geo as GeoPoint | null | undefined) ?? null;
      if (initial.fragmentSelection) {
        defaults.fragmentSelection = initial.fragmentSelection as DocumentFragmentSelection;
      }
    }
    return defaults;
  });
  const [personSeed, setPersonSeed] = useState<PersonSeed | null>(null);
  const [personSeedChoices, setPersonSeedChoices] = useState<PersonSeedChoice[] | null>(null);
  const [locallyCreatedPersons, setLocallyCreatedPersons] = useState<Person[]>([]);
  const [createdFindingPersons, setCreatedFindingPersons] = useState<CreatedFindingPerson[]>([]);
  const [locallyCreatedRelations, setLocallyCreatedRelations] = useState<PersonRelation[]>([]);
  const persistedBaseUpdatedAtRef = useRef<string>(entity?.updatedAt ?? "");
  const availablePersons = useMemo(
    () => mergePersonsById(persons, locallyCreatedPersons),
    [persons, locallyCreatedPersons],
  );
  const customDefinitions = definitionsForModule(customFieldDefinitions, config.collection);
  const [customValues, setCustomValues] = useState<CustomFieldValues>(() =>
    normalizeCustomFieldValues((entity as unknown as { customFields?: unknown } | null)?.customFields),
  );
  const archiveReferenceMissingLabels = missingArchiveReferenceLabels(config.collection, config.fields, form);

  const buildEntityForSave = (sourceForm: FormRecord, timestamp = nowIso()): AppEntity => {
    const findingType = String(sourceForm.findingType ?? "");
    const sourceParticipants = Array.isArray(sourceForm.participants)
      ? sortFindingParticipants(sourceForm.participants as FindingParticipant[], findingType)
      : [];
    return {
      ...(entity ?? {}),
      ...sourceForm,
      ...(config.collection === "findings"
        ? { people: participantSummary(sourceParticipants, findingType), participants: sourceParticipants }
        : {}),
      ...(supportsCustomFields(config.collection) ? { customFields: customValues } : {}),
      id: entity?.id ?? createId(),
      createdAt: entity?.createdAt ?? timestamp,
      __baseUpdatedAt: persistedBaseUpdatedAtRef.current || entity?.updatedAt,
      updatedAt: timestamp,
    } as unknown as AppEntity;
  };

  const persistExistingFindingDraft = async (nextForm: FormRecord) => {
    if (config.collection !== "findings" || !entity || !onPersist) return;
    const timestamp = nowIso();
    const entityToPersist = buildEntityForSave(nextForm, timestamp);
    const saved = await onPersist(entityToPersist);
    if (isEntitySaveResult(saved)) {
      persistedBaseUpdatedAtRef.current = saved.updatedAt;
    } else if (saved !== null) {
      persistedBaseUpdatedAtRef.current = entityToPersist.updatedAt;
    }
  };

  const fieldRequired = (field: FieldConfig) => {
    if (config.collection === "archiveRequests" && field.key === "requestDate") {
      const status = String(form.status ?? "чернетка").trim() || "чернетка";
      return status !== "чернетка";
    }
    if (requiresArchiveReferenceField(config.collection, field, config.fields, form)) {
      return true;
    }
    return Boolean(field.required || (field.type === "research" && researchRequired));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const timestamp = nowIso();
    const participants = Array.isArray(form.participants)
      ? form.participants as FindingParticipant[]
      : [];
    if (
      config.collection === "findings" &&
      !participants.some((participant) => participant.name.trim())
    ) {
      window.alert("Додайте принаймні одну особу, згадану в записі.");
      return;
    }
    if (
      researchRequired &&
      config.fields.some((field) => field.type === "research") &&
      !String(form.researchId ?? "").trim()
    ) {
      window.alert("Оберіть дослідження для цього запису.");
      return;
    }
    const missingRequiredField = config.fields.find((field) => {
      if (!fieldRequired(field)) return false;
      const value = form[field.key];
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === "boolean") return false;
      return !String(value ?? "").trim();
    });
    if (missingRequiredField) {
      window.alert(`Заповніть обов’язкове поле «${missingRequiredField.label}».`);
      return;
    }
    onSave(buildEntityForSave(form, timestamp));
  };

  return (
    <Modal
      title={`${entity ? "Редагувати" : "Додати"} ${config.singular}`}
      onClose={onClose}
      mode="window"
      stackIndex={stackIndex}
      dockIndex={dockIndex}
      onFocus={onFocus}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          {config.fields.map((field) => (
            <FormField
              key={field.key}
              field={field}
              value={form[field.key]}
              researches={researches}
              documents={documents}
              findings={findings}
              persons={availablePersons}
              researchId={String(form.researchId ?? "")}
              researchRequired={researchRequired}
              required={fieldRequired(field)}
              matrixYear={config.collection === "yearMatrix" ? String(form.year ?? "") : ""}
              matrixDocumentType={
                config.collection === "yearMatrix" ? String(form.documentType ?? "") : ""
              }
              findingType={config.collection === "findings" ? String(form.findingType ?? "") : ""}
              scanViewerContext={documentScanViewerContext(config.collection, form)}
              scanDriveFolderPath={scanDriveFolderPath(config.collection, field, form, availablePersons)}
              scanUploadBlockedMessage={
                field.type === "scans" && archiveReferenceMissingLabels.length
                  ? `Перед завантаженням файлу заповніть: ${archiveReferenceMissingLabels.join(", ")}.`
                  : undefined
              }
              onOpenScanViewer={onOpenScanViewer}
              onCreatePerson={() => {
                if (config.collection === "findings") {
                  const choices = personSeedChoicesFromFinding(form);
                  if (choices.length > 1) {
                    setPersonSeedChoices(choices);
                    return;
                  }
                  setPersonSeed(choices[0] ?? createBasicPersonSeed("", String(form.researchId ?? "")));
                  return;
                }
                const seed = config.collection === "tasks"
                  ? String(form.personName ?? "")
                  : String(form.relatedPeople ?? "");
                setPersonSeed(createBasicPersonSeed(seed, String(form.researchId ?? "")));
              }}
              onChange={(value) => setForm((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
          {config.collection === "findings" ? (
            <GeoPlaceField
              label="Місце на карті"
              value={(form.geo as GeoPoint | null) ?? null}
              placeName={String(form.place ?? "")}
              onChange={(geo) => setForm((current) => ({ ...current, geo }))}
              onPlaceNameChange={(place) => setForm((current) => ({ ...current, place }))}
            />
          ) : null}
          <CustomFieldsEditor
            db={db}
            definitions={customDefinitions}
            values={customValues}
            onChange={setCustomValues}
            onDeleteDefinition={onDeleteCustomField ? (definition) => {
              if (!window.confirm(
                `Видалити поле «${definition.label}»? Значення цього поля більше не відображатимуться в записах розділу.`,
              )) return;
              setCustomValues((current) => omitCustomField(current, definition.id));
              onDeleteCustomField(definition);
            } : undefined}
          />
          {supportsCustomFields(config.collection) && onAddCustomField ? (
            <InlineCustomFieldCreator
              module={config.collection}
              db={db}
              definitions={customFieldDefinitions}
              onAdd={onAddCustomField}
              canAdd={canAddCustomField}
              blockedMessage={customFieldLimitMessage}
            />
          ) : null}
        </div>
        {config.collection === "findings" ? (
          <FindingAiIndexingPanel
            finding={{ ...(form as Partial<Finding>), id: entity?.id }}
            documents={documents}
            customValues={customValues}
            onApply={(patch) => {
              setForm((current) => ({ ...current, ...patch.form } as FormRecord));
              setCustomValues(patch.customValues);
            }}
          />
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button type="submit" className="button button-primary">Зберегти</button>
        </div>
      </form>
      {personSeedChoices && onSavePerson ? (
        <Modal
          title="Створити особу зі знахідки"
          onClose={() => setPersonSeedChoices(null)}
          mode="window"
          minimizable={false}
          stackIndex={stackIndex + 20}
          dockIndex={dockIndex}
          onFocus={onFocus}
        >
          <div className="person-seed-choices">
            <p>Оберіть, для кого створити картку особи. Дані зі знахідки будуть перенесені у форму автоматично.</p>
            <div>
              {personSeedChoices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  className="person-seed-choice"
                  onClick={() => {
                    setPersonSeed(choice);
                    setPersonSeedChoices(null);
                  }}
                >
                  <strong>{choice.title}</strong>
                  {choice.description ? <span>{choice.description}</span> : null}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      ) : null}
      {personSeed !== null && onSavePerson ? (
        <PersonFormModal
          key={personSeed.key}
          researches={researches}
          db={db}
          initialFullName={String(personSeed.draft.fullName ?? "")}
          initialResearchId={String(personSeed.draft.researchId ?? form.researchId ?? "")}
          initialPersonDraft={personSeed.draft}
          researchRequired={researchRequired}
          customFieldDefinitions={definitionsForModule(customFieldDefinitions, "persons")}
          onAddCustomField={onAddCustomField}
          onDeleteCustomField={onDeleteCustomField}
          canAddCustomField={canAddCustomField}
          customFieldLimitMessage={customFieldLimitMessage}
          onClose={() => setPersonSeed(null)}
          onSave={async (person) => {
            const savedPerson = await onSavePerson(person);
            if (savedPerson === null) return;
            const linkedPerson = isPersonSaveResult(savedPerson) ? savedPerson : person;
            setLocallyCreatedPersons((current) => mergePersonsById(current, [linkedPerson]));
            if (config.collection === "findings" && personSeed.participantId) {
              const nextCreatedFindingPersons = mergeCreatedFindingPersons(createdFindingPersons, {
                participantId: personSeed.participantId,
                participantRole: personSeed.participantRole ?? "",
                person: linkedPerson,
              });
              setCreatedFindingPersons(nextCreatedFindingPersons);
              if (onSaveRelation) {
                const relations = relationsFromFindingPeople(
                  nextCreatedFindingPersons,
                  [...db.personRelations, ...locallyCreatedRelations],
                  form,
                );
                if (relations.length) {
                  const relationResults = await Promise.all(relations.map((relation) => onSaveRelation(relation)));
                  const savedRelations = relations.filter((_, index) => relationResults[index] !== null);
                  setLocallyCreatedRelations((current) => mergeRelationsByKey(current, savedRelations));
                }
              }
            }
            const selected = Array.isArray(form.personIds) ? form.personIds as string[] : [];
            const nextForm = { ...form, personIds: [...new Set([...selected, linkedPerson.id])] };
            setForm(nextForm);
            await persistExistingFindingDraft(nextForm);
            setPersonSeed(null);
          }}
        />
      ) : null}
    </Modal>
  );
}

function mergePersonsById(primary: Person[], additions: Person[]): Person[] {
  const byId = new Map(primary.map((person) => [person.id, person]));
  for (const person of additions) {
    byId.set(person.id, person);
  }
  return [...byId.values()];
}

function isPersonSaveResult(value: Person | null | void): value is Person {
  return Boolean(value && typeof value === "object" && "id" in value);
}

function isEntitySaveResult(value: AppEntity | null | void): value is AppEntity {
  return Boolean(value && typeof value === "object" && "id" in value && "updatedAt" in value);
}

function mergeCreatedFindingPersons(
  current: CreatedFindingPerson[],
  next: CreatedFindingPerson,
): CreatedFindingPerson[] {
  return [
    next,
    ...current.filter((item) => item.participantId !== next.participantId),
  ];
}

function mergeRelationsByKey(
  current: PersonRelation[],
  additions: PersonRelation[],
): PersonRelation[] {
  const next = [...current];
  for (const relation of additions) {
    if (!next.some((item) => areEquivalentRelations(item, relation))) {
      next.push(relation);
    }
  }
  return next;
}

function relationsFromFindingPeople(
  created: CreatedFindingPerson[],
  existingRelations: PersonRelation[],
  form: FormRecord,
): PersonRelation[] {
  const eventType = personEventTypeFromFinding(String(form.findingType ?? ""));
  const children = created.filter((item) => isChildParticipantRole(item.participantRole, eventType));
  const fathers = created.filter((item) => isBiologicalFatherRole(item.participantRole));
  const mothers = created.filter((item) => isBiologicalMotherRole(item.participantRole));
  const genericParents = created.filter((item) => isGenericParentRole(item.participantRole));
  const stepfathers = created.filter((item) => isStepfatherRole(item.participantRole));
  const stepmothers = created.filter((item) => isStepmotherRole(item.participantRole));
  const godfathers = created.filter((item) => isGodfatherRole(item.participantRole));
  const godmothers = created.filter((item) => isGodmotherRole(item.participantRole));
  const midwives = created.filter((item) => isMidwifeRole(item.participantRole));
  const grooms = eventType === "marriage" ? created.filter((item) => isGroomRole(item.participantRole)) : [];
  const brides = eventType === "marriage" ? created.filter((item) => isBrideRole(item.participantRole)) : [];
  const groomFathers = created.filter((item) => isGroomFatherRole(item.participantRole));
  const groomMothers = created.filter((item) => isGroomMotherRole(item.participantRole));
  const brideFathers = created.filter((item) => isBrideFatherRole(item.participantRole));
  const brideMothers = created.filter((item) => isBrideMotherRole(item.participantRole));
  const deceasedPeople = created.filter((item) => isDeceasedRole(item.participantRole));
  const spouseParticipants = created.filter((item) => isSpouseParticipantRole(item.participantRole));
  const informants = created.filter((item) => isInformantRole(item.participantRole));
  const householdHeads = created.filter((item) => isHouseholdHeadRole(item.participantRole));
  const householdSpouses = created.filter((item) => isHouseholdSpouseRole(item.participantRole));
  const sons = created.filter((item) => isSonRole(item.participantRole));
  const daughters = created.filter((item) => isDaughterRole(item.participantRole));
  const siblings = created.filter((item) => isSiblingRole(item.participantRole));
  const relatives = created.filter((item) => isRelativeRole(item.participantRole));
  const servants = created.filter((item) => isServantRole(item.participantRole));
  const guardians = created.filter((item) => isGuardianRole(item.participantRole));
  const wards = created.filter((item) => isWardRole(item.participantRole));
  const witnesses = created.filter((item) => isWitnessRole(item.participantRole));
  const pledgers = created.filter((item) => isPledgerRole(item.participantRole));
  const priests = created.filter((item) => isPriestRole(item.participantRole));
  const officials = created.filter((item) => isOfficialRole(item.participantRole));
  const timestamp = nowIso();
  const evidenceText = findingRelationEvidenceText(form);
  const notes = "Створено автоматично зі знахідки після створення пов’язаних осіб.";
  const additions: PersonRelation[] = [];

  const add = (
    personId: string,
    relatedPersonId: string,
    relationType: PersonRelationType,
  ) => {
    if (!personId || !relatedPersonId || personId === relatedPersonId) return;
    const relation: PersonRelation = {
      id: createId(),
      personId,
      relatedPersonId,
      relationType,
      status: "доведено",
      evidenceText,
      notes,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (
      existingRelations.some((item) => areEquivalentRelations(item, relation)) ||
      additions.some((item) => areEquivalentRelations(item, relation))
    ) {
      return;
    }
    additions.push(relation);
  };

  const addMany = (
    people: CreatedFindingPerson[],
    relatedPeople: CreatedFindingPerson[],
    relationType: PersonRelationType | ((related: CreatedFindingPerson, person: CreatedFindingPerson) => PersonRelationType),
  ) => {
    for (const person of people) {
      for (const related of relatedPeople) {
        add(
          person.person.id,
          related.person.id,
          typeof relationType === "function" ? relationType(related, person) : relationType,
        );
      }
    }
  };

  const addContextRelations = (mainPeople: CreatedFindingPerson[]) => {
    addMany(mainPeople, witnesses, "свідок");
    addMany(mainPeople, pledgers, "поручитель");
    addMany(mainPeople, priests, (priest) => isExactPriestRole(priest.participantRole) ? "священник" : "духовна особа");
    addMany(mainPeople, officials, "посадова особа");
  };

  for (const child of children) {
    for (const father of fathers) {
      add(child.person.id, father.person.id, "батько");
    }
    for (const mother of mothers) {
      add(child.person.id, mother.person.id, "мати");
    }
    for (const parent of genericParents) {
      add(child.person.id, parent.person.id, "батько або мати");
    }
    for (const stepfather of stepfathers) {
      add(child.person.id, stepfather.person.id, "вітчим");
    }
    for (const stepmother of stepmothers) {
      add(child.person.id, stepmother.person.id, "мачуха");
    }
    for (const godfather of godfathers) {
      add(child.person.id, godfather.person.id, "хрещений");
    }
    for (const godmother of godmothers) {
      add(child.person.id, godmother.person.id, "хрещена");
    }
    addMany([child], midwives, "повитуха");
  }

  if (eventType === "birth" || eventType === "baptism" || eventType === "death" || eventType === "burial") {
    for (const father of fathers) {
      for (const mother of mothers) {
        add(father.person.id, mother.person.id, "дружина");
      }
    }
  }

  for (const groom of grooms) {
    for (const bride of brides) {
      add(groom.person.id, bride.person.id, "дружина");
    }
    addMany([groom], groomFathers, "батько");
    addMany([groom], groomMothers, "мати");
  }

  for (const bride of brides) {
    addMany([bride], brideFathers, "батько");
    addMany([bride], brideMothers, "мати");
  }

  const marriagePeople = [...grooms, ...brides];
  if (marriagePeople.length) {
    addContextRelations(marriagePeople);
  }

  const deathPeople = deceasedPeople.length
    ? deceasedPeople
    : eventType === "death" || eventType === "burial"
      ? primaryCreatedPeopleForRelations(created, eventType)
      : [];
  for (const deceased of deathPeople) {
    addMany([deceased], fathers, "батько");
    addMany([deceased], mothers, "мати");
    addMany([deceased], genericParents, "батько або мати");
    addMany([deceased], spouseParticipants, (spouse) => spouseRelationTypeFromRole(spouse.participantRole));
    addMany([deceased], informants, "особа, яка повідомила");
  }
  if (deathPeople.length) {
    addContextRelations(deathPeople);
  }

  for (const head of householdHeads) {
    addMany([head], householdSpouses, (spouse) => spouseRelationTypeFromRole(spouse.participantRole));
    addMany(sons, [head], "батько або мати");
    addMany(daughters, [head], "батько або мати");
    addMany([head], genericParents, "батько або мати");
    addMany([head], siblings, "брат або сестра");
    addMany([head], relatives, "родич");
    addMany([head], servants, "наймит або служник");
    addMany([head], wards, "підопічний");
    addMany(guardians, [head], "опікун");
  }

  for (const guardian of guardians) {
    addMany(wards, [guardian], "опікун");
  }

  const genericMainPeople = primaryCreatedPeopleForRelations(created, eventType);
  if (genericMainPeople.length && !marriagePeople.length && !deathPeople.length && !householdHeads.length) {
    addMany(genericMainPeople, fathers, "батько");
    addMany(genericMainPeople, mothers, "мати");
    addMany(genericMainPeople, genericParents, "батько або мати");
    addMany(genericMainPeople, spouseParticipants, (spouse) => spouseRelationTypeFromRole(spouse.participantRole));
    addMany(genericMainPeople, siblings, "брат або сестра");
    addMany(genericMainPeople, relatives, "родич");
    addContextRelations(genericMainPeople);
  }

  if (children.length && !marriagePeople.length && !deathPeople.length) {
    addContextRelations(children);
  }

  return additions;
}

function primaryCreatedPeopleForRelations(
  created: CreatedFindingPerson[],
  eventType: PersonEventType | null,
): CreatedFindingPerson[] {
  if (!created.length) return [];
  if (eventType === "birth" || eventType === "baptism") {
    const children = created.filter((item) => isChildParticipantRole(item.participantRole, eventType));
    if (children.length) return children;
  }
  if (eventType === "marriage") {
    const spouses = created.filter((item) => isGroomRole(item.participantRole) || isBrideRole(item.participantRole));
    if (spouses.length) return spouses;
  }
  if (eventType === "death" || eventType === "burial") {
    const deceased = created.filter((item) => isDeceasedRole(item.participantRole));
    if (deceased.length) return deceased;
  }
  const heads = created.filter((item) => isHouseholdHeadRole(item.participantRole));
  if (heads.length) return heads;
  const primary = created.find((item) => !isContextOnlyRole(item.participantRole));
  return primary ? [primary] : [created[0]];
}

function areEquivalentRelations(first: PersonRelation, second: PersonRelation): boolean {
  if (first.personId === second.personId && first.relatedPersonId === second.relatedPersonId) {
    return first.relationType === second.relationType ||
      (isSpouseRelation(first.relationType) && isSpouseRelation(second.relationType)) ||
      (isParentRelation(first.relationType) && isParentRelation(second.relationType)) ||
      (isChildRelation(first.relationType) && isChildRelation(second.relationType)) ||
      (isSiblingRelation(first.relationType) && isSiblingRelation(second.relationType)) ||
      (isGodparentRelation(first.relationType) && isGodparentRelation(second.relationType));
  }
  if (first.personId === second.relatedPersonId && first.relatedPersonId === second.personId) {
    if (isSpouseRelation(first.relationType) && isSpouseRelation(second.relationType)) return true;
    if (isChildRelation(first.relationType) && isParentRelation(second.relationType)) return true;
    if (isChildRelation(second.relationType) && isParentRelation(first.relationType)) return true;
    if (isSiblingRelation(first.relationType) && isSiblingRelation(second.relationType)) return true;
    if (isGodchildRelation(first.relationType) && isGodparentRelation(second.relationType)) return true;
    if (isGodchildRelation(second.relationType) && isGodparentRelation(first.relationType)) return true;
    if (first.relationType === "підопічний" && second.relationType === "опікун") return true;
    if (second.relationType === "підопічний" && first.relationType === "опікун") return true;
    if (first.relationType === "член господарства" && second.relationType === "голова господарства") return true;
    if (second.relationType === "член господарства" && first.relationType === "голова господарства") return true;
  }
  return false;
}

function isParentRelation(value: PersonRelationType): boolean {
  return [
    "батько",
    "мати",
    "батько або мати",
    "вітчим",
    "мачуха",
    "опікун",
    "усиновлювач",
  ].includes(value);
}

function isChildRelation(value: PersonRelationType): boolean {
  return [
    "дитина",
    "син",
    "донька",
    "пасинок",
    "падчерка",
    "підопічний",
    "усиновлена дитина",
  ].includes(value);
}

function isSpouseRelation(value: PersonRelationType): boolean {
  return value === "чоловік" || value === "дружина" || value === "подружжя";
}

function isSiblingRelation(value: PersonRelationType): boolean {
  return value === "брат" || value === "сестра" || value === "брат або сестра";
}

function isGodparentRelation(value: PersonRelationType): boolean {
  return value === "хрещений" || value === "хрещена";
}

function isGodchildRelation(value: PersonRelationType): boolean {
  return value === "хрещеник" || value === "хрещениця";
}

function findingRelationEvidenceText(form: FormRecord): string {
  return [
    String(form.findingType ?? "").trim(),
    String(form.eventDate ?? "").trim(),
    String(form.place ?? "").trim(),
    String(form.archive ?? "").trim(),
    String(form.fund ?? "").trim(),
    String(form.description ?? "").trim(),
    String(form.file ?? "").trim(),
    String(form.page ?? "").trim() ? `арк./стор. ${String(form.page ?? "").trim()}` : "",
  ].filter(Boolean).join(" · ");
}

function omitCustomField(
  values: CustomFieldValues,
  fieldId: string,
): CustomFieldValues {
  const next = { ...values };
  delete next[fieldId];
  return next;
}

function createBasicPersonSeed(rawName: string, researchId: string): PersonSeed {
  const parsed = splitPersonName(rawName);
  return {
    key: `basic:${researchId}:${parsed.fullName}`,
    title: parsed.fullName || "Нова особа",
    draft: {
      researchId,
      ...parsed,
    },
  };
}

function personSeedChoicesFromFinding(form: FormRecord): PersonSeedChoice[] {
  const participants = Array.isArray(form.participants)
    ? sortFindingParticipants(
        form.participants as FindingParticipant[],
        String(form.findingType ?? ""),
      ).filter((participant) => participant.name.trim())
    : [];
  if (participants.length > 1) {
    return participants.map((participant, index) => ({
      ...createPersonSeedFromFinding(form, participant),
      key: `finding-participant:${participant.id || index}`,
      description: [participant.role, participant.notes].filter(Boolean).join(" · "),
    }));
  }
  return [createPersonSeedFromFinding(form, participants[0] ?? null)];
}

function createPersonSeedFromFinding(
  form: FormRecord,
  participant: FindingParticipant | null,
): PersonSeedChoice {
  const participants = Array.isArray(form.participants) ? form.participants as FindingParticipant[] : [];
  const rawName = participant?.name ||
    primaryParticipantName(participants, String(form.findingType ?? "")) ||
    String(form.personsText || form.people || "");
  const parsed = splitPersonName(rawName);
  const researchId = String(form.researchId ?? "");
  const eventType = personEventTypeFromFinding(String(form.findingType ?? ""));
  const eventDate = String(form.eventDate ?? "");
  const place = String(form.place ?? "");
  const scans = Array.isArray(form.scans) ? form.scans as ScanAttachment[] : [];
  const geo = isGeoPoint(form.geo) ? form.geo : null;
  const role = participant?.role ?? "";
  const gender = genderFromParticipantRole(role);
  const childParticipant = isChildParticipantRole(role, eventType);
  const personName = childParticipant && !parsed.givenName && parsed.surname
    ? { ...parsed, surname: "", givenName: parsed.surname }
    : parsed;
  const patronymicFromFather = !personName.patronymic && childParticipant
    ? patronymicFromFatherParticipant(participants, participant, gender, personName.givenName ?? "")
    : "";
  const shouldApplyEvent = shouldApplyFindingEventToPerson(eventType, role);
  const participantFacts = personFactsFromParticipantNotes(participant?.notes ?? "");
  const draft: PersonInitialDraft = {
    researchId,
    ...personName,
    patronymic: personName.patronymic || patronymicFromFather,
    status: "доведена",
    gender,
    ...participantFacts,
    notes: notesFromFinding(form, participant),
  };

  if (!shouldApplyEvent) {
    draft.mentionScans = scans;
  } else if (eventType === "birth" || eventType === "baptism") {
    draft.birthDate = eventDate;
    draft.birthPlace = place;
    draft.birthScans = scans;
  } else if (eventType === "marriage") {
    draft.marriageDate = eventDate;
    draft.marriagePlace = place;
    draft.marriageScans = scans;
  } else if (eventType === "death" || eventType === "burial") {
    draft.deathDate = eventDate;
    draft.deathPlace = place;
    draft.deathScans = scans;
  } else {
    draft.residencePlaces = place;
    draft.mentionScans = scans;
  }

  if (shouldApplyEvent && eventType && geo) {
    draft.events = [personEventFromFinding(eventType, eventDate, place, geo)];
  }

  return {
    key: `finding:${participant?.id ?? personName.fullName}`,
    title: personName.fullName || "Особа зі знахідки",
    description: participant ? [participant.role, participant.notes].filter(Boolean).join(" · ") : "",
    draft,
    participantId: participant?.id,
    participantRole: participant?.role,
  };
}

function genderFromParticipantRole(role: string): PersonGender {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole || isAmbiguousGenderRole(normalizedRole)) return "невідомо";

  if (roleHasAny(normalizedRole, [
    "мати",
    "дружина",
    "жінка",
    "донька",
    "дочка",
    "сестра",
    "наречена",
    "хрещена",
    "повитуха",
    "вдова",
  ])) {
    return "жінка";
  }

  if (roleHasAny(normalizedRole, [
    "батько",
    "чоловік",
    "син",
    "брат",
    "наречений",
    "хрещений",
    "вдівець",
  ])) {
    return "чоловік";
  }

  return "невідомо";
}

function isAmbiguousGenderRole(role: string): boolean {
  return roleHasAny(role, [
    "батько або мати",
    "мати або батько",
    "чоловік або дружина",
    "дружина або чоловік",
    "син або донька",
    "донька або син",
    "брат або сестра",
    "сестра або брат",
  ]);
}

function isChildParticipantRole(role: string, eventType: PersonEventType | null): boolean {
  const normalizedRole = normalizeRole(role);
  if (isGodfatherRole(normalizedRole) || isGodmotherRole(normalizedRole)) return false;
  if (roleHasAny(normalizedRole, [
    "дитина",
    "новонарод",
    "народжен",
    "охрещен",
    "син",
    "донька",
    "дочка",
  ])) {
    return true;
  }
  return !normalizedRole && (eventType === "birth" || eventType === "baptism");
}

function patronymicFromFatherParticipant(
  participants: FindingParticipant[],
  currentParticipant: FindingParticipant | null,
  childGender: PersonGender,
  childGivenName: string,
): string {
  const father = participants.find((candidate) =>
    candidate.id !== currentParticipant?.id &&
    candidate.name.trim() &&
    isBiologicalFatherRole(candidate.role)
  );
  if (!father) return "";

  const fatherGivenName = extractGivenNameForPatronymic(father.name);
  const patronymicGender = genderForPatronymic(childGender, childGivenName);
  if (!fatherGivenName || !patronymicGender) return "";

  return buildUkrainianPatronymic(fatherGivenName, patronymicGender);
}

function isBiologicalFatherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  if (!roleHasAny(normalizedRole, ["батько", "father"])) return false;
  return !roleHasAny(normalizedRole, ["або мати", "мати або", "хрещ", "назван", "прийом", "вітчим", "свід"]);
}

function isBiologicalMotherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  if (!roleHasAny(normalizedRole, ["мати", "mother"])) return false;
  return !roleHasAny(normalizedRole, ["батько або", "або батько", "хрещ", "назван", "прийом", "мачух", "свід"]);
}

function isGroomRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  if (isAmbiguousGenderRole(normalizedRole)) return false;
  return roleStartsWithAny(normalizedRole, ["наречений", "молодий"]) ||
    roleHasAny(normalizedRole, ["чоловік", "groom"]);
}

function isBrideRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  if (isAmbiguousGenderRole(normalizedRole)) return false;
  return roleStartsWithAny(normalizedRole, ["наречена", "молода"]) ||
    roleHasAny(normalizedRole, ["дружина", "bride"]);
}

function isGenericParentRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["батько або мати", "мати або батько", "parent"]);
}

function isGroomFatherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["батько нареченого", "батько молодого", "father of groom"]);
}

function isGroomMotherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["мати нареченого", "мати молодого", "mother of groom"]);
}

function isBrideFatherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["батько нареченої", "батько молодої", "father of bride"]);
}

function isBrideMotherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["мати нареченої", "мати молодої", "mother of bride"]);
}

function isGodfatherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["хрещений", "хресний", "godfather"]) ||
    (roleHasAny(normalizedRole, ["хрещ", "хрес", "god"]) && roleHasAny(normalizedRole, ["батько", "father"]));
}

function isGodmotherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["хрещена", "хресна", "godmother"]) ||
    (roleHasAny(normalizedRole, ["хрещ", "хрес", "god"]) && roleHasAny(normalizedRole, ["мати", "mother"]));
}

function isMidwifeRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["повитуха", "баба-повитуха", "акушерк", "midwife"]);
}

function isDeceasedRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["померла особа", "померлий", "померла", "покійний", "покійна", "похована", "похований", "deceased"]);
}

function isSpouseParticipantRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  if (isGroomRole(normalizedRole) || isBrideRole(normalizedRole)) return false;
  return roleHasAny(normalizedRole, ["чоловік або дружина", "дружина або чоловік", "чоловік", "дружина", "вдівець", "вдова", "подруж"]);
}

function spouseRelationTypeFromRole(role: string): PersonRelationType {
  const normalizedRole = normalizeRole(role);
  if (!isAmbiguousGenderRole(normalizedRole)) {
    if (roleHasAny(normalizedRole, ["чоловік", "вдівець", "husband"])) return "чоловік";
    if (roleHasAny(normalizedRole, ["дружина", "вдова", "wife"])) return "дружина";
  }
  return "подружжя";
}

function isInformantRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["особа, яка повідомила", "повідомила", "повідомив", "інформатор", "informant"]);
}

function isHouseholdHeadRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["голова господарства", "голова двору", "голова родини", "голова сім", "head of household"]);
}

function isHouseholdSpouseRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["чоловік або дружина", "дружина або чоловік", "подруж"]);
}

function isSonRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleStartsWithAny(normalizedRole, ["син"]) || roleHasAny(normalizedRole, [" son"]);
}

function isDaughterRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleStartsWithAny(normalizedRole, ["донька", "дочка"]) || roleHasAny(normalizedRole, ["daughter"]);
}

function isSiblingRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["брат або сестра", "сестра або брат", "брат", "сестра", "sibling"]);
}

function isRelativeRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["інший родич", "родич", "relative"]);
}

function isServantRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["наймит", "служник", "слуга", "робітник", "servant", "worker"]);
}

function isGuardianRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["опікун", "піклувальник", "guardian"]);
}

function isWardRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["підопічний", "підопічна", "ward"]);
}

function isStepfatherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["вітчим", "stepfather"]);
}

function isStepmotherRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["мачуха", "stepmother"]);
}

function isWitnessRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["свідок", "witness"]);
}

function isPledgerRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["поручитель", "поручник", "шафер", "bondsman", "sponsor"]);
}

function isPriestRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["священ", "духовна особа", "духовний", "ієрей", "дяк", "псалом", "priest", "clergy"]);
}

function isExactPriestRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["священ", "ієрей", "priest"]);
}

function isOfficialRole(role: string): boolean {
  const normalizedRole = normalizeRole(role);
  return roleHasAny(normalizedRole, ["посадова особа", "укладач", "реєстратор", "суддя", "командир", "представник", "official", "registrar", "judge"]);
}

function isContextOnlyRole(role: string): boolean {
  return isWitnessRole(role) ||
    isPledgerRole(role) ||
    isPriestRole(role) ||
    isOfficialRole(role) ||
    isMidwifeRole(role) ||
    isInformantRole(role);
}

function extractGivenNameForPatronymic(rawName: string): string {
  const fullName = cleanPersonName(rawName);
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";

  const parsed = splitPersonName(fullName);
  if (parts.length >= 3 && parsed.givenName) return parsed.givenName;

  const first = parts[0];
  const second = parts[1];
  const firstLooksLikeSurname = isLikelySurname(first);
  const secondLooksLikeSurname = isLikelySurname(second);
  if (firstLooksLikeSurname && !secondLooksLikeSurname) return second;
  if (secondLooksLikeSurname && !firstLooksLikeSurname) return first;

  return parsed.givenName || first;
}

function genderForPatronymic(
  gender: PersonGender,
  givenName: string,
): "male" | "female" | null {
  if (gender === "чоловік") return "male";
  if (gender === "жінка") return "female";

  const normalizedName = normalizeNameToken(givenName);
  if (!normalizedName) return null;
  if ([
    "микола",
    "ілля",
    "лука",
    "сава",
    "кузьма",
    "хома",
    "ярема",
    "некита",
    "никита",
  ].includes(normalizedName)) {
    return "male";
  }
  if (normalizedName.endsWith("а") || normalizedName.endsWith("я")) return "female";
  return null;
}

function buildUkrainianPatronymic(
  fatherGivenName: string,
  gender: "male" | "female",
): string {
  const name = titleNameToken(fatherGivenName);
  const normalizedName = normalizeNameToken(name);
  const exceptions: Record<string, { male: string; female: string }> = {
    федір: { male: "Федорович", female: "Федорівна" },
    микола: { male: "Миколайович", female: "Миколаївна" },
    ілля: { male: "Ілліч", female: "Іллівна" },
    сава: { male: "Савич", female: "Савівна" },
    лука: { male: "Лукич", female: "Луківна" },
    кузьма: { male: "Кузьмич", female: "Кузьмівна" },
    хома: { male: "Хомич", female: "Хомівна" },
    лев: { male: "Львович", female: "Львівна" },
    яків: { male: "Якович", female: "Яківна" },
  };
  const exception = exceptions[normalizedName];
  if (exception) return exception[gender];

  if (normalizedName.endsWith("й")) {
    return gender === "male"
      ? `${name}ович`
      : `${name.slice(0, -1)}ївна`;
  }
  if (normalizedName.endsWith("ь")) {
    const base = name.slice(0, -1);
    return gender === "male" ? `${base}ьович` : `${base}івна`;
  }
  if (normalizedName.endsWith("о")) {
    const base = name.slice(0, -1);
    return gender === "male" ? `${base}ович` : `${base}івна`;
  }
  if (normalizedName.endsWith("а") || normalizedName.endsWith("я")) {
    const base = name.slice(0, -1);
    return gender === "male" ? `${base}ич` : `${base}івна`;
  }

  return gender === "male" ? `${name}ович` : `${name}івна`;
}

function personFactsFromParticipantNotes(notes: string): Pick<PersonInitialDraft, "occupation" | "socialStatus" | "religion"> {
  const occupation = normalizeExtractedFact(
    extractParticipantFact(notes, ["заняття", "професія", "професія або заняття", "occupation", "profession"]),
  );
  return {
    occupation,
    socialStatus: normalizeSocialStatus(extractParticipantFact(notes, ["стан", "соціальний статус", "соціальний стан", "status", "social status"])),
    religion: normalizeReligion(extractParticipantFact(notes, ["конфесія", "віросповідання", "віра", "religion", "confession"])),
  };
}

function extractParticipantFact(notes: string, labels: string[]): string {
  const normalizedLabels = labels.map((label) => label.toLocaleLowerCase("uk"));
  const parts = notes.split(/[;\n]/);
  for (const part of parts) {
    const separatorIndex = part.indexOf(":");
    if (separatorIndex < 0) continue;
    const label = part.slice(0, separatorIndex).trim().toLocaleLowerCase("uk");
    const value = part.slice(separatorIndex + 1).trim();
    if (!value) continue;
    if (normalizedLabels.some((candidate) => label === candidate || label.endsWith(` ${candidate}`))) {
      return value;
    }
  }
  return "";
}

function normalizeSocialStatus(value: string): string {
  const raw = normalizeExtractedFact(value);
  const normalized = normalizeFactDictionaryText(raw);
  if (!normalized) return "";

  const rules: Array<{ needles: string[]; value: string }> = [
    { needles: ["кріпак", "кріпос", "крепост", "serf"], value: "кріпацький стан" },
    { needles: ["селя", "кресть", "peasant", "rolnik", "włośc", "wlosc"], value: "селянський стан" },
    { needles: ["міщ", "мещ", "бургер", "mieszcz", "townsman"], value: "міщанський стан" },
    { needles: ["дворян", "шляхт", "noble", "szlach"], value: "дворянський стан" },
    { needles: ["козак", "казак", "cossack"], value: "козацький стан" },
    { needles: ["купец", "купець", "merchant"], value: "купецький стан" },
    { needles: ["духов", "свящ", "священ", "priest", "clergy"], value: "духовний стан" },
    { needles: ["військ", "военн", "солдат", "рядов", "military", "soldier"], value: "військовий стан" },
    { needles: ["однодвор", "однодворец"], value: "однодворці" },
    { needles: ["чинш", "czynsz"], value: "чиншовики" },
    { needles: ["робіт", "рабоч", "worker"], value: "робітничий стан" },
  ];

  return rules.find((rule) => includesAny(normalized, rule.needles))?.value ?? raw;
}

function normalizeReligion(value: string): string {
  const raw = normalizeExtractedFact(value);
  const normalized = normalizeFactDictionaryText(raw);
  if (!normalized) return "";

  const rules: Array<{ needles: string[]; value: string }> = [
    { needles: ["греко катол", "греко-катол", "уніат", "униат", "greek catholic"], value: "греко-католицьке" },
    { needles: ["римсько катол", "римсько-катол", "римо катол", "римо-катол", "rzymskokat", "roman catholic"], value: "римсько-католицьке" },
    { needles: ["православ", "orthodox", "греко рос", "греко-рос"], value: "православне" },
    { needles: ["юдей", "іудей", "иудей", "єврей", "еврей", "mosais", "juda"], value: "юдейське" },
    { needles: ["лютеран", "luther"], value: "лютеранське" },
    { needles: ["євангел", "евангел", "evangel"], value: "євангелічне" },
    { needles: ["мусульм", "магомет", "islam", "muslim"], value: "мусульманське" },
    { needles: ["старообряд", "старовір", "старовер"], value: "старообрядницьке" },
    { needles: ["баптист", "baptist"], value: "баптистське" },
    { needles: ["протест", "protest"], value: "протестантське" },
    { needles: ["вірмено григор", "вірмено-григор", "армяно григ", "armenian"], value: "вірмено-григоріанське" },
    { needles: ["катол", "catholic"], value: "римсько-католицьке" },
  ];

  return rules.find((rule) => includesAny(normalized, rule.needles))?.value ?? raw;
}

function normalizeExtractedFact(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  const comparable = normalizeFactDictionaryText(normalized);
  if (["невідомо", "не відомо", "не вказано", "не зазначено", "немає", "unknown", "not specified", "n/a", "null"].includes(comparable)) {
    return "";
  }
  return normalized;
}

function normalizeFactDictionaryText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("uk")
    .replace(/[.,;:()[\]{}"“”„«»]/g, " ")
    .replace(/\s+/g, " ");
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function shouldApplyFindingEventToPerson(eventType: PersonEventType | null, role: string): boolean {
  if (!eventType || !role.trim()) return true;
  const normalizedRole = normalizeRole(role);

  if (eventType === "birth" || eventType === "baptism") {
    return roleHasAny(normalizedRole, ["дитина", "новонарод", "народжен", "охрещен"]);
  }

  if (eventType === "marriage") {
    return roleStartsWithAny(normalizedRole, ["наречений", "наречена", "молодий", "молода"]);
  }

  if (eventType === "death" || eventType === "burial") {
    return roleHasAny(normalizedRole, ["померл", "покійн", "похован"]);
  }

  return true;
}

function normalizeRole(role: string): string {
  return role
    .trim()
    .toLocaleLowerCase("uk")
    .replace(/\s+/g, " ");
}

function roleHasAny(role: string, needles: string[]): boolean {
  return needles.some((needle) => role.includes(needle));
}

function roleStartsWithAny(role: string, needles: string[]): boolean {
  return needles.some((needle) => role.startsWith(needle));
}

function splitPersonName(rawName: string): Pick<PersonInitialDraft, "fullName" | "surname" | "givenName" | "patronymic"> {
  const fullName = cleanPersonName(rawName);
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    const patronymicIndex = parts.findIndex(isLikelyPatronymic);
    if (patronymicIndex === 1) {
      return {
        fullName,
        surname: parts.slice(2).join(" "),
        givenName: parts[0],
        patronymic: parts[1],
      };
    }
    if (patronymicIndex > 1) {
      return {
        fullName,
        surname: parts.slice(0, patronymicIndex - 1).join(" ") || parts[0],
        givenName: parts[patronymicIndex - 1],
        patronymic: parts.slice(patronymicIndex).join(" "),
      };
    }
    return {
      fullName,
      surname: parts[0],
      givenName: parts[1],
      patronymic: parts.slice(2).join(" "),
    };
  }
  if (parts.length === 2) {
    if (isLikelyPatronymic(parts[1])) {
      return {
        fullName,
        surname: "",
        givenName: parts[0],
        patronymic: parts[1],
      };
    }
    if (isLikelySurname(parts[1]) && !isLikelySurname(parts[0])) {
      return {
        fullName,
        surname: parts[1],
        givenName: parts[0],
        patronymic: "",
      };
    }
    return {
      fullName,
      surname: parts[0],
      givenName: parts[1],
      patronymic: "",
    };
  }
  return {
    fullName,
    surname: parts[0] ?? "",
    givenName: "",
    patronymic: "",
  };
}

function isLikelyPatronymic(value: string): boolean {
  const normalized = normalizeNameToken(value);
  return [
    "ович",
    "евич",
    "євич",
    "івич",
    "ївич",
    "ич",
    "овна",
    "евна",
    "євна",
    "івна",
    "ївна",
    "ична",
  ].some((suffix) => normalized.endsWith(suffix));
}

function isLikelySurname(value: string): boolean {
  const normalized = normalizeNameToken(value);
  return [
    "енко",
    "єнко",
    "чук",
    "щук",
    "юк",
    "ук",
    "як",
    "ак",
    "ко",
    "ський",
    "цький",
    "зький",
    "ська",
    "цька",
    "зька",
    "ов",
    "ев",
    "єв",
    "ін",
    "їн",
  ].some((suffix) => normalized.endsWith(suffix));
}

function normalizeNameToken(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("uk")
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
}

function titleNameToken(value: string): string {
  return value
    .trim()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .split("-")
    .map((part) => part ? `${part[0].toLocaleUpperCase("uk")}${part.slice(1).toLocaleLowerCase("uk")}` : "")
    .filter(Boolean)
    .join("-");
}

function cleanPersonName(rawName: string): string {
  const firstChunk = rawName.split(";").find((part) => part.trim()) ?? rawName;
  const withoutRole = firstChunk.includes(":") ? firstChunk.split(":").slice(1).join(":") : firstChunk;
  return withoutRole.replace(/\s+/g, " ").trim();
}

function personEventTypeFromFinding(findingType: string): PersonEventType | null {
  const normalized = findingType.trim().toLocaleLowerCase("uk");
  if (!normalized) return null;
  if (normalized.includes("народ") || normalized.includes("хрещ") || normalized.includes("birth") || normalized.includes("bapt")) return "birth";
  if (normalized.includes("шлюб") || normalized.includes("marriage")) return "marriage";
  if (normalized.includes("смерт") || normalized.includes("помер") || normalized.includes("death")) return "death";
  if (normalized.includes("похов") || normalized.includes("burial")) return "burial";
  if (
    normalized.includes("посім") ||
    normalized.includes("сповід") ||
    normalized.includes("ревіз") ||
    normalized.includes("перепис") ||
    normalized.includes("інвентар") ||
    normalized.includes("згад")
  ) {
    return "residence";
  }
  return "other";
}

function personEventFromFinding(
  type: PersonEventType,
  eventDate: string,
  place: string,
  geo: GeoPoint,
): PersonEvent {
  return {
    id: type,
    personId: "draft",
    type,
    date: eventDate || null,
    placeName: place || geo.displayName || null,
    geo,
    notes: null,
  };
}

function notesFromFinding(form: FormRecord, participant: FindingParticipant | null): string {
  const sourceParts = [
    fieldLine("Архів", form.archive),
    fieldLine("Фонд", form.fund),
    fieldLine("Опис", form.description),
    fieldLine("Справа", form.file),
    fieldLine("Аркуш/сторінка", form.page),
  ].filter(Boolean);
  return [
    "Створено зі знахідки.",
    fieldLine("Тип знахідки", form.findingType),
    participant ? fieldLine("Учасник запису", [participant.role, participant.name].filter(Boolean).join(": ")) : "",
    participant?.notes ? fieldLine("Нотатки учасника", participant.notes) : "",
    fieldLine("Дата події", form.eventDate),
    fieldLine("Місце", form.place),
    sourceParts.length ? `Джерело: ${sourceParts.join(", ")}.` : "",
    fieldLine("Короткий зміст", form.summary),
    fieldLine("Нотатки знахідки", form.notes),
  ].filter(Boolean).join("\n");
}

function fieldLine(label: string, value: unknown): string {
  const text = String(value ?? "").trim();
  return text ? `${label}: ${text}` : "";
}

function isGeoPoint(value: unknown): value is GeoPoint {
  return Boolean(value && typeof value === "object" && "latitude" in value && "longitude" in value);
}

function FormField({
  field,
  value,
  researches,
  documents,
  findings,
  persons,
  researchId,
  researchRequired,
  required,
  matrixYear,
  matrixDocumentType,
  findingType,
  scanViewerContext,
  scanDriveFolderPath,
  scanUploadBlockedMessage,
  onCreatePerson,
  onOpenScanViewer,
  onChange,
}: {
  field: FieldConfig;
  value: FormValue;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  researchId: string;
  researchRequired: boolean;
  required: boolean;
  matrixYear: string;
  matrixDocumentType: string;
  findingType: string;
  scanViewerContext?: DocumentScanViewerContext;
  scanDriveFolderPath?: string[];
  scanUploadBlockedMessage?: string;
  onCreatePerson: () => void;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  onChange: (value: FormValue) => void;
}) {
  const suggestionsId = useId();

  if (field.type === "checkbox") {
    return (
      <label className={`checkbox-field ${field.wide ? "field-wide" : ""}`}>
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.type === "participants") {
    const participants = Array.isArray(value) ? value as FindingParticipant[] : [];
    return (
      <ParticipantsEditor
        participants={participants}
        findingType={findingType}
        required={required}
        onChange={onChange}
      />
    );
  }
  if (field.type === "scans") {
    const scans = Array.isArray(value) ? value as ScanAttachment[] : [];
    return (
      <ScanAttachmentsEditor
        title={field.label}
        description={field.attachmentDescription}
        accept={field.attachmentAccept}
        maxFiles={field.maxFiles}
        limitMessage={field.attachmentLimitMessage}
        policy={field.attachmentPolicy}
        driveFolderPath={scanDriveFolderPath}
        uploadBlockedMessage={scanUploadBlockedMessage}
        scans={scans}
        onChange={onChange}
        onPreview={onOpenScanViewer ? (scan, scans) => onOpenScanViewer(scan, scanViewerContext, scans) : undefined}
      />
    );
  }
  if (field.type === "persons") {
    const selected = Array.isArray(value) ? value as string[] : [];
    return (
      <PersonSelector
        persons={persons}
        selectedIds={selected}
        researchId={researchId}
        createLabel={field.key === "personIds" && findingType ? "Створити особу зі знахідки" : "Створити нову особу"}
        onChange={onChange}
        onCreate={onCreatePerson}
      />
    );
  }
  const availableDocuments = documents.filter((item) => {
    const matchesResearch = !researchId || !item.researchId || item.researchId === researchId;
    const matchesYear = !matrixYear || documentCoversYear(item, Number(matrixYear));
    const matchesType =
      !matrixDocumentType ||
      !item.documentType ||
      normalizeDocumentType(item.documentType) === normalizeDocumentType(matrixDocumentType);
    return matchesResearch && matchesYear && matchesType;
  });
  const availableFindings = findings.filter(
    (item) => !researchId || !item.researchId || item.researchId === researchId,
  );
  if (field.type === "documents" || field.type === "findings") {
    const selected = Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value as string[]
      : [];
    const options =
      field.type === "documents"
        ? availableDocuments.map((item) => ({ id: item.id, label: documentLabel(item) }))
        : availableFindings.map((item) => ({ id: item.id, label: findingLabel(item) }));
    return (
      <RelationSelector
        label={field.label}
        addLabel={field.type === "documents" ? "Додати документ" : "Додати знахідку"}
        searchPlaceholder={field.type === "documents" ? "Пошук документа…" : "Пошук знахідки…"}
        emptyLabel={field.type === "documents" ? "Пов’язаних документів не вибрано." : "Пов’язаних знахідок не вибрано."}
        noOptionsLabel={`Спочатку додайте ${field.type === "documents" ? "документи" : "знахідки"} до цього дослідження.`}
        options={options}
        selectedIds={selected}
        wide={field.wide}
        onChange={onChange}
      />
    );
  }
  const common = {
    value: Array.isArray(value) ? "" : String(value ?? ""),
    required,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(event.target.value),
  };
  const suggestions = field.suggestions ?? [];
  return (
    <label className={field.wide ? "field-wide" : ""}>
      <span>{field.label}{common.required ? " *" : ""}</span>
      {field.type === "textarea" ? (
        <textarea {...common} rows={4} />
      ) : field.type === "select" ? (
        <select {...common}>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
      ) : field.type === "research" ? (
        <select {...common}>
          <option value="">{researchRequired ? "Оберіть дослідження" : "Без прив’язки"}</option>
          {researches.map((research) => <option key={research.id} value={research.id}>{research.title}</option>)}
        </select>
      ) : field.type === "document" ? (
        <select {...common}>
          <option value="">Без пов’язаного документа</option>
          {availableDocuments.map((document) => (
            <option key={document.id} value={document.id}>{documentLabel(document)}</option>
          ))}
        </select>
      ) : (
        <>
          <input
            {...common}
            type={field.type ?? "text"}
            list={suggestions.length ? suggestionsId : undefined}
          />
          {suggestions.length ? (
            <datalist id={suggestionsId}>
              {suggestions.map((option) => <option key={option} value={option} />)}
            </datalist>
          ) : null}
        </>
      )}
    </label>
  );
}

function RelationSelector({
  label,
  addLabel,
  searchPlaceholder,
  emptyLabel,
  noOptionsLabel,
  options,
  selectedIds,
  wide,
  onChange,
}: {
  label: string;
  addLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  noOptionsLabel: string;
  options: Array<{ id: string; label: string }>;
  selectedIds: string[];
  wide?: boolean;
  onChange: (value: FormValue) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("uk");
  const filteredOptions = options.filter((option) =>
    !normalizedQuery || option.label.toLocaleLowerCase("uk").includes(normalizedQuery)
  );
  const selectedOptions = selectedIds.map((id) => ({
    id,
    label: options.find((option) => option.id === id)?.label ?? "Запис недоступний",
  }));

  return (
    <fieldset className={`relation-picker ${wide ? "field-wide" : ""}`}>
      <div className="person-selector-heading">
        <legend>{label}</legend>
        <button
          type="button"
          className="button button-secondary relation-add-button"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Закрити вибір" : `+ ${addLabel}`}
        </button>
      </div>
      {selectedOptions.length ? (
        <div className="selected-relations">
          {selectedOptions.map((option) => (
            <div key={option.id}>
              <span><strong>{option.label}</strong></span>
              <button
                type="button"
                aria-label="Прибрати зв’язок"
                title="Прибрати зв’язок"
                onClick={() => onChange(selectedIds.filter((id) => id !== option.id))}
              >×</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="relation-empty-hint">{emptyLabel}</p>
      )}
      {expanded ? (
        <div className="relation-chooser">
          <input
            autoFocus
            value={query}
            placeholder={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
          {options.length ? (
            filteredOptions.length ? (
              <div className="relation-options">
                {filteredOptions.map((option) => (
                  <label key={option.id}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(option.id)}
                      onChange={(event) =>
                        onChange(
                          event.target.checked
                            ? [...selectedIds, option.id]
                            : selectedIds.filter((id) => id !== option.id),
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            ) : <p>За цим запитом нічого не знайдено.</p>
          ) : <p>{noOptionsLabel}</p>}
        </div>
      ) : null}
    </fieldset>
  );
}

function defaultFieldValue(field: FieldConfig): FormValue {
  if (field.type === "checkbox") return false;
  if (
    field.type === "documents" ||
    field.type === "findings" ||
    field.type === "participants" ||
    field.type === "persons" ||
    field.type === "scans"
  ) return [];
  if (field.type === "select") return field.options?.[0] ?? "";
  return "";
}

function documentLabel(document: DocumentRecord): string {
  const details = [
    document.documentType,
    documentPeriod(document),
    document.place,
  ].filter(Boolean).join(" · ");
  return details ? `${document.title} — ${details}` : document.title;
}

function documentPeriod(document: DocumentRecord): string {
  const from = document.yearFrom.trim();
  const to = document.yearTo.trim();
  if (from && to && from !== to) return `${from}–${to}`;
  if (from || to) return from || to;
  return "рік не вказано";
}

function documentCoversYear(document: DocumentRecord, year: number): boolean {
  if (!Number.isFinite(year)) return true;
  const from = Number(document.yearFrom);
  const to = Number(document.yearTo);
  const hasFrom = Number.isFinite(from) && document.yearFrom.trim() !== "";
  const hasTo = Number.isFinite(to) && document.yearTo.trim() !== "";
  if (!hasFrom && !hasTo) return true;
  if (hasFrom && year < from) return false;
  if (hasTo && year > to) return false;
  return true;
}

function normalizeDocumentType(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("uk");
  const aliases: Record<string, string> = {
    "метрична книга": "народження",
    "народження": "народження",
    "шлюб": "шлюби",
    "шлюби": "шлюби",
    "смерть": "смерті",
    "смерті": "смерті",
    "сповідний розпис": "сповідки",
    "сповідки": "сповідки",
    "ревізія": "ревізії",
    "ревізії": "ревізії",
    "інвентар": "інвентарі",
    "інвентарі": "інвентарі",
  };
  return aliases[normalized] ?? normalized;
}

function findingLabel(finding: Finding): string {
  const title = primaryParticipantName(finding.participants, finding.findingType) ||
    finding.people ||
    finding.summary ||
    "Знахідка";
  const details = [finding.findingType, finding.eventDate, finding.place].filter(Boolean).join(" · ");
  return details ? `${title} — ${details}` : title;
}

function personName(person: Person): string {
  return person.fullName ||
    [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") ||
    "Особа без імені";
}

function ParticipantsEditor({
  participants,
  findingType,
  required,
  onChange,
}: {
  participants: FindingParticipant[];
  findingType: string;
  required?: boolean;
  onChange: (value: FormValue) => void;
}) {
  const roles = participantRoles(findingType);
  const addParticipant = () => {
    onChange([
      ...participants,
      {
        id: createId(),
        role: roles[0] ?? "Інша особа",
        name: "",
        notes: "",
      },
    ]);
  };
  const updateParticipant = (id: string, patch: Partial<FindingParticipant>) => {
    onChange(participants.map((participant) =>
      participant.id === id ? { ...participant, ...patch } : participant,
    ));
  };
  const removeParticipant = (id: string) => {
    onChange(participants.filter((participant) => participant.id !== id));
  };

  return (
    <fieldset className="participants-editor field-wide">
      <div className="participants-heading">
        <div>
          <legend>Учасники запису{required ? " *" : ""}</legend>
          <p>Додайте всіх осіб, згаданих у джерелі, та вкажіть їхню роль.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={addParticipant}>
          + Додати особу
        </button>
      </div>
      {participants.length ? (
        <div className="participant-list">
          {participants.map((participant, index) => {
            const availableRoles = participant.role && !roles.includes(participant.role)
              ? [...roles, participant.role]
              : roles;
            return (
              <div className="participant-row" key={participant.id}>
                <span className="participant-number">{index + 1}</span>
                <label>
                  <span>Роль</span>
                  <select
                    value={participant.role}
                    onChange={(event) => updateParticipant(participant.id, { role: event.target.value })}
                  >
                    {availableRoles.map((role) => <option key={role}>{role}</option>)}
                  </select>
                </label>
                <label>
                  <span>ПІБ або ім’я</span>
                  <input
                    value={participant.name}
                    required={required && index === 0}
                    placeholder="Як записано у джерелі"
                    onChange={(event) => updateParticipant(participant.id, { name: event.target.value })}
                  />
                </label>
                <label className="participant-notes">
                  <span>Уточнення</span>
                  <input
                    value={participant.notes}
                    placeholder="Вік, стан, спорідненість, місце проживання…"
                    onChange={(event) => updateParticipant(participant.id, { notes: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button danger participant-remove"
                  onClick={() => removeParticipant(participant.id)}
                  title="Видалити особу"
                  aria-label="Видалити особу"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <button type="button" className="participant-empty" onClick={addParticipant}>
          Ще немає учасників. Натисніть, щоб додати першу особу.
        </button>
      )}
    </fieldset>
  );
}

function searchableValue(value: unknown): string {
  if (typeof value === "string") return value.toLocaleLowerCase("uk");
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLocaleLowerCase("uk");
  }
  if (Array.isArray(value)) {
    return value.map(searchableValue).join(" ");
  }
  if (value && typeof value === "object") {
    return Object.values(value).map(searchableValue).join(" ");
  }
  return "";
}
