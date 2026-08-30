import type {
  ContextLegacyAmbiguousRelationTypeCode,
  ContextRelationCategory,
  ContextSpecificSocialRelationTypeCode,
} from "../../types/contextGraph.ts";

export interface SpecificSocialRelationDefinition {
  code: ContextSpecificSocialRelationTypeCode;
  label: string;
  sourceRoleLabel: string;
  targetRoleLabel: string;
}

const SPECIFIC_SOCIAL_RELATIONS: readonly SpecificSocialRelationDefinition[] = [
  {
    code: "godfather",
    label: "Хрещений батько",
    sourceRoleLabel: "Хрещений батько",
    targetRoleLabel: "Хрещеник або хрещениця",
  },
  {
    code: "godmother",
    label: "Хрещена мати",
    sourceRoleLabel: "Хрещена мати",
    targetRoleLabel: "Хрещеник або хрещениця",
  },
  {
    code: "sponsor_for_bride",
    label: "Поручитель по нареченій",
    sourceRoleLabel: "Поручитель по нареченій",
    targetRoleLabel: "Наречена",
  },
  {
    code: "sponsor_for_groom",
    label: "Поручитель по нареченому",
    sourceRoleLabel: "Поручитель по нареченому",
    targetRoleLabel: "Наречений",
  },
  {
    code: "witness_for_bride",
    label: "Свідок по нареченій",
    sourceRoleLabel: "Свідок по нареченій",
    targetRoleLabel: "Учасник шлюбу",
  },
  {
    code: "witness_for_groom",
    label: "Свідок по нареченому",
    sourceRoleLabel: "Свідок по нареченому",
    targetRoleLabel: "Учасник шлюбу",
  },
  {
    code: "event_witness",
    label: "Свідок при події",
    sourceRoleLabel: "Свідок при події",
    targetRoleLabel: "Учасник події",
  },
] as const;

const SPECIFIC_SOCIAL_RELATION_BY_CODE = new Map(
  SPECIFIC_SOCIAL_RELATIONS.map((definition) => [definition.code, definition]),
);

const LEGACY_AMBIGUOUS_CODES = new Set<ContextLegacyAmbiguousRelationTypeCode>([
  "godparent",
  "sponsor",
  "witness",
]);

export interface SocialCircleRelationSeed {
  relationId: string;
  personId: string;
  personLabel: string;
  relationLabel: string;
  category: ContextRelationCategory;
  isHypothesis?: boolean;
  isGenerated?: boolean;
}

export interface SocialCircleRadialNode {
  personId: string;
  personLabel: string;
  x: number;
  y: number;
  ringIndex: number;
  relationIds: string[];
  relationLabels: string[];
  category: ContextRelationCategory;
  hasHypothesis: boolean;
  hasGenerated: boolean;
}

export interface SocialCircleRadialLayout {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  centerRadius: number;
  nodeRadius: number;
  ringCount: number;
  nodes: SocialCircleRadialNode[];
}

export function isSpecificSocialRelationTypeCode(
  code: string,
): code is ContextSpecificSocialRelationTypeCode {
  return SPECIFIC_SOCIAL_RELATION_BY_CODE.has(code as ContextSpecificSocialRelationTypeCode);
}

export function isLegacyAmbiguousSocialRelationTypeCode(
  code: string,
): code is ContextLegacyAmbiguousRelationTypeCode {
  return LEGACY_AMBIGUOUS_CODES.has(code as ContextLegacyAmbiguousRelationTypeCode);
}

export function specificSocialRelationDefinition(
  code: string,
): SpecificSocialRelationDefinition | undefined {
  return SPECIFIC_SOCIAL_RELATION_BY_CODE.get(code as ContextSpecificSocialRelationTypeCode);
}

export function specificReplacementCodesForLegacyRole(
  code: string,
): readonly ContextSpecificSocialRelationTypeCode[] {
  if (code === "godparent") return ["godfather", "godmother"];
  if (code === "sponsor") return ["sponsor_for_bride", "sponsor_for_groom"];
  if (code === "witness") return ["witness_for_bride", "witness_for_groom"];
  return [];
}

/**
 * Returns the role of the person adjacent to the center of the social graph.
 * Relation rows store source and target roles, so the value must be chosen by
 * endpoint rather than by the center's perspective. This is particularly
 * important for "Хрещений батько" and wedding-side witnesses.
 */
export function relatedPersonSocialRoleLabel(input: {
  relationTypeCode: string;
  relatedIsSource: boolean;
  sourceRoleLabel?: string;
  targetRoleLabel?: string;
  fallbackSourceRoleLabel?: string;
  fallbackTargetRoleLabel?: string;
  fallbackRelationLabel?: string;
}): string {
  const {
    relationTypeCode,
    relatedIsSource,
    sourceRoleLabel = "",
    targetRoleLabel = "",
    fallbackSourceRoleLabel = "",
    fallbackTargetRoleLabel = "",
    fallbackRelationLabel = "Контекстний зв’язок",
  } = input;

  if (relationTypeCode === "godparent") {
    return relatedIsSource
      ? "Роль потребує уточнення: хрещений батько чи хрещена мати"
      : "Хрещена дитина · роль хрещеної особи потребує уточнення";
  }
  if (relationTypeCode === "witness") {
    return relatedIsSource
      ? "Сторона потребує уточнення: свідок по нареченій чи по нареченому"
      : "Учасник шлюбу · сторона свідка потребує уточнення";
  }
  if (relationTypeCode === "sponsor") {
    return relatedIsSource
      ? "Сторона потребує уточнення: поручитель по нареченій чи по нареченому"
      : "Учасник шлюбу · сторона поручителя потребує уточнення";
  }

  const definition = specificSocialRelationDefinition(relationTypeCode);
  if (relatedIsSource) {
    return sourceRoleLabel.trim()
      || definition?.sourceRoleLabel
      || fallbackSourceRoleLabel.trim()
      || fallbackRelationLabel;
  }
  return targetRoleLabel.trim()
    || definition?.targetRoleLabel
    || fallbackTargetRoleLabel.trim()
    || fallbackRelationLabel;
}

export function relationTypeEditorLabel(code: string, label: string): string {
  if (code === "godparent") return "Хрещений зв’язок — роль потребує уточнення";
  if (code === "sponsor") return "Шлюбний поручитель — сторона потребує уточнення";
  if (code === "witness") return "Весільний свідок — сторона потребує уточнення";
  // The foundation catalogue contains two distinct concepts with the same
  // historical label: `caregiver` (a person who provided day-to-day care) and
  // `guardian_non_parent` (a guardian without a parent-child relation). Keep
  // persisted catalogue rows unchanged, but disambiguate the former anywhere
  // the UI renders a relation-type selector.
  if (code === "caregiver") return "Доглядач";
  return specificSocialRelationDefinition(code)?.label ?? label;
}

/**
 * Builds a stable, depth-one layout without touching the genealogical graph.
 * People are sorted by their visible name and id, so the same data produces
 * the same SVG between renders, exports, and devices.
 */
export function buildSocialCircleRadialLayout(
  relations: readonly SocialCircleRelationSeed[],
  dimensions: { width?: number; height?: number } = {},
): SocialCircleRadialLayout {
  const grouped = new Map<string, SocialCircleRelationSeed[]>();

  relations.forEach((relation) => {
    const current = grouped.get(relation.personId) ?? [];
    current.push(relation);
    grouped.set(relation.personId, current);
  });

  const groups = [...grouped.entries()]
    .map(([personId, items]) => ({
      personId,
      items: [...items].sort((left, right) => stableCompare(left.relationId, right.relationId)),
      personLabel: items[0]?.personLabel.trim() || "Особа без імені",
    }))
    .sort((left, right) => {
      const byName = stableCompare(left.personLabel, right.personLabel);
      return byName || stableCompare(left.personId, right.personId);
    });

  const adaptive = adaptiveCanvas(groups.length);
  const width = finiteDimension(dimensions.width, adaptive.width);
  const height = finiteDimension(dimensions.height, adaptive.height);
  const centerX = width / 2;
  const centerY = height / 2;
  const nodeRadius = adaptive.nodeRadius;
  const centerRadius = groups.length > 50 ? 48 : groups.length > 24 ? 52 : 56;
  const outerRadius = Math.max(
    centerRadius + nodeRadius + 28,
    Math.min(width / 2 - nodeRadius - 28, height / 2 - nodeRadius - 30),
  );
  const ringGap = nodeRadius * 2 + (groups.length > 50 ? 26 : 30);
  const minimumRadius = centerRadius + nodeRadius + 28;
  const minimumArc = nodeRadius * 2 + 4;
  const rings = selectRings(groups.length, outerRadius, minimumRadius, ringGap, minimumArc);
  const ringSizes = distributeAcrossRings(groups.length, rings.map((radius) => ringCapacity(radius, minimumArc)));
  const nodes: SocialCircleRadialNode[] = [];
  let groupIndex = 0;

  rings.forEach((radius, ringIndex) => {
    const count = ringSizes[ringIndex] ?? 0;
    const startAngle = -Math.PI / 2 + (ringIndex % 2 === 0 || count <= 1 ? 0 : Math.PI / count);
    for (let slot = 0; slot < count; slot += 1) {
      const group = groups[groupIndex];
      groupIndex += 1;
      if (!group) break;
      const angle = count <= 1 ? startAngle : startAngle + (Math.PI * 2 * slot) / count;
      const relationLabels = unique(group.items.map((item) => item.relationLabel).filter(Boolean));
      nodes.push({
        personId: group.personId,
        personLabel: group.personLabel,
        x: round(centerX + Math.cos(angle) * radius),
        y: round(centerY + Math.sin(angle) * radius),
        ringIndex,
        relationIds: group.items.map((item) => item.relationId),
        relationLabels,
        category: group.items[0]?.category ?? "other",
        hasHypothesis: group.items.some((item) => item.isHypothesis),
        hasGenerated: group.items.some((item) => item.isGenerated),
      });
    }
  });

  return {
    width,
    height,
    centerX,
    centerY,
    centerRadius,
    nodeRadius,
    ringCount: rings.length,
    nodes,
  };
}

export function compactSocialCircleLabel(value: string, maximum = 24): string {
  const normalized = value.trim().replace(/\s+/g, " ") || "Особа без імені";
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function stableCompare(left: string, right: string): number {
  const normalizedLeft = left.trim().toLocaleLowerCase("uk-UA");
  const normalizedRight = right.trim().toLocaleLowerCase("uk-UA");
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function finiteDimension(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 240
    ? value
    : fallback;
}

function adaptiveCanvas(nodeCount: number): { width: number; height: number; nodeRadius: number } {
  if (nodeCount <= 10) return { width: 720, height: 520, nodeRadius: 43 };
  if (nodeCount <= 24) return { width: 860, height: 700, nodeRadius: 34 };
  if (nodeCount <= 50) return { width: 980, height: 800, nodeRadius: 28 };
  if (nodeCount <= 100) return { width: 1100, height: 920, nodeRadius: 22 };
  const side = Math.max(1100, Math.ceil(Math.sqrt(nodeCount)) * 105);
  return { width: side, height: Math.round(side * 0.84), nodeRadius: 18 };
}

function selectRings(
  nodeCount: number,
  outerRadius: number,
  minimumRadius: number,
  ringGap: number,
  minimumArc: number,
): number[] {
  if (nodeCount <= 0) return [];
  const selected: number[] = [];
  let capacity = 0;
  for (let radius = outerRadius; radius >= minimumRadius; radius -= ringGap) {
    selected.push(radius);
    capacity += ringCapacity(radius, minimumArc);
    if (capacity >= nodeCount) break;
  }
  // A custom small viewport may not offer another non-overlapping ring. Keep
  // all nodes deterministic in its innermost available ring instead of losing
  // nodes; normal v1 snapshots use the adaptive canvas and never need this.
  while (capacity < nodeCount) {
    const next = Math.max(minimumRadius, (selected.at(-1) ?? outerRadius) - ringGap);
    selected.push(next);
    capacity += ringCapacity(next, minimumArc);
  }
  return selected.reverse();
}

function ringCapacity(radius: number, minimumArc: number): number {
  return Math.max(1, Math.floor((Math.PI * 2 * radius) / minimumArc));
}

function distributeAcrossRings(nodeCount: number, capacities: readonly number[]): number[] {
  if (!capacities.length) return [];
  const totalCapacity = capacities.reduce((total, capacity) => total + capacity, 0);
  const allocation = capacities.map((capacity) => Math.min(
    capacity,
    Math.floor((nodeCount * capacity) / totalCapacity),
  ));
  let allocated = allocation.reduce((total, count) => total + count, 0);
  while (allocated < nodeCount) {
    let bestIndex = -1;
    let bestRemaining = -1;
    capacities.forEach((capacity, index) => {
      const remaining = capacity - (allocation[index] ?? 0);
      // Prefer outer rings on ties: they have the most visual breathing room.
      if (remaining >= bestRemaining && remaining > 0) {
        bestRemaining = remaining;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) break;
    allocation[bestIndex] = (allocation[bestIndex] ?? 0) + 1;
    allocated += 1;
  }
  return allocation;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
