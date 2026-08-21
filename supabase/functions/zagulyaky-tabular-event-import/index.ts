import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../_shared/supabaseApiKeys.ts";

/**
 * Browser-to-Edge relay for the event-centric Zagulyaky workbook importer.
 *
 * The browser owns XLSX parsing and validation. This function deliberately
 * never receives, decompresses, or logs XLSX bytes: it accepts only a small,
 * authenticated JSON action and relays it to the existing protected SQL
 * facades. Raw source text and private Facebook provenance can be present in
 * a `chunk`, but they are written only to the private import ledger by the
 * service-only SQL facade; this function never returns them.
 *
 * POST application/json action contract (all keys are closed):
 *
 *   { action: "begin", importMode: "dry_run" | "commit",
 *     sourceFileName: "…xlsx", sourceChecksum: "<sha256>",
 *     expectedCounts: { sourcePosts, events, participants, eventSources,
 *       cards, qc, eventsWithoutCards } }
 *
 *   { action: "chunk", importMode: "dry_run", batchId: "<uuid>",
 *     chunkIndex: 0..100000,
 *     chunk: { sourcePosts, events, participants, eventSources, cards, qc } }
 *
 *   { action: "finalize", importMode: "dry_run" | "commit",
 *     batchId: "<uuid>", materializeLimit?: 1..250 }
 *
 * A chunk checksum is derived in the relay from canonical JSON, rather than
 * trusted from the browser. The existing database receipt stores that digest
 * and therefore makes retries idempotent for exactly the same row data.
 */

const MAX_JSON_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_JSON_BYTES = 7 * 1024 * 1024;
const MAX_CHUNK_TOTAL_ROWS = 250;
const MAX_CHUNK_INDEX = 100_000;
const MAX_MATERIALIZE_LIMIT = 250;
const MAX_JSON_STRING_CHARS = 250_000;
const MAX_JSON_OBJECT_KEYS = 200;
const MAX_JSON_ARRAY_ITEMS = 1_000;
const MAX_JSON_DEPTH = 12;

const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const CHUNK_BUCKETS = [
  "sourcePosts",
  "events",
  "participants",
  "eventSources",
  "cards",
  "qc",
] as const;

const EXPECTED_COUNT_LIMITS = {
  sourcePosts: 50_000,
  events: 200_000,
  participants: 500_000,
  eventSources: 500_000,
  cards: 500_000,
  qc: 500_000,
  eventsWithoutCards: 200_000,
} as const;

type ImportMode = "dry_run" | "commit";
type RelayAction = "begin" | "chunk" | "finalize";
type RelayPhase = "preflight" | "auth" | "body" | "begin" | "chunk" | "finalize";
type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ExpectedCounts = { [K in keyof typeof EXPECTED_COUNT_LIMITS]: number };
type ChunkPayload = { [K in typeof CHUNK_BUCKETS[number]]: JsonObject[] };

type BeginInput = {
  action: "begin";
  importMode: ImportMode;
  sourceFileName: string;
  sourceChecksum: string;
  expectedCounts: ExpectedCounts;
};

type ChunkInput = {
  action: "chunk";
  importMode: "dry_run";
  batchId: string;
  chunkIndex: number;
  chunk: ChunkPayload;
};

type FinalizeInput = {
  action: "finalize";
  importMode: ImportMode;
  batchId: string;
  materializeLimit: number;
};

class RequestProblem extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function safeErrorName(error: unknown): string {
  const candidate = error && typeof error === "object" && "name" in error
    ? (error as { name?: unknown }).name
    : null;
  return typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)
    ? candidate
    : "UnknownError";
}

function unexpectedImportProblem(phase: RelayPhase): RequestProblem {
  return new RequestProblem(`TABULAR_EVENT_IMPORT_UNEXPECTED_${phase.toUpperCase()}`, 500);
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function allowedOrigins(): Set<string> {
  const configured = [
    Deno.env.get("ALLOWED_ORIGINS"),
    Deno.env.get("ALLOWED_ORIGIN"),
    Deno.env.get("APP_URL"),
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const allowed = new Set(configured);
  for (const origin of localDevOrigins) allowed.add(origin);
  return allowed;
}

function requestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = allowedOrigins();
  return allowed.has("*") || allowed.has(normalizeOrigin(origin));
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins();
  const normalized = origin ? normalizeOrigin(origin) : "";
  return {
    "Access-Control-Allow-Origin": allowed.has("*")
      ? "*"
      : allowed.has(normalized)
      ? normalized
      : "null",
    "Access-Control-Allow-Headers": [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
    ].join(", "),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RequestProblem("IMPORT_REQUEST_ABORTED", 499);
}

function authorizationToken(request: Request): string {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ")) throw new RequestProblem("AUTHENTICATION_REQUIRED", 401);
  const token = authorization.slice(7).trim();
  if (!token) throw new RequestProblem("AUTHENTICATION_REQUIRED", 401);
  return token;
}

function validateJsonContentType(request: Request): void {
  const value = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (value !== "application/json") throw new RequestProblem("INVALID_IMPORT_CONTENT_TYPE", 415);
}

function checkedContentLength(request: Request): void {
  const header = request.headers.get("Content-Length");
  if (header === null || header.trim() === "") return;
  if (!/^[0-9]{1,10}$/.test(header.trim())) throw new RequestProblem("INVALID_CONTENT_LENGTH", 400);
  const byteLength = Number(header);
  if (!Number.isSafeInteger(byteLength)) throw new RequestProblem("INVALID_CONTENT_LENGTH", 400);
  if (byteLength > MAX_JSON_REQUEST_BYTES) throw new RequestProblem("REQUEST_TOO_LARGE", 413);
}

async function readRelayBody(request: Request): Promise<JsonObject> {
  if (!request.body) throw new RequestProblem("IMPORT_REQUEST_BODY_REQUIRED", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestProblem("REQUEST_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new RequestProblem("IMPORT_REQUEST_BODY_REQUIRED", 400);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestProblem("INVALID_IMPORT_JSON", 400);
  }
  if (!isJsonObject(parsed)) throw new RequestProblem("INVALID_IMPORT_ACTION", 400);
  return parsed;
}

function requireClosedKeys(value: JsonObject, allowed: readonly string[], code: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new RequestProblem(code, 422);
  }
}

function requiredText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string") throw new RequestProblem(code, 422);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new RequestProblem(code, 422);
  return normalized;
}

function requiredMode(value: unknown): ImportMode {
  if (value === "dry_run" || value === "commit") return value;
  throw new RequestProblem("INVALID_IMPORT_MODE", 422);
}

function requiredAction(value: unknown): RelayAction {
  if (value === "begin" || value === "chunk" || value === "finalize") return value;
  throw new RequestProblem("INVALID_IMPORT_ACTION", 422);
}

function requiredUuid(value: unknown): string {
  const candidate = requiredText(value, 64, "INVALID_IMPORT_BATCH_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)) {
    throw new RequestProblem("INVALID_IMPORT_BATCH_ID", 422);
  }
  return candidate;
}

function requiredChecksum(value: unknown, code: string): string {
  const candidate = requiredText(value, 64, code).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(candidate)) throw new RequestProblem(code, 422);
  return candidate;
}

function requiredInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RequestProblem(code, 422);
  }
  return value;
}

function requiredSourceFileName(value: unknown): string {
  const fileName = requiredText(value, 255, "INVALID_SOURCE_FILE_NAME");
  if (/[\\/\u0000]/u.test(fileName) || !/\.xlsx$/iu.test(fileName)) {
    throw new RequestProblem("INVALID_SOURCE_FILE_NAME", 422);
  }
  return fileName;
}

function expectedCounts(value: unknown): ExpectedCounts {
  if (!isJsonObject(value)) throw new RequestProblem("INVALID_EXPECTED_COUNTS", 422);
  const keys = Object.keys(EXPECTED_COUNT_LIMITS) as (keyof typeof EXPECTED_COUNT_LIMITS)[];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new RequestProblem("INVALID_EXPECTED_COUNTS", 422);
  }
  const result = {} as ExpectedCounts;
  for (const key of keys) {
    result[key] = requiredInteger(value[key], 0, EXPECTED_COUNT_LIMITS[key], "INVALID_EXPECTED_COUNTS");
  }
  return result;
}

function assertBoundedJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new RequestProblem("IMPORT_CHUNK_NESTING_EXCEEDED", 422);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_CHARS) throw new RequestProblem("IMPORT_CHUNK_TEXT_TOO_LONG", 422);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
    for (const item of value) assertBoundedJson(item, depth + 1);
    return;
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_OBJECT_KEYS) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
    for (const [key, item] of entries) {
      if (key.length > 255) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
      assertBoundedJson(item, depth + 1);
    }
    return;
  }
  throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
}

function requiredChunk(value: unknown): ChunkPayload {
  if (!isJsonObject(value)) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
  requireClosedKeys(value, CHUNK_BUCKETS, "INVALID_IMPORT_CHUNK");
  const chunk = {} as ChunkPayload;
  let rowCount = 0;
  for (const bucket of CHUNK_BUCKETS) {
    const rows = value[bucket];
    if (!Array.isArray(rows)) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
    chunk[bucket] = rows.map((row) => {
      if (!isJsonObject(row)) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
      assertBoundedJson(row);
      return row;
    });
    rowCount += chunk[bucket].length;
  }
  if (rowCount < 1 || rowCount > MAX_CHUNK_TOTAL_ROWS) {
    throw new RequestProblem("INVALID_IMPORT_CHUNK_SIZE", 422);
  }
  return chunk;
}

function parseAction(value: JsonObject): BeginInput | ChunkInput | FinalizeInput {
  const action = requiredAction(value.action);
  if (action === "begin") {
    requireClosedKeys(value, ["action", "importMode", "sourceFileName", "sourceChecksum", "expectedCounts"], "INVALID_IMPORT_ACTION");
    return {
      action,
      importMode: requiredMode(value.importMode),
      sourceFileName: requiredSourceFileName(value.sourceFileName),
      sourceChecksum: requiredChecksum(value.sourceChecksum, "INVALID_SOURCE_CHECKSUM"),
      expectedCounts: expectedCounts(value.expectedCounts),
    };
  }
  if (action === "chunk") {
    requireClosedKeys(value, ["action", "importMode", "batchId", "chunkIndex", "chunk"], "INVALID_IMPORT_ACTION");
    if (value.importMode !== "dry_run") throw new RequestProblem("INVALID_CHUNK_IMPORT_MODE", 422);
    return {
      action,
      importMode: "dry_run",
      batchId: requiredUuid(value.batchId),
      chunkIndex: requiredInteger(value.chunkIndex, 0, MAX_CHUNK_INDEX, "INVALID_IMPORT_CHUNK_INDEX"),
      chunk: requiredChunk(value.chunk),
    };
  }
  if (action === "finalize") {
    requireClosedKeys(value, ["action", "importMode", "batchId", "materializeLimit"], "INVALID_IMPORT_ACTION");
    return {
      action,
      importMode: requiredMode(value.importMode),
      batchId: requiredUuid(value.batchId),
      materializeLimit: value.materializeLimit === undefined
        ? MAX_MATERIALIZE_LIMIT
        : requiredInteger(value.materializeLimit, 1, MAX_MATERIALIZE_LIMIT, "INVALID_MATERIALIZE_LIMIT"),
    };
  }
  throw new RequestProblem("INVALID_IMPORT_ACTION", 422);
}

/** Stable, key-sorted JSON used for the private SQL chunk receipt checksum. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isJsonObject(value)) throw new RequestProblem("INVALID_IMPORT_CHUNK", 422);
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
  return `{${entries.join(",")}}`;
}

function hexadecimal(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(value: string): Promise<string> {
  return hexadecimal(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function safeRpcErrorCode(error: unknown): string {
  const value = record(error).code;
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : "";
}

function safeDatabaseDiagnosticCode(code: string): string | null {
  if (/^[0-9A-Z]{5}$/.test(code)) return code;
  if (/^PGRST[0-9]{3}$/.test(code)) return code;
  return null;
}

function hasAdminPermissionMarker(error: unknown): boolean {
  return record(error).message === "ADMIN_PERMISSION_REQUIRED";
}

function rpcProblem(scope: "BEGIN" | "AUTHORIZE" | "CHUNK" | "FINALIZE", error: unknown): RequestProblem {
  const code = safeRpcErrorCode(error);
  if (code === "42501" || code === "ADMIN_PERMISSION_REQUIRED" || hasAdminPermissionMarker(error)) {
    return new RequestProblem("IMPORT_PERMISSION_REQUIRED", 403);
  }
  if (code === "PGRST202" || code === "42883" || code === "42P01") {
    return new RequestProblem(`IMPORT_${scope}_RPC_UNAVAILABLE`, 503);
  }
  if (code === "P0002") return new RequestProblem("IMPORT_BATCH_NOT_FOUND", 404);
  if (code === "23505") return new RequestProblem(`IMPORT_${scope}_CONFLICT`, 409);
  if (code === "23503") return new RequestProblem(`IMPORT_${scope}_REFERENCE_INVALID`, 409);
  if (code === "22007" || code === "22023" || code === "23514") {
    return new RequestProblem(`IMPORT_${scope}_VALIDATION_FAILED`, 422);
  }
  const databaseCode = safeDatabaseDiagnosticCode(code);
  if (databaseCode) return new RequestProblem(`IMPORT_${scope}_DATABASE_ERROR_${databaseCode}`, 422);
  return new RequestProblem(`IMPORT_${scope}_FAILED`, 422);
}

function safeBatchSummary(value: unknown): JsonObject {
  const source = record(value);
  const allowed = new Set([
    "batchId", "batch_id", "status", "importMode", "import_mode", "replayed", "resumable",
    "expectedSourcePostCount", "expectedEventCount", "expectedParticipantCount", "expectedEventSourceCount",
    "expectedCardCount", "expectedQcCount", "expectedNoCardEventCount", "sourcePostCount", "eventCount",
    "participantCount", "eventSourceCount", "cardCount", "qcCount", "noCardEventCount", "chunkCount",
    "chunkIndex", "materializedCardCount", "failedCardCount", "withheldCardCount", "failedChunkCount",
    "materializedInCall", "remainingCardCount", "dryRunCompletedAt", "completedAt", "lastErrorCode",
  ]);
  const nestedCounts = new Set(["expectedCounts", "actualCounts"]);
  const result: JsonObject = {};
  for (const [key, valueItem] of Object.entries(source)) {
    if (!allowed.has(key)) continue;
    if (typeof valueItem === "string" && valueItem.length <= 120) result[key] = valueItem;
    if (typeof valueItem === "number" && Number.isFinite(valueItem)) result[key] = valueItem;
    if (typeof valueItem === "boolean") result[key] = valueItem;
  }
  for (const key of nestedCounts) {
    const nested = record(source[key]);
    const safeNested: JsonObject = {};
    for (const [nestedKey, nestedValue] of Object.entries(nested)) {
      if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) safeNested[nestedKey] = nestedValue;
    }
    if (Object.keys(safeNested).length > 0) result[key] = safeNested;
  }
  return result;
}

function abortAwareFetch(signal: AbortSignal): typeof fetch {
  return (input, init) => {
    ensureNotAborted(signal);
    return fetch(input, { ...init, signal });
  };
}

function createCallerClient(supabaseUrl: string, publishableKey: string, accessToken: string, signal: AbortSignal) {
  return createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: abortAwareFetch(signal),
    },
  });
}

function createServerClient(supabaseUrl: string, serverKey: string, signal: AbortSignal) {
  return createClient(supabaseUrl, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: supabaseServerKeyHeaders(serverKey),
      fetch: abortAwareFetch(signal),
    },
  });
}

async function assertImportPermission(
  callerClient: ReturnType<typeof createCallerClient>,
  batchId: string,
): Promise<void> {
  // This caller-scoped facade enforces both auth.uid() and the exact
  // `zagulyaky.import` permission before the service key can submit a chunk
  // or ask for private-ledger materialization.
  const { error } = await callerClient.rpc(
    "admin_get_zagulyaky_tabular_event_import_v1",
    { p_batch_id: batchId },
  );
  if (error) throw rpcProblem("AUTHORIZE", error);
}

async function runRelay(request: Request): Promise<Response> {
  let phase: RelayPhase = "preflight";

  try {
    if (!requestOriginAllowed(request)) return json(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
    if (request.method !== "POST") return json(request, { error: "METHOD_NOT_ALLOWED" }, 405);
    validateJsonContentType(request);
    checkedContentLength(request);
    ensureNotAborted(request.signal);

    phase = "auth";
    const accessToken = authorizationToken(request);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
    const publishableKey = resolveSupabasePublishableKey({
      SUPABASE_PUBLISHABLE_KEY: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
      SUPABASE_PUBLISHABLE_KEYS: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
      SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
    });
    const serverKey = resolveSupabaseSecretKey({
      SUPABASE_SECRET_KEY: Deno.env.get("SUPABASE_SECRET_KEY"),
      SUPABASE_SECRET_KEYS: Deno.env.get("SUPABASE_SECRET_KEYS"),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    });
    if (!supabaseUrl || !publishableKey || !serverKey) {
      throw new RequestProblem("IMPORT_SERVICE_NOT_CONFIGURED", 503);
    }
    const callerClient = createCallerClient(supabaseUrl, publishableKey, accessToken, request.signal);
    const { data: userData, error: userError } = await callerClient.auth.getUser(accessToken);
    if (userError || !userData.user) throw new RequestProblem("AUTHENTICATION_REQUIRED", 401);
    ensureNotAborted(request.signal);

    phase = "body";
    const input = parseAction(await readRelayBody(request));
    ensureNotAborted(request.signal);

    if (input.action === "begin") {
      phase = "begin";
      // This caller-scoped definer RPC itself checks `zagulyaky.import`.
      const { data, error } = await callerClient.rpc(
        "admin_begin_zagulyaky_tabular_event_import_v1",
        {
          p_source_file_name: input.sourceFileName,
          p_source_checksum: input.sourceChecksum,
          p_expected_counts: input.expectedCounts,
          p_import_mode: input.importMode,
        },
      );
      if (error) throw rpcProblem("BEGIN", error);
      return json(request, { accepted: true, action: input.action, batch: safeBatchSummary(data) }, 202);
    }

    // The direct service facades remain service-role only. Recheck the
    // authenticated caller's import permission for every protected action,
    // including retries and separate browser sessions.
    await assertImportPermission(callerClient, input.batchId);
    ensureNotAborted(request.signal);
    const serverClient = createServerClient(supabaseUrl, serverKey, request.signal);

    if (input.action === "chunk") {
      phase = "chunk";
      const canonicalChunk = canonicalJson(input.chunk);
      if (new TextEncoder().encode(canonicalChunk).byteLength > MAX_CHUNK_JSON_BYTES) {
        throw new RequestProblem("IMPORT_CHUNK_TOO_LARGE", 413);
      }
      const calculatedChecksum = await sha256Text(canonicalChunk);
      const { data, error } = await serverClient.rpc(
        "service_ingest_zagulyaky_tabular_event_import_chunk_v1",
        {
          p_batch_id: input.batchId,
          p_chunk: input.chunk,
          p_import_mode: input.importMode,
          p_chunk_index: input.chunkIndex,
          p_chunk_checksum: calculatedChecksum,
        },
      );
      if (error) throw rpcProblem("CHUNK", error);
      return json(request, {
        accepted: true,
        action: input.action,
        chunkChecksum: calculatedChecksum,
        batch: safeBatchSummary(data),
      }, 202);
    }

    phase = "finalize";
    // Exactly one bounded materialization call per browser request. For a
    // commit, the browser resumes deterministically while remainingCardCount
    // is non-zero; dry-run needs one call after its last accepted chunk.
    const { data, error } = await serverClient.rpc(
      "service_finalize_zagulyaky_tabular_event_import_v1",
      {
        p_batch_id: input.batchId,
        p_import_mode: input.importMode,
        p_materialize_limit: input.materializeLimit,
      },
    );
    if (error) throw rpcProblem("FINALIZE", error);
    return json(request, { accepted: true, action: input.action, batch: safeBatchSummary(data) }, 202);
  } catch (error) {
    const problem = error instanceof RequestProblem
      ? error
      : error instanceof DOMException && error.name === "AbortError"
      ? new RequestProblem("IMPORT_REQUEST_ABORTED", 499)
      : unexpectedImportProblem(phase);
    // Never log JSON action data, raw post text, Facebook/private URLs,
    // database messages, access tokens, stacks, or arbitrary exception data.
    console.error({ code: problem.code, phase, errorName: safeErrorName(error) });
    return json(request, { error: problem.code }, problem.status);
  }
}

Deno.serve(runRelay);
