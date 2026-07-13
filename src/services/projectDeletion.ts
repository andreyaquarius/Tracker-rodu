import { isDatabaseStatementTimeout } from "../utils/databaseErrors.ts";

export type ProjectDeletionState = "queued" | "running" | "completed" | "failed";

export interface ProjectDeletionStatus {
  jobId: string;
  projectId: string;
  status: ProjectDeletionState;
  phase: string;
  processedRows: number;
  totalRows: number;
  completedTables: number;
  totalTables: number;
  progressPercent: number;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectDeletionOperations {
  start: (projectId: string) => Promise<ProjectDeletionStatus>;
  wake: (jobId: string) => Promise<void>;
  getStatus: (jobId: string) => Promise<ProjectDeletionStatus>;
}

export interface ProjectDeletionOptions {
  maxTransientRetries?: number;
  retryDelayMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  maxConsecutivePollFailures?: number;
  signal?: AbortSignal;
  onProgress?: (status: ProjectDeletionStatus) => void;
  onWakeError?: (error: unknown) => void;
  onPollError?: (error: unknown) => void;
  /** Test seam; production callers use the abort-aware timer. */
  waitForNextPoll?: (delayMs: number) => Promise<void>;
}

export type ProjectDeletionRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

export type ProjectDeletionWake = (jobId: string) => Promise<void>;

const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 350;
const DEFAULT_POLL_INTERVAL_MS = 1_250;
const DEFAULT_MAX_POLLS = 100_000;
const DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES = 12;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableTextValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numericValue(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

export function parseProjectDeletionStatus(value: unknown): ProjectDeletionStatus {
  const record = asObject(value);
  const jobId = textValue(record?.jobId);
  const projectId = textValue(record?.projectId);
  const state = textValue(record?.status);
  if (!jobId || !projectId || !["queued", "running", "completed", "failed"].includes(state)) {
    throw new Error("Сервер повернув некоректний стан видалення проєкту.");
  }
  return {
    jobId,
    projectId,
    status: state as ProjectDeletionState,
    phase: textValue(record?.phase),
    processedRows: numericValue(record?.processedRows),
    totalRows: numericValue(record?.totalRows),
    completedTables: numericValue(record?.completedTables),
    totalTables: numericValue(record?.totalTables),
    progressPercent: Math.min(100, numericValue(record?.progressPercent)),
    error: nullableTextValue(record?.error),
    createdAt: nullableTextValue(record?.createdAt),
    updatedAt: nullableTextValue(record?.updatedAt),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`.toLocaleLowerCase();
  if (typeof error === "string") return error.toLocaleLowerCase();
  const record = asObject(error);
  if (!record) return "";
  return [record.code, record.message, record.details, record.hint, record.status, record.statusCode]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ")
    .toLocaleLowerCase();
}

export function isTransientProjectDeletionError(error: unknown): boolean {
  if (isDatabaseStatementTimeout(error)) return true;
  const record = asObject(error);
  const status = Number(record?.status ?? record?.statusCode);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return true;
  const text = errorText(error);
  return /(^|\s)(08000|08001|08003|08004|08006|08007|08p01|40001|40p01|53300|55p03|57p01|57p02|57p03|pgrst000|pgrst001|pgrst002|pgrst003)(\s|$)/i.test(text)
    || text.includes("failed to fetch")
    || text.includes("fetch failed")
    || text.includes("networkerror")
    || text.includes("network request failed")
    || text.includes("connection reset")
    || text.includes("service unavailable")
    || text.includes("bad gateway")
    || text.includes("gateway timeout")
    || text.includes("temporarily unavailable");
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Project deletion was aborted.", "AbortError");
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Project deletion was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxTransientRetries: number;
    retryDelayMs: number;
    signal?: AbortSignal;
  },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    abortIfRequested(options.signal);
    try {
      return await operation();
    } catch (error) {
      if (!isTransientProjectDeletionError(error) || attempt >= options.maxTransientRetries) {
        throw error;
      }
      await wait(options.retryDelayMs * (2 ** attempt), options.signal);
    }
  }
}

async function callDeletionRpc(
  rpc: ProjectDeletionRpc,
  functionName: string,
  args: Record<string, unknown>,
): Promise<ProjectDeletionStatus> {
  const { data, error } = await rpc(functionName, args);
  if (error) throw error;
  return parseProjectDeletionStatus(data);
}

export function createProjectDeletionOperations(
  rpc: ProjectDeletionRpc,
  wake: ProjectDeletionWake,
): ProjectDeletionOperations {
  return {
    start: (projectId) => callDeletionRpc(rpc, "start_project_deletion", {
      target_project_id: projectId,
    }),
    wake,
    getStatus: (jobId) => callDeletionRpc(rpc, "get_project_deletion_status", {
      target_job_id: jobId,
    }),
  };
}

/**
 * Starts or resumes a durable deletion job, wakes the server worker once and
 * then only polls status. All destructive steps run server-side, so closing or
 * refreshing the browser does not stop the job; cron can resume queued work.
 */
export async function runProjectDeletion(
  operations: ProjectDeletionOperations,
  projectId: string,
  options: ProjectDeletionOptions = {},
): Promise<ProjectDeletionStatus> {
  const maxTransientRetries = options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const maxConsecutivePollFailures = options.maxConsecutivePollFailures
    ?? DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES;
  if (!projectId.trim()) throw new Error("Не вказано проєкт для видалення.");
  if (!Number.isInteger(maxTransientRetries) || maxTransientRetries < 0) {
    throw new RangeError("Project deletion retry count must be a non-negative integer.");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("Project deletion retry delay must be non-negative.");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("Project deletion poll interval must be non-negative.");
  }
  if (!Number.isInteger(maxPolls) || maxPolls < 1) {
    throw new RangeError("Project deletion maxPolls must be a positive integer.");
  }
  if (!Number.isInteger(maxConsecutivePollFailures) || maxConsecutivePollFailures < 1) {
    throw new RangeError("Project deletion poll failure limit must be a positive integer.");
  }

  const retryOptions = { maxTransientRetries, retryDelayMs, signal: options.signal };
  let current = await withTransientRetry(() => operations.start(projectId), retryOptions);
  if (current.projectId !== projectId) {
    throw new Error("Сервер повернув завдання видалення для іншого проєкту.");
  }
  options.onProgress?.(current);
  if (current.status === "completed") return current;
  if (current.status === "failed") {
    throw new Error(current.error || "Сервер не зміг завершити видалення проєкту.");
  }

  // The wake-up is only an optimization. The durable queued job is already
  // committed, and the scheduled worker will pick it up even if this request
  // cannot reach the Edge Function.
  void withTransientRetry(() => operations.wake(current.jobId), retryOptions)
    .catch((error) => options.onWakeError?.(error));

  const waitForNextPoll = options.waitForNextPoll
    ?? ((delayMs: number) => wait(delayMs, options.signal));
  let consecutivePollFailures = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    abortIfRequested(options.signal);
    await waitForNextPoll(pollIntervalMs);
    try {
      current = await withTransientRetry(
        () => operations.getStatus(current.jobId),
        retryOptions,
      );
      consecutivePollFailures = 0;
    } catch (error) {
      if (!isTransientProjectDeletionError(error)) throw error;
      consecutivePollFailures += 1;
      options.onPollError?.(error);
      if (consecutivePollFailures >= maxConsecutivePollFailures) throw error;
      continue;
    }
    if (current.projectId !== projectId) {
      throw new Error("Сервер повернув стан видалення для іншого проєкту.");
    }
    options.onProgress?.(current);
    if (current.status === "completed") return current;
    if (current.status === "failed") {
      throw new Error(current.error || "Сервер не зміг завершити видалення проєкту.");
    }
  }
  throw new Error("Серверне видалення проєкту ще не завершилося. Воно продовжується у фоні.");
}

