import { useMemo } from "react";
import { PersonFormModal } from "../components/PersonFormModal";
import { useWorkspaceWindows } from "../components/WorkspaceWindows";
import type { PageKey } from "../components/Sidebar";
import type { DocumentScanViewerContext } from "../components/DocumentWorkspaceViewer";
import type {
  AppDatabase,
  AppEntity,
  ArchiveRequest,
  CustomFieldDefinition,
  DocumentRecord,
  Finding,
  Hypothesis,
  Person,
  PersonRelation,
  Research,
  ScanAttachment,
  TaskRecord,
} from "../types";
import { EntityDetailsModal, EntityModal } from "../pages/CrudPage";
import { configs } from "../pages/entityConfigs";
import { PersonCardModal } from "../pages/PersonsPage";

const relatedEntityPages = [
  "researches",
  "documents",
  "archiveRequests",
  "tasks",
  "findings",
  "hypotheses",
] as const;

type RelatedEntityPageKey = (typeof relatedEntityPages)[number];

function isRelatedEntityPage(page: PageKey): page is RelatedEntityPageKey {
  return relatedEntityPages.includes(page as RelatedEntityPageKey);
}

export interface FamilyTreeRecordWindowOptions {
  projectId?: string;
  db?: AppDatabase;
  persons?: Person[];
  relations?: PersonRelation[];
  researches?: Research[];
  documents?: DocumentRecord[];
  findings?: Finding[];
  tasks?: TaskRecord[];
  hypotheses?: Hypothesis[];
  archiveRequests?: ArchiveRequest[];
  customFieldDefinitions?: CustomFieldDefinition[];
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  canAddCustomField?: boolean;
  customFieldLimitMessage?: string;
  onSavePerson?: (person: Person) => void | Promise<Person | null | void>;
  onSaveEntity?: (
    collection: RelatedEntityPageKey,
    entity: AppEntity,
  ) => void | AppEntity | null | Promise<AppEntity | null | void>;
  onSaveRelation?: (
    relation: PersonRelation,
  ) => void | Promise<PersonRelation | null | void>;
  onDeleteRelation?: (id: string) => void;
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onCreateRelated?: (
    page: PageKey,
    initialValues: Record<string, unknown>,
  ) => void;
  onOpenScanViewer?: (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => void;
  canCreateRelated?: (page: RelatedEntityPageKey) => boolean;
  readOnly?: boolean;
  canCreate?: boolean;
  researchRequired?: boolean;
  onOpenPerson?: (personId: string) => void;
  allowNavigationFallback?: boolean;
}

/** Opens person cards and every record linked from their tabs above the tree. */
export function useFamilyTreeRecordWindows({
  projectId,
  db,
  persons = [],
  relations = [],
  researches = [],
  documents = [],
  findings = [],
  tasks = [],
  hypotheses = [],
  archiveRequests = [],
  customFieldDefinitions = [],
  onAddCustomField,
  onDeleteCustomField,
  canAddCustomField = true,
  customFieldLimitMessage,
  onSavePerson,
  onSaveEntity,
  onSaveRelation,
  onDeleteRelation,
  onOpenRelated,
  onCreateRelated,
  onOpenScanViewer,
  canCreateRelated,
  readOnly = false,
  canCreate = true,
  researchRequired = false,
  onOpenPerson,
  allowNavigationFallback = true,
}: FamilyTreeRecordWindowOptions) {
  const { openWindow: openWorkspaceWindow } = useWorkspaceWindows();
  const personCustomFieldDefinitions = useMemo(
    () => customFieldDefinitions.filter((field) => field.module === "persons"),
    [customFieldDefinitions],
  );
  const canCreateLinkedRecords = !readOnly && (
    canCreate ||
    relatedEntityPages.some((page) => canCreateRelated?.(page) ?? canCreate)
  );

  function navigationFallback(action: (() => void) | undefined): void {
    if (allowNavigationFallback) action?.();
  }

  function openPersonCardWindow(personId: string): void {
    const person = persons.find((item) => item.id === personId);
    if (
      !db ||
      !person ||
      !onSaveRelation ||
      !onDeleteRelation ||
      !onOpenRelated ||
      !onCreateRelated
    ) {
      navigationFallback(() => onOpenPerson?.(personId));
      return;
    }

    openWorkspaceWindow({
      ownerKey: "persons",
      logicalKey: `view:${person.id}`,
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <PersonCardModal
          db={db}
          person={person}
          persons={persons}
          researches={researches}
          customFieldDefinitions={personCustomFieldDefinitions}
          relations={relations}
          findings={findings}
          tasks={tasks}
          hypotheses={hypotheses}
          archiveRequests={archiveRequests}
          onClose={close}
          onEdit={
            !readOnly && onSavePerson
              ? () => openPersonEditWindow(person)
              : undefined
          }
          onSaveRelation={(relation) => {
            void onSaveRelation(relation);
          }}
          onDeleteRelation={onDeleteRelation}
          onOpenRelated={openRelatedRecordWindow}
          onCreateRelated={openRelatedCreateWindow}
          readOnly={readOnly}
          canCreate={canCreateLinkedRecords}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  }

  function openPersonEditWindow(person: Person): void {
    if (!db || !onSavePerson) {
      navigationFallback(() => onOpenPerson?.(person.id));
      return;
    }
    openWorkspaceWindow({
      ownerKey: "familyTree:persons",
      logicalKey: `edit:${person.id}`,
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <PersonFormModal
          db={db}
          person={person}
          researches={researches}
          researchRequired={researchRequired}
          customFieldDefinitions={personCustomFieldDefinitions}
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
  }

  function openRelatedRecordWindow(page: PageKey, entityId: string): void {
    if (page === "persons") {
      openPersonCardWindow(entityId);
      return;
    }
    if (!isRelatedEntityPage(page) || !db || !onSaveEntity) {
      navigationFallback(() => onOpenRelated?.(page, entityId));
      return;
    }
    const entity = (db[page] as AppEntity[]).find((item) => item.id === entityId);
    if (!entity) {
      navigationFallback(() => onOpenRelated?.(page, entityId));
      return;
    }
    openWorkspaceWindow({
      ownerKey: `familyTree:${page}`,
      logicalKey: `view:${entity.id}`,
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <EntityDetailsModal
          config={configs[page]}
          db={db}
          entity={entity}
          researches={researches}
          documents={documents}
          findings={findings}
          persons={persons}
          customFieldDefinitions={customFieldDefinitions}
          onOpenRelated={openRelatedRecordWindow}
          onOpenScanViewer={onOpenScanViewer}
          projectId={projectId ?? ""}
          canCreateTasks={!readOnly && (canCreateRelated?.("tasks") ?? canCreate)}
          onCreateTask={(task) => {
            onSaveEntity("tasks", task as unknown as AppEntity);
          }}
          onClose={close}
          onEdit={readOnly ? undefined : () => openRelatedEditWindow(page, entity)}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  }

  function openRelatedEditWindow(
    page: RelatedEntityPageKey,
    entity: AppEntity,
  ): void {
    if (!db || !onSaveEntity) {
      navigationFallback(() => onOpenRelated?.(page, entity.id));
      return;
    }
    openWorkspaceWindow({
      ownerKey: `familyTree:${page}`,
      logicalKey: `edit:${entity.id}`,
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <EntityModal
          config={configs[page]}
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
          onPersist={(savedEntity) => onSaveEntity(page, savedEntity)}
          onOpenScanViewer={onOpenScanViewer}
          researchRequired={researchRequired}
          onClose={close}
          onSave={(savedEntity) => {
            onSaveEntity(page, savedEntity);
            close();
          }}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  }

  function openRelatedCreateWindow(
    page: PageKey,
    initialValues: Record<string, unknown>,
  ): void {
    if (page === "persons") {
      navigationFallback(() => onCreateRelated?.(page, initialValues));
      return;
    }
    if (!isRelatedEntityPage(page) || !db || !onSaveEntity) {
      navigationFallback(() => onCreateRelated?.(page, initialValues));
      return;
    }
    if (readOnly || !(canCreateRelated?.(page) ?? canCreate)) {
      navigationFallback(() => onCreateRelated?.(page, initialValues));
      return;
    }
    const windowId = `new:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    openWorkspaceWindow({
      ownerKey: `familyTree:${page}`,
      logicalKey: windowId,
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <EntityModal
          config={configs[page]}
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
          onPersist={(savedEntity) => onSaveEntity(page, savedEntity)}
          onOpenScanViewer={onOpenScanViewer}
          researchRequired={researchRequired}
          onClose={close}
          onSave={(savedEntity) => {
            onSaveEntity(page, savedEntity);
            close();
          }}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  }

  return { openPersonCardWindow };
}
