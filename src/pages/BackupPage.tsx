import { useCallback, useEffect, useRef, useState } from "react";
import type { AppDatabase, DriveBackupFile } from "../types";
import type { SupabaseWorkspace } from "../services/supabaseAuth";
import {
  createImportPreview,
  downloadDatabase,
  type ImportPreview,
  readDatabaseFile,
} from "../utils/exportImport";
import {
  createProjectBackup,
  deleteProjectBackup,
  downloadProjectBackup,
  listProjectBackups,
} from "../services/projectBackups";
import { signInWithGoogle } from "../services/googleAuth";
import { storageService } from "../services/storage/storageService";
import { formatDateTime } from "../utils/dateHelpers";
import { Modal } from "../components/Modal";

interface Props {
  db: AppDatabase;
  workspace: SupabaseWorkspace | null;
  onReplace: (db: AppDatabase) => void | Promise<void>;
  notify: (message: string, error?: boolean) => void;
}

interface PendingImport {
  db: AppDatabase;
  preview: ImportPreview;
  fileName: string;
}

export function BackupPage({
  db,
  workspace,
  onReplace,
  notify,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<DriveBackupFile[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const isOwner = workspace?.role === "owner";

  const closeImportPreview = () => {
    setPendingImport(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const requireWorkspace = (): SupabaseWorkspace => {
    if (!workspace) {
      throw new Error("Спочатку виберіть або створіть проєкт.");
    }
    return workspace;
  };

  const requireOwner = (): SupabaseWorkspace => {
    const activeWorkspace = requireWorkspace();
    if (activeWorkspace.role !== "owner") {
      throw new Error("Керувати резервними копіями може лише власник проєкту.");
    }
    return activeWorkspace;
  };

  const refreshBackups = useCallback(async () => {
    if (!workspace || workspace.role !== "owner") {
      setBackups([]);
      return;
    }
    setLoadingBackups(true);
    try {
      setBackups(await listProjectBackups(workspace.projectId));
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Не вдалося завантажити резервні копії проєкту.",
        true,
      );
    } finally {
      setLoadingBackups(false);
    }
  }, [notify, workspace]);

  useEffect(() => {
    void refreshBackups();
  }, [db.settings.lastAutomaticBackupAt, refreshBackups]);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await action();
      notify(success);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Операцію не виконано.",
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const selectImportFile = async (file?: File) => {
    if (!file) return;
    try {
      const imported = await readDatabaseFile(file);
      setPendingImport({
        db: imported,
        preview: createImportPreview(imported),
        fileName: file.name,
      });
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Файл не пройшов перевірку.",
        true,
      );
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const selectLegacyDriveDatabase = () =>
    run(async () => {
      requireOwner();
      const token = await signInWithGoogle();
      const driveFile = await storageService.findDatabase(token);
      if (!driveFile) {
        throw new Error("Стару базу Трекера Роду на Google Drive не знайдено.");
      }
      const imported = await storageService.downloadDatabase(token, driveFile.id);
      setPendingImport({
        db: imported,
        preview: createImportPreview(imported),
        fileName: driveFile.name,
      });
    }, "Стару базу завантажено для попереднього перегляду.");

  const confirmImport = () =>
    run(async () => {
      if (!pendingImport) return;
      const activeWorkspace = requireOwner();
      await createProjectBackup(activeWorkspace.projectId, db, "pre-import");
      await onReplace(pendingImport.db);
      closeImportPreview();
      await refreshBackups();
    }, "Дані проєкту успішно імпортовано.");

  const createInternalBackup = () =>
    run(async () => {
      const activeWorkspace = requireOwner();
      await createProjectBackup(activeWorkspace.projectId, db, "manual");
      await refreshBackups();
    }, "Резервну копію проєкту створено у Supabase.");

  const restoreBackup = (backup: DriveBackupFile) => {
    if (!window.confirm(
      "Відновлення замінить поточні дані. Перед цим буде створено страхувальну копію поточного стану.",
    )) return;

    void run(async () => {
      const activeWorkspace = requireOwner();
      await createProjectBackup(activeWorkspace.projectId, db, "manual");
      await onReplace(await downloadProjectBackup(backup.id));
      await refreshBackups();
    }, "Проєкт відновлено з резервної копії.");
  };

  const downloadBackup = (backup: DriveBackupFile) =>
    run(async () => {
      const restored = await downloadProjectBackup(backup.id);
      downloadDatabase(restored, backup.name);
    }, "Резервну копію підготовлено до завантаження.");

  const removeBackup = (backup: DriveBackupFile) => {
    if (!window.confirm(`Видалити резервну копію «${backup.name}»?`)) return;
    void run(async () => {
      requireOwner();
      await deleteProjectBackup(backup.id);
      await refreshBackups();
    }, "Резервну копію видалено.");
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Захист даних Трекера Роду</span>
          <h1>Резервні копії проєкту</h1>
          <p>
            Дані й резервні копії зберігаються у приватному сховищі Supabase.
            JSON використовується лише для контрольованого імпорту або експорту.
          </p>
        </div>
      </div>

      <section className="backup-status panel">
        <div className="backup-icon">↻</div>
        <div>
          <span className="eyebrow">Поточний стан</span>
          <h2>
            {workspace
              ? `Проєкт «${workspace.projectName}» у PostgreSQL`
              : "Проєкт не вибрано"}
          </h2>
          <p>
            {workspace
              ? "Зміни зберігаються у Supabase автоматично."
              : "Прийміть запрошення або створіть проєкт, щоб працювати з даними."}
          </p>
        </div>
      </section>

      <section className="backup-grid">
        <article className="panel backup-card">
          <span className="card-icon">S</span>
          <h2>Внутрішня копія</h2>
          <p>Створіть повний знімок активного проєкту у приватному сховищі.</p>
          <button
            className="button button-secondary"
            disabled={busy || !isOwner}
            onClick={createInternalBackup}
          >
            Створити резервну копію
          </button>
        </article>

        <article className="panel backup-card">
          <span className="card-icon">↓</span>
          <h2>Експорт JSON</h2>
          <p>Завантажте контрольну копію поточних даних проєкту на комп’ютер.</p>
          <button
            className="button button-secondary"
            disabled={!workspace}
            onClick={() => downloadDatabase(db)}
          >
            Завантажити JSON
          </button>
        </article>

        <article className="panel backup-card">
          <span className="card-icon">↑</span>
          <h2>Імпорт старої бази</h2>
          <p>
            Імпортуйте JSON зі старої локальної або Google Drive версії.
            Перед заміною буде створено страхувальну копію.
          </p>
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".json,application/json"
            onChange={(event) => void selectImportFile(event.target.files?.[0])}
          />
          <button
            className="button button-secondary"
            disabled={busy || !isOwner}
            onClick={() => inputRef.current?.click()}
          >
            Імпортувати JSON
          </button>
        </article>

        <article className="panel backup-card">
          <span className="card-icon">G</span>
          <h2>Перенесення зі старого Google Drive</h2>
          <p>
            Одноразово завантажте стару базу з приватної папки застосунку
            та перенесіть її до активного Supabase-проєкту.
          </p>
          <button
            className="button button-secondary"
            disabled={busy || !isOwner}
            onClick={() => void selectLegacyDriveDatabase()}
          >
            Знайти стару базу
          </button>
        </article>
      </section>

      <section className="panel backup-list-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Supabase Storage</span>
            <h2>Доступні резервні копії</h2>
          </div>
          <button
            className="button button-ghost"
            disabled={loadingBackups || !isOwner}
            onClick={() => void refreshBackups()}
          >
            {loadingBackups ? "Оновлення…" : "Оновити список"}
          </button>
        </div>

        {!workspace ? (
          <div className="empty-inline">Проєкт не вибрано.</div>
        ) : !isOwner ? (
          <div className="empty-inline">
            Резервні копії проєкту доступні лише його власнику.
          </div>
        ) : backups.length ? (
          <div className="backup-table-wrap">
            <table className="backup-table">
              <thead>
                <tr>
                  <th>Дата створення</th>
                  <th>Назва файлу</th>
                  <th>Тип</th>
                  <th>Розмір</th>
                  <th>Дії</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.id}>
                    <td data-label="Дата">{formatDateTime(backup.createdTime)}</td>
                    <td data-label="Файл" className="backup-file-name">{backup.name}</td>
                    <td data-label="Тип">
                      <span className="status-pill">{backupTypeLabel(backup.type)}</span>
                    </td>
                    <td data-label="Розмір">{formatFileSize(backup.size)}</td>
                    <td data-label="Дії">
                      <div className="backup-actions">
                        <button className="text-button" onClick={() => restoreBackup(backup)}>
                          Відновити
                        </button>
                        <button className="text-button" onClick={() => void downloadBackup(backup)}>
                          Завантажити
                        </button>
                        <button className="text-button danger-text" onClick={() => removeBackup(backup)}>
                          Видалити
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-inline">
            {loadingBackups
              ? "Завантаження резервних копій…"
              : "Резервних копій ще немає."}
          </div>
        )}
      </section>

      {pendingImport ? (
        <Modal title="Попередній перегляд імпорту" onClose={closeImportPreview}>
          <div className="import-preview">
            <p className="import-file-name">{pendingImport.fileName}</p>
            <div className="import-warning">
              Імпорт замінить поточні дані. Перед імпортом буде створено
              страхувальну резервну копію.
            </div>
            <div className="preview-grid">
              <PreviewItem label="Останнє оновлення" value={formatDateTime(pendingImport.preview.updatedAt)} />
              <PreviewItem label="Дослідження" value={pendingImport.preview.researches} />
              <PreviewItem label="Документи" value={pendingImport.preview.documents} />
              <PreviewItem label="Матриця років" value={pendingImport.preview.yearMatrix} />
              <PreviewItem label="Завдання" value={pendingImport.preview.tasks} />
              <PreviewItem label="Знахідки" value={pendingImport.preview.findings} />
              <PreviewItem label="Гіпотези" value={pendingImport.preview.hypotheses} />
              <PreviewItem label="Запити в архів" value={pendingImport.preview.archiveRequests} />
            </div>
            <div className="details-actions">
              <button className="button button-ghost" onClick={closeImportPreview}>
                Скасувати
              </button>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void confirmImport()}
              >
                Створити копію та імпортувати
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function PreviewItem({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function backupTypeLabel(type: DriveBackupFile["type"]): string {
  const labels = {
    automatic: "Автоматична",
    manual: "Ручна",
    "pre-import": "Перед імпортом",
    "pre-clear": "Перед очищенням",
  };
  return labels[type];
}

function formatFileSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
