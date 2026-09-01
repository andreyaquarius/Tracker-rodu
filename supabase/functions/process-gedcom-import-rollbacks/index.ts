import { createClient } from "npm:@supabase/supabase-js@2";

const WORKER_BUDGET_MS = 80_000;
const INITIAL_ROLLBACK_BATCH_SIZE = 500;
const MIN_ROLLBACK_BATCH_SIZE = 25;
const INITIAL_DELETION_BATCH_SIZE = 100;
const MIN_DELETION_BATCH_SIZE = 1;

type WorkKind = "deletion" | "rollback";

type WorkerPayload = {
  operationId?: unknown;
  jobId?: unknown;
  status?: unknown;
  retryable?: unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function isTransientError(error: unknown): boolean {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown }
    : {};
  const code = String(candidate.code ?? "").toUpperCase();
  const status = Number(candidate.status ?? candidate.statusCode ?? 0);
  const message = String(candidate.message ?? error ?? "");
  return code === "57014"
    || code === "40001"
    || code === "40P01"
    || code === "55P03"
    || status === 429
    || status >= 500
    || /statement timeout|timed out|timeout|fetch failed|connection|temporarily unavailable|bad gateway|gateway timeout/i.test(message);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok");
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  const cronSecret = Deno.env.get("TASK_REMINDER_CRON_SECRET")?.trim() ?? "";
  if (!supabaseUrl || !serviceRoleKey || !cronSecret) {
    return json({ error: "Supabase function environment is incomplete." }, 500);
  }

  const providedToken = bearerToken(request)
    || request.headers.get("x-cron-secret")?.trim()
    || "";
  if (!providedToken || !constantTimeEqual(providedToken, cronSecret)) {
    return json({ error: "Authentication required" }, 401);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deadline = Date.now() + WORKER_BUDGET_MS;
  let rollbackBatchSize = INITIAL_ROLLBACK_BATCH_SIZE;
  let deletionBatchSize = INITIAL_DELETION_BATCH_SIZE;
  let processedRollbackBatches = 0;
  let processedDeletionBatches = 0;
  let lastOperationId: string | null = null;
  let lastDeletionJobId: string | null = null;
  let nextKind: WorkKind = "deletion";
  let consecutiveEmptyQueues = 0;
  let deletionBlocked = false;
  let rollbackBlocked = false;
  const queueErrors: Array<{ kind: WorkKind; message: string }> = [];

  while (Date.now() < deadline) {
    if (deletionBlocked && rollbackBlocked) break;
    if (nextKind === "deletion" && deletionBlocked) nextKind = "rollback";
    if (nextKind === "rollback" && rollbackBlocked) nextKind = "deletion";
    const workKind = nextKind;
    const isDeletion = workKind === "deletion";
    const functionName = isDeletion
      ? "process_next_gedcom_deletion_job"
      : "process_next_stale_gedcom_import_rollback";
    const batchSize = isDeletion ? deletionBatchSize : rollbackBatchSize;
    const { data, error } = await client.rpc(functionName, { batch_size: batchSize });
    if (error) {
      const minimumBatchSize = isDeletion
        ? MIN_DELETION_BATCH_SIZE
        : MIN_ROLLBACK_BATCH_SIZE;
      if (isTransientError(error) && batchSize > minimumBatchSize) {
        const smallerBatchSize = Math.max(minimumBatchSize, Math.floor(batchSize / 2));
        if (isDeletion) deletionBatchSize = smallerBatchSize;
        else rollbackBatchSize = smallerBatchSize;
        continue;
      }
      console.error(`GEDCOM ${workKind} worker stopped`, error);
      queueErrors.push({
        kind: workKind,
        message: String((error as { message?: unknown })?.message ?? error),
      });
      if (isDeletion) deletionBlocked = true;
      else rollbackBlocked = true;
      nextKind = isDeletion ? "rollback" : "deletion";
      continue;
    }
    nextKind = isDeletion ? "rollback" : "deletion";
    if (!data) {
      if ((isDeletion && rollbackBlocked) || (!isDeletion && deletionBlocked)) break;
      consecutiveEmptyQueues += 1;
      if (consecutiveEmptyQueues >= 2) break;
      continue;
    }

    consecutiveEmptyQueues = 0;
    const payload = data as WorkerPayload;
    if (isDeletion) {
      lastDeletionJobId = typeof payload.jobId === "string"
        ? payload.jobId
        : lastDeletionJobId;
      processedDeletionBatches += 1;
      if (payload.status === "failed" && payload.retryable === true) {
        deletionBatchSize = Math.max(
          MIN_DELETION_BATCH_SIZE,
          Math.floor(deletionBatchSize / 2),
        );
      }
    } else {
      lastOperationId = typeof payload.operationId === "string"
        ? payload.operationId
        : lastOperationId;
      processedRollbackBatches += 1;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const result = {
    ...(queueErrors.length > 0
      ? { error: "One GEDCOM work queue failed; completed work is durable and the next run will retry." }
      : {}),
    processedBatches: processedRollbackBatches + processedDeletionBatches,
    processedRollbackBatches,
    processedDeletionBatches,
    lastOperationId,
    lastDeletionJobId,
    hasMore: Date.now() >= deadline || queueErrors.length > 0,
    queueErrors,
  };
  return json(result, queueErrors.length > 0 ? 500 : 200);
});
