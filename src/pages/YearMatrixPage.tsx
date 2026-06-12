import { useMemo, useState } from "react";
import type {
  AppDatabase,
  AppEntity,
  CustomFieldDefinition,
  DocumentRecord,
  Finding,
  Research,
  YearMatrixRecord,
} from "../types";
import { analyzeYearGaps } from "../utils/yearGapAnalyzer";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import { CrudPage } from "./CrudPage";
import type { EntityConfig } from "./entityConfigs";
import type { PageKey } from "../components/Sidebar";

const statuses = [
  "знайдено",
  "перевірено",
  "не перевірено",
  "прогалина",
  "втрачено",
  "недоступно",
  "потрібно повторно перевірити",
];

const config: EntityConfig = {
  collection: "yearMatrix",
  title: "Матриця років",
  singular: "рік",
  description: "Карта перевірених і пропущених років.",
  emptyText: "Матриця порожня. Додайте рік або цілий діапазон.",
  searchPlaceholder: "Пошук за роком, місцем або типом документа…",
  statusKey: "status",
  statusOptions: statuses,
  fields: [
    { key: "researchId", label: "Дослідження", type: "research" },
    { key: "year", label: "Рік", type: "number", required: true },
    { key: "place", label: "Населений пункт" },
    { key: "documentType", label: "Тип документа", type: "select", options: ["народження", "шлюби", "смерті", "сповідки", "ревізії", "інвентарі", "інше"] },
    { key: "status", label: "Статус", type: "select", options: statuses },
    { key: "documentId", label: "Пов’язаний документ", type: "document", wide: true },
    { key: "notes", label: "Примітка", type: "textarea", wide: true },
  ],
  columns: [
    { key: "year", label: "Рік" },
    { key: "place", label: "Населений пункт" },
    { key: "documentType", label: "Тип документа" },
    { key: "documentId", label: "Пов’язаний документ" },
    { key: "status", label: "Статус" },
  ],
};

interface Props {
  db: AppDatabase;
  items: YearMatrixRecord[];
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  initialSearch?: string;
  customFieldDefinitions?: CustomFieldDefinition[];
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onOpenRelated: (page: PageKey, entityId: string) => void;
  onSave: (entity: AppEntity) => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
}

export function YearMatrixPage({
  db,
  items,
  researches,
  documents,
  findings,
  initialSearch = "",
  customFieldDefinitions = [],
  onAddCustomField,
  onOpenRelated,
  onSave,
  onDelete,
  readOnly = false,
}: Props) {
  const currentYear = new Date().getFullYear();
  const [from, setFrom] = useState("1840");
  const [to, setTo] = useState("1860");
  const [documentType, setDocumentType] = useState("народження");
  const [researchId, setResearchId] = useState("");
  const [showGaps, setShowGaps] = useState(false);
  const gaps = useMemo(
    () => analyzeYearGaps(
      items.filter((item) => !researchId || item.researchId === researchId),
      Math.max(1, Number(from) || currentYear),
      Math.min(9999, Number(to) || currentYear),
      documentType,
    ),
    [currentYear, documentType, from, items, researchId, to],
  );

  const addRange = () => {
    if (readOnly) return;
    const start = Number(from);
    const end = Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end - start > 500) {
      window.alert("Вкажіть коректний діапазон до 500 років.");
      return;
    }
    const existing = new Set(
      items
        .filter((item) => item.researchId === researchId && item.documentType === documentType)
        .map((item) => item.year),
    );
    for (let year = start; year <= end; year += 1) {
      if (existing.has(String(year))) continue;
      const timestamp = nowIso();
      onSave({
        id: createId(),
        researchId,
        documentId: "",
        year: String(year),
        place: "",
        documentType,
        status: "не перевірено",
        notes: "",
        customFields: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      } as YearMatrixRecord);
    }
  };

  return (
    <>
      <section className="panel matrix-tools">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Швидке заповнення</span>
            <h2>Діапазон та аналіз прогалин</h2>
          </div>
        </div>
        <div className="range-grid">
          <label><span>Дослідження</span><select value={researchId} onChange={(event) => setResearchId(event.target.value)}><option value="">Без прив’язки</option>{researches.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label><span>Рік від</span><input type="number" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label><span>Рік до</span><input type="number" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <label><span>Тип документа</span><select value={documentType} onChange={(event) => setDocumentType(event.target.value)}>{["народження", "шлюби", "смерті", "сповідки", "ревізії", "інвентарі", "інше"].map((type) => <option key={type}>{type}</option>)}</select></label>
          {!readOnly ? (
            <button className="button button-secondary" onClick={addRange}>Додати діапазон</button>
          ) : null}
          <button className="button button-primary" onClick={() => setShowGaps(true)}>Знайти прогалини</button>
        </div>
        {showGaps ? (
          <div className="gap-result">
            <strong>{gaps.length ? `Знайдено ${gaps.length} проблемних років` : "Прогалин не знайдено"}</strong>
            <p>{gaps.length ? gaps.join(", ") : "Вибраний період має записи без проблемних статусів."}</p>
          </div>
        ) : null}
      </section>
      <CrudPage
        db={db}
        config={config}
        items={items}
        researches={researches}
        documents={documents}
        findings={findings}
        customFieldDefinitions={customFieldDefinitions}
        onAddCustomField={onAddCustomField}
        initialSearch={initialSearch}
        onOpenRelated={onOpenRelated}
        onSave={onSave}
        onDelete={onDelete}
        readOnly={readOnly}
      />
    </>
  );
}
