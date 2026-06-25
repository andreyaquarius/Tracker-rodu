import { useState, type FormEvent } from "react";
import {
  createGeneHelpSimpleRequest,
  getGeneHelpRequestStatus,
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
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!description.trim()) {
      setMessage({ text: "Опишіть, яка саме допомога потрібна в GeneHelp.", error: true });
      return;
    }
    setBusy("create");
    setMessage(null);
    try {
      const response = await createGeneHelpSimpleRequest({
        title: title.trim(),
        description: description.trim(),
      });
      setCreatedRequest(response);
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
      <form className="genehelp-request-modal" onSubmit={create}>
        <div className="genehelp-intro">
          <span className="eyebrow">Партнерський сервіс</span>
          <p>
            Опишіть задачу або пошук, з яким потрібна допомога. Якщо у вас ще
            немає профілю GeneHelp, Трекер Роду створить його автоматично за
            email вашого акаунта.
          </p>
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
          <button className="button button-primary" disabled={Boolean(busy)} type="submit">
            {busy === "create" ? "Надсилання..." : "Попросити допомоги"}
          </button>
        </div>
      </form>
    </Modal>
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
