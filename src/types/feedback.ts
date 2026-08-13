export type FeedbackCategory = "question" | "suggestion" | "problem" | "other";
export type FeedbackStatus = "open" | "answered" | "closed";
export type FeedbackSenderRole = "user" | "admin";

export interface FeedbackThread {
  id: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  lastMessageAt: string;
  lastMessageRole: FeedbackSenderRole;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  unread: boolean;
}

export interface FeedbackMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderRole: FeedbackSenderRole;
  body: string;
  createdAt: string;
}

export interface CreateFeedbackThreadInput {
  subject: string;
  category: FeedbackCategory;
  body: string;
}
