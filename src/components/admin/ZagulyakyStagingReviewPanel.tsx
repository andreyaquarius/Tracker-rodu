import { useEffect, useMemo, useState } from "react";
import {
  loadAdminZagulyakyIngestionBatches,
  loadAdminZagulyakyIngestionItemDetail,
  loadAdminZagulyakyIngestionItems,
  type AdminZagulyakyIngestionBatch,
  type AdminZagulyakyIngestionBatchStatus,
  type AdminZagulyakyIngestionFlag,
  type AdminZagulyakyIngestionItem,
  type AdminZagulyakyIngestionItemDetail,
  type AdminZagulyakyIngestionStageStatus,
  type AdminZagulyakyStructuredCandidate,
  type AdminZagulyakyStructuredCandidateParticipant,
} from "../../services/zagulyakyAdminService.ts";
import { sanitizeWebUrl } from "../../utils/safeUrl.ts";
import { zagulyakaEventRoleLabel } from "../../utils/zagulyakyEventRoles.ts";
import { zagulyakaEventLabels } from "../../utils/zagulyakyLabels.ts";
import { ZagulyakyStructuringPanel } from "./ZagulyakyStructuringPanel.tsx";
import "./ZagulyakyModerationPanel.css";

const PAGE_SIZE = 25;
const BATCH_PAGE_SIZE = 50;

const BATCH_STATUS_LABELS: Record<AdminZagulyakyIngestionBatchStatus, string> = {
  received: "Отримано",
  processing: "Обробляється",
  dry_run_complete: "Dry run завершено",
  completed: "Завершено",
  completed_with_errors: "Завершено з помилками",
  failed: "Не завершено",
  cancelled: "Скасовано",
  unknown: "Невідомий стан",
};

const STAGE_STATUS_LABELS: Record<AdminZagulyakyIngestionStageStatus, string> = {
  staged: "У початковій базі",
  quarantined: "Quarantine",
  structured: "Структуровано",
  linked: "Пов’язано",
  ignored: "Пропущено",
  unknown: "Невідомий стан",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("uk-UA");
}

function formatCount(value: number): string {
  return Math.max(0, value).toLocaleString("uk-UA");
}

function batchTimestamp(batch: AdminZagulyakyIngestionBatch): number {
  const value = batch.completedAt ?? batch.receivedAt;
  return value ? Date.parse(value) || 0 : 0;
}

function newestCompletedBatch(batches: AdminZagulyakyIngestionBatch[]): AdminZagulyakyIngestionBatch | null {
  return [...batches]
    .filter((batch) => batch.status === "completed" || batch.status === "completed_with_errors")
    .sort((left, right) => batchTimestamp(right) - batchTimestamp(left))[0] ?? null;
}

function reviewerErrorMessage(error: unknown): string {
  const candidate = error && typeof error === "object"
    ? `${String((error as { code?: unknown }).code ?? "")} ${String((error as { message?: unknown }).message ?? "")}`
    : String(error ?? "");
  if (/PGRST202|42883|admin_(?:list|get)_zagulyaky_ingestion/iu.test(candidate)) {
    return "Перегляд початкової приватної бази ще недоступний у робочій базі. Потрібно застосувати окрему серверну міграцію переглядача; нічого не опубліковано.";
  }
  if (candidate.includes("ADMIN_PERMISSION_REQUIRED")) {
    return "Ваш акаунт не має дозволу zagulyaky.import для перегляду початкової приватної бази.";
  }
  if (candidate.includes("INGESTION_BATCH_NOT_FOUND") || candidate.includes("INGESTION_ITEM_NOT_FOUND")) {
    return "Вибраний приватний пакет або допис більше недоступний. Оновіть список пакетів.";
  }
  return "Не вдалося безпечно завантажити дані початкової приватної бази. Текст дописів і посилання не показано в повідомленні.";
}

function itemFlags(item: AdminZagulyakyIngestionItem): string[] {
  const flags: string[] = [];
  if (item.quarantined) flags.push("quarantine");
  if (item.attachmentCount > 0 || item.declaredAttachmentCount > 0) flags.push("вкладення");
  if (item.requiresOcr) flags.push("OCR");
  if (item.requiresSourceRefetch) flags.push("повторне джерело");
  if (item.sourceIncomplete) flags.push("неповне джерело");
  if (item.textTruncated) flags.push("обрізаний текст");
  if (item.possibleLivingPerson) flags.push("можливо жива особа");
  return flags;
}

function privateText(value: string): React.ReactNode {
  return value || "—";
}

const STRUCTURAL_ROLE_LABELS: Record<string, string> = {
  subject: "Основна особа",
  spouse: "Чоловік або дружина",
  parent: "Один із батьків",
  child: "Дитина",
  witness: "Свідок",
  godparent: "Хрещений батько або мати",
  official: "Посадова особа",
  relative: "Родич",
  mentioned: "Згадана особа",
  other: "Інший учасник",
};

function eventTypeLabel(value: string): string {
  if (Object.prototype.hasOwnProperty.call(zagulyakaEventLabels, value)) {
    return zagulyakaEventLabels[value as keyof typeof zagulyakaEventLabels];
  }
  return value || "—";
}

function participantName(participant: AdminZagulyakyStructuredCandidateParticipant): string {
  return participant.originalFullName
    || participant.normalizedUkFullName
    || [participant.surname, participant.givenName, participant.patronymic].filter(Boolean).join(" ")
    || "ПІБ не розпізнано";
}

function participantRoleLabel(participant: AdminZagulyakyStructuredCandidateParticipant): string {
  if (participant.eventRoleCode || participant.eventRoleCustom) {
    return zagulyakaEventRoleLabel(participant.eventRoleCode, participant.eventRoleCustom);
  }
  return STRUCTURAL_ROLE_LABELS[participant.structuralRole] || "Роль не вказана";
}

/**
 * A deliberately read-only reviewer for the initial private source base. It
 * is not a public catalogue view and does not create a public record or image
 * request. The protected RPCs decide who can see this panel's data; the one
 * outbound source link is sanitized and only opens after an explicit click.
 */
export function ZagulyakyStagingReviewPanel() {
  const [batchStatus, setBatchStatus] = useState<AdminZagulyakyIngestionBatchStatus | "">("");
  const [batches, setBatches] = useState<AdminZagulyakyIngestionBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchesReload, setBatchesReload] = useState(0);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [stageStatus, setStageStatus] = useState<AdminZagulyakyIngestionStageStatus | "">("");
  const [quarantine, setQuarantine] = useState<"" | "yes" | "no">("");
  const [flag, setFlag] = useState<AdminZagulyakyIngestionFlag | "">("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<AdminZagulyakyIngestionItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsReload, setItemsReload] = useState(0);
  const [selectedItem, setSelectedItem] = useState<AdminZagulyakyIngestionItem | null>(null);
  const [detail, setDetail] = useState<AdminZagulyakyIngestionItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setBatchesLoading(true);
    setError("");
    void loadAdminZagulyakyIngestionBatches(batchStatus || null, BATCH_PAGE_SIZE, 0)
      .then((page) => {
        if (!active) return;
        setBatches(page.items);
        setSelectedBatchId((current) => {
          if (current && page.items.some((batch) => batch.id === current)) return current;
          return newestCompletedBatch(page.items)?.id ?? page.items[0]?.id ?? "";
        });
      })
      .catch((requestError) => {
        if (active) {
          setBatches([]);
          setSelectedBatchId("");
          setError(reviewerErrorMessage(requestError));
        }
      })
      .finally(() => {
        if (active) setBatchesLoading(false);
      });
    return () => { active = false; };
  }, [batchStatus, batchesReload]);

  useEffect(() => {
    setOffset(0);
    setSelectedItem(null);
    setDetail(null);
  }, [selectedBatchId, query, stageStatus, quarantine, flag]);

  useEffect(() => {
    if (!selectedBatchId) {
      setItems([]);
      setItemsTotal(0);
      return;
    }
    let active = true;
    setItemsLoading(true);
    setError("");
    void loadAdminZagulyakyIngestionItems({
      batchId: selectedBatchId,
      query,
      stageStatus: stageStatus || null,
      quarantined: quarantine === "yes" ? true : quarantine === "no" ? false : null,
      flag: flag || null,
      limit: PAGE_SIZE,
      offset,
    })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setItemsTotal(page.total);
        setSelectedItem((current) => current && page.items.some((item) => item.id === current.id) ? current : null);
      })
      .catch((requestError) => {
        if (active) {
          setItems([]);
          setItemsTotal(0);
          setError(reviewerErrorMessage(requestError));
        }
      })
      .finally(() => {
        if (active) setItemsLoading(false);
      });
    return () => { active = false; };
  }, [flag, itemsReload, offset, query, quarantine, selectedBatchId, stageStatus]);

  useEffect(() => {
    // A previous page selection can still be visible for one render while a
    // batch/filter change clears it. Do not request that item against a new
    // batch even momentarily: the server correctly treats that as not found.
    if (!selectedBatchId || !selectedItem || (selectedItem.batchId && selectedItem.batchId !== selectedBatchId)) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetail(null);
    setError("");
    void loadAdminZagulyakyIngestionItemDetail(selectedBatchId, selectedItem.id)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((requestError) => {
        if (active) setError(reviewerErrorMessage(requestError));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [selectedBatchId, selectedItem]);

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) ?? null,
    [batches, selectedBatchId],
  );

  const applySearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(queryDraft.trim());
  };

  return (
    <div className="zagulyaky-staging-review">
      <section className="admin-panel-card zagulyaky-staging-review-intro">
        <div>
          <span className="eyebrow">Початкова база · приватна</span>
          <h2>Перегляд імпортованих дописів</h2>
          <p>
            Це приватні вихідні матеріали Facebook-експорту для первинного наповнення бази. Один допис
            зберігається разом зі своїм оригінальним текстом, посиланням і витягнутими даними; він не є публічною карткою «Загуляки».
          </p>
        </div>
      </section>

      {error ? <div className="admin-alert error" role="alert">{error}</div> : null}

      <section className="admin-panel-card zagulyaky-staging-batch-toolbar">
        <label>Статус пакета
          <select
            value={batchStatus}
            disabled={batchesLoading}
            onChange={(event) => setBatchStatus(event.target.value as AdminZagulyakyIngestionBatchStatus | "")}
          >
            <option value="">Усі пакети</option>
            {Object.entries(BATCH_STATUS_LABELS).filter(([status]) => status !== "unknown").map(([status, label]) => (
              <option key={status} value={status}>{label}</option>
            ))}
          </select>
        </label>
        <label>Пакет
          <select
            value={selectedBatchId}
            disabled={batchesLoading || !batches.length}
            onChange={(event) => setSelectedBatchId(event.target.value)}
          >
            {!batches.length ? <option value="">Пакетів немає</option> : null}
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.sourceFileName} · {BATCH_STATUS_LABELS[batch.status]} · {formatDate(batch.completedAt ?? batch.receivedAt)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button button-secondary" disabled={batchesLoading} onClick={() => setBatchesReload((value) => value + 1)}>
          Оновити пакети
        </button>
      </section>

      {selectedBatch ? <BatchSummary batch={selectedBatch} /> : null}

      {selectedBatch ? (
        <ZagulyakyStructuringPanel
          batchId={selectedBatch.id}
          sourceFileName={selectedBatch.sourceFileName}
          batchCompleted={selectedBatch.status === "completed" || selectedBatch.status === "completed_with_errors"}
        />
      ) : null}

      {selectedBatch ? (
        <>
          <section className="admin-panel-card zagulyaky-staging-filters">
            <form onSubmit={applySearch}>
              <label>Пошук у приватному тексті та ID
                <input
                  value={queryDraft}
                  onChange={(event) => setQueryDraft(event.target.value)}
                  maxLength={160}
                  placeholder="Фраза або Facebook ID"
                />
              </label>
              <button type="submit" className="button button-secondary" disabled={itemsLoading}>Застосувати</button>
            </form>
            <label>Стан
              <select value={stageStatus} onChange={(event) => setStageStatus(event.target.value as AdminZagulyakyIngestionStageStatus | "")}>
                <option value="">Усі стани</option>
                {Object.entries(STAGE_STATUS_LABELS).filter(([status]) => status !== "unknown").map(([status, label]) => (
                  <option key={status} value={status}>{label}</option>
                ))}
              </select>
            </label>
            <label>Quarantine
              <select value={quarantine} onChange={(event) => setQuarantine(event.target.value as "" | "yes" | "no")}>
                <option value="">Усі</option><option value="yes">Лише quarantine</option><option value="no">Без quarantine</option>
              </select>
            </label>
            <label>Позначка
              <select value={flag} onChange={(event) => setFlag(event.target.value as AdminZagulyakyIngestionFlag | "")}>
                <option value="">Усі дописи</option>
                <option value="has_attachments">Є вкладення</option>
                <option value="requires_ocr">Потрібен OCR</option>
                <option value="requires_source_refetch">Потрібно повторно перевірити джерело</option>
              </select>
            </label>
            <div className="zagulyaky-staging-filter-actions">
              <span>Знайдено: <strong>{formatCount(itemsTotal)}</strong></span>
              <button type="button" className="button button-secondary" disabled={itemsLoading} onClick={() => setItemsReload((value) => value + 1)}>Оновити список</button>
            </div>
          </section>

          <div className="zagulyaky-staging-layout">
            <section className="admin-panel-card zagulyaky-staging-list" aria-label="Список приватних дописів">
              {itemsLoading ? <div className="admin-loading">Завантажуємо приватний список…</div> : null}
              <div className="zagulyaky-staging-cards">
                {items.map((item) => (
                  <article key={item.id} className={selectedItem?.id === item.id ? "selected" : ""}>
                    <div>
                      <span className="eyebrow">{item.sourceItemIndex === null ? "Вихідний допис" : `Допис № ${item.sourceItemIndex + 1}`}</span>
                      <strong>{item.externalId ? `Facebook ID: ${item.externalId}` : "Ідентифікатор джерела відсутній"}</strong>
                      <small>{item.sourceDateText || formatDate(item.sourcePublishedAt)} · вкладень: {formatCount(item.attachmentCount || item.declaredAttachmentCount)} · посилань: {formatCount(item.linkCount)}</small>
                      {item.textPreview ? <p className="zagulyaky-staging-text-preview"><span>Фрагмент джерела</span>{item.textPreview}</p> : null}
                    </div>
                    <div className="zagulyaky-staging-card-actions">
                      <span className={`zagulyaky-status stage-${item.stageStatus}`}>{STAGE_STATUS_LABELS[item.stageStatus]}</span>
                      {itemFlags(item).map((value) => <span className="zagulyaky-staging-flag" key={value}>{value}</span>)}
                      <button type="button" className="button button-secondary" onClick={() => setSelectedItem(item)}>Переглянути</button>
                    </div>
                  </article>
                ))}
                {!itemsLoading && !items.length ? <p className="zagulyaky-staging-empty">У цьому пакеті немає дописів за поточними фільтрами.</p> : null}
              </div>
              <Pagination offset={offset} total={itemsTotal} onChange={setOffset} />
            </section>

            {selectedItem ? (
              <section className="admin-panel-card zagulyaky-staging-detail" aria-label="Приватні деталі допису">
                <div className="admin-card-heading">
                  <div><span className="eyebrow">Приватний джерельний допис</span><h2>{selectedItem.externalId || "Без зовнішнього ID"}</h2></div>
                  <button type="button" className="button button-secondary" onClick={() => setSelectedItem(null)}>Закрити</button>
                </div>
                {detailLoading ? <div className="admin-loading">Завантажуємо приватні метадані…</div> : null}
                {detail ? <ItemDetail detail={detail} /> : null}
              </section>
            ) : null}
          </div>
        </>
      ) : !batchesLoading ? (
        <section className="admin-panel-card zagulyaky-staging-empty">
          Немає доступного завершеного пакета початкової приватної бази. Виберіть інший статус або оновіть список.
        </section>
      ) : null}
    </div>
  );
}

function BatchSummary({ batch }: { batch: AdminZagulyakyIngestionBatch }) {
  return (
    <section className="admin-panel-card zagulyaky-staging-batch-summary" aria-label="Стан приватного пакета">
      <div className="admin-card-heading">
        <div><span className="eyebrow">Вибраний приватний пакет</span><h2>{batch.sourceFileName}</h2></div>
        <span className={`zagulyaky-status stage-${batch.status}`}>{BATCH_STATUS_LABELS[batch.status]}</span>
      </div>
      <dl>
        <div><dt>Режим</dt><dd>{batch.importMode === "commit" ? "Commit" : batch.importMode === "dry_run" ? "Dry run" : "—"}</dd></div>
        <div><dt>Очікувано</dt><dd>{formatCount(batch.expectedItemCount)}</dd></div>
        <div><dt>Оброблено</dt><dd>{formatCount(batch.processedItemCount)}</dd></div>
        <div><dt>У початковій базі</dt><dd>{formatCount(batch.stagedItemCount)}</dd></div>
        <div><dt>Quarantine</dt><dd>{formatCount(batch.quarantinedItemCount)}</dd></div>
        <div><dt>Помилки</dt><dd>{formatCount(batch.failedItemCount)}</dd></div>
      </dl>
      <p>Це технічний стан початкової приватної бази. Він не означає створення або публікацію карток каталогу.</p>
    </section>
  );
}

function ItemDetail({ detail }: { detail: AdminZagulyakyIngestionItemDetail }) {
  const { item } = detail;
  const safeFacebookPostUrl = sanitizeWebUrl(detail.facebookPostUrl);
  return (
    <div className="zagulyaky-staging-detail-content">
      <dl className="zagulyaky-review-facts">
        <div><dt>Стан</dt><dd>{STAGE_STATUS_LABELS[item.stageStatus]}</dd></div>
        <div><dt>Quarantine</dt><dd>{item.quarantined ? "Так" : "Ні"}</dd></div>
        <div><dt>Дата в джерелі</dt><dd>{item.sourceDateText || formatDate(item.sourcePublishedAt)}</dd></div>
        <div><dt>Автор у джерелі</dt><dd>{privateText(detail.sourceAuthorLabel)}</dd></div>
        <div><dt>Кандидатні роки</dt><dd>{detail.candidateYears.length ? detail.candidateYears.join(", ") : "—"}</dd></div>
        <div><dt>Вкладення / посилання</dt><dd>{formatCount(item.attachmentCount || item.declaredAttachmentCount)} / {formatCount(item.linkCount)}</dd></div>
      </dl>

      <StructuredCandidates candidates={detail.structuredCandidates} />

      <section className="zagulyaky-staging-private-text">
        <h3>Оригінальний текст допису</h3>
        <p>Показується лише в початковій приватній базі та лишається прив’язаним до цього допису. Він доступний для окремої майбутньої дії перегляду або створення запису, але не копіюється до каталогу автоматично.</p>
        <pre>{detail.rawText || "Текст у джерелі відсутній."}</pre>
        {detail.rawTextTruncatedForDisplay ? <small>На екрані показано перші 16 000 символів; вихідний текст не змінено.</small> : null}
      </section>

      <section className="zagulyaky-staging-private-metadata">
        <h3>Оригінальний допис Facebook</h3>
        <p>Внутрішнє приватне посилання: воно доступне лише адміністратору в початковій базі та ніколи не відкривається автоматично.</p>
        <dl>
          <div><dt>Допис</dt><dd>{safeFacebookPostUrl ? <a href={safeFacebookPostUrl} target="_blank" rel="noopener noreferrer">Оригінальний допис Facebook (приватно)</a> : "Facebook-посилання відсутнє або не пройшло перевірку"}</dd></div>
          <div><dt>Колекція</dt><dd><code>{privateText(detail.sourceCollectionUrl)}</code></dd></div>
        </dl>
      </section>

      <PrivateAttachments attachments={detail.attachments} />
      <PrivateLinks links={detail.links} />
      <ExtractionJobs extractionJobs={detail.extractionJobs} errors={detail.errors} />
    </div>
  );
}

function StructuredCandidates({ candidates }: { candidates: AdminZagulyakyStructuredCandidate[] }) {
  return (
    <section className="zagulyaky-staging-private-metadata">
      <h3>Витягнуті дані з цього допису</h3>
      <p>Усі знайдені люди й документи показані всередині одного приватного допису. Порожній список означає, що допис ще не опрацьовано або в ньому не виявлено даних для «Загуляк».</p>
      {candidates.length ? <ul className="zagulyaky-staging-private-list">
        {candidates.map((candidate, index) => <StructuredCandidate key={candidate.id || `${candidate.kind}-${index}`} candidate={candidate} />)}
      </ul> : <p>Структурованих даних для цього допису поки немає.</p>}
    </section>
  );
}

function StructuredCandidate({ candidate }: { candidate: AdminZagulyakyStructuredCandidate }) {
  const eventDate = candidate.eventDateText
    || [candidate.eventYearFrom, candidate.eventYearTo].filter((value): value is number => value !== null).join("–");
  const candidateLabel = candidate.kind === "person" ? "Людина" : candidate.kind === "document" ? "Документ" : "Запис";
  return (
    <li>
      <strong>{candidate.title || `${candidateLabel} без назви`}</strong>
      <span>{candidateLabel}</span>
      {candidate.eventType ? <small>Подія: {eventTypeLabel(candidate.eventType)}{eventDate ? ` · ${eventDate}` : ""}</small> : eventDate ? <small>Дата: {eventDate}</small> : null}
      {candidate.eventLocationText ? <small>Місце події: {candidate.eventLocationText}</small> : null}
      {candidate.originText ? <small>Походження: {candidate.originText}</small> : null}
      {candidate.residenceText ? <small>Проживання: {candidate.residenceText}</small> : null}
      {candidate.socialEstateText ? <small>Стан / заняття: {candidate.socialEstateText}</small> : null}
      {candidate.participants.length ? <ul className="zagulyaky-staging-private-list">
        {candidate.participants.map((participant, index) => (
          <li key={`${participantName(participant)}-${index}`}>
            <strong>{participantName(participant)}</strong>
            <span>Роль: {participantRoleLabel(participant)}</span>
            {participant.originText ? <small>Походження: {participant.originText}</small> : null}
            {participant.residenceText ? <small>Проживання: {participant.residenceText}</small> : null}
            {participant.socialEstateText ? <small>Стан / заняття: {participant.socialEstateText}</small> : null}
          </li>
        ))}
      </ul> : null}
    </li>
  );
}

function PrivateAttachments({ attachments }: { attachments: AdminZagulyakyIngestionItemDetail["attachments"] }) {
  return (
    <section className="zagulyaky-staging-private-metadata">
      <h3>Вкладення</h3>
      <p>Зображення не підвантажуються й не відображаються на цій сторінці.</p>
      {attachments.length ? <ul className="zagulyaky-staging-private-list">
        {attachments.map((attachment, index) => (
          <li key={attachment.id || index}>
            <strong>Вкладення {attachment.sourceIndex === null ? index + 1 : attachment.sourceIndex + 1}</strong>
            <span>{attachment.width && attachment.height ? `${attachment.width} × ${attachment.height}` : "Розмір не вказано"} · {attachment.downloadStatus || "не запитано"} · права: {attachment.rightsStatus || "на перевірці"}</span>
            {attachment.altText ? <small>Підпис: {attachment.altText}</small> : null}
            {attachment.originalCdnUrl ? <code>CDN: {attachment.originalCdnUrl}</code> : null}
            {attachment.photoPageUrl ? <code>Сторінка: {attachment.photoPageUrl}</code> : null}
          </li>
        ))}
      </ul> : <p>У відповіді немає метаданих вкладень.</p>}
    </section>
  );
}

function PrivateLinks({ links }: { links: AdminZagulyakyIngestionItemDetail["links"] }) {
  return (
    <section className="zagulyaky-staging-private-metadata">
      <h3>Знайдені посилання</h3>
      {links.length ? <ul className="zagulyaky-staging-private-list">
        {links.map((link, index) => (
          <li key={link.id || index}>
            <strong>{link.label || link.linkKind || `Посилання ${index + 1}`}</strong>
            <span>{link.requiresSafeFetch ? "Потребує безпечної перевірки" : "Не відкривається автоматично"}</span>
            {link.rawUrl ? <code>{link.rawUrl}</code> : null}
            {link.normalizedUrl && link.normalizedUrl !== link.rawUrl ? <code>Нормалізована адреса: {link.normalizedUrl}</code> : null}
          </li>
        ))}
      </ul> : <p>У дописі не знайдено посилань.</p>}
    </section>
  );
}

function ExtractionJobs({
  extractionJobs: jobs,
  errors,
}: Pick<AdminZagulyakyIngestionItemDetail, "extractionJobs" | "errors">) {
  return (
    <section className="zagulyaky-staging-private-metadata">
      <h3>Черги й технічні позначки</h3>
      {jobs.length ? <ul className="zagulyaky-staging-private-list">
        {jobs.map((job, index) => <li key={job.id || index}><strong>{job.jobType || "Технічна задача"}</strong><span>{job.status || "невідомо"} · спроб: {formatCount(job.attemptCount)}</span>{job.lastErrorCode ? <code>{job.lastErrorCode}</code> : null}</li>)}
      </ul> : <p>Черги для цього допису ще не створено.</p>}
      {errors.length ? <ul className="zagulyaky-staging-private-list zagulyaky-staging-errors">
        {errors.map((itemError, index) => <li key={`${itemError.errorCode}-${index}`}><strong>{itemError.errorCode || "Технічна помилка"}</strong><span>{itemError.errorDetail || "Без додаткового опису"}</span></li>)}
      </ul> : null}
    </section>
  );
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (next: number) => void }) {
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  return (
    <div className="zagulyaky-pagination">
      <button type="button" className="button button-secondary" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>Попередня</button>
      <span>Сторінка {page} з {pages}</span>
      <button type="button" className="button button-secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => onChange(offset + PAGE_SIZE)}>Наступна</button>
    </div>
  );
}
