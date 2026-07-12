"use client";

import { useEffect, useRef, useState } from "react";
import type {
  FamilyGraphData,
  FamilyTreeLayoutOptions,
  LayoutResult,
  OccurrenceId,
} from "../types.ts";
import type { LayoutWorkerRequest } from "../worker/protocol.ts";
import { runFamilyTreeLayoutTask } from "./familyTreeLayoutTask.ts";

export interface UseFamilyTreeLayoutInput {
  graph: FamilyGraphData;
  options: FamilyTreeLayoutOptions;
  preserveAnchorOccurrenceId?: OccurrenceId | undefined;
  workerFactory?: (() => Worker) | undefined;
}

export interface UseFamilyTreeLayoutResult {
  layout: LayoutResult | undefined;
  loading: boolean;
  error: Error | undefined;
  revision: number;
  anchorShift: { x: number; y: number } | undefined;
}

function defaultWorkerFactory(): Worker {
  return new Worker(
    new URL("../worker/familyTreeLayout.worker.ts", import.meta.url),
    { type: "module", name: "family-tree-layout" },
  );
}

export function familyTreeLayoutAnchorPoint(
  layout: LayoutResult | undefined,
  occurrenceId: OccurrenceId | undefined,
): { x: number; y: number } | undefined {
  if (!layout || !occurrenceId) return undefined;
  const node = layout.nodes.find(candidate => candidate.occurrenceId === occurrenceId);
  if (node) return { x: node.x, y: node.y };
  const union = layout.unions.find(
    candidate => candidate.occurrenceId === occurrenceId,
  );
  return union ? { x: union.x, y: union.y } : undefined;
}

export function useFamilyTreeLayout({
  graph,
  options,
  preserveAnchorOccurrenceId,
  workerFactory = defaultWorkerFactory,
}: UseFamilyTreeLayoutInput): UseFamilyTreeLayoutResult {
  const [state, setState] = useState<UseFamilyTreeLayoutResult>({
    layout: undefined,
    loading: true,
    error: undefined,
    revision: 0,
    anchorShift: undefined,
  });
  const revisionRef = useRef(0);
  const previousLayoutRef = useRef<LayoutResult | undefined>(undefined);

  useEffect(() => {
    const revision = ++revisionRef.current;
    const previous = previousLayoutRef.current;
    const previousPositions = previous?.nodes.map(node => ({
      occurrenceId: node.occurrenceId,
      x: node.x,
      y: node.y,
    }));
    const retainedPositions = options.previousPositions ?? previousPositions;
    const effectiveOptions: FamilyTreeLayoutOptions = {
      ...options,
      ...(retainedPositions ? { previousPositions: retainedPositions } : {}),
    };
    const input = { graph, options: effectiveOptions };
    let disposed = false;

    setState(current => ({
      ...current,
      loading: true,
      error: undefined,
      revision,
    }));

    const accept = (layout: LayoutResult): void => {
      if (disposed || revision !== revisionRef.current) return;
      const oldAnchor = familyTreeLayoutAnchorPoint(
        previous,
        preserveAnchorOccurrenceId,
      );
      const newAnchor = familyTreeLayoutAnchorPoint(
        layout,
        preserveAnchorOccurrenceId,
      );
      const anchorShift =
        oldAnchor && newAnchor
          ? { x: newAnchor.x - oldAnchor.x, y: newAnchor.y - oldAnchor.y }
          : undefined;
      previousLayoutRef.current = layout;
      setState({
        layout,
        loading: false,
        error: undefined,
        revision,
        anchorShift,
      });
    };

    const fail = (message: string): void => {
      if (disposed || revision !== revisionRef.current) return;
      setState({
        layout: previousLayoutRef.current,
        loading: false,
        revision,
        error: new Error(message),
        anchorShift: undefined,
      });
    };

    const request: LayoutWorkerRequest = { type: "LAYOUT", revision, input };
    const createWorker =
      typeof Worker === "undefined" && workerFactory === defaultWorkerFactory
        ? undefined
        : workerFactory;
    const cancelTask = runFamilyTreeLayoutTask({
      request,
      ...(createWorker ? { createWorker } : {}),
      onResult: accept,
      onError: fail,
    });
    return () => {
      disposed = true;
      cancelTask();
    };
  }, [graph, options, preserveAnchorOccurrenceId, workerFactory]);

  return state;
}
