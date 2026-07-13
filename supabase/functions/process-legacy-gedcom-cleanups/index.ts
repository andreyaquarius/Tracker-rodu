import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const WORKER_BUDGET_MS = 80_000;
const INITIAL_BATCH_SIZE = 500;
const MIN_BATCH_SIZE = 25;
const STORAGE_BATCH_SIZE = 100;

type CleanupJob = {
  jobId: string;
  status: string;
  phase: string;
  requiresStorageCleanup?: boolean;
  error?: string | null;
};

type StorageObject = {
  attachmentId: string;
  storageBucket: string;
  storagePath: string;
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

function asCleanupJob(value: unknown): CleanupJob | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CleanupJob>;
  return typeof candidate.jobId === "string"
    && typeof candidate.status === "string"
    && typeof candidate.phase === "string"
    ? candidate as CleanupJob
    : null;
}

function asStorageObjects(value: unknown): StorageObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const object = candidate as Partial<StorageObject>;
    return typeof object.attachmentId === "string"
      && typeof object.storageBucket === "string"
      && typeof object.storagePath === "string"
      ? [object as StorageObject]
      : [];
  });
}

async function removeQueuedStorageObjects(
  client: SupabaseClient,
  jobId: string,
): Promise<number> {
  const listed = await client.rpc("list_legacy_gedcom_cleanup_storage_objects", {
    target_job_id: jobId,
    batch_size: STORAGE_BATCH_SIZE,
  });
  if (listed.error) throw listed.error;
  const objects = asStorageObjects(listed.data);
  if (!objects.length) return 0;

  const byBucket = new Map<string, StorageObject[]>();
  for (const object of objects) {
    byBucket.set(object.storageBucket, [
      ...(byBucket.get(object.storageBucket) ?? []),
      object,
    ]);
  }
  for (const [bucket, bucketObjects] of byBucket) {
    const removal = await client.storage
      .from(bucket)
      .remove(bucketObjects.map((object) => object.storagePath));
    if (removal.error) throw removal.error;
  }

  const marked = await client.rpc("mark_legacy_gedcom_cleanup_storage_deleted", {
    target_job_id: jobId,
    attachment_ids: objects.map((object) => object.attachmentId),
  });
  if (marked.error) throw marked.error;
  return objects.length;
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
  let activeJobId: string | null = null;
  let batchSize = INITIAL_BATCH_SIZE;
  let processedBatches = 0;
  let removedStorageObjects = 0;
  let transientAttempts = 0;

  while (Date.now() < deadline) {
    const rpcName = activeJobId
      ? "process_legacy_gedcom_cleanup"
      : "process_next_legacy_gedcom_cleanup";
    const rpcArgs = activeJobId
      ? { target_job_id: activeJobId, batch_size: batchSize }
      : { batch_size: batchSize };
    const result = await client.rpc(rpcName, rpcArgs);
    if (result.error) {
      if (isTransientError(result.error) && batchSize > MIN_BATCH_SIZE) {
        batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
        transientAttempts += 1;
        continue;
      }
      console.error("Legacy GEDCOM cleanup worker stopped", result.error);
      return json({
        error: "Legacy GEDCOM cleanup batch failed; the scheduled worker will retry.",
        jobId: activeJobId,
        processedBatches,
        transientAttempts,
      }, 500);
    }

    const job = asCleanupJob(result.data);
    if (!job) break;
    activeJobId = job.jobId;
    processedBatches += 1;

    if (job.status === "failed") {
      console.error("Legacy GEDCOM cleanup job failed", {
        jobId: job.jobId,
        error: job.error ?? "Unknown cleanup failure",
      });
      return json({
        error: job.error ?? "Legacy GEDCOM cleanup job failed.",
        jobId: job.jobId,
        processedBatches,
      }, 500);
    }
    if (job.status === "completed" || job.status === "paused") {
      activeJobId = null;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      continue;
    }
    if (job.requiresStorageCleanup) {
      removedStorageObjects += await removeQueuedStorageObjects(client, job.jobId);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return json({
    processedBatches,
    removedStorageObjects,
    activeJobId,
    hasMore: Date.now() >= deadline || activeJobId !== null,
  });
});
