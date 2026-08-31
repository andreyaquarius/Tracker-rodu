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
  | "list-requests"
  | "sync-notifications";

type GeneHelpAccountRow = {
  genehelp_user_id: string | null;
  genehelp_email: string;
  genehelp_name: string;
  encrypted_integration_token: string;
  token_last4: string;
  created_in_genehelp: boolean;
  notifications_last_synced_at?: string | null;
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

type GeneHelpLocalRequestRow = {
  id: string;
  genehelp_request_id: string;
  status: unknown;
  response: unknown;
  provider_updated_at: string | null;
};

type GeneHelpNotificationSummary = {
  id: number;
  type: "ai_content" | "interaction_unread_message";
  description: string;
  target: GeneHelpTarget | null;
};

type GeneHelpMinimalRequest = {
  id: string;
  status: string;
  visibility: string;
  publicStatus: string;
  createdAt: string;
  updatedAt: string;
};

type GeneHelpTarget = {
  kind: "request" | "interaction";
  id: string;
  requestId?: string;
};

type GeneHelpPage<T> = {
  items: T[];
  page: number;
  hasMore: boolean;
};

type GeneHelpLocalStatus = {
  code: string | null;
  publicStatus: string | null;
};

type GeneHelpRpcResult = {
  outcome?: string;
};

type GeneHelpSyncSummary = {
  connected: boolean;
  skipped: boolean;
  throttled: boolean;
  notificationPages: number;
  notificationsScanned: number;
  messageEvents: number;
  statusPages: number;
  statusesScanned: number;
  statusEvents: number;
};

const geneHelpBaseUrl = "https://genehelp.online";
const geneHelpRequestTestMode = false;
const geneHelpNotificationPageSize = 100;
const geneHelpNotificationMaximumPages = 20;
const geneHelpNotificationSyncIntervalMs = 45_000;
const geneHelpMaximumProviderBodyCharacters = 2_000_000;
const geneHelpMaximumTrackedRequests = 1_000;
const geneHelpProviderTimeoutMs = 12_000;

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
      case "sync-notifications":
        return await syncNotifications(context);
      default:
        return json({ error: "Невідома дія GeneHelp." }, 400);
    }
  } catch (error) {
    const status = error instanceof GeneHelpProviderError
      ? ([429, 504].includes(error.status) ? error.status : error.status >= 500 ? 502 : error.status)
      : 400;
    return json({ error: errorMessage(error, "Не вдалося виконати запит GeneHelp.") }, status);
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

async function syncNotifications(context: GeneHelpContext): Promise<Response> {
  const summary = emptyGeneHelpSyncSummary();
  const { data: accountData, error: accountError } = await context.admin
    .from("user_genehelp_accounts")
    .select("genehelp_user_id, genehelp_email, genehelp_name, encrypted_integration_token, token_last4, created_in_genehelp, notifications_last_synced_at")
    .eq("user_id", context.user.id)
    .maybeSingle();
  if (accountError) throw decorateSupabaseError(accountError);
  if (!accountData) {
    return json({ ...summary, connected: false, skipped: true });
  }

  summary.connected = true;
  const { data: requestData, error: requestError } = await context.admin
    .from("user_genehelp_requests")
    .select("id, genehelp_request_id, status, response, provider_updated_at")
    .eq("user_id", context.user.id)
    .limit(geneHelpMaximumTrackedRequests);
  if (requestError) throw decorateGeneHelpRequestStorageError(requestError);

  const localRequests = (requestData ?? []) as GeneHelpLocalRequestRow[];
  if (localRequests.length === 0) {
    summary.skipped = true;
    return json(summary);
  }

  const account = accountData as GeneHelpAccountRow;
  const previousClaim = normalizeOptionalTimestamp(account.notifications_last_synced_at);
  const syncStartedAt = new Date();
  if (
    previousClaim &&
    syncStartedAt.getTime() - Date.parse(previousClaim) < geneHelpNotificationSyncIntervalMs
  ) {
    summary.skipped = true;
    summary.throttled = true;
    return json(summary);
  }

  const syncStartedAtIso = syncStartedAt.toISOString();
  const claimBase = context.admin
    .from("user_genehelp_accounts")
    .update({ notifications_last_synced_at: syncStartedAtIso })
    .eq("user_id", context.user.id);
  const claimQuery = previousClaim
    ? claimBase.eq("notifications_last_synced_at", previousClaim)
    : claimBase.is("notifications_last_synced_at", null);
  const { data: claimedAccount, error: claimError } = await claimQuery
    .select("user_id")
    .maybeSingle();
  if (claimError) throw decorateSupabaseError(claimError);
  if (!claimedAccount) {
    summary.skipped = true;
    summary.throttled = true;
    return json(summary);
  }

  const integrationToken = await decryptApiKey(
    account.encrypted_integration_token,
    context.encryptionKey,
  );
  const [notificationBatch, minimalBatch] = await Promise.all([
    fetchGeneHelpNotifications(integrationToken),
    fetchGeneHelpMinimalRequests(integrationToken),
  ]);

  summary.notificationPages = notificationBatch.pages;
  summary.notificationsScanned = notificationBatch.items.length;
  summary.statusPages = minimalBatch.pages;
  summary.statusesScanned = minimalBatch.items.length;

  const localByRequestId = new Map(
    localRequests.map((row) => [row.genehelp_request_id, row] as const),
  );
  const unreadNotifications = notificationBatch.items.filter((item) =>
    item.type === "interaction_unread_message"
  );
  const unresolvedInteractionIds = new Set<string>();
  for (const item of unreadNotifications) {
    if (item.target?.kind === "interaction" && !item.target.requestId) {
      unresolvedInteractionIds.add(item.target.id);
    }
  }
  const interactionRequestIds = unresolvedInteractionIds.size > 0
    ? await fetchGeneHelpInteractionRequestMap(integrationToken, unresolvedInteractionIds)
    : new Map<string, string>();

  for (const notification of unreadNotifications) {
    const requestId = notification.target?.kind === "request"
      ? notification.target.id
      : notification.target?.requestId ||
        (notification.target ? interactionRequestIds.get(notification.target.id) : undefined);
    if (!requestId || !localByRequestId.has(requestId)) continue;

    const stableIdentity = {
      notification_id: notification.id,
      type: notification.type,
      request_id: requestId,
      target_kind: notification.target?.kind ?? "",
      target_id: notification.target?.id ?? "",
    };
    const payloadHash = await sha256Hex(stableIdentity);
    const outcome = await receiveGeneHelpNotification(context, {
      p_provider_event_id: `notification:${notification.id}`,
      p_event_type: "interaction_unread_message",
      p_occurred_at: syncStartedAtIso,
      p_genehelp_request_id: requestId,
      p_genehelp_user_id: normalizeOptionalBoundedText(account.genehelp_user_id, 128),
      p_status: null,
      p_reply: {
        id: `notification:${notification.id}`,
        preview: notification.description,
      },
      p_payload_sha256: payloadHash,
    });
    if (outcome === "applied") summary.messageEvents += 1;
  }

  for (const remote of minimalBatch.items) {
    const local = localByRequestId.get(remote.id);
    if (!local) continue;

    const current = readLocalGeneHelpStatus(local);
    const sameStatus = equalStatusCode(current.code, remote.status);
    const samePublicStatus = current.publicStatus === null ||
      equalStatusCode(current.publicStatus, remote.publicStatus);
    const providerUpdatedAt = normalizeOptionalTimestamp(local.provider_updated_at);
    const needsSilentBaseline = current.code === null ||
      (sameStatus && samePublicStatus && providerUpdatedAt === null);

    if (needsSilentBaseline) {
      await silentlyBaselineGeneHelpStatus(context, local, remote, syncStartedAtIso);
      continue;
    }
    if (sameStatus && samePublicStatus) {
      if (Date.parse(providerUpdatedAt!) < Date.parse(remote.updatedAt)) {
        await silentlyBaselineGeneHelpStatus(context, local, remote, syncStartedAtIso);
      }
      continue;
    }

    const stableStatusFields = {
      request_id: remote.id,
      status: remote.status,
      public_status: remote.publicStatus,
      visibility: remote.visibility,
      updated_at: remote.updatedAt,
    };
    const payloadHash = await sha256Hex(stableStatusFields);
    const outcome = await receiveGeneHelpNotification(context, {
      p_provider_event_id: `status:${remote.id}:${payloadHash.slice(0, 40)}`,
      p_event_type: "genealogy_request.status_changed",
      p_occurred_at: remote.updatedAt,
      p_genehelp_request_id: remote.id,
      p_genehelp_user_id: normalizeOptionalBoundedText(account.genehelp_user_id, 128),
      p_status: {
        code: remote.status,
        request_status: remote.status,
        public_status: remote.publicStatus,
        visibility: remote.visibility,
        updated_at: remote.updatedAt,
        message: geneHelpStatusChangeMessage(remote),
      },
      p_reply: null,
      p_payload_sha256: payloadHash,
    });
    if (outcome === "applied") summary.statusEvents += 1;
  }

  return json(summary);
}

function emptyGeneHelpSyncSummary(): GeneHelpSyncSummary {
  return {
    connected: false,
    skipped: false,
    throttled: false,
    notificationPages: 0,
    notificationsScanned: 0,
    messageEvents: 0,
    statusPages: 0,
    statusesScanned: 0,
    statusEvents: 0,
  };
}

async function fetchGeneHelpNotifications(
  token: string,
): Promise<{ items: GeneHelpNotificationSummary[]; pages: number }> {
  const items: GeneHelpNotificationSummary[] = [];
  let pages = 0;
  for (let page = 1; page <= geneHelpNotificationMaximumPages; page += 1) {
    const response = await callGeneHelp(
      `/api/partners/notifications?locale=uk&limit=${geneHelpNotificationPageSize}&page=${page}`,
      token,
    );
    const parsed = parseGeneHelpPage(
      response,
      page,
      (value) => parseGeneHelpNotification(value),
    );
    items.push(...parsed.items);
    pages = parsed.page;
    if (!parsed.hasMore) return { items, pages };
  }
  throw invalidGeneHelpProviderResponse("GeneHelp повернув забагато сторінок сповіщень.");
}

async function fetchGeneHelpMinimalRequests(
  token: string,
): Promise<{ items: GeneHelpMinimalRequest[]; pages: number }> {
  const items: GeneHelpMinimalRequest[] = [];
  let pages = 0;
  for (let page = 1; page <= geneHelpNotificationMaximumPages; page += 1) {
    const response = await callGeneHelp(
      `/api/partners/genealogy-requests/minimal?page=${page}`,
      token,
    );
    const parsed = parseGeneHelpPage(
      response,
      page,
      (value) => parseGeneHelpMinimalRequest(value),
    );
    items.push(...parsed.items);
    pages = parsed.page;
    if (!parsed.hasMore) return { items, pages };
  }
  throw invalidGeneHelpProviderResponse("GeneHelp повернув забагато сторінок статусів.");
}

function parseGeneHelpPage<T>(
  value: unknown,
  requestedPage: number,
  parseItem: (value: unknown) => T,
): GeneHelpPage<T> {
  const record = requireRecord(value, "Некоректна відповідь GeneHelp.");
  const rawItems = record.data;
  if (!Array.isArray(rawItems) || rawItems.length > geneHelpNotificationPageSize) {
    throw invalidGeneHelpProviderResponse("GeneHelp повернув некоректну сторінку даних.");
  }
  const meta = requireRecord(record.meta, "GeneHelp не повернув метадані сторінки.");
  const total = requireBoundedInteger(meta.total, 0, 2_000_000, "meta.total");
  const page = requireBoundedInteger(meta.page, 1, geneHelpNotificationMaximumPages, "meta.page");
  const limit = requireBoundedInteger(meta.limit, 1, geneHelpNotificationPageSize, "meta.limit");
  if (page !== requestedPage || total < rawItems.length || typeof meta.has_more !== "boolean") {
    throw invalidGeneHelpProviderResponse("GeneHelp повернув неузгоджені метадані сторінки.");
  }
  if (limit !== geneHelpNotificationPageSize) {
    throw invalidGeneHelpProviderResponse("GeneHelp повернув неочікуваний розмір сторінки.");
  }
  return {
    items: rawItems.map(parseItem),
    page,
    hasMore: meta.has_more,
  };
}

function parseGeneHelpNotification(value: unknown): GeneHelpNotificationSummary {
  const record = requireRecord(value, "Некоректне сповіщення GeneHelp.");
  const id = requireBoundedInteger(record.id, 1, Number.MAX_SAFE_INTEGER, "notification.id");
  const type = requireEnum(
    record.type,
    ["ai_content", "interaction_unread_message"] as const,
    "notification.type",
  );
  requireBoundedText(record.title, 0, 200, "notification.title");
  const description = requireBoundedText(record.description, 0, 1_000, "notification.description");
  if (
    !(typeof record.age === "string" && record.age.length <= 128) &&
    !(typeof record.age === "number" && Number.isFinite(record.age))
  ) {
    throw invalidGeneHelpProviderResponse("GeneHelp повернув некоректний notification.age.");
  }
  const targetUrl = record.target_url === null
    ? ""
    : requireBoundedUriReference(record.target_url, "notification.target_url");
  if (typeof record.is_clickable !== "boolean") {
    throw invalidGeneHelpProviderResponse("GeneHelp повернув некоректний notification.is_clickable.");
  }
  return {
    id,
    type,
    description,
    target: parseCanonicalGeneHelpTarget(targetUrl),
  };
}

function parseGeneHelpMinimalRequest(value: unknown): GeneHelpMinimalRequest {
  const record = requireRecord(value, "Некоректний мінімальний запит GeneHelp.");
  const id = requireGeneHelpProviderId(record.id, "request.id");
  requireBoundedUriReference(record.url, "request.url");
  requireBoundedUriReference(record.view_url, "request.view_url");
  requireBoundedUriReference(record.edit_url, "request.edit_url");
  const status = requireBoundedText(record.status, 1, 128, "request.status");
  const visibility = requireBoundedText(record.visibility, 0, 128, "request.visibility");
  const publicStatus = requireBoundedText(
    record.public_status,
    0,
    128,
    "request.public_status",
  );
  const createdAt = requireProviderTimestamp(record.created_at, "request.created_at");
  const updatedAt = requireProviderTimestamp(record.updated_at, "request.updated_at");
  return { id, status, visibility, publicStatus, createdAt, updatedAt };
}

async function fetchGeneHelpInteractionRequestMap(
  token: string,
  wantedInteractionIds: Set<string>,
): Promise<Map<string, string>> {
  const response = await callGeneHelp(
    "/api/partners/v2/genealogy-requests?limit=100",
    token,
  );
  const record = requireRecord(response, "Некоректна відповідь GeneHelp зі списком запитів.");
  if (!Array.isArray(record.data) || record.data.length > geneHelpNotificationPageSize) {
    throw invalidGeneHelpProviderResponse("GeneHelp повернув некоректні групи запитів.");
  }

  const result = new Map<string, string>();
  let itemCount = 0;
  let interactionCount = 0;
  for (const rawGroup of record.data) {
    const group = requireRecord(rawGroup, "Некоректна група запитів GeneHelp.");
    requireBoundedText(group.helper_country_code, 0, 16, "group.helper_country_code");
    requireBoundedInteger(group.count, 0, 100_000, "group.count");
    if (!Array.isArray(group.items)) {
      throw invalidGeneHelpProviderResponse("GeneHelp повернув некоректний group.items.");
    }
    itemCount += group.items.length;
    if (itemCount > geneHelpNotificationPageSize) {
      throw invalidGeneHelpProviderResponse("GeneHelp повернув забагато запитів для limit=100.");
    }
    for (const rawItem of group.items) {
      const item = requireRecord(rawItem, "Некоректний запит GeneHelp.");
      const requestId = requireGeneHelpProviderId(item.id, "request.id");
      requireBoundedText(item.title, 0, 300, "request.title");
      requireBoundedUriReference(item.url, "request.url");
      requireBoundedUriReference(item.edit_url, "request.edit_url");
      requireBoundedText(item.status, 1, 128, "request.status");
      if (typeof item.is_test !== "boolean") {
        throw invalidGeneHelpProviderResponse("GeneHelp повернув некоректний request.is_test.");
      }
      requireProviderTimestamp(item.created_at, "request.created_at");
      requireBoundedUriReference(item.interaction_url, "request.interaction_url");
      if (!Array.isArray(item.interactions) || item.interactions.length > 100) {
        throw invalidGeneHelpProviderResponse("GeneHelp повернув некоректні interactions.");
      }
      interactionCount += item.interactions.length;
      if (interactionCount > 2_000) {
        throw invalidGeneHelpProviderResponse("GeneHelp повернув забагато interactions.");
      }
      for (const rawInteraction of item.interactions) {
        const interaction = requireRecord(rawInteraction, "Некоректна відповідь GeneHelp interaction.");
        const interactionId = requireGeneHelpProviderId(interaction.id, "interaction.id", 1);
        requireBoundedUriReference(interaction.url, "interaction.url");
        requireBoundedText(interaction.status, 0, 128, "interaction.status");
        requireProviderTimestamp(interaction.created_at, "interaction.created_at");
        if (wantedInteractionIds.has(interactionId)) result.set(interactionId, requestId);
      }
    }
  }
  return result;
}

function parseCanonicalGeneHelpTarget(value: string): GeneHelpTarget | null {
  if (!value.startsWith("/") && !value.startsWith(`${geneHelpBaseUrl}/`)) return null;
  if (value.startsWith("//") || /[%\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, geneHelpBaseUrl);
  } catch {
    return null;
  }
  if (url.origin !== geneHelpBaseUrl || url.search || url.hash || !url.pathname.startsWith("/")) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length > 0 && /^(?:uk|en|pl)$/i.test(segments[0])) segments.shift();
  if (segments[0] === "my") segments.shift();

  if (
    (segments[0] === "requests" || segments[0] === "genealogy-requests") &&
    segments.length === 2 &&
    isGeneHelpProviderId(segments[1], 4)
  ) {
    return { kind: "request", id: segments[1] };
  }
  if (
    (segments[0] === "requests" || segments[0] === "genealogy-requests") &&
    segments[2] === "interactions" &&
    segments.length === 4 &&
    isGeneHelpProviderId(segments[1], 4) &&
    isGeneHelpProviderId(segments[3], 1)
  ) {
    return { kind: "interaction", id: segments[3], requestId: segments[1] };
  }
  if (
    segments[0] === "interactions" &&
    segments.length === 2 &&
    isGeneHelpProviderId(segments[1], 1)
  ) {
    return { kind: "interaction", id: segments[1] };
  }
  return null;
}

async function receiveGeneHelpNotification(
  context: GeneHelpContext,
  args: {
    p_provider_event_id: string;
    p_event_type: string;
    p_occurred_at: string;
    p_genehelp_request_id: string;
    p_genehelp_user_id: string | null;
    p_status: Record<string, unknown> | null;
    p_reply: Record<string, unknown> | null;
    p_payload_sha256: string;
  },
): Promise<string> {
  const { data, error } = await context.admin.rpc(
    "service_receive_genehelp_notification_v1",
    args,
  );
  if (error) throw decorateGeneHelpNotificationStorageError(error);
  const result = asRecord(data) as GeneHelpRpcResult;
  return typeof result.outcome === "string" ? result.outcome : "";
}

async function silentlyBaselineGeneHelpStatus(
  context: GeneHelpContext,
  local: GeneHelpLocalRequestRow,
  remote: GeneHelpMinimalRequest,
  checkedAt: string,
): Promise<void> {
  const status = {
    ...asRecord(local.status),
    code: remote.status,
    request_status: remote.status,
    public_status: remote.publicStatus,
    visibility: remote.visibility,
    updated_at: remote.updatedAt,
  };
  const response = {
    ...asRecord(local.response),
    status: {
      ...asRecord(asRecord(local.response).status),
      ...status,
    },
    visibility: remote.visibility,
    public_status: remote.publicStatus,
    updated_at: remote.updatedAt,
  };
  const { error } = await context.admin
    .from("user_genehelp_requests")
    .update({
      status,
      response,
      provider_updated_at: remote.updatedAt,
      last_checked_at: checkedAt,
      updated_at: checkedAt,
    })
    .eq("id", local.id)
    .eq("user_id", context.user.id)
    .eq("genehelp_request_id", local.genehelp_request_id);
  if (error) throw decorateGeneHelpRequestStorageError(error);
}

function readLocalGeneHelpStatus(local: GeneHelpLocalRequestRow): GeneHelpLocalStatus {
  const status = asRecord(local.status);
  const response = asRecord(local.response);
  const responseStatus = asRecord(response.status);
  const code = firstKnownStatusCode([
    status.code,
    status.request_status,
    status.status,
    typeof response.status === "string" ? response.status : null,
    responseStatus.code,
    responseStatus.request_status,
    responseStatus.status,
  ]);
  const publicStatus = firstKnownPublicStatus([
    status.public_status,
    response.public_status,
    responseStatus.public_status,
  ]);
  return { code, publicStatus };
}

function firstKnownStatusCode(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || /^(?:unknown|undefined|null|n\/a|невідомо)$/i.test(text)) continue;
    return text.slice(0, 128);
  }
  return null;
}

function firstKnownPublicStatus(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (/^(?:unknown|undefined|null|n\/a|невідомо)$/i.test(text)) continue;
    return text.slice(0, 128);
  }
  return null;
}

function equalStatusCode(left: string | null, right: string): boolean {
  return (left ?? "").trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function geneHelpStatusChangeMessage(remote: GeneHelpMinimalRequest): string {
  const publicStatus = remote.publicStatus
    ? ` Публічний статус: ${remote.publicStatus}.`
    : "";
  return `Новий статус GeneHelp: ${remote.status}.${publicStatus}`;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidGeneHelpProviderResponse(message);
  }
  return value as Record<string, unknown>;
}

function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw invalidGeneHelpProviderResponse(`GeneHelp повернув некоректний ${field}.`);
  }
  return Number(value);
}

function requireBoundedText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  field: string,
): string {
  if (typeof value !== "string") {
    throw invalidGeneHelpProviderResponse(`GeneHelp повернув некоректний ${field}.`);
  }
  const text = value.trim();
  if (text.length < minimumLength || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw invalidGeneHelpProviderResponse(`GeneHelp повернув некоректний ${field}.`);
  }
  return text;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw invalidGeneHelpProviderResponse(`GeneHelp повернув некоректний ${field}.`);
  }
  return value as T[number];
}

function requireGeneHelpProviderId(value: unknown, field: string, minimumLength = 4): string {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : value;
  const id = requireBoundedText(normalized, minimumLength, 64, field);
  if (!isGeneHelpProviderId(id, minimumLength)) {
    throw invalidGeneHelpProviderResponse(`GeneHelp повернув некоректний ${field}.`);
  }
  return id;
}

function isGeneHelpProviderId(value: string, minimumLength: number): boolean {
  return value.length >= minimumLength && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}

function requireBoundedUriReference(value: unknown, field: string): string {
  const text = requireBoundedText(value, 0, 2_048, field);
  if (/^(?:javascript|data|file):/i.test(text)) {
    throw invalidGeneHelpProviderResponse(`GeneHelp повернув некоректний ${field}.`);
  }
  return text;
}

function requireProviderTimestamp(value: unknown, field: string): string {
  const text = requireBoundedText(value, 10, 64, field);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now() + 10 * 60 * 1_000) {
    throw invalidGeneHelpProviderResponse(`GeneHelp повернув некоректний ${field}.`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizeOptionalBoundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

async function sha256Hex(value: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function invalidGeneHelpProviderResponse(message: string): GeneHelpProviderError {
  return new GeneHelpProviderError(502, message);
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
          is_test: geneHelpRequestTestMode,
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), geneHelpProviderTimeoutMs);
  let response: Response;
  let rawBody: string;
  try {
    response = await fetch(new URL(path, geneHelpBaseUrl), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get("Content-Length") ?? "0");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > geneHelpMaximumProviderBodyCharacters
    ) {
      throw invalidGeneHelpProviderResponse("GeneHelp повернув завелику відповідь.");
    }
    rawBody = await response.text();
  } catch (error) {
    if (error instanceof GeneHelpProviderError) throw error;
    if (controller.signal.aborted) {
      throw new GeneHelpProviderError(
        504,
        "GeneHelp не відповів вчасно. Спробуйте оновити сповіщення трохи пізніше.",
      );
    }
    throw new GeneHelpProviderError(
      502,
      "Не вдалося підключитися до GeneHelp. Спробуйте трохи пізніше.",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (rawBody.length > geneHelpMaximumProviderBodyCharacters) {
    throw invalidGeneHelpProviderResponse("GeneHelp повернув завелику відповідь.");
  }
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

function decorateGeneHelpNotificationStorageError(error: unknown): Error {
  const message = errorMessage(error, "Не вдалося зберегти сповіщення GeneHelp.");
  if (
    message.includes("service_receive_genehelp_notification_v1") ||
    message.includes("user_genehelp_notifications") ||
    message.includes("schema cache") ||
    message.includes("Could not find the function")
  ) {
    return new Error(
      "Схема сповіщень GeneHelp ще не готова. Застосуйте SQL-міграцію вхідних сповіщень.",
    );
  }
  return new Error(message);
}
