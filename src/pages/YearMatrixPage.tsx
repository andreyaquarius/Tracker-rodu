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

const matrixStatusStyles = [
  { status: "перевірено", label: "Перевірено", className: "is-verified" },
  { status: "знайдено", label: "Знайдено", className: "is-found" },
  { status: "не перевірено", label: "Не перевірено", className: "is-unchecked" },
  { status: "потрібно повторно перевірити", label: "Потрібно перевірити повторно", className: "is-recheck" },
  { status: "недоступно", label: "Недоступно", className: "is-unavailable" },
  { status: "втрачено", label: "Втрачено", className: "is-lost" },
  { status: "прогалина", label: "Прогалина", className: "is-gap" },
] as const;

const statusPriority = [
  "потрібно повторно перевірити",
  "не перевірено",
  "прогалина",
  "недоступно",
  "втрачено",
  "знайдено",
  "перевірено",
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
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  onOpenRelated: (page: PageKey, entityId: string) => void;
  onSave: (entity: AppEntity) => void;
  onSaveRange?: (records: YearMatrixRecord[]) => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
  projectName?: string;
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
  onDeleteCustomField,
  onOpenRelated,
  onSave,
  onSaveRange,
  onDelete,
  readOnly = false,
  projectName = "Трекер Роду",
}: Props) {
  const currentYear = new Date().getFullYear();
  const [from, setFrom] = useState("1840");
  const [to, setTo] = useState("1860");
  const [documentType, setDocumentType] = useState("народження");
  const [rangePlace, setRangePlace] = useState("");
  const [researchId, setResearchId] = useState("");
  const [showGaps, setShowGaps] = useState(false);
  const [visualPlace, setVisualPlace] = useState("");
  const [visualDocumentType, setVisualDocumentType] = useState("");
  const [showVisualization, setShowVisualization] = useState(false);
  const [visualizationError, setVisualizationError] = useState("");
  const placeOptions = useMemo(
    () => uniqueValues(items.map((item) => item.place)),
    [items],
  );
  const documentTypeOptions = useMemo(
    () => uniqueValues(items.map((item) => item.documentType)),
    [items],
  );
  const visualization = useMemo(() => {
    if (!showVisualization || !visualPlace || !visualDocumentType) return null;
    const matching = items.filter(
      (item) =>
        item.place.trim() === visualPlace &&
        item.documentType.trim() === visualDocumentType &&
        Number.isInteger(Number(item.year)),
    );
    if (!matching.length) return { tiles: [], stats: [] };
    const years = matching.map((item) => Number(item.year));
    const start = Math.min(...years);
    const end = Math.max(...years);
    if (end - start > 500) return { tiles: [], stats: [], tooWide: true };
    const byYear = new Map<number, YearMatrixRecord[]>();
    for (const item of matching) {
      const year = Number(item.year);
      byYear.set(year, [...(byYear.get(year) ?? []), item]);
    }
    const tiles = Array.from({ length: end - start + 1 }, (_, index) => {
      const year = start + index;
      const records = byYear.get(year) ?? [];
      const status = records.length ? combinedYearStatus(records) : "прогалина";
      return { year, status, count: records.length };
    });
    const stats = matrixStatusStyles
      .map((meta) => {
        const count = tiles.filter((tile) => tile.status === meta.status).length;
        return {
          ...meta,
          count,
          percent: tiles.length ? Math.round((count / tiles.length) * 100) : 0,
        };
      })
      .filter((item) => item.count > 0);
    return { tiles, stats, start, end };
  }, [items, showVisualization, visualDocumentType, visualPlace]);
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
        .filter(
          (item) =>
            item.researchId === researchId &&
            item.documentType === documentType &&
            item.place.trim() === rangePlace.trim(),
        )
        .map((item) => item.year),
    );
    const records: YearMatrixRecord[] = [];
    for (let year = start; year <= end; year += 1) {
      if (existing.has(String(year))) continue;
      const timestamp = nowIso();
      records.push({
        id: createId(),
        researchId,
        documentId: "",
        year: String(year),
        place: rangePlace.trim(),
        documentType,
        status: "не перевірено",
        notes: "",
        customFields: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    if (!records.length) {
      window.alert("Усі роки цього діапазону вже додані для вибраного населеного пункту і типу документа.");
      return;
    }
    if (onSaveRange) onSaveRange(records);
    else records.forEach((record) => onSave(record));
  };

  const buildVisualization = () => {
    if (!visualPlace || !visualDocumentType) {
      setVisualizationError("Оберіть населений пункт і тип документа.");
      setShowVisualization(false);
      return;
    }
    setVisualizationError("");
    setShowVisualization(true);
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
          <label><span>Населений пункт</span><input value={rangePlace} onChange={(event) => setRangePlace(event.target.value)} placeholder="Наприклад: Трубіївка" /></label>
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
      <section className="panel matrix-visualization-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Візуальна матриця</span>
            <h2>Стан опрацювання років</h2>
            <p>Оберіть населений пункт і тип документа, щоб побудувати кольорову матрицю років.</p>
          </div>
        </div>
        <div className="matrix-visualization-controls">
          <label>
            <span>Населений пункт</span>
            <select
              value={visualPlace}
              onChange={(event) => {
                setVisualPlace(event.target.value);
                setVisualizationError("");
                setShowVisualization(false);
              }}
            >
              <option value="">Оберіть населений пункт</option>
              {placeOptions.map((place) => <option key={place} value={place}>{place}</option>)}
            </select>
          </label>
          <label>
            <span>Тип документа</span>
            <select
              value={visualDocumentType}
              onChange={(event) => {
                setVisualDocumentType(event.target.value);
                setVisualizationError("");
                setShowVisualization(false);
              }}
            >
              <option value="">Оберіть тип документа</option>
              {documentTypeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <button className="button button-primary" onClick={buildVisualization}>
            Сформувати матрицю
          </button>
        </div>
        {visualizationError ? <div className="form-error">{visualizationError}</div> : null}
        {showVisualization && visualization?.tooWide ? (
          <div className="empty-inline">Діапазон перевищує 500 років. Уточніть записи для вибраної комбінації.</div>
        ) : null}
        {showVisualization && visualization && !visualization.tooWide && !visualization.tiles.length ? (
          <div className="empty-inline">Для вибраного населеного пункту й типу документа записів немає.</div>
        ) : null}
        {showVisualization && visualization && visualization.tiles.length ? (
          <>
            <div className="matrix-statistics">
              {visualization.stats.map((item) => (
                <article key={item.status}>
                  <span className={`matrix-status-dot ${item.className}`} />
                  <div>
                    <strong>{item.percent}%</strong>
                    <small>{item.label} · {item.count}</small>
                  </div>
                </article>
              ))}
            </div>
            <div className="matrix-visualization-layout">
              <div>
                <div className="matrix-visualization-caption">
                  <strong>{visualPlace}</strong>
                  <span>{visualDocumentType} · {visualization.start}–{visualization.end}</span>
                </div>
                <div className="year-tile-grid">
                  {visualization.tiles.map((tile) => {
                    const meta = matrixStatusStyles.find((item) => item.status === tile.status)
                      ?? matrixStatusStyles[2];
                    return (
                      <article
                        key={tile.year}
                        className={`year-tile ${meta.className}`}
                        title={`${tile.year}: ${meta.label}${tile.count ? ` (${tile.count} записів)` : ""}`}
                      >
                        <strong>{tile.year}</strong>
                        <span>{meta.label}</span>
                      </article>
                    );
                  })}
                </div>
              </div>
              <aside className="matrix-legend" aria-label="Позначення кольорів">
                <h3>Позначення</h3>
                {matrixStatusStyles.map((item) => (
                  <div key={item.status}>
                    <span className={`matrix-status-dot ${item.className}`} />
                    <span>{item.label}</span>
                  </div>
                ))}
              </aside>
            </div>
          </>
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
        onDeleteCustomField={onDeleteCustomField}
        initialSearch={initialSearch}
        onOpenRelated={onOpenRelated}
        onSave={onSave}
        onDelete={onDelete}
        readOnly={readOnly}
        projectName={projectName}
      />
    </>
  );
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "uk"));
}

function combinedYearStatus(records: YearMatrixRecord[]): string {
  const statusesForYear = new Set(records.map((record) => record.status.trim()));
  return statusPriority.find((status) => statusesForYear.has(status))
    ?? records[0]?.status.trim()
    ?? "не перевірено";
}
