import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails";
import type { SupabaseAccount } from "../services/supabaseAuth";
import { formatDateTimeForDisplay } from "../utils/dateHelpers";
import { notificationKey, notificationPath } from "../utils/notificationInbox.ts";
import { useNotificationInbox } from "./NotificationInboxProvider";
import "./notificationInbox.css";

export function AnnouncementBell({ account }: { account: SupabaseAccount | null }) {
  const detailsRef = useDismissibleDetails();
  const { pathname } = useLocation();
  const { items, unreadCount, loading, error, actionError, markingAll, refresh, markAllRead } = useNotificationInbox();
  const close = () => { if (detailsRef.current) detailsRef.current.open = false; };
  useEffect(close, [pathname]);
  if (!account) return null;

  return (
    <details className="announcement-menu" ref={detailsRef} onToggle={(event) => {
      if (event.currentTarget.open) void refresh();
    }}>
      <summary aria-label={`Відкрити сповіщення Трекера Роду${unreadCount ? `, непрочитаних: ${unreadCount}` : ""}`} title="Сповіщення">
        <BellIcon />
        {unreadCount ? <span className="announcement-badge">{unreadCount}</span> : null}
      </summary>
      <div className="announcement-popover">
        <div className="announcement-popover-header">
          <div><span className="eyebrow">Сповіщення</span><strong>Нагадування та оновлення</strong></div>
          <button type="button" className="text-button" onClick={() => void refresh()} disabled={loading}>Оновити</button>
        </div>
        <Link className="button button-secondary notification-inbox-link" to="/notifications" onClick={close}>Усі повідомлення</Link>
        {error || actionError ? <div className="alert alert-error compact-alert" role="status">{actionError || error}</div> : null}
        <div className="announcement-list">
          {items.map((item) => (
            <article className={`announcement-item ${item.isRead ? "" : "unread"}`} key={notificationKey(item)}>
              <Link className="notification-preview-link" to={notificationPath(item.kind, item.id)} onClick={close} aria-label={`Читати повідомлення: ${item.title}${item.isRead ? "" : " (нове)"}`}>
                <span>{item.category}{!item.isRead ? " · Нове" : ""}</span>
                <strong>{item.title}</strong>
                {item.body ? <p>{item.body}</p> : null}
                <small>{formatDateTimeForDisplay(item.date)}</small>
              </Link>
            </article>
          ))}
        </div>
        {!items.length ? <div className="empty-inline">{loading ? "Завантажуємо сповіщення..." : error ? "Спробуйте оновити список." : "Повідомлень поки немає."}</div> : null}
        {unreadCount ? <button type="button" className="button button-secondary announcement-read-all" disabled={markingAll} onClick={() => void markAllRead()}>
          Позначити все прочитаним
        </button> : null}
      </div>
    </details>
  );
}

function BellIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M18 8.5a6 6 0 0 0-12 0c0 7-2.5 7.5-2.5 7.5h17S18 15.5 18 8.5Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    <path d="M10 19a2.2 2.2 0 0 0 4 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
  </svg>;
}
