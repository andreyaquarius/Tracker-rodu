import type {
  DescendantFrontierPageRequest,
  DescendantFrontierPageResponse,
  FamilyBranchRequest,
  FamilyBranchResponse,
  FamilyTreeNeighborhoodClient,
  NeighborhoodRequest,
  NeighborhoodResponse,
} from "../features/family-tree-view/data/neighborhoodClient";
import {
  createCachedNeighborhoodClient,
} from "../features/family-tree-view/data/neighborhoodClient";
import { getSupabaseClient } from "./supabaseAuth.ts";
import { databaseStatementTimeoutMessage } from "../utils/databaseErrors.ts";

export interface FamilyTreeEntryPoint {
  id: string;
  projectId: string;
  title: string;
  rootPersonId: string | null;
  isDefault: boolean;
  graphVersion: string;
}

type FamilyTreeEntryPointRow = {
  id: string;
  project_id: string;
  title: string;
  root_person_id: string | null;
  is_default: boolean;
  graph_version: number | string;
};

const ENTRY_POINT_SELECT = "id, project_id, title, root_person_id, is_default, graph_version";

export async function readFamilyTreeEntryPoints(
  projectId: string,
): Promise<FamilyTreeEntryPoint[]> {
  const { data, error } = await getSupabaseClient()
    .from("family_trees")
    .select(ENTRY_POINT_SELECT)
    .eq("project_id", projectId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as FamilyTreeEntryPointRow[]).map(entryPointFromRow);
}

export function createTrackerNeighborhoodClient(): FamilyTreeNeighborhoodClient {
  return createCachedNeighborhoodClient(createAbortableSupabaseRpcClient(), 20);
}

function createAbortableSupabaseRpcClient(): FamilyTreeNeighborhoodClient {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

  return {
    async load(request: NeighborhoodRequest, signal?: AbortSignal): Promise<NeighborhoodResponse> {
      if (!supabaseUrl || !publishableKey) {
        throw new Error("Supabase не налаштовано для завантаження родового дерева.");
      }
      if (signal?.aborted) throw abortError();

      const { data: sessionData, error: sessionError } = await getSupabaseClient().auth.getSession();
      if (sessionError) throw sessionError;
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Сеанс завершився. Увійдіть знову, щоб відкрити дерево.");
      if (signal?.aborted) throw abortError();

      let response = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_family_tree_neighborhood_v2`,
        {
          method: "POST",
          headers: {
            apikey: publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ p_request: request }),
          signal,
        },
      );
      let payload = await response.json().catch(() => undefined) as unknown;
      if (!response.ok && isMissingRpcFunction(payload)) {
        response = await fetch(
          `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_family_tree_neighborhood_v1`,
          {
            method: "POST",
            headers: {
              apikey: publishableKey,
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ p_request: request }),
            signal,
          },
        );
        payload = await response.json().catch(() => undefined) as unknown;
      }
      if (!response.ok) {
        const message = databaseStatementTimeoutMessage(payload) ??
          readPostgrestError(payload) ??
          `Не вдалося завантажити оточення дерева (${response.status}).`;
        throw new Error(message);
      }
      return assertNeighborhoodResponse(payload);
    },
    async loadFamilyBranch(
      request: FamilyBranchRequest,
      signal?: AbortSignal,
    ): Promise<FamilyBranchResponse> {
      if (!supabaseUrl || !publishableKey) {
        throw new Error("Supabase не налаштовано для завантаження родового дерева.");
      }
      if (signal?.aborted) throw abortError();
      const { data: sessionData, error: sessionError } =
        await getSupabaseClient().auth.getSession();
      if (sessionError) throw sessionError;
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        throw new Error("Сеанс завершився. Увійдіть знову, щоб відкрити дерево.");
      }
      if (signal?.aborted) throw abortError();

      const response = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_family_tree_family_children_v1`,
        {
          method: "POST",
          headers: {
            apikey: publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            p_request: {
              treeId: request.treeId,
              scope: request.scope,
              ...(request.cursor === undefined
                ? {}
                : { cursor: request.cursor }),
              ...(request.pageSize === undefined
                ? {}
                : { pageSize: request.pageSize }),
              ...(request.knownGraphVersion === undefined
                ? {}
                : { knownGraphVersion: request.knownGraphVersion }),
              ...(request.permissionFingerprint === undefined
                ? {}
                : { permissionFingerprint: request.permissionFingerprint }),
            },
          }),
          signal,
        },
      );
      const payload = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        const message = databaseStatementTimeoutMessage(payload) ??
          readPostgrestError(payload) ??
          `Не вдалося завантажити дітей сімейної пари (${response.status}).`;
        throw new Error(message);
      }
      return assertFamilyBranchResponse(payload, request);
    },
    async loadDescendantFrontierPage(
      request: DescendantFrontierPageRequest,
      signal?: AbortSignal,
    ): Promise<DescendantFrontierPageResponse> {
      if (!supabaseUrl || !publishableKey) {
        throw new Error("Supabase не налаштовано для завантаження родового дерева.");
      }
      if (signal?.aborted) throw abortError();
      const { data: sessionData, error: sessionError } =
        await getSupabaseClient().auth.getSession();
      if (sessionError) throw sessionError;
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        throw new Error("Сеанс завершився. Увійдіть знову, щоб відкрити дерево.");
      }
      if (signal?.aborted) throw abortError();

      const response = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_family_tree_descendants_frontier_v1`,
        {
          method: "POST",
          headers: {
            apikey: publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ p_request: request }),
          signal,
        },
      );
      const payload = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        const message = databaseStatementTimeoutMessage(payload) ??
          readPostgrestError(payload) ??
          `Не вдалося завантажити пакет нащадків (${response.status}).`;
        throw new Error(message);
      }
      return assertDescendantFrontierPageResponse(payload, request);
    },
  };
}

function entryPointFromRow(row: FamilyTreeEntryPointRow): FamilyTreeEntryPoint {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    rootPersonId: row.root_person_id,
    isDefault: row.is_default,
    graphVersion: String(row.graph_version),
  };
}

function assertNeighborhoodResponse(value: unknown): NeighborhoodResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Сервер повернув некоректне оточення дерева.");
  }
  const candidate = value as Partial<NeighborhoodResponse>;
  if (!Array.isArray(candidate.persons) ||
      !Array.isArray(candidate.unions) ||
      !Array.isArray(candidate.parentChildRelations) ||
      !Array.isArray(candidate.continuations)) {
    throw new Error("У відповіді сервера бракує обов’язкових частин родового графа.");
  }
  if (candidate.persons.some((person) => !person || typeof person.id !== "string")) {
    throw new Error("Сервер повернув особу без канонічного ID.");
  }
  if (candidate.unions.some((union) =>
    !union || typeof union.id !== "string" || !Array.isArray(union.memberIds)
  )) {
    throw new Error("Сервер повернув некоректний сімейний union.");
  }
  if (candidate.parentChildRelations.some((relation) =>
    !relation ||
    typeof relation.id !== "string" ||
    typeof relation.parentId !== "string" ||
    typeof relation.childId !== "string"
  )) {
    throw new Error("Сервер повернув некоректний зв’язок між батьками й дитиною.");
  }
  if (
    candidate.familyContinuations !== undefined &&
    (!Array.isArray(candidate.familyContinuations) ||
      candidate.familyContinuations.some(continuation =>
        !continuation ||
        typeof continuation.id !== "string" ||
        typeof continuation.token !== "string" ||
        !continuation.scope ||
        typeof continuation.scope.id !== "string" ||
        !Array.isArray(continuation.scope.parentIds)
      ))
  ) {
    throw new Error("Сервер повернув некоректне сімейне продовження дерева.");
  }
  return candidate as NeighborhoodResponse;
}

function assertFamilyBranchResponse(
  value: unknown,
  request: FamilyBranchRequest,
): FamilyBranchResponse {
  const graph = assertNeighborhoodResponse(value);
  const candidate = value as Partial<FamilyBranchResponse>;
  if (
    !candidate.scope ||
    typeof candidate.scope.id !== "string" ||
    !Array.isArray(candidate.scope.parentIds) ||
    candidate.scope.id !== request.scope.id
  ) {
    throw new Error("Сервер повернув сімейну гілку для іншої пари.");
  }
  if (
    candidate.nextCursor !== undefined &&
    typeof candidate.nextCursor !== "string"
  ) {
    throw new Error("Сервер повернув некоректний курсор сімейної гілки.");
  }
  return { ...graph, ...candidate, scope: candidate.scope } as FamilyBranchResponse;
}

function assertDescendantFrontierPageResponse(
  value: unknown,
  request: DescendantFrontierPageRequest,
): DescendantFrontierPageResponse {
  const graph = assertNeighborhoodResponse(value);
  const candidate = value as Partial<DescendantFrontierPageResponse>;
  const progress = candidate.progress;
  if (
    !candidate.nextFrontier ||
    !Number.isInteger(candidate.nextFrontier.generation) ||
    !Array.isArray(candidate.nextFrontier.personIds) ||
    candidate.nextFrontier.personIds.some(personId => typeof personId !== "string") ||
    typeof candidate.hasMore !== "boolean" ||
    !progress ||
    !Number.isInteger(progress.currentGeneration) ||
    !Number.isInteger(progress.nextGeneration) ||
    !Number.isInteger(progress.frontierCount) ||
    !Number.isInteger(progress.pageSize) ||
    !Number.isInteger(progress.pageNumber) ||
    !Number.isInteger(progress.returnedDescendantCount) ||
    !Number.isInteger(progress.returnedPersonCount) ||
    !Number.isInteger(progress.returnedUnionCount) ||
    !Number.isInteger(progress.returnedRelationCount) ||
    typeof progress.frontierComplete !== "boolean" ||
    progress.currentGeneration !== request.frontier.generation ||
    candidate.nextFrontier.generation !== progress.nextGeneration ||
    (candidate.nextCursor !== undefined &&
      typeof candidate.nextCursor !== "string")
  ) {
    throw new Error("Сервер повернув некоректний пакет покоління нащадків.");
  }
  return { ...graph, ...candidate } as DescendantFrontierPageResponse;
}

function isMissingRpcFunction(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const code = (payload as { code?: unknown }).code;
  return code === "PGRST202" || code === "42883";
}

function readPostgrestError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
