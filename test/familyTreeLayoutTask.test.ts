import assert from "node:assert/strict";
import test from "node:test";
import {
  runFamilyTreeLayoutTask,
} from "../src/features/family-tree-view/react/familyTreeLayoutTask.ts";
import type {
  FamilyTreeLayoutInput,
  LayoutResult,
} from "../src/features/family-tree-view/types.ts";
import type {
  FamilyTreeWorkerRequest,
  FamilyTreeWorkerResponse,
  LayoutWorkerRequest,
} from "../src/features/family-tree-view/worker/protocol.ts";

type Listener = (event: any) => void;

class MockWorker {
  readonly messages: FamilyTreeWorkerRequest[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  terminated = false;
  throwOnPost = false;
  errorPrevented = false;

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: FamilyTreeWorkerRequest): void {
    if (this.throwOnPost) throw new DOMException("clone", "DataCloneError");
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(response: FamilyTreeWorkerResponse): void {
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      listener({ data: response });
    }
  }

  emitError(): void {
    const event = {
      preventDefault: () => {
        this.errorPrevented = true;
      },
    };
    for (const listener of [...(this.listeners.get("error") ?? [])]) {
      listener(event);
    }
  }
}

function input(): FamilyTreeLayoutInput {
  return {
    graph: { persons: [], unions: [], parentChildRelations: [] },
    options: { focusPersonId: "focus" },
  };
}

function request(revision: number): LayoutWorkerRequest {
  return { type: "LAYOUT", revision, input: input() };
}

function layout(marker = 0): LayoutResult {
  return {
    nodes: [],
    unions: [],
    edges: [],
    bounds: { left: marker, top: 0, right: marker, bottom: 0 },
    generationBands: [],
    warnings: [],
  };
}

function asWorkerFactory(worker: MockWorker): () => Worker {
  return () => worker as unknown as Worker;
}

function waitForFallback(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5));
}

test("a worker task accepts only its own revision and terminates after success", () => {
  const worker = new MockWorker();
  const results: LayoutResult[] = [];
  const cancel = runFamilyTreeLayoutTask({
    request: request(4),
    createWorker: asWorkerFactory(worker),
    onResult: result => results.push(result),
    onError: message => assert.fail(message),
  });

  assert.deepEqual(worker.messages.map(message => message.type), ["LAYOUT"]);
  worker.emitMessage({ type: "LAYOUT_RESULT", revision: 3, result: layout(3) });
  assert.equal(results.length, 0);
  worker.emitMessage({ type: "LAYOUT_RESULT", revision: 4, result: layout(4) });
  assert.equal(results[0]?.bounds.left, 4);
  assert.equal(worker.terminated, true);
  cancel();
});

test("cancel terminates CPU work and a late stale result is never accepted", () => {
  const first = new MockWorker();
  const second = new MockWorker();
  const results: number[] = [];
  const cancelFirst = runFamilyTreeLayoutTask({
    request: request(1),
    createWorker: asWorkerFactory(first),
    onResult: result => results.push(result.bounds.left),
    onError: message => assert.fail(message),
  });
  cancelFirst();
  assert.equal(first.terminated, true);
  first.emitMessage({ type: "LAYOUT_RESULT", revision: 1, result: layout(1) });

  const cancelSecond = runFamilyTreeLayoutTask({
    request: request(2),
    createWorker: asWorkerFactory(second),
    onResult: result => results.push(result.bounds.left),
    onError: message => assert.fail(message),
  });
  second.emitMessage({ type: "LAYOUT_RESULT", revision: 2, result: layout(2) });
  assert.deepEqual(results, [2]);
  cancelSecond();
});

test("runtime worker errors terminate the worker and recover through fallback", async () => {
  const worker = new MockWorker();
  const results: number[] = [];
  let fallbackCalls = 0;
  const cancel = runFamilyTreeLayoutTask({
    request: request(7),
    createWorker: asWorkerFactory(worker),
    calculateFallback: () => {
      fallbackCalls += 1;
      return layout(70);
    },
    onResult: result => results.push(result.bounds.left),
    onError: message => assert.fail(message),
  });

  worker.emitError();
  await waitForFallback();
  assert.equal(worker.errorPrevented, true);
  assert.equal(worker.terminated, true);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(results, [70]);
  cancel();
});

test("worker creation and postMessage failures use one cancellable fallback", async () => {
  const creationResults: number[] = [];
  runFamilyTreeLayoutTask({
    request: request(8),
    createWorker: () => {
      throw new Error("worker unavailable");
    },
    calculateFallback: () => layout(80),
    onResult: result => creationResults.push(result.bounds.left),
    onError: message => assert.fail(message),
  });

  const postWorker = new MockWorker();
  postWorker.throwOnPost = true;
  const postResults: number[] = [];
  const cancelPost = runFamilyTreeLayoutTask({
    request: request(9),
    createWorker: asWorkerFactory(postWorker),
    calculateFallback: () => layout(90),
    onResult: result => postResults.push(result.bounds.left),
    onError: message => assert.fail(message),
  });
  await waitForFallback();
  assert.deepEqual(creationResults, [80]);
  assert.deepEqual(postResults, [90]);
  assert.equal(postWorker.terminated, true);

  const canceledResults: number[] = [];
  const cancelBeforeFallback = runFamilyTreeLayoutTask({
    request: request(10),
    calculateFallback: () => layout(100),
    onResult: result => canceledResults.push(result.bounds.left),
    onError: message => assert.fail(message),
  });
  cancelBeforeFallback();
  await waitForFallback();
  assert.deepEqual(canceledResults, []);
  cancelPost();
});
