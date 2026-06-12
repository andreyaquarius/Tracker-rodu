import { useEffect, useState, type FormEvent } from "react";
import type {
  AppDatabase,
  CustomSectionDefinition,
  CustomSectionField,
  CustomSectionFieldType,
  ScanAttachment,
  SectionParentKey,
} from "../types";
import { Modal } from "./Modal";
import {
  customSectionFieldTypes,
  customSectionTemplates,
  sectionFromTemplate,
} from "../utils/customSections";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import { deleteScanFile } from "../services/scanStorage";
import { SectionIcon, sectionIconOptions } from "./SectionIcon";
import {
  customSectionKey,
  hierarchyRootKeys,
  hierarchyRootLabels,
  sectionDescendantIds,
  sectionDepth,
} from "../utils/sectionHierarchy";

export function CustomSectionBuilder({
  db,
  onChange,
  readOnly = false,
  createRequest,
  onCreateRequestHandled,
}: {
  db: AppDatabase;
  onChange: (db: AppDatabase) => void;
  readOnly?: boolean;
  createRequest?: { id: number; parentKey: SectionParentKey };
  onCreateRequestHandled?: () => void;
}) {
  const [editing, setEditing] = useState<CustomSectionDefinition | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [pendingParentKey, setPendingParentKey] = useState<SectionParentKey | null>(null);

  useEffect(() => {
    if (!createRequest || readOnly) return;
    setPendingParentKey(createRequest.parentKey);
    setTemplateOpen(true);
    onCreateRequestHandled?.();
  }, [createRequest?.id, readOnly]);

  const startTemplate = (templateId: string) => {
    const template = customSectionTemplates.find((item) => item.id === templateId);
    if (!template) return;
    setEditing({
      ...sectionFromTemplate(template),
      parentKey: pendingParentKey,
    });
    setTemplateOpen(false);
  };

  const save = (section: CustomSectionDefinition) => {
    const exists = db.customSections.some((item) => item.id === section.id);
    onChange({
      ...db,
      customSections: exists
        ? db.customSections.map((item) => item.id === section.id ? section : item)
        : [...db.customSections, section],
    });
    setEditing(null);
  };

  const moveSection = (section: CustomSectionDefinition, direction: -1 | 1) => {
    const siblingIds = db.customSections
      .filter((item) => item.parentKey === section.parentKey)
      .map((item) => item.id);
    const siblingIndex = siblingIds.indexOf(section.id);
    const targetId = siblingIds[siblingIndex + direction];
    if (!targetId) return;
    const currentIndex = db.customSections.findIndex((item) => item.id === section.id);
    const targetIndex = db.customSections.findIndex((item) => item.id === targetId);
    const nextSections = [...db.customSections];
    [nextSections[currentIndex], nextSections[targetIndex]] = [
      nextSections[targetIndex],
      nextSections[currentIndex],
    ];
    onChange({ ...db, customSections: nextSections });
  };

  const remove = async (section: CustomSectionDefinition) => {
    const childCount = db.customSections.filter(
      (item) => item.parentKey === customSectionKey(section.id),
    ).length;
    if (childCount) {
      window.alert(
        `Спочатку перемістіть або видаліть підрозділи (${childCount}), що містяться у «${section.name}».`,
      );
      return;
    }
    const records = db.customSectionRecords.filter((item) => item.sectionId === section.id);
    if (!window.confirm(
      `Видалити розділ «${section.name}» і всі його записи (${records.length})? Цю дію не можна скасувати.`,
    )) return;
    const attachmentFieldIds = new Set(
      section.fields.filter((field) => field.type === "attachments").map((field) => field.id),
    );
    const attachments = records.flatMap((record) =>
      Object.entries(record.values)
        .filter(([fieldId, value]) => attachmentFieldIds.has(fieldId) && Array.isArray(value))
        .flatMap(([, value]) => value as ScanAttachment[]),
    );
    await Promise.allSettled(attachments.map(deleteScanFile));
    onChange({
      ...db,
      customSections: db.customSections.filter((item) => item.id !== section.id),
      customSectionRecords: db.customSectionRecords.filter(
        (item) => item.sectionId !== section.id,
      ),
    });
  };

  return (
    <section className="panel settings-panel custom-fields-settings">
      <div className="section-heading">
        <div>
          <h2>Конструктор розділів</h2>
          <p>Створюйте власні розділи, визначайте їхні поля або використовуйте готові шаблони.</p>
        </div>
        <button
          type="button"
          className="button button-primary"
          disabled={readOnly}
          onClick={() => {
            setPendingParentKey(null);
            setTemplateOpen(true);
          }}
        >
          + Створити розділ
        </button>
      </div>

      {db.customSections.length ? (
        <div className="custom-section-list">
          {db.customSections.map((section) => {
            const recordCount = db.customSectionRecords.filter(
              (record) => record.sectionId === section.id,
            ).length;
            const siblings = db.customSections.filter(
              (item) => item.parentKey === section.parentKey,
            );
            const siblingIndex = siblings.findIndex((item) => item.id === section.id);
            return (
              <article key={section.id}>
                <span className="custom-section-icon">
                  <SectionIcon icon={section.icon} size={22} />
                </span>
                <div>
                  <strong>{section.name}</strong>
                  <small>
                    Рівень {sectionDepth(db.customSections, section) + 1} · {section.fields.length} полів · {recordCount} записів
                  </small>
                  {section.description ? <p>{section.description}</p> : null}
                </div>
                <div className="custom-section-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="Перемістити вище"
                    disabled={readOnly || siblingIndex === 0}
                    onClick={() => moveSection(section, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Перемістити нижче"
                    disabled={readOnly || siblingIndex === siblings.length - 1}
                    onClick={() => moveSection(section, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={readOnly}
                    onClick={() => setEditing(cloneSection(section))}
                  >
                    Налаштувати
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    title="Видалити розділ"
                    disabled={readOnly}
                    onClick={() => void remove(section)}
                  >
                    ×
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-inline">
          Власних розділів поки немає. Створіть порожній розділ або виберіть шаблон.
        </div>
      )}

      {templateOpen ? (
        <Modal title="Створити власний розділ" onClose={() => setTemplateOpen(false)}>
          <div className="template-grid">
            {customSectionTemplates.map((template) => (
              <button
                type="button"
                key={template.id}
                onClick={() => startTemplate(template.id)}
              >
                <span><SectionIcon icon={template.icon} size={22} /></span>
                <strong>{template.name}</strong>
                <small>{template.description}</small>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {editing ? (
        <SectionEditor
          section={editing}
          sections={db.customSections}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </section>
  );
}

function SectionEditor({
  section,
  sections,
  onClose,
  onSave,
}: {
  section: CustomSectionDefinition;
  sections: CustomSectionDefinition[];
  onClose: () => void;
  onSave: (section: CustomSectionDefinition) => void;
}) {
  const [form, setForm] = useState(section);
  const unavailableParentIds = sectionDescendantIds(sections, form.id);

  const updateField = (id: string, patch: Partial<CustomSectionField>) => {
    if (patch.type === "attachments") return;
    setForm((current) => ({
      ...current,
      fields: current.fields.map((field) => field.id === id ? { ...field, ...patch } : field),
    }));
  };
  const addField = () => {
    const field: CustomSectionField = {
      id: createId(),
      label: "",
      type: "text",
      required: false,
      options: [],
    };
    setForm((current) => ({
      ...current,
      fields: [...current.fields, field],
      titleFieldId: current.titleFieldId || field.id,
    }));
  };
  const removeField = (id: string) => {
    setForm((current) => {
      const fields = current.fields.filter((field) => field.id !== id);
      return {
        ...current,
        fields,
        titleFieldId: current.titleFieldId === id
          ? fields[0]?.id ?? ""
          : current.titleFieldId,
      };
    });
  };
  const moveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= form.fields.length) return;
    setForm((current) => {
      const fields = [...current.fields];
      [fields[index], fields[target]] = [fields[target], fields[index]];
      return { ...current, fields };
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const fields = form.fields.map((field) => ({
      ...field,
      label: field.label.trim(),
      options: field.options.map((option) => option.trim()).filter(Boolean),
    }));
    if (!form.name.trim()) return;
    if (!fields.length || fields.some((field) => !field.label)) {
      window.alert("Додайте принаймні одне поле та вкажіть назву кожного поля.");
      return;
    }
    onSave({
      ...form,
      name: form.name.trim(),
      singularName: form.singularName.trim() || "запис",
      description: form.description.trim(),
      icon: form.icon || "folder",
      fields,
      titleFieldId: fields.some((field) => field.id === form.titleFieldId)
        ? form.titleFieldId
        : fields[0].id,
      updatedAt: nowIso(),
    });
  };

  return (
    <Modal title="Налаштування розділу" onClose={onClose}>
      <form className="section-builder-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field-wide">
            <span>Розташування розділу</span>
            <select
              value={form.parentKey ?? ""}
              onChange={(event) => setForm({
                ...form,
                parentKey: (event.target.value || null) as SectionParentKey | null,
              })}
            >
              <option value="">Кореневий власний розділ</option>
              <optgroup label="Основні генеалогічні розділи">
                {hierarchyRootKeys.map((key) => (
                  <option key={key} value={key}>{hierarchyRootLabels[key]}</option>
                ))}
              </optgroup>
              <optgroup label="Власні розділи">
                {sections
                  .filter((item) => item.id !== form.id && !unavailableParentIds.has(item.id))
                  .map((item) => (
                    <option key={item.id} value={customSectionKey(item.id)}>
                      {"— ".repeat(sectionDepth(sections, item))}{item.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
          <label>
            <span>Назва розділу</span>
            <input
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label>
            <span>Назва одного запису</span>
            <input
              required
              value={form.singularName}
              placeholder="наприклад: будівлю"
              onChange={(event) => setForm({ ...form, singularName: event.target.value })}
            />
          </label>
          <fieldset className="icon-picker-field">
            <span>Позначка в меню</span>
            <div className="section-icon-picker">
              {sectionIconOptions.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={form.icon === option.id ? "selected" : ""}
                  title={option.label}
                  aria-label={option.label}
                  aria-pressed={form.icon === option.id}
                  onClick={() => setForm({ ...form, icon: option.id })}
                >
                  <SectionIcon icon={option.id} size={21} />
                </button>
              ))}
            </div>
          </fieldset>
          <label>
            <span>Поле-заголовок запису</span>
            <select
              value={form.titleFieldId}
              onChange={(event) => setForm({ ...form, titleFieldId: event.target.value })}
            >
              {form.fields.map((field) => (
                <option key={field.id} value={field.id}>{field.label || "Поле без назви"}</option>
              ))}
            </select>
          </label>
          <label className="field-wide">
            <span>Опис розділу</span>
            <textarea
              rows={3}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>
        </div>

        <div className="builder-fields-heading">
          <div>
            <h3>Поля розділу</h3>
            <p>Кількість полів не обмежена. Порядок тут буде порядком у формі.</p>
          </div>
          <button type="button" className="button button-secondary" onClick={addField}>
            + Додати поле
          </button>
        </div>

        <div className="builder-field-list">
          {form.fields.map((field, index) => (
            <div className="builder-field" key={field.id}>
              <div className="builder-field-order">
                <button type="button" disabled={index === 0} onClick={() => moveField(index, -1)}>↑</button>
                <button
                  type="button"
                  disabled={index === form.fields.length - 1}
                  onClick={() => moveField(index, 1)}
                >↓</button>
              </div>
              <label>
                <span>Назва поля</span>
                <input
                  required
                  value={field.label}
                  onChange={(event) => updateField(field.id, { label: event.target.value })}
                />
              </label>
              <label>
                <span>Тип</span>
                <select
                  value={field.type}
                  onChange={(event) => updateField(field.id, {
                    type: event.target.value as CustomSectionFieldType,
                    options: [],
                    relationTarget: undefined,
                  })}
                >
                  {field.type === "attachments" ? (
                    <option value="attachments">Файли та скани (наявне поле)</option>
                  ) : null}
                  {customSectionFieldTypes.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              {field.type === "select" ? (
                <label className="builder-field-extra">
                  <span>Варіанти списку</span>
                  <input
                    value={field.options.join(", ")}
                    placeholder="через кому"
                    onChange={(event) => updateField(field.id, {
                      options: event.target.value.split(","),
                    })}
                  />
                </label>
              ) : null}
              {field.type === "relation" ? (
                <label className="builder-field-extra">
                  <span>Зв’язувати з</span>
                  <select
                    required
                    value={field.relationTarget ?? ""}
                    onChange={(event) => updateField(field.id, {
                      relationTarget: event.target.value as CustomSectionField["relationTarget"],
                    })}
                  >
                    <option value="">Виберіть розділ</option>
                    <option value="all">Усі розділи, згруповані за категоріями</option>
                    <option value="researches">Дослідження</option>
                    <option value="documents">Документи</option>
                    <option value="persons">Особи</option>
                    <option value="findings">Знахідки</option>
                    <option value="tasks">Завдання</option>
                    <option value="hypotheses">Гіпотези</option>
                    {sections.filter((item) => item.id !== form.id).map((item) => (
                      <option key={item.id} value={`custom:${item.id}`}>{item.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="checkbox-field builder-required">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) => updateField(field.id, { required: event.target.checked })}
                />
                <span>Обов’язкове</span>
              </label>
              <button
                type="button"
                className="icon-button danger"
                title="Видалити поле"
                onClick={() => removeField(field.id)}
              >×</button>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button type="submit" className="button button-primary">Зберегти розділ</button>
        </div>
      </form>
    </Modal>
  );
}

function cloneSection(section: CustomSectionDefinition): CustomSectionDefinition {
  return {
    ...section,
    fields: section.fields.map((field) => ({
      ...field,
      options: [...field.options],
    })),
  };
}
