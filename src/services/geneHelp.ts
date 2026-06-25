import { getSupabaseClient } from "./supabaseAuth";

export interface GeneHelpStatus {
  code?: string;
  request_status?: string;
  draft_state?: string;
  creation_mode?: string;
  ready?: boolean;
  owner_action_required?: boolean;
  failed?: boolean;
  updated_at?: string;
  message?: string;
}

export interface GeneHelpSimpleRequestResponse {
  id: string;
  message?: string;
  status?: GeneHelpStatus;
  links?: {
    view?: string;
    edit?: string;
    status?: string;
  };
  meta?: {
    is_test?: boolean;
  };
  data?: unknown;
}

export interface GeneHelpStoredRequest extends GeneHelpSimpleRequestResponse {
  title?: string | null;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  lastCheckedAt?: string | null;
}

export interface GeneHelpRequestListResponse {
  requests: GeneHelpStoredRequest[];
}

export interface GeneHelpAccountStatus {
  connected: boolean;
  email: string;
  name: string;
}

export async function getGeneHelpAccountStatus(): Promise<GeneHelpAccountStatus> {
  return invokeGeneHelp<GeneHelpAccountStatus>("account-status", {});
}

export async function createGeneHelpSimpleRequest(input: {
  title?: string;
  description: string;
  registrationConsent?: boolean;
}): Promise<GeneHelpSimpleRequestResponse> {
  return invokeGeneHelp<GeneHelpSimpleRequestResponse>("create-simple-request", input);
}

export async function getGeneHelpRequestStatus(id: string): Promise<GeneHelpSimpleRequestResponse> {
  return invokeGeneHelp<GeneHelpSimpleRequestResponse>("get-status", { id });
}

export async function listGeneHelpRequests(): Promise<GeneHelpRequestListResponse> {
  return invokeGeneHelp<GeneHelpRequestListResponse>("list-requests", {});
}

async function invokeGeneHelp<T = unknown>(
  action: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await getSupabaseClient().functions.invoke("genehelp", {
    body: { action, ...body },
  });
  if (error) {
    const context = "context" in error ? error.context : null;
    if (context instanceof Response) {
      try {
        const payload = await context.clone().json() as { error?: string };
        if (payload.error) throw new Error(readableGeneHelpError(payload.error));
      } catch (contextError) {
        if (contextError instanceof Error && contextError.message !== "Unexpected end of JSON input") {
          throw contextError;
        }
      }
    }
    if (error instanceof Error && error.message.includes("Failed to send a request to the Edge Function")) {
      throw new Error("Не вдалося підключитися до серверної функції GeneHelp. Перевірте, що Edge Function genehelp передеплоєна.");
    }
    throw error;
  }
  if (hasErrorPayload(data)) throw new Error(readableGeneHelpError(String(data.error)));
  return data as T;
}

function hasErrorPayload(value: unknown): value is { error: unknown } {
  return Boolean(value && typeof value === "object" && "error" in value);
}

function readableGeneHelpError(message: string): string {
  if (message.includes("JWT") || message.includes("auth")) {
    return "Потрібно увійти в акаунт, щоб користуватися GeneHelp.";
  }
  return message;
}
