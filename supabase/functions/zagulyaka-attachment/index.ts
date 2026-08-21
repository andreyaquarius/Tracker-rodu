import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../_shared/supabaseApiKeys.ts";

const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const SIGNED_URL_SECONDS = 300;

type AttachmentAction = "delivery" | "preview" | "publish" | "revoke";
type JsonObject = Record<string, unknown>;
type PublicationPreparation = {
  attachmentId: string;
  privateBucket: "zagulyaky-private";
  privatePath: string;
  publicBucket: "zagulyaky-public";
  publicPath: string;
  mimeType: string;
  publicationState: "ready" | "uploaded" | "published";
  targetExists: boolean;
};
type CleanupTask = {
  taskId: string;
  storageBucket: "zagulyaky-public";
  storagePath: string;
  claimToken: string;
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
  const configured = [Deno.env.get("ALLOWED_ORIGIN"), Deno.env.get("APP_URL")]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const result = new Set(configured);
  for (const origin of localDevOrigins) result.add(origin);
  if (!result.size) result.add("*");
  return result;
}

function corsHeaders(request: Request): HeadersInit {
  const requestOrigin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const origins = allowedOrigins();
  const allowedOrigin = origins.has("*")
    ? "*"
    : requestOrigin && origins.has(requestOrigin)
      ? requestOrigin
      : [...origins][0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

function accessToken(request: Request): string {
  const header = request.headers.get("Authorization")?.trim() ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

async function requestPayload(request: Request): Promise<{ action: AttachmentAction; attachmentId: string } | null> {
  try {
    const payload = record(await request.json());
    const action = text(payload.action);
    const attachmentId = text(payload.attachmentId);
    if (!isUuid(attachmentId) || !["delivery", "preview", "publish", "revoke"].includes(action)) return null;
    return { action: action as AttachmentAction, attachmentId };
  } catch {
    return null;
  }
}

function rpcErrorMessage(error: unknown): string {
  const message = text(record(error).message);
  if (/^(ADMIN_PERMISSION_REQUIRED|ZAGULYAKA_ATTACHMENT_NOT_FOUND|ATTACHMENT_ALREADY_PUBLISHED|ATTACHMENT_RECORD_NOT_PUBLIC|ATTACHMENT_NOT_PUBLISHED|PUBLIC_ATTACHMENT_OBJECT_NOT_FOUND|PUBLIC_ATTACHMENT_CLEANUP_PENDING)$/i.test(message)) {
    return message;
  }
  return "ATTACHMENT_OPERATION_FAILED";
}

function publicationPreparation(value: unknown): PublicationPreparation | null {
  const prepared = record(value);
  const attachmentId = text(prepared.attachmentId);
  const privateBucket = text(prepared.privateBucket);
  const privatePath = text(prepared.privatePath);
  const publicBucket = text(prepared.publicBucket);
  const publicPath = text(prepared.publicPath);
  const mimeType = text(prepared.mimeType);
  const publicationState = text(prepared.publicationState);
  if (!isUuid(attachmentId)
    || privateBucket !== "zagulyaky-private"
    || !privatePath
    || publicBucket !== "zagulyaky-public"
    || !publicPath
    || !mimeType
    || !["ready", "uploaded", "published"].includes(publicationState)) {
    return null;
  }
  return {
    attachmentId,
    privateBucket,
    privatePath,
    publicBucket,
    publicPath,
    mimeType,
    publicationState: publicationState as PublicationPreparation["publicationState"],
    targetExists: prepared.targetExists === true,
  };
}

function cleanupTask(value: unknown): CleanupTask | null {
  const task = record(value);
  const taskId = text(task.taskId);
  const storageBucket = text(task.storageBucket);
  const storagePath = text(task.storagePath);
  const claimToken = text(task.claimToken);
  if (!isUuid(taskId) || !isUuid(claimToken)
    || storageBucket !== "zagulyaky-public"
    || !isPublicDerivativePath(storagePath)) {
    return null;
  }
  return { taskId, storageBucket, storagePath, claimToken };
}

function isPublicDerivativePath(storagePath: string): boolean {
  if (storagePath.length < 3 || storagePath.length > 500 || storagePath.includes("..")) return false;
  const segments = storagePath.split("/");
  return segments.length >= 4
    && segments.every(Boolean)
    && segments[0] === "catalogue"
    && isUuid(segments[1])
    && isUuid(segments[2]);
}

async function preparePublication(
  callerClient: ReturnType<typeof createClient>,
  attachmentId: string,
): Promise<{ preparation: PublicationPreparation | null; error: unknown | null }> {
  const { data, error } = await callerClient.rpc("admin_prepare_zagulyaka_attachment_publication_v2", {
    p_attachment_id: attachmentId,
  });
  return { preparation: error ? null : publicationPreparation(data), error };
}

async function attemptQueuedPublicCleanup(
  adminClient: ReturnType<typeof createClient>,
  cleanupTaskId: string,
): Promise<{ completed: boolean; pending: boolean; failed: boolean }> {
  const { data: claimData, error: claimError } = await adminClient.rpc(
    "claim_zagulyaky_storage_cleanup_task_v1",
    { p_task_id: cleanupTaskId },
  );
  if (claimError) return { completed: false, pending: true, failed: false };

  const claimed = record(claimData);
  const task = cleanupTask(claimed.task);
  if (!task) {
    const completed = text(claimed.status) === "completed";
    const failed = text(claimed.status) === "failed";
    return { completed, pending: !completed, failed };
  }

  let removed = false;
  try {
    const { error } = await adminClient.storage.from(task.storageBucket).remove([task.storagePath]);
    if (!error) removed = true;
  } catch {
    // The durable finalizer records only a stable error code. Do not persist a
    // provider message, which can disclose a private object path.
  }

  const { data: finalizationData, error: finalizationError } = await adminClient.rpc(
    "finalize_zagulyaky_storage_cleanup_v1",
    {
      p_task_id: task.taskId,
      p_claim_token: task.claimToken,
      p_removed: removed,
      p_error: removed ? "" : "ZAGULYAKY_STORAGE_DELETE_FAILED",
    },
  );
  if (finalizationError) return { completed: false, pending: true, failed: false };
  const status = text(record(finalizationData).status);
  const completed = status === "completed";
  return { completed, pending: !completed, failed: status === "failed" };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "METHOD_NOT_ALLOWED" }, 405);

  const payload = await requestPayload(request);
  if (!payload) return json(request, { error: "INVALID_ATTACHMENT_REQUEST" }, 400);

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
    return json(request, { error: "ATTACHMENT_FUNCTION_NOT_CONFIGURED" }, 503);
  }

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: supabaseServerKeyHeaders(secretKey) },
  });

  try {
    if (payload.action === "delivery") {
      // This is a service-only lookup. Anonymous callers receive only the
      // short-lived signed URL below, never a Storage bucket/path from an RPC.
      const { data, error } = await adminClient.rpc("service_get_public_zagulyaka_attachment_delivery_v1", {
        p_attachment_id: payload.attachmentId,
      });
      if (error) return json(request, { error: "ATTACHMENT_NOT_AVAILABLE" }, 404);
      const delivery = record(data);
      const bucket = text(delivery.bucket);
      const path = text(delivery.path);
      if (bucket !== "zagulyaky-public" || !isPublicDerivativePath(path)) {
        return json(request, { error: "ATTACHMENT_NOT_AVAILABLE" }, 404);
      }
      const { data: signed, error: signedError } = await adminClient.storage
        .from(bucket)
        .createSignedUrl(path, SIGNED_URL_SECONDS);
      if (signedError || !signed?.signedUrl) return json(request, { error: "ATTACHMENT_NOT_AVAILABLE" }, 404);
      return json(request, { url: signed.signedUrl, expiresIn: SIGNED_URL_SECONDS });
    }

    const token = accessToken(request);
    if (!token) return json(request, { error: "AUTH_REQUIRED" }, 401);
    const callerClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: caller, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !caller.user) return json(request, { error: "AUTH_REQUIRED" }, 401);

    if (payload.action === "preview") {
      const { data, error } = await callerClient.rpc("admin_get_zagulyaka_attachment_review_v1", {
        p_attachment_id: payload.attachmentId,
      });
      if (error) return json(request, { error: rpcErrorMessage(error) }, 403);
      const review = record(data);
      const bucket = text(review.privateBucket);
      const path = text(review.privatePath);
      if (bucket !== "zagulyaky-private" || !path || path.includes("..")) {
        return json(request, { error: "ATTACHMENT_NOT_AVAILABLE" }, 404);
      }
      const { data: signed, error: signedError } = await adminClient.storage
        .from(bucket)
        .createSignedUrl(path, SIGNED_URL_SECONDS);
      if (signedError || !signed?.signedUrl) return json(request, { error: "ATTACHMENT_NOT_AVAILABLE" }, 404);
      return json(request, {
        url: signed.signedUrl,
        expiresIn: SIGNED_URL_SECONDS,
        fileName: text(review.fileName),
        mimeType: text(review.mimeType),
      });
    }

    if (payload.action === "publish") {
      let { preparation, error: prepareError } = await preparePublication(callerClient, payload.attachmentId);
      if (prepareError || !preparation) {
        return json(request, { error: prepareError ? rpcErrorMessage(prepareError) : "ATTACHMENT_OPERATION_FAILED" }, 409);
      }
      if (preparation.publicationState === "published") {
        return json(request, { published: true, attachmentId: preparation.attachmentId, recovered: true });
      }

      if (!preparation.targetExists) {
        const { data: original, error: downloadError } = await adminClient.storage
          .from(preparation.privateBucket)
          .download(preparation.privatePath);
        if (downloadError || !original) return json(request, { error: "ATTACHMENT_NOT_AVAILABLE" }, 404);
        const { error: uploadError } = await adminClient.storage
          .from(preparation.publicBucket)
          .upload(preparation.publicPath, original, {
            cacheControl: "3600",
            contentType: preparation.mimeType,
            upsert: false,
          });
        if (uploadError) {
          // The generation-scoped upload can have won before the request failed.
          // Re-read the authoritative state instead of removing a target whose
          // next retry may be able to complete publication.
          const rechecked = await preparePublication(callerClient, payload.attachmentId);
          if (rechecked.error || !rechecked.preparation) {
            return json(request, { error: rechecked.error ? rpcErrorMessage(rechecked.error) : "ATTACHMENT_COPY_FAILED" }, 502);
          }
          preparation = rechecked.preparation;
          if (preparation.publicationState !== "published" && !preparation.targetExists) {
            return json(request, { error: "ATTACHMENT_COPY_FAILED" }, 502);
          }
        }
      }

      if (preparation.publicationState === "published") {
        return json(request, { published: true, attachmentId: preparation.attachmentId, recovered: true });
      }

      const { error: completeError } = await callerClient.rpc(
        "admin_complete_zagulyaka_attachment_publication_v2",
        { p_attachment_id: preparation.attachmentId, p_public_path: preparation.publicPath },
      );
      if (!completeError) return json(request, { published: true, attachmentId: preparation.attachmentId });

      const authoritative = await preparePublication(callerClient, payload.attachmentId);
      if (authoritative.preparation?.publicationState === "published") {
        return json(request, { published: true, attachmentId: authoritative.preparation.attachmentId, recovered: true });
      }
      // A failed/ambiguous complete never deletes the generation-scoped object:
      // it may already be committed as public, and retaining it makes retry
      // safe if the DB commit did not finish.
      return json(request, {
        error: authoritative.error ? rpcErrorMessage(authoritative.error) : "ATTACHMENT_PUBLICATION_PENDING_RETRY",
        attachmentId: payload.attachmentId,
      }, authoritative.error ? 409 : 202);
    }

    const { data: revokedData, error: revokeError } = await callerClient.rpc(
      "admin_revoke_zagulyaka_attachment_publication_v2",
      { p_attachment_id: payload.attachmentId },
    );
    if (revokeError) return json(request, { error: rpcErrorMessage(revokeError) }, 409);
    const cleanupTaskId = text(record(revokedData).cleanupTaskId);
    if (!isUuid(cleanupTaskId)) return json(request, { error: "ATTACHMENT_REVOKE_CLEANUP_NOT_QUEUED" }, 500);

    const cleanup = await attemptQueuedPublicCleanup(adminClient, cleanupTaskId);
    return json(request, {
      revoked: true,
      attachmentId: payload.attachmentId,
      cleanupPending: cleanup.pending,
      cleanupFailed: cleanup.failed,
    }, cleanup.pending ? 202 : 200);
  } catch {
    return json(request, { error: "ATTACHMENT_OPERATION_FAILED" }, 500);
  }
});
