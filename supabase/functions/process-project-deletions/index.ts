import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  isTrustedDeletionWorkerToken,
  requestDeletionContinuation,
} from "./continuation.ts";

const STORAGE_BUCKETS = ["project-backups", "project-attachments", "gedcom-exports"] as const;
const STORAGE_PAGE_SIZE = 1_000;
const STORAGE_REMOVE_BATCH_SIZE = 100;
const INITIAL_DATABASE_BATCH_SIZE = 250;
const MIN_DATABASE_BATCH_SIZE = 10;
const WORKER_BUDGET_MS = 85_000;

type ProjectDeletionJob = {
  jobId: string;
  projectId: string;
  status: "queued" | "running" | "failed" | "completed" | string;
  phase: string;
  error?: string | null;
};

type StorageListEntry = {
  id?: string | null;
  name: string;
  metadata?: Record<string, unknown> | null;
};

type WorkerOutcome = {
  shouldContinue: boolean;
  jobId?: string;
};

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

class WorkerBudgetExpired extends Error {
  constructor() {
    super("Project deletion worker reached its execution budget.");
    this.name = "WorkerBudgetExpired";
  }
}

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

function configuredAllowedOrigins(): Set<string> {
  const values = [Deno.env.get("ALLOWED_ORIGIN"), Deno.env.get("APP_URL")]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const origins = new Set(values);
  for (const origin of localDevOrigins) origins.add(origin);
  if (!origins.size) origins.add("*");
  return origins;
}

function corsHeaders(request: Request): HeadersInit {
  const requestOrigin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const allowedOrigins = configuredAllowedOrigins();
  const allowedOrigin = allowedOrigins.has("*")
    ? "*"
    : requestOrigin && allowedOrigins.has(requestOrigin)
      ? requestOrigin
      : [...allowedOrigins][0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
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
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asJob(value: unknown): ProjectDeletionJob | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ProjectDeletionJob>;
  if (
    typeof candidate.jobId !== "string" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.phase !== "string"
  ) return null;
  return candidate as ProjectDeletionJob;
}

function assertWithinBudget(deadline: number): void {
  if (Date.now() >= deadline) throw new WorkerBudgetExpired();
}

function storagePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function isStorageFolder(entry: StorageListEntry): boolean {
  return entry.id == null;
}

function isMissingBucket(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error ?? "");
  return /bucket.+not found|not found.+bucket/i.test(message);
}

function isTransientDatabaseError(error: unknown): boolean {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown }
    : {};
  const code = String(candidate.code ?? "").toUpperCase();
  const status = Number(candidate.status ?? candidate.statusCode ?? 0);
  const message = String(candidate.message ?? error ?? "");
  return code === "57014" ||
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    status === 429 ||
    status >= 500 ||
    /statement timeout|timed out|timeout|fetch failed|connection|temporarily unavailable|bad gateway|gateway timeout/i.test(message);
}

function retryDelay(attempt: number): number {
  return Math.min(2_000, 150 * (2 ** Math.min(attempt, 4)));
}

async function removeProjectObjectsFromBucket(
  adminClient: SupabaseClient,
  bucket: string,
  projectId: string,
  deadline: number,
): Promise<void> {
  const directories = [projectId];
  const visited = new Set<string>();

  while (directories.length) {
    assertWithinBudget(deadline);
    const directory = directories.shift()!;
    if (visited.has(directory)) continue;
    visited.add(directory);

    const files: string[] = [];
    const childDirectories: string[] = [];
    let offset = 0;

    // List the directory completely before deleting from it. Incrementing an
    // offset while removing the same page would otherwise skip objects.
    while (true) {
      assertWithinBudget(deadline);
      const { data, error } = await adminClient.storage.from(bucket).list(directory, {
        limit: STORAGE_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) {
        // Some older installations do not have both optional buckets.
        if (offset === 0 && directory === projectId && isMissingBucket(error)) return;
        throw error;
      }

      const entries = (data ?? []) as StorageListEntry[];
      for (const entry of entries) {
        const path = storagePath(directory, entry.name);
        if (isStorageFolder(entry)) childDirectories.push(path);
        else files.push(path);
      }
      if (entries.length < STORAGE_PAGE_SIZE) break;
      offset += entries.length;
    }

    for (let offset = 0; offset < files.length; offset += STORAGE_REMOVE_BATCH_SIZE) {
      assertWithinBudget(deadline);
      const { error } = await adminClient.storage
        .from(bucket)
        .remove(files.slice(offset, offset + STORAGE_REMOVE_BATCH_SIZE));
      if (error) throw error;
    }

    directories.push(...childDirectories);
  }
}

async function cleanupProjectStorage(
  adminClient: SupabaseClient,
  job: ProjectDeletionJob,
  deadline: number,
): Promise<void> {
  // Only Supabase Storage is in scope. Files owned by the user's Google Drive
  // are deliberately never touched by project deletion.
  for (const bucket of STORAGE_BUCKETS) {
    await removeProjectObjectsFromBucket(
      adminClient,
      bucket,
      job.projectId,
      deadline,
    );
  }

  assertWithinBudget(deadline);
  const { error } = await adminClient.rpc("mark_project_deletion_storage_cleaned", {
    target_job_id: job.jobId,
  });
  if (error) throw error;
}

async function runDeletionWorker(
  supabaseUrl: string,
  serviceRoleKey: string,
  targetJobId?: string,
): Promise<WorkerOutcome> {
  const deadline = Date.now() + WORKER_BUDGET_MS;
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let databaseBatchSize = INITIAL_DATABASE_BATCH_SIZE;
  let transientAttempt = 0;
  let successfulBatches = 0;
  let activeJobId = targetJobId;

  try {
    while (Date.now() < deadline) {
      const rpcName = activeJobId
        ? "process_project_deletion"
        : "process_next_project_deletion";
      const rpcArguments = activeJobId
        ? { target_job_id: activeJobId, batch_size: databaseBatchSize }
        : { batch_size: databaseBatchSize };
      const { data, error } = await adminClient.rpc(rpcName, rpcArguments);
      if (error) {
        if (isTransientDatabaseError(error)) {
          databaseBatchSize = Math.max(
            MIN_DATABASE_BATCH_SIZE,
            Math.floor(databaseBatchSize / 2),
          );
          successfulBatches = 0;
          transientAttempt += 1;
          const delay = retryDelay(transientAttempt);
          if (Date.now() + delay >= deadline) {
            return { shouldContinue: true, jobId: activeJobId };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }

      transientAttempt = 0;
      successfulBatches += 1;
      if (successfulBatches >= 4 && databaseBatchSize < INITIAL_DATABASE_BATCH_SIZE) {
        databaseBatchSize = Math.min(
          INITIAL_DATABASE_BATCH_SIZE,
          Math.max(databaseBatchSize + 1, Math.floor(databaseBatchSize * 1.25)),
        );
        successfulBatches = 0;
      }

      const job = asJob(data);
      if (!job) return { shouldContinue: false }; // The cron queue is empty.
      activeJobId = job.jobId;
      if (job.status === "failed") {
        console.error("Project deletion job failed", {
          jobId: job.jobId,
          error: job.error ?? "Unknown deletion error",
        });
        return { shouldContinue: false };
      }
      if (job.status === "completed") {
        return { shouldContinue: false };
      }
      if (job.phase === "storage_cleanup") {
        await cleanupProjectStorage(adminClient, job, deadline);
      }

      // Yield between bounded database batches so other work can run.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return { shouldContinue: true, jobId: activeJobId };
  } catch (error) {
    if (error instanceof WorkerBudgetExpired || isTransientDatabaseError(error)) {
      return { shouldContinue: true, jobId: activeJobId };
    }
    console.error("Project deletion worker stopped; the durable job will resume", error);
    return { shouldContinue: false };
  }
}

async function runDeletionWorkerWithContinuation(
  supabaseUrl: string,
  serviceRoleKey: string,
  continuationToken: string,
  targetJobId?: string,
): Promise<void> {
  const outcome = await runDeletionWorker(
    supabaseUrl,
    serviceRoleKey,
    targetJobId,
  );
  // Queue recovery only receives a job after the database stale-worker guard
  // claims it. Once claimed, it may become one targeted chain just like a
  // browser-started job. An empty queue never schedules another invocation.
  if (!outcome.shouldContinue || !outcome.jobId) return;

  try {
    // One completed worker schedules one successor. There is deliberately no
    // retry loop here: the five-minute cron remains the recovery path if this
    // single wake-up is rejected or the network is temporarily unavailable.
    await requestDeletionContinuation({
      supabaseUrl,
      serverToken: continuationToken,
      jobId: outcome.jobId,
    });
  } catch (error) {
    console.error(
      "Could not wake the next project deletion worker; cron will recover the durable job",
      error,
    );
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json(request, { error: "Supabase function environment is incomplete." }, 500);
  }

  const providedToken = bearerToken(request) || request.headers.get("x-cron-secret")?.trim() || "";
  const cronSecret = Deno.env.get("TASK_REMINDER_CRON_SECRET")?.trim() ?? "";
  const isServerRequest = isTrustedDeletionWorkerToken(
    providedToken,
    serviceRoleKey,
    cronSecret,
  );
  let targetJobId: string | undefined;
  let body: { jobId?: unknown };

  try {
    body = await request.json() as { jobId?: unknown };
  } catch {
    return json(request, { error: "A JSON body is required." }, 400);
  }

  if (isServerRequest) {
    if (body.jobId !== undefined) {
      if (typeof body.jobId !== "string" || !isUuid(body.jobId)) {
        return json(request, { error: "A valid project deletion jobId is required." }, 400);
      }
      targetJobId = body.jobId;
    }
  }

  if (!isServerRequest) {
    const authorization = request.headers.get("Authorization")?.trim() ?? "";
    const accessToken = bearerToken(request);
    if (!authorization || !accessToken) {
      return json(request, { error: "Authentication required" }, 401);
    }

    if (typeof body.jobId !== "string" || !isUuid(body.jobId)) {
      return json(request, { error: "A valid project deletion jobId is required." }, 400);
    }
    targetJobId = body.jobId;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userResult, error: userError } = await userClient.auth.getUser(accessToken);
    if (userError || !userResult.user) {
      return json(request, { error: "Authentication required" }, 401);
    }

    // The RPC performs the requester/owner/admin authorization check with the
    // browser JWT before service-role work is allowed to start.
    const { error: statusError } = await userClient.rpc("get_project_deletion_status", {
      target_job_id: targetJobId,
    });
    if (statusError) {
      const forbidden = statusError.code === "42501";
      return json(
        request,
        { error: forbidden ? "Project deletion access denied." : statusError.message },
        forbidden ? 403 : 400,
      );
    }
  }

  EdgeRuntime.waitUntil(
    runDeletionWorkerWithContinuation(
      supabaseUrl,
      serviceRoleKey,
      cronSecret || serviceRoleKey,
      targetJobId,
    ),
  );
  return json(
    request,
    {
      accepted: true,
      jobId: targetJobId ?? null,
      mode: targetJobId ? "job" : "queue",
    },
    202,
  );
});
