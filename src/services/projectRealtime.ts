import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabaseAuth";

export type ProjectRealtimeGroup =
  | "project"
  | "researches"
  | "people"
  | "documents"
  | "work"
  | "analysis"
  | "custom"
  | "activity";

export type ProjectRealtimeEntityChange = {
  group: ProjectRealtimeGroup;
  module: string;
  action: string;
  entityId: string;
  details: Record<string, unknown>;
};

function groupForModule(module: string): ProjectRealtimeGroup | null {
  if (module === "researches") return "researches";
  if (module === "persons") return "people";
  if (module === "documents" || module === "yearMatrix") return "documents";
  if (module === "tasks" || module === "findings") return "work";
  if (module === "hypotheses" || module === "archiveRequests") return "analysis";
  if (module === "settings") return "project";
  if (module.startsWith("custom:")) return "custom";
  return null;
}

export function subscribeProjectRealtime(
  projectId: string,
  currentUserId: string,
  onGroupsChanged: (
    groups: Set<ProjectRealtimeGroup>,
    changedByOtherUser: boolean,
    changes: ProjectRealtimeEntityChange[],
  ) => void,
): () => void {
  const client = getSupabaseClient();
  const channel: RealtimeChannel = client.channel(`project-activity:${projectId}`);
  const pending = new Set<ProjectRealtimeGroup>();
  const pendingChanges = new Map<string, ProjectRealtimeEntityChange>();
  let timer: number | null = null;

  const queue = (
    group: ProjectRealtimeGroup,
    change?: ProjectRealtimeEntityChange,
  ) => {
    pending.add(group);
    if (change) {
      pendingChanges.set(
        `${change.module}:${change.entityId || change.action}`,
        change,
      );
    }
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      const changed = new Set(pending);
      const entityChanges = [...pendingChanges.values()];
      pending.clear();
      pendingChanges.clear();
      onGroupsChanged(changed, true, entityChanges);
    }, 400);
  };

  channel.on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "activity_log",
      filter: `project_id=eq.${projectId}`,
    },
    (payload) => {
      const record = payload.new;
      const actorId = typeof record.actor_id === "string" ? record.actor_id : "";
      if (!actorId || actorId === currentUserId) return;

      const details = record.details &&
        typeof record.details === "object" &&
        !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : {};
      const module = String(details.module ?? record.entity_type ?? "");
      const action = String(record.action ?? "");
      const entityId = String(
        details.entityId ?? details.relatedId ?? record.entity_id ?? "",
      );
      if (action.startsWith("field_") || action.startsWith("section_")) {
        queue("custom", {
          group: "custom",
          module,
          action,
          entityId,
          details,
        });
      } else {
        const group = groupForModule(module);
        if (group) {
          queue(group, { group, module, action, entityId, details });
        }
      }
      queue("activity");
    },
  );

  channel.subscribe();
  return () => {
    if (timer !== null) window.clearTimeout(timer);
    void client.removeChannel(channel);
  };
}
