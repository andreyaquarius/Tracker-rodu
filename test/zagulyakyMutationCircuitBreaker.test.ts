import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createZagulyakaMutationCircuitBreaker,
  isZagulyakaVersionConflict,
  ZagulyakaVersionConflictCircuitOpenError,
  type ZagulyakaVersionedMutation,
} from "../src/utils/zagulyakyMutationCircuitBreaker.ts";

const authorMutation: ZagulyakaVersionedMutation = {
  scope: "author",
  recordIds: ["record-a"],
  action: "submit_draft",
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test("recognises the Zagulyaky optimistic-lock marker and SQLSTATE", () => {
  assert.equal(isZagulyakaVersionConflict({ code: "40001", message: "other" }), true);
  assert.equal(isZagulyakaVersionConflict({ message: "ZAGULYAKA_VERSION_CONFLICT" }), true);
  assert.equal(isZagulyakaVersionConflict({ cause: { details: "SQLSTATE 40001" } }), true);
  assert.equal(isZagulyakaVersionConflict({ code: "23505", message: "duplicate key" }), false);
});

test("shares one in-flight mutation and blocks a rejected stale version until a fresh read", async () => {
  const circuit = createZagulyakaMutationCircuitBreaker();
  const gate = deferred<void>();
  let invokes = 0;
  const first = circuit.run(authorMutation, async () => {
    invokes += 1;
    await gate.promise;
    throw { code: "40001", message: "ZAGULYAKA_VERSION_CONFLICT" };
  });
  const duplicate = circuit.run(authorMutation, async () => {
    invokes += 1;
    return "must not run";
  });

  assert.strictEqual(duplicate, first);
  await Promise.resolve();
  assert.equal(invokes, 1);

  gate.resolve();
  await assert.rejects(first, error => error instanceof Object && "code" in error && error.code === "40001");
  await assert.rejects(duplicate, error => error instanceof Object && "code" in error && error.code === "40001");

  await assert.rejects(
    circuit.run(authorMutation, async () => {
      invokes += 1;
      return "must not run";
    }),
    error => error instanceof ZagulyakaVersionConflictCircuitOpenError &&
      error.code === "ZAGULYAKA_VERSION_CONFLICT_CIRCUIT_OPEN",
  );
  assert.equal(invokes, 1, "the opened circuit must not make another RPC");

  circuit.markRecordFresh("author", "record-a");
  assert.equal(await circuit.run(authorMutation, async () => {
    invokes += 1;
    return "fresh lock version";
  }), "fresh lock version");
  assert.equal(invokes, 2);
});

test("keeps the circuit narrow to an action and scope", async () => {
  const circuit = createZagulyakaMutationCircuitBreaker();
  await assert.rejects(
    circuit.run(authorMutation, async () => {
      throw { message: "ZAGULYAKA_VERSION_CONFLICT" };
    }),
  );

  assert.equal(await circuit.run({ ...authorMutation, action: "withdraw_draft" }, async () => "other action"), "other action");
  assert.equal(await circuit.run({ ...authorMutation, scope: "admin" }, async () => "other scope"), "other scope");
  assert.equal(await circuit.run({ ...authorMutation, recordIds: ["record-b"] }, async () => "other record"), "other record");
});

test("does not re-open a circuit when a fresh load finishes before an older failure returns", async () => {
  const circuit = createZagulyakaMutationCircuitBreaker();
  const gate = deferred<void>();
  const request = circuit.run(authorMutation, async () => {
    await gate.promise;
    throw { code: "40001" };
  });
  await Promise.resolve();

  circuit.markRecordFresh("author", "record-a");
  gate.resolve();
  await assert.rejects(request);
  assert.equal(await circuit.run(authorMutation, async () => "fresh request"), "fresh request");
});

test("a failed merge guards both stale records until both are refreshed", async () => {
  const circuit = createZagulyakaMutationCircuitBreaker();
  const merge: ZagulyakaVersionedMutation = {
    scope: "admin",
    recordIds: ["survivor", "merged"],
    action: "merge_duplicate",
  };
  await assert.rejects(circuit.run(merge, async () => {
    throw { code: "40001" };
  }));

  circuit.markRecordFresh("admin", "survivor");
  await assert.rejects(circuit.run(merge, async () => "must not run"), ZagulyakaVersionConflictCircuitOpenError);

  circuit.markRecordFresh("admin", "merged");
  assert.equal(await circuit.run(merge, async () => "merged safely"), "merged safely");
});

test("every versioned Zagulyaky RPC is routed through the local breaker and current-version reads rebase it", () => {
  const authorService = readFileSync(
    new URL("../src/services/zagulyakyService.ts", import.meta.url),
    "utf8",
  );
  const adminService = readFileSync(
    new URL("../src/services/zagulyakyAdminService.ts", import.meta.url),
    "utf8",
  );

  for (const rpcName of [
    "update_my_zagulyaka_draft_v1",
    "replace_my_zagulyaka_details_v1",
    "submit_zagulyaka_v1",
    "withdraw_zagulyaka_v1",
    "delete_my_zagulyaka_draft_v3",
    "attach_my_zagulyaka_file_v1",
    "delete_my_zagulyaka_attachment_v2",
  ]) {
    const rpcIndex = authorService.indexOf(`rpc(\"${rpcName}\"`);
    assert.notEqual(rpcIndex, -1, `${rpcName} must remain a client mutation`);
    assert.match(authorService.slice(Math.max(0, rpcIndex - 1_800), rpcIndex), /runZagulyakaVersionedMutation/);
  }
  for (const rpcName of ["admin_review_zagulyaka_v1", "admin_merge_zagulyaka_duplicate_v1"]) {
    const rpcIndex = adminService.indexOf(`rpc(\"${rpcName}\"`);
    assert.notEqual(rpcIndex, -1, `${rpcName} must remain a client mutation`);
    assert.match(adminService.slice(Math.max(0, rpcIndex - 1_800), rpcIndex), /runZagulyakaVersionedMutation/);
  }

  assert.match(
    section(authorService, "export async function loadMyZagulyaky(", "export async function loadMyZagulyakaDraft("),
    /markZagulyakaRecordFresh\(\"author"/,
  );
  assert.match(
    section(authorService, "export async function loadMyZagulyakaDraft(", "export async function createZagulyakaDraft("),
    /markZagulyakaRecordFresh\(\"author"/,
  );
  assert.match(
    section(adminService, "export async function loadAdminZagulyakyQueue(", "export async function loadAdminZagulyakaDetail("),
    /markZagulyakaRecordFresh\(\"admin"/,
  );
  assert.match(
    section(adminService, "export async function loadAdminZagulyakaDetail(", "export async function loadAdminZagulyakaPrivacyClearance("),
    /markZagulyakaRecordFresh\(\"admin"/,
  );
});
