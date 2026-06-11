import type {
  AppDatabase,
  CustomSectionDefinition,
  CustomSectionField,
  CustomSectionFieldType,
  CustomSectionRecord,
  CustomSectionRecordValue,
} from "../types";
import { nowIso } from "./dateHelpers";
import { createId } from "./id";

export interface CustomSectionTemplate {
  id: string;
  name: string;
  description: string;
  sectionName: string;
  singularName: string;
  icon: string;
  fields: Array<Pick<CustomSectionField, "label" | "type" | "required" | "options">>;
}

export const customSectionFieldTypes: Array<[CustomSectionFieldType, string]> = [
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

export const customSectionTemplates: CustomSectionTemplate[] = [
  {
    id: "blank",
    name: "Порожній розділ",
    description: "Власна назва та поля з чистого аркуша.",
    sectionName: "Новий розділ",
    singularName: "запис",
    icon: "folder",
    fields: [
      { label: "Назва", type: "text", required: true, options: [] },
    ],
  },
  {
    id: "village-history",
    name: "Історія населеного пункту",
    description: "Події, місця, джерела та описи з історії села або міста.",
    sectionName: "Історія населеного пункту",
    singularName: "історичний запис",
    icon: "village",
    fields: [
      { label: "Назва", type: "text", required: true, options: [] },
      { label: "Дата або період", type: "text", required: false, options: [] },
      { label: "Місце", type: "text", required: false, options: [] },
      { label: "Категорія", type: "select", required: false, options: ["подія", "місце", "установа", "переказ", "інше"] },
      { label: "Опис", type: "textarea", required: false, options: [] },
      { label: "Джерело", type: "textarea", required: false, options: [] },
      { label: "Файли та світлини", type: "attachments", required: false, options: [] },
    ],
  },
  {
    id: "buildings",
    name: "Історичні будівлі",
    description: "Будинки, храми, школи, підприємства та інші споруди.",
    sectionName: "Історичні будівлі",
    singularName: "будівлю",
    icon: "building",
    fields: [
      { label: "Назва будівлі", type: "text", required: true, options: [] },
      { label: "Адреса", type: "text", required: false, options: [] },
      { label: "Рік спорудження", type: "number", required: false, options: [] },
      { label: "Призначення", type: "text", required: false, options: [] },
      { label: "Стан", type: "select", required: false, options: ["збережена", "перебудована", "втрачена", "невідомо"] },
      { label: "Історія", type: "textarea", required: false, options: [] },
      { label: "Світлини й документи", type: "attachments", required: false, options: [] },
    ],
  },
  {
    id: "chronology",
    name: "Події та хронологія",
    description: "Хронологічний реєстр важливих подій.",
    sectionName: "Події та хронологія",
    singularName: "подію",
    icon: "calendar",
    fields: [
      { label: "Назва події", type: "text", required: true, options: [] },
      { label: "Дата", type: "date", required: false, options: [] },
      { label: "Приблизний період", type: "text", required: false, options: [] },
      { label: "Місце", type: "text", required: false, options: [] },
      { label: "Опис", type: "textarea", required: false, options: [] },
      { label: "Джерела", type: "textarea", required: false, options: [] },
      { label: "Вкладення", type: "attachments", required: false, options: [] },
    ],
  },
  {
    id: "institutions",
    name: "Установи й організації",
    description: "Церкви, школи, підприємства, товариства та органи управління.",
    sectionName: "Установи й організації",
    singularName: "установу",
    icon: "landmark",
    fields: [
      { label: "Назва установи", type: "text", required: true, options: [] },
      { label: "Тип", type: "select", required: false, options: ["церква", "школа", "підприємство", "товариство", "орган влади", "інше"] },
      { label: "Рік заснування", type: "number", required: false, options: [] },
      { label: "Рік припинення", type: "number", required: false, options: [] },
      { label: "Адреса або місце", type: "text", required: false, options: [] },
      { label: "Історія", type: "textarea", required: false, options: [] },
      { label: "Документи та світлини", type: "attachments", required: false, options: [] },
    ],
  },
  {
    id: "oral-history",
    name: "Усні свідчення",
    description: "Інтерв’ю, спогади, легенди та перекази.",
    sectionName: "Усні свідчення",
    singularName: "свідчення",
    icon: "microphone",
    fields: [
      { label: "Назва або тема", type: "text", required: true, options: [] },
      { label: "Оповідач", type: "text", required: false, options: [] },
      { label: "Дата запису", type: "date", required: false, options: [] },
      { label: "Місце запису", type: "text", required: false, options: [] },
      { label: "Текст свідчення", type: "textarea", required: false, options: [] },
      { label: "Коментар дослідника", type: "textarea", required: false, options: [] },
      { label: "Аудіо, фото або документи", type: "attachments", required: false, options: [] },
    ],
  },
];

export function sectionFromTemplate(template: CustomSectionTemplate): CustomSectionDefinition {
  const timestamp = nowIso();
  const fields = template.fields.map((field) => ({
    ...field,
    id: createId(),
  }));
  return {
    id: createId(),
    parentKey: null,
    name: template.sectionName,
    singularName: template.singularName,
    description: template.description,
    icon: template.icon,
    titleFieldId: fields[0]?.id ?? "",
    fields,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function customRecordTitle(
  section: CustomSectionDefinition,
  record: CustomSectionRecord,
): string {
  const title = record.values[section.titleFieldId];
  if (typeof title === "string" && title.trim()) return title;
  const firstText = section.fields
    .map((field) => record.values[field.id])
    .find((value) => typeof value === "string" && value.trim());
  return typeof firstText === "string" ? firstText : `${section.singularName || "Запис"} без назви`;
}

export function customRecordSearchText(
  db: AppDatabase,
  section: CustomSectionDefinition,
  record: CustomSectionRecord,
): string {
  return section.fields.map((field) => {
    const value = record.values[field.id];
    const fieldDefinitionText = [field.label, ...field.options].join(" ");
    if (field.type !== "relation" || !Array.isArray(value)) {
      return `${fieldDefinitionText} ${flattenValue(value)}`;
    }
    const relatedValues = (value as string[])
      .map((id) => relatedRecordLabel(db, field.relationTarget, id))
      .join(" ");
    return `${fieldDefinitionText} ${relatedValues}`;
  }).join(" ");
}

export function relatedRecordLabel(
  db: AppDatabase,
  target: CustomSectionField["relationTarget"],
  id: string,
): string {
  if (!target) return id;
  if (target === "all") {
    for (const section of db.customSections) {
      const record = db.customSectionRecords.find(
        (item) => item.sectionId === section.id && item.id === id,
      );
      if (record) return customRecordTitle(section, record);
    }
    for (const collection of relationCollections) {
      const item = db[collection].find((entity) => entity.id === id);
      if (item) return standardRecordLabel(item);
    }
    return "Запис недоступний";
  }
  if (target.startsWith("custom:")) {
    const sectionId = target.slice("custom:".length);
    const section = db.customSections.find((item) => item.id === sectionId);
    const record = db.customSectionRecords.find(
      (item) => item.sectionId === sectionId && item.id === id,
    );
    return section && record ? customRecordTitle(section, record) : "Запис недоступний";
  }
  const collection = target as import("../types").CollectionKey;
  const item = db[collection].find((entity) => entity.id === id);
  if (!item) return "Запис недоступний";
  return standardRecordLabel(item);
}

export function emptyCustomValue(type: CustomSectionFieldType): CustomSectionRecordValue {
  if (type === "boolean") return false;
  if (type === "attachments" || type === "relation" || type === "multiselect") return [];
  return "";
}

function flattenValue(value: CustomSectionRecordValue | undefined): string {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item : item.name).join(" ");
  }
  return String(value ?? "");
}

const relationCollections = [
  "researches",
  "documents",
  "persons",
  "findings",
  "tasks",
  "hypotheses",
  "archiveRequests",
  "yearMatrix",
] as const;

function standardRecordLabel(item: unknown): string {
  const candidate = item as Record<string, unknown>;
  return String(
    candidate.title ||
    candidate.fullName ||
    candidate.subject ||
    candidate.summary ||
    candidate.personName ||
    candidate.year ||
    "Запис",
  );
}
