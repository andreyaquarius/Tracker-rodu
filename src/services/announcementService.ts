import { getSupabaseClient } from "./supabaseAuth";
import type {
  AdminAnnouncementInput,
  AnnouncementCategory,
  AnnouncementEmailStatus,
  AnnouncementMediaType,
  AppAnnouncement,
} from "../types/announcements";

export async function loadMyAnnouncements(): Promise<AppAnnouncement[]> {
  const { data, error } = await getSupabaseClient().rpc("list_my_app_announcements");
  if (error) throw error;
  return (data ?? []).map(mapAnnouncement);
}

export async function markAnnouncementRead(id: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("mark_app_announcement_read", {
    target_announcement_id: id,
  });
  if (error) throw error;
}

export async function loadAdminAnnouncements(): Promise<AppAnnouncement[]> {
  const { data, error } = await getSupabaseClient().rpc("admin_list_app_announcements");
  if (error) throw error;
  return (data ?? []).map(mapAnnouncement);
}

export async function adminSaveAnnouncement(input: AdminAnnouncementInput): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc("admin_upsert_app_announcement", {
    target_id: input.id ?? null,
    target_title: input.title,
    target_body: input.body,
    target_category: input.category,
    target_media_type: input.mediaType,
    target_media_url: input.mediaUrl || null,
    target_cta_label: input.ctaLabel || null,
    target_cta_url: input.ctaUrl || null,
    target_is_published: input.isPublished,
    target_email_status: input.emailStatus,
  });
  if (error) throw error;
  return String(data);
}

export async function adminDeleteAnnouncement(id: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("admin_delete_app_announcement", {
    target_id: id,
  });
  if (error) throw error;
}

export async function sendAnnouncementEmail(id: string): Promise<{ sent: number; failed: number }> {
  const client = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Увійдіть в акаунт перед надсиланням email-розсилки.");

  const localFunctionsUrl = import.meta.env.VITE_LOCAL_EDGE_FUNCTIONS_URL?.trim();
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const baseUrl = localFunctionsUrl || (supabaseUrl ? `${supabaseUrl.replace(/\/+$/, "")}/functions/v1` : "");
  if (!baseUrl) {
    throw new Error("Не налаштована адреса Supabase для email-розсилки.");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/send-announcement-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(anonKey ? { apikey: anonKey } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ announcementId: id }),
    });
  } catch {
    throw new Error(
      "Не вдалося підключитися до серверної функції email-розсилки. Перевірте, що Edge Function send-announcement-email передеплоєно.",
    );
  }

  const data = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(
      stringField(data, "error") ||
        stringField(data, "message") ||
        `Серверна функція email-розсилки повернула помилку ${response.status}.`,
    );
  }

  return {
    sent: Number((data as { sent?: unknown } | null)?.sent ?? 0),
    failed: Number((data as { failed?: unknown } | null)?.failed ?? 0),
  };
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function stringField(value: unknown, field: string): string {
  if (!value || typeof value !== "object" || !(field in value)) return "";
  const text = String((value as Record<string, unknown>)[field] ?? "").trim();
  return text;
}

function mapAnnouncement(row: Record<string, unknown>): AppAnnouncement {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    category: String(row.category ?? "update") as AnnouncementCategory,
    mediaType: String(row.media_type ?? "none") as AnnouncementMediaType,
    mediaUrl: nullableString(row.media_url),
    ctaLabel: nullableString(row.cta_label),
    ctaUrl: nullableString(row.cta_url),
    isPublished: Boolean(row.is_published),
    publishedAt: nullableString(row.published_at),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    isRead: Boolean(row.is_read),
    readAt: nullableString(row.read_at),
    emailStatus: String(row.email_status ?? "not_planned") as AnnouncementEmailStatus,
    emailRequestedAt: nullableString(row.email_requested_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}
