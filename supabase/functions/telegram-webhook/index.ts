import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../_shared/supabaseApiKeys.ts";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_MESSAGE_CHARS = 12_000;
const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const BOT_REPLY_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;
type TelegramImageMimeType = "image/jpeg" | "image/png" | "image/webp";
type TelegramPhoto = {
  fileId: string;
  fileUniqueId: string;
  fileName: string;
  mimeType: TelegramImageMimeType;
  byteSize: number | null;
  area: number;
};

/**
 * Provenance that Telegram includes when a user forwards a message into the
 * bot's private chat. We retain only human-readable/public fields: neither a
 * third-party chat id nor any participant identity is persisted here.
 */
type TelegramForwardOriginType = "channel" | "chat" | "user" | "hidden_user";
type TelegramForwardSource = {
  forwarded: true;
  originalPlatform: "telegram";
  originType: TelegramForwardOriginType;
  sourceTitle: string | null;
  sourceUsername: string | null;
  sourceChatType: "channel" | "group" | "supergroup" | "private" | null;
  originalMessageId: number | null;
  publicPermalink: string | null;
};

type TelegramMessage = {
  updateId: number;
  telegramUserId: number;
  privateChatId: number;
  messageId: number;
  username: string | null;
  displayName: string | null;
  text: string;
  photo: TelegramPhoto | null;
  forwardSource: TelegramForwardSource | null;
};

type TelegramIntent = "note" | "zagulyaka";
type TelegramIntentCallback = {
  callbackId: string;
  telegramUserId: number;
  privateChatId: number;
  promptMessageId: number;
  choiceToken: string | null;
  intent: TelegramIntent | null;
  legacyIntentPicker: boolean;
};

type BotReply = {
  text: string;
};

class WebhookProblem extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const normalized = value.trim();
  return normalized && Array.from(normalized).length <= maximum ? normalized : null;
}

function nullableText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const normalized = value.trim();
  return Array.from(normalized).length <= maximum ? (normalized || null) : null;
}

function integerId(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function telegramUsername(value: unknown): string | null {
  const username = stringValue(value, 32);
  return username && /^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(username) ? username : null;
}

function telegramChatType(value: unknown): TelegramForwardSource["sourceChatType"] {
  return value === "channel" || value === "group" || value === "supergroup" || value === "private"
    ? value
    : null;
}

function telegramChatSource(value: unknown): Pick<
  TelegramForwardSource,
  "sourceTitle" | "sourceUsername" | "sourceChatType"
> {
  const chat = record(value);
  return {
    sourceTitle: nullableText(chat.title, 300),
    sourceUsername: telegramUsername(chat.username),
    sourceChatType: telegramChatType(chat.type),
  };
}

function telegramPublicPermalink(username: string | null, messageId: number | null): string | null {
  // A Telegram username is public. Do not derive the /c/ form because that
  // would create a non-public-looking link from a private chat identifier.
  return username && messageId ? `https://t.me/${username}/${messageId}` : null;
}

function forwardSourceFromOrigin(value: unknown): TelegramForwardSource | null {
  const origin = record(value);
  const originType = origin.type;
  if (originType === "channel") {
    const chat = telegramChatSource(origin.chat);
    const originalMessageId = integerId(origin.message_id);
    return {
      forwarded: true,
      originalPlatform: "telegram",
      originType,
      sourceTitle: chat.sourceTitle,
      sourceUsername: chat.sourceUsername,
      sourceChatType: "channel",
      originalMessageId,
      publicPermalink: telegramPublicPermalink(chat.sourceUsername, originalMessageId),
    };
  }
  if (originType === "chat") {
    const chat = telegramChatSource(origin.sender_chat);
    return {
      forwarded: true,
      originalPlatform: "telegram",
      originType,
      sourceTitle: chat.sourceTitle,
      sourceUsername: chat.sourceUsername,
      sourceChatType: chat.sourceChatType,
      originalMessageId: null,
      // MessageOriginChat intentionally has no original message id, so a
      // permalink cannot be safely reconstructed even if the chat is public.
      publicPermalink: null,
    };
  }
  if (originType === "user") {
    return {
      forwarded: true,
      originalPlatform: "telegram",
      originType,
      // Do not persist a third party's personal name or username. This bot is
      // for a user's saved channel/group material, not user surveillance.
      sourceTitle: null,
      sourceUsername: null,
      sourceChatType: null,
      originalMessageId: null,
      publicPermalink: null,
    };
  }
  if (originType === "hidden_user") {
    return {
      forwarded: true,
      originalPlatform: "telegram",
      originType,
      sourceTitle: null,
      sourceUsername: null,
      sourceChatType: null,
      originalMessageId: null,
      publicPermalink: null,
    };
  }
  return null;
}

function legacyForwardSource(message: JsonObject): TelegramForwardSource | null {
  // Bot API now provides forward_origin. Keep this narrow fallback for a
  // Telegram delivery that still carries the older fields during rollout.
  const legacyChat = record(message.forward_from_chat);
  if (Object.keys(legacyChat).length) {
    const chat = telegramChatSource(legacyChat);
    const originalMessageId = integerId(message.forward_from_message_id);
    const originType: TelegramForwardOriginType = chat.sourceChatType === "channel" ? "channel" : "chat";
    return {
      forwarded: true,
      originalPlatform: "telegram",
      originType,
      sourceTitle: chat.sourceTitle,
      sourceUsername: chat.sourceUsername,
      sourceChatType: chat.sourceChatType,
      originalMessageId,
      publicPermalink: originType === "channel"
        ? telegramPublicPermalink(chat.sourceUsername, originalMessageId)
        : null,
    };
  }
  const legacyUser = record(message.forward_from);
  if (Object.keys(legacyUser).length) {
    return {
      forwarded: true,
      originalPlatform: "telegram",
      originType: "user",
      sourceTitle: null,
      sourceUsername: null,
      sourceChatType: null,
      originalMessageId: null,
      publicPermalink: null,
    };
  }
  return typeof message.forward_sender_name === "string"
    ? {
        forwarded: true,
        originalPlatform: "telegram",
        originType: "hidden_user",
        sourceTitle: null,
        sourceUsername: null,
        sourceChatType: null,
        originalMessageId: null,
        publicPermalink: null,
      }
    : null;
}

function forwardedSource(message: JsonObject): TelegramForwardSource | null {
  return forwardSourceFromOrigin(message.forward_origin) ?? legacyForwardSource(message);
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function webhookAuthorized(request: Request): boolean {
  const configured = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")?.trim() ?? "";
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token")?.trim() ?? "";
  return Boolean(configured) && Boolean(supplied) && constantTimeEqual(supplied, configured);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requireJsonContentType(request: Request): void {
  const value = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (value !== "application/json") throw new WebhookProblem("UNSUPPORTED_MEDIA_TYPE", 415);
}

async function readJsonBody(request: Request): Promise<JsonObject> {
  const contentLength = request.headers.get("Content-Length")?.trim() ?? "";
  if (contentLength) {
    if (!/^\d{1,9}$/u.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES) {
      throw new WebhookProblem("REQUEST_TOO_LARGE", 413);
    }
  }
  if (!request.body) throw new WebhookProblem("INVALID_UPDATE", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new WebhookProblem("REQUEST_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new WebhookProblem("INVALID_UPDATE", 400);

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WebhookProblem("INVALID_UPDATE", 400);
    }
    return parsed as JsonObject;
  } catch (error) {
    if (error instanceof WebhookProblem) throw error;
    throw new WebhookProblem("INVALID_UPDATE", 400);
  }
}

function selectPhoto(value: unknown): TelegramPhoto | null {
  if (!Array.isArray(value)) return null;
  let selected: TelegramPhoto | null = null;
  for (const entry of value) {
    const photo = record(entry);
    const fileId = stringValue(photo.file_id, 512);
    const fileUniqueId = stringValue(photo.file_unique_id, 512);
    if (!fileId || !fileUniqueId) continue;
    const width = typeof photo.width === "number" && Number.isSafeInteger(photo.width) && photo.width > 0
      ? photo.width
      : 0;
    const height = typeof photo.height === "number" && Number.isSafeInteger(photo.height) && photo.height > 0
      ? photo.height
      : 0;
    const declaredSize = typeof photo.file_size === "number"
      && Number.isSafeInteger(photo.file_size)
      && photo.file_size > 0
      && photo.file_size <= 20 * 1024 * 1024
      ? photo.file_size
      : null;
    const candidate: TelegramPhoto = {
      fileId,
      fileUniqueId,
      fileName: "telegram-photo.jpg",
      mimeType: "image/jpeg",
      byteSize: declaredSize,
      area: width * height,
    };
    if (!selected || candidate.area > selected.area || (candidate.area === selected.area
      && (candidate.byteSize ?? 0) > (selected.byteSize ?? 0))) {
      selected = candidate;
    }
  }
  return selected;
}

function selectImageDocument(value: unknown): TelegramPhoto | null {
  const document = record(value);
  const fileId = stringValue(document.file_id, 512);
  const fileUniqueId = stringValue(document.file_unique_id, 512);
  const mimeType = nullableText(document.mime_type, 100)?.toLowerCase();
  if (!fileId || !fileUniqueId
    || (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp")) {
    return null;
  }
  const declaredSize = typeof document.file_size === "number"
    && Number.isSafeInteger(document.file_size)
    && document.file_size > 0
    && document.file_size <= 20 * 1024 * 1024
    ? document.file_size
    : null;
  return {
    fileId,
    fileUniqueId,
    // A Telegram document filename is user-controlled and does not need to be
    // retained. The worker determines the final extension from magic bytes.
    fileName: "telegram-image",
    mimeType,
    byteSize: declaredSize,
    area: 0,
  };
}

function parseMessage(update: JsonObject): TelegramMessage | null {
  const updateId = integerId(update.update_id);
  const message = record(update.message);
  if (!updateId || !Object.keys(message).length) return null;

  const from = record(message.from);
  const chat = record(message.chat);
  const telegramUserId = integerId(from.id);
  const privateChatId = integerId(chat.id);
  const messageId = integerId(message.message_id);
  if (!telegramUserId || !privateChatId || !messageId || chat.type !== "private" || privateChatId !== telegramUserId) {
    return null;
  }

  const messageText = typeof message.text === "string"
    ? message.text
    : typeof message.caption === "string"
    ? message.caption
    : "";
  if (messageText.includes("\0") || Array.from(messageText).length > MAX_MESSAGE_CHARS) {
    throw new WebhookProblem("MESSAGE_TOO_LARGE", 422);
  }

  const firstName = nullableText(from.first_name, 128);
  const lastName = nullableText(from.last_name, 128);
  return {
    updateId,
    telegramUserId,
    privateChatId,
    messageId,
    username: nullableText(from.username, 128),
    displayName: [firstName, lastName].filter(Boolean).join(" ") || null,
    text: messageText.trim(),
    photo: selectPhoto(message.photo) ?? selectImageDocument(message.document),
    forwardSource: forwardedSource(message),
  };
}

function parseChoiceCallback(value: unknown): { choiceToken: string; intent: TelegramIntent } | null {
  if (typeof value !== "string") return null;
  const match = /^tracker:choice:([0-9a-f-]{36}):(note|zagulyaka)$/iu.exec(value);
  if (!match || !isUuid(match[1])) return null;
  const intent = match[2] === "note" || match[2] === "zagulyaka" ? match[2] : null;
  return intent ? { choiceToken: match[1].toLowerCase(), intent } : null;
}

function parseIntentCallback(update: JsonObject): TelegramIntentCallback | null {
  if (!integerId(update.update_id)) return null;
  const callback = record(update.callback_query);
  if (!Object.keys(callback).length) return null;
  const callbackId = stringValue(callback.id, 128);
  const selection = parseChoiceCallback(callback.data);
  const legacyIntentPicker = callback.data === "tracker:intent:note" || callback.data === "tracker:intent:zagulyaka";
  const from = record(callback.from);
  const message = record(callback.message);
  const chat = record(message.chat);
  const telegramUserId = integerId(from.id);
  const privateChatId = integerId(chat.id);
  const promptMessageId = integerId(message.message_id);
  // `callback.message.from` is the bot, so the only user identity trusted here
  // is callback_query.from.  Inline messages and group callbacks never reach
  // the mode-setting RPC.
  if (!callbackId || !telegramUserId || !privateChatId || !promptMessageId
    || chat.type !== "private" || privateChatId !== telegramUserId) {
    return null;
  }
  return {
    callbackId,
    telegramUserId,
    privateChatId,
    promptMessageId,
    choiceToken: selection?.choiceToken ?? null,
    intent: selection?.intent ?? null,
    legacyIntentPicker,
  };
}

function parseCommand(value: string): { name: "start" | "note" | "zagulyaka" | "help" | "pending"; argument: string | null } | null {
  const match = /^\/(start|note|zagulyaka|help|pending)(?:@[A-Za-z0-9_]{3,64})?(?:\s+([^\s]+))?\s*$/iu.exec(value.trim());
  if (!match) return null;
  const name = match[1]?.toLowerCase();
  if (name !== "start" && name !== "note" && name !== "zagulyaka" && name !== "help" && name !== "pending") return null;
  // Only `/start CODE` has an argument. A non-command text that starts with
  // `/note` must be preserved as ordinary content rather than discarded.
  if (name !== "start" && match[2]) return null;
  return { name, argument: match[2] ?? null };
}

function serviceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const secretKey = resolveSupabaseSecretKey({
    SUPABASE_SECRET_KEY: Deno.env.get("SUPABASE_SECRET_KEY"),
    SUPABASE_SECRET_KEYS: Deno.env.get("SUPABASE_SECRET_KEYS"),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  });
  if (!supabaseUrl || !secretKey) throw new WebhookProblem("SERVICE_NOT_CONFIGURED", 503);
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: supabaseServerKeyHeaders(secretKey) },
  });
}

function safeTelegramToken(): string {
  return Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim() ?? "";
}

async function callTelegramBot(method: string, payload: JsonObject): Promise<void> {
  const token = safeTelegramToken();
  if (!token) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOT_REPLY_TIMEOUT_MS);
  try {
    // The bot token is necessarily part of the Bot API path. Never surface
    // this URL, response, or caught provider error in logs or HTTP responses.
    await fetch(`${TELEGRAM_API_ORIGIN}/bot${token}/${method}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telegram delivery is best effort. The already-persisted operation must
    // not be repeated merely because a confirmation message was unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

async function sendBotReply(chatId: number, reply: BotReply): Promise<void> {
  if (!reply.text) return;
  await callTelegramBot("sendMessage", {
    chat_id: chatId,
    text: reply.text,
    disable_web_page_preview: true,
  });
}

async function answerIntentCallback(callbackId: string, text: string): Promise<void> {
  await callTelegramBot("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: false,
  });
}

async function removeIntentPicker(callback: TelegramIntentCallback): Promise<void> {
  await callTelegramBot("editMessageReplyMarkup", {
    chat_id: callback.privateChatId,
    message_id: callback.promptMessageId,
    reply_markup: { inline_keyboard: [] },
  });
}

function safeRpcFailure(error: unknown): WebhookProblem {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (code === "PGRST202" || code === "42883" || code === "42P01") {
    return new WebhookProblem("SERVICE_UNAVAILABLE", 503);
  }
  return new WebhookProblem("SERVICE_OPERATION_FAILED", 503);
}

async function handleCommand(
  message: TelegramMessage,
  command: NonNullable<ReturnType<typeof parseCommand>>,
): Promise<BotReply> {
  if (command.name === "help") {
    return {
      text: "Надішліть або приватно перешліть текст, допис чи посилання — я одразу збережу це як приватну Нотатку. Чернетки Загуляк у Telegram-боті тимчасово вимкнено. Фото зараз не обробляються і не зберігаються; додайте до них текст або посилання, якщо хочете зберегти нотатку.",
    };
  }

  if (command.name === "pending") {
    return {
      text: "Нові текстові повідомлення й посилання зберігаються як Нотатки одразу. Старі матеріали, що очікували вибору, не обробляються як Загуляки; за потреби перешліть текст або посилання ще раз.",
    };
  }

  if (command.name === "start") {
    const client = serviceClient();
    const code = command.argument && /^[A-Za-z0-9_-]{1,160}$/u.test(command.argument)
      ? command.argument
      : "";
    if (!code) {
      return { text: "Відкрийте «Налаштування» у Трекері Роду, створіть одноразовий код підключення й надішліть сюди команду /start з цим кодом." };
    }
    const { data, error } = await client.rpc("service_consume_telegram_link_v1", {
      p_start_code: code,
      p_telegram_user_id: message.telegramUserId,
      p_private_chat_id: message.privateChatId,
      p_telegram_username: message.username,
      p_display_name: message.displayName,
    });
    if (error) throw safeRpcFailure(error);
    return record(data).linked === true
      ? {
          text: "Telegram підключено. Тепер надішліть або перешліть текст, допис чи посилання — я одразу збережу це як приватну Нотатку. Чернетки Загуляк і обробка фото в боті тимчасово вимкнені.",
        }
      : { text: "Посилання недійсне, прострочене або цей Telegram уже підключений до іншого акаунта." };
  }

  if (command.name === "zagulyaka") {
    return {
      text: "Створення чернеток Загуляк через Telegram-бот тимчасово вимкнено. Надішліть текст або посилання без команди — я збережу його як приватну Нотатку.",
    };
  }

  // Keep the old command recognisable without exposing an account-wide mode.
  return {
    text: "Надішліть текст або посилання без команди — я одразу збережу це як приватну Нотатку.",
  };
}

async function enqueueMessage(message: TelegramMessage): Promise<BotReply> {
  const client = serviceClient();
  // Notes are text/link bookmarks. During the temporary notes-only mode, do
  // not persist a Telegram photo/file id, queue it, or send it to an AI worker.
  const photoOmitted = message.photo !== null;
  const { data, error } = await client.rpc("service_enqueue_telegram_message_v1", {
    p_update_id: message.updateId,
    p_telegram_user_id: message.telegramUserId,
    p_private_chat_id: message.privateChatId,
    p_message_id: message.messageId,
    p_message_text: message.text,
    p_media: null,
    // The update was delivered in the owner's private chat. Forward metadata
    // identifies only the original public/visible source and never causes the
    // bot to subscribe to or inspect the source group/channel.
    p_source_metadata: message.forwardSource ?? {},
  });
  if (error) throw safeRpcFailure(error);
  const result = record(data);
  if (result.linked !== true) {
    return { text: "Спочатку підключіть Telegram у налаштуваннях Трекера Роду." };
  }
  if (result.accepted !== true) {
    return {
      text: photoOmitted
        ? "Бот тимчасово зберігає лише текстові Нотатки та посилання. Фото не обробляються і не зберігаються; додайте текст або посилання до повідомлення."
        : "Надішліть текст або посилання, щоб зберегти приватну Нотатку.",
    };
  }
  const choiceToken = typeof result.choiceToken === "string" && isUuid(result.choiceToken)
    ? result.choiceToken
    : null;
  if (result.awaitingChoice === true && choiceToken) {
    const { data: noteData, error: noteError } = await client.rpc("service_choose_telegram_intake_intent_v1", {
      p_telegram_user_id: message.telegramUserId,
      p_private_chat_id: message.privateChatId,
      p_choice_token: choiceToken,
      p_intent: "note",
    });
    if (noteError) throw safeRpcFailure(noteError);
    const noteResult = record(noteData);
    if (noteResult.linked !== true) {
      return { text: "Спочатку підключіть Telegram у налаштуваннях Трекера Роду." };
    }
    if (noteResult.selected !== true) {
      if (noteResult.reason === "expired") {
        return { text: "Строк збереження цього матеріалу минув. Надішліть текст або посилання ще раз." };
      }
      if (noteResult.reason === "already_selected" || noteResult.reason === "zagulyaka_disabled") {
        return { text: "Це повідомлення вже належить до старої чернетки Загуляки. Нові чернетки Загуляк через бот тимчасово вимкнено." };
      }
      return { text: "Не вдалося зберегти цей матеріал. Надішліть текст або посилання ще раз." };
    }
    if (noteResult.materialized === true) {
      return {
        text: photoOmitted
          ? "Нотатку збережено у вашому приватному списку. Текст і джерело збережено, а фото навмисно не оброблялося та не зберігалося. Відкрийте «Нотатки» у Трекері Роду та натисніть «Оновити»."
          : "Нотатку збережено у вашому приватному списку. Відкрийте «Нотатки» у Трекері Роду та натисніть «Оновити».",
      };
    }
    return {
      text: "Нотатку отримано та додано до приватної черги. Відкрийте «Нотатки» у Трекері Роду трохи пізніше.",
    };
  }
  if (result.reason === "expired") {
    return { text: "Строк вибору для цього матеріалу минув, тож його приватний вміст очищено. Якщо він ще потрібен, перешліть його ще раз." };
  }
  if (result.intent === "zagulyaka") {
    return { text: "Це повідомлення вже належить до старої чернетки Загуляки. Нові чернетки через бот тимчасово вимкнено." };
  }
  return { text: "Це повідомлення вже було збережено як приватну Нотатку." };
}

async function handleIntentCallback(callback: TelegramIntentCallback): Promise<void> {
  // A legacy Note button is still safe to honour: it materializes only a
  // private note and never enters the worker.  A Zagulyaka button must remain
  // inert, however, so old Telegram messages cannot revive the retired AI flow.
  if (callback.choiceToken && callback.intent === "note") {
    const client = serviceClient();
    const { data, error } = await client.rpc("service_choose_telegram_intake_intent_v1", {
      p_telegram_user_id: callback.telegramUserId,
      p_private_chat_id: callback.privateChatId,
      p_choice_token: callback.choiceToken,
      p_intent: "note",
    });
    if (error) throw safeRpcFailure(error);
    const result = record(data);
    if (result.linked !== true) {
      await answerIntentCallback(callback.callbackId, "Спочатку підключіть Telegram у Трекері Роду.");
      return;
    }
    if (result.selected === true) {
      await answerIntentCallback(
        callback.callbackId,
        result.materialized === true ? "Нотатку збережено." : "Нотатку додано до приватної черги.",
      );
      await removeIntentPicker(callback);
      return;
    }
    await answerIntentCallback(
      callback.callbackId,
      result.reason === "photo_requires_zagulyaka"
        ? "Фото через Telegram-бот тимчасово не обробляються. Надішліть текст або посилання ще раз."
        : "Цей матеріал більше недоступний. Надішліть текст або посилання ще раз.",
    );
    await removeIntentPicker(callback);
    return;
  }

  // A stale inline button must not offer a hidden way to start the retired
  // Zagulyaka/AI flow. Remove it without consuming or changing its material.
  const disabledMessage = callback.intent === "zagulyaka"
    ? "Чернетки Загуляк у Telegram-боті тимчасово вимкнено."
    : "Це попереднє меню вже неактивне. Надішліть текст або посилання ще раз — воно збережеться як Нотатка.";
  await answerIntentCallback(callback.callbackId, disabledMessage);
  await removeIntentPicker(callback);
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!webhookAuthorized(request)) return json({ error: "UNAUTHORIZED" }, 401);

  try {
    requireJsonContentType(request);
    const update = await readJsonBody(request);
    const intentCallback = parseIntentCallback(update);
    if (intentCallback) {
      await handleIntentCallback(intentCallback);
      return json({ ok: true });
    }
    const message = parseMessage(update);
    // Unsupported update types, group messages and malformed identities do not
    // cause Telegram retries and never reach a database or an external API.
    if (!message) return json({ ok: true });

    const command = parseCommand(message.text);
    const reply = command ? await handleCommand(message, command) : await enqueueMessage(message);
    await sendBotReply(message.privateChatId, reply);
    return json({ ok: true });
  } catch (error) {
    const problem = error instanceof WebhookProblem
      ? error
      : new WebhookProblem("WEBHOOK_FAILED", 503);
    // Deliberately do not log the update, user text, Telegram IDs, headers,
    // database diagnostics, error details or token-bearing Bot API URLs.
    return json({ error: problem.code }, problem.status);
  }
}

Deno.serve(handleRequest);
