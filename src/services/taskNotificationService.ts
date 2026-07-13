import { getSupabaseClient } from "./supabaseAuth";
import type { TaskReminderNotification } from "../types/notifications";

type TaskNotificationRow = {
  id: string;
  task_id: string;
  project_id: string;
  project_name: string;
  task_title: string;
  task_description: string;
  task_deadline: string;
  scheduled_for: string;
  created_at: string;
  read_at: string | null;
};

const TASK_NOTIFICATION_SELECT =
  "id, task_id, project_id, project_name, task_title, task_description, task_deadline, scheduled_for, created_at, read_at";

export async function loadMyTaskNotifications(
  limit = 50,
): Promise<TaskReminderNotification[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const { data, error } = await getSupabaseClient()
    .from("task_notifications")
    .select(TASK_NOTIFICATION_SELECT)
    .order("created_at", { ascending: false })
    .limit(boundedLimit);
  if (error) throw error;
  return ((data ?? []) as TaskNotificationRow[]).map(taskNotificationFromRow);
}

export async function markTaskNotificationRead(id: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("task_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function markAllTaskNotificationsRead(): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("task_notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) throw error;
}

function taskNotificationFromRow(row: TaskNotificationRow): TaskReminderNotification {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    projectName: row.project_name,
    taskTitle: row.task_title,
    taskDescription: row.task_description,
    taskDeadline: row.task_deadline,
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at,
    readAt: row.read_at,
    isRead: Boolean(row.read_at),
  };
}
