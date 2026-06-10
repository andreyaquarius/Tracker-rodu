import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AppDatabase,
  CustomSectionDefinition,
  CustomSectionField,
  CustomSectionRecord,
  CustomSectionRecordValue,
  ScanAttachment,
} from "../types";
import type { PageKey } from "../components/Sidebar";
import { Modal } from "../components/Modal";
import {
  ScanAttachmentsEditor,
  ScanAttachmentsView,
} from "../components/ScanAttachments";
import {
  customRecordSearchText,
  customRecordTitle,
  emptyCustomValue,
  relatedRecordLabel,
} from "../utils/customSections";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import { deleteScanFile } from "../services/scanStorage";
import { InlineCustomSectionFieldCreator } from "../components/InlineCustomSectionFieldCreator";

export function CustomSectionPage({
  db,
  section,
  records,
  initialSearch = "",
  initialOpenRecordId = "",
  onSave,
  onDelete,
  onOpenRelated,
  onAddField,
  readOnly = false,
}: {
  db: AppDatabase;
  section: CustomSectionDefinition;
  records: CustomSectionRecord[];
  initialSearch?: string;
  initialOpenRecordId?: string;
  onSave: (record: CustomSectionRecord) => void;
  onDelete: (id: string) => void;
  onOpenRelated: (page: PageKey, entityId: string) => void;
  onAddField?: (field: CustomSectionField) => void;
  readOnly?: boolean;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [viewing, setViewing] = useState<CustomSectionRecord | null>(null);
  const [editing, setEditing] = useState<CustomSectionRecord | "new" | null>(null);

  useEffect(() => setSearch(initialSearch), [initialSearch]);
  useEffect(() => {
    if (!initialOpenRecordId) return;
    setViewing(records.find((record) => record.id === initialOpenRecordId) ?? null);
  }, [initialOpenRecordId, records]);
  useEffect(() => {
    if (!viewing) return;
    setViewing(records.find((record) => record.id === viewing.id) ?? null);
  }, [records, viewing?.id]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("uk");
    if (!query) return records;
    return records.filter((record) =>
      `${customRecordTitle(section, record)} ${customRecordSearchText(db, section, record)}`
        .toLocaleLowerCase("uk")
        .includes(query),
    );
  }, [db, records, search, section]);
  const columns = section.fields
    .filter((field) => field.type !== "attachments")
    .slice(0, 4);

  const remove = async (record: CustomSectionRecord) => {
    if (readOnly) return;
    if (!window.confirm(`Видалити запис «${customRecordTitle(section, record)}»?`)) return;
    const attachments = section.fields
      .filter((field) => field.type === "attachments")
      .flatMap((field) => {
        const value = record.values[field.id];
        return Array.isArray(value) ? value as ScanAttachment[] : [];
      });
    await Promise.allSettled(attachments.map(deleteScanFile));
    onDelete(record.id);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Власний розділ</span>
          <h1>{section.name}</h1>
          <p>{section.description || "Власна структура записів вашого дослідження."}</p>
        </div>
        {!readOnly ? (
          <button className="button button-primary" onClick={() => setEditing("new")}>
            + Додати {section.singularName}
          </button>
        ) : null}
      </div>

      <section className="panel list-panel">
        <div className="toolbar custom-section-toolbar">
          <label className="search-box">
            <span>Пошук</span>
            <input
              value={search}
              placeholder={`Пошук у розділі «${section.name}»…`}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <span className="result-count">{filtered.length} записів</span>
        </div>
        {filtered.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Назва</th>
                  {columns.filter((field) => field.id !== section.titleFieldId).map((field) => (
                    <th key={field.id}>{field.label}</th>
                  ))}
                  <th className="actions-column">Дії</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => (
                  <tr
                    className="clickable-row"
                    key={record.id}
                    onClick={() => setViewing(record)}
                  >
                    <td data-label="Назва"><strong>{customRecordTitle(section, record)}</strong></td>
                    {columns.filter((field) => field.id !== section.titleFieldId).map((field) => (
                      <td key={field.id} data-label={field.label}>
                        {compactValue(db, field, record.values[field.id])}
                      </td>
                    ))}
                    <td className="row-actions" data-label="Дії">
                      {!readOnly ? (
                        <>
                          <button
                            className="icon-button"
                            title="Редагувати"
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditing(record);
                            }}
                          >✎</button>
                          <button
                            className="icon-button danger"
                            title="Видалити"
                            onClick={(event) => {
                              event.stopPropagation();
                              void remove(record);
                            }}
                          >×</button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <strong>{search ? "Нічого не знайдено" : "Записів поки немає"}</strong>
            <p>{search ? "Спробуйте змінити пошуковий запит." : `Додайте перший запис у розділ «${section.name}».`}</p>
          </div>
        )}
      </section>

      {viewing ? (
        <CustomRecordDetails
          db={db}
          section={section}
          record={viewing}
          onOpenRelated={onOpenRelated}
          onClose={() => setViewing(null)}
          onEdit={readOnly ? undefined : () => {
              setEditing(viewing);
              setViewing(null);
            }}
        />
      ) : null}

      {editing && !readOnly ? (
        <CustomRecordEditor
          db={db}
          section={section}
          record={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(record) => {
            onSave(record);
            setEditing(null);
          }}
          onAddField={onAddField}
        />
      ) : null}
    </>
  );
}

function CustomRecordEditor({
  db,
  section,
  record,
  onClose,
  onSave,
  onAddField,
}: {
  db: AppDatabase;
  section: CustomSectionDefinition;
  record: CustomSectionRecord | null;
  onClose: () => void;
  onSave: (record: CustomSectionRecord) => void;
  onAddField?: (field: CustomSectionField) => void;
}) {
  const [values, setValues] = useState<Record<string, CustomSectionRecordValue>>(() =>
    Object.fromEntries(section.fields.map((field) => [
      field.id,
      record?.values[field.id] ?? emptyCustomValue(field.type),
    ])),
  );
  useEffect(() => {
    setValues((current) => {
      const next = { ...current };
      for (const field of section.fields) {
        if (!(field.id in next)) next[field.id] = emptyCustomValue(field.type);
      }
      return next;
    });
  }, [section.fields]);
  const update = (fieldId: string, value: CustomSectionRecordValue) => {
    setValues((current) => ({ ...current, [fieldId]: value }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = section.fields.find((field) => {
      if (!field.required) return false;
      const value = values[field.id];
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === "boolean") return false;
      return !String(value ?? "").trim();
    });
    if (missing) {
      window.alert(`Заповніть обов’язкове поле «${missing.label}».`);
      return;
    }
    const timestamp = nowIso();
    onSave({
      id: record?.id ?? createId(),
      sectionId: section.id,
      values,
      createdAt: record?.createdAt ?? timestamp,
      __baseUpdatedAt: record?.updatedAt,
      updatedAt: timestamp,
    } as CustomSectionRecord);
  };

  return (
    <Modal
      title={`${record ? "Редагувати" : "Додати"} ${section.singularName}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          {section.fields.map((field) => (
            <CustomRecordField
              key={field.id}
              db={db}
              field={field}
              value={values[field.id] ?? emptyCustomValue(field.type)}
              onChange={(value) => update(field.id, value)}
            />
          ))}
          {onAddField ? (
            <InlineCustomSectionFieldCreator
              db={db}
              fields={section.fields}
              onAdd={onAddField}
            />
          ) : null}
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button type="submit" className="button button-primary">Зберегти</button>
        </div>
      </form>
    </Modal>
  );
}

function CustomRecordField({
  db,
  field,
  value,
  onChange,
}: {
  db: AppDatabase;
  field: CustomSectionField;
  value: CustomSectionRecordValue;
  onChange: (value: CustomSectionRecordValue) => void;
}) {
  if (field.type === "attachments") {
    return (
      <ScanAttachmentsEditor
        title={field.label}
        scans={Array.isArray(value) ? value as ScanAttachment[] : []}
        onChange={onChange}
      />
    );
  }
  if (field.type === "relation") {
    const selected = Array.isArray(value) ? value as string[] : [];
    const groups = relationOptionGroups(db, field);
    return (
      <fieldset className="field-wide relation-picker">
        <legend>{field.label}</legend>
        <details className="relation-dropdown">
          <summary>
            <span>
              {selected.length
                ? `Вибрано записів: ${selected.length}`
                : "Виберіть пов’язані записи"}
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
              <div className="relation-dropdown-empty">
                У вибраних розділах ще немає записів.
              </div>
            )}
          </div>
        </details>
      </fieldset>
    );
  }
  if (field.type === "boolean") {
    return (
      <label className="checkbox-field field-wide">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value as string[] : [];
    return (
      <label className="field-wide">
        <span>{field.label}</span>
        <select
          multiple
          required={field.required}
          value={selected}
          onChange={(event) => onChange(
            Array.from(event.target.selectedOptions, (option) => option.value),
          )}
        >
          {field.options.map((option) => <option key={option}>{option}</option>)}
        </select>
        <small className="field-hint">Для вибору кількох варіантів утримуйте Ctrl.</small>
      </label>
    );
  }
  const stringValue = typeof value === "string" ? value : "";
  const inputType = field.type === "year"
    ? "number"
    : ["approximate-date", "place"].includes(field.type)
      ? "text"
      : field.type;
  return (
    <label className={field.type === "textarea" ? "field-wide" : ""}>
      <span>{field.label}</span>
      {field.type === "textarea" ? (
        <textarea
          required={field.required}
          rows={5}
          value={stringValue}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.type === "select" ? (
        <select
          required={field.required}
          value={stringValue}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Не вибрано</option>
          {field.options.map((option) => <option key={option}>{option}</option>)}
        </select>
      ) : (
        <input
          required={field.required}
          type={inputType}
          min={field.type === "year" ? 1 : undefined}
          max={field.type === "year" ? 9999 : undefined}
          value={stringValue}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function CustomRecordDetails({
  db,
  section,
  record,
  onOpenRelated,
  onClose,
  onEdit,
}: {
  db: AppDatabase;
  section: CustomSectionDefinition;
  record: CustomSectionRecord;
  onOpenRelated: (page: PageKey, entityId: string) => void;
  onClose: () => void;
  onEdit?: () => void;
}) {
  return (
    <Modal title={customRecordTitle(section, record)} onClose={onClose}>
      <div className="details-body">
        <div className="details-grid">
          {section.fields.map((field) => (
            <div
              key={field.id}
              className={`detail-item ${["textarea", "attachments", "relation", "multiselect"].includes(field.type) ? "detail-wide" : ""}`}
            >
              <span>{field.label}</span>
              <CustomRecordValue
                db={db}
                field={field}
                value={record.values[field.id]}
                onOpenRelated={onOpenRelated}
              />
            </div>
          ))}
        </div>
        <div className="details-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Закрити</button>
          {onEdit ? (
            <button type="button" className="button button-primary" onClick={onEdit}>Редагувати</button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function CustomRecordValue({
  db,
  field,
  value,
  onOpenRelated,
}: {
  db: AppDatabase;
  field: CustomSectionField;
  value: CustomSectionRecordValue | undefined;
  onOpenRelated: (page: PageKey, entityId: string) => void;
}) {
  if (field.type === "attachments") {
    return <ScanAttachmentsView scans={Array.isArray(value) ? value as ScanAttachment[] : []} />;
  }
  if (field.type === "relation") {
    const ids = Array.isArray(value) ? value as string[] : [];
    return ids.length ? (
      <div className="linked-items">
        {ids.map((id) => (
          <button
            type="button"
            className="related-record-button"
            key={id}
            onClick={() => {
              const page = relationRecordPage(db, field, id);
              if (page) onOpenRelated(page, id);
            }}
          >
            <span>{relatedRecordLabel(db, field.relationTarget, id)}</span>
            <small>Відкрити →</small>
          </button>
        ))}
      </div>
    ) : <div className="detail-text">Не вибрано</div>;
  }
  if (field.type === "boolean") {
    return <div className="detail-text">{value ? "Так" : "Ні"}</div>;
  }
  if (field.type === "multiselect") {
    const values = Array.isArray(value) ? value as string[] : [];
    return <div className="detail-text">{values.join(", ") || "—"}</div>;
  }
  if (field.type === "url" && typeof value === "string" && value) {
    return <a href={value} target="_blank" rel="noreferrer">Відкрити посилання ↗</a>;
  }
  if (field.type === "email" && typeof value === "string" && value) {
    return <a href={`mailto:${value}`}>{value}</a>;
  }
  if (field.type === "tel" && typeof value === "string" && value) {
    return <a href={`tel:${value}`}>{value}</a>;
  }
  return <div className="detail-text">{String(value ?? "") || "—"}</div>;
}

interface RelationOptionGroup {
  key: string;
  label: string;
  options: Array<{ id: string; label: string }>;
}

const standardRelationGroups: Array<{
  key: import("../types").CollectionKey;
  label: string;
}> = [
  { key: "researches", label: "Дослідження" },
  { key: "documents", label: "Документи" },
  { key: "persons", label: "Особи" },
  { key: "findings", label: "Знахідки" },
  { key: "tasks", label: "Завдання" },
  { key: "hypotheses", label: "Гіпотези" },
  { key: "archiveRequests", label: "Запити в архів" },
  { key: "yearMatrix", label: "Матриця років" },
];

function relationOptionGroups(
  db: AppDatabase,
  field: CustomSectionField,
): RelationOptionGroup[] {
  const target = field.relationTarget;
  if (!target) return [];
  if (target === "all") {
    return [
      ...standardRelationGroups.map((group) => ({
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
          .map((record) => ({
            id: record.id,
            label: customRecordTitle(section, record),
          })),
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
  const collection = target as import("../types").CollectionKey;
  const options = db[collection].map((record) => ({
    id: record.id,
    label: relatedRecordLabel(db, target, record.id),
  }));
  const label = standardRelationGroups.find((group) => group.key === collection)?.label ?? "Записи";
  return options.length ? [{ key: collection, label, options }] : [];
}

function relationRecordPage(
  db: AppDatabase,
  field: CustomSectionField,
  id: string,
): PageKey | null {
  const target = field.relationTarget;
  if (!target) return null;
  if (target !== "all") return target;
  const customRecord = db.customSectionRecords.find((record) => record.id === id);
  if (customRecord) return `custom:${customRecord.sectionId}`;
  const group = standardRelationGroups.find(({ key }) =>
    db[key].some((record) => record.id === id),
  );
  return group?.key ?? null;
}

function compactValue(
  db: AppDatabase,
  field: CustomSectionField,
  value: CustomSectionRecordValue | undefined,
): string {
  if (field.type === "boolean") return value ? "Так" : "Ні";
  if (field.type === "relation" && Array.isArray(value)) {
    return (value as string[]).slice(0, 2)
      .map((id) => relatedRecordLabel(db, field.relationTarget, id)).join(", ") ||
      "—";
  }
  if (Array.isArray(value)) return value.length ? `${value.length} файлів` : "—";
  const text = String(value ?? "");
  return text.length > 80 ? `${text.slice(0, 77)}…` : text || "—";
}
