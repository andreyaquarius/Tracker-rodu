import type { ProjectRealtimeEntityChange } from "../services/projectRealtime";

export type RealtimePatchModule =
  | "researches"
  | "persons"
  | "personRelations"
  | "documents"
  | "yearMatrix"
  | "tasks"
  | "findings"
  | "hypotheses"
  | "archiveRequests";

export type RealtimeRecordMutation = {
  module: RealtimePatchModule;
  entityId: string;
  operation: "upsert" | "delete";
};

const PATCH_MODULES = new Set<RealtimePatchModule>([
  "researches",
  "persons",
  "documents",
  "yearMatrix",
  "tasks",
  "findings",
  "hypotheses",
  "archiveRequests",
]);

const CRUD_ACTION_PATTERN = /(?:_created|_updated|_changed)$/;

export function realtimeRecordMutation(
  change: ProjectRealtimeEntityChange,
): RealtimeRecordMutation | null {
  if (!change.entityId) return null;
  if (change.module === "persons" && change.action.startsWith("relation_")) {
    return {
      module: "personRelations",
      entityId: change.entityId,
      operation: change.action === "relation_deleted" ? "delete" : "upsert",
    };
  }
  if (!PATCH_MODULES.has(change.module as RealtimePatchModule)) return null;
  if (change.action === "record_deleted") {
    return {
      module: change.module as RealtimePatchModule,
      entityId: change.entityId,
      operation: "delete",
    };
  }
  if (
    change.action === "record_created" ||
    change.action === "record_updated" ||
    CRUD_ACTION_PATTERN.test(change.action)
  ) {
    return {
      module: change.module as RealtimePatchModule,
      entityId: change.entityId,
      operation: "upsert",
    };
  }
  return null;
}

export function upsertRealtimeRecord<T extends { id: string }>(
  records: T[],
  record: T,
): T[] {
  const index = records.findIndex((item) => item.id === record.id);
  if (index < 0) return [record, ...records];
  const next = [...records];
  next[index] = record;
  return next;
}

export function removeRealtimeRecord<T extends { id: string }>(
  records: T[],
  entityId: string,
): T[] {
  const next = records.filter((item) => item.id !== entityId);
  return next.length === records.length ? records : next;
}
