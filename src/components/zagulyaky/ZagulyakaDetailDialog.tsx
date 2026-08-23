import { useState, type FormEvent } from "react";
import { Modal } from "../Modal";
import type { ZagulyakaDetail, ZagulyakaParticipant } from "../../types/zagulyaky";
import type { SupabaseAccount } from "../../services/supabaseAuth";
import { createZagulyakaClaim } from "../../services/zagulyakyService";
import { sanitizeWebUrl } from "../../utils/safeUrl";
import { zagulyakaEventRoleLabel } from "../../utils/zagulyakyEventRoles";
import {
  zagulyakaEventLabels,
  zagulyakaVerificationLabels,
} from "../../utils/zagulyakyLabels";
import { ZagulyakaRouteMap } from "./ZagulyakaRouteMap";

export function ZagulyakaDetailDialog({
  detail,
  loading,
  error,
  onClose,
  account = null,
  onRequestSignIn,
}: {
  detail: ZagulyakaDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
  account?: SupabaseAccount | null;
  onRequestSignIn?: () => void;
}) {
  const safeSourceUrl = sanitizeWebUrl(detail?.source?.sourceUrl);
  const safeOriginalPostUrl = sanitizeFacebookPostUrl(detail?.originalPostUrl);
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [claimType, setClaimType] = useState<"correction" | "privacy" | "copyright" | "abuse" | "source_problem" | "other">("correction");
  const [claimMessage, setClaimMessage] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimNotice, setClaimNotice] = useState("");
  const [claimError, setClaimError] = useState("");

  const submitClaim = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !account) return;
    setClaimBusy(true);
    setClaimError("");
    setClaimNotice("");
    try {
      await createZagulyakaClaim(detail.id, claimType, claimMessage, account.id);
      setClaimMessage("");
      setShowClaimForm(false);
      setClaimNotice("Уточнення надіслано модератору. Воно не буде опубліковане автоматично.");
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError ?? "");
      setClaimError(message || "Не вдалося надіслати уточнення.");
    } finally {
      setClaimBusy(false);
    }
  };
  return (
    <Modal
      title={detail?.title || "Картка загуляки"}
      className="zagulyaky-detail-modal"
      onClose={onClose}
    >
      <div className="zagulyaky-detail-body">
        {loading ? <ZagulyakyDetailSkeleton /> : null}
        {!loading && error ? (
          <div className="zagulyaky-state zagulyaky-state-error" role="alert">
            <strong>Не вдалося відкрити запис</strong>
            <p>{error}</p>
          </div>
        ) : null}
        {!loading && !error && !detail ? (
          <div className="zagulyaky-state">Запис не знайдено або ще не опубліковано.</div>
        ) : null}
        {!loading && !error && detail ? (
          <>
            <header className="zagulyaky-detail-heading">
              <div>
                <span className="eyebrow">{detail.kind === "person" ? "Запис про особу" : "Загуляка документів"}</span>
                <h2>{detail.title}</h2>
                {detail.summary ? <p>{detail.summary}</p> : null}
              </div>
              <span className={`zagulyaky-status status-${detail.verificationStatus}`}>
                {zagulyakaVerificationLabels[detail.verificationStatus]}
              </span>
            </header>

            <dl className="zagulyaky-facts">
              {detail.kind === "person" ? (
                <>
                  <Fact label="Написання в джерелі" value={detail.originalName} />
                  <Fact label="Нормалізовано українською" value={detail.normalizedNameUk} />
                  <Fact label="Подія" value={detail.eventType ? zagulyakaEventLabels[detail.eventType] : ""} />
                  <Fact label="Роль у події" value={participantEventRoleLabel(detail.participants.find((participant) => participant.role === "subject"))} />
                  <Fact label="Дата" value={detail.eventDateLabel || yearRange(detail.eventYearFrom, detail.eventYearTo)} />
                  <Fact label="Походження" value={detail.originPlace} />
                  <Fact label="Де знайдено" value={detail.foundPlace} />
                </>
              ) : (
                <>
                  <Fact label="Тип документа" value={detail.documentType} />
                  <Fact label="Місце в офіційному описі" value={detail.officialPlace} />
                  <Fact label="Додатково знайдено" value={detail.foundPlace} />
                  <Fact label="Фактичні роки" value={yearRange(detail.eventYearFrom, detail.eventYearTo)} />
                  <Fact label="Сторінки / кадри" value={detail.pageRange} />
                  <Fact label="Типи записів" value={detail.recordTypes.join(", ")} />
                </>
              )}
            </dl>

            <ZagulyakaRouteMap
              origin={detail.originGeo}
              found={detail.foundGeo}
              originPlaceLabel={detail.kind === "person" ? detail.originPlace : detail.officialPlace || detail.originPlace}
              foundPlaceLabel={detail.foundPlace}
              originRoleLabel={detail.kind === "person" ? "Звідки людина" : "Місце документа"}
            />

            {detail.reason ? (
              <section className="zagulyaky-detail-section">
                <h3>Чому це загуляка</h3>
                <p>{detail.reason}</p>
              </section>
            ) : null}

            {detail.originalText || detail.normalizedTextUk ? (
              <section className="zagulyaky-transcription-grid">
                <article>
                  <span className="eyebrow">Мова джерела</span>
                  <p>{detail.originalText || "—"}</p>
                </article>
                <article>
                  <span className="eyebrow">Українська</span>
                  <p>{detail.normalizedTextUk || "—"}</p>
                </article>
              </section>
            ) : null}

            {detail.participants.length ? (
              <section className="zagulyaky-detail-section">
                <h3>Пов’язані учасники</h3>
                <div className="zagulyaky-participants">
                  {detail.participants.map((participant) => (
                    <article key={participant.id}>
                      <strong>{participant.normalizedNameUk || participant.originalName || "Без імені"}</strong>
                      <span>Роль у події: {participantEventRoleLabel(participant)}</span>
                      {participant.originalName && participant.originalName !== participant.normalizedNameUk
                        ? <small>{participant.originalName}</small>
                        : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {detail.source ? (
              <section className="zagulyaky-source-card">
                <div>
                  <span className="eyebrow">Джерело</span>
                  <h3>{detail.source.sourceTitle || detail.source.institutionName || "Зовнішнє джерело"}</h3>
                  <p>{[detail.source.institutionName, detail.source.archiveReference, detail.source.pageLabel].filter(Boolean).join(" · ")}</p>
                  {detail.source.accessRequiresLogin ? <small>Для перегляду джерела може знадобитися вхід.</small> : null}
                </div>
                {safeSourceUrl ? (
                  <a className="button button-secondary" href={safeSourceUrl} target="_blank" rel="noreferrer noopener">
                    Відкрити джерело
                  </a>
                ) : null}
              </section>
            ) : null}

            {safeOriginalPostUrl ? (
              <section className="zagulyaky-original-post-card" aria-label="Оригінальний допис Facebook">
                <div>
                  <span className="eyebrow">Оригінальний допис</span>
                  <h3>Facebook</h3>
                  <p>Посилання додано до публічної картки після окремого підтвердження права на його оприлюднення.</p>
                </div>
                <a
                  className="button button-secondary"
                  href={safeOriginalPostUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  referrerPolicy="no-referrer"
                >
                  Відкрити оригінальний допис Facebook
                </a>
              </section>
            ) : null}

            {detail.publicMedia.length ? (
              <section className="zagulyaky-detail-section">
                <h3>Докази</h3>
                <div className="zagulyaky-media-grid">
                  {detail.publicMedia.map((media) => {
                    const safeMediaUrl = sanitizeWebUrl(media.url);
                    if (!safeMediaUrl) return null;
                    return (
                      <a href={safeMediaUrl} target="_blank" rel="noreferrer noopener" key={media.id}>
                        {media.mimeType.startsWith("image/")
                          ? <img src={safeMediaUrl} alt={media.alt || media.name} loading="lazy" />
                          : <span>{media.name}</span>}
                      </a>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <footer className="zagulyaky-detail-footer">
              <span>{detail.confirmationsCount} {confirmationWord(detail.confirmationsCount)}</span>
              {detail.contributor ? <span>Додав(ла): {detail.contributor}</span> : null}
              <span>Публічний ID: {detail.id.slice(0, 8)}</span>
              {account ? <button type="button" className="button button-ghost" onClick={() => { setShowClaimForm((current) => !current); setClaimError(""); }}>Уточнити запис</button> : <button type="button" className="button button-ghost" onClick={onRequestSignIn}>Увійдіть, щоб уточнити</button>}
            </footer>
            {claimNotice ? <p className="zagulyaky-claim-notice" role="status">{claimNotice}</p> : null}
            {showClaimForm && account ? (
              <form className="zagulyaky-claim-form" onSubmit={(event) => void submitClaim(event)}>
                <h3>Уточнення або скарга</h3>
                <p>Надішліть виправлення, повідомлення про приватність, авторські права або проблему з джерелом. Модератор розгляне його приватно.</p>
                <label><span>Тип</span><select value={claimType} onChange={(event) => setClaimType(event.target.value as typeof claimType)}><option value="correction">Виправлення</option><option value="privacy">Приватність</option><option value="copyright">Авторські права</option><option value="source_problem">Проблема з джерелом</option><option value="abuse">Зловживання</option><option value="other">Інше</option></select></label>
                <label><span>Повідомлення</span><textarea value={claimMessage} onChange={(event) => setClaimMessage(event.target.value)} rows={4} minLength={10} maxLength={8000} required /></label>
                {claimError ? <p className="zagulyaky-claim-error" role="alert">{claimError}</p> : null}
                <div><button type="button" className="button button-secondary" disabled={claimBusy} onClick={() => setShowClaimForm(false)}>Скасувати</button><button type="submit" className="button button-primary" disabled={claimBusy}>{claimBusy ? "Надсилаємо…" : "Надіслати модератору"}</button></div>
              </form>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function participantEventRoleLabel(participant: ZagulyakaParticipant | undefined): string {
  return zagulyakaEventRoleLabel(
    participant?.eventRoleCode,
    participant?.eventRoleCustomText,
  );
}

/**
 * An original-post link is more sensitive than a normal source link.  Even
 * though the server exposes it only after a publication approval, keep the
 * browser renderer narrow as a second line of defence: it may only navigate
 * to an http(s) Facebook host and never to a private or arbitrary URL.
 */
function sanitizeFacebookPostUrl(value: unknown): string | null {
  const url = sanitizeWebUrl(value);
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const facebookHost = ["facebook.com", "fb.com", "fb.me"]
      .some((domain) => host === domain || host.endsWith(`.${domain}`));
    return facebookHost ? url : null;
  } catch {
    return null;
  }
}

function ZagulyakyDetailSkeleton() {
  return (
    <div className="zagulyaky-detail-skeleton" aria-label="Завантажуємо запис">
      <span /><span /><span /><span />
    </div>
  );
}

function yearRange(from: number | null, to: number | null): string {
  if (from === null && to === null) return "";
  if (from === to || to === null) return String(from ?? to);
  if (from === null) return `до ${to}`;
  return `${from}–${to}`;
}

function confirmationWord(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return "підтверджень";
  if (last === 1) return "підтвердження";
  if (last >= 2 && last <= 4) return "підтвердження";
  return "підтверджень";
}
