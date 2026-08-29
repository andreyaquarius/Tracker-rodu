import { useCallback, useEffect, useState } from "react";
import {
  createAdminZagulyakaDuplicateCandidate,
  loadAdminZagulyakaPrivacyClearance,
  loadAdminZagulyakaDetail,
  loadAdminZagulyakaDuplicateCandidates,
  loadAdminZagulyakyClaims,
  loadAdminZagulyakyQueue,
  mergeAdminZagulyakaDuplicate,
  previewAdminZagulyakaAttachment,
  publishAdminZagulyakaAttachment,
  recordAdminZagulyakaLivingConsent,
  revokeAdminZagulyakaAttachment,
  resolveAdminZagulyakaDuplicateCandidate,
  resolveAdminZagulyakaClaim,
  reviewAdminZagulyaka,
  type AdminZagulyakaClaim,
  type AdminZagulyakaDetail,
  type AdminZagulyakaDuplicateCandidate,
  type AdminZagulyakaAttachmentAccess,
  type AdminZagulyakaPrivacyClearance,
  type AdminZagulyakaQueueItem,
  type ZagulyakaClaimRecordAction,
  type ZagulyakaClaimStatus,
  type ZagulyakaDuplicateCandidateStatus,
  type ZagulyakaModerationAction,
  type ZagulyakaModerationStatus,
  type ZagulyakaPrivacyStatus,
  type ZagulyakaVerificationStatus,
} from "../../services/zagulyakyAdminService.ts";
import { zagulyakaEventRoleLabel } from "../../utils/zagulyakyEventRoles";
import { Modal } from "../Modal";
import "./ZagulyakyModerationPanel.css";

const PAGE_SIZE = 25;

interface AttachmentPreview extends AdminZagulyakaAttachmentAccess {
  attachmentId: string;
  expiresAt: number;
  expired: boolean;
}

const STATUS_LABELS: Record<ZagulyakaModerationStatus, string> = {
  draft: "Чернетка",
  pending_review: "Очікує перевірки",
  needs_changes: "Потрібні зміни",
  published: "Опубліковано",
  rejected: "Відхилено",
  withdrawn: "Відкликано",
  merged: "Об’єднано",
  archived: "В архіві",
};

const VERIFICATION_LABELS: Record<ZagulyakaVerificationStatus, string> = {
  unverified: "Не перевірено",
  plausible: "Ймовірно",
  corroborated: "Підтверджено кількома джерелами",
  verified: "Перевірено",
  disputed: "Оспорюється",
};

const PRIVACY_LABELS: Record<ZagulyakaPrivacyStatus, string> = {
  pending: "Приватність не перевірено",
  cleared: "Можна публікувати",
  blocked: "Публікацію заблоковано",
  requires_consent: "Потрібна згода",
};

const CLAIM_STATUS_LABELS: Record<ZagulyakaClaimStatus, string> = {
  open: "Нові",
  reviewing: "На розгляді",
  resolved: "Вирішені",
  rejected: "Відхилені",
};

const CLAIM_TYPE_LABELS: Record<string, string> = {
  correction: "Уточнення даних",
  privacy: "Приватність",
  copyright: "Авторські права",
  abuse: "Порушення",
  source_problem: "Проблема з джерелом",
  other: "Інше",
};

const DUPLICATE_STATUS_LABELS: Record<ZagulyakaDuplicateCandidateStatus, string> = {
  pending: "Очікує рішення",
  confirmed: "Підтверджено",
  dismissed: "Не дублі",
};

const CLAIM_RECORD_ACTION_LABELS: Record<ZagulyakaClaimRecordAction, string> = {
  none: "Лише оновити звернення",
  privacy_block: "Негайно заблокувати публікацію",
  archive: "Архівувати запис",
};

const MODERATION_ACTION_LABELS: Record<string, string> = {
  submit: "Подано на модерацію",
  withdraw: "Відкликано автором",
  publish: "Опубліковано",
  request_changes: "Повернено на уточнення",
  reject: "Відхилено",
  archive: "Архівовано",
  restore: "Повернено до черги",
  merge: "Об’єднання з дублем",
  privacy_block: "Публікацію заблоковано",
  privacy_clear: "Приватність підтверджено",
  duplicate_candidate_create: "Додано кандидата на дублікат",
  duplicate_candidate_confirm: "Дублікат підтверджено",
  duplicate_candidate_dismiss: "Дублікат відхилено",
  claim_review: "Звернення взято в роботу",
  claim_resolve: "Звернення вирішено",
  claim_reject: "Звернення відхилено",
  attachment_add: "Додано приватне вкладення",
  attachment_remove: "Прибрано приватне вкладення",
  attachment_publish: "Опубліковано контрольовану копію вкладення",
  attachment_revoke: "Відкликано публічну копію вкладення",
};

function displayDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("uk-UA");
}

function errorMessage(error: unknown): string {
  const message = error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error ?? "");
  if (message.includes("ZAGULYAKA_VERSION_CONFLICT")) {
    return "Запис уже змінився в іншій вкладці. Оновіть чергу й повторіть перевірку.";
  }
  if (message.includes("PRIVACY_CLEARANCE_REQUIRED")) {
    return "Перед публікацією встановіть статус приватності «Можна публікувати».";
  }
  if (message.includes("LIVING_PERSON_DOCUMENTED_CONSENT_REQUIRED")) {
    return "Для потенційно живої особи спершу зафіксуйте дату та приватне посилання на підтверджену згоду.";
  }
  if (message.includes("CONSENT_EVIDENCE_REFERENCE_REQUIRED")) {
    return "Додайте приватне посилання або номер доказу згоди (щонайменше 3 символи).";
  }
  if (message.includes("INVALID_CONSENT_DATE")) {
    return "Вкажіть коректну дату отримання згоди.";
  }
  if (message.includes("ATTACHMENT_RECORD_NOT_PUBLIC")) {
    return "Публічну копію вкладення можна створити лише після публікації запису з очищеною приватністю.";
  }
  if (message.includes("ATTACHMENT_ALREADY_PUBLISHED")) {
    return "Для цього вкладення вже є публічна копія.";
  }
  if (message.includes("ATTACHMENT_COPY_FAILED")) {
    return "Не вдалося створити контрольовану публічну копію вкладення. Спробуйте ще раз.";
  }
  if (message.includes("ATTACHMENT_PRIVATE_OBJECT_NOT_FOUND")) {
    return "Оригінальний файл вкладення вже відсутній у приватному сховищі. Попросіть автора додати файл повторно: перегляд і публічну копію відновити без оригіналу неможливо.";
  }
  if (message.includes("ATTACHMENT_PRIVATE_STORAGE_CHECK_FAILED") || message.includes("ATTACHMENT_PRIVATE_SIGNING_FAILED")) {
    return "Не вдалося безпечно перевірити або відкрити приватне вкладення. Спробуйте ще раз; якщо помилка повторюється, перевірте деплой Edge Function вкладень.";
  }
  if (message.includes("ATTACHMENT_FUNCTION_NOT_CONFIGURED")) {
    return "Сервер перегляду вкладень не налаштований. Потрібен деплой Edge Functions із серверним ключем Supabase.";
  }
  if (message.includes("PUBLIC_ATTACHMENT_CLEANUP_PENDING")) {
    return "Попередня публічна копія ще безпечно очищується. Дочекайтеся завершення черги перед повторною публікацією.";
  }
  if (message.includes("ATTACHMENT_PUBLICATION_PENDING_RETRY")) {
    return "Копію вже підготовлено, але підтвердження ще не завершилось. Спробуйте дію ще раз — дубль не створюється.";
  }
  if (message.includes("ATTACHMENT_REVOKE_CLEANUP_NOT_QUEUED") || message.includes("ATTACHMENT_REVOKE_FAILED")) {
    return "Не вдалося поставити відкликану копію в захищену чергу очищення. Спробуйте ще раз або перевірте аудит.";
  }
  if (message.includes("ATTACHMENT_NOT_AVAILABLE")) {
    return "Файл вкладення не знайдено у приватному сховищі або його доступ уже відкликано.";
  }
  if (message.includes("ATTACHMENT_OPERATION_FAILED")) {
    return "Не вдалося безпечно обробити вкладення. Спробуйте ще раз або перевірте журнал модерації.";
  }
  if (message.includes("PGRST202") || /Could not find the function.*zagulyaka_attachment/i.test(message)) {
    return "Серверні зміни для вкладень ще не застосовані. Застосуйте міграції Supabase та задеплойте Edge Functions.";
  }
  if (message.includes("ATTACHMENT_REVOKED_STORAGE_RETRY_REQUIRED")) {
    return "Публічний доступ уже відкликано. Файл додано до черги повторного очищення сховища.";
  }
  if (message.includes("ZAGULYAKA_SOURCE_REQUIRED")) {
    return "Публікація неможлива без принаймні одного джерела.";
  }
  if (message.includes("ADMIN_PERMISSION_REQUIRED")) {
    return "Вашій адміністративній ролі бракує дозволу zagulyaky.moderate.";
  }
  if (message.includes("DUPLICATE_CONFIRMATION_REQUIRED")) {
    return "Спершу підтвердьте, що це справді дублікати.";
  }
  if (message.includes("DUPLICATE_RESOLUTION_NOTE_REQUIRED") || message.includes("DUPLICATE_MERGE_NOTE_REQUIRED")) {
    return "Для рішення щодо дубліката додайте коротке пояснення.";
  }
  if (message.includes("DUPLICATE_KIND_MISMATCH")) {
    return "Об’єднувати можна лише два записи одного типу.";
  }
  if (message.includes("INVALID_DUPLICATE_SURVIVOR_STATUS")) {
    return "Канонічним може бути лише активний, неархівний і невідхилений запис.";
  }
  if (message.includes("OPEN_ZAGULYAKA_CLAIM_BLOCKS_MERGE")) {
    return "Спершу завершіть усі відкриті скарги й уточнення щодо обох записів.";
  }
  if (message.includes("ZAGULYAKA_CLAIM_ALREADY_CLOSED")) {
    return "Це звернення вже закрито. Для нових обставин створіть нове звернення.";
  }
  if (message.includes("CLAIM_RECORD_ACTION_NOTE_REQUIRED")) {
    return "Для блокування або архівації через звернення додайте пояснення.";
  }
  if (message.includes("REJECTED_CLAIM_CANNOT_CHANGE_RECORD")) {
    return "Відхилене звернення не може одночасно змінювати публічний запис.";
  }
  return message || "Не вдалося виконати операцію.";
}

function detailValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function detailText(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "—";
}

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function ZagulyakyModerationPanel() {
  const [view, setView] = useState<"records" | "claims" | "duplicates">("records");
  const [status, setStatus] = useState<ZagulyakaModerationStatus | "">("pending_review");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<AdminZagulyakaQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<AdminZagulyakaQueueItem | null>(null);
  const [detail, setDetail] = useState<AdminZagulyakaDetail | null>(null);
  const [privacyClearance, setPrivacyClearance] = useState<AdminZagulyakaPrivacyClearance | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<ZagulyakaVerificationStatus>("unverified");
  const [privacyStatus, setPrivacyStatus] = useState<ZagulyakaPrivacyStatus>("pending");
  const [publicSlug, setPublicSlug] = useState("");
  const [moderationNote, setModerationNote] = useState("");
  const [consentObtainedAt, setConsentObtainedAt] = useState("");
  const [consentEvidenceReference, setConsentEvidenceReference] = useState("");
  const [consentPrivateNote, setConsentPrivateNote] = useState("");
  const [attachmentBusyId, setAttachmentBusyId] = useState("");
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [claimStatus, setClaimStatus] = useState<ZagulyakaClaimStatus | "">("open");
  const [claimOffset, setClaimOffset] = useState(0);
  const [claims, setClaims] = useState<AdminZagulyakaClaim[]>([]);
  const [claimsTotal, setClaimsTotal] = useState(0);
  const [selectedClaim, setSelectedClaim] = useState<AdminZagulyakaClaim | null>(null);
  const [claimNote, setClaimNote] = useState("");
  const [claimRecordAction, setClaimRecordAction] = useState<ZagulyakaClaimRecordAction>("none");
  const [duplicateStatus, setDuplicateStatus] = useState<ZagulyakaDuplicateCandidateStatus | "">("pending");
  const [duplicateOffset, setDuplicateOffset] = useState(0);
  const [duplicates, setDuplicates] = useState<AdminZagulyakaDuplicateCandidate[]>([]);
  const [duplicatesTotal, setDuplicatesTotal] = useState(0);
  const [selectedDuplicate, setSelectedDuplicate] = useState<AdminZagulyakaDuplicateCandidate | null>(null);
  const [recordDuplicates, setRecordDuplicates] = useState<AdminZagulyakaDuplicateCandidate[]>([]);
  const [duplicateRecordId, setDuplicateRecordId] = useState("");
  const [duplicateCandidateId, setDuplicateCandidateId] = useState("");
  const [duplicateScore, setDuplicateScore] = useState("0.50");
  const [duplicateReasons, setDuplicateReasons] = useState("");
  const [duplicateNote, setDuplicateNote] = useState("");
  const [duplicateSurvivorId, setDuplicateSurvivorId] = useState("");
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0);
  const [recordsRefreshKey, setRecordsRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const refreshQueue = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await loadAdminZagulyakyQueue(status || null, PAGE_SIZE, offset);
      setItems(page.items);
      setTotal(page.total);
      setSelected((current) => {
        if (!current) return null;
        return page.items.find((item) => item.id === current.id) ?? null;
      });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [offset, status]);

  const refreshClaims = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await loadAdminZagulyakyClaims(claimStatus || null, PAGE_SIZE, claimOffset);
      setClaims(page.items);
      setClaimsTotal(page.total);
      setSelectedClaim((current) => {
        if (!current) return null;
        return page.items.find((item) => item.id === current.id) ?? null;
      });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [claimOffset, claimStatus]);

  const refreshDuplicates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await loadAdminZagulyakaDuplicateCandidates(
        null,
        duplicateStatus || null,
        PAGE_SIZE,
        duplicateOffset,
      );
      setDuplicates(page.items);
      setDuplicatesTotal(page.total);
      setSelectedDuplicate((current) => {
        if (!current) return null;
        return page.items.find((item) => item.recordId === current.recordId
          && item.candidateRecordId === current.candidateRecordId) ?? null;
      });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [duplicateOffset, duplicateStatus]);

  useEffect(() => {
    if (view === "records") void refreshQueue();
    else if (view === "claims") void refreshClaims();
    else if (view === "duplicates") void refreshDuplicates();
  }, [recordsRefreshKey, refreshClaims, refreshDuplicates, refreshQueue, view]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setPrivacyClearance(null);
      setRecordDuplicates([]);
      setAttachmentPreview(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetail(null);
    setVerificationStatus(selected.verificationStatus);
    setPrivacyStatus(selected.privacyStatus);
    setPublicSlug("");
    setModerationNote("");
    setConsentObtainedAt("");
    setConsentEvidenceReference("");
    setConsentPrivateNote("");
    void Promise.all([
      loadAdminZagulyakaDetail(selected.id),
      loadAdminZagulyakaDuplicateCandidates(selected.id, null, 50, 0),
      loadAdminZagulyakaPrivacyClearance(selected.id),
    ])
      .then(([value, candidates, clearance]) => {
        if (!active) return;
        setDetail(value);
        setRecordDuplicates(candidates.items);
        setPrivacyClearance(clearance);
        const slug = value.record.public_slug;
        setPublicSlug(typeof slug === "string" ? slug : "");
        setConsentObtainedAt(clearance.consentObtainedAt ? clearance.consentObtainedAt.slice(0, 10) : "");
        setConsentEvidenceReference(clearance.evidenceReference);
        setConsentPrivateNote(clearance.privateNote);
      })
      .catch((requestError) => {
        if (active) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [reviewRefreshKey, selected]);

  useEffect(() => {
    if (!attachmentPreview || attachmentPreview.expired) return undefined;
    const remainingMs = Math.max(0, attachmentPreview.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setAttachmentPreview((current) => current
        ? { ...current, expired: true }
        : null);
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [attachmentPreview]);

  useEffect(() => {
    setClaimNote(selectedClaim?.resolutionNote ?? "");
    setClaimRecordAction("none");
  }, [selectedClaim]);

  useEffect(() => {
    if (!selectedDuplicate) {
      setDuplicateNote("");
      setDuplicateSurvivorId("");
      return;
    }
    setDuplicateNote("");
    setDuplicateSurvivorId(selectedDuplicate.record.id);
  }, [selectedDuplicate]);

  const runReview = async (action: ZagulyakaModerationAction) => {
    if (!selected || submitting) return;
    if (["request_changes", "reject"].includes(action) && moderationNote.trim().length < 3) {
      setError("Для повернення або відхилення додайте зрозумілий коментар модератора.");
      return;
    }
    const pendingAttachmentIds = action === "publish"
      ? (detail?.attachments ?? [])
        .filter((attachment) => attachment.is_public_derivative !== true)
        .map((attachment) => detailText(attachment, "id"))
        .filter((attachmentId) => attachmentId !== "—")
      : [];
    const publishConfirmation = pendingAttachmentIds.length
      ? `Опублікувати цей запис і створити публічні копії ${pendingAttachmentIds.length} вкладень?`
      : "Опублікувати цей запис?";
    if (["publish", "reject", "archive"].includes(action)
      && !window.confirm(action === "publish" ? publishConfirmation : "Підтвердити цю модераторську дію?")) return;
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const reviewed = await reviewAdminZagulyaka({
        recordId: selected.id,
        expectedLockVersion: selected.lockVersion,
        action,
        note: moderationNote,
        verificationStatus,
        privacyStatus,
        publicSlug,
      });
      if (action === "publish" && pendingAttachmentIds.length) {
        // Copy one original at a time. A batch can contain several 25 MiB PDFs,
        // and parallel browser requests would needlessly exhaust Edge/Storage
        // memory while the moderator is waiting for a single confirmation.
        const publicationErrors: unknown[] = [];
        for (const attachmentId of pendingAttachmentIds) {
          try {
            await publishAdminZagulyakaAttachment(attachmentId);
          } catch (publicationError) {
            publicationErrors.push(publicationError);
          }
        }
        if (publicationErrors.length) {
          setError(`Запис опубліковано, але ${publicationErrors.length} із ${pendingAttachmentIds.length} вкладень не вдалося скопіювати. ${errorMessage(publicationErrors[0])}`);
          setSuccess("Модераторське рішення збережено в журналі аудиту.");
          // Keep the newly published record open so the moderator can retry an
          // individual controlled copy without having to find it in the queue.
          setSelected(reviewed);
          setReviewRefreshKey((value) => value + 1);
        } else {
          setSuccess(`Запис і ${pendingAttachmentIds.length} вкладень опубліковано. Публічні копії доступні з картки.`);
          setSelected(null);
        }
      } else {
        setSuccess("Модераторське рішення збережено в журналі аудиту.");
        setSelected(null);
      }
      await refreshQueue();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const runRecordLivingConsent = async () => {
    if (!selected || !selected.possibleLivingPerson || submitting) return;
    if (!consentObtainedAt || consentEvidenceReference.trim().length < 3) {
      setError("Вкажіть дату та приватне посилання або номер доказу згоди.");
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const clearance = await recordAdminZagulyakaLivingConsent({
        recordId: selected.id,
        consentObtainedAt: new Date(`${consentObtainedAt}T12:00:00`).toISOString(),
        evidenceReference: consentEvidenceReference,
        privateNote: consentPrivateNote,
      });
      setPrivacyClearance(clearance);
      setPrivacyStatus("cleared");
      setSuccess(clearance.publicVisibilityRestored
        ? "Згоду зафіксовано приватно, а видимість раніше опублікованого запису відновлено."
        : "Згоду зафіксовано приватно. Тепер можна окремо обрати «Можна публікувати» й опублікувати запис.");
      // A historical published record is touched when its consent gate is
      // cleared, which advances its optimistic lock. Refresh the selected
      // queue row before any following archive/publish action can reuse it.
      await refreshQueue();
      setReviewRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const runPreviewAttachment = async (attachmentId: string) => {
    if (attachmentBusyId) return;
    setAttachmentBusyId(attachmentId);
    setError("");
    setSuccess("");
    try {
      const access = await previewAdminZagulyakaAttachment(attachmentId);
      const url = safeExternalUrl(access.url);
      if (!url) throw new Error("ATTACHMENT_NOT_AVAILABLE");
      setAttachmentPreview({
        ...access,
        attachmentId,
        url,
        expiresAt: Date.now() + access.expiresIn * 1000,
        expired: false,
      });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setAttachmentBusyId("");
    }
  };

  const runPublishAttachment = async (attachmentId: string) => {
    if (!selected || attachmentBusyId || !window.confirm("Створити контрольовану публічну копію цього вкладення? Вона стане доступною лише разом із публічним записом.")) return;
    setAttachmentBusyId(attachmentId);
    setError("");
    setSuccess("");
    try {
      await publishAdminZagulyakaAttachment(attachmentId);
      setSuccess("Публічну копію вкладення створено. Доступ контролюється через короткочасні посилання.");
      await refreshQueue();
      setReviewRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setAttachmentBusyId("");
    }
  };

  const runRevokeAttachment = async (attachmentId: string) => {
    if (attachmentBusyId || !window.confirm("Відкликати публічну копію вкладення? Нові посилання на неї більше не видаватимуться.")) return;
    setAttachmentBusyId(attachmentId);
    setError("");
    setSuccess("");
    try {
      await revokeAdminZagulyakaAttachment(attachmentId);
      setSuccess("Публічну копію вкладення відкликано.");
      await refreshQueue();
      setReviewRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setAttachmentBusyId("");
    }
  };

  const runClaimAction = async (nextStatus: Exclude<ZagulyakaClaimStatus, "open">) => {
    if (!selectedClaim || submitting) return;
    if (["resolved", "rejected"].includes(nextStatus) && claimNote.trim().length < 3) {
      setError("Для завершення звернення додайте коротке пояснення рішення.");
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await resolveAdminZagulyakaClaim(selectedClaim.id, nextStatus, claimNote, claimRecordAction);
      setSuccess(claimRecordAction === "none"
        ? "Статус звернення оновлено, дію записано в аудит."
        : "Звернення оновлено, а захисну дію для запису зафіксовано в аудиті.");
      setSelectedClaim(null);
      await refreshClaims();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const runCreateDuplicateCandidate = async () => {
    if (submitting) return;
    const recordId = duplicateRecordId.trim();
    const candidateRecordId = duplicateCandidateId.trim();
    if (!recordId || !candidateRecordId || recordId === candidateRecordId) {
      setError("Вкажіть два різні ідентифікатори записів.");
      return;
    }
    const score = Number(duplicateScore.replace(",", "."));
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      setError("Оцінка схожості має бути числом від 0 до 1.");
      return;
    }
    const reasons = duplicateReasons.split("\n").map((value) => value.trim()).filter(Boolean);
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await createAdminZagulyakaDuplicateCandidate({
        recordId,
        candidateRecordId,
        score,
        reasons,
      });
      setSuccess("Кандидата на дублікат додано до черги модерації.");
      setDuplicateCandidateId("");
      setDuplicateReasons("");
      await refreshDuplicates();
      setReviewRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const runResolveDuplicateCandidate = async (nextStatus: Exclude<ZagulyakaDuplicateCandidateStatus, "pending">) => {
    if (!selectedDuplicate || submitting) return;
    if (duplicateNote.trim().length < 3) {
      setError("Для рішення щодо дубліката додайте коротке пояснення.");
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await resolveAdminZagulyakaDuplicateCandidate({
        recordId: selectedDuplicate.recordId,
        candidateRecordId: selectedDuplicate.candidateRecordId,
        status: nextStatus,
        note: duplicateNote,
      });
      setSuccess(nextStatus === "confirmed"
        ? "Дублікат підтверджено. Тепер за потреби можна безпечно об’єднати записи."
        : "Кандидата на дублікат відхилено, рішення записано в аудит.");
      setSelectedDuplicate(null);
      if (nextStatus === "confirmed") {
        setDuplicateStatus("confirmed");
        setDuplicateOffset(0);
      } else {
        await refreshDuplicates();
      }
      setReviewRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const runMergeDuplicate = async () => {
    if (!selectedDuplicate || submitting) return;
    if (selectedDuplicate.status !== "confirmed") {
      setError("Спершу підтвердьте, що це справді дублікати.");
      return;
    }
    if (duplicateNote.trim().length < 3) {
      setError("Для об’єднання дублів додайте коротке пояснення.");
      return;
    }
    const survivor = duplicateSurvivorId === selectedDuplicate.candidate.id
      ? selectedDuplicate.candidate
      : selectedDuplicate.record;
    const merged = survivor.id === selectedDuplicate.record.id
      ? selectedDuplicate.candidate
      : selectedDuplicate.record;
    if (!window.confirm(`Об’єднати «${merged.title}» з «${survivor.title}»? Об’єднаний запис зникне з публічного каталогу.`)) return;
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await mergeAdminZagulyakaDuplicate({
        survivorRecordId: survivor.id,
        mergedRecordId: merged.id,
        survivorExpectedLockVersion: survivor.lockVersion,
        mergedExpectedLockVersion: merged.lockVersion,
        note: duplicateNote,
      });
      setSuccess("Записи об’єднано. Історію та посилання на канонічний запис збережено в аудиті.");
      setSelectedDuplicate(null);
      await Promise.all([refreshDuplicates(), refreshQueue()]);
      setReviewRefreshKey((value) => value + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const reviewActions: ZagulyakaModerationAction[] = !selected ? []
    : selected.status === "pending_review" ? ["publish", "request_changes", "reject"]
      : selected.status === "published" || selected.status === "rejected" ? ["archive"]
        : selected.status === "archived" ? ["restore"] : [];
  const actionLabels: Record<ZagulyakaModerationAction, string> = {
    publish: "Опублікувати",
    request_changes: "Повернути на уточнення",
    reject: "Відхилити",
    archive: "Архівувати",
    restore: "Повернути до черги",
  };
  const hasCurrentLivingClearance = privacyClearance?.reviewStatus === "approved"
    && privacyClearance.clearanceCurrent;
  // Imported and AI-materialized records begin as private drafts. They cannot
  // be published from this state, so show a living-person privacy review only
  // at the actual review/publication stages. The server remains authoritative.
  const requiresLivingPrivacyReview = Boolean(
    selected && (selected.status === "pending_review" || selected.status === "published"),
  );

  return (
    <div className="zagulyaky-moderation">
      {attachmentPreview ? (
        <AttachmentPreviewDialog
          preview={attachmentPreview}
          busy={attachmentBusyId === attachmentPreview.attachmentId}
          error={error}
          onClose={() => setAttachmentPreview(null)}
          onRefresh={() => void runPreviewAttachment(attachmentPreview.attachmentId)}
        />
      ) : null}
      <section className="admin-panel-card zagulyaky-moderation-intro">
        <div>
          <h2>Модерація публічного каталогу</h2>
          <p>Перевіряйте джерела, приватність і нормалізацію перед публікацією. Приватні дерева користувачів тут не відображаються.</p>
        </div>
        <div className="zagulyaky-moderation-tabs" role="tablist" aria-label="Режими модерації">
          <button type="button" role="tab" aria-selected={view === "records"} className={view === "records" ? "active" : ""} onClick={() => setView("records")}>Записи</button>
          <button type="button" role="tab" aria-selected={view === "claims"} className={view === "claims" ? "active" : ""} onClick={() => setView("claims")}>Скарги й уточнення</button>
          <button type="button" role="tab" aria-selected={view === "duplicates"} className={view === "duplicates" ? "active" : ""} onClick={() => setView("duplicates")}>Дублікати</button>
        </div>
      </section>

      {error ? <div className="admin-alert error" role="alert">{error}</div> : null}
      {success ? <div className="admin-alert zagulyaky-success" role="status">{success}</div> : null}

      {view === "records" ? (
        <>
          <section className="admin-panel-card zagulyaky-moderation-toolbar">
            <label>Статус
              <select value={status} onChange={(event) => { setStatus(event.target.value as ZagulyakaModerationStatus | ""); setOffset(0); setSelected(null); }}>
                <option value="">Усі записи</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <span>Знайдено: <strong>{total.toLocaleString("uk-UA")}</strong></span>
            <button type="button" className="button button-secondary" disabled={loading} onClick={() => void refreshQueue()}>Оновити</button>
          </section>

          <div className="zagulyaky-moderation-layout">
            <section className="admin-panel-card zagulyaky-moderation-list">
              <div className="admin-table-wrap">
                <table className="admin-analytics-table">
                  <thead><tr><th>Запис</th><th>Статус</th><th>Джерела</th><th>Подано</th><th aria-label="Дія" /></tr></thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className={selected?.id === item.id ? "selected" : ""}>
                        <td><strong>{item.title}</strong><small>{item.kind === "person" ? "Загуляка людини" : "Загуляка документа"}</small></td>
                        <td><span className={`zagulyaky-status status-${item.status}`}>{STATUS_LABELS[item.status]}</span></td>
                        <td>{item.sourceCount}{item.duplicateCandidateCount ? <small>дублі: {item.duplicateCandidateCount}</small> : null}</td>
                        <td>{displayDate(item.submittedAt)}</td>
                        <td><button type="button" className="button button-secondary" onClick={() => setSelected(item)}>Перевірити</button></td>
                      </tr>
                    ))}
                    {!loading && !items.length ? <tr><td colSpan={5}>У цій черзі записів немає.</td></tr> : null}
                  </tbody>
                </table>
              </div>
              <Pagination offset={offset} total={total} onChange={setOffset} />
            </section>

            {selected ? (
              <section className="admin-panel-card zagulyaky-review-panel" aria-label="Перевірка загуляки">
                <div className="admin-card-heading">
                  <div><span className="eyebrow">{selected.kind === "person" ? "Людина" : "Документ"}</span><h2>{selected.title}</h2></div>
                  <button type="button" className="button button-secondary" onClick={() => setSelected(null)}>Закрити</button>
                </div>
                <dl className="zagulyaky-review-facts">
                  <div><dt>Подія / дата</dt><dd>{selected.eventType ?? "—"} · {selected.eventDateText ?? selected.eventYearFrom ?? "—"}</dd></div>
                  <div><dt>Звідки</dt><dd>{selected.sourceLocationText ?? "—"}</dd></div>
                  <div><dt>Де знайдено</dt><dd>{selected.foundLocationText ?? "—"}</dd></div>
                  <div><dt>Підстава класифікації</dt><dd>{selected.classificationReason || "—"}</dd></div>
                </dl>
                {selected.summary ? <p className="zagulyaky-review-summary">{selected.summary}</p> : null}
                {requiresLivingPrivacyReview && selected.possibleLivingPerson ? (
                  <section className="zagulyaky-living-clearance" aria-label="Підтвердження згоди для живої особи">
                    <div>
                      <h3>Можливо жива особа</h3>
                      <p>Публікація технічно заблокована, доки модератор не зафіксує дату та приватне посилання на документовану згоду.</p>
                    </div>
                    <span className={`zagulyaky-status clearance-${privacyClearance?.reviewStatus ?? "missing"}`}>
                      {hasCurrentLivingClearance
                        ? "Згоду зафіксовано"
                        : privacyClearance?.reviewStatus === "approved"
                          ? "Дані змінилися — оновіть згоду"
                          : "Згоду не зафіксовано"}
                    </span>
                    <label>Дата отримання згоди
                      <input type="date" value={consentObtainedAt} onChange={(event) => setConsentObtainedAt(event.target.value)} disabled={submitting} />
                    </label>
                    <label>Приватне посилання / номер доказу
                      <input value={consentEvidenceReference} onChange={(event) => setConsentEvidenceReference(event.target.value)} maxLength={500} disabled={submitting} placeholder="Напр. consent-2026-001 або private/consents/..." />
                    </label>
                    <label className="wide">Приватна примітка
                      <textarea value={consentPrivateNote} onChange={(event) => setConsentPrivateNote(event.target.value)} rows={2} maxLength={3000} disabled={submitting} />
                    </label>
                    <button type="button" className="button button-secondary" disabled={submitting} onClick={() => void runRecordLivingConsent()}>
                      {hasCurrentLivingClearance ? "Оновити згоду" : "Зафіксувати згоду"}
                    </button>
                  </section>
                ) : null}
                {detailLoading ? <div className="admin-loading">Завантажуємо джерела й учасників…</div> : null}
                {detail ? <ReviewEvidence detail={detail} attachmentBusyId={attachmentBusyId} onPreview={(attachmentId) => void runPreviewAttachment(attachmentId)} onPublish={(attachmentId) => void runPublishAttachment(attachmentId)} onRevoke={(attachmentId) => void runRevokeAttachment(attachmentId)} /> : null}
                {detail ? <ReviewHistory detail={detail} /> : null}
                <RecordDuplicateSummary
                  recordId={selected.id}
                  items={recordDuplicates}
                  loading={detailLoading}
                  onOpenDuplicates={() => {
                    setDuplicateRecordId(selected.id);
                    setView("duplicates");
                  }}
                />

                <div className="zagulyaky-review-form">
                  <label>Достовірність
                    <select value={verificationStatus} onChange={(event) => setVerificationStatus(event.target.value as ZagulyakaVerificationStatus)}>
                      {Object.entries(VERIFICATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label>Приватність
                    <select value={privacyStatus} onChange={(event) => setPrivacyStatus(event.target.value as ZagulyakaPrivacyStatus)}>
                      {Object.entries(PRIVACY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className="wide">Публічна адреса
                    <input value={publicSlug} onChange={(event) => setPublicSlug(event.target.value)} placeholder="Автоматично, якщо лишити порожнім" maxLength={180} />
                  </label>
                  <label className="wide">Коментар модератора
                    <textarea value={moderationNote} onChange={(event) => setModerationNote(event.target.value)} rows={3} maxLength={8000} placeholder="Обов’язково для повернення на уточнення або відхилення" />
                  </label>
                </div>
                <div className="zagulyaky-review-actions">
                  {reviewActions.map((action) => (
                    <button key={action} type="button" disabled={submitting || detailLoading} className={`button ${action === "publish" ? "button-primary" : "button-secondary"}`} onClick={() => void runReview(action)}>{actionLabels[action]}</button>
                  ))}
                  {!reviewActions.length ? <span>Для цього статусу немає доступних переходів.</span> : null}
                </div>
              </section>
            ) : null}
          </div>
        </>
      ) : view === "claims" ? (
        <ClaimsPanel
          status={claimStatus}
          onStatusChange={(value) => { setClaimStatus(value); setClaimOffset(0); setSelectedClaim(null); }}
          items={claims}
          total={claimsTotal}
          offset={claimOffset}
          onOffsetChange={setClaimOffset}
          selected={selectedClaim}
          onSelect={setSelectedClaim}
          note={claimNote}
          onNoteChange={setClaimNote}
          recordAction={claimRecordAction}
          onRecordActionChange={setClaimRecordAction}
          loading={loading || submitting}
          onRefresh={() => void refreshClaims()}
          onAction={(nextStatus) => void runClaimAction(nextStatus)}
        />
      ) : view === "duplicates" ? (
        <DuplicatesPanel
          status={duplicateStatus}
          onStatusChange={(value) => { setDuplicateStatus(value); setDuplicateOffset(0); setSelectedDuplicate(null); }}
          items={duplicates}
          total={duplicatesTotal}
          offset={duplicateOffset}
          onOffsetChange={setDuplicateOffset}
          selected={selectedDuplicate}
          onSelect={setSelectedDuplicate}
          recordId={duplicateRecordId}
          candidateRecordId={duplicateCandidateId}
          score={duplicateScore}
          reasons={duplicateReasons}
          note={duplicateNote}
          survivorId={duplicateSurvivorId}
          onRecordIdChange={setDuplicateRecordId}
          onCandidateRecordIdChange={setDuplicateCandidateId}
          onScoreChange={setDuplicateScore}
          onReasonsChange={setDuplicateReasons}
          onNoteChange={setDuplicateNote}
          onSurvivorIdChange={setDuplicateSurvivorId}
          loading={loading || submitting}
          onRefresh={() => void refreshDuplicates()}
          onCreate={() => void runCreateDuplicateCandidate()}
          onResolve={(nextStatus) => void runResolveDuplicateCandidate(nextStatus)}
          onMerge={() => void runMergeDuplicate()}
        />
      ) : null}
    </div>
  );
}

function ReviewEvidence({
  detail,
  attachmentBusyId,
  onPreview,
  onPublish,
  onRevoke,
}: {
  detail: AdminZagulyakaDetail;
  attachmentBusyId: string;
  onPreview: (attachmentId: string) => void;
  onPublish: (attachmentId: string) => void;
  onRevoke: (attachmentId: string) => void;
}) {
  return (
    <div className="zagulyaky-evidence">
      <section><h3>Учасники ({detail.participants.length})</h3>
        {detail.participants.map((participant, index) => {
          const eventRole = zagulyakaEventRoleLabel(
            String(participant.event_role_code ?? participant.eventRoleCode ?? "").trim(),
            String(
              participant.event_role_custom
              ?? participant.eventRoleCustomText
              ?? participant.eventRoleCustom
              ?? "",
            ).trim(),
          );
          return <p key={String(participant.id ?? index)}><strong>{detailText(participant, "normalized_uk_full_name", "original_full_name")}</strong><span>Роль у події: {eventRole} · {detailText(participant, "origin_text", "residence_text")}</span></p>;
        })}
        {!detail.participants.length ? <p>Не вказано.</p> : null}
      </section>
      <section><h3>Джерела ({detail.sources.length})</h3>
        {detail.sources.map((source, index) => {
          const sourceUrl = safeExternalUrl(source.source_url);
          return <p key={String(source.id ?? index)}><strong>{detailText(source, "title", "citation")}</strong><span>{detailText(source, "archive_name", "citation")}</span>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">Відкрити джерело</a> : null}</p>;
        })}
        {!detail.sources.length ? <p>Джерел немає.</p> : null}
      </section>
      {detail.privateSourceLinks.length ? <PrivateSourceLinks origins={detail.privateSourceLinks} /> : null}
      {detail.documentDiscoveries.length ? <section><h3>Знахідка документа</h3>{detail.documentDiscoveries.map((discovery, index) => <p key={index}><strong>{detailText(discovery, "official_location_text")}</strong><span>Знайдено: {detailText(discovery, "discovered_location_text")}</span></p>)}</section> : null}
      <section className="zagulyaky-attachment-review"><h3>Приватні вкладення ({detail.attachments.length})</h3>
        <p>Оригінал доступний модератору лише за коротким приватним посиланням. Публічна копія створюється окремою контрольованою дією після публікації запису.</p>
        {detail.attachments.map((attachment, index) => {
          const id = detailText(attachment, "id");
          const isPublished = attachment.is_public_derivative === true;
          const busy = attachmentBusyId === id;
          return <article key={id === "—" ? String(index) : id}>
            <div><strong>{detailText(attachment, "file_name")}</strong><span>{detailText(attachment, "mime_type")} · {formatBytes(attachment.byte_size)}</span></div>
            <div className="zagulyaky-attachment-actions">
              <button type="button" className="button button-secondary" disabled={busy || id === "—"} onClick={() => onPreview(id)}>{busy ? "Готуємо…" : "Переглянути приватно"}</button>
              {isPublished
                ? <button type="button" className="button button-ghost" disabled={busy || id === "—"} onClick={() => onRevoke(id)}>{busy ? "Відкликаємо…" : "Відкликати публічну копію"}</button>
                : <button type="button" className="button button-primary" disabled={busy || id === "—"} onClick={() => onPublish(id)}>{busy ? "Створюємо…" : "Створити публічну копію"}</button>}
            </div>
          </article>;
        })}
        {!detail.attachments.length ? <p>Вкладень немає.</p> : null}
      </section>
      <section><h3>Оригінальний текст</h3><p className="zagulyaky-original-text">{detailValue(detail.record, "original_text")}</p></section>
    </div>
  );
}

function AttachmentPreviewDialog({
  preview,
  busy,
  error,
  onClose,
  onRefresh,
}: {
  preview: AttachmentPreview;
  busy: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isImage = preview.mimeType.toLowerCase().startsWith("image/");
  const isPdf = preview.mimeType.toLowerCase() === "application/pdf";

  return (
    <Modal
      title={`Приватний перегляд: ${preview.fileName}`}
      className="zagulyaky-attachment-preview-modal"
      viewportBounded
      onClose={onClose}
    >
      <div className="zagulyaky-attachment-preview">
        <p className="zagulyaky-attachment-preview-notice">
          Файл доступний лише модератору за короткочасним приватним посиланням. Ця дія не створює публічної копії.
        </p>
        {error ? <div className="admin-alert error" role="alert">{error}</div> : null}
        {preview.expired ? (
          <div className="zagulyaky-attachment-preview-expired" role="status">
            <strong>Приватне посилання вже втратило чинність.</strong>
            <span>Оновіть його, щоб продовжити перегляд.</span>
            <button type="button" className="button button-secondary" disabled={busy} onClick={onRefresh}>
              {busy ? "Оновлюємо…" : "Оновити приватне посилання"}
            </button>
          </div>
        ) : (
          <>
            <div className="zagulyaky-attachment-preview-frame">
              {isImage ? (
                <img src={preview.url} alt={preview.fileName} referrerPolicy="no-referrer" />
              ) : isPdf ? (
                <iframe src={preview.url} title={preview.fileName} referrerPolicy="no-referrer" />
              ) : (
                <div className="zagulyaky-attachment-preview-unsupported">
                  <strong>Для цього типу файлу немає вбудованого перегляду.</strong>
                  <span>{preview.mimeType || "Тип файлу не вказано"}</span>
                </div>
              )}
            </div>
            <div className="zagulyaky-attachment-preview-actions">
              <a className="button button-secondary" href={preview.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                Відкрити окремо
              </a>
              <a className="button button-ghost" href={preview.url} referrerPolicy="no-referrer">
                Відкрити в цій вкладці
              </a>
              <button type="button" className="button button-secondary" onClick={onClose}>Закрити</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** This moderator-only provenance is never part of the public catalogue response. */
function PrivateSourceLinks({ origins }: { origins: AdminZagulyakaDetail["privateSourceLinks"] }) {
  return (
    <section className="zagulyaky-private-source-links" aria-label="Приватні посилання на оригінали">
      <h3>Приватне посилання на оригінал ({origins.length})</h3>
      <p>Видно лише модераторам. Посилання не публікується в каталозі автоматично.</p>
      {origins.map((origin, index) => {
        const facebookPostUrl = safeExternalUrl(origin.facebookPostUrl);
        const sourceTitle = origin.sourceTitleOriginal || origin.sourcePlatform || "Джерело";
        const rowKey = `${origin.sourcePlatform}:${origin.facebookPostUrl}:${index}`;
        return (
          <article key={rowKey}>
            <div>
              <strong>{sourceTitle}</strong>
              <span>Приватне посилання · {origin.sourcePlatform || "платформа не вказана"}</span>
            </div>
            <div className="zagulyaky-private-source-link-actions">
              {facebookPostUrl ? <a href={facebookPostUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Відкрити оригінальний допис Facebook</a> : null}
              {!facebookPostUrl ? <small>Приватного посилання не збережено.</small> : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1) return "розмір не вказано";
  if (bytes < 1024) return `${Math.trunc(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function ReviewHistory({ detail }: { detail: AdminZagulyakaDetail }) {
  return (
    <section className="zagulyaky-history" aria-label="Версії та аудит запису">
      <details>
        <summary>Версії запису <span>{detail.versions.length}</span></summary>
        <div className="zagulyaky-history-list">
          {detail.versions.map((version) => {
            const attachmentSummary = snapshotAttachmentSummary(version.snapshot);
            return (
              <article key={version.id}>
                <strong>Ревізія {version.revisionNo || "—"}</strong>
                <span>{snapshotTitle(version.snapshot)} · {displayDate(version.createdAt)}{attachmentSummary ? ` · ${attachmentSummary}` : ""}</span>
              </article>
            );
          })}
          {!detail.versions.length ? <p>Знімків версій поки що немає.</p> : null}
        </div>
      </details>
      <details>
        <summary>Журнал модерації <span>{detail.moderationActions.length}</span></summary>
        <div className="zagulyaky-history-list">
          {detail.moderationActions.map((action) => (
            <article key={action.id}>
              <strong>{MODERATION_ACTION_LABELS[action.action] ?? action.action}</strong>
              <span>{displayDate(action.createdAt)}</span>
              {action.note ? <p>{action.note}</p> : null}
              {Object.keys(action.metadata).length ? <small>{metadataSummary(action.metadata)}</small> : null}
            </article>
          ))}
          {!detail.moderationActions.length ? <p>Модераторських дій поки що немає.</p> : null}
        </div>
      </details>
      <details>
        <summary>Системний аудит <span>{detail.adminAudit.length}</span></summary>
        <div className="zagulyaky-history-list">
          {detail.adminAudit.map((audit) => (
            <article key={audit.id}>
              <strong>{audit.actionCode || "Адміністративна дія"}</strong>
              <span>{displayDate(audit.createdAt)} · {audit.outcome}</span>
              {Object.keys(audit.sanitizedDiff).length ? <small>{metadataSummary(audit.sanitizedDiff)}</small> : null}
            </article>
          ))}
          {!detail.adminAudit.length ? <p>Аудит-дій для цього запису поки що немає.</p> : null}
        </div>
      </details>
    </section>
  );
}

function RecordDuplicateSummary({
  recordId,
  items,
  loading,
  onOpenDuplicates,
}: {
  recordId: string;
  items: AdminZagulyakaDuplicateCandidate[];
  loading: boolean;
  onOpenDuplicates: () => void;
}) {
  return (
    <section className="zagulyaky-record-duplicates" aria-label="Кандидати на дублікати">
      <div>
        <h3>Дублікати</h3>
        <p>Кандидати: {loading ? "завантажуємо…" : items.length}</p>
      </div>
      <button type="button" className="button button-secondary" onClick={onOpenDuplicates}>Відкрити чергу дублів</button>
      {!loading && items.length ? <ul>
        {items.slice(0, 4).map((item) => {
          const counterpart = item.record.id === recordId ? item.candidate : item.record;
          return <li key={`${item.recordId}:${item.candidateRecordId}`}><span className={`zagulyaky-status duplicate-${item.status}`}>{DUPLICATE_STATUS_LABELS[item.status]}</span><strong>{counterpart.title}</strong><small>схожість {formatScore(item.score)}</small></li>;
        })}
      </ul> : null}
    </section>
  );
}

function snapshotTitle(snapshot: Record<string, unknown>): string {
  const value = snapshot.record;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const title = (value as Record<string, unknown>).title;
    const status = (value as Record<string, unknown>).status;
    return [typeof title === "string" && title.trim() ? title : "Без назви", typeof status === "string" ? status : ""].filter(Boolean).join(" · ");
  }
  return "Знімок без заголовка";
}

function snapshotAttachmentSummary(snapshot: Record<string, unknown>): string {
  const manifest = snapshot.attachmentManifest;
  if (!Array.isArray(manifest)) return "";
  const count = manifest.length;
  if (!count) return "без вкладень";
  return `${count} ${count === 1 ? "вкладення" : count >= 2 && count <= 4 ? "вкладення" : "вкладень"}`;
}

function metadataSummary(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata).slice(0, 4).map(([key, value]) => `${key}: ${typeof value === "string" ? value : String(value)}`);
  return entries.join(" · ");
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

interface ClaimsPanelProps {
  status: ZagulyakaClaimStatus | "";
  onStatusChange: (value: ZagulyakaClaimStatus | "") => void;
  items: AdminZagulyakaClaim[];
  total: number;
  offset: number;
  onOffsetChange: (value: number) => void;
  selected: AdminZagulyakaClaim | null;
  onSelect: (value: AdminZagulyakaClaim | null) => void;
  note: string;
  onNoteChange: (value: string) => void;
  recordAction: ZagulyakaClaimRecordAction;
  onRecordActionChange: (value: ZagulyakaClaimRecordAction) => void;
  loading: boolean;
  onRefresh: () => void;
  onAction: (status: Exclude<ZagulyakaClaimStatus, "open">) => void;
}

function ClaimsPanel(props: ClaimsPanelProps) {
  return (
    <div className="zagulyaky-moderation-layout">
      <section className="admin-panel-card zagulyaky-moderation-list">
        <div className="zagulyaky-claims-toolbar">
          <label>Статус<select value={props.status} onChange={(event) => props.onStatusChange(event.target.value as ZagulyakaClaimStatus | "")}><option value="">Усі</option>{Object.entries(CLAIM_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <span>Знайдено: <strong>{props.total.toLocaleString("uk-UA")}</strong></span>
          <button type="button" className="button button-secondary" disabled={props.loading} onClick={props.onRefresh}>Оновити</button>
        </div>
        <div className="admin-table-wrap"><table className="admin-analytics-table"><thead><tr><th>Запис</th><th>Тип</th><th>Статус</th><th>Створено</th><th /></tr></thead><tbody>
          {props.items.map((claim) => <tr key={claim.id} className={props.selected?.id === claim.id ? "selected" : ""}><td><strong>{claim.recordTitle}</strong></td><td>{CLAIM_TYPE_LABELS[claim.claimType] ?? claim.claimType}</td><td>{CLAIM_STATUS_LABELS[claim.status]}</td><td>{displayDate(claim.createdAt)}</td><td><button type="button" className="button button-secondary" onClick={() => props.onSelect(claim)}>Розглянути</button></td></tr>)}
          {!props.loading && !props.items.length ? <tr><td colSpan={5}>Звернень у цій черзі немає.</td></tr> : null}
        </tbody></table></div>
        <Pagination offset={props.offset} total={props.total} onChange={props.onOffsetChange} />
      </section>
      {props.selected ? <section className="admin-panel-card zagulyaky-claim-panel"><div className="admin-card-heading"><div><span className="eyebrow">{CLAIM_TYPE_LABELS[props.selected.claimType] ?? props.selected.claimType}</span><h2>{props.selected.recordTitle}</h2></div><button type="button" className="button button-secondary" onClick={() => props.onSelect(null)}>Закрити</button></div><p className="zagulyaky-claim-message">{props.selected.message}</p><label>Рішення<textarea rows={4} value={props.note} onChange={(event) => props.onNoteChange(event.target.value)} maxLength={8000} placeholder="Пояснення для журналу модерації" /></label>{!(["resolved", "rejected"] as ZagulyakaClaimStatus[]).includes(props.selected.status) ? <label>Дія для публічного запису<select value={props.recordAction} onChange={(event) => props.onRecordActionChange(event.target.value as ZagulyakaClaimRecordAction)}>{Object.entries(CLAIM_RECORD_ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}<p className="zagulyaky-claim-safety-note">Блокування приховує запис з каталогу одразу. Архівація доступна після остаточного вирішення звернення.</p><div className="zagulyaky-review-actions">{props.selected.status === "open" ? <button type="button" className="button button-secondary" disabled={props.loading || props.recordAction === "archive"} onClick={() => props.onAction("reviewing")}>Взяти в роботу</button> : null}{!(["resolved", "rejected"] as ZagulyakaClaimStatus[]).includes(props.selected.status) ? <><button type="button" className="button button-primary" disabled={props.loading} onClick={() => props.onAction("resolved")}>Позначити вирішеним</button><button type="button" className="button button-secondary" disabled={props.loading || props.recordAction !== "none"} onClick={() => props.onAction("rejected")}>Відхилити</button></> : null}</div></section> : null}
    </div>
  );
}

interface DuplicatesPanelProps {
  status: ZagulyakaDuplicateCandidateStatus | "";
  onStatusChange: (value: ZagulyakaDuplicateCandidateStatus | "") => void;
  items: AdminZagulyakaDuplicateCandidate[];
  total: number;
  offset: number;
  onOffsetChange: (value: number) => void;
  selected: AdminZagulyakaDuplicateCandidate | null;
  onSelect: (value: AdminZagulyakaDuplicateCandidate | null) => void;
  recordId: string;
  candidateRecordId: string;
  score: string;
  reasons: string;
  note: string;
  survivorId: string;
  onRecordIdChange: (value: string) => void;
  onCandidateRecordIdChange: (value: string) => void;
  onScoreChange: (value: string) => void;
  onReasonsChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSurvivorIdChange: (value: string) => void;
  loading: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onResolve: (status: Exclude<ZagulyakaDuplicateCandidateStatus, "pending">) => void;
  onMerge: () => void;
}

function DuplicatesPanel(props: DuplicatesPanelProps) {
  const selected = props.selected;
  const canMerge = selected?.status === "confirmed"
    && selected.record.status !== "merged"
    && selected.candidate.status !== "merged";
  return (
    <div className="zagulyaky-duplicates-layout">
      <section className="admin-panel-card zagulyaky-duplicate-create">
        <div className="admin-card-heading">
          <div><span className="eyebrow">Ручна перевірка</span><h2>Новий кандидат на дублікат</h2></div>
        </div>
        <p>Вкажіть два внутрішні ID записів. Об’єднання стане доступним лише після окремого підтвердження пари.</p>
        <div className="zagulyaky-duplicate-create-form">
          <label>ID першого запису<input value={props.recordId} onChange={(event) => props.onRecordIdChange(event.target.value)} placeholder="UUID запису" /></label>
          <label>ID можливого дубля<input value={props.candidateRecordId} onChange={(event) => props.onCandidateRecordIdChange(event.target.value)} placeholder="UUID запису" /></label>
          <label>Оцінка схожості (0–1)<input type="number" min="0" max="1" step="0.01" inputMode="decimal" value={props.score} onChange={(event) => props.onScoreChange(event.target.value)} /></label>
          <label className="wide">Підстави, по одній у рядку<textarea rows={3} value={props.reasons} onChange={(event) => props.onReasonsChange(event.target.value)} maxLength={12000} placeholder="Збіг ПІБ і року народження&#10;Те саме архівне джерело" /></label>
        </div>
        <div className="zagulyaky-review-actions"><button type="button" className="button button-primary" disabled={props.loading} onClick={props.onCreate}>Додати до черги дублів</button></div>
      </section>

      <section className="admin-panel-card zagulyaky-moderation-list">
        <div className="zagulyaky-claims-toolbar">
          <label>Статус<select value={props.status} onChange={(event) => props.onStatusChange(event.target.value as ZagulyakaDuplicateCandidateStatus | "")}><option value="">Усі</option>{Object.entries(DUPLICATE_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <span>Знайдено: <strong>{props.total.toLocaleString("uk-UA")}</strong></span>
          <button type="button" className="button button-secondary" disabled={props.loading} onClick={props.onRefresh}>Оновити</button>
        </div>
        <div className="admin-table-wrap"><table className="admin-analytics-table"><thead><tr><th>Записи</th><th>Схожість</th><th>Статус</th><th>Створено</th><th /></tr></thead><tbody>
          {props.items.map((item) => <tr key={`${item.recordId}:${item.candidateRecordId}`} className={selected?.recordId === item.recordId && selected?.candidateRecordId === item.candidateRecordId ? "selected" : ""}><td><strong>{item.record.title}</strong><small>{item.candidate.title}</small></td><td>{formatScore(item.score)}</td><td><span className={`zagulyaky-status duplicate-${item.status}`}>{DUPLICATE_STATUS_LABELS[item.status]}</span></td><td>{displayDate(item.createdAt)}</td><td><button type="button" className="button button-secondary" onClick={() => props.onSelect(item)}>Перевірити</button></td></tr>)}
          {!props.loading && !props.items.length ? <tr><td colSpan={5}>Кандидатів у цій черзі немає.</td></tr> : null}
        </tbody></table></div>
        <Pagination offset={props.offset} total={props.total} onChange={props.onOffsetChange} />
      </section>

      {selected ? <section className="admin-panel-card zagulyaky-duplicate-review"><div className="admin-card-heading"><div><span className="eyebrow">Кандидат на дублікат</span><h2>{selected.record.title} ↔ {selected.candidate.title}</h2></div><button type="button" className="button button-secondary" onClick={() => props.onSelect(null)}>Закрити</button></div><dl className="zagulyaky-review-facts"><div><dt>Перший запис</dt><dd>{selected.record.id}<br />{STATUS_LABELS[selected.record.status]}</dd></div><div><dt>Другий запис</dt><dd>{selected.candidate.id}<br />{STATUS_LABELS[selected.candidate.status]}</dd></div><div><dt>Схожість</dt><dd>{formatScore(selected.score)}</dd></div><div><dt>Статус</dt><dd>{DUPLICATE_STATUS_LABELS[selected.status]}</dd></div></dl>{selected.reasons.length ? <section className="zagulyaky-duplicate-reasons"><h3>Підстави</h3><ul>{selected.reasons.map((reason, index) => <li key={index}>{typeof reason === "string" ? reason : JSON.stringify(reason)}</li>)}</ul></section> : <p>Підстави не вказано.</p>}<label>Коментар модератора<textarea rows={4} value={props.note} onChange={(event) => props.onNoteChange(event.target.value)} maxLength={8000} placeholder="Обов’язково для підтвердження, відхилення або об’єднання" /></label>{canMerge ? <label>Залишити канонічним<select value={props.survivorId} onChange={(event) => props.onSurvivorIdChange(event.target.value)}><option value={selected.record.id}>{selected.record.title}</option><option value={selected.candidate.id}>{selected.candidate.title}</option></select></label> : null}<div className="zagulyaky-review-actions">{selected.status === "pending" ? <><button type="button" className="button button-primary" disabled={props.loading} onClick={() => props.onResolve("confirmed")}>Підтвердити дублікат</button><button type="button" className="button button-secondary" disabled={props.loading} onClick={() => props.onResolve("dismissed")}>Не дублі</button></> : null}{canMerge ? <button type="button" className="button button-danger" disabled={props.loading} onClick={props.onMerge}>Об’єднати записи</button> : null}{selected.status === "confirmed" && !canMerge ? <span>Пара підтверджена, але один із записів уже об’єднано.</span> : null}</div></section> : null}
    </div>
  );
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (value: number) => void }) {
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  return <div className="zagulyaky-pagination"><button type="button" className="button button-secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>← Назад</button><span>{page} / {pages}</span><button type="button" className="button button-secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => onChange(offset + PAGE_SIZE)}>Далі →</button></div>;
}
