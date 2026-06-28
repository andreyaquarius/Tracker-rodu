import { getSupabaseClient } from "./supabaseAuth";

type EdgeFunctionOptions = {
  connectionErrorMessage?: string;
};

export async function invokeEdgeFunction<T>(
  name: string,
  body: Record<string, unknown>,
  options: EdgeFunctionOptions = {},
): Promise<T> {
  const localFunctionsUrl = import.meta.env.VITE_LOCAL_EDGE_FUNCTIONS_URL?.trim();
  if (localFunctionsUrl) {
    return invokeLocalEdgeFunction<T>(localFunctionsUrl, name, body, options);
  }

  const { data, error } = await getSupabaseClient().functions.invoke(name, { body });
  if (error) {
    const contextMessage = await readSupabaseFunctionError(error);
    if (contextMessage) throw new Error(contextMessage);
    if (
      options.connectionErrorMessage &&
      error instanceof Error &&
      error.message.includes("Failed to send a request to the Edge Function")
    ) {
      throw new Error(options.connectionErrorMessage);
    }
    throw error;
  }
  if (hasErrorPayload(data)) throw new Error(String(data.error));
  return data as T;
}

async function invokeLocalEdgeFunction<T>(
  localFunctionsUrl: string,
  name: string,
  body: Record<string, unknown>,
  options: EdgeFunctionOptions,
): Promise<T> {
  const { data: sessionData, error: sessionError } = await getSupabaseClient().auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData.session?.access_token;
  if (!token) {
    throw new Error("Увійдіть в акаунт перед локальною перевіркою Edge Function.");
  }

  const baseUrl = localFunctionsUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      options.connectionErrorMessage ||
        `Не вдалося підключитися до локальної Edge Function ${name}. Перевірте, що вона запущена на ${baseUrl}.`,
    );
  }

  const payload = await readJsonSafely(response);
  if (!response.ok) {
    const message = hasErrorPayload(payload) ? String(payload.error) : "";
    throw new Error(message || `Локальна Edge Function ${name} повернула помилку ${response.status}.`);
  }
  if (hasErrorPayload(payload)) throw new Error(String(payload.error));
  return payload as T;
}

async function readSupabaseFunctionError(error: unknown): Promise<string | null> {
  if (!error || typeof error !== "object" || !("context" in error)) return null;
  const context = (error as { context?: unknown }).context;
  if (!(context instanceof Response)) return null;
  const payload = await readJsonSafely(context.clone());
  return hasErrorPayload(payload) ? String(payload.error) : null;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function hasErrorPayload(value: unknown): value is { error: unknown } {
  return Boolean(value && typeof value === "object" && "error" in value);
}
