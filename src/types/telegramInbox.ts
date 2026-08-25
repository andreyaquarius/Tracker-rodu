/**
 * Private, account-scoped bookmark created by the Telegram bot.
 *
 * These values deliberately describe the inbox only. They are not a public
 * Zagulyaka and do not grant publication or moderation status.
 */
export type TelegramNoteStatus =
  | "inbox"
  | "reviewing"
  | "saved"
  | "archived"
  | "converted"
  | (string & {});

/** The availability/verification state of the original shared source. */
export type TelegramNoteSourceStatus =
  | "unverified"
  | "available"
  | "unavailable"
  | "changed"
  | (string & {});

export type TelegramNotePriority =
  | "low"
  | "normal"
  | "high"
  | "urgent"
  | (string & {});

export type TelegramNoteSourcePlatform =
  | "telegram"
  | "facebook"
  | "web"
  | "other"
  | (string & {});

/**
 * Narrow provenance captured from a Telegram `forward_origin` object.
 * It intentionally excludes private chat IDs, sender IDs and raw updates.
 */
export interface TelegramNoteSourceMetadata {
  forwarded?: boolean;
  originType?: "channel" | "chat" | "user" | "hidden_user";
  sourceTitle?: string;
  sourceUsername?: string;
  sourceChatType?: "channel" | "group" | "supergroup" | "private";
  originalPlatform?: "telegram";
  originalMessageId?: number;
  /** Canonical link only when Telegram exposed a public channel username. */
  publicPermalink?: string;
}

export interface TelegramAccountLinkStatus {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
  displayName: string | null;
  /** Legacy AI flag; it remains false while Telegram is in Notes-only mode. */
  aiOptIn: boolean;
}

/** A short, expiring code a user sends to the Telegram bot as `/start CODE`. */
export interface TelegramLinkStart extends TelegramAccountLinkStatus {
  startCode: string | null;
  expiresAt: string | null;
}

export interface TelegramNote {
  id: string;
  title: string;
  body: string;
  sourceUrl: string;
  sourcePlatform: TelegramNoteSourcePlatform;
  /** Original channel/page/group label captured when the post was shared. */
  sourceLabel: string;
  sourceMetadata: TelegramNoteSourceMetadata;
  status: TelegramNoteStatus;
  sourceStatus: TelegramNoteSourceStatus;
  priority: TelegramNotePriority;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramNotesFilters {
  status: TelegramNoteStatus | "";
  sourceStatus: TelegramNoteSourceStatus | "";
  priority: TelegramNotePriority | "";
  sourcePlatform: TelegramNoteSourcePlatform | "";
  query: string;
  limit?: number;
}

export interface UpdateTelegramNoteInput {
  noteId: string;
  title: string;
  body: string;
  sourceUrl: string;
  sourcePlatform: TelegramNoteSourcePlatform;
  status: TelegramNoteStatus;
  sourceStatus: TelegramNoteSourceStatus;
  priority: TelegramNotePriority;
}

export const telegramNoteStatusLabels: Record<string, string> = {
  inbox: "Вхідні",
  reviewing: "Перевіряю",
  saved: "Збережено",
  archived: "Архів",
  converted: "Перетворено на запис",
};

export const telegramNoteSourceStatusLabels: Record<string, string> = {
  unverified: "Не перевірено",
  available: "Джерело доступне",
  unavailable: "Джерело недоступне",
  changed: "Джерело змінилося",
};

export const telegramNotePriorityLabels: Record<string, string> = {
  low: "Низький",
  normal: "Звичайний",
  high: "Високий",
  urgent: "Терміновий",
};

export const telegramNoteSourcePlatformLabels: Record<string, string> = {
  telegram: "Telegram",
  facebook: "Facebook",
  web: "Вебпосилання",
  other: "Інше",
};

export const emptyTelegramNotesFilters: TelegramNotesFilters = {
  status: "",
  sourceStatus: "",
  priority: "",
  sourcePlatform: "",
  query: "",
  limit: 100,
};
