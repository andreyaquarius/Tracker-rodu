import { useEffect, useMemo, useState } from "react";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails";
import type { SupabaseAccount } from "../services/supabaseAuth";
import {
  loadMyAnnouncements,
  markAnnouncementRead,
} from "../services/announcementService";
import type { AppAnnouncement } from "../types/announcements";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const unreadCount = useMemo(
    () => announcements.filter((item) => !item.isRead).length,
    [announcements],
  );

  const refresh = async () => {
    if (!account) return;
    setLoading(true);
    setError("");
    try {
      setAnnouncements(await loadMyAnnouncements());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити оновлення.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!account) {
      setAnnouncements([]);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5 * 60 * 1000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
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
      await markAnnouncementRead(announcement.id);
    } catch {
      void refresh();
    }
  };

  const markAllRead = async () => {
    const unread = announcements.filter((item) => !item.isRead);
    if (!unread.length) return;
    setAnnouncements((current) =>
      current.map((item) => ({ ...item, isRead: true, readAt: item.readAt ?? new Date().toISOString() })),
    );
    for (const announcement of unread) {
      try {
        await markAnnouncementRead(announcement.id);
      } catch {
        void refresh();
        return;
      }
    }
  };

  if (!account) return null;

  return (
    <details className="announcement-menu" ref={detailsRef}>
      <summary aria-label="Відкрити оновлення Трекера Роду" title="Оновлення">
        <BellIcon />
        {unreadCount ? <span className="announcement-badge">{unreadCount}</span> : null}
      </summary>
      <div className="announcement-popover">
        <div className="announcement-popover-header">
          <div>
            <span className="eyebrow">Оновлення</span>
            <strong>Що нового</strong>
          </div>
          <button type="button" className="text-button" onClick={() => void refresh()} disabled={loading}>
            Оновити
          </button>
        </div>
        {error ? <div className="alert alert-error compact-alert">{error}</div> : null}
        {announcements.length ? (
          <>
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
                    <small>{formatDate(announcement.publishedAt ?? announcement.createdAt)}</small>
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
            {loading ? "Завантажуємо оновлення..." : "Нових повідомлень немає."}
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

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
