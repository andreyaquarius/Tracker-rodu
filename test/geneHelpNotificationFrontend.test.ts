import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bell = source("../src/components/AnnouncementBell.tsx");
const layout = source("../src/components/Layout.tsx");
const geneHelp = source("../src/services/geneHelp.ts");
const service = source("../src/services/geneHelpNotificationService.ts");
const types = source("../src/types/notifications.ts");

test("GeneHelp notification service uses the authenticated RPC contract", () => {
  assert.match(service, /rpc\("list_my_genehelp_notifications",\s*\{\s*p_limit:/s);
  assert.match(service, /rpc\("mark_genehelp_notification_read",\s*\{\s*p_notification_id:/s);
  assert.match(service, /rpc\("mark_all_genehelp_notifications_read"\)/);
  assert.match(service, /runAuthenticatedSupabaseRequest/g);
  assert.match(service, /Math\.min\(100, Math\.max\(1, Math\.trunc\(limit\)\)\)/);
  assert.match(service, /lastIndexOf\("\."\)/);
  assert.match(service, /interaction_unread_message:\s*"reply_created"/);
  assert.match(service, /"genealogy_request\.status_changed":\s*"status_changed"/);
  assert.match(types, /"reply_created"\s*\|\s*"status_changed"/);
});

test("GeneHelp notification list triggers throttled provider sync without hiding the local inbox", () => {
  assert.match(geneHelp, /interface GeneHelpNotificationSyncSummary/);
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
    assert.match(geneHelp, new RegExp(`\\b${field}: (?:boolean|number);`));
  }
  assert.match(geneHelp, /invokeGeneHelp<GeneHelpNotificationSyncSummary>\("sync-notifications",\s*\{\}\)/);
  assert.match(service, /const GENEHELP_SYNC_INTERVAL_MS = 55 \* 1000/);
  assert.match(service, /geneHelpSyncStartedAtByUser = new Map<string, number>\(\)/);
  assert.match(service, /const syncUserId = expectedUserId\?\.trim\(\);\s*if \(syncUserId\)/s);
  assert.match(service, /geneHelpSyncStartedAtByUser\.set\(syncUserId, now\);\s*try \{\s*await syncGeneHelpNotifications\(\);\s*\} catch \{/s);
  assert.ok(
    service.indexOf("await syncGeneHelpNotifications()") < service.indexOf('client.rpc("list_my_genehelp_notifications"'),
    "provider sync must run before the local notification RPC",
  );
  assert.ok(
    service.indexOf('client.rpc("list_my_genehelp_notifications"') > service.indexOf("} catch {"),
    "the local notification RPC must still run after provider sync failure",
  );
  assert.match(service, /let syncWarning = false/);
  assert.match(service, /catch \{[\s\S]*?syncWarning = true/s);
  assert.match(service, /return \{ notifications, syncWarning \}/);
});

test("notification bell combines GeneHelp with announcements and task reminders", () => {
  assert.match(
    bell,
    /Promise\.allSettled\(\[\s*loadMyAnnouncements\(expectedUserId\),\s*loadMyGeneHelpNotifications\(50, expectedUserId\),\s*loadMyTaskNotifications\(50, expectedUserId\)/s,
  );
  assert.match(bell, /geneHelpNotifications\.filter\(\(item\) => !item\.isRead\)/);
  assert.match(bell, /markGeneHelpNotificationRead\(notification\.id, account\?\.id\)/);
  assert.match(bell, /markAllGeneHelpNotificationsRead\(account\?\.id\)/);
  assert.ok(
    bell.indexOf("geneHelpNotifications.map") < bell.indexOf("taskNotifications.map"),
    "GeneHelp notifications should appear before task reminders",
  );
  assert.match(bell, /GeneHelp · Нова відповідь/);
  assert.match(bell, /GeneHelp · Статус змінено/);
  assert.match(bell, /setGeneHelpNotifications\(geneHelpResult\.value\.notifications\)/);
  assert.match(
    bell,
    /geneHelpResult\.status === "fulfilled" &&\s*geneHelpResult\.value\.syncWarning/s,
  );
  assert.match(bell, /Не вдалося оновити сповіщення GeneHelp\. Показуємо раніше отримані дані\./);
});

test("GeneHelp notification links are derived locally and never trust webhook links", () => {
  assert.match(bell, /authenticatedGeneHelpViewUrl\(canonicalRequestUrl, undefined, requestId\)/);
  assert.match(bell, /\^\[a-z0-9_-\]\{4,64\}\$/i);
  assert.doesNotMatch(service, /\b(?:links|view_url|edit_url)\b/);
  assert.doesNotMatch(bell, /notification\.(?:links|viewUrl|editUrl)/);
  assert.match(bell, /window\.open\(targetUrl, "_blank", "noopener,noreferrer"\)/);
  assert.match(bell, /void markGeneHelpRead\(notification\)/);
  assert.doesNotMatch(bell, /markGeneHelpRead\(notification\)\.finally/);
  assert.doesNotMatch(bell, /window\.location\.assign\(targetUrl\)/);
});

test("existing refresh on open, focus and every minute remains intact", () => {
  assert.match(bell, /window\.setInterval\(\(\) => void refresh\(\), 60 \* 1000\)/);
  assert.match(bell, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(bell, /event\.currentTarget\.open\) void refresh\(\)/);
});

test("notification state is remounted when the signed-in account changes", () => {
  assert.match(
    layout,
    /<AnnouncementBell\s+key=\{props\.account\?\.id \?\? "anonymous"\}\s+account=\{props\.account\}/s,
  );
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
