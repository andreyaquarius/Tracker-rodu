import { useState } from "react";
import type {
  AppDatabase,
  CustomFieldDefinition,
  CustomFieldModule,
  CustomFieldType,
} from "../types";
import { createId } from "../utils/id";

const fieldTypes: Array<[CustomFieldType, string]> = [
  ["text", "Короткий текст"],
  ["textarea", "Довгий текст"],
  ["number", "Число"],
  ["year", "Рік"],
  ["date", "Дата"],
  ["time", "Час"],
  ["approximate-date", "Приблизна дата або період"],
  ["place", "Місце"],
  ["select", "Список"],
  ["multiselect", "Множинний список"],
  ["boolean", "Так / ні"],
  ["url", "Посилання"],
  ["email", "Електронна пошта"],
  ["tel", "Телефон"],
  ["attachments", "Файли та скани"],
  ["relation", "Зв’язок з іншими записами"],
];

export function InlineCustomFieldCreator({
  module,
  db,
  definitions,
  onAdd,
}: {
  module: CustomFieldModule;
  db: AppDatabase;
  definitions: CustomFieldDefinition[];
  onAdd: (definition: CustomFieldDefinition) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [options, setOptions] = useState("");
  const [relationTarget, setRelationTarget] = useState("all");

  const add = () => {
    const fieldLabel = label.trim();
    const listOptions = options
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!fieldLabel) {
      window.alert("Вкажіть назву нового поля.");
      return;
    }
    if (
      definitions.some(
        (field) =>
          field.module === module &&
          field.label.toLocaleLowerCase("uk") === fieldLabel.toLocaleLowerCase("uk"),
      )
    ) {
      window.alert("Поле з такою назвою вже існує в цьому розділі.");
      return;
    }
    if (["select", "multiselect"].includes(type) && !listOptions.length) {
      window.alert("Додайте хоча б один варіант списку.");
      return;
    }
    onAdd({
      id: createId(),
      module,
      label: fieldLabel,
      type,
      options: ["select", "multiselect"].includes(type) ? listOptions : [],
      relationTarget: type === "relation"
        ? relationTarget as CustomFieldDefinition["relationTarget"]
        : undefined,
    });
    setLabel("");
    setOptions("");
    setType("text");
    setOpen(false);
  };

  return (
    <div className="inline-custom-field field-wide">
      <button
        type="button"
        className="button button-secondary"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Скасувати додавання поля" : "+ Додати власне поле"}
      </button>
      {open ? (
        <div className="inline-custom-field-panel">
          <p className="field-wide">
            Нове поле буде доступне в усіх записах цього розділу.
          </p>
          <label>
            <span>Назва поля</span>
            <input
              value={label}
              placeholder="Наприклад: Назва маєтку"
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
          </label>
          <label>
            <span>Тип поля</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value as CustomFieldType)}
            >
              {fieldTypes.map(([value, text]) => (
                <option key={value} value={value}>{text}</option>
              ))}
            </select>
          </label>
          {["select", "multiselect"].includes(type) ? (
            <label className="field-wide">
              <span>Варіанти списку</span>
              <textarea
                rows={3}
                value={options}
                placeholder="Один варіант на рядок або через кому"
                onChange={(event) => setOptions(event.target.value)}
              />
            </label>
          ) : null}
          {type === "relation" ? (
            <label className="field-wide">
              <span>Зв’язувати з</span>
              <select
                value={relationTarget}
                onChange={(event) => setRelationTarget(event.target.value)}
              >
                <option value="all">Усі розділи, згруповані за категоріями</option>
                <option value="researches">Дослідження</option>
                <option value="documents">Документи</option>
                <option value="persons">Особи</option>
                <option value="findings">Знахідки</option>
                <option value="tasks">Завдання</option>
                <option value="hypotheses">Гіпотези</option>
                <option value="archiveRequests">Запити в архів</option>
                <option value="yearMatrix">Матриця років</option>
                {db.customSections.map((section) => (
                  <option key={section.id} value={`custom:${section.id}`}>{section.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="inline-custom-field-actions field-wide">
            <button type="button" className="button button-primary" onClick={add}>
              Додати поле до розділу
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
