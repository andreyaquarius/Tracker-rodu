import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { SupabaseAccount } from "../../services/supabaseAuth";
import {
  listTelegramNotes,
  updateTelegramNote,
} from "../../services/telegramInboxService";
import type {
  TelegramNote,
  TelegramNotePriority,
  TelegramNoteSourcePlatform,
  TelegramNoteSourceStatus,
  TelegramNoteStatus,
  TelegramNotesFilters,
} from "../../types/telegramInbox";
import {
  emptyTelegramNotesFilters,
  telegramNotePriorityLabels,
  telegramNoteSourcePlatformLabels,
  telegramNoteSourceStatusLabels,
  telegramNoteStatusLabels,
} from "../../types/telegramInbox";
import { sanitizeWebUrl } from "../../utils/safeUrl";
import "./TelegramNotesPanel.css";

const NOTE_STATUSES = ["inbox", "reviewing", "saved", "archived", "converted"] as const;
const SOURCE_STATUSES = ["unverified", "available", "unavailable", "changed"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const PLATFORMS = ["telegram", "facebook", "web", "other"] as const;

type NoteDraft = Pick<
  TelegramNote,
  "id" | "title" | "body" | "sourceUrl" | "sourcePlatform" | "status" | "sourceStatus" | "priority"
>;

export interface TelegramNotesPanelProps {
  /** The connected account owns all links and saved notes shown here. */
  account: Pick<SupabaseAccount, "id"> | null | undefined;
}

/**
 * Private Telegram inbox. It intentionally only displays a submitted URL and
 * never fetches, previews, or analyses an arbitrary external link in browser.
 */
export function TelegramNotesPanel({ account }: TelegramNotesPanelProps) {
  const [notes, setNotes] = useState<TelegramNote[]>([]);
  const [filters, setFilters] = useState<TelegramNotesFilters>(() => ({ ...emptyTelegramNotesFilters }));
  const [filterDraft, setFilterDraft] = useState<TelegramNotesFilters>(() => ({ ...emptyTelegramNotesFilters }));
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [editing, setEditing] = useState<NoteDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);

  const accountId = account?.id ?? "";

  const refresh = useCallback(async (nextFilters = filters) => {
    if (!accountId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    try {
      const nextNotes = await listTelegramNotes(nextFilters, accountId);
      if (requestGeneration.current !== generation) return;
      setNotes(nextNotes);
      setEditing((current) => current && nextNotes.some((note) => note.id === current.id) ? current : null);
      setSelectedNoteId((current) => current && nextNotes.some((note) => note.id === current) ? current : "");
    } catch (loadError) {
      if (requestGeneration.current === generation) setError(telegramInboxErrorMessage(loadError));
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [accountId, filters]);

  useEffect(() => {
    if (!accountId) {
      ++requestGeneration.current;
      setNotes([]);
      setSelectedNoteId("");
      setEditing(null);
      setError("");
      return;
    }
    void refresh();
  }, [accountId, refresh]);

  const visibleCountLabel = useMemo(
    () => `${notes.length} ${pluralizeNotes(notes.length)}`,
    [notes.length],
  );
  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextFilters = { ...filterDraft, query: filterDraft.query.trim() };
    setFilters(nextFilters);
    setSelectedNoteId("");
    setEditing(null);
    void refresh(nextFilters);
  };

  const resetFilters = () => {
    const nextFilters = { ...emptyTelegramNotesFilters };
    setFilters(nextFilters);
    setFilterDraft(nextFilters);
    setSelectedNoteId("");
    setEditing(null);
    void refresh(nextFilters);
  };

  const startEdit = (note: TelegramNote) => {
    setSelectedNoteId(note.id);
    setEditing({
      id: note.id,
      title: note.title,
      body: note.body,
      sourceUrl: note.sourceUrl,
      sourcePlatform: note.sourcePlatform,
      status: note.status,
      sourceStatus: note.sourceStatus,
      priority: note.priority,
    });
    setError("");
    setNotice("");
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !accountId) return;
    if (!editing.title.trim()) {
      setError("Додайте коротку назву нотатки.");
      return;
    }
    const sourceUrl = normalizedEditableSourceUrl(editing.sourceUrl);
    if (sourceUrl === null) {
      setError("Вкажіть повне й коректне http або https посилання на джерело.");
      return;
    }
    setSavingId(editing.id);
    setError("");
    try {
      const saved = await updateTelegramNote({
        noteId: editing.id,
        title: editing.title,
        body: editing.body,
        sourceUrl,
        sourcePlatform: editing.sourcePlatform,
        status: editing.status,
        sourceStatus: editing.sourceStatus,
        priority: editing.priority,
      }, accountId);
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note));
      setEditing(null);
      setNotice("Нотатку оновлено.");
    } catch (saveError) {
      setError(telegramInboxErrorMessage(saveError));
    } finally {
      setSavingId("");
    }
  };

  if (!accountId) {
    return (
      <section className="telegram-notes-panel telegram-notes-panel--signed-out" aria-labelledby="telegram-notes-title">
        <span className="eyebrow">Особистий простір</span>
        <h2 id="telegram-notes-title">Збережені нотатки</h2>
        <p>Увійдіть в акаунт, щоб бачити свої приватні нотатки.</p>
      </section>
    );
  }

  return (
    <section className="telegram-notes-panel" aria-labelledby="telegram-notes-title">
      <header className="telegram-notes-panel__heading">
        <div>
          <span className="eyebrow">Telegram і нотатки</span>
          <h2 id="telegram-notes-title">Особиста скринька джерел</h2>
          <p>
            Перешліть допис із Telegram-каналу безпосередньо в приватний чат із ботом,
            або надішліть посилання через «Поділитися» чи копіювання з Facebook. Бот спершу
            збереже матеріал у короткому приватному очікуванні, а потім попросить обрати:
            приватна <strong>Нотатка</strong> чи <strong>Загуляка</strong> для підготовки
            окремої приватної чернетки.
          </p>
        </div>
        <div className="telegram-notes-panel__actions">
          <a className="button button-secondary" href="/zahuliaky/my">Мої чернетки Загуляк</a>
          <button type="button" className="button button-secondary" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Оновлюємо…" : "Оновити"}
          </button>
        </div>
      </header>

      {error ? <div className="alert alert-error telegram-notes-panel__alert" role="alert">{error}</div> : null}
      {notice ? <div className="alert telegram-notes-panel__alert" role="status">{notice}</div> : null}

      <section className="telegram-notes-workspace" aria-labelledby="telegram-note-list-title">
        <form className="telegram-notes-filters panel" onSubmit={applyFilters}>
          <div className="telegram-notes-filters__heading">
            <div>
              <span className="eyebrow">Фільтри</span>
              <h3>Збережені нотатки</h3>
            </div>
            <span>{visibleCountLabel}</span>
          </div>
          <div className="telegram-notes-filters__controls">
            <label className="telegram-notes-filters__search">
              <span>Пошук</span>
              <input
                type="search"
                value={filterDraft.query}
                onChange={(event) => setFilterDraft((current) => ({ ...current, query: event.target.value }))}
                placeholder="Текст, назва, канал або посилання"
              />
            </label>
            <label>
              <span>Стан нотатки</span>
              <select
                value={filterDraft.status}
                onChange={(event) => setFilterDraft((current) => ({ ...current, status: event.target.value as TelegramNoteStatus | "" }))}
              >
                <option value="">Усі стани</option>
                <Options values={NOTE_STATUSES} labels={telegramNoteStatusLabels} />
              </select>
            </label>
            <label>
              <span>Стан джерела</span>
              <select
                value={filterDraft.sourceStatus}
                onChange={(event) => setFilterDraft((current) => ({ ...current, sourceStatus: event.target.value as TelegramNoteSourceStatus | "" }))}
              >
                <option value="">Усі джерела</option>
                <Options values={SOURCE_STATUSES} labels={telegramNoteSourceStatusLabels} />
              </select>
            </label>
            <label>
              <span>Пріоритет</span>
              <select
                value={filterDraft.priority}
                onChange={(event) => setFilterDraft((current) => ({ ...current, priority: event.target.value as TelegramNotePriority | "" }))}
              >
                <option value="">Усі пріоритети</option>
                <Options values={PRIORITIES} labels={telegramNotePriorityLabels} />
              </select>
            </label>
            <label>
              <span>Платформа</span>
              <select
                value={filterDraft.sourcePlatform}
                onChange={(event) => setFilterDraft((current) => ({ ...current, sourcePlatform: event.target.value as TelegramNoteSourcePlatform | "" }))}
              >
                <option value="">Усі платформи</option>
                <Options values={PLATFORMS} labels={telegramNoteSourcePlatformLabels} />
              </select>
            </label>
            <div className="telegram-notes-filters__actions">
              <button type="submit" className="button button-primary" disabled={loading}>Застосувати</button>
              <button type="button" className="button button-secondary" onClick={resetFilters} disabled={loading}>Скинути</button>
            </div>
          </div>
        </form>

        <div className="telegram-notes-list" aria-live="polite" aria-busy={loading}>
          <div className="telegram-notes-list__header">
            <h3 id="telegram-note-list-title">Нотатки</h3>
            <span>{loading ? "Завантажуємо…" : visibleCountLabel}</span>
          </div>
          {!loading && !notes.length ? (
            <div className="telegram-notes-empty panel">
              <strong>Нотаток за цими фільтрами ще немає.</strong>
              <span>Надішліть або перешліть допис боту, а потім натисніть «Нотатка». Після оновлення сторінки він з’явиться тут приватно. Для фото оберіть «Загуляка», щоб створити чернетку запису.</span>
            </div>
          ) : null}
          {!loading && notes.length && !selectedNote ? (
            <ul className="telegram-note-list panel" aria-label="Список збережених нотаток">
              {notes.map((note) => (
                <NoteListItem key={note.id} note={note} onOpen={() => setSelectedNoteId(note.id)} />
              ))}
            </ul>
          ) : null}
          {selectedNote ? (
            editing?.id === selectedNote.id ? (
              <NoteEditor
                draft={editing}
                saving={savingId === selectedNote.id}
                onChange={setEditing}
                onCancel={() => setEditing(null)}
                onSubmit={saveEdit}
              />
            ) : (
              <NoteDetail
                note={selectedNote}
                onBack={() => setSelectedNoteId("")}
                onEdit={() => startEdit(selectedNote)}
              />
            )
          ) : null}
        </div>
      </section>
    </section>
  );
}

function NoteListItem({ note, onOpen }: { note: TelegramNote; onOpen: () => void }) {
  const sourceLabel = forwardedSourceLabel(note);
  return (
    <li className="telegram-note-list__item">
      <button type="button" className="telegram-note-list__button" onClick={onOpen}>
        <span className="telegram-note-list__summary">
          <span className="telegram-note-list__title">{note.title}</span>
          <span className="telegram-note-list__meta">
            {labelFor(note.sourcePlatform, telegramNoteSourcePlatformLabels)}
            {sourceLabel ? ` · ${sourceLabel}` : null}
            {!sourceLabel && note.sourceMetadata.forwarded ? " · Пересланий допис Telegram" : null}
          </span>
        </span>
        <span className="telegram-note-list__end">
          <span className="telegram-note-list__badges" aria-label="Стан нотатки">
            <StatusBadge value={note.status} labels={telegramNoteStatusLabels} kind="status" />
            <StatusBadge value={note.sourceStatus} labels={telegramNoteSourceStatusLabels} kind="source" />
            <StatusBadge value={note.priority} labels={telegramNotePriorityLabels} kind="priority" />
          </span>
          <time dateTime={note.updatedAt || note.createdAt}>{formatDateTime(note.updatedAt || note.createdAt)}</time>
          <span className="telegram-note-list__open" aria-hidden="true">Відкрити</span>
        </span>
      </button>
    </li>
  );
}

function NoteDetail({ note, onBack, onEdit }: { note: TelegramNote; onBack: () => void; onEdit: () => void }) {
  const sourceUrl = sanitizeWebUrl(note.sourceUrl);
  const telegramPermalink = sanitizeWebUrl(note.sourceMetadata.publicPermalink ?? "");
  const sourceLabel = forwardedSourceLabel(note);
  return (
    <article className="telegram-note-detail panel" aria-labelledby={`telegram-note-title-${note.id}`}>
      <div className="telegram-note-detail__heading">
        <button type="button" className="button button-secondary" onClick={onBack}>← До списку</button>
        <time dateTime={note.updatedAt || note.createdAt}>{formatDateTime(note.updatedAt || note.createdAt)}</time>
      </div>
      <div className="telegram-note-detail__topline">
        <div className="telegram-note-detail__badges" aria-label="Стан нотатки">
          <StatusBadge value={note.status} labels={telegramNoteStatusLabels} kind="status" />
          <StatusBadge value={note.sourceStatus} labels={telegramNoteSourceStatusLabels} kind="source" />
          <StatusBadge value={note.priority} labels={telegramNotePriorityLabels} kind="priority" />
        </div>
      </div>
      <h4 id={`telegram-note-title-${note.id}`}>{note.title}</h4>
      {note.body ? <p className="telegram-note-detail__body">{note.body}</p> : <p className="telegram-note-detail__empty-body">Текст нотатки відсутній.</p>}
      <footer className="telegram-note-detail__footer">
        <span>{labelFor(note.sourcePlatform, telegramNoteSourcePlatformLabels)}</span>
        {sourceLabel ? <span className="telegram-note-detail__source-label">Переслано з Telegram: {sourceLabel}</span> : null}
        {!sourceLabel && note.sourceMetadata.forwarded ? <span className="telegram-note-detail__source-label">Пересланий допис Telegram</span> : null}
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noreferrer noopener">Відкрити першоджерело</a>
        ) : note.sourceUrl ? <span className="telegram-note-detail__invalid-link">Посилання недоступне</span> : null}
        {telegramPermalink && telegramPermalink !== sourceUrl ? (
          <a href={telegramPermalink} target="_blank" rel="noreferrer noopener">Відкрити допис Telegram</a>
        ) : null}
        <button type="button" className="button button-secondary" onClick={onEdit}>Редагувати</button>
      </footer>
    </article>
  );
}

function forwardedSourceLabel(note: TelegramNote): string {
  const isNamedSource = note.sourceMetadata.originType === "channel"
    || (note.sourceMetadata.originType === "chat"
      && (note.sourceMetadata.sourceChatType === "channel"
        || note.sourceMetadata.sourceChatType === "group"
        || note.sourceMetadata.sourceChatType === "supergroup"));
  if (note.sourceMetadata.forwarded && !isNamedSource) {
    return "";
  }
  const label = note.sourceLabel || note.sourceMetadata.sourceTitle || "";
  return label.trim();
}

function NoteEditor({
  draft,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: NoteDraft;
  saving: boolean;
  onChange: (draft: NoteDraft) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const sourceUrl = sanitizeWebUrl(draft.sourceUrl);
  const sourceUrlHelpId = `telegram-note-source-url-help-${draft.id}`;
  return (
    <form className="telegram-note-editor panel" onSubmit={onSubmit}>
      <div className="telegram-note-editor__heading">
        <div>
          <span className="eyebrow">Редагування</span>
          <h4>Збережена нотатка</h4>
        </div>
        {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer noopener">Першоджерело</a> : null}
      </div>
      <label>
        <span>Назва</span>
        <input value={draft.title} maxLength={300} required onChange={(event) => onChange({ ...draft, title: event.target.value })} />
      </label>
      <label>
        <span>Текст нотатки</span>
        <textarea rows={7} value={draft.body} maxLength={20_000} onChange={(event) => onChange({ ...draft, body: event.target.value })} />
      </label>
      <label>
        <span>Посилання на джерело</span>
        <input
          type="url"
          inputMode="url"
          value={draft.sourceUrl}
          maxLength={2048}
          placeholder="https://example.org/source"
          spellCheck={false}
          aria-describedby={sourceUrlHelpId}
          onChange={(event) => onChange({ ...draft, sourceUrl: event.target.value })}
          onBlur={(event) => {
            const normalized = normalizedEditableSourceUrl(event.target.value);
            if (normalized !== null) onChange({ ...draft, sourceUrl: normalized });
          }}
        />
        <small id={sourceUrlHelpId}>Лише повне http або https посилання. Під час редагування воно не завантажується.</small>
      </label>
      <div className="telegram-note-editor__fields">
        <label>
          <span>Платформа джерела</span>
          <select value={draft.sourcePlatform} onChange={(event) => onChange({ ...draft, sourcePlatform: event.target.value as TelegramNoteSourcePlatform })}>
            <OptionsWithCurrent values={PLATFORMS} current={draft.sourcePlatform} labels={telegramNoteSourcePlatformLabels} />
          </select>
        </label>
        <label>
          <span>Стан нотатки</span>
          <select value={draft.status} onChange={(event) => onChange({ ...draft, status: event.target.value as TelegramNoteStatus })}>
            <OptionsWithCurrent values={NOTE_STATUSES} current={draft.status} labels={telegramNoteStatusLabels} />
          </select>
        </label>
        <label>
          <span>Стан джерела</span>
          <select value={draft.sourceStatus} onChange={(event) => onChange({ ...draft, sourceStatus: event.target.value as TelegramNoteSourceStatus })}>
            <OptionsWithCurrent values={SOURCE_STATUSES} current={draft.sourceStatus} labels={telegramNoteSourceStatusLabels} />
          </select>
        </label>
        <label>
          <span>Пріоритет</span>
          <select value={draft.priority} onChange={(event) => onChange({ ...draft, priority: event.target.value as TelegramNotePriority })}>
            <OptionsWithCurrent values={PRIORITIES} current={draft.priority} labels={telegramNotePriorityLabels} />
          </select>
        </label>
      </div>
      <div className="telegram-note-editor__actions">
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>Скасувати</button>
        <button type="submit" className="button button-primary" disabled={saving}>{saving ? "Зберігаємо…" : "Зберегти"}</button>
      </div>
    </form>
  );
}

function Options({ values, labels }: { values: readonly string[]; labels: Record<string, string> }) {
  return <>{values.map((value) => <option key={value} value={value}>{labelFor(value, labels)}</option>)}</>;
}

function OptionsWithCurrent({
  values,
  current,
  labels,
}: {
  values: readonly string[];
  current: string;
  labels: Record<string, string>;
}) {
  const allValues = values.includes(current) ? values : [current, ...values];
  return <Options values={allValues} labels={labels} />;
}

function StatusBadge({
  value,
  labels,
  kind,
}: {
  value: string;
  labels: Record<string, string>;
  kind: "status" | "source" | "priority";
}) {
  return <span className={`telegram-note-badge telegram-note-badge--${kind} telegram-note-badge--${safeClassSuffix(value)}`}>{labelFor(value, labels)}</span>;
}

/** Allows only an explicit http(s) URL; this never requests the URL. */
function normalizedEditableSourceUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return null;
  return sanitizeWebUrl(raw);
}

function labelFor(value: string, labels: Record<string, string>): string {
  return labels[value] ?? (value.replace(/[_-]+/g, " ") || "—");
}

function safeClassSuffix(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function formatDateTime(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function pluralizeNotes(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "нотаток";
  if (last === 1) return "нотатка";
  if (last >= 2 && last <= 4) return "нотатки";
  return "нотаток";
}

function telegramInboxErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message ?? "")
      : "";
  if (raw.includes("AUTH_REQUIRED") || raw.includes("authentication")) {
    return "Увійдіть в акаунт, щоб відкрити приватні нотатки.";
  }
  if (raw.includes("TELEGRAM_LINK") || raw.includes("TELEGRAM_ACCOUNT")) {
    return "Не вдалося виконати дію з Telegram-підключенням. Оновіть сторінку та спробуйте ще раз.";
  }
  if (raw.includes("TELEGRAM_AI") || raw.includes("AI_OPT_IN")) {
    return "Не вдалося змінити дозвіл на ШІ-аналіз. Оновіть сторінку та спробуйте ще раз.";
  }
  if (raw.includes("schema cache") || raw.includes("does not exist")) {
    return "Модуль Telegram-нотаток ще не підготовлено на сервері. Потрібно застосувати його міграцію.";
  }
  return raw || "Не вдалося виконати дію з Telegram-нотатками.";
}
