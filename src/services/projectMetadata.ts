import type {
  ActivityLogEntry,
  CollectionKey,
  ScanAttachment,
} from "../types";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import { getSupabaseClient, getSupabaseSession } from "./supabaseAuth";

const PROJECT_BUCKET = "project-attachments";

type ActivityRow = {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: unknown;
  created_at: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function activityFromRow(row: ActivityRow): ActivityLogEntry | null {
  const details = asRecord(row.details);
  const module = String(details.module ?? row.entity_type) as CollectionKey;
  const text = String(details.text ?? "");
  if (!text) return null;
  return {
    id: String(row.id),
    createdAt: row.created_at,
    actionType: row.action as ActivityLogEntry["actionType"],
    text,
    module,
    relatedId: String(details.relatedId ?? row.entity_id ?? ""),
  };
}

export async function listProjectActivity(
  projectId: string,
  limit = 100,
): Promise<ActivityLogEntry[]> {
  const { data, error } = await getSupabaseClient()
    .from("activity_log")
    .select("id, action, entity_type, entity_id, details, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as ActivityRow[])
    .map(activityFromRow)
    .filter((entry): entry is ActivityLogEntry => entry !== null);
}

export async function addProjectActivity(
  projectId: string,
  entry: ActivityLogEntry,
): Promise<ActivityLogEntry> {
  const session = await getSupabaseSession();
  if (!session) throw new Error("Увійдіть до облікового запису.");

  const { data, error } = await getSupabaseClient()
    .from("activity_log")
    .insert({
      project_id: projectId,
      actor_id: session.user.id,
      action: entry.actionType,
      entity_type: entry.module,
      entity_id: entry.relatedId || null,
      details: {
        text: entry.text,
        module: entry.module,
        relatedId: entry.relatedId,
      },
      created_at: entry.createdAt,
    })
    .select("id, action, entity_type, entity_id, details, created_at")
    .single();
  if (error) throw error;
  return activityFromRow(data as ActivityRow) ?? entry;
}

export function createGenericProjectActivity(
  module: CollectionKey,
  relatedId: string,
  text: string,
  actionType: ActivityLogEntry["actionType"],
): ActivityLogEntry {
  return {
    id: createId(),
    createdAt: nowIso(),
    actionType,
    text,
    module,
    relatedId,
  };
}

export async function syncProjectAttachmentMetadata(
  projectId: string,
  ownerType: string,
  ownerId: string,
  fields: Record<string, ScanAttachment[]>,
): Promise<void> {
  const client = getSupabaseClient();
  const { error: deleteError } = await client
    .from("attachments")
    .delete()
    .eq("project_id", projectId)
    .eq("owner_type", ownerType)
    .eq("owner_id", ownerId);
  if (deleteError) throw deleteError;

  const rows = Object.entries(fields).flatMap(([fieldKey, scans]) =>
    scans
      .filter(
        (scan) =>
          scan.storage === "supabase" &&
          Boolean(scan.storagePath),
      )
      .map((scan) => ({
        id: scan.id,
        project_id: projectId,
        owner_type: ownerType,
        owner_id: ownerId,
        field_key: fieldKey,
        storage_bucket: PROJECT_BUCKET,
        storage_path: scan.storagePath!,
        file_name: scan.name,
        mime_type: scan.mimeType || "application/octet-stream",
        size_bytes: scan.size,
        created_at: scan.createdAt,
      })),
  );
  if (!rows.length) return;

  const { error } = await client
    .from("attachments")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

export async function deleteProjectAttachmentMetadata(
  projectId: string,
  ownerType: string,
  ownerId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("attachments")
    .delete()
    .eq("project_id", projectId)
    .eq("owner_type", ownerType)
    .eq("owner_id", ownerId);
  if (error) throw error;
}
