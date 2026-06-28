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
