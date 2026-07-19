import { createClient } from "npm:@supabase/supabase-js@2";
import {
  failGedcomExport,
  parseClaimedGedcomExport,
  processClaimedGedcomExport,
  standardGedcomStorageUpload,
  type GedcomExportCompletedFile,
  type GedcomExportJob,
  type SupabaseServiceClient,
} from "../_shared/gedcomExportProcessor.ts";
import {
  isModernSupabaseSecretKey,
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
} from "../_shared/supabaseApiKeys.ts";

const EDGE_PERSON_LIMIT = 5_000;

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

type ExportStatus = GedcomExportJob & {
  phase: string;
  estimatedPersonCount: number;
  personCount: number;
  familyCount: number;
  warningCount: number;
  storagePath: string;
  fileName: string;
  fileSize: number;
  downloadUrl: string;
  expiresAt: string;
  emailStatus: string;
  emailError: string;
};

type CleanupJob = {
  jobId: string;
  storageBucket: string;
  storagePath: string;
};

const EMAIL_BATCH_SIZE = 20;
const CLEANUP_BATCH_SIZE = 100;
const EMAIL_CONCURRENCY = 4;
const CLEANUP_CONCURRENCY = 10;

const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function corsHeaders(request: Request): HeadersInit {
  const configured = [Deno.env.get("ALLOWED_ORIGIN"), Deno.env.get("APP_URL")]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const allowed = new Set(configured);
  for (const origin of localDevOrigins) allowed.add(origin);
  if (!allowed.size) allowed.add("*");
  const origin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const selected = allowed.has("*") ? "*" : allowed.has(origin) ? origin : [...allowed][0] ?? "*";
  return {
    "Access-Control-Allow-Origin": selected,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
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

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeEqual(left: string, right: string): boolean {
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

function isTrustedServerRequest(request: Request, serverKey: string, cronSecret: string): boolean {
  const bearer = bearerToken(request);
  const apiKey = request.headers.get("apikey")?.trim() ?? "";
  const headerCronSecret = request.headers.get("x-cron-secret")?.trim() ?? "";
  const trustedCron = Boolean(cronSecret) && (
    Boolean(bearer) && safeEqual(bearer, cronSecret)
    || Boolean(headerCronSecret) && safeEqual(headerCronSecret, cronSecret)
  );
  const trustedModernKey = Boolean(apiKey) && safeEqual(apiKey, serverKey);
  const trustedLegacyKey = !isModernSupabaseSecretKey(serverKey)
    && Boolean(bearer)
    && safeEqual(bearer, serverKey);
  return trustedCron || trustedModernKey || trustedLegacyKey;
}

function parseExportStatus(value: unknown): ExportStatus | null {
  const unwrapped = Array.isArray(value) ? value[0] : value;
  if (!unwrapped || typeof unwrapped !== "object") return null;
  const row = unwrapped as Record<string, unknown>;
  const valueOf = (camel: string, snake: string) => row[camel] ?? row[snake];
  const parsed: ExportStatus = {
    jobId: text(valueOf("jobId", "job_id")),
    projectId: text(valueOf("projectId", "project_id")),
    treeId: text(valueOf("treeId", "tree_id")),
    treeTitle: text(valueOf("treeTitle", "tree_title")),
    requestedBy: text(valueOf("requestedBy", "requested_by")),
    requesterEmail: text(valueOf("requesterEmail", "requester_email")),
    status: text(valueOf("status", "status")),
    attempts: Number(valueOf("attempts", "attempts")) || 0,
    phase: text(valueOf("phase", "phase")),
    estimatedPersonCount: Number(valueOf("estimatedPersonCount", "estimated_person_count")) || 0,
    personCount: Number(valueOf("personCount", "person_count")) || 0,
    familyCount: Number(valueOf("familyCount", "family_count")) || 0,
    warningCount: Number(valueOf("warningCount", "warning_count")) || 0,
    storagePath: text(valueOf("storagePath", "storage_path")),
    fileName: text(valueOf("fileName", "file_name")),
    fileSize: Number(valueOf("fileSize", "file_size")) || 0,
    downloadUrl: text(valueOf("downloadUrl", "download_url")),
    expiresAt: text(valueOf("expiresAt", "expires_at")),
    emailStatus: text(valueOf("emailStatus", "email_status")),
    emailError: text(valueOf("emailError", "email_error")),
  };
  return parsed.jobId && parsed.projectId && parsed.treeId ? parsed : null;
}

async function readStatus(client: SupabaseServiceClient, jobId: string): Promise<ExportStatus | null> {
  const { data, error } = await client.rpc("get_gedcom_export_status", {
    target_job_id: jobId,
  });
  if (error) throw error;
  return parseExportStatus(data);
}

async function estimatedPersonCount(client: SupabaseServiceClient, status: ExportStatus): Promise<number> {
  if (status.personCount > 0) return status.personCount;
  if (status.estimatedPersonCount > 0) return status.estimatedPersonCount;
  const result = await client.from("persons")
    .select("id", { count: "exact", head: true })
    .eq("project_id", status.projectId);
  if (result.error) throw result.error;
  return Number(result.count) || 0;
}

async function claimTargetedJob(client: SupabaseServiceClient, jobId: string): Promise<GedcomExportJob | null> {
  const { data, error } = await client.rpc("claim_gedcom_export", {
    target_job_id: jobId,
  });
  if (error) throw error;
  return parseClaimedGedcomExport(data);
}

async function processSmallExport(
  client: SupabaseServiceClient,
  job: GedcomExportJob,
): Promise<void> {
  try {
    await processClaimedGedcomExport(
      client,
      job,
      (input) => standardGedcomStorageUpload(client, input),
    );
  } catch (error) {
    console.error("GEDCOM export worker failed", { jobId: job.jobId, error });
    await failGedcomExport(client, job.jobId, job.attempts, error);
    return;
  }

  // Generation is already durable and complete. Email transport or its audit
  // RPC must never roll the export back to a failed generation state.
  try {
    // Claiming rechecks current project access and deletion state before any
    // signed link is sent. It also fences duplicate delivery attempts.
    await deliverClaimedEmails(client);
  } catch (error) {
    console.error("GEDCOM export completed but email status could not be recorded", {
      jobId: job.jobId,
      error,
    });
  }
}

async function deliverPendingEmail(
  client: SupabaseServiceClient,
  status: ExportStatus,
): Promise<void> {
  if (status.status !== "completed" || status.emailStatus === "sent") return;
  const completed: GedcomExportCompletedFile = {
    jobId: status.jobId,
    storagePath: status.storagePath,
    fileName: status.fileName || "family-tree.ged",
    fileSize: status.fileSize,
    personCount: status.personCount,
    familyCount: status.familyCount,
    warningCount: status.warningCount,
    downloadUrl: status.downloadUrl,
    expiresAt: status.expiresAt,
  };
  await deliverExportEmail(client, status, completed);
}

async function deliverExportEmail(
  client: SupabaseServiceClient,
  job: GedcomExportJob,
  completed: GedcomExportCompletedFile,
): Promise<void> {
  let delivered = false;
  let deliveryError = "";
  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim() ?? "";
    const from = Deno.env.get("GEDCOM_EXPORT_EMAIL_FROM")?.trim()
      || Deno.env.get("TASK_REMINDER_EMAIL_FROM")?.trim()
      || Deno.env.get("ANNOUNCEMENT_EMAIL_FROM")?.trim()
      || Deno.env.get("INVITATION_EMAIL_FROM")?.trim()
      || Deno.env.get("RESEND_FROM_EMAIL")?.trim()
      || "";
    if (!resendApiKey || !from) {
      throw new Error("RESEND_API_KEY or GEDCOM_EXPORT_EMAIL_FROM is not configured.");
    }
    if (!job.requesterEmail || !completed.downloadUrl) {
      throw new Error("GEDCOM export email or download URL is missing.");
    }
    const treeTitle = sanitizeEmailTitle(job.treeTitle);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `gedcom-export:${job.jobId}`,
      },
      body: JSON.stringify({
        from,
        to: [job.requesterEmail],
        subject: `GEDCOM-файл «${treeTitle}» готовий`,
        html: emailHtml(treeTitle, completed),
        text: `GEDCOM-файл «${treeTitle}» готовий. Завантажити: ${completed.downloadUrl}\nПосилання чинне 7 днів.`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    delivered = true;
  } catch (error) {
    deliveryError = error instanceof Error ? error.message : String(error);
    console.error("GEDCOM export email delivery failed", { jobId: job.jobId, error: deliveryError });
  }

  const { error: recordError } = await client.rpc("record_gedcom_export_email", {
    target_job_id: job.jobId,
    target_sent: delivered,
    target_error: delivered ? null : deliveryError.slice(0, 2_000),
  });
  if (recordError) throw recordError;
}

function sanitizeEmailTitle(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(normalized || "Родове дерево").slice(0, 160).join("");
}

function emailHtml(treeTitle: string, completed: GedcomExportCompletedFile): string {
  const title = escapeHtml(treeTitle);
  const url = escapeHtml(completed.downloadUrl);
  return `<!doctype html><html lang="uk"><body style="font-family:Arial,sans-serif;color:#173d38">
    <h2>GEDCOM-файл готовий</h2>
    <p>Експорт дерева <strong>${title}</strong> завершено.</p>
    <p><a href="${url}" style="display:inline-block;padding:12px 18px;background:#075e54;color:#fff;text-decoration:none;border-radius:8px">Завантажити GEDCOM</a></p>
    <p>Файл містить ${completed.personCount.toLocaleString("uk-UA")} осіб. Посилання чинне 7 днів.</p>
  </body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rpcJobs(value: unknown): unknown[] {
  const unwrapped = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!unwrapped || typeof unwrapped !== "object") return [];
  const jobs = (unwrapped as Record<string, unknown>).jobs;
  return Array.isArray(jobs) ? jobs : [];
}

function parseCleanupJob(value: unknown): CleanupJob | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const parsed = {
    jobId: text(row.jobId ?? row.job_id),
    storageBucket: text(row.storageBucket ?? row.storage_bucket) || "gedcom-exports",
    storagePath: text(row.storagePath ?? row.storage_path),
  };
  return parsed.jobId && parsed.storagePath ? parsed : null;
}

async function runInBatches<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < values.length; index += concurrency) {
    await Promise.all(values.slice(index, index + concurrency).map(async (value) => {
      try {
        await worker(value);
      } catch (error) {
        console.error("GEDCOM export maintenance item failed", error);
      }
    }));
  }
}

async function deliverClaimedEmails(client: SupabaseServiceClient): Promise<void> {
  const { data, error } = await client.rpc("claim_gedcom_export_emails", {
    batch_size: EMAIL_BATCH_SIZE,
  });
  if (error) throw error;
  const jobs = rpcJobs(data)
    .map(parseExportStatus)
    .filter((job): job is ExportStatus => Boolean(job));
  await runInBatches(jobs, EMAIL_CONCURRENCY, (job) => deliverPendingEmail(client, job));
}

async function cleanupExpiredExports(client: SupabaseServiceClient): Promise<void> {
  const { data, error } = await client.rpc("cleanup_expired_gedcom_exports", {
    batch_size: CLEANUP_BATCH_SIZE,
  });
  if (error) throw error;
  const jobs = rpcJobs(data)
    .map(parseCleanupJob)
    .filter((job): job is CleanupJob => Boolean(job));
  await runInBatches(jobs, CLEANUP_CONCURRENCY, async (job) => {
    let removed = false;
    let cleanupError = "";
    try {
      const result = await client.storage.from(job.storageBucket).remove([job.storagePath]);
      if (result.error) throw result.error;
      removed = true;
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }

    const { error: finalizeError } = await client.rpc("finalize_gedcom_export_cleanup", {
      target_job_id: job.jobId,
      target_removed: removed,
      target_error: removed ? null : cleanupError.slice(0, 2_000),
    });
    if (finalizeError) throw finalizeError;
  });
}

async function runCronMaintenance(client: SupabaseServiceClient): Promise<void> {
  const results = await Promise.allSettled([
    deliverClaimedEmails(client),
    cleanupExpiredExports(client),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("GEDCOM export cron maintenance failed", result.reason);
    }
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

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
  const cronSecret = Deno.env.get("TASK_REMINDER_CRON_SECRET")?.trim() ?? "";
  if (!supabaseUrl || !publishableKey || !serverKey) {
    return json(request, { error: "Supabase function environment is incomplete." }, 500);
  }

  let body: { jobId?: unknown } = {};
  try {
    body = await request.json() as { jobId?: unknown };
  } catch {
    return json(request, { error: "A JSON body is required." }, 400);
  }
  const serverRequest = isTrustedServerRequest(request, serverKey, cronSecret);
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (jobId && !isUuid(jobId)) return json(request, { error: "A valid GEDCOM export jobId is required." }, 400);

  const adminClient = createClient(supabaseUrl, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as SupabaseServiceClient;

  let status: ExportStatus | null = null;
  if (!serverRequest) {
    const authorization = request.headers.get("Authorization")?.trim() ?? "";
    const accessToken = bearerToken(request);
    if (!authorization || !accessToken || !jobId) return json(request, { error: "Authentication required" }, 401);
    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: userResult, error: userError } = await userClient.auth.getUser(accessToken);
    if (userError || !userResult.user) return json(request, { error: "Authentication required" }, 401);
    try {
      status = await readStatus(userClient as unknown as SupabaseServiceClient, jobId);
    } catch (error) {
      const candidate = error as { code?: string; message?: string };
      return json(request, { error: candidate.message ?? "GEDCOM export access denied." }, candidate.code === "42501" ? 403 : 400);
    }
  } else if (jobId) {
    status = await readStatus(adminClient, jobId);
  }

  // Queue generation and all large jobs belong to the Node runner. A trusted
  // no-job cron wake only retries durable email deliveries and removes expired
  // Storage objects; it never claims an unknown generation job into this Edge
  // isolate.
  if (!jobId) {
    if (!serverRequest) return json(request, { error: "Authentication required" }, 401);
    EdgeRuntime.waitUntil(runCronMaintenance(adminClient));
    return json(request, { accepted: true, mode: "maintenance", claimed: false }, 202);
  }
  if (!status) return json(request, { error: "GEDCOM export job was not found." }, 404);

  if (status.status === "completed") {
    EdgeRuntime.waitUntil(deliverClaimedEmails(adminClient));
    return json(request, { accepted: true, jobId, mode: "email" }, 202);
  }

  const personCount = await estimatedPersonCount(adminClient, status);
  if (personCount > EDGE_PERSON_LIMIT) {
    return json(request, {
      accepted: true,
      jobId,
      mode: "large-runner",
      claimed: false,
      personCount,
    }, 202);
  }

  const claimed = await claimTargetedJob(adminClient, jobId);
  if (!claimed) {
    return json(request, { accepted: true, jobId, mode: "already-running", claimed: false }, 202);
  }
  EdgeRuntime.waitUntil(processSmallExport(adminClient, claimed));
  return json(request, {
    accepted: true,
    jobId,
    mode: "edge",
    claimed: true,
    personCount,
  }, 202);
});
