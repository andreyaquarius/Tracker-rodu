import type { ScanAttachment } from "../types/index.ts";

const GOOGLE_DRIVE_STORAGE = "google-drive";

export function projectAttachmentMetadataRows(
  projectId: string,
  ownerType: string,
  ownerId: string,
  fields: Record<string, ScanAttachment[]>,
) {
  const candidates = Object.entries(fields).flatMap(([fieldKey, scans]) =>
    scans
      .filter(
        (scan) =>
          scan.storage === "google-drive" &&
          Boolean(scan.storagePath),
      )
      .map((scan) => ({
        id: scan.id,
        project_id: projectId,
        owner_type: ownerType,
        owner_id: ownerId,
        field_key: fieldKey,
        storage_bucket: GOOGLE_DRIVE_STORAGE,
        storage_path: scan.storagePath,
        file_name: scan.name,
        mime_type: scan.mimeType || "application/octet-stream",
        size_bytes: scan.size,
        created_at: scan.createdAt,
      })),
  );
  const unique = new Map<string, (typeof candidates)[number]>();
  for (const row of candidates) {
    const identity = JSON.stringify([
      row.field_key,
      row.storage_bucket,
      row.storage_path,
    ]);
    if (!unique.has(identity)) unique.set(identity, row);
  }
  return [...unique.values()];
}
