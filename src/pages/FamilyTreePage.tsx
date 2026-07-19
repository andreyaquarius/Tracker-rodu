import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeGraphIssue,
  FamilyTreeGraphMode,
  FamilyTreeGraphQuery,
  FamilyTreeIssueDto,
} from "../types/familyTree";
import { useFamilyTreeGraph } from "../hooks/useFamilyTreeGraph";
import { requestGedcomExport } from "../services/gedcomExportService.ts";
import {
  calculateTreeLayoutWithCache,
  type VisualNode,
} from "../utils/familyTreeVisualLayout";
import {
  FamilyTreeToolbar,
  type FamilyTreeRelationshipScope,
  type FamilyTreeSearchResult,
  type FamilyTreeToolbarState,
} from "../components/familyTree/FamilyTreeToolbar";
import { FamilyTreeViewer } from "../components/familyTree/FamilyTreeViewer";
import { FamilyTreeSidePanel } from "../components/familyTree/FamilyTreeSidePanel";
import type { FamilyTreeDetachInput } from "../components/familyTree/FamilyTreeSidePanel";
import { FamilyTreeLegend } from "../components/familyTree/FamilyTreeLegend";
import { FamilyTreeIssuesPanel } from "../components/familyTree/FamilyTreeIssuesPanel";
import {
  FamilyTreeEmptyState,
  FamilyTreeErrorState,
  FamilyTreeLoadingState,
} from "../components/familyTree/FamilyTreeStates";
import {
  FamilyTreePersonDialog,
  type FamilyTreePartnerOption,
  type FamilyTreePersonDialogSubmit,
} from "../components/familyTree/FamilyTreePersonDialog";
import {
  FamilyTreeAttachPersonDialog,
  type FamilyTreeAttachAction,
  type FamilyTreeAttachCandidate,
  type FamilyTreeAttachSubmit,
} from "../components/familyTree/FamilyTreeAttachPersonDialog";
import { useFamilyTreeMutations } from "../hooks/useFamilyTreeMutations";
import {
  createFamilyTreeFromLegacyImport,
  type FamilyTreeBuilderAction,
} from "../services/familyTreeMutationService";
import { useWorkspaceWindows } from "../components/WorkspaceWindows";
import type {
  AppDatabase,
  AppEntity,
  DocumentRecord,
  ArchiveRequest,
  CustomFieldDefinition,
  Finding,
  Hypothesis,
  Person,
  PersonRelation,
  Research,
  ScanAttachment,
  TaskRecord,
} from "../types";
import type { PageKey } from "../components/Sidebar";
import { PersonFormModal } from "../components/PersonFormModal";
import { savePersonAndClose } from "../features/persons-v2/contracts.ts";
import { PersonCardModal } from "./PersonsPage";
import { configs } from "./entityConfigs";
import { EntityDetailsModal, EntityModal } from "./CrudPage";
import type { DocumentScanViewerContext } from "../components/DocumentWorkspaceViewer";
import { graphForDisplayMode } from "../utils/familyTreeVisibility";
import {
  createFamilyTree,
  deleteFamilyTree,
  mergeFamilyTrees,
  readFamilyTreeAdminSummaries,
  setDefaultFamilyTree,
  type FamilyTreeAdminSummary,
} from "../services/familyTreeAdminService";
import { formatDateForDisplay, formatDateTime } from "../utils/dateHelpers";
import { ProductionFamilyTreePage } from "./ProductionFamilyTreePage";
import { useFamilyTreeRecordWindows } from "../hooks/useFamilyTreeRecordWindows";
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

const relatedEntityPages = [
  "researches",
  "documents",
  "archiveRequests",
  "tasks",
  "findings",
  "hypotheses",
] as const;

type RelatedEntityPageKey = typeof relatedEntityPages[number];

function isRelatedEntityPage(page: PageKey): page is RelatedEntityPageKey {
  return relatedEntityPages.includes(page as RelatedEntityPageKey);
}

const defaultToolbarState: FamilyTreeToolbarState = {
  treeId: "",
  rootPersonId: "",
  mode: "family",
  generationsUp: 7,
  generationsDown: 4,
  relationshipScope: "family",
  includeAdoptive: true,
  includeStep: true,
  includeFoster: true,
  includeGuardian: true,
  includeDisputed: true,
};

const GEDCOM_EXPORT_PRIVACY_CONFIRMATION =
  "GEDCOM-файл може містити персональні та приватні дані, зокрема відомості про живих осіб. " +
  "Файл буде сформовано у фоновому режимі, а захищене посилання для завантаження надійде на email вашого облікового запису. " +
  "Продовжити експорт?";

export type FamilyTreePageProps = {
  projectId: string | undefined;
  initialTreeId?: string;
  initialFocusPersonId?: string;
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
  onImportRecords?: (collection: "persons", records: AppEntity[]) => Promise<void>;
  onImportGedcom?: (
    input: GedcomImportReconciliationPayload,
    options?: GedcomImportExecutionOptions,
  ) => Promise<GedcomImportReconciliationResult | void>;
  onBackupGedcomPhotos?: (
    plan: GedcomPhotoBackupPlan,
    onProgress: (progress: GedcomPhotoBackupProgress) => void,
  ) => Promise<GedcomPhotoBackupResult>;
  onSaveEntity?: (collection: RelatedEntityPageKey, entity: AppEntity) => void | AppEntity | null | Promise<AppEntity | null | void>;
  onSaveRelation?: (relation: PersonRelation) => void;
  onDeleteRelation?: (id: string) => void;
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onCreateRelated?: (page: PageKey, initialValues: Record<string, unknown>) => void;
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
  onActiveContextChange?: (context: {
    projectId: string;
    treeId: string;
    rootPersonId: string;
  }) => void;
  personProfileNavigationEnabled?: boolean;
  useProductionRenderer?: boolean;
};

export function FamilyTreePage({
  useProductionRenderer = false,
  ...props
}: FamilyTreePageProps) {
  if (useProductionRenderer) {
    return <ProductionFamilyTreePageWithWindows {...props} />;
  }
  return <LegacyFamilyTreePage {...props} />;
}

function ProductionFamilyTreePageWithWindows(props: FamilyTreePageProps) {
  const { openPersonCardWindow } = useFamilyTreeRecordWindows({
    ...props,
    allowNavigationFallback: false,
  });
  const handleOpenPerson = props.personProfileNavigationEnabled && props.onOpenPerson
    ? props.onOpenPerson
    : openPersonCardWindow;
  return (
    <ProductionFamilyTreePage
      {...props}
      onOpenPerson={handleOpenPerson}
    />
  );
}

export function LegacyFamilyTreePage({
  projectId,
  initialTreeId,
  initialFocusPersonId,
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
  onActiveContextChange,
  personProfileNavigationEnabled = false,
}: FamilyTreePageProps) {
  const { openWindow: openWorkspaceWindow } = useWorkspaceWindows();
  const [toolbarState, setToolbarState] = useState<FamilyTreeToolbarState>(() => ({
    ...defaultToolbarState,
    treeId: initialTreeId?.trim() || "",
  }));
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState("");
  const [highlightedOccurrenceIds, setHighlightedOccurrenceIds] = useState<string[]>([]);
  const [highlightedRelationshipId, setHighlightedRelationshipId] = useState("");
  const [selectedIssueKey, setSelectedIssueKey] = useState("");
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [treeSearchQuery, setTreeSearchQuery] = useState("");
  const [focusOccurrenceId, setFocusOccurrenceId] = useState("");
  const appliedRouteFocusRef = useRef("");
  const [expandedBranchPersonIds, setExpandedBranchPersonIds] = useState<string[]>([]);
  const [treeAdminOpen, setTreeAdminOpen] = useState(false);
  const [treeAdminSummaries, setTreeAdminSummaries] = useState<FamilyTreeAdminSummary[]>([]);
  const [treeAdminLoading, setTreeAdminLoading] = useState(false);
  const [treeAdminError, setTreeAdminError] = useState("");
  const [newTreeTitle, setNewTreeTitle] = useState("");
  const [treeBuildRootPersonId, setTreeBuildRootPersonId] = useState("");
  const [builderTarget, setBuilderTarget] = useState<{
    action: FamilyTreeBuilderAction;
    personId?: string;
  } | null>(null);
  const [attachTarget, setAttachTarget] = useState<{
    action: FamilyTreeAttachAction;
    personId: string;
  } | null>(null);
  const [builderNotice, setBuilderNotice] = useState("");

  const query = useMemo<FamilyTreeGraphQuery | null>(() => {
    if (!projectId) return null;
    return {
      projectId,
      treeId: toolbarState.treeId || undefined,
      rootPersonId: toolbarState.rootPersonId || undefined,
      mode: "family",
      unlimitedDepth: true,
      includeAssociations: true,
      includeDisproven: true,
      includePrivateLiving: true,
      problemsMode: true,
    };
  }, [projectId, toolbarState.rootPersonId, toolbarState.treeId]);

  const { data, isLoading, error, refetch } = useFamilyTreeGraph(query);
  const mutations = useFamilyTreeMutations();
  const filteredGraph = useMemo(
    () => data ? filterGraphForViewState(data, toolbarState, expandedBranchPersonIds) : null,
    [data, expandedBranchPersonIds, toolbarState],
  );
  const layout = useMemo(
    () => filteredGraph ? calculateTreeLayoutWithCache(filteredGraph) : null,
    [filteredGraph],
  );
  const selectedLayoutNode = useMemo(() => {
    if (!layout) return null;
    return layout.nodes.find((node) => node.occurrence.id === selectedOccurrenceId) ??
      layout.nodes.find((node) => node.occurrence.id === layout.rootOccurrenceId) ??
      layout.nodes[0] ??
      null;
  }, [layout, selectedOccurrenceId]);
  const treeSearchResults = useMemo(
    () => layout ? searchTreeLayout(layout.nodes, treeSearchQuery) : [],
    [layout, treeSearchQuery],
  );
  const personNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of filteredGraph?.availablePersons ?? []) {
      map.set(person.personId, person.displayName);
    }
    for (const person of filteredGraph?.nodes ?? []) {
      map.set(person.personId, person.displayName);
    }
    return map;
  }, [filteredGraph]);
  const builderTargetName = builderTarget?.personId ? personNameById.get(builderTarget.personId) ?? "" : "";
  const attachTargetName = attachTarget?.personId ? personNameById.get(attachTarget.personId) ?? "" : "";
  const personCustomFieldDefinitions = useMemo(
    () => customFieldDefinitions.filter((field) => field.module === "persons"),
    [customFieldDefinitions],
  );
  const suggestedTreeBuildRootPersonId = useMemo(() => {
    if (toolbarState.rootPersonId && persons.some((person) => person.id === toolbarState.rootPersonId)) {
      return toolbarState.rootPersonId;
    }
    return persons[0]?.id ?? "";
  }, [persons, toolbarState.rootPersonId]);
  const selectedTreeBuildRootPersonId = treeBuildRootPersonId && persons.some((person) => person.id === treeBuildRootPersonId)
    ? treeBuildRootPersonId
    : suggestedTreeBuildRootPersonId;
  const canCreateLinkedRecords = !readOnly && (
    canCreate ||
    relatedEntityPages.some((page) => canCreateRelated?.(page) ?? canCreate)
  );
  const builderPartnerOptions = useMemo<FamilyTreePartnerOption[]>(() => {
    if (!filteredGraph || !builderTarget?.personId) return [];
    return partnerOptionsForPerson(filteredGraph, builderTarget.personId, personNameById);
  }, [filteredGraph, builderTarget, personNameById]);
  const attachPartnerOptions = useMemo<FamilyTreePartnerOption[]>(() => {
    if (!filteredGraph || !attachTarget?.personId) return [];
    return partnerOptionsForPerson(filteredGraph, attachTarget.personId, personNameById);
  }, [filteredGraph, attachTarget, personNameById]);
  const attachCandidates = useMemo<FamilyTreeAttachCandidate[]>(() => {
    if (!filteredGraph || !attachTarget) return [];
    return attachCandidatesForAction(filteredGraph, attachTarget.action, attachTarget.personId);
  }, [filteredGraph, attachTarget]);
  const activeTreeId = toolbarState.treeId ||
    filteredGraph?.treeId ||
    data?.treeId ||
    treeAdminSummaries.find((summary) => summary.tree.isDefault)?.tree.id ||
    treeAdminSummaries[0]?.tree.id ||
    "";
  const persistedRootPersonId = treeAdminSummaries.find(
    (summary) => summary.tree.id === activeTreeId,
  )?.tree.rootPersonId
    || data?.tree?.rootPersonId
    || "";

  useEffect(() => {
    if (!projectId || !activeTreeId || !persistedRootPersonId) return;
    onActiveContextChange?.({
      projectId,
      treeId: activeTreeId,
      rootPersonId: persistedRootPersonId,
    });
  }, [activeTreeId, onActiveContextChange, persistedRootPersonId, projectId]);

  const refreshTreeAdmin = async () => {
    if (!projectId) {
      setTreeAdminSummaries([]);
      return;
    }
    setTreeAdminLoading(true);
    setTreeAdminError("");
    try {
      setTreeAdminSummaries(await readFamilyTreeAdminSummaries(projectId));
    } catch (adminError) {
      setTreeAdminError(adminError instanceof Error ? adminError.message : "Не вдалося завантажити адміністрування дерев.");
    } finally {
      setTreeAdminLoading(false);
    }
  };

  function openPersonCardWindow(personId: string) {
    if (personProfileNavigationEnabled && onOpenPerson) {
      onOpenPerson(personId);
      return;
    }
    const person = persons.find((item) => item.id === personId);
    if (!db || !person || !onSaveRelation || !onDeleteRelation || !onOpenRelated || !onCreateRelated) {
      onOpenPerson?.(personId);
      return;
    }

    openWorkspaceWindow({
      ownerKey: "persons",
      logicalKey: `view:${person.id}`,
      render: ({ stackIndex, dockIndex, onFocus, close }) => (
        <PersonCardModal
          projectId={projectId}
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
          onEdit={!readOnly && onSavePerson ? () => openPersonEditWindow(person) : undefined}
          onSaveRelation={onSaveRelation}
          onDeleteRelation={onDeleteRelation}
          onOpenRelated={(page, entityId) => {
            openRelatedRecordWindow(page, entityId);
          }}
          onCreateRelated={(page, initialValues) => {
            openRelatedCreateWindow(page, initialValues);
          }}
          readOnly={readOnly}
          canCreate={canCreateLinkedRecords}
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  }

  function openPersonEditWindow(person: Person) {
    if (!db || !onSavePerson) {
      onOpenPerson?.(person.id);
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
          onSave={(savedPerson) => savePersonAndClose(onSavePerson, savedPerson, close)}
          modalMode="window"
          stackIndex={stackIndex}
          dockIndex={dockIndex}
          onFocus={onFocus}
        />
      ),
    });
  }

  function openRelatedRecordWindow(
    page: PageKey,
    entityId: string,
    loadedEntity?: AppEntity,
  ) {
    if (page === "persons") {
      openPersonCardWindow(entityId);
      return;
    }
    if (!isRelatedEntityPage(page) || !db || !onSaveEntity) {
      onOpenRelated?.(page, entityId);
      return;
    }
    const entity = loadedEntity ??
      (db[page] as AppEntity[]).find((item) => item.id === entityId);
    if (!entity) {
      onOpenRelated?.(page, entityId);
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
          onOpenRelated={(nextPage, nextEntityId) => openRelatedRecordWindow(nextPage, nextEntityId)}
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

  function openRelatedEditWindow(page: RelatedEntityPageKey, entity: AppEntity) {
    if (!db || !onSaveEntity) {
      onOpenRelated?.(page, entity.id);
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

  function openRelatedCreateWindow(page: PageKey, initialValues: Record<string, unknown>) {
    if (page === "persons") {
      onCreateRelated?.(page, initialValues);
      return;
    }
    if (!isRelatedEntityPage(page) || !db || !onSaveEntity) {
      onCreateRelated?.(page, initialValues);
      return;
    }
    if (readOnly || !(canCreateRelated?.(page) ?? canCreate)) {
      onCreateRelated?.(page, initialValues);
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

  useEffect(() => {
    setToolbarState({
      ...defaultToolbarState,
      treeId: initialTreeId?.trim() || "",
    });
    appliedRouteFocusRef.current = "";
    setSelectedOccurrenceId("");
    setHighlightedOccurrenceIds([]);
    setHighlightedRelationshipId("");
    setSelectedIssueKey("");
    setIssuesOpen(false);
    setExpandedBranchPersonIds([]);
    setBuilderTarget(null);
    setAttachTarget(null);
    setBuilderNotice("");
    mutations.resetError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTreeId, projectId]);

  useEffect(() => {
    setExpandedBranchPersonIds([]);
  }, [toolbarState.treeId, toolbarState.mode]);

  useEffect(() => {
    if (!treeAdminOpen) return;
    void refreshTreeAdmin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, treeAdminOpen]);

  useEffect(() => {
    if (!filteredGraph?.rootPersonId) return;
    setToolbarState((current) => {
      const treeId = current.treeId || filteredGraph.treeId;
      const rootPersonId = current.rootPersonId || (filteredGraph.rootPersonId ?? "");
      if (treeId === current.treeId && rootPersonId === current.rootPersonId) return current;
      return {
        ...current,
        treeId,
        rootPersonId,
      };
    });
  }, [filteredGraph?.treeId, filteredGraph?.rootPersonId]);

  useEffect(() => {
    if (!filteredGraph) return;
    setHighlightedOccurrenceIds([]);
    setHighlightedRelationshipId("");
    setSelectedIssueKey("");
    setSelectedOccurrenceId((current) => {
      if (current && filteredGraph.occurrences.some((occurrence) => occurrence.id === current)) return current;
      const rootOccurrence = filteredGraph.occurrences.find(
        (occurrence) => occurrence.personId === filteredGraph.rootPersonId,
      );
      return rootOccurrence?.id ?? filteredGraph.occurrences[0]?.id ?? "";
    });
  }, [filteredGraph]);

  useEffect(() => {
    const personId = initialFocusPersonId?.trim();
    if (!personId || !filteredGraph) return;
    const routedTreeId = initialTreeId?.trim();
    if (routedTreeId && filteredGraph.treeId !== routedTreeId) return;
    const requestKey = `${filteredGraph.treeId}\u001f${personId}`;
    if (appliedRouteFocusRef.current === requestKey) return;
    const occurrence = filteredGraph.occurrences.find((item) => item.personId === personId);
    if (!occurrence) return;
    appliedRouteFocusRef.current = requestKey;
    setSelectedOccurrenceId(occurrence.id);
    setHighlightedOccurrenceIds([occurrence.id]);
    setHighlightedRelationshipId("");
    setSelectedIssueKey("");
    setFocusOccurrenceId(occurrence.id);
  }, [filteredGraph, initialFocusPersonId, initialTreeId]);

  const updateToolbar = (patch: Partial<FamilyTreeToolbarState>) => {
    if (patch.rootPersonId) {
      setExpandedBranchPersonIds([patch.rootPersonId]);
    }
    setToolbarState((current) => ({ ...current, ...patch }));
    if (patch.rootPersonId) {
      const treeId = patch.treeId || toolbarState.treeId || filteredGraph?.treeId || data?.treeId || "";
      if (projectId && treeId && patch.rootPersonId !== filteredGraph?.rootPersonId) {
        void persistFamilyTreeRoot(treeId, patch.rootPersonId);
      }
    }
  };

  const persistFamilyTreeRoot = async (treeId: string, rootPersonId: string) => {
    if (!projectId || readOnly) return;
    const result = await mutations.setFamilyTreeRoot({ projectId, treeId, personId: rootPersonId });
    if (result === null) return;
    setBuilderNotice("Центральну особу дерева збережено.");
    await refreshTreeAdmin();
    await refetch();
  };

  const expandHiddenRelatives = (direction: "up" | "down" | "side", occurrenceId: string) => {
    setSelectedOccurrenceId(occurrenceId);
    if (direction === "side") {
      const occurrence = filteredGraph?.occurrences.find((item) => item.id === occurrenceId);
      if (!occurrence) return;
      setExpandedBranchPersonIds([occurrence.personId]);
      setToolbarState((current) => ({
        ...current,
        rootPersonId: occurrence.personId,
        mode: "family",
      }));
      setFocusOccurrenceId("");
      return;
    }
    setToolbarState((current) => ({
      ...current,
      generationsUp: direction === "up" ? current.generationsUp + 1 : current.generationsUp,
      generationsDown: direction === "down" ? current.generationsDown + 1 : current.generationsDown,
    }));
  };

  const selectAdminTree = (treeId: string, rootPersonId: string | null) => {
    setToolbarState((current) => ({
      ...current,
      treeId,
      rootPersonId: rootPersonId ?? "",
      mode: "family",
    }));
    setSelectedOccurrenceId("");
    setHighlightedOccurrenceIds([]);
    setHighlightedRelationshipId("");
    setSelectedIssueKey("");
    setExpandedBranchPersonIds([]);
    setBuilderNotice("");
  };

  const createAdminTree = async () => {
    if (!projectId || !newTreeTitle.trim()) return;
    setTreeAdminLoading(true);
    setTreeAdminError("");
    try {
      const tree = await createFamilyTree({ projectId, title: newTreeTitle });
      setNewTreeTitle("");
      selectAdminTree(tree.id, tree.rootPersonId);
      setBuilderNotice("Нове дерево створено. Тепер можна додати фокусну особу або прив’язати людей.");
      await refreshTreeAdmin();
      await refetch();
    } catch (adminError) {
      setTreeAdminError(adminError instanceof Error ? adminError.message : "Не вдалося створити дерево.");
    } finally {
      setTreeAdminLoading(false);
    }
  };

  const makeAdminTreeDefault = async (treeId: string) => {
    if (!projectId) return;
    setTreeAdminLoading(true);
    setTreeAdminError("");
    try {
      await setDefaultFamilyTree({ projectId, treeId });
      await refreshTreeAdmin();
      setBuilderNotice("Основне дерево оновлено.");
    } catch (adminError) {
      setTreeAdminError(adminError instanceof Error ? adminError.message : "Не вдалося зробити дерево основним.");
    } finally {
      setTreeAdminLoading(false);
    }
  };

  const mergeAdminTreeIntoActive = async (sourceTreeId: string) => {
    if (!projectId || !activeTreeId || sourceTreeId === activeTreeId) return;
    const source = treeAdminSummaries.find((summary) => summary.tree.id === sourceTreeId);
    const target = treeAdminSummaries.find((summary) => summary.tree.id === activeTreeId);
    const confirmed = window.confirm(
      `Об’єднати дерево «${source?.tree.title || "Без назви"}» з поточним деревом «${target?.tree.title || "Без назви"}»? Особи не дублюватимуться, а дерево-джерело буде прибране.`,
    );
    if (!confirmed) return;
    setTreeAdminLoading(true);
    setTreeAdminError("");
    try {
      await mergeFamilyTrees({ projectId, sourceTreeId, targetTreeId: activeTreeId });
      setBuilderNotice("Дерева об’єднано. Якщо між гілками з’явився зв’язок, тепер вони будуть будуватися як одне дерево.");
      await refreshTreeAdmin();
      await refetch();
    } catch (adminError) {
      setTreeAdminError(adminError instanceof Error ? adminError.message : "Не вдалося об’єднати дерева.");
    } finally {
      setTreeAdminLoading(false);
    }
  };

  const deleteAdminTree = async (treeId: string) => {
    if (!projectId) return;
    const summary = treeAdminSummaries.find((item) => item.tree.id === treeId);
    const confirmed = window.confirm(
      `Видалити дерево «${summary?.tree.title || "Без назви"}»? Картки осіб залишаться в базі, буде видалено лише це дерево та його графові зв’язки.`,
    );
    if (!confirmed) return;
    setTreeAdminLoading(true);
    setTreeAdminError("");
    try {
      const fallbackTreeId = await deleteFamilyTree({ projectId, treeId });
      const fallbackSummary = treeAdminSummaries.find((item) => item.tree.id === fallbackTreeId);
      if (treeId === activeTreeId) {
        selectAdminTree(fallbackTreeId ?? "", fallbackSummary?.tree.rootPersonId ?? null);
      }
      setBuilderNotice("Дерево видалено. Особи з бази не видалялися.");
      await refreshTreeAdmin();
      await refetch();
    } catch (adminError) {
      setTreeAdminError(adminError instanceof Error ? adminError.message : "Не вдалося видалити дерево.");
    } finally {
      setTreeAdminLoading(false);
    }
  };

  const selectIssue = (issue: FamilyTreeIssueDto, key: string) => {
    setSelectedIssueKey(key);
    setHighlightedOccurrenceIds(issue.occurrenceIds);
    setHighlightedRelationshipId(issue.relationshipIds[0] ?? "");
    const occurrenceId = issue.occurrenceIds[0] ??
      filteredGraph?.occurrences.find((occurrence) => issue.personIds.includes(occurrence.personId))?.id ??
      "";
    if (occurrenceId) {
      setSelectedOccurrenceId(occurrenceId);
      setFocusOccurrenceId(occurrenceId);
    }
  };

  const selectSearchResult = (result: FamilyTreeSearchResult) => {
    setSelectedOccurrenceId(result.occurrenceId);
    setHighlightedOccurrenceIds([result.occurrenceId]);
    setHighlightedRelationshipId("");
    setSelectedIssueKey("");
    setFocusOccurrenceId(result.occurrenceId);
  };

  const exportGedcom = async () => {
    if (!projectId) return;
    const treeId = toolbarState.treeId || data?.treeId || filteredGraph?.treeId || "";
    if (!treeId) {
      setBuilderNotice("Не вибрано дерево для експорту GEDCOM.");
      return;
    }
    if (!window.confirm(GEDCOM_EXPORT_PRIVACY_CONFIRMATION)) {
      setBuilderNotice("Експорт GEDCOM скасовано.");
      return;
    }
    setBuilderNotice("Надсилаю запит на фоновий експорт GEDCOM…");
    try {
      const status = await requestGedcomExport(projectId, treeId);
      if ((status.status === "failed" && !status.retryable) || status.status === "expired") {
        throw new Error(
          status.error ||
            (status.status === "expired"
              ? "Термін дії попереднього експорту завершився. Спробуйте ще раз."
              : "Фоновий експорт GEDCOM завершився з помилкою."),
        );
      }
      if (status.status === "completed") {
        if (status.emailStatus === "sent") {
          setBuilderNotice(
            "GEDCOM-файл уже готовий. Захищене посилання для завантаження надіслано на вашу email-адресу.",
          );
        } else if (status.emailStatus === "failed") {
          setBuilderNotice(
            "GEDCOM-файл уже готовий, але не вдалося надіслати email із посиланням. Спробуйте повторити запит пізніше.",
          );
        } else {
          setBuilderNotice(
            "GEDCOM-файл уже готовий. Email із захищеним посиланням готується до надсилання.",
          );
        }
      } else {
        setBuilderNotice(
          "Запит на експорт GEDCOM прийнято. Файл формується у фоновому режимі; коли він буде готовий, захищене посилання для завантаження надійде на вашу email-адресу.",
        );
      }
    } catch (exportError) {
      setBuilderNotice(
        exportError instanceof Error
          ? `Не вдалося експортувати GEDCOM: ${exportError.message}`
          : "Не вдалося експортувати GEDCOM.",
      );
    }
  };

  const openBuilderAction = (action: FamilyTreeBuilderAction, personId: string) => {
    if (!personId) return;
    setBuilderNotice("");
    mutations.resetError();
    setAttachTarget(null);
    setBuilderTarget({ action, personId });
  };

  const openAttachAction = (action: FamilyTreeAttachAction, personId: string) => {
    if (!personId) return;
    setBuilderNotice("");
    mutations.resetError();
    setBuilderTarget(null);
    setAttachTarget({ action, personId });
  };

  const openRootBuilder = () => {
    setBuilderNotice("");
    mutations.resetError();
    setAttachTarget(null);
    setBuilderTarget({ action: "create_root" });
  };

  const openBuilderActionFromOccurrence = (action: FamilyTreeBuilderAction, occurrenceId: string) => {
    const occurrence = filteredGraph?.occurrences.find((item) => item.id === occurrenceId);
    if (!occurrence) return;
    openBuilderAction(action, occurrence.personId);
  };

  const submitBuilderAction = async (payload: FamilyTreePersonDialogSubmit) => {
    if (!projectId || !builderTarget) return;

    if (payload.action === "create_root") {
      const created = await mutations.createRootPersonInTree({
        projectId,
        treeId: filteredGraph?.treeId || toolbarState.treeId || undefined,
        person: payload.person,
      });
      if (!created) return;
      setToolbarState((current) => ({
        ...current,
        treeId: created.treeId,
        rootPersonId: created.personId,
        mode: "family",
      }));
      setBuilderTarget(null);
      setBuilderNotice("Першу особу створено. Родове дерево готове до наповнення.");
      return;
    }

    if (!filteredGraph?.treeId || !builderTarget.personId) return;

    const baseInput = {
      projectId,
      treeId: filteredGraph.treeId,
      person: payload.person,
      referencePersonId: builderTarget.personId,
    };
    let createdPersonId: string | null = null;

    if (payload.action === "add_father" || payload.action === "add_mother" || payload.action === "add_parent") {
      createdPersonId = await mutations.addParentToPerson({
        ...baseInput,
        childId: builderTarget.personId,
        parentIntent: payload.action === "add_father" ? "father" : payload.action === "add_mother" ? "mother" : "parent",
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "add_partner") {
      createdPersonId = await mutations.addPartnerToPerson({
        ...baseInput,
        personId: builderTarget.personId,
        relationshipType: payload.partnerRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "add_child") {
      createdPersonId = await mutations.addChildToPerson({
        ...baseInput,
        parentId: builderTarget.personId,
        secondParentId: payload.secondParentId,
        familyGroupId: payload.familyGroupId,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "add_sibling") {
      createdPersonId = await mutations.addSiblingToPerson({
        ...baseInput,
        personId: builderTarget.personId,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    }

    if (!createdPersonId) return;
    setBuilderTarget(null);
    setBuilderNotice("Особу додано до родового дерева. Граф оновлено.");
    await refetch();
  };

  const submitAttachAction = async (payload: FamilyTreeAttachSubmit) => {
    if (!projectId || !filteredGraph?.treeId || !attachTarget?.personId) return;
    let attachedPersonId: string | null = null;

    if (payload.action === "attach_parent") {
      attachedPersonId = await mutations.attachExistingParentToPerson({
        projectId,
        treeId: filteredGraph.treeId,
        childId: attachTarget.personId,
        parentId: payload.existingPersonId,
        parentIntent: payload.parentIntent,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "attach_partner") {
      attachedPersonId = await mutations.attachExistingPartnerToPerson({
        projectId,
        treeId: filteredGraph.treeId,
        personId: attachTarget.personId,
        partnerId: payload.existingPersonId,
        relationshipType: payload.partnerRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "attach_child") {
      attachedPersonId = await mutations.attachExistingChildToPerson({
        projectId,
        treeId: filteredGraph.treeId,
        parentId: attachTarget.personId,
        childId: payload.existingPersonId,
        secondParentId: payload.secondParentId,
        familyGroupId: payload.familyGroupId,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    }

    if (!attachedPersonId) return;
    setAttachTarget(null);
    setBuilderNotice("Існуючу особу прив’язано без створення дубліката. Граф оновлено.");
    await refetch();
  };

  const detachRelationship = async (input: FamilyTreeDetachInput) => {
    if (!projectId) return;
    const confirmed = window.confirm(
      `Від’єднати зв’язок з «${input.label}»? Особа залишиться в базі, буде видалено лише зв’язок у дереві.`,
    );
    if (!confirmed) return;
    const result = await mutations.deleteRelationship({
      projectId,
      kind: input.kind,
      relationshipId: input.relationshipId,
    });
    if (result === null) return;
    setBuilderNotice("Зв’язок від’єднано. Особу не видалено.");
    await refetch();
  };
  const createTreeFromExistingPeople = async () => {
    if (!projectId || !persons.length) return;
    const rootPersonId = selectedTreeBuildRootPersonId || persons[0]?.id || "";
    if (!rootPersonId) return;
    const originalPersonById = new Map(persons.map((person) => [person.id, person]));
    const importedPeople = persons.map((person) =>
      person.status === "гіпотетична" && typeof person.customFields?.__gedcomXref === "string"
        ? { ...person, status: "доведена" as Person["status"] }
        : person,
    );
    if (onSavePerson) {
      for (const person of importedPeople) {
        if (person !== originalPersonById.get(person.id)) {
          await onSavePerson(person);
        }
      }
    }
    const result = await createFamilyTreeFromLegacyImport({
      projectId,
      title: "Родове дерево з GEDCOM",
      persons: importedPeople,
      relations,
      rootPersonId,
    });
    if (!result) return;
    setToolbarState((current) => ({
      ...current,
      treeId: result.treeId,
      rootPersonId: result.rootPersonId,
      mode: "family",
    }));
    setSelectedOccurrenceId("");
    setBuilderNotice(`Родове дерево сформовано з наявних осіб: ${result.persons} осіб, ${result.parentChildRelationships + result.partnerRelationships} зв’язків.`);
    await refetch();
  };
  const showRootCreationState = Boolean(
    projectId &&
    !error &&
    !isLoading &&
    filteredGraph &&
    (!filteredGraph.tree || !filteredGraph.rootPersonId),
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Родове дерево</h1>
        </div>
        <div className="page-heading-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setTreeAdminOpen((current) => !current)}
          >
            {treeAdminOpen ? "Сховати адміністрування" : "Адміністрування дерева"}
          </button>
        </div>
      </div>

      {treeAdminOpen ? (
        <FamilyTreeAdminPanel
          summaries={treeAdminSummaries}
          activeTreeId={activeTreeId}
          newTreeTitle={newTreeTitle}
          isLoading={treeAdminLoading}
          error={treeAdminError}
          readOnly={readOnly}
          onNewTreeTitleChange={setNewTreeTitle}
          onCreateTree={() => void createAdminTree()}
          onSelectTree={selectAdminTree}
          onMakeDefault={(treeId) => void makeAdminTreeDefault(treeId)}
          onMergeIntoActive={(treeId) => void mergeAdminTreeIntoActive(treeId)}
          onDeleteTree={(treeId) => void deleteAdminTree(treeId)}
          onRefresh={() => void refreshTreeAdmin()}
        />
      ) : null}

      <FamilyTreeToolbar
        graph={filteredGraph}
        state={toolbarState}
        searchQuery={treeSearchQuery}
        searchResults={treeSearchResults}
        onChange={updateToolbar}
        onSearchChange={setTreeSearchQuery}
        onSelectSearchResult={selectSearchResult}
        onExportGedcom={exportGedcom}
        onRefresh={() => void refetch()}
        isLoading={isLoading}
      />

      {builderNotice ? <div className="inline-success">{builderNotice}</div> : null}
      {error && filteredGraph ? <div className="form-error">Не вдалося оновити дерево: {error}</div> : null}
      {mutations.error && !builderTarget ? <div className="form-error">{mutations.error}</div> : null}

      {showRootCreationState ? (
        <section className="panel family-tree-root-empty">
          <span className="eyebrow">Родове дерево</span>
          <h2>У цьому проєкті ще немає родового дерева.</h2>
          <p>Почніть із першої особи.</p>
          <div className="family-tree-root-empty-actions">
            <button type="button" className="button button-primary" onClick={openRootBuilder}>
              Створити себе
            </button>
            <button type="button" className="button" onClick={openRootBuilder}>
              Створити фокусну особу
            </button>
            {!readOnly && persons.length ? (
              <>
                <label className="family-tree-root-select">
                  <span>Від кого будувати дерево</span>
                  <select
                    value={selectedTreeBuildRootPersonId}
                    onChange={(event) => setTreeBuildRootPersonId(event.target.value)}
                  >
                    {persons
                      .slice()
                      .sort((left, right) => personDisplayName(left).localeCompare(personDisplayName(right), "uk"))
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {personDisplayName(person)}
                        </option>
                      ))}
                  </select>
                </label>
                <button type="button" className="button button-secondary" onClick={() => void createTreeFromExistingPeople()}>
                  Сформувати дерево з наявних осіб
                </button>
              </>
            ) : null}
          </div>
        </section>
      ) : !projectId ? (
        <FamilyTreeEmptyState
          title="Проєкт не вибрано"
          description="Оберіть проєкт, щоб завантажити його родове дерево."
        />
      ) : error && !filteredGraph ? (
        <FamilyTreeErrorState message={error} onRetry={() => void refetch()} />
      ) : isLoading && !filteredGraph ? (
        <FamilyTreeLoadingState />
      ) : filteredGraph && layout ? (
        <div className="family-tree-workspace">
          <div className="family-tree-main-column">
            <FamilyTreeViewer
              graph={filteredGraph}
              layout={layout}
              selectedOccurrenceId={selectedLayoutNode?.occurrence.id ?? ""}
              focusOccurrenceId={focusOccurrenceId}
              highlightedOccurrenceIds={highlightedOccurrenceIds}
              highlightedRelationshipId={highlightedRelationshipId}
              issuesCount={filteredGraph.issues.length}
              onOpenIssues={() => setIssuesOpen(true)}
              onSelectOccurrence={(occurrenceId) => {
                setSelectedOccurrenceId(occurrenceId);
                setHighlightedOccurrenceIds([]);
                setHighlightedRelationshipId("");
                setSelectedIssueKey("");
              }}
              onAction={openBuilderActionFromOccurrence}
              onExpandGeneration={expandHiddenRelatives}
            />
          </div>
          <div className="family-tree-aside-column">
            <FamilyTreeSidePanel
              graph={filteredGraph}
              selected={selectedLayoutNode}
              onSelectOccurrence={setSelectedOccurrenceId}
              onAction={openBuilderAction}
              onAttach={openAttachAction}
              onDetach={(input) => void detachRelationship(input)}
              onOpenPerson={openPersonCardWindow}
            />
            <FamilyTreeLegend />
          </div>
        </div>
      ) : (
        <FamilyTreeEmptyState
          title="Дані ще не завантажені"
          description="Натисніть «Оновити», щоб повторити завантаження родового дерева."
        />
      )}

      {issuesOpen && filteredGraph ? (
        <div className="family-tree-issues-popover" role="dialog" aria-modal="true">
          <div className="family-tree-issues-popover-inner">
            <button
              type="button"
              className="family-tree-popover-close"
              onClick={() => setIssuesOpen(false)}
              aria-label="Закрити перевірку"
            >
              ×
            </button>
            <FamilyTreeIssuesPanel
              issues={filteredGraph.issues}
              selectedIssueKey={selectedIssueKey}
              onSelectIssue={(issue, key) => {
                selectIssue(issue, key);
                setIssuesOpen(false);
              }}
            />
          </div>
        </div>
      ) : null}

      {builderTarget ? (
        <FamilyTreePersonDialog
          action={builderTarget.action}
          targetName={builderTargetName}
          partnerOptions={builderPartnerOptions}
          isSaving={mutations.isMutating}
          error={mutations.error}
          onClose={() => {
            mutations.resetError();
            setBuilderTarget(null);
          }}
          onSubmit={submitBuilderAction}
        />
      ) : null}
      {attachTarget ? (
        <FamilyTreeAttachPersonDialog
          action={attachTarget.action}
          targetName={attachTargetName}
          candidates={attachCandidates}
          partnerOptions={attachPartnerOptions}
          isSaving={mutations.isMutating}
          error={mutations.error}
          onClose={() => {
            mutations.resetError();
            setAttachTarget(null);
          }}
          onSubmit={submitAttachAction}
        />
      ) : null}
    </>
  );
}

function FamilyTreeAdminPanel({
  summaries,
  activeTreeId,
  newTreeTitle,
  isLoading,
  error,
  readOnly,
  onNewTreeTitleChange,
  onCreateTree,
  onSelectTree,
  onMakeDefault,
  onMergeIntoActive,
  onDeleteTree,
  onRefresh,
}: {
  summaries: FamilyTreeAdminSummary[];
  activeTreeId: string;
  newTreeTitle: string;
  isLoading: boolean;
  error: string;
  readOnly: boolean;
  onNewTreeTitleChange: (value: string) => void;
  onCreateTree: () => void;
  onSelectTree: (treeId: string, rootPersonId: string | null) => void;
  onMakeDefault: (treeId: string) => void;
  onMergeIntoActive: (treeId: string) => void;
  onDeleteTree: (treeId: string) => void;
  onRefresh: () => void;
}) {
  const totals = summaries.reduce(
    (acc, summary) => ({
      trees: acc.trees + 1,
      persons: acc.persons + summary.stats.persons,
      families: acc.families + summary.stats.families,
      surnames: acc.surnames + summary.stats.surnames,
      unknownVitalStatusPersons: acc.unknownVitalStatusPersons + summary.stats.unknownVitalStatusPersons,
      issues: acc.issues + summary.stats.issues,
    }),
    { trees: 0, persons: 0, families: 0, surnames: 0, unknownVitalStatusPersons: 0, issues: 0 },
  );

  return (
    <section className="panel family-tree-admin-panel" aria-label="Адміністрування родових дерев">
      <div className="family-tree-admin-header">
        <div>
          <span className="eyebrow">Адміністрування</span>
          <h2>Дерева в цьому проєкті</h2>
        </div>
        <button type="button" className="button button-secondary" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? "Оновлення..." : "Оновити статистику"}
        </button>
      </div>

      <div className="family-tree-admin-stats">
        <AdminStat label="Дерев" value={totals.trees} />
        <AdminStat label="Осіб у деревах" value={totals.persons} />
        <AdminStat label="Сімейних груп" value={totals.families} />
        <AdminStat label="Прізвищ" value={totals.surnames} />
        <AdminStat label="Невідомий статус" value={totals.unknownVitalStatusPersons} />
        <AdminStat label="Проблем" value={totals.issues} />
      </div>

      {!readOnly ? (
        <div className="family-tree-admin-create">
          <label>
            <span>Назва нового дерева</span>
            <input
              value={newTreeTitle}
              placeholder="Наприклад: Гілка Каленських з Війтівки"
              onChange={(event) => onNewTreeTitleChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCreateTree();
              }}
            />
          </label>
          <button type="button" className="button button-primary" disabled={!newTreeTitle.trim() || isLoading} onClick={onCreateTree}>
            Створити дерево
          </button>
        </div>
      ) : null}

      {error ? <div className="form-error">{error}</div> : null}

      <div className="family-tree-admin-list">
        {summaries.length ? summaries.map((summary) => {
          const isActive = summary.tree.id === activeTreeId;
          return (
            <article key={summary.tree.id} className={`family-tree-admin-card${isActive ? " active" : ""}`}>
              <div className="family-tree-admin-card-main">
                <div>
                  <h3>{summary.tree.title || "Дерево без назви"}</h3>
                  <p>
                    {summary.rootPersonName ? `Центральна особа: ${summary.rootPersonName}` : "Центральну особу ще не вибрано"}
                    {summary.tree.isDefault ? " · основне дерево" : ""}
                  </p>
                </div>
                <div className="family-tree-admin-card-actions">
                  <button type="button" className="button button-secondary" disabled={isActive} onClick={() => onSelectTree(summary.tree.id, summary.tree.rootPersonId)}>
                    {isActive ? "Відкрите" : "Відкрити"}
                  </button>
                  {!readOnly && !summary.tree.isDefault ? (
                    <button type="button" className="button button-secondary" onClick={() => onMakeDefault(summary.tree.id)}>
                      Основне
                    </button>
                  ) : null}
                  {!readOnly && activeTreeId && !isActive ? (
                    <button type="button" className="button button-secondary" onClick={() => onMergeIntoActive(summary.tree.id)}>
                      Об’єднати з поточним
                    </button>
                  ) : null}
                  {!readOnly ? (
                    <button type="button" className="button button-secondary danger" onClick={() => onDeleteTree(summary.tree.id)}>
                      Видалити
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="family-tree-admin-card-stats">
                <AdminStat label="Осіб" value={summary.stats.persons} />
                <AdminStat label="Сімей" value={summary.stats.families} />
                <AdminStat label="Прізвищ" value={summary.stats.surnames} />
                <AdminStat label="Партнерств" value={summary.stats.partnerRelationships} />
                <AdminStat label="Батьки-діти" value={summary.stats.parentChildRelationships} />
                <AdminStat label="Живих" value={summary.stats.livingPersons} />
                <AdminStat label="Померлих" value={summary.stats.deceasedPersons} />
                <AdminStat label="Невідомо" value={summary.stats.unknownVitalStatusPersons} />
                <AdminStat label="Проблем" value={summary.stats.issues} />
              </div>
              <p className="family-tree-admin-surnames">
                {summary.surnames.length
                  ? `Прізвища: ${summary.surnames.slice(0, 12).join(", ")}${summary.surnames.length > 12 ? ` та ще ${summary.surnames.length - 12}` : ""}`
                  : "Прізвища ще не визначені"}
              </p>
              {summary.mergeHistory.length ? (
                <div className="family-tree-admin-history">
                  <strong>Історія об’єднань</strong>
                  {summary.mergeHistory.slice(0, 3).map((item) => (
                    <small key={item.id}>
                      {formatDateTime(item.createdAt)} · перенесено осіб: {item.movedPersons}
                    </small>
                  ))}
                </div>
              ) : null}
            </article>
          );
        }) : (
          <div className="family-tree-admin-empty">
            У проєкті ще немає окремих дерев. Створіть дерево і додайте фокусну особу.
          </div>
        )}
      </div>
    </section>
  );
}

function AdminStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="family-tree-admin-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function personDisplayName(person: Person): string {
  return person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") || "Особа без імені";
}

function partnerOptionsForPerson(
  graph: FamilyTreeGraphDto,
  personId: string,
  personNameById: Map<string, string>,
): FamilyTreePartnerOption[] {
  const options = new Map<string, FamilyTreePartnerOption>();
  for (const group of graph.groups) {
    if (!group.partnerIds.includes(personId)) continue;
    for (const partnerId of group.partnerIds) {
      if (partnerId === personId || options.has(partnerId)) continue;
      options.set(partnerId, {
        personId: partnerId,
        familyGroupId: group.id,
        label: personNameById.get(partnerId) ?? "Особа без імені",
      });
    }
  }
  for (const group of graph.groups) {
    if (!group.parentIds.includes(personId)) continue;
    const realFamilyGroupId = group.partnerIds.length || group.primaryPartnerIds.length ? group.id : null;
    for (const parentId of group.parentIds) {
      if (parentId === personId || options.has(parentId)) continue;
      options.set(parentId, {
        personId: parentId,
        familyGroupId: realFamilyGroupId,
        label: personNameById.get(parentId) ?? "Особа без імені",
      });
    }
  }
  return Array.from(options.values()).sort((left, right) => left.label.localeCompare(right.label, "uk"));
}

function attachCandidatesForAction(
  graph: FamilyTreeGraphDto,
  action: FamilyTreeAttachAction,
  targetPersonId: string,
): FamilyTreeAttachCandidate[] {
  const relatedIds = new Set<string>([targetPersonId]);
  for (const edge of graph.edges) {
    if (action === "attach_parent" && edge.kind === "parent_child" && edge.toPersonId === targetPersonId) {
      relatedIds.add(edge.fromPersonId);
    } else if (action === "attach_child" && edge.kind === "parent_child" && edge.fromPersonId === targetPersonId) {
      relatedIds.add(edge.toPersonId);
    } else if (action === "attach_partner" && edge.kind === "partner") {
      if (edge.fromPersonId === targetPersonId) relatedIds.add(edge.toPersonId);
      if (edge.toPersonId === targetPersonId) relatedIds.add(edge.fromPersonId);
    }
  }

  const people = new Map<string, FamilyTreeAttachCandidate>();
  for (const person of [...graph.availablePersons, ...graph.nodes]) {
    if (relatedIds.has(person.personId) || people.has(person.personId)) continue;
    people.set(person.personId, {
      personId: person.personId,
      label: person.displayName || "Особа без імені",
      detail: person.events
        .slice(0, 2)
        .map((event) => [
          formatDateForDisplay(event.eventDate || event.dateText),
          event.placeName,
        ].filter(Boolean).join(" · "))
        .filter(Boolean)
        .join("; "),
    });
  }
  return Array.from(people.values()).sort((left, right) => left.label.localeCompare(right.label, "uk"));
}

function filterGraphForViewState(
  graph: FamilyTreeGraphDto,
  state: FamilyTreeToolbarState,
  expandedBranchPersonIds: string[] = [],
): FamilyTreeGraphDto {
  const modeGraph = graphForDisplayMode(graph, state.mode, { expandedPersonIds: expandedBranchPersonIds });
  const generationOccurrences = modeGraph.occurrences
    .filter((occurrence) => occurrenceAllowedByGeneration(occurrence.generation, state));
  const generationOccurrenceIds = new Set(generationOccurrences.map((occurrence) => occurrence.id));
  const edges = modeGraph.edges.filter((edge) =>
    edgeAllowed(edge, state) &&
    (!edge.fromOccurrenceId || generationOccurrenceIds.has(edge.fromOccurrenceId)) &&
    (!edge.toOccurrenceId || generationOccurrenceIds.has(edge.toOccurrenceId)),
  );
  const visiblePersonIds = new Set<string>();
  const edgePersonIds = new Set(edges.flatMap((edge) => [edge.fromPersonId, edge.toPersonId]));
  for (const occurrence of generationOccurrences) {
    if (modeGraph.rootPersonId === occurrence.personId || edgePersonIds.has(occurrence.personId)) {
      visiblePersonIds.add(occurrence.personId);
    }
  }
  const occurrences = annotateLocalBoundaryCounts(
    generationOccurrences.filter((occurrence) => visiblePersonIds.has(occurrence.personId)),
    modeGraph.edges,
    state,
  );
  const occurrenceIds = new Set(occurrences.map((occurrence) => occurrence.id));
  const nodes = modeGraph.nodes
    .filter((node) => visiblePersonIds.has(node.personId))
    .map((node) => ({
      ...node,
      occurrenceIds: node.occurrenceIds.filter((occurrenceId) => occurrenceIds.has(occurrenceId)),
    }));
  const groups = modeGraph.groups.filter((group) =>
    group.memberIds.some((personId) => visiblePersonIds.has(personId)) ||
    group.parentIds.some((personId) => visiblePersonIds.has(personId)) ||
    group.childIds.some((personId) => visiblePersonIds.has(personId)) ||
    group.partnerIds.some((personId) => visiblePersonIds.has(personId)),
  );
  const issues = modeGraph.issues.filter((issue) => issueAllowed(issue, state.includeDisputed));
  return {
    ...modeGraph,
    mode: state.mode,
    nodes,
    occurrences,
    edges,
    groups,
    issues,
    stats: {
      ...modeGraph.stats,
      persons: nodes.length,
      occurrences: occurrences.length,
      edges: edges.length,
      groups: groups.length,
      issues: issues.length,
    },
  };
}

function occurrenceAllowedByGeneration(generation: number, state: FamilyTreeToolbarState): boolean {
  if (state.mode === "ancestors" || state.mode === "direct-line") {
    return generation <= 0 && Math.abs(generation) <= state.generationsUp;
  }
  if (state.mode === "descendants") {
    return generation >= 0;
  }
  return generation >= -state.generationsUp;
}

function annotateLocalBoundaryCounts(
  occurrences: FamilyTreeGraphDto["occurrences"],
  edges: FamilyTreeEdgeDto[],
  state: FamilyTreeToolbarState,
): FamilyTreeGraphDto["occurrences"] {
  const visibleOccurrenceIds = new Set(occurrences.map((occurrence) => occurrence.id));
  const hiddenParents = new Map<string, number>();
  const hiddenChildren = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "parent_child" || !edge.fromOccurrenceId || !edge.toOccurrenceId) continue;
    const parentVisible = visibleOccurrenceIds.has(edge.fromOccurrenceId);
    const childVisible = visibleOccurrenceIds.has(edge.toOccurrenceId);
    if (!parentVisible && childVisible) {
      hiddenParents.set(edge.toOccurrenceId, (hiddenParents.get(edge.toOccurrenceId) ?? 0) + 1);
    }
    if (parentVisible && !childVisible) {
      hiddenChildren.set(edge.fromOccurrenceId, (hiddenChildren.get(edge.fromOccurrenceId) ?? 0) + 1);
    }
  }
  return occurrences.map((occurrence) => ({
    ...occurrence,
    hiddenParentsCount: hiddenParents.get(occurrence.id) ?? occurrence.hiddenParentsCount ?? 0,
    hiddenChildrenCount: hiddenChildren.get(occurrence.id) ?? occurrence.hiddenChildrenCount ?? 0,
  }));
}

function searchTreeLayout(nodes: VisualNode[], query: string): FamilyTreeSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  return nodes
    .map((node) => {
      const haystack = normalizeSearchText([
        node.person.displayName,
        node.person.gender,
        node.person.status,
        ...node.person.names.flatMap((name) => [
          name.fullName,
          name.originalText,
          name.surname,
          name.givenName,
          name.patronymic,
        ]),
        ...node.person.events.flatMap((event) => [
          event.title,
          event.eventType,
          event.eventDate,
          event.dateFrom,
          event.dateTo,
          event.dateText,
          event.placeName,
        ]),
      ].filter(Boolean).join(" "));
      return { node, matches: haystack.includes(normalizedQuery) };
    })
    .filter((item) => item.matches)
    .slice(0, 12)
    .map(({ node }) => ({
      occurrenceId: node.occurrence.id,
      personId: node.person.personId,
      displayName: node.person.displayName,
      description: searchResultDescription(node),
      generation: node.occurrence.generation,
    }));
}

function searchResultDescription(node: VisualNode): string {
  const years = nodeLifeYears(node);
  const place = node.person.events.map((event) => event.placeName).find(Boolean) ?? "";
  return [
    `Покоління ${node.occurrence.generation}`,
    years,
    place,
    node.occurrence.isRepeated ? "повторна поява" : "",
  ].filter(Boolean).join(" · ");
}

function nodeLifeYears(node: VisualNode): string {
  const birth = node.person.events.find((event) => ["birth", "baptism", "christening"].includes(event.eventType));
  const death = node.person.events.find((event) => ["death", "burial"].includes(event.eventType));
  const birthYear = eventYear(birth);
  const deathYear = eventYear(death);
  if (birthYear && deathYear) return `${birthYear}-${deathYear}`;
  if (birthYear) return `нар. ${birthYear}`;
  if (deathYear) return `пом. ${deathYear}`;
  return "";
}

function eventYear(event: VisualNode["person"]["events"][number] | undefined): string {
  if (!event) return "";
  const text = [event.eventDate, event.dateFrom, event.dateText].find(Boolean) ?? "";
  const match = text.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match?.[1] ?? "";
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase("uk").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
}

function edgeAllowed(edge: FamilyTreeEdgeDto, state: FamilyTreeToolbarState): boolean {
  if (state.relationshipScope === "direct" && edge.kind !== "parent_child") return false;
  if (state.relationshipScope === "family" && edge.kind === "association") return false;
  if (!state.includeDisputed && (edge.evidenceStatus === "disputed" || edge.evidenceStatus === "unknown")) {
    return false;
  }
  if (edge.kind !== "parent_child") return true;
  if (!state.includeAdoptive && edge.relationshipType === "adoptive") return false;
  if (!state.includeStep && edge.relationshipType === "step") return false;
  if (!state.includeFoster && edge.relationshipType === "foster") return false;
  if (!state.includeGuardian && edge.relationshipType === "guardian") return false;
  return true;
}

function issueAllowed(issue: FamilyTreeIssueDto, includeDisputed: boolean): boolean {
  if (includeDisputed) return true;
  return !isDisputedIssue(issue);
}

function isDisputedIssue(issue: FamilyTreeIssueDto): boolean {
  const code = issue.code as FamilyTreeGraphIssue["code"];
  return code === "missingPreferredParentSet" || code === "repeatedAncestor";
}
