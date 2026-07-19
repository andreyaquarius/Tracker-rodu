export type GedcomExportState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "expired";

export interface GedcomExportStatus {
  jobId: string;
  projectId: string;
  treeId: string;
  treeTitle: string;
  status: GedcomExportState;
  phase: string;
  progressPercent: number;
  personCount: number;
  familyCount: number;
  warningCount: number;
  fileName: string;
  fileSize: number;
  downloadUrl: string | null;
  expiresAt: string | null;
  emailStatus: "pending" | "sent" | "failed";
  emailError: string | null;
  retryable: boolean;
  nextAttemptAt: string | null;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export type GedcomExportRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

export interface GedcomExportOperations {
  start: (projectId: string, treeId: string) => Promise<GedcomExportStatus>;
  wake: (jobId: string) => Promise<void>;
  getStatus: (jobId: string) => Promise<GedcomExportStatus>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function parseGedcomExportStatus(value: unknown): GedcomExportStatus {
  const record = asRecord(value);
  const jobId = stringValue(record?.jobId);
  const projectId = stringValue(record?.projectId);
  const treeId = stringValue(record?.treeId);
  const rawStatus = stringValue(record?.status);
  const status = rawStatus === "processing" ? "running" : rawStatus;
  if (
    !jobId ||
    !projectId ||
    !treeId ||
    !["queued", "running", "completed", "failed", "expired"].includes(status)
  ) {
    throw new Error("Сервер повернув некоректний стан експорту GEDCOM.");
  }

  const emailState = stringValue(record?.emailStatus);
  return {
    jobId,
    projectId,
    treeId,
    treeTitle: stringValue(record?.treeTitle),
    status: status as GedcomExportState,
    phase: stringValue(record?.phase),
    progressPercent: Math.min(100, nonNegativeNumber(record?.progressPercent)),
    personCount: nonNegativeNumber(record?.personCount),
    familyCount: nonNegativeNumber(record?.familyCount),
    warningCount: nonNegativeNumber(record?.warningCount),
    fileName: stringValue(record?.fileName),
    fileSize: nonNegativeNumber(record?.fileSize),
    downloadUrl: nullableString(record?.downloadUrl),
    expiresAt: nullableString(record?.expiresAt),
    emailStatus: ["pending", "sent", "failed"].includes(emailState)
      ? emailState as GedcomExportStatus["emailStatus"]
      : "pending",
    emailError: nullableString(record?.emailError),
    retryable: record?.retryable === true,
    nextAttemptAt: nullableString(record?.nextAttemptAt),
    error: nullableString(record?.error),
    createdAt: nullableString(record?.createdAt),
    updatedAt: nullableString(record?.updatedAt),
    completedAt: nullableString(record?.completedAt),
  };
}

async function callExportRpc(
  rpc: GedcomExportRpc,
  functionName: string,
  args: Record<string, unknown>,
): Promise<GedcomExportStatus> {
  const { data, error } = await rpc(functionName, args);
  if (error) throw databaseError(error);
  return parseGedcomExportStatus(data);
}

function databaseError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.trim()) return new Error(error);
  const record = asRecord(error);
  const message = [record?.message, record?.details, record?.hint]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join(" ");
  return new Error(message || "Не вдалося створити запит на експорт GEDCOM.");
}

export function createGedcomExportOperations(
  rpc: GedcomExportRpc,
  wake: (jobId: string) => Promise<void>,
): GedcomExportOperations {
  return {
    start: (projectId, treeId) => callExportRpc(rpc, "start_gedcom_export", {
      target_project_id: projectId,
      target_tree_id: treeId,
    }),
    wake,
    getStatus: (jobId) => callExportRpc(rpc, "get_gedcom_export_status", {
      target_job_id: jobId,
    }),
  };
}

export async function wakeGedcomExport(jobId: string): Promise<void> {
  const { invokeEdgeFunction } = await import("./edgeFunctions.ts");
  await invokeEdgeFunction<{ accepted: boolean }>(
    "process-gedcom-exports",
    { jobId },
    {
      connectionErrorMessage:
        "Запит на експорт збережено, але фоновий обробник зараз недоступний. Він повторить спробу автоматично.",
    },
  );
}

function defaultOperations(): GedcomExportOperations {
  const rpc: GedcomExportRpc = async (functionName, args) => {
    const { getSupabaseClient } = await import("./supabaseAuth.ts");
    return getSupabaseClient().rpc(functionName, args);
  };
  return createGedcomExportOperations(rpc, wakeGedcomExport);
}

/**
 * Creates a durable server-side export job. The function returns as soon as
 * the job is queued; closing the page does not interrupt GEDCOM generation.
 */
export async function requestGedcomExport(
  projectId: string,
  treeId: string,
  operations: GedcomExportOperations = defaultOperations(),
): Promise<GedcomExportStatus> {
  if (!projectId.trim()) throw new Error("Не вказано проєкт для експорту GEDCOM.");
  if (!treeId.trim()) throw new Error("Не вибрано дерево для експорту GEDCOM.");

  const status = await operations.start(projectId, treeId);
  if (
    status.status === "queued" ||
    status.status === "running" ||
    (status.status === "failed" && status.retryable)
  ) {
    try {
      await operations.wake(status.jobId);
    } catch (error) {
      // The durable cron worker will claim the queued job. A transient wake-up
      // failure must not turn an accepted export request into a client error.
      console.warn("GEDCOM export worker wake-up failed; cron will retry", error);
    }
  }
  return status;
}

export async function getGedcomExportStatus(jobId: string): Promise<GedcomExportStatus> {
  if (!jobId.trim()) throw new Error("Не вказано завдання експорту GEDCOM.");
  return defaultOperations().getStatus(jobId);
}
