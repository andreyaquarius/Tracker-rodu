import type { AppDatabase, BackupFile, BackupType } from "../types";
import { normalizeDatabase } from "../utils/database";
import {
  listAllProjectPersonNames,
  validateProjectPersonNamesForRestore,
} from "./projectPersonNames";
import { getSupabaseClient } from "./supabaseAuth";

const PROJECT_BACKUP_BUCKET = "project-backups";
const MAX_AUTOMATIC_BACKUPS_PER_PROJECT = 7;

function backupTypeFromName(name: string): BackupType {
  if (name.includes("-automatic-")) return "automatic";
  return "manual";
}

function safeTimestamp(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function backupName(): string {
  return `tracker-rodu-automatic-${safeTimestamp()}.json`;
}

export async function createProjectBackup(
  projectId: string,
  db: AppDatabase,
): Promise<BackupFile> {
  // Person names are loaded lazily by the profile UI and therefore are not
  // guaranteed to be present in `db`. Build the complete snapshot before
  // rotating existing backups so a read failure cannot discard a good copy.
  const snapshot = await buildProjectBackupSnapshot(projectId, db);

  // The list is newest-first. When seven copies already exist, delete the
  // oldest one before uploading the eighth so the new snapshot is never
  // blocked by the server-side seven-object safety limit.
  await pruneAutomaticProjectBackups(
    projectId,
    MAX_AUTOMATIC_BACKUPS_PER_PROJECT - 1,
  );

  const name = backupName();
  const path = `${projectId}/${name}`;
  const content = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([content], { type: "application/json" });
  const { error } = await getSupabaseClient().storage
    .from(PROJECT_BACKUP_BUCKET)
    .upload(path, blob, {
      contentType: "application/json",
      upsert: false,
    });
  if (error) throw error;
  const createdTime = new Date().toISOString();
  await pruneAutomaticProjectBackups(projectId, MAX_AUTOMATIC_BACKUPS_PER_PROJECT);
  return {
    id: path,
    name,
    createdTime,
    modifiedTime: createdTime,
    size: blob.size,
    type: "automatic",
  };
}

/**
 * Produces the authoritative payload shared by cloud, JSON and Excel backup
 * flows. `AppDatabase` intentionally keeps historical names optional for
 * backwards-compatible version-5 files, while every new export includes them.
 */
export async function buildProjectBackupSnapshot(
  projectId: string,
  db: AppDatabase,
): Promise<AppDatabase> {
  const personNames = await listAllProjectPersonNames(projectId);
  validateProjectPersonNamesForRestore({
    names: personNames,
    personIds: new Set(db.persons.map((item) => item.id)),
    documentIds: new Set(db.documents.map((item) => item.id)),
    findingIds: new Set(db.findings.map((item) => item.id)),
  });
  return {
    ...db,
    personNames,
  };
}

async function pruneAutomaticProjectBackups(
  projectId: string,
  keep: number,
): Promise<void> {
  const obsolete = (await listProjectBackups(projectId))
    .filter((backup) => backup.type === "automatic")
    // listProjectBackups returns newest-first, so everything after `keep` is
    // the oldest part of the rotation.
    .slice(Math.max(0, keep));
  if (!obsolete.length) return;

  const { error } = await getSupabaseClient().storage
    .from(PROJECT_BACKUP_BUCKET)
    .remove(obsolete.map((backup) => backup.id));
  if (error) throw error;
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
