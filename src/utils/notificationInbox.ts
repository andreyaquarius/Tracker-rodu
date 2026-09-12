import type { AppAnnouncement } from "../types/announcements.ts";
import type { GeneHelpNotification, TaskReminderNotification } from "../types/notifications.ts";
import { authenticatedGeneHelpViewUrl } from "./geneHelpLinks.ts";
import { sanitizeWebUrl } from "./safeUrl.ts";

export type NotificationKind = "announcement" | "task" | "genehelp";
export interface InboxNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  category: string;
  date: string;
  isRead: boolean;
  projectName?: string;
  deadline?: string;
  action?: { url: string; label: string; external: boolean };
  material?: { url: string; label: string };
}

export function notificationKey(item: Pick<InboxNotification, "kind" | "id">): string {
  return `${item.kind}:${item.id}`;
}

export function notificationPath(kind: NotificationKind, id: string): string {
  return `/notifications/${kind}/${encodeURIComponent(id)}`;
}

export function isNotificationKind(value: string): value is NotificationKind {
  return value === "announcement" || value === "task" || value === "genehelp";
}

export function isNotificationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const categories: Record<AppAnnouncement["category"], string> = {
  update: "Оновлення", feature: "Нова функція", maintenance: "Технічне", tip: "Порада",
};

export function announcementInboxItem(item: AppAnnouncement): InboxNotification {
  const actionUrl = sanitizeWebUrl(item.ctaUrl);
  const materialUrl = sanitizeWebUrl(item.mediaUrl);
  return {
    id: item.id, kind: "announcement", title: item.title, body: item.body,
    category: categories[item.category] ?? "Оголошення",
    date: item.publishedAt ?? item.createdAt, isRead: item.isRead,
    ...(actionUrl ? { action: { url: actionUrl, label: item.ctaLabel || "Детальніше", external: true } } : {}),
    ...(materialUrl ? { material: { url: materialUrl, label: item.mediaType === "video" ? "Переглянути відео" : "Відкрити матеріал" } } : {}),
  };
}

export function taskInboxItem(item: TaskReminderNotification): InboxNotification {
  return {
    id: item.id, kind: "task", title: item.taskTitle, body: item.taskDescription,
    category: "Нагадування про завдання", date: item.scheduledFor || item.createdAt,
    isRead: item.isRead, projectName: item.projectName, deadline: item.taskDeadline,
    action: { url: `/projects/${encodeURIComponent(item.projectId)}/tasks`, label: "Відкрити завдання проєкту", external: false },
  };
}

export function geneHelpInboxItem(item: GeneHelpNotification): InboxNotification {
  const requestId = item.requestId.trim();
  const canonicalRequestUrl = `https://genehelp.online/requests/${encodeURIComponent(requestId)}`;
  const url = /^[a-z0-9_-]{4,64}$/i.test(requestId)
    ? authenticatedGeneHelpViewUrl(canonicalRequestUrl, undefined, requestId) : null;
  return {
    id: item.id, kind: "genehelp", title: item.title || "Запит GeneHelp", body: item.body,
    category: item.eventType === "reply_created" ? "GeneHelp · Нова відповідь" : "GeneHelp · Статус змінено",
    date: item.occurredAt || item.createdAt, isRead: item.isRead,
    ...(url ? { action: { url, label: "Відкрити запит у GeneHelp", external: true } } : {}),
  };
}

export function sortInboxNotifications(items: InboxNotification[]): InboxNotification[] {
  const timestamp = (date: string) => Date.parse(date) || 0;
  return [...items].sort((a, b) => timestamp(b.date) - timestamp(a.date) || notificationKey(a).localeCompare(notificationKey(b)));
}
