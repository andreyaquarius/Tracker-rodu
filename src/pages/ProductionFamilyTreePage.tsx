import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal } from "../components/Modal";
import { GedcomImportButton, type GedcomImportArchivePayload } from "../components/GedcomImportButton";
import { CircularAncestorChartWindow } from "../components/familyTree/CircularAncestorChartWindow";
import { FamilyTreeToolsWindow } from "../components/familyTree/FamilyTreeToolsWindow";
import {
  FamilyTreeAttachPersonDialog,
  type FamilyTreeAttachAction,
  type FamilyTreeAttachCandidate,
  type FamilyTreeAttachSubmit,
} from "../components/familyTree/FamilyTreeAttachPersonDialog";
import {
  FamilyTreePersonDialog,
  type FamilyTreePartnerOption,
  type FamilyTreePersonDialogSubmit,
} from "../components/familyTree/FamilyTreePersonDialog";
import {
  FamilyTreeEmptyState,
  FamilyTreeErrorState,
  FamilyTreeLoadingState,
} from "../components/familyTree/FamilyTreeStates";
import { FamilyTreeViewport } from "../features/family-tree-view/react/FamilyTreeViewport";
import { attachTrackerPersonPhotos } from "../features/family-tree-view/adapters/trackerPersonPhotos.ts";
import { MAX_RENDERED_FAMILY_TREE_NODES } from "../features/family-tree-view/react/renderLimits";
import {
  useFamilyTreeNeighborhood,
} from "../features/family-tree-view/react/useFamilyTreeNeighborhood";
import { useProgressiveDescendantGraph } from "../features/family-tree-view/react/useProgressiveDescendantGraph";
import { buildFamilyCorridorProjection } from "../features/family-tree-view/state/familyCorridorProjection";
import { buildAllDescendantsProjection } from "../features/family-tree-view/state/allDescendantsProjection";
import {
  graphVersionsConflict,
  mergeNeighborhood,
  permissionFingerprintsConflict,
} from "../features/family-tree-view/data/neighborhoodClient";
import {
  appendFamilyCorridorTrailItem,
  capturePedigreeReturnSnapshot,
  familyTreePerspectiveKey,
  isSpecialFamilyTreePerspective,
  keepFamilyCorridorTrailThrough,
  type FamilyCorridorTrailItem,
  type FamilyTreeGenerationSettings,
  type FamilyTreePedigreeReturnSnapshot,
  type FamilyTreePerspective,
} from "../features/family-tree-view/state/familyTreePerspectiveState";
import { familyContinuationPresentationKey } from "../features/family-tree-view/react/familyContinuationLayout";
import type {
  CameraState,
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  FamilyTreeLayoutOptions,
  LayoutNode,
  OccurrenceId,
  TreeUnion,
} from "../features/family-tree-view/types";
import { useFamilyTreeMutations } from "../hooks/useFamilyTreeMutations";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails";
import {
  createFamilyTreeFromLegacyImport,
  type FamilyTreeBuilderAction,
} from "../services/familyTreeMutationService";
import { getFamilyTreeGraph } from "../services/familyTreeGraphService";
import { readLatestGedcomArchive, saveGedcomArchive } from "../services/gedcomArchiveService.ts";
import { registerGedcomImportTree } from "../services/gedcomImportOperation.ts";
import { getScanPreviewSource } from "../services/scanStorage.ts";
import {
  createTrackerNeighborhoodClient,
  readFamilyTreeEntryPoints,
  type FamilyTreeEntryPoint,
} from "../services/familyTreeNeighborhoodService";
import type {
  AppEntity,
  DocumentRecord,
  Finding,
  Person,
  PersonRelation,
  Research,
  ScanAttachment,
} from "../types";
import { moveFamilyTreeFocus, pushFamilyTreeFocus } from "../utils/familyTreeFocusHistory.ts";
import {
  DEFAULT_FAMILY_TREE_APPEARANCE,
  directLineageGroupingDepth,
  directLineagePalette,
  normalizeFamilyTreeAppearance,
  readFamilyTreeAppearance,
  writeFamilyTreeAppearance,
  type FamilyTreeAppearancePreferences,
} from "../utils/familyTreeAppearance.ts";
import { formatDateForDisplay } from "../utils/dateHelpers.ts";
import { exportFamilyTreeGraphToGedcom } from "../utils/gedcom";
import type {
  GedcomImportExecutionOptions,
  GedcomImportReconciliationPayload,
  GedcomImportReconciliationResult,
} from "../utils/gedcomImportReconciliation.ts";

const FAMILY_TREE_GEDCOM_INPUT_ID = "family-tree-tools-gedcom-input";

async function resolveFamilyTreePhotoSource(photo: ScanAttachment) {
  const source = await getScanPreviewSource(photo);
  if (source.kind !== "image") {
    if (source.revokeOnClose) URL.revokeObjectURL(source.url);
    return null;
  }
  return { url: source.url, revokeOnClose: source.revokeOnClose };
}

export interface ProductionFamilyTreePageProps {
  projectId?: string;
  persons?: Person[];
  documents?: DocumentRecord[];
  findings?: Finding[];
  researches?: Research[];
  readOnly?: boolean;
  canCreate?: boolean;
  researchRequired?: boolean;
  onImportRecords?: (
    collection: "persons",
    records: AppEntity[],
  ) => Promise<void>;
  onImportGedcom?: (
    input: GedcomImportReconciliationPayload,
    options?: GedcomImportExecutionOptions,
  ) => Promise<GedcomImportReconciliationResult | void>;
  onSaveRelation?: (
    relation: PersonRelation,
  ) => Promise<PersonRelation | null> | PersonRelation | null | void;
  onOpenPerson?: (personId: string) => void;
}

export function ProductionFamilyTreePage({
  projectId,
  persons = [],
  documents = [],
  findings = [],
  researches = [],
  readOnly = false,
  canCreate = true,
  researchRequired = false,
  onImportRecords,
  onImportGedcom,
  onSaveRelation,
  onOpenPerson,
}: ProductionFamilyTreePageProps) {
  const [entryPoints, setEntryPoints] = useState<FamilyTreeEntryPoint[]>([]);
  const [selectedTreeId, setSelectedTreeId] = useState("");
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState("");
  const [reloadRevision, setReloadRevision] = useState(0);
  const [rootDialogOpen, setRootDialogOpen] = useState(false);
  const [treeToolsOpen, setTreeToolsOpen] = useState(false);
  const [activeTreeFocusPersonId, setActiveTreeFocusPersonId] = useState("");
  const [circularChartFocusPersonId, setCircularChartFocusPersonId] = useState("");
  const [treeToolsNotice, setTreeToolsNotice] = useState("");
  const [exportingGedcom, setExportingGedcom] = useState(false);
  const [gedcomResearchId, setGedcomResearchId] = useState("");
  const [treeAppearance, setTreeAppearance] =
    useState<FamilyTreeAppearancePreferences>({
      ...DEFAULT_FAMILY_TREE_APPEARANCE,
    });
  const preferredTreeIdRef = useRef("");
  const mutations = useFamilyTreeMutations();

  useEffect(() => {
    setGedcomResearchId((current) => {
      if (current && researches.some((research) => research.id === current)) {
        return current;
      }
      return researches.length === 1 ? researches[0]!.id : "";
    });
  }, [researches]);

  useEffect(() => {
    let active = true;
    setEntryPoints([]);
    setSelectedTreeId("");
    setError("");
    if (!projectId) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void readFamilyTreeEntryPoints(projectId)
      .then((entries) => {
        if (!active) return;
        setEntryPoints(entries);
        const requestedTreeId = preferredTreeIdRef.current;
        preferredTreeIdRef.current = "";
        const preferred = entries.find((entry) => entry.id === requestedTreeId) ??
          entries.find((entry) => entry.isDefault) ??
          entries[0];
        setSelectedTreeId(preferred?.id ?? "");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити список дерев.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, reloadRevision]);

  const selectedEntry = entryPoints.find((entry) => entry.id === selectedTreeId) ??
    entryPoints.find((entry) => entry.isDefault) ??
    entryPoints[0] ??
    null;

  useEffect(() => {
    setTreeAppearance(
      projectId && selectedEntry?.id
        ? readFamilyTreeAppearance(projectId, selectedEntry.id)
        : { ...DEFAULT_FAMILY_TREE_APPEARANCE },
    );
  }, [projectId, selectedEntry?.id]);

  const updateTreeAppearance = useCallback((
    value: FamilyTreeAppearancePreferences,
  ) => {
    const normalized = normalizeFamilyTreeAppearance(value);
    setTreeAppearance(normalized);
    if (projectId && selectedEntry?.id) {
      writeFamilyTreeAppearance(projectId, selectedEntry.id, normalized);
    }
  }, [projectId, selectedEntry?.id]);
  const searchCircularAncestorFocusPersons = useCallback((query: string) => {
    const normalizedQuery = query.trim().toLocaleLowerCase("uk");
    if (!normalizedQuery) return [];
    return persons
      .filter((person) => searchablePersonText(person).includes(normalizedQuery))
      .sort((left, right) => personLabel(left).localeCompare(personLabel(right), "uk"))
      .slice(0, 12)
      .map((person) => ({
        personId: person.id,
        label: personLabel(person),
        detail: [
          formatDateForDisplay(person.birthDate) || person.birthYearFrom,
          formatDateForDisplay(person.deathDate) || person.deathYearFrom,
          person.birthPlace,
        ].filter(Boolean).join(" · "),
      }));
  }, [persons]);
  const circularChartFocusPersonLabel = useMemo(
    () => personLabel(persons.find((person) => person.id === circularChartFocusPersonId)),
    [circularChartFocusPersonId, persons],
  );

  useEffect(() => {
    setActiveTreeFocusPersonId(selectedEntry?.rootPersonId ?? "");
    setCircularChartFocusPersonId("");
  }, [selectedEntry?.id, selectedEntry?.rootPersonId]);

  async function createRoot(payload: FamilyTreePersonDialogSubmit) {
    if (!projectId || payload.action !== "create_root") return;
    const result = await mutations.createRootPersonInTree({
      projectId,
      treeId: selectedEntry?.id,
      person: payload.person,
      title: selectedEntry?.title || "Родове дерево",
    });
    if (!result) return;
    setSelectedTreeId(result.treeId);
    setRootDialogOpen(false);
    setReloadRevision((value) => value + 1);
  }

  const canImportGedcom = Boolean(
    !readOnly &&
      canCreate &&
      onImportRecords &&
      onSaveRelation,
  );

  function openTreeTools() {
    setTreeToolsNotice("");
    setTreeToolsOpen(true);
  }

  function selectGedcomFile() {
    setTreeToolsOpen(false);
    document.getElementById(FAMILY_TREE_GEDCOM_INPUT_ID)?.click();
  }

  function openCircularAncestorChart() {
    const focusPersonId = activeTreeFocusPersonId || selectedEntry?.rootPersonId || "";
    if (!focusPersonId) return;
    setTreeToolsOpen(false);
    setCircularChartFocusPersonId(focusPersonId);
  }

  async function createTreeFromGedcom(input: {
    fileName: string;
    people: Person[];
    relations: PersonRelation[];
    rootPersonId?: string;
    archive: GedcomImportArchivePayload;
    importOperationId?: string;
  }) {
    if (!projectId) return;
    const result = await createFamilyTreeFromLegacyImport({
      projectId,
      title: `GEDCOM: ${input.fileName}`,
      persons: input.people,
      relations: input.relations,
      rootPersonId: input.rootPersonId,
      rollbackOperationId: input.importOperationId,
    });
    if (!result) return;
    if (input.importOperationId) {
      // The tree is already registered by the mutation service; repeat the
      // idempotent registration here before any archive work or UI return.
      await registerGedcomImportTree(input.importOperationId, result.treeId);
    }
    preferredTreeIdRef.current = result.treeId;
    setSelectedTreeId(result.treeId);
    let archiveBatchId = "";
    try {
      const savedArchive = await saveGedcomArchive({
        projectId,
        treeId: result.treeId,
        fileName: input.fileName,
        gedcomVersion: input.archive.gedcomVersion,
        records: input.archive.records,
        personIdByXref: input.archive.personIdByXref,
        warnings: input.archive.warnings,
        rollbackOperationId: input.importOperationId,
      });
      archiveBatchId = savedArchive.batchId;
      setTreeToolsNotice(`Імпортовано дерево «GEDCOM: ${input.fileName}» і збережено повний сирий архів.`);
    } catch (archiveError) {
      console.error("GEDCOM archive persistence failed", archiveError);
      setTreeToolsNotice(
        `Імпорт «GEDCOM: ${input.fileName}» буде скасовано, бо сирий GEDCOM-архів не вдалося зберегти. ` +
          (archiveError instanceof Error ? archiveError.message : ""),
      );
      throw archiveError;
    }
    setReloadRevision((value) => value + 1);
    return { treeId: result.treeId, archiveBatchId: archiveBatchId || undefined };
  }

  async function exportGedcom() {
    if (!projectId || !selectedEntry?.id) return;
    setExportingGedcom(true);
    setTreeToolsNotice("Готуємо повний GEDCOM-файл активного дерева…");
    try {
      const exportGraph = await getFamilyTreeGraph({
        projectId,
        treeId: selectedEntry.id,
        rootPersonId: selectedEntry.rootPersonId || undefined,
        mode: "family",
        unlimitedDepth: true,
        includeAssociations: true,
        includeDisproven: true,
        includePrivateLiving: true,
        problemsMode: true,
      });
      const livingCount = exportGraph.nodes.filter((node) => node.isLiving).length;
      if (livingCount > 0) {
        const confirmed = window.confirm(
          `GEDCOM-файл міститиме ${livingCount} живих осіб. У файлі буде позначка приватності RESN privacy. Перед завантаженням на сторонній ресурс перевірте його налаштування приватності. Експортувати файл?`,
        );
        if (!confirmed) {
          setTreeToolsNotice("Експорт GEDCOM скасовано.");
          return;
        }
      }
      const result = exportFamilyTreeGraphToGedcom(exportGraph, {
        sourceName: "Трекер Роду",
        createdAt: new Date(),
        preservedRecords: (await readLatestGedcomArchive({ projectId, treeId: selectedEntry.id }))?.records,
        documents,
        findings,
      });
      downloadTextFile(
        result.text,
        "family-tree.ged",
        "text/plain;charset=utf-8",
      );
      setTreeToolsNotice(
        `GEDCOM експортовано: ${exportGraph.nodes.length} осіб.` +
          (result.warnings.length
            ? ` Попереджень: ${result.warnings.length}.`
            : ""),
      );
    } catch (exportError) {
      setTreeToolsNotice(
        exportError instanceof Error
          ? `Не вдалося експортувати GEDCOM: ${exportError.message}`
          : "Не вдалося експортувати GEDCOM.",
      );
    } finally {
      setExportingGedcom(false);
    }
  }

  if (!projectId) {
    return (
      <FamilyTreeEmptyState
        title="Проєкт не вибрано"
        description="Оберіть проєкт, щоб завантажити його родове дерево."
      />
    );
  }

  if (loading) return <FamilyTreeLoadingState />;
  if (error) {
    return (
      <FamilyTreeErrorState
        message={error}
        onRetry={() => setReloadRevision((value) => value + 1)}
      />
    );
  }

  const needsRoot = !selectedEntry?.rootPersonId;
  return (
    <>
      {needsRoot ? (
        <div className="family-tree-v2-empty-tools">
          <button
            type="button"
            className="button button-secondary family-tree-v2-tools-trigger"
            aria-haspopup="dialog"
            aria-expanded={treeToolsOpen}
            onClick={openTreeTools}
          >
            Родове дерево
            <span aria-hidden="true">⌄</span>
          </button>
        </div>
      ) : null}

      {needsRoot ? (
        <section className="panel family-tree-root-empty">
          <span className="eyebrow">Початок дерева</span>
          <h2>{selectedEntry ? "У дереві ще немає домашньої особи" : "У проєкті ще немає родового дерева"}</h2>
          <p>Створіть першу канонічну особу. Вона залишиться у звичайному модулі осіб і буде домашньою точкою дерева.</p>
          {!readOnly && canCreate ? (
            <button type="button" className="button" onClick={() => setRootDialogOpen(true)}>
              Створити першу особу
            </button>
          ) : null}
        </section>
      ) : selectedEntry ? (
        <LoadedFamilyTree
          key={selectedEntry.id}
          projectId={projectId}
          entryPoint={selectedEntry}
          persons={persons}
          readOnly={readOnly}
          canCreate={canCreate}
          appearance={treeAppearance}
          treeToolsOpen={treeToolsOpen}
          onOpenTreeTools={openTreeTools}
          onFocusPersonChange={setActiveTreeFocusPersonId}
          onOpenPerson={onOpenPerson}
        />
      ) : null}

      {canImportGedcom && onImportRecords && onSaveRelation ? (
        <GedcomImportButton
          inputId={FAMILY_TREE_GEDCOM_INPUT_ID}
          hideTrigger
          defaultResearchId={gedcomResearchId}
          researchRequired={researchRequired}
          onImportPersons={(records) => onImportRecords("persons", records)}
          onImportGedcom={onImportGedcom}
          onSaveRelation={onSaveRelation}
          onCreateFamilyTree={(input) => createTreeFromGedcom(input)}
        />
      ) : null}

      {treeToolsOpen ? (
        <FamilyTreeToolsWindow
          trees={entryPoints}
          selectedTreeId={selectedEntry?.id ?? ""}
          researches={researches}
          selectedResearchId={gedcomResearchId}
          researchRequired={researchRequired}
          canImportGedcom={canImportGedcom && (!researchRequired || Boolean(gedcomResearchId))}
          canExportGedcom={Boolean(selectedEntry?.id && selectedEntry.rootPersonId)}
          exportingGedcom={exportingGedcom}
          appearance={treeAppearance}
          notice={treeToolsNotice}
          onSelectTree={setSelectedTreeId}
          onSelectResearch={setGedcomResearchId}
          onImportGedcom={selectGedcomFile}
          onExportGedcom={() => void exportGedcom()}
          onOpenCircularChart={openCircularAncestorChart}
          onAppearanceChange={updateTreeAppearance}
          onClose={() => setTreeToolsOpen(false)}
        />
      ) : null}

      {selectedEntry?.id && circularChartFocusPersonId ? (
        <CircularAncestorChartWindow
          key={selectedEntry.id}
          treeId={selectedEntry.id}
          focusPersonId={circularChartFocusPersonId}
          focusPersonLabel={circularChartFocusPersonLabel}
          searchFocusPersons={searchCircularAncestorFocusPersons}
          onFocusPersonChange={setCircularChartFocusPersonId}
          onOpenPerson={onOpenPerson}
          onClose={() => setCircularChartFocusPersonId("")}
        />
      ) : null}

      {rootDialogOpen ? (
        <FamilyTreePersonDialog
          key="create-root"
          action="create_root"
          targetName=""
          partnerOptions={[]}
          isSaving={mutations.isMutating}
          error={mutations.error}
          onClose={() => setRootDialogOpen(false)}
          onSubmit={(payload) => void createRoot(payload)}
        />
      ) : null}
    </>
  );
}

function LoadedFamilyTree({
  projectId,
  entryPoint,
  persons,
  readOnly,
  canCreate,
  appearance,
  treeToolsOpen,
  onOpenTreeTools,
  onFocusPersonChange,
  onOpenPerson,
}: {
  projectId: string;
  entryPoint: FamilyTreeEntryPoint;
  persons: Person[];
  readOnly: boolean;
  canCreate: boolean;
  appearance: FamilyTreeAppearancePreferences;
  treeToolsOpen: boolean;
  onOpenTreeTools: () => void;
  onFocusPersonChange: (personId: string) => void;
  onOpenPerson?: (personId: string) => void;
}) {
  const client = useMemo(() => createTrackerNeighborhoodClient(), []);
  const homePersonId = entryPoint.rootPersonId!;
  const [focusHistory, setFocusHistory] = useState([homePersonId]);
  const [focusIndex, setFocusIndex] = useState(0);
  const focusPersonId = focusHistory[focusIndex] ?? homePersonId;
  useEffect(() => {
    onFocusPersonChange(focusPersonId);
  }, [focusPersonId, onFocusPersonChange]);
  const [ancestorDepth, setAncestorDepth] = useState(7);
  const [descendantDepth, setDescendantDepth] = useState(0);
  const [collateralDepth, setCollateralDepth] = useState(0);
  const maxNodes = 400;
  const [showAllParentSets, setShowAllParentSets] = useState(false);
  const [activeParentSetByChild, setActiveParentSetByChild] = useState<Record<string, string>>({});
  const [selectedPersonId, setSelectedPersonId] = useState(focusPersonId);
  const [searchQuery, setSearchQuery] = useState("");
  const [relativeMenuPersonId, setRelativeMenuPersonId] = useState("");
  const [builderTarget, setBuilderTarget] = useState<{ action: FamilyTreeBuilderAction; personId: string } | null>(null);
  const [attachTarget, setAttachTarget] = useState<{ action: FamilyTreeAttachAction; personId: string } | null>(null);
  const [anchorOccurrenceId, setAnchorOccurrenceId] = useState<string>();
  const [layoutWarnings, setLayoutWarnings] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [perspective, setPerspective] = useState<FamilyTreePerspective>({
    kind: "pedigree",
  });
  const [familyContinuationOwnerByScope, setFamilyContinuationOwnerByScope] =
    useState<ReadonlyMap<string, string>>(() => new Map());
  const cameraSnapshotsRef = useRef(new Map<string, CameraState>());
  const perspectiveSessionRef = useRef(0);
  const corridorExpansionSessionsRef = useRef(new Set<string>());
  const perspectiveRef = useRef(perspective);
  perspectiveRef.current = perspective;
  const focusPersonIdRef = useRef(focusPersonId);
  focusPersonIdRef.current = focusPersonId;
  const shellRef = useRef<HTMLElement>(null);
  const perspectiveBarRef = useRef<HTMLDivElement>(null);
  const viewSettingsRef = useDismissibleDetails();
  const mutations = useFamilyTreeMutations();
  const pedigreeNeighborhood = useFamilyTreeNeighborhood({
    client,
    treeId: entryPoint.id,
    focusPersonId,
    ancestorDepth,
    descendantDepth,
    collateralDepth,
    maxNodes,
    sessionKey: "pedigree",
    defaultVisibleFamilyPersonId: focusPersonId,
    includeCousinDescendantsByDefault:
      appearance.showCousinDescendantsByDefault,
  });
  const specialFocusPersonId = perspective.kind === "family-corridor"
    ? perspective.returnTo.focusPersonId
    : perspective.kind === "all-descendants"
      ? perspective.rootPersonId
      : homePersonId;
  const specialSettings = perspective.kind === "family-corridor"
    ? perspective.returnTo.generationSettings
    : undefined;
  const progressiveInitialGraph = useMemo<FamilyGraphData | undefined>(() => {
    if (perspective.kind !== "all-descendants") return undefined;
    const snapshot = perspective.returnTo.pedigreeGraph;
    const root = snapshot.persons.find(person =>
      person.id === perspective.rootPersonId
    );
    if (!root) return undefined;
    return {
      persons: [root],
      unions: [],
      parentChildRelations: [],
      continuations: [],
      familyContinuations: [],
      graphVersion: snapshot.graphVersion,
      permissionFingerprint: snapshot.permissionFingerprint,
    };
  }, [perspective]);
  const specialNeighborhood = useFamilyTreeNeighborhood({
    client,
    treeId: entryPoint.id,
    focusPersonId: specialFocusPersonId,
    enabled: perspective.kind === "family-corridor",
    sessionKey: perspective.kind === "pedigree"
      ? "special-idle"
      : perspective.sessionId,
    ancestorDepth: perspective.kind === "family-corridor"
      ? specialSettings?.ancestorDepth ?? 7
      : 0,
    descendantDepth: specialSettings?.descendantDepth ?? 0,
    collateralDepth: perspective.kind === "family-corridor"
      ? specialSettings?.collateralDepth ?? 0
      : 0,
    maxNodes,
    permissionFingerprint: perspective.kind === "pedigree"
      ? undefined
      : perspective.returnTo.permissionFingerprint,
  });
  const progressiveDescendants = useProgressiveDescendantGraph({
    client,
    treeId: entryPoint.id,
    rootPersonId: perspective.kind === "all-descendants"
      ? perspective.rootPersonId
      : homePersonId,
    enabled: perspective.kind === "all-descendants",
    sessionKey: perspective.kind === "all-descendants"
      ? perspective.sessionId
      : "all-descendants-idle",
    pageSize: 200,
    maxGenerations: 100,
    initialGraph: progressiveInitialGraph,
    knownGraphVersion: perspective.kind === "all-descendants"
      ? perspective.returnTo.graphVersion
      : undefined,
    permissionFingerprint: perspective.kind === "all-descendants"
      ? perspective.returnTo.permissionFingerprint
      : undefined,
  });
  const neighborhood = perspective.kind === "pedigree"
    ? pedigreeNeighborhood
    : specialNeighborhood;

  const pedigreeGraph = pedigreeNeighborhood.graph;
  const corridorSessionGraph = useMemo(() => {
    const specialGraph = perspective.kind === "all-descendants"
      ? progressiveDescendants.graph
      : specialNeighborhood.graph;
    if (perspective.kind !== "family-corridor") return specialGraph;
    if (!specialGraph.persons.length) {
      return perspective.returnTo.pedigreeGraph;
    }
    const snapshotGraph = perspective.returnTo.pedigreeGraph;
    if (
      graphVersionsConflict(
        snapshotGraph.graphVersion,
        specialGraph.graphVersion,
      ) ||
      permissionFingerprintsConflict(
        snapshotGraph.permissionFingerprint,
        specialGraph.permissionFingerprint,
      )
    ) {
      return specialGraph;
    }
    // This creates an isolated session seed. It never writes the composed
    // result back into the long-lived pedigree neighborhood store.
    return mergeNeighborhood(snapshotGraph, {
      ...specialGraph,
      continuations: specialGraph.continuations ?? [],
    });
  }, [perspective, specialNeighborhood.graph]);
  const graph = perspective.kind === "pedigree"
    ? pedigreeGraph
    : perspective.kind === "family-corridor"
      ? corridorSessionGraph
      : progressiveDescendants.graph;
  const activeNestedFamilyScopes = useMemo(() => {
    if (perspective.kind !== "family-corridor") return [];
    const activeScopeIds = new Set(specialNeighborhood.activeFamilyScopeIds);
    const scopes = new Map<string, FamilyScope>();
    for (const continuation of graph.familyContinuations ?? []) {
      if (
        continuation.scope.id !== perspective.scope.id &&
        activeScopeIds.has(continuation.scope.id)
      ) {
        scopes.set(continuation.scope.id, continuation.scope);
      }
    }
    return [...scopes.values()].map(scope => ({
      familyKey: scope.id,
      familyGroupId: scope.familyGroupId,
      parentIds: scope.parentIds,
      unionIds: scope.unionIds,
    }));
  }, [graph.familyContinuations, perspective, specialNeighborhood.activeFamilyScopeIds]);
  const corridorProjection = useMemo(() => {
    if (perspective.kind !== "family-corridor") return undefined;
    return buildFamilyCorridorProjection({
      graph,
      selectedFamily: {
        familyKey: perspective.scope.id,
        familyGroupId: perspective.scope.familyGroupId,
        parentIds: perspective.scope.parentIds,
        unionIds: perspective.scope.unionIds,
      },
      originalFocusPersonId: perspective.returnTo.focusPersonId,
      activeNestedFamilies: activeNestedFamilyScopes,
    });
  }, [activeNestedFamilyScopes, graph, perspective]);
  const allDescendantsProjection = useMemo(
    () => perspective.kind === "all-descendants"
      ? buildAllDescendantsProjection({
          graph,
          rootPersonId: perspective.rootPersonId,
          originalFocusPersonId: perspective.returnTo.focusPersonId,
        })
      : undefined,
    [graph, perspective],
  );
  const displayedGraphWithoutPhotos = perspective.kind === "pedigree"
    ? pedigreeGraph
    : perspective.kind === "family-corridor"
      ? corridorProjection?.graph ?? graph
      : allDescendantsProjection?.graph ?? graph;
  const displayedGraph = useMemo(
    () => attachTrackerPersonPhotos(displayedGraphWithoutPhotos, persons),
    [displayedGraphWithoutPhotos, persons],
  );
  const layoutFocusPersonId = perspective.kind === "pedigree"
    ? focusPersonId
    : perspective.kind === "family-corridor"
      ? corridorProjection?.perspectiveFocusPersonId ?? perspective.returnTo.focusPersonId
      : perspective.rootPersonId;
  const lineageTargetPersonId = perspective.kind === "all-descendants"
    ? allDescendantsProjection?.focusLineagePersonIds.includes(
        perspective.returnTo.focusPersonId,
      )
      ? perspective.returnTo.focusPersonId
      : perspective.rootPersonId
    : layoutFocusPersonId;
  const lineagePalette = useMemo(
    () => directLineagePalette(appearance),
    [appearance],
  );
  const perspectiveKey = familyTreePerspectiveKey(perspective, focusPersonId);
  const corridorBreadcrumbs = useMemo(
    () => perspective.kind === "family-corridor"
      ? perspective.trail.map((item, index) => ({
          index,
          item,
          label: familyScopeLabel(graph, item.scope),
        }))
      : [],
    [graph, perspective],
  );
  const corridorLabel = corridorBreadcrumbs.at(-1)?.label ?? "Вибрана сім’я";
  const allDescendantsLabel = useMemo(() => {
    if (perspective.kind !== "all-descendants") return "";
    return (
      displayedGraph.persons.find(person => person.id === perspective.rootPersonId)
        ?.displayName ??
      perspective.returnTo.pedigreeGraph.persons.find(
        person => person.id === perspective.rootPersonId,
      )?.displayName ??
      "Особа"
    );
  }, [displayedGraph.persons, perspective]);
  const allDescendantsTruncated = perspective.kind === "all-descendants" &&
    !progressiveDescendants.loading &&
    progressiveDescendants.loadedGenerations >= 100;
  const rememberCamera = useCallback((camera: CameraState) => {
    cameraSnapshotsRef.current.set(perspectiveKey, camera);
  }, [perspectiveKey]);
  // The logical descendants graph may contain thousands of people. Scene
  // construction therefore gets a graph-derived occurrence budget, while the
  // viewport independently keeps at most 600 interactive items mounted.
  const logicalSceneNodeBudget = perspective.kind === "all-descendants"
    ? Math.max(
        MAX_RENDERED_FAMILY_TREE_NODES,
        displayedGraph.persons.length +
          displayedGraph.parentChildRelations.length * 2 +
          displayedGraph.unions.length * 2 +
          32,
      )
    : MAX_RENDERED_FAMILY_TREE_NODES;
  const layoutOptions = useMemo<FamilyTreeLayoutOptions>(() => ({
    focusPersonId: layoutFocusPersonId,
    layoutMode: perspective.kind === "all-descendants"
      ? "descendant-forest"
      : "family-graph",
    ancestorDepth: MAX_RENDERED_FAMILY_TREE_NODES,
    descendantDepth: MAX_RENDERED_FAMILY_TREE_NODES,
    collateralDepth: MAX_RENDERED_FAMILY_TREE_NODES,
    maxVisibleNodes: logicalSceneNodeBudget,
    lineageTargetPersonId,
    lineageGroupDepth: directLineageGroupingDepth(
      appearance.directLineageGrouping,
    ),
    showAllParentSets,
    // The footer already exposes the complete add-relative menu. Rendering a
    // second dashed plus on the canvas duplicates that action and crowds the
    // branch controls, especially on compact and touch layouts.
    showUnknownParentPlaceholders: false,
    activeParentSetByChild,
    ...(perspective.kind === "all-descendants"
      ? {
          primaryLineagePersonIds:
            allDescendantsProjection?.focusLineagePersonIds ?? [],
        }
      : {}),
  }), [
    activeParentSetByChild,
    allDescendantsProjection?.focusLineagePersonIds,
    appearance.directLineageGrouping,
    layoutFocusPersonId,
    lineageTargetPersonId,
    logicalSceneNodeBudget,
    perspective.kind,
    showAllParentSets,
  ]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (perspective.kind === "pedigree") return;
    perspectiveBarRef.current?.focus({ preventScroll: true });
  }, [perspectiveKey, perspective.kind]);

  function generationSettings(): FamilyTreeGenerationSettings {
    return {
      ancestorDepth,
      descendantDepth,
      collateralDepth,
      showAllParentSets,
      activeParentSetByChild,
    };
  }

  function nextPerspectiveSessionId(
    kind: Exclude<FamilyTreePerspective["kind"], "pedigree">,
  ): string {
    perspectiveSessionRef.current += 1;
    return `${kind}:${perspectiveSessionRef.current}`;
  }

  function captureCurrentPedigreeSnapshot(): FamilyTreePedigreeReturnSnapshot {
    const pedigreeKey = familyTreePerspectiveKey(
      { kind: "pedigree" },
      focusPersonId,
    );
    return capturePedigreeReturnSnapshot({
      treeId: entryPoint.id,
      graph: pedigreeGraph,
      focusHistory,
      focusIndex,
      branchVisibility: pedigreeNeighborhood.captureBranchVisibility(),
      camera: cameraSnapshotsRef.current.get(pedigreeKey),
      selectedPersonId,
      generationSettings: generationSettings(),
      familyContinuationOwners: familyContinuationOwnerByScope,
    });
  }

  function restorePedigreeSnapshot(
    snapshot: FamilyTreePedigreeReturnSnapshot,
    forceReload = false,
  ) {
    const restoreResult = snapshot.treeId === entryPoint.id
      ? pedigreeNeighborhood.restoreBranchVisibility(snapshot.branchVisibility)
      : "stale-scope";
    setFocusHistory([...snapshot.focusHistory]);
    setFocusIndex(snapshot.focusIndex);
    setAncestorDepth(snapshot.generationSettings.ancestorDepth);
    setDescendantDepth(snapshot.generationSettings.descendantDepth);
    setCollateralDepth(snapshot.generationSettings.collateralDepth);
    setShowAllParentSets(snapshot.generationSettings.showAllParentSets);
    setActiveParentSetByChild({
      ...snapshot.generationSettings.activeParentSetByChild,
    });
    setSelectedPersonId(
      snapshot.pedigreeGraph.persons.some(
        person => person.id === snapshot.selectedPersonId,
      )
        ? snapshot.selectedPersonId
        : snapshot.focusPersonId,
    );
    setFamilyContinuationOwnerByScope(
      new Map(snapshot.familyContinuationOwners),
    );
    if (snapshot.camera) {
      cameraSnapshotsRef.current.set(
        familyTreePerspectiveKey(
          { kind: "pedigree" },
          snapshot.focusPersonId,
        ),
        { ...snapshot.camera },
      );
    }
    setPerspective({ kind: "pedigree" });
    setAnchorOccurrenceId(undefined);
    if (forceReload || restoreResult !== "restored") {
      pedigreeNeighborhood.reload();
    }
    return restoreResult;
  }

  function leaveSpecialPerspective() {
    if (!isSpecialFamilyTreePerspective(perspective)) return;
    if (perspective.kind === "family-corridor") {
      corridorExpansionSessionsRef.current.delete(perspective.sessionId);
    }
    const specialGraph = specialNeighborhood.graph;
    const graphIdentityChanged = Boolean(specialGraph.persons.length) && (
      graphVersionsConflict(
        perspective.returnTo.graphVersion,
        specialGraph.graphVersion,
      ) ||
      permissionFingerprintsConflict(
        perspective.returnTo.permissionFingerprint,
        specialGraph.permissionFingerprint,
      )
    );
    restorePedigreeSnapshot(perspective.returnTo, graphIdentityChanged);
  }

  function reloadPedigreeAfterMutation() {
    if (isSpecialFamilyTreePerspective(perspective)) {
      restorePedigreeSnapshot(perspective.returnTo, true);
    } else {
      pedigreeNeighborhood.reload();
    }
  }

  function enterAllDescendants(rootPersonId: string) {
    if (!rootPersonId) return;
    const returnTo = isSpecialFamilyTreePerspective(perspective)
      ? perspective.returnTo
      : captureCurrentPedigreeSnapshot();
    setPerspective({
      kind: "all-descendants",
      sessionId: nextPerspectiveSessionId("all-descendants"),
      rootPersonId,
      returnTo,
    });
    setSelectedPersonId(rootPersonId);
    setFamilyContinuationOwnerByScope(new Map());
    setAnchorOccurrenceId(undefined);
    setNotice("");
  }

  useEffect(() => {
    if (perspective.kind !== "family-corridor") return;
    if (
      specialNeighborhood.loading ||
      specialNeighborhood.canceled ||
      specialNeighborhood.error ||
      !graph.persons.length ||
      corridorExpansionSessionsRef.current.has(perspective.sessionId)
    ) {
      return;
    }
    const requestedKey = familyContinuationPresentationKey({
      id: `requested:${perspective.scope.id}`,
      scope: perspective.scope,
      token: `requested:${perspective.scope.id}`,
    });
    const continuation = (graph.familyContinuations ?? []).find(
      candidate =>
        candidate.scope.id === perspective.scope.id ||
        familyContinuationPresentationKey(candidate) === requestedKey,
    ) ?? perspective.continuation;
    if (
      continuation.expanded ||
      specialNeighborhood.activeFamilyScopeIds.includes(continuation.scope.id)
    ) {
      corridorExpansionSessionsRef.current.add(perspective.sessionId);
      return;
    }
    corridorExpansionSessionsRef.current.add(perspective.sessionId);
    if (continuation.scope.id !== perspective.scope.id) {
      setPerspective(current =>
        current.kind === "family-corridor" &&
        current.sessionId === perspective.sessionId
          ? {
              ...current,
              scope: continuation.scope,
              continuation,
              trail: current.trail.length
                ? [
                    {
                      ...current.trail[0]!,
                      scope: continuation.scope,
                      continuation,
                    },
                    ...current.trail.slice(1),
                  ]
                : [{
                    scope: continuation.scope,
                    continuation,
                    ...(current.ownerPersonId
                      ? { ownerPersonId: current.ownerPersonId }
                      : {}),
                  }],
            }
          : current,
      );
      if (perspective.ownerPersonId) {
        setFamilyContinuationOwnerByScope(
          new Map([[continuation.scope.id, perspective.ownerPersonId]]),
        );
      }
    }
    const prospective = buildFamilyCorridorProjection({
      graph,
      selectedFamily: {
        familyKey: continuation.scope.id,
        familyGroupId: continuation.scope.familyGroupId,
        parentIds: continuation.scope.parentIds,
        unionIds: continuation.scope.unionIds,
      },
      originalFocusPersonId: perspective.returnTo.focusPersonId,
    });
    void specialNeighborhood
      .expandFamilyContinuation(
        continuation,
        new Set(prospective.graph.persons.map(person => person.id)),
      )
      .then(result => {
        const current = perspectiveRef.current;
        if (
          current.kind !== "family-corridor" ||
          current.sessionId !== perspective.sessionId
        ) {
          return;
        }
        if (result !== "expanded") {
          corridorExpansionSessionsRef.current.delete(perspective.sessionId);
        }
        if (result === "failed") {
          setNotice("Не вдалося відкрити дітей цієї сім’ї.");
        }
      });
  }, [
    graph,
    perspective,
    specialNeighborhood.activeFamilyScopeIds,
    specialNeighborhood.canceled,
    specialNeighborhood.error,
    specialNeighborhood.expandFamilyContinuation,
    specialNeighborhood.loading,
  ]);

  function leaveFamilyCorridor() {
    leaveSpecialPerspective();
    setNotice("");
  }

  function selectCorridorBreadcrumb(index: number) {
    const current = perspectiveRef.current;
    if (current.kind !== "family-corridor") return;
    const nextTrail = keepFamilyCorridorTrailThrough(current.trail, index);
    const target = nextTrail.at(-1);
    if (!target || nextTrail.length === current.trail.length) return;

    const removedItems = current.trail.slice(nextTrail.length);
    for (const item of removedItems) {
      specialNeighborhood.collapseFamilyScope(item.scope.id);
    }
    const removedScopeIds = new Set(
      removedItems.map(item => item.scope.id),
    );
    setFamilyContinuationOwnerByScope(owners => {
      const next = new Map(owners);
      for (const scopeId of removedScopeIds) next.delete(scopeId);
      return next;
    });
    setPerspective(value =>
      value.kind === "family-corridor" &&
      value.sessionId === current.sessionId
        ? { ...value, trail: nextTrail }
        : value,
    );
    if (target.ownerPersonId) setSelectedPersonId(target.ownerPersonId);
    setAnchorOccurrenceId(target.anchorOccurrenceId);
    setNotice(`Повернуто до покоління ${nextTrail.length}: ${familyScopeLabel(graph, target.scope)}.`);
  }

  function changeFocus(personId: string) {
    if (!personId || personId === focusPersonId) return;
    if (isSpecialFamilyTreePerspective(perspective)) {
      restorePedigreeSnapshot(perspective.returnTo);
    }
    const next = pushFamilyTreeFocus(focusHistory, focusIndex, personId);
    setPerspective({ kind: "pedigree" });
    setFamilyContinuationOwnerByScope(new Map());
    setFocusHistory(next.history);
    setFocusIndex(next.index);
    setSelectedPersonId(personId);
    setSearchQuery("");
    setAnchorOccurrenceId(undefined);
  }

  function moveFocusHistoryBy(delta: -1 | 1) {
    if (isSpecialFamilyTreePerspective(perspective)) return;
    const next = moveFamilyTreeFocus(focusHistory, focusIndex, delta);
    if (next.index === focusIndex) return;
    const nextPersonId = focusHistory[next.index] ?? homePersonId;
    setPerspective({ kind: "pedigree" });
    setFamilyContinuationOwnerByScope(new Map());
    setFocusIndex(next.index);
    setSelectedPersonId(nextPersonId);
    setSearchQuery("");
    setAnchorOccurrenceId(undefined);
  }

  function visiblePersonIdsForFamily(
    continuation: FamilyContinuation,
  ): ReadonlySet<string> {
    if (isSpecialFamilyTreePerspective(perspective)) {
      return new Set(displayedGraph.persons.map(person => person.id));
    }
    const prospectiveCorridor = buildFamilyCorridorProjection({
      graph,
      selectedFamily: {
        familyKey: continuation.scope.id,
        familyGroupId: continuation.scope.familyGroupId,
        parentIds: continuation.scope.parentIds,
        unionIds: continuation.scope.unionIds,
      },
      originalFocusPersonId: focusPersonId,
    });
    return new Set(prospectiveCorridor.graph.persons.map(person => person.id));
  }

  async function toggleFamilyContinuation(
    continuation: FamilyContinuation,
    anchorOccurrenceId?: OccurrenceId,
    ownerPersonId?: string,
  ) {
    const requestSessionId = isSpecialFamilyTreePerspective(perspective)
      ? perspective.sessionId
      : undefined;
    const activeOwnerPersonId =
      ownerPersonId ?? continuation.scope.parentIds[0];
    const openedTrailItem: FamilyCorridorTrailItem = {
      scope: continuation.scope,
      continuation,
      ...(activeOwnerPersonId
        ? { ownerPersonId: activeOwnerPersonId }
        : {}),
      ...(anchorOccurrenceId ? { anchorOccurrenceId } : {}),
    };
    if (activeOwnerPersonId) {
      setFamilyContinuationOwnerByScope(current => {
        const next = new Map(current);
        next.set(continuation.scope.id, activeOwnerPersonId);
        return next;
      });
    }
    const forgetActiveOwner = () => {
      setFamilyContinuationOwnerByScope(current => {
        if (!current.has(continuation.scope.id)) return current;
        const next = new Map(current);
        next.delete(continuation.scope.id);
        return next;
      });
    };
    setAnchorOccurrenceId(anchorOccurrenceId);
    const visiblePersonIds = visiblePersonIdsForFamily(continuation);
    if (perspective.kind === "pedigree") {
      const returnTo = captureCurrentPedigreeSnapshot();
      setPerspective({
        kind: "family-corridor",
        sessionId: nextPerspectiveSessionId("family-corridor"),
        scope: continuation.scope,
        continuation,
        ...(activeOwnerPersonId
          ? { ownerPersonId: activeOwnerPersonId }
          : {}),
        trail: [openedTrailItem],
        returnTo,
      });
      if (activeOwnerPersonId) {
        setSelectedPersonId(activeOwnerPersonId);
      }
      setFamilyContinuationOwnerByScope(
        activeOwnerPersonId
          ? new Map([[continuation.scope.id, activeOwnerPersonId]])
          : new Map(),
      );
      setNotice("");
      return;
    }

    const result = await neighborhood.expandFamilyContinuation(
      continuation,
      visiblePersonIds,
    );
    if (requestSessionId) {
      const current = perspectiveRef.current;
      if (
        !isSpecialFamilyTreePerspective(current) ||
        current.sessionId !== requestSessionId
      ) {
        return;
      }
    }
    if (result === "expanded") {
      const current = perspectiveRef.current;
      if (
        current.kind === "family-corridor" &&
        (!requestSessionId || current.sessionId === requestSessionId)
      ) {
        const existingIndex = current.trail.findIndex(
          item => item.scope.id === openedTrailItem.scope.id,
        );
        const parentIndex = existingIndex >= 0
          ? existingIndex - 1
          : familyCorridorParentTrailIndex(
              graph,
              current.trail,
              openedTrailItem.ownerPersonId,
            );
        const prefix = parentIndex >= 0
          ? keepFamilyCorridorTrailThrough(current.trail, parentIndex)
          : [];
        const removedItems = current.trail
          .slice(prefix.length)
          .filter(item => item.scope.id !== openedTrailItem.scope.id);
        for (const item of removedItems) {
          neighborhood.collapseFamilyScope(item.scope.id);
        }
        const removedScopeIds = new Set(
          removedItems.map(item => item.scope.id),
        );
        setFamilyContinuationOwnerByScope(owners => {
          const next = new Map(owners);
          for (const scopeId of removedScopeIds) next.delete(scopeId);
          if (openedTrailItem.ownerPersonId) {
            next.set(
              openedTrailItem.scope.id,
              openedTrailItem.ownerPersonId,
            );
          }
          return next;
        });
        const nextTrail = appendFamilyCorridorTrailItem(
          prefix,
          openedTrailItem,
        );
        setPerspective(value =>
          value.kind === "family-corridor" &&
          value.sessionId === current.sessionId
            ? { ...value, trail: nextTrail }
            : value,
        );
      }
      setNotice("Дітей цієї пари відкрито; дерево перебудовано без сторонніх гілок.");
    } else if (result === "collapsed") {
      const current = perspectiveRef.current;
      if (current.kind === "family-corridor") {
        const collapsedIndex = current.trail.findIndex(
          item => item.scope.id === continuation.scope.id,
        );
        if (collapsedIndex >= 0) {
          const keepCount = collapsedIndex === 0 ? 1 : collapsedIndex;
          const removedItems = current.trail.slice(keepCount);
          for (const item of removedItems) {
            if (item.scope.id !== continuation.scope.id) {
              neighborhood.collapseFamilyScope(item.scope.id);
            }
          }
          const removedScopeIds = new Set(
            removedItems.map(item => item.scope.id),
          );
          setFamilyContinuationOwnerByScope(owners => {
            const next = new Map(owners);
            for (const scopeId of removedScopeIds) next.delete(scopeId);
            return next;
          });
          setPerspective(value =>
            value.kind === "family-corridor" &&
            value.sessionId === current.sessionId
              ? { ...value, trail: value.trail.slice(0, keepCount) }
              : value,
          );
        } else {
          forgetActiveOwner();
        }
      } else {
        forgetActiveOwner();
      }
      setNotice("Дітей цієї пари приховано.");
    } else if (result === "failed") {
      forgetActiveOwner();
      setNotice("Не вдалося змінити сімейну гілку.");
    } else if (result === "aborted") {
      forgetActiveOwner();
      setNotice("Завантаження сімейної гілки зупинено.");
    }
  }

  function togglePersonBranches(personId: string, occurrenceId: string) {
    const willExpand = neighborhood.collapsedBranchPersonIds.includes(personId);
    setAnchorOccurrenceId(occurrenceId);
    neighborhood.togglePersonBranches(personId);
    setNotice(
      willExpand
        ? "Раніше відкриті додаткові гілки особи розгорнуто."
        : "Відкриті додаткові гілки особи згорнуто.",
    );
  }

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase("uk");
  const searchResults = useMemo(() => {
    if (!normalizedSearch) return [];
    return persons
      .filter((person) => searchablePersonText(person).includes(normalizedSearch))
      .sort((left, right) => personLabel(left).localeCompare(personLabel(right), "uk"))
      .slice(0, 12);
  }, [normalizedSearch, persons]);

  const parentSetOptions = useMemo(() => parentSetsForChild(graph, focusPersonId), [focusPersonId, graph]);
  const targetPersonId = builderTarget?.personId ?? attachTarget?.personId ?? relativeMenuPersonId;
  const targetName = graph.persons.find((person) => person.id === targetPersonId)?.displayName ??
    personLabel(persons.find((person) => person.id === targetPersonId));
  const partnerOptions = useMemo(
    () => partnershipOptionsForPerson(graph, targetPersonId),
    [graph, targetPersonId],
  );
  const attachCandidates = useMemo<FamilyTreeAttachCandidate[]>(() => persons
    .filter((person) => person.id !== targetPersonId)
    .map((person) => ({
      personId: person.id,
      label: personLabel(person),
      detail: [formatDateForDisplay(person.birthDate), person.birthPlace].filter(Boolean).join(" · "),
    })), [persons, targetPersonId]);

  async function submitRelative(payload: FamilyTreePersonDialogSubmit) {
    if (!builderTarget) return;
    const base = { projectId, treeId: entryPoint.id, person: payload.person };
    let result: string | null = null;
    if (payload.action === "add_father" || payload.action === "add_mother" || payload.action === "add_parent") {
      result = await mutations.addParentToPerson({
        ...base,
        childId: builderTarget.personId,
        parentIntent: payload.action === "add_father" ? "father" : payload.action === "add_mother" ? "mother" : "parent",
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "add_partner") {
      result = await mutations.addPartnerToPerson({
        ...base,
        personId: builderTarget.personId,
        relationshipType: payload.partnerRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "add_child") {
      result = await mutations.addChildToPerson({
        ...base,
        parentId: builderTarget.personId,
        secondParentId: payload.secondParentId,
        familyGroupId: payload.familyGroupId,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "add_sibling") {
      result = await mutations.addSiblingToPerson({
        ...base,
        personId: builderTarget.personId,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    }
    if (!result) return;
    setBuilderTarget(null);
    setNotice("Родича створено й приєднано до дерева.");
    reloadPedigreeAfterMutation();
  }

  async function submitAttach(payload: FamilyTreeAttachSubmit) {
    if (!attachTarget) return;
    const base = { projectId, treeId: entryPoint.id };
    let result: string | null = null;
    if (payload.action === "attach_parent") {
      result = await mutations.attachExistingParentToPerson({
        ...base,
        childId: attachTarget.personId,
        parentId: payload.existingPersonId,
        parentIntent: payload.parentIntent,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "attach_partner") {
      result = await mutations.attachExistingPartnerToPerson({
        ...base,
        personId: attachTarget.personId,
        partnerId: payload.existingPersonId,
        relationshipType: payload.partnerRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    } else if (payload.action === "attach_child") {
      result = await mutations.attachExistingChildToPerson({
        ...base,
        parentId: attachTarget.personId,
        childId: payload.existingPersonId,
        secondParentId: payload.secondParentId,
        familyGroupId: payload.familyGroupId,
        relationshipType: payload.parentRelationshipType,
        evidenceStatus: payload.evidenceStatus,
      });
    }
    if (!result) return;
    setAttachTarget(null);
    setNotice("Наявну особу приєднано до дерева.");
    reloadPedigreeAfterMutation();
  }

  async function expandContinuation(token: string, node: LayoutNode) {
    const requestFocusPersonId = focusPersonId;
    const requestSessionId = isSpecialFamilyTreePerspective(perspective)
      ? perspective.sessionId
      : undefined;
    const requestIsCurrent = () => {
      if (!requestSessionId) {
        return perspectiveRef.current.kind === "pedigree" &&
          focusPersonIdRef.current === requestFocusPersonId;
      }
      const current = perspectiveRef.current;
      return isSpecialFamilyTreePerspective(current) &&
        current.sessionId === requestSessionId;
    };
    // Anchor the owning person card, not the temporary continuation button.
    // The button can disappear or receive another occurrence id after the
    // branch is composed, while the card remains stable across both expansion
    // and collapse. This lets the viewport compensate every layout reflow.
    setAnchorOccurrenceId(node.sourceOccurrenceId ?? node.occurrenceId);
    if (token.startsWith("local:")) {
      if (node.continuation?.expanded) {
        await neighborhood.expandContinuation(token, node);
        if (!requestIsCurrent()) return;
        setNotice("Гілку приховано. Повторне натискання відновить її без нового запиту.");
        return;
      }
      if (token.endsWith(":other-parent-sets")) {
        setShowAllParentSets(true);
        setNotice("Показано всі вже завантажені набори батьків цієї особи.");
        return;
      }
      setNotice(
        "Досягнуто межу поточного перегляду. Зробіть цю особу фокусною, щоб продовжити її гілку.",
      );
      return;
    }
    await neighborhood.expandContinuation(token, node);
    if (!requestIsCurrent()) return;
    setNotice("Гілку розгорнуто.");
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await shellRef.current?.requestFullscreen();
    }
  }

  const specialPerspectiveActive = isSpecialFamilyTreePerspective(perspective);
  const activeLoading = perspective.kind === "all-descendants"
    ? progressiveDescendants.loading
    : neighborhood.loading;
  const activeError = perspective.kind === "all-descendants"
    ? progressiveDescendants.error
    : neighborhood.error;
  const activeReload = perspective.kind === "all-descendants"
    ? progressiveDescendants.reload
    : neighborhood.reload;
  const specialPerspectiveLoadedPersons = perspective.kind === "all-descendants"
    ? progressiveDescendants.loadedPersons
    : specialNeighborhood.graph.persons.length;

  if (
    perspective.kind === "pedigree" &&
    neighborhood.loading &&
    !graph.persons.length
  ) {
    return <FamilyTreeLoadingState />;
  }
  if (
    perspective.kind === "pedigree" &&
    neighborhood.error &&
    !graph.persons.length
  ) {
    return <FamilyTreeErrorState message={neighborhood.error.message} onRetry={neighborhood.reload} />;
  }

  return (
    <section
      ref={shellRef}
      className="family-tree-v2-shell"
      aria-busy={activeLoading}
    >
      <div className="panel family-tree-v2-host-toolbar" role="toolbar" aria-label="Параметри родового дерева">
        <button
          type="button"
          className="button button-secondary family-tree-v2-tools-trigger"
          title={`Родове дерево: ${entryPoint.title || "без назви"}`}
          aria-haspopup="dialog"
          aria-expanded={treeToolsOpen}
          onClick={onOpenTreeTools}
        >
          Родове дерево
          <span aria-hidden="true">⌄</span>
        </button>
        <div className="family-tree-v2-history" aria-label="Історія фокусу">
          <button type="button" className="button button-secondary" disabled={specialPerspectiveActive || focusIndex <= 0} onClick={() => moveFocusHistoryBy(-1)}>
            ← Назад
          </button>
          <button type="button" className="button button-secondary" disabled={specialPerspectiveActive || focusIndex >= focusHistory.length - 1} onClick={() => moveFocusHistoryBy(1)}>
            Вперед →
          </button>
          <button type="button" className="button button-secondary" disabled={specialPerspectiveActive || focusPersonId === homePersonId} onClick={() => changeFocus(homePersonId)}>
            Домашня особа
          </button>
        </div>

        <label className="family-tree-v2-search">
          <span>Знайти особу</span>
          <input
            type="search"
            value={searchQuery}
            placeholder="Ім’я, прізвище, рік або місце"
            aria-label="Знайти особу"
            aria-expanded={Boolean(normalizedSearch)}
            aria-controls="family-tree-v2-search-results"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {normalizedSearch ? (
            <div id="family-tree-v2-search-results" className="family-tree-v2-search-results" role="listbox">
              {searchResults.length ? searchResults.map((person) => (
                <button key={person.id} type="button" role="option" aria-selected={person.id === focusPersonId} onClick={() => changeFocus(person.id)}>
                  <strong>{personLabel(person)}</strong>
                  <small>{[
                    formatDateForDisplay(person.birthDate),
                    person.birthPlace,
                  ].filter(Boolean).join(" · ") || "Без дат"}</small>
                </button>
              )) : <div>Збігів не знайдено</div>}
            </div>
          ) : null}
        </label>

        <details ref={viewSettingsRef} className="family-tree-v2-view-settings">
          <summary className="button button-secondary" aria-controls="family-tree-v2-view-settings-panel">Параметри</summary>
          <div id="family-tree-v2-view-settings-panel" className="family-tree-v2-view-settings-panel">
        <label>
          <span>Предків</span>
          <input type="number" min={0} value={ancestorDepth} disabled={specialPerspectiveActive} onChange={(event) => setAncestorDepth(nonNegativeInteger(event.target.value, 7))} />
        </label>
        <label>
          <span>Нащадків</span>
          <input type="number" min={0} value={descendantDepth} disabled={specialPerspectiveActive} onChange={(event) => setDescendantDepth(nonNegativeInteger(event.target.value, 0))} />
        </label>
        <label className="checkbox-line">
          <input type="checkbox" checked={collateralDepth > 0} disabled={specialPerspectiveActive} onChange={(event) => setCollateralDepth(event.target.checked ? 1 : 0)} />
          <span>Показати бічні гілки зараз</span>
        </label>
        <label className="checkbox-line">
          <input type="checkbox" checked={showAllParentSets} disabled={specialPerspectiveActive} onChange={(event) => setShowAllParentSets(event.target.checked)} />
          <span>Усі набори батьків</span>
        </label>
        {parentSetOptions.length > 1 ? (
          <label>
            <span>Активний набір батьків</span>
            <select
              disabled={specialPerspectiveActive}
              value={activeParentSetByChild[focusPersonId] ?? parentSetOptions[0]?.id ?? ""}
              onChange={(event) => setActiveParentSetByChild((current) => ({ ...current, [focusPersonId]: event.target.value }))}
            >
              {parentSetOptions.map((parentSet, index) => (
                <option key={parentSet.id} value={parentSet.id}>{parentSetLabel(parentSet, index)}</option>
              ))}
            </select>
          </label>
        ) : null}
          </div>
        </details>
        <button type="button" className="button button-secondary family-tree-v2-fullscreen" onClick={() => void toggleFullscreen()}>
          {isFullscreen ? "Згорнути" : "На весь екран"}
        </button>
        <button type="button" className="button button-secondary family-tree-v2-reload" disabled={activeLoading} onClick={activeReload}>
          {activeLoading ? "Оновлення…" : "Оновити"}
        </button>
      </div>

      {notice || activeError || layoutWarnings.length ? (
        <div className="family-tree-v2-status-strip">
          {notice ? <div className="family-tree-v2-notice" role="status">{notice}</div> : null}
          {activeError ? <div className="form-error" role="alert">{activeError.message}</div> : null}
          {layoutWarnings.length ? (
            <details className="family-tree-v2-warnings">
              <summary>Попередження схеми: {layoutWarnings.length}</summary>
              <ul>{layoutWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {perspective.kind === "family-corridor" ? (
        <>
          <div
            ref={perspectiveBarRef}
            className="family-tree-v2-perspective-bar family-tree-v2-perspective-bar-compact"
            role="region"
            aria-label="Режим лінії нащадків"
            tabIndex={-1}
          >
            <strong className="family-tree-v2-perspective-heading">
              Лінія нащадків: <span>{corridorLabel}</span>
            </strong>
            <SpecialPerspectiveProgress
              compact
              loading={specialNeighborhood.loading}
              canceled={specialNeighborhood.canceled}
              error={specialNeighborhood.error}
              loadedPersons={specialPerspectiveLoadedPersons}
              mountedNodeLimit={MAX_RENDERED_FAMILY_TREE_NODES}
            />
            <div className="family-tree-v2-perspective-actions">
              {specialNeighborhood.loading ? (
                <button type="button" className="button button-secondary" onClick={specialNeighborhood.cancel}>
                  Зупинити
                </button>
              ) : null}
              <button
                type="button"
                className="button button-secondary"
                aria-label="Повернутися до родового дерева"
                title="Повернутися до родового дерева"
                onClick={leaveFamilyCorridor}
              >
                ← До дерева
              </button>
            </div>
          </div>
          <nav
            className="family-tree-v2-corridor-breadcrumbs"
            aria-label="Відкриті покоління сімейного коридору"
          >
            <ol>
              <li>
                <button type="button" onClick={leaveFamilyCorridor}>
                  Родове дерево
                </button>
              </li>
              {corridorBreadcrumbs.map(({ index, item, label }) => {
                const current = index === corridorBreadcrumbs.length - 1;
                return (
                  <li key={item.scope.id}>
                    <span aria-hidden="true">›</span>
                    <button
                      type="button"
                      aria-current={current ? "page" : undefined}
                      disabled={current}
                      onClick={() => selectCorridorBreadcrumb(index)}
                    >
                      Покоління {index + 1}: {label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </>
      ) : null}

      {perspective.kind === "all-descendants" ? (
        <div
          ref={perspectiveBarRef}
          className="family-tree-v2-perspective-bar family-tree-v2-perspective-bar-compact"
          role="region"
          aria-label="Режим усіх нащадків"
          tabIndex={-1}
        >
          <strong className="family-tree-v2-perspective-heading">
            Нащадки: <span>{allDescendantsLabel}</span>
          </strong>
          <SpecialPerspectiveProgress
            compact
            loading={progressiveDescendants.loading}
            canceled={progressiveDescendants.canceled}
            error={progressiveDescendants.error}
            loadedPersons={specialPerspectiveLoadedPersons}
            loadedGenerations={progressiveDescendants.loadedGenerations}
            pagesLoaded={progressiveDescendants.pagesLoaded}
            mountedNodeLimit={MAX_RENDERED_FAMILY_TREE_NODES}
            truncated={allDescendantsTruncated}
          />
          <div className="family-tree-v2-perspective-actions">
            {progressiveDescendants.loading ? (
              <button type="button" className="button button-secondary" onClick={progressiveDescendants.cancel}>
                Зупинити
              </button>
            ) : null}
            <button
              type="button"
              className="button button-secondary"
              aria-label="Повернутися до родового дерева"
              title="Повернутися до родового дерева"
              onClick={leaveFamilyCorridor}
            >
              ← До дерева
            </button>
          </div>
        </div>
      ) : null}

      {specialPerspectiveActive && (
        perspective.kind === "all-descendants"
          ? progressiveDescendants.canceled
          : specialNeighborhood.canceled
      ) && !graph.persons.length ? (
        <section className="panel family-tree-state" role="status">
          <span className="eyebrow">Завантаження зупинено</span>
          <h2>Спеціальний режим призупинено</h2>
          <p>Можна продовжити завантаження або повернутися до базового родового дерева.</p>
          <button type="button" className="button button-secondary" onClick={activeReload}>
            Продовжити завантаження
          </button>
        </section>
      ) : specialPerspectiveActive && activeLoading && !graph.persons.length ? (
        <FamilyTreeLoadingState />
      ) : specialPerspectiveActive && activeError && !graph.persons.length ? (
        <FamilyTreeErrorState
          message={activeError.message}
          onRetry={activeReload}
        />
      ) : (
      <FamilyTreeViewport
        key={perspectiveKey}
        className="family-tree-v2-viewport"
        graph={displayedGraph}
        options={layoutOptions}
        lineageColor={appearance.directLineageColor}
        lineagePalette={lineagePalette}
        maxRenderedNodes={MAX_RENDERED_FAMILY_TREE_NODES}
        initialCamera={cameraSnapshotsRef.current.get(perspectiveKey)}
        onCameraChange={rememberCamera}
        selectedPersonId={selectedPersonId}
        preserveAnchorOccurrenceId={anchorOccurrenceId}
        onOpenPerson={(personId) => {
          setSelectedPersonId(personId);
          onOpenPerson?.(personId);
        }}
        onShowAllDescendants={(personId) => enterAllDescendants(personId)}
        onFocusPerson={changeFocus}
        branchTogglePersonIds={new Set(neighborhood.branchTogglePersonIds)}
        collapsedBranchPersonIds={new Set(neighborhood.collapsedBranchPersonIds)}
        onTogglePersonBranches={togglePersonBranches}
        familyContinuationOwnerByScope={familyContinuationOwnerByScope}
        onToggleFamilyContinuation={(continuation, occurrenceId, ownerPersonId) => {
          void toggleFamilyContinuation(
            continuation,
            occurrenceId,
            ownerPersonId,
          );
        }}
        onAddRelative={!readOnly && canCreate ? (personId) => {
          mutations.resetError();
          setRelativeMenuPersonId(personId);
        } : undefined}
        onExpandContinuation={(token, node) => void expandContinuation(token, node)}
        onLayoutWarnings={setLayoutWarnings}
        resolvePhotoSource={resolveFamilyTreePhotoSource}
      />
      )}

      {relativeMenuPersonId ? (
        <RelativeMenu
          targetName={targetName}
          onClose={() => setRelativeMenuPersonId("")}
          onCreate={(action) => {
            setBuilderTarget({ action, personId: relativeMenuPersonId });
            setRelativeMenuPersonId("");
          }}
          onAttach={(action) => {
            setAttachTarget({ action, personId: relativeMenuPersonId });
            setRelativeMenuPersonId("");
          }}
        />
      ) : null}
      {builderTarget ? (
        <FamilyTreePersonDialog
          key={`${builderTarget.action}:${builderTarget.personId}`}
          action={builderTarget.action}
          targetName={targetName}
          partnerOptions={partnerOptions}
          isSaving={mutations.isMutating}
          error={mutations.error}
          onClose={() => setBuilderTarget(null)}
          onSubmit={(payload) => void submitRelative(payload)}
        />
      ) : null}
      {attachTarget ? (
        <FamilyTreeAttachPersonDialog
          key={`${attachTarget.action}:${attachTarget.personId}`}
          action={attachTarget.action}
          targetName={targetName}
          candidates={attachCandidates}
          partnerOptions={partnerOptions}
          isSaving={mutations.isMutating}
          error={mutations.error}
          onClose={() => setAttachTarget(null)}
          onSubmit={(payload) => void submitAttach(payload)}
        />
      ) : null}
    </section>
  );
}

function SpecialPerspectiveProgress({
  compact = false,
  loading,
  canceled,
  error,
  loadedPersons,
  loadedGenerations,
  pagesLoaded,
  mountedNodeLimit,
  truncated = false,
}: {
  compact?: boolean;
  loading: boolean;
  canceled: boolean;
  error?: Error;
  loadedPersons: number;
  loadedGenerations?: number;
  pagesLoaded?: number;
  mountedNodeLimit: number;
  truncated?: boolean;
}) {
  const status = loading
    ? `Завантажено ${loadedPersons} · фонове завантаження триває`
    : canceled
      ? `Завантажено ${loadedPersons} · завантаження зупинено`
      : error
        ? "Завантаження завершилося помилкою"
        : truncated
          ? `Показано ${loadedPersons} осіб із завантаженої частини гілки`
          : `Завантажено ${loadedPersons}`;

  if (compact) {
    return <span className="visually-hidden" aria-live="polite">{status}</span>;
  }

  return (
    <div className="family-tree-v2-perspective-progress" aria-live="polite">
      {loading ? (
        <progress aria-label="Завантаження спеціального режиму дерева" />
      ) : (
        <progress
          aria-label={canceled ? "Завантаження зупинено" : "Завантаження завершено"}
          value={canceled || error ? 0 : 1}
          max={1}
        />
      )}
      <span>{status}</span>
      {loadedGenerations !== undefined || pagesLoaded !== undefined ? (
        <small>
          Поколінь завершено: {loadedGenerations ?? 0} · пакетів отримано: {pagesLoaded ?? 0}.
        </small>
      ) : null}
      <small>Одночасно монтується не більше {mountedNodeLimit} елементів.</small>
    </div>
  );
}

function RelativeMenu({
  targetName,
  onClose,
  onCreate,
  onAttach,
}: {
  targetName: string;
  onClose: () => void;
  onCreate: (action: Exclude<FamilyTreeBuilderAction, "create_root">) => void;
  onAttach: (action: FamilyTreeAttachAction) => void;
}) {
  const createActions: Array<[Exclude<FamilyTreeBuilderAction, "create_root">, string]> = [
    ["add_father", "Додати батька"],
    ["add_mother", "Додати матір"],
    ["add_parent", "Додати одного з батьків"],
    ["add_partner", "Додати партнера"],
    ["add_child", "Додати дитину"],
    ["add_sibling", "Додати брата або сестру"],
  ];
  return (
    <Modal
      title={`Додати родича${targetName ? ` для ${targetName}` : ""}`}
      className="family-tree-relative-modal"
      onClose={onClose}
      mode="dialog"
    >
      <div className="family-tree-v2-relative-menu">
        <p>Створити нову канонічну особу</p>
        <div className="family-tree-v2-relative-grid">
          {createActions.map(([action, label]) => (
            <button key={action} type="button" className="button button-secondary" onClick={() => onCreate(action)}>{label}</button>
          ))}
        </div>
        <p>Приєднати особу, яка вже є у проєкті</p>
        <div className="family-tree-v2-relative-grid">
          <button type="button" className="button button-secondary" onClick={() => onAttach("attach_parent")}>Приєднати як одного з батьків</button>
          <button type="button" className="button button-secondary" onClick={() => onAttach("attach_partner")}>Приєднати як партнера</button>
          <button type="button" className="button button-secondary" onClick={() => onAttach("attach_child")}>Приєднати як дитину</button>
        </div>
      </div>
    </Modal>
  );
}

function familyScopeLabel(graph: FamilyGraphData, scope: FamilyScope): string {
  const namesById = new Map(graph.persons.map(person => [person.id, person.displayName]));
  const names = scope.parentIds
    .map(personId => namesById.get(personId))
    .filter((name): name is string => Boolean(name));
  if (names.length >= 2) return names.slice(0, 2).join(" + ");
  return names[0] ?? "Вибрана сім’я";
}

function familyCorridorParentTrailIndex(
  graph: FamilyGraphData,
  trail: readonly FamilyCorridorTrailItem[],
  ownerPersonId: string | undefined,
): number {
  if (!trail.length) return -1;
  if (!ownerPersonId) return trail.length - 1;
  const ownerParentIds = new Set(
    graph.parentChildRelations
      .filter(relation => relation.childId === ownerPersonId)
      .map(relation => relation.parentId),
  );
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    if (trail[index]!.scope.parentIds.some(parentId => ownerParentIds.has(parentId))) {
      return index;
    }
  }
  return trail.length - 1;
}

function partnershipOptionsForPerson(graph: FamilyGraphData, personId: string): FamilyTreePartnerOption[] {
  if (!personId) return [];
  const people = new Map(graph.persons.map((person) => [person.id, person]));
  const result = new Map<string, FamilyTreePartnerOption>();
  for (const union of graph.unions) {
    if (union.kind !== "partnership" || !union.memberIds.includes(personId)) continue;
    for (const partnerId of union.memberIds) {
      if (partnerId === personId) continue;
      result.set(partnerId, {
        personId: partnerId,
        label: people.get(partnerId)?.displayName ?? "Особа",
        familyGroupId: null,
      });
    }
  }
  return [...result.values()].sort((left, right) => left.label.localeCompare(right.label, "uk"));
}

function parentSetsForChild(graph: FamilyGraphData, childId: string): TreeUnion[] {
  const unionIds = new Set(
    graph.parentChildRelations
      .filter((relation) => relation.childId === childId && relation.unionId?.startsWith("parent-set:"))
      .map((relation) => relation.unionId!),
  );
  return graph.unions
    .filter((union) => union.kind === "parent-set" && unionIds.has(union.id))
    .sort((left, right) => Number(Boolean(right.isDefaultForPedigree)) - Number(Boolean(left.isDefaultForPedigree)) ||
      Number(Boolean(right.isPreferredForDisplay)) - Number(Boolean(left.isPreferredForDisplay)) ||
      (left.displayOrder ?? "").localeCompare(right.displayOrder ?? "") ||
      left.id.localeCompare(right.id));
}

function parentSetLabel(parentSet: TreeUnion, index: number): string {
  const kind: Record<string, string> = {
    biological: "Біологічні батьки",
    genetic: "Генетичні батьки",
    birth_or_gestational: "Батьки народження / гестаційні",
    adoptive: "Усиновлювачі",
    foster: "Прийомні батьки",
    step: "Зведені батьки",
    guardian: "Опікуни",
    social: "Соціальні батьки",
    legal: "Юридичні батьки",
    unknown: "Невідомий набір батьків",
    other: "Інший набір батьків",
  };
  const suffix = parentSet.isDefaultForPedigree ? " · основний" : parentSet.isPreferredForDisplay ? " · бажаний" : "";
  return `${kind[parentSet.parentSetType ?? ""] ?? `Набір батьків ${index + 1}`}${suffix}`;
}

function searchablePersonText(person: Person): string {
  return [
    personLabel(person),
    person.birthDate,
    formatDateForDisplay(person.birthDate),
    person.birthPlace,
    person.deathDate,
    formatDateForDisplay(person.deathDate),
    person.deathPlace,
  ].filter(Boolean).join(" ").toLocaleLowerCase("uk");
}

function personLabel(person: Person | undefined): string {
  if (!person) return "Особа";
  return person.fullName?.trim() ||
    [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ").trim() ||
    "Особа";
}

function nonNegativeInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function downloadTextFile(
  text: string,
  fileName: string,
  mimeType: string,
): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
