import type {
  GeneHelpNotification,
  GeneHelpNotificationEventType,
} from "../types/notifications";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest";
import { syncGeneHelpNotifications } from "./geneHelp";
import { getSupabaseClient } from "./supabaseAuth";

const GENEHELP_SYNC_INTERVAL_MS = 55 * 1000;
const geneHelpSyncStartedAtByUser = new Map<string, number>();
const geneHelpEventTypeAliases: Readonly<Record<string, GeneHelpNotificationEventType>> = {
  interaction_unread_message: "reply_created",
  "genealogy_request.status_changed": "status_changed",
};

type GeneHelpNotificationRow = {
  id?: unknown;
  genehelp_request_id?: unknown;
  event_type?: unknown;
  title?: unknown;
  body?: unknown;
  occurred_at?: unknown;
  created_at?: unknown;
  read_at?: unknown;
  is_read?: unknown;
};

export interface GeneHelpNotificationLoadResult {
  notifications: GeneHelpNotification[];
  syncWarning: boolean;
}

export async function loadMyGeneHelpNotifications(
  limit = 50,
  expectedUserId?: string,
): Promise<GeneHelpNotificationLoadResult> {
  let syncWarning = false;
  const syncUserId = expectedUserId?.trim();
  if (syncUserId) {
    const now = Date.now();
    const lastStartedAt = geneHelpSyncStartedAtByUser.get(syncUserId) ?? 0;
    if (now - lastStartedAt >= GENEHELP_SYNC_INTERVAL_MS) {
      geneHelpSyncStartedAtByUser.set(syncUserId, now);
      try {
        await syncGeneHelpNotifications();
      } catch {
        // The local notification inbox remains useful when GeneHelp is temporarily unavailable.
        syncWarning = true;
      }
    }
  }

  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("list_my_genehelp_notifications", {
        p_limit: boundedLimit,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  const notifications = Array.isArray(data)
    ? data.map((row) => geneHelpNotificationFromRow(row as GeneHelpNotificationRow))
    : [];
  return { notifications, syncWarning };
}

export async function markGeneHelpNotificationRead(
  id: string,
  expectedUserId?: string,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("mark_genehelp_notification_read", {
        p_notification_id: id,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
}

export async function markAllGeneHelpNotificationsRead(
  expectedUserId?: string,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("mark_all_genehelp_notifications_read");
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
}

function geneHelpNotificationFromRow(row: GeneHelpNotificationRow): GeneHelpNotification {
  const createdAt = text(row.created_at);
  const readAt = nullableText(row.read_at);
  return {
    id: text(row.id),
    requestId: text(row.genehelp_request_id),
    eventType: eventType(row.event_type),
    title: text(row.title),
    body: text(row.body),
    occurredAt: text(row.occurred_at) || createdAt,
    createdAt,
    readAt,
    isRead: typeof row.is_read === "boolean" ? row.is_read : Boolean(readAt),
  };
}

function eventType(value: unknown): GeneHelpNotificationEventType {
  const providerEventType = String(value ?? "").trim().toLowerCase();
  const aliased = geneHelpEventTypeAliases[providerEventType];
  if (aliased) return aliased;
  const normalized = providerEventType.includes(".")
    ? providerEventType.slice(providerEventType.lastIndexOf(".") + 1)
    : providerEventType;
  return normalized === "reply_created" || normalized === "interaction_unread_message"
    ? "reply_created"
    : "status_changed";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}
