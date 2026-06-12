import { useEffect, useRef, useState } from "react";
import type { ScanAttachment } from "../types";
import {
  deleteScanFile,
  type AttachmentPolicy,
  downloadScan,
  MAX_ATTACHMENT_SIZE_MB,
  openScan,
  saveScan,
} from "../services/scanStorage";
import {
  authorizeGoogleDrive,
  isGoogleDriveAuthorized,
  prepareGoogleDriveAuthorization,
} from "../services/googleDriveStorage";

export function ScanAttachmentsEditor({
  title = "Файли та вкладення",
  description = `Зображення, аудіо, PDF, DJVU, XPS, документи Word, Excel, PowerPoint, OpenDocument, RTF, CSV, TXT, Markdown, XML, HTML або EPUB. Максимальний розмір одного файлу — ${MAX_ATTACHMENT_SIZE_MB} МБ. Файли зберігаються у папці активного проєкту на вашому Google Drive.`,
  accept = "image/*,audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.wma,.webm,.pdf,.djvu,.djv,.xps,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.csv,.ppt,.pptx,.odp,.txt,.md,.xml,.html,.htm,.epub",
  maxFiles,
  limitMessage,
  policy = "all",
  scans,
  onChange,
}: {
  title?: string;
  description?: string;
  accept?: string;
  maxFiles?: number;
  limitMessage?: string;
  policy?: AttachmentPolicy;
  scans: ScanAttachment[];
  onChange: (scans: ScanAttachment[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [driveReady, setDriveReady] = useState(false);
  const [driveConnected, setDriveConnected] = useState(isGoogleDriveAuthorized());
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void prepareGoogleDriveAuthorization()
      .then(() => {
        if (active) setDriveReady(true);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Не вдалося підготувати підключення Google Drive.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const connectDrive = async () => {
    setError("");
    try {
      await authorizeGoogleDrive();
      setDriveConnected(true);
    } catch (authorizationError) {
      setDriveConnected(false);
      setError(
        authorizationError instanceof Error
          ? authorizationError.message
          : "Не вдалося підключити Google Drive.",
      );
    }
  };

  const chooseFiles = () => {
    if (!isGoogleDriveAuthorized()) {
      setDriveConnected(false);
      setError("Термін доступу до Google Drive завершився. Підключіть диск повторно.");
      return;
    }
    fileInputRef.current?.click();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (maxFiles && scans.length + selected.length > maxFiles) {
      setError(
        limitMessage ||
        (maxFiles === 1
          ? "До однієї знахідки можна прикріпити лише один файл."
          : `Можна прикріпити не більше ${maxFiles} файлів.`),
      );
      return;
    }
    setUploading(true);
    setError("");
    const added: ScanAttachment[] = [];
    try {
      for (const file of selected) {
        added.push(await saveScan(file, policy));
      }
      onChange([...scans, ...added]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Не вдалося додати файл.");
      if (added.length) onChange([...scans, ...added]);
    } finally {
      setUploading(false);
    }
  };
  const limitReached = Boolean(maxFiles && scans.length >= maxFiles);

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
        <button
          type="button"
          className={`button button-secondary scan-upload-button ${uploading || limitReached ? "disabled" : ""}`}
          disabled={uploading || limitReached || !driveReady}
          onClick={driveConnected ? chooseFiles : () => void connectDrive()}
        >
          {!driveReady
            ? "Підготовка Google Drive…"
            : !driveConnected
              ? "Підключити Google Drive"
              : uploading
                ? "Завантаження…"
                : limitReached
                  ? "Файл уже додано"
                  : maxFiles === 1
                    ? "+ Додати файл"
                    : "+ Додати файли"}
        </button>
        <input
          ref={fileInputRef}
          className="scan-file-input"
          type="file"
          accept={accept}
          multiple={!maxFiles || maxFiles > 1}
          disabled={uploading || limitReached}
          onChange={(event) => {
            void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
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
  return scan.storage === "google-drive" ? "Google Drive" : "";
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
