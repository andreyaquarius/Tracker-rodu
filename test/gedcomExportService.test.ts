import assert from "node:assert/strict";
import test from "node:test";

import {
  createGedcomExportOperations,
  parseGedcomExportStatus,
  requestGedcomExport,
} from "../src/services/gedcomExportService.ts";

const queuedPayload = {
  jobId: "job-1",
  projectId: "project-1",
  treeId: "tree-1",
  treeTitle: "Родина",
  status: "queued",
  phase: "queued",
  progressPercent: 0,
  personCount: 0,
  familyCount: 0,
  warningCount: 0,
  fileName: "rodyna.ged",
  fileSize: 0,
  emailStatus: "pending",
  retryable: false,
  createdAt: "2026-07-19T10:00:00Z",
  updatedAt: "2026-07-19T10:00:00Z",
};

test("GEDCOM export status parser accepts the durable job payload", () => {
  const parsed = parseGedcomExportStatus(queuedPayload);
  assert.equal(parsed.jobId, "job-1");
  assert.equal(parsed.treeTitle, "Родина");
  assert.equal(parsed.status, "queued");
  assert.equal(parsed.downloadUrl, null);
  assert.equal(parsed.emailStatus, "pending");
});

test("SQL processing and not_ready email states normalize to client states", () => {
  const parsed = parseGedcomExportStatus({
    ...queuedPayload,
    status: "processing",
    emailStatus: "not_ready",
    progressPercent: 37,
  });
  assert.equal(parsed.status, "running");
  assert.equal(parsed.emailStatus, "pending");
  assert.equal(parsed.progressPercent, 37);
});

test("completed payload keeps its signed download metadata", () => {
  const parsed = parseGedcomExportStatus({
    ...queuedPayload,
    status: "completed",
    emailStatus: "sent",
    downloadUrl: "https://storage.example/signed",
    expiresAt: "2026-07-26T10:00:00Z",
    completedAt: "2026-07-19T10:02:00Z",
  });
  assert.equal(parsed.downloadUrl, "https://storage.example/signed");
  assert.equal(parsed.expiresAt, "2026-07-26T10:00:00Z");
  assert.equal(parsed.emailStatus, "sent");
});

test("requestGedcomExport starts the job and wakes the worker without polling", async () => {
  const calls: string[] = [];
  const operations = createGedcomExportOperations(
    async (name, args) => {
      calls.push(`${name}:${String(args.target_tree_id ?? "")}`);
      return { data: queuedPayload, error: null };
    },
    async (jobId) => {
      calls.push(`wake:${jobId}`);
    },
  );

  const result = await requestGedcomExport("project-1", "tree-1", operations);
  assert.equal(result.status, "queued");
  assert.deepEqual(calls, ["start_gedcom_export:tree-1", "wake:job-1"]);
});

test("an immediate wake-up failure does not lose an already queued export", async () => {
  const operations = createGedcomExportOperations(
    async () => ({ data: queuedPayload, error: null }),
    async () => {
      throw new Error("temporary worker outage");
    },
  );

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const result = await requestGedcomExport("project-1", "tree-1", operations);
    assert.equal(result.jobId, "job-1");
  } finally {
    console.warn = originalWarn;
  }
});

test("retryable failed jobs are woken again, terminal failed jobs are not", async () => {
  const wakes: string[] = [];
  const retryableOperations = createGedcomExportOperations(
    async () => ({
      data: {
        ...queuedPayload,
        status: "failed",
        retryable: true,
        nextAttemptAt: "2026-07-19T10:01:00Z",
      },
      error: null,
    }),
    async (jobId) => { wakes.push(jobId); },
  );
  const terminalOperations = createGedcomExportOperations(
    async () => ({
      data: { ...queuedPayload, status: "failed", retryable: false },
      error: null,
    }),
    async (jobId) => { wakes.push(`terminal:${jobId}`); },
  );

  const retryable = await requestGedcomExport("project-1", "tree-1", retryableOperations);
  const terminal = await requestGedcomExport("project-1", "tree-1", terminalOperations);
  assert.equal(retryable.retryable, true);
  assert.equal(terminal.retryable, false);
  assert.deepEqual(wakes, ["job-1"]);
});

test("getStatus uses the target_job_id RPC contract", async () => {
  const seen: Array<[string, Record<string, unknown>]> = [];
  const operations = createGedcomExportOperations(
    async (name, args) => {
      seen.push([name, args]);
      return { data: queuedPayload, error: null };
    },
    async () => undefined,
  );
  await operations.getStatus("job-1");
  assert.deepEqual(seen, [["get_gedcom_export_status", { target_job_id: "job-1" }]]);
});

test("plain PostgREST errors keep their useful message", async () => {
  const operations = createGedcomExportOperations(
    async () => ({
      data: null,
      error: { message: "TREE_NOT_FOUND", details: "The tree is missing" },
    }),
    async () => undefined,
  );

  await assert.rejects(
    requestGedcomExport("project-1", "tree-1", operations),
    /TREE_NOT_FOUND The tree is missing/,
  );
});
