/// <reference lib="webworker" />

import { layoutFamilyGraph } from "../layout/layoutFamilyGraph.ts";
import { layoutDescendantForest } from "../layout/layoutDescendantForest.ts";
import type {
  FamilyTreeWorkerRequest,
  FamilyTreeWorkerResponse,
} from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

let minimumRevision = 0;

self.onmessage = (event: MessageEvent<FamilyTreeWorkerRequest>): void => {
  const message = event.data;
  if (message.type === "CANCEL_BEFORE") {
    minimumRevision = Math.max(minimumRevision, message.revision);
    return;
  }
  if (message.revision < minimumRevision) return;

  try {
    const result = message.input.options.layoutMode === "descendant-forest"
      ? layoutDescendantForest(message.input)
      : layoutFamilyGraph(message.input);
    if (message.revision < minimumRevision) return;
    const response: FamilyTreeWorkerResponse = {
      type: "LAYOUT_RESULT",
      revision: message.revision,
      result,
    };
    self.postMessage(response);
  } catch (error) {
    const response: FamilyTreeWorkerResponse = {
      type: "LAYOUT_ERROR",
      revision: message.revision,
      message: error instanceof Error ? error.message : "Unknown layout error",
    };
    self.postMessage(response);
  }
};

export {};
