import { useMemo, useState } from "react";
import type { AppEntity, CollectionKey, FindingParticipant } from "../types";
import type { EntityConfig, FieldConfig } from "../pages/entityConfigs";
import { analyzeTableImportWithAi } from "../services/aiTableImport";
import { nowIso } from "../utils/dateHelpers";
import { createId } from "../utils/id";

interface AiTableImportProps {
  config: EntityConfig;
  projectId?: string;
  onImport: (records: AppEntity[]) => void;
}

export function AiTableImport({ config, projectId, onImport }: AiTableImportProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [records, setRecords] = useState<AppEntity[]>([]);

  const parsedRows = useMemo(() => parseTableText(text), [text]);

  const analyze = async () => {
    setError("");
    setSummary("");
    setWarnings([]);
    setRecords([]);
    if (!parsedRows.length) {
      setError("Вставте CSV/TSV або JSON-таблицю з заголовками колонок.");
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
        rows: parsedRows,
      });
      setSummary(result.summary);
      setWarnings(result.warnings);
      setRecords(result.records.map((record) => buildEntity(config.collection, config.fields, record)));
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Не вдалося проаналізувати таблицю.");
    } finally {
      setBusy(false);
    }
  };

  const importRecords = () => {
    onImport(records);
    setOpen(false);
    setText("");
    setRecords([]);
    setSummary("");
    setWarnings([]);
  };

  if (!open) {
    return (
      <button type="button" className="button button-ghost" onClick={() => setOpen(true)}>
        Імпорт ШІ
      </button>
    );
  }

  return (
    <div className="ai-import-panel">
      <div className="ai-import-heading">
        <div>
          <strong>Імпорт таблиці через ШІ</strong>
          <p>Вставте CSV/TSV або JSON. ШІ зіставить колонки з полями розділу «{config.title}».</p>
        </div>
        <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>Закрити</button>
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Наприклад: Назва,Архів,Фонд,Рік від,Рік до..."
        rows={8}
      />
      <div className="ai-import-actions">
        <span>{parsedRows.length ? `Розпізнано рядків: ${parsedRows.length}` : "Очікується таблиця з заголовками"}</span>
        <button type="button" className="button button-primary" onClick={() => void analyze()} disabled={busy}>
          {busy ? "Аналіз…" : "Проаналізувати"}
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      {summary ? <p className="ai-import-summary">{summary}</p> : null}
      {warnings.length ? <ul className="ai-import-warnings">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
      {records.length ? (
        <div className="ai-import-preview">
          <strong>Готово до імпорту: {records.length}</strong>
          <pre>{JSON.stringify(records.slice(0, 3), null, 2)}</pre>
          <button type="button" className="button button-primary" onClick={importRecords}>Завантажити записи на сайт</button>
        </div>
      ) : null}
    </div>
  );
}

function parseTableText(value: string): Record<string, unknown>[] {
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isRecord).map((row) => ({ ...row }));
  } catch {
    // Fall back to delimited text.
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const headers = splitDelimitedLine(lines[0], delimiter).map((header) => header.trim()).filter(Boolean);
  if (!headers.length) return [];
  return lines.slice(1).map((line) => {
    const cells = splitDelimitedLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? ""]));
  });
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
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
