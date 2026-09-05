import type { FamilyGraphData, LayoutBounds, ParentChildRelation, TreePerson } from "../types.ts";

export const MAX_CONSTELLATION_PERSONS = 1000;
export type ConstellationRole = "focus" | "ancestor" | "descendant" | "partner" | "relative";

export interface ConstellationNode {
  id: string;
  person: TreePerson;
  role: ConstellationRole;
  generation: number;
  distance: number;
  /** Only assigned from explicit father/mother roles, never inferred from sex. */
  ancestorSlot?: number;
  x: number;
  y: number;
}

export interface ConstellationEdge {
  id: string;
  source: string;
  target: string;
  kind: "parent" | "partner";
  unionId?: string;
  label: string;
  relationshipKind?: ParentChildRelation["kind"];
}

export interface ConstellationScene {
  focusId: string;
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  rings: number[];
  bounds: LayoutBounds;
  omittedCount: number;
  /** Shortest known connection within this bounded, permission-scoped graph. */
  paths: Record<string, { personIds: string[]; edgeIds: string[] }>;
}

const parentLabels: Record<ParentChildRelation["kind"], string> = {
  biological: "Біологічне батьківство", genetic_father: "Генетичний батько",
  genetic_mother: "Генетична мати", gestational_parent: "Гестаційне батьківство",
  birth_parent: "Батьківство при народженні", adoptive: "Усиновлення",
  foster: "Прийомне батьківство", step: "Вітчим / мачуха", guardian: "Опіка",
  social_parent: "Соціальне батьківство", legal_parent: "Юридичне батьківство",
  donor: "Донорство", surrogate: "Сурогатне материнство",
  presumed: "Імовірне батьківство", unknown: "Тип батьківства не вказано", other: "Інший батьківський зв’язок",
};

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A read-only projection. Parent sets never manufacture partnerships. */
export function buildConstellationScene(graph: FamilyGraphData, focusId: string): ConstellationScene {
  const people = new Map(graph.persons.map(person => [person.id, person]));
  const empty: ConstellationScene = {
    focusId, nodes: [], edges: [], rings: [], paths: Object.create(null),
    bounds: { left: -90, right: 90, top: -90, bottom: 90 }, omittedCount: people.size,
  };
  if (!people.has(focusId)) return empty;
  const parentRelations = [...graph.parentChildRelations]
    .filter(relation => relation.parentId !== relation.childId && people.has(relation.parentId) && people.has(relation.childId))
    .sort((a, b) => Number(b.isPreferred ?? false) - Number(a.isPreferred ?? false) || compare(a.id, b.id));
  const uniqueEdges = new Map<string, ConstellationEdge>();
  for (const relation of parentRelations) {
    uniqueEdges.set(`parent:${relation.id}`, {
      id: `parent:${relation.id}`, source: relation.parentId, target: relation.childId,
      kind: "parent", relationshipKind: relation.kind,
      label: parentLabels[relation.kind] ?? parentLabels.unknown,
    });
  }
  for (const union of [...graph.unions].sort((a, b) => compare(a.id, b.id))) {
    if (union.kind !== "partnership") continue;
    const members = [...new Set(union.memberIds)].filter(id => people.has(id)).sort(compare);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const source = members[i]!;
        const target = members[j]!;
        const id = `partner:${union.id}:${source}:${target}`;
        uniqueEdges.set(id, {
          id, source, target, kind: "partner", unionId: union.id,
          label: union.status === "divorced" ? "Розлучення" : union.status === "married" ? "Шлюб" : "Партнерство",
        });
      }
    }
  }
  const edges = [...uniqueEdges.values()].sort((a, b) => compare(a.id, b.id));
  const adjacency = new Map<string, { id: string; edge: ConstellationEdge; generationDelta: number }[]>();
  const parents = new Map<string, ParentChildRelation[]>();
  const children = new Map<string, ParentChildRelation[]>();
  for (const edge of edges) {
    for (const [id, next, delta] of [
      [edge.source, edge.target, edge.kind === "parent" ? 1 : 0],
      [edge.target, edge.source, edge.kind === "parent" ? -1 : 0],
    ] as const) {
      const list = adjacency.get(id) ?? [];
      list.push({ id: next, edge, generationDelta: delta });
      adjacency.set(id, list);
    }
  }
  for (const relation of parentRelations) {
    parents.set(relation.childId, [...(parents.get(relation.childId) ?? []), relation]);
    children.set(relation.parentId, [...(children.get(relation.parentId) ?? []), relation]);
  }
  // Explore at most the visible budget and retain one shortest path per person.
  const visited = new Map<string, { distance: number; generation: number; from?: string; edgeId?: string }>([
    [focusId, { distance: 0, generation: 0 }],
  ]);
  const queue = [focusId];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    const current = visited.get(id)!;
    for (const next of (adjacency.get(id) ?? []).sort((a, b) => compare(a.id, b.id) || compare(a.edge.id, b.edge.id))) {
      if (visited.has(next.id) || visited.size >= MAX_CONSTELLATION_PERSONS) continue;
      visited.set(next.id, { distance: current.distance + 1, generation: current.generation + next.generationDelta, from: id, edgeId: next.edge.id });
      queue.push(next.id);
    }
  }
  const ancestors = new Map<string, { depth: number; slot?: number }>([[focusId, { depth: 0, slot: 1 }]]);
  const ancestorQueue = [focusId];
  for (let index = 0; index < ancestorQueue.length; index++) {
    const childId = ancestorQueue[index]!;
    const current = ancestors.get(childId)!;
    const relations = [...(parents.get(childId) ?? [])].sort((a, b) => {
      const bit = (relation: ParentChildRelation) => parentBit(relation) ?? 2;
      return bit(a) - bit(b) || compare(a.id, b.id);
    });
    for (const relation of relations) {
      if (!visited.has(relation.parentId) || ancestors.has(relation.parentId)) continue;
      const bit = parentBit(relation);
      const slot = current.slot !== undefined && bit !== undefined && current.depth < 50 ? current.slot * 2 + bit : undefined;
      ancestors.set(relation.parentId, { depth: current.depth + 1, slot });
      ancestorQueue.push(relation.parentId);
    }
  }
  const descendants = new Map<string, number>([[focusId, 0]]);
  const descendantQueue = [focusId];
  for (let index = 0; index < descendantQueue.length; index++) {
    const id = descendantQueue[index]!;
    for (const relation of children.get(id) ?? []) {
      if (!visited.has(relation.childId) || descendants.has(relation.childId)) continue;
      descendants.set(relation.childId, descendants.get(id)! + 1);
      descendantQueue.push(relation.childId);
    }
  }
  const directPartners = new Set((adjacency.get(focusId) ?? []).filter(next => next.edge.kind === "partner").map(next => next.id));
  const nodes = queue.map((id): ConstellationNode => {
    const ancestor = ancestors.get(id);
    const descendant = descendants.get(id);
    const node = visited.get(id)!;
    const role: ConstellationRole = id === focusId ? "focus" : ancestor ? "ancestor" : descendant !== undefined ? "descendant" : directPartners.has(id) ? "partner" : "relative";
    return { id, person: people.get(id)!, role, generation: ancestor ? -ancestor.depth : descendant ?? node.generation,
      distance: node.distance, ancestorSlot: ancestor?.slot, x: 0, y: 0 };
  });
  const rings: number[] = [];
  // Disjoint angular sectors preserve reading direction; growing radii prevent
  // crowded generations from overlapping. Coordinates do not depend on viewport.
  const sectors: Record<Exclude<ConstellationRole, "focus">, [number, number]> = {
    ancestor: [Math.PI * 1.14, Math.PI * 1.87], descendant: [Math.PI * 0.18, Math.PI * 0.84],
    partner: [-Math.PI * 0.06, Math.PI * 0.06], relative: [Math.PI * 0.92, Math.PI * 1.06],
  };
  const layers = new Map<number, ConstellationNode[]>();
  for (const node of nodes) {
    if (node.distance) layers.set(node.distance, [...(layers.get(node.distance) ?? []), node]);
  }
  let previousRadius = 0;
  for (const [, layer] of [...layers].sort((a, b) => a[0] - b[0])) {
    let radius = previousRadius + 240;
    const groups = Object.entries(sectors).map(([role, sector]) => {
      const members = layer.filter(node => node.role === role).sort((a, b) => (
        (a.ancestorSlot ?? Number.MAX_SAFE_INTEGER) - (b.ancestorSlot ?? Number.MAX_SAFE_INTEGER)
        || compare(a.person.displayName, b.person.displayName) || compare(a.id, b.id)
      ));
      if (members.length > 1) radius = Math.max(radius, 190 / (2 * Math.sin((sector[1] - sector[0]) / (members.length - 1) / 2)));
      return { members, sector };
    });
    rings.push(radius);
    previousRadius = radius;
    for (const { members, sector } of groups) {
      members.forEach((node, index) => {
        const angle = members.length === 1 ? (sector[0] + sector[1]) / 2 : sector[0] + index / (members.length - 1) * (sector[1] - sector[0]);
        node.x = Math.round(Math.cos(angle) * radius * 100) / 100;
        node.y = Math.round(Math.sin(angle) * radius * 100) / 100;
      });
    }
  }
  const paths: ConstellationScene["paths"] = Object.create(null);
  for (const id of queue) {
    const personIds = [id];
    const edgeIds: string[] = [];
    let current = visited.get(id)!;
    while (current.from && current.edgeId) {
      personIds.push(current.from);
      edgeIds.push(current.edgeId);
      current = visited.get(current.from)!;
    }
    paths[id] = { personIds: personIds.reverse(), edgeIds: edgeIds.reverse() };
  }
  return { focusId, nodes, edges: edges.filter(edge => visited.has(edge.source) && visited.has(edge.target)), rings, paths,
    omittedCount: people.size - nodes.length,
    bounds: { left: Math.min(...nodes.map(node => node.x)) - 100, right: Math.max(...nodes.map(node => node.x)) + 100,
      top: Math.min(...nodes.map(node => node.y)) - 65, bottom: Math.max(...nodes.map(node => node.y)) + 90 } };
}

function parentBit(relation: ParentChildRelation): 0 | 1 | undefined {
  if (["father", "adoptive_father", "stepfather"].includes(relation.role ?? "")) return 0;
  if (["mother", "adoptive_mother", "stepmother"].includes(relation.role ?? "")) return 1;
  return undefined;
}

export function constellationLife(person: TreePerson): string {
  const birth = person.birth?.display || person.birth?.sort;
  const death = person.death?.display || person.death?.sort;
  return [birth && `нар. ${birth}`, death && `пом. ${death}`].filter(Boolean).join(" · ");
}
