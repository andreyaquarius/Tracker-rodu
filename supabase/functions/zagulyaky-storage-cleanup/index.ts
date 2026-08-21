import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../_shared/supabaseApiKeys.ts";

const LOCAL_DEV_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const USER_BATCH_LIMIT = 20;
const SERVICE_BATCH_LIMIT = 50;
const MAX_REQUEST_BYTES = 8 * 1024;

type CleanupAction =
  | "process_mine"
  | "process_queue"
  | "publish_derivative"
  | "revoke_derivative";
type JsonObject = Record<string, unknown>;
type CleanupTask = {
  taskId: string;
  storageBucket: "zagulyaky-private" | "zagulyaky-public";
  storagePath: string;
  claimToken: string;
};
type CleanupRequest = {
  action: CleanupAction;
  limit: number;
  attachmentId: string;
};
type PublicationPreparation = {
  attachmentId: string;
  recordId: string;
  privateBucket: string;
  privatePath: string;
  publicBucket: string;
  publicPath: string;
  fileName: string;
  mimeType: string;
  publicationState: "ready" | "uploaded" | "published";
  targetExists: boolean;
};

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
  const origins = new Set(configured);
  for (const origin of LOCAL_DEV_ORIGINS) origins.add(origin);
  if (!origins.size) origins.add("*");
  return origins;
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const origins = allowedOrigins();
  return origins.has("*") || origins.has(normalizeOrigin(origin));
}

function corsHeaders(request: Request): HeadersInit {
  const requestOrigin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const origins = allowedOrigins();
  const allowedOrigin = origins.has("*")
    ? "*"
    : requestOrigin && origins.has(requestOrigin)
      ? requestOrigin
      : "null";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
      "x-zagulyaky-cleanup-secret",
      "x-cron-secret",
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

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
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

function workerSecrets(): string[] {
  // The existing scheduled-worker secret is deliberately accepted alongside a
  // dedicated secret. A rollout may set both, while the checked-in workflow
  // keeps using TASK_REMINDER_CRON_SECRET until the new secret is provisioned.
  return [
    Deno.env.get("ZAGULYAKY_STORAGE_CLEANUP_SECRET")?.trim() ?? "",
    Deno.env.get("TASK_REMINDER_CRON_SECRET")?.trim() ?? "",
  ].filter((secret, index, all) => Boolean(secret) && all.indexOf(secret) === index);
}

function hasWorkerAuthorization(request: Request, allowedSecrets: string[]): boolean {
  const supplied = bearerToken(request)
    || request.headers.get("x-zagulyaky-cleanup-secret")?.trim()
    || request.headers.get("x-cron-secret")?.trim()
    || "";
  if (!supplied || !allowedSecrets.length) return false;
  // Do every comparison even if a previous value matches, so accepting the
  // fallback does not reveal which configured secret is in use by timing.
  let matches = false;
  for (const allowedSecret of allowedSecrets) {
    const equal = constantTimeEqual(supplied, allowedSecret);
    matches = matches || equal;
  }
  return matches;
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum
    ? value
    : null;
}

async function requestPayload(request: Request): Promise<CleanupRequest | null> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) return null;
  try {
    const payload = record(await request.json());
    const action = text(payload.action);
    if (action === "process_mine" || action === "process_queue") {
      const maximum = action === "process_mine" ? USER_BATCH_LIMIT : SERVICE_BATCH_LIMIT;
      const limit = boundedLimit(payload.limit, maximum, maximum);
      return limit === null ? null : { action, limit, attachmentId: "" };
    }
    if (action === "publish_derivative" || action === "revoke_derivative") {
      const attachmentId = text(payload.attachmentId);
      return isUuid(attachmentId) ? { action, attachmentId, limit: 0 } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function cleanupTask(value: unknown): CleanupTask | null {
  const item = record(value);
  const taskId = text(item.taskId);
  const storageBucket = text(item.storageBucket);
  const storagePath = text(item.storagePath);
  const claimToken = text(item.claimToken);
  if (!isUuid(taskId) || !isUuid(claimToken)) return null;
  if (storageBucket !== "zagulyaky-private" && storageBucket !== "zagulyaky-public") return null;
  if (!isExpectedCleanupPath(storageBucket, storagePath)) return null;
  return { taskId, storageBucket, storagePath, claimToken };
}

function isExpectedCleanupPath(
  storageBucket: CleanupTask["storageBucket"],
  storagePath: string,
): boolean {
  if (storagePath.length < 3 || storagePath.length > 500 || storagePath.includes("..")) return false;
  const segments = storagePath.split("/");
  if (segments.some((segment) => !segment)) return false;
  if (storageBucket === "zagulyaky-private") {
    // The SQL queue check binds these first two UUIDs to owner_id/record_id.
    return segments.length >= 3 && isUuid(segments[0]) && isUuid(segments[1]);
  }
  // Accept both legacy and generation-scoped public paths. SQL also binds the
  // record/attachment UUIDs to the queue row before this Edge code sees them.
  return segments.length >= 4
    && segments[0] === "catalogue"
    && isUuid(segments[1])
    && isUuid(segments[2]);
}

function cleanupTasks(value: unknown): CleanupTask[] {
  const tasks = record(value).tasks;
  return Array.isArray(tasks)
    ? tasks.flatMap((candidate) => {
      const parsed = cleanupTask(candidate);
      return parsed ? [parsed] : [];
    })
    : [];
}

function exhaustedCount(value: unknown): number {
  const raw = record(value).exhaustedCount;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

function publicationPreparation(value: unknown): PublicationPreparation | null {
  const item = record(value);
  const attachmentId = text(item.attachmentId);
  const recordId = text(item.recordId);
  const privateBucket = text(item.privateBucket);
  const privatePath = text(item.privatePath);
  const publicBucket = text(item.publicBucket);
  const publicPath = text(item.publicPath);
  const fileName = text(item.fileName);
  const mimeType = text(item.mimeType);
  const publicationState = text(item.publicationState);
  if (!isUuid(attachmentId) || !isUuid(recordId)) return null;
  if (!privateBucket || !privatePath || publicBucket !== "zagulyaky-public" || !publicPath || !fileName || !mimeType) {
    return null;
  }
  if (publicationState !== "ready" && publicationState !== "uploaded" && publicationState !== "published") {
    return null;
  }
  return {
    attachmentId,
    recordId,
    privateBucket,
    privatePath,
    publicBucket,
    publicPath,
    fileName,
    mimeType,
    publicationState,
    targetExists: item.targetExists === true,
  };
}

function completedStatus(value: unknown): string {
  return text(record(value).status);
}

async function authenticatedUserClient(
  request: Request,
  supabaseUrl: string,
  publishableKey: string,
): Promise<ReturnType<typeof createClient> | null> {
  const accessToken = bearerToken(request);
  if (!accessToken) return null;
  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data, error } = await userClient.auth.getUser(accessToken);
  return error || !data.user ? null : userClient;
}

async function processClaimedTasks(
  adminClient: ReturnType<typeof createClient>,
  tasks: CleanupTask[],
): Promise<{ completed: number; retryScheduled: number; failed: number; finalizationFailures: number }> {
  let completed = 0;
  let retryScheduled = 0;
  let failed = 0;
  let finalizationFailures = 0;

  for (const task of tasks) {
    let removed = false;
    let failureCode = "";
    try {
      const { error } = await adminClient.storage.from(task.storageBucket).remove([task.storagePath]);
      if (error) throw error;
      // Storage deletion is idempotent: a missing object is a successful
      // outcome for a task being retried after a worker timeout.
      removed = true;
    } catch {
      // Never write a raw Storage/provider error to the outbox: it can include
      // an object path or other private provider metadata.
      failureCode = "ZAGULYAKY_STORAGE_DELETE_FAILED";
    }

    const { data, error } = await adminClient.rpc("finalize_zagulyaky_storage_cleanup_v1", {
      p_task_id: task.taskId,
      p_claim_token: task.claimToken,
      p_removed: removed,
      p_error: failureCode,
    });
    if (error) {
      // If this write fails after Storage succeeded, the lease expires and a
      // later worker repeats the harmless remove then finalizes idempotently.
      finalizationFailures += 1;
      continue;
    }
    const status = completedStatus(data);
    if (status === "completed") completed += 1;
    else if (status === "failed") failed += 1;
    else retryScheduled += 1;
  }

  return { completed, retryScheduled, failed, finalizationFailures };
}

async function preparePublication(
  userClient: ReturnType<typeof createClient>,
  attachmentId: string,
): Promise<PublicationPreparation | null> {
  const { data, error } = await userClient.rpc("admin_prepare_zagulyaka_attachment_publication_v2", {
    p_attachment_id: attachmentId,
  });
  return error ? null : publicationPreparation(data);
}

async function publishDerivative(
  userClient: ReturnType<typeof createClient>,
  adminClient: ReturnType<typeof createClient>,
  attachmentId: string,
): Promise<{ body: JsonObject; status: number }> {
  let prepared = await preparePublication(userClient, attachmentId);
  if (!prepared) return { body: { error: "ATTACHMENT_PUBLICATION_PREPARE_FAILED" }, status: 409 };

  if (prepared.publicationState === "published") {
    return {
      body: { published: true, attachmentId: prepared.attachmentId, recovered: true },
      status: 200,
    };
  }

  if (!prepared.targetExists) {
    const { data: original, error: downloadError } = await adminClient.storage
      .from(prepared.privateBucket)
      .download(prepared.privatePath);
    if (downloadError || !original) {
      return { body: { error: "ATTACHMENT_SOURCE_NOT_AVAILABLE" }, status: 404 };
    }
    const { error: uploadError } = await adminClient.storage
      .from(prepared.publicBucket)
      .upload(prepared.publicPath, original, {
        cacheControl: "3600",
        contentType: prepared.mimeType,
        upsert: false,
      });
    if (uploadError) {
      // A previous attempt may have uploaded the generation-scoped target but lost
      // its response. Re-read instead of treating "already exists" as fatal.
      const rechecked = await preparePublication(userClient, attachmentId);
      if (!rechecked || (!rechecked.targetExists && rechecked.publicationState !== "published")) {
        return { body: { error: "ATTACHMENT_COPY_FAILED" }, status: 502 };
      }
      prepared = rechecked;
    }
  }

  if (prepared.publicationState === "published") {
    return {
      body: { published: true, attachmentId: prepared.attachmentId, recovered: true },
      status: 200,
    };
  }

  const { error: completeError } = await userClient.rpc("admin_complete_zagulyaka_attachment_publication_v2", {
    p_attachment_id: prepared.attachmentId,
    p_public_path: prepared.publicPath,
  });
  if (!completeError) {
    return { body: { published: true, attachmentId: prepared.attachmentId }, status: 200 };
  }

  // A network timeout can occur after the transaction committed. Re-read the
  // authoritative DB state before any cleanup decision. We deliberately do
  // not delete an unconfirmed generation-scoped target here either: retaining it
  // makes the next retry complete safely, and a confirmed public object is
  // never removed by this path.
  const authoritative = await preparePublication(userClient, attachmentId);
  if (authoritative?.publicationState === "published") {
    return {
      body: { published: true, attachmentId: authoritative.attachmentId, recovered: true },
      status: 200,
    };
  }
  return {
    body: { error: "ATTACHMENT_PUBLICATION_PENDING_RETRY", attachmentId },
    status: 202,
  };
}

async function revokeDerivative(
  userClient: ReturnType<typeof createClient>,
  adminClient: ReturnType<typeof createClient>,
  attachmentId: string,
): Promise<{ body: JsonObject; status: number }> {
  const { data: revokedData, error: revokeError } = await userClient.rpc(
    "admin_revoke_zagulyaka_attachment_publication_v2",
    { p_attachment_id: attachmentId },
  );
  if (revokeError) return { body: { error: "ATTACHMENT_REVOKE_FAILED" }, status: 409 };

  const revoked = record(revokedData);
  const cleanupTaskId = text(revoked.cleanupTaskId);
  if (!isUuid(cleanupTaskId)) {
    return { body: { error: "ATTACHMENT_REVOKE_CLEANUP_NOT_QUEUED" }, status: 500 };
  }

  const { data: claimData, error: claimError } = await adminClient.rpc(
    "claim_zagulyaky_storage_cleanup_task_v1",
    { p_task_id: cleanupTaskId },
  );
  if (claimError) {
    return {
      body: { revoked: true, attachmentId, cleanupPending: true },
      status: 202,
    };
  }

  const claimed = record(claimData);
  const task = cleanupTask(claimed.task);
  if (!task) {
    const cleanupFailed = text(claimed.status) === "failed";
    return {
      body: {
        revoked: true,
        attachmentId,
        cleanupPending: text(claimed.status) !== "completed",
        cleanupFailed,
      },
      status: text(claimed.status) === "completed" ? 200 : 202,
    };
  }

  const outcome = await processClaimedTasks(adminClient, [task]);
  const cleanupPending = outcome.completed !== 1;
  return {
    body: {
      revoked: true,
      attachmentId,
      cleanupPending,
      cleanupFailed: outcome.failed > 0,
      retryScheduled: outcome.retryScheduled,
      finalizationFailures: outcome.finalizationFailures,
    },
    status: cleanupPending ? 202 : 200,
  };
}

Deno.serve(async (request) => {
  if (!originAllowed(request)) return json(request, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "METHOD_NOT_ALLOWED" }, 405);

  const payload = await requestPayload(request);
  if (!payload) return json(request, { error: "INVALID_CLEANUP_REQUEST" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const publishableKey = resolveSupabasePublishableKey({
    SUPABASE_PUBLISHABLE_KEY: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
    SUPABASE_PUBLISHABLE_KEYS: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
  });
  const secretKey = resolveSupabaseSecretKey({
    SUPABASE_SECRET_KEY: Deno.env.get("SUPABASE_SECRET_KEY"),
    SUPABASE_SECRET_KEYS: Deno.env.get("SUPABASE_SECRET_KEYS"),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  });
  if (!supabaseUrl || !publishableKey || !secretKey) {
    return json(request, { error: "ZAGULYAKY_STORAGE_CLEANUP_NOT_CONFIGURED" }, 503);
  }

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: supabaseServerKeyHeaders(secretKey) },
  });

  if (payload.action === "process_queue") {
    if (!hasWorkerAuthorization(request, workerSecrets())) {
      return json(request, { error: "SERVICE_AUTH_REQUIRED" }, 401);
    }
    const { data, error } = await adminClient.rpc("claim_zagulyaky_storage_cleanup_queue_v1", {
      p_limit: payload.limit,
    });
    if (error) return json(request, { error: "CLEANUP_QUEUE_CLAIM_FAILED" }, 503);
    const tasks = cleanupTasks(data);
    const outcome = await processClaimedTasks(adminClient, tasks);
    return json(request, {
      action: payload.action,
      claimed: tasks.length,
      exhausted: exhaustedCount(data),
      completed: outcome.completed,
      retryScheduled: outcome.retryScheduled,
      failed: outcome.failed,
      finalizationFailures: outcome.finalizationFailures,
    });
  }

  const userClient = await authenticatedUserClient(request, supabaseUrl, publishableKey);
  if (!userClient) return json(request, { error: "AUTH_REQUIRED" }, 401);

  if (payload.action === "publish_derivative") {
    const outcome = await publishDerivative(userClient, adminClient, payload.attachmentId);
    return json(request, outcome.body, outcome.status);
  }
  if (payload.action === "revoke_derivative") {
    const outcome = await revokeDerivative(userClient, adminClient, payload.attachmentId);
    return json(request, outcome.body, outcome.status);
  }

  // The database claim function derives owner_id from auth.uid() and restricts
  // this action to `zagulyaky-private`; clients never provide paths or task ids.
  const { data, error } = await userClient.rpc("claim_my_zagulyaky_storage_cleanup_v1", {
    p_limit: payload.limit,
  });
  if (error) return json(request, { error: "MY_CLEANUP_CLAIM_FAILED" }, 409);
  const tasks = cleanupTasks(data);
  const outcome = await processClaimedTasks(adminClient, tasks);
  return json(request, {
    action: payload.action,
    claimed: tasks.length,
    exhausted: exhaustedCount(data),
    completed: outcome.completed,
    retryScheduled: outcome.retryScheduled,
    failed: outcome.failed,
    finalizationFailures: outcome.finalizationFailures,
  });
});
