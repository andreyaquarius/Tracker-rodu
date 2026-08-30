import { createClient } from "npm:@supabase/supabase-js@2";

type ProviderName = "katottg" | "openstreetmap" | "wikidata";

type DiscoverySource = {
  provider: ProviderName;
  label: string;
  url: string;
  attribution: string;
  attributionUrl: string;
  externalId: string | null;
  datasetVersion: string | null;
};

type DiscoveryCandidate = {
  id: string;
  canonicalName: string;
  modernName: string;
  placeType: string;
  latitude: number | null;
  longitude: number | null;
  currentCountry: string;
  currentAdmin: string;
  wikidataId: string | null;
  geonamesId: string | null;
  externalIds: Record<string, string>;
  sources: DiscoverySource[];
  fieldSources: Record<string, ProviderName[]>;
  confidence: number;
  matchReasons: string[];
};

type NominatimResult = {
  osm_type?: string;
  osm_id?: number | string;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  class?: string;
  type?: string;
  importance?: number;
  address?: Record<string, string>;
  namedetails?: Record<string, string>;
  extratags?: Record<string, string>;
};

type WikidataSearchItem = {
  id?: string;
  label?: string;
  description?: string;
  concepturi?: string;
};

type WikidataClaim = {
  mainsnak?: {
    datavalue?: {
      value?: unknown;
    };
  };
};

type WikidataEntity = {
  id?: string;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<string, WikidataClaim[]>;
};

type CacheEnvelope = {
  hit: boolean;
  payload: unknown;
};

const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function configuredAllowedOrigins(): Set<string> {
  const values = [Deno.env.get("ALLOWED_ORIGIN"), Deno.env.get("APP_URL")]
    .flatMap((value) => (value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);
  const origins = new Set(values);
  for (const origin of localDevOrigins) origins.add(origin);
  if (!origins.size) origins.add("*");
  return origins;
}

function corsHeadersForRequest(request: Request): HeadersInit {
  const origin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const allowedOrigins = configuredAllowedOrigins();
  const allowOrigin = allowedOrigins.has("*")
    ? "*"
    : origin && allowedOrigins.has(origin)
      ? origin
      : [...allowedOrigins][0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersForRequest(request), "Content-Type": "application/json" },
  });
}

function text(value: unknown, maxLength = 500): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim().slice(0, maxLength)
    : "";
}

function normalizeSearchKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function numberOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => text(value, 2_000)).filter(Boolean))];
}

function addFieldSource(
  target: Record<string, ProviderName[]>,
  field: string,
  provider: ProviderName,
) {
  target[field] = unique([...(target[field] ?? []), provider]) as ProviderName[];
}

function source(
  provider: ProviderName,
  url: string,
  externalId: string | null = null,
  datasetVersion: string | null = null,
): DiscoverySource {
  if (provider === "katottg") {
    return {
      provider,
      label: "КАТОТТГ",
      url,
      attribution: "Міністерство розвитку громад та територій України",
      attributionUrl: "https://mininfra.gov.ua/diialnist/rozvytok-mistsevoho-samovriaduvannia/kodyfikator-administratyvno-terytorialnykh-odynyts-ta-terytorii-terytorialnykh-hromad",
      externalId,
      datasetVersion,
    };
  }
  if (provider === "wikidata") {
    return {
      provider,
      label: "Wikidata",
      url,
      attribution: "Wikidata, CC0",
      attributionUrl: "https://www.wikidata.org/wiki/Wikidata:Copyright",
      externalId,
      datasetVersion,
    };
  }
  return {
    provider,
    label: "OpenStreetMap",
    url,
    attribution: "© OpenStreetMap contributors",
    attributionUrl: "https://www.openstreetmap.org/copyright",
    externalId,
    datasetVersion,
  };
}

function firstRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function cacheEnvelope(value: unknown): CacheEnvelope {
  const row = firstRow(value);
  if (!row) return { hit: false, payload: null };
  const payload = row.payload ?? row.result ?? row.value ?? null;
  const hit = row.hit === true || row.found === true || payload !== null;
  return { hit, payload };
}

function appUserAgent(): string {
  const appUrl = Deno.env.get("APP_URL")?.trim() || "https://trekerrodu.com.ua";
  return `TrekerRodu/1.0 (${appUrl}; historical-place-discovery)`;
}

async function fetchJson(
  url: string,
  timeoutMs = 8_000,
  outerSignal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const abortFromOuter = () => controller.abort();
    if (outerSignal?.aborted) controller.abort();
    outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Accept-Language": "uk",
          "User-Agent": appUserAgent(),
        },
      });
      if (response.ok) return await response.json();
      if (![429, 503].includes(response.status) || attempt > 0 || outerSignal?.aborted) {
        throw new Error(`Provider HTTP ${response.status}`);
      }
      const retryAfterSeconds = Number(response.headers.get("Retry-After"));
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1_000
        : 600;
      await wait(Math.min(2_000, Math.max(300, retryAfterMs)));
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", abortFromOuter);
    }
  }
  throw new Error("Provider retry exhausted");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function withProviderDeadline<T>(
  task: Promise<T>,
  controller: AbortController,
  milliseconds = 15_000,
): Promise<T> {
  let timer: number | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Provider deadline exceeded"));
    }, milliseconds);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function acquireProviderSlot(
  admin: ReturnType<typeof createClient>,
  provider: string,
  minimumIntervalMs: number,
) {
  const { data, error } = await admin.rpc("acquire_historical_place_provider_slot_v1", {
    p_provider: provider,
    p_min_interval_ms: minimumIntervalMs,
  });
  if (error) throw error;
  const row = firstRow(data);
  const waitMs = Number(row?.wait_ms ?? row?.waitMs ?? data ?? 0);
  if (Number.isFinite(waitMs) && waitMs > 12_000) {
    throw new Error("Provider queue is busy");
  }
  if (Number.isFinite(waitMs) && waitMs > 0) await wait(waitMs);
}

async function cachedProviderRequest(
  admin: ReturnType<typeof createClient>,
  provider: string,
  cacheKey: string,
  ttlSeconds: number,
  minimumIntervalMs: number,
  loader: () => Promise<unknown>,
  rateProvider = provider,
): Promise<unknown> {
  const { data: cached, error: cacheError } = await admin.rpc(
    "get_historical_place_discovery_cache_v1",
    { p_provider: provider, p_cache_key: cacheKey },
  );
  if (cacheError) throw cacheError;
  const envelope = cacheEnvelope(cached);
  if (envelope.hit) return envelope.payload;

  await acquireProviderSlot(admin, rateProvider, minimumIntervalMs);
  const payload = await loader();
  const { error: writeError } = await admin.rpc(
    "put_historical_place_discovery_cache_v1",
    {
      p_provider: provider,
      p_cache_key: cacheKey,
      p_payload: payload,
      p_ttl_seconds: ttlSeconds,
    },
  );
  if (writeError) throw writeError;
  return payload;
}

function mapKatottgType(category: string): string {
  return ({ M: "city", T: "urban_settlement", C: "village", X: "small_settlement" } as Record<string, string>)[category] ?? "settlement";
}

function katottgCandidates(data: unknown): DiscoveryCandidate[] {
  const envelope = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(envelope.items)
      ? envelope.items
      : [];
  const dataset = envelope.dataset && typeof envelope.dataset === "object"
    ? envelope.dataset as Record<string, unknown>
    : {};
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const code = text(row.code ?? row.katottgCode ?? row.katottg_code, 30);
    const name = text(row.name ?? row.canonical_name, 500);
    if (!code || !name) return [];
    const category = text(row.category ?? row.object_category, 5).toUpperCase();
    const admin = text(row.currentAdmin ?? row.current_admin ?? row.admin_path ?? row.administrative_path, 2_000);
    const sourceUrl = text(row.source_url ?? dataset.sourcePageUrl ?? dataset.source_page_url ?? dataset.sourceUrl ?? dataset.source_url, 2_000) || "https://mininfra.gov.ua/diialnist/rozvytok-mistsevoho-samovriaduvannia/kodyfikator-administratyvno-terytorialnykh-odynyts-ta-terytorii-terytorialnykh-hromad";
    const datasetVersion = text(row.dataset_version ?? row.version ?? dataset.version, 80) || null;
    return [{
      id: `katottg:${code}`,
      canonicalName: name,
      modernName: name,
      placeType: text(row.placeType ?? row.place_type, 80) || mapKatottgType(category),
      latitude: null,
      longitude: null,
      currentCountry: text(row.country, 500) || "Україна",
      currentAdmin: admin,
      wikidataId: null,
      geonamesId: null,
      externalIds: { katottg: code },
      sources: [source("katottg", sourceUrl, code, datasetVersion)],
      fieldSources: {
        canonicalName: ["katottg"],
        modernName: ["katottg"],
        placeType: ["katottg"],
        currentCountry: ["katottg"],
        currentAdmin: ["katottg"],
        externalIds: ["katottg"],
      },
      confidence: Number(row.score ?? 0.96),
      matchReasons: unique([
        text(row.match_reason, 500),
        `Офіційний код КАТОТТГ ${code}`,
      ]),
    } satisfies DiscoveryCandidate];
  });
}

function osmPlaceType(item: NominatimResult): string {
  return ({
    city: "city",
    town: "town",
    village: "village",
    hamlet: "hamlet",
    isolated_dwelling: "hamlet",
    locality: "settlement",
    municipality: "community",
    administrative: "district",
  } as Record<string, string>)[text(item.type, 80).toLowerCase()] ?? "settlement";
}

function osmStableId(item: NominatimResult): string {
  const osmType = text(item.osm_type, 20).toLowerCase();
  const osmId = text(item.osm_id, 60);
  const prefix = ({ node: "node", way: "way", relation: "relation" } as Record<string, string>)[osmType];
  return prefix && osmId ? `${prefix}/${osmId}` : "";
}

function osmAdmin(address: Record<string, string> | undefined, placeName: string): string {
  if (!address) return "";
  return unique([
    address.municipality,
    address.county,
    address.district,
    address.state_district,
    address.state,
  ]).filter((value) => normalizeSearchKey(value) !== normalizeSearchKey(placeName)).join(", ");
}

function osmCandidates(data: unknown): DiscoveryCandidate[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as NominatimResult;
    const latitude = numberOrNull(item.lat, -90, 90);
    const longitude = numberOrNull(item.lon, -180, 180);
    const osm = osmStableId(item);
    const name = text(
      item.namedetails?.["name:uk"] ?? item.name ?? item.display_name?.split(",")[0],
      500,
    );
    if (!name || latitude === null || longitude === null) return [];
    const wikidata = text(item.extratags?.wikidata, 40);
    const katottg = text(
      item.extratags?.["ref:katotth"] ?? item.extratags?.["ref:katottg"] ?? item.extratags?.katottg,
      40,
    );
    const geonames = text(item.extratags?.geonames, 40);
    const externalIds: Record<string, string> = {};
    if (osm) externalIds.osm = osm;
    if (wikidata) externalIds.wikidata = wikidata;
    if (katottg) externalIds.katottg = katottg;
    if (geonames) externalIds.geonames = geonames;
    const currentCountry = text(item.address?.country, 500);
    const currentAdmin = osmAdmin(item.address, name);
    const fields: Record<string, ProviderName[]> = {};
    for (const field of ["canonicalName", "modernName", "placeType", "latitude", "longitude", "externalIds"]) addFieldSource(fields, field, "openstreetmap");
    if (currentCountry) addFieldSource(fields, "currentCountry", "openstreetmap");
    if (currentAdmin) addFieldSource(fields, "currentAdmin", "openstreetmap");
    if (wikidata) addFieldSource(fields, "wikidataId", "openstreetmap");
    if (geonames) addFieldSource(fields, "geonamesId", "openstreetmap");
    return [{
      id: `osm:${osm || `${latitude}:${longitude}`}`,
      canonicalName: name,
      modernName: name,
      placeType: osmPlaceType(item),
      latitude,
      longitude,
      currentCountry,
      currentAdmin,
      wikidataId: wikidata || null,
      geonamesId: geonames || null,
      externalIds,
      sources: [source("openstreetmap", osm ? `https://www.openstreetmap.org/${osm}` : "https://www.openstreetmap.org/copyright", osm || null)],
      fieldSources: fields,
      confidence: Math.min(0.92, Math.max(0.55, Number(item.importance ?? 0.55) + 0.25)),
      matchReasons: unique([text(item.display_name, 2_000), "Знайдено за сучасною картою OpenStreetMap"]),
    } satisfies DiscoveryCandidate];
  });
}

function claimValue(entity: WikidataEntity, property: string): unknown {
  return entity.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
}

function claimEntityIds(entity: WikidataEntity, property: string): string[] {
  return unique((entity.claims?.[property] ?? [])
    .map((claim) => entityId(claim.mainsnak?.datavalue?.value))
    .filter(Boolean));
}

function entityId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  const id = text(row.id, 40);
  if (/^Q\d+$/.test(id)) return id;
  const numericId = Number(row["numeric-id"]);
  return Number.isInteger(numericId) && numericId > 0 ? `Q${numericId}` : "";
}

function quantityText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return text(String(value), 80);
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return text(row.amount ?? row.text, 80).replace(/^\+/, "");
}

function wikidataPlaceType(instanceOf: string[]): string | null {
  const types: Record<string, string> = {
    Q515: "city",
    Q3957: "town",
    Q532: "village",
    Q5084: "hamlet",
    Q486972: "settlement",
    Q200250: "city",
    Q1549591: "city",
    Q174844: "city",
    Q1637706: "city",
    Q15284: "community",
    Q2983893: "community",
    Q6256: "country",
  };
  for (const id of instanceOf) if (types[id]) return types[id];
  return null;
}

function entityLabel(entity: WikidataEntity | undefined): string {
  return text(entity?.labels?.uk?.value ?? entity?.labels?.en?.value ?? entity?.labels?.ru?.value, 500);
}

function wikidataCandidates(
  searchData: unknown,
  entitiesData: unknown,
): DiscoveryCandidate[] {
  const searchItems = searchData && typeof searchData === "object" && Array.isArray((searchData as { search?: unknown }).search)
    ? (searchData as { search: WikidataSearchItem[] }).search
    : [];
  const entities = entitiesData && typeof entitiesData === "object"
    ? ((entitiesData as { entities?: Record<string, WikidataEntity> }).entities ?? {})
    : {};
  const searchRank = new Map(searchItems.map((item, index) => [text(item.id, 40), index]));
  return Object.values(entities).flatMap((entity) => {
    const qid = text(entity.id, 40);
    if (!/^Q\d+$/.test(qid) || !searchRank.has(qid)) return [];
    const name = entityLabel(entity) || text(searchItems.find((item) => item.id === qid)?.label, 500);
    if (!name) return [];
    const coordinate = claimValue(entity, "P625");
    const coordinateRow = coordinate && typeof coordinate === "object" ? coordinate as Record<string, unknown> : {};
    const latitude = numberOrNull(coordinateRow.latitude, -90, 90);
    const longitude = numberOrNull(coordinateRow.longitude, -180, 180);
    const parentQid = entityId(claimValue(entity, "P131"));
    const countryQid = entityId(claimValue(entity, "P17"));
    const instanceOf = claimEntityIds(entity, "P31");
    const katottg = quantityText(claimValue(entity, "P9435"));
    const osmRelation = quantityText(claimValue(entity, "P402"));
    const geonames = quantityText(claimValue(entity, "P1566"));
    const mappedPlaceType = wikidataPlaceType(instanceOf);
    // Text search can return people, organizations and documents. Keep only
    // known settlement classes or entities carrying a strong geographic ID.
    if (!mappedPlaceType && !katottg && !osmRelation && !geonames) return [];
    const parentName = entityLabel(entities[parentQid]);
    const countryName = entityLabel(entities[countryQid]);
    const externalIds: Record<string, string> = { wikidata: qid };
    if (katottg) externalIds.katottg = katottg;
    if (osmRelation) externalIds.osm = `relation/${osmRelation}`;
    if (geonames) externalIds.geonames = geonames;
    const fields: Record<string, ProviderName[]> = {};
    for (const field of ["canonicalName", "modernName", "placeType", "wikidataId", "externalIds"]) addFieldSource(fields, field, "wikidata");
    if (latitude !== null && longitude !== null) {
      addFieldSource(fields, "latitude", "wikidata");
      addFieldSource(fields, "longitude", "wikidata");
    }
    if (parentName) addFieldSource(fields, "currentAdmin", "wikidata");
    if (countryName) addFieldSource(fields, "currentCountry", "wikidata");
    return [{
      id: `wikidata:${qid}`,
      canonicalName: name,
      modernName: name,
      placeType: mappedPlaceType ?? "settlement",
      latitude,
      longitude,
      currentCountry: countryName,
      currentAdmin: parentName,
      wikidataId: qid,
      geonamesId: geonames || null,
      externalIds,
      sources: [source("wikidata", `https://www.wikidata.org/wiki/${qid}`, qid)],
      fieldSources: fields,
      confidence: Math.max(0.62, 0.86 - (searchRank.get(qid) ?? 0) * 0.035),
      matchReasons: unique([
        text(searchItems.find((item) => item.id === qid)?.description, 500),
        `Об'єкт Wikidata ${qid}`,
      ]),
    } satisfies DiscoveryCandidate];
  });
}

function candidateStrongIds(candidate: DiscoveryCandidate): Set<string> {
  return new Set(unique([
    candidate.externalIds.katottg && `katottg:${candidate.externalIds.katottg}`,
    candidate.wikidataId && `wikidata:${candidate.wikidataId}`,
    candidate.externalIds.osm && `osm:${candidate.externalIds.osm}`,
    candidate.geonamesId && `geonames:${candidate.geonamesId}`,
    candidate.id,
  ]));
}

function candidatesShareIdentity(left: DiscoveryCandidate, right: DiscoveryCandidate): boolean {
  const leftIds = candidateStrongIds(left);
  return [...candidateStrongIds(right)].some((id) => leftIds.has(id));
}

function candidateHasProvider(candidate: DiscoveryCandidate, provider: ProviderName): boolean {
  return candidate.sources.some((item) => item.provider === provider);
}

function mergeCandidate(base: DiscoveryCandidate, addition: DiscoveryCandidate): DiscoveryCandidate {
  const sources = [...base.sources];
  for (const item of addition.sources) {
    if (!sources.some((candidate) => candidate.provider === item.provider && candidate.url === item.url)) sources.push(item);
  }
  const fieldSources = { ...base.fieldSources };
  for (const [field, providers] of Object.entries(addition.fieldSources)) {
    fieldSources[field] = unique([...(fieldSources[field] ?? []), ...providers]) as ProviderName[];
  }
  const baseHasKatottg = candidateHasProvider(base, "katottg");
  const additionHasKatottg = candidateHasProvider(addition, "katottg");
  const preferAdditionKatottg = !baseHasKatottg && additionHasKatottg;
  const externalIds = preferAdditionKatottg
    ? { ...base.externalIds, ...addition.externalIds }
    : { ...addition.externalIds, ...base.externalIds };
  return {
    ...base,
    id: preferAdditionKatottg ? addition.id : base.id,
    canonicalName: preferAdditionKatottg ? addition.canonicalName : base.canonicalName || addition.canonicalName,
    modernName: preferAdditionKatottg ? addition.modernName : base.modernName || addition.modernName,
    placeType: preferAdditionKatottg
      ? addition.placeType
      : base.placeType === "settlement"
        ? addition.placeType
        : base.placeType,
    latitude: base.latitude ?? addition.latitude,
    longitude: base.longitude ?? addition.longitude,
    currentCountry: preferAdditionKatottg ? addition.currentCountry : base.currentCountry || addition.currentCountry,
    currentAdmin: preferAdditionKatottg ? addition.currentAdmin : base.currentAdmin || addition.currentAdmin,
    wikidataId: base.wikidataId ?? addition.wikidataId,
    geonamesId: base.geonamesId ?? addition.geonamesId,
    externalIds,
    sources,
    fieldSources,
    confidence: Math.min(0.99, Math.max(base.confidence, addition.confidence) + 0.04),
    matchReasons: unique([...base.matchReasons, ...addition.matchReasons]),
  };
}

function mergeCandidates(groups: DiscoveryCandidate[][], limit: number): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];
  for (const group of groups) {
    for (const candidate of group) {
      const matchingIndexes = candidates
        .map((existing, index) => candidatesShareIdentity(existing, candidate) ? index : -1)
        .filter((index) => index >= 0);
      let merged = candidate;
      for (const index of matchingIndexes) merged = mergeCandidate(candidates[index], merged);
      for (const index of matchingIndexes.sort((left, right) => right - left)) candidates.splice(index, 1);
      candidates.push(merged);
    }
  }
  return candidates
    .sort((left, right) => right.confidence - left.confidence || right.sources.length - left.sources.length || left.canonicalName.localeCompare(right.canonicalName, "uk"))
    .slice(0, limit);
}

async function wikidataDiscovery(
  admin: ReturnType<typeof createClient>,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<DiscoveryCandidate[]> {
  const normalized = normalizeSearchKey(query);
  const searchKey = `uk:${limit}:${normalized}`;
  const searchData = await cachedProviderRequest(
    admin,
    "wikidata-search",
    searchKey,
    30 * 24 * 60 * 60,
    350,
    () => fetchJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({
      action: "wbsearchentities",
      search: query,
      language: "uk",
      uselang: "uk",
      type: "item",
      limit: String(limit),
      format: "json",
      origin: "*",
    }).toString()}`, 8_000, signal),
    "wikidata",
  );
  const searchItems = searchData && typeof searchData === "object" && Array.isArray((searchData as { search?: unknown }).search)
    ? (searchData as { search: WikidataSearchItem[] }).search
    : [];
  const ids = unique(searchItems.map((item) => text(item.id, 40)).filter((id) => /^Q\d+$/.test(id)));
  if (!ids.length) return [];

  const primary = await cachedProviderRequest(
    admin,
    "wikidata-entities",
    ids.join("|"),
    30 * 24 * 60 * 60,
    350,
    () => fetchJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({
      action: "wbgetentities",
      ids: ids.join("|"),
      props: "labels|descriptions|claims",
      languages: "uk|en|ru",
      languagefallback: "1",
      format: "json",
      origin: "*",
    }).toString()}`, 8_000, signal),
    "wikidata",
  );
  const primaryEntities = primary && typeof primary === "object"
    ? ((primary as { entities?: Record<string, WikidataEntity> }).entities ?? {})
    : {};
  const contextIds = unique(Object.values(primaryEntities).flatMap((entity) => [
    entityId(claimValue(entity, "P131")),
    entityId(claimValue(entity, "P17")),
  ]).filter(Boolean));
  let contextEntities: Record<string, WikidataEntity> = {};
  if (contextIds.length) {
    const context = await cachedProviderRequest(
      admin,
      "wikidata-entities",
      contextIds.join("|"),
      30 * 24 * 60 * 60,
      350,
      () => fetchJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({
        action: "wbgetentities",
        ids: contextIds.join("|"),
        props: "labels",
        languages: "uk|en|ru",
        languagefallback: "1",
        format: "json",
        origin: "*",
      }).toString()}`, 8_000, signal),
      "wikidata",
    );
    contextEntities = context && typeof context === "object"
      ? ((context as { entities?: Record<string, WikidataEntity> }).entities ?? {})
      : {};
  }
  return wikidataCandidates(searchData, { entities: { ...primaryEntities, ...contextEntities } });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeadersForRequest(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = request.headers.get("Authorization");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error("Налаштування серверної функції неповні.");
    if (!authorization) return json(request, { error: "Потрібна авторизація." }, 401);

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json(request, { error: "Не вдалося підтвердити користувача." }, 401);

    const input = await request.json() as { query?: unknown; projectId?: unknown; limit?: unknown };
    const query = text(input.query, 160);
    const projectId = text(input.projectId, 80);
    const requestedLimit = Number(input.limit);
    const limit = Math.min(20, Math.max(3, Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 12));
    if (query.length < 2) return json(request, { candidates: [], warnings: [] });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      return json(request, { error: "Оберіть проєкт для пошуку місця." }, 400);
    }

    const { data: canEditProject, error: membershipError } = await userClient.rpc(
      "can_edit_project",
      { target_project_id: projectId },
    );
    if (membershipError) throw membershipError;
    if (canEditProject !== true) {
      return json(request, { error: "У вас немає права створювати місця в цьому проєкті." }, 403);
    }

    const warnings: string[] = [];
    const { data: katottgData, error: katottgError } = await userClient.rpc(
      "search_katottg_settlements_v1",
      { p_query: query, p_limit: limit },
    );
    if (katottgError) throw katottgError;

    const nominatimController = new AbortController();
    const nominatimPromise = withProviderDeadline(cachedProviderRequest(
      admin,
      "nominatim",
      `search:uk:${limit}:${normalizeSearchKey(query)}`,
      30 * 24 * 60 * 60,
      1_050,
      () => fetchJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({
        q: query,
        format: "jsonv2",
        addressdetails: "1",
        namedetails: "1",
        extratags: "1",
        featureType: "settlement",
        "accept-language": "uk",
        limit: String(Math.min(7, limit)),
      }).toString()}`, 8_000, nominatimController.signal),
    ), nominatimController).then(osmCandidates).catch(() => {
      warnings.push("OpenStreetMap тимчасово не відповів; показано результати інших джерел.");
      return [];
    });

    const wikidataController = new AbortController();
    const wikidataPromise = withProviderDeadline(
      wikidataDiscovery(admin, query, Math.min(7, limit), wikidataController.signal),
      wikidataController,
    ).catch(() => {
      warnings.push("Wikidata тимчасово не відповіла; показано результати інших джерел.");
      return [];
    });

    const [osm, wikidata] = await Promise.all([nominatimPromise, wikidataPromise]);
    const candidates = mergeCandidates([katottgCandidates(katottgData), osm, wikidata], limit);
    return json(request, {
      query,
      candidates,
      warnings: unique(warnings),
      searchedProviders: ["katottg", "openstreetmap", "wikidata"],
      requiresConfirmation: true,
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : error && typeof error === "object"
        ? JSON.stringify(error)
        : String(error);
    console.error("historical-place discovery failed", message);
    return json(request, {
      error: "Не вдалося виконати пошук у каталогах. Спробуйте ще раз або заповніть місце вручну.",
    }, 500);
  }
});
