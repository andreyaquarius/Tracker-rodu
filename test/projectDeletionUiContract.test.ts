import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/services/supabaseAuth.ts", import.meta.url), "utf8");
const topBar = readFileSync(new URL("../src/components/TopBar.tsx", import.meta.url), "utf8");
const projectsPage = readFileSync(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");

test("workspace state changes only after the durable deletion reports completion", () => {
  const handlerStart = app.indexOf("const removeWorkspace = async");
  const handlerEnd = app.indexOf("const renameWorkspace = async", handlerStart);
  const handler = app.slice(handlerStart, handlerEnd);
  const completion = handler.indexOf("await deleteSupabaseWorkspace");
  assert.ok(completion >= 0);
  assert.ok(handler.indexOf("clearProjectResearchCache", completion) > completion);
  assert.ok(handler.indexOf("setWorkspaces(refreshed)", completion) > completion);
  assert.ok(handler.indexOf("routerNavigate", completion) > completion);
});

test("the browser wakes the asynchronous worker and never runs deletion batches itself", () => {
  assert.match(auth, /functions\.invoke\("process-project-deletions"/);
  assert.doesNotMatch(auth, /rpc\("process_project_deletion"/);
  assert.doesNotMatch(auth, /from\("projects"\)\.delete/);
});

test("workspace loading retains pending deletions with a rolling-deploy fallback", () => {
  assert.match(auth, /deletionPending: project\.deletion_pending === true/);
  assert.doesNotMatch(auth, /if \(!project \|\| project\.deletion_pending === true\) return null/);
  assert.match(auth, /rpc\("list_accessible_project_deletions"\)/);
  assert.match(auth, /deletionJobId: deletion\.jobId/);
  assert.match(auth, /isMissingDeletionPendingError/);
  assert.match(auth, /projects!inner\(id, name, slug\)/);
  assert.match(auth, /projects!inner\(id, name\)"/);
  assert.match(app, /items\.filter\(\(item\) => !item\.deletionPending\)/);
});

test("pending workspaces cannot be opened or renamed and expose only their existing job", () => {
  assert.match(topBar, /item\.deletionPending \? " · Видаляється"/);
  assert.match(topBar, /onOpenWorkspaceDeletion\(item\.projectId\)/);
  assert.match(topBar, /disabled=\{isCreatingWorkspace \|\| item\.deletionPending\}/);
  assert.match(projectsPage, /project-route-card-pending/);
  assert.match(projectsPage, /onOpenDeletion\(workspace\.projectId\)/);
  assert.match(projectsPage, /Переглянути видалення/);
  assert.match(app, /if \(nextWorkspace\.deletionPending\)/);
  assert.match(app, /if \(requestedWorkspace\.deletionPending\)/);
  assert.match(app, /workspaces\.filter\(\(item\) => !item\.deletionPending\)\.length <= 1/);
  assert.doesNotMatch(auth, /role: "admin"/);

  const removeStart = app.indexOf("const removeWorkspace = async");
  const removeEnd = app.indexOf("const renameWorkspace = async", removeStart);
  const removeHandler = app.slice(removeStart, removeEnd);
  assert.ok(removeHandler.indexOf("targetWorkspace.deletionPending") < removeHandler.indexOf("window.confirm"));
});

test("reopening targets the durable job and delegates failed-job requeue safely", () => {
  const resumeStart = auth.indexOf("export async function resumeSupabaseWorkspaceDeletion");
  const resumeEnd = auth.indexOf("export async function renameSupabaseWorkspace", resumeStart);
  const resumeHandler = auth.slice(resumeStart, resumeEnd);
  assert.match(resumeHandler, /workspace\.deletionJobId/);
  assert.match(resumeHandler, /resumeProjectDeletion/);
  assert.doesNotMatch(resumeHandler, /start_project_deletion/);

  const appResumeStart = app.indexOf("const resumeWorkspaceDeletion = async");
  const appResumeEnd = app.indexOf("const removeWorkspace = async", appResumeStart);
  const appResumeHandler = app.slice(appResumeStart, appResumeEnd);
  assert.match(appResumeHandler, /resumeSupabaseWorkspaceDeletion/);
  assert.doesNotMatch(appResumeHandler, /window\.confirm/);
});

test("the progress overlay can detach polling without cancelling server deletion", () => {
  assert.match(app, /Закрити й продовжити у фоні/);
  assert.match(app, /workspaceDeletionAbortRef\.current\?\.abort\(\)/);
  assert.match(app, /signal: abortController\.signal/);
  assert.match(app, /if \(!isAbortError\(error\)\)/);
  assert.match(
    app,
    /if \(workspaceDeletionAbortRef\.current === abortController\) \{[\s\S]*?setWorkspaceDeletion\(null\);[\s\S]*?setIsCreatingWorkspace\(false\);[\s\S]*?\}/,
  );
});

test("project deletion has persistent progress and disables duplicate workspace actions", () => {
  assert.match(app, /className="workspace-deletion-overlay"/);
  assert.match(app, /role="progressbar"/);
  assert.match(app, /projectDeletionServerActivityLabel\(workspaceDeletion\.progress\.updatedAt\)/);
  assert.match(app, /recentProcessedDelta/);
  assert.match(app, /Відсоток оновлюється після завершення поточного розділу/);
  assert.match(app, /Можна закрити цю вкладку/);
  assert.match(topBar, /disabled=\{isCreatingWorkspace \|\| !item\.deletionJobId\}/);
});
