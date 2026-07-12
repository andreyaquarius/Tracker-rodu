import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  ActivityLogEntry,
  ActivityModule,
  ArchiveRequest,
  AppDatabase,
  AppEntity,
  CollectionKey,
  CustomFieldDefinition,
  CustomSectionRecord,
  DocumentRecord,
  Finding,
  Hypothesis,
  Person,
  PersonRelation,
  Research,
  ScanAttachment,
  SectionParentKey,
  TaskRecord,
  YearMatrixRecord,
} from "./types";
import { useAppDatabase } from "./hooks/useAppDatabase";
import { Layout } from "./components/Layout";
import { UpgradeRequiredModal } from "./components/UpgradeRequiredModal";
import type { PageKey } from "./components/Sidebar";
import { DashboardPage } from "./pages/DashboardPage";
import { CrudPage } from "./pages/CrudPage";
import { configs } from "./pages/entityConfigs";
import { YearMatrixPage } from "./pages/YearMatrixPage";
import { BackupPage } from "./pages/BackupPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SubscriptionPage } from "./pages/SubscriptionPage";
import { LoginPage } from "./pages/LoginPage";
import { PrivacyPage, TermsPage } from "./pages/LegalPages";
import { FeaturesPage, PricingPage } from "./pages/PublicMarketingPages";
import { PersonsPage } from "./pages/PersonsPage";
import { MapPage } from "./pages/MapPage";
import { FamilyTreePage } from "./pages/FamilyTreePage";
import { shouldUseProductionFamilyTreeRenderer } from "./utils/familyTreeRendererFlag";
import { FamilyTreeErrorBoundary } from "./components/familyTree/FamilyTreeErrorBoundary";
import { CustomSectionPage } from "./pages/CustomSectionPage";
import { ProjectTeamModal } from "./components/ProjectTeamModal";
import { GeneHelpRequestModal } from "./components/GeneHelpRequestModal";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SectionHierarchyHeader } from "./components/SectionHierarchyHeader";
import {
  DocumentWorkspaceViewer,
  type ActiveDocumentScanViewer,
  type DocumentScanViewerContext,
} from "./components/DocumentWorkspaceViewer";
import { isHierarchyPage } from "./utils/sectionHierarchy";
import {
  pagePath,
  parseAppRoute,
  projectDashboardPath,
} from "./utils/appRoutes";
import {
  createSupabaseWorkspace,
  deleteSupabaseWorkspace,
  ensureSupabaseWorkspace,
  getAccountFromSession,
  getSupabaseSession,
  isSupabaseConfigured,
  listSupabaseWorkspaces,
  onSupabaseAuthChange,
  requestSupabasePasswordReset,
  renameSupabaseWorkspace,
  signInWithSupabaseGoogle,
  signInWithSupabaseEmail,
  signUpWithSupabaseEmail,
  signOutFromSupabase,
  updateSupabasePassword,
  type SupabaseAccount,
  type SupabaseWorkspace,
} from "./services/supabaseAuth";
import { useSubscription } from "./hooks/useSubscription";
import {
  loadAppFeatureFlags,
  subscriptionErrorCode,
  subscriptionErrorMessage,
} from "./services/subscriptionService";
import {
  assertFamilyTreeFeatureAccess,
  loadMyFamilyTreeFeatureAccess,
} from "./services/familyTreeFeatureAccess";
import { resolveFamilyTreeFeatureAccess } from "./utils/familyTreeFeatureAccess";
import type { PlanLimitKey, UpgradeReason } from "./types/subscription";
import {
  clearProjectResearchCache,
  deleteProjectResearch,
  getProjectResearch,
  importProjectResearches,
  listProjectResearches,
  loadProjectResearchCache,
  saveProjectResearch,
  saveProjectResearchCache,
} from "./services/projectResearches";
import {
  clearProjectPeopleCache,
  deleteProjectPerson,
  deleteProjectPersonRelation,
  getProjectPerson,
  getProjectPersonRelation,
  importProjectPeople,
  listProjectPeople,
  loadProjectPeopleCache,
  saveProjectPeopleCache,
  saveProjectPerson,
  saveProjectPersonRelation,
} from "./services/projectPeople";
import {
  clearProjectDocumentsCache,
  deleteProjectDocument,
  deleteProjectYearMatrixRecord,
  getProjectDocument,
  getProjectYearMatrixRecord,
  importProjectDocuments,
  listProjectDocuments,
  loadProjectDocumentsCache,
  saveProjectDocument,
  saveProjectDocumentsCache,
  saveProjectYearMatrixRecord,
  saveProjectYearMatrixRecords,
} from "./services/projectDocuments";
import {
  clearProjectWorkRecordsCache,
  deleteProjectFinding,
  deleteProjectTask,
  getProjectFinding,
  getProjectTask,
  importProjectWorkRecords,
  listProjectWorkRecords,
  loadProjectWorkRecordsCache,
  saveProjectFinding,
  saveProjectTask,
  saveProjectWorkRecordsCache,
} from "./services/projectWorkRecords";
import {
  clearProjectAnalysisRecordsCache,
  deleteProjectArchiveRequest,
  deleteProjectHypothesis,
  deleteProjectHypothesisTargetLinks,
  getProjectArchiveRequest,
  getProjectHypothesis,
  importProjectAnalysisRecords,
  listProjectAnalysisRecords,
  loadProjectAnalysisRecordsCache,
  saveProjectAnalysisRecordsCache,
  saveProjectArchiveRequest,
  saveProjectHypothesis,
} from "./services/projectAnalysisRecords";
import {
  clearProjectCustomStructureCache,
  deleteProjectCustomFieldDefinition,
  deleteProjectCustomRecord,
  deleteProjectCustomSection,
  importProjectCustomStructure,
  listProjectCustomStructure,
  loadProjectCustomStructureCache,
  saveProjectCustomFieldDefinition,
  saveProjectCustomRecord,
  saveProjectCustomSection,
  saveProjectCustomStructureCache,
} from "./services/projectCustomStructure";
import {
  addProjectActivity,
  createGenericProjectActivity,
  deleteProjectAttachmentMetadata,
  listProjectActivity,
  syncProjectAttachmentMetadata,
} from "./services/projectMetadata";
import {
  loadProjectPreferences,
  saveProjectPreferences,
  type ProjectPreferences,
} from "./services/projectSettings";
import {
  clearProjectRecords,
  createProjectBackup,
} from "./services/projectBackups";
import {
  subscribeProjectRealtime,
  type ProjectRealtimeEntityChange,
  type ProjectRealtimeGroup,
} from "./services/projectRealtime";
import { assertProjectRecordUnchanged } from "./services/projectConflicts";
import { deleteScanFile, setProjectAttachmentTarget } from "./services/scanStorage";
import { clearGoogleDriveSession } from "./services/googleDriveStorage";
import { clearAllProjectCaches } from "./utils/projectCache";
import { databaseStatementTimeoutMessage } from "./utils/databaseErrors";
import {
  GedcomImportStageError,
  toGedcomImportStageError,
  type GedcomImportStage,
} from "./utils/gedcomImportDiagnostics";
import {
  reconcileGedcomImportForRetry,
  type GedcomImportExecutionOptions,
  type GedcomImportReconciliationPayload,
  type GedcomImportReconciliationResult,
} from "./utils/gedcomImportReconciliation.ts";
import type { ImportPhaseProgress } from "./utils/importBatches.ts";
import {
  dataGroupsForPage,
} from "./utils/projectDataGroups";
import {
  realtimeRecordMutation,
  removeRealtimeRecord,
  upsertRealtimeRecord,
} from "./utils/realtimeChanges";
import { createActivityEntries } from "./utils/activityLog";
import {
  emptyProjectDashboardStats,
  loadProjectDashboard,
  type ProjectDashboardStats,
  type ProjectDashboardTask,
} from "./services/projectDashboard";

const ACCOUNT_ONBOARDING_KEY = "tracker-rodu-account-onboarded";
const ACTIVE_WORKSPACE_KEY = "tracker-rodu-active-workspace";
const SITE_ORIGIN = "https://trekerrodu.com.ua";
const SITE_IMAGE_URL = `${SITE_ORIGIN}/tracker-rodu-logo.png`;

type PublicPageKey = "privacy" | "terms" | "features" | "pricing";

const PUBLIC_PAGE_SEO: Record<PublicPageKey, {
  title: string;
  description: string;
  canonical: string;
}> = {
  privacy: {
    title: "Політика конфіденційності — Трекер Роду",
    description:
      "Політика конфіденційності Трекера Роду: дані акаунта, Supabase, Google Auth, Google Drive, Gemini, права користувача та видалення акаунта.",
    canonical: `${SITE_ORIGIN}/privacy`,
  },
  terms: {
    title: "Умови користування — Трекер Роду",
    description:
      "Умови користування Трекером Роду: акаунт, trial, тарифи, оплата, скасування, контент користувача, Google Drive, ШІ-функції та відповідальність.",
    canonical: `${SITE_ORIGIN}/terms`,
  },
  features: {
    title: "Можливості Трекера Роду — інструменти генеалогічного дослідження",
    description:
      "Можливості Трекера Роду для генеалогічного дослідження: документи, особи, знахідки, гіпотези, карта, власні розділи, командна робота й резервні копії.",
    canonical: `${SITE_ORIGIN}/features`,
  },
  pricing: {
    title: "Тарифи Трекера Роду — Старт, Дослідник і Професійний",
    description:
      "Тарифи Трекера Роду: Старт, Дослідник і Професійний, 30 днів пробного повного доступу без платіжної картки.",
    canonical: `${SITE_ORIGIN}/pricing`,
  },
};

const HOME_SEO = {
  title: "Трекер Роду — Не губи сліди свого роду",
  description:
    "Керуйте родовим дослідженням: від першої зачіпки до підтвердженого факту.",
  canonical: `${SITE_ORIGIN}/`,
};

function upsertMetaName(name: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(
    `meta[name="${name}"]`,
  );
  if (!element) {
    element = document.createElement("meta");
    element.name = name;
    document.head.appendChild(element);
  }
  element.content = content;
}

function upsertMetaProperty(property: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(
    `meta[property="${property}"]`,
  );
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute("property", property);
    document.head.appendChild(element);
  }
  element.content = content;
}

function upsertCanonical(href: string | null): void {
  const existing = document.head.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  if (!href) {
    existing?.remove();
    return;
  }
  const element = existing ?? document.createElement("link");
  element.rel = "canonical";
  element.href = href;
  if (!existing) document.head.appendChild(element);
}

function applyPublicSeo(page: PublicPageKey): void {
  const seo = PUBLIC_PAGE_SEO[page];
  document.title = seo.title;
  upsertMetaName("description", seo.description);
  upsertMetaName("robots", "index, follow");
  upsertCanonical(seo.canonical);
  upsertMetaProperty("og:title", seo.title);
  upsertMetaProperty("og:description", seo.description);
  upsertMetaProperty("og:type", "website");
  upsertMetaProperty("og:url", seo.canonical);
  upsertMetaProperty("og:site_name", "Трекер Роду");
  upsertMetaProperty("og:locale", "uk_UA");
  upsertMetaProperty("og:image", SITE_IMAGE_URL);
  upsertMetaProperty("og:image:alt", "Трекер Роду");
  upsertMetaName("twitter:card", "summary");
  upsertMetaName("twitter:title", seo.title);
  upsertMetaName("twitter:description", seo.description);
  upsertMetaName("twitter:image", SITE_IMAGE_URL);
}

function applyHomeSeo(): void {
  document.title = HOME_SEO.title;
  upsertMetaName("description", HOME_SEO.description);
  upsertMetaName("robots", "index, follow");
  upsertCanonical(HOME_SEO.canonical);
  upsertMetaProperty("og:title", HOME_SEO.title);
  upsertMetaProperty("og:description", HOME_SEO.description);
  upsertMetaProperty("og:type", "website");
  upsertMetaProperty("og:url", HOME_SEO.canonical);
  upsertMetaProperty("og:site_name", "Трекер Роду");
  upsertMetaProperty("og:locale", "uk_UA");
  upsertMetaProperty("og:image", SITE_IMAGE_URL);
  upsertMetaProperty("og:image:alt", "Трекер Роду");
  upsertMetaName("twitter:card", "summary");
  upsertMetaName("twitter:title", HOME_SEO.title);
  upsertMetaName("twitter:description", HOME_SEO.description);
  upsertMetaName("twitter:image", SITE_IMAGE_URL);
}

const researchScopedCollections: ReadonlySet<CollectionKey> = new Set([
  "documents",
  "yearMatrix",
  "tasks",
  "findings",
  "hypotheses",
  "archiveRequests",
  "persons",
]);

const standardSectionQuotaKeys: Record<string, string> = {
  persons: "persons",
  documents: "documents",
  yearMatrix: "year_matrix",
  archiveRequests: "archive_requests",
  tasks: "tasks",
  findings: "findings",
  hypotheses: "hypotheses",
};

function chooseWorkspace(
  items: SupabaseWorkspace[],
  preferredProjectId: string | null,
  fallbackProjectId?: string,
): SupabaseWorkspace | null {
  if (!items.length) return null;
  return (
    items.find((item) => item.projectId === preferredProjectId) ??
    items.find((item) => item.projectId === fallbackProjectId) ??
    items[0]
  );
}

function mergeImportedRecords<T extends { id: string }>(imported: T[], current: T[]): T[] {
  const importedIds = new Set(imported.map((record) => record.id));
  return [...imported, ...current.filter((record) => !importedIds.has(record.id))];
}

function removeCustomFieldFromDatabase(
  db: AppDatabase,
  definition: CustomFieldDefinition,
): AppDatabase {
  const records = db[definition.module] as Array<AppEntity & {
    customFields?: Record<string, unknown>;
  }>;
  const cleaned = records.map((record) => {
    const customFields = { ...(record.customFields ?? {}) };
    delete customFields[definition.id];
    return { ...record, customFields };
  });
  return {
    ...db,
    [definition.module]: cleaned,
    settings: {
      ...db.settings,
      customFields: db.settings.customFields.filter(
        (field) => field.id !== definition.id,
      ),
    },
  } as AppDatabase;
}

function scanList(value: unknown): ScanAttachment[] {
  return Array.isArray(value) ? value as ScanAttachment[] : [];
}

function projectAttachmentFields(
  collection: CollectionKey,
  entity: AppEntity,
  db: AppDatabase,
): Record<string, ScanAttachment[]> {
  const fields: Record<string, ScanAttachment[]> = {};
  const record = entity as unknown as Record<string, unknown>;

  if (collection === "documents" || collection === "findings") {
    fields.scans = scanList(record.scans);
  }
  if (collection === "persons") {
    fields.birthScans = scanList(record.birthScans);
    fields.marriageScans = scanList(record.marriageScans);
    fields.deathScans = scanList(record.deathScans);
    fields.mentionScans = scanList(record.mentionScans);
    fields.photos = scanList(record.photos);
  }
  if (collection === "archiveRequests") {
    fields.requestScans = scanList(record.requestScans);
    fields.responseScans = scanList(record.responseScans);
  }

  const customValues = (
    record.customFields &&
    typeof record.customFields === "object" &&
    !Array.isArray(record.customFields)
  )
    ? record.customFields as Record<string, unknown>
    : {};
  for (const definition of db.settings.customFields) {
    if (definition.module !== collection || definition.type !== "attachments") continue;
    fields[`custom:${definition.id}`] = scanList(customValues[definition.id]);
  }
  return fields;
}

async function deleteEntityScanFiles(
  collection: CollectionKey,
  entity: AppEntity,
  db: AppDatabase,
): Promise<void> {
  const scans = Object.values(projectAttachmentFields(collection, entity, db)).flat();
  await Promise.all(scans.map((scan) =>
    deleteScanFile(scan, { force: collection === "findings" })
  ));
}

function activityModuleLabel(collection: CollectionKey): string {
  const labels: Record<CollectionKey, string> = {
    researches: "Дослідження",
    documents: "Документи",
    yearMatrix: "Матриця років",
    tasks: "Завдання",
    findings: "Знахідки",
    hypotheses: "Гіпотези",
    archiveRequests: "Запити в архів",
    persons: "Особи",
  };
  return labels[collection];
}

function baseUpdatedAt(entity: object): string | undefined {
  const value = (entity as Record<string, unknown>).__baseUpdatedAt;
  return typeof value === "string" ? value : undefined;
}

const GEDCOM_IMPORT_PHASE_RANGES: Record<
  ImportPhaseProgress["phase"],
  { step: string; start: number; end: number }
> = {
  persons: { step: "Зберігаємо осіб", start: 47, end: 52 },
  relations: { step: "Зберігаємо родинні звʼязки", start: 52, end: 56 },
  documents: { step: "Зберігаємо джерела", start: 56, end: 58 },
  "year-matrix": { step: "Зберігаємо матрицю років", start: 58, end: 59 },
  tasks: { step: "Зберігаємо завдання", start: 59, end: 60 },
  "task-person-delete": { step: "Оновлюємо учасників завдань", start: 60, end: 61 },
  "task-person-insert": { step: "Оновлюємо учасників завдань", start: 61, end: 62 },
  findings: { step: "Зберігаємо знахідки", start: 58, end: 68 },
  "finding-participant-delete": { step: "Оновлюємо учасників знахідок", start: 68, end: 71 },
  "finding-participant-upsert": { step: "Зберігаємо учасників знахідок", start: 71, end: 74 },
};

function reportGedcomImportBatchProgress(
  options: GedcomImportExecutionOptions | undefined,
  progress: ImportPhaseProgress,
): void {
  const range = GEDCOM_IMPORT_PHASE_RANGES[progress.phase];
  const ratio = progress.totalItems > 0
    ? progress.processedItems / progress.totalItems
    : 1;
  options?.onProgress?.({
    step: range.step,
    percent: range.start + (range.end - range.start) * Math.min(1, ratio),
    detail: [
      `Оброблено ${progress.processedItems.toLocaleString("uk-UA")} із ${progress.totalItems.toLocaleString("uk-UA")} записів.`,
      `Пакетів: ${progress.completedBatches.toLocaleString("uk-UA")} із ${progress.totalBatches.toLocaleString("uk-UA")}.`,
    ].join(" "),
  });
}

export default function App() {
  const app = useAppDatabase();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const [moduleSearch, setModuleSearch] = useState("");
  const [openEntityId, setOpenEntityId] = useState("");
  const [createRequest, setCreateRequest] = useState<{
    id: number;
    page: PageKey;
    initialValues: Record<string, unknown>;
  } | null>(null);
  const [sectionCreateRequest, setSectionCreateRequest] = useState<{
    id: number;
    parentKey: SectionParentKey;
  } | null>(null);
  const [onboarded, setOnboarded] = useState(() => {
    return localStorage.getItem(ACCOUNT_ONBOARDING_KEY) === "1";
  });
  const [loginError, setLoginError] = useState("");
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [isAccountSigningIn, setIsAccountSigningIn] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [scanViewer, setScanViewer] = useState<ActiveDocumentScanViewer | null>(null);
  const [geneHelpOpen, setGeneHelpOpen] = useState(false);
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});
  const [familyTreeFeatureAccess, setFamilyTreeFeatureAccess] = useState({
    allowed: false,
    loading: true,
  });
  const [account, setAccount] = useState<SupabaseAccount | null>(null);
  const [workspace, setWorkspace] = useState<SupabaseWorkspace | null>(null);
  const [workspaces, setWorkspaces] = useState<SupabaseWorkspace[]>([]);
  const [projectResearches, setProjectResearches] = useState<Research[]>([]);
  const [researchesReadyForProject, setResearchesReadyForProject] = useState<string | null>(null);
  const [projectPersons, setProjectPersons] = useState<Person[]>([]);
  const [projectPersonRelations, setProjectPersonRelations] = useState<PersonRelation[]>([]);
  const [projectDocuments, setProjectDocuments] = useState<DocumentRecord[]>([]);
  const [projectYearMatrix, setProjectYearMatrix] = useState<YearMatrixRecord[]>([]);
  const [documentsReadyForProject, setDocumentsReadyForProject] = useState<string | null>(null);
  const [peopleReadyForProject, setPeopleReadyForProject] = useState<string | null>(null);
  const [projectTasks, setProjectTasks] = useState<TaskRecord[]>([]);
  const [projectFindings, setProjectFindings] = useState<Finding[]>([]);
  const [workRecordsReadyForProject, setWorkRecordsReadyForProject] =
    useState<string | null>(null);
  const [projectHypotheses, setProjectHypotheses] = useState<Hypothesis[]>([]);
  const [projectArchiveRequests, setProjectArchiveRequests] =
    useState<ArchiveRequest[]>([]);
  const [analysisReadyForProject, setAnalysisReadyForProject] = useState<string | null>(null);
  const [projectCustomFields, setProjectCustomFields] =
    useState<CustomFieldDefinition[]>([]);
  const [projectCustomSections, setProjectCustomSections] = useState(
    app.db.customSections,
  );
  const [projectCustomRecords, setProjectCustomRecords] = useState(
    app.db.customSectionRecords,
  );
  const route = useMemo(
    () => parseAppRoute(location.pathname, projectCustomSections),
    [location.pathname, projectCustomSections],
  );
  const page: PageKey =
    route.kind === "project" || route.kind === "settings"
      ? route.page
      : "dashboard";
  const [customStructureReadyForProject, setCustomStructureReadyForProject] =
    useState<string | null>(null);
  const [projectActivity, setProjectActivity] = useState<ActivityLogEntry[]>([]);
  const [dashboardStats, setDashboardStats] = useState<ProjectDashboardStats>(
    emptyProjectDashboardStats,
  );
  const [dashboardTasks, setDashboardTasks] = useState<ProjectDashboardTask[]>([]);
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences>(
    () => ({
      researcherName: app.db.settings.researcherName,
      compactTables: app.db.settings.compactTables,
      lastAutomaticBackupAt: app.db.settings.lastAutomaticBackupAt,
    }),
  );
  const [projectPreferencesReadyFor, setProjectPreferencesReadyFor] =
    useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [upgradeReason, setUpgradeReason] = useState<UpgradeReason | null>(null);
  const workspaceSetupRef = useRef<Promise<void> | null>(null);
  const passwordRecoveryRef = useRef(false);
  const lastPreparedUserRef = useRef<string | null>(null);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const automaticProjectBackupRef = useRef<string | null>(null);
  const hydratedWorkspaceRef = useRef<string | null>(null);
  const peopleLoadRef = useRef<{
    projectId: string;
    promise: ReturnType<typeof listProjectPeople>;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const syncedPreferencesRef = useRef<{
    projectId: string;
    value: string;
  } | null>(null);
  const subscriptionAccess = useSubscription(
    workspace?.projectId,
    Boolean(account) && route.kind !== "public",
  );
  useEffect(() => {
    let active = true;
    if (!account || route.kind === "public") {
      setFeatureFlags({});
      return () => {
        active = false;
      };
    }
    void loadAppFeatureFlags()
      .then((flags) => {
        if (active) setFeatureFlags(flags);
      })
      .catch(() => {
        if (active) setFeatureFlags({});
      });
    return () => {
      active = false;
    };
  }, [account?.id, route.kind]);

  useEffect(() => {
    let active = true;
    if (!account || route.kind === "public") {
      setFamilyTreeFeatureAccess({ allowed: false, loading: false });
      return () => {
        active = false;
      };
    }

    setFamilyTreeFeatureAccess({ allowed: false, loading: true });
    void loadMyFamilyTreeFeatureAccess()
      .then((allowed) => {
        if (active) setFamilyTreeFeatureAccess({ allowed, loading: false });
      })
      .catch(() => {
        // Private beta access is deliberately fail-closed if the entitlement
        // service is unavailable or its database migration is not installed.
        if (active) setFamilyTreeFeatureAccess({ allowed: false, loading: false });
      });

    return () => {
      active = false;
    };
  }, [account?.id, route.kind]);

  // The application owner must never be locked out while the private-beta
  // entitlement migration is being rolled out. Server-side SQL grants app
  // administrators the same unconditional access.
  const canUseFamilyTreeFeature = resolveFamilyTreeFeatureAccess({
    isAppAdmin: subscriptionAccess.isAdmin,
    serverAllowed: familyTreeFeatureAccess.allowed,
    serverLoading: familyTreeFeatureAccess.loading,
  });

  const canOpenGeneHelp = subscriptionAccess.isAdmin || featureFlags.genehelp_public === true;
  const canCreateProjectRecords = !workspace || subscriptionAccess.canCreateProjectRecords;
  const canCreateStandardSection = useCallback((sectionKey?: string) => {
    if (!canCreateProjectRecords) return false;
    if (!sectionKey) return true;
    return subscriptionAccess.context?.sectionQuotas[sectionKey]?.canCreate ?? true;
  }, [canCreateProjectRecords, subscriptionAccess.context]);
  const canCreateCustomSection = !workspace || subscriptionAccess.canCreateCustomSection;
  const canCreateCustomField = !workspace || subscriptionAccess.canCreateCustomField;
  const limitNotice = useCallback((label: string, key: PlanLimitKey) => {
    if (subscriptionAccess.loading) return "Перевіряємо ліміти тарифу…";
    const limit = subscriptionAccess.getLimit(key);
    const used = subscriptionAccess.getUsage(key);
    if (limit && !limit.isUnlimited && limit.value !== null) {
      if (limit.value === 0) {
        return `Створення ${label} недоступне на поточному тарифі. Перегляньте платні тарифи, щоб додати цю можливість.`;
      }
      return `Досягнуто ліміт ${label}: використано ${used} із ${limit.value}. Ви можете редагувати або видаляти наявні елементи, але не можете додавати нові.`;
    }
    return `Створення ${label} недоступне на поточному тарифі.`;
  }, [subscriptionAccess.getLimit, subscriptionAccess.getUsage, subscriptionAccess.loading]);
  const customSectionLimitMessage = canCreateCustomSection
    ? undefined
    : limitNotice("власних розділів", "custom_sections_per_project");
  const customFieldLimitMessage = canCreateCustomField
    ? undefined
    : limitNotice("власних полів", "custom_fields_per_project");
  const showCustomFieldBlocked = useCallback(() => {
    setUpgradeReason({
      featureName: "Власні поля",
      reason: customFieldLimitMessage || "Створення нового власного поля недоступне або ліміт уже використано.",
      recommendedPlan: "researcher",
      used: subscriptionAccess.getUsage("custom_fields_per_project"),
      limit: subscriptionAccess.getLimit("custom_fields_per_project")?.value ?? undefined,
    });
  }, [
    customFieldLimitMessage,
    subscriptionAccess.getLimit,
    subscriptionAccess.getUsage,
  ]);
  const firstReachedLimitNotice = useCallback((label: string, keys: PlanLimitKey[]) => {
    if (subscriptionAccess.loading) return "Перевіряємо ліміти тарифу…";
    const reachedKey = keys.find((key) => {
      const limit = subscriptionAccess.getLimit(key);
      const used = subscriptionAccess.getUsage(key);
      return Boolean(limit && !limit.isUnlimited && limit.value !== null && used >= limit.value);
    });
    return limitNotice(label, reachedKey ?? keys[0]);
  }, [
    limitNotice,
    subscriptionAccess.getLimit,
    subscriptionAccess.getUsage,
    subscriptionAccess.loading,
  ]);
  const canCreateResearchRecord = !workspace || subscriptionAccess.canCreateResearch;
  const researchLimitMessage = canCreateResearchRecord
    ? undefined
    : firstReachedLimitNotice("досліджень", [
        "researches_per_project",
        "researches_total",
      ]);
  const researchRequiredByPlan = subscriptionAccess.effectivePlan !== "professional";
  const requestedDataGroups = useMemo(() => dataGroupsForPage(page), [page]);
  const shouldLoadResearches = requestedDataGroups.has("researches");
  const shouldLoadPeople = requestedDataGroups.has("people");
  const shouldLoadDocuments = requestedDataGroups.has("documents");
  const shouldLoadWork = requestedDataGroups.has("work");
  const shouldLoadAnalysis = requestedDataGroups.has("analysis");

  useEffect(() => {
    if (route.kind === "public") {
      applyPublicSeo(route.page);
      return;
    }

    if (route.kind === "root" && !account) {
      applyHomeSeo();
      return;
    }

    upsertMetaName("robots", "noindex, nofollow");
    upsertCanonical(null);
  }, [account, route]);

  const describeError = useCallback((error: unknown, fallback: string) => {
    if (subscriptionErrorCode(error)) return subscriptionErrorMessage(error);
    const timeoutMessage = databaseStatementTimeoutMessage(error);
    if (timeoutMessage) return timeoutMessage;
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "object" && error !== null) {
      const message = "message" in error ? String(error.message ?? "") : "";
      const details = "details" in error ? String(error.details ?? "") : "";
      const hint = "hint" in error ? String(error.hint ?? "") : "";
      const combined = [message, details, hint].filter(Boolean).join(" ");
      if (combined) return combined;
    }
    return fallback;
  }, []);

  const ensureCanCreateProjectRecord = useCallback((featureName: string) => {
    if (canCreateProjectRecords) return true;
    setUpgradeReason({
      featureName,
      reason: "У цьому проєкті можна редагувати й видаляти наявні дані, але створення нових записів заблоковане поточним тарифом.",
      recommendedPlan: "researcher",
    });
    return false;
  }, [canCreateProjectRecords]);
  const refreshSubscriptionAfterCreate = useCallback((previousEntity: unknown) => {
    if (!previousEntity) void subscriptionAccess.refreshSubscription();
  }, [subscriptionAccess.refreshSubscription]);

  useEffect(() => {
    if (!account) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("openTeam") !== "1") return;
    setTeamOpen(true);
    url.searchParams.delete("openTeam");
    window.history.replaceState({}, "", url);
  }, [account]);

  useEffect(() => {
    if (!account || isAccountSigningIn || passwordRecovery) return;

    if (route.kind === "root") {
      routerNavigate(
        workspace ? projectDashboardPath(workspace.projectSlug) : "/projects",
        { replace: true },
      );
      return;
    }
    if (route.kind === "unknown") {
      routerNavigate("/projects", { replace: true });
      return;
    }
    if (route.kind !== "project") return;

    const requestedWorkspace = workspaces.find(
      (item) =>
        item.projectSlug === route.projectRef ||
        item.projectId === route.projectRef,
    );
    if (!requestedWorkspace) {
      routerNavigate("/projects", { replace: true });
      return;
    }
    if (workspace?.projectId !== requestedWorkspace.projectId) {
      setWorkspace(requestedWorkspace);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, requestedWorkspace.projectId);
      return;
    }
    if (
      route.unresolvedSectionPath &&
      customStructureReadyForProject !== requestedWorkspace.projectId
    ) {
      return;
    }
    const canonicalPath = pagePath(
      requestedWorkspace.projectSlug,
      route.page,
      projectCustomSections,
    );
    if (location.pathname !== canonicalPath) {
      routerNavigate(canonicalPath, { replace: true });
    }
  }, [
    account,
    isAccountSigningIn,
    location.pathname,
    passwordRecovery,
    route,
    routerNavigate,
    customStructureReadyForProject,
    projectCustomSections,
    workspace,
    workspaces,
  ]);

  useEffect(() => {
    if (!authReady || account || passwordRecovery) return;
    if (route.kind === "root" || route.kind === "public") return;
    routerNavigate("/", { replace: true });
  }, [account, authReady, passwordRecovery, route.kind, routerNavigate]);

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    let active = true;
    const prepareWorkspace = async (session: Awaited<ReturnType<typeof getSupabaseSession>>) => {
      if (passwordRecoveryRef.current) return;
      if (!session) {
        setAccount(null);
        setWorkspace(null);
        setWorkspaces([]);
        setIsAccountSigningIn(false);
        setAuthReady(true);
        lastPreparedUserRef.current = null;
        return;
      }

      // Auth events can repeat on token refresh and on every tab focus.
      // Once a user is prepared, ignore the repeats: otherwise each event rebuilds
      // `account`/`workspace`, which re-fires every data-load effect and floods
      // PostgREST with duplicate full-table reads — the request storm behind the
      // "Thread killed by timeout manager" timeouts.
      if (lastPreparedUserRef.current === session.user.id) {
        setAuthReady(true);
        return;
      }

      if (workspaceSetupRef.current) {
        await workspaceSetupRef.current;
        setAuthReady(true);
        return;
      }

      const currentAccount = getAccountFromSession(session);
      if (!currentAccount) {
        setAccount(null);
        setWorkspace(null);
        setWorkspaces([]);
        setIsAccountSigningIn(false);
        setAuthReady(true);
        return;
      }

      setIsAccountSigningIn(true);
      workspaceSetupRef.current = (async () => {
        setAccount(currentAccount);
        const fetchedWorkspaces = await listSupabaseWorkspaces(
          undefined,
          session.user.id,
        );
        const ensuredWorkspace = fetchedWorkspaces[0] ?? await ensureSupabaseWorkspace(
          session,
          currentAccount,
          fetchedWorkspaces,
        );
        if (!active) return;

        const availableWorkspaces = fetchedWorkspaces.length
          ? fetchedWorkspaces
          : ensuredWorkspace
            ? [ensuredWorkspace]
            : [];
        const requestedRoute = parseAppRoute(window.location.pathname);
        const requestedWorkspace =
          requestedRoute.kind === "project"
            ? availableWorkspaces.find(
                (item) =>
                  item.projectSlug === requestedRoute.projectRef ||
                  item.projectId === requestedRoute.projectRef,
              )
            : undefined;
        const activeWorkspace = chooseWorkspace(
          availableWorkspaces,
          requestedWorkspace?.projectId ?? localStorage.getItem(ACTIVE_WORKSPACE_KEY),
          ensuredWorkspace?.projectId,
        );

        setWorkspaces(availableWorkspaces);
        setWorkspace(activeWorkspace);
        if (activeWorkspace) {
          localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspace.projectId);
        } else {
          localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
        }
        localStorage.setItem(ACCOUNT_ONBOARDING_KEY, "1");
        setOnboarded(true);
        lastPreparedUserRef.current = session.user.id;
      })();

      try {
        await workspaceSetupRef.current;
      } finally {
        workspaceSetupRef.current = null;
        if (active) {
          setIsAccountSigningIn(false);
          setAuthReady(true);
        }
      }
    };

    void getSupabaseSession()
      .then((session) => {
        if (!active) return;
        return prepareWorkspace(session);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setIsAccountSigningIn(false);
        setAuthReady(true);
        setLoginError(
          describeError(error, "Не вдалося перевірити вхід до облікового запису."),
        );
      });

    const subscription = onSupabaseAuthChange((session, event) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY") {
        passwordRecoveryRef.current = true;
        setPasswordRecovery(true);
        setAccount(null);
        setWorkspace(null);
        setWorkspaces([]);
        setIsAccountSigningIn(false);
        setAuthReady(true);
        return;
      }
      if (passwordRecoveryRef.current) return;
      void prepareWorkspace(session).catch((error: unknown) => {
        if (!active) return;
        setIsAccountSigningIn(false);
        setAuthReady(true);
        setLoginError(
          describeError(error, "Не вдалося підготувати ваш робочий простір."),
        );
      });
    });

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, []);

  const notify = useCallback((message: string, error = false) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ message, error });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3500);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    activeWorkspaceIdRef.current = workspace?.projectId ?? null;
    setProjectAttachmentTarget(
      workspace?.projectId ?? null,
      workspace?.projectName ?? "",
      canCreateProjectRecords,
    );
  }, [canCreateProjectRecords, workspace?.projectId, workspace?.projectName]);

  useEffect(() => {
    const projectId = workspace?.projectId ?? null;
    if (hydratedWorkspaceRef.current === projectId) return;
    hydratedWorkspaceRef.current = projectId;
    setProjectResearches([]);
    setProjectPersons([]);
    setProjectPersonRelations([]);
    setProjectDocuments([]);
    setProjectYearMatrix([]);
    setProjectTasks([]);
    setProjectFindings([]);
    setProjectHypotheses([]);
    setProjectArchiveRequests([]);
    setResearchesReadyForProject(null);
    setPeopleReadyForProject(null);
    setDocumentsReadyForProject(null);
    setWorkRecordsReadyForProject(null);
    setAnalysisReadyForProject(null);
  }, [workspace?.projectId]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectPreferencesReadyFor(null);
      return;
    }

    const projectId = workspace.projectId;
    const fallback = {
      researcherName: app.db.settings.researcherName,
      compactTables: app.db.settings.compactTables,
      lastAutomaticBackupAt: app.db.settings.lastAutomaticBackupAt,
    };
    setProjectPreferencesReadyFor(null);
    syncedPreferencesRef.current = null;
    setProjectPreferences(fallback);
    let active = true;
    void loadProjectPreferences(projectId, fallback)
      .then((preferences) => {
        if (!active) return;
        syncedPreferencesRef.current = {
          projectId,
          value: JSON.stringify(preferences),
        };
        setProjectPreferences(preferences);
        setProjectPreferencesReadyFor(projectId);
      })
      .catch((error: unknown) => {
        if (!active) return;
        notify(
          describeError(error, "Не вдалося завантажити налаштування проєкту."),
          true,
        );
      });
    return () => {
      active = false;
    };
  }, [
    account,
    app.db.settings.compactTables,
    app.db.settings.lastAutomaticBackupAt,
    app.db.settings.researcherName,
    describeError,
    notify,
    workspace,
  ]);

  useEffect(() => {
    if (
      !workspace ||
      workspace.role !== "owner" ||
      projectPreferencesReadyFor !== workspace.projectId
    ) {
      return;
    }
    const projectId = workspace.projectId;
    const serialized = JSON.stringify(projectPreferences);
    if (
      syncedPreferencesRef.current?.projectId === projectId &&
      syncedPreferencesRef.current.value === serialized
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const previousSynced = syncedPreferencesRef.current;
      syncedPreferencesRef.current = { projectId, value: serialized };
      void saveProjectPreferences(projectId, projectPreferences).then(() => {
        const entry = createGenericProjectActivity(
          "settings",
          projectId,
          "Оновлено загальні налаштування проєкту.",
          "settings_updated",
        );
        void addProjectActivity(projectId, entry)
          .then((saved) => {
            if (activeWorkspaceIdRef.current !== projectId) return;
            setProjectActivity((current) => [
              saved,
              ...current.filter((item) => item.id !== saved.id),
            ].slice(0, 100));
          })
          .catch(() => undefined);
      }).catch(
        (error: unknown) => {
          syncedPreferencesRef.current = previousSynced;
          notify(
            describeError(error, "Не вдалося зберегти налаштування проєкту."),
            true,
          );
        },
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    describeError,
    notify,
    projectPreferences,
    projectPreferencesReadyFor,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectActivity([]);
      return;
    }
    let active = true;
    void listProjectActivity(workspace.projectId, 10)
      .then((entries) => {
        if (active) setProjectActivity(entries);
      })
      .catch((error: unknown) => {
        if (!active) return;
        notify(
          describeError(error, "Не вдалося завантажити журнал активності проєкту."),
          true,
        );
      });
    return () => {
      active = false;
    };
  }, [account, describeError, notify, workspace]);

  useEffect(() => {
    if (!workspace || !account) {
      setDashboardStats(emptyProjectDashboardStats());
      setDashboardTasks([]);
      return;
    }
    if (page !== "dashboard") return;

    let active = true;
    void loadProjectDashboard(workspace.projectId)
      .then((dashboard) => {
        if (!active) return;
        setDashboardStats(dashboard.stats);
        setDashboardTasks(dashboard.tasks);
      })
      .catch((error: unknown) => {
        if (!active) return;
        notify(
          describeError(
            error,
            "Не вдалося завантажити статистику панелі огляду.",
          ),
          true,
        );
      });
    return () => {
      active = false;
    };
  }, [account, describeError, notify, page, workspace]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectResearches([]);
      setResearchesReadyForProject(null);
      return;
    }

    if (!shouldLoadResearches) return;
    const projectId = workspace.projectId;
    if (researchesReadyForProject === projectId) return;
    const cached = loadProjectResearchCache(projectId);
    setProjectResearches(cached);

    let active = true;
    setResearchesReadyForProject(null);
    void (async () => {
      try {
        const researches = await listProjectResearches(projectId);

        if (!active) return;
        saveProjectResearchCache(projectId, researches);
        setProjectResearches(researches);
        setResearchesReadyForProject(projectId);
      } catch (error) {
        if (!active) return;
        notify(
          describeError(
            error,
            cached.length
              ? "Не вдалося оновити дослідження з бази. Показано локальний кеш."
              : "Не вдалося завантажити дослідження з бази.",
          ),
          true,
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [
    account,
    describeError,
    notify,
    shouldLoadResearches,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectPersons([]);
      setProjectPersonRelations([]);
      setPeopleReadyForProject(null);
      return;
    }
    if (!shouldLoadPeople) return;
    const projectId = workspace.projectId;
    if (peopleReadyForProject === projectId) return;
    const cached = loadProjectPeopleCache(projectId);
    setProjectPersons(cached.persons);
    setProjectPersonRelations(cached.relations);

    let active = true;
    setPeopleReadyForProject(null);
    const fallbackPersons = cached.persons;
    const fallbackRelations = cached.relations;

    let load = peopleLoadRef.current?.projectId === projectId
      ? peopleLoadRef.current.promise
      : null;
    if (!load) {
      load = listProjectPeople(projectId).then((remote) => {
        saveProjectPeopleCache(projectId, remote.persons, remote.relations);
        return remote;
      });
      peopleLoadRef.current = { projectId, promise: load };
      const clearInFlight = () => {
        if (peopleLoadRef.current?.promise === load) peopleLoadRef.current = null;
      };
      void load.then(clearInFlight, clearInFlight);
    }

    void load
      .then((remote) => {
        if (!active) return;
        setProjectPersons(remote.persons);
        setProjectPersonRelations(remote.relations);
        setPeopleReadyForProject(projectId);
      })
      .catch((error: unknown) => {
        if (!active) return;
        notify(
          describeError(
            error,
            fallbackPersons.length
              ? "Не вдалося оновити осіб із бази. Показано локальний кеш."
              : "Не вдалося завантажити осіб із бази.",
          ),
          true,
        );
      });

    return () => {
      active = false;
    };
  }, [
    account,
    describeError,
    notify,
    shouldLoadPeople,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectDocuments([]);
      setProjectYearMatrix([]);
      setDocumentsReadyForProject(null);
      return;
    }
    if (!shouldLoadDocuments) return;
    const projectId = workspace.projectId;
    if (documentsReadyForProject === projectId) return;
    const cached = loadProjectDocumentsCache(projectId);
    setProjectDocuments(cached.documents);
    setProjectYearMatrix(cached.yearMatrix);

    let active = true;
    setDocumentsReadyForProject(null);
    const fallbackDocuments = cached.documents;
    const fallbackMatrix = cached.yearMatrix;

    void (async () => {
      try {
        const remote = await listProjectDocuments(projectId);

        if (!active) return;
        saveProjectDocumentsCache(projectId, remote.documents, remote.yearMatrix);
        setProjectDocuments(remote.documents);
        setProjectYearMatrix(remote.yearMatrix);
        setDocumentsReadyForProject(projectId);
      } catch (error) {
        if (!active) return;
        notify(
          describeError(
            error,
            fallbackDocuments.length || fallbackMatrix.length
              ? "Не вдалося оновити документи з бази. Показано локальний кеш."
              : "Не вдалося завантажити документи з бази.",
          ),
          true,
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [
    account,
    describeError,
    notify,
    shouldLoadDocuments,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectTasks([]);
      setProjectFindings([]);
      setWorkRecordsReadyForProject(null);
      return;
    }
    if (!shouldLoadWork) return;
    const projectId = workspace.projectId;
    if (workRecordsReadyForProject === projectId) return;
    const cached = loadProjectWorkRecordsCache(projectId);
    setProjectTasks(cached.tasks);
    setProjectFindings(cached.findings);

    let active = true;
    setWorkRecordsReadyForProject(null);
    const fallbackTasks = cached.tasks;
    const fallbackFindings = cached.findings;

    void (async () => {
      try {
        const remote = await listProjectWorkRecords(projectId);

        if (!active) return;
        saveProjectWorkRecordsCache(projectId, remote.tasks, remote.findings);
        setProjectTasks(remote.tasks);
        setProjectFindings(remote.findings);
        setWorkRecordsReadyForProject(projectId);
      } catch (error) {
        if (!active) return;
        notify(
          describeError(
            error,
            fallbackTasks.length || fallbackFindings.length
              ? "Не вдалося оновити завдання і знахідки з бази. Показано локальний кеш."
              : "Не вдалося завантажити завдання і знахідки з бази.",
          ),
          true,
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [
    account,
    describeError,
    notify,
    shouldLoadWork,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectHypotheses([]);
      setProjectArchiveRequests([]);
      setAnalysisReadyForProject(null);
      return;
    }
    if (!shouldLoadAnalysis) return;
    const projectId = workspace.projectId;
    if (analysisReadyForProject === projectId) return;
    const cached = loadProjectAnalysisRecordsCache(projectId);
    setProjectHypotheses(cached.hypotheses);
    setProjectArchiveRequests(cached.archiveRequests);

    let active = true;
    setAnalysisReadyForProject(null);
    const fallbackHypotheses = cached.hypotheses;
    const fallbackRequests = cached.archiveRequests;

    void (async () => {
      try {
        const remote = await listProjectAnalysisRecords(projectId);

        if (!active) return;
        saveProjectAnalysisRecordsCache(
          projectId,
          remote.hypotheses,
          remote.archiveRequests,
        );
        setProjectHypotheses(remote.hypotheses);
        setProjectArchiveRequests(remote.archiveRequests);
        setAnalysisReadyForProject(projectId);
      } catch (error) {
        if (!active) return;
        notify(
          describeError(
            error,
            fallbackHypotheses.length || fallbackRequests.length
              ? "Не вдалося оновити гіпотези й архівні запити з бази. Показано локальний кеш."
              : "Не вдалося завантажити гіпотези й архівні запити з бази.",
          ),
          true,
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [
    account,
    describeError,
    notify,
    shouldLoadAnalysis,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace || !account) {
      setProjectCustomFields([]);
      setProjectCustomSections([]);
      setProjectCustomRecords([]);
      setCustomStructureReadyForProject(null);
      return;
    }

    let active = true;
    const projectId = workspace.projectId;
    setCustomStructureReadyForProject(null);
    const cached = loadProjectCustomStructureCache(projectId);
    const includeRecords =
      page === "settings" ||
      page === "backup" ||
      page.startsWith("custom:");
    const hasCached =
      cached.definitions.length || cached.sections.length || cached.records.length;
    const fallback = cached;
    setProjectCustomFields(fallback.definitions);
    setProjectCustomSections(fallback.sections);
    setProjectCustomRecords(fallback.records);

    void (async () => {
      try {
        const remote = await listProjectCustomStructure(projectId, includeRecords);
        const records = includeRecords ? remote.records : fallback.records;

        if (!active) return;
        saveProjectCustomStructureCache(
          projectId,
          remote.definitions,
          remote.sections,
          records,
        );
        setProjectCustomFields(remote.definitions);
        setProjectCustomSections(remote.sections);
        setProjectCustomRecords(records);
        setCustomStructureReadyForProject(projectId);
      } catch (error) {
        if (!active) return;
        notify(
          describeError(
            error,
            hasCached
              ? "Не вдалося оновити власні розділи з бази. Показано локальний кеш."
              : "Не вдалося завантажити власні розділи з бази.",
          ),
          true,
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [
    account,
    describeError,
    notify,
    page,
    workspace,
  ]);

  const activeDb = useMemo<AppDatabase>(
    () =>
      workspace
        ? {
            ...app.db,
            researches: projectResearches,
            persons: projectPersons,
            personRelations: projectPersonRelations,
            documents: projectDocuments,
            yearMatrix: projectYearMatrix,
            tasks: projectTasks,
            findings: projectFindings,
            hypotheses: projectHypotheses,
            archiveRequests: projectArchiveRequests,
            customSections: projectCustomSections,
            customSectionRecords: projectCustomRecords,
            activityLog: projectActivity,
            settings: {
              ...app.db.settings,
              ...projectPreferences,
              customFields: projectCustomFields,
            },
          }
        : app.db,
    [
      app.db,
      projectDocuments,
      projectArchiveRequests,
      projectActivity,
      projectCustomFields,
      projectCustomRecords,
      projectCustomSections,
      projectFindings,
      projectHypotheses,
      projectPersonRelations,
      projectPersons,
      projectPreferences,
      projectResearches,
      projectTasks,
      projectYearMatrix,
      workspace,
    ],
  );

  const realtimeProjectId = workspace?.projectId ?? "";
  const realtimeUserId = account?.id ?? "";
  const realtimeViewRef = useRef({
    page,
    projectPreferences,
    notify,
    describeError,
  });
  realtimeViewRef.current = {
    page,
    projectPreferences,
    notify,
    describeError,
  };

  useEffect(() => {
    if (!realtimeProjectId || !realtimeUserId) return;
    const projectId = realtimeProjectId;
    let active = true;
    let refreshing = false;
    const queued = new Set<ProjectRealtimeGroup>();

    const refreshGroups = async (groups: Set<ProjectRealtimeGroup>) => {
      groups.forEach((group) => queued.add(group));
      if (refreshing) return;
      refreshing = true;
      try {
        while (active && queued.size) {
          const current = new Set(queued);
          queued.clear();
          const jobs: Promise<void>[] = [];

          if (current.has("project")) {
            jobs.push(
              loadProjectPreferences(
                projectId,
                realtimeViewRef.current.projectPreferences,
              ).then(
                (preferences) => {
                  if (activeWorkspaceIdRef.current !== projectId) return;
                  syncedPreferencesRef.current = {
                    projectId,
                    value: JSON.stringify(preferences),
                  };
                  setProjectPreferences(preferences);
                },
              ),
            );
          }
          if (current.has("researches")) {
            jobs.push(
              listProjectResearches(projectId).then((records) => {
                if (activeWorkspaceIdRef.current !== projectId) return;
                setProjectResearches(records);
                saveProjectResearchCache(projectId, records);
              }),
            );
          }
          if (current.has("people")) {
            jobs.push(
              listProjectPeople(projectId).then((records) => {
                if (activeWorkspaceIdRef.current !== projectId) return;
                setProjectPersons(records.persons);
                setProjectPersonRelations(records.relations);
                saveProjectPeopleCache(
                  projectId,
                  records.persons,
                  records.relations,
                );
              }),
            );
          }
          if (current.has("documents")) {
            jobs.push(
              listProjectDocuments(projectId).then((records) => {
                if (activeWorkspaceIdRef.current !== projectId) return;
                setProjectDocuments(records.documents);
                setProjectYearMatrix(records.yearMatrix);
                saveProjectDocumentsCache(
                  projectId,
                  records.documents,
                  records.yearMatrix,
                );
              }),
            );
          }
          if (current.has("work")) {
            jobs.push(
              listProjectWorkRecords(projectId).then((records) => {
                if (activeWorkspaceIdRef.current !== projectId) return;
                setProjectTasks(records.tasks);
                setProjectFindings(records.findings);
                saveProjectWorkRecordsCache(
                  projectId,
                  records.tasks,
                  records.findings,
                );
              }),
            );
          }
          if (current.has("analysis")) {
            jobs.push(
              listProjectAnalysisRecords(projectId).then((records) => {
                if (activeWorkspaceIdRef.current !== projectId) return;
                setProjectHypotheses(records.hypotheses);
                setProjectArchiveRequests(records.archiveRequests);
                saveProjectAnalysisRecordsCache(
                  projectId,
                  records.hypotheses,
                  records.archiveRequests,
                );
              }),
            );
          }
          if (current.has("custom")) {
            const currentPage = realtimeViewRef.current.page;
            const includeRecords =
              currentPage === "settings" ||
              currentPage === "backup" ||
              currentPage.startsWith("custom:");
            jobs.push(
              listProjectCustomStructure(projectId, includeRecords).then((records) => {
                if (activeWorkspaceIdRef.current !== projectId) return;
                const nextRecords = includeRecords
                  ? records.records
                  : loadProjectCustomStructureCache(projectId).records;
                setProjectCustomFields(records.definitions);
                setProjectCustomSections(records.sections);
                setProjectCustomRecords(nextRecords);
                saveProjectCustomStructureCache(
                  projectId,
                  records.definitions,
                  records.sections,
                  nextRecords,
                );
              }),
            );
          }
          if (current.has("activity")) {
            jobs.push(
              listProjectActivity(projectId, 10).then((records) => {
                if (activeWorkspaceIdRef.current === projectId) {
                  setProjectActivity(records);
                }
              }),
            );
          }
          if (
            realtimeViewRef.current.page === "dashboard" &&
            [...current].some((group) => group !== "activity")
          ) {
            jobs.push(
              loadProjectDashboard(projectId, { force: true }).then((dashboard) => {
                if (activeWorkspaceIdRef.current !== projectId) return;
                setDashboardStats(dashboard.stats);
                setDashboardTasks(dashboard.tasks);
              }),
            );
          }

          const results = await Promise.allSettled(jobs);
          if (results.some((result) => result.status === "rejected")) {
            throw new Error("Не вдалося оновити частину змін проєкту.");
          }
        }
      } catch (error) {
        if (active) {
          realtimeViewRef.current.notify(
            realtimeViewRef.current.describeError(
              error,
              "Не вдалося отримати зміни проєкту.",
            ),
            true,
          );
        }
      } finally {
        refreshing = false;
      }
    };

    const applyRealtimeMutation = async (
      change: ProjectRealtimeEntityChange,
    ): Promise<boolean> => {
      const mutation = realtimeRecordMutation(change);
      if (!mutation) return false;
      const { module, entityId, operation } = mutation;
      const shouldApply = () =>
        active && activeWorkspaceIdRef.current === projectId;

      if (operation === "delete") {
        if (!shouldApply()) return true;
        if (module === "researches") {
          setProjectResearches((records) => removeRealtimeRecord(records, entityId));
        } else if (module === "persons") {
          setProjectPersons((records) => removeRealtimeRecord(records, entityId));
          setProjectPersonRelations((records) =>
            records.filter(
              (relation) =>
                relation.personId !== entityId &&
                relation.relatedPersonId !== entityId,
              ),
          );
        } else if (module === "personRelations") {
          setProjectPersonRelations((records) => removeRealtimeRecord(records, entityId));
        } else if (module === "documents") {
          setProjectDocuments((records) => removeRealtimeRecord(records, entityId));
        } else if (module === "yearMatrix") {
          setProjectYearMatrix((records) => removeRealtimeRecord(records, entityId));
        } else if (module === "tasks") {
          setProjectTasks((records) => removeRealtimeRecord(records, entityId));
        } else if (module === "findings") {
          setProjectFindings((records) => removeRealtimeRecord(records, entityId));
        } else if (module === "hypotheses") {
          setProjectHypotheses((records) => removeRealtimeRecord(records, entityId));
        } else if (module === "archiveRequests") {
          setProjectArchiveRequests((records) => removeRealtimeRecord(records, entityId));
        }
        return true;
      }

      if (module === "researches") {
        const record = await getProjectResearch(projectId, entityId);
        if (shouldApply()) {
          setProjectResearches((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "persons") {
        const record = await getProjectPerson(projectId, entityId);
        if (shouldApply()) {
          setProjectPersons((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "personRelations") {
        const record = await getProjectPersonRelation(projectId, entityId);
        if (shouldApply()) {
          setProjectPersonRelations((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "documents") {
        const record = await getProjectDocument(projectId, entityId);
        if (shouldApply()) {
          setProjectDocuments((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "yearMatrix") {
        const record = await getProjectYearMatrixRecord(projectId, entityId);
        if (shouldApply()) {
          setProjectYearMatrix((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "tasks") {
        const record = await getProjectTask(projectId, entityId);
        if (shouldApply()) {
          setProjectTasks((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "findings") {
        const record = await getProjectFinding(projectId, entityId);
        if (shouldApply()) {
          setProjectFindings((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "hypotheses") {
        const record = await getProjectHypothesis(projectId, entityId);
        if (shouldApply()) {
          setProjectHypotheses((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      } else if (module === "archiveRequests") {
        const record = await getProjectArchiveRequest(projectId, entityId);
        if (shouldApply()) {
          setProjectArchiveRequests((records) => record
            ? upsertRealtimeRecord(records, record)
            : removeRealtimeRecord(records, entityId));
        }
      }
      return true;
    };

    const unsubscribe = subscribeProjectRealtime(
      projectId,
      realtimeUserId,
      (groups, changedByOtherUser, changes) => {
        if (changedByOtherUser) {
          realtimeViewRef.current.notify(
            "Інший учасник оновив дані проєкту.",
          );
        }
        void (async () => {
          const fallbackGroups = new Set(
            [...groups].filter((group) => group !== "activity"),
          );
          for (const group of [...fallbackGroups]) {
            const groupChanges = changes.filter((change) => change.group === group);
            if (!groupChanges.length) continue;
            const results = await Promise.allSettled(
              groupChanges.map(applyRealtimeMutation),
            );
            if (
              results.every(
                (result) => result.status === "fulfilled" && result.value,
              )
            ) {
              fallbackGroups.delete(group);
            }
          }

          await refreshGroups(new Set(["activity", ...fallbackGroups]));
          if (
            active &&
            changes.length > 0 &&
            fallbackGroups.size === 0 &&
            realtimeViewRef.current.page === "dashboard"
          ) {
            const dashboard = await loadProjectDashboard(projectId, { force: true });
            if (activeWorkspaceIdRef.current === projectId) {
              setDashboardStats(dashboard.stats);
              setDashboardTasks(dashboard.tasks);
            }
          }
        })().catch((error: unknown) => {
          if (!active) return;
          realtimeViewRef.current.notify(
            realtimeViewRef.current.describeError(
              error,
              "Не вдалося отримати зміни проєкту.",
            ),
            true,
          );
        });
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [realtimeProjectId, realtimeUserId]);

  useEffect(() => {
    if (
      !workspace ||
      workspace.role !== "owner" ||
      projectPreferencesReadyFor !== workspace.projectId ||
      researchesReadyForProject !== workspace.projectId ||
      peopleReadyForProject !== workspace.projectId ||
      documentsReadyForProject !== workspace.projectId ||
      workRecordsReadyForProject !== workspace.projectId ||
      analysisReadyForProject !== workspace.projectId ||
      customStructureReadyForProject !== workspace.projectId
    ) {
      return;
    }

    const projectId = workspace.projectId;
    const today = new Date().toISOString().slice(0, 10);
    if (projectPreferences.lastAutomaticBackupAt?.slice(0, 10) === today) return;
    if (automaticProjectBackupRef.current === projectId) return;
    automaticProjectBackupRef.current = projectId;

    void createProjectBackup(projectId, activeDb, "automatic")
      .then(async () => {
        const lastAutomaticBackupAt = new Date().toISOString();
        const next = { ...projectPreferences, lastAutomaticBackupAt };
        syncedPreferencesRef.current = {
          projectId,
          value: JSON.stringify(next),
        };
        setProjectPreferences(next);
        await saveProjectPreferences(projectId, next);
      })
      .catch((error: unknown) => {
        if (syncedPreferencesRef.current?.projectId === projectId) {
          syncedPreferencesRef.current = null;
        }
        notify(
          describeError(
            error,
            "Не вдалося створити автоматичну резервну копію проєкту.",
          ),
          true,
        );
      })
      .finally(() => {
        if (automaticProjectBackupRef.current === projectId) {
          automaticProjectBackupRef.current = null;
        }
      });
  }, [
    activeDb,
    analysisReadyForProject,
    customStructureReadyForProject,
    describeError,
    documentsReadyForProject,
    notify,
    peopleReadyForProject,
    projectPreferences,
    projectPreferencesReadyFor,
    researchesReadyForProject,
    workRecordsReadyForProject,
    workspace,
  ]);

  const recordProjectActivity = useCallback((
    module: ActivityModule,
    relatedId: string,
    text: string,
    actionType: ActivityLogEntry["actionType"],
    mutationEntityId?: string,
  ) => {
    if (!workspace) return;
    const entry = createGenericProjectActivity(
      module,
      relatedId,
      text,
      actionType,
      mutationEntityId,
    );
    void addProjectActivity(workspace.projectId, entry)
      .then((saved) => {
        if (activeWorkspaceIdRef.current !== workspace.projectId) return;
        setProjectActivity((current) => [
          saved,
          ...current.filter((item) => item.id !== saved.id),
        ].slice(0, 100));
      })
      .catch(() => undefined);
  }, [workspace]);

  const recordEntityActivity = useCallback((
    collection: CollectionKey,
    previous: AppEntity | undefined,
    next: AppEntity,
  ) => {
    if (!workspace) return;
    const generated = createActivityEntries(collection, previous, next);
    const entries = generated.length
      ? generated
      : [
          createGenericProjectActivity(
            collection,
            next.id,
            `${previous ? "Оновлено" : "Створено"} запис у розділі «${activityModuleLabel(collection)}».`,
            previous ? "record_updated" : "record_created",
          ),
        ];
    for (const entry of entries) {
      void addProjectActivity(workspace.projectId, entry)
        .then((saved) => {
          if (activeWorkspaceIdRef.current !== workspace.projectId) return;
          setProjectActivity((current) => [
            saved,
            ...current.filter((item) => item.id !== saved.id),
          ].slice(0, 100));
        })
        .catch(() => undefined);
    }
  }, [workspace]);

  const recordEntityDeletion = useCallback((
    collection: CollectionKey,
    relatedId: string,
  ) => {
    if (!workspace) return;
    const entry = createGenericProjectActivity(
      collection,
      relatedId,
      `Видалено запис із розділу «${activityModuleLabel(collection)}».`,
      "record_deleted",
    );
    void addProjectActivity(workspace.projectId, entry)
      .then((saved) => {
        if (activeWorkspaceIdRef.current !== workspace.projectId) return;
        setProjectActivity((current) => [saved, ...current].slice(0, 100));
      })
      .catch(() => undefined);
  }, [workspace]);

  const syncEntityAttachmentMetadata = useCallback((
    collection: CollectionKey,
    entity: AppEntity,
  ) => {
    if (!workspace) return;
    const fields = projectAttachmentFields(collection, entity, activeDb);
    void syncProjectAttachmentMetadata(
      workspace.projectId,
      collection,
      entity.id,
      fields,
    ).catch((error: unknown) => {
      notify(
        describeError(error, "Запис збережено, але не вдалося оновити метадані вкладень."),
        true,
      );
    });
  }, [activeDb, describeError, notify, workspace]);

  const deleteEntityAttachmentMetadata = useCallback((
    collection: CollectionKey,
    relatedId: string,
  ) => {
    if (!workspace) return;
    void deleteProjectAttachmentMetadata(
      workspace.projectId,
      collection,
      relatedId,
    ).catch(() => undefined);
  }, [workspace]);

  const signIn = async () => {
    setLoginError("");
    setIsAccountSigningIn(true);
    try {
      await signInWithSupabaseGoogle();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не вдалося увійти через Google.";
      setLoginError(message);
      setIsAccountSigningIn(false);
      notify(message, true);
    }
  };

  const completePasswordRecovery = async (password: string) => {
    setLoginError("");
    await updateSupabasePassword(password);
    passwordRecoveryRef.current = false;
    setPasswordRecovery(false);
    const cleanUrl = new URL(import.meta.env.BASE_URL, window.location.href);
    window.location.replace(cleanUrl.toString());
  };

  const signOutAccount = async () => {
    try {
      clearGoogleDriveSession();
      await signOutFromSupabase();
      setAccount(null);
      setWorkspace(null);
      setWorkspaces([]);
      setAuthReady(true);
      lastPreparedUserRef.current = null;
      workspaceSetupRef.current = null;
      // Wipe cached personal project data so it cannot be read by the next
      // user of a shared browser after sign-out.
      clearAllProjectCaches();
      localStorage.removeItem(ACCOUNT_ONBOARDING_KEY);
      localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
      setOnboarded(false);
      setLoginError("");
      routerNavigate("/", { replace: true });
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Не вдалося вийти з облікового запису.",
        true,
      );
    }
  };

  const switchWorkspace = (projectId: string) => {
    const nextWorkspace = workspaces.find((item) => item.projectId === projectId);
    if (!nextWorkspace) return;
    setWorkspace(nextWorkspace);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, nextWorkspace.projectId);
    routerNavigate(projectDashboardPath(nextWorkspace.projectSlug));
    notify(`Активний проєкт: ${nextWorkspace.projectName}`);
  };

  const createWorkspace = async () => {
    const session = await getSupabaseSession();
    if (!session || !account) {
      notify("Спочатку увійдіть до облікового запису.", true);
      return;
    }
    if (!subscriptionAccess.canCreateProject) {
      setUpgradeReason({
        featureName: "Створення проєкту",
        reason: "Ви використали доступну кількість проєктів для поточного тарифу.",
        recommendedPlan: "researcher",
        used: subscriptionAccess.getUsage("projects"),
        limit: subscriptionAccess.getLimit("projects")?.value ?? undefined,
      });
      return;
    }

    const proposedName = window.prompt("Назва нового проєкту", `Проєкт ${account.name}`);
    if (proposedName === null) return;

    setIsCreatingWorkspace(true);
    try {
      const createdWorkspace = await createSupabaseWorkspace(session, proposedName);
      const refreshed = await listSupabaseWorkspaces();
      const availableWorkspaces = refreshed.length ? refreshed : [...workspaces, createdWorkspace];
      setWorkspaces(availableWorkspaces);
      const activeWorkspace =
        availableWorkspaces.find((item) => item.projectId === createdWorkspace.projectId) ??
        createdWorkspace;
      setWorkspace(activeWorkspace);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspace.projectId);
      routerNavigate(projectDashboardPath(activeWorkspace.projectSlug));
      notify(`Створено проєкт «${activeWorkspace.projectName}».`);
      void subscriptionAccess.refreshSubscription();
    } catch (error) {
      notify(describeError(error, "Не вдалося створити новий проєкт."), true);
    } finally {
      setIsCreatingWorkspace(false);
    }
  };

  const removeWorkspace = async (projectId: string) => {
    const targetWorkspace = workspaces.find((item) => item.projectId === projectId);
    if (!targetWorkspace) return;
    if (targetWorkspace.role !== "owner") {
      notify("Видаляти можна лише проєкти, де ви власник.", true);
      return;
    }
    if (workspaces.length <= 1) {
      notify("Не можна видалити останній проєкт.", true);
      return;
    }

    const confirmed = window.confirm(
      `Видалити проєкт «${targetWorkspace.projectName}»? Цю дію не можна скасувати.`,
    );
    if (!confirmed) return;

    setIsCreatingWorkspace(true);
    try {
      const refreshed = await deleteSupabaseWorkspace(projectId);
      clearProjectResearchCache(projectId);
      clearProjectPeopleCache(projectId);
      clearProjectDocumentsCache(projectId);
      clearProjectWorkRecordsCache(projectId);
      clearProjectAnalysisRecordsCache(projectId);
      clearProjectCustomStructureCache(projectId);
      const nextWorkspace = chooseWorkspace(
        refreshed,
        workspace?.projectId === projectId ? null : workspace?.projectId ?? null,
      );
      setWorkspaces(refreshed);
      setWorkspace(nextWorkspace);
      if (nextWorkspace) {
        localStorage.setItem(ACTIVE_WORKSPACE_KEY, nextWorkspace.projectId);
        routerNavigate(projectDashboardPath(nextWorkspace.projectSlug));
      } else {
        localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
        routerNavigate("/projects");
      }
      notify(`Проєкт «${targetWorkspace.projectName}» видалено.`);
    } catch (error) {
      notify(describeError(error, "Не вдалося видалити проєкт."), true);
    } finally {
      setIsCreatingWorkspace(false);
    }
  };

  const renameWorkspace = async (projectId: string) => {
    const targetWorkspace = workspaces.find((item) => item.projectId === projectId);
    if (!targetWorkspace) return;
    if (targetWorkspace.role !== "owner") {
      notify("Перейменовувати проєкт може лише його власник.", true);
      return;
    }

    const proposedName = window.prompt(
      "Нова назва проєкту",
      targetWorkspace.projectName,
    );
    if (proposedName === null || proposedName.trim() === targetWorkspace.projectName) return;

    setIsCreatingWorkspace(true);
    try {
      const refreshed = await renameSupabaseWorkspace(projectId, proposedName);
      const renamedWorkspace = refreshed.find((item) => item.projectId === projectId);
      setWorkspaces(refreshed);
      setWorkspace((current) =>
        current?.projectId === projectId && renamedWorkspace
          ? renamedWorkspace
          : current,
      );
      if (workspace?.projectId === projectId && renamedWorkspace) {
        routerNavigate(
          pagePath(renamedWorkspace.projectSlug, page, projectCustomSections),
          { replace: true },
        );
      }
      notify(`Проєкт перейменовано на «${renamedWorkspace?.projectName ?? proposedName.trim()}».`);
    } catch (error) {
      notify(describeError(error, "Не вдалося перейменувати проєкт."), true);
    } finally {
      setIsCreatingWorkspace(false);
    }
  };

  const acceptWorkspaceInvitation = async (projectId: string) => {
    const refreshed = await listSupabaseWorkspaces(projectId);
    const acceptedWorkspace = refreshed.find((item) => item.projectId === projectId);
    setWorkspaces(refreshed);
    if (acceptedWorkspace) {
      setWorkspace(acceptedWorkspace);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, acceptedWorkspace.projectId);
      routerNavigate(projectDashboardPath(acceptedWorkspace.projectSlug));
      notify(`Проєкт «${acceptedWorkspace.projectName}» додано до вашого робочого простору.`);
    } else {
      notify("Запрошення прийнято, але проєкт ще не з’явився. Оновіть сторінку.", true);
    }
    setTeamOpen(false);
  };

  if (route.kind === "public") {
    if (route.page === "privacy") return <PrivacyPage />;
    if (route.page === "terms") return <TermsPage />;
    if (route.page === "features") return <FeaturesPage />;
    return <PricingPage />;
  }

  if (!account) {
    return (
      <LoginPage
        onGoogle={() => void signIn()}
        onEmailSignIn={signInWithSupabaseEmail}
        onEmailSignUp={signUpWithSupabaseEmail}
        onPasswordResetRequest={requestSupabasePasswordReset}
        onPasswordUpdate={completePasswordRecovery}
        passwordRecovery={passwordRecovery}
        loading={isAccountSigningIn}
        error={loginError}
      />
    );
  }

  const saveResearch = (entity: AppEntity) => {
    if (!workspace) {
      app.saveEntity("researches", entity);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const research = entity as Research;
    const projectId = workspace.projectId;
    const previous = projectResearches;
    const previousEntity = previous.find((item) => item.id === research.id);
    if (!previousEntity && !subscriptionAccess.canCreateResearch) {
      setUpgradeReason({
        featureName: "Нове дослідження",
        reason: researchLimitMessage || "Досягнуто ліміт досліджень для поточного тарифу.",
        recommendedPlan: "researcher",
        used: subscriptionAccess.getUsage("researches_per_project"),
        limit: subscriptionAccess.getLimit("researches_per_project")?.value ?? undefined,
      });
      return;
    }
    const optimistic = previous.some((item) => item.id === research.id)
      ? previous.map((item) => (item.id === research.id ? research : item))
      : [research, ...previous];
    setProjectResearches(optimistic);
    saveProjectResearchCache(projectId, optimistic);

    void assertProjectRecordUnchanged(
      "researches",
      projectId,
      research.id,
      baseUpdatedAt(research) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectResearch(projectId, research))
      .then((saved) => {
        if (!previousEntity) void subscriptionAccess.refreshSubscription();
        recordEntityActivity("researches", previousEntity, saved);
        syncEntityAttachmentMetadata("researches", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectResearchCache(projectId);
          const next = cached.map((item) => (item.id === saved.id ? saved : item));
          saveProjectResearchCache(projectId, next);
          return;
        }
        setProjectResearches((current) => {
          const next = current.map((item) => (item.id === saved.id ? saved : item));
          saveProjectResearchCache(projectId, next);
          return next;
        });
      })
      .catch((error: unknown) => {
        saveProjectResearchCache(projectId, previous);
        if (activeWorkspaceIdRef.current === projectId) {
          setProjectResearches(previous);
        }
        notify(describeError(error, "Не вдалося зберегти дослідження."), true);
      });
  };

  const removeResearch = (id: string) => {
    if (!workspace) {
      app.deleteEntity("researches", id);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectResearches;
    const previousPersons = projectPersons;
    const previousDocuments = projectDocuments;
    const previousMatrix = projectYearMatrix;
    const previousTasks = projectTasks;
    const previousFindings = projectFindings;
    const previousHypotheses = projectHypotheses;
    const previousRequests = projectArchiveRequests;
    const optimistic = previous.filter((research) => research.id !== id);
    const nextPersons = previousPersons.map((person) =>
      person.researchId === id ? { ...person, researchId: "" } : person,
    );
    const nextDocuments = previousDocuments.map((document) =>
      document.researchId === id ? { ...document, researchId: "" } : document,
    );
    const nextMatrix = previousMatrix.map((record) =>
      record.researchId === id ? { ...record, researchId: "" } : record,
    );
    const nextTasks = previousTasks.map((task) =>
      task.researchId === id ? { ...task, researchId: "" } : task,
    );
    const nextFindings = previousFindings.map((finding) =>
      finding.researchId === id ? { ...finding, researchId: "" } : finding,
    );
    const nextHypotheses = previousHypotheses.map((hypothesis) =>
      hypothesis.researchId === id
        ? { ...hypothesis, researchId: "" }
        : hypothesis,
    );
    const nextRequests = previousRequests.map((request) =>
      request.researchId === id ? { ...request, researchId: "" } : request,
    );
    setProjectResearches(optimistic);
    setProjectPersons(nextPersons);
    setProjectDocuments(nextDocuments);
    setProjectYearMatrix(nextMatrix);
    setProjectTasks(nextTasks);
    setProjectFindings(nextFindings);
    setProjectHypotheses(nextHypotheses);
    setProjectArchiveRequests(nextRequests);
    saveProjectResearchCache(projectId, optimistic);
    saveProjectPeopleCache(projectId, nextPersons, projectPersonRelations);
    saveProjectDocumentsCache(projectId, nextDocuments, nextMatrix);
    saveProjectWorkRecordsCache(projectId, nextTasks, nextFindings);
    saveProjectAnalysisRecordsCache(
      projectId,
      nextHypotheses,
      nextRequests,
    );

    void deleteProjectResearch(projectId, id).then(() => {
      recordEntityDeletion("researches", id);
      deleteEntityAttachmentMetadata("researches", id);
    }).catch((error: unknown) => {
      saveProjectResearchCache(projectId, previous);
      saveProjectPeopleCache(projectId, previousPersons, projectPersonRelations);
      saveProjectDocumentsCache(projectId, previousDocuments, previousMatrix);
      saveProjectWorkRecordsCache(projectId, previousTasks, previousFindings);
      saveProjectAnalysisRecordsCache(
        projectId,
        previousHypotheses,
        previousRequests,
      );
      if (activeWorkspaceIdRef.current === projectId) {
        setProjectResearches(previous);
        setProjectPersons(previousPersons);
        setProjectDocuments(previousDocuments);
        setProjectYearMatrix(previousMatrix);
        setProjectTasks(previousTasks);
        setProjectFindings(previousFindings);
        setProjectHypotheses(previousHypotheses);
        setProjectArchiveRequests(previousRequests);
      }
      notify(describeError(error, "Не вдалося видалити дослідження."), true);
    });
  };

  const saveDocument = (entity: AppEntity) => {
    if (!workspace) {
      app.saveEntity("documents", entity);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const document = entity as DocumentRecord;
    const projectId = workspace.projectId;
    const previous = projectDocuments;
    const previousEntity = previous.find((item) => item.id === document.id);
    if (!previousEntity && !ensureCanCreateProjectRecord("Новий документ")) return;
    const optimistic = previous.some((item) => item.id === document.id)
      ? previous.map((item) => (item.id === document.id ? document : item))
      : [document, ...previous];
    setProjectDocuments(optimistic);
    saveProjectDocumentsCache(projectId, optimistic, projectYearMatrix);

    void assertProjectRecordUnchanged(
      "documents",
      projectId,
      document.id,
      baseUpdatedAt(document) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectDocument(
        projectId,
        document,
        new Set(projectResearches.map((research) => research.id)),
      ))
      .then((saved) => {
        refreshSubscriptionAfterCreate(previousEntity);
        recordEntityActivity("documents", previousEntity, saved);
        syncEntityAttachmentMetadata("documents", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectDocumentsCache(projectId);
          const documents = cached.documents.map((item) =>
            item.id === saved.id ? saved : item,
          );
          saveProjectDocumentsCache(projectId, documents, cached.yearMatrix);
          return;
        }
        setProjectDocuments((current) => {
          const next = current.map((item) => (item.id === saved.id ? saved : item));
          saveProjectDocumentsCache(projectId, next, projectYearMatrix);
          return next;
        });
      })
      .catch((error: unknown) => {
        const cached = loadProjectDocumentsCache(projectId);
        saveProjectDocumentsCache(projectId, previous, cached.yearMatrix);
        if (activeWorkspaceIdRef.current === projectId) setProjectDocuments(previous);
        notify(describeError(error, "Не вдалося зберегти документ."), true);
      });
  };

  const removeDocument = (id: string) => {
    if (!workspace) {
      app.deleteEntity("documents", id);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previousDocuments = projectDocuments;
    const previousMatrix = projectYearMatrix;
    const previousTasks = projectTasks;
    const previousFindings = projectFindings;
    const previousHypotheses = projectHypotheses;
    const nextDocuments = previousDocuments.filter((document) => document.id !== id);
    const nextMatrix = previousMatrix.map((record) =>
      record.documentId === id ? { ...record, documentId: "" } : record,
    );
    const nextTasks = previousTasks.map((task) =>
      task.documentId === id ? { ...task, documentId: "" } : task,
    );
    const nextFindings = previousFindings.map((finding) =>
      finding.documentId === id ? { ...finding, documentId: "" } : finding,
    );
    const nextHypotheses = previousHypotheses.map((hypothesis) => ({
      ...hypothesis,
      documentIds: hypothesis.documentIds.filter((documentId) => documentId !== id),
    }));
    setProjectDocuments(nextDocuments);
    setProjectYearMatrix(nextMatrix);
    setProjectTasks(nextTasks);
    setProjectFindings(nextFindings);
    setProjectHypotheses(nextHypotheses);
    saveProjectDocumentsCache(projectId, nextDocuments, nextMatrix);
    saveProjectWorkRecordsCache(projectId, nextTasks, nextFindings);
    saveProjectAnalysisRecordsCache(
      projectId,
      nextHypotheses,
      projectArchiveRequests,
    );

    void Promise.all([
      deleteProjectDocument(projectId, id),
      deleteProjectHypothesisTargetLinks(projectId, "document", id),
    ]).then(() => {
      recordEntityDeletion("documents", id);
      deleteEntityAttachmentMetadata("documents", id);
    }).catch((error: unknown) => {
      saveProjectDocumentsCache(projectId, previousDocuments, previousMatrix);
      saveProjectWorkRecordsCache(projectId, previousTasks, previousFindings);
      saveProjectAnalysisRecordsCache(
        projectId,
        previousHypotheses,
        projectArchiveRequests,
      );
      if (activeWorkspaceIdRef.current === projectId) {
        setProjectDocuments(previousDocuments);
        setProjectYearMatrix(previousMatrix);
        setProjectTasks(previousTasks);
        setProjectFindings(previousFindings);
        setProjectHypotheses(previousHypotheses);
      }
      notify(describeError(error, "Не вдалося видалити документ."), true);
    });
  };

  const saveYearMatrixRecord = (entity: AppEntity) => {
    if (!workspace) {
      app.saveEntity("yearMatrix", entity);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const record = entity as YearMatrixRecord;
    const projectId = workspace.projectId;
    const previous = projectYearMatrix;
    const previousEntity = previous.find((item) => item.id === record.id);
    if (!previousEntity && !ensureCanCreateProjectRecord("Новий запис матриці років")) return;
    const optimistic = previous.some((item) => item.id === record.id)
      ? previous.map((item) => (item.id === record.id ? record : item))
      : [record, ...previous];
    setProjectYearMatrix(optimistic);
    saveProjectDocumentsCache(projectId, projectDocuments, optimistic);

    void assertProjectRecordUnchanged(
      "year_matrix",
      projectId,
      record.id,
      baseUpdatedAt(record) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectYearMatrixRecord(
        projectId,
        record,
        new Set(projectResearches.map((research) => research.id)),
        new Set(projectDocuments.map((document) => document.id)),
      ))
      .then((saved) => {
        refreshSubscriptionAfterCreate(previousEntity);
        recordEntityActivity("yearMatrix", previousEntity, saved);
        syncEntityAttachmentMetadata("yearMatrix", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectDocumentsCache(projectId);
          const yearMatrix = cached.yearMatrix.map((item) =>
            item.id === saved.id ? saved : item,
          );
          saveProjectDocumentsCache(projectId, cached.documents, yearMatrix);
          return;
        }
        setProjectYearMatrix((current) => {
          const next = current.map((item) => (item.id === saved.id ? saved : item));
          saveProjectDocumentsCache(projectId, projectDocuments, next);
          return next;
        });
      })
      .catch((error: unknown) => {
        const cached = loadProjectDocumentsCache(projectId);
        saveProjectDocumentsCache(projectId, cached.documents, previous);
        if (activeWorkspaceIdRef.current === projectId) setProjectYearMatrix(previous);
        notify(describeError(error, "Не вдалося зберегти запис матриці років."), true);
      });
  };

  const saveYearMatrixRange = (records: YearMatrixRecord[]) => {
    if (!records.length) return;
    if (!workspace) {
      for (const record of records) app.saveEntity("yearMatrix", record);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    if (!ensureCanCreateProjectRecord("Діапазон матриці років")) return;

    const projectId = workspace.projectId;
    const previous = projectYearMatrix;
    const recordIds = new Set(records.map((record) => record.id));
    const optimistic = [
      ...records,
      ...previous.filter((record) => !recordIds.has(record.id)),
    ];
    setProjectYearMatrix(optimistic);
    saveProjectDocumentsCache(projectId, projectDocuments, optimistic);

    void saveProjectYearMatrixRecords(
      projectId,
      records,
      new Set(projectResearches.map((research) => research.id)),
      new Set(projectDocuments.map((document) => document.id)),
    )
      .then((saved) => {
        if (activeWorkspaceIdRef.current !== projectId) return;
        const savedById = new Map(saved.map((record) => [record.id, record]));
        setProjectYearMatrix((current) => {
          const next = current.map((record) => savedById.get(record.id) ?? record);
          saveProjectDocumentsCache(projectId, projectDocuments, next);
          return next;
        });
        recordProjectActivity(
          "yearMatrix",
          saved[0]?.id ?? records[0].id,
          `Додано діапазон із ${saved.length || records.length} років до матриці.`,
          "record_created",
        );
        void subscriptionAccess.refreshSubscription();
        notify(`Додано ${saved.length || records.length} років до матриці.`);
      })
      .catch((error: unknown) => {
        saveProjectDocumentsCache(projectId, projectDocuments, previous);
        if (activeWorkspaceIdRef.current === projectId) {
          setProjectYearMatrix(previous);
        }
        notify(
          describeError(error, "Не вдалося зберегти діапазон років."),
          true,
        );
      });
  };

  const removeYearMatrixRecord = (id: string) => {
    if (!workspace) {
      app.deleteEntity("yearMatrix", id);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectYearMatrix;
    const optimistic = previous.filter((record) => record.id !== id);
    setProjectYearMatrix(optimistic);
    saveProjectDocumentsCache(projectId, projectDocuments, optimistic);
    void deleteProjectYearMatrixRecord(projectId, id).then(() => {
      recordEntityDeletion("yearMatrix", id);
      deleteEntityAttachmentMetadata("yearMatrix", id);
    }).catch((error: unknown) => {
      const cached = loadProjectDocumentsCache(projectId);
      saveProjectDocumentsCache(projectId, cached.documents, previous);
      if (activeWorkspaceIdRef.current === projectId) setProjectYearMatrix(previous);
      notify(describeError(error, "Не вдалося видалити запис матриці років."), true);
    });
  };

  const saveTask = (entity: AppEntity) => {
    if (!workspace) {
      app.saveEntity("tasks", entity);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const task = entity as TaskRecord;
    const projectId = workspace.projectId;
    const previous = projectTasks;
    const previousEntity = previous.find((item) => item.id === task.id);
    if (!previousEntity && !ensureCanCreateProjectRecord("Нове завдання")) return;
    const optimistic = previous.some((item) => item.id === task.id)
      ? previous.map((item) => (item.id === task.id ? task : item))
      : [task, ...previous];
    setProjectTasks(optimistic);
    saveProjectWorkRecordsCache(projectId, optimistic, projectFindings);

    void assertProjectRecordUnchanged(
      "tasks",
      projectId,
      task.id,
      baseUpdatedAt(task) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectTask(
        projectId,
        task,
        new Set(projectResearches.map((research) => research.id)),
        new Set(projectDocuments.map((document) => document.id)),
        new Set(projectPersons.map((person) => person.id)),
      ))
      .then((saved) => {
        refreshSubscriptionAfterCreate(previousEntity);
        recordEntityActivity("tasks", previousEntity, saved);
        syncEntityAttachmentMetadata("tasks", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectWorkRecordsCache(projectId);
          const tasks = cached.tasks.map((item) => (item.id === saved.id ? saved : item));
          saveProjectWorkRecordsCache(projectId, tasks, cached.findings);
          return;
        }
        setProjectTasks((current) => {
          const next = current.map((item) => (item.id === saved.id ? saved : item));
          saveProjectWorkRecordsCache(projectId, next, projectFindings);
          return next;
        });
      })
      .catch((error: unknown) => {
        const cached = loadProjectWorkRecordsCache(projectId);
        saveProjectWorkRecordsCache(projectId, previous, cached.findings);
        if (activeWorkspaceIdRef.current === projectId) setProjectTasks(previous);
        notify(describeError(error, "Не вдалося зберегти завдання."), true);
      });
  };

  const removeTask = (id: string) => {
    if (!workspace) {
      app.deleteEntity("tasks", id);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectTasks;
    const optimistic = previous.filter((task) => task.id !== id);
    setProjectTasks(optimistic);
    saveProjectWorkRecordsCache(projectId, optimistic, projectFindings);
    void deleteProjectTask(projectId, id).then(() => {
      recordEntityDeletion("tasks", id);
      deleteEntityAttachmentMetadata("tasks", id);
    }).catch((error: unknown) => {
      const cached = loadProjectWorkRecordsCache(projectId);
      saveProjectWorkRecordsCache(projectId, previous, cached.findings);
      if (activeWorkspaceIdRef.current === projectId) setProjectTasks(previous);
      notify(describeError(error, "Не вдалося видалити завдання."), true);
    });
  };

  const saveFinding = (entity: AppEntity): Promise<Finding | null> => {
    if (!workspace) {
      app.saveEntity("findings", entity);
      return Promise.resolve(entity as Finding);
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return Promise.resolve(null);
    }

    const finding = entity as Finding;
    const projectId = workspace.projectId;
    const previous = projectFindings;
    const previousEntity = previous.find((item) => item.id === finding.id);
    if (!previousEntity && !ensureCanCreateProjectRecord("Нова знахідка")) return Promise.resolve(null);
    const optimistic = previous.some((item) => item.id === finding.id)
      ? previous.map((item) => (item.id === finding.id ? finding : item))
      : [finding, ...previous];
    setProjectFindings(optimistic);
    saveProjectWorkRecordsCache(projectId, projectTasks, optimistic);

    return assertProjectRecordUnchanged(
      "findings",
      projectId,
      finding.id,
      baseUpdatedAt(finding) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectFinding(
        projectId,
        finding,
        new Set(projectResearches.map((research) => research.id)),
        new Set(projectDocuments.map((document) => document.id)),
        new Set([...projectPersons.map((person) => person.id), ...finding.personIds]),
      ))
      .then((saved) => {
        refreshSubscriptionAfterCreate(previousEntity);
        recordEntityActivity("findings", previousEntity, saved);
        syncEntityAttachmentMetadata("findings", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectWorkRecordsCache(projectId);
          const findings = cached.findings.map((item) =>
            item.id === saved.id ? saved : item,
          );
          saveProjectWorkRecordsCache(projectId, cached.tasks, findings);
          return saved;
        }
        setProjectFindings((current) => {
          const next = current.map((item) => (item.id === saved.id ? saved : item));
          saveProjectWorkRecordsCache(projectId, projectTasks, next);
          return next;
        });
        return saved;
      })
      .catch((error: unknown) => {
        const cached = loadProjectWorkRecordsCache(projectId);
        saveProjectWorkRecordsCache(projectId, cached.tasks, previous);
        if (activeWorkspaceIdRef.current === projectId) setProjectFindings(previous);
        notify(describeError(error, "Не вдалося зберегти знахідку."), true);
        return null;
      });
  };

  const removeFinding = (id: string) => {
    if (!workspace) {
      const localFinding = activeDb.findings.find((finding) => finding.id === id);
      if (!localFinding) {
        app.deleteEntity("findings", id);
        return;
      }
      void deleteEntityScanFiles("findings", localFinding, activeDb)
        .then(() => app.deleteEntity("findings", id))
        .catch((error: unknown) => {
          notify(describeError(error, "Не вдалося видалити файли знахідки з Google Drive."), true);
        });
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectFindings;
    const deletedFinding = previous.find((finding) => finding.id === id) ?? null;
    const previousHypotheses = projectHypotheses;
    const optimistic = previous.filter((finding) => finding.id !== id);
    const nextHypotheses = previousHypotheses.map((hypothesis) => ({
      ...hypothesis,
      findingIds: hypothesis.findingIds.filter((findingId) => findingId !== id),
    }));
    setProjectFindings(optimistic);
    setProjectHypotheses(nextHypotheses);
    saveProjectWorkRecordsCache(projectId, projectTasks, optimistic);
    saveProjectAnalysisRecordsCache(
      projectId,
      nextHypotheses,
      projectArchiveRequests,
    );
    void (deletedFinding
      ? deleteEntityScanFiles("findings", deletedFinding, activeDb)
      : Promise.resolve()
    ).then(() => Promise.all([
      deleteProjectFinding(projectId, id),
      deleteProjectHypothesisTargetLinks(projectId, "finding", id),
    ])).then(() => {
      recordEntityDeletion("findings", id);
      deleteEntityAttachmentMetadata("findings", id);
    }).catch((error: unknown) => {
      const cached = loadProjectWorkRecordsCache(projectId);
      saveProjectWorkRecordsCache(projectId, cached.tasks, previous);
      saveProjectAnalysisRecordsCache(
        projectId,
        previousHypotheses,
        projectArchiveRequests,
      );
      if (activeWorkspaceIdRef.current === projectId) {
        setProjectFindings(previous);
        setProjectHypotheses(previousHypotheses);
      }
      notify(describeError(error, "Не вдалося видалити знахідку."), true);
    });
  };

  const saveHypothesis = (entity: AppEntity) => {
    if (!workspace) {
      app.saveEntity("hypotheses", entity);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const hypothesis = entity as Hypothesis;
    const projectId = workspace.projectId;
    const previous = projectHypotheses;
    const previousEntity = previous.find((item) => item.id === hypothesis.id);
    if (!previousEntity && !ensureCanCreateProjectRecord("Нова гіпотеза")) return;
    const optimistic = previous.some((item) => item.id === hypothesis.id)
      ? previous.map((item) => (item.id === hypothesis.id ? hypothesis : item))
      : [hypothesis, ...previous];
    setProjectHypotheses(optimistic);
    saveProjectAnalysisRecordsCache(
      projectId,
      optimistic,
      projectArchiveRequests,
    );

    void assertProjectRecordUnchanged(
      "hypotheses",
      projectId,
      hypothesis.id,
      baseUpdatedAt(hypothesis) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectHypothesis(
        projectId,
        hypothesis,
        new Set(projectResearches.map((research) => research.id)),
        new Set(projectPersons.map((person) => person.id)),
        new Set(projectDocuments.map((document) => document.id)),
        new Set(projectFindings.map((finding) => finding.id)),
      ))
      .then((saved) => {
        refreshSubscriptionAfterCreate(previousEntity);
        recordEntityActivity("hypotheses", previousEntity, saved);
        syncEntityAttachmentMetadata("hypotheses", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectAnalysisRecordsCache(projectId);
          const hypotheses = cached.hypotheses.map((item) =>
            item.id === saved.id ? saved : item,
          );
          saveProjectAnalysisRecordsCache(
            projectId,
            hypotheses,
            cached.archiveRequests,
          );
          return;
        }
        setProjectHypotheses((current) => {
          const next = current.map((item) =>
            item.id === saved.id ? saved : item,
          );
          saveProjectAnalysisRecordsCache(
            projectId,
            next,
            projectArchiveRequests,
          );
          return next;
        });
      })
      .catch((error: unknown) => {
        const cached = loadProjectAnalysisRecordsCache(projectId);
        saveProjectAnalysisRecordsCache(
          projectId,
          previous,
          cached.archiveRequests,
        );
        if (activeWorkspaceIdRef.current === projectId) {
          setProjectHypotheses(previous);
        }
        notify(describeError(error, "Не вдалося зберегти гіпотезу."), true);
      });
  };

  const removeHypothesis = (id: string) => {
    if (!workspace) {
      app.deleteEntity("hypotheses", id);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectHypotheses;
    const optimistic = previous.filter((hypothesis) => hypothesis.id !== id);
    setProjectHypotheses(optimistic);
    saveProjectAnalysisRecordsCache(
      projectId,
      optimistic,
      projectArchiveRequests,
    );
    void deleteProjectHypothesis(projectId, id).then(() => {
      recordEntityDeletion("hypotheses", id);
      deleteEntityAttachmentMetadata("hypotheses", id);
    }).catch((error: unknown) => {
      const cached = loadProjectAnalysisRecordsCache(projectId);
      saveProjectAnalysisRecordsCache(
        projectId,
        previous,
        cached.archiveRequests,
      );
      if (activeWorkspaceIdRef.current === projectId) {
        setProjectHypotheses(previous);
      }
      notify(describeError(error, "Не вдалося видалити гіпотезу."), true);
    });
  };

  const saveArchiveRequest = (entity: AppEntity) => {
    if (!workspace) {
      app.saveEntity("archiveRequests", entity);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const request = entity as ArchiveRequest;
    const projectId = workspace.projectId;
    const previous = projectArchiveRequests;
    const previousEntity = previous.find((item) => item.id === request.id);
    if (!previousEntity && !ensureCanCreateProjectRecord("Новий запит в архів")) return;
    const optimistic = previous.some((item) => item.id === request.id)
      ? previous.map((item) => (item.id === request.id ? request : item))
      : [request, ...previous];
    setProjectArchiveRequests(optimistic);
    saveProjectAnalysisRecordsCache(projectId, projectHypotheses, optimistic);

    void assertProjectRecordUnchanged(
      "archive_requests",
      projectId,
      request.id,
      baseUpdatedAt(request) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectArchiveRequest(
        projectId,
        request,
        new Set(projectResearches.map((research) => research.id)),
        new Set(projectPersons.map((person) => person.id)),
      ))
      .then((saved) => {
        refreshSubscriptionAfterCreate(previousEntity);
        recordEntityActivity("archiveRequests", previousEntity, saved);
        syncEntityAttachmentMetadata("archiveRequests", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectAnalysisRecordsCache(projectId);
          const requests = cached.archiveRequests.map((item) =>
            item.id === saved.id ? saved : item,
          );
          saveProjectAnalysisRecordsCache(
            projectId,
            cached.hypotheses,
            requests,
          );
          return;
        }
        setProjectArchiveRequests((current) => {
          const next = current.map((item) =>
            item.id === saved.id ? saved : item,
          );
          saveProjectAnalysisRecordsCache(projectId, projectHypotheses, next);
          return next;
        });
      })
      .catch((error: unknown) => {
        const cached = loadProjectAnalysisRecordsCache(projectId);
        saveProjectAnalysisRecordsCache(
          projectId,
          cached.hypotheses,
          previous,
        );
        if (activeWorkspaceIdRef.current === projectId) {
          setProjectArchiveRequests(previous);
        }
        notify(
          describeError(error, "Не вдалося зберегти запит до архіву."),
          true,
        );
      });
  };

  const removeArchiveRequest = (id: string) => {
    if (!workspace) {
      app.deleteEntity("archiveRequests", id);
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectArchiveRequests;
    const optimistic = previous.filter((request) => request.id !== id);
    setProjectArchiveRequests(optimistic);
    saveProjectAnalysisRecordsCache(projectId, projectHypotheses, optimistic);
    void deleteProjectArchiveRequest(projectId, id).then(() => {
      recordEntityDeletion("archiveRequests", id);
      deleteEntityAttachmentMetadata("archiveRequests", id);
    }).catch((error: unknown) => {
      const cached = loadProjectAnalysisRecordsCache(projectId);
      saveProjectAnalysisRecordsCache(
        projectId,
        cached.hypotheses,
        previous,
      );
      if (activeWorkspaceIdRef.current === projectId) {
        setProjectArchiveRequests(previous);
      }
      notify(
        describeError(error, "Не вдалося видалити запит до архіву."),
        true,
      );
    });
  };

  const saveFor = (collection: CollectionKey) => (entity: AppEntity): AppEntity | null | void | Promise<AppEntity | null | void> => {
    try {
      validateResearchScope(collection, [entity]);
    } catch (error) {
      notify(describeError(error, "Оберіть дослідження для цього запису."), true);
      return;
    }
    if (collection === "researches") saveResearch(entity);
    else if (collection === "documents") saveDocument(entity);
    else if (collection === "yearMatrix") saveYearMatrixRecord(entity);
    else if (collection === "tasks") saveTask(entity);
    else if (collection === "findings") return saveFinding(entity);
    else if (collection === "hypotheses") saveHypothesis(entity);
    else if (collection === "archiveRequests") saveArchiveRequest(entity);
    else app.saveEntity(collection, entity);
  };
  const validateResearchScope = (collection: CollectionKey, records: AppEntity[]) => {
    if (!researchRequiredByPlan || !researchScopedCollections.has(collection)) return;
    const missingCount = records.filter((record) =>
      !String((record as unknown as { researchId?: unknown }).researchId ?? "").trim(),
    ).length;
    if (missingCount > 0) {
      throw new Error(`На вашому тарифі кожен запис має бути прив’язаний до дослідження. Записів без дослідження: ${missingCount}.`);
    }
  };
  const importTableRecords = async (collection: CollectionKey, records: AppEntity[]) => {
    if (!records.length) return;
    validateResearchScope(collection, records);
    if (!workspace) {
      app.saveEntities(collection, records);
      notify(`Імпортовано записів: ${records.length}.`);
      return;
    }
    if (workspace.role === "viewer") {
      throw new Error("У цьому проєкті у вас є лише право перегляду.");
    }

    if (!canCreateProjectRecords) {
      throw new Error("У цьому проєкті можна редагувати й видаляти наявні дані, але імпорт нових записів заблокований поточним тарифом.");
    }
    const sectionQuotaKey = standardSectionQuotaKeys[collection];
    if (sectionQuotaKey && !canCreateStandardSection(sectionQuotaKey)) {
      throw new Error("Досягнуто ліміт записів у цьому розділі. Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.");
    }

    const projectId = workspace.projectId;
    const researchIds = new Set(projectResearches.map((research) => research.id));
    const documentIds = new Set(projectDocuments.map((document) => document.id));
    const personIds = new Set(projectPersons.map((person) => person.id));
    const findingIds = new Set(projectFindings.map((finding) => finding.id));

    try {
      if (collection === "tasks") {
        const imported = records as TaskRecord[];
        await importProjectWorkRecords(
          projectId,
          imported,
          [],
          researchIds,
          documentIds,
          personIds,
        );
        setProjectTasks((current) => {
          const next = mergeImportedRecords(imported, current);
          saveProjectWorkRecordsCache(projectId, next, projectFindings);
          return next;
        });
      } else if (collection === "findings") {
        const imported = records as Finding[];
        await importProjectWorkRecords(
          projectId,
          [],
          imported,
          researchIds,
          documentIds,
          personIds,
        );
        setProjectFindings((current) => {
          const next = mergeImportedRecords(imported, current);
          saveProjectWorkRecordsCache(projectId, projectTasks, next);
          return next;
        });
      } else if (collection === "hypotheses") {
        const imported = records as Hypothesis[];
        await importProjectAnalysisRecords(
          projectId,
          imported,
          [],
          researchIds,
          personIds,
          documentIds,
          findingIds,
        );
        setProjectHypotheses((current) => {
          const next = mergeImportedRecords(imported, current);
          saveProjectAnalysisRecordsCache(projectId, next, projectArchiveRequests);
          return next;
        });
      } else if (collection === "archiveRequests") {
        const imported = records as ArchiveRequest[];
        await importProjectAnalysisRecords(
          projectId,
          [],
          imported,
          researchIds,
          personIds,
          documentIds,
          findingIds,
        );
        setProjectArchiveRequests((current) => {
          const next = mergeImportedRecords(imported, current);
          saveProjectAnalysisRecordsCache(projectId, projectHypotheses, next);
          return next;
        });
      } else if (collection === "persons") {
        const imported = records as Person[];
        await importProjectPeople(projectId, imported, [], researchIds);
        setProjectPersons((current) => {
          const next = mergeImportedRecords(imported, current);
          saveProjectPeopleCache(projectId, next, projectPersonRelations);
          return next;
        });
      } else {
        throw new Error("Імпорт для цього розділу не підтримується.");
      }

      const previousRecords = activeDb[collection] as AppEntity[];
      records.forEach((record) => {
        const previous = previousRecords.find((item) => item.id === record.id);
        recordEntityActivity(collection, previous, record);
      });
      void subscriptionAccess.refreshSubscription();
      notify(`Імпортовано записів: ${records.length}.`);
    } catch (error) {
      throw new Error(describeError(error, "Не вдалося зберегти імпортовані записи."));
    }
  };
  const importGedcomRecords = async (
    input: GedcomImportReconciliationPayload,
    options?: GedcomImportExecutionOptions,
  ): Promise<GedcomImportReconciliationResult | void> => {
    if (!input.people.length) return;
    options?.onProgress?.({
      step: "Перевіряємо попередні імпорти",
      percent: 45,
      detail: "Зіставляємо GEDCOM з уже збереженими даними проєкту.",
    });
    if (workspace && !subscriptionAccess.isAdmin) {
      await assertFamilyTreeFeatureAccess();
    }
    validateResearchScope("persons", input.personRecords);
    validateResearchScope("documents", input.documents);
    if (!workspace) {
      const reconciled = reconcileGedcomImportForRetry(input, {
        people: activeDb.persons,
        documents: activeDb.documents,
        relations: activeDb.personRelations,
        findings: activeDb.findings,
      });
      app.setDatabase((current) => ({
        ...current,
        persons: mergeImportedRecords(reconciled.people, current.persons),
        documents: mergeImportedRecords(reconciled.documents, current.documents),
        personRelations: mergeImportedRecords(reconciled.relations, current.personRelations),
        findings: mergeImportedRecords(reconciled.findings, current.findings),
      }));
      options?.onProgress?.({
        step: "Оновлюємо дані проєкту",
        percent: 74,
        detail: "Особи, звʼязки, джерела та знахідки підготовлені.",
      });
      return reconciled;
    }
    if (workspace.role === "viewer") {
      throw new Error("У цьому проєкті у вас є лише право перегляду.");
    }
    const projectId = workspace.projectId;
    const researchIds = new Set(projectResearches.map((research) => research.id));
    const [storedPeople, storedDocuments, storedWorkRecords] = await Promise.all([
      listProjectPeople(projectId),
      listProjectDocuments(projectId),
      listProjectWorkRecords(projectId),
    ]);
    options?.onProgress?.({
      step: "Зіставляємо записи GEDCOM",
      percent: 46,
      detail: "Перевіряємо повторний імпорт і зберігаємо сталі ідентифікатори.",
    });
    const reconciled = reconcileGedcomImportForRetry(input, {
      people: storedPeople.persons,
      documents: storedDocuments.documents,
      relations: storedPeople.relations,
      findings: storedWorkRecords.findings,
    });
    options?.onProgress?.({
      step: "Готуємо пакетне збереження",
      percent: 47,
      detail: `Підготовлено ${reconciled.people.length.toLocaleString("uk-UA")} осіб, ${reconciled.relations.length.toLocaleString("uk-UA")} звʼязків і ${reconciled.findings.length.toLocaleString("uk-UA")} знахідок.`,
    });
    const storedPersonIds = new Set(storedPeople.persons.map((person) => person.id));
    const storedDocumentIds = new Set(storedDocuments.documents.map((document) => document.id));
    const storedFindingIds = new Set(storedWorkRecords.findings.map((finding) => finding.id));
    const storedRelationIds = new Set(storedPeople.relations.map((relation) => relation.id));
    const hasNewPeople = reconciled.people.some((person) => !storedPersonIds.has(person.id));
    const hasNewDocuments = reconciled.documents.some((document) => !storedDocumentIds.has(document.id));
    const hasNewFindings = reconciled.findings.some((finding) => !storedFindingIds.has(finding.id));
    const hasNewRelations = reconciled.relations.some((relation) => !storedRelationIds.has(relation.id));
    if ((hasNewPeople || hasNewDocuments || hasNewFindings || hasNewRelations) && !canCreateProjectRecords) {
      throw new Error("Імпорт нових записів заблокований поточним тарифом.");
    }
    if (hasNewPeople && !canCreateStandardSection(standardSectionQuotaKeys.persons)) {
      throw new Error("Досягнуто ліміт записів у розділі осіб.");
    }
    if (hasNewFindings && !canCreateStandardSection(standardSectionQuotaKeys.findings)) {
      throw new Error("Досягнуто ліміт записів у розділі знахідок.");
    }
    if (hasNewDocuments && !canCreateStandardSection(standardSectionQuotaKeys.documents)) {
      throw new Error("Досягнуто ліміт записів у розділі документів.");
    }

    const nextDocuments = mergeImportedRecords(reconciled.documents, storedDocuments.documents);
    const documentIds = new Set(nextDocuments.map((document) => document.id));
    const nextPersons = mergeImportedRecords(reconciled.people, storedPeople.persons);
    const nextRelations = mergeImportedRecords(reconciled.relations, storedPeople.relations);
    const nextFindings = mergeImportedRecords(reconciled.findings, storedWorkRecords.findings);
    const runPersistenceStage = async (
      stage: GedcomImportStage,
      fallback: string,
      counts: Record<string, number>,
      action: () => Promise<void>,
    ) => {
      try {
        await action();
      } catch (error) {
        const stageError = toGedcomImportStageError(
          stage,
          error,
          describeError(error, fallback),
        );
        console.error("GEDCOM import persistence stage failed", {
          projectId,
          stage,
          counts,
          error,
        });
        throw stageError;
      }
    };

    try {
      await runPersistenceStage(
        "people-relations",
        "Не вдалося зберегти осіб і родинні зв’язки.",
        { people: reconciled.people.length, relations: reconciled.relations.length },
        () => importProjectPeople(
          projectId,
          reconciled.people,
          reconciled.relations,
          researchIds,
          { onProgress: (progress) => reportGedcomImportBatchProgress(options, progress) },
        ),
      );
      options?.onProgress?.({
        step: "Особи та звʼязки збережені",
        percent: 56,
        detail: `Осіб: ${reconciled.people.length.toLocaleString("uk-UA")}, звʼязків: ${reconciled.relations.length.toLocaleString("uk-UA")}.`,
      });
      if (reconciled.documents.length) {
        await runPersistenceStage(
          "documents",
          "Не вдалося зберегти джерела і документи.",
          { documents: reconciled.documents.length },
          () => importProjectDocuments(
            projectId,
            reconciled.documents,
            [],
            researchIds,
            { onProgress: (progress) => reportGedcomImportBatchProgress(options, progress) },
          ),
        );
      }
      options?.onProgress?.({
        step: "Джерела збережені",
        percent: 58,
        detail: `Джерел і документів: ${reconciled.documents.length.toLocaleString("uk-UA")}.`,
      });
      if (reconciled.findings.length) {
        await runPersistenceStage(
          "findings",
          "Не вдалося зберегти події і знахідки.",
          { findings: reconciled.findings.length },
          () => importProjectWorkRecords(
            projectId,
            [],
            reconciled.findings,
            researchIds,
            documentIds,
            new Set(nextPersons.map((person) => person.id)),
            { onProgress: (progress) => reportGedcomImportBatchProgress(options, progress) },
          ),
        );
      }
      options?.onProgress?.({
        step: "Завершуємо збереження даних",
        percent: 74,
        detail: `Знахідок: ${reconciled.findings.length.toLocaleString("uk-UA")}. Оновлюємо локальний стан проєкту.`,
      });
      setProjectPersons(nextPersons);
      setProjectPersonRelations(nextRelations);
      if (reconciled.documents.length) setProjectDocuments(nextDocuments);
      if (reconciled.findings.length) setProjectFindings(nextFindings);
      saveProjectPeopleCache(projectId, nextPersons, nextRelations);
      if (reconciled.documents.length) saveProjectDocumentsCache(projectId, nextDocuments, storedDocuments.yearMatrix);
      if (reconciled.findings.length) saveProjectWorkRecordsCache(projectId, storedWorkRecords.tasks, nextFindings);
      options?.onProgress?.({
        step: "Дані GEDCOM збережені",
        percent: 74.5,
        detail: "Переходимо до формування родового дерева.",
      });
      void subscriptionAccess.refreshSubscription();
      return reconciled;
    } catch (error) {
      if (error instanceof GedcomImportStageError) throw error;
      throw new Error(describeError(error, "Не вдалося зберегти GEDCOM-імпорт."));
    }
  };
  const deleteFor = (collection: CollectionKey) => (id: string) => {
    if (collection === "researches") removeResearch(id);
    else if (collection === "documents") removeDocument(id);
    else if (collection === "yearMatrix") removeYearMatrixRecord(id);
    else if (collection === "tasks") removeTask(id);
    else if (collection === "findings") removeFinding(id);
    else if (collection === "hypotheses") removeHypothesis(id);
    else if (collection === "archiveRequests") removeArchiveRequest(id);
    else app.deleteEntity(collection, id);
  };
  const navigate = (nextPage: PageKey) => {
    if (nextPage === "familyTree" && !canUseFamilyTreeFeature) {
      notify("Модуль «Родове дерево» доступний лише запрошеним тестувальникам.", true);
      return;
    }
    setModuleSearch("");
    setOpenEntityId("");
    setCreateRequest(null);
    if (nextPage === "settings" || nextPage === "subscription") {
      routerNavigate(nextPage === "settings" ? "/settings" : "/settings/subscription");
      return;
    }
    if (workspace) {
      routerNavigate(pagePath(workspace.projectSlug, nextPage, projectCustomSections));
    }
  };
  const openProjects = () => {
    setModuleSearch("");
    setOpenEntityId("");
    setCreateRequest(null);
    routerNavigate("/projects");
  };
  const openSearchResult = (nextPage: PageKey, query: string, entityId?: string) => {
    setModuleSearch(query);
    setOpenEntityId(entityId ?? "");
    if (workspace) {
      routerNavigate(pagePath(workspace.projectSlug, nextPage, projectCustomSections));
    }
  };
  const openRelatedRecord = (nextPage: PageKey, entityId: string) => {
    setModuleSearch("");
    setOpenEntityId(entityId);
    setCreateRequest(null);
    if (workspace) {
      routerNavigate(pagePath(workspace.projectSlug, nextPage, projectCustomSections));
    }
  };
  const createRelatedRecord = (nextPage: PageKey, initialValues: Record<string, unknown>) => {
    if (!ensureCanCreateProjectRecord("Новий пов’язаний запис")) return;
    const canCreateRelatedRecord = nextPage === "researches"
      ? canCreateResearchRecord
      : canCreateStandardSection(standardSectionQuotaKeys[nextPage]);
    if (!canCreateRelatedRecord) {
      setUpgradeReason({
        featureName: "Новий пов’язаний запис",
        reason: nextPage === "researches"
          ? researchLimitMessage || "Досягнуто ліміт досліджень для поточного тарифу."
          : "Досягнуто ліміт записів у цьому розділі. Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
        recommendedPlan: "researcher",
      });
      return;
    }
    setModuleSearch("");
    setOpenEntityId("");
    setCreateRequest({
      id: Date.now(),
      page: nextPage,
      initialValues,
    });
    if (workspace) {
      routerNavigate(pagePath(workspace.projectSlug, nextPage, projectCustomSections));
    }
  };
  const openScanViewer = (
    scan: ScanAttachment,
    context?: DocumentScanViewerContext,
    scans?: ScanAttachment[],
  ) => {
    const pages = scans?.length ? scans : [scan];
    setScanViewer({
      scan,
      scans: pages,
      pageIndex: Math.max(0, pages.findIndex((item) => item.id === scan.id)),
      context,
      openedAt: Date.now(),
    });
  };
  const createFindingFromViewedDocument = (initialValues: Record<string, unknown>) => {
    createRelatedRecord("findings", initialValues);
  };

  const createSubsection = (parentKey: SectionParentKey) => {
    if (!canCreateCustomSection) {
      setUpgradeReason({
        featureName: "Власні розділи",
        reason: customSectionLimitMessage || "Створення нового власного розділу недоступне або ліміт уже використано.",
        recommendedPlan: "researcher",
        used: subscriptionAccess.getUsage("custom_sections_per_project"),
        limit: subscriptionAccess.getLimit("custom_sections_per_project")?.value ?? undefined,
      });
      return;
    }
    setSectionCreateRequest({
      id: Date.now(),
      parentKey,
    });
    navigate("settings");
  };
  const savePerson = (person: Person): Promise<Person | null> => {
    try {
      validateResearchScope("persons", [person as unknown as AppEntity]);
    } catch (error) {
      notify(describeError(error, "Оберіть дослідження для цієї особи."), true);
      return Promise.resolve(null);
    }
    if (!workspace) {
      app.saveEntity("persons", person);
      return Promise.resolve(person);
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return Promise.resolve(null);
    }

    const projectId = workspace.projectId;
    const previous = projectPersons;
    const previousEntity = previous.find((item) => item.id === person.id);
    if (!previousEntity && !ensureCanCreateProjectRecord("Нова особа")) return Promise.resolve(null);
    const optimistic = previous.some((item) => item.id === person.id)
      ? previous.map((item) => (item.id === person.id ? person : item))
      : [person, ...previous];
    setProjectPersons(optimistic);
    saveProjectPeopleCache(projectId, optimistic, projectPersonRelations);

    return assertProjectRecordUnchanged(
      "persons",
      projectId,
      person.id,
      baseUpdatedAt(person) ?? previousEntity?.updatedAt,
    )
      .then(() => saveProjectPerson(
        projectId,
        person,
        new Set(projectResearches.map((research) => research.id)),
      ))
      .then((saved) => {
        refreshSubscriptionAfterCreate(previousEntity);
        recordEntityActivity("persons", previousEntity, saved);
        syncEntityAttachmentMetadata("persons", saved);
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectPeopleCache(projectId);
          const persons = cached.persons.map((item) => (item.id === saved.id ? saved : item));
          saveProjectPeopleCache(projectId, persons, cached.relations);
          return saved;
        }
        setProjectPersons((current) => {
          const next = current.map((item) => (item.id === saved.id ? saved : item));
          saveProjectPeopleCache(projectId, next, projectPersonRelations);
          return next;
        });
        return saved;
      })
      .catch((error: unknown) => {
        const cached = loadProjectPeopleCache(projectId);
        saveProjectPeopleCache(projectId, previous, cached.relations);
        if (activeWorkspaceIdRef.current === projectId) setProjectPersons(previous);
        notify(describeError(error, "Не вдалося зберегти особу."), true);
        return null;
      });
  };
  const deletePerson = (id: string) => {
    if (!workspace) {
      app.setDatabase((current) => ({
        ...current,
        persons: current.persons.filter((person) => person.id !== id),
        personRelations: current.personRelations.filter(
          (relation) => relation.personId !== id && relation.relatedPersonId !== id,
        ),
        tasks: current.tasks.map((task) => ({
          ...task,
          personIds: task.personIds.filter((personId) => personId !== id),
        })),
        findings: current.findings.map((finding) => ({
          ...finding,
          personIds: finding.personIds.filter((personId) => personId !== id),
        })),
        hypotheses: current.hypotheses.map((hypothesis) => ({
          ...hypothesis,
          personIds: hypothesis.personIds.filter((personId) => personId !== id),
        })),
        archiveRequests: current.archiveRequests.map((request) => ({
          ...request,
          personIds: request.personIds.filter((personId) => personId !== id),
        })),
      }));
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previousPersons = projectPersons;
    const previousRelations = projectPersonRelations;
    const previousTasks = projectTasks;
    const previousFindings = projectFindings;
    const previousHypotheses = projectHypotheses;
    const previousRequests = projectArchiveRequests;
    const nextPersons = previousPersons.filter((person) => person.id !== id);
    const nextRelations = previousRelations.filter(
      (relation) => relation.personId !== id && relation.relatedPersonId !== id,
    );
    const nextTasks = previousTasks.map((task) => ({
      ...task,
      personIds: task.personIds.filter((personId) => personId !== id),
    }));
    const nextFindings = previousFindings.map((finding) => ({
      ...finding,
      personIds: finding.personIds.filter((personId) => personId !== id),
    }));
    const nextHypotheses = previousHypotheses.map((hypothesis) => ({
      ...hypothesis,
      personIds: hypothesis.personIds.filter((personId) => personId !== id),
    }));
    const nextRequests = previousRequests.map((request) => ({
      ...request,
      personIds: request.personIds.filter((personId) => personId !== id),
    }));
    setProjectPersons(nextPersons);
    setProjectPersonRelations(nextRelations);
    setProjectTasks(nextTasks);
    setProjectFindings(nextFindings);
    setProjectHypotheses(nextHypotheses);
    setProjectArchiveRequests(nextRequests);
    saveProjectPeopleCache(projectId, nextPersons, nextRelations);
    saveProjectWorkRecordsCache(projectId, nextTasks, nextFindings);
    saveProjectAnalysisRecordsCache(
      projectId,
      nextHypotheses,
      nextRequests,
    );

    void Promise.all([
      deleteProjectPerson(projectId, id),
      deleteProjectHypothesisTargetLinks(projectId, "person", id),
    ])
      .then(async () => {
        recordEntityDeletion("persons", id);
        deleteEntityAttachmentMetadata("persons", id);
        const changedFindings = nextFindings.filter(
          (finding, index) =>
            finding.personIds.length !== previousFindings[index]?.personIds.length,
        );
        const updates = await Promise.allSettled(
          changedFindings.map((finding) =>
            saveProjectFinding(
              projectId,
              finding,
              new Set(projectResearches.map((research) => research.id)),
              new Set(projectDocuments.map((document) => document.id)),
              new Set(nextPersons.map((person) => person.id)),
            ),
          ),
        );
        if (updates.some((result) => result.status === "rejected")) {
          notify("Особу видалено, але частину пов’язаних знахідок не вдалося оновити.", true);
        }
      })
      .catch((error: unknown) => {
        saveProjectPeopleCache(projectId, previousPersons, previousRelations);
        saveProjectWorkRecordsCache(projectId, previousTasks, previousFindings);
        saveProjectAnalysisRecordsCache(
          projectId,
          previousHypotheses,
          previousRequests,
        );
        if (activeWorkspaceIdRef.current === projectId) {
          setProjectPersons(previousPersons);
          setProjectPersonRelations(previousRelations);
          setProjectTasks(previousTasks);
          setProjectFindings(previousFindings);
          setProjectHypotheses(previousHypotheses);
          setProjectArchiveRequests(previousRequests);
        }
      notify(describeError(error, "Не вдалося видалити особу."), true);
      });
  };
  const saveRelation = (relation: PersonRelation): Promise<PersonRelation | null> => {
    if (!workspace) {
      app.setDatabase((current) => ({
        ...current,
        personRelations: current.personRelations.some((item) => item.id === relation.id)
          ? current.personRelations.map((item) => item.id === relation.id ? relation : item)
          : [...current.personRelations, relation],
      }));
      return Promise.resolve(relation);
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return Promise.resolve(null);
    }

    const projectId = workspace.projectId;
    const previous = projectPersonRelations;
    const previousRelation = previous.find((item) => item.id === relation.id);
    if (!previousRelation && !ensureCanCreateProjectRecord("Новий зв’язок між особами")) return Promise.resolve(null);
    const optimistic = previous.some((item) => item.id === relation.id)
      ? previous.map((item) => (item.id === relation.id ? relation : item))
      : [...previous, relation];
    const cachedPeople = loadProjectPeopleCache(projectId);
    const cachePersons = cachedPeople.persons.length ? cachedPeople.persons : projectPersons;
    setProjectPersonRelations(optimistic);
    saveProjectPeopleCache(projectId, cachePersons, optimistic);

    return saveProjectPersonRelation(projectId, relation)
      .then((saved) => {
        const latestPeople = loadProjectPeopleCache(projectId);
        const peopleForNames = latestPeople.persons.length ? latestPeople.persons : projectPersons;
        const firstPerson = peopleForNames.find((person) => person.id === saved.personId);
        const secondPerson = peopleForNames.find((person) => person.id === saved.relatedPersonId);
        const firstName = firstPerson?.fullName || firstPerson?.surname || "особою";
        const secondName = secondPerson?.fullName || secondPerson?.surname || "особою";
        recordProjectActivity(
          "persons",
          saved.personId,
          `${previousRelation ? "Оновлено" : "Створено"} зв’язок між «${firstName}» та «${secondName}».`,
          previousRelation ? "relation_updated" : "relation_created",
          saved.id,
        );
        if (activeWorkspaceIdRef.current !== projectId) {
          const cached = loadProjectPeopleCache(projectId);
          const relations = cached.relations.map((item) => (item.id === saved.id ? saved : item));
          saveProjectPeopleCache(projectId, cached.persons, relations);
          return saved;
        }
        setProjectPersonRelations((current) => {
          const next = current.map((item) => (item.id === saved.id ? saved : item));
          const latestPeople = loadProjectPeopleCache(projectId);
          saveProjectPeopleCache(projectId, latestPeople.persons.length ? latestPeople.persons : projectPersons, next);
          return next;
        });
        return saved;
      })
      .catch((error: unknown) => {
        const cached = loadProjectPeopleCache(projectId);
        saveProjectPeopleCache(projectId, cached.persons, previous);
        if (activeWorkspaceIdRef.current === projectId) setProjectPersonRelations(previous);
        notify(describeError(error, "Не вдалося зберегти зв’язок."), true);
        return null;
      });
  };
  const deleteRelation = (id: string) => {
    if (!workspace) {
      app.setDatabase((current) => ({
        ...current,
        personRelations: current.personRelations.filter((relation) => relation.id !== id),
      }));
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectPersonRelations;
    const optimistic = previous.filter((relation) => relation.id !== id);
    setProjectPersonRelations(optimistic);
    saveProjectPeopleCache(projectId, projectPersons, optimistic);
    void deleteProjectPersonRelation(projectId, id).then(() => {
      recordProjectActivity(
        "persons",
        id,
        "Видалено зв’язок між особами.",
        "relation_deleted",
      );
    }).catch((error: unknown) => {
      const cached = loadProjectPeopleCache(projectId);
      saveProjectPeopleCache(projectId, cached.persons, previous);
      if (activeWorkspaceIdRef.current === projectId) setProjectPersonRelations(previous);
      notify(describeError(error, "Не вдалося видалити зв’язок."), true);
    });
  };
  const saveCustomRecord = (record: CustomSectionRecord) => {
    if (!workspace) {
      app.setDatabase((current) => ({
        ...current,
        customSectionRecords: current.customSectionRecords.some((item) => item.id === record.id)
          ? current.customSectionRecords.map((item) => item.id === record.id ? record : item)
          : [record, ...current.customSectionRecords],
      }));
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }

    const projectId = workspace.projectId;
    const previous = projectCustomRecords;
    const previousRecord = previous.find((item) => item.id === record.id);
    if (!previousRecord && !ensureCanCreateProjectRecord("Новий запис власного розділу")) return;
    const optimistic = previous.some((item) => item.id === record.id)
      ? previous.map((item) => (item.id === record.id ? record : item))
      : [record, ...previous];
    setProjectCustomRecords(optimistic);
    saveProjectCustomStructureCache(
      projectId,
      projectCustomFields,
      projectCustomSections,
      optimistic,
    );
    const section = projectCustomSections.find((item) => item.id === record.sectionId);
    const titleValue = section ? record.values[section.titleFieldId] : "";
    const title = Array.isArray(titleValue)
      ? titleValue.join(", ")
      : typeof titleValue === "string"
        ? titleValue
        : section?.singularName ?? "Запис";
    void assertProjectRecordUnchanged(
      "custom_records",
      projectId,
      record.id,
      baseUpdatedAt(record) ?? previousRecord?.updatedAt,
    ).then(() => saveProjectCustomRecord(projectId, record, title || "Запис")).then(
      () => {
        recordProjectActivity(
          `custom:${record.sectionId}`,
          record.id,
          `${previousRecord ? "Оновлено" : "Створено"} запис «${title || section?.singularName || "Без назви"}» у розділі «${section?.name || "Власний розділ"}».`,
          previousRecord ? "record_updated" : "record_created",
        );
        const attachmentFields = Object.fromEntries(
          (section?.fields ?? [])
            .filter((field) => field.type === "attachments")
            .map((field) => [field.id, scanList(record.values[field.id])]),
        );
        void syncProjectAttachmentMetadata(
          projectId,
          `custom:${record.sectionId}`,
          record.id,
          attachmentFields,
        ).catch((error: unknown) => {
          notify(
            describeError(error, "Запис збережено, але не вдалося оновити метадані вкладень."),
            true,
          );
        });
      },
      (error: unknown) => {
        setProjectCustomRecords(previous);
        saveProjectCustomStructureCache(
          projectId,
          projectCustomFields,
          projectCustomSections,
          previous,
        );
        notify(describeError(error, "Не вдалося зберегти запис власного розділу."), true);
      },
    );
  };
  const deleteCustomRecord = (id: string) => {
    if (!workspace) {
      app.setDatabase((current) => ({
        ...current,
        customSectionRecords: current.customSectionRecords.filter((record) => record.id !== id),
      }));
      return;
    }
    if (workspace.role === "viewer") {
      notify("У цьому проєкті у вас є лише право перегляду.", true);
      return;
    }
    const projectId = workspace.projectId;
    const previous = projectCustomRecords;
    const deletedRecord = previous.find((record) => record.id === id);
    const optimistic = previous.filter((record) => record.id !== id);
    setProjectCustomRecords(optimistic);
    saveProjectCustomStructureCache(
      projectId,
      projectCustomFields,
      projectCustomSections,
      optimistic,
    );
    void deleteProjectCustomRecord(projectId, id).then(() => {
      if (!deletedRecord) return;
      const section = projectCustomSections.find(
        (item) => item.id === deletedRecord.sectionId,
      );
      recordProjectActivity(
        `custom:${deletedRecord.sectionId}`,
        id,
        `Видалено запис із розділу «${section?.name || "Власний розділ"}».`,
        "record_deleted",
      );
      void deleteProjectAttachmentMetadata(
        projectId,
        `custom:${deletedRecord.sectionId}`,
        id,
      ).catch(() => undefined);
    }).catch((error: unknown) => {
      setProjectCustomRecords(previous);
      saveProjectCustomStructureCache(
        projectId,
        projectCustomFields,
        projectCustomSections,
        previous,
      );
      notify(describeError(error, "Не вдалося видалити запис власного розділу."), true);
    });
  };
  const addCustomField = (definition: CustomFieldDefinition) => {
    if (definition.type === "attachments") {
      notify("Створення додаткових файлових полів вимкнено.", true);
      return;
    }
    if (!workspace) {
      app.setDatabase((current) => ({
        ...current,
        settings: {
          ...current.settings,
          customFields: [...current.settings.customFields, definition],
        },
      }));
      return;
    }
    if (!subscriptionAccess.canCreateCustomField) {
      showCustomFieldBlocked();
      return;
    }
    if (workspace.role !== "owner") {
      notify("Додаткові поля може змінювати лише власник проєкту.", true);
      return;
    }
    const projectId = workspace.projectId;
    const previous = projectCustomFields;
    const optimistic = [...previous, definition];
    setProjectCustomFields(optimistic);
    saveProjectCustomStructureCache(
      projectId,
      optimistic,
      projectCustomSections,
      projectCustomRecords,
    );
    void saveProjectCustomFieldDefinition(
      projectId,
      definition,
      optimistic.length - 1,
    ).then(() => {
      void subscriptionAccess.refreshSubscription();
      recordProjectActivity(
        definition.module,
        definition.id,
        `Додано поле «${definition.label}» до розділу «${activityModuleLabel(definition.module)}».`,
        "field_created",
      );
    }).catch((error: unknown) => {
      setProjectCustomFields(previous);
      saveProjectCustomStructureCache(
        projectId,
        previous,
        projectCustomSections,
        projectCustomRecords,
      );
      notify(describeError(error, "Не вдалося додати власне поле."), true);
    });
  };

  const deleteCustomField = (definition: CustomFieldDefinition) => {
    if (!workspace) {
      app.setDatabase((current) => removeCustomFieldFromDatabase(current, definition));
      return;
    }
    if (workspace.role !== "owner") {
      notify("Видаляти додаткові поля може лише власник проєкту.", true);
      return;
    }
    const projectId = workspace.projectId;
    const previous = projectCustomFields;
    const optimistic = previous.filter((field) => field.id !== definition.id);
    setProjectCustomFields(optimistic);
    saveProjectCustomStructureCache(
      projectId,
      optimistic,
      projectCustomSections,
      projectCustomRecords,
    );
    void deleteProjectCustomFieldDefinition(projectId, definition.id).then(() => {
      recordProjectActivity(
        definition.module,
        definition.id,
        `Видалено поле «${definition.label}» із розділу «${activityModuleLabel(definition.module)}».`,
        "field_deleted",
      );
    }).catch((error: unknown) => {
      setProjectCustomFields(previous);
      saveProjectCustomStructureCache(
        projectId,
        previous,
        projectCustomSections,
        projectCustomRecords,
      );
      notify(describeError(error, "Не вдалося видалити власне поле."), true);
    });
  };

  const changeSettings = (next: AppDatabase) => {
    if (!workspace) {
      app.setDatabase(next);
      return;
    }
    if (workspace.role !== "owner") {
      notify("Структуру проєкту може змінювати лише власник.", true);
      return;
    }

    const addedSections = next.customSections.filter(
      (section) => !projectCustomSections.some((item) => item.id === section.id),
    );
    const addedStandardFields = next.settings.customFields.filter(
      (field) => !projectCustomFields.some((item) => item.id === field.id),
    ).length;
    const addedSectionFields = next.customSections.reduce((count, section) => {
      const previous = projectCustomSections.find((item) => item.id === section.id);
      return count + section.fields.filter(
        (field) => !previous?.fields.some((item) => item.id === field.id),
      ).length;
    }, 0);
    if (
      (addedSections.length || addedStandardFields || addedSectionFields) &&
      !ensureCanCreateProjectRecord("Власні розділи та поля")
    ) {
      return;
    }
    const remainingSections = subscriptionAccess.getRemaining("custom_sections_per_project");
    if (remainingSections !== null && addedSections.length > remainingSections) {
      setUpgradeReason({
        featureName: "Власні розділи",
        reason: "Для створення цих розділів недостатньо доступного ліміту.",
        recommendedPlan: "researcher",
        used: subscriptionAccess.getUsage("custom_sections_per_project"),
        limit: subscriptionAccess.getLimit("custom_sections_per_project")?.value ?? undefined,
      });
      return;
    }

    const projectId = workspace.projectId;
    setProjectPreferences({
      researcherName: next.settings.researcherName,
      compactTables: next.settings.compactTables,
      lastAutomaticBackupAt: next.settings.lastAutomaticBackupAt,
    });
    const previousSections = projectCustomSections;
    const previousRecords = projectCustomRecords;
    const nextSections = next.customSections;
    const nextRecords = next.customSectionRecords;
    setProjectCustomSections(nextSections);
    setProjectCustomRecords(nextRecords);
    saveProjectCustomStructureCache(
      projectId,
      projectCustomFields,
      nextSections,
      nextRecords,
    );

    const removed = previousSections.filter(
      (section) => !nextSections.some((item) => item.id === section.id),
    );
    const changed = nextSections.filter((section) => {
      const previous = previousSections.find((item) => item.id === section.id);
      return !previous ||
        JSON.stringify(previous) !== JSON.stringify(section) ||
        previousSections.findIndex((item) => item.id === section.id) !==
          nextSections.findIndex((item) => item.id === section.id);
    });
    void Promise.all([
      ...removed.map((section) =>
        deleteProjectCustomSection(projectId, section.id),
      ),
      ...changed.map((section) =>
        saveProjectCustomSection(
          projectId,
          section,
          nextSections.findIndex((item) => item.id === section.id),
        ),
      ),
    ]).then(() => {
      if (changed.some((section) => !previousSections.some((item) => item.id === section.id))) {
        void subscriptionAccess.refreshSubscription();
      }
      for (const section of removed) {
        recordProjectActivity(
          "settings",
          section.id,
          `Видалено розділ «${section.name}».`,
          "section_deleted",
        );
      }
      for (const section of changed) {
        const previous = previousSections.find((item) => item.id === section.id);
        if (!previous) {
          recordProjectActivity(
            `custom:${section.id}`,
            section.id,
            `Створено розділ «${section.name}».`,
            "section_created",
          );
          continue;
        }
        const addedFields = section.fields.filter(
          (field) => !previous.fields.some((item) => item.id === field.id),
        );
        if (addedFields.length) {
          for (const field of addedFields) {
            recordProjectActivity(
              `custom:${section.id}`,
              section.id,
              `Додано поле «${field.label}» до розділу «${section.name}».`,
              "field_created",
            );
          }
          continue;
        }
        recordProjectActivity(
          `custom:${section.id}`,
          section.id,
          `Оновлено структуру розділу «${section.name}».`,
          "section_updated",
        );
      }
    }).catch((error: unknown) => {
      setProjectCustomSections(previousSections);
      setProjectCustomRecords(previousRecords);
      saveProjectCustomStructureCache(
        projectId,
        projectCustomFields,
        previousSections,
        previousRecords,
      );
      notify(describeError(error, "Не вдалося зберегти структуру розділів."), true);
    });
  };

  const replaceProjectDatabase = async (
    next: AppDatabase,
    onProgress?: (message: string, percent: number) => void,
  ) => {
    if (!workspace) {
      throw new Error("Спочатку виберіть або створіть проєкт.");
    }
    if (workspace.role !== "owner") {
      throw new Error("Відновлювати резервні копії може лише власник проєкту.");
    }

    if (!canCreateProjectRecords) {
      throw new Error("У цьому проєкті можна редагувати й видаляти наявні дані, але відновлення резервної копії заблоковане поточним тарифом, бо воно створює нові записи.");
    }

    const projectId = workspace.projectId;
    if (activeWorkspaceIdRef.current !== projectId) {
      throw new Error("Активний проєкт змінився. Повторіть імпорт у потрібному проєкті.");
    }
    const researchIds = new Set(next.researches.map((item) => item.id));
    const documentIds = new Set(next.documents.map((item) => item.id));
    const personIds = new Set(next.persons.map((item) => item.id));
    const findingIds = new Set(next.findings.map((item) => item.id));
    const recordLimit = subscriptionAccess.getLimit("records_per_standard_section");
    if (recordLimit && !recordLimit.isUnlimited && recordLimit.value !== null) {
      const counts: Array<[string, number]> = [
        ["Особи", next.persons.length],
        ["Документи", next.documents.length],
        ["Матриця років", next.yearMatrix.length],
        ["Завдання", next.tasks.length],
        ["Знахідки", next.findings.length],
        ["Гіпотези", next.hypotheses.length],
        ["Запити в архів", next.archiveRequests.length],
      ];
      const exceeded = counts.find(([, count]) => count > recordLimit.value!);
      if (exceeded) {
        throw new Error(`Резервна копія містить ${exceeded[1]} записів у розділі «${exceeded[0]}», а поточний тариф дозволяє до ${recordLimit.value} записів у розділі.`);
      }
    }

    onProgress?.("Очищаємо попередні записи цільового проєкту…", 15);
    await clearProjectRecords(projectId);
    onProgress?.("Відновлюємо дослідження…", 24);
    await importProjectResearches(projectId, next.researches);
    onProgress?.("Відновлюємо осіб та родинні зв’язки…", 34);
    await importProjectPeople(
      projectId,
      next.persons,
      next.personRelations,
      researchIds,
    );
    onProgress?.("Відновлюємо документи та матрицю років…", 44);
    await importProjectDocuments(
      projectId,
      next.documents,
      next.yearMatrix,
      researchIds,
    );
    onProgress?.("Відновлюємо завдання та знахідки…", 55);
    await importProjectWorkRecords(
      projectId,
      next.tasks,
      next.findings,
      researchIds,
      documentIds,
      personIds,
    );
    onProgress?.("Відновлюємо гіпотези та запити в архів…", 66);
    await importProjectAnalysisRecords(
      projectId,
      next.hypotheses,
      next.archiveRequests,
      researchIds,
      personIds,
      documentIds,
      findingIds,
    );
    onProgress?.("Відновлюємо власні розділи та поля…", 76);
    await importProjectCustomStructure(
      projectId,
      next.settings.customFields,
      next.customSections,
      next.customSectionRecords,
    );

    const preferences: ProjectPreferences = {
      researcherName: next.settings.researcherName,
      compactTables: next.settings.compactTables,
      lastAutomaticBackupAt: next.settings.lastAutomaticBackupAt,
    };
    onProgress?.("Оновлюємо налаштування проєкту…", 82);
    try {
      await saveProjectPreferences(projectId, preferences);
    } catch (error) {
      console.warn("Project data restored, but preferences were not updated.", error);
    }

    onProgress?.("Оновлюємо службові дані прикріплених файлів…", 88);
    const collections: Array<[CollectionKey, AppEntity[]]> = [
      ["researches", next.researches],
      ["documents", next.documents],
      ["yearMatrix", next.yearMatrix],
      ["tasks", next.tasks],
      ["findings", next.findings],
      ["hypotheses", next.hypotheses],
      ["archiveRequests", next.archiveRequests],
      ["persons", next.persons],
    ];
    for (const [collection, records] of collections) {
      for (const record of records) {
        try {
          await syncProjectAttachmentMetadata(
            projectId,
            collection,
            record.id,
            projectAttachmentFields(collection, record, next),
          );
        } catch (error) {
          console.warn("Project data restored, but attachment metadata was not updated.", error);
        }
      }
    }
    const sections = new Map(
      next.customSections.map((section) => [section.id, section]),
    );
    for (const record of next.customSectionRecords) {
      const section = sections.get(record.sectionId);
      const fields = Object.fromEntries(
        (section?.fields ?? [])
          .filter((field) => field.type === "attachments")
          .map((field) => [field.id, scanList(record.values[field.id])]),
      );
      try {
        await syncProjectAttachmentMetadata(
          projectId,
          `custom:${record.sectionId}`,
          record.id,
          fields,
        );
      } catch (error) {
        console.warn("Project data restored, but custom attachment metadata was not updated.", error);
      }
    }

    onProgress?.("Зберігаємо локальний стан та оновлюємо сторінку…", 96);
    saveProjectResearchCache(projectId, next.researches);
    saveProjectPeopleCache(projectId, next.persons, next.personRelations);
    saveProjectDocumentsCache(projectId, next.documents, next.yearMatrix);
    saveProjectWorkRecordsCache(projectId, next.tasks, next.findings);
    saveProjectAnalysisRecordsCache(
      projectId,
      next.hypotheses,
      next.archiveRequests,
    );
    saveProjectCustomStructureCache(
      projectId,
      next.settings.customFields,
      next.customSections,
      next.customSectionRecords,
    );
    if (activeWorkspaceIdRef.current !== projectId) return;

    setProjectResearches(next.researches);
    setProjectPersons(next.persons);
    setProjectPersonRelations(next.personRelations);
    setProjectDocuments(next.documents);
    setProjectYearMatrix(next.yearMatrix);
    setProjectTasks(next.tasks);
    setProjectFindings(next.findings);
    setProjectHypotheses(next.hypotheses);
    setProjectArchiveRequests(next.archiveRequests);
    setProjectCustomFields(next.settings.customFields);
    setProjectCustomSections(next.customSections);
    setProjectCustomRecords(next.customSectionRecords);
    setProjectPreferences(preferences);
    onProgress?.("Готово.", 100);
  };

  const content = (() => {
    const readOnly = Boolean(workspace && workspace.role === "viewer");
    const canManageStructure = !workspace || workspace.role === "owner";
    if (page.startsWith("custom:")) {
      const sectionId = page.slice("custom:".length);
      const section = activeDb.customSections.find((item) => item.id === sectionId);
      if (!section) {
        return (
          <section className="panel empty-state">
            <strong>Цей власний розділ не знайдено.</strong>
            <button className="button button-primary" onClick={() => navigate("settings")}>
              Відкрити конструктор
            </button>
          </section>
        );
      }
      return (
        <CustomSectionPage
          db={activeDb}
          section={section}
          records={activeDb.customSectionRecords.filter((record) => record.sectionId === section.id)}
          initialSearch={moduleSearch}
          initialOpenRecordId={openEntityId}
          onSave={saveCustomRecord}
          onDelete={deleteCustomRecord}
          onOpenRelated={openRelatedRecord}
          onAddField={canManageStructure && canCreateProjectRecords ? (field) => {
            if (!canCreateCustomField) {
              showCustomFieldBlocked();
              return;
            }
            changeSettings({
              ...activeDb,
              customSections: activeDb.customSections.map((item) =>
                item.id === section.id
                  ? {
                      ...item,
                      fields: [...item.fields, field],
                      titleFieldId: item.titleFieldId || field.id,
                      updatedAt: new Date().toISOString(),
                    }
                  : item,
              ),
            });
          } : undefined}
          canAddField={canCreateCustomField}
          fieldLimitMessage={customFieldLimitMessage}
          onAddFieldBlocked={showCustomFieldBlocked}
          readOnly={readOnly}
          canCreate={canCreateProjectRecords}
          projectName={workspace?.projectName}
        />
      );
    }
    switch (page) {
      case "dashboard":
        return (
          <DashboardPage
            db={activeDb}
            stats={dashboardStats}
            dashboardTasks={dashboardTasks}
            projectId={workspace?.projectId}
            onNavigate={navigate}
            onOpenSearchResult={openSearchResult}
          />
        );
      case "map":
        return (
          <MapPage
            db={activeDb}
            onOpenRelated={openRelatedRecord}
          />
        );
      case "familyTree":
        if (!canUseFamilyTreeFeature) {
          return (
            <section className="panel empty-state">
              <strong>
                {familyTreeFeatureAccess.loading
                  ? "Перевіряємо доступ до родового дерева…"
                  : "Модуль «Родове дерево» поки доступний лише запрошеним тестувальникам."}
              </strong>
              {!familyTreeFeatureAccess.loading ? (
                <p>Адміністратор може надати доступ зареєстрованому користувачу у розділі тарифів.</p>
              ) : null}
            </section>
          );
        }
        return (
          <FamilyTreeErrorBoundary>
            <FamilyTreePage
              projectId={workspace?.projectId}
              db={activeDb}
              persons={activeDb.persons}
              relations={activeDb.personRelations}
              researches={activeDb.researches}
              documents={activeDb.documents}
              findings={activeDb.findings}
              tasks={activeDb.tasks}
              hypotheses={activeDb.hypotheses}
              archiveRequests={activeDb.archiveRequests}
              customFieldDefinitions={activeDb.settings.customFields}
              onAddCustomField={canManageStructure && canCreateProjectRecords ? addCustomField : undefined}
              onDeleteCustomField={canManageStructure ? deleteCustomField : undefined}
              canAddCustomField={canCreateCustomField}
              customFieldLimitMessage={customFieldLimitMessage}
              onSavePerson={savePerson}
              onImportRecords={importTableRecords}
              onImportGedcom={importGedcomRecords}
              onSaveEntity={(collection, entity) => saveFor(collection)(entity)}
              onSaveRelation={saveRelation}
              onDeleteRelation={deleteRelation}
              onOpenRelated={openRelatedRecord}
              onCreateRelated={createRelatedRecord}
              onOpenScanViewer={openScanViewer}
              canCreateRelated={(relatedPage) => relatedPage === "researches"
                ? canCreateResearchRecord
                : canCreateStandardSection(standardSectionQuotaKeys[relatedPage])}
              readOnly={readOnly}
              canCreate={canCreateStandardSection(standardSectionQuotaKeys.persons)}
              researchRequired={researchRequiredByPlan}
              onOpenPerson={(personId) => openRelatedRecord("persons", personId)}
              useProductionRenderer={shouldUseProductionFamilyTreeRenderer(
                featureFlags,
                import.meta.env.DEV,
              )}
            />
          </FamilyTreeErrorBoundary>
        );
      case "researches":
      case "documents":
      case "archiveRequests":
      case "tasks":
      case "findings":
      case "hypotheses": {
        const pageCanCreate = page === "researches"
          ? canCreateResearchRecord
          : canCreateStandardSection(standardSectionQuotaKeys[page]);
        const showCreateBlocked = () => {
          setUpgradeReason({
            featureName: page === "researches"
              ? "Нове дослідження"
              : `Новий запис: ${configs[page].title}`,
            reason: page === "researches"
              ? researchLimitMessage || "Досягнуто ліміт досліджень для поточного тарифу."
              : "Досягнуто ліміт записів у цьому розділі. Ви можете редагувати або видаляти наявні записи, але не можете додавати нові.",
            recommendedPlan: "researcher",
            used: page === "researches"
              ? subscriptionAccess.getUsage("researches_per_project")
              : undefined,
            limit: page === "researches"
              ? subscriptionAccess.getLimit("researches_per_project")?.value ?? undefined
              : undefined,
          });
        };
        return (
          <CrudPage
            db={activeDb}
            config={configs[page]}
            items={activeDb[page]}
            researches={activeDb.researches}
            documents={activeDb.documents}
            findings={activeDb.findings}
            persons={activeDb.persons}
            customFieldDefinitions={activeDb.settings.customFields}
            onAddCustomField={canManageStructure && canCreateProjectRecords ? addCustomField : undefined}
            onDeleteCustomField={canManageStructure ? deleteCustomField : undefined}
            canAddCustomField={canCreateCustomField}
            customFieldLimitMessage={customFieldLimitMessage}
            onSavePerson={savePerson}
            onSaveRelation={saveRelation}
            initialSearch={moduleSearch}
            initialOpenEntityId={openEntityId}
            initialCreateRequest={
              createRequest?.page === page
                ? { id: createRequest.id, initialValues: createRequest.initialValues }
                : undefined
            }
            onOpenRelated={openRelatedRecord}
            onOpenScanViewer={openScanViewer}
            onSave={saveFor(page)}
            onImportRecords={importTableRecords}
            onDelete={deleteFor(page)}
            onCreateBlocked={showCreateBlocked}
            projectId={workspace?.projectId}
            onCreateTask={page === "hypotheses" ? (task) => saveTask(task) : undefined}
            readOnly={readOnly}
            canCreate={pageCanCreate}
            projectName={workspace?.projectName}
            researchRequired={researchRequiredByPlan}
          />
        );
      }
      case "persons":
        return (
          <PersonsPage
            db={activeDb}
            projectId={workspace?.projectId}
            persons={activeDb.persons}
            relations={activeDb.personRelations}
            researches={activeDb.researches}
            findings={activeDb.findings}
            tasks={activeDb.tasks}
            hypotheses={activeDb.hypotheses}
            archiveRequests={activeDb.archiveRequests}
            customFieldDefinitions={activeDb.settings.customFields.filter(
              (field) => field.module === "persons",
            )}
            onAddCustomField={canManageStructure && canCreateProjectRecords ? addCustomField : undefined}
            onDeleteCustomField={canManageStructure ? deleteCustomField : undefined}
            canAddCustomField={canCreateCustomField}
            customFieldLimitMessage={customFieldLimitMessage}
            initialSearch={moduleSearch}
            initialOpenPersonId={openEntityId}
            onSavePerson={savePerson}
            onImportRecords={importTableRecords}
            onImportGedcom={importGedcomRecords}
            onDeletePerson={deletePerson}
            onSaveRelation={saveRelation}
            onDeleteRelation={deleteRelation}
            onOpenRelated={openRelatedRecord}
            onCreateRelated={createRelatedRecord}
            readOnly={readOnly}
            canCreate={canCreateStandardSection(standardSectionQuotaKeys.persons)}
            projectName={workspace?.projectName}
            researchRequired={researchRequiredByPlan}
            canUseGedcom={canUseFamilyTreeFeature}
          />
        );
      case "yearMatrix":
        return (
          <YearMatrixPage
            db={activeDb}
            items={activeDb.yearMatrix}
            researches={activeDb.researches}
            documents={activeDb.documents}
            findings={activeDb.findings}
            customFieldDefinitions={activeDb.settings.customFields}
            onAddCustomField={canManageStructure && canCreateProjectRecords ? addCustomField : undefined}
            onDeleteCustomField={canManageStructure ? deleteCustomField : undefined}
            canAddCustomField={canCreateCustomField}
            customFieldLimitMessage={customFieldLimitMessage}
            initialSearch={moduleSearch}
            onOpenRelated={openRelatedRecord}
            onSave={saveFor("yearMatrix")}
            onSaveRange={saveYearMatrixRange}
            onDelete={deleteFor("yearMatrix")}
            readOnly={readOnly}
            canCreate={canCreateStandardSection(standardSectionQuotaKeys.yearMatrix)}
            projectName={workspace?.projectName}
            researchRequired={researchRequiredByPlan}
          />
        );
      case "backup":
        return (
          <BackupPage
            db={activeDb}
            workspace={workspace}
            onReplace={replaceProjectDatabase}
            notify={notify}
            onActivity={(relatedId, text, actionType) =>
              recordProjectActivity("backup", relatedId, text, actionType)
            }
          />
        );
      case "settings":
        return (
          <SettingsPage
            db={activeDb}
            onChange={changeSettings}
            readOnly={Boolean(workspace && workspace.role !== "owner")}
            canCreateCustomSection={canCreateCustomSection}
            customSectionLimitMessage={customSectionLimitMessage}
            canCreateCustomField={canCreateCustomField}
            customFieldLimitMessage={customFieldLimitMessage}
            onUpgradeRequired={() => setUpgradeReason({
              featureName: "Власні розділи",
              reason: customSectionLimitMessage || "Створення власних розділів недоступне або тарифний ліміт уже використано.",
              recommendedPlan: "researcher",
            })}
            onCustomFieldUpgradeRequired={showCustomFieldBlocked}
            sectionCreateRequest={sectionCreateRequest ?? undefined}
            onSectionCreateRequestHandled={() => setSectionCreateRequest(null)}
          />
        );
      case "subscription":
        return (
          <SubscriptionPage
            context={subscriptionAccess.context}
            trialDaysRemaining={subscriptionAccess.trialDaysRemaining}
            loading={subscriptionAccess.loading}
            error={subscriptionAccess.error}
            onRefresh={subscriptionAccess.refreshSubscription}
          />
        );
    }
  })();

  const structuredContent = isHierarchyPage(page) ? (
    <>
      <SectionHierarchyHeader
        page={page}
        sections={activeDb.customSections}
        canManage={!workspace || workspace.role === "owner"}
        onNavigate={navigate}
        onCreateChild={createSubsection}
      />
      {content}
    </>
  ) : content;

  const displayedContent = route.kind === "projects" ? (
    <ProjectsPage
      workspaces={workspaces}
      onOpen={switchWorkspace}
      onCreate={() => void createWorkspace()}
      creating={isCreatingWorkspace}
    />
  ) : route.kind === "settings" ? structuredContent : workspace ? structuredContent : (
    <section className="panel">
      <span className="eyebrow">Робочий простір</span>
      <h1>Проєкт ще не вибрано</h1>
      <p>
        Прийміть вхідне запрошення у розділі «Учасники та запрошення»
        або створіть новий проєкт у меню профілю.
      </p>
      <button
        type="button"
        className="button button-primary"
        onClick={() => setTeamOpen(true)}
      >
        Переглянути запрошення
      </button>
    </section>
  );

  return (
    <div className={activeDb.settings.compactTables ? "compact-tables" : ""}>
      <Layout
        page={route.kind === "projects" ? null : page}
        onNavigate={navigate}
        onOpenProjects={openProjects}
        onOpenGeneHelp={() => {
          if (canOpenGeneHelp) setGeneHelpOpen(true);
        }}
        showGeneHelp={canOpenGeneHelp}
        showFamilyTree={canUseFamilyTreeFeature}
        customSections={activeDb.customSections}
        account={account}
        workspace={workspace}
        workspaces={workspaces}
        onSignInAccount={() => void signIn()}
        onSignOutAccount={() => void signOutAccount()}
        onSwitchWorkspace={switchWorkspace}
        onCreateWorkspace={() => void createWorkspace()}
        onRenameWorkspace={(projectId) => void renameWorkspace(projectId)}
        onDeleteWorkspace={(projectId) => void removeWorkspace(projectId)}
        onOpenTeam={() => setTeamOpen(true)}
        isAccountSigningIn={isAccountSigningIn}
        isCreatingWorkspace={isCreatingWorkspace}
      >
        {subscriptionAccess.isTrial && subscriptionAccess.trialDaysRemaining <= 7 ? (
          <div className="subscription-notice">
            <span>
              До завершення повного пробного доступу залишилося {subscriptionAccess.trialDaysRemaining} дн.
              Після цього діятиме тариф «Старт», а дані буде збережено.
            </span>
            <button type="button" onClick={() => navigate("subscription")}>Обрати тариф</button>
          </div>
        ) : null}
        {subscriptionAccess.subscription?.status === "expired" ? (
          <div className="subscription-notice expired">
            <span>Пробний період завершився. Дані збережено, частина нових дій обмежена тарифом «Старт».</span>
            <button type="button" onClick={() => navigate("subscription")}>Переглянути тарифи</button>
          </div>
        ) : null}
        {displayedContent}
      </Layout>
      <DocumentWorkspaceViewer
        viewer={scanViewer}
        onClose={() => setScanViewer(null)}
        onOpenDocument={(documentId) => openRelatedRecord("documents", documentId)}
        onCreateFinding={createFindingFromViewedDocument}
      />
      {teamOpen && account ? (
        <ProjectTeamModal
          account={account}
          workspace={workspace}
          onClose={() => setTeamOpen(false)}
          onInvitationAccepted={acceptWorkspaceInvitation}
          canInviteMember={subscriptionAccess.canInviteMember}
          onUpgradeRequired={() => setUpgradeReason({
            featureName: "Запрошення учасників",
            reason: "Запрошення учасників недоступне або ліміт поточного тарифу вже використано.",
            recommendedPlan: "researcher",
            used: subscriptionAccess.getUsage("project_members"),
            limit: subscriptionAccess.getLimit("project_members")?.value ?? undefined,
          })}
          onSubscriptionChanged={() => void subscriptionAccess.refreshSubscription()}
          onActivity={(relatedId, text, actionType) =>
            recordProjectActivity("settings", relatedId, text, actionType)
          }
        />
      ) : null}
      {geneHelpOpen && canOpenGeneHelp ? (
        <GeneHelpRequestModal onClose={() => setGeneHelpOpen(false)} />
      ) : null}
      {upgradeReason ? (
        <UpgradeRequiredModal
          {...upgradeReason}
          currentPlan={subscriptionAccess.effectivePlan ?? "free"}
          trialExpired={subscriptionAccess.subscription?.status === "expired"}
          onClose={() => setUpgradeReason(null)}
          onOpenPlans={() => {
            setUpgradeReason(null);
            navigate("subscription");
          }}
        />
      ) : null}
      {toast ? <div className={`toast ${toast.error ? "toast-error" : ""}`}>{toast.message}</div> : null}
    </div>
  );
}
