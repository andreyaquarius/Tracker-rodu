import type {
  ConfirmedHistoricalPlaceDraft,
  HistoricalPlaceDiscoveryCandidate,
  HistoricalPlaceDiscoveryField,
  HistoricalPlaceDiscoveryInput,
  HistoricalPlaceDiscoveryProvider,
  HistoricalPlaceDiscoveryResult,
  HistoricalPlaceDiscoverySource,
} from "../types/historicalPlaceDiscovery.ts";

const FUNCTION_NAME = "discover-historical-places";
const MAX_QUERY_LENGTH = 120;
const MAX_RESULTS = 10;

const FIELD_NAMES = new Set<HistoricalPlaceDiscoveryField>([
  "canonicalName",
  "modernName",
  "placeType",
  "latitude",
  "longitude",
  "currentCountry",
  "currentAdmin",
  "wikidataId",
  "geonamesId",
  "externalIds",
]);

const INTERNAL_PLACE_TYPES = new Set([
  "settlement", "urban_settlement", "hamlet", "small_settlement", "village", "town", "city",
  "sloboda", "colony", "folwark", "estate", "manor", "parish", "volost",
  "county", "governorate", "okrug", "district", "region", "community",
  "country", "cemetery", "church", "monastery", "military_unit", "other",
]);

export interface HistoricalPlaceDiscoveryDependencies {
  invoke?: (
    name: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * One user-initiated lookup. There is intentionally no browser-side provider
 * fallback: external catalogue policies, authentication, caching and rate
 * limiting belong to the Edge Function.
 */
export async function discoverHistoricalPlaces(
  input: HistoricalPlaceDiscoveryInput,
  dependencies: HistoricalPlaceDiscoveryDependencies = {},
): Promise<HistoricalPlaceDiscoveryResult> {
  const query = input.query.trim();
  const projectId = input.projectId.trim();
  if (query.length < 2) {
    throw new Error("Введіть щонайменше два символи назви населеного пункту.");
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Назва не може бути довшою за ${MAX_QUERY_LENGTH} символів.`);
  }
  if (!projectId) throw new Error("Оберіть проєкт для пошуку історичного місця.");

  const limit = Math.min(Math.max(integer(input.limit, 7), 1), MAX_RESULTS);
  // Keep pure normalizers usable in Node contract tests without eagerly
  // loading the browser-oriented Supabase client.
  const invoke = dependencies.invoke ?? (async (
    name: string,
    body: Record<string, unknown>,
  ) => {
    const { invokeEdgeFunction } = await import("./edgeFunctions.ts");
    return invokeEdgeFunction<unknown>(name, body, {
      connectionErrorMessage:
        "Не вдалося підключитися до пошуку зовнішніх каталогів. Заповніть місце вручну або повторіть пізніше.",
    });
  });
  const response = await invoke(FUNCTION_NAME, { query, projectId, limit });
  return normalizeHistoricalPlaceDiscoveryResult(response, query, limit);
}

export function normalizeHistoricalPlaceDiscoveryResult(
  response: unknown,
  fallbackQuery = "",
  limit = MAX_RESULTS,
): HistoricalPlaceDiscoveryResult {
  const row = record(response);
  const rawSearchedProviders = valueOf(row, "searchedProviders", "searched_providers");
  const searchedProviders: HistoricalPlaceDiscoveryProvider[] = Array.isArray(rawSearchedProviders)
    ? unique(rawSearchedProviders.map((provider) => normalizeProvider(provider)))
    : [];
  return {
    query: stringValue(valueOf(row, "query")) || fallbackQuery,
    candidates: normalizeHistoricalPlaceDiscoveryResponse(response).slice(0, limit),
    warnings: stringList(valueOf(row, "warnings")),
    searchedProviders,
    requiresConfirmation: valueOf(row, "requiresConfirmation", "requires_confirmation") !== false,
  };
}

/** Public for deterministic contract tests and future cached-provider adapters. */
export function normalizeHistoricalPlaceDiscoveryResponse(
  response: unknown,
): HistoricalPlaceDiscoveryCandidate[] {
  const rows = responseRows(response);
  const candidates = rows
    .map(normalizeCandidate)
    .filter((item): item is HistoricalPlaceDiscoveryCandidate => Boolean(item));
  const merged = new Map<string, HistoricalPlaceDiscoveryCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.id);
    merged.set(candidate.id, existing ? mergeCandidates(existing, candidate) : candidate);
  }
  return [...merged.values()];
}

/**
 * Produces only reviewed form fields. In particular it cannot overwrite a
 * document's exact place wording or a researcher-authored description.
 */
export function toConfirmedHistoricalPlaceDraft(
  candidate: HistoricalPlaceDiscoveryCandidate,
): ConfirmedHistoricalPlaceDraft {
  return {
    canonicalName: candidate.canonicalName,
    modernName: candidate.modernName,
    placeType: candidate.placeType,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    currentCountry: candidate.currentCountry,
    currentAdmin: candidate.currentAdmin,
    wikidataId: candidate.wikidataId,
    geonamesId: candidate.geonamesId,
    externalIds: { ...candidate.externalIds },
    sourceMetadata: {
      candidateId: candidate.id,
      sources: candidate.sources.map((source) => ({ ...source })),
      fieldSources: Object.fromEntries(
        Object.entries(candidate.fieldSources).map(([field, providers]) => [
          field,
          [...(providers ?? [])],
        ]),
      ),
      confidence: candidate.confidence,
      matchReasons: [...candidate.matchReasons],
    },
  };
}

function normalizeCandidate(value: unknown): HistoricalPlaceDiscoveryCandidate | null {
  const row = record(value);
  const canonicalName = stringValue(valueOf(row, "canonicalName", "canonical_name", "name", "label"));
  if (!canonicalName) return null;

  const externalIds = normalizeExternalIds(valueOf(row, "externalIds", "external_ids"));
  const katottgCode = stringValue(valueOf(row, "katottgCode", "katottg_code"));
  const osmId = stringValue(valueOf(row, "osmId", "osm_id", "openstreetmapId", "openstreetmap_id"));
  if (katottgCode) externalIds.katottg = katottgCode;
  if (osmId) externalIds.osm = osmId;

  const rawWikidataId = stringValue(valueOf(row, "wikidataId", "wikidata_id"))
    || externalIds.wikidata
    || "";
  const wikidataId = /^Q\d+$/i.test(rawWikidataId) ? rawWikidataId.toUpperCase() : null;
  delete externalIds.wikidata;
  const rawGeonamesId = stringValue(valueOf(row, "geonamesId", "geonames_id"))
    || externalIds.geonames
    || "";
  const geonamesId = /^\d+$/.test(rawGeonamesId) ? rawGeonamesId : null;
  delete externalIds.geonames;

  const rawLatitude = coordinate(valueOf(row, "latitude", "lat"), -90, 90);
  const rawLongitude = coordinate(valueOf(row, "longitude", "lon", "lng"), -180, 180);
  const hasCoordinatePair = rawLatitude !== null && rawLongitude !== null;
  const adminParts = stringList(valueOf(row, "adminParts", "admin_parts", "administrativePath", "administrative_path"));
  const currentAdmin = stringValue(valueOf(row, "currentAdmin", "current_admin", "administrativeLabel", "administrative_label"))
    || adminParts.join(", ");
  const sources = normalizeSources(valueOf(row, "sources", "sourceMetadata", "source_metadata"));
  addDerivedSources(sources, externalIds, wikidataId);

  const modernName = stringValue(valueOf(row, "modernName", "modern_name")) || canonicalName;
  const placeType = normalizePlaceType(valueOf(row, "placeType", "place_type", "type", "category"));
  const candidate: HistoricalPlaceDiscoveryCandidate = {
    id: stringValue(valueOf(row, "id", "stableKey", "stable_key"))
      || candidateIdentity(canonicalName, currentAdmin, rawLatitude, rawLongitude, externalIds, wikidataId),
    canonicalName,
    modernName,
    placeType,
    latitude: hasCoordinatePair ? rawLatitude : null,
    longitude: hasCoordinatePair ? rawLongitude : null,
    currentCountry: stringValue(valueOf(row, "currentCountry", "current_country", "country")),
    currentAdmin,
    wikidataId,
    geonamesId,
    externalIds,
    sources: dedupeSources(sources),
    fieldSources: normalizeFieldSources(valueOf(row, "fieldSources", "field_sources")),
    confidence: normalizedConfidence(valueOf(row, "confidence", "score")),
    matchReasons: stringList(valueOf(row, "matchReasons", "match_reasons", "reasons")),
  };
  return candidate;
}

function mergeCandidates(
  first: HistoricalPlaceDiscoveryCandidate,
  second: HistoricalPlaceDiscoveryCandidate,
): HistoricalPlaceDiscoveryCandidate {
  const fieldSources = { ...first.fieldSources };
  for (const [field, providers] of Object.entries(second.fieldSources)) {
    const name = field as HistoricalPlaceDiscoveryField;
    fieldSources[name] = unique([...(fieldSources[name] ?? []), ...(providers ?? [])]);
  }
  return {
    ...first,
    modernName: first.modernName || second.modernName,
    placeType: first.placeType === "settlement" ? second.placeType : first.placeType,
    latitude: first.latitude ?? second.latitude,
    longitude: first.longitude ?? second.longitude,
    currentCountry: first.currentCountry || second.currentCountry,
    currentAdmin: first.currentAdmin || second.currentAdmin,
    wikidataId: first.wikidataId ?? second.wikidataId,
    geonamesId: first.geonamesId ?? second.geonamesId,
    externalIds: { ...second.externalIds, ...first.externalIds },
    sources: dedupeSources([...first.sources, ...second.sources]),
    fieldSources,
    confidence: Math.max(first.confidence, second.confidence),
    matchReasons: unique([...first.matchReasons, ...second.matchReasons]),
  };
}

function responseRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const row = record(value);
  for (const key of ["candidates", "suggestions", "items", "results"]) {
    if (Array.isArray(row[key])) return row[key] as unknown[];
  }
  if (row.data && row.data !== value) return responseRows(row.data);
  return [];
}

function normalizeExternalIds(value: unknown): Record<string, string> {
  const row = record(value);
  const result: Record<string, string> = {};
  for (const [providerValue, rawIdentifier] of Object.entries(row)) {
    const provider = externalProviderKey(providerValue);
    const identifierRow = record(rawIdentifier);
    const identifier = stringValue(
      typeof rawIdentifier === "object" && rawIdentifier !== null
        ? valueOf(identifierRow, "externalIdentifier", "external_identifier", "id", "value")
        : rawIdentifier,
    );
    if (provider && identifier) result[provider] = identifier;
  }
  return result;
}

function normalizeSources(value: unknown): HistoricalPlaceDiscoverySource[] {
  const values = Array.isArray(value)
    ? value
    : Object.entries(record(value)).map(([provider, item]) => ({ provider, ...record(item) }));
  return values.map((item) => {
    const row = record(item);
    const provider = normalizeProvider(valueOf(row, "provider", "key", "name"));
    const defaults = providerDefaults(provider);
    return {
      provider,
      label: stringValue(valueOf(row, "label", "providerLabel", "provider_label")) || defaults.label,
      externalId: nullableString(valueOf(row, "externalId", "external_id", "identifier", "id")),
      url: safeHttpUrl(valueOf(row, "url", "sourceUrl", "source_url")),
      attribution: stringValue(valueOf(row, "attribution")) || defaults.attribution,
      attributionUrl: safeHttpUrl(valueOf(row, "attributionUrl", "attribution_url")) || defaults.attributionUrl,
      datasetVersion: nullableString(valueOf(row, "datasetVersion", "dataset_version", "version")),
    };
  });
}

function addDerivedSources(
  sources: HistoricalPlaceDiscoverySource[],
  externalIds: Record<string, string>,
  wikidataId: string | null,
): void {
  if (externalIds.katottg && !sources.some((source) => source.provider === "katottg")) {
    sources.push(sourceFromIdentifier("katottg", externalIds.katottg));
  }
  if (externalIds.osm && !sources.some((source) => source.provider === "openstreetmap")) {
    sources.push(sourceFromIdentifier("openstreetmap", externalIds.osm));
  }
  if (wikidataId && !sources.some((source) => source.provider === "wikidata")) {
    sources.push(sourceFromIdentifier("wikidata", wikidataId));
  }
}

function sourceFromIdentifier(
  provider: Exclude<HistoricalPlaceDiscoveryProvider, "other">,
  externalId: string,
): HistoricalPlaceDiscoverySource {
  const defaults = providerDefaults(provider);
  return {
    provider,
    label: defaults.label,
    externalId,
    url: providerSourceUrl(provider, externalId),
    attribution: defaults.attribution,
    attributionUrl: defaults.attributionUrl,
    datasetVersion: null,
  };
}

function normalizeFieldSources(
  value: unknown,
): HistoricalPlaceDiscoveryCandidate["fieldSources"] {
  const result: HistoricalPlaceDiscoveryCandidate["fieldSources"] = {};
  for (const [rawField, rawProviders] of Object.entries(record(value))) {
    const field = normalizeFieldName(rawField);
    if (!field) continue;
    const providers = Array.isArray(rawProviders) ? rawProviders : [rawProviders];
    result[field] = unique(providers.map((provider) => {
      const row = record(provider);
      return normalizeProvider(
        typeof provider === "object" && provider !== null
          ? valueOf(row, "provider", "key", "name")
          : provider,
      );
    }));
  }
  return result;
}

function normalizeFieldName(value: string): HistoricalPlaceDiscoveryField | null {
  const aliases: Record<string, HistoricalPlaceDiscoveryField> = {
    canonical_name: "canonicalName",
    modern_name: "modernName",
    place_type: "placeType",
    current_country: "currentCountry",
    current_admin: "currentAdmin",
    wikidata_id: "wikidataId",
    geonames_id: "geonamesId",
    external_ids: "externalIds",
  };
  const normalized = aliases[value] ?? value;
  return FIELD_NAMES.has(normalized as HistoricalPlaceDiscoveryField)
    ? normalized as HistoricalPlaceDiscoveryField
    : null;
}

function normalizePlaceType(value: unknown): string {
  const text = stringValue(value).toLocaleLowerCase("uk-UA").replace(/[\s-]+/g, "_");
  if (INTERNAL_PLACE_TYPES.has(text)) return text;
  const aliases: Record<string, string> = {
    m: "city", "м": "city", "місто": "city",
    t: "town", "т": "town", "смт": "town", "містечко": "town",
    c: "village", "с": "village", "село": "village",
    x: "settlement", "х": "settlement", "селище": "settlement",
    locality: "settlement", place: "settlement",
    хутір: "hamlet", присілок: "small_settlement",
    municipality: "community", administrative: "region",
  };
  return aliases[text] ?? "settlement";
}

function normalizeProvider(value: unknown): HistoricalPlaceDiscoveryProvider {
  const text = stringValue(value).toLocaleLowerCase("uk-UA");
  if (text.includes("katottg") || text.includes("катоттг") || text.includes("katotth")) return "katottg";
  if (text.includes("openstreetmap") || text === "osm" || text.includes("nominatim")) return "openstreetmap";
  if (text.includes("wikidata")) return "wikidata";
  return "other";
}

function externalProviderKey(value: string): string {
  const provider = normalizeProvider(value);
  if (provider === "openstreetmap") return "osm";
  if (provider !== "other") return provider;
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9_.:-]+/g, "_");
}

function providerDefaults(provider: HistoricalPlaceDiscoveryProvider): {
  label: string;
  attribution: string;
  attributionUrl: string | null;
} {
  if (provider === "katottg") return {
    label: "КАТОТТГ",
    attribution: "Кодифікатор адміністративно-територіальних одиниць України",
    attributionUrl: "https://mininfra.gov.ua/diialnist/rozvytok-mistsevoho-samovriaduvannia/kodyfikator-administratyvno-terytorialnykh-odynyts-ta-terytorii-terytorialnykh-hromad",
  };
  if (provider === "openstreetmap") return {
    label: "OpenStreetMap",
    attribution: "© OpenStreetMap contributors",
    attributionUrl: "https://www.openstreetmap.org/copyright",
  };
  if (provider === "wikidata") return {
    label: "Wikidata",
    attribution: "Дані Wikidata",
    attributionUrl: "https://www.wikidata.org/",
  };
  return { label: "Інше джерело", attribution: "Зовнішнє джерело", attributionUrl: null };
}

function providerSourceUrl(
  provider: Exclude<HistoricalPlaceDiscoveryProvider, "other">,
  externalId: string,
): string | null {
  if (provider === "wikidata" && /^Q\d+$/i.test(externalId)) {
    return `https://www.wikidata.org/wiki/${externalId.toUpperCase()}`;
  }
  if (provider === "openstreetmap") {
    const compactMatch = /^([NWR])(\d+)$/i.exec(externalId);
    if (compactMatch) {
      const kind = ({ N: "node", W: "way", R: "relation" } as const)[compactMatch[1]!.toUpperCase() as "N" | "W" | "R"];
      return `https://www.openstreetmap.org/${kind}/${compactMatch[2]}`;
    }
    const pathMatch = /^(node|way|relation)\/(\d+)$/i.exec(externalId);
    return pathMatch
      ? `https://www.openstreetmap.org/${pathMatch[1]!.toLocaleLowerCase("en-US")}/${pathMatch[2]}`
      : null;
  }
  return null;
}

function candidateIdentity(
  canonicalName: string,
  currentAdmin: string,
  latitude: number | null,
  longitude: number | null,
  externalIds: Record<string, string>,
  wikidataId: string | null,
): string {
  if (externalIds.katottg) return `katottg:${externalIds.katottg}`;
  if (wikidataId) return `wikidata:${wikidataId}`;
  if (externalIds.osm) return `osm:${externalIds.osm}`;
  return [canonicalName, currentAdmin, latitude ?? "", longitude ?? ""]
    .join("|")
    .toLocaleLowerCase("uk-UA");
}

function dedupeSources(sources: HistoricalPlaceDiscoverySource[]): HistoricalPlaceDiscoverySource[] {
  const result = new Map<string, HistoricalPlaceDiscoverySource>();
  for (const source of sources) {
    const key = `${source.provider}|${source.externalId ?? ""}|${source.url ?? ""}`;
    if (!result.has(key)) result.set(key, source);
  }
  return [...result.values()];
}

function safeHttpUrl(value: unknown): string | null {
  const input = stringValue(value);
  if (!input) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizedConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const percent = number >= 0 && number <= 1 ? number * 100 : number;
  return Math.round(Math.max(0, Math.min(100, percent)));
}

function coordinate(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => {
    const row = record(item);
    return stringValue(
      typeof item === "object" && item !== null
        ? valueOf(row, "name", "label", "value", "reason")
        : item,
    );
  }).filter(Boolean));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function nullableString(value: unknown): string | null {
  return stringValue(value) || null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function valueOf(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (key in row) return row[key];
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
