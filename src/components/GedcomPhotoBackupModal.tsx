import { useEffect, useMemo, useRef, useState } from "react";
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
import { attachLocalGedcomPhotoFiles } from "../services/gedcomPhotoBackup.ts";
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
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const localSelection = useMemo(
    () => attachLocalGedcomPhotoFiles(plan, localFiles),
    [localFiles, plan],
  );
  const effectivePlan = localSelection.plan;
  const busy = phase === "authorizing" || phase === "copying";
  const expiryNotice = useMemo(() => expirySummary(effectivePlan), [effectivePlan]);

  useEffect(() => {
    // Warm up Google Identity Services, but never leave the consent button
    // permanently disabled when the preload fails. The click path retries and
    // can then show the real authorization error to the user.
    void prepareGoogleDriveAuthorization().catch(() => undefined);
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

  const startBackup = async (
    retryPlan = effectivePlan,
    previousResult: GedcomPhotoBackupResult | null = null,
  ) => {
    if (!onBackup || !retryPlan.candidates.length) return;
    setError("");
    setResult(null);
    setProgress(null);
    try {
      setPhase("authorizing");
      await authorizeGoogleDrive();
      setPhase("copying");
      const nextResult = await onBackup(retryPlan, setProgress);
      setResult(previousResult
        ? mergeBackupResults(previousResult, nextResult, retryPlan)
        : nextResult);
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
    ? { ...effectivePlan, candidates: uniqueFailedCandidates(result) }
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
            {effectivePlan.missingLocalCount ? (
              <p>
                Ще {effectivePlan.missingLocalCount.toLocaleString("uk-UA")} локальних фото з GEDCOM недоступні браузеру вже зараз.
                Їх можна додати пізніше вручну з профілів осіб.
              </p>
            ) : null}
            <p>Метадані й початкові адреси залишаться у профілях, але саме зображення без Drive-копії не гарантується.</p>
            <p>Кеш браузера не має гарантованого строку зберігання й може бути очищений браузером або користувачем у будь-який момент.</p>
            <div className="details-actions">
              {effectivePlan.candidates.length && onBackup ? (
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
              <PhotoStat value={effectivePlan.alreadyStoredCount} label="вже були у Drive" />
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
                <button type="button" className="button button-secondary" onClick={() => void startBackup(retryPlan, result)}>
                  Повторити для невдалих ({retryPlan.candidates.length})
                </button>
              ) : null}
              <button type="button" className="button button-primary" onClick={onClose}>Готово</button>
            </div>
          </section>
        ) : (
          <>
            <div className="gedcom-photo-backup__stats">
              <PhotoStat value={effectivePlan.candidates.length} label="можна скопіювати" />
              <PhotoStat value={effectivePlan.personCount} label="осіб із фото" />
              <PhotoStat value={effectivePlan.missingLocalCount} label="потребують файла" />
              <PhotoStat value={effectivePlan.alreadyStoredCount} label="вже у Drive" />
            </div>

            <section className="gedcom-photo-backup__explanation">
              <h3>Зберегти доступні фото у ваш Google Drive?</h3>
              <p>
                Застосунок створить папку <b>Особи / Імпорт GEDCOM / Фото</b> у папці цього проєкту,
                скопіює доступні зображення та автоматично оновить їх у профілях.
              </p>
              {!isGoogleDriveAuthorized() ? (
                <p>
                  Google попросить дозволи створювати файли застосунку та переглядати Drive для наявної функції вибору документів.
                  Під час цього пакетного кроку застосунок читає лише імпортовані фото й створює їх копії у папці проєкту.
                </p>
              ) : null}
              {expiryNotice ? <p>{expiryNotice}</p> : null}
              {effectivePlan.expiredCount ? (
                <p className="form-error">
                  Для {effectivePlan.expiredCount.toLocaleString("uk-UA")} фото зазначений строк уже минув.
                  Спробуємо використати локальну кешовану копію, якщо вона ще є.
                </p>
              ) : null}
              {effectivePlan.unsupportedHttpCount ? (
                <p className="form-error">
                  {effectivePlan.unsupportedHttpCount.toLocaleString("uk-UA")} незахищених HTTP-посилань не копіюватимуться автоматично.
                </p>
              ) : null}
              {effectivePlan.missingLocalCount ? (
                <p>
                  {effectivePlan.missingLocalCount.toLocaleString("uk-UA")} локальних шляхів із GEDCOM ще не зіставлено з файлами на цьому комп’ютері.
                </p>
              ) : null}
            </section>

            {plan.localCandidates.length ? (
              <section className="gedcom-photo-backup__local-files">
                <h3>Локальні фото з GEDCOM</h3>
                <p>
                  Виберіть папку з фотографіями або кілька файлів одразу. Застосунок зіставить їх за шляхом,
                  назвою файла та ідентифікатором GEDCOM; неоднозначні збіги не завантажуватимуться.
                </p>
                <input
                  ref={(node) => {
                    directoryInputRef.current = node;
                    node?.setAttribute("webkitdirectory", "");
                  }}
                  type="file"
                  accept="image/*,.tif,.tiff,.bmp"
                  multiple
                  disabled={busy}
                  hidden
                  onChange={(event) => {
                    setLocalFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <input
                  id="gedcom-photo-local-files"
                  type="file"
                  accept="image/*,.tif,.tiff,.bmp"
                  multiple
                  disabled={busy}
                  hidden
                  onChange={(event) => {
                    setLocalFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <div className="details-actions">
                  <button type="button" className="button button-secondary" disabled={busy} onClick={() => directoryInputRef.current?.click()}>
                    Вибрати папку
                  </button>
                  <label className="button button-secondary" htmlFor="gedcom-photo-local-files" aria-disabled={busy || undefined}>
                    Вибрати кілька фото
                  </label>
                </div>
                {localFiles.length ? (
                  <p role="status">
                    Зіставлено: {localSelection.matchedCount.toLocaleString("uk-UA")} із {plan.localCandidates.length.toLocaleString("uk-UA")}.
                    {localSelection.unmatchedCount ? ` Не знайдено або неоднозначні: ${localSelection.unmatchedCount.toLocaleString("uk-UA")}.` : " Усі локальні фото знайдено."}
                  </p>
                ) : null}
              </section>
            ) : null}

            {busy ? (
              <div className="gedcom-import-progress" aria-live="polite">
                <div className="gedcom-import-progress__header">
                  <strong>{phase === "authorizing" ? "Підключаємо Google Drive" : "Зберігаємо фотографії"}</strong>
                  <span>{progressPercent(progress)}%</span>
                </div>
                <div
                  className="gedcom-import-progress__bar"
                  role="progressbar"
                  aria-label="Прогрес збереження фотографій"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent(progress)}
                >
                  <span style={{ width: `${progressPercent(progress)}%` }} />
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
              {effectivePlan.candidates.length && onBackup ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void startBackup()}
                >
                  {busy
                    ? "Зберігаємо…"
                    : `${isGoogleDriveAuthorized() ? "Зберегти" : "Підключити Google Drive і зберегти"} ${effectivePlan.candidates.length.toLocaleString("uk-UA")} фото`}
                </button>
              ) : null}
              <button type="button" className="button button-secondary" disabled={busy} onClick={closeDialog}>
                {effectivePlan.candidates.length ? "Не зараз" : "Завершити"}
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
): number {
  if (!progress || !progress.total) return 5;
  return Math.max(5, Math.min(100, Math.round((progress.processed / progress.total) * 100)));
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

function mergeBackupResults(
  previous: GedcomPhotoBackupResult,
  next: GedcomPhotoBackupResult,
  retryPlan: GedcomPhotoBackupPlan,
): GedcomPhotoBackupResult {
  const retried = new Set(retryPlan.candidates.map(candidateKey));
  const updatedPersons = new Map(
    [...previous.updatedPersons, ...next.updatedPersons].map((person) => [person.id, person]),
  );
  return {
    requested: previous.requested,
    copied: previous.copied + next.copied,
    uploaded: previous.uploaded + next.uploaded,
    failures: [
      ...previous.failures.filter((failure) => !retried.has(candidateKey(failure.candidate))),
      ...next.failures,
    ],
    updatedPersons: [...updatedPersons.values()],
  };
}

function candidateKey(candidate: GedcomPhotoBackupPlan["candidates"][number]): string {
  return `${candidate.personId}:${candidate.deduplicationKey}`;
}
