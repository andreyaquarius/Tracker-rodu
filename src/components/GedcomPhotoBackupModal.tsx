import { useEffect, useMemo, useState } from "react";
import {
  authorizeGoogleDrive,
  isGoogleDriveAuthorized,
  prepareGoogleDriveAuthorization,
} from "../services/googleDriveStorage.ts";
import type {
  GedcomPhotoBackupPlan,
  GedcomPhotoBackupProgress,
  GedcomPhotoBackupResult,
} from "../services/gedcomPhotoBackup.ts";
import { externalLinkExpiry, formatExternalLinkExpiry } from "../utils/externalLinkExpiry.ts";
import { Modal } from "./Modal";

type DialogPhase = "offer" | "warning" | "authorizing" | "copying" | "result";

export function GedcomPhotoBackupModal({
  fileName,
  importSummary,
  plan,
  onBackup,
  onClose,
}: {
  fileName: string;
  importSummary: string;
  plan: GedcomPhotoBackupPlan;
  onBackup?: (
    plan: GedcomPhotoBackupPlan,
    onProgress: (progress: GedcomPhotoBackupProgress) => void,
  ) => Promise<GedcomPhotoBackupResult>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<DialogPhase>("offer");
  const [progress, setProgress] = useState<GedcomPhotoBackupProgress | null>(null);
  const [result, setResult] = useState<GedcomPhotoBackupResult | null>(null);
  const [error, setError] = useState("");
  const [driveReady, setDriveReady] = useState(false);
  const busy = phase === "authorizing" || phase === "copying";
  const expiryNotice = useMemo(() => expirySummary(plan), [plan]);

  useEffect(() => {
    let active = true;
    void prepareGoogleDriveAuthorization()
      .then(() => {
        if (active) setDriveReady(true);
      })
      .catch(() => {
        if (active) setDriveReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!busy) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [busy]);

  const closeDialog = () => {
    if (busy) return;
    if (phase === "offer") {
      setPhase("warning");
      return;
    }
    onClose();
  };

  const startBackup = async (retryPlan = plan) => {
    if (!onBackup || !retryPlan.candidates.length) return;
    setError("");
    setResult(null);
    setProgress(null);
    try {
      setPhase("authorizing");
      await authorizeGoogleDrive();
      setPhase("copying");
      const nextResult = await onBackup(retryPlan, setProgress);
      setResult(nextResult);
      setPhase("result");
    } catch (backupError) {
      setError(
        backupError instanceof Error
          ? backupError.message
          : "Не вдалося підключити Google Drive або розпочати копіювання.",
      );
      setPhase("offer");
    }
  };

  const retryPlan = result?.failures.length
    ? { ...plan, candidates: uniqueFailedCandidates(result) }
    : null;

  return (
    <Modal
      title="Збереження фотографій з GEDCOM"
      className="gedcom-photo-backup-modal"
      onClose={closeDialog}
    >
      <div className="gedcom-photo-backup">
        <div className="gedcom-photo-backup__hero">
          <span className="gedcom-photo-backup__icon" aria-hidden="true">☁</span>
          <div>
            <span className="eyebrow">Імпорт завершено</span>
            <h3>{fileName}</h3>
            <p>Особи, зв’язки, знахідки та дерево вже збережені. Копіювання фото є окремим безпечним кроком.</p>
          </div>
        </div>

        {phase === "warning" ? (
          <section className="gedcom-photo-backup__warning" role="alert">
            <h3>Без копії зовнішні фото можуть зникнути</h3>
            {expiryNotice ? <p>{expiryNotice}</p> : null}
            {plan.missingLocalCount ? (
              <p>
                Ще {plan.missingLocalCount.toLocaleString("uk-UA")} локальних фото з GEDCOM недоступні браузеру вже зараз.
                Їх можна додати пізніше вручну з профілів осіб.
              </p>
            ) : null}
            <p>Метадані й початкові адреси залишаться у профілях, але саме зображення без Drive-копії не гарантується.</p>
            <p>Кеш браузера не має гарантованого строку зберігання й може бути очищений браузером або користувачем у будь-який момент.</p>
            <div className="details-actions">
              {plan.candidates.length && onBackup ? (
                <button type="button" className="button button-primary" onClick={() => setPhase("offer")}>
                  Повернутися і зберегти фото
                </button>
              ) : null}
              <button type="button" className="button button-secondary" onClick={onClose}>
                Зрозуміло, завершити
              </button>
            </div>
          </section>
        ) : phase === "result" && result ? (
          <section className="gedcom-photo-backup__result" aria-live="polite">
            <h3>{result.failures.length ? "Копіювання завершено частково" : "Фотографії збережено"}</h3>
            <div className="gedcom-photo-backup__stats">
              <PhotoStat value={result.copied} label="збережено у Drive" />
              <PhotoStat value={result.failures.length} label="не вдалося" />
              <PhotoStat value={plan.alreadyStoredCount} label="вже були у Drive" />
            </div>
            {result.failures.length ? (
              <div className="gedcom-photo-backup__failures">
                <strong>Не скопійовані фото</strong>
                {result.failures.slice(0, 6).map((failure) => (
                  <p key={`${failure.candidate.personId}:${failure.candidate.photo.id}`}>
                    <b>{failure.candidate.personName}</b>: {failure.candidate.photo.name} — {failure.message}
                  </p>
                ))}
                {result.failures.length > 6 ? <small>Ще помилок: {result.failures.length - 6}.</small> : null}
              </div>
            ) : null}
            <div className="details-actions">
              {retryPlan?.candidates.length ? (
                <button type="button" className="button button-secondary" onClick={() => void startBackup(retryPlan)}>
                  Повторити для невдалих ({retryPlan.candidates.length})
                </button>
              ) : null}
              <button type="button" className="button button-primary" onClick={onClose}>Готово</button>
            </div>
          </section>
        ) : (
          <>
            <div className="gedcom-photo-backup__stats">
              <PhotoStat value={plan.candidates.length} label="можна скопіювати" />
              <PhotoStat value={plan.personCount} label="осіб із фото" />
              <PhotoStat value={plan.missingLocalCount} label="потребують файла" />
              <PhotoStat value={plan.alreadyStoredCount} label="вже у Drive" />
            </div>

            <section className="gedcom-photo-backup__explanation">
              <h3>Зберегти доступні фото у ваш Google Drive?</h3>
              <p>
                Застосунок створить папку <b>Особи / Імпорт GEDCOM / Фото</b> у папці цього проєкту,
                скопіює доступні зображення та автоматично оновить їх у профілях.
              </p>
              {expiryNotice ? <p>{expiryNotice}</p> : null}
              {plan.expiredCount ? (
                <p className="form-error">
                  Для {plan.expiredCount.toLocaleString("uk-UA")} фото зазначений строк уже минув.
                  Спробуємо використати локальну кешовану копію, якщо вона ще є.
                </p>
              ) : null}
              {plan.unsupportedHttpCount ? (
                <p className="form-error">
                  {plan.unsupportedHttpCount.toLocaleString("uk-UA")} незахищених HTTP-посилань не копіюватимуться автоматично.
                </p>
              ) : null}
              {plan.missingLocalCount ? (
                <p>
                  {plan.missingLocalCount.toLocaleString("uk-UA")} локальних шляхів із чужого комп’ютера неможливо прочитати з браузера;
                  ці файли потрібно буде вибрати вручну.
                </p>
              ) : null}
            </section>

            {busy ? (
              <div className="gedcom-import-progress" aria-live="polite">
                <div className="gedcom-import-progress__header">
                  <strong>{phase === "authorizing" ? "Підключаємо Google Drive" : "Зберігаємо фотографії"}</strong>
                  <span>{progressPercent(progress, plan)}%</span>
                </div>
                <div className="gedcom-import-progress__bar">
                  <span style={{ width: `${Math.max(5, progressPercent(progress, plan))}%` }} />
                </div>
                <small>
                  {phase === "authorizing"
                    ? "Підтвердьте доступ у вікні Google."
                    : progress
                      ? `${progress.processed} з ${progress.total}: ${progress.personName} — ${progress.photoName}`
                      : "Готуємо перше фото…"}
                </small>
              </div>
            ) : null}
            {error ? <div className="form-error" role="alert">{error}</div> : null}

            <details className="gedcom-photo-backup__import-summary">
              <summary>Підсумок основного імпорту</summary>
              <pre>{importSummary}</pre>
            </details>

            <div className="details-actions">
              {plan.candidates.length && onBackup ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy || (!driveReady && !isGoogleDriveAuthorized())}
                  onClick={() => void startBackup()}
                >
                  {busy
                    ? "Зберігаємо…"
                    : `${isGoogleDriveAuthorized() ? "Зберегти" : "Підключити Google Drive і зберегти"} ${plan.candidates.length.toLocaleString("uk-UA")} фото`}
                </button>
              ) : null}
              <button type="button" className="button button-secondary" disabled={busy} onClick={closeDialog}>
                {plan.candidates.length ? "Не зараз" : "Завершити"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PhotoStat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <strong>{value.toLocaleString("uk-UA")}</strong>
      <span>{label}</span>
    </div>
  );
}

function expirySummary(plan: GedcomPhotoBackupPlan): string {
  if (!plan.candidates.length) return "";
  const parts: string[] = [];
  if (plan.earliestExpiryAt) {
    const expiry = externalLinkExpiry(`https://expiry.invalid/?expires=${encodeURIComponent(plan.earliestExpiryAt)}`);
    parts.push(`Найраніший відомий строк: ${formatExternalLinkExpiry(expiry)}`);
  }
  if (plan.unknownExpiryCount) {
    parts.push(
      `Для ${plan.unknownExpiryCount.toLocaleString("uk-UA")} фото зовнішній сервіс не вказав строк — вони можуть перестати працювати будь-коли.`,
    );
  }
  return parts.join(" ") || "Зовнішній сервіс не вказав строк дії посилань — вони можуть перестати працювати будь-коли.";
}

function progressPercent(
  progress: GedcomPhotoBackupProgress | null,
  plan: GedcomPhotoBackupPlan,
): number {
  if (!progress || !plan.candidates.length) return 5;
  return Math.max(5, Math.min(100, Math.round((progress.processed / plan.candidates.length) * 100)));
}

function uniqueFailedCandidates(result: GedcomPhotoBackupResult) {
  const seen = new Set<string>();
  return result.failures
    .map((failure) => failure.candidate)
    .filter((candidate) => {
      const key = `${candidate.personId}:${candidate.photo.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
