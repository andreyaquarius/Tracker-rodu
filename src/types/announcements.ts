export type AnnouncementCategory = "update" | "feature" | "maintenance" | "tip";

export type AnnouncementMediaType = "none" | "image" | "video" | "link";

export type AnnouncementEmailStatus = "not_planned" | "planned" | "sent";

export interface AppAnnouncement {
  id: string;
  title: string;
  body: string;
  category: AnnouncementCategory;
  mediaType: AnnouncementMediaType;
  mediaUrl: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  readAt: string | null;
  emailStatus: AnnouncementEmailStatus;
  emailRequestedAt: string | null;
}

export interface AdminAnnouncementInput {
  id?: string | null;
  title: string;
  body: string;
  category: AnnouncementCategory;
  mediaType: AnnouncementMediaType;
  mediaUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  isPublished: boolean;
  emailStatus: AnnouncementEmailStatus;
}
