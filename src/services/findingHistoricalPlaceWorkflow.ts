import type { PlaceSummary } from "../types/historicalPlaces.ts";

export interface FindingHistoricalPlaceContext {
  projectId: string;
  documentId: string;
  originalText: string;
  eventDate: string;
}

export interface FindingHistoricalPlaceDecision {
  contextKey: string;
  place: PlaceSummary;
  confirmed: boolean;
}

export interface ConfirmFindingDocumentPlaceInput extends FindingHistoricalPlaceContext {
  findingId: string;
  placeId: string;
  expectedFindingUpdatedAt?: string | null;
}

export interface FindingDocumentPlaceLink {
  id: string;
  findingId: string;
  documentId: string;
  placeId: string;
  relationType: string;
  originalText: string;
  resolutionStatus: string;
  sourceReference: string | null;
  confidence: number;
  note: string;
  metadata: Record<string, unknown>;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface FindingDocumentPlaceState {
  findingId: string;
  currentDocumentId: string | null;
  documentMatchesFinding: boolean;
  link: FindingDocumentPlaceLink;
  place: PlaceSummary;
}

export interface ClearFindingDocumentPlaceInput {
  findingId: string;
  expectedFindingUpdatedAt?: string | null;
}

interface FindingHistoricalPlaceRpcError {
  code?: string;
  message?: string;
  details?: string;
}

export interface FindingHistoricalPlaceWorkflowDependencies {
  rpc?: (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: FindingHistoricalPlaceRpcError | null }>;
}

export class FindingHistoricalPlaceWorkflowError extends Error {
  readonly code: "invalid_input" | "migration_pending" | "request_failed";

  constructor(
    code: FindingHistoricalPlaceWorkflowError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FindingHistoricalPlaceWorkflowError";
    this.code = code;
  }
}

export function exactFindingEventDate(value: string): string | null {
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? normalized
    : null;
}

export function findingHistoricalPlaceContextKey(
  context: FindingHistoricalPlaceContext,
): string {
  return JSON.stringify([
    context.projectId.trim(),
    context.documentId.trim(),
    context.originalText,
    context.eventDate.trim(),
    exactFindingEventDate(context.eventDate),
  ]);
}

export function selectFindingHistoricalPlace(
  context: FindingHistoricalPlaceContext,
  place: PlaceSummary,
): FindingHistoricalPlaceDecision {
  return {
    contextKey: findingHistoricalPlaceContextKey(context),
    place,
    confirmed: false,
  };
}

export function confirmFindingHistoricalPlaceDecision(
  context: FindingHistoricalPlaceContext,
  decision: FindingHistoricalPlaceDecision,
): FindingHistoricalPlaceDecision {
  if (decision.contextKey !== findingHistoricalPlaceContextKey(context)) {
    throw new FindingHistoricalPlaceWorkflowError(
      "invalid_input",
      "Текст місця, дата або документ змінилися. Оберіть місце повторно.",
    );
  }
  return { ...decision, confirmed: true };
}

export function currentConfirmedFindingPlace(
  context: FindingHistoricalPlaceContext,
  decision: FindingHistoricalPlaceDecision | null,
): PlaceSummary | null {
  if (!decision?.confirmed) return null;
  return decision.contextKey === findingHistoricalPlaceContextKey(context)
    ? decision.place
    : null;
}

export function findingHistoricalPlaceDecisionFromState(
  context: FindingHistoricalPlaceContext,
  state: FindingDocumentPlaceState | null,
): FindingHistoricalPlaceDecision | null {
  if (!state
    || !state.documentMatchesFinding
    || state.link.documentId !== context.documentId
    || state.link.originalText !== context.originalText) {
    return null;
  }
  return {
    contextKey: findingHistoricalPlaceContextKey(context),
    place: state.place,
    confirmed: state.link.resolutionStatus === "confirmed",
  };
}

export async function suggestHistoricalPlacesForFinding(
  input: FindingHistoricalPlaceContext & { query?: string; limit?: number },
  signal?: AbortSignal,
): Promise<PlaceSummary[]> {
  const query = (input.query ?? input.originalText).trim();
  if (!input.projectId.trim() || query.length < 2) return [];
  // Keep pure decision helpers usable in Node tests without eagerly loading
  // the browser-oriented Supabase catalogue service.
  const { searchHistoricalPlaces } = await import("./historicalPlacesService.ts");
  return searchHistoricalPlaces({
    query,
    projectId: input.projectId,
    atDate: exactFindingEventDate(input.eventDate),
    limit: Math.min(Math.max(input.limit ?? 12, 1), 20),
  }, signal);
}

export async function confirmFindingDocumentPlace(
  input: ConfirmFindingDocumentPlaceInput,
  dependencies: FindingHistoricalPlaceWorkflowDependencies = {},
): Promise<Record<string, unknown>> {
  const findingId = requiredValue(input.findingId, "Не вдалося визначити знахідку.");
  const documentId = requiredValue(input.documentId, "Оберіть пов’язаний документ.");
  const placeId = requiredValue(input.placeId, "Оберіть історичне місце.");
  if (!input.originalText.trim()) {
    throw new FindingHistoricalPlaceWorkflowError(
      "invalid_input",
      "Вкажіть точний текст місця з документа.",
    );
  }

  const parameters = {
    p_finding_id: findingId,
    p_document_id: documentId,
    p_place_id: placeId,
    // Preserve the literal source wording. Trimming here would silently
    // rewrite evidence that belongs to the transcription.
    p_original_text: input.originalText,
    p_resolution_status: "confirmed",
    p_expected_finding_updated_at: input.expectedFindingUpdatedAt || null,
  };
  const response = dependencies.rpc
    ? await dependencies.rpc("confirm_finding_document_place_v1", parameters)
    : await callFindingHistoricalPlaceRpc("confirm_finding_document_place_v1", parameters);
  const { data, error } = response;
  if (error) {
    if (isPendingMigrationError(error, "confirm_finding_document_place_v1")) {
      throw new FindingHistoricalPlaceWorkflowError(
        "migration_pending",
        "Локальна міграція історичних місць для знахідок ще не застосована. Оновіть локальну Supabase і повторіть підтвердження.",
        { cause: error },
      );
    }
    const conflictMessage = confirmationConflictMessage(error);
    throw new FindingHistoricalPlaceWorkflowError(
      "request_failed",
      conflictMessage || error.message || "Не вдалося прив’язати місце до документа.",
      { cause: error },
    );
  }
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

export async function getFindingDocumentPlace(
  findingIdValue: string,
  dependencies: FindingHistoricalPlaceWorkflowDependencies = {},
): Promise<FindingDocumentPlaceState | null> {
  const findingId = requiredValue(findingIdValue, "Не вдалося визначити знахідку.");
  const parameters = { p_finding_id: findingId };
  const response = dependencies.rpc
    ? await dependencies.rpc("get_finding_document_place_v1", parameters)
    : await callFindingHistoricalPlaceRpc("get_finding_document_place_v1", parameters);
  const { data, error } = response;
  if (error) {
    if (isPendingMigrationError(error, "get_finding_document_place_v1")) {
      throw new FindingHistoricalPlaceWorkflowError(
        "migration_pending",
        "Локальна міграція історичних місць для знахідок ще не застосована. Оновіть локальну Supabase і повторіть завантаження.",
        { cause: error },
      );
    }
    throw new FindingHistoricalPlaceWorkflowError(
      "request_failed",
      error.code === "42501"
        ? "Немає права переглядати прив’язане історичне місце в цьому проєкті."
        : confirmationConflictMessage(error) || error.message || "Не вдалося завантажити прив’язане історичне місце.",
      { cause: error },
    );
  }
  return findingDocumentPlaceState(data);
}

export async function clearFindingDocumentPlace(
  input: ClearFindingDocumentPlaceInput,
  dependencies: FindingHistoricalPlaceWorkflowDependencies = {},
): Promise<Record<string, unknown>> {
  const findingId = requiredValue(input.findingId, "Не вдалося визначити знахідку.");
  const parameters = {
    p_finding_id: findingId,
    p_expected_finding_updated_at: input.expectedFindingUpdatedAt || null,
  };
  const response = dependencies.rpc
    ? await dependencies.rpc("clear_finding_document_place_v1", parameters)
    : await callFindingHistoricalPlaceRpc("clear_finding_document_place_v1", parameters);
  const { data, error } = response;
  if (error) {
    if (isPendingMigrationError(error, "clear_finding_document_place_v1")) {
      throw new FindingHistoricalPlaceWorkflowError(
        "migration_pending",
        "Локальна міграція історичних місць для знахідок ще не застосована. Оновіть локальну Supabase і повторіть очищення.",
        { cause: error },
      );
    }
    throw new FindingHistoricalPlaceWorkflowError(
      "request_failed",
      confirmationConflictMessage(error) || error.message || "Не вдалося прибрати прив’язку історичного місця.",
      { cause: error },
    );
  }
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

async function callFindingHistoricalPlaceRpc(
  name: string,
  parameters: Record<string, unknown>,
): Promise<{ data: unknown; error: FindingHistoricalPlaceRpcError | null }> {
  const { getSupabaseClient } = await import("./supabaseAuth.ts");
  const { data, error } = await getSupabaseClient().rpc(
    name,
    parameters,
  );
  return { data, error };
}

function requiredValue(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new FindingHistoricalPlaceWorkflowError("invalid_input", message);
  }
  return normalized;
}

function isPendingMigrationError(
  error: FindingHistoricalPlaceRpcError,
  rpcName: string,
): boolean {
  const message = `${error.message ?? ""} ${error.details ?? ""}`.toLocaleLowerCase("en-US");
  return error.code === "PGRST202"
    || error.code === "42883"
    || message.includes(rpcName.toLocaleLowerCase("en-US"))
      && (message.includes("schema cache") || message.includes("does not exist") || message.includes("could not find"));
}

function findingDocumentPlaceState(input: unknown): FindingDocumentPlaceState | null {
  const envelope = recordValue(input);
  const link = recordValue(envelope.link);
  const place = recordValue(envelope.place);
  if (!Object.keys(link).length && !Object.keys(place).length) return null;
  const id = stringValue(link.id);
  const placeId = stringValue(link.placeId);
  const placeProjectionId = stringValue(place.id);
  if (!id || !placeId || !placeProjectionId || placeId !== placeProjectionId) {
    throw new FindingHistoricalPlaceWorkflowError(
      "request_failed",
      "Сервер повернув неповну прив’язку історичного місця. Оновіть форму й повторіть завантаження.",
    );
  }
  const findingId = stringValue(envelope.findingId) || stringValue(link.findingId);
  const documentId = stringValue(link.documentId);
  const originalText = typeof link.originalText === "string" ? link.originalText : "";
  if (!findingId || !documentId || !originalText) {
    throw new FindingHistoricalPlaceWorkflowError(
      "request_failed",
      "Сервер повернув неповні дані джерела для історичного місця.",
    );
  }
  return {
    findingId,
    currentDocumentId: nullableStringValue(envelope.currentDocumentId),
    documentMatchesFinding: envelope.documentMatchesFinding === true,
    link: {
      id,
      findingId: stringValue(link.findingId) || findingId,
      documentId,
      placeId,
      relationType: stringValue(link.relationType),
      originalText,
      resolutionStatus: stringValue(link.resolutionStatus),
      sourceReference: nullableStringValue(link.sourceReference),
      confidence: finiteNumber(link.confidence),
      note: stringValue(link.note),
      metadata: recordValue(link.metadata),
      lockVersion: finiteNumber(link.lockVersion),
      createdAt: stringValue(link.createdAt),
      updatedAt: stringValue(link.updatedAt),
    },
    place: loadedPlaceSummary(place),
  };
}

function loadedPlaceSummary(place: Record<string, unknown>): PlaceSummary {
  const id = stringValue(place.id);
  const canonicalName = stringValue(place.canonicalName);
  const projectId = nullableStringValue(place.projectId);
  const status = stringValue(place.status);
  const verificationStatus = stringValue(place.verificationStatus);
  return {
    id,
    projectId,
    scope: place.scope === "global" ? "global" : "project",
    status: (["active", "needs_review", "merged", "archived"] as const).includes(
      status as "active" | "needs_review" | "merged" | "archived",
    ) ? status as PlaceSummary["status"] : "active",
    verificationStatus: (["unverified", "plausible", "verified", "disputed"] as const).includes(
      verificationStatus as "unverified" | "plausible" | "verified" | "disputed",
    ) ? verificationStatus as PlaceSummary["verificationStatus"] : "unverified",
    isPublic: place.isPublic === true,
    publishedAt: nullableStringValue(place.publishedAt),
    canonicalName,
    displayName: stringValue(place.displayName) || canonicalName,
    atDate: nullableStringValue(place.atDate),
    modernName: stringValue(place.modernName),
    placeType: stringValue(place.placeType) || "other",
    latitude: nullableFiniteNumber(place.latitude),
    longitude: nullableFiniteNumber(place.longitude),
    currentCountry: stringValue(place.currentCountry),
    currentAdmin: stringValue(place.currentAdmin),
    hierarchy: [],
    wikidataId: nullableStringValue(place.wikidataId),
    geonamesId: nullableStringValue(place.geonamesId),
    externalIds: loadedExternalIds(place.externalIds),
    description: stringValue(place.description),
    matchedName: "",
    matchedNameType: null,
    // The load projection contains compact name evidence. Suggestions use the
    // full search parser; the persisted badge needs only the canonical Place.
    names: [],
    lockVersion: finiteNumber(place.lockVersion),
    createdAt: stringValue(place.createdAt),
    updatedAt: stringValue(place.updatedAt),
  };
}

function loadedExternalIds(input: unknown): Record<string, string> {
  if (Array.isArray(input)) {
    const result: Record<string, string> = {};
    for (const item of input) {
      const row = recordValue(item);
      const provider = stringValue(row.provider);
      const externalIdentifier = stringValue(row.externalIdentifier);
      if (provider && externalIdentifier) result[provider] = externalIdentifier;
    }
    return result;
  }
  const row = recordValue(input);
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown): string | null {
  const result = stringValue(value);
  return result || null;
}

function finiteNumber(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function confirmationConflictMessage(error: FindingHistoricalPlaceRpcError): string {
  const message = `${error.message ?? ""} ${error.details ?? ""}`;
  if (error.code === "40001" || message.includes("FINDING_VERSION_CONFLICT")) {
    return "Знахідку вже змінили в іншому вікні. Оновіть її, перевірте місце ще раз і повторіть підтвердження.";
  }
  if (message.includes("FINDING_PLACE_ORIGINAL_TEXT_CONFLICT")) {
    return "Для цієї знахідки вже збережено інший точний текст місця. Оновіть знахідку й перевірте джерело; початковий текст не було перезаписано.";
  }
  if (message.includes("FINDING_DOCUMENT_MISMATCH")
    || message.includes("FINDING_DOCUMENT_PROJECT_SCOPE_MISMATCH")) {
    return "Документ знахідки змінився або належить іншому проєкту. Оновіть форму й оберіть місце повторно.";
  }
  if (error.code === "42501" || message.includes("PROJECT_EDIT_ACCESS_REQUIRED")) {
    return "Немає права редагувати цей проєкт або вибране місце.";
  }
  return "";
}
