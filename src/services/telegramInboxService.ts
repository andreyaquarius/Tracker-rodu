import type {
  CreateTelegramNoteInput,
  TelegramAccountLinkStatus,
  TelegramLinkStart,
  TelegramNote,
  TelegramNotePriority,
  TelegramNoteSourceMetadata,
  TelegramNoteSourcePlatform,
  TelegramNoteSourceStatus,
  TelegramNoteStatus,
  TelegramNotesFilters,
  UpdateTelegramNoteInput,
} from "../types/telegramInbox";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest";
import { sanitizeWebUrl } from "../utils/safeUrl";
import { getSupabaseClient } from "./supabaseAuth";

const DEFAULT_NOTE_LIMIT = 100;
const MAX_NOTE_LIMIT = 200;

type JsonRecord = Record<string, unknown>;

/** Starts (or rotates) the one-time `/start` code for the authenticated user. */
export async function createTelegramLink(
  aiOptIn: boolean,
  expectedUserId?: string,
): Promise<TelegramLinkStart> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("create_my_telegram_link_v1", {
        p_ai_opt_in: aiOptIn,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return mapTelegramLinkStart(firstRecord(data));
}

export async function loadTelegramLinkStatus(
  expectedUserId?: string,
): Promise<TelegramAccountLinkStatus> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("get_my_telegram_link_status_v1");
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return mapTelegramLinkStatus(firstRecord(data));
}

/** Disconnects only the bot-account link; it does not delete saved notes. */
export async function unlinkTelegramAccount(expectedUserId?: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("unlink_my_telegram_account_v1");
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
}

/**
 * Legacy compatibility API. The server currently forces this value to false
 * while the Telegram integration is temporarily Notes-only.
 */
export async function setTelegramAiOptIn(
  aiOptIn: boolean,
  expectedUserId?: string,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("set_my_telegram_ai_opt_in_v1", {
        p_ai_opt_in: aiOptIn,
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
}

export async function listTelegramNotes(
  filters: TelegramNotesFilters,
  expectedUserId?: string,
): Promise<TelegramNote[]> {
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("list_my_telegram_notes_v1", {
        p_status: nullableFilter(filters.status),
        p_source_status: nullableFilter(filters.sourceStatus),
        p_priority: nullableFilter(filters.priority),
        p_source_platform: nullableFilter(filters.sourcePlatform),
        p_query: nullableFilter(filters.query),
        p_limit: noteLimit(filters.limit),
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return records(data).map(mapTelegramNote).filter((note) => Boolean(note.id));
}

/** Creates a private note directly in Tracker Rodu, without a Telegram intake. */
export async function createTelegramNote(
  input: CreateTelegramNoteInput,
  expectedUserId?: string,
): Promise<TelegramNote> {
  const sourceUrl = safeHttpSourceUrl(input.sourceUrl);
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("create_my_telegram_note_v1", {
        p_title: text(input.title),
        p_body: text(input.body),
        p_source_url: sourceUrl,
        p_source_platform: text(input.sourcePlatform),
        p_status: text(input.status),
        p_source_status: text(input.sourceStatus),
        p_priority: text(input.priority),
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return mapTelegramNote(firstRecord(data));
}

export async function updateTelegramNote(
  input: UpdateTelegramNoteInput,
  expectedUserId?: string,
): Promise<TelegramNote> {
  const noteId = text(input.noteId);
  if (!noteId) throw new Error("Не вказано нотатку для оновлення.");
  const sourceUrl = safeHttpSourceUrl(input.sourceUrl);

  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(
    client,
    async () => {
      const result = await client.rpc("update_my_telegram_note_v1", {
        p_note_id: noteId,
        p_title: text(input.title),
        p_body: text(input.body),
        p_source_url: sourceUrl,
        p_source_platform: text(input.sourcePlatform),
        p_status: text(input.status),
        p_source_status: text(input.sourceStatus),
        p_priority: text(input.priority),
      });
      return { data: result.data, error: result.error };
    },
    expectedUserId,
  );
  if (error) throw error;
  return mapTelegramNote(firstRecord(data));
}

function mapTelegramLinkStart(row: JsonRecord): TelegramLinkStart {
  return {
    ...mapTelegramLinkStatus(row),
    startCode: nullableText(value(row, "startCode", "start_code")),
    expiresAt: nullableText(value(row, "expiresAt", "expires_at")),
  };
}

function mapTelegramLinkStatus(row: JsonRecord): TelegramAccountLinkStatus {
  return {
    linked: booleanValue(value(row, "linked")),
    telegramUsername: nullableText(value(row, "telegramUsername", "telegram_username")),
    linkedAt: nullableText(value(row, "linkedAt", "linked_at")),
    displayName: nullableText(value(row, "displayName", "display_name")),
    aiOptIn: booleanValue(value(row, "aiOptIn", "ai_opt_in")),
  };
}

function mapTelegramNote(row: JsonRecord): TelegramNote {
  return {
    id: text(value(row, "id")),
    title: text(value(row, "title"), "Нотатка без назви"),
    body: text(value(row, "body", "text", "content")),
    sourceUrl: text(value(row, "sourceUrl", "source_url")),
    sourcePlatform: sourcePlatform(value(row, "sourcePlatform", "source_platform")),
    sourceLabel: text(value(row, "sourceLabel", "source_label")),
    sourceMetadata: sourceMetadata(value(row, "sourceMetadata", "source_metadata")),
    status: noteStatus(value(row, "status")),
    sourceStatus: sourceStatus(value(row, "sourceStatus", "source_status")),
    priority: notePriority(value(row, "priority")),
    createdAt: text(value(row, "createdAt", "created_at")),
    updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(record);
  const row = record(value);
  const items = valueOf(row, "items", "notes", "data");
  return Array.isArray(items) ? items.map(record) : Object.keys(row).length ? [row] : [];
}

function firstRecord(value: unknown): JsonRecord {
  return records(value)[0] ?? {};
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function value(row: JsonRecord, ...keys: string[]): unknown {
  return valueOf(row, ...keys);
}

function valueOf(row: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function nullableFilter(value: unknown): string | null {
  return text(value) || null;
}

function safeHttpSourceUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("Вкажіть повне http або https посилання на джерело.");
  }
  const sanitized = sanitizeWebUrl(raw);
  if (!sanitized) throw new Error("Вкажіть коректне http або https посилання на джерело.");
  return sanitized;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

function noteLimit(value: unknown): number {
  const candidate = Number(value ?? DEFAULT_NOTE_LIMIT);
  if (!Number.isFinite(candidate)) return DEFAULT_NOTE_LIMIT;
  return Math.max(1, Math.min(MAX_NOTE_LIMIT, Math.trunc(candidate)));
}

function noteStatus(value: unknown): TelegramNoteStatus {
  return text(value, "inbox") as TelegramNoteStatus;
}

function sourceStatus(value: unknown): TelegramNoteSourceStatus {
  return text(value, "unverified") as TelegramNoteSourceStatus;
}

function notePriority(value: unknown): TelegramNotePriority {
  return text(value, "normal") as TelegramNotePriority;
}

function sourcePlatform(value: unknown): TelegramNoteSourcePlatform {
  return text(value, "other") as TelegramNoteSourcePlatform;
}

function sourceMetadata(value: unknown): TelegramNoteSourceMetadata {
  const row = record(value);
  const forwarded = valueOf(row, "forwarded") === true;
  if (!forwarded) return {};
  const originType = text(valueOf(row, "originType", "origin_type"));
  const sourceChatType = text(valueOf(row, "sourceChatType", "source_chat_type"));
  const isNamedChatOrigin = originType === "channel"
    || (originType === "chat" && (sourceChatType === "channel" || sourceChatType === "group" || sourceChatType === "supergroup"));
  const sourceTitle = isNamedChatOrigin ? nullableText(valueOf(row, "sourceTitle", "source_title")) : null;
  const sourceUsername = isNamedChatOrigin ? safeSourceUsername(valueOf(row, "sourceUsername", "source_username")) : null;
  const originalMessageId = sourceMessageId(valueOf(row, "originalMessageId", "original_message_id"));
  const publicPermalink = originType === "channel"
    ? safeMetadataPermalink(valueOf(row, "publicPermalink", "public_permalink"))
    : null;
  return {
    forwarded: true,
    ...(isForwardOriginType(originType) ? { originType } : {}),
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(sourceUsername ? { sourceUsername } : {}),
    ...(isNamedChatOrigin && isForwardChatType(sourceChatType) ? { sourceChatType } : {}),
    ...(originalMessageId !== null ? { originalMessageId } : {}),
    ...(publicPermalink ? { publicPermalink } : {}),
    originalPlatform: "telegram",
  };
}

function isForwardOriginType(value: string): value is NonNullable<TelegramNoteSourceMetadata["originType"]> {
  return value === "channel" || value === "chat" || value === "user" || value === "hidden_user";
}

function isForwardChatType(value: string): value is NonNullable<TelegramNoteSourceMetadata["sourceChatType"]> {
  return value === "channel" || value === "group" || value === "supergroup" || value === "private";
}

function safeSourceUsername(value: unknown): string | null {
  const username = text(value).replace(/^@+/, "");
  return /^[A-Za-z][A-Za-z0-9_]{4,63}$/u.test(username) ? username : null;
}

function sourceMessageId(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function safeMetadataPermalink(value: unknown): string | null {
  const url = text(value);
  return /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,63}\/[1-9][0-9]{0,18}$/iu.test(url) ? url : null;
}
