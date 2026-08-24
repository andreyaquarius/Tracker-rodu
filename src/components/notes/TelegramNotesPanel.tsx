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
  createTelegramLink,
  listTelegramNotes,
  loadTelegramLinkStatus,
  setTelegramAiOptIn,
  unlinkTelegramAccount,
  updateTelegramNote,
} from "../../services/telegramInboxService";
import type {
  TelegramAccountLinkStatus,
  TelegramLinkStart,
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
  const [linkStatus, setLinkStatus] = useState<TelegramAccountLinkStatus | null>(null);
  const [linkStart, setLinkStart] = useState<TelegramLinkStart | null>(null);
  const [notes, setNotes] = useState<TelegramNote[]>([]);
  const [filters, setFilters] = useState<TelegramNotesFilters>(() => ({ ...emptyTelegramNotesFilters }));
  const [filterDraft, setFilterDraft] = useState<TelegramNotesFilters>(() => ({ ...emptyTelegramNotesFilters }));
  const [editing, setEditing] = useState<NoteDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkAiOptIn, setLinkAiOptIn] = useState(false);
  const [aiOptInSaving, setAiOptInSaving] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [unlinkConfirming, setUnlinkConfirming] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
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
      const [nextLinkStatus, nextNotes] = await Promise.all([
        loadTelegramLinkStatus(accountId),
        listTelegramNotes(nextFilters, accountId),
      ]);
      if (requestGeneration.current !== generation) return;
      setLinkStatus(nextLinkStatus);
      setLinkAiOptIn((current) => nextLinkStatus.linked ? nextLinkStatus.aiOptIn : current);
      setNotes(nextNotes);
      setEditing((current) => current && nextNotes.some((note) => note.id === current.id) ? current : null);
    } catch (loadError) {
      if (requestGeneration.current === generation) setError(telegramInboxErrorMessage(loadError));
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [accountId, filters]);

  useEffect(() => {
    if (!accountId) {
      ++requestGeneration.current;
      setLinkStatus(null);
      setLinkStart(null);
      setLinkAiOptIn(false);
      setNotes([]);
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

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextFilters = { ...filterDraft, query: filterDraft.query.trim() };
    setFilters(nextFilters);
    setEditing(null);
    void refresh(nextFilters);
  };

  const resetFilters = () => {
    const nextFilters = { ...emptyTelegramNotesFilters };
    setFilters(nextFilters);
    setFilterDraft(nextFilters);
    setEditing(null);
    void refresh(nextFilters);
  };

  const beginLink = async () => {
    if (!accountId) return;
    setLinking(true);
    setError("");
    setNotice("");
    try {
      const result = await createTelegramLink(linkAiOptIn, accountId);
      setLinkStart(result);
      setLinkStatus(result);
      setLinkAiOptIn(result.aiOptIn);
      setNotice(result.linked
        ? "Цей Telegram-акаунт уже підключено."
        : "Код готовий. Надішліть його боту командою /start.");
    } catch (linkError) {
      setError(telegramInboxErrorMessage(linkError));
    } finally {
      setLinking(false);
    }
  };

  const copyStartCode = async () => {
    const code = linkStart?.startCode?.trim();
    if (!code) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("COPY_UNAVAILABLE");
      await navigator.clipboard.writeText(code);
      setNotice("Код скопійовано. Відкрийте Telegram-бота й надішліть: /start " + code);
    } catch {
      setError("Не вдалося скопіювати код. Скопіюйте його вручну.");
    }
  };

  const confirmUnlink = async () => {
    if (!accountId) return;
    setUnlinking(true);
    setError("");
    setNotice("");
    try {
      await unlinkTelegramAccount(accountId);
      setLinkStatus({ linked: false, telegramUsername: null, linkedAt: null, displayName: null, aiOptIn: false });
      setLinkStart(null);
      setLinkAiOptIn(false);
      setUnlinkConfirming(false);
      setNotice("Telegram-акаунт від’єднано. Збережені нотатки залишилися у вашому акаунті.");
    } catch (unlinkError) {
      setError(telegramInboxErrorMessage(unlinkError));
    } finally {
      setUnlinking(false);
    }
  };

  const updateAiProcessingPermission = async (nextAiOptIn: boolean) => {
    if (!accountId || !linkStatus?.linked) return;
    setAiOptInSaving(true);
    setError("");
    setNotice("");
    try {
      await setTelegramAiOptIn(nextAiOptIn, accountId);
      // The server may also change Telegram mode and cancel queued Zagulyaka
      // work when AI is disabled, so do not assume the checkbox value won.
      const nextStatus = await loadTelegramLinkStatus(accountId);
      setLinkStatus(nextStatus);
      setLinkAiOptIn(nextStatus.aiOptIn);
      setNotice(nextStatus.aiOptIn
        ? "ШІ-аналіз увімкнено. Позначені як «Загуляка» повідомлення можуть створювати лише приватні чернетки."
        : "ШІ-аналіз вимкнено. Збереження приватних нотаток продовжує працювати без передавання їх до ШІ.");
    } catch (aiOptInError) {
      setError(telegramInboxErrorMessage(aiOptInError));
    } finally {
      setAiOptInSaving(false);
    }
  };

  const startEdit = (note: TelegramNote) => {
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
        <span className="eyebrow">Telegram і нотатки</span>
        <h2 id="telegram-notes-title">Збережені з Telegram нотатки</h2>
        <p>Увійдіть в акаунт, щоб підключити Telegram-бота та бачити приватні нотатки.</p>
      </section>
    );
  }

  const linkName = telegramAccountName(linkStatus);
  const startCode = linkStart?.startCode?.trim() ?? "";
  const botUrl = telegramBotUrl(startCode);

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

      <section className="telegram-notes-link panel" aria-labelledby="telegram-link-title">
        <div>
          <span className="eyebrow">Підключення</span>
          <h3 id="telegram-link-title">Telegram-бот</h3>
          {linkStatus?.linked ? (
            <>
              <p>
                Підключено {linkName ? <strong>{linkName}</strong> : "Telegram-акаунт"}
                {linkStatus.linkedAt ? <> · {formatDateTime(linkStatus.linkedAt)}</> : null}.
              </p>
              <p className="telegram-notes-link__ai-summary">
                {linkStatus.aiOptIn
                  ? "ШІ-аналіз увімкнено для повідомлень, які ви надсилаєте боту як Загуляки."
                  : "ШІ-аналіз вимкнено; бот зберігає ваші нотатки приватно без передавання їх до ШІ."}
              </p>
              <p className="telegram-notes-link__forwarding-help">
                Бот не читає канали або Facebook самостійно: перешліть Telegram-допис у цей
                приватний чат або надішліть посилання на допис із Facebook. Для відкритих
                Telegram-каналів збережеться посилання на оригінал; для закритих — лише
                доступна назва джерела.
              </p>
            </>
          ) : (
            <p>Створіть одноразовий код, а потім надішліть його боту командою <code>/start код</code>.</p>
          )}
        </div>
        <div className="telegram-notes-link__actions">
          {linkStatus?.linked ? (
            <>
              {botUrl ? <a className="button button-secondary" href={botUrl} target="_blank" rel="noreferrer noopener">Відкрити бота</a> : null}
              <button type="button" className="button button-secondary" onClick={() => setUnlinkConfirming(true)} disabled={unlinking}>
                Від’єднати Telegram
              </button>
            </>
          ) : (
            <button type="button" className="button button-primary" onClick={() => void beginLink()} disabled={linking}>
              {linking ? "Готуємо код…" : "Підключити Telegram"}
            </button>
          )}
        </div>

        {linkStatus?.linked ? (
          <div className="telegram-notes-link__ai-control">
            <label>
              <input
                type="checkbox"
                checked={linkStatus.aiOptIn}
                disabled={aiOptInSaving || unlinking}
                onChange={(event) => void updateAiProcessingPermission(event.target.checked)}
              />
              <span>Дозволити ШІ готувати приватні чернетки Загуляк</span>
            </label>
            <small>
              За увімкнення текст і дозволені фото, які ви свідомо надсилаєте боту як Загуляки,
              можуть бути передані ШІ лише для підготовки приватної чернетки. Це не подає і не
              публікує запис автоматично. Вимкнення скасовує ще не оброблені ШІ-завдання, але не
              видаляє нотатки чи наявні чернетки.
            </small>
            {aiOptInSaving ? <span className="telegram-notes-link__ai-pending" role="status">Оновлюємо налаштування ШІ…</span> : null}
          </div>
        ) : (
          <div className="telegram-notes-link__ai-control">
            <label>
              <input
                type="checkbox"
                checked={linkAiOptIn}
                disabled={linking}
                onChange={(event) => setLinkAiOptIn(event.target.checked)}
              />
              <span>Дозволити ШІ готувати приватні чернетки Загуляк</span>
            </label>
            <small>
              Це окрема згода на передавання повідомлень, які ви самі позначите як Загуляки,
              до ШІ для аналізу. Без неї бот все одно збереже ваші нотатки приватно. Налаштування
              можна змінити після підключення.
            </small>
          </div>
        )}

        {startCode && !linkStart?.linked ? (
          <div className="telegram-notes-link__code" role="status">
            <div>
              <span>Одноразовий код</span>
              <code>{startCode}</code>
              <small>{linkStart?.expiresAt ? `Дійсний до ${formatDateTime(linkStart.expiresAt)}.` : "Строк дії коду обмежений."}</small>
            </div>
            <div className="telegram-notes-link__code-actions">
              <button type="button" className="button button-secondary" onClick={() => void copyStartCode()}>Скопіювати код</button>
              {botUrl ? <a className="button button-primary" href={botUrl} target="_blank" rel="noreferrer noopener">Відкрити бота</a> : null}
            </div>
          </div>
        ) : null}

        {unlinkConfirming ? (
          <div className="telegram-notes-link__confirm" role="alert">
            <p>Від’єднати бота? Нові повідомлення більше не потраплятимуть до скриньки. Наявні нотатки не буде видалено.</p>
            <div>
              <button type="button" className="button button-secondary" onClick={() => setUnlinkConfirming(false)} disabled={unlinking}>Скасувати</button>
              <button type="button" className="button button-danger" onClick={() => void confirmUnlink()} disabled={unlinking}>
                {unlinking ? "Від’єднуємо…" : "Так, від’єднати"}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="telegram-notes-workspace" aria-labelledby="telegram-note-list-title">
        <form className="telegram-notes-filters panel" onSubmit={applyFilters}>
          <div className="telegram-notes-filters__heading">
            <div>
              <span className="eyebrow">Фільтри</span>
              <h3>Збережені нотатки</h3>
            </div>
            <span>{visibleCountLabel}</span>
          </div>
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
        </form>

        <div className="telegram-notes-list" aria-live="polite" aria-busy={loading}>
          <div className="telegram-notes-list__header">
            <h3 id="telegram-note-list-title">Нотатки</h3>
            <span>{loading ? "Завантажуємо…" : visibleCountLabel}</span>
          </div>
          {!loading && !notes.length ? (
            <div className="telegram-notes-empty panel">
              <strong>Нотаток за цими фільтрами ще немає.</strong>
              <span>Оберіть у боті «Нотатка», а потім перешліть допис із Telegram-каналу або надішліть посилання з Facebook — воно з’явиться тут приватно. Для фото оберіть «Загуляка», щоб створити чернетку запису.</span>
            </div>
          ) : null}
          {notes.map((note) => (
            editing?.id === note.id ? (
              <NoteEditor
                key={note.id}
                draft={editing}
                saving={savingId === note.id}
                onChange={setEditing}
                onCancel={() => setEditing(null)}
                onSubmit={saveEdit}
              />
            ) : (
              <NoteCard key={note.id} note={note} onEdit={() => startEdit(note)} />
            )
          ))}
        </div>
      </section>
    </section>
  );
}

function NoteCard({ note, onEdit }: { note: TelegramNote; onEdit: () => void }) {
  const sourceUrl = sanitizeWebUrl(note.sourceUrl);
  const telegramPermalink = sanitizeWebUrl(note.sourceMetadata.publicPermalink ?? "");
  const sourceLabel = forwardedSourceLabel(note);
  return (
    <article className="telegram-note-card panel">
      <div className="telegram-note-card__topline">
        <div className="telegram-note-card__badges" aria-label="Стан нотатки">
          <StatusBadge value={note.status} labels={telegramNoteStatusLabels} kind="status" />
          <StatusBadge value={note.sourceStatus} labels={telegramNoteSourceStatusLabels} kind="source" />
          <StatusBadge value={note.priority} labels={telegramNotePriorityLabels} kind="priority" />
        </div>
        <time dateTime={note.updatedAt || note.createdAt}>{formatDateTime(note.updatedAt || note.createdAt)}</time>
      </div>
      <h4>{note.title}</h4>
      {note.body ? <p className="telegram-note-card__body">{note.body}</p> : null}
      <footer>
        <span>{labelFor(note.sourcePlatform, telegramNoteSourcePlatformLabels)}</span>
        {sourceLabel ? <span className="telegram-note-card__source-label">Переслано з Telegram: {sourceLabel}</span> : null}
        {!sourceLabel && note.sourceMetadata.forwarded ? <span className="telegram-note-card__source-label">Пересланий допис Telegram</span> : null}
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noreferrer noopener">Відкрити першоджерело</a>
        ) : note.sourceUrl ? <span className="telegram-note-card__invalid-link">Посилання недоступне</span> : null}
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

function telegramAccountName(status: TelegramAccountLinkStatus | null): string {
  if (!status) return "";
  if (status.telegramUsername) return `@${status.telegramUsername.replace(/^@+/, "")}`;
  return status.displayName ?? "";
}

/** A Telegram bot username is public configuration, not an API credential. */
function telegramBotUrl(startCode = ""): string | null {
  const username = import.meta.env.VITE_TELEGRAM_BOT_USERNAME?.trim().replace(/^@+/, "") ?? "";
  if (!/^[A-Za-z][A-Za-z0-9_]{4,63}bot$/iu.test(username)) return null;
  const base = `https://t.me/${username}`;
  return startCode && /^[A-Za-z0-9_-]{1,64}$/u.test(startCode)
    ? `${base}?start=${encodeURIComponent(startCode)}`
    : base;
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
