import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PERSON_CONTEXT_GRAPHS_FEATURE_KEY,
  resolvePersonContextGraphAccess,
} from "../src/utils/contextGraphFeatureAccess.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/202608300001_context_graph_feature_rollout.sql", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const subscriptionService = readFileSync(
  new URL("../src/services/subscriptionService.ts", import.meta.url),
  "utf8",
);
const personsModule = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);
const featureAdmin = readFileSync(new URL("../src/pages/SubscriptionPage.tsx", import.meta.url), "utf8");
const adminPanel = readFileSync(new URL("../src/pages/AdminPanelPage.tsx", import.meta.url), "utf8");

test("person context rollout access fails closed until the account-specific decision is resolved", () => {
  assert.equal(PERSON_CONTEXT_GRAPHS_FEATURE_KEY, "person_context_graphs_v1");
  assert.equal(resolvePersonContextGraphAccess({
    authenticated: false,
    requestResolved: true,
    effectiveEnabled: true,
  }), "disabled");
  assert.equal(resolvePersonContextGraphAccess({
    authenticated: true,
    requestResolved: false,
    effectiveEnabled: true,
  }), "loading");
  assert.equal(resolvePersonContextGraphAccess({
    authenticated: true,
    requestResolved: true,
    effectiveEnabled: false,
  }), "disabled");
  assert.equal(resolvePersonContextGraphAccess({
    authenticated: true,
    requestResolved: true,
    effectiveEnabled: true,
  }), "enabled");
});

test("the access client rejects a mismatched or malformed server decision", () => {
  const loader = subscriptionService.slice(
    subscriptionService.indexOf("export async function loadMyAppFeatureAccess"),
    subscriptionService.indexOf("export async function loadAdminSubscriptions"),
  );
  assert.match(loader, /row\.key !== key/u);
  assert.match(loader, /typeof row\.globalEnabled !== "boolean"/u);
  assert.match(loader, /typeof row\.effectiveEnabled !== "boolean"/u);
  assert.doesNotMatch(loader, /key: String\(row\.key \?\? key\)/u);
  assert.doesNotMatch(loader, /effectiveEnabled: Boolean\(row\.effectiveEnabled\)/u);
});

test("migration deploys the module globally off and preserves an existing rollout choice", () => {
  assert.match(migration, /'person_context_graphs_v1'[\s\S]*?false,[\s\S]*?true/u);
  const conflictUpdate = migration.match(/on conflict \(key\) do update[\s\S]*?;/u)?.[0] ?? "";
  assert.doesNotMatch(conflictUpdate, /is_enabled\s*=/u);
  assert.match(migration, /security_private\.app_feature_user_access/u);
  assert.match(migration, /primary key \(feature_key, user_id\)/u);
  assert.match(migration, /admin_set_my_feature_preview_v1/u);
});

test("server guards every context RPC and keeps service synchronizers alive", () => {
  const contextGuard = migration.match(
    /create or replace function security_private\.require_context_project_access_v1[\s\S]*?\$function\$;/u,
  )?.[0] ?? "";
  assert.match(contextGuard, /auth\.role\(\)[\s\S]*?service_role[\s\S]*?return;/u);
  assert.match(contextGuard, /app_feature_access_for_user_v1[\s\S]*?'person_context_graphs_v1'/u);
  assert.match(contextGuard, /APP_FEATURE_DISABLED:person_context_graphs_v1/u);
  assert.match(migration, /require_context_graph_share_project_owner_v1[\s\S]*?app_feature_access_for_user_v1/u);
  assert.match(migration, /get_shared_context_graph_view_v1[\s\S]*?require_app_feature_global_v1/u);
});

test("client hides the entry point and blocks a direct context URL before mounting graph loaders", () => {
  const outerRouteGate = personsModule.slice(
    personsModule.indexOf("export function PersonsModuleV2"),
    personsModule.indexOf("function PersonContextRouteV2"),
  );
  assert.match(outerRouteGate, /target\.mode === "context"[\s\S]*?contextGraphAccess !== "enabled"/u);
  assert.ok(
    outerRouteGate.indexOf("PersonContextFeatureGateV2") < outerRouteGate.indexOf("PersonContextRouteV2"),
    "the access gate must run before the route component that starts RPC loading",
  );
  assert.match(personsModule, /onOpenContext=\{contextGraphAccess === "enabled"/u);
  assert.match(app, /loadMyAppFeatureAccess\(PERSON_CONTEXT_GRAPHS_FEATURE_KEY\)/u);
  assert.match(app, /contextGraphAccess=\{personContextGraphAccess\}/u);
  assert.match(app, /canManageShareLinks=\{workspace\?\.role === "owner" && contextGraphPublicSharingEnabled\}/u);
});

test("a private-preview access failure cannot disable established global feature flags", () => {
  const featureLoad = app.slice(
    app.indexOf("void loadAppFeatureFlags()"),
    app.indexOf("// Family Tree and Persons V2 are core authenticated modules"),
  );
  assert.match(
    featureLoad,
    /loadAppFeatureFlags\(\)[\s\S]*?setFeatureFlags\(flags\)/u,
  );
  assert.match(
    featureLoad,
    /loadMyAppFeatureAccess\(PERSON_CONTEXT_GRAPHS_FEATURE_KEY\)[\s\S]*?setFeatureFlagsStatus\("ready"\)[\s\S]*?setFeatureFlagsStatus\("error"\)/u,
  );
  assert.doesNotMatch(
    featureLoad,
    /Promise\.all(?:Settled)?\(\[[\s\S]*?loadAppFeatureFlags\(\)[\s\S]*?loadMyAppFeatureAccess/u,
  );
  const contextFailureBranch = featureLoad.slice(
    featureLoad.indexOf("void loadMyAppFeatureAccess"),
  );
  assert.doesNotMatch(contextFailureBranch, /setFeatureFlags\(\{\}\)/u);
});

test("Functions UI separates private self-preview from the later global release", () => {
  assert.match(featureAdmin, /Увімкнути лише мені/u);
  assert.match(featureAdmin, /Лише мені: увімкнено/u);
  assert.match(featureAdmin, /Для всіх: вимкнено/u);
  assert.match(featureAdmin, /Для всіх: увімкнено/u);
  assert.match(featureAdmin, /adminSetMyFeaturePreview/u);
});

test("the admin feature list refreshes effective access only after a mutation", () => {
  const refreshFeatures = adminPanel.slice(
    adminPanel.indexOf("const refreshFeatures = useCallback"),
    adminPanel.indexOf("const refreshAnnouncements = useCallback"),
  );
  assert.match(refreshFeatures, /setFeatureFlags\(await loadAdminFeatureFlags\(\)\)/u);
  assert.doesNotMatch(refreshFeatures, /onFeatureFlagsChanged/u);

  const featurePage = adminPanel.slice(
    adminPanel.indexOf('currentPage === "features"'),
    adminPanel.indexOf('currentPage === "announcements"'),
  );
  assert.match(featurePage, /onChanged=\{async \(\) =>/u);
  assert.match(featurePage, /finally[\s\S]*?onFeatureFlagsChanged\?\.\(\)/u);
});
