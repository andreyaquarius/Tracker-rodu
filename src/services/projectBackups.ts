import type { AppDatabase, BackupFile, BackupType } from "../types";
import { normalizeDatabase } from "../utils/database";
import { getSupabaseClient } from "./supabaseAuth";

const PROJECT_BACKUP_BUCKET = "project-backups";

function backupTypeFromName(name: string): BackupType {
  if (name.includes("-automatic-")) return "automatic";
  return "manual";
}

function safeTimestamp(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function backupName(type: BackupType): string {
  return `tracker-rodu-${type}-${safeTimestamp()}.json`;
}

export async function createProjectBackup(
  projectId: string,
  db: AppDatabase,
  type: BackupType,
): Promise<BackupFile> {
  const name = backupName(type);
  const path = `${projectId}/${name}`;
  const content = JSON.stringify(db, null, 2);
  const blob = new Blob([content], { type: "application/json" });
  const { error } = await getSupabaseClient().storage
    .from(PROJECT_BACKUP_BUCKET)
    .upload(path, blob, {
      contentType: "application/json",
      upsert: false,
    });
  if (error) throw error;
  const createdTime = new Date().toISOString();
  if (type === "automatic") {
    const automatic = (await listProjectBackups(projectId))
      .filter((backup) => backup.type === "automatic")
      .slice(7);
    if (automatic.length) {
      const { error: pruneError } = await getSupabaseClient().storage
        .from(PROJECT_BACKUP_BUCKET)
        .remove(automatic.map((backup) => backup.id));
      if (pruneError) throw pruneError;
    }
  }
  return {
    id: path,
    name,
    createdTime,
    modifiedTime: createdTime,
    size: blob.size,
    type,
  };
}

export async function listProjectBackups(
  projectId: string,
): Promise<BackupFile[]> {
  const { data, error } = await getSupabaseClient().storage
    .from(PROJECT_BACKUP_BUCKET)
    .list(projectId, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" },
    });
  if (error) throw error;
  return data
    .filter((file) => file.name.endsWith(".json"))
    .map((file) => ({
      id: `${projectId}/${file.name}`,
      name: file.name,
      createdTime: file.created_at || file.updated_at || "",
      modifiedTime: file.updated_at || file.created_at || "",
      size: Number(file.metadata?.size ?? 0),
      type: backupTypeFromName(file.name),
    }));
}

export async function downloadProjectBackup(path: string): Promise<AppDatabase> {
  const { data, error } = await getSupabaseClient().storage
    .from(PROJECT_BACKUP_BUCKET)
    .download(path);
  if (error) throw error;
  const parsed = JSON.parse(await data.text()) as unknown;
  return normalizeDatabase(parsed);
}

export async function deleteProjectBackup(path: string): Promise<void> {
  const { error } = await getSupabaseClient().storage
    .from(PROJECT_BACKUP_BUCKET)
    .remove([path]);
  if (error) throw error;
}

export async function clearProjectRecords(projectId: string): Promise<void> {
  const client = getSupabaseClient();
  // Each RPC removes at most 500 rows and derives its table order from the
  // canonical asynchronous-deletion phases. This keeps large restores below
  // the request timeout and prevents new family-tree tables from being left
  // behind when the backup format itself does not contain them.
  for (let step = 0; step < 100_000; step += 1) {
    const { data, error } = await client.rpc("clear_project_records_for_restore", {
      target_project_id: projectId,
      batch_size: 500,
    });
    if (error) throw error;

    const result = data as {
      complete?: unknown;
      deletedRows?: unknown;
    } | null;
    if (result?.complete === true) return;
    const deletedRows = Number(result?.deletedRows);
    if (!Number.isFinite(deletedRows) || deletedRows <= 0) {
      throw new Error("PROJECT_RESTORE_CLEAR_INVALID_PROGRESS");
    }
  }

  throw new Error("PROJECT_RESTORE_CLEAR_STEP_LIMIT_EXCEEDED");
}
