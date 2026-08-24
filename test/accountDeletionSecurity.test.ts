import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const initialMigration = readFileSync(
  new URL("../supabase/migrations/202608170001_account_self_delete.sql", import.meta.url),
  "utf8",
);
const hardeningMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608180001_account_self_delete_hardening.sql",
    import.meta.url,
  ),
  "utf8",
);
const edgeFunction = readFileSync(
  new URL("../supabase/functions/delete-account/index.ts", import.meta.url),
  "utf8",
);
const clientService = readFileSync(
  new URL("../src/services/accountDeletion.ts", import.meta.url),
  "utf8",
);
const topBar = readFileSync(
  new URL("../src/components/TopBar.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);

test("account deletion RPC is service-role only, including the inherited PUBLIC role", () => {
  assert.doesNotMatch(initialMigration, /grant execute[\s\S]*?authenticated/i);
  assert.match(
    hardeningMigration,
    /revoke all on function public\.delete_account_data\(uuid\) from public, anon, authenticated/i,
  );
  assert.match(
    hardeningMigration,
    /grant execute on function public\.delete_account_data\(uuid\) to service_role/i,
  );
  assert.match(
    hardeningMigration,
    /revoke all on function public\.delete_account_data_v2\(uuid\) from public, anon, authenticated/i,
  );
  assert.match(
    hardeningMigration,
    /grant execute on function public\.complete_account_deletion\(uuid\) to service_role/i,
  );
});

test("account deletion preserves data in projects owned by another user", () => {
  assert.match(
    hardeningMigration,
    /delete from public\.projects project[\s\S]*?project\.owner_id = p_user_id/i,
  );
  assert.match(
    hardeningMigration,
    /set %I = project\.owner_id[\s\S]*?target\.project_id = project\.id/i,
  );
  assert.match(hardeningMigration, /set %I = null where %I = \$1/i);
  assert.doesNotMatch(
    hardeningMigration,
    /delete from %I\.%I where %I = \$1/i,
  );
});

test("administrator self-delete is blocked in both database and Edge Function", () => {
  assert.match(hardeningMigration, /if public\.is_app_admin\(p_user_id\)/i);
  assert.match(hardeningMigration, /ADMIN_ACCOUNT_DELETE_BLOCKED/);
  assert.match(edgeFunction, /admin\.rpc\("is_app_admin"/);
  assert.match(edgeFunction, /if \(isAdmin === true\)/);
  assert.match(edgeFunction, /new HttpError\(\s*403/);
});

test("owned project files use a durable manifest between database and auth deletion", () => {
  assert.match(hardeningMigration, /create table if not exists private\.account_deletion_jobs/i);
  assert.match(hardeningMigration, /project_ids uuid\[\]/i);
  assert.match(hardeningMigration, /insert into private\.account_deletion_jobs/i);
  assert.match(
    edgeFunction,
    /"project-backups",\s*"project-attachments",\s*"gedcom-exports"/,
  );
  assert.match(edgeFunction, /\.list\(directory,\s*\{/);
  assert.match(edgeFunction, /\.remove\(files\.slice/);
  assert.match(
    edgeFunction,
    /admin\.rpc\([\s\S]*?"delete_account_data_v2"[\s\S]*?removeOwnedProjectStorage[\s\S]*?complete_account_deletion[\s\S]*?admin\.auth\.admin\.deleteUser/,
  );
});

test("account deletion has independent auth config and returns generic internal failures", () => {
  assert.doesNotMatch(edgeFunction, /authenticatedContext/);
  assert.doesNotMatch(edgeFunction, /ENCRYPTION_KEY/);
  assert.match(edgeFunction, /auth\.getUser\(\)/);
  assert.match(edgeFunction, /очищення продовжиться з останнього завершеного кроку/);
});

test("client requires explicit server confirmation and UI requires a destructive phrase", () => {
  assert.match(clientService, /response\?\.deleted !== true/);
  assert.match(topBar, /deleteConfirmationValue\.trim\(\) !== "ВИДАЛИТИ"/);
  assert.match(topBar, /disabled=\{deleteConfirmationValue\.trim\(\) !== "ВИДАЛИТИ"\}/);
});

test("administrator account deletion fails closed until account-level access is resolved", () => {
  assert.match(
    app,
    /const subscriptionAccess = useSubscription\([\s\S]*?Boolean\(account\),[\s\S]*?account\?\.id \?\? "",[\s\S]*?\);/,
  );
  assert.match(
    app,
    /const canDeleteAccount = Boolean\(subscriptionAccess\.context\) && !subscriptionAccess\.isAdmin;/,
  );
  assert.match(topBar, /canDeleteAccount: boolean;/);
  assert.match(topBar, /\{canDeleteAccount \? \(/);
  assert.match(app, /if \(!canDeleteAccount\) \{/);
});
