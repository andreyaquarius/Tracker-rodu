import { formatCircularAncestorLife, formatCircularAncestorName } from "../circular/circularAncestorChartLabels.ts";
import type { FanChartOccurrence } from "./fanChartLayout.ts";
import { fanChartSectorGapDegrees } from "./fanChartLayout.ts";

export type FanChartLabelMode = "visible" | "hidden";
export type FanChartLabelLineKind = "name" | "life";
export type FanChartLabelHiddenReason = "invalid-geometry";

export interface FanChartLabelLine {
  kind: FanChartLabelLineKind;
  /** Complete words only. A word is never shortened or split between lines. */
  text: string;
  /** SVG y coordinate before applying the plan's `glyphScale`. */
  y: number;
  /** SVG font size before applying the plan's `glyphScale`. */
  glyphFontSize: number;
}

export interface FanChartLabelPlan {
  mode: FanChartLabelMode;
  fullName: string;
  life: string;
  /** Complete textual fallback for `<title>` and the accessible list. */
  accessibleText: string;
  /** Midpoint geometry for a radial label group. */
  midAngle: number;
  midRadius: number;
  /** Upright SVG rotation, normalized to the readable -90..90 range. */
  rotation: number;
  /** Empty when mode is hidden; accessibleText still retains all content. */
  lines: readonly FanChartLabelLine[];
  /** Vector scale for the whole label group. */
  glyphScale: number;
  renderedNameFontSize: number;
  renderedLifeFontSize: number;
  availableRadialLength: number;
  availableTangentialSize: number;
  requiredRadialLength: number;
  requiredTangentialSize: number;
  hiddenReason?: FanChartLabelHiddenReason;
}

const NAME_GLYPH_FONT_SIZE = 11;
const LIFE_GLYPH_FONT_SIZE = 8;
const LINE_GAP = 2.2;
const MAX_NAME_LINES = 3;

interface Candidate {
  nameLines: readonly string[];
  fitScale: number;
  requiredRadialLength: number;
  requiredTangentialSize: number;
}

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

function normalizeSignedAngle(angle: number): number {
  return ((angle + 180) % 360 + 360) % 360 - 180;
}

/**
 * Radial text follows the sector centre line. Because fan-chart x coordinates
 * are mirrored, its visual outward angle is `180 - midAngle`. The result is
 * flipped by 180 degrees whenever necessary so names never render upside down.
 */
export function uprightFanChartLabelRotation(midAngle: number): number {
  let rotation = normalizeSignedAngle(180 - midAngle);
  if (rotation > 90) rotation -= 180;
  if (rotation < -90) rotation += 180;
  return Object.is(rotation, -0) ? 0 : rotation;
}

function balancedWordLines(
  words: readonly string[],
  requestedLineCount: number,
): readonly string[] {
  if (words.length === 0) return [];
  const lineCount = Math.min(
    Math.max(1, Math.floor(requestedLineCount)),
    words.length,
  );
  type Partition = { maximumWidth: number; lines: readonly string[] };
  const table: Array<Array<Partition | undefined>> = Array.from(
    { length: words.length + 1 },
    () => Array<Partition | undefined>(lineCount + 1).fill(undefined),
  );
  table[0]![0] = { maximumWidth: 0, lines: [] };

  for (let wordCount = 1; wordCount <= words.length; wordCount += 1) {
    for (
      let usedLines = 1;
      usedLines <= Math.min(lineCount, wordCount);
      usedLines += 1
    ) {
      for (let split = usedLines - 1; split < wordCount; split += 1) {
        const previous = table[split]?.[usedLines - 1];
        if (!previous) continue;
        const nextLine = words.slice(split, wordCount).join(" ");
        const maximumWidth = Math.max(
          previous.maximumWidth,
          estimatedTextUnits(nextLine),
        );
        const existing = table[wordCount]?.[usedLines];
        if (
          !existing ||
          maximumWidth < existing.maximumWidth - 1e-9 ||
          (
            Math.abs(maximumWidth - existing.maximumWidth) <= 1e-9 &&
            previous.lines.length < existing.lines.length
          )
        ) {
          table[wordCount]![usedLines] = {
            maximumWidth,
            lines: [...previous.lines, nextLine],
          };
        }
      }
    }
  }

  return table[words.length]?.[lineCount]?.lines ?? [words.join(" ")];
}

function evaluateCandidate(
  nameLines: readonly string[],
  life: string,
  availableRadialLength: number,
  availableTangentialSize: number,
): Candidate {
  const radialAtNominal = Math.max(
    ...nameLines.map(line => estimatedTextUnits(line) * NAME_GLYPH_FONT_SIZE),
    estimatedTextUnits(life) * LIFE_GLYPH_FONT_SIZE,
    1,
  );
  const lineHeights = [
    ...nameLines.map(() => NAME_GLYPH_FONT_SIZE),
    LIFE_GLYPH_FONT_SIZE,
  ];
  const tangentialAtNominal =
    lineHeights.reduce((sum, value) => sum + value, 0) +
    Math.max(0, lineHeights.length - 1) * LINE_GAP;
  const fitScale = Math.max(0, Math.min(
    1,
    availableRadialLength / radialAtNominal,
    availableTangentialSize / tangentialAtNominal,
  ));

  return {
    nameLines,
    fitScale,
    requiredRadialLength: radialAtNominal * fitScale,
    requiredTangentialSize: tangentialAtNominal * fitScale,
  };
}

function betterCandidate(left: Candidate | undefined, right: Candidate): Candidate {
  if (!left) return right;
  const leftFont = NAME_GLYPH_FONT_SIZE * left.fitScale;
  const rightFont = NAME_GLYPH_FONT_SIZE * right.fitScale;
  if (rightFont > leftFont + 1e-9) return right;
  if (leftFont > rightFont + 1e-9) return left;
  // If readability is identical, prefer fewer rows and therefore less visual
  // noise in broad sectors.
  return right.nameLines.length < left.nameLines.length ? right : left;
}

function linePlans(candidate: Candidate, life: string): readonly FanChartLabelLine[] {
  const source = [
    ...candidate.nameLines.map(text => ({
      kind: "name" as const,
      text,
      glyphFontSize: NAME_GLYPH_FONT_SIZE,
    })),
    {
      kind: "life" as const,
      text: life,
      glyphFontSize: LIFE_GLYPH_FONT_SIZE,
    },
  ];
  const totalHeight =
    source.reduce((sum, line) => sum + line.glyphFontSize, 0) +
    Math.max(0, source.length - 1) * LINE_GAP;
  let cursor = -totalHeight / 2;
  return source.map(line => {
    const y = cursor + line.glyphFontSize / 2;
    cursor += line.glyphFontSize + LINE_GAP;
    return { ...line, y };
  });
}

/**
 * Produces a viewport-independent label plan for one non-focus fan sector.
 *
 * Complete name words are balanced over at most three semantic rows and the
 * life row is always retained. Valid sectors always receive a visible plan:
 * glyphs are authored at stable sizes and the complete group is vector-scaled
 * to the available geometry. This mirrors the circular chart and avoids both
 * browser glyph corruption and content loss in generations 10-16. Only invalid
 * geometry is hidden; `accessibleText` still contains the same complete data.
 */
export function planFanChartSectorLabel(
  occurrence: FanChartOccurrence,
): FanChartLabelPlan {
  const fullName = formatCircularAncestorName(occurrence.person);
  const life = formatCircularAncestorLife(occurrence.person);
  const accessibleText = `${fullName}, ${life}`;
  const midAngle = (occurrence.startAngle + occurrence.endAngle) / 2;
  const midRadius = (occurrence.innerRadius + occurrence.outerRadius) / 2;
  const ringWidth = occurrence.outerRadius - occurrence.innerRadius;
  const sweep = Math.abs(occurrence.endAngle - occurrence.startAngle);
  const gap = fanChartSectorGapDegrees(
    occurrence.startAngle,
    occurrence.endAngle,
  );
  const visibleSweep = Math.max(0, sweep - gap * 2);
  const availableRadialLength = Math.max(0, ringWidth * 0.76);
  const availableTangentialSize = Math.max(
    0,
    midRadius * visibleSweep * Math.PI / 180 * 0.78,
  );
  const geometryIsValid = [
    occurrence.startAngle,
    occurrence.endAngle,
    occurrence.innerRadius,
    occurrence.outerRadius,
    midAngle,
    midRadius,
  ].every(Number.isFinite) &&
    ringWidth > 0 &&
    visibleSweep > 0 &&
    midRadius > 0;

  const hidden = (
    reason: FanChartLabelHiddenReason,
    candidate?: Candidate,
  ): FanChartLabelPlan => ({
    mode: "hidden",
    fullName,
    life,
    accessibleText,
    midAngle,
    midRadius,
    rotation: uprightFanChartLabelRotation(midAngle),
    lines: [],
    glyphScale: candidate?.fitScale ?? 0,
    renderedNameFontSize: candidate
      ? NAME_GLYPH_FONT_SIZE * candidate.fitScale
      : 0,
    renderedLifeFontSize: 0,
    availableRadialLength,
    availableTangentialSize,
    requiredRadialLength: candidate?.requiredRadialLength ?? 0,
    requiredTangentialSize: candidate?.requiredTangentialSize ?? 0,
    hiddenReason: reason,
  });

  if (!geometryIsValid) return hidden("invalid-geometry");

  const words = fullName.split(/\s+/u).filter(Boolean);
  let best: Candidate | undefined;
  const maximumLines = Math.min(MAX_NAME_LINES, Math.max(1, words.length));
  for (let lineCount = 1; lineCount <= maximumLines; lineCount += 1) {
    const nameLines = balancedWordLines(words, lineCount);
    best = betterCandidate(
      best,
      evaluateCandidate(
        nameLines,
        life,
        availableRadialLength,
        availableTangentialSize,
      ),
    );
  }

  // `words` always contains at least the normalized fallback name. Keep the
  // guard defensive, but classify it as invalid input rather than hiding a
  // geometrically valid, merely small sector.
  if (!best) return hidden("invalid-geometry");
  const selected = best;
  const renderedNameFontSize = NAME_GLYPH_FONT_SIZE * selected.fitScale;

  return {
    mode: "visible",
    fullName,
    life,
    accessibleText,
    midAngle,
    midRadius,
    rotation: uprightFanChartLabelRotation(midAngle),
    lines: linePlans(selected, life),
    glyphScale: selected.fitScale,
    renderedNameFontSize,
    renderedLifeFontSize: LIFE_GLYPH_FONT_SIZE * selected.fitScale,
    availableRadialLength,
    availableTangentialSize,
    requiredRadialLength: selected.requiredRadialLength,
    requiredTangentialSize: selected.requiredTangentialSize,
  };
}
