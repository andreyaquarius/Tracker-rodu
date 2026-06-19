import { useMemo, useRef, useState } from "react";
import type { AppEntity, CollectionKey, FindingParticipant } from "../types";
import type { EntityConfig, FieldConfig } from "../pages/entityConfigs";
import { analyzeTableImportWithAi } from "../services/aiTableImport";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parsedTable = useMemo<ParsedTable>(() => parseTableText(text, fileName), [fileName, text]);

  const analyze = async () => {
    setError("");
    setSummary("");
    setWarnings([]);
    setRowWarnings({});
    setRecords([]);
    if (!parsedTable.rows.length) {
      setError("Прикріпіть CSV/TSV/TXT або JSON-таблицю з заголовками колонок.");
      return;
    }
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
        rows: parsedTable.rows,
      });
      setSummary(result.summary);
      setWarnings(result.warnings);
      setRowWarnings(Object.fromEntries(result.rows.map((row) => [row.sourceRowNumber, row.warnings])));
      setRecords(result.records.map((record) => buildEntity(config.collection, config.fields, record)));
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Не вдалося проаналізувати таблицю.");
    } finally {
      setBusy(false);
    }
  };

  const importRecords = () => {
    onImport(records.map(stripImportMetadata));
    setOpen(false);
    setText("");
    setFileName("");
    setRecords([]);
    setSummary("");
    setRowWarnings({});
    setWarnings([]);
  };

  if (!open) {
    return (
      <button type="button" className="button button-secondary ai-import-open-button" onClick={() => setOpen(true)}>
        📎 Прикріпити таблицю ШІ
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
        <button type="button" className="button button-secondary" onClick={() => { setText(""); setFileName(""); setRecords([]); setRowWarnings({}); setWarnings([]); setSummary(""); }}>
          Очистити
        </button>
        <button type="button" className="button button-primary" onClick={() => void analyze()} disabled={busy || !text.trim()}>
          {busy ? "Аналіз…" : "Проаналізувати"}
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      {summary ? <p className="ai-import-summary">{summary}</p> : null}
      {[...parsedTable.warnings, ...warnings].length ? <ul className="ai-import-warnings">{[...parsedTable.warnings, ...warnings].map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
      {records.length ? (
        <div className="ai-import-preview">
          <strong>Готово до імпорту: {records.length}</strong>
          <EditableImportPreview
            fields={config.fields}
            records={records}
            rowWarnings={rowWarnings}
            onChange={setRecords}
          />
          <button type="button" className="button button-primary" onClick={importRecords}>Завантажити записи на сайт</button>
        </div>
      ) : null}
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
  if (collection === "findings") {
    const participants = Array.isArray(entity.participants) ? entity.participants as FindingParticipant[] : [];
    entity.people = participants.map((participant) => participant.name).filter(Boolean).join(", ");
  }
  return entity as unknown as AppEntity;
}

function normalizeFieldValue(field: FieldConfig, value: unknown): unknown {
  if (field.type === "checkbox") return Boolean(value);
  if (field.type === "scans") return [];
  if (["documents", "findings", "persons"].includes(field.type ?? "")) return Array.isArray(value) ? value.map(String) : [];
  if (field.type === "participants") {
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
