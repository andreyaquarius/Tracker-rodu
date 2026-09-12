import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { announcementInboxItem, taskInboxItem, geneHelpInboxItem, notificationKey, notificationPath, sortInboxNotifications, type InboxNotification } from "../src/utils/notificationInbox.ts";
import { parseAppRoute } from "../src/utils/appRoutes.ts";
import type { AppAnnouncement } from "../src/types/announcements.ts";
import { helpArticles } from "../src/help/helpArticles.ts";

const id = "10000000-0000-4000-8000-000000000001";
const date = "2026-09-12T12:00:00Z";
const announcement: AppAnnouncement = {
  id, title: "Оновлення", body: "Перший абзац.\n\n" + "Довге повідомлення. ".repeat(300),
  category: "update", mediaType: "video", mediaUrl: "https://example.org/video", ctaLabel: "Читати", ctaUrl: "https://example.org/news",
  isPublished: true, publishedAt: date, createdAt: date, updatedAt: date, isRead: false, readAt: null, emailStatus: "not_planned", emailRequestedAt: null,
};

test("notification routes work without a selected project and identify the notification source", () => {
  assert.deepEqual(parseAppRoute("/notifications"), { kind: "notifications" });
  for (const kind of ["announcement", "task", "genehelp"] as const) {
    assert.deepEqual(parseAppRoute(notificationPath(kind, id)), { kind: "notifications", notificationKind: kind, notificationId: id });
    assert.equal(parseAppRoute(`${notificationPath(kind, id)}?test=1#reader`).kind, "notifications");
  }
  for (const invalid of ["/notifications/admin/" + id, "/notifications/task/not-a-uuid", "/notifications/task/" + id + "/extra"]) {
    assert.deepEqual(parseAppRoute(invalid), { kind: "unknown" });
  }
});

test("announcement reader preserves the whole message, paragraphs, material and CTA", () => {
  const item = announcementInboxItem(announcement);
  assert.equal(item.body, announcement.body);
  assert.equal(item.category, "Оновлення");
  assert.equal(item.action?.url, announcement.ctaUrl);
  assert.equal(item.material?.label, "Переглянути відео");
  assert.equal(item.date, date);
  assert.equal(item.isRead, false);
});

test("reader rejects executable media and CTA URLs", () => {
  for (const value of ["javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,hello", "file:///secret", "blob:https://example.org/id"]) {
    const item = announcementInboxItem({ ...announcement, ctaUrl: value, mediaUrl: value });
    assert.equal(item.action, undefined);
    assert.equal(item.material, undefined);
  }
});

test("tasks include their full description, project, deadline and separate destination", () => {
  const item = taskInboxItem({ id, taskId: "task-1", projectId: "project-1", projectName: "Родина", taskTitle: "Знайти запис", taskDescription: announcement.body, taskDeadline: "2026-10-01", scheduledFor: date, createdAt: date, readAt: null, isRead: false });
  assert.equal(item.body, announcement.body);
  assert.equal(item.projectName, "Родина");
  assert.equal(item.deadline, "2026-10-01");
  assert.deepEqual(item.action, { url: "/projects/project-1/tasks", label: "Відкрити завдання проєкту", external: false });
});

test("GeneHelp links are canonical authenticated links, never supplied webhook URLs", () => {
  const base = { id, requestId: "req-1234", eventType: "reply_created" as const, title: "Відповідь", body: "Текст відповіді", occurredAt: date, createdAt: date, readAt: null, isRead: false };
  assert.equal(geneHelpInboxItem(base).action?.url, "https://genehelp.online/uk/my/requests?request=req-1234");
  assert.equal(geneHelpInboxItem({ ...base, requestId: "../admin" }).action, undefined);
  assert.equal(geneHelpInboxItem({ ...base, eventType: "status_changed" }).category, "GeneHelp · Статус змінено");
});

test("same UUID from different sources stays separate; sorting is stable and non-mutating", () => {
  const a = announcementInboxItem(announcement);
  const b: InboxNotification = { ...a, kind: "task", date: "2026-09-13T12:00:00Z" };
  const c: InboxNotification = { ...a, kind: "genehelp", date: "invalid" };
  assert.notEqual(notificationKey(a), notificationKey(b));
  const items = [a, b, c];
  assert.deepEqual(sortInboxNotifications(items), [b, a, c]);
  assert.deepEqual(items, [a, b, c]);
});

test("one account-keyed provider serves both the bell and private reader without project queries", () => {
  const app = source("../src/App.tsx");
  const provider = source("../src/components/NotificationInboxProvider.tsx");
  const bell = source("../src/components/AnnouncementBell.tsx");
  const page = source("../src/pages/NotificationsPage.tsx");
  assert.match(app, /const skipsWorkspaceState[\s\S]*?route.kind === "notifications"/);
  assert.match(app, /<NotificationInboxProvider accountId=\{account.id\}>[\s\S]*?<Layout/);
  assert.match(app, /<NotificationsPage notificationKind=\{route.notificationKind\} notificationId=\{route.notificationId\}/);
  assert.match(provider, /<AccountInbox key=\{props.accountId\}/);
  assert.match(provider, /generation.current !== currentGeneration/);
  assert.match(provider, /if \(refreshFlight.current\) return refreshFlight.current/);
  assert.match(provider, /confirmedReads.current.add\(key\)/);
  assert.doesNotMatch(bell, /markRead\(|window.location.assign|window.open/);
  assert.match(bell, /onClick=\{close\}/);
  assert.match(page, /<div className="notification-full-text">\{item.body/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.match(page, /const PAGE_SIZE = 20/);
  assert.match(page, /Повторити позначення/);
});

test("deep links reload only authorized published/owned messages and preserve the GeneHelp boundary", () => {
  const announcements = source("../src/services/announcementService.ts");
  const tasks = source("../src/services/taskNotificationService.ts");
  const service = source("../src/services/notificationInboxService.ts");
  assert.match(announcements, /rpc\("list_my_app_announcements"\).eq\("id", id\).maybeSingle\(\)/);
  assert.match(tasks, /from\("task_notifications"\).select\(TASK_NOTIFICATION_SELECT\).eq\("id", id\).maybeSingle\(\)/);
  assert.match(service, /loadMyGeneHelpNotifications\(100, userId\)/);
  assert.doesNotMatch(service, /from\("user_genehelp_notifications"\)/);
  assert.match(service, /new PartialInboxError/);
});

test("notifications have a concise help guide and administration stays excluded", () => {
  assert.ok(helpArticles.some((article) => article.key === "notifications"));
  assert.ok(helpArticles.every((article) => !article.key.startsWith("admin")));
});

function source(path: string) { return readFileSync(new URL(path, import.meta.url), "utf8"); }
