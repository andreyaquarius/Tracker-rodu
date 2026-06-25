import { useEffect, useState, type FormEvent } from "react";
import {
  createGeneHelpSimpleRequest,
  getGeneHelpAccountStatus,
  getGeneHelpRequestStatus,
  type GeneHelpAccountStatus,
  type GeneHelpSimpleRequestResponse,
} from "../services/geneHelp";
import { sanitizeWebUrl } from "../utils/safeUrl";
import { Modal } from "./Modal";

interface GeneHelpRequestModalProps {
  onClose: () => void;
}

export function GeneHelpRequestModal({ onClose }: GeneHelpRequestModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [createdRequest, setCreatedRequest] =
    useState<GeneHelpSimpleRequestResponse | null>(null);
  const [busy, setBusy] = useState<"create" | "status" | null>(null);
  const [accountStatus, setAccountStatus] = useState<GeneHelpAccountStatus | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    void getGeneHelpAccountStatus()
      .then((status) => {
        if (!active) return;
        setAccountStatus(status);
      })
      .catch((error) => {
        if (!active) return;
        setMessage({
          text: readableError(error, "Не вдалося перевірити підключення GeneHelp."),
          error: true,
        });
      })
      .finally(() => {
        if (active) setAccountLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!description.trim()) {
      setMessage({ text: "Опишіть, яка саме допомога потрібна в GeneHelp.", error: true });
      return;
    }
    if (!accountStatus?.connected) {
      setConsentChecked(false);
      setConsentOpen(true);
      return;
    }
    await submitRequest(false);
  };

  const submitRequest = async (registrationConsent: boolean) => {
    setBusy("create");
    setMessage(null);
    try {
      const response = await createGeneHelpSimpleRequest({
        title: title.trim(),
        description: description.trim(),
        registrationConsent,
      });
      setCreatedRequest(response);
      setAccountStatus((current) => current ? { ...current, connected: true } : current);
      setTitle("");
      setDescription("");
      setMessage({ text: response.message || "Запит передано в GeneHelp." });
    } catch (error) {
      setMessage({
        text: readableError(error, "Не вдалося передати запит у GeneHelp."),
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const confirmRegistrationConsent = async () => {
    if (!consentChecked) return;
    setConsentOpen(false);
    await submitRequest(true);
  };

  const refreshStatus = async () => {
    if (!createdRequest?.id) return;
    setBusy("status");
    setMessage(null);
    try {
      const response = await getGeneHelpRequestStatus(createdRequest.id);
      setCreatedRequest(response);
      setMessage({ text: "Статус GeneHelp оновлено." });
    } catch (error) {
      setMessage({
        text: readableError(error, "Не вдалося оновити статус GeneHelp."),
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Допомога GeneHelp" onClose={onClose}>
      {consentOpen ? (
        <GeneHelpConsentStep
          account={accountStatus}
          checked={consentChecked}
          busy={busy === "create"}
          onCheckedChange={setConsentChecked}
          onCancel={() => setConsentOpen(false)}
          onConfirm={() => void confirmRegistrationConsent()}
        />
      ) : (
        <form className="genehelp-request-modal" onSubmit={create}>
        <div className="genehelp-intro">
          <span className="eyebrow">Партнерський сервіс</span>
          <p>
            Опишіть задачу або пошук, з яким потрібна допомога. Якщо у вас ще
            немає профілю GeneHelp, Трекер Роду створить його автоматично за
            email вашого акаунта.
          </p>
          {accountLoading ? (
            <small className="field-hint">Перевіряємо підключення до GeneHelp...</small>
          ) : null}
        </div>

        {message ? (
          <div className={`alert ${message.error ? "alert-error" : "alert-notice"}`}>
            {message.text}
          </div>
        ) : null}

        <label>
          <span>Назва запиту</span>
          <input
            value={title}
            disabled={Boolean(busy)}
            placeholder="Наприклад: Пошук метричного запису"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label>
          <span>Опис запиту *</span>
          <textarea
            rows={7}
            value={description}
            disabled={Boolean(busy)}
            placeholder="Опишіть, кого або який документ потрібно знайти, місце, період, відомі дані та сумніви."
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        {createdRequest ? (
          <GeneHelpRequestResult
            request={createdRequest}
            busy={busy === "status"}
            onRefresh={() => void refreshStatus()}
          />
        ) : null}

        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Закрити
          </button>
          <button className="button button-primary" disabled={Boolean(busy) || accountLoading} type="submit">
            {busy === "create" ? "Надсилання..." : "Попросити допомоги"}
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}

function GeneHelpConsentStep({
  account,
  checked,
  busy,
  onCheckedChange,
  onCancel,
  onConfirm,
}: {
  account: GeneHelpAccountStatus | null;
  checked: boolean;
  busy: boolean;
  onCheckedChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="genehelp-consent-modal">
      <div>
        <span className="eyebrow">Згода на реєстрацію</span>
        <h3>Підключити GeneHelp</h3>
        <p>
          Щоб передати запит у GeneHelp, Трекер Роду має створити або
          підключити ваш профіль у GeneHelp. Для цього буде передано тільки
          email та ім’я вашого акаунта.
        </p>
      </div>

      <div className="genehelp-consent-data">
        <div>
          <span>Email</span>
          <strong>{account?.email || "email акаунта"}</strong>
        </div>
        <div>
          <span>Ім’я</span>
          <strong>{account?.name || "ім’я акаунта"}</strong>
        </div>
      </div>

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <span>Я погоджуюсь передати ці дані до GeneHelp для реєстрації та створення запиту.</span>
      </label>

      <div className="modal-actions">
        <button type="button" className="button button-ghost" disabled={busy} onClick={onCancel}>
          Скасувати
        </button>
        <button type="button" className="button button-primary" disabled={busy || !checked} onClick={onConfirm}>
          {busy ? "Надсилання..." : "Надати згоду і надіслати"}
        </button>
      </div>
    </div>
  );
}

function GeneHelpRequestResult({
  request,
  busy,
  onRefresh,
}: {
  request: GeneHelpSimpleRequestResponse;
  busy: boolean;
  onRefresh: () => void;
}) {
  const status = request.status;
  return (
    <section className="genehelp-result">
      <div className="genehelp-box-heading">
        <h3>Запит створено</h3>
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? "Оновлення..." : "Оновити статус"}
        </button>
      </div>
      <strong>{request.id}</strong>
      {status ? (
        <dl>
          <div><dt>Статус</dt><dd>{status.code || status.request_status || "невідомо"}</dd></div>
          <div><dt>Повідомлення</dt><dd>{status.message || "—"}</dd></div>
        </dl>
      ) : null}
      <GeneHelpLinks view={request.links?.view} edit={request.links?.edit} />
    </section>
  );
}

function GeneHelpLinks({ view, edit }: { view?: string; edit?: string }) {
  const viewHref = sanitizeWebUrl(view || "");
  const editHref = sanitizeWebUrl(edit || "");
  if (!viewHref && !editHref) return null;
  return (
    <div className="genehelp-links">
      {viewHref ? <a className="text-button" href={viewHref} target="_blank" rel="noreferrer noopener">Переглянути</a> : null}
      {editHref ? <a className="text-button" href={editHref} target="_blank" rel="noreferrer noopener">Редагувати</a> : null}
    </div>
  );
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
