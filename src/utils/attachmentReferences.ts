import type { ScanAttachment } from "../types/index.ts";

/** Compare resolved originals, not Picker shortcut IDs, filenames or attachment row IDs. */
export function uniqueNewAttachmentReferences(existing: ScanAttachment[], candidates: ScanAttachment[]): ScanAttachment[] {
  const identity = (scan: ScanAttachment) => `${scan.storage}:${scan.storagePath || scan.id}`;
  const seen = new Set(existing.map(identity));
  return candidates.filter((scan) => {
    const key = identity(scan);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
