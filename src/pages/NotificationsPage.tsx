import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useNotificationInbox } from "../components/NotificationInboxProvider";
import { formatDateForDisplay, formatDateTimeForDisplay } from "../utils/dateHelpers";
import { notificationKey, notificationPath, sortInboxNotifications, type InboxNotification, type NotificationKind } from "../utils/notificationInbox.ts";
import "../components/notificationInbox.css";

const PAGE_SIZE = 20;

export function NotificationsPage({ notificationKind, notificationId }: { notificationKind?: NotificationKind; notificationId?: string }) {
  return <section className="notification-center">
    {notificationKind && notificationId
      ? <NotificationReader key={`${notificationKind}:${notificationId}`} kind={notificationKind} id={notificationId} />
      : <NotificationList />}
  </section>;
}

function NotificationList() {
  const inbox = useNotificationInbox();
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") === "unread" ? "unread" : "all";
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const items = useMemo(() => sortInboxNotifications(inbox.items)
    .filter((item) => filter === "all" || !item.isRead), [filter, inbox.items]);
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const requestedPage = Number(params.get("page"));
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const setPage = (next: number) => { setParams({ ...(filter === "unread" ? { filter } : {}), page: String(next) }); heading.current?.focus(); };

  return <>
    <header className="notification-page-header">
      <div><span className="eyebrow">Особистий простір</span><h1 ref={heading} tabIndex={-1}>Повідомлення</h1>
        <p>Оголошення, нагадування про завдання та відповіді GeneHelp. Відкрийте повідомлення, щоб прочитати його повністю.</p></div>
      <button type="button" className="button button-secondary" disabled={inbox.loading} onClick={() => void inbox.refresh()}>Оновити</button>
    </header>
    <div className="notification-toolbar">
      <div className="notification-filters" aria-label="Фільтр повідомлень">
        <button type="button" className="button button-secondary" aria-pressed={filter === "all"} onClick={() => setParams({})}>Усі ({inbox.items.length})</button>
        <button type="button" className="button button-secondary" aria-pressed={filter === "unread"} onClick={() => setParams({ filter: "unread" })}>Непрочитані ({inbox.unreadCount})</button>
      </div>
      {inbox.unreadCount ? <button type="button" className="text-button" disabled={inbox.markingAll} onClick={() => void inbox.markAllRead()}>Позначити все прочитаним</button> : null}
    </div>
    {inbox.error || inbox.actionError ? <div className="alert alert-error" role="status">{inbox.actionError || inbox.error}</div> : null}
    <div className="notification-page-list" aria-busy={inbox.loading}>
      {items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((item) => <article className={`notification-card ${item.isRead ? "" : "unread"}`} key={notificationKey(item)}>
        <Link to={notificationPath(item.kind, item.id)} state={{ inboxSearch: params.toString() }} aria-label={`Читати повідомлення: ${item.title}${item.isRead ? "" : " (нове)"}`}>
          <div className="notification-meta"><span>{item.category}</span><span>{item.isRead ? "Прочитано" : "Нове"}</span></div>
          <h2>{item.title}</h2>
          {item.body ? <p className="notification-excerpt">{item.body}</p> : null}
          {item.projectName ? <p className="notification-project">Проєкт: {item.projectName}</p> : null}
          <div className="notification-meta"><time dateTime={item.date}>{formatDateTimeForDisplay(item.date)}</time><span>Читати повністю →</span></div>
        </Link>
      </article>)}
      {!items.length ? <div className="panel empty-inline" role="status">{!inbox.loaded ? "Завантажуємо повідомлення..." : inbox.error ? "Список тимчасово недоступний. Натисніть «Оновити»." : filter === "unread" ? "Усі повідомлення прочитані." : "Повідомлень поки немає."}</div> : null}
    </div>
    {pageCount > 1 ? <nav className="notification-pagination" aria-label="Сторінки повідомлень">
      <button type="button" className="button button-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Назад</button>
      <span aria-live="polite">{page} з {pageCount}</span>
      <button type="button" className="button button-secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Далі →</button>
    </nav> : null}
    <p className="notification-list-note">Тут показано доступні оголошення та останні 50 сповіщень кожного типу: завдання й GeneHelp.</p>
  </>;
}

function NotificationReader({ kind, id }: { kind: NotificationKind; id: string }) {
  const location = useLocation();
  const returnSearch = typeof location.state?.inboxSearch === "string" ? location.state.inboxSearch : "";
  const { items, loaded, loadOne, markRead } = useNotificationInbox();
  const cached = items.find((item) => item.kind === kind && item.id === id);
  const [item, setItem] = useState<InboxNotification | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [readState, setReadState] = useState<"idle" | "saving" | "failed">("idle");
  const attemptedRead = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    if (cached) { setItem(cached); setLoading(false); setError(""); return; }
    if (!loaded) return;
    setLoading(true);
    setError("");
    void loadOne(kind, id).then((result) => {
      if (active) setItem(result);
    }).catch(() => {
      if (active) setError("Не вдалося відкрити повідомлення. Перевірте з’єднання та спробуйте ще раз.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cached, id, kind, loadOne, loaded, retry]);

  useEffect(() => {
    if (!loading) heading.current?.focus();
  }, [loading]);

  useEffect(() => {
    if (!item || item.isRead || attemptedRead.current) return;
    attemptedRead.current = true;
    setReadState("saving");
    void markRead(item).then((success) => {
      setReadState(success ? "idle" : "failed");
      if (success) setItem((current) => current ? { ...current, isRead: true } : current);
    });
  }, [item, markRead]);

  const retryMarkRead = async () => {
    if (!item) return;
    setReadState("saving");
    const success = await markRead(item);
    setReadState(success ? "idle" : "failed");
    if (success) setItem({ ...item, isRead: true });
  };

  return <>
    <Link className="notification-back" to={`/notifications${returnSearch ? `?${returnSearch}` : ""}`}>← Усі повідомлення</Link>
    {loading ? <div className="panel" role="status">Завантажуємо повідомлення...</div> : !item || error ? <div className="panel">
      <h1 ref={heading} tabIndex={-1}>{error ? "Не вдалося відкрити повідомлення" : "Повідомлення недоступне"}</h1>
      <p>{error || (kind === "genehelp" ? "Його видалено, воно належить іншому акаунту або вже поза списком останніх 100 сповіщень GeneHelp." : "Повідомлення видалено, знято з публікації або воно недоступне для вашого акаунту.")}</p>
      <button type="button" className="button button-secondary" onClick={() => setRetry((value) => value + 1)}>Спробувати ще раз</button>
    </div> : <article className="notification-reader" aria-labelledby="notification-title">
      <header>
        <div className="notification-meta"><span>{item.category}</span><time dateTime={item.date}>{formatDateTimeForDisplay(item.date)}</time></div>
        <h1 id="notification-title" ref={heading} tabIndex={-1}>{item.title}</h1>
        <p className="notification-read-status" role="status">{readState === "saving" ? "Позначаємо прочитаним..." : item.isRead ? "Прочитано" : "Непрочитане"}</p>
      </header>
      {readState === "failed" ? <div className="alert alert-error" role="alert">
        Не вдалося зберегти позначку прочитаного. Повідомлення можна читати.
        <button type="button" className="text-button" onClick={() => void retryMarkRead()}>Повторити позначення</button>
      </div> : null}
      {item.projectName || item.deadline ? <dl className="notification-task-details">
        {item.projectName ? <div><dt>Проєкт</dt><dd>{item.projectName}</dd></div> : null}
        {item.deadline ? <div><dt>Строк виконання</dt><dd>{formatDateForDisplay(item.deadline)}</dd></div> : null}
      </dl> : null}
      <div className="notification-full-text">{item.body || "Це повідомлення не містить додаткового тексту."}</div>
      {item.material || item.action ? <footer className="notification-actions">
        {item.material ? <a className="button button-secondary" href={item.material.url} target="_blank" rel="noopener noreferrer">{item.material.label} ↗</a> : null}
        {item.action ? item.action.external
          ? <a className="button button-primary" href={item.action.url} target="_blank" rel="noopener noreferrer">{item.action.label} ↗</a>
          : <Link className="button button-primary" to={item.action.url}>{item.action.label}</Link> : null}
      </footer> : null}
    </article>}
  </>;
}
