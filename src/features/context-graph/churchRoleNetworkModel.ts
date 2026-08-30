import type {
  ChurchRoleNetworkRolePreset,
  PersonChurchRoleNetworkFilters,
  PersonChurchRoleNetworkItem,
  PersonChurchRoleNetworkPage,
} from "../../types/contextGraph.ts";
import type {
  ContextRelationshipGraphEdge,
  ContextRelationshipGraphNode,
} from "./contextRelationshipGraphModel.ts";

export interface ChurchRoleNetworkFilterDraft {
  preset: ChurchRoleNetworkRolePreset;
  yearFrom: string;
  yearTo: string;
  minOccurrences: string;
}

export interface ChurchRolePresetOption {
  value: ChurchRoleNetworkRolePreset;
  label: string;
  roleCodes: readonly string[];
}

export const CHURCH_ROLE_PRESET_OPTIONS: readonly ChurchRolePresetOption[] = [
  {
    value: "godparents-sponsors",
    label: "Хрещені та поручителі",
    roleCodes: [
      "godfather", "godmother", "godparent",
      "sponsor_for_bride", "sponsor_for_groom", "sponsor",
    ],
  },
  {
    value: "godparents",
    label: "Лише хрещені",
    roleCodes: ["godfather", "godmother", "godparent"],
  },
  {
    value: "sponsors",
    label: "Лише поручителі",
    roleCodes: ["sponsor_for_bride", "sponsor_for_groom", "sponsor"],
  },
  {
    value: "witnesses",
    label: "Весільні свідки",
    roleCodes: ["witness_for_bride", "witness_for_groom"],
  },
  {
    value: "all-ritual",
    label: "Усі ритуальні ролі",
    roleCodes: [
      "godfather", "godmother", "godparent",
      "sponsor_for_bride", "sponsor_for_groom", "sponsor",
      "witness_for_bride", "witness_for_groom",
    ],
  },
] as const;

const PRESET_BY_VALUE = new Map(
  CHURCH_ROLE_PRESET_OPTIONS.map((option) => [option.value, option]),
);

export interface ChurchRoleRadialNode {
  key: string;
  label: string;
  occurrenceCount: number;
  x: number;
  y: number;
  radius: number;
  item: PersonChurchRoleNetworkItem;
}

export interface ChurchRoleRadialLayout {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  centerRadius: number;
  nodes: ChurchRoleRadialNode[];
}

export interface ChurchRoleRelationshipGraph {
  centerNode: ContextRelationshipGraphNode;
  nodes: ContextRelationshipGraphNode[];
  edges: ContextRelationshipGraphEdge[];
  groupKeyByNodeId: Readonly<Record<string, string>>;
  groupKeyByEdgeId: Readonly<Record<string, string>>;
  personIdByNodeId: Readonly<Record<string, string>>;
  omittedGroupCount: number;
  omittedSampleCount: number;
}

export interface ChurchRoleRelationshipGraphLimits {
  maxNodes?: number;
  maxEdges?: number;
}

export const CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS = {
  maxNodes: 250,
  maxEdges: 500,
} as const;

/**
 * Builds a person-centred preview from the bounded surname-cluster projection.
 * Group edges carry aggregate counts, while person edges are exact RPC samples
 * (at most five per counterpart group) and must never be presented as complete.
 */
export function buildChurchRoleRelationshipGraph(
  page: PersonChurchRoleNetworkPage,
  center: { id: string; label: string },
  limits: ChurchRoleRelationshipGraphLimits = CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS,
): ChurchRoleRelationshipGraph {
  const maxNodes = boundedChurchGraphLimit(
    limits.maxNodes,
    CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS.maxNodes,
    1,
    CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS.maxNodes,
  );
  const maxEdges = boundedChurchGraphLimit(
    limits.maxEdges,
    CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS.maxEdges,
    0,
    CHURCH_ROLE_RELATIONSHIP_GRAPH_LIMITS.maxEdges,
  );
  const centerNodeId = personNodeId(center.id);
  const centerNode: ContextRelationshipGraphNode = {
    id: centerNodeId,
    label: center.label,
    kind: "person",
    subtitle: "центральна особа",
    description: "Граф показує зв’язки навколо цієї особи та її прізвищевої групи.",
    color: "#173f38",
  };
  const nodes = new Map<string, ContextRelationshipGraphNode>([[centerNodeId, centerNode]]);
  const edges = new Map<string, ContextRelationshipGraphEdge>();
  const groupKeyByNodeId: Record<string, string> = {};
  const groupKeyByEdgeId: Record<string, string> = {};
  const personIdByNodeId: Record<string, string> = { [centerNodeId]: center.id };
  const centerGroup = page.centerGroup;
  let omittedGroupCount = 0;
  let omittedSampleCount = 0;
  const result = (): ChurchRoleRelationshipGraph => ({
    centerNode,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    groupKeyByNodeId,
    groupKeyByEdgeId,
    personIdByNodeId,
    omittedGroupCount,
    omittedSampleCount,
  });

  if (!centerGroup) {
    omittedGroupCount = page.items.length;
    omittedSampleCount = page.items.reduce((count, item) => count + item.samples.length, 0);
    return result();
  }

  const centerGroupNode = groupNode(centerGroup.key, centerGroup.label, centerGroup.memberCount, true);
  const centerMembershipId = membershipEdgeId(center.id, centerGroup.key);
  if (nodes.size + 1 > maxNodes || edges.size + 1 > maxEdges) {
    omittedGroupCount = page.items.length;
    omittedSampleCount = page.items.reduce((count, item) => count + item.samples.length, 0);
    return result();
  }
  nodes.set(centerGroupNode.id, centerGroupNode);
  groupKeyByNodeId[centerGroupNode.id] = centerGroup.key;
  edges.set(
    centerMembershipId,
    membershipEdge(centerNodeId, centerGroupNode.id, centerMembershipId),
  );
  groupKeyByEdgeId[centerMembershipId] = centerGroup.key;

  for (const item of page.items) {
    const centerGroupNodeId = centerGroupNode.id;
    const counterpartNode = groupNode(
      item.counterpartGroup.key,
      item.counterpartGroup.label,
      item.counterpartGroup.memberCount,
      false,
    );
    const aggregateId = `group-link:${centerGroup.key}:${item.counterpartGroup.key}`;
    const aggregateEdge: ContextRelationshipGraphEdge | null = counterpartNode.id !== centerGroupNodeId
      ? {
        id: aggregateId,
        sourceId: centerGroupNodeId,
        targetId: counterpartNode.id,
        label: `${churchRoleOccurrenceLabel(item.occurrenceCount)} між прізвищами`,
        description: [
          churchRoleOccurrenceLabel(item.occurrenceCount),
          `${item.personPairCount} пар людей`,
          churchRolePeriodLabel(item),
          "Групування за прізвищем — дослідницька підказка, не доказ споріднення.",
        ].join(" · "),
        directed: false,
      }
      : null;
    const samples = item.samples.slice(0, 5);
    const representativeSample = samples[0];
    const newGroupNodeIds = new Set<string>();
    const newGroupEdgeIds = new Set<string>();
    if (!nodes.has(counterpartNode.id)) newGroupNodeIds.add(counterpartNode.id);
    if (aggregateEdge && !edges.has(aggregateId)) newGroupEdgeIds.add(aggregateId);
    if (representativeSample) {
      const sourceGroup = representativeSample.direction === "outgoing"
        ? centerGroup
        : item.counterpartGroup;
      const targetGroup = representativeSample.direction === "outgoing"
        ? item.counterpartGroup
        : centerGroup;
      const sourcePersonNodeId = personNodeId(representativeSample.sourcePersonId);
      const targetPersonNodeId = personNodeId(representativeSample.targetPersonId);
      if (!nodes.has(sourcePersonNodeId)) newGroupNodeIds.add(sourcePersonNodeId);
      if (!nodes.has(targetPersonNodeId)) newGroupNodeIds.add(targetPersonNodeId);
      const representativeEdgeIds = [
        membershipEdgeId(representativeSample.sourcePersonId, sourceGroup.key),
        membershipEdgeId(representativeSample.targetPersonId, targetGroup.key),
        `relation:${representativeSample.relationId}`,
      ];
      representativeEdgeIds.forEach((edgeId) => {
        if (!edges.has(edgeId)) newGroupEdgeIds.add(edgeId);
      });
    }
    if (
      nodes.size + newGroupNodeIds.size > maxNodes
      || edges.size + newGroupEdgeIds.size > maxEdges
    ) {
      omittedGroupCount += 1;
      omittedSampleCount += item.samples.length;
      continue;
    }

    nodes.set(counterpartNode.id, counterpartNode);
    groupKeyByNodeId[counterpartNode.id] = item.counterpartGroup.key;
    if (aggregateEdge) {
      edges.set(aggregateId, aggregateEdge);
      groupKeyByEdgeId[aggregateId] = item.counterpartGroup.key;
    }

    omittedSampleCount += Math.max(0, item.samples.length - samples.length);
    for (const sample of samples) {
      const sourceNodeKey = personNodeId(sample.sourcePersonId);
      const targetNodeKey = personNodeId(sample.targetPersonId);
      const sourceGroup = sample.direction === "outgoing" ? centerGroup : item.counterpartGroup;
      const targetGroup = sample.direction === "outgoing" ? item.counterpartGroup : centerGroup;
      const sourceMembershipId = membershipEdgeId(sample.sourcePersonId, sourceGroup.key);
      const targetMembershipId = membershipEdgeId(sample.targetPersonId, targetGroup.key);
      const roleEdgeId = `relation:${sample.relationId}`;
      const newNodeIds = new Set(
        [sourceNodeKey, targetNodeKey].filter((nodeId) => !nodes.has(nodeId)),
      );
      const newEdgeIds = new Set(
        [sourceMembershipId, targetMembershipId, roleEdgeId]
          .filter((edgeId) => !edges.has(edgeId)),
      );
      if (
        nodes.size + newNodeIds.size > maxNodes
        || edges.size + newEdgeIds.size > maxEdges
      ) {
        omittedSampleCount += 1;
        continue;
      }

      const sourceNodeId = addSamplePerson(
        nodes,
        personIdByNodeId,
        sample.sourcePersonId,
        sample.sourceDisplayName,
        center,
      );
      const targetNodeId = addSamplePerson(
        nodes,
        personIdByNodeId,
        sample.targetPersonId,
        sample.targetDisplayName,
        center,
      );
      addMembershipEdge(edges, groupKeyByEdgeId, sourceNodeId, sample.sourcePersonId, sourceGroup.key);
      addMembershipEdge(edges, groupKeyByEdgeId, targetNodeId, sample.targetPersonId, targetGroup.key);

      edges.set(roleEdgeId, {
        id: roleEdgeId,
        sourceId: sourceNodeId,
        targetId: targetNodeId,
        label: sample.roleLabel,
        description: [
          sample.year ? String(sample.year) : "Рік не встановлено",
          `${sample.evidenceCount} підстав`,
          `${sample.confidence}% впевненості`,
          "Точний репрезентативний приклад із серверної вибірки.",
        ].join(" · "),
        directed: true,
      });
      groupKeyByEdgeId[roleEdgeId] = item.counterpartGroup.key;
    }
  }

  return result();
}

export function defaultChurchRoleNetworkFilterDraft(): ChurchRoleNetworkFilterDraft {
  return {
    preset: "godparents-sponsors",
    yearFrom: "",
    yearTo: "",
    minOccurrences: "2",
  };
}

export function parseChurchRoleNetworkFilterDraft(
  draft: ChurchRoleNetworkFilterDraft,
): PersonChurchRoleNetworkFilters {
  const preset = PRESET_BY_VALUE.get(draft.preset);
  if (!preset) throw new Error("Оберіть підтримуваний набір ролей.");
  const yearFrom = optionalYear(draft.yearFrom, "початковий рік");
  const yearTo = optionalYear(draft.yearTo, "кінцевий рік");
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    throw new Error("Початковий рік не може бути пізнішим за кінцевий.");
  }
  const minOccurrences = Number(draft.minOccurrences);
  if (!Number.isInteger(minOccurrences) || minOccurrences < 1 || minOccurrences > 1000) {
    throw new Error("Мінімум повторень має бути цілим числом від 1 до 1000.");
  }
  return {
    roleCodes: [...preset.roleCodes],
    yearFrom,
    yearTo,
    minOccurrences,
    limit: 20,
    offset: 0,
  };
}

export function churchRolePeriodLabel(
  value: Pick<PersonChurchRoleNetworkItem, "firstYear" | "lastYear">,
): string {
  if (value.firstYear && value.lastYear) {
    return value.firstYear === value.lastYear
      ? String(value.firstYear)
      : `${value.firstYear}–${value.lastYear}`;
  }
  if (value.firstYear) return `від ${value.firstYear}`;
  if (value.lastYear) return `до ${value.lastYear}`;
  return "Рік не встановлено";
}

export function churchRoleOccurrenceLabel(count: number): string {
  const normalized = Math.max(0, Math.round(count));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;
  if (mod10 === 1 && mod100 !== 11) return `${normalized} згадка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${normalized} згадки`;
  }
  return `${normalized} згадок`;
}

export function churchRoleSummary(item: PersonChurchRoleNetworkItem, maximum = 3): string {
  const labels = item.roleCounts
    .filter((role) => role.count > 0)
    .slice(0, maximum)
    .map((role) => `${role.label}: ${role.count}`);
  return labels.length ? labels.join(" · ") : "Роль не уточнено";
}

export function compactChurchRoleLabel(value: string, maximum = 22): string {
  const normalized = value.trim().replace(/\s+/gu, " ") || "Кластер без назви";
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function buildChurchRoleRadialLayout(
  items: readonly PersonChurchRoleNetworkItem[],
): ChurchRoleRadialLayout {
  const sorted = [...items].sort((left, right) => (
    right.occurrenceCount - left.occurrenceCount
    || stableCompare(left.counterpartGroup.label, right.counterpartGroup.label)
    || stableCompare(left.counterpartGroup.key, right.counterpartGroup.key)
  ));
  const capacities: number[] = [];
  let capacity = 0;
  for (let ring = 0; capacity < sorted.length; ring += 1) {
    const ringCapacity = 8 + ring * 4;
    capacities.push(ringCapacity);
    capacity += ringCapacity;
  }
  const outerRadius = sorted.length ? 158 + Math.max(0, capacities.length - 1) * 104 : 158;
  const width = Math.max(720, outerRadius * 2 + 190);
  const height = Math.max(520, outerRadius * 2 + 150);
  const centerX = width / 2;
  const centerY = height / 2;
  const centerRadius = sorted.length > 20 ? 54 : 62;
  const nodeRadius = sorted.length > 32 ? 34 : sorted.length > 16 ? 40 : 46;
  const nodes: ChurchRoleRadialNode[] = [];
  let index = 0;

  capacities.forEach((ringCapacity, ringIndex) => {
    const remaining = sorted.length - index;
    const count = Math.min(ringCapacity, remaining);
    if (count <= 0) return;
    const radius = 158 + ringIndex * 104;
    const offset = ringIndex % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / count;
    for (let slot = 0; slot < count; slot += 1) {
      const item = sorted[index];
      index += 1;
      if (!item) break;
      const angle = offset + (Math.PI * 2 * slot) / count;
      nodes.push({
        key: item.counterpartGroup.key,
        label: item.counterpartGroup.label,
        occurrenceCount: item.occurrenceCount,
        x: round(centerX + Math.cos(angle) * radius),
        y: round(centerY + Math.sin(angle) * radius),
        radius: nodeRadius,
        item,
      });
    }
  });

  return { width, height, centerX, centerY, centerRadius, nodes };
}

export function mergeChurchRoleNetworkPages(
  current: PersonChurchRoleNetworkPage,
  next: PersonChurchRoleNetworkPage,
): PersonChurchRoleNetworkPage {
  if (current.centerPersonId !== next.centerPersonId) return next;
  const items = new Map(current.items.map((item) => [item.counterpartGroup.key, item]));
  const before = items.size;
  next.items.forEach((item) => {
    if (!items.has(item.counterpartGroup.key)) items.set(item.counterpartGroup.key, item);
  });
  const madeProgress = items.size > before;
  const capReasons = [...new Set([...current.capReasons, ...next.capReasons])]
    .filter((reason) => reason !== "pagination");
  if (madeProgress && next.capReasons.includes("pagination")) {
    capReasons.push("pagination");
  }
  return {
    ...next,
    centerGroup: next.centerGroup ?? current.centerGroup,
    items: [...items.values()],
    total: Math.max(current.total, next.total),
    truncated: next.truncated && madeProgress,
    capReasons,
    sameGroupOccurrenceCount: Math.max(
      current.sameGroupOccurrenceCount,
      next.sameGroupOccurrenceCount,
    ),
    omittedWithoutSurnameCount: Math.max(
      current.omittedWithoutSurnameCount,
      next.omittedWithoutSurnameCount,
    ),
  };
}

export function churchRoleCapReasonLabel(reason: string): string {
  const labels: Readonly<Record<string, string>> = {
    center_without_surname: "У центральної особи не вказано прізвище.",
    center_people: "Для центрального прізвища враховано не більше 500 видимих осіб.",
    relations: "Перевірено не більше 10 000 доступних соціальних зв’язків.",
    evidence_per_relation: "Для кожного зв’язку враховано не більше 50 підтверджувальних записів.",
    occurrences: "Оброблено не більше 20 000 конкретних згадок.",
    pagination: "Результати завантажуються окремими сторінками.",
    relation_scan_cap: "Перевірено лише безпечну обмежену кількість зв’язків.",
    group_cap: "Частину кластерів не показано через безпечний ліміт.",
    source_cap: "Для частини зв’язків показано лише приклади джерел.",
  };
  return labels[reason] ?? "Розрахунок частково обмежено безпечним лімітом.";
}

export function churchRoleProblemCapReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)]
    .filter((reason) => reason !== "center_without_surname" && reason !== "pagination");
}

function personNodeId(personId: string): string {
  return `person:${personId}`;
}

function groupNodeId(groupKey: string): string {
  return `group:${groupKey}`;
}

function membershipEdgeId(personId: string, groupKey: string): string {
  return `surname-membership:${personId}:${groupKey}`;
}

function groupNode(
  key: string,
  label: string,
  memberCount: number,
  centerGroup: boolean,
): ContextRelationshipGraphNode {
  return {
    id: groupNodeId(key),
    label,
    kind: "group",
    subtitle: `${memberCount} осіб у видимій вибірці`,
    description: centerGroup
      ? "Прізвищевий кластер центральної особи. Це технічне групування, не встановлений рід."
      : "Пов’язана прізвищева група. Це дослідницька підказка, не доказ споріднення.",
    color: centerGroup ? "#a87418" : "#c49a3a",
  };
}

function addSamplePerson(
  nodes: Map<string, ContextRelationshipGraphNode>,
  personIdByNodeId: Record<string, string>,
  personId: string,
  displayName: string,
  center: { id: string; label: string },
): string {
  const nodeId = personNodeId(personId);
  if (!nodes.has(nodeId)) {
    nodes.set(nodeId, {
      id: nodeId,
      label: personId === center.id ? center.label : displayName,
      kind: "person",
      subtitle: personId === center.id ? "центральна особа" : "точний приклад із запису",
      description: personId === center.id
        ? "Центральна особа графа."
        : "Одна з не більш як п’яти конкретних осіб, повернутих для цієї прізвищевої групи.",
      color: personId === center.id ? "#173f38" : "#477b70",
    });
  }
  personIdByNodeId[nodeId] = personId;
  return nodeId;
}

function addMembershipEdge(
  edges: Map<string, ContextRelationshipGraphEdge>,
  groupKeyByEdgeId: Record<string, string>,
  personNode: string,
  personId: string,
  groupKey: string,
) {
  const id = membershipEdgeId(personId, groupKey);
  if (!edges.has(id)) {
    edges.set(id, membershipEdge(personNode, groupNodeId(groupKey), id));
  }
  groupKeyByEdgeId[id] = groupKey;
}

function membershipEdge(
  personNode: string,
  groupNode: string,
  id: string,
): ContextRelationshipGraphEdge {
  return {
    id,
    sourceId: personNode,
    targetId: groupNode,
    label: "згруповано за прізвищем",
    description: "Технічне групування за прізвищем, не родинний зв’язок.",
    directed: false,
    labelVisibility: "details-only",
    lineStyle: "dashed",
  };
}

function boundedChurchGraphLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function optionalYear(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 9999) {
    throw new Error(`Вкажіть коректний ${label} від 1 до 9999.`);
  }
  return parsed;
}

function stableCompare(left: string, right: string): number {
  return left.trim().localeCompare(right.trim(), "uk", { sensitivity: "base" });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
