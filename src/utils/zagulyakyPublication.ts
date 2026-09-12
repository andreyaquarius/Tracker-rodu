export function isArchivalPublicationSource(source: Record<string, unknown>): boolean {
  const value = (key: string) => typeof source[key] === "string" ? source[key].trim() : "";
  return Boolean(value("id")) && source.permission_status !== "restricted"
    && Boolean(value("citation") || value("archive_name") || /^https?:\/\//i.test(value("source_url")));
}

export function attachmentPublicationAction(record: { status: string; privacyStatus: string }):
  "publish_record" | "publish_attachment" | "unavailable" {
  if (record.privacyStatus === "blocked") return "unavailable";
  if (record.status === "pending_review") return "publish_record";
  if (record.status === "published" && record.privacyStatus === "cleared") return "publish_attachment";
  return "unavailable";
}

export function publicationBlocker(input: {
  privacyBlocked: boolean;
  possibleLivingPerson: boolean;
  hasCurrentClearance: boolean;
  archivalConfirmed: boolean;
  hasArchivalSource: boolean;
}): string | null {
  if (input.privacyBlocked) return "ARCHIVAL_PUBLICATION_BLOCKED";
  if (input.archivalConfirmed && !input.hasArchivalSource) return "ARCHIVAL_PUBLICATION_SOURCE_REQUIRED";
  if (input.possibleLivingPerson && !input.hasCurrentClearance && !input.archivalConfirmed) {
    return "LIVING_PERSON_DOCUMENTED_CONSENT_REQUIRED";
  }
  return null;
}

/** Never send a storage publication request before the record's approval commits. */
export async function publishZagulyakaWithAttachments<T extends { status: string; privacyStatus: string }>(input: {
  publishRecord: () => Promise<T>;
  attachmentIds: string[];
  publishAttachment: (id: string) => Promise<void>;
}): Promise<{ record: T; failures: { attachmentId: string; error: unknown }[] }> {
  const record = await input.publishRecord();
  if (attachmentPublicationAction(record) !== "publish_attachment") {
    throw new Error("ATTACHMENT_RECORD_NOT_PUBLIC");
  }
  const failures: { attachmentId: string; error: unknown }[] = [];
  // Large scans/PDFs must not all be copied concurrently in Edge memory.
  for (const attachmentId of new Set(input.attachmentIds)) {
    try {
      await input.publishAttachment(attachmentId);
    } catch (error) {
      failures.push({ attachmentId, error });
    }
  }
  return { record, failures };
}
