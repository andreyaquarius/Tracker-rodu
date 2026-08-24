import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseAccount } from "../../services/supabaseAuth";
import {
  createTelegramLink,
  loadTelegramLinkStatus,
  setTelegramAiOptIn,
  unlinkTelegramAccount,
} from "../../services/telegramInboxService";
import type {
  TelegramAccountLinkStatus,
  TelegramLinkStart,
} from "../../types/telegramInbox";
import "./TelegramBotSettings.css";

export interface TelegramBotSettingsProps {
  /** Telegram is a private account-level integration, not a project setting. */
  account: Pick<SupabaseAccount, "id"> | null | undefined;
}

/**
 * Connects a user's Telegram account to their private Tracker Rodu inbox.
 *
 * This lives in Settings intentionally: the Notes page is for reading and
 * working with saved notes, while a bot link and AI permission are account
 * integration controls.
 */
export function TelegramBotSettings({ account }: TelegramBotSettingsProps) {
  const [linkStatus, setLinkStatus] = useState<TelegramAccountLinkStatus | null>(null);
  const [linkStart, setLinkStart] = useState<TelegramLinkStart | null>(null);
  const [linkAiOptIn, setLinkAiOptIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [aiOptInSaving, setAiOptInSaving] = useState(false);
  const [unlinkConfirming, setUnlinkConfirming] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);

  const accountId = account?.id ?? "";

  const refreshLinkStatus = useCallback(async () => {
    if (!accountId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    try {
      const nextStatus = await loadTelegramLinkStatus(accountId);
      if (requestGeneration.current !== generation) return;
      setLinkStatus(nextStatus);
      setLinkAiOptIn(nextStatus.aiOptIn);
      if (nextStatus.linked) setLinkStart(null);
    } catch (loadError) {
      if (requestGeneration.current === generation) setError(telegramSettingsErrorMessage(loadError));
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (!accountId) {
      ++requestGeneration.current;
      setLinkStatus(null);
      setLinkStart(null);
      setLinkAiOptIn(false);
      setNotice("");
      setError("");
      return;
    }
    void refreshLinkStatus();
  }, [accountId, refreshLinkStatus]);

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
      setUnlinkConfirming(false);
      setNotice(result.linked
        ? "Цей Telegram-акаунт уже підключено."
        : "Код готовий. Надішліть його боту командою /start.");
    } catch (linkError) {
      setError(telegramSettingsErrorMessage(linkError));
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
      setNotice(`Код скопійовано. Відкрийте Telegram-бота й надішліть: /start ${code}`);
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
      setError(telegramSettingsErrorMessage(unlinkError));
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
      // Disabling AI also changes server-side queue state, so read it back.
      const nextStatus = await loadTelegramLinkStatus(accountId);
      setLinkStatus(nextStatus);
      setLinkAiOptIn(nextStatus.aiOptIn);
      setNotice(nextStatus.aiOptIn
        ? "ШІ-аналіз увімкнено. Позначені як «Загуляка» повідомлення можуть створювати лише приватні чернетки."
        : "ШІ-аналіз вимкнено. Збереження приватних нотаток продовжує працювати без передавання їх до ШІ.");
    } catch (aiOptInError) {
      setError(telegramSettingsErrorMessage(aiOptInError));
    } finally {
      setAiOptInSaving(false);
    }
  };

  if (!accountId) {
    return (
      <section className="panel telegram-bot-settings telegram-bot-settings--signed-out" aria-labelledby="telegram-bot-settings-title">
        <span className="eyebrow">Підключення</span>
        <h2 id="telegram-bot-settings-title">Telegram-бот</h2>
        <p>Увійдіть в акаунт, щоб підключити Telegram-бота до приватних нотаток і чернеток Загуляк.</p>
      </section>
    );
  }

  const linkName = telegramAccountName(linkStatus);
  const startCode = linkStart?.startCode?.trim() ?? "";
  const botUrl = telegramBotUrl(startCode);
  const isLinked = Boolean(linkStatus?.linked);

  return (
    <section className="panel telegram-bot-settings" aria-labelledby="telegram-bot-settings-title">
      <header className="telegram-bot-settings__heading">
        <div>
          <span className="eyebrow">Підключення</span>
          <h2 id="telegram-bot-settings-title">Telegram-бот</h2>
          <p>
            Перешліть допис із Telegram або надішліть посилання з Facebook у приватний чат із ботом.
            Після цього оберіть, чи зберегти матеріал як Нотатку або підготувати чернетку Загуляки.
          </p>
        </div>
        <div className="telegram-bot-settings__actions">
          <a className="button button-secondary" href="/notes">Відкрити нотатки</a>
          <button type="button" className="button button-secondary" onClick={() => void refreshLinkStatus()} disabled={loading || linking || unlinking}>
            {loading ? "Оновлюємо…" : "Оновити"}
          </button>
        </div>
      </header>

      {error ? <div className="alert alert-error telegram-bot-settings__alert" role="alert">{error}</div> : null}
      {notice ? <div className="alert telegram-bot-settings__alert" role="status">{notice}</div> : null}

      <div className="telegram-bot-settings__status">
        <div>
          <h3>{isLinked ? "Telegram підключено" : "Підключіть Telegram"}</h3>
          {isLinked ? (
            <>
              <p>
                Підключено {linkName ? <strong>{linkName}</strong> : "Telegram-акаунт"}
                {linkStatus?.linkedAt ? <> · {formatDateTime(linkStatus.linkedAt)}</> : null}.
              </p>
              <p className="telegram-bot-settings__ai-summary">
                {linkStatus?.aiOptIn
                  ? "ШІ-аналіз увімкнено для повідомлень, які ви надсилаєте боту як Загуляки."
                  : "ШІ-аналіз вимкнено; бот зберігає ваші нотатки приватно без передавання їх до ШІ."}
              </p>
            </>
          ) : (
            <p>Створіть одноразовий код, а потім надішліть його боту командою <code>/start код</code>.</p>
          )}
        </div>
        <div className="telegram-bot-settings__connection-actions">
          {isLinked ? (
            <>
              {botUrl ? <a className="button button-secondary" href={botUrl} target="_blank" rel="noreferrer noopener">Відкрити бота</a> : null}
              <button type="button" className="button button-secondary" onClick={() => setUnlinkConfirming(true)} disabled={unlinking || aiOptInSaving}>
                Від’єднати Telegram
              </button>
            </>
          ) : (
            <button type="button" className="button button-primary" onClick={() => void beginLink()} disabled={linking || loading}>
              {linking ? "Готуємо код…" : "Підключити Telegram"}
            </button>
          )}
        </div>
      </div>

      {isLinked ? (
        <div className="telegram-bot-settings__ai-control">
          <label>
            <input
              type="checkbox"
              checked={linkStatus?.aiOptIn ?? false}
              disabled={aiOptInSaving || unlinking}
              onChange={(event) => void updateAiProcessingPermission(event.target.checked)}
            />
            <span>Дозволити ШІ готувати приватні чернетки Загуляк</span>
          </label>
          <small>
            Текст і дозволені фото, які ви самі позначите як Загуляки, можуть передаватися ШІ лише
            для створення приватної чернетки. Це не подає запис на модерацію і не публікує його автоматично.
          </small>
          {aiOptInSaving ? <span className="telegram-bot-settings__ai-pending" role="status">Оновлюємо налаштування ШІ…</span> : null}
        </div>
      ) : (
        <div className="telegram-bot-settings__ai-control">
          <label>
            <input
              type="checkbox"
              checked={linkAiOptIn}
              disabled={linking || loading}
              onChange={(event) => setLinkAiOptIn(event.target.checked)}
            />
            <span>Дозволити ШІ готувати приватні чернетки Загуляк</span>
          </label>
          <small>
            Це окрема згода на передавання до ШІ лише тих матеріалів, які ви самі позначите як Загуляки.
            Без неї бот усе одно зберігатиме ваші нотатки приватно.
          </small>
        </div>
      )}

      {startCode && !isLinked ? (
        <div className="telegram-bot-settings__code" role="status">
          <div>
            <span>Одноразовий код</span>
            <code>{startCode}</code>
            <small>{linkStart?.expiresAt ? `Дійсний до ${formatDateTime(linkStart.expiresAt)}.` : "Строк дії коду обмежений."}</small>
          </div>
          <div className="telegram-bot-settings__code-actions">
            <button type="button" className="button button-secondary" onClick={() => void copyStartCode()}>Скопіювати код</button>
            {botUrl ? <a className="button button-primary" href={botUrl} target="_blank" rel="noreferrer noopener">Відкрити бота</a> : null}
          </div>
        </div>
      ) : null}

      {unlinkConfirming ? (
        <div className="telegram-bot-settings__confirm" role="alert">
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
  );
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

function telegramSettingsErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message ?? "")
      : "";
  if (raw.includes("AUTH_REQUIRED") || raw.includes("authentication")) {
    return "Увійдіть в акаунт, щоб змінювати Telegram-підключення.";
  }
  if (raw.includes("TELEGRAM_LINK") || raw.includes("TELEGRAM_ACCOUNT")) {
    return "Не вдалося виконати дію з Telegram-підключенням. Оновіть сторінку та спробуйте ще раз.";
  }
  if (raw.includes("TELEGRAM_AI") || raw.includes("AI_OPT_IN")) {
    return "Не вдалося змінити дозвіл на ШІ-аналіз. Оновіть сторінку та спробуйте ще раз.";
  }
  if (raw.includes("schema cache") || raw.includes("does not exist")) {
    return "Модуль Telegram ще не підготовлено на сервері. Потрібно застосувати його міграцію.";
  }
  return raw || "Не вдалося виконати дію з Telegram-підключенням.";
}
