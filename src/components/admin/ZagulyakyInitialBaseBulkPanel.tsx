import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT,
  loadAdminZagulyakyInitialBaseBulkSummary,
  loadMyZagulyakyInitialBaseBulkBatches,
  loadMyZagulyakyInitialBaseBulkSummary,
  publishZagulyakyTabularInitialBaseBatch,
  submitMyZagulyakyTabularInitialBaseBatch,
  type ZagulyakyInitialBaseBulkExclusions,
  type ZagulyakyInitialBaseBulkResult,
  type ZagulyakyInitialBaseBulkSummary,
} from "../../services/zagulyakyInitialBaseBulkService";

const MAX_BULK_REQUESTS = 100;

type BulkAction = "submit" | "publish";

interface BulkProgress {
  action: BulkAction;
  processed: number;
  remaining: number;
}

interface BulkOutcome {
  action: BulkAction;
  processed: number;
  excluded: ZagulyakyInitialBaseBulkExclusions;
}

function formatCount(value: number): string {
  return Math.max(0, value).toLocaleString("uk-UA");
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("uk-UA");
}

function safeBulkError(error: unknown): string {
  const source = error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error ?? "");
  if (/PGRST202|function .* does not exist|could not find the function/i.test(source)) {
    return "Пакетні інструменти ще не застосовано в робочій базі. Оновіть сторінку після серверної міграції.";
  }
  if (/ADMIN_PERMISSION_REQUIRED|42501/i.test(source)) {
    return "Для цієї дії потрібен дозвіл модератора Загуляк.";
  }
  if (/INITIAL_BASE_BULK_(?:BATCH_NOT_FOUND|OWNER_REQUIRED|NOT_FOUND)/i.test(source)) {
    return "Цей приватний пакет недоступний для вашого облікового запису. Оновіть список пакетів.";
  }
  if (/INITIAL_BASE_BULK_SUBMIT_ACKNOWLEDGEMENT_REQUIRED/i.test(source)) {
    return "Робоча база ще використовує застарілі правила подання. Оновіть сторінку після серверної міграції.";
  }
  if (/INITIAL_BASE_BULK_PUBLISH_ACKNOWLEDGEMENT_REQUIRED/i.test(source)) {
    return "Перед публікацією підтвердьте модераторське рішення й перевірку приватності.";
  }
  if (/INITIAL_BASE_BULK_NO_PROGRESS/i.test(source)) {
    return "Пакет не просунувся. Оновіть підсумок: частина записів могла стати непридатною через одночасну модерацію.";
  }
  return "Пакетну дію не виконано. Дані не публікувалися автоматично — оновіть підсумок і повторіть лише за потреби.";
}

function emptyExclusions(): ZagulyakyInitialBaseBulkExclusions {
  return {
    sourceUnavailableInCallCount: 0,
    livingClearanceMissingInCallCount: 0,
    missingOriginCount: 0,
    originApprovalPendingCount: 0,
    originApprovalNeedsModeratorCount: 0,
    requiredFieldsMissingCount: 0,
    rightsNotRecordedCount: 0,
    livingNeedsDocumentedConsentCount: 0,
    privacyBlockedCount: 0,
    originNotApprovedCount: 0,
    statusCount: 0,
    otherCount: 0,
  };
}

function exclusionItems(excluded: ZagulyakyInitialBaseBulkExclusions): Array<{ label: string; count: number }> {
  return [
    { label: "джерело змінилося під час пакетної операції", count: excluded.sourceUnavailableInCallCount },
    { label: "документована згода для можливо живої особи змінилася під час публікації", count: excluded.livingClearanceMissingInCallCount },
    { label: "немає зв’язку з оригінальним дописом", count: excluded.missingOriginCount },
    { label: "потрібне підтвердження відкритого посилання", count: excluded.originApprovalPendingCount },
    { label: "відкрите посилання може підтвердити лише модератор", count: excluded.originApprovalNeedsModeratorCount },
    { label: "бракує обов’язкових полів", count: excluded.requiredFieldsMissingCount },
    { label: "потрібна документована згода для можливо живої особи", count: excluded.livingNeedsDocumentedConsentCount },
    { label: "приватність блокує публікацію", count: excluded.privacyBlockedCount },
    { label: "відкрите посилання на оригінал ще не підтверджено", count: excluded.originNotApprovedCount },
    { label: "стан запису не відповідає цій дії", count: excluded.statusCount },
    { label: "інші серверні обмеження", count: excluded.otherCount },
  ].filter((item) => item.count > 0);
}

function Exclusions({ exclusions, title = "Виключено" }: {
  exclusions: ZagulyakyInitialBaseBulkExclusions;
  title?: string;
}) {
  const items = exclusionItems(exclusions);
  if (!items.length) return <p className="zagulyaky-initial-base-empty">{title}: немає.</p>;
  return (
    <section className="zagulyaky-initial-base-exclusions" aria-label={title}>
      <h4>{title}</h4>
      <ul>
        {items.map((item) => <li key={item.label}><strong>{formatCount(item.count)}</strong><span>{item.label}</span></li>)}
      </ul>
    </section>
  );
}

/**
 * Controls the initial tabular base without ever loading the 2,000+ cards in
 * the browser.  The database independently re-checks ownership, moderation,
 * privacy and moderation eligibility for every bounded server chunk.
 */
export function ZagulyakyInitialBaseBulkPanel({ canModerateZagulyaky }: {
  canModerateZagulyaky: boolean;
}) {
  const [batches, setBatches] = useState<Awaited<ReturnType<typeof loadMyZagulyakyInitialBaseBulkBatches>>["items"]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [authorSummary, setAuthorSummary] = useState<ZagulyakyInitialBaseBulkSummary | null>(null);
  const [moderatorSummary, setModeratorSummary] = useState<ZagulyakyInitialBaseBulkSummary | null>(null);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [busyAction, setBusyAction] = useState<BulkAction | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitAllSelected, setSubmitAllSelected] = useState(false);
  const [publishAllSelected, setPublishAllSelected] = useState(false);
  const [publishAcknowledged, setPublishAcknowledged] = useState(false);
  const [publishPrivacyAcknowledged, setPublishPrivacyAcknowledged] = useState(false);

  const loadBatches = useCallback(async () => {
    setLoadingBatches(true);
    setError("");
    try {
      const page = await loadMyZagulyakyInitialBaseBulkBatches();
      setBatches(page.items);
      setSelectedBatchId((current) => page.items.some((item) => item.batchId === current)
        ? current
        : page.items[0]?.batchId ?? "");
    } catch (requestError) {
      setBatches([]);
      setSelectedBatchId("");
      setAuthorSummary(null);
      setModeratorSummary(null);
      setError(safeBulkError(requestError));
    } finally {
      setLoadingBatches(false);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    if (!selectedBatchId) {
      setAuthorSummary(null);
      setModeratorSummary(null);
      return;
    }
    setLoadingSummary(true);
    setError("");
    try {
      const author = await loadMyZagulyakyInitialBaseBulkSummary(selectedBatchId);
      const moderator = canModerateZagulyaky
        ? await loadAdminZagulyakyInitialBaseBulkSummary(selectedBatchId)
        : null;
      setAuthorSummary(author);
      setModeratorSummary(moderator);
    } catch (requestError) {
      setAuthorSummary(null);
      setModeratorSummary(null);
      setError(safeBulkError(requestError));
    } finally {
      setLoadingSummary(false);
    }
  }, [canModerateZagulyaky, selectedBatchId]);

  useEffect(() => { void loadBatches(); }, [loadBatches]);
  useEffect(() => { void loadSummary(); }, [loadSummary]);

  useEffect(() => {
    setSubmitAllSelected(false);
    setPublishAllSelected(false);
    setPublishAcknowledged(false);
    setPublishPrivacyAcknowledged(false);
    setProgress(null);
    setOutcome(null);
    setNotice("");
  }, [selectedBatchId]);

  const selectedBatch = useMemo(
    () => batches.find((item) => item.batchId === selectedBatchId) ?? null,
    [batches, selectedBatchId],
  );
  const submitAvailable = authorSummary?.submission.availableForSubmission ?? 0;
  const publishAvailable = moderatorSummary?.publication.availableForPublication ?? 0;
  const submitTargetCount = progress?.action === "submit" && progress.remaining > 0
    ? progress.remaining
    : submitAvailable;
  const publishTargetCount = progress?.action === "publish" && progress.remaining > 0
    ? progress.remaining
    : publishAvailable;
  const currentSummary = moderatorSummary ?? authorSummary;
  const unknownFoundLocationCount = Math.max(
    authorSummary?.submission.unknownFoundLocationCount ?? 0,
    authorSummary?.warnings.unknownFoundLocationCount ?? 0,
  );

  const refresh = async () => {
    await loadBatches();
    await loadSummary();
  };

  const runInChunks = async (
    action: BulkAction,
    invoke: () => Promise<ZagulyakyInitialBaseBulkResult>,
  ): Promise<BulkOutcome> => {
    let processed = 0;
    let latestExclusions = emptyExclusions();
    for (let requestIndex = 0; requestIndex < MAX_BULK_REQUESTS; requestIndex += 1) {
      const result = await invoke();
      if (result.action !== action || result.batchId !== selectedBatchId) {
        throw new Error("INITIAL_BASE_BULK_NO_PROGRESS");
      }
      processed += result.processedCount;
      latestExclusions = result.excluded;
      setProgress({ action, processed, remaining: result.remainingEligibleCount });
      if (result.remainingEligibleCount === 0) return { action, processed, excluded: latestExclusions };
      if (result.processedCount === 0) throw new Error("INITIAL_BASE_BULK_NO_PROGRESS");
    }
    throw new Error("INITIAL_BASE_BULK_NO_PROGRESS");
  };

  const submitAll = async () => {
    if (!selectedBatchId || !submitTargetCount || !submitAllSelected || busyAction) return;
    if (!window.confirm(`Подати на модерацію всі ${formatCount(submitTargetCount)} придатних записів цього приватного пакета? Ця дія не публікує картки.`)) return;
    setBusyAction("submit");
    setError("");
    setNotice("");
    setOutcome(null);
    setProgress({ action: "submit", processed: 0, remaining: submitTargetCount });
    try {
      const completed = await runInChunks("submit", () => submitMyZagulyakyTabularInitialBaseBatch({
        batchId: selectedBatchId,
        limit: ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT,
      }));
      setOutcome(completed);
      setNotice(`На модерацію подано ${formatCount(completed.processed)} записів. Жодну картку не опубліковано цією дією.`);
      await refresh();
    } catch (requestError) {
      setError(safeBulkError(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const publishAll = async () => {
    if (!selectedBatchId || !publishTargetCount || !publishAllSelected || !publishAcknowledged || !publishPrivacyAcknowledged || busyAction || !canModerateZagulyaky) return;
    if (!window.confirm(`Опублікувати всі ${formatCount(publishTargetCount)} придатних записів цього пакета? Записи з приватнісними або іншими серверними обмеженнями буде виключено.`)) return;
    setBusyAction("publish");
    setError("");
    setNotice("");
    setOutcome(null);
    setProgress({ action: "publish", processed: 0, remaining: publishTargetCount });
    try {
      const completed = await runInChunks("publish", () => publishZagulyakyTabularInitialBaseBatch({
        batchId: selectedBatchId,
        limit: ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT,
        acknowledgePublication: true,
        acknowledgeNonLivingPrivacy: true,
      }));
      setOutcome(completed);
      setNotice(`Опубліковано ${formatCount(completed.processed)} записів. Виключені записи залишилися приватними для подальшої перевірки.`);
      await refresh();
    } catch (requestError) {
      setError(safeBulkError(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="admin-panel-card zagulyaky-initial-base-bulk" aria-label="Пакетна модерація початкової бази">
      <div className="admin-card-heading">
        <div>
          <span className="eyebrow">Початкова база · лише приватні записи</span>
          <h2>Пакетне подання і публікація</h2>
          <p>Операції виконуються на сервері частинами до {ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT} записів. Браузер бачить тільки підсумкові лічильники.</p>
        </div>
        <button type="button" className="button button-secondary" disabled={loadingBatches || loadingSummary || Boolean(busyAction)} onClick={() => void refresh()}>Оновити підсумок</button>
      </div>

      {error ? <div className="admin-alert error" role="alert">{error}</div> : null}
      {notice ? <div className="admin-alert zagulyaky-success" role="status">{notice}</div> : null}

      <label className="zagulyaky-initial-base-batch-select">Пакет, створений вашим обліковим записом
        <select value={selectedBatchId} disabled={loadingBatches || Boolean(busyAction)} onChange={(event) => setSelectedBatchId(event.target.value)}>
          {!batches.length ? <option value="">Пакетів початкової бази не знайдено</option> : null}
          {batches.map((item) => <option key={item.batchId} value={item.batchId}>{formatCount(item.recordCount)} записів · {item.status || "без статусу"} · оновлено {formatDate(item.updatedAt)}</option>)}
        </select>
      </label>

      {loadingBatches || loadingSummary ? <p className="zagulyaky-initial-base-empty">Оновлюємо лише агрегований стан пакета…</p> : null}
      {!loadingBatches && !batches.length ? <p className="zagulyaky-initial-base-empty">Для цього облікового запису немає завершених пакетів початкової табличної бази.</p> : null}

      {selectedBatch && currentSummary ? (
        <>
          <dl className="zagulyaky-initial-base-facts">
            <div><dt>У пакеті</dt><dd>{formatCount(currentSummary.recordCount)}</dd></div>
            <div><dt>Чернетки</dt><dd>{formatCount(currentSummary.draftCount)}</dd></div>
            <div><dt>На модерації</dt><dd>{formatCount(currentSummary.pendingReviewCount)}</dd></div>
            <div><dt>Опубліковано</dt><dd>{formatCount(currentSummary.publishedCount)}</dd></div>
            <div><dt>Доступно для подання</dt><dd>{formatCount(submitAvailable)}</dd></div>
            {canModerateZagulyaky ? <div><dt>Доступно для публікації</dt><dd>{formatCount(publishAvailable)}</dd></div> : null}
          </dl>

          <div className="zagulyaky-initial-base-actions">
            <section className="zagulyaky-initial-base-action-card">
              <div>
                <span className="eyebrow">Крок 1 · автор початкової бази</span>
                <h3>Подати всі придатні чернетки на модерацію</h3>
                <p>Ця дія передає історичні записи на перевірку модератору й не публікує картки автоматично.</p>
              </div>
              <Exclusions exclusions={authorSummary?.submission.exclusions ?? emptyExclusions()} title="Поки не можуть бути подані" />
              {unknownFoundLocationCount > 0 ? <p className="zagulyaky-initial-base-warning">У {formatCount(unknownFoundLocationCount)} записів історичне місце не розпізнано. Це попередження, а не блокування подання.</p> : null}
              <label className="zagulyaky-initial-base-acknowledgement"><input type="checkbox" checked={submitAllSelected} disabled={!submitTargetCount || Boolean(busyAction)} onChange={(event) => setSubmitAllSelected(event.target.checked)} />Вибрати всі {formatCount(submitTargetCount)} придатних чернеток цього пакета.</label>
              <button type="button" className="button button-primary" disabled={!submitTargetCount || !submitAllSelected || Boolean(busyAction)} onClick={() => void submitAll()}>{busyAction === "submit" ? "Подаємо частинами…" : progress?.action === "submit" && progress.remaining > 0 ? `Продовжити подання ${formatCount(progress.remaining)} чернеток` : `Подати ${formatCount(submitTargetCount)} чернеток на модерацію`}</button>
            </section>

            {canModerateZagulyaky ? <section className="zagulyaky-initial-base-action-card publish">
              <div>
                <span className="eyebrow">Крок 2 · модератор</span>
                <h3>Підтвердити й опублікувати всі придатні</h3>
                <p>Публікуються лише записи, які сервер повторно визнає придатними. Можливо живі особи можуть бути опубліковані лише з чинною документованою згодою; без неї, а також при блокуванні приватності чи неповних даних, запис залишається непублічним.</p>
              </div>
              <Exclusions exclusions={moderatorSummary?.publication.exclusions ?? emptyExclusions()} title="Будуть виключені з публікації" />
              <label className="zagulyaky-initial-base-acknowledgement"><input type="checkbox" checked={publishAllSelected} disabled={!publishTargetCount || Boolean(busyAction)} onChange={(event) => setPublishAllSelected(event.target.checked)} />Вибрати всі {formatCount(publishTargetCount)} придатних записів для публікації.</label>
              <label className="zagulyaky-initial-base-acknowledgement"><input type="checkbox" checked={publishAcknowledged} disabled={!publishTargetCount || Boolean(busyAction)} onChange={(event) => setPublishAcknowledged(event.target.checked)} />Підтверджую модераторське рішення опублікувати всі вибрані записи.</label>
              <label className="zagulyaky-initial-base-acknowledgement"><input type="checkbox" checked={publishPrivacyAcknowledged} disabled={!publishTargetCount || Boolean(busyAction)} onChange={(event) => setPublishPrivacyAcknowledged(event.target.checked)} />Підтверджую, що публікуються лише серверно придатні записи: можливо живі — лише з чинною документованою згодою; записи без такої згоди або з блокуванням приватності залишаються приватними.</label>
              <button type="button" className="button button-primary" disabled={!publishTargetCount || !publishAllSelected || !publishAcknowledged || !publishPrivacyAcknowledged || Boolean(busyAction)} onClick={() => void publishAll()}>{busyAction === "publish" ? "Публікуємо частинами…" : progress?.action === "publish" && progress.remaining > 0 ? `Продовжити публікацію ${formatCount(progress.remaining)} записів` : `Підтвердити й опублікувати ${formatCount(publishTargetCount)} записів`}</button>
            </section> : null}
          </div>
        </>
      ) : null}

      {progress ? <p className="zagulyaky-initial-base-progress" role="status">{progress.action === "submit" ? "Подано на модерацію" : "Опубліковано"}: {formatCount(progress.processed)} · залишилося у поточній серверній черзі: {formatCount(progress.remaining)}.</p> : null}
      {outcome ? <Exclusions exclusions={outcome.excluded} title={outcome.action === "submit" ? "Виключено під час подання" : "Виключено під час публікації"} /> : null}
    </section>
  );
}
