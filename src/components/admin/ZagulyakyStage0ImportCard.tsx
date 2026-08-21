import { useRef, useState } from "react";
import {
  prepareZagulyakyStage0File,
  runZagulyakyStage0Commit,
  runZagulyakyStage0DryRun,
  runZagulyakyStage0Recovery,
  zagulyakyStage0ImportErrorMessage,
  type ZagulyakyStage0ImportMode,
  type ZagulyakyStage0ImportSummary,
  type ZagulyakyStage0PreparedFile,
} from "../../services/zagulyakyStage0ImportService.ts";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1) return "0 Б";
  if (value < 1024) return `${Math.trunc(value)} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(2)} МіБ`;
}

function formatDate(value: string | null): string {
  if (!value) return "ще виконується";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "зафіксовано" : date.toLocaleString("uk-UA");
}

function canCommitPrivateStaging(summary: ZagulyakyStage0ImportSummary | null): boolean {
  return Boolean(
    summary
      && summary.importMode === "dry_run"
      && summary.status === "dry_run_complete"
      && summary.expectedItemCount > 0
      && summary.processedItemCount === summary.expectedItemCount
      && summary.stagedItemCount === 0
      && summary.failedItemCount === 0
      && !summary.lastErrorCode,
  );
}

/**
 * Recovery is deliberately more restrictive than the ordinary commit step.
 * The server gives this capability only for the exact, reselected source file
 * and only when its private batch can be resumed safely. Do not infer it from
 * counters or the status alone: that would make an old server look capable of
 * recovery even though a repeat commit would merely replay its old result.
 */
function canRecoverPrivateStaging(summary: ZagulyakyStage0ImportSummary | null): boolean {
  return Boolean(
    summary
      && summary.importMode === "commit"
      && summary.status === "completed_with_errors"
      && summary.replayed
      && summary.recoveryAvailable
      && summary.expectedItemCount > 0
      && summary.processedItemCount === summary.expectedItemCount
      && summary.failedItemCount > 0,
  );
}

export function ZagulyakyStage0ImportCard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionRevisionRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<ZagulyakyStage0PreparedFile | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [runningMode, setRunningMode] = useState<ZagulyakyStage0ImportMode | null>(null);
  const [commitConfirmed, setCommitConfirmed] = useState(false);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ZagulyakyStage0ImportSummary | null>(null);
  const running = runningMode !== null;
  const commitAvailable = Boolean(file && prepared && canCommitPrivateStaging(summary));
  const recoveryAvailable = Boolean(file && prepared && canRecoverPrivateStaging(summary));

  const clearSelection = () => {
    selectionRevisionRef.current += 1;
    if (inputRef.current) inputRef.current.value = "";
    setFile(null);
    setPrepared(null);
    setCommitConfirmed(false);
    setRecoveryConfirmed(false);
    setError("");
    setSummary(null);
  };

  const selectFile = async (nextFile: File | null) => {
    const revision = selectionRevisionRef.current + 1;
    selectionRevisionRef.current = revision;
    setFile(null);
    setPrepared(null);
    setCommitConfirmed(false);
    setRecoveryConfirmed(false);
    setSummary(null);
    setError("");
    if (!nextFile) return;

    setPreparing(true);
    try {
      const nextPrepared = await prepareZagulyakyStage0File(nextFile);
      if (selectionRevisionRef.current !== revision) return;
      setFile(nextFile);
      setPrepared(nextPrepared);
    } catch (selectionError) {
      if (selectionRevisionRef.current !== revision) return;
      setError(zagulyakyStage0ImportErrorMessage(selectionError));
    } finally {
      if (selectionRevisionRef.current === revision) setPreparing(false);
    }
  };

  const runDryRun = async () => {
    if (!file || !prepared || running || preparing) return;
    setRunningMode("dry_run");
    setCommitConfirmed(false);
    setRecoveryConfirmed(false);
    setError("");
    setSummary(null);
    try {
      const nextSummary = await runZagulyakyStage0DryRun(file);
      setSummary(nextSummary);
    } catch (requestError) {
      setError(zagulyakyStage0ImportErrorMessage(requestError, "dry_run"));
    } finally {
      setRunningMode(null);
    }
  };

  const runCommit = async () => {
    if (!file || !prepared || !commitAvailable || !commitConfirmed || running || preparing) return;
    setRunningMode("commit");
    setError("");
    try {
      const nextSummary = await runZagulyakyStage0Commit(file);
      setSummary(nextSummary);
    } catch (requestError) {
      setError(zagulyakyStage0ImportErrorMessage(requestError, "commit"));
    } finally {
      // A retry after any completed or interrupted request needs a fresh,
      // deliberate acknowledgement in the local UI.
      setCommitConfirmed(false);
      setRecoveryConfirmed(false);
      setRunningMode(null);
    }
  };

  const runRecovery = async () => {
    if (!file || !prepared || !recoveryAvailable || !recoveryConfirmed || running || preparing) return;
    setRunningMode("commit");
    setError("");
    try {
      // Recovery intentionally uses the same explicitly-supported Edge
      // `commit` mode. The prior replay response and capability marker prove
      // that this selected file is the eligible private batch.
      const nextSummary = await runZagulyakyStage0Recovery(file);
      setSummary(nextSummary);
    } catch (requestError) {
      setError(zagulyakyStage0ImportErrorMessage(requestError, "commit"));
    } finally {
      setRecoveryConfirmed(false);
      setRunningMode(null);
    }
  };

  return (
    <section className="admin-panel-card zagulyaky-stage0-import" aria-label="Контрольний імпорт Facebook-експорту">
      <div className="admin-card-heading">
        <div>
          <span className="eyebrow">Stage 0 · приватний staging</span>
          <h2>Перевірка Facebook-експорту</h2>
          <p>Файл залишається локальним, доки ви не натиснете dry run. Перевірка не створює публічних карток, не публікує текстів і не завантажує Facebook-зображення.</p>
        </div>
      </div>

      <div className="zagulyaky-stage0-import-controls">
        <label className="zagulyaky-stage0-file-label">
          <span>JSON-експорт зі збирача</span>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            disabled={preparing || running}
            onChange={(event) => void selectFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        {file ? <button type="button" className="button button-secondary" disabled={preparing || running} onClick={clearSelection}>Очистити вибір</button> : null}
      </div>

      {preparing ? <p className="zagulyaky-stage0-pending" role="status">Локально обчислюємо SHA-256 файла…</p> : null}
      {prepared ? (
        <dl className="zagulyaky-stage0-file-summary">
          <div><dt>Файл</dt><dd>{prepared.fileName}</dd></div>
          <div><dt>Розмір</dt><dd>{formatBytes(prepared.byteSize)}</dd></div>
          <div className="wide"><dt>SHA-256</dt><dd><code>{prepared.checksum}</code></dd></div>
        </dl>
      ) : null}

      <div className="zagulyaky-stage0-import-actions">
        <button type="button" className="button button-primary" disabled={!prepared || preparing || running} onClick={() => void runDryRun()}>
          {runningMode === "dry_run" ? "Виконуємо dry run…" : "Запустити dry run"}
        </button>
        <span>Спершу виконайте контрольну перевірку. Кнопка commit з’явиться лише для повного dry run без помилок.</span>
      </div>

      {error ? <div className="admin-alert error" role="alert">{error}</div> : null}
      {summary ? <ImportSummary summary={summary} /> : null}
      {commitAvailable && summary ? (
        <section className="zagulyaky-stage0-commit-confirmation" aria-labelledby="zagulyaky-stage0-commit-title">
          <div>
            <span className="eyebrow">Наступний крок · приватний staging</span>
            <h3 id="zagulyaky-stage0-commit-title">Підтвердіть завантаження перевіреного файла</h3>
            <p>
              Commit передасть цей самий оригінальний JSON до закритого staging для модерації.
              Публічних карток і Facebook-зображень він не створює.
            </p>
          </div>
          <dl>
            <div><dt>До обробки</dt><dd>{summary.expectedItemCount.toLocaleString("uk-UA")}</dd></div>
            <div><dt>Очікувано в quarantine</dt><dd>{summary.quarantinedItemCount.toLocaleString("uk-UA")}</dd></div>
          </dl>
          <label className="zagulyaky-stage0-commit-acknowledgement">
            <input
              type="checkbox"
              checked={commitConfirmed}
              disabled={running}
              onChange={(event) => setCommitConfirmed(event.target.checked)}
            />
            <span>
              Я підтверджую завантаження цього перевіреного файла до приватного staging і розумію,
              що вихідні дані стануть доступні лише уповноваженим модераторам.
            </span>
          </label>
          <div className="zagulyaky-stage0-import-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!commitConfirmed || running}
              onClick={() => void runCommit()}
            >
              {runningMode === "commit" ? "Завантажуємо до приватного staging…" : "Підтвердити й завантажити до приватного staging"}
            </button>
            <span>Перед надсиланням SHA-256 оригінального файла буде обчислено повторно.</span>
          </div>
        </section>
      ) : null}
      {recoveryAvailable && summary ? (
        <section className="zagulyaky-stage0-commit-confirmation zagulyaky-stage0-recovery-confirmation" aria-labelledby="zagulyaky-stage0-recovery-title">
          <div>
            <span className="eyebrow">Відновлення · приватний staging</span>
            <h3 id="zagulyaky-stage0-recovery-title">Спробувати відновити незбережену частину</h3>
            <p>
              Сервер підтвердив, що цей самий файл можна безпечно повторно обробити у приватному staging.
              Уже збережені записи не дублюватимуться; публічних карток і Facebook-зображень ця дія не створює.
            </p>
          </div>
          <dl>
            <div><dt>Уже збережено</dt><dd>{summary.stagedItemCount.toLocaleString("uk-UA")}</dd></div>
            <div><dt>Потребують відновлення</dt><dd>{summary.failedItemCount.toLocaleString("uk-UA")}</dd></div>
          </dl>
          <label className="zagulyaky-stage0-commit-acknowledgement">
            <input
              type="checkbox"
              checked={recoveryConfirmed}
              disabled={running}
              onChange={(event) => setRecoveryConfirmed(event.target.checked)}
            />
            <span>
              Я підтверджую повторну обробку незбереженої частини цього самого файла у приватному staging.
            </span>
          </label>
          <div className="zagulyaky-stage0-import-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!recoveryConfirmed || running}
              onClick={() => void runRecovery()}
            >
              {runningMode === "commit" ? "Відновлюємо у приватному staging…" : "Підтвердити й відновити у приватному staging"}
            </button>
            <span>Перед надсиланням SHA-256 оригінального файла буде обчислено повторно.</span>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function ImportSummary({ summary }: { summary: ZagulyakyStage0ImportSummary }) {
  const isCommit = summary.importMode === "commit";
  const hasFailures = summary.failedItemCount > 0 || Boolean(summary.lastErrorCode);
  const isPartialCommit = isCommit && summary.status === "completed_with_errors";
  const heading = isPartialCommit
    ? "Commit збережено частково"
    : isCommit
    ? hasFailures ? "Commit завершено з зауваженнями" : "Commit у приватний staging завершено"
    : hasFailures ? "Dry run завершено з зауваженнями" : "Dry run завершено";
  const resultDescription = isPartialCommit
    ? `У приватному staging збережено ${summary.stagedItemCount.toLocaleString("uk-UA")} із ${summary.expectedItemCount.toLocaleString("uk-UA")} дописів. ${summary.failedItemCount.toLocaleString("uk-UA")} не збережено через помилки; ${summary.quarantinedItemCount.toLocaleString("uk-UA")} позначено для quarantine. Публічних карток не створено.`
    : summary.replayed
    ? `Використано попередній безпечний результат ${isCommit ? "commit" : "dry run"} для цього самого файла.`
    : isCommit
    ? "Вихідні дані збережено лише у приватному staging. Публічних карток не створено."
    : "Публічних карток не створено.";
  const completedAt = isCommit ? summary.completedAt : summary.dryRunCompletedAt;
  return (
    <section className={`zagulyaky-stage0-result ${hasFailures ? "has-warnings" : ""}`} role="status" aria-live="polite">
      <div>
        <h3>{heading}</h3>
        <p>{resultDescription}</p>
      </div>
      <dl>
        <div><dt>Статус</dt><dd>{summary.status}</dd></div>
        <div><dt>Очікувано дописів</dt><dd>{summary.expectedItemCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Оброблено</dt><dd>{summary.processedItemCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>У staging</dt><dd>{summary.stagedItemCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Дублі</dt><dd>{summary.duplicateItemCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Quarantine</dt><dd>{summary.quarantinedItemCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Помилки</dt><dd>{summary.failedItemCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Завершено</dt><dd>{formatDate(completedAt)}</dd></div>
      </dl>
      {summary.lastErrorCode ? <p className="zagulyaky-stage0-result-error">Код технічної помилки: <code>{summary.lastErrorCode}</code></p> : null}
    </section>
  );
}
