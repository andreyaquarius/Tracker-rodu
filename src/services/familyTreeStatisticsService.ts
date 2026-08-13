import { getSupabaseClient } from "./supabaseAuth.ts";

export type FamilyTreeStatisticsTabId =
  | "overview"
  | "ancestry"
  | "demography"
  | "families"
  | "names"
  | "geography"
  | "research"
  | "quality";

export interface FamilyTreeStatisticsFilters {
  scope: "all" | "direct-ancestors" | "descendants";
  branch: "all" | "paternal" | "maternal";
  generationFrom?: number;
  generationTo?: number;
  yearFrom?: number;
  yearTo?: number;
  sex: "all" | "male" | "female" | "unknown";
  lifeStatus: "all" | "living" | "deceased" | "unknown";
  relationshipType?: string;
  eventTypes: string[];
  surnameMode: "displayed" | "birth" | "married";
  evidenceStatuses: string[];
  place?: string;
  importSourceKey?: string;
  sourceFilter: "all" | "with-sources" | "without-sources";
}

export const DEFAULT_FAMILY_TREE_STATISTICS_FILTERS: FamilyTreeStatisticsFilters = {
  scope: "all",
  branch: "all",
  sex: "all",
  lifeStatus: "all",
  eventTypes: [],
  surnameMode: "displayed",
  evidenceStatuses: [],
  sourceFilter: "all",
};

export interface FamilyTreeStatisticsMeta {
  treeId: string;
  projectId: string;
  title: string;
  rootPersonId: string;
  rootPersonName: string;
  graphVersion: string;
  treeUpdatedAt: string;
  calculatedAt: string;
  canViewPrivate: boolean;
  filteredPeople: number;
  scope: FamilyTreeStatisticsFilters["scope"];
  branch: FamilyTreeStatisticsFilters["branch"];
  methodology: string;
}

export interface FamilyTreeStatisticsMetric {
  id: string;
  label: string;
  value: number | string;
  suffix?: string;
  sampleSize?: number;
  detailKey?: string;
}

export interface FamilyTreeStatisticsChartRow {
  label: string;
  value: number;
  secondary?: number;
  tertiary?: number;
  total?: number;
  percent?: number;
  detailKey?: string;
}

export interface FamilyTreeStatisticsChart {
  id: string;
  title: string;
  type: "donut" | "bar" | "horizontal-bar" | "stacked-progress" | "distribution" | "line" | "multi-bar";
  seriesLabels?: string[];
  rows: FamilyTreeStatisticsChartRow[];
}

export interface FamilyTreeStatisticsTable {
  id: string;
  title: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface FamilyTreeStatisticsMapMarker {
  label: string;
  latitude: number;
  longitude: number;
  value: number;
  people: number;
  detailKey?: string;
}

export interface FamilyTreeStatisticsMapPath {
  personId: string;
  fromLabel: string;
  toLabel: string;
  fromLatitude: number;
  fromLongitude: number;
  toLatitude: number;
  toLongitude: number;
}

export interface FamilyTreeStatisticsPayload {
  meta: FamilyTreeStatisticsMeta;
  metrics: FamilyTreeStatisticsMetric[];
  charts: FamilyTreeStatisticsChart[];
  tables: FamilyTreeStatisticsTable[];
  map?: { markers: FamilyTreeStatisticsMapMarker[]; paths?: FamilyTreeStatisticsMapPath[] };
}

export interface FamilyTreeStatisticsPersonRow {
  id: string;
  displayName: string;
  birthDate: string | null;
  deathDate: string | null;
  generation: number;
  branch: string;
  kinshipKind: string;
  completeness: number;
  evidenceStatus: string;
  hasSources: boolean;
}

export interface FamilyTreeStatisticsPeoplePage {
  meta: FamilyTreeStatisticsMeta;
  detailKey: string;
  offset: number;
  limit: number;
  total: number;
  rows: FamilyTreeStatisticsPersonRow[];
}

const RPC_BY_TAB: Record<FamilyTreeStatisticsTabId, string> = {
  overview: "get_family_tree_statistics_overview_v1",
  ancestry: "get_family_tree_statistics_ancestry_v1",
  demography: "get_family_tree_statistics_demography_v1",
  families: "get_family_tree_statistics_families_v1",
  names: "get_family_tree_statistics_names_v1",
  geography: "get_family_tree_statistics_geography_v1",
  research: "get_family_tree_statistics_research_v1",
  quality: "get_family_tree_statistics_quality_v1",
};

const responseCache = new Map<string, FamilyTreeStatisticsPayload>();

function compactRequest(
  treeId: string,
  rootPersonId: string,
  filters: FamilyTreeStatisticsFilters,
  bypassCache = false,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    treeId,
    rootPersonId,
    scope: filters.scope,
    branch: filters.branch,
    generationFrom: filters.generationFrom,
    generationTo: filters.generationTo,
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    sex: filters.sex,
    lifeStatus: filters.lifeStatus,
    relationshipType: filters.relationshipType?.trim() || undefined,
    eventTypes: filters.eventTypes,
    surnameMode: filters.surnameMode,
    evidenceStatuses: filters.evidenceStatuses,
    place: filters.place?.trim() || undefined,
    importSourceKey: filters.importSourceKey?.trim() || undefined,
    sourceFilter: filters.sourceFilter,
    bypassCache: bypassCache || undefined,
  }).filter(([, value]) => value !== undefined));
}

function cacheKey(
  tab: FamilyTreeStatisticsTabId,
  treeId: string,
  rootPersonId: string,
  graphVersion: string,
  filters: FamilyTreeStatisticsFilters,
): string {
  return JSON.stringify([tab, treeId, rootPersonId, graphVersion, compactRequest(treeId, rootPersonId, filters)]);
}

export async function loadFamilyTreeStatistics(
  tab: FamilyTreeStatisticsTabId,
  input: {
    treeId: string;
    rootPersonId: string;
    graphVersion: string;
    filters: FamilyTreeStatisticsFilters;
    force?: boolean;
  },
): Promise<FamilyTreeStatisticsPayload> {
  const key = cacheKey(tab, input.treeId, input.rootPersonId, input.graphVersion, input.filters);
  if (!input.force) {
    const cached = responseCache.get(key);
    if (cached) return cached;
  }
  const { data, error } = await getSupabaseClient().rpc(RPC_BY_TAB[tab], {
    p_request: compactRequest(input.treeId, input.rootPersonId, input.filters, input.force),
  });
  if (error) throw error;
  const payload = data as FamilyTreeStatisticsPayload;
  responseCache.set(key, payload);
  return payload;
}

export async function loadFamilyTreeStatisticsPeople(input: {
  treeId: string;
  rootPersonId: string;
  filters: FamilyTreeStatisticsFilters;
  detailKey: string;
  offset?: number;
  limit?: number;
}): Promise<FamilyTreeStatisticsPeoplePage> {
  const { data, error } = await getSupabaseClient().rpc("list_family_tree_statistics_people_v1", {
    p_request: {
      ...compactRequest(input.treeId, input.rootPersonId, input.filters),
      detailKey: input.detailKey,
      offset: input.offset ?? 0,
      limit: input.limit ?? 50,
    },
  });
  if (error) throw error;
  return data as FamilyTreeStatisticsPeoplePage;
}

export function clearFamilyTreeStatisticsCache(treeId?: string): void {
  if (!treeId) {
    responseCache.clear();
    return;
  }
  for (const key of responseCache.keys()) {
    if (key.includes(treeId)) responseCache.delete(key);
  }
}

export function familyTreeStatisticsErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  if (/TREE_NOT_FOUND_OR_FORBIDDEN|42501/i.test(message)) {
    return "Дерево не знайдено або у вас немає доступу до його статистики.";
  }
  if (/TREE_ROOT_CHANGED|40001/i.test(message)) {
    return "Кореневу особу дерева змінено. Оновіть сторінку статистики.";
  }
  if (/statement timeout|57014/i.test(message)) {
    return "Розрахунок великого дерева триває довше очікуваного. Звузьте фільтри або повторіть запит.";
  }
  return message || "Не вдалося розрахувати статистику дерева.";
}
