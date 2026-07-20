import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import type { ScanAttachment } from "../types";
import {
  attachAttachmentReference,
  attachPickedGoogleDriveFiles,
  deleteScanFile,
  type DriveAttachmentPreview,
  type DriveAttachRange,
  type AttachmentPolicy,
  downloadScan,
  getScanBlob,
  inspectAttachmentReference,
  isGoogleWorkspaceDriveFile,
  MAX_ATTACHMENT_SIZE_MB,
  normalizeScanPreviewBlob,
  openScan,
  saveScan,
} from "../services/scanStorage";
import {
  authorizeGoogleDrive,
  isGoogleDriveAuthorized,
  prepareGoogleDriveAuthorization,
  prepareGoogleDrivePicker,
  pickGoogleDriveFiles,
} from "../services/googleDriveStorage";

type UploadProgressState = {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  loaded: number;
  total: number;
  percent: number;
};

export function ScanAttachmentsEditor({
  title = "Файли та вкладення",
  description = `Зображення, аудіо, PDF, DJVU, XPS, документи Word, Excel, PowerPoint, OpenDocument, RTF, CSV, TXT, Markdown, XML, HTML або EPUB. Максимальний розмір одного файлу — ${MAX_ATTACHMENT_SIZE_MB} МБ. Файли зберігаються у папці активного проєкту в хмарному сховищі.`,
  accept = "image/*,audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.wma,.webm,.pdf,.djvu,.djv,.xps,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.csv,.ppt,.pptx,.odp,.txt,.md,.xml,.html,.htm,.epub",
  maxFiles,
  limitMessage,
  policy = "all",
  driveFolderPath,
  uploadBlockedMessage,
  scans,
  onChange,
  onPreview,
}: {
  title?: string;
  description?: string;
  accept?: string;
  maxFiles?: number;
  limitMessage?: string;
  policy?: AttachmentPolicy;
  driveFolderPath?: string[];
  uploadBlockedMessage?: string;
  scans: ScanAttachment[];
  onChange: (scans: ScanAttachment[]) => void;
  onPreview?: (scan: ScanAttachment, scans?: ScanAttachment[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [driveReady, setDriveReady] = useState(false);
  const [pickerReady, setPickerReady] = useState(false);
  const [driveConnected, setDriveConnected] = useState(isGoogleDriveAuthorized());
  const [error, setError] = useState("");
  const [driveAttachOpen, setDriveAttachOpen] = useState(false);
  const [attachingDriveFile, setAttachingDriveFile] = useState(false);
  const [showPages, setShowPages] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);
  const [replacementScan, setReplacementScan] = useState<ScanAttachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);

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
            : "Не вдалося підготувати підключення хмарного сховища.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void prepareGoogleDrivePicker()
      .then(() => {
        if (active) setPickerReady(true);
      })
      .catch(() => {
        // The button retries loading. A Picker failure must not block local uploads.
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
          : "Не вдалося підключити хмарне сховище.",
      );
    }
  };

  const chooseFiles = () => {
    if (uploadBlockedMessage) {
      setError(uploadBlockedMessage);
      return;
    }
    if (!isGoogleDriveAuthorized()) {
      setDriveConnected(false);
      setError("Термін доступу до хмарного сховища завершився. Підключіть сховище повторно.");
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
    setUploadProgress(null);
    const added: ScanAttachment[] = [];
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const file = selected[index];
        setUploadProgress({
          fileName: file.name,
          fileIndex: index + 1,
          fileCount: selected.length,
          loaded: 0,
          total: file.size,
          percent: 0,
        });
        added.push(await saveScan(file, policy, {
          driveFolderPath,
          onUploadProgress: (progress) => setUploadProgress({
            fileName: progress.fileName,
            fileIndex: index + 1,
            fileCount: selected.length,
            loaded: progress.loaded,
            total: progress.total,
            percent: progress.percent,
          }),
        }));
      }
      onChange([...scans, ...added]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Не вдалося додати файл.");
      if (added.length) onChange([...scans, ...added]);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };
  const limitReached = Boolean(maxFiles && scans.length >= maxFiles);
  const previewableScans = scans.filter(isPreviewableAttachment);
  const groupedDocument = onPreview && previewableScans.length > 1;
  const visibleScans = groupedDocument && !showPages
    ? scans.filter((scan) => !previewableScans.includes(scan))
    : scans;

  const inspectDriveReference = (fileReference: string) =>
    inspectAttachmentReference(fileReference, policy);

  const attachFromDrive = async (fileReference: string, range: DriveAttachRange) => {
    setAttachingDriveFile(true);
    setError("");
    try {
      const attached = await attachAttachmentReference(fileReference, policy, range);
      if (maxFiles && scans.length + attached.length > maxFiles) {
        throw new Error(limitMessage || "Вибрано більше файлів, ніж дозволено для цього поля.");
      }
      onChange([...scans, ...attached]);
      setDriveAttachOpen(false);
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : "Не вдалося прикріпити джерело.");
      throw attachError;
    } finally {
      setAttachingDriveFile(false);
    }
  };

  const pickFromDrive = async () => {
    if (uploadBlockedMessage) {
      setError(uploadBlockedMessage);
      return;
    }
    setAttachingDriveFile(true);
    setError("");
    try {
      const remaining = maxFiles ? Math.max(0, maxFiles - scans.length) : undefined;
      const selected = await pickGoogleDriveFiles({
        multiselect: remaining === undefined || remaining > 1,
        maxItems: remaining,
        title: maxFiles === 1
          ? "Оберіть документ із Google Drive"
          : "Оберіть документи з Google Drive",
      });
      setPickerReady(true);
      setDriveConnected(true);
      if (!selected.length) return;

      const existingDriveIds = new Set(
        scans
          .filter((scan) => scan.storage === "google-drive")
          .map((scan) => scan.storagePath),
      );
      const unique = selected.filter((file, index) => (
        !existingDriveIds.has(file.id)
        && selected.findIndex((candidate) => candidate.id === file.id) === index
      ));
      if (!unique.length) {
        setError("Усі вибрані файли вже прикріплено.");
        return;
      }
      if (maxFiles && scans.length + unique.length > maxFiles) {
        throw new Error(limitMessage || "Вибрано більше файлів, ніж дозволено для цього поля.");
      }
      const attached = await attachPickedGoogleDriveFiles(unique, policy);
      onChange([...scans, ...attached]);
    } catch (pickError) {
      setError(pickError instanceof Error
        ? pickError.message
        : "Не вдалося вибрати файли з Google Drive.");
    } finally {
      setAttachingDriveFile(false);
    }
  };

  const remove = async (scan: ScanAttachment) => {
    if (!window.confirm(`Видалити файл «${scan.name}»?`)) return;
    setError("");
    try {
      await deleteScanFile(scan, {
        force: policy === "finding" && scan.deleteOnRemove !== false,
      });
      onChange(scans.filter((item) => item.id !== scan.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не вдалося видалити файл.");
    }
  };

  const saveExternalCopyToDrive = async (scan: ScanAttachment) => {
    if (uploadBlockedMessage) {
      setError(uploadBlockedMessage);
      return;
    }
    setUploading(true);
    setError("");
    try {
      const blob = normalizeScanPreviewBlob(scan, await getScanBlob(scan));
      const file = new File([blob], scan.name || "gedcom-photo", {
        type: blob.type || scan.mimeType || "application/octet-stream",
      });
      const uploaded = await saveScan(file, policy, { driveFolderPath });
      const replacement = uploadedReplacement(scan, uploaded, true);
      onChange(scans.map((item) => item.id === scan.id ? replacement : item));
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? `Не вдалося зберегти копію у Google Drive. ${copyError.message}`
          : "Не вдалося зберегти копію у Google Drive. Перевірте доступність зовнішнього посилання.",
      );
    } finally {
      setUploading(false);
    }
  };

  const chooseMissingLocalReplacement = (scan: ScanAttachment) => {
    if (uploadBlockedMessage) {
      setError(uploadBlockedMessage);
      return;
    }
    if (!driveReady) {
      setError("Дочекайтеся підготовки Google Drive і спробуйте ще раз.");
      return;
    }
    if (!isGoogleDriveAuthorized()) {
      setDriveConnected(false);
      setError("Спочатку підключіть Google Drive кнопкою над списком фотографій.");
      return;
    }
    setError("");
    setReplacementScan(scan);
    replacementInputRef.current?.click();
  };

  const replaceMissingLocalFile = async (file: File | undefined) => {
    const scan = replacementScan;
    setReplacementScan(null);
    if (!scan || !file) return;
    setUploading(true);
    setError("");
    try {
      const uploaded = await saveScan(file, policy, { driveFolderPath });
      const replacement = uploadedReplacement(scan, uploaded);
      onChange(scans.map((item) => item.id === scan.id ? replacement : item));
    } catch (replacementError) {
      setError(
        replacementError instanceof Error
          ? `Не вдалося зберегти вибране фото у Google Drive. ${replacementError.message}`
          : "Не вдалося зберегти вибране фото у Google Drive.",
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <fieldset className="scan-picker field-wide">
      <div className="scan-picker-heading">
        <div>
          <legend>{title}</legend>
          <p>{description}</p>
        </div>
        <div className="scan-picker-actions">
          <button
            type="button"
            className={`button button-secondary scan-upload-button ${uploading || limitReached ? "disabled" : ""}`}
            disabled={uploading || limitReached || !driveReady}
            onClick={driveConnected ? chooseFiles : () => void connectDrive()}
          >
            {!driveReady
              ? "Підготовка сховища…"
              : !driveConnected
                ? "Підключити сховище"
                : uploading
                  ? "Завантаження…"
                  : limitReached
                    ? "Файл уже додано"
                    : maxFiles === 1
                      ? "+ Додати файл"
                      : "+ Додати файли"}
          </button>
          <button
            type="button"
            className="button button-secondary scan-upload-button"
            disabled={attachingDriveFile || limitReached}
            onClick={() => void pickFromDrive()}
          >
            {attachingDriveFile
              ? "Відкриття Google Drive…"
              : pickerReady
                ? "Обрати з Google Drive"
                : "Підготовка Google Drive…"}
          </button>
          <button
            type="button"
            className="button button-secondary scan-upload-button"
            disabled={limitReached}
            onClick={() => setDriveAttachOpen(true)}
          >
            Зовнішнє посилання
          </button>
        </div>
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
        <input
          ref={replacementInputRef}
          className="scan-file-input"
          type="file"
          accept={accept}
          disabled={uploading}
          onChange={(event) => {
            void replaceMissingLocalFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {uploadProgress ? <ScanUploadProgress progress={uploadProgress} /> : null}
      {scans.length ? (
        <div className="scan-list">
          {groupedDocument ? (
            <ScanDocumentBundle
              scans={previewableScans}
              onPreview={() => onPreview?.(previewableScans[0], previewableScans)}
              showPages={showPages}
              onTogglePages={() => setShowPages((value) => !value)}
            />
          ) : null}
          {visibleScans.map((scan) => (
            <ScanRow
              key={scan.id}
              scan={scan}
              scanGroup={previewableScans.includes(scan) ? previewableScans : [scan]}
              onDelete={() => void remove(scan)}
              onPreview={onPreview}
              onSaveExternalCopy={
                policy === "person-photo"
                && scan.sourceKind === "gedcom"
                && scan.storage === "external-url"
                && scan.availability !== "missing-local"
                  ? () => void saveExternalCopyToDrive(scan)
                  : undefined
              }
              onReplaceMissingLocal={
                policy === "person-photo"
                && scan.sourceKind === "gedcom"
                && scan.availability === "missing-local"
                  ? () => chooseMissingLocalReplacement(scan)
                  : undefined
              }
            />
          ))}
        </div>
      ) : (
        <div className="scan-empty">Файлів поки немає.</div>
      )}
      {driveAttachOpen ? (
        <GoogleDriveAttachModal
          loading={attachingDriveFile}
          onInspect={inspectDriveReference}
          onClose={() => setDriveAttachOpen(false)}
          onAttach={attachFromDrive}
        />
      ) : null}
    </fieldset>
  );
}

function uploadedReplacement(
  scan: ScanAttachment,
  uploaded: ScanAttachment,
  preserveAvatarCrop = false,
): ScanAttachment {
  return {
    ...uploaded,
    id: scan.id,
    sourceKind: scan.sourceKind,
    sourceReference: scan.sourceReference || scan.storagePath,
    sourceExternalId: scan.sourceExternalId,
    sourceExpiresAt: scan.sourceExpiresAt,
    sourceDurability: scan.sourceDurability,
    availability: "available",
    ...(preserveAvatarCrop && scan.avatarCrop ? { avatarCrop: scan.avatarCrop } : {}),
  };
}

function ScanUploadProgress({ progress }: { progress: UploadProgressState }) {
  return (
    <div className="scan-upload-progress" role="status" aria-live="polite">
      <div>
        <strong>
          Завантаження {progress.fileIndex} з {progress.fileCount}: {progress.fileName}
        </strong>
        <span>
          {progress.percent}% · {formatFileSize(progress.loaded)} з {formatFileSize(progress.total)}
        </span>
      </div>
      <div className="scan-upload-progress-bar" aria-hidden="true">
        <span style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}

export function ScanAttachmentsView({
  scans,
  onPreview,
}: {
  scans: ScanAttachment[];
  onPreview?: (scan: ScanAttachment, scans?: ScanAttachment[]) => void;
}) {
  const [showPages, setShowPages] = useState(false);
  if (!scans.length) return <div className="detail-text">Файлів немає.</div>;
  const previewableScans = scans.filter(isPreviewableAttachment);
  const groupedDocument = onPreview && previewableScans.length > 1;
  const visibleScans = groupedDocument && !showPages
    ? scans.filter((scan) => !previewableScans.includes(scan))
    : scans;
  return (
    <div className="scan-list scan-list-details">
      {groupedDocument ? (
        <ScanDocumentBundle
          scans={previewableScans}
          onPreview={() => onPreview?.(previewableScans[0], previewableScans)}
          showPages={showPages}
          onTogglePages={() => setShowPages((value) => !value)}
        />
      ) : null}
      {visibleScans.map((scan) => (
        <ScanRow
          key={scan.id}
          scan={scan}
          scanGroup={previewableScans.includes(scan) ? previewableScans : [scan]}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}

function ScanDocumentBundle({
  scans,
  onPreview,
  showPages,
  onTogglePages,
}: {
  scans: ScanAttachment[];
  onPreview: () => void;
  showPages: boolean;
  onTogglePages: () => void;
}) {
  const totalSize = scans.reduce((sum, scan) => sum + scan.size, 0);
  return (
    <div className="scan-document-bundle">
      <span className="scan-file-icon">DOC</span>
      <div className="scan-file-info">
        <strong>Скан документа</strong>
        <small>{scans.length} стор. · {formatFileSize(totalSize)} · Хмарне сховище</small>
      </div>
      <div className="scan-actions">
        <button type="button" className="button button-secondary" onClick={onPreview}>
          Переглянути як документ
        </button>
        <button type="button" className="text-button" onClick={onTogglePages}>
          {showPages ? "Сховати сторінки" : "Показати сторінки"}
        </button>
      </div>
    </div>
  );
}

function GoogleDriveAttachModal({
  loading,
  onInspect,
  onClose,
  onAttach,
}: {
  loading: boolean;
  onInspect: (fileReference: string) => Promise<DriveAttachmentPreview>;
  onClose: () => void;
  onAttach: (fileReference: string, range: DriveAttachRange) => Promise<void>;
}) {
  const [fileReference, setFileReference] = useState("");
  const [preview, setPreview] = useState<DriveAttachmentPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [modalError, setModalError] = useState("");
  const [rangeStart, setRangeStart] = useState("1");
  const [rangeEnd, setRangeEnd] = useState("");

  const inspect = async () => {
    const reference = fileReference.trim();
    if (!reference) return;
    setChecking(true);
    setModalError("");
    try {
      const nextPreview = await onInspect(reference);
      setPreview(nextPreview);
      setRangeStart("1");
      setRangeEnd(String(nextPreview.totalFiles));
    } catch (error) {
      setPreview(null);
      setModalError(error instanceof Error ? error.message : "Не вдалося перевірити посилання.");
    } finally {
      setChecking(false);
    }
  };

  const attach = async () => {
    const reference = fileReference.trim();
    if (!reference) return;
    setModalError("");
    try {
      await onAttach(reference, preview?.kind === "folder"
        ? {
            start: Number(rangeStart || 1),
            end: Number(rangeEnd || preview.totalFiles),
          }
        : {});
    } catch (error) {
      setModalError(error instanceof Error ? error.message : "Не вдалося прикріпити джерело.");
    }
  };

  const sampleFiles = preview?.attachableFiles.slice(0, 5) ?? [];

  return createPortal(
    <div className="scan-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="drive-attach-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drive-attach-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="scan-preview-header">
          <div>
            <span className="eyebrow">Джерело</span>
            <h2 id="drive-attach-title">Прикріпити за посиланням</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Закрити">
            ×
          </button>
        </div>
        <div className="drive-attach-body">
          <label>
            <span>Посилання на зовнішній документ або сторінку джерела</span>
            <input
              value={fileReference}
              onChange={(event) => {
                setFileReference(event.target.value);
                setPreview(null);
                setModalError("");
              }}
              placeholder="https://uk.wikisource.org/wiki/... або https://archive.org/..."
              autoFocus
            />
          </label>
          <p className="form-help">
            Приватний файл Google Drive додавайте кнопкою «Обрати з Google Drive» — так Google
            надає застосунку доступ саме до вибраного файла.
          </p>
          <button
            type="button"
            className="button button-secondary"
            disabled={checking || loading || !fileReference.trim()}
            onClick={() => void inspect()}
          >
            {checking ? "Перевіряємо…" : "Перевірити"}
          </button>
          {modalError ? <div className="alert alert-error">{modalError}</div> : null}
          {preview ? (
            <div className="drive-attach-preview">
              <strong>
                {preview.kind === "folder"
                  ? `Папка: ${preview.name}`
                  : preview.source === "external-url"
                    ? `Джерело: ${preview.name}`
                    : `Файл: ${preview.name}`}
              </strong>
              <small>
                {preview.kind === "folder"
                  ? `Знайдено файлів: ${preview.totalFiles}`
                  : preview.source === "external-url"
                    ? "Зовнішнє посилання"
                  : formatFileSize(preview.attachableFiles[0]?.size ?? 0)}
              </small>
              {preview.kind === "folder" ? (
                <>
                  <div className="drive-range-grid">
                    <label>
                      <span>Від сторінки</span>
                      <input
                        type="number"
                        min="1"
                        max={preview.totalFiles}
                        value={rangeStart}
                        onChange={(event) => setRangeStart(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>До сторінки</span>
                      <input
                        type="number"
                        min="1"
                        max={preview.totalFiles}
                        value={rangeEnd}
                        onChange={(event) => setRangeEnd(event.target.value)}
                      />
                    </label>
                  </div>
                  <ul>
                    {sampleFiles.map((file) => (
                      <li key={`${file.name}-${file.size}`}>
                        <span>{file.name}</span>
                        <small>{formatFileSize(file.size)}</small>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="scan-preview-actions">
          <span />
          <button type="button" className="button button-ghost" onClick={onClose} disabled={loading}>
            Скасувати
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={loading || checking || !fileReference.trim()}
            onClick={() => void attach()}
          >
            {loading ? "Прикріплення…" : "Прикріпити"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ScanRow({
  scan,
  scanGroup,
  onDelete,
  onPreview,
  onSaveExternalCopy,
  onReplaceMissingLocal,
}: {
  scan: ScanAttachment;
  scanGroup?: ScanAttachment[];
  onDelete?: () => void;
  onPreview?: (scan: ScanAttachment, scans?: ScanAttachment[]) => void;
  onSaveExternalCopy?: () => void;
  onReplaceMissingLocal?: () => void;
}) {
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const unavailable = scan.availability === "missing-local";
  const googleWorkspaceFile = isGoogleWorkspaceDriveFile(scan.mimeType);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не вдалося виконати дію.");
    }
  };

  const closePreview = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  const previewScan = async () => {
    if (googleWorkspaceFile) {
      await run(() => openScan(scan));
      return;
    }
    if (onPreview) {
      onPreview(scan, scanGroup);
      return;
    }
    setError("");
    setPreviewLoading(true);
    try {
      const blob = await getScanBlob(scan);
      const kind = previewKind(scan, blob);
      if (!kind) {
        throw new Error("Попередній перегляд доступний для зображень, PDF і web-джерел.");
      }
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({
        kind,
        name: scan.name,
        url: URL.createObjectURL(blob),
      });
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Не вдалося відкрити попередній перегляд.");
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <>
      <div className="scan-row">
        <span className="scan-file-icon">{attachmentIcon(scan)}</span>
        <div className="scan-file-info">
          <strong>{scan.name}</strong>
          <small>
            {unavailable
              ? "Локальний файл GEDCOM недоступний"
              : scan.storage === "external-url"
              ? storageLabel(scan)
              : googleWorkspaceFile
                ? "Google Drive · файл Google Workspace"
              : `${formatFileSize(scan.size)} · ${storageLabel(scan)}`}
          </small>
          {unavailable && scan.statusMessage ? <em>{scan.statusMessage}</em> : null}
          {error ? <em>{error}</em> : null}
        </div>
        <div className="scan-actions">
          {!unavailable ? (
            <>
              <button type="button" className="text-button" onClick={() => void previewScan()}>
                {previewLoading
                  ? "Відкриття…"
                  : googleWorkspaceFile
                    ? "Відкрити у Google"
                    : "Переглянути"}
              </button>
              {!googleWorkspaceFile ? (
                <button type="button" className="text-button" onClick={() => void run(() => openScan(scan))}>
                  {scan.storage === "external-url" ? "Відкрити джерело" : "Google Drive"}
                </button>
              ) : null}
            </>
          ) : null}
          {!unavailable && scan.storage !== "external-url" && !googleWorkspaceFile ? (
            <button type="button" className="text-button" onClick={() => void run(() => downloadScan(scan))}>
              Завантажити
            </button>
          ) : null}
          {onSaveExternalCopy ? (
            <button type="button" className="text-button" onClick={onSaveExternalCopy}>
              Зберегти копію у Google Drive
            </button>
          ) : null}
          {onReplaceMissingLocal ? (
            <button type="button" className="text-button" onClick={onReplaceMissingLocal}>
              Вибрати локальний файл і зберегти у Google Drive
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              className="icon-button danger scan-delete-button"
              title="Видалити файл"
              aria-label={`Видалити файл ${scan.name}`}
              onClick={onDelete}
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
      {preview ? (
        <ScanPreviewModal
          preview={preview}
          onClose={closePreview}
          onDownload={() => void run(() => downloadScan(scan))}
        />
      ) : null}
    </>
  );
}

type ScanPreview = {
  kind: "image" | "pdf" | "web";
  name: string;
  url: string;
};

type ScanPreviewSize = { width: number; height: number };
type ScanPreviewPan = { x: number; y: number };

const MIN_SCAN_PREVIEW_WIDTH = 420;
const MIN_SCAN_PREVIEW_HEIGHT = 360;
const MIN_SCAN_PREVIEW_ZOOM = 0.4;
const MAX_SCAN_PREVIEW_ZOOM = 4;
const SCAN_PREVIEW_ZOOM_STEP = 0.01;

function ScanPreviewModal({
  preview,
  onClose,
  onDownload,
}: {
  preview: ScanPreview;
  onClose: () => void;
  onDownload: () => void;
}) {
  const panStartRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [previewSize, setPreviewSize] = useState<ScanPreviewSize | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState<ScanPreviewPan>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    setPreviewSize(null);
    panStartRef.current = null;
  }, [preview.url]);

  const changeZoom = (delta: number) => {
    setZoom((value) => clampScanPreviewZoom(value + delta));
  };

  const resetImageView = () => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  };

  const rotateImage = (degrees: number) => {
    setRotation((value) => normalizeScanPreviewDegrees(value + degrees));
    setPan({ x: 0, y: 0 });
  };

  const handlePreviewWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (preview.kind !== "image") return;
    event.preventDefault();
    event.stopPropagation();
    if (Math.abs(event.deltaY) < 4) return;
    changeZoom(event.deltaY < 0 ? SCAN_PREVIEW_ZOOM_STEP : -SCAN_PREVIEW_ZOOM_STEP);
  };

  const beginImagePan = (event: PointerEvent<HTMLImageElement>) => {
    if (preview.kind !== "image" || event.button !== 0) return;
    event.preventDefault();
    panStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateImagePan = (event: PointerEvent<HTMLImageElement>) => {
    if (!isPanning || !panStartRef.current) return;
    const start = panStartRef.current;
    setPan({
      x: start.panX + event.clientX - start.clientX,
      y: start.panY + event.clientY - start.clientY,
    });
  };

  const finishImagePan = (event: PointerEvent<HTMLImageElement>) => {
    if (!isPanning) return;
    setIsPanning(false);
    panStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (fullscreen || event.button !== 0) return;

    const panel = event.currentTarget.closest(".scan-preview-modal");
    if (!panel) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    event.currentTarget.setPointerCapture(event.pointerId);

    const resize = (moveEvent: globalThis.PointerEvent) => {
      setPreviewSize({
        width: Math.min(
          window.innerWidth - 16,
          Math.max(MIN_SCAN_PREVIEW_WIDTH, startWidth + moveEvent.clientX - startX),
        ),
        height: Math.min(
          window.innerHeight - 16,
          Math.max(MIN_SCAN_PREVIEW_HEIGHT, startHeight + moveEvent.clientY - startY),
        ),
      });
    };

    const stop = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const previewStyle: CSSProperties | undefined = !fullscreen && previewSize
    ? { width: previewSize.width, height: previewSize.height }
    : undefined;
  const imageStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
  };

  return createPortal(
    <div className="scan-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`scan-preview-modal ${fullscreen ? "scan-preview-modal-fullscreen" : ""}`}
        style={previewStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-preview-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="scan-preview-header">
          <div>
            <span className="eyebrow">Попередній перегляд</span>
            <h2 id="scan-preview-title">{preview.name}</h2>
          </div>
          <div className="scan-preview-header-actions">
            {preview.kind === "image" ? (
              <div className="scan-preview-toolstrip">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => changeZoom(-SCAN_PREVIEW_ZOOM_STEP)}
                  aria-label="Зменшити зображення"
                  title="Зменшити"
                >
                  -
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => changeZoom(SCAN_PREVIEW_ZOOM_STEP)}
                  aria-label="Збільшити зображення"
                  title="Збільшити"
                >
                  +
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => rotateImage(-90)}
                  aria-label="Повернути ліворуч"
                  title="Повернути ліворуч"
                >
                  ↺
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => rotateImage(90)}
                  aria-label="Повернути праворуч"
                  title="Повернути праворуч"
                >
                  ↻
                </button>
                <button type="button" className="button button-secondary" onClick={resetImageView}>
                  100%
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setFullscreen((value) => !value)}
            >
              {fullscreen ? "Згорнути" : "На весь екран"}
            </button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Закрити">
              ×
            </button>
          </div>
        </div>
        <div className="scan-preview-body" onWheelCapture={handlePreviewWheel}>
          {preview.kind === "image" ? (
            <img
              className={isPanning ? "panning" : ""}
              src={preview.url}
              alt={preview.name}
              style={imageStyle}
              draggable={false}
              onPointerDown={beginImagePan}
              onPointerMove={updateImagePan}
              onPointerUp={finishImagePan}
              onPointerCancel={finishImagePan}
            />
          ) : (
            <iframe title={preview.name} src={preview.url} />
          )}
        </div>
        <div className="scan-preview-actions">
          <span>Перегляд відкрито у вашому браузері.</span>
          {preview.kind !== "web" ? (
            <button type="button" className="button button-secondary" onClick={onDownload}>
              Завантажити
            </button>
          ) : null}
        </div>
        {!fullscreen ? (
          <button
            type="button"
            className="scan-preview-resize-handle"
            onPointerDown={startResize}
            aria-label="Змінити розмір вікна попереднього перегляду"
            title="Змінити розмір"
          />
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

function clampScanPreviewZoom(value: number): number {
  return Math.min(MAX_SCAN_PREVIEW_ZOOM, Math.max(MIN_SCAN_PREVIEW_ZOOM, Math.round(value * 100) / 100));
}

function normalizeScanPreviewDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function previewKind(scan: ScanAttachment, blob: Blob): ScanPreview["kind"] | null {
  const mimeType = (blob.type || scan.mimeType || "").toLocaleLowerCase();
  const extension = scan.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (mimeType === "application/pdf" || extension === "pdf") return "pdf";
  if (mimeType === "text/html" || ["html", "htm"].includes(extension) || scan.storage === "external-url") {
    return "web";
  }
  if (
    mimeType.startsWith("image/") ||
    ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"].includes(extension)
  ) {
    return "image";
  }
  return null;
}

function isPreviewableAttachment(scan: ScanAttachment): boolean {
  if (scan.availability === "missing-local") return false;
  const mimeType = (scan.mimeType || "").toLocaleLowerCase();
  const extension = scan.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  return (
    scan.storage === "external-url" ||
    mimeType === "text/html" ||
    ["html", "htm"].includes(extension) ||
    mimeType === "application/pdf" ||
    extension === "pdf" ||
    mimeType.startsWith("image/") ||
    ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"].includes(extension)
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function storageLabel(scan: ScanAttachment): string {
  if (scan.storage === "external-url") return "Зовнішнє джерело";
  return scan.storage === "google-drive" ? "Хмарне сховище" : "";
}

function attachmentIcon(scan: ScanAttachment): string {
  const extension = scan.name.split(".").pop()?.toLocaleUpperCase() ?? "";
  if (scan.storage === "external-url") return extension && extension.length <= 5 ? extension : "WEB";
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
