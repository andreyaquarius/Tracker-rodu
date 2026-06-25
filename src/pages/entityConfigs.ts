import type { CollectionKey } from "../types";
import type { TableColumn } from "../components/DataTable";
import { primaryParticipantName } from "../utils/findingParticipants";

export interface FieldConfig {
  key: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "number"
    | "date"
    | "url"
    | "select"
    | "checkbox"
    | "research"
    | "document"
    | "documents"
    | "findings"
    | "participants"
    | "persons"
    | "scans";
  options?: string[];
  required?: boolean;
  wide?: boolean;
  attachmentPolicy?: "all" | "finding" | "archive-request" | "document";
  attachmentAccept?: string;
  attachmentDescription?: string;
  attachmentLimitMessage?: string;
  maxFiles?: number;
}

export interface EntityConfig {
  collection: CollectionKey;
  title: string;
  singular: string;
  description: string;
  emptyText: string;
  searchPlaceholder: string;
  fields: FieldConfig[];
  columns: TableColumn[];
  statusKey?: "status" | "reviewStatus";
  statusOptions?: string[];
}

const researchField: FieldConfig = {
  key: "researchId",
  label: "Дослідження",
  type: "research",
};

const archiveOptions = [
  "ЦДІАК України (Київ)",
  "ЦДІАЛ України (Львів)",
  "ЦДАВО України",
  "ЦДАГО України",
  "Державний архів Вінницької області",
  "Державний архів Волинської області",
  "Державний архів Дніпропетровської області",
  "Державний архів Житомирської області",
  "Державний архів Закарпатської області",
  "Державний архів Запорізької області",
  "Державний архів Івано-Франківської області",
  "Державний архів Київської області",
  "Державний архів Кіровоградської області",
  "Державний архів Львівської області",
  "Державний архів Миколаївської області",
  "Державний архів Одеської області",
  "Державний архів Полтавської області",
  "Державний архів Рівненської області",
  "Державний архів Сумської області",
  "Державний архів Тернопільської області",
  "Державний архів Харківської області",
  "Державний архів Хмельницької області",
  "Державний архів Черкаської області",
  "Державний архів Чернівецької області",
  "Державний архів Чернігівської області",
  "Інший архів або установа",
];

export const configs: Record<Exclude<CollectionKey, "yearMatrix" | "persons">, EntityConfig> = {
  researches: {
    collection: "researches",
    title: "Дослідження",
    singular: "дослідження",
    description: "Окремі напрями пошуку з метою, періодом та робочими нотатками.",
    emptyText: "Ще немає досліджень. Створіть перший напрям пошуку.",
    searchPlaceholder: "Пошук за назвою, прізвищем або місцем…",
    statusKey: "status",
    statusOptions: ["активне", "призупинене", "завершене"],
    fields: [
      { key: "title", label: "Назва дослідження", required: true, wide: true },
      { key: "goal", label: "Головна мета", type: "textarea", wide: true },
      { key: "surnames", label: "Основні прізвища" },
      { key: "places", label: "Населені пункти" },
      { key: "periodFrom", label: "Період від", type: "number" },
      { key: "periodTo", label: "Період до", type: "number" },
      { key: "archives", label: "Архіви", type: "textarea", wide: true },
      { key: "status", label: "Статус", type: "select", options: ["активне", "призупинене", "завершене"] },
      { key: "notes", label: "Нотатки", type: "textarea", wide: true },
    ],
    columns: [
      { key: "title", label: "Назва" },
      { key: "surnames", label: "Прізвища" },
      { key: "places", label: "Місця" },
      { key: "period", label: "Період", render: (item) => {
        const row = item as unknown as Record<string, string>;
        return [row.periodFrom, row.periodTo].filter(Boolean).join("–") || "—";
      } },
      { key: "status", label: "Статус" },
    ],
  },
  documents: {
    collection: "documents",
    title: "Документи",
    singular: "документ",
    description: "Реєстр джерел, прогрес перегляду та точне місце зупинки.",
    emptyText: "Ще немає документів для перегляду.",
    searchPlaceholder: "Пошук за назвою, архівом, фондом або місцем…",
    statusKey: "reviewStatus",
    statusOptions: ["не почато", "в роботі", "переглянуто", "потрібно повторно перевірити", "недоступно"],
    fields: [
      researchField,
      { key: "title", label: "Назва документа", required: true, wide: true },
      { key: "documentType", label: "Тип документа", type: "select", options: ["народження", "шлюби", "смерті", "метрична книга", "сповідний розпис", "ревізія", "інвентар", "судова справа", "військовий документ", "інше"] },
      { key: "archive", label: "Архів" },
      { key: "fund", label: "Фонд" },
      { key: "description", label: "Опис" },
      { key: "file", label: "Справа" },
      { key: "yearFrom", label: "Рік від", type: "number" },
      { key: "yearTo", label: "Рік до", type: "number" },
      { key: "place", label: "Населений пункт" },
      { key: "url", label: "Посилання на документ", type: "url", wide: true },
      {
        key: "scans",
        label: "Скан документа",
        type: "scans",
        wide: true,
        attachmentPolicy: "document",
        attachmentDescription: "Додайте скан, файл із хмарного сховища або посилання на зовнішнє джерело: Вікіджерела, електронний архів, бібліотеку чи інший сайт із документом.",
      },
      { key: "pagesCount", label: "Кількість сторінок / аркушів", type: "number" },
      { key: "lastPage", label: "Остання переглянута сторінка", type: "number" },
      { key: "reviewStatus", label: "Статус перегляду", type: "select", options: ["не почато", "в роботі", "переглянуто", "потрібно повторно перевірити", "недоступно"] },
      { key: "notes", label: "Нотатки", type: "textarea", wide: true },
    ],
    columns: [
      { key: "title", label: "Документ" },
      { key: "year", label: "Рік", render: (item) => {
        const row = item as unknown as Record<string, string>;
        const from = String(row.yearFrom ?? "").trim();
        const to = String(row.yearTo ?? "").trim();
        return from && to && from !== to ? `${from}–${to}` : from || to || "—";
      } },
      { key: "archive", label: "Архів" },
      { key: "documentType", label: "Тип" },
      { key: "place", label: "Населений пункт" },
      { key: "nextPage", label: "Наступна сторінка", render: (item) => {
        const page = Number((item as unknown as Record<string, string>).lastPage || 0) + 1;
        return String(page);
      } },
      { key: "reviewStatus", label: "Статус" },
    ],
  },
  archiveRequests: {
    collection: "archiveRequests",
    title: "Запити в архів",
    singular: "запит",
    description: "Облік звернень до архівів, надісланих запитів і отриманих відповідей.",
    emptyText: "Запитів до архівів поки немає.",
    searchPlaceholder: "Пошук за архівом, темою запиту, особою або коментарем…",
    statusKey: "status",
    statusOptions: ["чернетка", "надіслано", "очікується відповідь", "отримано відповідь", "виконано", "відмовлено"],
    fields: [
      researchField,
      { key: "personIds", label: "Пов’язані особи", type: "persons", wide: true },
      { key: "archive", label: "Архів", type: "select", options: archiveOptions, required: true },
      { key: "archiveDetails", label: "Уточнення архіву або установи", wide: true },
      { key: "requestDate", label: "Дата запиту", type: "date", required: true },
      { key: "responseDate", label: "Дата відповіді", type: "date" },
      {
        key: "status",
        label: "Статус",
        type: "select",
        options: ["чернетка", "надіслано", "очікується відповідь", "отримано відповідь", "виконано", "відмовлено"],
      },
      { key: "subject", label: "Про що запит", type: "textarea", required: true, wide: true },
      {
        key: "requestScans",
        label: "Файл запиту",
        type: "scans",
        wide: true,
        attachmentPolicy: "archive-request",
        attachmentAccept: ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        attachmentDescription: "Додайте один файл запиту у форматі Word (DOC, DOCX) або PDF. Максимальний розмір — 25 МБ.",
        attachmentLimitMessage: "До одного архівного запиту можна прикріпити лише один файл запиту.",
        maxFiles: 1,
      },
      {
        key: "responseScans",
        label: "Файл відповіді архіву",
        type: "scans",
        wide: true,
        attachmentPolicy: "archive-request",
        attachmentAccept: ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        attachmentDescription: "Додайте один файл відповіді архіву у форматі Word (DOC, DOCX) або PDF. Максимальний розмір — 25 МБ.",
        attachmentLimitMessage: "До одного архівного запиту можна прикріпити лише один файл відповіді.",
        maxFiles: 1,
      },
      { key: "notes", label: "Коментарі та нотатки", type: "textarea", wide: true },
    ],
    columns: [
      { key: "requestDate", label: "Дата запиту" },
      { key: "researchId", label: "Дослідження" },
      { key: "archive", label: "Архів" },
      { key: "subject", label: "Про що запит" },
      { key: "responseDate", label: "Дата відповіді" },
      { key: "status", label: "Статус" },
    ],
  },
  tasks: {
    collection: "tasks",
    title: "Завдання",
    singular: "завдання",
    description: "Наступні кроки дослідження, пріоритети та строки.",
    emptyText: "Відкритих завдань поки немає.",
    searchPlaceholder: "Пошук за назвою, особою або місцем…",
    statusKey: "status",
    statusOptions: ["не почато", "в роботі", "знайдено", "не знайдено", "перевірено", "потрібно повторно перевірити", "закрито"],
    fields: [
      researchField,
      { key: "personName", label: "Особа" },
      { key: "personIds", label: "Пов’язані особи", type: "persons", wide: true },
      { key: "title", label: "Назва завдання", required: true, wide: true },
      { key: "description", label: "Опис", type: "textarea", wide: true },
      { key: "place", label: "Населений пункт" },
      { key: "yearFrom", label: "Рік від", type: "number" },
      { key: "yearTo", label: "Рік до", type: "number" },
      { key: "documentType", label: "Тип документа" },
      { key: "documentId", label: "Пов’язаний документ", type: "document", wide: true },
      { key: "status", label: "Статус", type: "select", options: ["не почато", "в роботі", "знайдено", "не знайдено", "перевірено", "потрібно повторно перевірити", "закрито"] },
      { key: "priority", label: "Пріоритет", type: "select", options: ["низький", "середній", "високий", "критичний"] },
      { key: "deadline", label: "Дедлайн", type: "date" },
      { key: "notes", label: "Нотатки", type: "textarea", wide: true },
    ],
    columns: [
      { key: "title", label: "Завдання" },
      { key: "personName", label: "Особа" },
      { key: "priority", label: "Пріоритет" },
      { key: "deadline", label: "Дедлайн" },
      { key: "status", label: "Статус" },
    ],
  },
  findings: {
    collection: "findings",
    title: "Знахідки",
    singular: "знахідку",
    description: "Факти з точними посиланнями, транскрипціями та оцінкою надійності.",
    emptyText: "Ще не додано жодної знахідки.",
    searchPlaceholder: "Пошук за особою, місцем, архівом або справою…",
    fields: [
      researchField,
      { key: "documentId", label: "Пов’язаний документ", type: "document", wide: true },
      { key: "findingType", label: "Тип знахідки", type: "select", options: ["народження", "шлюб", "смерть", "згадка", "посімейний список", "сповідний розпис", "ревізія", "інвентар", "судова справа", "військовий документ", "інше"] },
      { key: "eventDate", label: "Дата події", type: "date" },
      { key: "personsText", label: "Особа або особи — сирий текст", type: "textarea", wide: true },
      { key: "personIds", label: "Пов’язані особи", type: "persons", wide: true },
      { key: "participants", label: "Учасники запису", type: "participants", required: true, wide: true },
      { key: "place", label: "Населений пункт" },
      { key: "archive", label: "Архів" },
      { key: "fund", label: "Фонд" },
      { key: "description", label: "Опис" },
      { key: "file", label: "Справа" },
      { key: "page", label: "Аркуш або сторінка" },
      {
        key: "scans",
        label: "Файл знахідки",
        type: "scans",
        wide: true,
        attachmentPolicy: "finding",
        attachmentAccept: "image/*,.pdf,.txt,.md,.rtf,.csv,.json,.xml,.html,.htm",
        attachmentDescription: "Один файл: зображення, PDF або текстовий файл (TXT, Markdown, RTF, CSV, JSON, XML чи HTML). Максимальний розмір — 25 МБ.",
        maxFiles: 1,
      },
      { key: "summary", label: "Короткий зміст", type: "textarea", wide: true },
      { key: "transcription", label: "Точна транскрипція", type: "textarea", wide: true },
      { key: "conclusion", label: "Висновок", type: "textarea", wide: true },
      { key: "reliability", label: "Рівень надійності", type: "select", options: ["високий", "середній", "низький", "сумнівний"] },
      { key: "needsReview", label: "Потребує повторної перевірки", type: "checkbox" },
      { key: "notes", label: "Нотатки", type: "textarea", wide: true },
    ],
    columns: [
      {
        key: "participants",
        label: "Основна особа",
        render: (item) => primaryParticipantName(
          (item as unknown as { participants?: import("../types").FindingParticipant[] }).participants ?? [],
        ) || "—",
      },
      { key: "findingType", label: "Тип" },
      { key: "eventDate", label: "Дата" },
      { key: "place", label: "Місце" },
      { key: "reliability", label: "Надійність" },
    ],
  },
  hypotheses: {
    collection: "hypotheses",
    title: "Гіпотези",
    singular: "гіпотезу",
    description: "Версії, аргументи за і проти та план доказування.",
    emptyText: "Гіпотез ще немає.",
    searchPlaceholder: "Пошук за назвою, описом або особами…",
    statusKey: "status",
    statusOptions: ["активна", "підтверджена", "спростована", "відкладена"],
    fields: [
      researchField,
      { key: "title", label: "Назва гіпотези", required: true, wide: true },
      { key: "description", label: "Опис", type: "textarea", wide: true },
      { key: "argumentsFor", label: "Аргументи за", type: "textarea", wide: true },
      { key: "argumentsAgainst", label: "Аргументи проти", type: "textarea", wide: true },
      { key: "toVerify", label: "Що треба перевірити", type: "textarea", wide: true },
      { key: "relatedPeople", label: "Пов’язані особи", wide: true },
      { key: "personIds", label: "Картки пов’язаних осіб", type: "persons", wide: true },
      { key: "documentIds", label: "Пов’язані документи", type: "documents", wide: true },
      { key: "findingIds", label: "Пов’язані знахідки", type: "findings", wide: true },
      { key: "status", label: "Статус", type: "select", options: ["активна", "підтверджена", "спростована", "відкладена"] },
      { key: "probability", label: "Рівень імовірності", type: "select", options: ["низький", "середній", "високий"] },
      { key: "notes", label: "Нотатки", type: "textarea", wide: true },
    ],
    columns: [
      { key: "title", label: "Гіпотеза" },
      { key: "relatedPeople", label: "Особи" },
      { key: "probability", label: "Імовірність" },
      { key: "status", label: "Статус" },
    ],
  },
};
