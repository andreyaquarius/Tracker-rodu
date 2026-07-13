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
