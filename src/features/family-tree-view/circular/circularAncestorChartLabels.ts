import type { TreePerson } from "../types.ts";
import type { CircularAncestorOccurrence } from "./circularAncestorChartLayout.ts";
import { formatDateForDisplay } from "../../../utils/dateHelpers.ts";

export type CircularAncestorLabelMode = "curved" | "radial" | "hidden";
export type CircularAncestorVisibleLabelMode = Exclude<
  CircularAncestorLabelMode,
  "hidden"
>;

export interface CircularAncestorLabelPlan {
  /** The planner always returns a visible geometry mode for valid sectors. */
  mode: CircularAncestorLabelMode;
  /** Kept separately so callers can remain compatible with older plans. */
  preferredMode: CircularAncestorVisibleLabelMode;
  name: string;
  life: string;
  /** All dimensions are SVG/world units, not CSS pixels. */
  fontSize: number;
  lifeFontSize: number;
  lineGap: number;
  availableLength: number;
  availableCrossSize: number;
  requiredLength: number;
  requiredCrossSize: number;
  /** Geometry-only scale applied to the nominal world-unit typography. */
  fitScale: number;
}

export interface CircularAncestorZoomRecommendationOptions {
  /** Smallest acceptable rendered size for both the name and life line. */
  targetScreenFontSize?: number;
  /** Only known occurrences through this generation affect the result. */
  maxGeneration?: number;
}

export interface CircularAncestorZoomRecommendation {
  /** Camera zoom multiplier relative to the supplied fit scale. */
  recommendedZoom: number;
  /** Resulting CSS pixels per world unit after applying the recommendation. */
  recommendedScale: number;
  /** CSS pixels per world unit at camera zoom=1. */
  fitScale: number;
  targetScreenFontSize: number;
  minimumWorldFontSize: number;
  minimumScreenFontSizeAtFit: number;
  limitingOccurrenceId?: string;
  consideredOccurrenceCount: number;
  maxGeneration: number;
}

const CURVED_MIN_ANGLE = 22.5;
const NAME_WORLD_FONT_SIZE = 11;
const LIFE_WORLD_FONT_SIZE = 8.5;
const LINE_GAP_WORLD_SIZE = 3.5;
const DEFAULT_TARGET_SCREEN_FONT_SIZE = 7;
const DEFAULT_RECOMMENDATION_MAX_GENERATION = 8;

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/**
 * `displayName` is the adapter's authoritative full card name and includes the
 * patronymic when one exists. It must never be shortened for the chart.
 */
export function formatCircularAncestorName(person: TreePerson): string {
  const displayName = normalizeWhitespace(person.displayName);
  if (displayName) return displayName;

  const fallback = [person.surname, person.givenName]
    .map(normalizeWhitespace)
    .filter(Boolean)
    .join(" ");
  return fallback || "Особа без імені";
}

/** Preserves genealogical precision while presenting exact dates as dd.mm.yyyy. */
export function formatCircularAncestorLife(person: TreePerson): string {
  const birth = formatDateForDisplay(normalizeWhitespace(person.birth?.display || person.birth?.sort));
  const death = formatDateForDisplay(normalizeWhitespace(person.death?.display || person.death?.sort));
  if (birth && death) return `${birth} — ${death}`;
  if (birth) return `нар. ${birth}`;
  if (death) return `пом. ${death}`;
  return "Дати не вказані";
}

function normalizedPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Approximate proportional-font width in `fontSize` units. */
function estimatedTextUnits(value: string): number {
  let units = 0;
  for (const character of Array.from(value)) {
    if (/\s/u.test(character)) units += 0.34;
    else if (/[ilI1іІїЇ]/u.test(character)) units += 0.36;
    else if (/[MW@%ШЩЖЮФ]/u.test(character)) units += 0.78;
    else units += 0.58;
  }
  return Math.max(1, units);
}

/**
 * Plans exactly one label for one known occurrence. Text is never truncated.
 * Typography is fitted entirely in SVG/world units and therefore remains
 * geometrically stable when the viewport, fullscreen state, or camera changes.
 *
 * The optional second argument is intentionally ignored and only preserves
 * source compatibility with the first screen-dependent implementation.
 */
export function planCircularAncestorLabel(
  occurrence: CircularAncestorOccurrence,
  _legacyWorldPerPixel?: number,
): CircularAncestorLabelPlan {
  const name = formatCircularAncestorName(occurrence.person);
  const life = formatCircularAncestorLife(occurrence.person);
  const sweepDegrees = Math.abs(occurrence.endAngle - occurrence.startAngle);
  const sweepRadians = sweepDegrees * Math.PI / 180;
  const midRadius = (occurrence.innerRadius + occurrence.outerRadius) / 2;
  const ringWidth = Math.max(0, occurrence.outerRadius - occurrence.innerRadius);
  const preferredMode: CircularAncestorVisibleLabelMode =
    sweepDegrees >= CURVED_MIN_ANGLE ? "curved" : "radial";

  // Curved labels run around the sector. Radial labels run from the inner
  // radius towards the outer radius. Padding keeps glyphs off sector borders.
  const availableLength = preferredMode === "curved"
    ? midRadius * sweepRadians * 0.84
    : ringWidth * 0.76;
  const availableCrossSize = preferredMode === "curved"
    ? ringWidth * 0.72
    : midRadius * sweepRadians * 0.72;

  const baseFontSize = NAME_WORLD_FONT_SIZE;
  const baseLifeFontSize = LIFE_WORLD_FONT_SIZE;
  const baseLineGap = LINE_GAP_WORLD_SIZE;
  const baseRequiredLength = Math.max(
    estimatedTextUnits(name) * baseFontSize,
    estimatedTextUnits(life) * baseLifeFontSize,
  );
  const baseRequiredCrossSize =
    baseFontSize + baseLineGap + baseLifeFontSize;
  const fitScale = Math.min(
    1,
    availableLength / Math.max(1e-6, baseRequiredLength),
    availableCrossSize / Math.max(1e-6, baseRequiredCrossSize),
  );
  const fontSize = baseFontSize * fitScale;
  const lifeFontSize = baseLifeFontSize * fitScale;
  const lineGap = baseLineGap * fitScale;
  const requiredLength = baseRequiredLength * fitScale;
  const requiredCrossSize = baseRequiredCrossSize * fitScale;

  return {
    mode: preferredMode,
    preferredMode,
    name,
    life,
    fontSize,
    lifeFontSize,
    lineGap,
    availableLength,
    availableCrossSize,
    requiredLength,
    requiredCrossSize,
    fitScale,
  };
}

/**
 * Finds a camera zoom that makes even the smallest geometrically fitted name
 * or life line readable at the requested screen size. It examines only actual
 * sparse occurrences; theoretical empty Ahnentafel slots are never expanded.
 */
export function recommendCircularAncestorLabelZoom(
  occurrences: readonly CircularAncestorOccurrence[],
  fitPixelsPerWorld: number,
  options: CircularAncestorZoomRecommendationOptions = {},
): CircularAncestorZoomRecommendation {
  const fitScale = normalizedPositive(fitPixelsPerWorld, 1);
  const targetScreenFontSize = normalizedPositive(
    options.targetScreenFontSize ?? DEFAULT_TARGET_SCREEN_FONT_SIZE,
    DEFAULT_TARGET_SCREEN_FONT_SIZE,
  );
  const rawMaxGeneration = Number.isFinite(options.maxGeneration)
    ? Math.floor(options.maxGeneration!)
    : DEFAULT_RECOMMENDATION_MAX_GENERATION;
  const maxGeneration = Math.max(0, rawMaxGeneration);
  const considered = occurrences.filter(
    occurrence => occurrence.generation <= maxGeneration,
  );

  let minimumWorldFontSize = Number.POSITIVE_INFINITY;
  let limitingOccurrenceId: string | undefined;
  for (const occurrence of considered) {
    const plan = planCircularAncestorLabel(occurrence);
    const occurrenceMinimum = Math.min(plan.fontSize, plan.lifeFontSize);
    if (occurrenceMinimum < minimumWorldFontSize) {
      minimumWorldFontSize = occurrenceMinimum;
      limitingOccurrenceId = occurrence.occurrenceId;
    }
  }

  if (!considered.length || !Number.isFinite(minimumWorldFontSize)) {
    return {
      recommendedZoom: 1,
      recommendedScale: fitScale,
      fitScale,
      targetScreenFontSize,
      minimumWorldFontSize: 0,
      minimumScreenFontSizeAtFit: 0,
      consideredOccurrenceCount: 0,
      maxGeneration,
    };
  }

  const minimumScreenFontSizeAtFit = minimumWorldFontSize * fitScale;
  const recommendedZoom = minimumScreenFontSizeAtFit > 0
    ? Math.max(1, targetScreenFontSize / minimumScreenFontSizeAtFit)
    : 1;
  return {
    recommendedZoom,
    recommendedScale: fitScale * recommendedZoom,
    fitScale,
    targetScreenFontSize,
    minimumWorldFontSize,
    minimumScreenFontSizeAtFit,
    ...(limitingOccurrenceId ? { limitingOccurrenceId } : {}),
    consideredOccurrenceCount: considered.length,
    maxGeneration,
  };
}
