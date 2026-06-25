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

export async function createGeneHelpSimpleRequest(input: {
  title?: string;
  description: string;
}): Promise<GeneHelpSimpleRequestResponse> {
  return invokeGeneHelp<GeneHelpSimpleRequestResponse>("create-simple-request", input);
}

export async function getGeneHelpRequestStatus(id: string): Promise<GeneHelpSimpleRequestResponse> {
  return invokeGeneHelp<GeneHelpSimpleRequestResponse>("get-status", { id });
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
