import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  createResearchGraphViewShare,
  listResearchGraphViewShares,
  revokeResearchGraphViewShare,
  updateResearchGraphViewShare,
} from "../../services/contextRelationsService.ts";
import type {
  ResearchGraphSavedView,
  ResearchGraphViewShare,
} from "../../types/contextGraph.ts";
import { researchGraphSharePath } from "../../utils/appRoutes.ts";

const SHARE_EXPIRY_OPTIONS = [
  { days: 7, label: "7 днів" },
  { days: 30, label: "30 днів" },
  { days: 90, label: "90 днів" },
] as const;

export interface ResearchGraphShareManagerProps {
  projectId: string;
  view: ResearchGraphSavedView;
  onClose: () => void;
}

/** Owner-only share controls. Raw bearer tokens never leave component memory. */
export function ResearchGraphShareManager({
  projectId,
  view,
  onClose,
}: ResearchGraphShareManagerProps) {
  const headingId = useId();
  const requestSequence = useRef(0);
  const contextKey = `${projectId}:${view.id}`;
  const activeContextKey = useRef(contextKey);
  activeContextKey.current = contextKey;
  const [shares, setShares] = useState<ResearchGraphViewShare[]>([]);
  const [expiryDays, setExpiryDays] = useState<7 | 30 | 90>(30);
  const [publicTitle, setPublicTitle] = useState("Спільний дослідницький граф");
  const [loading, setLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [oneTimeUrl, setOneTimeUrl] = useState("");
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState("");

  const activeShare = useMemo(() => shares.find((share) => (
    share.status === "active" && Date.parse(share.expiresAt) > Date.now()
  )) ?? null, [shares]);
  const currentShare = shares[0] ?? null;

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const requestContextKey = contextKey;
    setLoading(true);
    setError("");
    setMessage("");
    setOneTimeUrl("");
    setPublicTitle("Спільний дослідницький граф");
    setConfirmRotate(false);
    setConfirmRevokeId("");
    void listResearchGraphViewShares(projectId, view.id)
      .then((page) => {
        if (sequence !== requestSequence.current || requestContextKey !== activeContextKey.current) return;
        setShares(page.items);
        if (page.items[0]?.publicTitle) setPublicTitle(page.items[0].publicTitle);
      })
      .catch((cause) => {
        if (sequence !== requestSequence.current || requestContextKey !== activeContextKey.current) return;
        setError(errorMessage(cause, "Не вдалося завантажити посилання."));
      })
      .finally(() => {
        if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) {
          setLoading(false);
        }
      });
    return () => { requestSequence.current += 1; };
  }, [contextKey, projectId, reloadVersion, view.id]);

  const createOrRotate = async () => {
    if (activeShare && !confirmRotate) {
      setConfirmRotate(true);
      setMessage("Нове посилання одразу відкличе попереднє. Підтвердьте заміну.");
      return;
    }
    const sequence = ++requestSequence.current;
    const requestContextKey = contextKey;
    setBusy(true);
    setError("");
    setMessage("");
    setOneTimeUrl("");
    try {
      const created = await createResearchGraphViewShare(projectId, {
        savedViewId: view.id,
        accessMode: "public_readonly",
        expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60_000).toISOString(),
        publicTitle,
        expectedLockVersion: currentShare?.lockVersion ?? null,
      });
      if (sequence !== requestSequence.current || requestContextKey !== activeContextKey.current) return;
      setShares([created.share]);
      setOneTimeUrl(`${window.location.origin}${researchGraphSharePath(created.token)}`);
      setConfirmRotate(false);
      setMessage("Посилання створено. Скопіюйте його зараз: секретний токен більше не показуватиметься.");
    } catch (cause) {
      if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) {
        setError(errorMessage(cause, "Не вдалося створити посилання."));
      }
    } finally {
      if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) setBusy(false);
    }
  };

  const copyOneTimeUrl = async () => {
    if (!oneTimeUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(oneTimeUrl);
      setMessage("Посилання скопійовано.");
      setError("");
    } catch {
      setError("Автоматичне копіювання недоступне. Виділіть адресу в полі й скопіюйте її вручну.");
    }
  };

  const updateActiveShare = async () => {
    if (!activeShare) return;
    const sequence = ++requestSequence.current;
    const requestContextKey = contextKey;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const updated = await updateResearchGraphViewShare(projectId, activeShare, {
        accessMode: "public_readonly",
        expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60_000).toISOString(),
        publicTitle,
      });
      if (sequence !== requestSequence.current || requestContextKey !== activeContextKey.current) return;
      setShares([updated]);
      setMessage("Публічну назву і строк дії оновлено. Адреса посилання не змінилася.");
    } catch (cause) {
      if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) {
        setError(errorMessage(cause, "Не вдалося оновити посилання."));
      }
    } finally {
      if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) setBusy(false);
    }
  };

  const revoke = async (share: ResearchGraphViewShare) => {
    if (confirmRevokeId !== share.id) {
      setConfirmRevokeId(share.id);
      setMessage("Підтвердьте відкликання: відкрита сторінка одразу перестане працювати.");
      return;
    }
    const sequence = ++requestSequence.current;
    const requestContextKey = contextKey;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const revoked = await revokeResearchGraphViewShare(projectId, share);
      if (sequence !== requestSequence.current || requestContextKey !== activeContextKey.current) return;
      setShares((current) => current.map((item) => item.id === revoked.id ? revoked : item));
      setConfirmRevokeId("");
      setOneTimeUrl("");
      setMessage("Посилання відкликано.");
    } catch (cause) {
      if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) {
        setError(errorMessage(cause, "Не вдалося відкликати посилання."));
      }
    } finally {
      if (sequence === requestSequence.current && requestContextKey === activeContextKey.current) setBusy(false);
    }
  };

  return (
    <section className="research-graph-share-manager" aria-labelledby={headingId}>
      <div className="research-graph-share-manager__heading">
        <div>
          <h4 id={headingId}>Публічне посилання: {view.name}</h4>
          <p>Керувати ним може лише власник проєкту.</p>
        </div>
        <button type="button" onClick={onClose} disabled={busy}>Закрити</button>
      </div>

      <div className="research-graph-share-manager__privacy" role="note">
        <strong>Посилання не є копією приватного графа.</strong>
        Сервер щоразу формує окремий read-only зріз. До нього потрапляють лише особи,
        які явно позначені публічними, не є живими та мають записану дату смерті.
        Усі інші особи, непублічні записи й пов’язані з ними ребра вилучаються.
      </div>

      <div className="research-graph-share-manager__create">
        <label>
          <span>Публічна назва</span>
          <input
            type="text"
            value={publicTitle}
            maxLength={120}
            required
            onChange={(event) => setPublicTitle(event.target.value)}
            disabled={busy}
          />
          <small>Це окрема підтверджена назва; приватна назва представлення не публікується автоматично.</small>
        </label>
        <label>
          <span>Строк дії нового посилання</span>
          <select
            value={expiryDays}
            onChange={(event) => setExpiryDays(Number(event.target.value) as 7 | 30 | 90)}
            disabled={busy}
          >
            {SHARE_EXPIRY_OPTIONS.map((option) => (
              <option key={option.days} value={option.days}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="research-graph-v1__button is-primary"
          onClick={() => { void createOrRotate(); }}
          disabled={busy || loading || !publicTitle.trim()}
        >
          {busy
            ? "Зберігаємо…"
            : activeShare
              ? "Замінити посилання"
              : currentShare?.status === "suspended"
                ? "Повторно опублікувати"
                : "Створити посилання"}
        </button>
        {activeShare ? (
          <button
            type="button"
            className="research-graph-v1__button is-secondary"
            onClick={() => { void updateActiveShare(); }}
            disabled={busy || !publicTitle.trim()}
          >
            Оновити назву і строк
          </button>
        ) : null}
        {confirmRotate ? (
          <button
            type="button"
            className="research-graph-v1__button is-secondary"
            onClick={() => { setConfirmRotate(false); setMessage(""); }}
            disabled={busy}
          >
            Не замінювати
          </button>
        ) : null}
      </div>

      {oneTimeUrl ? (
        <div className="research-graph-share-manager__one-time" role="status">
          <label>
            <span>Нове посилання — показується один раз</span>
            <input type="text" readOnly value={oneTimeUrl} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <button type="button" onClick={() => { void copyOneTimeUrl(); }}>Копіювати</button>
        </div>
      ) : null}

      {error ? (
        <div>
          <p className="research-graph-v1__saved-view-status is-error" role="alert">{error}</p>
          {!busy && !loading ? (
            <button type="button" onClick={() => setReloadVersion((current) => current + 1)}>
              Оновити список
            </button>
          ) : null}
        </div>
      ) : null}
      {message ? <p className="research-graph-v1__saved-view-status" role="status">{message}</p> : null}
      {loading ? (
        <p role="status">Завантажуємо посилання…</p>
      ) : shares.length ? (
        <ul className="research-graph-share-manager__list" aria-label="Історія публічних посилань">
          {shares.map((share) => (
            <li key={share.id}>
              <div>
                <strong>{shareStatusLabel(share)}</strong>
                <span>Діє до {dateTimeLabel(share.expiresAt)}</span>
              </div>
              {share.status === "active" ? (
                <div>
                  <button type="button" onClick={() => { void revoke(share); }} disabled={busy}>
                    {confirmRevokeId === share.id ? "Підтвердити відкликання" : "Відкликати"}
                  </button>
                  {confirmRevokeId === share.id ? (
                    <button type="button" onClick={() => { setConfirmRevokeId(""); setMessage(""); }} disabled={busy}>
                      Скасувати
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>Для цього представлення ще немає посилань.</p>
      )}
      {activeShare && !oneTimeUrl ? (
        <small>
          З міркувань безпеки чинний секретний токен повторно не показується. Якщо адреса втрачена, замініть посилання.
        </small>
      ) : null}
    </section>
  );
}

function shareStatusLabel(share: ResearchGraphViewShare): string {
  if (share.status === "revoked") return "Відкликане";
  if (share.status === "suspended") return "Призупинене — представлення змінилося";
  if (share.status === "expired" || Date.parse(share.expiresAt) <= Date.now()) return "Строк завершився";
  return "Активне посилання";
}

function dateTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("uk-UA", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "невідомої дати";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
