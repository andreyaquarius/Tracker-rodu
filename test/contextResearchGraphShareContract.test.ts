import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/contextRelationsService.ts", import.meta.url),
  "utf8",
);
const supabaseAuth = readFileSync(
  new URL("../src/services/supabaseAuth.ts", import.meta.url),
  "utf8",
);
const manager = readFileSync(
  new URL("../src/features/context-graph/ResearchGraphShareManager.tsx", import.meta.url),
  "utf8",
);
const viewer = readFileSync(
  new URL("../src/features/context-graph/SharedResearchGraphPage.tsx", import.meta.url),
  "utf8",
);
const researchGraph = readFileSync(
  new URL("../src/features/context-graph/PersonResearchGraphV1.tsx", import.meta.url),
  "utf8",
);
const contextWorkspace = readFileSync(
  new URL("../src/features/context-graph/PersonContextWorkspaceV1.tsx", import.meta.url),
  "utf8",
);
const personsModule = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const shareMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608290023_context_graph_saved_view_shares.sql",
    import.meta.url,
  ),
  "utf8",
);

test("owner share service uses exact authenticated management RPC contract", () => {
  const block = sourceBlock(
    service,
    "/** Lists owner-visible metadata only",
    "/**\n * Anonymous boundary",
  );
  for (const rpc of [
    "list_context_graph_view_shares_v1",
    "create_context_graph_view_share_v1",
    "update_context_graph_view_share_v1",
    "revoke_context_graph_view_share_v1",
  ]) {
    assert.match(block, new RegExp(`client\\.rpc\\("${rpc}"`, "u"), `Missing ${rpc}`);
  }
  for (const parameter of [
    "p_project_id", "p_view_id", "p_access_mode", "p_expires_at",
    "p_public_title", "p_share_id", "p_expected_lock_version",
  ]) {
    assert.match(block, new RegExp(`${parameter}:`, "u"), `Missing ${parameter}`);
  }
  assert.match(block, /runAuthenticatedSupabaseRequest/u);
  assert.match(block, /public_readonly/u);
  assert.match(
    block,
    /p_expected_lock_version: draft\.expectedLockVersion === null[\s\S]*?positiveInteger\(draft\.expectedLockVersion\)/u,
  );
  assert.match(service, /version_conflict[\s\S]*?іншій вкладці/u);
  assert.doesNotMatch(block, /localStorage|sessionStorage|indexedDB/u);
});

test("public resolver posts only fragment bearer token to the dedicated sanitized RPC", () => {
  const block = sourceBlock(
    service,
    "export async function getSharedResearchGraphView",
    "/** Saves a polymorphic contextual assertion",
  );
  assert.match(block, /client\.rpc\("get_shared_context_graph_view_v1",\s*\{[\s\S]*?p_token:/u);
  assert.match(block, /getAnonymousSupabaseClient\(\)/u);
  assert.doesNotMatch(block, /runAuthenticatedSupabaseRequest|getPersonResearchGraph|p_project_id|p_view_id/u);
  assert.match(block, /mapSharedResearchGraphView/u);
});

test("public share client cannot inherit or persist the signed-in session", () => {
  const block = sourceBlock(
    supabaseAuth,
    "const anonymousNoStoreFetch",
    "function requireSupabase",
  );
  assert.match(block, /persistSession:\s*false/u);
  assert.match(block, /autoRefreshToken:\s*false/u);
  assert.match(block, /detectSessionInUrl:\s*false/u);
  assert.match(block, /storageKey:\s*"tracker-rodu-public-share-anon-v1"/u);
  assert.match(block, /cache:\s*"no-store"/u);
  assert.match(block, /credentials:\s*"omit"/u);
  assert.match(block, /referrerPolicy:\s*"no-referrer"/u);
  assert.match(
    supabaseAuth,
    /let supabase: ReturnType<typeof createAuthenticatedSupabaseClient> \| null = null/u,
  );
  const authenticatedFactory = sourceBlock(
    supabaseAuth,
    "function createAuthenticatedSupabaseClient",
    "// Deliberately lazy.",
  );
  assert.match(authenticatedFactory, /createClient/u);
  assert.match(authenticatedFactory, /persistSession:\s*true/u);
  const normalFactory = sourceBlock(
    supabaseAuth,
    "function requireSupabase",
    "export function getSupabaseClient",
  );
  assert.match(normalFactory, /supabase = createAuthenticatedSupabaseClient\(\)/u);
  assert.doesNotMatch(normalFactory, /createClient\(/u);
});

test("public mapper fails closed on raw IDs, private entity types and private payload fields", () => {
  const block = sourceBlock(service, "function mapSharedResearchGraphView", "function isoTimestamp");
  assert.match(block, /\^\[A-Za-z0-9_-\]\{43\}\$/u);
  assert.match(block, /entityType !== "person" && entityType !== "place"/u);
  assert.match(block, /row\.masked === true/u);
  assert.match(block, /viewRow\.title/u);
  assert.match(block, /accessMode !== "public_readonly"/u);
  assert.doesNotMatch(block, /projectId|ownerId|savedViewId|metadata|notes|entityId|lockVersion/u);
});

test("owner UI provides one-time copy, bounded expiry, rotate, update and revoke", () => {
  assert.match(manager, /Строк дії нового посилання/u);
  assert.match(manager, /days:\s*30/u);
  assert.match(manager, /Публічна назва/u);
  assert.match(manager, /приватна назва представлення не публікується автоматично/u);
  assert.match(manager, /явно позначені публічними[\s\S]*?мають записану дату смерті/u);
  assert.match(manager, /Замінити посилання/u);
  assert.match(manager, /Повторно опублікувати/u);
  assert.match(manager, /Оновити назву і строк/u);
  assert.match(manager, /Підтвердити відкликання/u);
  assert.match(manager, /Оновити список/u);
  assert.match(manager, /navigator\.clipboard\?\.writeText/u);
  assert.match(manager, /показується один раз/u);
  assert.match(manager, /expectedLockVersion: currentShare\?\.lockVersion \?\? null/u);
  assert.doesNotMatch(manager, /localStorage|sessionStorage|indexedDB/u);
});

test("share controls require both exact project ownership and the global rollout", () => {
  assert.match(
    app,
    /canManageShareLinks=\{workspace\?\.role === "owner" && contextGraphPublicSharingEnabled\}/u,
  );
  assert.match(personsModule, /canManageShareLinks=\{canManageShareLinks\}/u);
  assert.match(contextWorkspace, /canManageShareLinks=\{canManageShareLinks\}/u);
  assert.match(researchGraph, /\{canManageShareLinks \? \(/u);
  assert.doesNotMatch(researchGraph, /canEdit && canManageShareLinks/u);
});

test("anonymous viewer is read-only, generic while loading and server-title driven after load", () => {
  assert.match(viewer, /sharedView\?\.view\.title \|\| "Спільний дослідницький граф"/u);
  assert.match(viewer, /getSharedResearchGraphView\(token\)/u);
  assert.match(viewer, /Живі особи, непублічні записи/u);
  assert.match(viewer, /INACTIVE_LINK_MESSAGE/u);
  assert.match(viewer, /clampResearchGraphViewport/u);
  assert.match(viewer, /aria-label="Зменшити масштаб графа"/u);
  assert.match(viewer, /aria-label="Збільшити масштаб графа"/u);
  assert.doesNotMatch(viewer, /onOpenPerson|onOpenDocument|onOpenFinding|download|href=|projectId/u);
});

test("anonymous viewer reproduces the saved deterministic layout without exposing edit controls", () => {
  assert.match(viewer, /buildResearchGraphLayout\(nodes, edges, sharedView\.view\.layoutId\)/u);
  assert.match(viewer, /sharedLayoutLabel\(sharedView\.view\.layoutId\)/u);
  assert.doesNotMatch(viewer, /role="radiogroup"|selectLayout/u);
});

test("stable share status uses one statement timestamp", () => {
  const block = sourceBlock(
    shareMigration,
    "create or replace function security_private.context_graph_share_status_v1",
    "create or replace function security_private.context_graph_share_meta_json_v1",
  );
  assert.match(block, /\bstable\b/u);
  assert.match(block, /statement_timestamp\(\)/u);
  assert.doesNotMatch(block, /clock_timestamp\(\)/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
