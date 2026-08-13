import type {
  CreateFeedbackThreadInput,
  FeedbackCategory,
  FeedbackMessage,
  FeedbackSenderRole,
  FeedbackStatus,
  FeedbackThread,
} from "../types/feedback";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest";
import { getSupabaseClient } from "./supabaseAuth";

const feedbackCategories = new Set<FeedbackCategory>([
  "question",
  "suggestion",
  "problem",
  "other",
]);
const feedbackStatuses = new Set<FeedbackStatus>(["open", "answered", "closed"]);
const feedbackSenderRoles = new Set<FeedbackSenderRole>(["user", "admin"]);

export async function loadFeedbackThreads(expectedUserId?: string): Promise<FeedbackThread[]> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("list_feedback_threads");
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return asRecords(data).map(mapFeedbackThread);
}

export async function loadFeedbackMessages(
  threadId: string,
  expectedUserId?: string,
): Promise<FeedbackMessage[]> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("list_feedback_messages", {
        p_thread_id: threadId,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return asRecords(data).map(mapFeedbackMessage);
}

export async function createFeedbackThread(
  input: CreateFeedbackThreadInput,
  expectedUserId?: string,
): Promise<string> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("create_feedback_thread", {
        p_subject: input.subject,
        p_category: input.category,
        p_body: input.body,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return String(data ?? "");
}

export async function postFeedbackMessage(
  threadId: string,
  body: string,
  expectedUserId?: string,
): Promise<string> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("post_feedback_message", {
        p_thread_id: threadId,
        p_body: body,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return String(data ?? "");
}

export async function markFeedbackThreadRead(
  threadId: string,
  expectedUserId?: string,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("mark_feedback_thread_read", {
        p_thread_id: threadId,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
}

export async function setFeedbackThreadStatus(
  threadId: string,
  status: "open" | "closed",
  expectedUserId?: string,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("set_feedback_thread_status", {
        p_thread_id: threadId,
        p_status: status,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
}

export async function loadFeedbackUnreadCount(expectedUserId?: string): Promise<number> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("get_feedback_unread_count");
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  const count = Number(data ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

export function notifyFeedbackInboxChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("tracker-rodu:feedback-inbox-changed"));
  }
}

function mapFeedbackThread(row: Record<string, unknown>): FeedbackThread {
  return {
    id: String(row.id ?? ""),
    authorId: String(row.authorId ?? row.author_id ?? ""),
    authorName: String(row.authorName ?? row.author_name ?? "Користувач"),
    authorEmail: String(row.authorEmail ?? row.author_email ?? ""),
    subject: String(row.subject ?? ""),
    category: enumValue(row.category, feedbackCategories, "question"),
    status: enumValue(row.status, feedbackStatuses, "open"),
    lastMessageAt: String(row.lastMessageAt ?? row.last_message_at ?? ""),
    lastMessageRole: enumValue(
      row.lastMessageRole ?? row.last_message_role,
      feedbackSenderRoles,
      "user",
    ),
    createdAt: String(row.createdAt ?? row.created_at ?? ""),
    updatedAt: String(row.updatedAt ?? row.updated_at ?? ""),
    messageCount: numberValue(row.messageCount ?? row.message_count),
    unread: Boolean(row.unread),
  };
}

function mapFeedbackMessage(row: Record<string, unknown>): FeedbackMessage {
  return {
    id: String(row.id ?? ""),
    threadId: String(row.threadId ?? row.thread_id ?? ""),
    senderId: String(row.senderId ?? row.sender_id ?? ""),
    senderRole: enumValue(row.senderRole ?? row.sender_role, feedbackSenderRoles, "user"),
    body: String(row.body ?? ""),
    createdAt: String(row.createdAt ?? row.created_at ?? ""),
  };
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  const normalized = String(value ?? "") as T;
  return allowed.has(normalized) ? normalized : fallback;
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}
