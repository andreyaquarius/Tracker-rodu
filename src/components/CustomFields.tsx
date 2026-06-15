import type {
  AppDatabase,
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldValues,
  ScanAttachment,
} from "../types";
import { ScanAttachmentsEditor, ScanAttachmentsView } from "./ScanAttachments";
import { RecordRelationPicker } from "./RecordRelationPicker";
import { relatedRecordLabel } from "../utils/customSections";

export function CustomFieldsEditor({
  db,
  definitions,
  values,
  onChange,
  onDeleteDefinition,
}: {
  db: AppDatabase;
  definitions: CustomFieldDefinition[];
  values: CustomFieldValues;
  onChange: (values: CustomFieldValues) => void;
  onDeleteDefinition?: (definition: CustomFieldDefinition) => void;
}) {
  if (!definitions.length) return null;
  const update = (id: string, value: CustomFieldValue) => {
    onChange({ ...values, [id]: value });
  };
  return (
    <>
      {definitions.map((definition) => {
        const multiple = definition.type === "multiselect" || definition.type === "relation";
        const value = values[definition.id] ??
          (definition.type === "boolean" ? false : multiple || definition.type === "attachments" ? [] : "");
        const removeButton = onDeleteDefinition ? (
          <button
            type="button"
            className="custom-field-delete"
            title={`Видалити поле «${definition.label}»`}
            aria-label={`Видалити поле «${definition.label}»`}
            onClick={() => onDeleteDefinition(definition)}
          >
            ×
          </button>
        ) : null;
        if (definition.type === "attachments") {
          return (
            <div className="custom-field-entry field-wide" key={definition.id}>
              <div className="custom-field-heading">
                <span>{definition.label}</span>
                {removeButton}
              </div>
              <ScanAttachmentsEditor
                title=""
                scans={Array.isArray(value) ? value as ScanAttachment[] : []}
                onChange={(scans) => update(definition.id, scans)}
              />
            </div>
          );
        }
        if (definition.type === "relation") {
          return (
            <div className="custom-field-entry field-wide" key={definition.id}>
              <div className="custom-field-heading">
                <span>{definition.label}</span>
                {removeButton}
              </div>
              <fieldset className="relation-picker">
                <RecordRelationPicker
                  db={db}
                  target={definition.relationTarget ?? "all"}
                  selected={Array.isArray(value) ? value as string[] : []}
                  onChange={(ids) => update(definition.id, ids)}
                />
              </fieldset>
            </div>
          );
        }
        if (definition.type === "multiselect") {
          const selected = Array.isArray(value) ? value as string[] : [];
          return (
            <div className="custom-field-entry field-wide" key={definition.id}>
              <div className="custom-field-heading">
                <span>{definition.label}</span>
                {removeButton}
              </div>
              <fieldset className="relation-picker">
                <div className="relation-options">
                  {definition.options.map((option) => (
                    <label key={option}>
                      <input
                        type="checkbox"
                        checked={selected.includes(option)}
                        onChange={(event) => update(
                          definition.id,
                          event.target.checked
                            ? [...selected, option]
                            : selected.filter((item) => item !== option),
                        )}
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          );
        }
        if (definition.type === "boolean") {
          return (
            <div className="custom-field-entry field-wide" key={definition.id}>
              <div className="custom-field-heading">
                <span>{definition.label}</span>
                {removeButton}
              </div>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(event) => update(definition.id, event.target.checked)}
                />
                <span>Так</span>
              </label>
            </div>
          );
        }
        return (
          <div
            className={["textarea", "approximate-date"].includes(definition.type) ? "field-wide" : ""}
            key={definition.id}
          >
            <div className="custom-field-heading">
              <span>{definition.label}</span>
              {removeButton}
            </div>
            {definition.type === "textarea" ? (
              <textarea
                rows={4}
                value={String(value)}
                onChange={(event) => update(definition.id, event.target.value)}
              />
            ) : definition.type === "select" ? (
              <select
                value={String(value)}
                onChange={(event) => update(definition.id, event.target.value)}
              >
                <option value="">Не вибрано</option>
                {definition.options.map((option) => <option key={option}>{option}</option>)}
              </select>
            ) : (
              <input
                type={inputType(definition.type)}
                inputMode={definition.type === "year" ? "numeric" : undefined}
                placeholder={definition.type === "approximate-date" ? "Наприклад: близько 1850 року або 1848–1852" : undefined}
                value={String(value)}
                onChange={(event) => update(definition.id, event.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function CustomFieldsView({
  db,
  definitions,
  values,
}: {
  db: AppDatabase;
  definitions: CustomFieldDefinition[];
  values: CustomFieldValues;
}) {
  if (!definitions.length) return null;
  return (
    <>
      {definitions.map((definition) => {
        const value = values[definition.id];
        return (
          <div
            className={`detail-item ${["textarea", "attachments", "relation", "multiselect"].includes(definition.type) ? "detail-wide" : ""}`}
            key={definition.id}
          >
            <span>{definition.label}</span>
            <CustomFieldDisplay db={db} definition={definition} value={value} />
          </div>
        );
      })}
    </>
  );
}

function CustomFieldDisplay({
  db,
  definition,
  value,
}: {
  db: AppDatabase;
  definition: CustomFieldDefinition;
  value: CustomFieldValue | undefined;
}) {
  if (definition.type === "attachments") {
    return <ScanAttachmentsView scans={Array.isArray(value) ? value as ScanAttachment[] : []} />;
  }
  if (definition.type === "relation") {
    const ids = Array.isArray(value) ? value as string[] : [];
    return (
      <div className="detail-text">
        {ids.map((id) => relatedRecordLabel(db, definition.relationTarget ?? "all", id)).join(", ") || "—"}
      </div>
    );
  }
  if (definition.type === "multiselect") {
    return <div className="detail-text">{Array.isArray(value) ? value.join(", ") || "—" : "—"}</div>;
  }
  if (definition.type === "boolean") {
    return <div className="detail-text">{value ? "Так" : "Ні"}</div>;
  }
  const text = String(value ?? "") || "—";
  if (definition.type === "url" && text !== "—") {
    return <a href={text} target="_blank" rel="noreferrer">Відкрити посилання ↗</a>;
  }
  if (definition.type === "email" && text !== "—") {
    return <a href={`mailto:${text}`}>{text}</a>;
  }
  if (definition.type === "tel" && text !== "—") {
    return <a href={`tel:${text}`}>{text}</a>;
  }
  return <div className="detail-text">{text}</div>;
}

function inputType(type: CustomFieldDefinition["type"]): string {
  if (type === "number" || type === "year") return "number";
  if (type === "date" || type === "time" || type === "url" || type === "email" || type === "tel") {
    return type;
  }
  return "text";
}
