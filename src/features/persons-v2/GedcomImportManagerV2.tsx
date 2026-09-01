import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal";
import {
  subscribeProjectGedcomDeletionProgress,
  type ProjectGedcomDeletionPhase,
  type ProjectGedcomDeletionProgress,
} from "../../services/projectPeople.ts";
import {
  gedcomImportDisplayName,
  type GedcomImportGroup,
} from "../../utils/gedcomImportGroups.ts";

export interface GedcomImportManagerV2Props {
  groups: readonly GedcomImportGroup[];
  canDelete: boolean;
  onDelete: (group: GedcomImportGroup) => Promise<void>;
}

export function GedcomImportManagerV2({
  groups,
  canDelete,
  onDelete,
}: GedcomImportManagerV2Props) {
  const [open, setOpen] = useState(false);
  const [deletingSourceKey, setDeletingSourceKey] = useState("");
  const [deletionProgress, setDeletionProgress] = useState<ProjectGedcomDeletionProgress | null>(null);
  const [error, setError] = useState("");
  const deletionInFlightRef = useRef(false);
  const deletingSourceKeyRef = useRef("");

  useEffect(() => subscribeProjectGedcomDeletionProgress((progress) => {
    if (progress.sourceKey === deletingSourceKeyRef.current) setDeletionProgress(progress);
  }), []);

  if (!groups.length) return null;

  const removeGroup = async (group: GedcomImportGroup, index: number) => {
    if (!canDelete || deletionInFlightRef.current) return;
    const name = gedcomImportDisplayName(group, index);
    const confirmed = window.confirm(
      [
        `Видалити «${name}»?`,
        `Буде видалено ${group.personCount} імпортованих осіб, ${group.relationCount} звʼязків і ${group.findingCount} імпортованих знахідок. Інші особи проєкту залишаться.`,
        "Окреме дерево імпорту буде видалено лише якщо його після імпорту не доповнювали вручну. Розширене вручну дерево збережеться; якщо його коренем досі є імпортована особа, спочатку виберіть інший корінь.",
        "Цю дію не можна скасувати.",
      ].join("\n\n"),
    );
    if (!confirmed) return;
    deletionInFlightRef.current = true;
    deletingSourceKeyRef.current = group.sourceKey;
    setError("");
    setDeletionProgress(null);
    setDeletingSourceKey(group.sourceKey);
    try {
      await onDelete(group);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не вдалося видалити GEDCOM-імпорт.");
    } finally {
      deletionInFlightRef.current = false;
      deletingSourceKeyRef.current = "";
      setDeletingSourceKey("");
    }
  };

  return (
    <>
      <button
        type="button"
        className="button button-secondary"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        Керування GEDCOM ({groups.length})
      </button>
      {open ? (
        <Modal
          title="Імпортовані GEDCOM"
          className="persons-v2-gedcom-manager-modal"
          onClose={() => {
            if (!deletionInFlightRef.current) setOpen(false);
          }}
        >
          <div className="persons-v2-gedcom-manager">
            <p>
              У межах одного проєкту дозволено один активний GEDCOM-набір. Щоб завантажити інший файл,
              спочатку видаліть наявний набір осіб і його звʼязки.
            </p>
            {groups.length > 1 ? (
              <div className="notice warning" role="status">
                Знайдено {groups.length} окремі GEDCOM-набори. Це дані, завантажені до появи запобіжника;
                видаліть зайвий набір нижче.
              </div>
            ) : null}
            {error ? <div className="notice error" role="alert">{error}</div> : null}
            <div className="persons-v2-gedcom-manager__list">
              {groups.map((group, index) => {
                const deleting = deletingSourceKey === group.sourceKey;
                return (
                  <article className="panel persons-v2-gedcom-manager__item" key={group.sourceKey}>
                    <div>
                      <strong>{gedcomImportDisplayName(group, index)}</strong>
                      <span>
                        {group.personCount} осіб · {group.relationCount} звʼязків · {group.findingCount} знахідок
                        {group.importedAt
                          ? ` · ${new Date(group.importedAt).toLocaleDateString("uk-UA")}`
                          : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button button-danger"
                      disabled={!canDelete || Boolean(deletingSourceKey)}
                      onClick={() => void removeGroup(group, index)}
                    >
                      {deleting ? "Видаляємо…" : "Видалити набір"}
                    </button>
                    {deleting && deletionProgress ? (
                      <div className="gedcom-import-progress" role="status" aria-live="polite">
                        <progress
                          max={Math.max(1, deletionProgress.totalPersons)}
                          value={Math.min(
                            Math.max(0, deletionProgress.processedPersons),
                            Math.max(1, deletionProgress.totalPersons),
                          )}
                        />
                        <span>
                          {gedcomDeletionPhaseLabel(deletionProgress.phase)} · {deletionProgress.processedPersons}
                          {deletionProgress.totalPersons > 0 ? ` із ${deletionProgress.totalPersons}` : ""} осіб
                          {deletionProgress.remainingPersons > 0
                            ? ` · залишилося ${deletionProgress.remainingPersons}`
                            : ""}
                        </span>
                        <small>
                          Видалено: {deletionProgress.deletedRelations} звʼязків, {deletionProgress.deletedFindings}
                          {" "}знахідок, {deletionProgress.deletedPersons} осіб.
                          {deletionProgress.status === "failed" && deletionProgress.retryable
                            ? " Сервер автоматично повторює безпечний крок."
                            : ""}
                        </small>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {!canDelete ? (
              <small>У режимі перегляду видалення недоступне.</small>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function gedcomDeletionPhaseLabel(phase: ProjectGedcomDeletionPhase): string {
  switch (phase) {
    case "relations": return "Видаляємо звʼязки";
    case "findings": return "Видаляємо знахідки";
    case "trees": return "Перевіряємо дерева";
    case "archives": return "Очищаємо архівні привʼязки";
    case "persons": return "Видаляємо осіб";
    case "finalize": return "Завершуємо";
    case "completed": return "Готово";
  }
}
