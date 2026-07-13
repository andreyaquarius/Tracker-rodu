import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectDeletionOperations,
  isTransientProjectDeletionError,
  resumeProjectDeletion,
  runProjectDeletion,
  shouldWakeResumedProjectDeletion,
  type ProjectDeletionOperations,
  type ProjectDeletionRpc,
  type ProjectDeletionStatus,
} from "../src/services/projectDeletion.ts";

function status(
  state: ProjectDeletionStatus["status"],
  overrides: Partial<ProjectDeletionStatus> = {},
): ProjectDeletionStatus {
  return {
    jobId: "job-1",
    projectId: "project-1",
    status: state,
    phase: state === "completed" ? "completed" : "persons",
    processedRows: 0,
    totalRows: 0,
    completedTables: 0,
    totalTables: 2,
    progressPercent: 0,
    error: null,
    createdAt: "2026-07-13T10:00:00Z",
    updatedAt: "2026-07-13T10:00:00Z",
    ...overrides,
  };
}

test("project deletion starts once, wakes Edge once and only polls status", async () => {
  const statusReplies = [
    status("running", { processedRows: 250, progressPercent: 45 }),
    status("completed", {
      processedRows: 500,
      completedTables: 2,
      progressPercent: 100,
    }),
  ];
  const calls: string[] = [];
  const progress: number[] = [];
  const operations: ProjectDeletionOperations = {
    start: async (projectId) => {
      calls.push(`start:${projectId}`);
      return status("queued");
    },
    wake: async (jobId) => { calls.push(`wake:${jobId}`); },
    getStatus: async (jobId) => {
      calls.push(`status:${jobId}`);
      return statusReplies.shift()!;
    },
  };

  const result = await runProjectDeletion(operations, "project-1", {
    retryDelayMs: 0,
    pollIntervalMs: 0,
    onProgress: (current) => progress.push(current.progressPercent),
    waitForNextPoll: async () => undefined,
  });
  await Promise.resolve();

  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    "start:project-1",
    "wake:job-1",
    "status:job-1",
    "status:job-1",
  ]);
  assert.deepEqual(progress, [0, 45, 100]);
  assert.equal(calls.some((call) => call.startsWith("process:")), false);
});

test("a failed Edge wake does not cancel the durable queued job", async () => {
  const wakeErrors: unknown[] = [];
  let statusCalls = 0;
  const operations: ProjectDeletionOperations = {
    start: async () => status("queued"),
    wake: async () => { throw { status: 503, message: "Service unavailable" }; },
    getStatus: async () => {
      statusCalls += 1;
      return status("completed", { progressPercent: 100 });
    },
  };

  const result = await runProjectDeletion(operations, "project-1", {
    retryDelayMs: 0,
    maxTransientRetries: 1,
    pollIntervalMs: 0,
    waitForNextPoll: async () => undefined,
    onWakeError: (error) => wakeErrors.push(error),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(result.status, "completed");
  assert.equal(statusCalls, 1);
  assert.equal(wakeErrors.length, 1);
});

test("transient polling failures retry and permanent polling failures stop", async () => {
  let pollingCalls = 0;
  const transientOperations: ProjectDeletionOperations = {
    start: async () => status("queued"),
    wake: async () => undefined,
    getStatus: async () => {
      pollingCalls += 1;
      if (pollingCalls < 3) throw { code: "57014", message: "statement timeout" };
      return status("completed", { progressPercent: 100 });
    },
  };
  await runProjectDeletion(transientOperations, "project-1", {
    retryDelayMs: 0,
    maxTransientRetries: 2,
    pollIntervalMs: 0,
    waitForNextPoll: async () => undefined,
  });
  assert.equal(pollingCalls, 3);

  let permanentCalls = 0;
  const permanentOperations: ProjectDeletionOperations = {
    start: async () => status("queued"),
    wake: async () => undefined,
    getStatus: async () => {
      permanentCalls += 1;
      throw { code: "42501", message: "permission denied" };
    },
  };
  await assert.rejects(
    runProjectDeletion(permanentOperations, "project-1", {
      retryDelayMs: 0,
      pollIntervalMs: 0,
      waitForNextPoll: async () => undefined,
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "42501"),
  );
  assert.equal(permanentCalls, 1);
});

test("the Supabase adapter uses start and status RPCs but no process RPC", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const wakes: string[] = [];
  const rpc: ProjectDeletionRpc = async (name, args) => {
    rpcCalls.push({ name, args });
    return {
      data: name === "start_project_deletion"
        ? status("queued")
        : status("completed", { progressPercent: 100 }),
      error: null,
    };
  };
  const operations = createProjectDeletionOperations(rpc, async (jobId) => {
    wakes.push(jobId);
  });

  await runProjectDeletion(operations, "project-1", {
    retryDelayMs: 0,
    pollIntervalMs: 0,
    waitForNextPoll: async () => undefined,
  });
  await Promise.resolve();

  assert.deepEqual(rpcCalls, [
    { name: "start_project_deletion", args: { target_project_id: "project-1" } },
    { name: "get_project_deletion_status", args: { target_job_id: "job-1" } },
  ]);
  assert.deepEqual(wakes, ["job-1"]);
});

test("a completed start response returns without waking or polling", async () => {
  let wakeCalls = 0;
  let statusCalls = 0;
  const result = await runProjectDeletion({
    start: async () => status("completed", { progressPercent: 100 }),
    wake: async () => { wakeCalls += 1; },
    getStatus: async () => {
      statusCalls += 1;
      return status("completed", { progressPercent: 100 });
    },
  }, "project-1", {
    retryDelayMs: 0,
    waitForNextPoll: async () => undefined,
  });
  assert.equal(result.status, "completed");
  assert.equal(wakeCalls, 0);
  assert.equal(statusCalls, 0);
});

test("resuming a queued deletion reuses the durable job without starting another", async () => {
  const calls: string[] = [];
  const operations: ProjectDeletionOperations = {
    start: async (projectId) => {
      calls.push(`start:${projectId}`);
      return status("running");
    },
    wake: async (jobId) => { calls.push(`wake:${jobId}`); },
    getStatus: async (jobId) => {
      calls.push(`status:${jobId}`);
      return calls.filter((call) => call.startsWith("status:")).length === 1
        ? status("queued", { processedRows: 250 })
        : status("completed", { processedRows: 500, progressPercent: 100 });
    },
  };

  const result = await resumeProjectDeletion(
    operations,
    "project-1",
    "job-1",
    {
      retryDelayMs: 0,
      pollIntervalMs: 0,
      waitForNextPoll: async () => undefined,
    },
  );
  await Promise.resolve();

  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    "status:job-1",
    "wake:job-1",
    "status:job-1",
  ]);
  assert.equal(calls.includes("start:project-1"), false);
});

test("a targeted wake can resume an existing failed durable job", async () => {
  let statusReads = 0;
  let wakeCalls = 0;
  let startCalls = 0;
  const result = await resumeProjectDeletion({
    start: async () => {
      startCalls += 1;
      return status("queued", { error: null });
    },
    wake: async () => { wakeCalls += 1; },
    getStatus: async () => {
      statusReads += 1;
      return statusReads === 1
        ? status("failed", { error: "temporary worker error" })
        : status("completed", { progressPercent: 100 });
    },
  }, "project-1", "job-1", {
    retryDelayMs: 0,
    pollIntervalMs: 0,
    waitForNextPoll: async () => undefined,
  });
  await Promise.resolve();

  assert.equal(result.status, "completed");
  assert.equal(startCalls, 1);
  assert.equal(wakeCalls, 1);
});

test("failed resume refuses a replacement job id", async () => {
  let wakeCalls = 0;
  await assert.rejects(
    resumeProjectDeletion({
      start: async () => status("queued", { jobId: "job-2" }),
      wake: async () => { wakeCalls += 1; },
      getStatus: async () => status("failed", { error: "temporary" }),
    }, "project-1", "job-1", {
      retryDelayMs: 0,
      pollIntervalMs: 0,
      waitForNextPoll: async () => undefined,
    }),
    /інше завдання видалення/i,
  );
  assert.equal(wakeCalls, 0);
});

test("viewing a fresh running deletion only polls and does not start a duplicate worker chain", async () => {
  let wakeCalls = 0;
  let statusReads = 0;
  const fresh = new Date().toISOString();
  const result = await resumeProjectDeletion({
    start: async () => status("running", { updatedAt: fresh }),
    wake: async () => { wakeCalls += 1; },
    getStatus: async () => {
      statusReads += 1;
      return statusReads === 1
        ? status("running", { updatedAt: fresh })
        : status("completed", { progressPercent: 100 });
    },
  }, "project-1", "job-1", {
    retryDelayMs: 0,
    pollIntervalMs: 0,
    waitForNextPoll: async () => undefined,
  });

  assert.equal(result.status, "completed");
  assert.equal(wakeCalls, 0);
});

test("resume wake policy recovers stale jobs but leaves active jobs alone", () => {
  const now = Date.parse("2026-07-13T20:00:00Z");
  assert.equal(shouldWakeResumedProjectDeletion(status("queued"), now), true);
  assert.equal(shouldWakeResumedProjectDeletion(status("failed"), now), true);
  assert.equal(shouldWakeResumedProjectDeletion(
    status("running", { updatedAt: "2026-07-13T19:59:10Z" }),
    now,
  ), false);
  assert.equal(shouldWakeResumedProjectDeletion(
    status("running", { updatedAt: "2026-07-13T19:57:59Z" }),
    now,
  ), true);
});

test("detaching client polling aborts locally without changing the durable job", async () => {
  const controller = new AbortController();
  let statusCalls = 0;
  await assert.rejects(
    runProjectDeletion({
      start: async () => status("queued"),
      wake: async () => undefined,
      getStatus: async () => {
        statusCalls += 1;
        return status("running");
      },
    }, "project-1", {
      signal: controller.signal,
      retryDelayMs: 0,
      pollIntervalMs: 0,
      waitForNextPoll: async () => { controller.abort(); },
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(statusCalls, 0);
});

test("project deletion transient classification excludes validation and permission errors", () => {
  assert.equal(isTransientProjectDeletionError({ status: 503, message: "Service unavailable" }), true);
  assert.equal(isTransientProjectDeletionError(new Error("Failed to fetch")), true);
  assert.equal(isTransientProjectDeletionError({ code: "23505", message: "duplicate key" }), false);
  assert.equal(isTransientProjectDeletionError({ code: "42501", message: "permission denied" }), false);
});
