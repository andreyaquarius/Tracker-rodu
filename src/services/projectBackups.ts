import type { AppDatabase, BackupType, DriveBackupFile } from "../types";
import { normalizeDatabase } from "../utils/database";
import { getSupabaseClient } from "./supabaseAuth";

const PROJECT_BACKUP_BUCKET = "project-backups";

function backupTypeFromName(name: string): BackupType {
  if (name.includes("-pre-import-")) return "pre-import";
  if (name.includes("-pre-clear-")) return "pre-clear";
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
): Promise<DriveBackupFile> {
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
): Promise<DriveBackupFile[]> {
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
  const tables = [
    "attachments",
    "record_links",
    "custom_records",
    "custom_section_fields",
    "custom_sections",
    "custom_field_definitions",
    "archive_request_persons",
    "archive_requests",
    "hypothesis_links",
    "hypotheses",
    "finding_participants",
    "findings",
    "task_persons",
    "tasks",
    "year_matrix",
    "documents",
    "person_relations",
    "persons",
    "researches",
  ];
  for (const table of tables) {
    const { error } = await client.from(table).delete().eq("project_id", projectId);
    if (error) throw error;
  }
}
