import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createFeedbackThread,
  loadFeedbackMessages,
  loadFeedbackThreads,
  markFeedbackThreadRead,
  notifyFeedbackInboxChanged,
  postFeedbackMessage,
  setFeedbackThreadStatus,
} from "../services/feedbackService";
import type { SupabaseAccount } from "../services/supabaseAuth";
import type {
  FeedbackCategory,
  FeedbackMessage,
  FeedbackStatus,
  FeedbackThread,
} from "../types/feedback";
import { formatDateTimeForDisplay } from "../utils/dateHelpers";
import {
  trackProductAnalyticsAction,
  trackProductAnalyticsOperation,
} from "../services/productAnalytics.ts";

interface FeedbackPageProps {
  account: SupabaseAccount;
  isAdmin: boolean;
  startComposer?: boolean;
}

const categoryLabels: Record<FeedbackCategory, string> = {
  question: "Питання",
  suggestion: "Побажання",
  problem: "Повідомлення про проблему",
  other: "Інше",
};

const statusLabels: Record<FeedbackStatus, string> = {
  open: "Очікує відповіді",
  answered: "Є відповідь",
  closed: "Завершено",
};

type AdminFilter = "all" | "unread" | FeedbackStatus;

export function FeedbackPage({ account, isAdmin, startComposer = false }: FeedbackPageProps) {
  const [threads, setThreads] = useState<FeedbackThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [messages, setMessages] = useState<FeedbackMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reply, setReply] = useState("");
  const [showComposer, setShowComposer] = useState(() => !isAdmin && startComposer);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("question");
  const [body, setBody] = useState("");
  const [adminFilter, setAdminFilter] = useState<AdminFilter>("all");
  const [search, setSearch] = useState("");
  const selectionGeneration = useRef(0);

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const visibleThreads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return threads.filter((thread) => {
      if (isAdmin && adminFilter === "unread" && !thread.unread) return false;
      if (isAdmin && adminFilter !== "all" && adminFilter !== "unread" && thread.status !== adminFilter) {
        return false;
      }
      if (!query) return true;
      return [thread.subject, thread.authorName, thread.authorEmail, categoryLabels[thread.category]]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [adminFilter, isAdmin, search, threads]);

  const refreshThreads = async (preferredThreadId?: string) => {
    setLoading(true);
    setError("");
    try {
      const nextThreads = await loadFeedbackThreads(account.id);
      setThreads(nextThreads);
      setSelectedThreadId((current) => {
        const preferred = preferredThreadId || current;
        return nextThreads.some((thread) => thread.id === preferred)
          ? preferred
          : nextThreads[0]?.id ?? "";
      });
      notifyFeedbackInboxChanged();
    } catch (loadError) {
      setError(feedbackErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshThreads();
  }, [account.id, isAdmin]);

  useEffect(() => {
    if (!isAdmin && startComposer) setShowComposer(true);
  }, [isAdmin, startComposer]);

  useEffect(() => {
    const generation = ++selectionGeneration.current;
    if (!selectedThreadId) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }
    setMessagesLoading(true);
    setError("");
    void Promise.all([
      loadFeedbackMessages(selectedThreadId, account.id),
      markFeedbackThreadRead(selectedThreadId, account.id),
    ]).then(([nextMessages]) => {
      if (selectionGeneration.current !== generation) return;
      setMessages(nextMessages);
      setThreads((current) => current.map((thread) => (
        thread.id === selectedThreadId ? { ...thread, unread: false } : thread
      )));
      notifyFeedbackInboxChanged();
    }).catch((loadError) => {
      if (selectionGeneration.current === generation) setError(feedbackErrorMessage(loadError));
    }).finally(() => {
      if (selectionGeneration.current === generation) setMessagesLoading(false);
    });
  }, [account.id, selectedThreadId]);

  const submitThread = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedSubject = subject.trim();
    const normalizedBody = body.trim();
    if (normalizedSubject.length < 3 || normalizedBody.length < 1) {
      setError("Вкажіть тему щонайменше з 3 символів і напишіть повідомлення.");
      return;
    }
    const analyticsStartedAt = Date.now();
    trackProductAnalyticsAction("feedback_create");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const threadId = await createFeedbackThread({
        subject: normalizedSubject,
        category,
        body: normalizedBody,
      }, account.id);
      setSubject("");
      setCategory("question");
      setBody("");
      setShowComposer(false);
      setNotice("Звернення надіслано. Відповідь з’явиться в цій приватній скриньці.");
      await refreshThreads(threadId);
      trackProductAnalyticsOperation("feedback_create", "success", Date.now() - analyticsStartedAt, 1);
    } catch (submitError) {
      trackProductAnalyticsOperation("feedback_create", "failure", Date.now() - analyticsStartedAt, 1);
      setError(feedbackErrorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const submitReply = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedReply = reply.trim();
    if (!selectedThread || !normalizedReply) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await postFeedbackMessage(selectedThread.id, normalizedReply, account.id);
      setReply("");
      setNotice(isAdmin ? "Відповідь надіслано користувачу." : "Повідомлення додано до звернення.");
      const nextMessages = await loadFeedbackMessages(selectedThread.id, account.id);
      setMessages(nextMessages);
      await refreshThreads(selectedThread.id);
    } catch (submitError) {
      setError(feedbackErrorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const toggleClosed = async () => {
    if (!selectedThread) return;
    setBusy(true);
    setError("");
    try {
      await setFeedbackThreadStatus(
        selectedThread.id,
        selectedThread.status === "closed" ? "open" : "closed",
        account.id,
      );
      await refreshThreads(selectedThread.id);
    } catch (statusError) {
      setError(feedbackErrorMessage(statusError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="feedback-page" aria-labelledby="feedback-page-title">
      <header className="page-heading feedback-page-heading">
        <div>
          <span className="eyebrow">Приватні повідомлення</span>
          <h1 id="feedback-page-title">{isAdmin ? "Звернення користувачів" : "Підтримка Трекера Роду"}</h1>
          <p>
            {isAdmin
              ? "Відповідайте на питання й побажання користувачів у зручний час. Це не онлайн-чат."
              : "Повідомте про помилку платформи або поставте питання щодо функцій, акаунта, тарифу, оплати, резервних копій чи збереження даних. Відповідь можна прочитати тут пізніше."}
          </p>
        </div>
        <div className="page-heading-actions">
          <button type="button" className="button button-secondary" onClick={() => void refreshThreads()} disabled={loading}>
            Оновити
          </button>
          {!isAdmin ? (
            <button type="button" className="button button-primary" onClick={() => setShowComposer((current) => !current)}>
              {showComposer ? "Скасувати" : "+ Нове звернення"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="feedback-privacy-note" role="note">
        <PrivacyShieldIcon />
        <div>
          <strong>Приватність звернення</strong>
          <span>
            {isAdmin
              ? "Кожне листування доступне лише його автору та адміністраторам застосунку."
              : "Ваше звернення і всі відповіді бачите лише ви та адміністратор Трекера Роду."}
          </span>
        </div>
      </div>

      {error ? <div className="alert alert-error feedback-alert" role="alert">{error}</div> : null}
      {notice ? <div className="alert feedback-alert" role="status">{notice}</div> : null}

      {!isAdmin && showComposer ? (
        <form className="panel feedback-composer" onSubmit={submitThread}>
          <div className="feedback-section-heading">
            <div>
              <span className="eyebrow">Нове звернення</span>
              <h2>Напишіть адміністратору</h2>
            </div>
            <small>Відповідь не потребує вашої присутності онлайн.</small>
          </div>
          <div className="feedback-composer-grid">
            <label>
              <span>Тип звернення</span>
              <select value={category} onChange={(event) => setCategory(event.target.value as FeedbackCategory)}>
                {Object.entries(categoryLabels).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Тема</span>
              <input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                minLength={3}
                maxLength={160}
                placeholder="Коротко опишіть питання або пропозицію"
                required
              />
            </label>
          </div>
          <label>
            <span>Повідомлення</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={5000}
              rows={6}
              placeholder="Опишіть деталі. Не додавайте паролі, ключі доступу чи інші секретні дані."
              required
            />
            <small>{body.length} / 5000</small>
          </label>
          <div className="feedback-composer-actions">
            <button type="button" className="button button-secondary" onClick={() => setShowComposer(false)} disabled={busy}>Скасувати</button>
            <button type="submit" className="button button-primary" disabled={busy}>{busy ? "Надсилаємо…" : "Надіслати звернення"}</button>
          </div>
        </form>
      ) : null}

      <div className="feedback-workspace">
        <aside className="panel feedback-thread-panel" aria-label={isAdmin ? "Вхідні звернення" : "Мої звернення"}>
          <div className="feedback-thread-panel-header">
            <div>
              <span className="eyebrow">{isAdmin ? "Вхідні" : "Історія"}</span>
              <h2>{isAdmin ? "Звернення" : "Мої звернення"}</h2>
            </div>
            <span className="feedback-total">{visibleThreads.length}</span>
          </div>
          <input
            className="feedback-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={isAdmin ? "Тема, ім’я або email" : "Пошук за темою"}
            aria-label="Пошук звернень"
          />
          {isAdmin ? (
            <div className="feedback-filters" aria-label="Фільтри звернень">
              {(["all", "unread", "open", "answered", "closed"] as AdminFilter[]).map((filter) => (
                <button
                  type="button"
                  className={adminFilter === filter ? "active" : ""}
                  onClick={() => setAdminFilter(filter)}
                  key={filter}
                >
                  {filter === "all" ? "Усі" : filter === "unread" ? "Непрочитані" : statusLabels[filter]}
                </button>
              ))}
            </div>
          ) : null}
          <div className="feedback-thread-list">
            {visibleThreads.map((thread) => (
              <button
                type="button"
                className={`feedback-thread-card ${selectedThreadId === thread.id ? "active" : ""} ${thread.unread ? "unread" : ""}`}
                onClick={() => setSelectedThreadId(thread.id)}
                key={thread.id}
              >
                <span className="feedback-thread-card-topline">
                  <span>{categoryLabels[thread.category]}</span>
                  <time dateTime={thread.lastMessageAt}>{formatDateTime(thread.lastMessageAt)}</time>
                </span>
                <strong>{thread.subject}</strong>
                {isAdmin ? <small>{thread.authorName}{thread.authorEmail ? ` · ${thread.authorEmail}` : ""}</small> : null}
                <span className={`feedback-status feedback-status-${thread.status}`}>
                  {thread.unread ? "Нове повідомлення" : statusLabels[thread.status]}
                </span>
              </button>
            ))}
            {!loading && !visibleThreads.length ? (
              <div className="feedback-empty-list">
                <strong>{search || adminFilter !== "all" ? "Нічого не знайдено" : "Звернень ще немає"}</strong>
                {!isAdmin && !search ? <span>Створіть перше звернення кнопкою вище.</span> : null}
              </div>
            ) : null}
            {loading ? <div className="feedback-empty-list">Завантажуємо звернення…</div> : null}
          </div>
        </aside>

        <article className="panel feedback-conversation">
          {selectedThread ? (
            <>
              <header className="feedback-conversation-header">
                <div>
                  <span className="eyebrow">{categoryLabels[selectedThread.category]}</span>
                  <h2>{selectedThread.subject}</h2>
                  {isAdmin ? (
                    <p>{selectedThread.authorName}{selectedThread.authorEmail ? ` · ${selectedThread.authorEmail}` : ""}</p>
                  ) : null}
                </div>
                <div className="feedback-conversation-status">
                  <span className={`feedback-status feedback-status-${selectedThread.status}`}>{statusLabels[selectedThread.status]}</span>
                  <button type="button" className="text-button" onClick={() => void toggleClosed()} disabled={busy}>
                    {selectedThread.status === "closed" ? "Відновити" : "Завершити"}
                  </button>
                </div>
              </header>
              <div className="feedback-message-list" aria-live="polite">
                {messagesLoading ? <div className="feedback-empty-list">Завантажуємо листування…</div> : null}
                {!messagesLoading && messages.map((message) => {
                  const isOwn = message.senderId === account.id;
                  return (
                    <div className={`feedback-message ${isOwn ? "own" : "other"}`} key={message.id}>
                      <div className="feedback-message-meta">
                        <strong>{message.senderRole === "admin" ? "Адміністратор" : isOwn ? "Ви" : selectedThread.authorName}</strong>
                        <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
                      </div>
                      <p>{message.body}</p>
                    </div>
                  );
                })}
              </div>
              <form className="feedback-reply" onSubmit={submitReply}>
                <label>
                  <span>{isAdmin ? "Відповідь користувачу" : "Додати повідомлення"}</span>
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    rows={4}
                    maxLength={5000}
                    placeholder={isAdmin ? "Напишіть відповідь. Користувач прочитає її у своїй скриньці." : "Уточніть питання або додайте інформацію."}
                    disabled={busy}
                  />
                </label>
                <div className="feedback-reply-footer">
                  <small>{reply.length} / 5000 · відповідь не надсилається як онлайн-чат</small>
                  <button type="submit" className="button button-primary" disabled={busy || !reply.trim()}>
                    {busy ? "Надсилаємо…" : "Надіслати"}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="feedback-empty-conversation">
              <PrivacyShieldIcon />
              <strong>{isAdmin ? "Виберіть звернення зі списку" : "Тут з’явиться приватне листування"}</strong>
              <span>{isAdmin ? "Після вибору можна прочитати історію та відповісти." : "Створіть нове звернення або виберіть наявне."}</span>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  if (!value) return "";
  try {
    return formatDateTimeForDisplay(value);
  } catch {
    return value;
  }
}

function formatDateTime(value: string): string {
  return formatDate(value);
}

function feedbackErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message ?? "")
      : "";
  if (raw.includes("FEEDBACK_THREAD_RATE_LIMIT")) {
    return "Забагато нових звернень за короткий час. Спробуйте трохи пізніше.";
  }
  if (raw.includes("FEEDBACK_MESSAGE_RATE_LIMIT")) {
    return "Забагато повідомлень за короткий час. Спробуйте трохи пізніше.";
  }
  if (raw.includes("FEEDBACK_ACCESS_DENIED") || raw.includes("FEEDBACK_THREAD_NOT_FOUND")) {
    return "Звернення не знайдено або у вас немає доступу до нього.";
  }
  if (raw.includes("list_feedback_threads") || raw.includes("schema cache")) {
    return "Приватна скринька ще не підготовлена в базі даних. Застосуйте міграцію 202608130004_private_feedback_inbox.sql.";
  }
  return raw || "Не вдалося виконати дію зі зверненням. Спробуйте ще раз.";
}

function PrivacyShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.8 2.9 8 7 10 4.1-2 7-5.2 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
