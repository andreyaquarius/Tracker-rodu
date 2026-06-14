import { useCallback, useEffect, useState } from "react";
import type { ActivityActionType, AppDatabase, BackupFile } from "../types";
import type { SupabaseWorkspace } from "../services/supabaseAuth";
import { downloadDatabase } from "../utils/exportImport";
import {
  createProjectBackup,
  deleteProjectBackup,
  downloadProjectBackup,
  listProjectBackups,
} from "../services/projectBackups";
import { formatDateTime } from "../utils/dateHelpers";
import { exportProjectToExcel } from "../utils/excelExport";

interface Props {
  db: AppDatabase;
  workspace: SupabaseWorkspace | null;
  onReplace: (db: AppDatabase) => void | Promise<void>;
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
    }, "Резервну копію проєкту створено у Supabase.");

  const restoreBackup = (backup: BackupFile) => {
    if (!window.confirm(
      "Відновлення замінить поточні дані. Перед цим буде створено страхувальну копію поточного стану.",
    )) return;

    void run(async () => {
      const activeWorkspace = requireOwner();
      await createProjectBackup(activeWorkspace.projectId, db, "manual");
      await onReplace(await downloadProjectBackup(backup.id));
      onActivity?.(
        backup.id,
        `Відновлено проєкт із резервної копії «${backup.name}».`,
        "backup_restored",
      );
      await refreshBackups();
    }, "Проєкт відновлено з резервної копії.");
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

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Захист даних Трекера Роду</span>
          <h1>Резервні копії проєкту</h1>
          <p>
            Робочі дані та резервні копії зберігаються у приватному сховищі
            Supabase. Файл JSON можна завантажити лише як додаткову копію.
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
