import { useState } from "react";
import { Modal } from "../../components/Modal";
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
  const [error, setError] = useState("");

  if (!groups.length) return null;

  const removeGroup = async (group: GedcomImportGroup, index: number) => {
    if (!canDelete || deletingSourceKey) return;
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
    setError("");
    setDeletingSourceKey(group.sourceKey);
    try {
      await onDelete(group);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не вдалося видалити GEDCOM-імпорт.");
    } finally {
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
            if (!deletingSourceKey) setOpen(false);
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
