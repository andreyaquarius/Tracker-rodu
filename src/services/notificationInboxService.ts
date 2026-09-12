import { loadMyAnnouncements, loadMyAnnouncement, markAnnouncementRead } from "./announcementService";
import { loadMyGeneHelpNotifications, markGeneHelpNotificationRead, markAllGeneHelpNotificationsRead } from "./geneHelpNotificationService";
import { loadMyTaskNotifications, loadMyTaskNotification, markTaskNotificationRead, markAllTaskNotificationsRead } from "./taskNotificationService";
import { announcementInboxItem, geneHelpInboxItem, taskInboxItem, type InboxNotification, type NotificationKind } from "../utils/notificationInbox.ts";

export interface InboxLoadResult { items: InboxNotification[]; warning: string }
export interface NotificationInboxService {
  load(userId: string): Promise<InboxLoadResult>;
  loadOne(kind: NotificationKind, id: string, userId: string): Promise<InboxNotification | null>;
  markRead(item: InboxNotification, userId: string): Promise<void>;
  markAll(items: InboxNotification[], userId: string): Promise<void>;
}

export const notificationInboxService: NotificationInboxService = {
  async load(expectedUserId) {
    const [announcementResult, geneHelpResult, taskResult] = await Promise.allSettled([
      loadMyAnnouncements(expectedUserId),
      loadMyGeneHelpNotifications(50, expectedUserId),
      loadMyTaskNotifications(50, expectedUserId),
    ]);
    const results = [announcementResult, geneHelpResult, taskResult];
    if (results.every((result) => result.status === "rejected")) {
      throw new Error("Не вдалося завантажити сповіщення. Спробуйте ще раз.");
    }
    // A failed source is not an empty inbox. Keep its existing messages in the provider.
    if (results.some((result) => result.status === "rejected")) {
      throw new PartialInboxError([
        ...(geneHelpResult.status === "fulfilled" ? geneHelpResult.value.notifications.map(geneHelpInboxItem) : []),
        ...(taskResult.status === "fulfilled" ? taskResult.value.map(taskInboxItem) : []),
        ...(announcementResult.status === "fulfilled" ? announcementResult.value.map(announcementInboxItem) : []),
      ], [
        ...(geneHelpResult.status === "fulfilled" ? ["genehelp" as const] : []),
        ...(taskResult.status === "fulfilled" ? ["task" as const] : []),
        ...(announcementResult.status === "fulfilled" ? ["announcement" as const] : []),
      ]);
    }
    const geneHelpSyncWarning = geneHelpResult.status === "fulfilled" && geneHelpResult.value.syncWarning;
    return {
      items: [
        ...(geneHelpResult.status === "fulfilled" ? geneHelpResult.value.notifications.map(geneHelpInboxItem) : []),
        ...(taskResult.status === "fulfilled" ? taskResult.value.map(taskInboxItem) : []),
        ...(announcementResult.status === "fulfilled" ? announcementResult.value.map(announcementInboxItem) : []),
      ],
      warning: geneHelpSyncWarning ? "Не вдалося оновити сповіщення GeneHelp. Показуємо раніше отримані дані." : "",
    };
  },
  async loadOne(kind, id, userId) {
    if (kind === "announcement") {
      const item = await loadMyAnnouncement(id, userId);
      return item ? announcementInboxItem(item) : null;
    }
    if (kind === "task") {
      const item = await loadMyTaskNotification(id, userId);
      return item ? taskInboxItem(item) : null;
    }
    // The existing private GeneHelp RPC exposes only the most recent 100 messages.
    // Do not bypass its permissions with a direct table query.
    const result = await loadMyGeneHelpNotifications(100, userId);
    const item = result.notifications.find((notification) => notification.id === id);
    return item ? geneHelpInboxItem(item) : null;
  },
  async markRead(item, userId) {
    if (item.kind === "announcement") await markAnnouncementRead(item.id, userId);
    else if (item.kind === "task") await markTaskNotificationRead(item.id, userId);
    else await markGeneHelpNotificationRead(item.id, userId);
  },
  async markAll(items, userId) {
    const unread = items.filter((item) => !item.isRead);
    const results = await Promise.allSettled([
      ...unread.filter((item) => item.kind === "announcement").map((item) => markAnnouncementRead(item.id, userId)),
      ...(unread.some((item) => item.kind === "genehelp") ? [markAllGeneHelpNotificationsRead(userId)] : []),
      ...(unread.some((item) => item.kind === "task") ? [markAllTaskNotificationsRead(userId)] : []),
    ]);
    if (results.some((result) => result.status === "rejected")) throw new Error("Не всі повідомлення вдалося позначити прочитаними. Спробуйте ще раз.");
  },
};

export class PartialInboxError extends Error {
  readonly items: InboxNotification[];
  readonly loadedKinds: NotificationKind[];
  constructor(items: InboxNotification[], loadedKinds: NotificationKind[]) {
    super("Частину сповіщень тимчасово не вдалося завантажити.");
    this.items = items;
    this.loadedKinds = loadedKinds;
  }
}
