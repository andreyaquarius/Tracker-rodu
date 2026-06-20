import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityActionType, AppDatabase, BackupFile } from "../types";
import type { SupabaseWorkspace } from "../services/supabaseAuth";
import { downloadDatabase, readDatabaseBackup } from "../utils/exportImport";
import {
  createProjectBackup,
  deleteProjectBackup,
  downloadProjectBackup,
  listProjectBackups,
} from "../services/projectBackups";
import { formatDateTime } from "../utils/dateHelpers";
import { exportProjectToExcel } from "../utils/excelExport";
import { cloneDatabaseForProjectImport } from "../utils/database";

interface Props {
  db: AppDatabase;
  workspace: SupabaseWorkspace | null;
  onReplace: (
    db: AppDatabase,
    onProgress?: (message: string, percent: number) => void,
  ) => void | Promise<void>;
  notify: (message: string, error?: boolean) => void;
  onActivity?: (
    relatedId: string,
    text: string,
    actionType: ActivityActionType,
  ) => void;
}

export function BackupPage({
  db,
  workspace,
  onReplace,
  notify,
  onActivity,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<{
    title: string;
    message: string;
    percent: number;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const isOwner = workspace?.role === "owner";

  const requireOwner = (): SupabaseWorkspace => {
    if (!workspace) throw new Error("Спочатку виберіть або створіть проєкт.");
    if (workspace.role !== "owner") {
      throw new Error("Керувати резервними копіями може лише власник проєкту.");
    }
    return workspace;
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
      notify(error instanceof Error ? error.message : "Операцію не виконано.", true);
    } finally {
      setBusy(false);
    }
  };

  const createInternalBackup = () =>
    run(async () => {
      const activeWorkspace = requireOwner();
      const backup = await createProjectBackup(activeWorkspace.projectId, db, "manual");
      onActivity?.(
        backup.id,
        `Створено резервну копію «${backup.name}».`,
        "backup_created",
      );
      await refreshBackups();
    }, "Резервну копію проєкту створено.");

  const restoreBackup = (backup: BackupFile) => {
    if (!window.confirm(
      "Відновлення замінить поточні дані. Перед цим буде створено страхувальну копію поточного стану.",
    )) return;

    setRestoreProgress({
      title: "Відновлення проєкту",
      message: "Завантажуємо резервну копію…",
      percent: 3,
    });
    void run(async () => {
      const activeWorkspace = requireOwner();
      setRestoreProgress({
        title: "Відновлення проєкту",
        message: "Створюємо страховочну копію поточних даних…",
        percent: 7,
      });
      await createProjectBackup(activeWorkspace.projectId, db, "manual");
      setRestoreProgress({
        title: "Відновлення проєкту",
        message: "Завантажуємо та перевіряємо резервну копію…",
        percent: 12,
      });
      const restored = await downloadProjectBackup(backup.id);
      await onReplace(restored, (message, percent) =>
        setRestoreProgress({
          title: "Відновлення проєкту",
          message,
          percent,
        }),
      );
      onActivity?.(
        backup.id,
        `Відновлено проєкт із резервної копії «${backup.name}».`,
        "backup_restored",
      );
      await refreshBackups();
      setRestoreProgress({
        title: "Відновлення завершено",
        message: "Дані проєкту успішно оновлено.",
        percent: 100,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }, "Проєкт відновлено з резервної копії.")
      .finally(() => setRestoreProgress(null));
  };

  const downloadBackup = (backup: BackupFile) =>
    run(async () => {
      const restored = await downloadProjectBackup(backup.id);
      downloadDatabase(restored, backup.name);
    }, "Резервну копію підготовлено до завантаження.");

  const removeBackup = (backup: BackupFile) => {
    if (!window.confirm(`Видалити резервну копію «${backup.name}»?`)) return;
    void run(async () => {
      requireOwner();
      await deleteProjectBackup(backup.id);
      onActivity?.(
        backup.id,
        `Видалено резервну копію «${backup.name}».`,
        "backup_deleted",
      );
      await refreshBackups();
    }, "Резервну копію видалено.");
  };

  const importLocalBackup = (file: File) => {
    if (!window.confirm(
      `Відновити проєкт із файла «${file.name}»? Поточні дані буде замінено, а перед цим застосунок створить страхувальну копію.`,
    )) return;

    setRestoreProgress({
      title: "Імпорт резервної копії",
      message: "Читаємо та перевіряємо JSON-файл…",
      percent: 2,
    });
    void run(async () => {
      const activeWorkspace = requireOwner();
      const imported = cloneDatabaseForProjectImport(
        await readDatabaseBackup(file),
      );
      setRestoreProgress({
        title: "Імпорт резервної копії",
        message: "Створюємо страховочну копію поточного проєкту…",
        percent: 7,
      });
      await createProjectBackup(activeWorkspace.projectId, db, "manual");
      await onReplace(imported, (message, percent) =>
        setRestoreProgress({
          title: "Імпорт резервної копії",
          message,
          percent,
        }),
      );
      onActivity?.(
        activeWorkspace.projectId,
        `Відновлено проєкт із локальної резервної копії «${file.name}».`,
        "backup_restored",
      );
      await refreshBackups();
      setRestoreProgress({
        title: "Імпорт завершено",
        message: "Резервну копію успішно додано до проєкту.",
        percent: 100,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }, "Проєкт відновлено з локальної резервної копії.")
      .finally(() => setRestoreProgress(null));
  };

  return (
    <>
      {restoreProgress ? (
        <div className="restore-progress-backdrop" role="presentation">
          <section
            className="restore-progress-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-progress-title"
            aria-describedby="restore-progress-message"
          >
            <span className="restore-progress-spinner" aria-hidden="true" />
            <div>
              <span className="eyebrow">Зачекайте, не закривайте сторінку</span>
              <h2 id="restore-progress-title">{restoreProgress.title}</h2>
              <p id="restore-progress-message" aria-live="polite">
                {restoreProgress.message}
              </p>
              <div
                className="restore-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={restoreProgress.percent}
              >
                <span style={{ width: `${restoreProgress.percent}%` }} />
              </div>
              <strong>{restoreProgress.percent}%</strong>
            </div>
          </section>
        </div>
      ) : null}
      <div className="page-heading">
        <div>
          <span className="eyebrow">Захист даних Трекера Роду</span>
          <h1>Резервні копії проєкту</h1>
          <p>
            Робочі дані та резервні копії зберігаються у приватному захищеному сховищі.
            Файл JSON можна завантажити як додаткову копію.
          </p>
        </div>
      </div>

      <section className="backup-status panel">
        <div className="backup-icon">↻</div>
        <div>
          <span className="eyebrow">Поточний стан</span>
          <h2>
            {workspace
              ? `Проєкт «${workspace.projectName}»`
              : "Проєкт не вибрано"}
          </h2>
          <p>
            {workspace
              ? "Зміни зберігаються автоматично."
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
          <h2>Завантажити копію</h2>
          <p>Збережіть контрольну копію поточних даних проєкту на комп'ютері.</p>
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
          <h2>Імпортувати копію</h2>
          <p>
            Відновіть проєкт із JSON-файла, який раніше було збережено на комп’ютері.
          </p>
          <input
            ref={importInputRef}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) importLocalBackup(file);
            }}
          />
          <button
            className="button button-secondary"
            disabled={busy || !isOwner}
            onClick={() => importInputRef.current?.click()}
          >
            Вибрати файл JSON
          </button>
        </article>

        <article className="panel backup-card">
          <span className="card-icon">X</span>
          <h2>Експорт у Excel</h2>
          <p>
            Завантажте весь проєкт одним файлом XLSX. Кожен стандартний і власний
            розділ буде розміщено на окремому аркуші.
          </p>
          <button
            className="button button-secondary"
            disabled={!workspace}
            onClick={() => exportProjectToExcel(db, workspace?.projectName ?? "Трекер Роду")}
          >
            Завантажити весь проєкт
          </button>
        </article>
      </section>

      <section className="panel backup-list-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Хмарне сховище</span>
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
    </>
  );
}

function backupTypeLabel(type: BackupFile["type"]): string {
  const labels = {
    automatic: "Автоматична",
    manual: "Ручна",
  };
  return labels[type];
}

function formatFileSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
