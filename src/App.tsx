import { useState } from "react";
import type { AppEntity, CollectionKey, Person, PersonRelation } from "./types";
import { useAppDatabase } from "./hooks/useAppDatabase";
import { Layout } from "./components/Layout";
import type { PageKey } from "./components/Sidebar";
import { DashboardPage } from "./pages/DashboardPage";
import { CrudPage } from "./pages/CrudPage";
import { configs } from "./pages/entityConfigs";
import { YearMatrixPage } from "./pages/YearMatrixPage";
import { BackupPage } from "./pages/BackupPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { PersonsPage } from "./pages/PersonsPage";

const ONBOARDING_KEY = "tracker-rodu-onboarded";
const LEGACY_ONBOARDING_KEY = "rodovyi-navigator-onboarded";

export default function App() {
  const app = useAppDatabase();
  const [page, setPage] = useState<PageKey>("dashboard");
  const [moduleSearch, setModuleSearch] = useState("");
  const [openEntityId, setOpenEntityId] = useState("");
  const [createRequest, setCreateRequest] = useState<{
    id: number;
    page: PageKey;
    initialValues: Record<string, unknown>;
  } | null>(null);
  const [onboarded, setOnboarded] = useState(() => {
    const value =
      localStorage.getItem(ONBOARDING_KEY) ??
      localStorage.getItem(LEGACY_ONBOARDING_KEY);
    if (value === "1") {
      localStorage.setItem(ONBOARDING_KEY, "1");
      localStorage.removeItem(LEGACY_ONBOARDING_KEY);
      return true;
    }
    return false;
  });
  const [loginError, setLoginError] = useState("");
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);

  const notify = (message: string, error = false) => {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 3500);
  };

  const connect = async () => {
    setLoginError("");
    try {
      await app.connectGoogle();
      localStorage.setItem(ONBOARDING_KEY, "1");
      setOnboarded(true);
      notify("Google Drive підключено.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не вдалося підключити Google.";
      setLoginError(message);
      notify(message, true);
    }
  };

  const continueLocal = () => {
    localStorage.setItem(ONBOARDING_KEY, "1");
    setOnboarded(true);
  };

  if (!onboarded) {
    return <LoginPage onGoogle={() => void connect()} onLocal={continueLocal} loading={app.isSigningIn} error={loginError} />;
  }

  const saveFor = (collection: CollectionKey) => (entity: AppEntity) => app.saveEntity(collection, entity);
  const deleteFor = (collection: CollectionKey) => (id: string) => app.deleteEntity(collection, id);
  const navigate = (nextPage: PageKey) => {
    setModuleSearch("");
    setOpenEntityId("");
    setCreateRequest(null);
    setPage(nextPage);
  };
  const openSearchResult = (nextPage: PageKey, query: string, entityId?: string) => {
    setModuleSearch(query);
    setOpenEntityId(entityId ?? "");
    setPage(nextPage);
  };
  const openRelatedRecord = (nextPage: PageKey, entityId: string) => {
    setModuleSearch("");
    setOpenEntityId(entityId);
    setCreateRequest(null);
    setPage(nextPage);
  };
  const createRelatedRecord = (nextPage: PageKey, initialValues: Record<string, unknown>) => {
    setModuleSearch("");
    setOpenEntityId("");
    setCreateRequest({
      id: Date.now(),
      page: nextPage,
      initialValues,
    });
    setPage(nextPage);
  };
  const savePerson = (person: Person) => app.saveEntity("persons", person);
  const deletePerson = (id: string) => {
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
    }));
  };
  const saveRelation = (relation: PersonRelation) => {
    app.setDatabase((current) => ({
      ...current,
      personRelations: current.personRelations.some((item) => item.id === relation.id)
        ? current.personRelations.map((item) => item.id === relation.id ? relation : item)
        : [...current.personRelations, relation],
    }));
  };
  const deleteRelation = (id: string) => {
    app.setDatabase((current) => ({
      ...current,
      personRelations: current.personRelations.filter((relation) => relation.id !== id),
    }));
  };

  const content = (() => {
    switch (page) {
      case "dashboard":
        return (
          <DashboardPage
            db={app.db}
            onNavigate={navigate}
            onOpenSearchResult={openSearchResult}
          />
        );
      case "researches":
      case "documents":
      case "tasks":
      case "findings":
      case "hypotheses":
        return (
          <CrudPage
            config={configs[page]}
            items={app.db[page]}
            researches={app.db.researches}
            documents={app.db.documents}
            findings={app.db.findings}
            persons={app.db.persons}
            onSavePerson={savePerson}
            initialSearch={moduleSearch}
            initialOpenEntityId={openEntityId}
            initialCreateRequest={
              createRequest?.page === page
                ? { id: createRequest.id, initialValues: createRequest.initialValues }
                : undefined
            }
            onOpenRelated={openRelatedRecord}
            onSave={saveFor(page)}
            onDelete={deleteFor(page)}
          />
        );
      case "persons":
        return (
          <PersonsPage
            persons={app.db.persons}
            relations={app.db.personRelations}
            researches={app.db.researches}
            findings={app.db.findings}
            tasks={app.db.tasks}
            hypotheses={app.db.hypotheses}
            initialSearch={moduleSearch}
            initialOpenPersonId={openEntityId}
            onSavePerson={savePerson}
            onDeletePerson={deletePerson}
            onSaveRelation={saveRelation}
            onDeleteRelation={deleteRelation}
            onOpenRelated={openRelatedRecord}
            onCreateRelated={createRelatedRecord}
          />
        );
      case "yearMatrix":
        return (
          <YearMatrixPage
            items={app.db.yearMatrix}
            researches={app.db.researches}
            documents={app.db.documents}
            findings={app.db.findings}
            initialSearch={moduleSearch}
            onOpenRelated={openRelatedRecord}
            onSave={saveFor("yearMatrix")}
            onDelete={deleteFor("yearMatrix")}
          />
        );
      case "backup":
        return (
          <BackupPage
            db={app.db}
            user={app.user}
            sync={app.sync}
            onReplace={app.replaceDatabase}
            onSync={app.forceSyncNow}
            notify={notify}
          />
        );
      case "settings":
        return <SettingsPage db={app.db} onChange={app.setDatabase} />;
    }
  })();

  return (
    <div className={app.db.settings.compactTables ? "compact-tables" : ""}>
      <Layout
        page={page}
        onNavigate={navigate}
        user={app.user}
        sync={app.sync}
        onConnect={() => void connect()}
        onDisconnect={app.disconnectGoogle}
        isSigningIn={app.isSigningIn}
      >
        {content}
      </Layout>
      {toast ? <div className={`toast ${toast.error ? "toast-error" : ""}`}>{toast.message}</div> : null}
    </div>
  );
}
