import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AppDatabase,
  AppEntity,
  ArchiveRequest,
  CustomFieldDefinition,
  Finding,
  Hypothesis,
  Person,
  PersonRelation,
  Research,
  ScanAttachment,
  TaskRecord,
} from "../../types";
import type { PageKey } from "../../components/Sidebar";
import { TableDataImportButton } from "../../components/TableDataImportButton";
import { GedcomImportButton } from "../../components/GedcomImportButton";
import { exportPersonsToExcel } from "../../utils/excelExport";
import type {
  GedcomImportExecutionOptions,
  GedcomImportReconciliationPayload,
  GedcomImportReconciliationResult,
} from "../../utils/gedcomImportReconciliation.ts";
import type {
  GedcomPhotoBackupPlan,
  GedcomPhotoBackupProgress,
  GedcomPhotoBackupResult,
} from "../../services/gedcomPhotoBackup.ts";
import { createFamilyTreeFromLegacyImport } from "../../services/familyTreeMutationService";
import { registerGedcomImportTree } from "../../services/gedcomImportOperation.ts";
import {
  emptyPersonLinkedRecords,
  listPersonLinkedRecords,
  type PersonLinkedRecords,
} from "../../services/projectPersonLinkedRecords.ts";
import { listProjectDocumentsByIds } from "../../services/projectDocuments";
import {
  loadProjectPersonSummaries,
  type ProjectPersonSummary,
} from "../../services/projectPersonSummaries.ts";
import {
  loadProjectPersonPedigreeOrder,
  readCachedProjectPersonPedigreeOrder,
  type ProjectPersonPedigreeContext,
  type ProjectPersonPedigreeOrder,
} from "../../services/projectPersonPedigreeOrder.ts";
import { getScanPreviewSource } from "../../services/scanStorage";
import {
  isPhotoReferenceAvailable,
  primaryPersonPhoto,
} from "../../utils/personPhotos.ts";
import {
  type PersonRouteTarget,
  type PersonSaveHandler,
} from "./contracts";
import { PersonsCatalogV2 } from "./PersonsCatalogV2";
import { PersonPreviewDrawerV2 } from "./PersonPreviewDrawerV2";
import { PersonProfileV2 } from "./PersonProfileV2";
import { PersonEditorV2 } from "./PersonEditorV2";
import { buildPersonTimeline, personDisplayName as personDisplayNameForDeleteV2 } from "./model";
import {
  relatedRecordDraftForPerson,
  type PersonCreatableRelatedPage,
} from "../../utils/personRelatedRecordDrafts.ts";
import {
  buildGedcomImportGroups,
  type GedcomImportDatasetMarker,
  type GedcomImportGroup,
} from "../../utils/gedcomImportGroups.ts";
import { GedcomImportManagerV2 } from "./GedcomImportManagerV2.tsx";
import { listProjectGedcomImportDatasets } from "../../services/projectPeople.ts";

export interface PersonsModuleV2Props {
  db: AppDatabase;
  projectId?: string;
  persons: Person[];
  relations: PersonRelation[];
  researches: Research[];
  findings: Finding[];
  tasks: TaskRecord[];
  hypotheses: Hypothesis[];
  archiveRequests: ArchiveRequest[];
  initialSearch?: string;
  target: PersonRouteTarget;
  onNavigate: (target: PersonRouteTarget, options?: { replace?: boolean }) => void;
  onShowInTree?: (person: Person) => void;
  onOpenMap?: (person: Person) => void;
  onOpenPhoto?: (photo: ScanAttachment, photos: readonly ScanAttachment[]) => void;
  onSavePerson: PersonSaveHandler;
  onDeletePersons?: (personIds: readonly string[]) => Promise<void>;
  onDeleteGedcomImport?: (group: GedcomImportGroup) => Promise<void>;
  onImportRecords: (collection: "persons", records: AppEntity[]) => Promise<void>;
  onImportGedcom?: (
    input: GedcomImportReconciliationPayload,
    options?: GedcomImportExecutionOptions,
  ) => Promise<GedcomImportReconciliationResult | void>;
  onBackupGedcomPhotos?: (
    plan: GedcomPhotoBackupPlan,
    onProgress: (progress: GedcomPhotoBackupProgress) => void,
  ) => Promise<GedcomPhotoBackupResult>;
  onSaveRelation: (
    relation: PersonRelation,
  ) => Promise<PersonRelation | null> | PersonRelation | null | void;
  onOpenRelated: (page: PageKey, entityId: string, entity?: AppEntity) => void;
  onNavigateRelated?: (page: PageKey) => void;
  onCreateRelated?: (
    page: PersonCreatableRelatedPage,
    initialValues: Record<string, unknown>,
  ) => void;
  customFieldDefinitions?: CustomFieldDefinition[];
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  canAddCustomField?: boolean;
  customFieldLimitMessage?: string;
  readOnly?: boolean;
  canCreate?: boolean;
  canCreateTree?: boolean;
  canImportTable?: boolean;
  onSubscriptionChanged?: () => void;
  projectName?: string;
  researchRequired?: boolean;
  canUseGedcom?: boolean;
  directAncestorIds?: ReadonlySet<string>;
  pedigreeContext?: ProjectPersonPedigreeContext;
  pedigreeCacheScope?: string;
}

interface PersonDetailBundle extends PersonLinkedRecords {
  documents: AppDatabase["documents"];
  loading: boolean;
  error: string;
}

const emptyDetailBundle: PersonDetailBundle = {
  ...emptyPersonLinkedRecords(),
  documents: [],
  loading: false,
  error: "",
};
const emptyPersonFamilyOrder: ReadonlyMap<string, number> = new Map();
const emptyPersonIdSet: ReadonlySet<string> = new Set();

export function PersonsModuleV2({
  db,
  projectId,
  persons,
  relations,
  researches,
  findings,
  tasks,
  hypotheses,
  archiveRequests,
  initialSearch = "",
  target,
  onNavigate,
  onShowInTree,
  onOpenMap,
  onOpenPhoto,
  onSavePerson,
  onDeletePersons,
  onDeleteGedcomImport,
  onImportRecords,
  onImportGedcom,
  onBackupGedcomPhotos,
  onSaveRelation,
  onOpenRelated,
  onNavigateRelated,
  onCreateRelated,
  customFieldDefinitions = [],
  onAddCustomField,
  onDeleteCustomField,
  canAddCustomField = true,
  customFieldLimitMessage,
  readOnly = false,
  canCreate = true,
  canCreateTree = true,
  canImportTable = true,
  onSubscriptionChanged,
  projectName = "Трекер Роду",
  researchRequired = false,
  canUseGedcom = false,
  directAncestorIds,
  pedigreeContext,
  pedigreeCacheScope = "",
}: PersonsModuleV2Props) {
  const [previewPersonId, setPreviewPersonId] = useState("");
  const [deletingPersons, setDeletingPersons] = useState(false);
  const [gedcomDatasetMarkers, setGedcomDatasetMarkers] = useState<GedcomImportDatasetMarker[]>([]);
  const detailPersonId = target.personId || previewPersonId;
  const detailPerson = persons.find((person) => person.id === detailPersonId) ?? null;
  const routePerson = persons.find((person) => person.id === target.personId) ?? null;
  const [detail, setDetail] = useState<PersonDetailBundle>(emptyDetailBundle);
  const localSummaries = useMemo(
    () => buildLocalPersonSummaries(persons, relations, findings, tasks, hypotheses, archiveRequests),
    [archiveRequests, findings, hypotheses, persons, relations, tasks],
  );
  const [remoteSummaries, setRemoteSummaries] = useState<Map<string, ProjectPersonSummary> | null>(null);
  const summaries = remoteSummaries ?? localSummaries;
  const selectedPhotoUrl = usePersonPhotoUrl(detailPerson);
  const gedcomImportGroups = useMemo(
    () => buildGedcomImportGroups(persons, relations, findings, gedcomDatasetMarkers),
    [findings, gedcomDatasetMarkers, persons, relations],
  );
  const pedigreeTreeId = pedigreeContext?.treeId ?? "";
  const pedigreeRootPersonId = pedigreeContext?.rootPersonId ?? "";
  const pedigreeRequestKey = [
    projectId ?? "",
    pedigreeCacheScope,
    pedigreeTreeId,
    pedigreeRootPersonId,
  ].join("\u001f");
  const cachedPedigree = projectId
    ? readCachedProjectPersonPedigreeOrder(projectId, pedigreeContext, pedigreeCacheScope)
    : null;
  const [pedigreeLoad, setPedigreeLoad] = useState<{
    requestKey: string;
    status: "loading" | "ready" | "unavailable";
    value?: ProjectPersonPedigreeOrder;
  } | null>(null);
  const currentPedigreeLoad = pedigreeLoad?.requestKey === pedigreeRequestKey
    ? pedigreeLoad
    : cachedPedigree
      ? { requestKey: pedigreeRequestKey, status: "ready" as const, value: cachedPedigree }
      : null;
  const currentPedigree = currentPedigreeLoad?.status === "ready"
    ? currentPedigreeLoad.value ?? null
    : null;
  const canonicalPedigree = currentPedigree?.familyOrder.size ? currentPedigree : null;
  const effectiveDirectAncestorIds = directAncestorIds
    ?? canonicalPedigree?.directAncestorIds
    ?? emptyPersonIdSet;
  const familyOrder = canonicalPedigree?.familyOrder ?? emptyPersonFamilyOrder;
  const familyOrderStatus: "loading" | "ready" | "unavailable" = canonicalPedigree
    ? "ready"
    : currentPedigreeLoad?.status === "unavailable" || currentPedigreeLoad?.status === "ready"
      ? "unavailable"
      : "loading";

  const loadGedcomDatasetMarkers = useCallback(async (): Promise<GedcomImportDatasetMarker[]> => {
    if (!projectId || !canUseGedcom) {
      return [];
    }
    try {
      return await listProjectGedcomImportDatasets(projectId);
    } catch {
      // Entity provenance remains a compatible fallback while the migration
      // is rolling out to hosted projects.
      return [];
    }
  }, [canUseGedcom, projectId]);

  useEffect(() => {
    let active = true;
    void loadGedcomDatasetMarkers().then((markers) => {
      if (active) setGedcomDatasetMarkers(markers);
    });
    return () => {
      active = false;
    };
  }, [loadGedcomDatasetMarkers]);

  useEffect(() => {
    if (previewPersonId && !persons.some((person) => person.id === previewPersonId)) {
      setPreviewPersonId("");
    }
  }, [persons, previewPersonId]);

  useEffect(() => {
    if (!projectId) {
      setPedigreeLoad({ requestKey: pedigreeRequestKey, status: "unavailable" });
      return;
    }
    const context = pedigreeTreeId || pedigreeRootPersonId
      ? { treeId: pedigreeTreeId, rootPersonId: pedigreeRootPersonId }
      : undefined;
    const cached = readCachedProjectPersonPedigreeOrder(projectId, context, pedigreeCacheScope);
    if (cached) {
      setPedigreeLoad((current) => (
        current?.requestKey === pedigreeRequestKey
        && current.status === "ready"
        && current.value === cached
          ? current
          : { requestKey: pedigreeRequestKey, status: "ready", value: cached }
      ));
      return;
    }
    const controller = new AbortController();
    setPedigreeLoad({ requestKey: pedigreeRequestKey, status: "loading" });
    void loadProjectPersonPedigreeOrder(projectId, context, {
      signal: controller.signal,
      cacheScope: pedigreeCacheScope,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setPedigreeLoad({ requestKey: pedigreeRequestKey, status: "ready", value });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
        setPedigreeLoad({ requestKey: pedigreeRequestKey, status: "unavailable" });
    });
    return () => controller.abort();
  }, [pedigreeCacheScope, pedigreeRequestKey, pedigreeRootPersonId, pedigreeTreeId, projectId]);

  useEffect(() => {
    if (!projectId) {
      setRemoteSummaries(null);
      return;
    }
    let active = true;
    setRemoteSummaries(null);
    void loadProjectPersonSummaries(projectId)
      .then((value) => {
        if (active) setRemoteSummaries(value);
      })
      .catch(() => {
        // The V2 UI remains usable while the summary migration is being rolled
        // out; current in-memory records are the conservative fallback.
        if (active) setRemoteSummaries(null);
      });
    return () => {
      active = false;
    };
  }, [archiveRequests, findings, hypotheses, persons, projectId, relations, tasks]);

  useEffect(() => {
    if (!detailPersonId) {
      setDetail(emptyDetailBundle);
      return;
    }
    let active = true;
    setDetail({ ...emptyDetailBundle, loading: true });
    const load = async (): Promise<PersonDetailBundle> => {
      const linked = projectId
        ? await listPersonLinkedRecords(projectId, detailPersonId)
        : linkedRecordsFromMemory(detailPersonId, findings, tasks, hypotheses, archiveRequests);
      const documentIds = linkedDocumentIds(linked);
      const documents = projectId
        ? await listProjectDocumentsByIds(projectId, documentIds)
        : db.documents.filter((document) => documentIds.includes(document.id));
      return { ...linked, documents, loading: false, error: "" };
    };
    void load()
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const linked = linkedRecordsFromMemory(
          detailPersonId,
          findings,
          tasks,
          hypotheses,
          archiveRequests,
        );
        const documentIds = linkedDocumentIds(linked);
        setDetail({
          ...linked,
          documents: db.documents.filter((document) => documentIds.includes(document.id)),
          loading: false,
          error: error instanceof Error
            ? error.message
            : "Не вдалося завантажити пов’язані матеріали.",
        });
      });
    return () => {
      active = false;
    };
  }, [archiveRequests, db.documents, detailPersonId, findings, hypotheses, projectId, tasks]);

  if (target.mode === "edit" || target.mode === "new") {
    if (readOnly || (target.mode === "new" && !canCreate)) {
      return (
        <UnavailablePersonEditorV2
          reason={readOnly ? "read-only" : "create-disabled"}
          onBack={() => onNavigate(
            routePerson
              ? { mode: "profile", personId: routePerson.id }
              : { mode: "list" },
          )}
        />
      );
    }
    if (target.mode === "edit" && !routePerson) {
      return <MissingPersonV2 onBack={() => onNavigate({ mode: "list" })} />;
    }
    return (
      <PersonEditorV2
        db={db}
        person={target.mode === "new" ? null : routePerson}
        researches={researches}
        researchRequired={researchRequired}
        customFieldDefinitions={customFieldDefinitions}
        onAddCustomField={onAddCustomField}
        onDeleteCustomField={onDeleteCustomField}
        canAddCustomField={canAddCustomField}
        customFieldLimitMessage={customFieldLimitMessage}
        onSave={onSavePerson}
        onCancel={() => onNavigate(
          routePerson
            ? { mode: "profile", personId: routePerson.id }
            : { mode: "list" },
        )}
        onOpenProfile={(person) => onNavigate({ mode: "profile", personId: person.id })}
        onPersisted={(person) => onNavigate(
          { mode: "edit", personId: person.id },
          { replace: true },
        )}
      />
    );
  }

  if (target.mode === "profile") {
    if (!routePerson) return <MissingPersonV2 onBack={() => onNavigate({ mode: "list" })} />;
    const research = researches.find((item) => item.id === routePerson.researchId) ?? null;
    return (
      <>
        {detail.loading ? <PersonDetailNoticeV2>Завантажуємо пов’язані матеріали…</PersonDetailNoticeV2> : null}
        {detail.error ? <PersonDetailNoticeV2 error>{detail.error}</PersonDetailNoticeV2> : null}
        <PersonProfileV2
          person={routePerson}
          research={research}
          persons={persons}
          relations={relations}
          documents={detail.documents}
          findings={detail.findings}
          tasks={detail.tasks}
          hypotheses={detail.hypotheses}
          archiveRequests={detail.archiveRequests}
          photoUrl={selectedPhotoUrl}
          photoUrlForPerson={safeExternalPhotoUrl}
          directAncestor={effectiveDirectAncestorIds.has(routePerson.id)}
          onBack={() => onNavigate({ mode: "list" })}
          onEdit={readOnly ? undefined : (person) => onNavigate({ mode: "edit", personId: person.id })}
          onDelete={!readOnly && onDeletePersons && !deletingPersons
            ? (person) => void deleteOnePerson(person)
            : undefined}
          onShowInTree={onShowInTree}
          onOpenMap={onOpenMap}
          onOpenPhoto={onOpenPhoto}
          onAddEvent={readOnly ? undefined : (person) => onNavigate({ mode: "edit", personId: person.id })}
          onOpenPerson={(person) => onNavigate({ mode: "profile", personId: person.id })}
          onOpenRelated={(page, record) => onOpenRelated(page, record.id, record)}
          onBrowseRelated={onNavigateRelated}
          onCreateRelated={!readOnly && onCreateRelated
            ? (page, person) => onCreateRelated(
                page,
                relatedRecordDraftForPerson(page, person),
              )
            : undefined}
        />
      </>
    );
  }

  if (familyOrderStatus === "loading") {
    return (
      <section className="panel empty-state persons-v2-pedigree-loading" role="status">
        <strong>Готуємо список осіб…</strong>
        <p>Застосовуємо збережений порядок від кореневої особи родового дерева.</p>
      </section>
    );
  }

  const headerActions: ReactNode = (
    <>
      {!readOnly && canCreate && canImportTable ? (
        <TableDataImportButton
          collection="persons"
          db={db}
          fields={[]}
          customFieldDefinitions={customFieldDefinitions}
          onImport={(records) => onImportRecords("persons", records)}
        />
      ) : null}
      {!readOnly && canUseGedcom ? (
        <GedcomImportButton
          key={`persons-v2-gedcom-import:${projectId ?? "local"}`}
          disabled={!canCreate || !canCreateTree || gedcomImportGroups.length > 0}
          defaultResearchId={researches.length === 1 ? researches[0].id : ""}
          researchRequired={researchRequired}
          onImportPersons={(records) => onImportRecords("persons", records)}
          onImportGedcom={onImportGedcom}
          onImportCompleted={async () => {
            setGedcomDatasetMarkers(await loadGedcomDatasetMarkers());
          }}
          onBackupGedcomPhotos={onBackupGedcomPhotos}
          onSaveRelation={onSaveRelation}
          onCreateFamilyTree={projectId ? async ({ fileName, people, relations: importedRelations, rootPersonId, importSourceKey, importOperationId }) => {
            const result = await createFamilyTreeFromLegacyImport({
              projectId,
              title: `GEDCOM: ${fileName}`,
              persons: people,
              relations: importedRelations,
              rootPersonId,
              importSourceKey,
              rollbackOperationId: importOperationId,
            });
            if (result && importOperationId) {
              await registerGedcomImportTree(importOperationId, result.treeId);
            }
            if (result) onSubscriptionChanged?.();
            return result ? { treeId: result.treeId } : undefined;
          } : undefined}
        />
      ) : null}
      {canUseGedcom && onDeleteGedcomImport ? (
        <GedcomImportManagerV2
          groups={gedcomImportGroups}
          canDelete={!readOnly && !deletingPersons}
          onDelete={async (group) => {
            await onDeleteGedcomImport(group);
            setGedcomDatasetMarkers((current) => (
              current.filter((marker) => marker.sourceKey !== group.sourceKey)
            ));
          }}
        />
      ) : null}
    </>
  );

  async function deleteOnePerson(person: Person) {
    if (!onDeletePersons || deletingPersons) return;
    if (pedigreeRootPersonId === person.id) {
      window.alert(
        "Ця особа є кореневою для поточного родового дерева. Спочатку відкрийте налаштування дерева та виберіть іншу кореневу особу.",
      );
      return;
    }
    const summary = summaries.get(person.id);
    const impact = {
      relations: summary?.relationCount ?? relations.filter((relation) => (
        relation.personId === person.id || relation.relatedPersonId === person.id
      )).length,
      findings: summary?.findingCount ?? findings.filter((finding) => finding.personIds.includes(person.id)).length,
      tasks: summary?.taskCount ?? tasks.filter((task) => task.personIds.includes(person.id)).length,
      hypotheses: summary?.hypothesisCount ?? hypotheses.filter((hypothesis) => hypothesis.personIds.includes(person.id)).length,
      archiveRequests: summary?.archiveRequestCount ?? archiveRequests.filter((request) => request.personIds.includes(person.id)).length,
      documents: summary?.documentCount ?? 0,
    };
    const linkedRecords = impact.findings
      + impact.tasks
      + impact.hypotheses
      + impact.archiveRequests
      + impact.documents;
    const linkedDetails = [
      impact.relations ? `родинних звʼязків: ${impact.relations}` : "",
      impact.findings ? `знахідок: ${impact.findings}` : "",
      impact.tasks ? `завдань: ${impact.tasks}` : "",
      impact.hypotheses ? `гіпотез: ${impact.hypotheses}` : "",
      impact.archiveRequests ? `архівних запитів: ${impact.archiveRequests}` : "",
      impact.documents ? `повʼязаних документів: ${impact.documents}` : "",
    ].filter(Boolean).join("; ");
    const confirmed = window.confirm(
      [
        `Видалити особу «${personDisplayNameForDeleteV2(person)}»?`,
        linkedDetails
          ? `До неї привʼязано: ${linkedDetails}.`
          : "У видимих розділах повʼязаних записів не знайдено.",
        impact.relations
          ? "Родинні звʼязки цієї особи буде видалено."
          : "",
        linkedRecords
          ? "Знахідки, завдання, гіпотези, архівні запити й документи не видаляються — застосунок відвʼяже їх від цієї особи."
          : "",
        "Також буде очищено технічні посилання та вкладення профілю; самі файли на Google Drive не видаляються.",
        "Перед видаленням перегляньте й за потреби вручну відвʼяжіть важливі записи. Якщо продовжити, решту привʼязок застосунок відвʼяже автоматично. Цю дію не можна скасувати.",
      ].filter(Boolean).join("\n\n"),
    );
    if (!confirmed) return;
    setDeletingPersons(true);
    try {
      await onDeletePersons([person.id]);
      if (previewPersonId === person.id) setPreviewPersonId("");
      if (target.personId === person.id) {
        onNavigate({ mode: "list" }, { replace: true });
      }
    } catch {
      // The application-level handler already shows the actionable error.
    } finally {
      setDeletingPersons(false);
    }
  }

  const deleteSelectedPersons = async (selected: readonly Person[]) => {
    if (!onDeletePersons || deletingPersons || !selected.length) return;
    if (pedigreeRootPersonId && selected.some((person) => person.id === pedigreeRootPersonId)) {
      window.alert(
        "Серед вибраних є коренева особа поточного родового дерева. Спочатку виберіть іншу кореневу особу в налаштуваннях дерева.",
      );
      return;
    }
    const selectedIds = new Set(selected.map((person) => person.id));
    const impact = {
      relations: relations.filter((relation) => (
        selectedIds.has(relation.personId) || selectedIds.has(relation.relatedPersonId)
      )).length,
      findings: findings.filter((finding) => finding.personIds.some((id) => selectedIds.has(id))).length,
      tasks: tasks.filter((task) => task.personIds.some((id) => selectedIds.has(id))).length,
      hypotheses: hypotheses.filter((hypothesis) => hypothesis.personIds.some((id) => selectedIds.has(id))).length,
      archiveRequests: archiveRequests.filter((request) => request.personIds.some((id) => selectedIds.has(id))).length,
    };
    const impactDetails = [
      impact.relations ? `родинних звʼязків: ${impact.relations}` : "",
      impact.findings ? `знахідок: ${impact.findings}` : "",
      impact.tasks ? `завдань: ${impact.tasks}` : "",
      impact.hypotheses ? `гіпотез: ${impact.hypotheses}` : "",
      impact.archiveRequests ? `архівних запитів: ${impact.archiveRequests}` : "",
    ].filter(Boolean).join("; ");
    const confirmed = window.confirm(
      [
        `Видалити вибраних осіб (${selected.length})?`,
        impactDetails ? `З ними повʼязано: ${impactDetails}.` : "У видимих розділах повʼязаних записів не знайдено.",
        "Родинні звʼязки буде видалено. Інші записи проєкту залишаться, але будуть відвʼязані від вибраних осіб.",
        "Перед видаленням перегляньте важливі привʼязки. Цю дію не можна скасувати.",
      ].join("\n\n"),
    );
    if (!confirmed) return;
    setDeletingPersons(true);
    try {
      await onDeletePersons(selected.map((person) => person.id));
    } catch {
      // The application-level handler already shows the actionable error.
    } finally {
      setDeletingPersons(false);
    }
  };

  return (
    <div className="persons-v2-catalog-shell">
      <div className={`persons-v2-catalog-layout${detailPerson ? " has-preview" : ""}`}>
        <div className="persons-v2-catalog-main">
          <PersonsCatalogV2
            persons={persons}
            initialQuery={initialSearch}
            directAncestorIds={effectiveDirectAncestorIds}
            familyOrder={familyOrder}
            familyOrderStatus={familyOrderStatus}
            selectedPersonId={previewPersonId}
            summaries={summaries}
            headerActions={headerActions}
            photoUrlForPerson={safeExternalPhotoUrl}
            onOpenPerson={(person) => setPreviewPersonId(person.id)}
            onCreatePerson={!readOnly && canCreate
              ? () => onNavigate({ mode: "new" })
              : undefined}
            enabledBulkActions={readOnly || !onDeletePersons ? ["export"] : ["export", "delete"]}
            onDeletePerson={!readOnly && onDeletePersons && !deletingPersons
              ? (person) => void deleteOnePerson(person)
              : undefined}
            onBulkAction={(action, selected) => {
              if (action === "delete") {
                void deleteSelectedPersons(selected);
                return;
              }
              if (action === "export") {
                exportPersonsToExcel(
                  db,
                  projectName,
                  [...selected],
                  "filtered",
                  customFieldDefinitions,
                );
              }
            }}
          />
        </div>
        <PersonPreviewDrawerV2
          person={detailPerson}
          persons={persons}
          relations={relations}
          research={researches.find((item) => item.id === detailPerson?.researchId) ?? null}
          findings={detail.findings}
          tasks={detail.tasks}
          hypotheses={detail.hypotheses}
          archiveRequests={detail.archiveRequests}
          photoUrl={selectedPhotoUrl}
          directAncestor={detailPerson ? effectiveDirectAncestorIds.has(detailPerson.id) : false}
          onClose={() => setPreviewPersonId("")}
          onOpenProfile={(person) => onNavigate({ mode: "profile", personId: person.id })}
          onOpenPhoto={onOpenPhoto}
          onShowInTree={onShowInTree}
          onEdit={readOnly ? undefined : (person) => onNavigate({ mode: "edit", personId: person.id })}
          onDelete={!readOnly && onDeletePersons && !deletingPersons
            ? (person) => void deleteOnePerson(person)
            : undefined}
          onAddEvent={readOnly ? undefined : (person) => onNavigate({ mode: "edit", personId: person.id })}
        />
      </div>
    </div>
  );
}

function MissingPersonV2({ onBack }: { onBack: () => void }) {
  return (
    <section className="panel empty-state persons-v2-missing">
      <strong>Особу не знайдено або вона недоступна.</strong>
      <p>Можливо, запис видалено або ваші права доступу змінилися.</p>
      <button type="button" className="button button-primary" onClick={onBack}>Повернутися до осіб</button>
    </section>
  );
}

function UnavailablePersonEditorV2({
  reason,
  onBack,
}: {
  reason: "read-only" | "create-disabled";
  onBack: () => void;
}) {
  return (
    <section className="panel empty-state persons-v2-missing">
      <strong>
        {reason === "read-only"
          ? "Редагування недоступне в режимі перегляду."
          : "Створення нової особи зараз недоступне."}
      </strong>
      <p>
        {reason === "read-only"
          ? "Ви можете переглядати доступні дані, але не змінювати їх."
          : "Перевірте права доступу або доступний ліміт записів про осіб."}
      </p>
      <button type="button" className="button button-primary" onClick={onBack}>
        Повернутися назад
      </button>
    </section>
  );
}

function PersonDetailNoticeV2({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <p className={`persons-v2-detail-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
      {children}
    </p>
  );
}

function linkedRecordsFromMemory(
  personId: string,
  findings: readonly Finding[],
  tasks: readonly TaskRecord[],
  hypotheses: readonly Hypothesis[],
  archiveRequests: readonly ArchiveRequest[],
): PersonLinkedRecords {
  return {
    findings: findings.filter((item) => item.personIds.includes(personId)),
    tasks: tasks.filter((item) => item.personIds.includes(personId)),
    hypotheses: hypotheses.filter((item) => item.personIds.includes(personId)),
    archiveRequests: archiveRequests.filter((item) => item.personIds.includes(personId)),
  };
}

function linkedDocumentIds(records: PersonLinkedRecords): string[] {
  return [...new Set([
    ...records.findings.map((item) => item.documentId),
    ...records.tasks.map((item) => item.documentId),
    ...records.hypotheses.flatMap((item) => item.documentIds),
  ].filter(Boolean))];
}

function buildLocalPersonSummaries(
  persons: readonly Person[],
  relations: readonly PersonRelation[],
  findings: readonly Finding[],
  tasks: readonly TaskRecord[],
  hypotheses: readonly Hypothesis[],
  archiveRequests: readonly ArchiveRequest[],
): Map<string, ProjectPersonSummary> {
  const summaries = new Map(persons.map((person) => {
    const lastEvent = buildPersonTimeline(person).at(-1);
    return [person.id, {
      personId: person.id,
      relationCount: 0,
      taskCount: 0,
      hypothesisCount: 0,
      archiveRequestCount: 0,
      findingCount: 0,
      documentCount: 0,
      lastEventType: lastEvent?.type ?? null,
      lastEventDate: lastEvent?.date ?? null,
    }] satisfies [string, ProjectPersonSummary];
  }));
  const documents = new Map<string, Set<string>>();
  const update = (personId: string, key: keyof Pick<ProjectPersonSummary,
    "relationCount" | "taskCount" | "hypothesisCount" | "archiveRequestCount" | "findingCount">) => {
    const summary = summaries.get(personId);
    if (summary) summary[key] += 1;
  };
  relations.forEach((relation) => {
    update(relation.personId, "relationCount");
    update(relation.relatedPersonId, "relationCount");
  });
  tasks.forEach((task) => task.personIds.forEach((personId) => {
    update(personId, "taskCount");
    if (task.documentId) addDocument(documents, personId, task.documentId);
  }));
  hypotheses.forEach((hypothesis) => hypothesis.personIds.forEach((personId) => {
    update(personId, "hypothesisCount");
    hypothesis.documentIds.forEach((id) => addDocument(documents, personId, id));
  }));
  archiveRequests.forEach((request) => request.personIds.forEach((personId) => update(personId, "archiveRequestCount")));
  findings.forEach((finding) => finding.personIds.forEach((personId) => {
    update(personId, "findingCount");
    if (finding.documentId) addDocument(documents, personId, finding.documentId);
  }));
  documents.forEach((ids, personId) => {
    const summary = summaries.get(personId);
    if (summary) summary.documentCount = ids.size;
  });
  return summaries;
}

function addDocument(documents: Map<string, Set<string>>, personId: string, documentId: string) {
  const ids = documents.get(personId) ?? new Set<string>();
  ids.add(documentId);
  documents.set(personId, ids);
}

function safeExternalPhotoUrl(person: Person): string | undefined {
  const photo = primaryPersonPhoto(person.photos, person.primaryPhotoId);
  if (!photo || !isPhotoReferenceAvailable(photo) || photo.storage !== "external-url") return undefined;
  const value = photo.webViewLink || photo.storagePath;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

function usePersonPhotoUrl(person: Person | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    let revokeUrl = "";
    setUrl(undefined);
    if (!person) return () => undefined;
    const photo = primaryPersonPhoto(person.photos, person.primaryPhotoId);
    if (!photo || !isPhotoReferenceAvailable(photo)) return () => undefined;
    void getScanPreviewSource(photo)
      .then((source) => {
        if (!active || source.kind !== "image") {
          if (source.revokeOnClose) URL.revokeObjectURL(source.url);
          return;
        }
        if (source.revokeOnClose) revokeUrl = source.url;
        setUrl(source.url);
      })
      .catch(() => {
        if (active) setUrl(undefined);
      });
    return () => {
      active = false;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [person]);
  return url;
}
