import { createClient } from "npm:@supabase/supabase-js@2";

const WORKER_BUDGET_MS = 80_000;
const INITIAL_BATCH_SIZE = 500;
const MIN_BATCH_SIZE = 25;

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
  let batchSize = INITIAL_BATCH_SIZE;
  let processedBatches = 0;
  let lastOperationId: string | null = null;

  while (Date.now() < deadline) {
    const { data, error } = await client.rpc("process_next_stale_gedcom_import_rollback", {
      batch_size: batchSize,
    });
    if (error) {
      if (isTransientError(error) && batchSize > MIN_BATCH_SIZE) {
        batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
        continue;
      }
      console.error("GEDCOM import rollback worker stopped", error);
      return json({
        error: "GEDCOM rollback batch failed; the next scheduled run will retry.",
        processedBatches,
        lastOperationId,
      }, 500);
    }
    if (!data) break;

    const operation = data as { operationId?: unknown };
    lastOperationId = typeof operation.operationId === "string"
      ? operation.operationId
      : lastOperationId;
    processedBatches += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return json({
    processedBatches,
    lastOperationId,
    hasMore: Date.now() >= deadline,
  });
});
