export interface TaskReminderNotification {
  id: string;
  taskId: string;
  projectId: string;
  projectName: string;
  taskTitle: string;
  taskDescription: string;
  taskDeadline: string;
  scheduledFor: string;
  createdAt: string;
  readAt: string | null;
  isRead: boolean;
}

export type GeneHelpNotificationEventType = "reply_created" | "status_changed";

export interface GeneHelpNotification {
  id: string;
  requestId: string;
  eventType: GeneHelpNotificationEventType;
  title: string;
  body: string;
  occurredAt: string;
  createdAt: string;
  readAt: string | null;
  isRead: boolean;
}
