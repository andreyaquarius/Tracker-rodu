import type { FamilyTreeLayoutInput, LayoutResult } from "../types.ts";

export interface LayoutWorkerRequest {
  type: "LAYOUT";
  revision: number;
  input: FamilyTreeLayoutInput;
}

export interface LayoutWorkerCancelRequest {
  type: "CANCEL_BEFORE";
  revision: number;
}

export type FamilyTreeWorkerRequest =
  | LayoutWorkerRequest
  | LayoutWorkerCancelRequest;

export interface LayoutWorkerResponse {
  type: "LAYOUT_RESULT";
  revision: number;
  result: LayoutResult;
}

export interface LayoutWorkerErrorResponse {
  type: "LAYOUT_ERROR";
  revision: number;
  message: string;
}

export type FamilyTreeWorkerResponse =
  | LayoutWorkerResponse
  | LayoutWorkerErrorResponse;
