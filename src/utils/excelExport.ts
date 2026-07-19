import type {
  AppDatabase,
  AppEntity,
  CollectionKey,
  CustomFieldDefinition,
  CustomFieldValue,
  CustomSectionDefinition,
  CustomSectionRelationTarget,
  CustomSectionRecord,
  CustomSectionRecordValue,
  FindingParticipant,
  Person,
  ScanAttachment,
} from "../types";
import type { FieldConfig } from "../pages/entityConfigs";
import { customRecordTitle, relatedRecordLabel } from "./customSections";
import {
  projectBackupRecords,
  PROJECT_EXCEL_BACKUP_SHEET_NAME,
} from "./excelBackupFormat";
import { neutralizeSpreadsheetValue } from "./spreadsheetSafe";

interface WorkbookColumn {
  key: string;
  label: string;
  width?: number;
  value?: (record: Record<string, unknown>) => WorkbookCellValue;
}

interface WorkbookSheet {
  name: string;
  columns: WorkbookColumn[];
  records: Array<Record<string, unknown>>;
  hidden?: boolean;
}

interface HyperlinkCell {
  text: string;
  url: string;
}

type WorkbookCellValue = string | number | HyperlinkCell | null | undefined;

interface EntityExportOptions {
  db: AppDatabase;
  collection: CollectionKey;
  title: string;
  projectName: string;
  records: AppEntity[];
  fields: FieldConfig[];
  scope: "filtered" | "all";
  customFieldDefinitions?: CustomFieldDefinition[];
}

export const standardLabels: Record<CollectionKey, Record<string, string>> = {
  researches: {
    title: "Назва дослідження",
    goal: "Головна мета",
    surnames: "Основні прізвища",
    places: "Населені пункти",
    periodFrom: "Період від",
    periodTo: "Період до",
    archives: "Архіви",
    status: "Статус",
    notes: "Нотатки",
  },
  documents: {
    researchId: "Дослідження",
    title: "Назва документа",
    documentType: "Тип документа",
    archive: "Архів",
    fund: "Фонд",
    description: "Опис",
    file: "Справа",
    yearFrom: "Рік від",
    yearTo: "Рік до",
    place: "Населений пункт",
    url: "Посилання",
    scans: "Скан документа",
    pagesCount: "Кількість сторінок / аркушів",
    lastPage: "Остання переглянута сторінка",
    reviewStatus: "Статус перегляду",
    notes: "Нотатки",
  },
  yearMatrix: {
    researchId: "Дослідження",
    documentId: "Пов’язаний документ",
    year: "Рік",
    place: "Населений пункт",
    documentType: "Тип документа",
    status: "Статус",
    notes: "Примітка",
  },
  tasks: {
    researchId: "Дослідження",
    personName: "Особа",
    personIds: "Пов’язані особи",
    title: "Назва завдання",
    description: "Опис",
    place: "Населений пункт",
    yearFrom: "Рік від",
    yearTo: "Рік до",
    documentType: "Тип документа",
    documentId: "Пов’язаний документ",
    status: "Статус",
    priority: "Пріоритет",
    deadline: "Дедлайн",
    reminderAt: "Дата й час нагадування",
    reminderInApp: "Нагадування в застосунку",
    reminderEmail: "Нагадування електронною поштою",
    reminderSentAt: "Нагадування надіслано",
    notes: "Нотатки",
  },
  findings: {
    researchId: "Дослідження",
    documentId: "Пов’язаний документ",
    findingType: "Тип знахідки",
    eventDate: "Дата події",
    personsText: "Особи — текст джерела",
    personIds: "Пов’язані особи",
    participants: "Учасники запису",
    place: "Населений пункт",
    archive: "Архів",
    fund: "Фонд",
    description: "Опис",
    file: "Справа",
    page: "Аркуш або сторінка",
    sourceUrl: "Посилання на джерело",
    scans: "Файл знахідки",
    summary: "Короткий зміст",
    transcription: "Точна транскрипція",
    conclusion: "Висновок",
    reliability: "Рівень надійності",
    needsReview: "Потребує повторної перевірки",
    notes: "Нотатки",
  },
  hypotheses: {
    researchId: "Дослідження",
    title: "Назва гіпотези",
    description: "Опис",
    argumentsFor: "Аргументи за",
    argumentsAgainst: "Аргументи проти",
    toVerify: "Що треба перевірити",
    relatedPeople: "Пов’язані особи — текст",
    personIds: "Картки пов’язаних осіб",
    documentIds: "Пов’язані документи",
    findingIds: "Пов’язані знахідки",
    status: "Статус",
    probability: "Рівень імовірності",
    notes: "Нотатки",
  },
  archiveRequests: {
    researchId: "Дослідження",
    personIds: "Пов’язані особи",
    archive: "Архів",
    archiveDetails: "Уточнення архіву або установи",
    requestDate: "Дата запиту",
    responseDate: "Дата відповіді",
    subject: "Про що запит",
    status: "Статус",
    requestScans: "Файл запиту",
    responseScans: "Файл відповіді архіву",
    notes: "Коментарі та нотатки",
  },
  persons: {
    researchId: "Дослідження",
    surname: "Прізвище",
    givenName: "Ім’я",
    patronymic: "По батькові",
    fullName: "Повне ім’я",
    gender: "Стать",
    nameVariants: "Варіанти імені",
    surnameVariants: "Варіанти прізвища",
    birthDate: "Дата народження",
    birthYearFrom: "Рік народження від",
    birthYearTo: "Рік народження до",
    birthPlace: "Місце народження",
    marriageDate: "Дата шлюбу",
    marriagePlace: "Місце шлюбу",
    deathDate: "Дата смерті",
    deathYearFrom: "Рік смерті від",
    deathYearTo: "Рік смерті до",
    deathPlace: "Місце смерті",
    residencePlaces: "Місця проживання",
    socialStatus: "Соціальний статус",
    religion: "Віросповідання",
    occupation: "Професія або заняття",
    status: "Статус",
    isLiving: "Жива особа",
    privacyStatus: "Приватність у дереві",
    notes: "Нотатки",
  },
};

const personFields = Object.entries(standardLabels.persons).map(([key, label]) => ({
  key,
  label,
}));

export function exportEntityRecordsToExcel({
  db,
  collection,
  title,
  projectName,
  records,
  fields,
  scope,
  customFieldDefinitions = [],
}: EntityExportOptions): void {
  const columns = entityColumns(
    db,
    collection,
    fields.map(({ key, label }) => ({ key, label })),
    customFieldDefinitions,
    records as unknown as Array<Record<string, unknown>>,
  );
  downloadWorkbook(
    exportFileName(projectName, `${title}-${scope === "filtered" ? "за-фільтрами" : "усі"}`),
    [{ name: title, columns, records: records as unknown as Array<Record<string, unknown>> }],
  );
}

export function exportPersonsToExcel(
  db: AppDatabase,
  projectName: string,
  records: Person[],
  scope: "filtered" | "all",
  customFieldDefinitions: CustomFieldDefinition[],
): void {
  downloadWorkbook(
    exportFileName(projectName, `Особи-${scope === "filtered" ? "за-фільтрами" : "усі"}`),
    [{
      name: "Особи",
      columns: entityColumns(
        db,
        "persons",
        personFields,
        customFieldDefinitions,
        records as unknown as Array<Record<string, unknown>>,
      ),
      records: records as unknown as Array<Record<string, unknown>>,
    }],
  );
}

export function exportCustomSectionToExcel(
  db: AppDatabase,
  projectName: string,
  section: CustomSectionDefinition,
  records: CustomSectionRecord[],
  scope: "filtered" | "all",
): void {
  const columns: WorkbookColumn[] = [
    {
      key: "__title",
      label: "Назва",
      value: (record) => customRecordTitle(section, record as unknown as CustomSectionRecord),
    },
    ...section.fields.map((field) => ({
      key: field.id,
      label: field.label,
      value: (record: Record<string, unknown>) => {
        const customRecord = record as unknown as CustomSectionRecord;
        return formatCustomSectionValue(db, field.relationTarget, customRecord.values[field.id]);
      },
    })),
    metadataColumn("createdAt", "Створено"),
    metadataColumn("updatedAt", "Оновлено"),
  ];
  downloadWorkbook(
    exportFileName(projectName, `${section.name}-${scope === "filtered" ? "за-фільтрами" : "усі"}`),
    [{
      name: section.name,
      columns,
      records: records as unknown as Array<Record<string, unknown>>,
    }],
  );
}

export function exportProjectToExcel(db: AppDatabase, projectName: string): void {
  const sheets: WorkbookSheet[] = (
    Object.keys(standardLabels) as CollectionKey[]
  ).map((collection) => {
    const records = db[collection] as unknown as Array<Record<string, unknown>>;
    return {
      name: collectionSheetName(collection),
      columns: entityColumns(
        db,
        collection,
        Object.entries(standardLabels[collection]).map(([key, label]) => ({ key, label })),
        db.settings.customFields,
        records,
      ),
      records,
    };
  });

  sheets.push({
    name: "Зв’язки осіб",
    columns: [
      {
        key: "personId",
        label: "Особа",
        value: (record) => personName(db.persons.find((person) => person.id === record.personId)) ?? String(record.personId ?? ""),
      },
      {
        key: "relatedPersonId",
        label: "Пов’язана особа",
        value: (record) => personName(db.persons.find((person) => person.id === record.relatedPersonId)) ?? String(record.relatedPersonId ?? ""),
      },
      { key: "relationType", label: "Тип зв’язку" },
      { key: "status", label: "Статус" },
      { key: "evidenceText", label: "Докази" },
      { key: "notes", label: "Нотатки" },
      metadataColumn("createdAt", "Створено"),
      metadataColumn("updatedAt", "Оновлено"),
    ],
    records: db.personRelations as unknown as Array<Record<string, unknown>>,
  });

  sheets.push({
    name: "Журнал активності",
    columns: [
      metadataColumn("createdAt", "Дата й час"),
      { key: "text", label: "Дія" },
      { key: "module", label: "Розділ" },
      { key: "actionType", label: "Тип дії" },
      { key: "relatedId", label: "Пов’язаний запис" },
    ],
    records: db.activityLog as unknown as Array<Record<string, unknown>>,
  });

  if (db.settings.customFields.length) {
    sheets.push({
      name: "Додаткові поля",
      columns: [
        { key: "module", label: "Розділ" },
        { key: "label", label: "Назва поля" },
        { key: "type", label: "Тип поля" },
        {
          key: "options",
          label: "Варіанти",
          value: (record) => Array.isArray(record.options) ? record.options.join(", ") : "",
        },
      ],
      records: db.settings.customFields as unknown as Array<Record<string, unknown>>,
    });
  }

  for (const section of db.customSections) {
    sheets.push({
      name: section.name,
      columns: [
        {
          key: "__title",
          label: "Назва",
          value: (record) => customRecordTitle(section, record as unknown as CustomSectionRecord),
        },
        ...section.fields.map((field) => ({
          key: field.id,
          label: field.label,
          value: (record: Record<string, unknown>) => {
            const customRecord = record as unknown as CustomSectionRecord;
            return formatCustomSectionValue(db, field.relationTarget, customRecord.values[field.id]);
          },
        })),
        metadataColumn("createdAt", "Створено"),
        metadataColumn("updatedAt", "Оновлено"),
      ],
      records: db.customSectionRecords
        .filter((record) => record.sectionId === section.id) as unknown as Array<Record<string, unknown>>,
    });
  }

  sheets.push({
    name: PROJECT_EXCEL_BACKUP_SHEET_NAME,
    hidden: true,
    columns: [
      { key: "key", label: "Ключ" },
      { key: "value", label: "Значення", width: 42 },
    ],
    records: projectBackupRecords(db) as unknown as Array<Record<string, unknown>>,
  });

  downloadWorkbook(exportFileName(projectName, "повний-проєкт"), sheets);
}

function entityColumns(
  db: AppDatabase,
  collection: CollectionKey,
  fields: Array<{ key: string; label: string }>,
  customFieldDefinitions: CustomFieldDefinition[],
  records: Array<Record<string, unknown>> = [],
): WorkbookColumn[] {
  const uniqueFields = new Map(fields.map((field) => [field.key, field]));
  const columns: WorkbookColumn[] = [{ key: "id", label: "ID запису" }];
  columns.push(...Array.from(uniqueFields.values()).flatMap((field) => {
    if (collection === "findings" && field.key === "participants") {
      return findingParticipantColumns(records);
    }
    return [{
      key: field.key,
      label: field.label,
      value: (record: Record<string, unknown>) =>
        formatEntityValue(db, field.key, record[field.key]),
    }];
  }));

  for (const definition of customFieldDefinitions.filter((field) => field.module === collection)) {
    columns.push({
      key: `custom:${definition.id}`,
      label: definition.label,
      value: (record) => {
        const customFields = record.customFields as Record<string, CustomFieldValue> | undefined;
        return formatEntityValue(db, definition.id, customFields?.[definition.id]);
      },
    });
  }

  columns.push(metadataColumn("createdAt", "Створено"));
  columns.push(metadataColumn("updatedAt", "Оновлено"));
  return columns;
}

function findingParticipantColumns(
  records: Array<Record<string, unknown>>,
): WorkbookColumn[] {
  const maximum = Math.max(
    1,
    ...records.map((record) =>
      Array.isArray(record.participants) ? record.participants.length : 0
    ),
  );
  return Array.from({ length: maximum }, (_, index) => ({
    key: `participant:${index}`,
    label: `Учасник ${index + 1}`,
    width: 30,
    value: (record: Record<string, unknown>) => {
      const participants = Array.isArray(record.participants)
        ? record.participants as FindingParticipant[]
        : [];
      const participant = participants[index];
      if (!participant) return "";
      return [
        participant.role,
        participant.name,
        participant.notes,
      ].filter(Boolean).join("\n");
    },
  }));
}

function metadataColumn(key: string, label: string): WorkbookColumn {
  return {
    key,
    label,
    value: (record) => formatDateTime(record[key]),
  };
}

function formatEntityValue(db: AppDatabase, key: string, value: unknown): WorkbookCellValue {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Так" : "Ні";
  if (typeof value === "number") return value;
  if (key === "privacyStatus") return personPrivacyStatusLabel(String(value));
  if (key === "researchId") return db.researches.find((item) => item.id === value)?.title ?? String(value);
  if (key === "documentId") return db.documents.find((item) => item.id === value)?.title ?? String(value);
  if (key === "personIds") return formatIds(value, (id) => personName(db.persons.find((item) => item.id === id)));
  if (key === "documentIds") return formatIds(value, (id) => db.documents.find((item) => item.id === id)?.title);
  if (key === "findingIds") return formatIds(value, (id) => {
    const finding = db.findings.find((item) => item.id === id);
    return finding?.summary || finding?.findingType;
  });
  if (key === "participants" && Array.isArray(value)) {
    return (value as FindingParticipant[])
      .map((participant) => [participant.role, participant.name, participant.notes].filter(Boolean).join(": "))
      .join("\n");
  }
  if (Array.isArray(value)) {
    if (value.every(isAttachment)) return formatAttachments(value as ScanAttachment[]);
    return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function personPrivacyStatusLabel(value: string): string {
  switch (value) {
    case "project":
      return "У межах проєкту";
    case "public":
      return "Публічна";
    case "confidential":
      return "Конфіденційна";
    case "private":
    default:
      return "Приватна";
  }
}

function formatCustomSectionValue(
  db: AppDatabase,
  relationTarget: CustomSectionRelationTarget | undefined,
  value: CustomSectionRecordValue | undefined,
): WorkbookCellValue {
  if (value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Так" : "Ні";
  if (Array.isArray(value)) {
    if (value.every(isAttachment)) return formatAttachments(value as ScanAttachment[]);
    if (relationTarget) {
      return (value as string[]).map((id) => relatedRecordLabel(db, relationTarget, id)).join(", ");
    }
    return value.join(", ");
  }
  return String(value);
}

function formatIds(value: unknown, resolve: (id: string) => string | undefined): string {
  if (!Array.isArray(value)) return "";
  return value.map((id) => resolve(String(id)) ?? String(id)).join(", ");
}

function formatAttachments(scans: ScanAttachment[]): WorkbookCellValue {
  if (!scans.length) return "";
  if (scans.length === 1) {
    const scan = scans[0];
    const link = attachmentUrl(scan);
    return link ? { text: scan.name, url: link } : scan.name;
  }
  return scans.map((scan) => {
    const link = attachmentUrl(scan);
    return link ? `${scan.name}: ${link}` : scan.name;
  }).join("\n");
}

function attachmentUrl(scan: ScanAttachment): string {
  if (isWebUrl(scan.webViewLink)) return scan.webViewLink;
  if (isWebUrl(scan.storagePath)) return scan.storagePath;
  return "";
}

function isAttachment(value: unknown): value is ScanAttachment {
  return Boolean(
    value
    && typeof value === "object"
    && "name" in value
    && "storagePath" in value,
  );
}

function personName(person: Person | undefined): string | undefined {
  if (!person) return undefined;
  return person.fullName
    || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")
    || undefined;
}

function collectionSheetName(collection: CollectionKey): string {
  return {
    researches: "Дослідження",
    documents: "Документи",
    yearMatrix: "Матриця років",
    tasks: "Завдання",
    findings: "Знахідки",
    hypotheses: "Гіпотези",
    archiveRequests: "Запити в архів",
    persons: "Особи",
  }[collection];
}

function formatDateTime(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("uk-UA", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);
}

function exportFileName(projectName: string, suffix: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${safeFilePart(projectName)}-${safeFilePart(suffix)}-${date}.xlsx`;
}

function safeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "Трекер-Роду";
}

function downloadWorkbook(fileName: string, inputSheets: WorkbookSheet[]): void {
  const sheets = uniqueSheetNames(inputSheets);
  const files = workbookFiles(sheets);
  const blob = new Blob([createZip(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function uniqueSheetNames(sheets: WorkbookSheet[]): WorkbookSheet[] {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const base = safeSheetName(sheet.name) || `Аркуш ${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLocaleLowerCase("uk"))) {
      const addition = ` ${suffix}`;
      name = `${base.slice(0, 31 - addition.length)}${addition}`;
      suffix += 1;
    }
    used.add(name.toLocaleLowerCase("uk"));
    return { ...sheet, name };
  });
}

function safeSheetName(value: string): string {
  return value.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31);
}

function workbookFiles(sheets: WorkbookSheet[]): Array<{ name: string; data: Uint8Array }> {
  const text = (value: string) => new TextEncoder().encode(value);
  const files = [
    { name: "[Content_Types].xml", data: text(contentTypesXml(sheets.length)) },
    { name: "_rels/.rels", data: text(rootRelationshipsXml()) },
    { name: "docProps/app.xml", data: text(appPropertiesXml(sheets)) },
    { name: "docProps/core.xml", data: text(corePropertiesXml()) },
    { name: "xl/workbook.xml", data: text(workbookXml(sheets)) },
    { name: "xl/_rels/workbook.xml.rels", data: text(workbookRelationshipsXml(sheets.length)) },
    { name: "xl/styles.xml", data: text(stylesXml()) },
  ];
  sheets.forEach((sheet, index) => {
    const worksheet = worksheetParts(sheet);
    files.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: text(worksheet.xml),
    });
    if (worksheet.relationships) {
      files.push({
        name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`,
        data: text(worksheet.relationships),
      });
    }
  });
  return files;
}

function contentTypesXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  return xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${sheets}
</Types>`);
}

function rootRelationshipsXml(): string {
  return xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
}

function workbookXml(sheets: WorkbookSheet[]): string {
  return xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView/></bookViews>
  <sheets>${sheets.map((sheet, index) =>
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"${sheet.hidden ? ' state="hidden"' : ""}/>`
  ).join("")}</sheets>
</workbook>`);
}

function workbookRelationshipsXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");
  return xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
}

function stylesXml(): string {
  return xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font>
    <font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Aptos"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF154D43"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border/>
    <border><left style="thin"><color rgb="FFD9DED9"/></left><right style="thin"><color rgb="FFD9DED9"/></right><top style="thin"><color rgb="FFD9DED9"/></top><bottom style="thin"><color rgb="FFD9DED9"/></bottom></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);
}

function worksheetParts(sheet: WorkbookSheet): { xml: string; relationships: string } {
  const columns = sheet.columns.length ? sheet.columns : [{ key: "empty", label: "Записи" }];
  const header = `<row r="1" ht="28" customHeight="1">${columns.map((column, index) =>
    inlineCell(cellReference(index, 1), column.label, 1)
  ).join("")}</row>`;
  const hyperlinks: Array<{ reference: string; url: string; text: string }> = [];
  const rows = sheet.records.map((record, rowIndex) => {
    const rowNumber = rowIndex + 2;
    return `<row r="${rowNumber}">${columns.map((column, columnIndex) => {
      const value = column.value ? column.value(record) : record[column.key];
      const reference = cellReference(columnIndex, rowNumber);
      const hyperlink = hyperlinkValue(value);
      if (hyperlink) {
        hyperlinks.push({ reference, ...hyperlink });
        return inlineCell(reference, hyperlink.text, 3);
      }
      return dataCell(reference, value);
    }).join("")}</row>`;
  }).join("");
  const lastRow = Math.max(1, sheet.records.length + 1);
  const lastColumn = columnName(columns.length - 1);
  const widths = columns.map((column, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${column.width ?? estimateColumnWidth(column.label)}" customWidth="1"/>`
  ).join("");
  const hyperlinkXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((link, index) =>
        `<hyperlink ref="${link.reference}" r:id="rId${index + 1}" display="${escapeXml(link.text)}"/>`
      ).join("")}</hyperlinks>`
    : "";
  const relationships = hyperlinks.length
    ? xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${hyperlinks.map((link, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(link.url)}" TargetMode="External"/>`
  ).join("")}
</Relationships>`)
    : "";
  return {
    xml: xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${widths}</cols>
  <sheetData>${header}${rows}</sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
  ${hyperlinkXml}
</worksheet>`),
    relationships,
  };
}

function dataCell(reference: string, value: WorkbookCellValue | unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}" s="2"><v>${value}</v></c>`;
  }
  return inlineCell(reference, String(value ?? ""), 2);
}

function hyperlinkValue(value: unknown): HyperlinkCell | null {
  if (isHyperlinkCell(value) && isWebUrl(value.url)) return value;
  if (typeof value === "string" && isWebUrl(value)) {
    return { text: value, url: value };
  }
  return null;
}

function isHyperlinkCell(value: unknown): value is HyperlinkCell {
  return Boolean(
    value
    && typeof value === "object"
    && "text" in value
    && "url" in value,
  );
}

function isWebUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function inlineCell(reference: string, value: string, style: number): string {
  const safe = neutralizeSpreadsheetValue(value);
  const preserved = /^\s|\s$|\n/.test(safe) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" t="inlineStr" s="${style}"><is><t${preserved}>${escapeXml(safe)}</t></is></c>`;
}

function cellReference(columnIndex: number, row: number): string {
  return `${columnName(columnIndex)}${row}`;
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function estimateColumnWidth(label: string): number {
  return Math.min(42, Math.max(14, label.length + 4));
}

function appPropertiesXml(sheets: WorkbookSheet[]): string {
  return xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Трекер Роду</Application>
  <TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((sheet) =>
    `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`
  ).join("")}</vt:vector></TitlesOfParts>
</Properties>`);
}

function corePropertiesXml(): string {
  const now = new Date().toISOString();
  return xml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Трекер Роду</dc:creator>
  <cp:lastModifiedBy>Трекер Роду</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`);
}

function xml(value: string): string {
  return value.replace(/>\s+</g, "><").trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = crc32(file.data);
    const local = new Uint8Array(30 + name.length + file.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(file.data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return concatenate([...localParts, ...centralParts, end]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
