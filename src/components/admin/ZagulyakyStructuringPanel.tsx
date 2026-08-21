import { useEffect, useMemo, useState } from "react";
import {
  loadZagulyakyStructuringCandidates,
  loadZagulyakyStructuringRuns,
  processMyZagulyakyStructuringRun,
  retryFailedZagulyakyStructuringTasks,
  startZagulyakyStructuringRun,
  ZagulyakyStructuringError,
  zagulyakyStructuringErrorMessage,
  ZAGULYAKY_STRUCTURING_MAX_ITEM_LIMIT,
  ZAGULYAKY_STRUCTURING_PILOT_LIMIT,
  type ZagulyakyStructuringCandidate,
  type ZagulyakyStructuringCandidateKind,
  type ZagulyakyStructuringCandidateStatus,
  type ZagulyakyStructuringRun,
} from "../../services/zagulyakyStructuringService.ts";
import "./ZagulyakyModerationPanel.css";

const RUN_PAGE_LIMIT = 25;
const CANDIDATE_PAGE_LIMIT = 25;

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "У черзі",
  processing: "Обробляється",
  completed: "Завершено",
  completed_with_errors: "Завершено з зауваженнями",
  failed: "Не завершено",
  cancelled: "Скасовано",
  unknown: "Невідомий стан",
};

const CANDIDATE_KIND_LABELS: Record<ZagulyakyStructuringCandidateKind, string> = {
  person: "Людина · витягнутий факт",
  document: "Документ · витягнутий факт",
  unknown: "Потребує класифікації",
};

const CANDIDATE_STATUS_LABELS: Record<ZagulyakyStructuringCandidateStatus, string> = {
  proposed: "Пропозиція",
  materialized: "Чернетку створено раніше",
  rejected: "Відхилено",
  superseded: "Замінено новішою пропозицією",
  unknown: "Невідомий стан",
};

function formatCount(value: number): string {
  return Math.max(0, value).toLocaleString("uk-UA");
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("uk-UA");
}

function formatConfidence(value: number | null): string {
  return value === null ? "—" : `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function isRunTerminal(run: ZagulyakyStructuringRun): boolean {
  return run.status === "completed" || run.status === "completed_with_errors" || run.status === "failed" || run.status === "cancelled";
}

function isContractUnavailable(error: unknown): boolean {
  const text = error && typeof error === "object"
    ? `${String((error as { code?: unknown }).code ?? "")} ${String((error as { message?: unknown }).message ?? "")}`
    : String(error ?? "");
  return /PGRST202|42883|admin_(?:start|get|list)_zagulyaky_structuring/iu.test(text);
}

function privateStructuringError(error: unknown): string {
  if (isContractUnavailable(error)) {
    return "Автоматичне структурування ще не доступне у робочій базі. Потрібна окрема серверна міграція та Edge-функція; жодні тексти не передано до AI.";
  }
  return zagulyakyStructuringErrorMessage(error);
}

function storedTaskError(run: ZagulyakyStructuringRun): string {
  if (!run.lastErrorCode) {
    return "Одна або кілька приватних задач завершилися помилкою. Текст допису й дані Facebook не показуються; оновіть стан або зверніться до адміністратора.";
  }
  return `${zagulyakyStructuringErrorMessage(new ZagulyakyStructuringError(run.lastErrorCode))} Код перевірки: ${run.lastErrorCode}.`;
}

/**
 * Stage 1 enriches private source-post cards, never the public catalogue.
 * The operator must acknowledge the external Gemini processing at start. All
 * extracted facts stay attached to their original private post.
 */
export function ZagulyakyStructuringPanel({
  batchId,
  sourceFileName,
  batchCompleted,
}: {
  batchId: string;
  sourceFileName: string;
  batchCompleted: boolean;
}) {
  const [runs, setRuns] = useState<ZagulyakyStructuringRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsReload, setRunsReload] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [run, setRun] = useState<ZagulyakyStructuringRun | null>(null);
  const [itemLimit, setItemLimit] = useState(ZAGULYAKY_STRUCTURING_PILOT_LIMIT);
  const [consentChecked, setConsentChecked] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [processBusy, setProcessBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [candidateKind, setCandidateKind] = useState<ZagulyakyStructuringCandidateKind | "">("");
  const [candidateStatus, setCandidateStatus] = useState<ZagulyakyStructuringCandidateStatus | "">("");
  const [candidateQueryDraft, setCandidateQueryDraft] = useState("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [candidateReload, setCandidateReload] = useState(0);
  const [candidates, setCandidates] = useState<ZagulyakyStructuringCandidate[]>([]);
  const [candidatesTotal, setCandidatesTotal] = useState(0);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    setRunsLoading(true);
    setError("");
    void loadZagulyakyStructuringRuns(batchId, null, RUN_PAGE_LIMIT, 0)
      .then((page) => {
        if (!active) return;
        setRuns(page.items);
        setSelectedRunId((current) => current && page.items.some((item) => item.id === current)
          ? current
          : page.items[0]?.id ?? "");
      })
      .catch((requestError) => {
        if (!active) return;
        setRuns([]);
        setSelectedRunId("");
        setRun(null);
        setError(privateStructuringError(requestError));
      })
      .finally(() => { if (active) setRunsLoading(false); });
    return () => { active = false; };
  }, [batchId, runsReload]);

  useEffect(() => {
    setRun(runs.find((item) => item.id === selectedRunId) ?? null);
    setCandidateOffset(0);
    setCandidates([]);
    setCandidatesTotal(0);
    setRetryConfirmed(false);
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) return;
    let active = true;
    setCandidatesLoading(true);
    setError("");
    void loadZagulyakyStructuringCandidates({
      runId: selectedRunId,
      kind: candidateKind || null,
      status: candidateStatus || null,
      query: candidateQuery,
      limit: CANDIDATE_PAGE_LIMIT,
      offset: candidateOffset,
    })
      .then((page) => {
        if (!active) return;
        setCandidates(page.items);
        setCandidatesTotal(page.total);
      })
      .catch((requestError) => { if (active) setError(privateStructuringError(requestError)); })
      .finally(() => { if (active) setCandidatesLoading(false); });
    return () => { active = false; };
  }, [candidateKind, candidateOffset, candidateQuery, candidateReload, candidateStatus, selectedRunId]);

  const canExpand = Boolean(run && (run.succeededCount > 0 || run.candidateCount > 0 || isRunTerminal(run)));
  // A terminal provider/configuration failure pauses new text transfers. The
  // operator must explicitly requeue only the failed task after repairing the
  // external configuration; remaining queued posts stay untouched meanwhile.
  const canProcess = Boolean(run && run.failedCount === 0 && !isRunTerminal(run) && (run.queuedCount > 0 || run.processingCount > 0));
  const canRetryFailedTasks = Boolean(run && run.failedCount > 0 && Boolean(run.lastErrorCode));
  const pageStart = candidatesTotal ? candidateOffset + 1 : 0;
  const pageEnd = Math.min(candidateOffset + candidates.length, candidatesTotal);

  const refreshRuns = () => setRunsReload((value) => value + 1);

  const startRun = async () => {
    if (!batchCompleted || !consentChecked || startBusy) return;
    setStartBusy(true);
    setError("");
    setSuccess("");
    try {
      const nextRun = await startZagulyakyStructuringRun({ batchId, itemLimit, explicitConsent: true });
      setRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]);
      setSelectedRunId(nextRun.id);
      setRun(nextRun);
      setConsentChecked(false);
      setSuccess(`Створено приватний запуск: до ${formatCount(nextRun.selectedItemCount || itemLimit)} текстових дописів. Публічних карток не створено.`);
    } catch (requestError) {
      setError(privateStructuringError(requestError));
    } finally {
      setStartBusy(false);
    }
  };

  const processNext = async () => {
    if (!run || !canProcess || processBusy) return;
    setProcessBusy(true);
    setError("");
    setSuccess("");
    try {
      const nextRun = await processMyZagulyakyStructuringRun(run.id, 1);
      setRuns((current) => current.map((item) => item.id === nextRun.id ? nextRun : item));
      setRun(nextRun);
      setCandidateReload((value) => value + 1);
      if (nextRun.failedCount > run.failedCount) {
        setError(storedTaskError(nextRun));
      } else {
        setSuccess("Опрацьовано один наступний приватний допис. Результати залишаються лише в черзі кандидатів.");
      }
    } catch (requestError) {
      setError(privateStructuringError(requestError));
    } finally {
      setProcessBusy(false);
    }
  };

  const retryFailedTasks = async () => {
    if (!run || !canRetryFailedTasks || !retryConfirmed || retryBusy) return;
    setRetryBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await retryFailedZagulyakyStructuringTasks(run.id, true, 25);
      setRuns((current) => current.map((item) => item.id === result.run.id ? result.run : item));
      setRun(result.run);
      setRetryConfirmed(false);
      setSuccess(
        result.requeuedCount
          ? `Повернуто в приватну чергу: ${formatCount(result.requeuedCount)}. Ліміт спроб не скинуто; текст не надсилатиметься до Google, доки ви окремо не натиснете «Опрацювати наступний допис».`
          : "Немає дозволених terminal-задач для повернення в чергу. Оновіть стан запуску.",
      );
    } catch (requestError) {
      setError(privateStructuringError(requestError));
    } finally {
      setRetryBusy(false);
    }
  };

  const applyCandidateSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCandidateQuery(candidateQueryDraft.trim().slice(0, 160));
    setCandidateOffset(0);
  };

  const currentRunLabel = useMemo(() => run ? `${RUN_STATUS_LABELS[run.status] ?? RUN_STATUS_LABELS.unknown} · ${formatCount(run.candidateCount)} кандидатів` : "Запуск не вибрано", [run]);

  return (
    <section className="admin-panel-card zagulyaky-structuring" aria-label="Автоматичне приватне структурування дописів">
      <div className="admin-card-heading">
        <div>
          <span className="eyebrow">Stage 1 · приватна початкова база</span>
          <h2>Автоматично виділити факти у приватних дописах</h2>
          <p>
            Один допис лишається однією приватною карткою початкової бази. Модель лише додає до неї
            витягнуті ПІБ, ролі, походження й відомості про документи; вона не створює карток каталогу,
            не публікує, не зливає людей і не завантажує зображення.
          </p>
        </div>
        <button type="button" className="button button-secondary" disabled={runsLoading || startBusy || processBusy || retryBusy} onClick={refreshRuns}>Оновити стан</button>
      </div>

      <dl className="zagulyaky-structuring-batch-facts">
        <div><dt>Пакет</dt><dd>{sourceFileName}</dd></div>
        <div><dt>Запусків</dt><dd>{formatCount(runs.length)}</dd></div>
        <div><dt>Вибраний запуск</dt><dd>{currentRunLabel}</dd></div>
      </dl>

      {!batchCompleted ? <div className="admin-alert error">Структурувати можна лише завершений приватний пакет Stage 0.</div> : null}
      {error ? <div className="admin-alert error" role="alert">{error}</div> : null}
      {success ? <div className="admin-alert zagulyaky-success" role="status">{success}</div> : null}

      <section className="zagulyaky-structuring-start">
        <div>
          <h3>Контрольований запуск</h3>
          <p>
            Спочатку запускайте пілот на 50 текстових дописах. Quarantine, дописи без тексту, дописи з OCR
            та позначені як неповні не передаються до AI.
          </p>
        </div>
        <label>Обсяг цього кроку
          <select
            value={itemLimit}
            disabled={!batchCompleted || startBusy || processBusy || retryBusy}
            onChange={(event) => setItemLimit(Number(event.target.value))}
          >
            <option value={ZAGULYAKY_STRUCTURING_PILOT_LIMIT}>Пілот · 50 дописів</option>
            {canExpand ? <option value={250}>Продовжити до 250 дописів</option> : null}
            {canExpand ? <option value={ZAGULYAKY_STRUCTURING_MAX_ITEM_LIMIT}>Розширити до всіх придатних дописів</option> : null}
          </select>
        </label>
        <label className="zagulyaky-structuring-consent">
          <input
            type="checkbox"
            checked={consentChecked}
            disabled={!batchCompleted || startBusy || processBusy || retryBusy}
            onChange={(event) => setConsentChecked(event.target.checked)}
          />
          <span>
            Підтверджую передачу до Google Gemini лише текстів некарантинних дописів цього приватного пакета
            для доповнення приватних карток дописів витягнутими фактами. Я розумію, що це може використати квоту або кошти Google AI;
            публікацію, подання на модерацію, автоматичне злиття людей і обробку Facebook-зображень не дозволяю.
          </span>
        </label>
        <div className="zagulyaky-structuring-actions">
          <button type="button" className="button button-primary" disabled={!batchCompleted || !consentChecked || startBusy || processBusy || retryBusy} onClick={() => void startRun()}>
            {startBusy ? "Створюємо приватний запуск…" : itemLimit === ZAGULYAKY_STRUCTURING_PILOT_LIMIT ? "Запустити пілот на 50 дописах" : "Розширити приватний запуск"}
          </button>
          <span>До Google не надсилаються Facebook-автор, URL, raw JSON, вкладення чи зображення.</span>
        </div>
      </section>

      {runs.length ? (
        <section className="zagulyaky-structuring-runs" aria-label="Приватні запуски структурування">
          <h3>Запуски</h3>
          <div className="zagulyaky-structuring-run-list">
            {runs.map((item) => (
              <button
                type="button"
                key={item.id}
                className={item.id === selectedRunId ? "selected" : ""}
                onClick={() => setSelectedRunId(item.id)}
              >
                <span>{RUN_STATUS_LABELS[item.status] ?? RUN_STATUS_LABELS.unknown}</span>
                <strong>{formatCount(item.succeededCount)} / {formatCount(item.selectedItemCount)} текстів</strong>
                <small>кандидатів: {formatCount(item.candidateCount)} · людей: {formatCount(item.personCandidateCount)} · документів: {formatCount(item.documentCandidateCount)}</small>
                <small>{formatDate(item.createdAt)}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {run ? (
        <>
          <RunSummary run={run} />
          {canRetryFailedTasks ? (
            <section className="zagulyaky-structuring-recovery">
              <div>
                <h3>Відновити помилкову задачу</h3>
                <p>
                  Повернення в чергу не надсилає допис до Google і не створює карток. Воно лише дозволяє
                  наступну контрольовану спробу з тим самим обмеженим лімітом спроб після виправлення Gemini.
                </p>
              </div>
              <label className="zagulyaky-structuring-consent">
                <input type="checkbox" checked={retryConfirmed} disabled={retryBusy || processBusy || startBusy} onChange={(event) => setRetryConfirmed(event.target.checked)} />
                <span>Підтверджую, що хочу повернути лише невдалі задачі цього приватного запуску в чергу після виправлення налаштувань Gemini.</span>
              </label>
              <button type="button" className="button button-secondary" disabled={!retryConfirmed || retryBusy || processBusy || startBusy} onClick={() => void retryFailedTasks()}>
                {retryBusy ? "Повертаємо в чергу…" : `Повернути до ${formatCount(Math.min(run.failedCount, 25))} помилкових задач у чергу`}
              </button>
            </section>
          ) : null}
          {canProcess ? (
            <section className="zagulyaky-structuring-process">
              <div>
                <h3>Опрацювання пілота</h3>
                <p>Кнопка передає один наступний дозволений текст до Google Gemini та зберігає витягнуті факти лише у приватній картці цього допису.</p>
              </div>
              <button type="button" className="button button-secondary" disabled={processBusy || startBusy || retryBusy} onClick={() => void processNext()}>
                {processBusy ? "Обробляємо наступний допис…" : "Опрацювати наступний допис"}
              </button>
            </section>
          ) : null}

          <section className="zagulyaky-structuring-candidates">
            <div className="admin-card-heading">
              <div><span className="eyebrow">Приватні результати</span><h3>Витягнуті факти про людей і документи</h3></div>
              <span>Знайдено: <strong>{formatCount(candidatesTotal)}</strong></span>
            </div>
            <form className="zagulyaky-structuring-filters" onSubmit={applyCandidateSearch}>
              <label>Пошук у структурованих полях
                <input value={candidateQueryDraft} maxLength={160} onChange={(event) => setCandidateQueryDraft(event.target.value)} placeholder="Ім’я, назва або місце" />
              </label>
              <label>Тип
                <select value={candidateKind} onChange={(event) => { setCandidateKind(event.target.value as ZagulyakyStructuringCandidateKind | ""); setCandidateOffset(0); }}>
                  <option value="">Усі типи</option><option value="person">Люди</option><option value="document">Документи</option>
                </select>
              </label>
              <label>Стан
                <select value={candidateStatus} onChange={(event) => { setCandidateStatus(event.target.value as ZagulyakyStructuringCandidateStatus | ""); setCandidateOffset(0); }}>
                  <option value="">Усі стани</option><option value="proposed">Пропозиції</option><option value="materialized">Чернетки зі старих запусків</option><option value="rejected">Відхилені</option>
                </select>
              </label>
              <button type="submit" className="button button-secondary" disabled={candidatesLoading}>Застосувати</button>
            </form>
            {candidatesLoading ? <div className="admin-loading">Завантажуємо приватні витягнуті факти…</div> : null}
            <div className="zagulyaky-structuring-candidate-list">
              {candidates.map((candidate) => <CandidateCard candidate={candidate} key={candidate.id} />)}
              {!candidatesLoading && !candidates.length ? <p>Для поточних фільтрів приватних витягнутих фактів немає.</p> : null}
            </div>
            {candidatesTotal > CANDIDATE_PAGE_LIMIT ? (
              <div className="zagulyaky-staging-pagination">
                <span>{formatCount(pageStart)}–{formatCount(pageEnd)} з {formatCount(candidatesTotal)}</span>
                <button type="button" className="button button-secondary" disabled={candidateOffset === 0 || candidatesLoading} onClick={() => setCandidateOffset((value) => Math.max(0, value - CANDIDATE_PAGE_LIMIT))}>Назад</button>
                <button type="button" className="button button-secondary" disabled={candidateOffset + CANDIDATE_PAGE_LIMIT >= candidatesTotal || candidatesLoading} onClick={() => setCandidateOffset((value) => value + CANDIDATE_PAGE_LIMIT)}>Далі</button>
              </div>
            ) : null}
          </section>

        </>
      ) : null}
    </section>
  );
}

function RunSummary({ run }: { run: ZagulyakyStructuringRun }) {
  return (
    <section className="zagulyaky-structuring-summary" aria-label="Підсумок приватного запуску">
      <dl>
        <div><dt>Статус</dt><dd>{RUN_STATUS_LABELS[run.status] ?? RUN_STATUS_LABELS.unknown}</dd></div>
        <div><dt>Відібрано текстів</dt><dd>{formatCount(run.selectedItemCount)}</dd></div>
        <div><dt>У черзі / обробляється</dt><dd>{formatCount(run.queuedCount)} / {formatCount(run.processingCount)}</dd></div>
        <div><dt>Успішно / з помилкою</dt><dd>{formatCount(run.succeededCount)} / {formatCount(run.failedCount)}</dd></div>
        <div><dt>Люди / документи</dt><dd>{formatCount(run.personCandidateCount)} / {formatCount(run.documentCandidateCount)}</dd></div>
        <div><dt>Картки каталогу</dt><dd>Не створюються автоматично</dd></div>
        <div><dt>Виключено: OCR / quarantine / завеликі</dt><dd>{formatCount(run.excludedOcrCount)} / {formatCount(run.excludedQuarantinedCount)} / {formatCount(run.excludedOversizedCount)}</dd></div>
        <div><dt>Модель</dt><dd>{run.model || "Google Gemini"}</dd></div>
      </dl>
      <p>Створено: {formatDate(run.createdAt)} · завершено: {formatDate(run.completedAt)}</p>
      {run.failedCount > 0 ? (
        <div className="admin-alert error" role="alert">
          <strong>Є невдалі приватні задачі.</strong> {storedTaskError(run)}
        </div>
      ) : null}
    </section>
  );
}

function CandidateCard({ candidate }: { candidate: ZagulyakyStructuringCandidate }) {
  const eventDate = candidate.eventDateText || candidate.eventYearFrom
    ? candidate.eventDateText || [candidate.eventYearFrom, candidate.eventYearTo].filter(Boolean).join("–")
    : "—";
  return (
    <article>
      <div>
        <span className={`zagulyaky-status ${candidate.kind === "person" ? "status-pending_review" : "stage-structured"}`}>{CANDIDATE_KIND_LABELS[candidate.kind]}</span>
        <h4>{candidate.title || "Назва потребує перевірки"}</h4>
        <p>{candidate.classificationReason || "Модель не надала достатньої підстави класифікації."}</p>
        <small>Допис № {candidate.sourceItemIndex === null ? "—" : candidate.sourceItemIndex + 1} · подія: {candidate.eventType || "—"} · дата: {eventDate} · упевненість: {formatConfidence(candidate.confidence)}</small>
        {candidate.eventPlaceText ? <small>Місце: {candidate.eventPlaceText}</small> : null}
        {candidate.warningCount || candidate.possibleLivingPerson ? <small className="zagulyaky-structuring-warning">Потрібна модерація{candidate.possibleLivingPerson ? " · можливо жива особа" : ""}{candidate.warningCount ? ` · попереджень: ${candidate.warningCount}` : ""}</small> : null}
      </div>
      <div>
        <span className="zagulyaky-structuring-candidate-status">{CANDIDATE_STATUS_LABELS[candidate.status]}</span>
        {candidate.draftRecordId ? <small>Чернетку створено в попередній версії запуску</small> : null}
      </div>
    </article>
  );
}
