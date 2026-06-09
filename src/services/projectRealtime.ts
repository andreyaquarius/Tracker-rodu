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

const GROUP_TABLES: Record<ProjectRealtimeGroup, string[]> = {
  project: ["projects"],
  researches: ["researches"],
  people: ["persons", "person_relations"],
  documents: ["documents", "year_matrix"],
  work: ["tasks", "task_persons", "findings", "finding_participants"],
  analysis: [
    "hypotheses",
    "hypothesis_links",
    "archive_requests",
    "archive_request_persons",
  ],
  custom: [
    "custom_field_definitions",
    "custom_sections",
    "custom_section_fields",
    "custom_records",
    "record_links",
  ],
  activity: ["activity_log"],
};

export function subscribeProjectRealtime(
  projectId: string,
  currentUserId: string,
  onGroupsChanged: (
    groups: Set<ProjectRealtimeGroup>,
    changedByOtherUser: boolean,
  ) => void,
): () => void {
  const client = getSupabaseClient();
  let channel: RealtimeChannel = client.channel(`project:${projectId}`);
  const pending = new Set<ProjectRealtimeGroup>();
  let pendingExternalActivity = false;
  let timer: number | null = null;

  const queue = (group: ProjectRealtimeGroup, changedByOtherUser = false) => {
    pending.add(group);
    pendingExternalActivity ||= changedByOtherUser;
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      const changed = new Set(pending);
      const externalActivity = pendingExternalActivity;
      pending.clear();
      pendingExternalActivity = false;
      onGroupsChanged(changed, externalActivity);
    }, 250);
  };

  for (const [group, tables] of Object.entries(GROUP_TABLES) as Array<
    [ProjectRealtimeGroup, string[]]
  >) {
    for (const table of tables) {
      channel = channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter:
            table === "projects"
              ? `id=eq.${projectId}`
              : `project_id=eq.${projectId}`,
        },
        (payload) => {
          if (table !== "activity_log") {
            queue(group);
            return;
          }
          const record = payload.eventType === "DELETE"
            ? payload.old
            : payload.new;
          const actorId = typeof record.actor_id === "string"
            ? record.actor_id
            : "";
          queue(group, Boolean(actorId && actorId !== currentUserId));
        },
      );
    }
  }

  channel.subscribe();
  return () => {
    if (timer !== null) window.clearTimeout(timer);
    void client.removeChannel(channel);
  };
}
