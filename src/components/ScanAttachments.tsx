import { useState } from "react";
import type { ScanAttachment } from "../types";
import {
  deleteScanFile,
  downloadScan,
  openScan,
  saveScan,
} from "../services/scanStorage";

export function ScanAttachmentsEditor({
  title = "Файли та вкладення",
  description = "Зображення, аудіо, PDF, DJVU, XPS, документи Word, Excel, PowerPoint, OpenDocument, RTF, CSV, TXT, Markdown, XML, HTML або EPUB, до 25 МБ кожен. Файли зберігаються у захищеному сховищі застосунку.",
  scans,
  onChange,
}: {
  title?: string;
  description?: string;
  scans: ScanAttachment[];
  onChange: (scans: ScanAttachment[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    const added: ScanAttachment[] = [];
    try {
      for (const file of Array.from(files)) {
        added.push(await saveScan(file));
      }
      onChange([...scans, ...added]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Не вдалося додати файл.");
      if (added.length) onChange([...scans, ...added]);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (scan: ScanAttachment) => {
    if (!window.confirm(`Видалити файл «${scan.name}»?`)) return;
    setError("");
    try {
      await deleteScanFile(scan);
      onChange(scans.filter((item) => item.id !== scan.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не вдалося видалити файл.");
    }
  };

  return (
    <fieldset className="scan-picker field-wide">
      <div className="scan-picker-heading">
        <div>
          <legend>{title}</legend>
          <p>{description}</p>
        </div>
        <label className={`button button-secondary scan-upload-button ${uploading ? "disabled" : ""}`}>
          {uploading ? "Завантаження…" : "+ Додати файли"}
          <input
            type="file"
            accept="image/*,audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.wma,.webm,.pdf,.djvu,.djv,.xps,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.csv,.ppt,.pptx,.odp,.txt,.md,.xml,.html,.htm,.epub"
            multiple
            disabled={uploading}
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {scans.length ? (
        <div className="scan-list">
          {scans.map((scan) => (
            <ScanRow key={scan.id} scan={scan} onDelete={() => void remove(scan)} />
          ))}
        </div>
      ) : (
        <div className="scan-empty">Файлів поки немає.</div>
      )}
    </fieldset>
  );
}

export function ScanAttachmentsView({ scans }: { scans: ScanAttachment[] }) {
  if (!scans.length) return <div className="detail-text">Файлів немає.</div>;
  return (
    <div className="scan-list scan-list-details">
      {scans.map((scan) => <ScanRow key={scan.id} scan={scan} />)}
    </div>
  );
}

function ScanRow({
  scan,
  onDelete,
}: {
  scan: ScanAttachment;
  onDelete?: () => void;
}) {
  const [error, setError] = useState("");

  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не вдалося виконати дію.");
    }
  };

  return (
    <div className="scan-row">
      <span className="scan-file-icon">{attachmentIcon(scan)}</span>
      <div className="scan-file-info">
        <strong>{scan.name}</strong>
        <small>
          {formatFileSize(scan.size)} · {storageLabel(scan)}
        </small>
        {error ? <em>{error}</em> : null}
      </div>
      <div className="scan-actions">
        <button type="button" className="text-button" onClick={() => void run(() => openScan(scan))}>
          Відкрити
        </button>
        <button type="button" className="text-button" onClick={() => void run(() => downloadScan(scan))}>
          Завантажити
        </button>
        {onDelete ? (
          <button type="button" className="icon-button danger" title="Видалити файл" onClick={onDelete}>×</button>
        ) : null}
      </div>
    </div>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function storageLabel(scan: ScanAttachment): string {
  return scan.storage === "supabase" ? "Сховище проєкту" : "";
}

function attachmentIcon(scan: ScanAttachment): string {
  const extension = scan.name.split(".").pop()?.toLocaleUpperCase() ?? "";
  if (scan.mimeType.startsWith("audio/") || audioExtensions.has(extension)) return "AUD";
  if (scan.mimeType === "application/pdf" || extension === "PDF") return "PDF";
  if (["DJVU", "DJV"].includes(extension)) return "DJVU";
  if (scan.mimeType.startsWith("image/")) return "IMG";
  if (["XLS", "XLSX", "ODS", "CSV"].includes(extension)) return "XLS";
  if (["PPT", "PPTX", "ODP"].includes(extension)) return "PPT";
  if (["TXT", "MD", "RTF", "XML", "HTML", "HTM"].includes(extension)) return "TXT";
  if (extension === "EPUB") return "BOOK";
  return "DOC";
}

const audioExtensions = new Set([
  "MP3",
  "WAV",
  "M4A",
  "AAC",
  "OGG",
  "OPUS",
  "FLAC",
  "WMA",
  "WEBM",
]);
