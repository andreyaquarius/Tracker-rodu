import { layoutFamilyGraph } from "../layout/layoutFamilyGraph.ts";
import { layoutDescendantForest } from "../layout/layoutDescendantForest.ts";
import type { FamilyTreeLayoutInput, LayoutResult } from "../types.ts";
import type {
  FamilyTreeWorkerResponse,
  LayoutWorkerRequest,
} from "../worker/protocol.ts";

export interface FamilyTreeLayoutTaskOptions {
  request: LayoutWorkerRequest;
  /** Omit when Worker is unavailable; the task will use the safe fallback. */
  createWorker?: (() => Worker) | undefined;
  calculateFallback?: ((input: FamilyTreeLayoutInput) => LayoutResult) | undefined;
  onResult: (layout: LayoutResult) => void;
  onError: (message: string) => void;
}

/**
 * Runs one isolated layout revision. Cancelling terminates its dedicated
 * worker, which is the only reliable way to interrupt synchronous worker CPU.
 * Worker creation, postMessage, runtime and deserialization failures recover
 * through one cancellable main-thread fallback task.
 */
export function runFamilyTreeLayoutTask({
  request,
  createWorker,
  calculateFallback,
  onResult,
  onError,
}: FamilyTreeLayoutTaskOptions): () => void {
  let disposed = false;
  let worker: Worker | undefined;
  let fallbackHandle: ReturnType<typeof setTimeout> | undefined;
  let fallbackScheduled = false;
  const calculate = calculateFallback ?? (input =>
    input.options.layoutMode === "descendant-forest"
      ? layoutDescendantForest(input)
      : layoutFamilyGraph(input));

  let handleMessage:
    | ((event: MessageEvent<FamilyTreeWorkerResponse>) => void)
    | undefined;
  let handleWorkerError: ((event: ErrorEvent) => void) | undefined;
  let handleMessageError: ((event: MessageEvent<unknown>) => void) | undefined;

  const terminateWorker = (): void => {
    const current = worker;
    if (!current) return;
    if (handleMessage) current.removeEventListener("message", handleMessage);
    if (handleWorkerError) current.removeEventListener("error", handleWorkerError);
    if (handleMessageError) {
      current.removeEventListener("messageerror", handleMessageError);
    }
    try {
      current.terminate();
    } catch {
      // A failed/partially constructed worker may already be terminated.
    }
    if (worker === current) worker = undefined;
  };

  const scheduleFallback = (): void => {
    if (disposed || fallbackScheduled) return;
    fallbackScheduled = true;
    terminateWorker();
    fallbackHandle = setTimeout(() => {
      fallbackHandle = undefined;
      if (disposed) return;
      try {
        onResult(calculate(request.input));
      } catch (error) {
        onError(error instanceof Error ? error.message : "Layout failed");
      }
    }, 0);
  };

  if (!createWorker) {
    scheduleFallback();
  } else {
    try {
      worker = createWorker();
      handleMessage = (event): void => {
        if (disposed || event.data.revision !== request.revision) return;
        if (event.data.type === "LAYOUT_RESULT") {
          const result = event.data.result;
          terminateWorker();
          onResult(result);
          return;
        }
        // A worker-specific execution failure gets one deterministic fallback.
        scheduleFallback();
      };
      handleWorkerError = (event): void => {
        event.preventDefault();
        scheduleFallback();
      };
      handleMessageError = (): void => scheduleFallback();
      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleWorkerError);
      worker.addEventListener("messageerror", handleMessageError);
      worker.postMessage(request);
    } catch {
      scheduleFallback();
    }
  }

  return (): void => {
    if (disposed) return;
    disposed = true;
    if (fallbackHandle !== undefined) clearTimeout(fallbackHandle);
    fallbackHandle = undefined;
    terminateWorker();
  };
}
