import { useRef, useState } from "react";
import {
  prepareZagulyakyTabularEventImportFile,
  runZagulyakyTabularEventImportCommit,
  runZagulyakyTabularEventImportDryRun,
  zagulyakyTabularEventImportErrorMessage,
  type ZagulyakyTabularEventImportCounts,
  type ZagulyakyTabularEventImportMode,
  type ZagulyakyTabularEventImportSummary,
  type ZagulyakyTabularEventPreparedFile,
} from "../../services/zagulyakyTabularEventImportService.ts";

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

function countMatchesWorkbook(
  counts: ZagulyakyTabularEventImportCounts,
  summary: ZagulyakyTabularEventImportSummary,
): boolean {
  const workbook = summary.workbook;
  return counts.sourcePosts === workbook.sourcePostCount
    && counts.events === workbook.eventCount
    && counts.participants === workbook.participantCount
    && counts.eventSources === workbook.eventSourceCount
    && counts.cards === workbook.cardCount
    && counts.qc === workbook.qcCount
    && counts.eventsWithoutCards === workbook.noCardEventCount;
}

/**
 * Commit is intentionally not inferred from an optimistic request response.
 * The browser requires a complete, count-matching dry run for this exact
 * local file; the browser re-hashes it immediately before commit, and the
 * protected server verifies the matching private batch before it materializes
 * any record.
 */
function canCommitTabularImport(summary: ZagulyakyTabularEventImportSummary | null): boolean {
  return Boolean(
    summary
      && summary.importMode === "dry_run"
      && summary.status === "dry_run_complete"
      && summary.workbook.sourcePostCount > 0
      && countMatchesWorkbook(summary.expectedCounts, summary)
      && countMatchesWorkbook(summary.actualCounts, summary)
      && !summary.lastErrorCode,
  );
}

/**
 * A browser refresh, interrupted connection, or HMR update may happen after
 * the server has moved an already checked batch to `commit_ready`. Resuming
 * that exact batch must remain possible without re-uploading XLSX rows.
 */
function canResumeTabularImport(summary: ZagulyakyTabularEventImportSummary | null): boolean {
  return Boolean(
    summary
      && summary.importMode === "commit"
      && (summary.status === "commit_ready" || summary.status === "commit_materializing")
      && summary.workbook.sourcePostCount > 0
      && countMatchesWorkbook(summary.expectedCounts, summary)
      && countMatchesWorkbook(summary.actualCounts, summary)
      && !summary.lastErrorCode,
  );
}

export function ZagulyakyTabularEventImportCard({ onOpenDrafts }: { onOpenDrafts?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionRevisionRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<ZagulyakyTabularEventPreparedFile | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [runningMode, setRunningMode] = useState<ZagulyakyTabularEventImportMode | null>(null);
  const [commitConfirmed, setCommitConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ZagulyakyTabularEventImportSummary | null>(null);
  const running = runningMode !== null;
  const commitAvailable = Boolean(file && prepared && canCommitTabularImport(summary));
  const commitResumeAvailable = Boolean(file && prepared && canResumeTabularImport(summary));
  const materializationAvailable = commitAvailable || commitResumeAvailable;
  const isCommitResume = summary?.importMode === "commit";

  const clearSelection = () => {
    selectionRevisionRef.current += 1;
    if (inputRef.current) inputRef.current.value = "";
    setFile(null);
    setPrepared(null);
    setCommitConfirmed(false);
    setError("");
    setSummary(null);
  };

  const selectFile = async (nextFile: File | null) => {
    const revision = selectionRevisionRef.current + 1;
    selectionRevisionRef.current = revision;
    setFile(null);
    setPrepared(null);
    setCommitConfirmed(false);
    setSummary(null);
    setError("");
    if (!nextFile) return;

    setPreparing(true);
    try {
      const nextPrepared = await prepareZagulyakyTabularEventImportFile(nextFile);
      if (selectionRevisionRef.current !== revision) return;
      setFile(nextFile);
      setPrepared(nextPrepared);
    } catch (selectionError) {
      if (selectionRevisionRef.current !== revision) return;
      setError(zagulyakyTabularEventImportErrorMessage(selectionError));
    } finally {
      if (selectionRevisionRef.current === revision) setPreparing(false);
    }
  };

  const runDryRun = async () => {
    if (!file || !prepared || running || preparing) return;
    setRunningMode("dry_run");
    setCommitConfirmed(false);
    setError("");
    setSummary(null);
    try {
      setSummary(await runZagulyakyTabularEventImportDryRun(file));
    } catch (requestError) {
      setError(zagulyakyTabularEventImportErrorMessage(requestError, "dry_run"));
    } finally {
      setRunningMode(null);
    }
  };

  const runCommit = async () => {
    if (!file || !prepared || !summary || !materializationAvailable || !commitConfirmed || running || preparing) return;
    setRunningMode("commit");
    setError("");
    try {
      setSummary(await runZagulyakyTabularEventImportCommit(file, summary, prepared));
    } catch (requestError) {
      setError(zagulyakyTabularEventImportErrorMessage(requestError, "commit"));
    } finally {
      // A later commit or retry always needs a fresh explicit acknowledgement.
      setCommitConfirmed(false);
      setRunningMode(null);
    }
  };

  return (
    <section className="admin-panel-card zagulyaky-stage0-import zagulyaky-tabular-import" aria-label="Приватний імпорт подієвої XLSX-таблиці">
      <div className="admin-card-heading">
        <div>
          <span className="eyebrow">Початкова база · XLSX · приватний staging</span>
          <h2>Імпорт подій і карток Загуляк</h2>
          <p>
            Використовуйте перевірену подієву таблицю XLSX. Браузер локально перевіряє всі аркуші й зв’язки,
            а сервер приймає лише малі приватні пакети та зберігає оригінальні дописи й Facebook-посилання тільки у staging.
          </p>
        </div>
      </div>

      <div className="zagulyaky-stage0-import-controls">
        <label className="zagulyaky-stage0-file-label">
          <span>Заповнений XLSX-шаблон подій</span>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={preparing || running}
            onChange={(event) => void selectFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        {file ? (
          <button type="button" className="button button-secondary" disabled={preparing || running} onClick={clearSelection}>
            Очистити вибір
          </button>
        ) : null}
      </div>

      {preparing ? <p className="zagulyaky-stage0-pending" role="status">Локально обчислюємо SHA-256 XLSX-файла…</p> : null}
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
        <span>Dry run не створює публічних карток, не публікує текстів і не відкриває Facebook-посилань.</span>
      </div>

      {error ? <div className="admin-alert error" role="alert">{error}</div> : null}
      {summary ? <TabularImportSummary summary={summary} onOpenDrafts={onOpenDrafts} /> : null}

      {materializationAvailable && summary ? (
        <section className="zagulyaky-stage0-commit-confirmation" aria-labelledby="zagulyaky-tabular-import-commit-title">
          <div>
            <span className="eyebrow">{isCommitResume ? "Продовження · тільки чернетки" : "Наступний крок · тільки чернетки"}</span>
            <h3 id="zagulyaky-tabular-import-commit-title">
              {isCommitResume
                ? "Продовжіть створення приватних чернеток із перевіреного staging"
                : "Підтвердіть створення чернеток із перевіреного staging"}
            </h3>
            <p>
              {isCommitResume
                ? "Сервер продовжить лише незавершені bounded-кроки вже перевіреного private staging. XLSX-рядки не надсилаються повторно."
                : "Commit локально повторно перевірить SHA-256 цього самого XLSX, а сервер звірить його з private staging і матеріалізує тільки непублічні записи у статусі «Чернетка» / «Не перевірено»."}
              {" Автоматичного об’єднання, публікації, відкритих URL джерел або вкладень не буде."}
            </p>
          </div>
          <dl>
            <div><dt>Карток у staging</dt><dd>{summary.actualCounts.cards.toLocaleString("uk-UA")}</dd></div>
            <div><dt>Подій без карток</dt><dd>{summary.actualCounts.eventsWithoutCards.toLocaleString("uk-UA")}</dd></div>
          </dl>
          <label className="zagulyaky-stage0-commit-acknowledgement">
            <input
              type="checkbox"
              checked={commitConfirmed}
              disabled={running}
              onChange={(event) => setCommitConfirmed(event.target.checked)}
            />
            <span>
              Я підтверджую створення приватних чернеток із цього перевіреного XLSX і розумію,
              що кожна картка потребує окремої модерації перед публікацією.
            </span>
          </label>
          <div className="zagulyaky-stage0-import-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!commitConfirmed || running}
              onClick={() => void runCommit()}
            >
              {runningMode === "commit"
                ? "Створюємо приватні чернетки…"
                : isCommitResume
                ? "Підтвердити й продовжити створення чернеток"
                : "Підтвердити й створити приватні чернетки"}
            </button>
            <span>Commit не передає XLSX-рядки повторно: використовується лише перевірений приватний staging.</span>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function TabularImportSummary({
  summary,
  onOpenDrafts,
}: {
  summary: ZagulyakyTabularEventImportSummary;
  onOpenDrafts?: () => void;
}) {
  const isCommit = summary.importMode === "commit";
  const hasFailures = Boolean(summary.lastErrorCode) || summary.actualCounts.failedCards > 0 || summary.status === "completed_with_errors";
  const isComplete = isCommit && summary.status === "completed" && summary.remainingCardCount === 0;
  const heading = isComplete
    ? "Commit у приватні чернетки завершено"
    : isCommit && hasFailures
    ? "Commit завершено з зауваженнями"
    : isCommit
    ? "Commit виконується"
    : hasFailures
    ? "Dry run завершено з зауваженнями"
    : "Dry run завершено";
  const description = summary.replayed
    ? "Для цього самого XLSX використано попередній безпечний результат."
    : isComplete
    ? "Створено лише непублічні чернетки. Оригінальні дописи й приватні Facebook-посилання не стали публічними."
    : isCommit
    ? "Сервер продовжує контрольоване створення чернеток із приватного staging. Публічних карток не створено."
    : "Усі дані перевірені у приватному staging. Публічних карток не створено.";
  const completedAt = isCommit ? summary.completedAt : summary.dryRunCompletedAt;

  return (
    <section className={`zagulyaky-stage0-result ${hasFailures ? "has-warnings" : ""}`} role="status" aria-live="polite">
      <div>
        <h3>{heading}</h3>
        <p>{description}</p>
      </div>
      <dl>
        <div><dt>Статус</dt><dd>{summary.status}</dd></div>
        <div><dt>Дописи</dt><dd>{summary.actualCounts.sourcePosts.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Події</dt><dd>{summary.actualCounts.events.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Учасники</dt><dd>{summary.actualCounts.participants.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Картки</dt><dd>{summary.actualCounts.cards.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Готові / на перевірці</dt><dd>{summary.workbook.readyCardCount.toLocaleString("uk-UA")} / {summary.workbook.needsReviewCardCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Створено чернеток</dt><dd>{summary.actualCounts.materializedCards.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Залишилося</dt><dd>{summary.remainingCardCount.toLocaleString("uk-UA")}</dd></div>
        <div><dt>Завершено</dt><dd>{formatDate(completedAt)}</dd></div>
      </dl>
      {summary.lastErrorCode ? <p className="zagulyaky-stage0-result-error">Код технічної помилки: <code>{summary.lastErrorCode}</code></p> : null}
      {isComplete && onOpenDrafts ? (
        <div className="zagulyaky-stage0-import-actions">
          <button type="button" className="button button-secondary" onClick={onOpenDrafts}>Переглянути створені чернетки</button>
          <span>Відкриє «Записи» з фільтром «Чернетка» та оновить чергу модерації.</span>
        </div>
      ) : null}
    </section>
  );
}
