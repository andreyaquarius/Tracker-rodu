import type {
  AppDatabase,
  CollectionKey,
  CustomSectionRelationTarget,
} from "../types";
import { customRecordTitle, relatedRecordLabel } from "../utils/customSections";

const standardGroups: Array<{ key: CollectionKey; label: string }> = [
  { key: "researches", label: "Дослідження" },
  { key: "documents", label: "Документи" },
  { key: "persons", label: "Особи" },
  { key: "findings", label: "Знахідки" },
  { key: "tasks", label: "Завдання" },
  { key: "hypotheses", label: "Гіпотези" },
  { key: "archiveRequests", label: "Запити в архів" },
  { key: "yearMatrix", label: "Матриця років" },
];

interface RelationGroup {
  key: string;
  label: string;
  options: Array<{ id: string; label: string }>;
}

export function RecordRelationPicker({
  db,
  target = "all",
  selected,
  onChange,
}: {
  db: AppDatabase;
  target?: CustomSectionRelationTarget;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const groups = relationGroups(db, target);
  return (
    <details className="relation-dropdown">
      <summary>
        <span>
          {selected.length ? `Вибрано записів: ${selected.length}` : "Виберіть пов’язані записи"}
        </span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="relation-dropdown-menu">
        {groups.length ? groups.map((group) => (
          <section key={group.key}>
            <h4>{group.label}</h4>
            {group.options.map((option) => (
              <label key={`${group.key}-${option.id}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(option.id)}
                  onChange={(event) => onChange(
                    event.target.checked
                      ? [...new Set([...selected, option.id])]
                      : selected.filter((id) => id !== option.id),
                  )}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </section>
        )) : (
          <div className="relation-dropdown-empty">У вибраних розділах ще немає записів.</div>
        )}
      </div>
    </details>
  );
}

function relationGroups(
  db: AppDatabase,
  target: CustomSectionRelationTarget,
): RelationGroup[] {
  if (target === "all") {
    return [
      ...standardGroups.map((group) => ({
        key: group.key,
        label: group.label,
        options: db[group.key].map((record) => ({
          id: record.id,
          label: relatedRecordLabel(db, group.key, record.id),
        })),
      })),
      ...db.customSections.map((section) => ({
        key: `custom:${section.id}`,
        label: section.name,
        options: db.customSectionRecords
          .filter((record) => record.sectionId === section.id)
          .map((record) => ({ id: record.id, label: customRecordTitle(section, record) })),
      })),
    ].filter((group) => group.options.length);
  }
  if (target.startsWith("custom:")) {
    const sectionId = target.slice("custom:".length);
    const section = db.customSections.find((item) => item.id === sectionId);
    if (!section) return [];
    const options = db.customSectionRecords
      .filter((record) => record.sectionId === sectionId)
      .map((record) => ({ id: record.id, label: customRecordTitle(section, record) }));
    return options.length ? [{ key: target, label: section.name, options }] : [];
  }
  const collection = target as CollectionKey;
  const group = standardGroups.find((item) => item.key === collection);
  const options = db[collection].map((record) => ({
    id: record.id,
    label: relatedRecordLabel(db, collection, record.id),
  }));
  return options.length ? [{ key: collection, label: group?.label ?? "Записи", options }] : [];
}
