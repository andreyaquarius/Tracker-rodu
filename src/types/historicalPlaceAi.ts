import type {
  HistoricalPlaceTemporalContext,
  PlaceNameDatePrecision,
  PlaceNameType,
} from "./historicalPlaces.ts";

export type HistoricalPlaceAiNameType = Exclude<
  PlaceNameType,
  "canonical" | "modern"
>;

export type HistoricalPlaceAiRelationKind =
  | "administrative_parent"
  | "parish"
  | "related";

export type HistoricalPlaceAiTargetMatch =
  | "likely_same"
  | "uncertain"
  | "different";

export interface HistoricalPlaceAiTargetInput {
  /** Existing target being enriched. It is validated server-side and never proposed by AI. */
  placeId?: string | null;
  canonicalName: string;
  modernName?: string;
}

export interface HistoricalPlaceAiSourceInput {
  /** Optional provenance. The document must belong to the selected project. */
  documentId?: string | null;
  /** Exact user-selected excerpt. It is not written to the database by the Edge Function. */
  text: string;
  page?: string;
  sourceReference?: string;
}

export interface HistoricalPlaceAiExtractionInput {
  projectId: string;
  consent: boolean;
  target: HistoricalPlaceAiTargetInput;
  source: HistoricalPlaceAiSourceInput;
  temporalContext?: HistoricalPlaceTemporalContext | null;
}

export interface HistoricalPlaceAiTargetAssessment {
  match: HistoricalPlaceAiTargetMatch;
  reason: string;
}

export interface HistoricalPlaceAiEvidenceSuggestion {
  suggestionId: string;
  sourceQuote: string;
  /** True only when the returned quote can be found in the submitted excerpt. */
  verifiedQuote: boolean;
  confidence: number;
  warnings: string[];
  /** Always true; provider output cannot disable the review step. */
  requiresUserReview: true;
}

export interface HistoricalPlaceAiNameSuggestion
  extends HistoricalPlaceAiEvidenceSuggestion {
  originalText: string;
  normalizedName: string;
  languageCode: string;
  nameType: HistoricalPlaceAiNameType;
  validFromText: string | null;
  validToText: string | null;
  datePrecision: PlaceNameDatePrecision;
}

export interface HistoricalPlaceAiRelationSuggestion
  extends HistoricalPlaceAiEvidenceSuggestion {
  kind: HistoricalPlaceAiRelationKind;
  /** Literal name of the related place. A user must match it to the catalogue. */
  relatedPlaceOriginalText: string;
  relationType: string;
  religion: string | null;
  validFromText: string | null;
  validToText: string | null;
  datePrecision: PlaceNameDatePrecision;
  requiresPlaceMatch: true;
}

export interface HistoricalPlaceAiPlaceTypeSuggestion
  extends HistoricalPlaceAiEvidenceSuggestion {
  placeType: string;
}

export interface HistoricalPlaceAiExtractionResult {
  targetAssessment: HistoricalPlaceAiTargetAssessment;
  nameSuggestions: HistoricalPlaceAiNameSuggestion[];
  relationSuggestions: HistoricalPlaceAiRelationSuggestion[];
  placeTypeSuggestion: HistoricalPlaceAiPlaceTypeSuggestion | null;
  warnings: string[];
  /** Always true; the result is evidence for a draft, never a saved fact. */
  needsHumanReview: true;
}

export interface HistoricalPlaceAiExtractionResponse {
  jobId: string;
  createdAt: string;
  provider: "google_gemini";
  model: string;
  keySource: "platform" | "user";
  promptVersion: string;
  schemaVersion: string;
  /** Server-generated SHA-256 identity of the authorized target/source context. */
  contextKey: string;
  /** Client-side identity used only to invalidate a stale result before acceptance. */
  requestContextKey: string;
  inputSummary: {
    projectId: string;
    documentId: string | null;
    sourcePage: string;
    sourceReference: string;
    sourceTextChars: number;
    sourceTextSha256: string;
  };
  result: HistoricalPlaceAiExtractionResult;
}

export interface HistoricalPlaceAiDraftSelection {
  nameSuggestionIds: Iterable<string>;
  relationSuggestionIds: Iterable<string>;
  acceptPlaceType: boolean;
}

/**
 * Safe payload emitted by the review panel. It contains suggestions only and
 * deliberately has no coordinates, external identifiers or resolved Place ID.
 */
export interface HistoricalPlaceAiAcceptedDraft {
  contextKey: string;
  jobId: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  sourceTextSha256: string;
  sourceDocumentId: string | null;
  sourceReference: string;
  sourcePage: string;
  nameSuggestions: HistoricalPlaceAiNameSuggestion[];
  relationSuggestions: HistoricalPlaceAiRelationSuggestion[];
  placeTypeSuggestion: HistoricalPlaceAiPlaceTypeSuggestion | null;
}
