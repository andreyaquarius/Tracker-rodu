import { useEffect, useMemo, useRef, useState } from "react";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails";
import type { SupabaseAccount } from "../services/supabaseAuth";
import {
  loadMyAnnouncements,
  markAnnouncementRead,
} from "../services/announcementService";
import type { AppAnnouncement } from "../types/announcements";
import {
  loadMyGeneHelpNotifications,
  markAllGeneHelpNotificationsRead,
  markGeneHelpNotificationRead,
} from "../services/geneHelpNotificationService";
import {
  loadMyTaskNotifications,
  markAllTaskNotificationsRead,
  markTaskNotificationRead,
} from "../services/taskNotificationService";
import type {
  GeneHelpNotification,
  TaskReminderNotification,
} from "../types/notifications";
import { formatDateForDisplay, formatDateTimeForDisplay } from "../utils/dateHelpers";
import { authenticatedGeneHelpViewUrl } from "../utils/geneHelpLinks";

interface AnnouncementBellProps {
  account: SupabaseAccount | null;
}

const categoryLabels: Record<AppAnnouncement["category"], string> = {
  update: "Оновлення",
  feature: "Нова функція",
  maintenance: "Технічне",
  tip: "Порада",
};

export function AnnouncementBell({ account }: AnnouncementBellProps) {
  const detailsRef = useDismissibleDetails();
  const [announcements, setAnnouncements] = useState<AppAnnouncement[]>([]);
  const [geneHelpNotifications, setGeneHelpNotifications] = useState<GeneHelpNotification[]>([]);
  const [taskNotifications, setTaskNotifications] = useState<TaskReminderNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const refreshGenerationRef = useRef(0);

  const unreadCount = useMemo(
    () =>
      announcements.filter((item) => !item.isRead).length +
      geneHelpNotifications.filter((item) => !item.isRead).length +
      taskNotifications.filter((item) => !item.isRead).length,
    [announcements, geneHelpNotifications, taskNotifications],
  );

  const refresh = async () => {
    const expectedUserId = account?.id;
    const generation = ++refreshGenerationRef.current;
    const isCurrent = () => refreshGenerationRef.current === generation;
    if (!expectedUserId) return;
    setLoading(true);
    setError("");
    try {
      const [announcementResult, geneHelpResult, taskResult] = await Promise.allSettled([
        loadMyAnnouncements(expectedUserId),
        loadMyGeneHelpNotifications(50, expectedUserId),
        loadMyTaskNotifications(50, expectedUserId),
      ]);
      if (!isCurrent()) return;
      if (announcementResult.status === "fulfilled") {
        setAnnouncements(announcementResult.value);
      }
      if (geneHelpResult.status === "fulfilled") {
        setGeneHelpNotifications(geneHelpResult.value.notifications);
      }
      if (taskResult.status === "fulfilled") {
        setTaskNotifications(taskResult.value);
      }
      const results = [announcementResult, geneHelpResult, taskResult];
      if (results.every((result) => result.status === "rejected")) {
        const firstFailure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        throw firstFailure?.reason;
      }
      const geneHelpSyncWarning = geneHelpResult.status === "fulfilled" &&
        geneHelpResult.value.syncWarning;
      if (geneHelpSyncWarning) {
        setError("Не вдалося оновити сповіщення GeneHelp. Показуємо раніше отримані дані.");
      } else if (results.some((result) => result.status === "rejected")) {
        setError("Частину сповіщень тимчасово не вдалося завантажити.");
      }
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити сповіщення.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  useEffect(() => {
    refreshGenerationRef.current += 1;
    if (!account) {
      setAnnouncements([]);
      setGeneHelpNotifications([]);
      setTaskNotifications([]);
      setError("");
      setLoading(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60 * 1000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      refreshGenerationRef.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [account?.id]);

  const markRead = async (announcement: AppAnnouncement) => {
    if (announcement.isRead) return;
    setAnnouncements((current) =>
      current.map((item) =>
        item.id === announcement.id
          ? { ...item, isRead: true, readAt: new Date().toISOString() }
          : item,
      ),
    );
    try {
      await markAnnouncementRead(announcement.id, account?.id);
    } catch {
      void refresh();
    }
  };

  const markTaskRead = async (notification: TaskReminderNotification) => {
    if (notification.isRead) return;
    setTaskNotifications((current) =>
      current.map((item) =>
        item.id === notification.id
          ? { ...item, isRead: true, readAt: new Date().toISOString() }
          : item,
      ),
    );
    try {
      await markTaskNotificationRead(notification.id, account?.id);
    } catch {
      void refresh();
    }
  };

  const markGeneHelpRead = async (notification: GeneHelpNotification) => {
    if (notification.isRead) return;
    setGeneHelpNotifications((current) =>
      current.map((item) =>
        item.id === notification.id
          ? { ...item, isRead: true, readAt: new Date().toISOString() }
          : item,
      ),
    );
    try {
      await markGeneHelpNotificationRead(notification.id, account?.id);
    } catch {
      void refresh();
    }
  };

  const openGeneHelpNotification = (notification: GeneHelpNotification) => {
    const targetUrl = geneHelpNotificationUrl(notification);
    if (targetUrl) window.open(targetUrl, "_blank", "noopener,noreferrer");
    void markGeneHelpRead(notification);
  };

  const markAllRead = async () => {
    const unread = announcements.filter((item) => !item.isRead);
    const unreadGeneHelp = geneHelpNotifications.filter((item) => !item.isRead);
    const unreadTasks = taskNotifications.filter((item) => !item.isRead);
    if (!unread.length && !unreadGeneHelp.length && !unreadTasks.length) return;
    setAnnouncements((current) =>
      current.map((item) => ({ ...item, isRead: true, readAt: item.readAt ?? new Date().toISOString() })),
    );
    setTaskNotifications((current) =>
      current.map((item) => ({
        ...item,
        isRead: true,
        readAt: item.readAt ?? new Date().toISOString(),
      })),
    );
    setGeneHelpNotifications((current) =>
      current.map((item) => ({
        ...item,
        isRead: true,
        readAt: item.readAt ?? new Date().toISOString(),
      })),
    );
    try {
      await Promise.all([
        ...unread.map((announcement) => markAnnouncementRead(announcement.id, account?.id)),
        ...(unreadGeneHelp.length ? [markAllGeneHelpNotificationsRead(account?.id)] : []),
        ...(unreadTasks.length ? [markAllTaskNotificationsRead(account?.id)] : []),
      ]);
    } catch {
      void refresh();
    }
  };

  if (!account) return null;

  return (
    <details
      className="announcement-menu"
      ref={detailsRef}
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh();
      }}
    >
      <summary aria-label="Відкрити сповіщення Трекера Роду" title="Сповіщення">
        <BellIcon />
        {unreadCount ? <span className="announcement-badge">{unreadCount}</span> : null}
      </summary>
      <div className="announcement-popover">
        <div className="announcement-popover-header">
          <div>
            <span className="eyebrow">Сповіщення</span>
            <strong>Нагадування та оновлення</strong>
          </div>
          <button type="button" className="text-button" onClick={() => void refresh()} disabled={loading}>
            Оновити
          </button>
        </div>
        {error ? <div className="alert alert-error compact-alert">{error}</div> : null}
        {geneHelpNotifications.length || taskNotifications.length || announcements.length ? (
          <>
            {geneHelpNotifications.length ? (
              <div className="announcement-list genehelp-notification-list">
                {geneHelpNotifications.map((notification) => (
                  <article
                    className={`announcement-item genehelp-notification-item ${notification.isRead ? "" : "unread"}`}
                    key={notification.id}
                  >
                    <button type="button" onClick={() => openGeneHelpNotification(notification)}>
                      <span>{geneHelpNotificationLabel(notification)}</span>
                      <strong>{notification.title || "Запит GeneHelp"}</strong>
                      {notification.body ? <p>{notification.body}</p> : null}
                      <small>{formatDateTimeForDisplay(notification.occurredAt || notification.createdAt)}</small>
                    </button>
                  </article>
                ))}
              </div>
            ) : null}
            {taskNotifications.length ? (
              <div className="announcement-list task-notification-list">
                {taskNotifications.map((notification) => (
                  <article
                    className={`announcement-item task-notification-item ${notification.isRead ? "" : "unread"}`}
                    key={notification.id}
                  >
                    <button
                      type="button"
                      onClick={() => void markTaskRead(notification).finally(() => {
                        window.location.assign(taskNotificationUrl(notification));
                      })}
                    >
                      <span>Нагадування про завдання</span>
                      <strong>{notification.taskTitle}</strong>
                      <p>
                        Проєкт: {notification.projectName}
                        {notification.taskDeadline ? (
                          <>
                            <br />
                            Строк виконання: {formatDateForDisplay(notification.taskDeadline)}
                          </>
                        ) : null}
                      </p>
                      <small>{formatDateTimeForDisplay(notification.scheduledFor)}</small>
                    </button>
                  </article>
                ))}
              </div>
            ) : null}
            <div className="announcement-list">
              {announcements.map((announcement) => (
                <article
                  className={`announcement-item ${announcement.isRead ? "" : "unread"}`}
                  key={announcement.id}
                >
                  <button type="button" onClick={() => void markRead(announcement)}>
                    <span>{categoryLabels[announcement.category]}</span>
                    <strong>{announcement.title}</strong>
                    <p>{announcement.body}</p>
                    <small>{formatDateTimeForDisplay(announcement.publishedAt ?? announcement.createdAt)}</small>
                  </button>
                  {announcement.mediaUrl ? (
                    <a href={announcement.mediaUrl} target="_blank" rel="noreferrer">
                      {announcement.mediaType === "video" ? "Переглянути відео" : "Відкрити матеріал"}
                    </a>
                  ) : null}
                  {announcement.ctaUrl ? (
                    <a href={announcement.ctaUrl} target="_blank" rel="noreferrer">
                      {announcement.ctaLabel || "Детальніше"}
                    </a>
                  ) : null}
                </article>
              ))}
            </div>
            {unreadCount ? (
              <button type="button" className="button button-secondary announcement-read-all" onClick={() => void markAllRead()}>
                Позначити все прочитаним
              </button>
            ) : null}
          </>
        ) : (
          <div className="empty-inline">
            {loading ? "Завантажуємо сповіщення..." : "Нових повідомлень немає."}
          </div>
        )}
      </div>
    </details>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M18 8.5a6 6 0 0 0-12 0c0 7-2.5 7.5-2.5 7.5h17S18 15.5 18 8.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M10 19a2.2 2.2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function taskNotificationUrl(notification: TaskReminderNotification): string {
  return `/projects/${encodeURIComponent(notification.projectId)}/tasks`;
}

function geneHelpNotificationLabel(notification: GeneHelpNotification): string {
  return notification.eventType === "reply_created"
    ? "GeneHelp · Нова відповідь"
    : "GeneHelp · Статус змінено";
}

function geneHelpNotificationUrl(notification: GeneHelpNotification): string | null {
  const requestId = notification.requestId.trim();
  if (!/^[a-z0-9_-]{4,64}$/i.test(requestId)) return null;
  const canonicalRequestUrl = `https://genehelp.online/requests/${encodeURIComponent(requestId)}`;
  return authenticatedGeneHelpViewUrl(canonicalRequestUrl, undefined, requestId);
}
