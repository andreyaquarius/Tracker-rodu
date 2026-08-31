import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const edge = source("../supabase/functions/genehelp/index.ts");
const docs = source("../docs/GENEHELP_INTEGRATION.md");
const workflow = source("../.github/workflows/deploy-supabase-functions.yml");

test("GeneHelp exposes an authenticated, throttled notification sync action", () => {
  assert.match(edge, /\| "sync-notifications"/);
  assert.match(edge, /case "sync-notifications":\s*return await syncNotifications\(context\)/s);
  assert.match(edge, /geneHelpNotificationSyncIntervalMs\s*=\s*45_000/);
  assert.match(edge, /notifications_last_synced_at/);
  assert.match(edge, /from\("user_genehelp_accounts"\)/);
  assert.match(edge, /from\("user_genehelp_requests"\)/);
  assert.match(edge, /decryptApiKey\(/);

  for (const field of [
    "connected",
    "skipped",
    "throttled",
    "notificationPages",
    "notificationsScanned",
    "messageEvents",
    "statusPages",
    "statusesScanned",
    "statusEvents",
  ]) {
    assert.match(edge, new RegExp(`\\b${field}: (?:boolean|number);`));
  }
});

test("GeneHelp polling uses only the documented bounded provider endpoints", () => {
  assert.match(edge, /\/api\/partners\/notifications\?locale=uk&limit=/);
  assert.match(edge, /\/api\/partners\/genealogy-requests\/minimal\?page=/);
  assert.match(
    edge,
    /\/api\/partners\/v2\/genealogy-requests\?limit=(?:100|\$\{geneHelpNotificationPageSize\})/,
  );
  assert.match(edge, /geneHelpNotificationPageSize\s*=\s*100/);
  assert.match(edge, /geneHelpNotificationMaximumPages\s*=\s*20/);
  assert.match(edge, /interaction_unread_message/);
  assert.match(edge, /ai_content/);
  assert.match(
    edge,
    /notificationBatch\.items\.filter\(\(item\) =>\s*item\.type === "interaction_unread_message"/s,
  );
  assert.match(
    edge,
    /unresolvedInteractionIds\.size > 0\s*\? await fetchGeneHelpInteractionRequestMap/s,
  );
  assert.match(edge, /hasMore|has_more/);
  assert.doesNotMatch(edge, /ack(?:nowledge)?[-_/]notifications/i);
  assert.doesNotMatch(edge, /webhook/i);
});

test("notification target URLs are reduced to canonical same-origin identifiers", () => {
  assert.match(
    edge,
    /const targetUrl = record\.target_url === null\s*\? ""\s*:\s*requireBoundedUriReference\(record\.target_url, "notification\.target_url"\)/s,
  );
  assert.match(edge, /new URL\([^\n]+geneHelpBaseUrl\)/);
  assert.match(edge, /\.origin\s*!==\s*(?:new URL\()?geneHelpBaseUrl/);
  assert.match(edge, /target_url/);
  assert.match(edge, /(?:requests|genealogy-requests)/);
  assert.match(edge, /interactions/);
  assert.match(edge, /\[A-Za-z0-9_-\]/);
  const uriReferenceHelper = edge.slice(
    edge.indexOf("function requireBoundedUriReference"),
    edge.indexOf("function requireProviderTimestamp"),
  );
  assert.match(uriReferenceHelper, /requireBoundedText\(value, 0, 2_048, field\)/);
  const boundedTextHelper = edge.slice(
    edge.indexOf("function requireBoundedText"),
    edge.indexOf("function requireEnum"),
  );
  assert.match(
    boundedTextHelper,
    /text\.length > maximumLength \|\| \/\[\\u0000-\\u001f\\u007f\]\/\.test\(text\)/,
  );
  assert.doesNotMatch(edge, /window\.(?:open|location)/);
});

test("provider events are allowlisted, hashed, and delivered through the service RPC", () => {
  assert.match(edge, /service_receive_genehelp_notification_v1/);
  for (const argument of [
    "p_provider_event_id",
    "p_event_type",
    "p_occurred_at",
    "p_genehelp_request_id",
    "p_genehelp_user_id",
    "p_status",
    "p_reply",
    "p_payload_sha256",
  ]) {
    assert.match(edge, new RegExp(`\\b${argument}\\b`));
  }
  assert.match(edge, /notification:\$\{/);
  assert.match(edge, /status:\$\{/);
  assert.match(edge, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(edge, /p_event_type:\s*"interaction_unread_message"/);
  assert.match(edge, /p_event_type:\s*"genealogy_request\.status_changed"/);
  const identityStart = edge.indexOf("const stableIdentity = {");
  const identityEnd = edge.indexOf("};", identityStart);
  assert.ok(identityStart >= 0 && identityEnd > identityStart, "stable message identity must exist");
  const stableIdentity = edge.slice(identityStart, identityEnd);
  assert.doesNotMatch(stableIdentity, /\b(?:age|description|preview|title)\b/);
  assert.match(edge, /current\.code === null[\s\S]*silentlyBaselineGeneHelpStatus/);
  assert.match(
    edge,
    /const samePublicStatus = current\.publicStatus === null \|\|\s*equalStatusCode\(current\.publicStatus, remote\.publicStatus\)/s,
  );
  const publicStatusParser = edge.slice(
    edge.indexOf("function firstKnownPublicStatus"),
    edge.indexOf("function equalStatusCode"),
  );
  assert.ok(
    /const text = value\.trim\(\);[\s\S]*return text\.slice\(0, 128\)/.test(publicStatusParser) &&
      !/if \([^)]*!text/.test(publicStatusParser),
    "an explicit empty public_status must remain known; only null is unknown-equivalent",
  );
  assert.match(
    edge,
    /if \(sameStatus && samePublicStatus\) \{\s*if \(Date\.parse\(providerUpdatedAt!\) < Date\.parse\(remote\.updatedAt\)\) \{\s*await silentlyBaselineGeneHelpStatus/s,
  );
  assert.match(edge, /\[429, 504\]\.includes\(error\.status\)/);
  assert.doesNotMatch(edge, /console\.(?:log|info|debug|warn|error)/);
});

test("documentation records polling, security, and initial status-baseline behavior", () => {
  assert.match(docs, /немає webhook і немає\s+окремого ACK endpoint/i);
  assert.match(docs, /дзвіночок сповіщень/);
  assert.match(docs, /45 секунд/);
  assert.match(docs, /GET \/api\/partners\/notifications\?locale=uk&limit=100&page=N/);
  assert.match(docs, /GET \/api\/partners\/genealogy-requests\/minimal\?page=N/);
  assert.match(docs, /GET \/api\/partners\/v2\/genealogy-requests\?limit=100/);
  assert.match(docs, /interaction_unread_message/);
  assert.match(docs, /`ai_content` ігнорується/);
  assert.match(docs, /20 сторінками/);
  assert.match(docs, /integration token ніколи не\s+передається у браузер/s);
  assert.match(docs, /канонічного шляху того самого\s+origin/s);
  assert.match(docs, /початковий стан запиту без\s+сповіщення/s);
});

test("Supabase deployment workflow runs the complete GeneHelp contract gate", () => {
  assert.match(workflow, /- "test\/geneHelp\*\.test\.ts"/);
  assert.match(workflow, /- name: Verify GeneHelp notification sync contracts\s+run: node --test --test-concurrency=1 "test\/geneHelp\*\.test\.ts"/s);
  assert.ok(
    workflow.indexOf("Verify GeneHelp notification sync contracts") < workflow.indexOf("Preview database migrations"),
    "GeneHelp contracts must pass before database migrations",
  );
  assert.ok(
    workflow.indexOf("Verify GeneHelp notification sync contracts") < workflow.indexOf("Deploy Edge Functions"),
    "GeneHelp contracts must pass before Edge Function deployment",
  );
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
