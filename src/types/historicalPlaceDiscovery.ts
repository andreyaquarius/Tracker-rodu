/** External catalogues that can contribute to one reviewed place suggestion. */
export type HistoricalPlaceDiscoveryProvider =
  | "katottg"
  | "openstreetmap"
  | "wikidata"
  | "other";

export type HistoricalPlaceDiscoveryField =
  | "canonicalName"
  | "modernName"
  | "placeType"
  | "latitude"
  | "longitude"
  | "currentCountry"
  | "currentAdmin"
  | "wikidataId"
  | "geonamesId"
  | "externalIds";

/** Safe, displayable provider provenance. Raw provider payloads are not retained. */
export interface HistoricalPlaceDiscoverySource {
  provider: HistoricalPlaceDiscoveryProvider;
  label: string;
  externalId: string | null;
  url: string | null;
  attribution: string;
  attributionUrl: string | null;
  datasetVersion: string | null;
}

export interface HistoricalPlaceDiscoveryCandidate {
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
  /** Includes `katottg` and `osm` when those catalogues supplied stable IDs. */
  externalIds: Record<string, string>;
  sources: HistoricalPlaceDiscoverySource[];
  fieldSources: Partial<
    Record<HistoricalPlaceDiscoveryField, HistoricalPlaceDiscoveryProvider[]>
  >;
  /** Normalized 0–100 provider confidence. It is never a verification status. */
  confidence: number;
  matchReasons: string[];
}

export interface HistoricalPlaceDiscoveryInput {
  query: string;
  projectId: string;
  limit?: number;
}

export interface HistoricalPlaceDiscoveryResult {
  query: string;
  candidates: HistoricalPlaceDiscoveryCandidate[];
  warnings: string[];
  searchedProviders: HistoricalPlaceDiscoveryProvider[];
  requiresConfirmation: boolean;
}

export interface HistoricalPlaceDiscoverySourceMetadata {
  candidateId: string;
  sources: HistoricalPlaceDiscoverySource[];
  fieldSources: HistoricalPlaceDiscoveryCandidate["fieldSources"];
  confidence: number;
  matchReasons: string[];
}

/**
 * Fields that may be copied into the existing-place form after an explicit
 * user confirmation. Evidence text and descriptions are deliberately absent.
 */
export interface ConfirmedHistoricalPlaceDraft {
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
  sourceMetadata: HistoricalPlaceDiscoverySourceMetadata;
}
