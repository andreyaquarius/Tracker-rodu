import {
  authenticatedContext,
  corsHeaders,
  decryptApiKey,
  encryptApiKey,
  errorMessage,
  json,
} from "../_shared/ai.ts";

type GeneHelpAction =
  | "account-status"
  | "create-simple-request"
  | "get-status"
  | "list-requests";

type GeneHelpAccountRow = {
  genehelp_user_id: string | null;
  genehelp_email: string;
  genehelp_name: string;
  encrypted_integration_token: string;
  token_last4: string;
  created_in_genehelp: boolean;
};

type GeneHelpOnboardingResponse = {
  user?: {
    id?: string;
    email?: string;
    name?: string;
    created?: boolean;
  };
  integration_token?: string;
  token_type?: string;
};

type GeneHelpContext = Awaited<ReturnType<typeof authenticatedContext>>;

const geneHelpBaseUrl = "https://genehelp.online";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const context = await authenticatedContext(request);
    const input = await request.json() as Record<string, unknown>;
    const action = String(input.action ?? "") as GeneHelpAction;

    switch (action) {
      case "account-status":
        return await getAccountStatus(context);
      case "create-simple-request":
        return await createSimpleRequest(context, input);
      case "get-status":
        return await getStatus(context, input);
      case "list-requests":
        return await listRequests(context);
      default:
        return json({ error: "Невідома дія GeneHelp." }, 400);
    }
  } catch (error) {
    return json({ error: errorMessage(error, "Не вдалося виконати запит GeneHelp.") }, 400);
  }
});

async function getAccountStatus(context: GeneHelpContext): Promise<Response> {
  const { data, error } = await context.admin
    .from("user_genehelp_accounts")
    .select("user_id")
    .eq("user_id", context.user.id)
    .maybeSingle();
  if (error) throw decorateSupabaseError(error);

  return json({
    connected: Boolean(data),
    email: context.user.email?.trim().toLocaleLowerCase() ?? "",
    name: userDisplayName(context),
  });
}

async function createSimpleRequest(
  context: GeneHelpContext,
  input: Record<string, unknown>,
): Promise<Response> {
  const description = String(input.description ?? "").trim();
  if (description.length < 12) {
    return json({ error: "Опишіть запит GeneHelp трохи детальніше." }, 400);
  }

  const title = normalizeOptionalText(input.title);
  const registrationConsent = input.registrationConsent === true;
  await assertRequestHistoryReady(context);
  let integrationToken = await ensureIntegrationToken(context, registrationConsent);
  try {
    const response = await createRequestWithToken(integrationToken, title, description);
    await saveGeneHelpRequest(context, response, title, description);
    return json(response);
  } catch (error) {
    if (!(error instanceof GeneHelpProviderError) || ![401, 403].includes(error.status)) {
      throw error;
    }
    integrationToken = await onboardGeneHelpUser(context);
    const response = await createRequestWithToken(integrationToken, title, description);
    await saveGeneHelpRequest(context, response, title, description);
    return json(response);
  }
}

async function getStatus(
  context: GeneHelpContext,
  input: Record<string, unknown>,
): Promise<Response> {
  const id = normalizeGeneHelpId(input.id);
  const integrationToken = await ensureIntegrationToken(context, false);
  const response = await callGeneHelp(
    `/api/partners/genealogy-requests/${encodeURIComponent(id)}`,
    integrationToken,
  );
  await updateGeneHelpRequestStatus(context, id, response);
  return json(response);
}

async function listRequests(context: GeneHelpContext): Promise<Response> {
  const { data, error } = await context.admin
    .from("user_genehelp_requests")
    .select("genehelp_request_id, title, description, status, links, meta, response, created_at, updated_at, last_checked_at")
    .eq("user_id", context.user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw decorateGeneHelpRequestStorageError(error);

  return json({
    requests: (data ?? []).map((row) => ({
      id: row.genehelp_request_id,
      title: row.title,
      description: row.description,
      status: row.status,
      links: row.links,
      meta: row.meta,
      data: row.response,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastCheckedAt: row.last_checked_at,
    })),
  });
}

async function createRequestWithToken(
  integrationToken: string,
  title: string | null,
  description: string,
): Promise<unknown> {
  return callGeneHelp(
    "/api/partners/v2/genealogy-requests/simple",
    integrationToken,
    {
      method: "POST",
      body: {
        meta: {
          locale: "uk",
          is_test: false,
        },
        content: {
          title,
          description,
        },
      },
    },
  );
}

async function assertRequestHistoryReady(context: GeneHelpContext): Promise<void> {
  const { error } = await context.admin
    .from("user_genehelp_requests")
    .select("genehelp_request_id")
    .eq("user_id", context.user.id)
    .limit(1);
  if (error) throw decorateGeneHelpRequestStorageError(error);
}

async function saveGeneHelpRequest(
  context: GeneHelpContext,
  response: unknown,
  title: string | null,
  description: string,
): Promise<void> {
  const id = extractRequestId(response);
  if (!id) return;
  const now = new Date().toISOString();
  const { error } = await context.admin
    .from("user_genehelp_requests")
    .upsert({
      user_id: context.user.id,
      genehelp_request_id: id,
      title,
      description,
      status: extractObject(response, "status"),
      links: extractObject(response, "links"),
      meta: extractObject(response, "meta"),
      response: toJsonValue(response),
      last_checked_at: now,
      updated_at: now,
    }, { onConflict: "user_id,genehelp_request_id" });
  if (error) throw decorateGeneHelpRequestStorageError(error);
}

async function updateGeneHelpRequestStatus(
  context: GeneHelpContext,
  id: string,
  response: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await context.admin
    .from("user_genehelp_requests")
    .upsert({
      user_id: context.user.id,
      genehelp_request_id: id,
      status: extractObject(response, "status"),
      links: extractObject(response, "links"),
      meta: extractObject(response, "meta"),
      response: toJsonValue(response),
      last_checked_at: now,
      updated_at: now,
    }, { onConflict: "user_id,genehelp_request_id" });
  if (error) throw decorateGeneHelpRequestStorageError(error);
}

async function ensureIntegrationToken(
  context: GeneHelpContext,
  allowOnboarding: boolean,
): Promise<string> {
  const { data, error } = await context.admin
    .from("user_genehelp_accounts")
    .select("genehelp_user_id, genehelp_email, genehelp_name, encrypted_integration_token, token_last4, created_in_genehelp")
    .eq("user_id", context.user.id)
    .maybeSingle();
  if (error) throw decorateSupabaseError(error);
  if (!data) {
    if (!allowOnboarding) {
      throw new Error("Потрібна згода на передачу email та імені для реєстрації в GeneHelp.");
    }
    return onboardGeneHelpUser(context);
  }
  const row = data as GeneHelpAccountRow;
  return decryptApiKey(row.encrypted_integration_token, context.encryptionKey);
}

async function onboardGeneHelpUser(context: GeneHelpContext): Promise<string> {
  const partnerToken = requirePartnerToken();
  const email = context.user.email?.trim().toLocaleLowerCase() ?? "";
  if (!email) {
    throw new Error("Для реєстрації в GeneHelp потрібна email-адреса акаунта.");
  }
  const name = userDisplayName(context);

  const response = await callGeneHelp(
    "/api/partners/onboarding/users",
    partnerToken,
    {
      method: "POST",
      body: { email, name },
    },
  ) as GeneHelpOnboardingResponse;

  const integrationToken = response.integration_token?.trim();
  if (!integrationToken) {
    throw new Error("GeneHelp не повернув інтеграційний токен користувача.");
  }

  const encryptedToken = await encryptApiKey(integrationToken, context.encryptionKey);
  const { error } = await context.admin
    .from("user_genehelp_accounts")
    .upsert({
      user_id: context.user.id,
      genehelp_user_id: response.user?.id ?? null,
      genehelp_email: response.user?.email || email,
      genehelp_name: response.user?.name || name,
      encrypted_integration_token: encryptedToken,
      token_last4: integrationToken.slice(-4),
      created_in_genehelp: response.user?.created === true,
      consented_at: new Date().toISOString(),
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  if (error) throw decorateSupabaseError(error);

  return integrationToken;
}

async function callGeneHelp(
  path: string,
  token: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
  } = {},
): Promise<unknown> {
  const response = await fetch(new URL(path, geneHelpBaseUrl), {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const rawBody = await response.text();
  let parsed: unknown = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = rawBody;
  }

  if (!response.ok) {
    const providerMessage = readableProviderError(parsed) || rawBody;
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 401 || response.status === 403) {
      throw new GeneHelpProviderError(
        response.status,
        path.includes("/onboarding/")
          ? "GeneHelp відхилив партнерський токен. Перевірте Supabase secret PLAIN PARTNER TOKEN."
          : "GeneHelp відхилив інтеграційний токен користувача.",
      );
    }
    if (response.status === 429) {
      throw new GeneHelpProviderError(
        response.status,
        retryAfter
          ? `GeneHelp тимчасово обмежив частоту запитів. Повторіть через ${retryAfter} с.`
          : "GeneHelp тимчасово обмежив частоту запитів. Спробуйте трохи пізніше.",
      );
    }
    throw new GeneHelpProviderError(
      response.status,
      providerMessage || "GeneHelp не зміг виконати запит.",
    );
  }

  return parsed;
}

class GeneHelpProviderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GeneHelpProviderError";
  }
}

function requirePartnerToken(): string {
  const token =
    Deno.env.get("PLAIN PARTNER TOKEN")?.trim() ||
    Deno.env.get("PLAIN_PARTNER_TOKEN")?.trim() ||
    Deno.env.get("GENEHELP_PARTNER_TOKEN")?.trim();
  if (!token) {
    throw new Error("У Supabase secrets не налаштовано партнерський токен GeneHelp.");
  }
  return token;
}

function userDisplayName(context: GeneHelpContext): string {
  const metadata = context.user.user_metadata as Record<string, unknown>;
  const name = [
    metadata.full_name,
    metadata.name,
    metadata.display_name,
  ].find((value) => typeof value === "string" && value.trim());
  if (typeof name === "string" && name.trim()) return name.trim();
  const email = context.user.email?.trim() ?? "";
  return email.split("@")[0]?.trim() || "Користувач Трекера Роду";
}

function normalizeOptionalText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function extractRequestId(value: unknown): string | null {
  const record = asRecord(value);
  const nestedRequest = asRecord(record.request);
  const nestedData = asRecord(record.data);
  const candidates = [
    record.id,
    record.request_id,
    record.genealogy_request_id,
    nestedRequest.id,
    nestedData.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function extractObject(value: unknown, key: string): Record<string, unknown> {
  const nested = asRecord(asRecord(value)[key]);
  return toPlainObject(nested);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    : {};
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

function normalizeGeneHelpId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9_-]{4,64}$/i.test(id)) {
    throw new Error("Некоректний ідентифікатор запиту GeneHelp.");
  }
  return id;
}

function readableProviderError(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    const nested = readableProviderError(record.error);
    if (nested) return nested;
  }
  for (const key of ["message", "error", "detail"]) {
    if (typeof record[key] === "string" && String(record[key]).trim()) {
      return String(record[key]);
    }
  }
  return "";
}

function decorateSupabaseError(error: unknown): Error {
  const message = errorMessage(error, "Не вдалося прочитати налаштування GeneHelp.");
  if (
    message.includes("user_genehelp_accounts") ||
    message.includes("schema cache") ||
    message.includes("Could not find the table")
  ) {
    return new Error("Таблиця GeneHelp ще не створена. Застосуйте SQL-міграцію GeneHelp у Supabase.");
  }
  return new Error(message);
}

function decorateGeneHelpRequestStorageError(error: unknown): Error {
  const message = errorMessage(error, "Не вдалося прочитати історію запитів GeneHelp.");
  if (
    message.includes("user_genehelp_requests") ||
    message.includes("schema cache") ||
    message.includes("Could not find the table")
  ) {
    return new Error("Таблиця історії GeneHelp ще не створена. Застосуйте SQL-міграцію GeneHelp для надісланих запитів у Supabase.");
  }
  return new Error(message);
}
