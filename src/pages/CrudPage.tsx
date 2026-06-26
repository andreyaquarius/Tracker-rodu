import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  AppEntity,
  AppDatabase,
  CollectionKey,
  CustomFieldDefinition,
  CustomFieldValues,
  DocumentRecord,
  Finding,
  FindingParticipant,
  GeoPoint,
  Hypothesis,
  Person,
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
} from "../utils/findingParticipants";
import { PersonSelector } from "../components/PersonSelector";
import { PersonFormModal } from "../components/PersonFormModal";
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
  onSavePerson?: (person: Person) => void;
  onSave: (entity: AppEntity) => void;
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

type FormValue = string | boolean | string[] | FindingParticipant[] | ScanAttachment[] | GeoPoint | null;
type FormRecord = Record<string, FormValue>;
type EntityWindow =
  | { windowId: string; kind: "view"; entityId: string }
  | { windowId: string; kind: "edit"; entityId: string }
  | { windowId: string; kind: "new"; initialValues?: Record<string, unknown> };

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
    const participants = Array.isArray(value) ? value as FindingParticipant[] : [];
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
    const participantName = primaryParticipantName(record.participants as FindingParticipant[]);
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
  onSavePerson?: (person: Person) => void;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  researchRequired: boolean;
  onClose: () => void;
  onSave: (entity: AppEntity) => void;
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
    }
    return defaults;
  });
  const [personSeed, setPersonSeed] = useState<string | null>(null);
  const customDefinitions = definitionsForModule(customFieldDefinitions, config.collection);
  const [customValues, setCustomValues] = useState<CustomFieldValues>(() =>
    normalizeCustomFieldValues((entity as unknown as { customFields?: unknown } | null)?.customFields),
  );

  const fieldRequired = (field: FieldConfig) => {
    if (config.collection === "archiveRequests" && field.key === "requestDate") {
      const status = String(form.status ?? "чернетка").trim() || "чернетка";
      return status !== "чернетка";
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
    onSave({
      ...(entity ?? {}),
      ...form,
      ...(config.collection === "findings"
        ? { people: participantSummary(participants), participants }
        : {}),
      ...(supportsCustomFields(config.collection) ? { customFields: customValues } : {}),
      id: entity?.id ?? createId(),
      createdAt: entity?.createdAt ?? timestamp,
      __baseUpdatedAt: entity?.updatedAt,
      updatedAt: timestamp,
    } as unknown as AppEntity);
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
              persons={persons}
              researchId={String(form.researchId ?? "")}
              researchRequired={researchRequired}
              required={fieldRequired(field)}
              matrixYear={config.collection === "yearMatrix" ? String(form.year ?? "") : ""}
              matrixDocumentType={
                config.collection === "yearMatrix" ? String(form.documentType ?? "") : ""
              }
              findingType={config.collection === "findings" ? String(form.findingType ?? "") : ""}
              scanViewerContext={documentScanViewerContext(config.collection, form)}
              onOpenScanViewer={onOpenScanViewer}
              onCreatePerson={() => {
                const seed = config.collection === "findings"
                  ? String(form.personsText || participantSummary(
                      Array.isArray(form.participants) ? form.participants as FindingParticipant[] : [],
                    ))
                  : config.collection === "tasks"
                    ? String(form.personName ?? "")
                    : String(form.relatedPeople ?? "");
                setPersonSeed(seed);
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
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button type="submit" className="button button-primary">Зберегти</button>
        </div>
      </form>
      {personSeed !== null && onSavePerson ? (
        <PersonFormModal
          researches={researches}
          db={db}
          initialFullName={personSeed}
          initialResearchId={String(form.researchId ?? "")}
          researchRequired={researchRequired}
          customFieldDefinitions={definitionsForModule(customFieldDefinitions, "persons")}
          onAddCustomField={onAddCustomField}
          onDeleteCustomField={onDeleteCustomField}
          canAddCustomField={canAddCustomField}
          customFieldLimitMessage={customFieldLimitMessage}
          onClose={() => setPersonSeed(null)}
          onSave={(person) => {
            onSavePerson(person);
            const selected = Array.isArray(form.personIds) ? form.personIds as string[] : [];
            setForm((current) => ({ ...current, personIds: [...new Set([...selected, person.id])] }));
            setPersonSeed(null);
          }}
        />
      ) : null}
    </Modal>
  );
}

function omitCustomField(
  values: CustomFieldValues,
  fieldId: string,
): CustomFieldValues {
  const next = { ...values };
  delete next[fieldId];
  return next;
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
  onCreatePerson: () => void;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  onChange: (value: FormValue) => void;
}) {
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
        <input {...common} type={field.type ?? "text"} />
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
  const title = primaryParticipantName(finding.participants) || finding.people || finding.summary || "Знахідка";
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
