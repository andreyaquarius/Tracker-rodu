import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppDatabase,
  DriveBackupFile,
  GoogleUser,
  SyncState,
} from "../types";
import type { SupabaseWorkspace } from "../services/supabaseAuth";
import {
  createImportPreview,
  downloadDatabase,
  type ImportPreview,
  readDatabaseFile,
} from "../utils/exportImport";
import { loadLocalCopy } from "../services/localStorageDb";
import {
  getAccessToken,
  requestDriveFilePermission,
} from "../services/googleAuth";
import { storageService } from "../services/storage/storageService";
import {
  createProjectBackup,
  deleteProjectBackup,
  downloadProjectBackup,
  listProjectBackups,
} from "../services/projectBackups";
import { formatDateTime } from "../utils/dateHelpers";
import { Modal } from "../components/Modal";

interface Props {
  db: AppDatabase;
  user: GoogleUser | null;
  workspace: SupabaseWorkspace | null;
  sync: SyncState;
  onReplace: (db: AppDatabase) => void | Promise<void>;
  onSync: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}

interface PendingImport {
  db: AppDatabase;
  preview: ImportPreview;
  fileName: string;
}

export function BackupPage({
  db,
  user,
  workspace,
  sync,
  onReplace,
  onSync,
  notify,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<DriveBackupFile[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const projectMode = Boolean(workspace);
  const isOwner = workspace?.role === "owner";

  const closeImportPreview = () => {
    setPendingImport(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const requireToken = () => {
    const token = getAccessToken();
    if (!token) {
      throw new Error("Спочатку підключіть Google Drive у верхній панелі.");
    }
    return token;
  };

  const refreshBackups = useCallback(async () => {
    if (workspace) {
      if (workspace.role !== "owner") {
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
      return;
    }

    const token = getAccessToken();
    if (!token) {
      setBackups([]);
      return;
    }
    setLoadingBackups(true);
    try {
      setBackups(await storageService.listBackups(token));
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Не вдалося завантажити резервні копії.",
        true,
      );
    } finally {
      setLoadingBackups(false);
    }
  }, [notify, workspace]);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups, user, db.settings.lastAutomaticBackupAt]);

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

  const confirmImport = () =>
    run(async () => {
      if (!pendingImport) return;
      if (workspace) {
        if (!isOwner) {
          throw new Error("Імпортувати дані може лише власник проєкту.");
        }
        await createProjectBackup(workspace.projectId, db, "pre-import");
      } else {
        await storageService.createBackup(requireToken(), db, "pre-import");
      }
      await onReplace(pendingImport.db);
      closeImportPreview();
      await refreshBackups();
    }, projectMode ? "Дані проєкту успішно імпортовано." : "Базу успішно імпортовано.");

  const createInternalBackup = () =>
    run(async () => {
      if (workspace) {
        if (!isOwner) {
          throw new Error("Створювати резервні копії може лише власник проєкту.");
        }
        await createProjectBackup(workspace.projectId, db, "manual");
      } else {
        await storageService.createBackup(requireToken(), db, "manual");
      }
      await refreshBackups();
    }, projectMode
      ? "Резервну копію проєкту створено у Supabase."
      : "Резервну копію створено в Google Drive.");

  const visibleBackup = () =>
    run(async () => {
      let token = requireToken();
      token = await requestDriveFilePermission();
      await storageService.createVisibleBackup(token, db);
    }, "Видиму резервну копію створено на Google Drive.");

  const restoreBackup = (backup: DriveBackupFile) => {
    if (!window.confirm(
      "Відновлення замінить поточні дані. Перед цим буде створено страхувальну копію поточного стану.",
    )) return;

    void run(async () => {
      if (workspace) {
        if (!isOwner) {
          throw new Error("Відновлювати дані може лише власник проєкту.");
        }
        await createProjectBackup(workspace.projectId, db, "manual");
        await onReplace(await downloadProjectBackup(backup.id));
      } else {
        const token = requireToken();
        await storageService.createBackup(token, db, "manual");
        await onReplace(await storageService.downloadBackup(token, backup.id));
      }
      await refreshBackups();
    }, projectMode
      ? "Проєкт відновлено з резервної копії."
      : "Базу відновлено з резервної копії.");
  };

  const downloadBackup = (backup: DriveBackupFile) =>
    run(async () => {
      const restored = workspace
        ? await downloadProjectBackup(backup.id)
        : await storageService.downloadBackup(requireToken(), backup.id);
      downloadDatabase(restored, backup.name);
    }, "Резервну копію підготовлено до завантаження.");

  const removeBackup = (backup: DriveBackupFile) => {
    if (!window.confirm(`Видалити резервну копію «${backup.name}»?`)) return;
    void run(async () => {
      if (workspace) {
        if (!isOwner) {
          throw new Error("Видаляти резервні копії може лише власник проєкту.");
        }
        await deleteProjectBackup(backup.id);
      } else {
        await storageService.deleteBackup(requireToken(), backup.id);
      }
      await refreshBackups();
    }, "Резервну копію видалено.");
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Захист даних Трекера Роду</span>
          <h1>Резервні копії та синхронізація</h1>
          <p>
            {projectMode
              ? "Копії активного проєкту зберігаються у приватному сховищі Supabase."
              : "Локальні копії та резервні копії Google Drive залишаються доступними без проєкту."}
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
              : user
                ? "Google Drive підключено"
                : "Працює локальний режим"}
          </h2>
          {projectMode ? (
            <p>
              Дані зберігаються у Supabase автоматично. Резервними копіями
              керує власник проєкту.
            </p>
          ) : (
            <>
              <p>Остання синхронізація: {formatDateTime(sync.lastSyncedAt)}</p>
              <p>
                Остання автоматична копія:{" "}
                {formatDateTime(db.settings.lastAutomaticBackupAt)}
              </p>
            </>
          )}
        </div>
        {!projectMode ? (
          <button
            className="button button-primary"
            disabled={busy || !user}
            onClick={() => run(onSync, "Синхронізацію завершено.")}
          >
            Синхронізувати зараз
          </button>
        ) : null}
      </section>

      <section className="backup-grid">
        <article className="panel backup-card">
          <span className="card-icon">{projectMode ? "S" : "G"}</span>
          <h2>Внутрішня копія</h2>
          <p>
            {projectMode
              ? "Створіть повний знімок активного проєкту в приватному сховищі."
              : "Створіть ручну копію у приватній папці застосунку."}
          </p>
          <button
            className="button button-secondary"
            disabled={busy || (projectMode ? !isOwner : !user)}
            onClick={createInternalBackup}
          >
            Створити резервну копію
          </button>
        </article>

        <article className="panel backup-card">
          <span className="card-icon">↓</span>
          <h2>JSON на комп'ютер</h2>
          <p>Завантажте резервну копію поточних даних.</p>
          <button
            className="button button-secondary"
            onClick={() => downloadDatabase(db)}
          >
            Завантажити JSON
          </button>
        </article>

        <article className="panel backup-card">
          <span className="card-icon">↑</span>
          <h2>Імпорт JSON</h2>
          <p>Файл буде перевірено перед заміною поточних даних.</p>
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".json,application/json"
            onChange={(event) => void selectImportFile(event.target.files?.[0])}
          />
          <button
            className="button button-secondary"
            disabled={busy || (projectMode ? !isOwner : !user)}
            onClick={() => inputRef.current?.click()}
          >
            Імпортувати JSON
          </button>
        </article>

        <article className="panel backup-card">
          <span className="card-icon">G</span>
          <h2>Видима копія у Drive</h2>
          <p>Створіть датований JSON у звичайному розділі Google Drive.</p>
          <button
            className="button button-secondary"
            disabled={busy || !user}
            onClick={visibleBackup}
          >
            Створити видиму копію
          </button>
        </article>

        {!projectMode ? (
          <article className="panel backup-card">
            <span className="card-icon">↺</span>
            <h2>Локальна копія</h2>
            <p>Відновіть останні дані, збережені у цьому браузері.</p>
            <button
              className="button button-secondary"
              onClick={() => {
                void onReplace(loadLocalCopy());
                notify("Локальну копію відновлено.");
              }}
            >
              Відновити локальну копію
            </button>
          </article>
        ) : null}
      </section>

      <section className="panel backup-list-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">
              {projectMode ? "Supabase Storage" : "Google Drive appDataFolder"}
            </span>
            <h2>Доступні резервні копії</h2>
          </div>
          <button
            className="button button-ghost"
            disabled={
              loadingBackups ||
              (projectMode ? !isOwner : !user)
            }
            onClick={() => void refreshBackups()}
          >
            {loadingBackups ? "Оновлення…" : "Оновити список"}
          </button>
        </div>

        {projectMode && !isOwner ? (
          <div className="empty-inline">
            Резервні копії проєкту доступні лише його власнику.
          </div>
        ) : !projectMode && !user ? (
          <div className="empty-inline">
            Підключіть Google Drive, щоб переглянути резервні копії.
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
                    <td data-label="Дата">
                      {formatDateTime(backup.createdTime)}
                    </td>
                    <td data-label="Файл" className="backup-file-name">
                      {backup.name}
                    </td>
                    <td data-label="Тип">
                      <span className="status-pill">
                        {backupTypeLabel(backup.type)}
                      </span>
                    </td>
                    <td data-label="Розмір">
                      {formatFileSize(backup.size)}
                    </td>
                    <td data-label="Дії">
                      <div className="backup-actions">
                        <button
                          className="text-button"
                          onClick={() => restoreBackup(backup)}
                        >
                          Відновити
                        </button>
                        <button
                          className="text-button"
                          onClick={() => void downloadBackup(backup)}
                        >
                          Завантажити
                        </button>
                        <button
                          className="text-button danger-text"
                          onClick={() => removeBackup(backup)}
                        >
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
              <PreviewItem
                label="Останнє оновлення"
                value={formatDateTime(pendingImport.preview.updatedAt)}
              />
              <PreviewItem label="Дослідження" value={pendingImport.preview.researches} />
              <PreviewItem label="Документи" value={pendingImport.preview.documents} />
              <PreviewItem label="Матриця років" value={pendingImport.preview.yearMatrix} />
              <PreviewItem label="Завдання" value={pendingImport.preview.tasks} />
              <PreviewItem label="Знахідки" value={pendingImport.preview.findings} />
              <PreviewItem label="Гіпотези" value={pendingImport.preview.hypotheses} />
              <PreviewItem
                label="Запити в архів"
                value={pendingImport.preview.archiveRequests}
              />
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
