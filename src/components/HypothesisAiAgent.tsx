import { useEffect, useState } from "react";
import type { AppDatabase, Hypothesis, TaskRecord } from "../types";
import { Modal } from "./Modal";
import {
  listAiHypothesisReviews,
  reviewHypothesisWithAi,
  type AiAgentMode,
  type AiHypothesisReview,
} from "../services/aiAgent";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import { formatDateTime } from "../utils/dateHelpers";

const costWarning =
  "На тарифі «Старт» запит використовує ваш API-ключ Google AI Studio. На платних тарифах спочатку використовується включений місячний ліміт, а після його вичерпання — ваш API-ключ, якщо він збережений.";

export function HypothesisAiAgent({
  hypothesis,
  db,
  canCreateTasks,
  onCreateTask,
}: {
  hypothesis: Hypothesis;
  db: AppDatabase;
  canCreateTasks: boolean;
  onCreateTask?: (task: TaskRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AiAgentMode>("fast");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<AiHypothesisReview | null>(null);
  const [history, setHistory] = useState<AiHypothesisReview[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [createdTasks, setCreatedTasks] = useState<Set<string>>(new Set());

  const persons = db.persons.filter((item) => hypothesis.personIds.includes(item.id));
  const documents = db.documents.filter((item) => hypothesis.documentIds.includes(item.id));
  const findings = db.findings.filter((item) => hypothesis.findingIds.includes(item.id));

  useEffect(() => {
    if (!open) return;
    setHistoryBusy(true);
    setHistoryError("");
    void listAiHypothesisReviews(hypothesis.id)
      .then(setHistory)
      .catch((reason: unknown) => {
        setHistoryError(
          reason instanceof Error
            ? reason.message
            : "Не вдалося завантажити історію перевірок.",
        );
      })
      .finally(() => setHistoryBusy(false));
  }, [hypothesis.id, open]);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const completed = await reviewHypothesisWithAi(hypothesis.id, mode);
      setReview(completed);
      setHistory((current) => [
        completed,
        ...current.filter((item) => item.reviewId !== completed.reviewId),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не вдалося виконати аналіз.");
    } finally {
      setBusy(false);
    }
  };

  const createTask = (title: string) => {
    if (!onCreateTask || !canCreateTasks || createdTasks.has(title)) return;
    const timestamp = nowIso();
    onCreateTask({
      id: createId(),
      researchId: hypothesis.researchId,
      personName: hypothesis.relatedPeople,
      personIds: hypothesis.personIds,
      title,
      description: `Рекомендовано ШІ під час перевірки гіпотези «${hypothesis.title}».`,
      place: "",
      yearFrom: "",
      yearTo: "",
      documentType: "",
      documentId: hypothesis.documentIds[0] ?? "",
      status: "не почато",
      priority: "середній",
      deadline: "",
      reminderAt: "",
      reminderInApp: false,
      reminderEmail: false,
      reminderSentAt: "",
      notes: `Гіпотеза: ${hypothesis.title}`,
      customFields: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    setCreatedTasks((current) => new Set([...current, title]));
  };

  return (
    <>
      <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
        Перевірити з ШІ
      </button>
      {open ? (
        <Modal title={`Перевірка гіпотези з ШІ`} onClose={() => setOpen(false)}>
          <div className="details-body ai-review-modal">
            {!review ? (
              <>
                <div className="import-warning">{costWarning}</div>
                {error ? <div className="alert alert-error">{error}</div> : null}
                <div>
                  <h3>Які дані будуть передані</h3>
                  <ul className="ai-data-list">
                    <li>Текст, аргументи та нотатки гіпотези</li>
                    <li>Пов’язані особи: {persons.length}</li>
                    <li>Пов’язані документи: {documents.length}</li>
                    <li>Пов’язані знахідки: {findings.length}</li>
                    <li>Пов’язані завдання та записи, якщо вони є</li>
                  </ul>
                  <p className="field-hint">Файли та скани не надсилаються. Передаються лише текстові поля пов’язаних записів.</p>
                </div>
                <label>
                  <span>Режим аналізу</span>
                  <select value={mode} onChange={(event) => setMode(event.target.value as AiAgentMode)}>
                    <option value="fast">Швидкий</option>
                    <option value="detailed">Детальний</option>
                  </select>
                </label>
                <ReviewHistory
                  history={history}
                  busy={historyBusy}
                  error={historyError}
                  onOpen={setReview}
                />
                <div className="modal-actions">
                  <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>
                    Скасувати
                  </button>
                  <button type="button" className="button button-primary" disabled={busy} onClick={() => void run()}>
                    {busy ? "Аналіз триває…" : "Запустити аналіз"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="ai-review-summary">
                  <div><span>Оцінка гіпотези</span><strong>{review.result.assessment}</strong></div>
                  <div><span>Рівень впевненості</span><strong>{review.result.confidence}</strong></div>
                </div>
                <ReviewBlock title="Аргументи за" items={review.result.argumentsFor} />
                <ReviewBlock title="Аргументи проти" items={review.result.argumentsAgainst} />
                <ReviewBlock title="Яких доказів бракує" items={review.result.missingEvidence} />
                <ReviewBlock title="Що перевірити далі" items={review.result.recommendedChecks} />
                <section className="ai-review-block">
                  <h3>Рекомендовані завдання</h3>
                  {review.result.suggestedTasks.length ? review.result.suggestedTasks.map((task) => (
                    <div className="ai-suggested-task" key={task}>
                      <span>{task}</span>
                      {canCreateTasks ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={createdTasks.has(task)}
                          onClick={() => createTask(task)}
                        >
                          {createdTasks.has(task) ? "Створено" : "Створити завдання"}
                        </button>
                      ) : null}
                    </div>
                  )) : <p>Немає окремих рекомендованих завдань.</p>}
                </section>
                <ReviewBlock title="Ризики помилки" items={review.result.risks} />
                <section className="ai-review-block">
                  <h3>Короткий висновок</h3>
                  <p>{review.result.summary}</p>
                </section>
                <div className="details-meta">
                  <span>Дата: {formatDateTime(review.createdAt)}</span>
                  <span>Модель: {review.model}</span>
                  <span>Режим: {review.mode === "detailed" ? "детальний" : "швидкий"}</span>
                </div>
                <div className="modal-actions">
                  <button type="button" className="button button-ghost" onClick={() => setReview(null)}>
                    Новий аналіз
                  </button>
                  <button type="button" className="button button-primary" onClick={() => setOpen(false)}>
                    Закрити
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function ReviewHistory({
  history,
  busy,
  error,
  onOpen,
}: {
  history: AiHypothesisReview[];
  busy: boolean;
  error: string;
  onOpen: (review: AiHypothesisReview) => void;
}) {
  return (
    <section className="ai-review-history">
      <div className="section-heading">
        <div>
          <h3>Історія перевірок</h3>
          <p>Попередні висновки зберігаються для цієї гіпотези.</p>
        </div>
        <span className="result-count">{history.length}</span>
      </div>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {busy ? (
        <div className="empty-inline">Завантаження історії…</div>
      ) : history.length ? (
        <div className="ai-review-history-list">
          {history.map((item) => (
            <button type="button" key={item.reviewId} onClick={() => onOpen(item)}>
              <span>
                <strong>{item.result.assessment}</strong>
                <small>
                  {formatDateTime(item.createdAt)} · {item.mode === "detailed" ? "детальний" : "швидкий"}
                </small>
              </span>
              <span>
                <small>Впевненість</small>
                <strong>{item.result.confidence}</strong>
              </span>
              <span className="activity-arrow">→</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-inline">Цю гіпотезу ще не перевіряли за допомогою ШІ.</div>
      )}
    </section>
  );
}

function ReviewBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="ai-review-block">
      <h3>{title}</h3>
      {items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>Не виявлено.</p>}
    </section>
  );
}
