import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { buildPersonTimeline } from "./model";
import {
  relatedRecordDraftForPerson,
  type PersonCreatableRelatedPage,
} from "../../utils/personRelatedRecordDrafts.ts";

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
  onSavePerson,
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
  projectName = "Трекер Роду",
  researchRequired = false,
  canUseGedcom = false,
  directAncestorIds,
  pedigreeContext,
  pedigreeCacheScope = "",
}: PersonsModuleV2Props) {
  const [previewPersonId, setPreviewPersonId] = useState("");
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
          onShowInTree={onShowInTree}
          onOpenMap={onOpenMap}
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
      {!readOnly && canCreate ? (
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
          disabled={!canCreate}
          defaultResearchId={researches.length === 1 ? researches[0].id : ""}
          researchRequired={researchRequired}
          onImportPersons={(records) => onImportRecords("persons", records)}
          onImportGedcom={onImportGedcom}
          onBackupGedcomPhotos={onBackupGedcomPhotos}
          onSaveRelation={onSaveRelation}
          onCreateFamilyTree={projectId ? async ({ fileName, people, relations: importedRelations, rootPersonId, importOperationId }) => {
            const result = await createFamilyTreeFromLegacyImport({
              projectId,
              title: `GEDCOM: ${fileName}`,
              persons: people,
              relations: importedRelations,
              rootPersonId,
              rollbackOperationId: importOperationId,
            });
            if (result && importOperationId) {
              await registerGedcomImportTree(importOperationId, result.treeId);
            }
            return result ? { treeId: result.treeId } : undefined;
          } : undefined}
        />
      ) : null}
    </>
  );

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
            enabledBulkActions={["export"]}
            onBulkAction={(action, selected) => {
              if (action !== "export") return;
              exportPersonsToExcel(
                db,
                projectName,
                [...selected],
                "filtered",
                customFieldDefinitions,
              );
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
          onShowInTree={onShowInTree}
          onEdit={readOnly ? undefined : (person) => onNavigate({ mode: "edit", personId: person.id })}
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
