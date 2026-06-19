import { useMemo, useRef, useState } from "react";
import type { AppEntity, CollectionKey, FindingParticipant } from "../types";
import type { EntityConfig, FieldConfig } from "../pages/entityConfigs";
import { analyzeTableImportWithAi, type AiSourceRow } from "../services/aiTableImport";
import { nowIso } from "../utils/dateHelpers";
import { createId } from "../utils/id";
import {
  isSupportedTableFileName,
  parseTableText,
  unsupportedTableFormatMessage,
  type ParsedTable,
} from "../utils/tableImport";

interface AiTableImportProps {
  config: EntityConfig;
  projectId?: string;
  onImport: (records: AppEntity[]) => void;
}

const AI_IMPORT_BATCH_SIZE = 10;

type ImportBatchPhase = "idle" | "analyzing" | "review" | "complete" | "error";

export function AiTableImport({ config, projectId, onImport }: AiTableImportProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [rowWarnings, setRowWarnings] = useState<Record<number, string[]>>({});
  const [records, setRecords] = useState<AppEntity[]>([]);
  const [confirmedRecords, setConfirmedRecords] = useState<AppEntity[]>([]);
  const [batchIndex, setBatchIndex] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [currentBatchRows, setCurrentBatchRows] = useState<AiSourceRow[]>([]);
  const [phase, setPhase] = useState<ImportBatchPhase>("idle");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parsedTable = useMemo<ParsedTable>(() => parseTableText(text, fileName), [fileName, text]);
  const totalRows = parsedTable.rows.length;
  const confirmedRows = confirmedRecords.length;
  const reviewedRows = phase === "review" ? records.length : 0;
  const analyzedRows = Math.min(totalRows, confirmedRows + reviewedRows);
  const progressPercent = totalRows ? Math.round((analyzedRows / totalRows) * 100) : 0;

  const resetBatchImport = () => {
    setError("");
    setSummary("");
    setWarnings([]);
    setRowWarnings({});
    setRecords([]);
    setConfirmedRecords([]);
    setBatchIndex(0);
    setTotalBatches(0);
    setCurrentBatchRows([]);
    setPhase("idle");
  };

  const analyzeImportBatch = async (nextBatchIndex: number) => {
    const start = nextBatchIndex * AI_IMPORT_BATCH_SIZE;
    const batchRows = parsedTable.rows.slice(start, start + AI_IMPORT_BATCH_SIZE);
    if (!batchRows.length) return;

    setError("");
    setSummary("");
    setWarnings([]);
    setRowWarnings({});
    setRecords([]);
    setCurrentBatchRows(batchRows);
    setBatchIndex(nextBatchIndex);
    setPhase("analyzing");
    setBusy(true);

    try {
      const result = await analyzeTableImportWithAi({
        projectId,
        collection: config.collection,
        title: config.title,
        fields: config.fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          options: field.options,
          required: field.required,
        })),
        fileName,
        sourceHeaders: parsedTable.headers,
        rows: batchRows,
      });
      setSummary(result.summary || `Партію ${nextBatchIndex + 1} підготовлено до перевірки.`);
      setWarnings(result.warnings);
      setRowWarnings(Object.fromEntries(result.rows.map((row) => [row.sourceRowNumber, row.warnings])));
      setRecords(result.records.map((record) => buildEntity(config.collection, config.fields, record)));
      setPhase("review");
    } catch (analysisError) {
      setPhase("error");
      setError(analysisError instanceof Error ? analysisError.message : "Не вдалося проаналізувати партію таблиці.");
    } finally {
      setBusy(false);
    }
  };

  const startBatchAnalysis = async () => {
    resetBatchImport();
    if (!parsedTable.rows.length) {
      setError("Прикріпіть CSV/TSV/TXT або JSON-таблицю з заголовками колонок.");
      return;
    }
    setTotalBatches(Math.ceil(parsedTable.rows.length / AI_IMPORT_BATCH_SIZE));
    await analyzeImportBatch(0);
  };

  const confirmBatchAndContinue = async () => {
    if (!records.length) return;
    const nextConfirmedRecords = [...confirmedRecords, ...records];
    setConfirmedRecords(nextConfirmedRecords);
    setRecords([]);
    setRowWarnings({});
    setWarnings([]);
    setSummary("");

    const nextBatchIndex = batchIndex + 1;
    if (nextBatchIndex >= totalBatches) {
      setCurrentBatchRows([]);
      setPhase("complete");
      setSummary(`Підтверджено ${nextConfirmedRecords.length} записів. Можна завантажити їх на сайт.`);
      return;
    }
    await analyzeImportBatch(nextBatchIndex);
  };

  const importConfirmedRecords = () => {
    onImport(confirmedRecords.map(stripImportMetadata));
    setOpen(false);
    setText("");
    setFileName("");
    resetBatchImport();
  };

  if (!open) {
    return (
      <button type="button" className="button button-secondary ai-import-open-button" onClick={() => setOpen(true)}>
        📎 Імпорт даних ШІ
      </button>
    );
  }

  return (
    <div className="ai-import-panel">
      <div className="ai-import-heading">
        <div>
          <strong>Імпорт таблиці через ШІ</strong>
          <p>Прикріпіть файл CSV, TSV, TXT або JSON. ШІ зіставить колонки з полями розділу «{config.title}».</p>
        </div>
        <button type="button" className="button button-secondary" onClick={() => setOpen(false)}>Закрити</button>
      </div>
      <div className="ai-import-file-box">
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,text/plain,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setError("");
            setSummary("");
            setWarnings([]);
            setRowWarnings({});
            setRecords([]);
            setConfirmedRecords([]);
            setBatchIndex(0);
            setTotalBatches(0);
            setCurrentBatchRows([]);
            setPhase("idle");
            if (!isSupportedTableFileName(file.name)) {
              setText("");
              setFileName("");
              setError(unsupportedTableFormatMessage(file.name));
              return;
            }
            setFileName(file.name);
            void file.text().then(setText).catch(() => {
              setText("");
              setFileName("");
              setError("Не вдалося прочитати файл таблиці.");
            });
          }}
        />
        <button
          type="button"
          className="button button-primary ai-import-attach-button"
          onClick={() => fileInputRef.current?.click()}
        >
          📎 Прикріпити таблицю
        </button>
        <div>
          <strong>{fileName || "Файл ще не вибрано"}</strong>
          <span>{parsedTable.rows.length ? `Розпізнано рядків: ${parsedTable.rows.length}` : "Підтримуються CSV, TSV, TXT або JSON з заголовками колонок."}</span>
        </div>
      </div>
      <div className="ai-import-actions">
        <button type="button" className="button button-secondary" onClick={() => { setText(""); setFileName(""); resetBatchImport(); }}>
          Очистити
        </button>
        <button type="button" className="button button-primary" onClick={() => void startBatchAnalysis()} disabled={busy || !text.trim()}>
          {busy ? "Аналіз…" : "Проаналізувати"}
        </button>
      </div>
      {totalBatches ? (
        <BatchProgress
          batchIndex={batchIndex}
          totalBatches={totalBatches}
          totalRows={totalRows}
          confirmedRows={confirmedRows}
          analyzedRows={analyzedRows}
          progressPercent={progressPercent}
          batchRows={currentBatchRows.length}
          phase={phase}
        />
      ) : null}
      {error ? <div className="form-error">{error}</div> : null}
      {phase === "error" && currentBatchRows.length ? (
        <div className="ai-import-actions">
          <button type="button" className="button button-secondary" onClick={() => void analyzeImportBatch(batchIndex)} disabled={busy}>
            Повторити поточну партію
          </button>
        </div>
      ) : null}
      {summary ? <p className="ai-import-summary">{summary}</p> : null}
      {[...parsedTable.warnings, ...warnings].length ? <ul className="ai-import-warnings">{[...parsedTable.warnings, ...warnings].map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
      {records.length ? (
        <div className="ai-import-preview">
          <strong>Перевірте партію {batchIndex + 1}: {records.length} записів</strong>
          <EditableImportPreview
            fields={config.fields}
            records={records}
            rowWarnings={rowWarnings}
            onChange={setRecords}
          />
          <button type="button" className="button button-primary" onClick={() => void confirmBatchAndContinue()} disabled={busy}>
            {batchIndex + 1 >= totalBatches ? "Підтвердити останню партію" : "Підтвердити партію та продовжити"}
          </button>
        </div>
      ) : null}
      {phase === "complete" && confirmedRecords.length ? (
        <div className="ai-import-preview">
          <strong>Усі партії підтверджено: {confirmedRecords.length}</strong>
          <button type="button" className="button button-primary" onClick={importConfirmedRecords}>
            Завантажити підтверджені записи на сайт
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BatchProgress({
  batchIndex,
  totalBatches,
  totalRows,
  confirmedRows,
  analyzedRows,
  progressPercent,
  batchRows,
  phase,
}: {
  batchIndex: number;
  totalBatches: number;
  totalRows: number;
  confirmedRows: number;
  analyzedRows: number;
  progressPercent: number;
  batchRows: number;
  phase: ImportBatchPhase;
}) {
  const statusText = {
    idle: "Очікує запуску",
    analyzing: "Gemini аналізує поточну партію",
    review: "Партія готова до перевірки",
    complete: "Усі партії підтверджено",
    error: "Потрібна повторна спроба",
  }[phase];

  return (
    <div className="ai-import-progress" role="status" aria-live="polite">
      <div className="ai-import-progress-heading">
        <strong>Партія {Math.min(batchIndex + 1, totalBatches)} з {totalBatches}</strong>
        <span>{statusText}</span>
      </div>
      <div className="ai-import-progress-bar" aria-label={`Прогрес ${progressPercent}%`}>
        <span style={{ width: `${progressPercent}%` }} />
      </div>
      <div className="ai-import-progress-meta">
        <span>Опрацьовано: {analyzedRows} з {totalRows}</span>
        <span>Підтверджено: {confirmedRows}</span>
        <span>У поточній партії: {batchRows || "—"}</span>
      </div>
    </div>
  );
}

function EditableImportPreview({
  fields,
  records,
  rowWarnings,
  onChange,
}: {
  fields: FieldConfig[];
  records: AppEntity[];
  rowWarnings: Record<number, string[]>;
  onChange: (records: AppEntity[]) => void;
}) {
  const visibleFields = fields.filter((field) => !["scans", "documents", "findings", "persons"].includes(field.type ?? ""));
  return (
    <div className="ai-import-preview-table-wrap">
      <table className="ai-import-preview-table">
        <thead>
          <tr>
            <th>#</th>
            {visibleFields.map((field) => <th key={field.key}>{field.label}</th>)}
            <th>Попередження</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record, recordIndex) => {
            const row = record as unknown as Record<string, unknown>;
            return (
              <tr key={String(row.id ?? recordIndex)}>
                <td>{recordIndex + 1}</td>
                {visibleFields.map((field) => (
                  <td key={field.key}>
                    <input
                      value={displayEditableValue(row[field.key])}
                      onChange={(event) => {
                        const nextRecords = records.map((item, index) => index === recordIndex
                          ? ({
                              ...(item as unknown as Record<string, unknown>),
                              [field.key]: coerceEditableValue(field, event.target.value),
                            } as unknown as AppEntity)
                          : item);
                        onChange(nextRecords);
                      }}
                    />
                  </td>
                ))}
                <td>{(rowWarnings[Number(row.__sourceRowNumber)] ?? []).join("; ") || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function displayEditableValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("; ");
  return value == null ? "" : String(value);
}

function coerceEditableValue(field: FieldConfig, value: string): unknown {
  if (field.type === "checkbox") return value === "true" || value === "так" || value === "1";
  if (field.type === "participants") {
    return value.split(";").map((name) => name.trim()).filter(Boolean).map((name) => ({
      id: createId(),
      role: "основна особа",
      name,
      notes: "",
    }));
  }
  return value;
}

function stripImportMetadata(record: AppEntity): AppEntity {
  const cleaned = { ...(record as unknown as Record<string, unknown>) };
  delete cleaned.__sourceRowNumber;
  return cleaned as unknown as AppEntity;
}

function buildEntity(collection: CollectionKey, fields: FieldConfig[], source: Record<string, unknown>): AppEntity {
  const timestamp = nowIso();
  const entity: Record<string, unknown> = {
    id: createId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    customFields: {},
  };
  for (const field of fields) entity[field.key] = normalizeFieldValue(field, source[field.key]);
  entity.__sourceRowNumber = source.__sourceRowNumber;
  const contaminated = findModelCommentary(entity);
  if (contaminated) {
    throw new Error(`ШІ повернув службовий текст у полі "${contaminated}". Повторіть аналіз таблиці.`);
  }
  if (collection === "findings") {
    const participants = Array.isArray(entity.participants) ? entity.participants as FindingParticipant[] : [];
    entity.people = participants.map((participant) => participant.name).filter(Boolean).join(", ");
  }
  if (collection === "persons") {
    const fullName = String(entity.fullName ?? "").trim();
    const nameParts = [entity.surname, entity.givenName, entity.patronymic]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    if (!fullName && nameParts.length) entity.fullName = nameParts.join(" ");
    if (!String(entity.gender ?? "").trim()) entity.gender = "невідомо";
    if (!String(entity.status ?? "").trim()) entity.status = "гіпотетична";
    entity.birthScans = [];
    entity.marriageScans = [];
    entity.deathScans = [];
    entity.mentionScans = [];
  }
  return entity as unknown as AppEntity;
}

function findModelCommentary(value: unknown, fieldPath = ""): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (/\b(wait,\s*i\s*must|valid json|final json|json generation|let'?s restart|i will just output|without comments)\b/i.test(text)) {
      return fieldPath || "data";
    }
    if (/(службов|коментар|пояснен|фінальн)\s+(текст|json|відповід)/i.test(text)) {
      return fieldPath || "data";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findModelCommentary(item, `${fieldPath}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const nested = findModelCommentary(nestedValue, fieldPath ? `${fieldPath}.${key}` : key);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeFieldValue(field: FieldConfig, value: unknown): unknown {
  if (field.type === "checkbox") {
    if (typeof value === "boolean") return value;
    const text = String(value ?? "").trim().toLowerCase();
    return ["true", "1", "yes", "так", "истина"].includes(text);
  }
  if (field.type === "scans") return [];
  if (["documents", "findings", "persons"].includes(field.type ?? "")) return Array.isArray(value) ? value.map(String) : [];
  if (field.type === "participants") {
    if (typeof value === "string") {
      return value.split(/[;,]/).map((name) => name.trim()).filter(Boolean).map((name) => ({
        id: createId(),
        role: "основна особа",
        name,
        notes: "",
      }));
    }
    const participants = Array.isArray(value) ? value.filter(isRecord) : [];
    return participants.map((participant) => ({
      id: createId(),
      role: String(participant.role ?? "основна особа"),
      name: String(participant.name ?? ""),
      notes: String(participant.notes ?? ""),
    }));
  }
  if (field.type === "select" && field.options?.length) {
    const text = String(value ?? "").trim();
    return field.options.includes(text) ? text : field.options[0];
  }
  return value == null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
