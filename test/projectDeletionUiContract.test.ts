import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/services/supabaseAuth.ts", import.meta.url), "utf8");
const topBar = readFileSync(new URL("../src/components/TopBar.tsx", import.meta.url), "utf8");

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

test("workspace loading hides pending deletions with a rolling-deploy fallback", () => {
  assert.match(auth, /project\.deletion_pending === true/);
  assert.match(auth, /isMissingDeletionPendingError/);
  assert.match(auth, /projects!inner\(id, name, slug\)/);
  assert.match(auth, /projects!inner\(id, name\)"/);
});

test("project deletion has persistent progress and disables duplicate workspace actions", () => {
  assert.match(app, /className="workspace-deletion-overlay"/);
  assert.match(app, /role="progressbar"/);
  assert.match(app, /Можна закрити цю вкладку/);
  assert.ok((topBar.match(/disabled=\{isCreatingWorkspace\}/g) ?? []).length >= 4);
});
