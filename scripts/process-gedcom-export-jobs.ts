import { createClient } from "@supabase/supabase-js";
import {
  GEDCOM_EXPORT_SIGNED_URL_SECONDS,
  failGedcomExport,
  parseClaimedGedcomExport,
  processClaimedGedcomExport,
  standardGedcomStorageUpload,
  type GedcomExportUploader,
  type SupabaseServiceClient,
} from "../supabase/functions/_shared/gedcomExportProcessor.ts";
import {
  resolveSupabaseSecretKey,
  supabaseServerKeyHeaders,
} from "../supabase/functions/_shared/supabaseApiKeys.ts";

const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
const STANDARD_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
const RUNNER_BUDGET_MS = 20 * 60 * 1_000;
const MAX_JOBS_PER_RUN = 10;

const projectRef = process.env.SUPABASE_PROJECT_REF?.trim() ?? "";
const supabaseUrl = process.env.SUPABASE_URL?.trim()
  || (projectRef ? `https://${projectRef}.supabase.co` : "");
const storageUrl = resolveStorageUrl(supabaseUrl, projectRef);
const serverKey = resolveSupabaseSecretKey({
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  SUPABASE_SECRET_KEYS: process.env.SUPABASE_SECRET_KEYS,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const cronSecret = process.env.TASK_REMINDER_CRON_SECRET?.trim() ?? "";

if (!supabaseUrl || !serverKey || !cronSecret) {
  throw new Error(
    "SUPABASE_URL (or SUPABASE_PROJECT_REF), SUPABASE_SECRET_KEY and TASK_REMINDER_CRON_SECRET are required.",
  );
}

const client = createClient(supabaseUrl, serverKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}) as unknown as SupabaseServiceClient;

const upload: GedcomExportUploader = async (input) => {
  if (input.bytes.byteLength <= STANDARD_UPLOAD_MAX_BYTES) {
    await standardGedcomStorageUpload(client, input);
    return;
  }
  await uploadWithTus({
    storageUrl,
    serverKey,
    ...input,
  });
};

const startedAt = Date.now();
let completedJobs = 0;
let failedJobs = 0;

for (let jobIndex = 0; jobIndex < MAX_JOBS_PER_RUN; jobIndex += 1) {
  if (Date.now() - startedAt >= RUNNER_BUDGET_MS) break;
  const { data, error } = await client.rpc("claim_gedcom_export", {
    target_job_id: null,
  });
  if (error) throw error;
  const job = parseClaimedGedcomExport(data);
  if (!job) break;

  console.log(JSON.stringify({ event: "gedcom_export_claimed", jobId: job.jobId, attempts: job.attempts }));
  let generated = false;
  try {
    const completed = await processClaimedGedcomExport(client, job, upload);
    generated = true;
    completedJobs += 1;
    console.log(JSON.stringify({
      event: "gedcom_export_completed",
      jobId: job.jobId,
      persons: completed.personCount,
      families: completed.familyCount,
      bytes: completed.fileSize,
      signedUrlSeconds: GEDCOM_EXPORT_SIGNED_URL_SECONDS,
    }));
  } catch (jobError) {
    failedJobs += 1;
    console.error(JSON.stringify({
      event: "gedcom_export_failed",
      jobId: job.jobId,
      error: jobError instanceof Error ? jobError.message : String(jobError),
    }));
    await failGedcomExport(client, job.jobId, job.attempts, jobError);
  }
  if (generated) {
    try {
      await wakeEmailDelivery(job.jobId);
    } catch (emailWakeError) {
      // The export is already complete. The Edge cron email-claim path will
      // retry pending delivery without changing generation status.
      console.error(JSON.stringify({
        event: "gedcom_export_email_wake_failed",
        jobId: job.jobId,
        error: emailWakeError instanceof Error ? emailWakeError.message : String(emailWakeError),
      }));
    }
  }
}

console.log(JSON.stringify({
  event: "gedcom_export_runner_finished",
  completedJobs,
  failedJobs,
  elapsedMs: Date.now() - startedAt,
}));

async function wakeEmailDelivery(jobId: string): Promise<void> {
  const response = await retryFetch(`${supabaseUrl}/functions/v1/process-gedcom-exports`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jobId }),
  });
  if (!response.ok) {
    throw new Error(`GEDCOM export email wake failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
}

async function uploadWithTus(input: {
  storageUrl: string;
  serverKey: string;
  bucket: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<void> {
  const endpoint = `${input.storageUrl.replace(/\/+$/, "")}/storage/v1/upload/resumable`;
  const createResponse = await retryFetch(endpoint, {
    method: "POST",
    headers: {
      ...supabaseServerKeyHeaders(input.serverKey),
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(input.bytes.byteLength),
      "Upload-Metadata": uploadMetadata({
        bucketName: input.bucket,
        objectName: input.path,
        contentType: input.contentType,
        cacheControl: "3600",
      }),
      "x-upsert": "true",
    },
  });
  if (!createResponse.ok) {
    throw new Error(`TUS create failed (${createResponse.status}): ${(await createResponse.text()).slice(0, 500)}`);
  }
  const location = createResponse.headers.get("Location");
  if (!location) throw new Error("TUS upload location is missing.");
  const uploadUrl = new URL(location, endpoint).toString();

  let offset = 0;
  while (offset < input.bytes.byteLength) {
    const chunk = input.bytes.subarray(offset, Math.min(offset + TUS_CHUNK_BYTES, input.bytes.byteLength));
    offset = await patchTusChunk({
      uploadUrl,
      serverKey: input.serverKey,
      offset,
      chunk,
    });
  }
}

function resolveStorageUrl(baseUrl: string, explicitProjectRef: string): string {
  if (explicitProjectRef) return `https://${explicitProjectRef}.storage.supabase.co`;
  try {
    const url = new URL(baseUrl);
    const hostedProject = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
    if (hostedProject) return `${url.protocol}//${hostedProject[1]}.storage.supabase.co`;
  } catch {
    // A malformed URL is rejected by the Supabase client shortly afterwards.
  }
  return baseUrl;
}

async function patchTusChunk(input: {
  uploadUrl: string;
  serverKey: string;
  offset: number;
  chunk: Uint8Array;
}): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(input.uploadUrl, {
        method: "PATCH",
        headers: {
          ...supabaseServerKeyHeaders(input.serverKey),
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(input.offset),
          "Content-Type": "application/offset+octet-stream",
        },
        body: input.chunk,
      });
      if (response.ok) {
        const nextOffset = Number(response.headers.get("Upload-Offset"));
        return Number.isFinite(nextOffset) && nextOffset > input.offset
          ? nextOffset
          : input.offset + input.chunk.byteLength;
      }
      lastError = new Error(`TUS chunk failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    } catch (error) {
      lastError = error;
    }

    // A PATCH may have reached Storage even when its response was lost. HEAD
    // is the TUS source of truth and prevents retransmitting accepted bytes.
    const serverOffset = await readTusOffset(input.uploadUrl, input.serverKey);
    if (serverOffset > input.offset) return serverOffset;
    if (attempt + 1 < 3) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("TUS chunk failed after retries.");
}

async function readTusOffset(uploadUrl: string, serverKey: string): Promise<number> {
  const response = await retryFetch(uploadUrl, {
    method: "HEAD",
    headers: {
      ...supabaseServerKeyHeaders(serverKey),
      "Tus-Resumable": "1.0.0",
    },
  });
  if (!response.ok) throw new Error(`TUS HEAD failed (${response.status}).`);
  const offset = Number(response.headers.get("Upload-Offset"));
  if (!Number.isFinite(offset) || offset < 0) throw new Error("TUS HEAD returned an invalid offset.");
  return offset;
}

function uploadMetadata(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key} ${Buffer.from(value, "utf8").toString("base64")}`)
    .join(",");
}

async function retryFetch(
  input: string,
  init: RequestInit,
  maxAttempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || response.status < 500 && response.status !== 429) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < maxAttempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Network request failed after retries.");
}
