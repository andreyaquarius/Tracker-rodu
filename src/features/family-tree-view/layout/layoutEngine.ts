import type {
  FamilyTreeLayoutInput,
  GenerationBand,
  LayoutBounds,
  LayoutEdge,
  LayoutEdgeKind,
  LayoutNode,
  LayoutPoint,
  LayoutResult,
  LayoutUnion,
  ParentChildRelation,
  ParentRelationshipKind,
  PersonId,
  PreviousNodePosition,
  TreePerson,
} from "../types.ts";
import {
  buildGraphIndex,
  compareCodePoints,
  comparePeopleByBirth,
  compareRelations,
  parentRoleOrder,
} from "./graphIndex.ts";
import {
  buildOccurrenceScene,
  type OccurrenceScene,
  type SceneNode,
  type SceneUnion,
} from "./occurrenceScene.ts";
import { layoutDirectAncestors } from "./directAncestorLayout.ts";
import { packLayer } from "./pavaPacking.ts";

interface Bundle {
  id: string;
  generation: number;
  nodes: SceneNode[];
  nodeCenterOffsets: Map<string, number>;
  width: number;
  orderKey: string;
  ancestorSectorStartPath: readonly number[];
  ancestorSectorEndPath: readonly number[];
  x: number;
}

interface LayoutSettings {
  horizontalGap: number;
  branchGapStep: number;
  partnerGap: number;
  generationGap: number;
  previousPositions: ReadonlyMap<string, PreviousNodePosition>;
  primaryLineagePersonIds: ReadonlySet<PersonId>;
  lineageTargetPersonId: PersonId;
  lineageGroupDepth: 0 | 1 | 2 | 3;
  gapCache: Map<string, number>;
}

export type LayoutEngineMode = "family-graph" | "descendant-forest";

interface StructuralFamilyBlock {
  id: string;
  generation: number;
  orderKey: string;
  memberOccurrenceIds: string[];
  childOccurrenceIds: string[];
  unions: SceneUnion[];
}

function structuralMemberOccurrenceIds(union: SceneUnion): string[] {
  return [...new Set(union.memberOccurrenceIds)]
    .filter(
      occurrenceId =>
        !occurrenceId.startsWith("placeholder:") &&
        !occurrenceId.startsWith("continuation:"),
    )
    .sort(compareCodePoints);
}

function displayPartnershipPriority(union: SceneUnion): number {
  if (union.kind !== "partnership") return Number.POSITIVE_INFINITY;
  if (
    union.status === "active" ||
    union.status === "current" ||
    union.status === "married"
  ) {
    return 0;
  }
  if (!union.status || union.status === "unknown") return 1;
  if (union.status === "separated" || union.status === "divorced") return 2;
  return 3;
}

function preferredDisplayPartnership(
  unions: readonly SceneUnion[],
): SceneUnion | undefined {
  return unions
    .filter(union => union.kind === "partnership")
    .sort(
      (left, right) =>
        displayPartnershipPriority(left) - displayPartnershipPriority(right) ||
        compareCodePoints(left.orderKey, right.orderKey) ||
        compareCodePoints(left.occurrenceId, right.occurrenceId),
    )[0];
}

/**
 * The domain stores one ParentSet per child, while a family-view renderer
 * needs one visual junction for an explicit partnership and its children.
 * Parent-set records are frequently stored per child. Records with the same
 * two-or-more visible parents therefore form one visual family even when the
 * import did not repeat a partnership id. Duplicate partnership records are
 * also one visual couple. We retain every domain union in the block, but route
 * exactly one partner line, one family stem and one shared children bus.
 * The same applies when only one parent is currently known: all visible
 * children of that occurrence use one parent-to-children bus instead of one
 * long horizontal route per database row. Empty parent sets remain separate.
 * Occurrence IDs keep pedigree-collapse branches distinct even when their
 * canonical person IDs match.
 */
function structuralFamilyBlocks(
  unions: readonly SceneUnion[],
): StructuralFamilyBlock[] {
  const ordered = [...unions].sort(
    (a, b) =>
      b.generation - a.generation ||
      compareCodePoints(a.orderKey, b.orderKey) ||
      compareCodePoints(a.occurrenceId, b.occurrenceId),
  );
  const visiblePairSignaturesByGroup = new Map<string, Map<string, string[]>>();
  for (const union of ordered) {
    if (!union.familyGroupId) continue;
    const memberOccurrenceIds = structuralMemberOccurrenceIds(union);
    if (memberOccurrenceIds.length < 2) continue;
    const groupKey = `${union.generation}\u001f${union.familyGroupId}`;
    const signature = JSON.stringify([
      union.generation,
      ["members", ...memberOccurrenceIds],
    ]);
    const signatures = visiblePairSignaturesByGroup.get(groupKey) ?? new Map();
    signatures.set(signature, memberOccurrenceIds);
    visiblePairSignaturesByGroup.set(groupKey, signatures);
  }
  const signatureFor = (union: SceneUnion): string => {
    const memberOccurrenceIds = structuralMemberOccurrenceIds(union);
    const exactMemberSignature = JSON.stringify([
      union.generation,
      ["members", ...memberOccurrenceIds],
    ]);
    // Two visible parents are the authoritative visual identity. Imported
    // records can carry a persisted UUID on the partnership and a derived
    // parents:* scope on child parent sets; those still form one visual family.
    if (memberOccurrenceIds.length >= 2) return exactMemberSignature;

    if (union.familyGroupId) {
      // A single visible parent-set may still belong to one explicit couple.
      // Reuse that pair only when the group identifies exactly one compatible
      // pair. This preserves incomplete records without letting a leaked group
      // merge A+B with A+C.
      const groupKey = `${union.generation}\u001f${union.familyGroupId}`;
      const compatiblePairs = [
        ...(visiblePairSignaturesByGroup.get(groupKey)?.entries() ?? []),
      ].filter(([, pairMembers]) =>
        memberOccurrenceIds.every(memberId => pairMembers.includes(memberId)),
      );
      if (compatiblePairs.length === 1) return compatiblePairs[0]![0];
      if (compatiblePairs.length > 1) {
        return JSON.stringify([
          union.generation,
          ["family-group", union.familyGroupId, ...memberOccurrenceIds],
        ]);
      }
      // At sparse/high generations imports often assign a different
      // technical familyGroupId to every per-child ParentSet even though only
      // one canonical parent is known and no distinct partner pair is
      // visible. In that case the group id is not visual evidence of separate
      // families: merge by the sole visible parent occurrence so the children
      // use one shared bus. Once different partners are actually visible,
      // their pair signatures above keep the families separate.
      return exactMemberSignature;
    }
    return exactMemberSignature;
  };
  const unionsBySignature = new Map<string, SceneUnion[]>();
  for (const union of ordered) {
    const signature = signatureFor(union);
    const matches = unionsBySignature.get(signature);
    if (matches) matches.push(union);
    else unionsBySignature.set(signature, [union]);
  }

  const blocks: StructuralFamilyBlock[] = [];
  const singleton = (union: SceneUnion): StructuralFamilyBlock => {
    const memberOccurrenceIds = structuralMemberOccurrenceIds(union);
    return {
      id: union.occurrenceId,
      generation: union.generation,
      orderKey: union.orderKey,
      memberOccurrenceIds,
      childOccurrenceIds: [...new Set(union.childOccurrenceIds)],
      unions: [union],
    };
  };

  for (const group of unionsBySignature.values()) {
    const partnerships = group.filter(union => union.kind === "partnership");
    const parentSets = group.filter(union => union.kind === "parent-set");
    const memberCount = new Set(
      group.flatMap(union => structuralMemberOccurrenceIds(union)),
    ).size;
    const mergeAsOneFamily = partnerships.length > 0 || memberCount >= 1;
    if (!mergeAsOneFamily) {
      for (const union of group) blocks.push(singleton(union));
      continue;
    }

    const anchor = preferredDisplayPartnership(partnerships) ?? parentSets[0];
    if (!anchor) continue;
    const block = singleton(anchor);
    block.unions = [
      ...partnerships,
      ...parentSets,
    ].sort(
      (left, right) =>
        compareCodePoints(left.orderKey, right.orderKey) ||
        compareCodePoints(left.occurrenceId, right.occurrenceId),
    );
    block.memberOccurrenceIds = [
      ...new Set(
        group.flatMap(union => structuralMemberOccurrenceIds(union)),
      ),
    ].sort(compareCodePoints);
    block.childOccurrenceIds = [
      ...new Set(group.flatMap(union => union.childOccurrenceIds)),
    ];
    blocks.push(block);
  }

  return blocks.sort(
    (left, right) =>
      right.generation - left.generation ||
      compareCodePoints(left.orderKey, right.orderKey) ||
      compareCodePoints(left.id, right.id),
  );
}

function familyRelationsForChild(
  block: StructuralFamilyBlock,
  childOccurrenceId: string,
): ParentChildRelation[] {
  const byId = new Map<string, ParentChildRelation>();
  for (const union of block.unions) {
    for (const relation of
      union.relationByChildOccurrenceId.get(childOccurrenceId) ?? []) {
      byId.set(relation.id, relation);
    }
  }
  return [...byId.values()].sort(compareRelations);
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const current = this.parent.get(id);
    if (!current) {
      this.parent.set(id, id);
      return id;
    }
    if (current === id) return id;
    const root = this.find(current);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const [first, second] = [rootA, rootB].sort(compareCodePoints);
    this.parent.set(second!, first!);
  }
}

function normalizedSettings(input: FamilyTreeLayoutInput): LayoutSettings {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? Math.max(1, value!) : fallback;
  return {
    horizontalGap: positive(input.options.horizontalGap, 28),
    branchGapStep: positive(input.options.branchGapStep, 34),
    partnerGap: positive(input.options.partnerGap, 12),
    generationGap: positive(input.options.generationGap, 82),
    previousPositions: new Map(
      (input.options.previousPositions ?? []).map(position => [
        position.occurrenceId,
        position,
      ]),
    ),
    primaryLineagePersonIds: new Set(
      input.options.primaryLineagePersonIds ?? [],
    ),
    lineageTargetPersonId:
      input.options.lineageTargetPersonId ?? input.options.focusPersonId,
    lineageGroupDepth: [1, 2, 3].includes(input.options.lineageGroupDepth ?? 0)
      ? (input.options.lineageGroupDepth as 1 | 2 | 3)
      : 0,
    gapCache: new Map(),
  };
}

function lineageSegments(orderKey: string): string[] {
  return orderKey
    .split("|")
    .filter(segment => /^(A|D|S):/.test(segment));
}

function compareNumberPaths(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function fallbackAncestorSectorPath(orderKey: string): number[] {
  return orderKey
    .split("|")
    .filter(segment => segment.startsWith("A:"))
    .map(segment => {
      const [, group = "0", parent = "0"] = segment.split(":");
      return Number(parent) * 1_000_000 + Number(group) * 1_000;
    });
}

function compareBundleOrder(left: Bundle, right: Bundle): number {
  const ancestorOrder =
    left.generation > 0 && right.generation > 0
      ? compareNumberPaths(
          left.ancestorSectorEndPath,
          right.ancestorSectorEndPath,
        ) ||
        compareNumberPaths(
          left.ancestorSectorStartPath,
          right.ancestorSectorStartPath,
        )
      : 0;
  return (
    ancestorOrder ||
    compareCodePoints(left.orderKey, right.orderKey) ||
    compareCodePoints(left.id, right.id)
  );
}

/**
 * MyHeritage-like nested spacing: close relatives inside one ancestral sector
 * stay compact, while sectors that diverged nearer the focus receive a larger
 * gap. This creates the characteristic inverted-pyramid silhouette.
 */
function hierarchicalGap(
  left: Bundle,
  right: Bundle,
  settings: LayoutSettings,
): number {
  const cacheKey = `${left.id}|${right.id}`;
  const cached = settings.gapCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const useAncestorSectors =
    left.generation > 0 &&
    right.generation > 0 &&
    (left.ancestorSectorEndPath.length > 0 ||
      right.ancestorSectorStartPath.length > 0);
  const leftSegments: readonly (number | string)[] = useAncestorSectors
    ? left.ancestorSectorEndPath
    : lineageSegments(left.orderKey);
  const rightSegments: readonly (number | string)[] = useAncestorSectors
    ? right.ancestorSectorStartPath
    : lineageSegments(right.orderKey);
  let common = 0;
  while (
    common < leftSegments.length &&
    common < rightSegments.length &&
    leftSegments[common] === rightSegments[common]
  ) {
    common += 1;
  }
  const layerDepth = Math.max(
    Math.abs(left.generation),
    leftSegments.length,
    rightSegments.length,
  );
  const separatedLevels = Math.max(0, layerDepth - common - 1);
  const result =
    settings.horizontalGap + separatedLevels * settings.branchGapStep;
  settings.gapCache.set(cacheKey, result);
  return result;
}

/**
 * Relation roles are not consistently populated by every importer. Preserve
 * explicit roles first, then use the precise relationship kind before falling
 * back to the person's sex and the shared generic ordering.
 */
function layoutParentRoleOrder(
  node: SceneNode,
  relation: ParentChildRelation | undefined,
): number {
  if (!node.personId) return 3;
  if (
    relation?.role === "father" ||
    relation?.role === "stepfather" ||
    relation?.role === "adoptive_father"
  ) {
    return 0;
  }
  if (relation?.kind === "genetic_father") return 0;
  if (
    relation?.role === "mother" ||
    relation?.role === "stepmother" ||
    relation?.role === "adoptive_mother"
  ) {
    return 6;
  }
  if (
    relation?.kind === "genetic_mother" ||
    relation?.kind === "gestational_parent" ||
    relation?.kind === "birth_parent" ||
    relation?.kind === "surrogate"
  ) {
    return 6;
  }
  const person = node.personId
    ? {
        id: node.personId,
        displayName: node.personId,
        ...(node.sex ? { sex: node.sex } : {}),
      }
    : undefined;
  return parentRoleOrder(person, relation);
}

function memberRelation(
  node: SceneNode,
  sceneUnions: readonly SceneUnion[],
): ParentChildRelation | undefined {
  if (!node.personId) return undefined;
  for (const sceneUnion of sceneUnions) {
    for (const relations of sceneUnion.relationByChildOccurrenceId.values()) {
      const relation = relations.find(item => item.parentId === node.personId);
      if (relation) return relation;
    }
  }
  return undefined;
}

function memberRole(
  node: SceneNode,
  sceneUnions: readonly SceneUnion[],
): number {
  return layoutParentRoleOrder(node, memberRelation(node, sceneUnions));
}

function orderBundleNodes(
  nodes: readonly SceneNode[],
  incidentUnions: readonly SceneUnion[],
): SceneNode[] {
  if (nodes.length <= 1) return [...nodes];
  if (nodes.length === 2) {
    return [...nodes].sort(
      (a, b) =>
        memberRole(a, incidentUnions) - memberRole(b, incidentUnions) ||
        compareCodePoints(a.orderKey, b.orderKey) ||
        compareCodePoints(a.occurrenceId, b.occurrenceId),
    );
  }

  const degree = new Map<string, number>();
  for (const union of incidentUnions) {
    for (const memberId of union.memberOccurrenceIds) {
      degree.set(memberId, (degree.get(memberId) ?? 0) + 1);
    }
  }
  const ranked = [...nodes].sort(
    (a, b) =>
      a.focusDistance - b.focusDistance ||
      (degree.get(b.occurrenceId) ?? 0) -
        (degree.get(a.occurrenceId) ?? 0) ||
      compareCodePoints(a.orderKey, b.orderKey) ||
      compareCodePoints(a.occurrenceId, b.occurrenceId),
  );
  const hub = ranked[0]!;
  const others = ranked.slice(1).sort(
    (a, b) =>
      compareCodePoints(a.orderKey, b.orderKey) ||
      compareCodePoints(a.occurrenceId, b.occurrenceId),
  );
  const left: SceneNode[] = [];
  const right: SceneNode[] = [];
  others.forEach((node, index) => {
    if (index % 2 === 0) left.push(node);
    else right.push(node);
  });
  return [...left.reverse(), hub, ...right];
}

/**
 * Reconstruct the ancestor-side path from actual parent relations instead of
 * trusting occurrence order keys. The occurrence builder's key is a stable
 * traversal key, but legacy imports may expose only `genetic_father` /
 * `genetic_mother` while leaving the generic role as `parent`; in that case an
 * ID-based relation tie-break can otherwise swap the two ancestor sectors.
 */
function deriveAncestorSectorPaths(
  scene: OccurrenceScene,
  focusOccurrenceId = scene.focusOccurrenceId,
  includeCollateralSectors = true,
): ReadonlyMap<string, readonly number[]> {
  const paths = new Map<string, readonly number[]>();
  if (!focusOccurrenceId) return paths;

  const nodesById = new Map(scene.nodes.map(node => [node.occurrenceId, node]));
  const focus = nodesById.get(focusOccurrenceId);
  if (!focus) return paths;
  paths.set(focus.occurrenceId, []);

  const highestGeneration = Math.max(
    focus.generation,
    ...scene.nodes.map(node => node.generation),
  );
  for (
    let generation = focus.generation;
    generation < highestGeneration;
    generation += 1
  ) {
    const children = scene.nodes
      .filter(
        node => node.generation === generation && paths.has(node.occurrenceId),
      )
      .sort((a, b) => {
        const pathOrder = compareNumberPaths(
          paths.get(a.occurrenceId)!,
          paths.get(b.occurrenceId)!,
        );
        return (
          pathOrder ||
          compareCodePoints(a.orderKey, b.orderKey) ||
          compareCodePoints(a.occurrenceId, b.occurrenceId)
        );
      });

    for (const child of children) {
      const childPath = paths.get(child.occurrenceId)!;
      const parentGroups = scene.unions
        .filter(
          union =>
            union.childOccurrenceIds.includes(child.occurrenceId) &&
            union.memberOccurrenceIds.some(
              occurrenceId =>
                nodesById.get(occurrenceId)?.generation === generation + 1,
            ),
        )
        .sort(
          (a, b) =>
            compareCodePoints(a.orderKey, b.orderKey) ||
            compareCodePoints(a.occurrenceId, b.occurrenceId),
        );

      parentGroups.forEach((union, groupIndex) => {
        const relations =
          union.relationByChildOccurrenceId.get(child.occurrenceId) ?? [];
        const parents = union.memberOccurrenceIds
          .map(occurrenceId => {
            const node = nodesById.get(occurrenceId);
            if (
              !node ||
              node.generation !== generation + 1 ||
              (node.kind !== "person" && node.kind !== "reference")
            ) {
              return undefined;
            }
            const relation = node.personId
              ? relations.find(item => item.parentId === node.personId)
              : undefined;
            return { node, relation };
          })
          .filter(
            (
              entry,
            ): entry is {
              node: SceneNode;
              relation: ParentChildRelation | undefined;
            } => Boolean(entry),
          )
          .sort((a, b) => {
            const roleOrder =
              layoutParentRoleOrder(a.node, a.relation) -
              layoutParentRoleOrder(b.node, b.relation);
            const relationOrder =
              a.relation && b.relation
                ? compareRelations(a.relation, b.relation)
                : a.relation
                  ? -1
                  : b.relation
                    ? 1
                    : 0;
            return (
              roleOrder ||
              relationOrder ||
              compareCodePoints(a.node.orderKey, b.node.orderKey) ||
              compareCodePoints(a.node.occurrenceId, b.node.occurrenceId)
            );
          });

        parents.forEach(({ node, relation }, parentIndex) => {
          const role = layoutParentRoleOrder(node, relation);
          const token = role * 1_000_000 + groupIndex * 1_000 + parentIndex;
          const candidate = [...childPath, token];
          const existing = paths.get(node.occurrenceId);
          if (!existing || compareNumberPaths(candidate, existing) < 0) {
            paths.set(node.occurrenceId, candidate);
          }
        });
      });
    }
  }

  if (!includeCollateralSectors) return paths;

  // Side branches and partners retain the nearest semantic ancestor sector.
  // Choosing the longest prefix prevents a grandparent's collateral family
  // from being flattened into the broader paternal/maternal root sector.
  const anchors = scene.nodes
    .filter(node => paths.has(node.occurrenceId))
    .sort(
      (a, b) =>
        b.orderKey.length - a.orderKey.length ||
        compareCodePoints(a.orderKey, b.orderKey) ||
        compareCodePoints(a.occurrenceId, b.occurrenceId),
    );
  for (const node of scene.nodes) {
    if (paths.has(node.occurrenceId)) continue;
    const anchor = anchors.find(
      candidate =>
        candidate.generation > 0 &&
        (node.orderKey === candidate.orderKey ||
          node.orderKey.startsWith(`${candidate.orderKey}|`)),
    );
    if (anchor) paths.set(node.occurrenceId, paths.get(anchor.occurrenceId)!);
  }

  return paths;
}

function buildBundles(
  scene: OccurrenceScene,
  settings: LayoutSettings,
): {
  bundles: Bundle[];
  bundleByOccurrenceId: ReadonlyMap<string, Bundle>;
} {
  const nodesById = new Map(scene.nodes.map(node => [node.occurrenceId, node]));
  // Continuations are controls attached to a card, not genealogical cards.
  // They are positioned as compact satellites after the structural pedigree
  // is solved and must never reserve columns or move ancestor sectors.
  const structuralNodes = scene.nodes.filter(
    node => node.kind !== "continuation" && node.kind !== "placeholder",
  );
  const ancestorSectorPaths = deriveAncestorSectorPaths(scene);
  const disjoint = new DisjointSet();
  for (const node of structuralNodes) disjoint.add(node.occurrenceId);

  const unionsByMemberOccurrenceId = new Map<string, SceneUnion[]>();
  const unionOrder = new Map<string, number>();
  for (const [unionIndex, union] of scene.unions.entries()) {
    unionOrder.set(union.occurrenceId, unionIndex);
    for (const memberOccurrenceId of union.memberOccurrenceIds) {
      const incident = unionsByMemberOccurrenceId.get(memberOccurrenceId);
      if (incident) incident.push(union);
      else unionsByMemberOccurrenceId.set(memberOccurrenceId, [union]);
    }
    const members = union.memberOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node))
      .filter(node => node.generation === union.generation + 0.5);
    for (let index = 1; index < members.length; index += 1) {
      disjoint.union(members[0]!.occurrenceId, members[index]!.occurrenceId);
    }
  }

  const groups = new Map<string, SceneNode[]>();
  for (const node of structuralNodes) {
    const root = disjoint.find(node.occurrenceId);
    const values = groups.get(root);
    if (values) values.push(node);
    else groups.set(root, [node]);
  }

  const bundles: Bundle[] = [];
  const bundleByOccurrenceId = new Map<string, Bundle>();
  for (const [root, nodes] of groups) {
    const generation = nodes[0]!.generation;
    const incidentUnionIds = new Set<string>();
    const incidentUnions: SceneUnion[] = [];
    for (const node of nodes) {
      for (const union of unionsByMemberOccurrenceId.get(node.occurrenceId) ?? []) {
        if (incidentUnionIds.has(union.occurrenceId)) continue;
        incidentUnionIds.add(union.occurrenceId);
        incidentUnions.push(union);
      }
    }
    incidentUnions.sort(
      (left, right) =>
        unionOrder.get(left.occurrenceId)! - unionOrder.get(right.occurrenceId)!,
    );
    const ordered = orderBundleNodes(nodes, incidentUnions);
    let cursor = 0;
    const offsets = new Map<string, number>();
    for (const node of ordered) {
      offsets.set(node.occurrenceId, cursor + node.width / 2);
      cursor += node.width + settings.partnerGap;
    }
    const width = Math.max(1, cursor - settings.partnerGap);
    for (const [id, center] of offsets) offsets.set(id, center - width / 2);

    const sectorPaths = ordered
      .map(
        node =>
          ancestorSectorPaths.get(node.occurrenceId) ??
          fallbackAncestorSectorPath(node.orderKey),
      )
      .filter(path => path.length > 0)
      .sort(compareNumberPaths);
    const ancestorSectorStartPath =
      generation > 0 && sectorPaths.length > 0 ? sectorPaths[0]! : [];
    const ancestorSectorEndPath =
      generation > 0 && sectorPaths.length > 0
        ? sectorPaths[sectorPaths.length - 1]!
        : [];

    const previousCenters = ordered
      .map(node => {
        const previous = settings.previousPositions.get(node.occurrenceId);
        const offset = offsets.get(node.occurrenceId)!;
        return previous ? previous.x + node.width / 2 - offset : undefined;
      })
      .filter((value): value is number => value !== undefined);
    const bundle: Bundle = {
      id: `bundle:${root}`,
      generation,
      nodes: ordered,
      nodeCenterOffsets: offsets,
      width,
      orderKey: ordered
        .map(node => node.orderKey)
        .sort(compareCodePoints)[0]!,
      ancestorSectorStartPath,
      ancestorSectorEndPath,
      x:
        previousCenters.length > 0
          ? previousCenters.reduce((sum, value) => sum + value, 0) /
            previousCenters.length
          : 0,
    };
    bundles.push(bundle);
    for (const node of ordered) bundleByOccurrenceId.set(node.occurrenceId, bundle);
  }

  bundles.sort(
    (a, b) =>
      b.generation - a.generation ||
      compareBundleOrder(a, b),
  );
  return { bundles, bundleByOccurrenceId };
}

function bundleNodeCenter(bundle: Bundle, occurrenceId: string): number {
  return bundle.x + (bundle.nodeCenterOffsets.get(occurrenceId) ?? 0);
}

function initializeLayers(
  bundles: readonly Bundle[],
  settings: LayoutSettings,
  scene: OccurrenceScene,
  bundleByOccurrenceId: ReadonlyMap<string, Bundle>,
  personsById: ReadonlyMap<string, TreePerson>,
): Map<number, Bundle[]> {
  const layers = new Map<number, Bundle[]>();
  for (const bundle of bundles) {
    const values = layers.get(bundle.generation);
    if (values) values.push(bundle);
    else layers.set(bundle.generation, [bundle]);
  }

  for (const values of layers.values()) {
    values.sort(compareBundleOrder);
  }

  const nodesById = new Map(scene.nodes.map(node => [node.occurrenceId, node]));
  const familyChildBundlesByGeneration = new Map<
    number,
    Array<{ familyId: string; bundles: Bundle[] }>
  >();
  for (const family of structuralFamilyBlocks(scene.unions)) {
    const orderedChildren = [...new Set(family.childOccurrenceIds)].sort(
      (leftId, rightId) => {
        const leftNode = nodesById.get(leftId);
        const rightNode = nodesById.get(rightId);
        const leftPerson = leftNode?.personId
          ? personsById.get(leftNode.personId)
          : undefined;
        const rightPerson = rightNode?.personId
          ? personsById.get(rightNode.personId)
          : undefined;
        if (leftPerson && rightPerson) {
          const birthOrder = comparePeopleByBirth(leftPerson, rightPerson);
          if (birthOrder) return birthOrder;
        } else if (leftPerson || rightPerson) {
          return leftPerson ? -1 : 1;
        }
        return compareCodePoints(leftId, rightId);
      },
    );
    const orderedChildBundles = orderedChildren
      .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
      .filter((bundle): bundle is Bundle => Boolean(bundle))
      .filter((bundle, index, values) => values.indexOf(bundle) === index);
    const generation = orderedChildBundles[0]?.generation;
    if (
      generation === undefined ||
      orderedChildBundles.some(bundle => bundle.generation !== generation)
    ) {
      continue;
    }
    const groups = familyChildBundlesByGeneration.get(generation);
    const group = { familyId: family.id, bundles: orderedChildBundles };
    if (groups) groups.push(group);
    else familyChildBundlesByGeneration.set(generation, [group]);
  }

  for (const [generation, values] of layers) {
    const rank = new Map(values.map((bundle, index) => [bundle.id, index]));
    const familyGroups = (familyChildBundlesByGeneration.get(generation) ?? [])
      .map(group => ({
        ...group,
        bundles: group.bundles.filter(bundle => rank.has(bundle.id)),
      }))
      .filter(group => group.bundles.length > 0);
    if (familyGroups.length === 0) continue;

    // Families that share a child occurrence (for example biological and
    // adoptive parent sets shown together) form one ordering component. This
    // keeps disjoint partner families compact without sacrificing either
    // family's chronology when one child legitimately belongs to both.
    const childComponents = new DisjointSet();
    for (const group of familyGroups) {
      group.bundles.forEach(bundle => childComponents.add(bundle.id));
      for (let index = 1; index < group.bundles.length; index += 1) {
        childComponents.union(group.bundles[0]!.id, group.bundles[index]!.id);
      }
    }
    const groupsByComponent = new Map<string, typeof familyGroups>();
    for (const group of familyGroups) {
      const componentId = childComponents.find(group.bundles[0]!.id);
      const groups = groupsByComponent.get(componentId);
      if (groups) groups.push(group);
      else groupsByComponent.set(componentId, [group]);
    }

    const components = [...groupsByComponent.entries()].map(
      ([componentId, groups]) => {
        const componentBundles = values.filter(bundle =>
          groups.some(group => group.bundles.includes(bundle)),
        );
        const componentIds = new Set(componentBundles.map(bundle => bundle.id));
        const outgoing = new Map<string, Set<string>>();
        const indegree = new Map(componentBundles.map(bundle => [bundle.id, 0]));
        for (const group of groups) {
          for (let index = 1; index < group.bundles.length; index += 1) {
            const leftId = group.bundles[index - 1]!.id;
            const rightId = group.bundles[index]!.id;
            if (!componentIds.has(leftId) || !componentIds.has(rightId)) continue;
            const targets = outgoing.get(leftId) ?? new Set<string>();
            if (targets.has(rightId)) continue;
            targets.add(rightId);
            outgoing.set(leftId, targets);
            indegree.set(rightId, (indegree.get(rightId) ?? 0) + 1);
          }
        }

        const orderedBundles: Bundle[] = [];
        const emitted = new Set<string>();
        while (orderedBundles.length < componentBundles.length) {
          const next = componentBundles.find(
            bundle =>
              !emitted.has(bundle.id) && (indegree.get(bundle.id) ?? 0) === 0,
          );
          if (!next) {
            orderedBundles.push(
              ...componentBundles.filter(bundle => !emitted.has(bundle.id)),
            );
            break;
          }
          orderedBundles.push(next);
          emitted.add(next.id);
          for (const targetId of outgoing.get(next.id) ?? []) {
            indegree.set(targetId, (indegree.get(targetId) ?? 0) - 1);
          }
        }
        return {
          componentId,
          bundles: orderedBundles,
          anchor: Math.min(
            ...componentBundles.map(bundle => rank.get(bundle.id)!),
          ),
        };
      },
    ).sort(
      (left, right) =>
        left.anchor - right.anchor ||
        compareCodePoints(left.componentId, right.componentId),
    );

    const claimed = new Set(
      components.flatMap(component => component.bundles.map(bundle => bundle.id)),
    );
    const componentsByAnchor = new Map<number, typeof components>();
    for (const component of components) {
      const matches = componentsByAnchor.get(component.anchor);
      if (matches) matches.push(component);
      else componentsByAnchor.set(component.anchor, [component]);
    }
    const ordered: Bundle[] = [];
    const emitted = new Set<string>();
    values.forEach((bundle, index) => {
      for (const component of componentsByAnchor.get(index) ?? []) {
        for (const familyBundle of component.bundles) {
          if (emitted.has(familyBundle.id)) continue;
          ordered.push(familyBundle);
          emitted.add(familyBundle.id);
        }
      }
      if (claimed.has(bundle.id) || emitted.has(bundle.id)) return;
      ordered.push(bundle);
      emitted.add(bundle.id);
    });
    ordered.push(...values.filter(bundle => !emitted.has(bundle.id)));
    values.splice(0, values.length, ...ordered);
  }

  for (const values of layers.values()) {
    let cursor = 0;
    for (let index = 0; index < values.length; index += 1) {
      const bundle = values[index]!;
      if (index > 0) {
        cursor += hierarchicalGap(values[index - 1]!, bundle, settings);
      }
      const hasPrevious = bundle.nodes.some(node =>
        settings.previousPositions.has(node.occurrenceId),
      );
      if (!hasPrevious) bundle.x = cursor + bundle.width / 2;
      cursor += bundle.width;
    }
    const center = values.length
      ? (values[0]!.x + values[values.length - 1]!.x) / 2
      : 0;
    for (const bundle of values) {
      if (!bundle.nodes.some(node => settings.previousPositions.has(node.occurrenceId))) {
        bundle.x -= center;
      }
    }
  }
  return layers;
}

function unionAnchorX(
  union: SceneUnion,
  bundleByOccurrenceId: ReadonlyMap<string, Bundle>,
): number | undefined {
  const centers = union.memberOccurrenceIds
    .map(id => {
      const bundle = bundleByOccurrenceId.get(id);
      return bundle ? bundleNodeCenter(bundle, id) : undefined;
    })
    .filter((value): value is number => value !== undefined);
  if (centers.length === 0) return undefined;
  return centers.reduce((sum, value) => sum + value, 0) / centers.length;
}

function solveBundlePositions(
  scene: OccurrenceScene,
  bundles: readonly Bundle[],
  bundleByOccurrenceId: ReadonlyMap<string, Bundle>,
  layers: ReadonlyMap<number, Bundle[]>,
  settings: LayoutSettings,
  familyBlocks: readonly StructuralFamilyBlock[] = structuralFamilyBlocks(
    scene.unions,
  ),
): void {
  const focusBundle = scene.focusOccurrenceId
    ? bundleByOccurrenceId.get(scene.focusOccurrenceId)
    : undefined;
  const layerRankByBundleId = new Map<string, number>();
  for (const layer of layers.values()) {
    layer.forEach((bundle, index) => layerRankByBundleId.set(bundle.id, index));
  }

  for (let pass = 0; pass < 8; pass += 1) {
    const targets = new Map<string, Array<{ x: number; weight: number }>>();
    const addTarget = (bundle: Bundle, x: number, weight: number): void => {
      const values = targets.get(bundle.id);
      if (values) values.push({ x, weight });
      else targets.set(bundle.id, [{ x, weight }]);
    };

    for (const family of familyBlocks) {
      const memberBundle = family.memberOccurrenceIds
        .map(id => bundleByOccurrenceId.get(id))
        .find((bundle): bundle is Bundle => Boolean(bundle));
      if (!memberBundle) continue;
      const anchorOffsetValues = family.memberOccurrenceIds
        .map(id => memberBundle.nodeCenterOffsets.get(id))
        .filter((value): value is number => value !== undefined);
      const anchorOffset = anchorOffsetValues.length
        ? anchorOffsetValues.reduce((sum, value) => sum + value, 0) /
          anchorOffsetValues.length
        : 0;

      const childEntries = family.childOccurrenceIds
        .map(occurrenceId => {
          const bundle = bundleByOccurrenceId.get(occurrenceId);
          return bundle ? { occurrenceId, bundle } : undefined;
        })
        .filter(
          (
            entry,
          ): entry is { occurrenceId: string; bundle: Bundle } => Boolean(entry),
        );
      const childBundles = childEntries
        .map(entry => entry.bundle)
        .filter((bundle, index, values) => values.indexOf(bundle) === index)
        .sort(
          (left, right) =>
            (layerRankByBundleId.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
              (layerRankByBundleId.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
            compareBundleOrder(left, right),
        );
      if (childBundles.length === 0) continue;

      const exactChildCenters = childEntries.map(entry =>
        bundleNodeCenter(entry.bundle, entry.occurrenceId),
      );
      const childrenCenter =
        (Math.min(...exactChildCenters) + Math.max(...exactChildCenters)) / 2;
      addTarget(memberBundle, childrenCenter - anchorOffset, 16);

      const childGaps = childBundles.slice(1).map((bundle, index) =>
        hierarchicalGap(childBundles[index]!, bundle, settings),
      );
      const totalWidth =
        childBundles.reduce((sum, bundle) => sum + bundle.width, 0) +
        childGaps.reduce((sum, value) => sum + value, 0);
      const anchor = memberBundle.x + anchorOffset;
      let cursor = anchor - totalWidth / 2;
      const rawBundleCenters = new Map<string, number>();
      for (let index = 0; index < childBundles.length; index += 1) {
        const childBundle = childBundles[index]!;
        rawBundleCenters.set(
          childBundle.id,
          cursor + childBundle.width / 2,
        );
        cursor += childBundle.width + (childGaps[index] ?? 0);
      }
      const proposedChildCenters = childEntries.map(entry =>
        (rawBundleCenters.get(entry.bundle.id) ?? entry.bundle.x) +
        (entry.bundle.nodeCenterOffsets.get(entry.occurrenceId) ?? 0),
      );
      const proposedChildrenCenter =
        (Math.min(...proposedChildCenters) +
          Math.max(...proposedChildCenters)) /
        2;
      const directChildShift = anchor - proposedChildrenCenter;
      for (const childBundle of childBundles) {
        addTarget(
          childBundle,
          (rawBundleCenters.get(childBundle.id) ?? childBundle.x) +
            directChildShift,
          20,
        );
      }
    }

    for (const [generation, layer] of layers) {
      const packed = packLayer(
        layer.map((bundle, index) => {
          const values = targets.get(bundle.id) ?? [];
          let weightedSum = bundle.x * 4;
          let weight = 4;
          for (const target of values) {
            weightedSum += target.x * target.weight;
            weight += target.weight;
          }

          const previousCenters = bundle.nodes
            .map(node => {
              const previous = settings.previousPositions.get(node.occurrenceId);
              const offset = bundle.nodeCenterOffsets.get(node.occurrenceId)!;
              return previous
                ? previous.x + node.width / 2 - offset
                : undefined;
            })
            .filter((value): value is number => value !== undefined);
          if (previousCenters.length > 0) {
            const previous =
              previousCenters.reduce((sum, value) => sum + value, 0) /
              previousCenters.length;
            weightedSum += previous * 80;
            weight += 80;
          }
          if (bundle === focusBundle) {
            weightedSum += 0;
            weight += 500;
          }
          return {
            id: bundle.id,
            width: bundle.width,
            desiredX: weightedSum / weight,
            weight,
            ...(index > 0
              ? {
                  gapBefore: hierarchicalGap(
                    layer[index - 1]!,
                    bundle,
                    settings,
                  ),
                }
              : {}),
          };
        }),
        settings.horizontalGap,
      );
      for (const bundle of layer) {
        bundle.x = packed.get(bundle.id) ?? bundle.x;
        if (!Number.isFinite(bundle.x)) bundle.x = 0;
      }

      // The map key can be negative; it is deliberately not used as an array index.
      void generation;
    }
  }

  if (focusBundle && scene.focusOccurrenceId) {
    const focusCenter = bundleNodeCenter(focusBundle, scene.focusOccurrenceId);
    for (const bundle of bundles) bundle.x -= focusCenter;
  }
}

interface DescendantFamilyGroup {
  family: StructuralFamilyBlock;
  parentBundle: Bundle;
  anchorOffset: number;
  children: Array<{
    occurrenceId: string;
    bundle: Bundle;
  }>;
}

interface DescendantSubtreePlan {
  bundle: Bundle;
  /** Full subtree contour relative to the bundle center. */
  left: number;
  right: number;
  children: Array<{
    plan: DescendantSubtreePlan;
    centerOffset: number;
  }>;
}

interface DescendantFamilyPlacement {
  familyId: string;
  parentBundleId: string;
  mode: "primary-pair" | "side-partner";
  hubOccurrenceId: string;
  partnerOccurrenceId?: string;
  side?: "left" | "right";
  /** Zero is the satellite nearest the primary family on this side. */
  laneIndex: number;
  /** Total number of side partnerships sharing this side of the hub. */
  sidePartnerCount?: number;
  /** The family stem uses the free contour gap beside the satellite. */
  junctionOffsetFromPartnerCenter?: number;
}

interface DescendantLayoutPlan {
  familyPlacementById: ReadonlyMap<string, DescendantFamilyPlacement>;
}

/**
 * A descending family cannot be solved as independent generation rows. A
 * couple that is both a child in one family and a parent in the next receives
 * conflicting barycentric targets, so PAVA may put its own children below a
 * neighboring couple. For a descendants-only scene, build rigid family
 * subtrees bottom-up and pack those contours top-down instead.
 *
 * The rectangular contour is deliberately conservative: sibling subtrees do
 * not share horizontal space even on different lower rows. That makes every
 * family bus traceable and lets a wide child row push neighboring aunts,
 * uncles and their partners outward as one unit.
 */
function planDescendantForest(
  scene: OccurrenceScene,
  bundles: readonly Bundle[],
  bundleByOccurrenceId: ReadonlyMap<string, Bundle>,
  layers: ReadonlyMap<number, Bundle[]>,
  settings: LayoutSettings,
  allowSpanningOwner = false,
  allowNodesAboveFocus = false,
): DescendantLayoutPlan | undefined {
  const structuralNodes = scene.nodes.filter(
    node => node.kind === "person" || node.kind === "reference",
  );
  const focusNode = structuralNodes.find(
    node => node.occurrenceId === scene.focusOccurrenceId,
  );
  if (
    !scene.focusOccurrenceId ||
    !focusNode ||
    structuralNodes.length === 0 ||
    (!allowNodesAboveFocus &&
      structuralNodes.some(node => node.generation > focusNode.generation))
  ) {
    return undefined;
  }

  const layerRankByBundleId = new Map<string, number>();
  for (const layer of layers.values()) {
    layer.forEach((bundle, index) => layerRankByBundleId.set(bundle.id, index));
  }

  const groups: DescendantFamilyGroup[] = [];
  for (const family of structuralFamilyBlocks(scene.unions)) {
    const parentBundles = [
      ...new Set(
        family.memberOccurrenceIds
          .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
          .filter((bundle): bundle is Bundle => Boolean(bundle)),
      ),
    ];
    if (parentBundles.length !== 1) continue;
    const parentBundle = parentBundles[0]!;
    const anchorOffsets = family.memberOccurrenceIds
      .map(occurrenceId => parentBundle.nodeCenterOffsets.get(occurrenceId))
      .filter((value): value is number => value !== undefined);
    if (anchorOffsets.length === 0) continue;

    const seenChildBundles = new Set<string>();
    const children = family.childOccurrenceIds
      .map(occurrenceId => {
        const bundle = bundleByOccurrenceId.get(occurrenceId);
        return bundle ? { occurrenceId, bundle } : undefined;
      })
      .filter(
        (
          entry,
        ): entry is { occurrenceId: string; bundle: Bundle } =>
          entry !== undefined &&
          entry.bundle.generation < parentBundle.generation,
      )
      .filter(entry => {
        if (seenChildBundles.has(entry.bundle.id)) return false;
        seenChildBundles.add(entry.bundle.id);
        return true;
      })
      .sort(
        (left, right) =>
          (layerRankByBundleId.get(left.bundle.id) ?? Number.MAX_SAFE_INTEGER) -
            (layerRankByBundleId.get(right.bundle.id) ?? Number.MAX_SAFE_INTEGER) ||
          compareBundleOrder(left.bundle, right.bundle),
      );
    // Keep a visible childless/unloaded partnership in the same star. If it
    // were omitted, its old bundle offset could overlap a satellite that does
    // have loaded children, and its fallback partner route would cut through
    // the newly packed families.
    if (
      children.length === 0 &&
      !preferredDisplayPartnership(family.unions)
    ) {
      continue;
    }
    groups.push({
      family,
      parentBundle,
      anchorOffset:
        anchorOffsets.reduce((sum, value) => sum + value, 0) /
        anchorOffsets.length,
      children,
    });
  }
  if (groups.length === 0) return undefined;

  groups.sort(
    (left, right) =>
      right.parentBundle.generation - left.parentBundle.generation ||
      (layerRankByBundleId.get(left.parentBundle.id) ?? Number.MAX_SAFE_INTEGER) -
        (layerRankByBundleId.get(right.parentBundle.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.anchorOffset - right.anchorOffset ||
      compareCodePoints(left.family.orderKey, right.family.orderKey) ||
      compareCodePoints(left.family.id, right.family.id),
  );

  // A canonical child displayed through two genuinely different parent sets
  // is a DAG, not a tree. Keep the existing multi-lane solver for that rare
  // case instead of assigning the same card to two rigid subtrees.
  const ownerByChildBundleId = new Map<string, DescendantFamilyGroup>();
  for (const group of groups) {
    for (const child of group.children) {
      const existing = ownerByChildBundleId.get(child.bundle.id);
      if (existing && existing !== group) {
        if (allowSpanningOwner) continue;
        return undefined;
      }
      ownerByChildBundleId.set(child.bundle.id, group);
    }
  }

  const groupsByParentBundleId = new Map<string, DescendantFamilyGroup[]>();
  for (const group of groups) {
    const values = groupsByParentBundleId.get(group.parentBundle.id);
    if (values) values.push(group);
    else groupsByParentBundleId.set(group.parentBundle.id, [group]);
  }
  const memo = new Map<string, DescendantSubtreePlan>();
  const active = new Set<string>();
  const nodesByOccurrenceId = new Map(
    scene.nodes.map(node => [node.occurrenceId, node]),
  );
  const familyPlacementById = new Map<string, DescendantFamilyPlacement>();
  let invalid = false;
  const buildPlan = (bundle: Bundle): DescendantSubtreePlan => {
    const cached = memo.get(bundle.id);
    if (cached) return cached;
    if (active.has(bundle.id)) {
      invalid = true;
      return {
        bundle,
        left: -bundle.width / 2,
        right: bundle.width / 2,
        children: [],
      };
    }
    active.add(bundle.id);

    const childPlacements: DescendantSubtreePlan["children"] = [];
    const groupLayouts = (groupsByParentBundleId.get(bundle.id) ?? [])
      .map(group => {
        const entries = group.children.filter(
          child => ownerByChildBundleId.get(child.bundle.id) === group,
        );
        if (entries.length === 0) {
          return { group, placements: [], left: 0, right: 0 };
        }
        let cursor = 0;
        const placements = entries.map((entry, index) => {
          const plan = buildPlan(entry.bundle);
          const centerOffset = cursor - plan.left;
          cursor +=
            plan.right - plan.left +
            (index < entries.length - 1 ? settings.horizontalGap : 0);
          return { entry, plan, centerOffset };
        });
        const directChildCenters = placements.map(
          placement =>
            placement.centerOffset +
            (placement.entry.bundle.nodeCenterOffsets.get(
              placement.entry.occurrenceId,
            ) ?? 0),
        );
        const directCenter =
          (Math.min(...directChildCenters) +
            Math.max(...directChildCenters)) /
          2;
        // Every family starts as a local subtree centred at zero. The parent
        // bundle decides later whether that zero belongs under the primary
        // pair or under a side partner.
        const centerShift = -directCenter;
        for (const placement of placements) {
          placement.centerOffset += centerShift;
        }
        const left = Math.min(
          ...placements.map(
            placement => placement.centerOffset + placement.plan.left,
          ),
        );
        const right = Math.max(
          ...placements.map(
            placement => placement.centerOffset + placement.plan.right,
          ),
        );
        return { group, placements, left, right };
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .sort(
        (left, right) =>
          left.group.anchorOffset - right.group.anchorOffset ||
          compareCodePoints(left.group.family.orderKey, right.group.family.orderKey) ||
          compareCodePoints(left.group.family.id, right.group.family.id),
      );

    const memberFrequency = new Map<string, number>();
    for (const layout of groupLayouts) {
      for (const occurrenceId of layout.group.family.memberOccurrenceIds) {
        memberFrequency.set(
          occurrenceId,
          (memberFrequency.get(occurrenceId) ?? 0) + 1,
        );
      }
    }
    const hubOccurrenceId = [...memberFrequency]
      .filter(([, frequency]) => frequency > 1)
      .sort(([leftId, leftFrequency], [rightId, rightFrequency]) => {
        const leftNode = nodesByOccurrenceId.get(leftId);
        const rightNode = nodesByOccurrenceId.get(rightId);
        const leftLineage = leftNode?.personId
          ? settings.primaryLineagePersonIds.has(leftNode.personId)
          : false;
        const rightLineage = rightNode?.personId
          ? settings.primaryLineagePersonIds.has(rightNode.personId)
          : false;
        return (
          Number(rightLineage) - Number(leftLineage) ||
          rightFrequency - leftFrequency ||
          compareCodePoints(leftId, rightId)
        );
      })[0]?.[0];
    const starLayouts = hubOccurrenceId
      ? groupLayouts.map(layout => {
          if (
            !layout.group.family.memberOccurrenceIds.includes(hubOccurrenceId)
          ) {
            return undefined;
          }
          const otherMembers = layout.group.family.memberOccurrenceIds.filter(
            occurrenceId => occurrenceId !== hubOccurrenceId,
          );
          if (otherMembers.length > 1) return undefined;
          return {
            layout,
            ...(otherMembers[0]
              ? { partnerOccurrenceId: otherMembers[0] }
              : {}),
          };
        })
      : [];
    const typedStarLayouts = starLayouts.filter(
      (value): value is NonNullable<typeof value> => Boolean(value),
    );
    const starPartnerOccurrenceIds = typedStarLayouts
      .map(value => value.partnerOccurrenceId)
      .filter((value): value is string => Boolean(value));
    const canPackPartnerStar =
      groupLayouts.length > 1 &&
      starLayouts.length === groupLayouts.length &&
      typedStarLayouts.length === groupLayouts.length &&
      typedStarLayouts.filter(value => !value.partnerOccurrenceId).length <= 1 &&
      new Set(starPartnerOccurrenceIds).size ===
        starPartnerOccurrenceIds.length;

    if (canPackPartnerStar && hubOccurrenceId) {
      const lineageScore = (value: (typeof typedStarLayouts)[number]) => {
        const childLineageCount = value.layout.placements.filter(placement => {
          const node = nodesByOccurrenceId.get(
            placement.entry.occurrenceId,
          );
          return Boolean(
            node?.personId &&
              settings.primaryLineagePersonIds.has(node.personId),
          );
        }).length;
        const memberLineageCount =
          value.layout.group.family.memberOccurrenceIds.filter(occurrenceId => {
            const node = nodesByOccurrenceId.get(occurrenceId);
            return Boolean(
              node?.personId &&
                settings.primaryLineagePersonIds.has(node.personId),
            );
          }).length;
        return (
          childLineageCount * 10_000 +
          memberLineageCount * 100 +
          (value.layout.placements.length > 0 ? 10 : 0)
        );
      };
      const orderedStarLayouts = [...typedStarLayouts].sort(
        (left, right) =>
          // A loaded hub-only family cannot move its junction to a partner
          // satellite. Keep that family directly below the hub and place all
          // explicit partners around it; otherwise its bus is pushed almost
          // entirely to one side of the selected card.
          Number(
            !right.partnerOccurrenceId &&
              right.layout.placements.length > 0,
          ) -
            Number(
              !left.partnerOccurrenceId &&
                left.layout.placements.length > 0,
            ) ||
          lineageScore(right) - lineageScore(left) ||
          compareCodePoints(
            left.layout.group.family.orderKey,
            right.layout.group.family.orderKey,
          ) ||
          compareCodePoints(
            left.layout.group.family.id,
            right.layout.group.family.id,
          ),
      );
      const primary = orderedStarLayouts[0]!;
      const hubNode = nodesByOccurrenceId.get(hubOccurrenceId);
      const primaryPartnerNode = primary.partnerOccurrenceId
        ? nodesByOccurrenceId.get(primary.partnerOccurrenceId)
        : undefined;
      if (!hubNode || (primary.partnerOccurrenceId && !primaryPartnerNode)) {
        invalid = true;
      } else {
        const primaryMembers = primaryPartnerNode
          ? [hubNode, primaryPartnerNode].sort(
              (left, right) =>
                memberRole(left, primary.layout.group.family.unions) -
                  memberRole(right, primary.layout.group.family.unions) ||
                compareCodePoints(left.orderKey, right.orderKey) ||
                compareCodePoints(left.occurrenceId, right.occurrenceId),
            )
          : [hubNode];
        const primaryWidth = primaryPartnerNode
          ? primaryMembers[0]!.width +
            settings.partnerGap +
            primaryMembers[1]!.width
          : hubNode.width;
        const primaryCenters = new Map<string, number>();
        if (primaryPartnerNode) {
          primaryCenters.set(
            primaryMembers[0]!.occurrenceId,
            -primaryWidth / 2 + primaryMembers[0]!.width / 2,
          );
          primaryCenters.set(
            primaryMembers[1]!.occurrenceId,
            primaryWidth / 2 - primaryMembers[1]!.width / 2,
          );
        } else {
          primaryCenters.set(hubOccurrenceId, 0);
        }
        for (const [occurrenceId, center] of primaryCenters) {
          bundle.nodeCenterOffsets.set(occurrenceId, center);
        }
        const primaryTarget =
          primaryPartnerNode && primary.partnerOccurrenceId
            ? ((primaryCenters.get(hubOccurrenceId) ?? 0) +
                (primaryCenters.get(primary.partnerOccurrenceId) ?? 0)) /
              2
            : primaryCenters.get(hubOccurrenceId) ?? 0;
        for (const placement of primary.layout.placements) {
          placement.centerOffset += primaryTarget;
          childPlacements.push({
            plan: placement.plan,
            centerOffset: placement.centerOffset,
          });
        }
        primary.layout.left = Math.min(
          ...primaryMembers.map(
            node =>
              (primaryCenters.get(node.occurrenceId) ?? 0) - node.width / 2,
          ),
          ...primary.layout.placements.map(
            placement => placement.centerOffset + placement.plan.left,
          ),
        );
        primary.layout.right = Math.max(
          ...primaryMembers.map(
            node =>
              (primaryCenters.get(node.occurrenceId) ?? 0) + node.width / 2,
          ),
          ...primary.layout.placements.map(
            placement => placement.centerOffset + placement.plan.right,
          ),
        );
        let occupiedLeft = primary.layout.left;
        let occupiedRight = primary.layout.right;
        familyPlacementById.set(primary.layout.group.family.id, {
          familyId: primary.layout.group.family.id,
          parentBundleId: bundle.id,
          mode: "primary-pair",
          hubOccurrenceId,
          ...(primary.partnerOccurrenceId
            ? { partnerOccurrenceId: primary.partnerOccurrenceId }
            : {}),
          laneIndex: 0,
        });

        const sideLaneCount = { left: 0, right: 0 };
        const sidePlacements: DescendantFamilyPlacement[] = [];
        const satellites = orderedStarLayouts.slice(1).sort(
          (left, right) =>
            compareCodePoints(
              left.layout.group.family.orderKey,
              right.layout.group.family.orderKey,
            ) ||
            compareCodePoints(
              left.layout.group.family.id,
              right.layout.group.family.id,
            ),
        );
        for (const satellite of satellites) {
          if (!satellite.partnerOccurrenceId) continue;
          const partnerNode = nodesByOccurrenceId.get(
            satellite.partnerOccurrenceId,
          );
          if (!partnerNode) {
            invalid = true;
            continue;
          }
          const branchLeft = Math.min(
            -partnerNode.width / 2,
            satellite.layout.left,
          );
          const branchRight = Math.max(
            partnerNode.width / 2,
            satellite.layout.right,
          );
          const leftCandidate = occupiedLeft - settings.horizontalGap - branchRight;
          const rightCandidate = occupiedRight + settings.horizontalGap - branchLeft;
          const leftSpan = Math.max(
            occupiedRight,
            leftCandidate + branchRight,
          ) - Math.min(occupiedLeft, leftCandidate + branchLeft);
          const rightSpan = Math.max(
            occupiedRight,
            rightCandidate + branchRight,
          ) - Math.min(occupiedLeft, rightCandidate + branchLeft);
          const side: "left" | "right" =
            leftSpan < rightSpan ||
            (Math.abs(leftSpan - rightSpan) < 0.001 &&
              sideLaneCount.left <= sideLaneCount.right)
              ? "left"
              : "right";
          const partnerCenter = side === "left"
            ? leftCandidate
            : rightCandidate;
          const junctionOffsetFromPartnerCenter = side === "left"
            ? branchRight + settings.horizontalGap / 2
            : branchLeft - settings.horizontalGap / 2;
          bundle.nodeCenterOffsets.set(
            satellite.partnerOccurrenceId,
            partnerCenter,
          );
          for (const placement of satellite.layout.placements) {
            placement.centerOffset += partnerCenter;
            childPlacements.push({
              plan: placement.plan,
              centerOffset: placement.centerOffset,
            });
          }
          satellite.layout.left = partnerCenter + branchLeft;
          satellite.layout.right = partnerCenter + branchRight;
          if (side === "left") occupiedLeft = satellite.layout.left;
          else occupiedRight = satellite.layout.right;
          const laneIndex = sideLaneCount[side]++;
          const sidePlacement: DescendantFamilyPlacement = {
            familyId: satellite.layout.group.family.id,
            parentBundleId: bundle.id,
            mode: "side-partner",
            hubOccurrenceId,
            partnerOccurrenceId: satellite.partnerOccurrenceId,
            side,
            laneIndex,
            sidePartnerCount: 0,
            junctionOffsetFromPartnerCenter,
          };
          familyPlacementById.set(
            satellite.layout.group.family.id,
            sidePlacement,
          );
          sidePlacements.push(sidePlacement);
        }
        for (const sidePlacement of sidePlacements) {
          sidePlacement.sidePartnerCount = sideLaneCount[sidePlacement.side!];
        }

        // Re-centre the bundle around the actual card box. The descendant
        // contour is shifted by the same amount, so recursive packing remains
        // stable and saved coordinates cannot pull satellites back inward.
        const cardLeft = Math.min(
          ...bundle.nodes.map(
            node =>
              (bundle.nodeCenterOffsets.get(node.occurrenceId) ?? 0) -
              node.width / 2,
          ),
        );
        const cardRight = Math.max(
          ...bundle.nodes.map(
            node =>
              (bundle.nodeCenterOffsets.get(node.occurrenceId) ?? 0) +
              node.width / 2,
          ),
        );
        const cardCenter = (cardLeft + cardRight) / 2;
        for (const [occurrenceId, center] of bundle.nodeCenterOffsets) {
          bundle.nodeCenterOffsets.set(occurrenceId, center - cardCenter);
        }
        for (const placement of childPlacements) {
          placement.centerOffset -= cardCenter;
        }
        for (const layout of groupLayouts) {
          layout.left -= cardCenter;
          layout.right -= cardCenter;
        }
        bundle.width = Math.max(1, cardRight - cardLeft);
      }
    } else if (groupLayouts.length > 0) {
      for (const layout of groupLayouts) {
        for (const placement of layout.placements) {
          placement.centerOffset += layout.group.anchorOffset;
        }
        layout.left += layout.group.anchorOffset;
        layout.right += layout.group.anchorOffset;
      }
      const packedGroups = packLayer(
        groupLayouts.map((layout, index) => ({
          id: layout.group.family.id,
          width: layout.right - layout.left,
          desiredX: (layout.left + layout.right) / 2,
          weight: 100,
          ...(index > 0 ? { gapBefore: settings.horizontalGap } : {}),
        })),
        settings.horizontalGap,
      );
      for (const layout of groupLayouts) {
        const originalCenter = (layout.left + layout.right) / 2;
        const packedCenter =
          packedGroups.get(layout.group.family.id) ?? originalCenter;
        const shift = packedCenter - originalCenter;
        for (const placement of layout.placements) {
          childPlacements.push({
            plan: placement.plan,
            centerOffset: placement.centerOffset + shift,
          });
        }
        layout.left += shift;
        layout.right += shift;
      }
    }

    const plan: DescendantSubtreePlan = {
      bundle,
      left: Math.min(
        -bundle.width / 2,
        ...groupLayouts.map(layout => layout.left),
      ),
      right: Math.max(
        bundle.width / 2,
        ...groupLayouts.map(layout => layout.right),
      ),
      children: childPlacements,
    };
    active.delete(bundle.id);
    memo.set(bundle.id, plan);
    return plan;
  };

  const childBundleIds = new Set(ownerByChildBundleId.keys());
  const roots = bundles
    .filter(bundle => !childBundleIds.has(bundle.id))
    .sort(
      (left, right) =>
        left.x - right.x || compareBundleOrder(left, right),
    );
  if (roots.length === 0) return undefined;
  const rootPlans = roots.map(buildPlan);
  if (invalid || memo.size !== bundles.length) return undefined;
  const packedRoots = packLayer(
    rootPlans.map((plan, index) => ({
      id: plan.bundle.id,
      width: plan.right - plan.left,
      desiredX: plan.bundle.x + (plan.left + plan.right) / 2,
      weight: 100,
      ...(index > 0 ? { gapBefore: settings.horizontalGap } : {}),
    })),
    settings.horizontalGap,
  );

  const assigned = new Set<string>();
  const assign = (plan: DescendantSubtreePlan, center: number): void => {
    if (assigned.has(plan.bundle.id)) return;
    assigned.add(plan.bundle.id);
    plan.bundle.x = center;
    for (const child of plan.children) {
      assign(child.plan, center + child.centerOffset);
    }
  };
  for (const plan of rootPlans) {
    const boxCenter =
      packedRoots.get(plan.bundle.id) ??
      plan.bundle.x + (plan.left + plan.right) / 2;
    assign(plan, boxCenter - (plan.left + plan.right) / 2);
  }
  const focusBundle = bundleByOccurrenceId.get(scene.focusOccurrenceId);
  if (focusBundle) {
    const focusCenter = bundleNodeCenter(
      focusBundle,
      scene.focusOccurrenceId,
    );
    for (const bundle of bundles) bundle.x -= focusCenter;
  }
  return { familyPlacementById };
}

/**
 * Descendant-only fallback for a shared-child DAG. A convergence couple keeps
 * one canonical bundle while the contour planner selects one spanning owner;
 * both real incoming families remain available to edge routing. The generation
 * solver below is retained only for malformed/cyclic DAGs that cannot produce
 * a spanning forest. The ancestor solver is never used.
 */
function packDescendantFallbackLayers(
  scene: OccurrenceScene,
  bundles: readonly Bundle[],
  layers: ReadonlyMap<number, Bundle[]>,
  bundleByOccurrenceId: ReadonlyMap<string, Bundle>,
  settings: LayoutSettings,
): DescendantLayoutPlan | undefined {
  const families = structuralFamilyBlocks(scene.unions);
  const incomingByChildBundleId = new Map<
    string,
    Array<{
      family: StructuralFamilyBlock;
      parentBundle: Bundle;
      childOccurrenceId: string;
    }>
  >();
  for (const family of families) {
    const parentBundle = family.memberOccurrenceIds
      .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
      .find((bundle): bundle is Bundle => Boolean(bundle));
    if (!parentBundle) continue;
    for (const childOccurrenceId of family.childOccurrenceIds) {
      const childBundle = bundleByOccurrenceId.get(childOccurrenceId);
      if (!childBundle) continue;
      const incoming = incomingByChildBundleId.get(childBundle.id);
      const entry = { family, parentBundle, childOccurrenceId };
      if (incoming) incoming.push(entry);
      else incomingByChildBundleId.set(childBundle.id, [entry]);
    }
  }

  const rankByBundleId = new Map<string, number>();
  for (const layer of layers.values()) {
    layer.forEach((bundle, index) => rankByBundleId.set(bundle.id, index));
  }
  for (const [childBundleId, rawIncoming] of incomingByChildBundleId) {
    const incoming = rawIncoming
      .filter(
        (entry, index, values) =>
          values.findIndex(
            candidate => candidate.family.id === entry.family.id,
          ) === index,
      )
      .sort(
        (left, right) =>
          (rankByBundleId.get(left.parentBundle.id) ?? Number.MAX_SAFE_INTEGER) -
            (rankByBundleId.get(right.parentBundle.id) ?? Number.MAX_SAFE_INTEGER) ||
          compareCodePoints(left.family.orderKey, right.family.orderKey) ||
          compareCodePoints(left.family.id, right.family.id),
      );
    if (incoming.length !== 2) continue;
    const childBundle = bundles.find(bundle => bundle.id === childBundleId);
    const layer = childBundle ? layers.get(childBundle.generation) : undefined;
    if (!childBundle || !layer) continue;

    // Keep the shared couple canonical. The rigid contour planner below picks
    // one spanning owner for geometry, while edge routing retains both real
    // incoming families. A synthetic reference/portal would render the same
    // person twice (for example, a selected ancestor's mother).

    const otherChildren = (
      entry: (typeof incoming)[number],
    ): Bundle[] => {
      const seen = new Set<string>();
      return entry.family.childOccurrenceIds
        .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
        .filter((bundle): bundle is Bundle => Boolean(bundle))
        .filter(bundle => bundle.id !== childBundleId)
        .filter(bundle => {
          if (seen.has(bundle.id)) return false;
          seen.add(bundle.id);
          return true;
        })
        .sort(
          (left, right) =>
            layer.indexOf(left) - layer.indexOf(right) ||
            compareBundleOrder(left, right),
        );
    };
    const leftChildren = otherChildren(incoming[0]!);
    const rightChildren = otherChildren(incoming[1]!);
    const component = [
      ...leftChildren,
      childBundle,
      ...rightChildren,
    ];
    const componentIds = new Set(component.map(bundle => bundle.id));
    const firstIndex = Math.min(
      ...layer
        .map((bundle, index) => (componentIds.has(bundle.id) ? index : -1))
        .filter(index => index >= 0),
    );
    const insertionIndex = layer
      .slice(0, firstIndex)
      .filter(bundle => !componentIds.has(bundle.id)).length;
    const remaining = layer.filter(bundle => !componentIds.has(bundle.id));
    remaining.splice(insertionIndex, 0, ...component);
    layer.splice(0, layer.length, ...remaining);

    const leftOffset = childBundle.nodeCenterOffsets.get(
      incoming[0]!.childOccurrenceId,
    );
    const rightOffset = childBundle.nodeCenterOffsets.get(
      incoming[1]!.childOccurrenceId,
    );
    if (
      leftOffset !== undefined &&
      rightOffset !== undefined &&
      leftOffset > rightOffset
    ) {
      childBundle.nodeCenterOffsets.set(
        incoming[0]!.childOccurrenceId,
        rightOffset,
      );
      childBundle.nodeCenterOffsets.set(
        incoming[1]!.childOccurrenceId,
        leftOffset,
      );
    }
  }

  // Previous tree coordinates describe the pre-reduction spanning tree and
  // must not pin a legal convergence back into its old collapsed rows.
  const dagSettings: LayoutSettings = {
    ...settings,
    previousPositions: new Map(),
    gapCache: new Map(),
  };
  const rigidSpanningPlan = planDescendantForest(
    scene,
    bundles,
    bundleByOccurrenceId,
    layers,
    dagSettings,
    true,
    true,
  );
  if (rigidSpanningPlan) return rigidSpanningPlan;
  for (const layer of layers.values()) {
    let cursor = 0;
    for (let index = 0; index < layer.length; index += 1) {
      const bundle = layer[index]!;
      if (index > 0) {
        cursor += hierarchicalGap(layer[index - 1]!, bundle, dagSettings);
      }
      bundle.x = cursor + bundle.width / 2;
      cursor += bundle.width;
    }
    if (!layer.length) continue;
    const left = layer[0]!.x - layer[0]!.width / 2;
    const last = layer[layer.length - 1]!;
    const right = last.x + last.width / 2;
    const center = (left + right) / 2;
    for (const bundle of layer) bundle.x -= center;
  }
  solveBundlePositions(
    scene,
    bundles,
    bundleByOccurrenceId,
    layers,
    dagSettings,
  );

  // A pedigree reduction only makes the part above the re-entry a DAG. Once
  // the two arms meet, the descendants below the shared card/couple are an
  // ordinary forest again. Leaving that lower forest in the generation-only
  // solver makes wide child rows fight with their own grandchildren and is
  // the reason a tree can start correctly and then collapse into a heap.
  // Re-run the rigid descendant planner for every terminal convergence and
  // keep its root attached to the coordinate chosen by the DAG solver.
  const convergenceBundleIds = new Set(
    [...incomingByChildBundleId]
      .filter(([, entries]) =>
        new Set(entries.map(entry => entry.family.id)).size > 1,
      )
      .map(([bundleId]) => bundleId),
  );
  const childBundlesByParentBundleId = new Map<string, Set<string>>();
  for (const family of families) {
    const parentBundle = family.memberOccurrenceIds
      .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
      .find((bundle): bundle is Bundle => Boolean(bundle));
    if (!parentBundle) continue;
    const childIds = childBundlesByParentBundleId.get(parentBundle.id) ??
      new Set<string>();
    for (const childOccurrenceId of family.childOccurrenceIds) {
      const childBundle = bundleByOccurrenceId.get(childOccurrenceId);
      if (childBundle && childBundle.generation < parentBundle.generation) {
        childIds.add(childBundle.id);
      }
    }
    childBundlesByParentBundleId.set(parentBundle.id, childIds);
  }
  const reachableFrom = (rootBundleId: string): Set<string> => {
    const reachable = new Set<string>();
    const pending = [rootBundleId];
    while (pending.length > 0) {
      const bundleId = pending.pop()!;
      if (reachable.has(bundleId)) continue;
      reachable.add(bundleId);
      for (const childId of childBundlesByParentBundleId.get(bundleId) ?? []) {
        pending.push(childId);
      }
    }
    return reachable;
  };
  const terminalConvergences = [...convergenceBundleIds]
    .map(bundleId => ({ bundleId, reachable: reachableFrom(bundleId) }))
    .filter(({ bundleId, reachable }) =>
      ![...reachable].some(
        candidate =>
          candidate !== bundleId && convergenceBundleIds.has(candidate),
      ),
    )
    .sort((left, right) => {
      const leftBundle = bundles.find(bundle => bundle.id === left.bundleId);
      const rightBundle = bundles.find(bundle => bundle.id === right.bundleId);
      return (
        (rightBundle?.generation ?? 0) - (leftBundle?.generation ?? 0) ||
        compareCodePoints(left.bundleId, right.bundleId)
      );
    });

  const familyPlacementById = new Map<string, DescendantFamilyPlacement>();
  const claimedBundles = new Set<string>();
  for (const convergence of terminalConvergences) {
    if ([...convergence.reachable].some(id => claimedBundles.has(id))) continue;
    const convergenceBundle = bundles.find(
      bundle => bundle.id === convergence.bundleId,
    );
    if (!convergenceBundle) continue;
    const anchorOccurrenceId =
      incomingByChildBundleId
        .get(convergence.bundleId)
        ?.map(entry => entry.childOccurrenceId)
        .find(occurrenceId =>
          convergenceBundle.nodeCenterOffsets.has(occurrenceId),
        ) ?? convergenceBundle.nodes[0]?.occurrenceId;
    if (!anchorOccurrenceId) continue;
    const anchorBefore = bundleNodeCenter(
      convergenceBundle,
      anchorOccurrenceId,
    );
    const subBundles = bundles.filter(bundle =>
      convergence.reachable.has(bundle.id),
    );
    const subLayers = new Map<number, Bundle[]>();
    for (const [generation, layer] of layers) {
      const values = layer.filter(bundle =>
        convergence.reachable.has(bundle.id),
      );
      if (values.length > 0) subLayers.set(generation, values);
    }
    const subScene: OccurrenceScene = {
      nodes: scene.nodes.filter(node =>
        convergence.reachable.has(
          bundleByOccurrenceId.get(node.occurrenceId)?.id ?? "",
        ),
      ),
      unions: scene.unions.filter(union =>
        union.memberOccurrenceIds.some(occurrenceId =>
          convergence.reachable.has(
            bundleByOccurrenceId.get(occurrenceId)?.id ?? "",
          ),
        ),
      ),
      warnings: scene.warnings,
      primaryOccurrenceByPersonId: scene.primaryOccurrenceByPersonId,
      focusOccurrenceId: anchorOccurrenceId,
    };
    const subPlan = planDescendantForest(
      subScene,
      subBundles,
      bundleByOccurrenceId,
      subLayers,
      dagSettings,
    );
    if (!subPlan) continue;
    const anchorAfter = bundleNodeCenter(
      convergenceBundle,
      anchorOccurrenceId,
    );
    const shift = anchorBefore - anchorAfter;
    for (const bundle of subBundles) {
      bundle.x += shift;
      claimedBundles.add(bundle.id);
    }
    for (const [familyId, placement] of subPlan.familyPlacementById) {
      familyPlacementById.set(familyId, placement);
    }
  }

  // The lower rigid blocks are now fixed. Walk back towards the selected root
  // once and place each ordinary parent bundle exactly over the interval of
  // its visible children. This is deliberately a bottom-up sweep rather than
  // another weighted solver pass: weighted targets were the source of the
  // growing left/right drift at every generation above a convergence.
  const focusBundle = scene.focusOccurrenceId
    ? bundleByOccurrenceId.get(scene.focusOccurrenceId)
    : undefined;
  const hasDistinctIngressConvergence = terminalConvergences.some(
    convergence =>
      new Set(
        (incomingByChildBundleId.get(convergence.bundleId) ?? []).map(
          entry => entry.childOccurrenceId,
        ),
      ).size > 1,
  );
  if (hasDistinctIngressConvergence) {
    const parentGenerations = new Set<number>();
  for (const family of families) {
    const parentBundle = family.memberOccurrenceIds
      .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
      .find((bundle): bundle is Bundle => Boolean(bundle));
    if (parentBundle && !claimedBundles.has(parentBundle.id)) {
      parentGenerations.add(parentBundle.generation);
    }
  }
    const orderedParentGenerations = [...parentGenerations].sort(
      (left, right) => left - right,
    );
    for (const generation of orderedParentGenerations) {
    const targets = new Map<string, number[]>();
    for (const family of families) {
      const parentBundle = family.memberOccurrenceIds
        .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
        .find((bundle): bundle is Bundle => Boolean(bundle));
      if (
        !parentBundle ||
        parentBundle.generation !== generation ||
        claimedBundles.has(parentBundle.id)
      ) {
        continue;
      }
      const anchorOffsets = family.memberOccurrenceIds
        .map(occurrenceId => parentBundle.nodeCenterOffsets.get(occurrenceId))
        .filter((value): value is number => value !== undefined);
      const childCenters = family.childOccurrenceIds
        .map(occurrenceId => {
          const bundle = bundleByOccurrenceId.get(occurrenceId);
          return bundle && bundle.generation < parentBundle.generation
            ? bundleNodeCenter(bundle, occurrenceId)
            : undefined;
        })
        .filter((value): value is number => value !== undefined);
      if (anchorOffsets.length === 0 || childCenters.length === 0) continue;
      const anchorOffset =
        anchorOffsets.reduce((sum, value) => sum + value, 0) /
        anchorOffsets.length;
      const childrenCenter =
        (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
      const values = targets.get(parentBundle.id) ?? [];
      values.push(childrenCenter - anchorOffset);
      targets.set(parentBundle.id, values);
    }
    for (const [bundleId, values] of targets) {
      const bundle = bundles.find(candidate => candidate.id === bundleId);
      if (!bundle || values.length === 0) continue;
      bundle.x =
        values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    // Childless siblings on the same row must move out of the way of the
    // centred branch roots, not pull those roots away from their children.
    // Fixed-to-fixed collisions are intentionally left to the DAG ordering
    // invariant; free cards before, between and after fixed anchors are packed
    // into the available intervals deterministically.
    const layer = layers.get(generation);
    if (!layer || layer.length < 2 || targets.size === 0) continue;
    const fixedIndices = layer
      .map((bundle, index) => (targets.has(bundle.id) ? index : -1))
      .filter(index => index >= 0);
    const requiredDistance = (left: Bundle, right: Bundle): number =>
      left.width / 2 + hierarchicalGap(left, right, dagSettings) + right.width / 2;
    const firstFixedIndex = fixedIndices[0];
    if (firstFixedIndex !== undefined) {
      for (let index = firstFixedIndex - 1; index >= 0; index -= 1) {
        const bundle = layer[index]!;
        const next = layer[index + 1]!;
        bundle.x = next.x - requiredDistance(bundle, next);
      }
    }
    for (let fixedIndex = 0; fixedIndex < fixedIndices.length - 1; fixedIndex += 1) {
      const leftIndex = fixedIndices[fixedIndex]!;
      const rightIndex = fixedIndices[fixedIndex + 1]!;
      if (rightIndex <= leftIndex + 1) continue;
      const leftAnchor = layer[leftIndex]!;
      const rightAnchor = layer[rightIndex]!;
      const required = layer
        .slice(leftIndex, rightIndex)
        .reduce(
          (sum, bundle, index) =>
            sum + requiredDistance(bundle, layer[leftIndex + index + 1]!),
          0,
        );
      const available = rightAnchor.x - leftAnchor.x;
      if (available + 0.001 < required) continue;
      const extraPerGap =
        (available - required) / Math.max(1, rightIndex - leftIndex);
      for (let index = leftIndex + 1; index < rightIndex; index += 1) {
        const previous = layer[index - 1]!;
        const bundle = layer[index]!;
        bundle.x =
          previous.x + requiredDistance(previous, bundle) + extraPerGap;
      }
    }
    const lastFixedIndex = fixedIndices[fixedIndices.length - 1];
    if (lastFixedIndex !== undefined) {
      for (let index = lastFixedIndex + 1; index < layer.length; index += 1) {
        const previous = layer[index - 1]!;
        const bundle = layer[index]!;
        bundle.x = previous.x + requiredDistance(previous, bundle);
      }
    }

    // A real GEDCOM can have several continuing side families on this same
    // row. Their exact centring targets may be mutually infeasible, so finish
    // the row with one constrained PAVA pass. Branch roots carry a very high
    // weight; childless/free cards absorb the displacement first, while the
    // hard non-overlap invariant always wins over a cosmetically exact centre.
    const packed = packLayer(
      layer.map((bundle, index) => ({
        id: bundle.id,
        width: bundle.width,
        desiredX: bundle.x,
        weight: targets.has(bundle.id) ? 1_000_000 : 1,
        ...(index > 0
          ? {
              gapBefore: hierarchicalGap(
                layer[index - 1]!,
                bundle,
                dagSettings,
              ),
            }
          : {}),
      })),
      dagSettings.horizontalGap,
    );
    for (const bundle of layer) {
      bundle.x = packed.get(bundle.id) ?? bundle.x;
    }
    }
  } else if (focusBundle && scene.focusOccurrenceId) {
    // A single canonical person reused by two parent sets is not a joining
    // couple. Both incoming families cannot own and centre that same card at
    // once, so keep the safe layered upper geometry and only align the root's
    // primary family as one rigid translation of every lower generation.
    const primaryRootFamily = families
      .map(family => {
        const parentBundle = family.memberOccurrenceIds
          .map(occurrenceId => bundleByOccurrenceId.get(occurrenceId))
          .find((bundle): bundle is Bundle => Boolean(bundle));
        const childEntries = family.childOccurrenceIds
          .map(occurrenceId => {
            const bundle = bundleByOccurrenceId.get(occurrenceId);
            return bundle ? { occurrenceId, bundle } : undefined;
          })
          .filter(
            (
              entry,
            ): entry is { occurrenceId: string; bundle: Bundle } =>
              Boolean(
                entry && entry.bundle.generation < focusBundle.generation,
              ),
          );
        return { family, parentBundle, childEntries };
      })
      .filter(
        value =>
          value.parentBundle === focusBundle &&
          value.family.memberOccurrenceIds.includes(scene.focusOccurrenceId!) &&
          value.childEntries.length > 0,
      )
      .sort(
        (left, right) =>
          right.childEntries.length - left.childEntries.length ||
          compareCodePoints(left.family.orderKey, right.family.orderKey) ||
          compareCodePoints(left.family.id, right.family.id),
      )[0];
    if (primaryRootFamily) {
      const memberCenters = primaryRootFamily.family.memberOccurrenceIds
        .map(occurrenceId =>
          focusBundle.nodeCenterOffsets.has(occurrenceId)
            ? bundleNodeCenter(focusBundle, occurrenceId)
            : undefined,
        )
        .filter((value): value is number => value !== undefined);
      const childCenters = primaryRootFamily.childEntries.map(entry =>
        bundleNodeCenter(entry.bundle, entry.occurrenceId),
      );
      const parentCenter =
        memberCenters.reduce((sum, value) => sum + value, 0) /
        memberCenters.length;
      const childCenter =
        (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
      const shift = parentCenter - childCenter;
      for (const bundle of bundles) {
        if (bundle.generation < focusBundle.generation) bundle.x += shift;
      }
    }
  }

  // Translation is the only focus constraint in a DAG. It retains every
  // family alignment computed above while restoring the selected card to the
  // stable origin expected by viewport restoration.
  if (focusBundle && scene.focusOccurrenceId) {
    const focusCenter = bundleNodeCenter(
      focusBundle,
      scene.focusOccurrenceId,
    );
    for (const bundle of bundles) bundle.x -= focusCenter;
  }

  return familyPlacementById.size > 0
    ? { familyPlacementById }
    : undefined;
}

function positionNodes(
  bundles: readonly Bundle[],
  settings: LayoutSettings,
): SceneNode[] {
  for (const bundle of bundles) {
    for (const node of bundle.nodes) {
      const center = bundleNodeCenter(bundle, node.occurrenceId);
      node.x = center - node.width / 2;
    }
  }
  const nodes = bundles.flatMap(bundle => bundle.nodes);
  positionGenerationRows(nodes, settings, new Map());
  return nodes;
}

function positionGenerationRows(
  nodes: readonly SceneNode[],
  settings: LayoutSettings,
  generationGapByCorridor: ReadonlyMap<number, number>,
): void {
  const defaultHeight = Math.max(1, ...nodes.map(node => node.height));
  const rowY = new Map<number, number>([[0, 0]]);
  const gapFor = (corridor: number): number =>
    generationGapByCorridor.get(corridor) ?? settings.generationGap;
  const yForGeneration = (generation: number): number => {
    const cached = rowY.get(generation);
    if (cached !== undefined) return cached;
    if (!Number.isInteger(generation)) {
      const fallback = -generation * (defaultHeight + settings.generationGap);
      rowY.set(generation, fallback);
      return fallback;
    }
    let y = 0;
    if (generation > 0) {
      for (let parentGeneration = 1; parentGeneration <= generation; parentGeneration += 1) {
        y -= defaultHeight + gapFor(parentGeneration - 0.5);
      }
    } else {
      for (let parentGeneration = 0; parentGeneration > generation; parentGeneration -= 1) {
        y += defaultHeight + gapFor(parentGeneration - 0.5);
      }
    }
    rowY.set(generation, y);
    return y;
  };

  for (const node of nodes) node.y = yForGeneration(node.generation);
}

function ancestorLineageGroup(
  path: readonly number[],
  depth: 0 | 1 | 2 | 3,
): number | undefined {
  if (depth === 0 || path.length < depth) return undefined;
  let group = 0;
  for (const token of path.slice(0, depth)) {
    const role = Math.floor(token / 1_000_000);
    const fallbackIndex = token % 1_000;
    const side = role <= 1 ? 0 : role >= 4 ? 1 : fallbackIndex > 0 ? 1 : 0;
    group = group * 2 + side;
  }
  return group;
}

function assignAncestorLineage(
  node: SceneNode,
  path: readonly number[],
  focusOccurrenceId: string,
  settings: LayoutSettings,
): void {
  node.lineageRole = node.occurrenceId === focusOccurrenceId
    ? "focus"
    : "direct-ancestor";
  const group = ancestorLineageGroup(path, settings.lineageGroupDepth);
  if (group !== undefined) node.lineageGroup = group;
}

function applyDirectAncestorGrid(
  scene: OccurrenceScene,
  nodes: readonly SceneNode[],
  settings: LayoutSettings,
  personsById: ReadonlyMap<string, TreePerson>,
): DescendantLayoutPlan | undefined {
  if (!scene.focusOccurrenceId) return undefined;
  const ancestorPaths = deriveAncestorSectorPaths(scene);
  const pedigreeNodes = nodes.filter(
    node => node.kind === "person" || node.kind === "reference",
  );
  const pedigreeOccurrenceIds = new Set(
    pedigreeNodes.map(node => node.occurrenceId),
  );
  const directEntries = pedigreeNodes
    .map(node => {
      const path = ancestorPaths.get(node.occurrenceId);
      if (!path) return undefined;
      if (node.occurrenceId === scene.focusOccurrenceId) {
        return path.length === 0 && node.generation === 0
          ? { node, path }
          : undefined;
      }
      const lineage = node.orderKey.split("|").slice(1);
      const direct =
        node.generation > 0 &&
        path.length === node.generation &&
        lineage.length === node.generation &&
        lineage.every(segment => segment.startsWith("A:"));
      return direct ? { node, path } : undefined;
    })
    .filter(
      (
        entry,
      ): entry is {
        node: SceneNode;
        path: readonly number[];
      } => Boolean(entry),
    );

  // Keep lineage semantics on the concrete occurrence. A canonical person can
  // be a direct ancestor in one pedigree-collapse path and collateral in
  // another, so a person-id set in React would highlight the wrong card.
  for (const { node, path } of directEntries) {
    assignAncestorLineage(
      node,
      path,
      scene.focusOccurrenceId,
      settings,
    );
  }

  const directByOccurrenceId = new Map(
    directEntries.map(entry => [entry.node.occurrenceId, entry]),
  );
  if (!directByOccurrenceId.has(scene.focusOccurrenceId)) return undefined;

  const globalFamilyIds = new Set(
    structuralFamilyBlocks(scene.unions).map(family => family.id),
  );
  const pedigreeFamilyPlacementById = new Map<
    string,
    DescendantFamilyPlacement
  >();

  // Every collateral family belongs to the nearest direct ancestor sector.
  // Re-layout that entire branch in its own local coordinate system before
  // the direct pedigree is packed. This keeps a couple, its shared children
  // and all nested side families together; saved coordinates are deliberately
  // only a soft seed and can never stretch a family bus through another branch.
  const directAnchors = directEntries
    .map(entry => entry.node)
    .sort(
      (left, right) =>
        right.orderKey.length - left.orderKey.length ||
        compareCodePoints(left.orderKey, right.orderKey) ||
        compareCodePoints(left.occurrenceId, right.occurrenceId),
    );
  const directByPath = new Map<string, SceneNode[]>();
  for (const entry of directEntries) {
    const key = JSON.stringify(entry.path);
    const anchors = directByPath.get(key);
    if (anchors) anchors.push(entry.node);
    else directByPath.set(key, [entry.node]);
  }

  const ownerByOccurrenceId = new Map<string, string>();
  for (const node of pedigreeNodes) {
    if (directByOccurrenceId.has(node.occurrenceId)) continue;

    const partnershipAnchorIds = [
      ...new Set(
        scene.unions
          .filter(
            union =>
              union.kind === "partnership" &&
              union.memberOccurrenceIds.includes(node.occurrenceId),
          )
          .flatMap(union => union.memberOccurrenceIds)
          .filter(occurrenceId => {
            const anchor = directByOccurrenceId.get(occurrenceId)?.node;
            return anchor?.generation === node.generation;
          }),
      ),
    ].sort(compareCodePoints);
    if (partnershipAnchorIds.length > 1) return undefined;
    const prefixAnchor = directAnchors.find(
      anchor =>
        anchor.occurrenceId !== scene.focusOccurrenceId &&
        node.orderKey.startsWith(`${anchor.orderKey}|`),
    );
    const semanticPath = ancestorPaths.get(node.occurrenceId);
    const pathAnchors = semanticPath
      ? (directByPath.get(JSON.stringify(semanticPath)) ?? [])
      : [];
    const focusAnchor = directByOccurrenceId.get(scene.focusOccurrenceId)?.node;
    const owner =
      (partnershipAnchorIds.length === 1
        ? directByOccurrenceId.get(partnershipAnchorIds[0]!)?.node
        : undefined) ??
      prefixAnchor ??
      (pathAnchors.length === 1 ? pathAnchors[0] : undefined) ??
      focusAnchor;
    if (!owner) return undefined;
    ownerByOccurrenceId.set(node.occurrenceId, owner.occurrenceId);
  }

  const ownedNodesByAnchor = new Map<string, SceneNode[]>();
  for (const node of pedigreeNodes) {
    const ownerId = ownerByOccurrenceId.get(node.occurrenceId);
    if (!ownerId) continue;
    const owned = ownedNodesByAnchor.get(ownerId);
    if (owned) owned.push(node);
    else ownedNodesByAnchor.set(ownerId, [node]);
  }
  for (const owned of ownedNodesByAnchor.values()) {
    owned.sort(
      (left, right) =>
        right.generation - left.generation ||
        compareCodePoints(left.orderKey, right.orderKey) ||
        compareCodePoints(left.occurrenceId, right.occurrenceId),
    );
  }

  const relativeLeftByOccurrenceId = new Map<string, number>();
  let branchLayoutFailed = false;
  const items = directEntries.map(({ node, path }) => {
    let leftExtent = node.width / 2;
    let rightExtent = node.width / 2;
    const contourByGeneration = new Map<
      number,
      { left: number; right: number }
    >([
      [
        node.generation,
        { left: -node.width / 2, right: node.width / 2 },
      ],
    ]);
    const owned = ownedNodesByAnchor.get(node.occurrenceId) ?? [];
    if (owned.length > 0) {
      const localNodes = [node, ...owned].map(localNode => ({ ...localNode }));
      const includedIds = new Set(
        localNodes.map(localNode => localNode.occurrenceId),
      );
      const siblingOrderingUnionIds = new Set(
        structuralFamilyBlocks(scene.unions)
          .filter(
            family =>
              family.childOccurrenceIds.filter(occurrenceId =>
                includedIds.has(occurrenceId),
              ).length >= 2,
          )
          .flatMap(family => family.unions.map(union => union.occurrenceId)),
      );
      const localScene: OccurrenceScene = {
        nodes: localNodes,
        unions: scene.unions.filter(union => {
          const structuralIds = [
            ...union.memberOccurrenceIds,
            ...union.childOccurrenceIds,
          ].filter(occurrenceId => pedigreeOccurrenceIds.has(occurrenceId));
          return (
            (structuralIds.length > 0 &&
              structuralIds.every(occurrenceId => includedIds.has(occurrenceId))) ||
            siblingOrderingUnionIds.has(union.occurrenceId)
          );
        }),
        warnings: [],
        primaryOccurrenceByPersonId: new Map(
          localNodes
            .filter(
              (localNode): localNode is SceneNode & { personId: string } =>
                Boolean(localNode.personId),
            )
            .map(localNode => [localNode.personId, localNode.occurrenceId]),
        ),
        focusOccurrenceId: node.occurrenceId,
      };
      const localSettings: LayoutSettings = {
        ...settings,
        previousPositions: new Map(),
        gapCache: new Map(),
      };
      const localBundleState = buildBundles(localScene, localSettings);
      const localLayers = initializeLayers(
        localBundleState.bundles,
        localSettings,
        localScene,
        localBundleState.bundleByOccurrenceId,
        personsById,
      );
      const localDescendantPlan = planDescendantForest(
        localScene,
        localBundleState.bundles,
        localBundleState.bundleByOccurrenceId,
        localLayers,
        localSettings,
      );
      if (!localDescendantPlan) {
        solveBundlePositions(
          localScene,
          localBundleState.bundles,
          localBundleState.bundleByOccurrenceId,
          localLayers,
          localSettings,
        );
      }
      const locallyPositioned = positionNodes(
        localBundleState.bundles,
        localSettings,
      );
      const locallyPositionedById = new Map(
        locallyPositioned.map(localNode => [localNode.occurrenceId, localNode]),
      );
      const localAnchor = locallyPositionedById.get(node.occurrenceId);
      if (!localAnchor) branchLayoutFailed = true;
      if (!localAnchor) {
        return {
          occurrenceId: node.occurrenceId,
          width: node.width,
          leftExtent,
          rightExtent,
          contourByGeneration,
          path,
        };
      }
      const anchorCenter = localAnchor.x + localAnchor.width / 2;
      const localOwned = owned
        .map(ownedNode => {
          const localNode = locallyPositionedById.get(ownedNode.occurrenceId);
          return localNode ? { ownedNode, localNode } : undefined;
        })
        .filter(
          (
            entry,
          ): entry is { ownedNode: SceneNode; localNode: SceneNode } =>
            Boolean(entry),
        );
      const rawLeft = Math.min(
        ...localOwned.map(({ localNode }) => localNode.x - anchorCenter),
      );
      const rawRight = Math.max(
        ...localOwned.map(
          ({ localNode }) =>
            localNode.x + localNode.width - anchorCenter,
        ),
      );
      const role = path.length
        ? Math.floor(path[path.length - 1]! / 1_000_000)
        : 3;
      const desiredSide =
        path.length === 0
          ? "center"
          : role < 3
            ? "left"
            : role > 3
              ? "right"
              : "center";
      const branchCenter = (rawLeft + rawRight) / 2;
      const hasChronologicalSiblingRow = structuralFamilyBlocks(
        localScene.unions,
      ).some(
        family =>
          family.childOccurrenceIds.filter(occurrenceId =>
            includedIds.has(occurrenceId),
          ).length >= 2,
      );
      const mirror =
        !hasChronologicalSiblingRow &&
        ((desiredSide === "left" && branchCenter > 0) ||
          (desiredSide === "right" && branchCenter < 0));

      // Keep the family-star geometry produced by the dedicated descendant
      // solver. The global router needs these junctions and side-line ports too;
      // otherwise a side marriage falls back to the couple midpoint and its
      // vertical stem can cut through a neighboring marriage's child bus.
      let mergedLocalPlacement = false;
      for (const [familyId, placement] of
        localDescendantPlan?.familyPlacementById ?? []) {
        if (
          !globalFamilyIds.has(familyId) ||
          !pedigreeOccurrenceIds.has(placement.hubOccurrenceId) ||
          (placement.partnerOccurrenceId !== undefined &&
            !pedigreeOccurrenceIds.has(placement.partnerOccurrenceId))
        ) {
          continue;
        }
        const transformedPlacement: DescendantFamilyPlacement = {
          ...placement,
        };
        if (mirror && transformedPlacement.side) {
          transformedPlacement.side =
            transformedPlacement.side === "left" ? "right" : "left";
        }
        if (
          mirror &&
          transformedPlacement.junctionOffsetFromPartnerCenter !== undefined
        ) {
          transformedPlacement.junctionOffsetFromPartnerCenter =
            -transformedPlacement.junctionOffsetFromPartnerCenter;
        }
        pedigreeFamilyPlacementById.set(familyId, transformedPlacement);
        mergedLocalPlacement = true;
      }
      for (const { ownedNode, localNode } of localOwned) {
        const rawRelativeLeft = localNode.x - anchorCenter;
        const relativeLeft = mirror
          ? -(rawRelativeLeft + localNode.width)
          : rawRelativeLeft;
        relativeLeftByOccurrenceId.set(ownedNode.occurrenceId, relativeLeft);
        leftExtent = Math.max(leftExtent, -relativeLeft);
        rightExtent = Math.max(
          rightExtent,
          relativeLeft + localNode.width,
        );
        const currentContour = contourByGeneration.get(localNode.generation);
        if (currentContour) {
          currentContour.left = Math.min(currentContour.left, relativeLeft);
          currentContour.right = Math.max(
            currentContour.right,
            relativeLeft + localNode.width,
          );
        } else {
          contourByGeneration.set(localNode.generation, {
            left: relativeLeft,
            right: relativeLeft + localNode.width,
          });
        }
      }

      // Cards alone are not the whole occupied branch. Reserve the future
      // parent-to-children route in its half-generation corridor as well, so
      // another direct sector cannot cross or merge with that family bus.
      const localNodeById = locallyPositionedById;
      for (const family of structuralFamilyBlocks(localScene.unions)) {
        const members = family.memberOccurrenceIds
          .map(occurrenceId => localNodeById.get(occurrenceId))
          .filter((candidate): candidate is SceneNode => Boolean(candidate));
        const children = family.childOccurrenceIds
          .map(occurrenceId => localNodeById.get(occurrenceId))
          .filter((candidate): candidate is SceneNode => Boolean(candidate));
        if (members.length === 0 || children.length === 0) continue;
        const unionX = familyJunctionX(
          family,
          members,
          localDescendantPlan,
        );
        const routeCenters = [
          unionX,
          ...children.map(child => child.x + child.width / 2),
        ];
        const margin = Math.max(12, settings.partnerGap);
        const rawRouteLeft = Math.min(...routeCenters) - margin - anchorCenter;
        const rawRouteRight = Math.max(...routeCenters) + margin - anchorCenter;
        const routeLeft = mirror ? -rawRouteRight : rawRouteLeft;
        const routeRight = mirror ? -rawRouteLeft : rawRouteRight;
        const corridor = family.generation - 0.5;
        const currentContour = contourByGeneration.get(corridor);
        if (currentContour) {
          currentContour.left = Math.min(currentContour.left, routeLeft);
          currentContour.right = Math.max(currentContour.right, routeRight);
        } else {
          contourByGeneration.set(corridor, {
            left: routeLeft,
            right: routeRight,
          });
        }
        leftExtent = Math.max(leftExtent, -routeLeft);
        rightExtent = Math.max(rightExtent, routeRight);
      }
    }
    return {
      occurrenceId: node.occurrenceId,
      width: node.width,
      leftExtent,
      rightExtent,
      contourByGeneration,
      ...(path.length > 0
        ? {
            side:
              Math.floor(path[path.length - 1]! / 1_000_000) > 3
                ? ("maternal" as const)
                : ("paternal" as const),
          }
        : {}),
      path,
    };
  });

  if (branchLayoutFailed) return undefined;
  const grid = layoutDirectAncestors(items, {
    sectorGap: settings.partnerGap,
  });
  if (!grid) return undefined;
  for (const { node } of directEntries) {
    const center = grid.centerByOccurrenceId.get(node.occurrenceId)!;
    node.x = center - node.width / 2;
    for (const ownedNode of ownedNodesByAnchor.get(node.occurrenceId) ?? []) {
      const relativeLeft = relativeLeftByOccurrenceId.get(
        ownedNode.occurrenceId,
      );
      if (relativeLeft !== undefined) ownedNode.x = center + relativeLeft;
    }
  }
  return pedigreeFamilyPlacementById.size > 0
    ? {
        familyPlacementById: pedigreeFamilyPlacementById,
      }
    : undefined;
}

interface ConfiguredLineageStyle {
  role: "focus" | "direct-ancestor";
  group?: number;
}

/**
 * Captures fill semantics before either coordinate solver can rewrite the
 * occurrence graph. Descendant convergence replaces one incoming occurrence
 * with a geometry-only portal, so deriving ancestry after that rewrite would
 * lose the non-owning person's parents.
 */
function buildConfiguredDirectLineage(
  scene: OccurrenceScene,
  settings: LayoutSettings,
): ReadonlyMap<string, ConfiguredLineageStyle> {
  const styles = new Map<string, ConfiguredLineageStyle>();
  const requestedTarget = scene.primaryOccurrenceByPersonId.get(
    settings.lineageTargetPersonId,
  );
  const requestedNode = scene.nodes.find(
    node => node.occurrenceId === requestedTarget,
  );
  if (
    !requestedNode?.personId ||
    (requestedNode.kind !== "person" && requestedNode.kind !== "reference")
  ) {
    return styles;
  }
  const targetOccurrenceId = requestedNode.occurrenceId;
  const ancestorPaths = deriveAncestorSectorPaths(
    scene,
    targetOccurrenceId,
    false,
  );

  // Reverse-walk from the original pedigree focus. This uses concrete
  // parent-child occurrences, so a person repeated as a lateral partner does
  // not inherit the direct-line fill from their other occurrence.
  for (const node of scene.nodes) {
    const path = ancestorPaths.get(node.occurrenceId);
    if (
      !path ||
      (node.kind !== "person" && node.kind !== "reference") ||
      !node.personId
    ) {
      continue;
    }
    const group = ancestorLineageGroup(path, settings.lineageGroupDepth);
    styles.set(node.occurrenceId, {
      role: node.occurrenceId === targetOccurrenceId
        ? "focus"
        : "direct-ancestor",
      ...(group === undefined ? {} : { group }),
    });
  }
  return styles;
}

/**
 * Applies the immutable root-lineage snapshot after layout. Visual focus and
 * geometry may move freely without changing which concrete cards are filled.
 */
function applyConfiguredDirectLineage(
  nodes: readonly SceneNode[],
  styles: ReadonlyMap<string, ConfiguredLineageStyle>,
): void {
  for (const node of nodes) {
    delete node.lineageRole;
    delete node.lineageGroup;
    const style = styles.get(node.occurrenceId);
    if (!style) continue;
    node.lineageRole = style.role;
    if (style.group !== undefined) node.lineageGroup = style.group;
  }
}

function positionAuxiliaryNodes(
  scene: OccurrenceScene,
  structuralNodes: readonly SceneNode[],
): SceneNode[] {
  const nodesById = new Map(
    structuralNodes.map(node => [node.occurrenceId, node]),
  );
  const bySource = new Map<string, SceneNode[]>();
  for (const node of scene.nodes) {
    if (node.kind !== "continuation" && node.kind !== "placeholder") continue;
    const sourceOccurrenceId =
      node.sourceOccurrenceId ??
      (node.actionPersonId
        ? scene.primaryOccurrenceByPersonId.get(node.actionPersonId)
        : undefined);
    if (!sourceOccurrenceId || !nodesById.has(sourceOccurrenceId)) continue;
    const values = bySource.get(sourceOccurrenceId);
    if (values) values.push(node);
    else bySource.set(sourceOccurrenceId, [node]);
  }

  const directionOrder = new Map([
    ["parents", 0],
    ["siblings", 1],
    ["partners", 2],
    ["children", 3],
  ]);
  const continuations: SceneNode[] = [];
  for (const [sourceOccurrenceId, values] of bySource) {
    const source = nodesById.get(sourceOccurrenceId)!;
    values.sort(
      (left, right) =>
        (directionOrder.get(left.direction ?? "children") ?? 4) -
          (directionOrder.get(right.direction ?? "children") ?? 4) ||
        compareCodePoints(left.occurrenceId, right.occurrenceId),
    );
    const gap = 4;
    const totalWidth =
      values.reduce((sum, node) => sum + node.width, 0) +
      gap * Math.max(0, values.length - 1);
    let cursor = source.x + source.width - totalWidth - 6;
    for (const node of values) {
      node.generation = source.generation;
      node.x = cursor;
      node.y = source.y + source.height + 7;
      cursor += node.width + gap;
      continuations.push(node);
    }
  }

  return [...structuralNodes, ...continuations];
}

function relationEdgeKind(kind: ParentRelationshipKind): LayoutEdgeKind {
  return kind;
}

function uniqueKinds(relations: readonly ParentChildRelation[]): ParentRelationshipKind[] {
  return [...new Set(relations.map(relation => relation.kind))].sort(compareCodePoints);
}

interface SiblingBusRouteEntry {
  familyId: string;
  corridor: number;
  parentBottom: number;
  childTop: number;
  baseBusY: number;
}

interface SiblingBusLanePlan {
  laneByFamily: ReadonlyMap<string, number>;
  laneCountByCorridor: ReadonlyMap<number, number>;
}

const SIBLING_BUS_INTERVAL_PADDING = 10;
const SIBLING_BUS_INTERVAL_MARGIN = 12;
const SIBLING_BUS_LANE_GAP = 12;
// Continuation controls occupy sourceBottom + 7..35. Keep the first family
// route below them, with a visible buffer, and keep the final route away from
// the child card border.
const SIBLING_BUS_PARENT_CLEARANCE = 44;
const SIBLING_BUS_CHILD_CLEARANCE = 14;

function sideFamilyPlacement(
  familyId: string,
  descendantPlan: DescendantLayoutPlan | undefined,
): DescendantFamilyPlacement | undefined {
  const placement = descendantPlan?.familyPlacementById.get(familyId);
  return placement?.mode === "side-partner" ? placement : undefined;
}

function familyJunctionX(
  family: StructuralFamilyBlock,
  members: readonly SceneNode[],
  descendantPlan: DescendantLayoutPlan | undefined,
): number {
  const placement = sideFamilyPlacement(family.id, descendantPlan);
  if (
    placement?.partnerOccurrenceId &&
    placement.junctionOffsetFromPartnerCenter !== undefined
  ) {
    const partner = members.find(
      member => member.occurrenceId === placement.partnerOccurrenceId,
    );
    if (partner) {
      return (
        partner.x +
        partner.width / 2 +
        placement.junctionOffsetFromPartnerCenter
      );
    }
  }
  const memberCenters = members.map(node => node.x + node.width / 2);
  return (
    memberCenters.reduce((sum, value) => sum + value, 0) /
    memberCenters.length
  );
}

interface SideFamilyRouteGeometry {
  placement: DescendantFamilyPlacement;
  hub: SceneNode;
  partner: SceneNode;
  lineY: number;
  hubPortX: number;
  partnerPortX: number;
  junctionX: number;
}

function sideFamilyRouteGeometry(
  family: StructuralFamilyBlock,
  members: readonly SceneNode[],
  descendantPlan: DescendantLayoutPlan | undefined,
): SideFamilyRouteGeometry | undefined {
  const placement = sideFamilyPlacement(family.id, descendantPlan);
  if (!placement?.partnerOccurrenceId || !placement.side) return undefined;
  const hub = members.find(
    member => member.occurrenceId === placement.hubOccurrenceId,
  );
  const partner = members.find(
    member => member.occurrenceId === placement.partnerOccurrenceId,
  );
  if (!hub || !partner) return undefined;
  const sideCount = Math.max(1, placement.sidePartnerCount ?? 1);
  const portProgress = (placement.laneIndex + 1) / (sideCount + 1);
  const lineY = Math.max(hub.y, partner.y) +
    Math.min(hub.height, partner.height) * (0.46 - portProgress * 0.18);
  const hubPortX = placement.side === "left" ? hub.x : hub.x + hub.width;
  const partnerPortX = placement.side === "left"
    ? partner.x + partner.width
    : partner.x;
  return {
    placement,
    hub,
    partner,
    lineY,
    // Preserve the established multi-partner convention: every partnership
    // leaves and enters through facing side ports on its own parallel line.
    hubPortX,
    partnerPortX,
    junctionX: familyJunctionX(family, members, descendantPlan),
  };
}

function reserveSortedIntervalLane(
  laneEndXs: number[],
  interval: [number, number],
): number {
  // Callers sort intervals by their left edge. Every new interval can only be
  // appended after the last interval already assigned to a lane, so checking
  // one right edge is equivalent to rescanning the lane's entire history.
  for (let laneIndex = 0; laneIndex < laneEndXs.length; laneIndex += 1) {
    if (laneEndXs[laneIndex]! + SIBLING_BUS_INTERVAL_MARGIN > interval[0]) {
      continue;
    }
    laneEndXs[laneIndex] = interval[1];
    return laneIndex;
  }
  laneEndXs.push(interval[1]);
  return laneEndXs.length - 1;
}

function createSiblingBusLanePlan(
  families: readonly StructuralFamilyBlock[],
  nodesById: ReadonlyMap<string, SceneNode>,
  descendantPlan?: DescendantLayoutPlan,
): SiblingBusLanePlan {
  const intervalsByCorridor = new Map<
    number,
    Array<{ familyId: string; interval: [number, number] }>
  >();
  for (const family of families) {
    const members = family.memberOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node))
      .filter(node => node.kind !== "continuation" && node.kind !== "placeholder");
    const children = family.childOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node));
    if (!members.length || !children.length) continue;
    const childCenters = children.map(node => node.x + node.width / 2);
    const unionX = familyJunctionX(family, members, descendantPlan);
    const centers = [unionX, ...childCenters];
    const values = intervalsByCorridor.get(family.generation);
    const entry = {
      familyId: family.id,
      interval: [
        Math.min(...centers) - SIBLING_BUS_INTERVAL_PADDING,
        Math.max(...centers) + SIBLING_BUS_INTERVAL_PADDING,
      ] as [number, number],
    };
    if (values) values.push(entry);
    else intervalsByCorridor.set(family.generation, [entry]);
  }

  const laneByFamily = new Map<string, number>();
  const laneCountByCorridor = new Map<number, number>();
  for (const [corridor, entries] of intervalsByCorridor) {
    const laneEndXs: number[] = [];
    const sorted = [...entries].sort(
      (left, right) =>
        left.interval[0] - right.interval[0] ||
        left.interval[1] - right.interval[1] ||
        compareCodePoints(left.familyId, right.familyId),
    );
    for (const entry of sorted) {
      laneByFamily.set(
        entry.familyId,
        reserveSortedIntervalLane(laneEndXs, entry.interval),
      );
    }
    laneCountByCorridor.set(corridor, Math.max(1, laneEndXs.length));
  }
  return { laneByFamily, laneCountByCorridor };
}

function requiredGenerationGapByCorridor(
  lanePlan: SiblingBusLanePlan,
  baseGap: number,
): ReadonlyMap<number, number> {
  const corridors = new Set(lanePlan.laneCountByCorridor.keys());
  return new Map(
    [...corridors].map(corridor => {
      const laneCount = lanePlan.laneCountByCorridor.get(corridor) ?? 1;
      return [
        corridor,
        Math.max(
          baseGap,
          SIBLING_BUS_PARENT_CLEARANCE +
            SIBLING_BUS_CHILD_CLEARANCE +
            Math.max(0, laneCount - 1) * SIBLING_BUS_LANE_GAP,
        ),
      ];
    }),
  );
}

/**
 * Independent families can span the same horizontal range after a collateral
 * branch is opened. If their sibling buses share one Y coordinate, Canvas
 * paints them as a single long family line. Colour the interval graph into
 * deterministic vertical lanes so every family remains traceable without
 * hiding any already-open branch.
 */
function siblingBusYByFamily(
  families: readonly StructuralFamilyBlock[],
  nodesById: ReadonlyMap<string, SceneNode>,
  lanePlan: SiblingBusLanePlan,
): ReadonlyMap<string, number> {
  const entriesByCorridor = new Map<number, SiblingBusRouteEntry[]>();
  for (const family of families) {
    const members = family.memberOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node))
      .filter(node => node.kind !== "continuation" && node.kind !== "placeholder");
    const children = family.childOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node));
    if (!members.length || !children.length) continue;

    const parentBottom = Math.max(...members.map(node => node.y + node.height));
    const childTop = Math.min(...children.map(node => node.y));
    const verticalGap = Math.max(1, childTop - parentBottom);
    const unionY = parentBottom + Math.min(34, verticalGap * 0.28);
    const baseBusY = unionY + (childTop - unionY) * 0.52;
    const entry: SiblingBusRouteEntry = {
      familyId: family.id,
      corridor: family.generation,
      parentBottom,
      childTop,
      baseBusY,
    };
    const entries = entriesByCorridor.get(entry.corridor);
    if (entries) entries.push(entry);
    else entriesByCorridor.set(entry.corridor, [entry]);
  }

  const busYByFamily = new Map<string, number>();
  for (const [corridor, entries] of entriesByCorridor) {
    const laneCount = lanePlan.laneCountByCorridor.get(corridor) ?? 1;
    // Calculate one shared origin for the entire between-generation corridor.
    // Disjoint family intervals can reuse lane 0 and must therefore have the
    // same Y; only genuinely overlapping intervals move to another lane.
    const top =
      Math.max(...entries.map(entry => entry.parentBottom)) +
      SIBLING_BUS_PARENT_CLEARANCE;
    const bottom =
      Math.min(...entries.map(entry => entry.childTop)) -
      SIBLING_BUS_CHILD_CLEARANCE;
    const routeHeight = SIBLING_BUS_LANE_GAP * (laneCount - 1);
    const averageBaseY =
      entries.reduce((sum, entry) => sum + entry.baseBusY, 0) /
      entries.length;
    const latestStart = Math.max(top, bottom - routeHeight);
    const startY = Math.min(
      Math.max(averageBaseY - routeHeight / 2, top),
      latestStart,
    );
    for (const entry of entries) {
      const lane = lanePlan.laneByFamily.get(entry.familyId) ?? 0;
      busYByFamily.set(
        entry.familyId,
        startY + lane * SIBLING_BUS_LANE_GAP,
      );
    }
  }
  return busYByFamily;
}

function routeEdges(
  scene: OccurrenceScene,
  nodes: readonly SceneNode[],
  settings: LayoutSettings,
  families: readonly StructuralFamilyBlock[],
  lanePlan: SiblingBusLanePlan,
  descendantPlan?: DescendantLayoutPlan,
): { unions: LayoutUnion[]; edges: LayoutEdge[] } {
  const nodesById = new Map(nodes.map(node => [node.occurrenceId, node]));
  const edges: LayoutEdge[] = [];
  const unions: LayoutUnion[] = [];
  const routedBusY = siblingBusYByFamily(
    families,
    nodesById,
    lanePlan,
  );

  interface SharedChildApproach {
    approachX: number;
    portX: number;
    portY: number;
  }
  interface FamilyBusGeometry {
    family: StructuralFamilyBlock;
    children: SceneNode[];
    busY: number;
    left: number;
    right: number;
  }
  const familyGeometriesByChild = new Map<string, FamilyBusGeometry[]>();
  for (const family of families) {
    const members = family.memberOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node))
      .filter(node => node.kind !== "continuation" && node.kind !== "placeholder");
    const children = family.childOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node));
    if (!members.length || !children.length) continue;
    const unionX = familyJunctionX(family, members, descendantPlan);
    const centers = [unionX, ...children.map(child => child.x + child.width / 2)];
    const geometry: FamilyBusGeometry = {
      family,
      children,
      busY: routedBusY.get(family.id) ?? 0,
      left: Math.min(...centers),
      right: Math.max(...centers),
    };
    for (const child of children) {
      const values = familyGeometriesByChild.get(child.occurrenceId);
      if (values) values.push(geometry);
      else familyGeometriesByChild.set(child.occurrenceId, [geometry]);
    }
  }

  // A canonical child may legitimately belong to multiple parent sets. If
  // their buses use different vertical lanes, a straight drop from the upper
  // bus would cross every lower bus. Keep the lowest route straight and give
  // each upper family a deterministic side/outer approach into the shared
  // card. The approach is part of that family's one horizontal bus.
  const sharedChildApproachByFamilyChild = new Map<
    string,
    SharedChildApproach
  >();
  const approachKey = (familyId: string, childId: string): string =>
    `${familyId}\u001f${childId}`;
  for (const [childId, geometries] of familyGeometriesByChild) {
    if (geometries.length < 2) continue;
    const child = nodesById.get(childId);
    if (!child) continue;
    const ordered = [...geometries].sort(
      (left, right) =>
        right.busY - left.busY ||
        compareCodePoints(left.family.id, right.family.id),
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const geometry = ordered[index]!;
      const lowerRoutes = ordered.slice(0, index);
      const candidates = [
        { side: "left" as const, x: child.x },
        { side: "right" as const, x: child.x + child.width },
      ].map(candidate => ({
        ...candidate,
        crossings: lowerRoutes.filter(
          route =>
            candidate.x >= route.left - 0.001 &&
            candidate.x <= route.right + 0.001,
        ).length,
      }));
      candidates.sort(
        (left, right) =>
          left.crossings - right.crossings ||
          Math.abs(left.x - (geometry.left + geometry.right) / 2) -
            Math.abs(right.x - (geometry.left + geometry.right) / 2) ||
          (left.side === "left" ? -1 : 1),
      );
      const chosen = candidates[0]!;
      let approachX = chosen.x;
      if (chosen.crossings > 0) {
        const laneOffset = 12 + index * SIBLING_BUS_LANE_GAP;
        const outerLeft = Math.min(...lowerRoutes.map(route => route.left)) - laneOffset;
        const outerRight = Math.max(...lowerRoutes.map(route => route.right)) + laneOffset;
        approachX = Math.abs(outerLeft - chosen.x) <= Math.abs(outerRight - chosen.x)
          ? outerLeft
          : outerRight;
      }
      sharedChildApproachByFamilyChild.set(
        approachKey(geometry.family.id, childId),
        {
          approachX,
          portX: chosen.side === "left" ? child.x : child.x + child.width,
          portY: child.y + child.height / 2,
        },
      );
    }
  }

  for (const family of families) {
    const members = family.memberOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node))
      .filter(
        node => node.kind !== "continuation" && node.kind !== "placeholder",
      )
      .sort(
        (a, b) =>
          a.x - b.x || compareCodePoints(a.occurrenceId, b.occurrenceId),
      );
    const children = family.childOccurrenceIds
      .map(id => nodesById.get(id))
      .filter((node): node is SceneNode => Boolean(node))
      .sort(
        (a, b) =>
          a.x - b.x || compareCodePoints(a.occurrenceId, b.occurrenceId),
    );
    if (members.length === 0) continue;

    const placement = sideFamilyPlacement(family.id, descendantPlan);
    const sideRoute = sideFamilyRouteGeometry(
      family,
      members,
      descendantPlan,
    );
    const unionX = familyJunctionX(family, members, descendantPlan);
    const parentBottom = Math.max(...members.map(node => node.y + node.height));
    const childTop = children.length
      ? Math.min(...children.map(node => node.y))
      : parentBottom + settings.generationGap;
    const verticalGap = Math.max(1, childTop - parentBottom);
    const unionY = parentBottom + Math.min(34, verticalGap * 0.28);
    const busY = children.length
      ? routedBusY.get(family.id) ?? unionY + (childTop - unionY) * 0.52
      : unionY;
    const partnership = preferredDisplayPartnership(family.unions);
    const partnershipLineY =
      partnership && members.length >= 2
        ? members[0]!.y +
          Math.min(...members.map(member => member.height)) * 0.52
        : unionY;
    const partnershipMembersAreAdjacent =
      partnership !== undefined &&
      members.length >= 2 &&
      members.slice(1).every((right, index) => {
        const left = members[index]!;
        return (
          right.x - (left.x + left.width) <= settings.partnerGap * 1.5
        );
      });
    const sideRailY = sideRoute?.lineY;
    const partnershipJunctionY =
      partnership && members.length >= 2
        ? sideRailY !== undefined
          ? sideRailY
          : partnershipMembersAreAdjacent
          ? partnershipLineY
          : unionY - 10
        : unionY;
    const layoutUnionY =
      sideRailY !== undefined
        ? sideRailY
        : partnership && children.length === 0
          ? partnershipJunctionY
          : unionY;

    for (const sceneUnion of family.unions) {
      const ownMembers = sceneUnion.memberOccurrenceIds
        .map(id => nodesById.get(id))
        .filter((node): node is SceneNode => Boolean(node))
        .filter(
          node => node.kind !== "continuation" && node.kind !== "placeholder",
        )
        .sort(
          (a, b) =>
            a.x - b.x || compareCodePoints(a.occurrenceId, b.occurrenceId),
        );
      const ownChildren = sceneUnion.childOccurrenceIds
        .map(id => nodesById.get(id))
        .filter((node): node is SceneNode => Boolean(node))
        .sort(
          (a, b) =>
            a.x - b.x || compareCodePoints(a.occurrenceId, b.occurrenceId),
        );
      unions.push({
        occurrenceId: sceneUnion.occurrenceId,
        unionId: sceneUnion.unionId,
        kind: sceneUnion.kind,
        generation: sceneUnion.generation,
        x: unionX,
        y: layoutUnionY,
        memberOccurrenceIds: ownMembers.map(node => node.occurrenceId),
        childOccurrenceIds: ownChildren.map(node => node.occurrenceId),
        ...(sceneUnion.status ? { status: sceneUnion.status } : {}),
      });
    }

    const anchorUnion = partnership ?? family.unions[0]!;
    const familyStemStartY =
      sideRailY ?? (partnership ? partnershipJunctionY : unionY);

    if (
      partnership &&
      placement &&
      sideRoute
    ) {
      edges.push({
        id: `${partnership.occurrenceId}:partner:1`,
        sourceId: sideRoute.hub.occurrenceId,
        targetId: sideRoute.partner.occurrenceId,
        unionOccurrenceId: partnership.occurrenceId,
        kind:
          partnership.status === "divorced" || partnership.status === "separated"
            ? "separated-partnership"
            : "partnership",
        points: [
          { x: sideRoute.hubPortX, y: sideRoute.lineY },
          { x: sideRoute.partnerPortX, y: sideRoute.lineY },
        ],
      });
    } else if (partnership && members.length >= 2) {
      for (let index = 1; index < members.length; index += 1) {
        const left = members[index - 1]!;
        const right = members[index]!;
        const adjacent =
          right.x - (left.x + left.width) <= settings.partnerGap * 1.5;
        const lineY = left.y + Math.min(left.height, right.height) * 0.52;
        const points: LayoutPoint[] = adjacent
          ? [
              { x: left.x + left.width, y: lineY },
              { x: right.x, y: lineY },
            ]
          : [
              { x: left.x + left.width / 2, y: left.y + left.height },
              { x: left.x + left.width / 2, y: unionY - 10 },
              { x: right.x + right.width / 2, y: unionY - 10 },
              { x: right.x + right.width / 2, y: right.y + right.height },
            ];
        edges.push({
          id: `${partnership.occurrenceId}:partner:${index}`,
          sourceId: left.occurrenceId,
          targetId: right.occurrenceId,
          unionOccurrenceId: partnership.occurrenceId,
          kind:
            partnership.status === "divorced" || partnership.status === "separated"
              ? "separated-partnership"
              : "partnership",
          points,
        });
      }
    } else if (sideRoute) {
      for (const member of members) {
          const portX = member.occurrenceId === sideRoute.hub.occurrenceId
            ? sideRoute.hubPortX
          : member.occurrenceId === sideRoute.partner.occurrenceId
            ? sideRoute.partnerPortX
            : member.x + member.width / 2;
        edges.push({
          id: `${family.id}:member:${member.occurrenceId}`,
          sourceId: member.occurrenceId,
          targetId: anchorUnion.occurrenceId,
          unionOccurrenceId: anchorUnion.occurrenceId,
          kind: "union-stem",
          points: [
            { x: portX, y: sideRoute.lineY },
            { x: sideRoute.junctionX, y: sideRoute.lineY },
          ],
        });
      }
    } else {
      for (const member of members) {
        edges.push({
          id: `${family.id}:member:${member.occurrenceId}`,
          sourceId: member.occurrenceId,
          targetId: anchorUnion.occurrenceId,
          unionOccurrenceId: anchorUnion.occurrenceId,
          kind: "union-stem",
          points: [
            { x: member.x + member.width / 2, y: member.y + member.height },
            { x: member.x + member.width / 2, y: unionY },
            { x: unionX, y: unionY },
          ],
        });
      }
    }

    if (children.length > 0) {
      edges.push({
        id: `${family.id}:family-stem`,
        sourceId: anchorUnion.occurrenceId,
        targetId: anchorUnion.occurrenceId,
        unionOccurrenceId: anchorUnion.occurrenceId,
        kind: "union-stem",
        points: [
          { x: unionX, y: familyStemStartY },
          { x: unionX, y: busY },
        ],
      });
      const childCenters = children.map(node =>
        sharedChildApproachByFamilyChild.get(
          approachKey(family.id, node.occurrenceId),
        )?.approachX ?? node.x + node.width / 2,
      );
      const busCenters = [unionX, ...childCenters];
      edges.push({
        id: `${family.id}:siblings`,
        sourceId: anchorUnion.occurrenceId,
        targetId: anchorUnion.occurrenceId,
        unionOccurrenceId: anchorUnion.occurrenceId,
        kind: "siblings-bus",
        points: [
          { x: Math.min(...busCenters), y: busY },
          { x: Math.max(...busCenters), y: busY },
        ],
      });

      for (const child of children) {
        const relations = familyRelationsForChild(family, child.occurrenceId);
        const sourceUnion =
          family.unions.find(
            union =>
              (union.relationByChildOccurrenceId.get(child.occurrenceId)?.length ??
                0) > 0,
          ) ?? anchorUnion;
        const kinds = uniqueKinds(relations);
        const kind = relationEdgeKind(kinds[0] ?? "unknown");
        const sharedApproach = sharedChildApproachByFamilyChild.get(
          approachKey(family.id, child.occurrenceId),
        );
        edges.push({
          id: `${family.id}:child:${child.occurrenceId}`,
          sourceId: sourceUnion.occurrenceId,
          targetId: child.occurrenceId,
          unionOccurrenceId: sourceUnion.occurrenceId,
          relationIds: relations.map(relation => relation.id),
          relationshipKinds: kinds,
          kind,
          points: sharedApproach
            ? [
                { x: sharedApproach.approachX, y: busY },
                { x: sharedApproach.approachX, y: sharedApproach.portY },
                { x: sharedApproach.portX, y: sharedApproach.portY },
              ]
            : [
                { x: child.x + child.width / 2, y: busY },
                { x: child.x + child.width / 2, y: child.y },
              ],
          ...(relations[0] ? { relationId: relations[0].id } : {}),
          ...(kinds.length > 1 ? { label: kinds.join(" / ") } : {}),
        });
      }
    }
  }

  return { unions, edges };
}

function computeBounds(
  nodes: readonly LayoutNode[],
  unions: readonly LayoutUnion[],
  edges: readonly LayoutEdge[],
): LayoutBounds {
  if (nodes.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const include = (point: LayoutPoint): void => {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  };
  for (const node of nodes) {
    include({ x: node.x, y: node.y });
    include({ x: node.x + node.width, y: node.y + node.height });
  }
  for (const union of unions) include(union);
  for (const edge of edges) for (const point of edge.points) include(point);
  const padding = 120;
  return {
    left: left - padding,
    top: top - padding,
    right: right + padding,
    bottom: bottom + padding,
  };
}

function buildGenerationBands(
  nodes: readonly LayoutNode[],
  settings: LayoutSettings,
): GenerationBand[] {
  const structuralNodes = nodes.filter(
    node => node.kind !== "continuation" && node.kind !== "placeholder",
  );
  const generations = [...new Set(structuralNodes.map(node => node.generation))].sort(
    (a, b) => b - a,
  );
  return generations.map(generation => {
    const layer = structuralNodes.filter(node => node.generation === generation);
    const top = Math.min(...layer.map(node => node.y)) - settings.generationGap * 0.18;
    const bottom =
      Math.max(...layer.map(node => node.y + node.height)) +
      settings.generationGap * 0.18;
    const label =
      generation === 0
        ? "Фокусне покоління"
        : generation > 0
          ? `${generation} покоління предків`
          : `${Math.abs(generation)} покоління нащадків`;
    return { generation, top, bottom, label };
  });
}

function allCoordinatesFinite(
  nodes: readonly LayoutNode[],
  unions: readonly LayoutUnion[],
  edges: readonly LayoutEdge[],
): boolean {
  return (
    nodes.every(node =>
      [node.x, node.y, node.width, node.height, node.generation].every(Number.isFinite),
    ) &&
    unions.every(union =>
      [union.x, union.y, union.generation].every(Number.isFinite),
    ) &&
    edges.every(edge =>
      edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
    )
  );
}

/**
 * Pure deterministic layout entry point. Run it in the provided Web Worker in
 * the UI; call it directly only in tests, SSR-free tools, or small previews.
 */
export function layoutGraphEngine(
  input: FamilyTreeLayoutInput,
  mode: LayoutEngineMode,
): LayoutResult {
  const settings = normalizedSettings(input);
  // Reuse the same weakly cached canonical index as scene construction instead
  // of rebuilding a second 10k+ person map on every visual reflow.
  const personsById = buildGraphIndex(input.graph).personsById;
  const scene = buildOccurrenceScene(input.graph, input.options);
  if (scene.nodes.length === 0) {
    return {
      nodes: [],
      unions: [],
      edges: [],
      bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      generationBands: [],
      warnings: scene.warnings,
      ...(scene.focusOccurrenceId
        ? { focusOccurrenceId: scene.focusOccurrenceId }
        : {}),
    };
  }

  const configuredLineage = buildConfiguredDirectLineage(scene, settings);

  const { bundles, bundleByOccurrenceId } = buildBundles(scene, settings);
  const layers = initializeLayers(
    bundles,
    settings,
    scene,
    bundleByOccurrenceId,
    personsById,
  );
  const structuralFamilies = structuralFamilyBlocks(scene.unions);
  let descendantLayoutPlan: DescendantLayoutPlan | undefined;
  if (mode === "descendant-forest") {
    descendantLayoutPlan = planDescendantForest(
      scene,
      bundles,
      bundleByOccurrenceId,
      layers,
      settings,
      false,
      true,
    );
    // A shared-child DAG cannot be represented as one rigid tree contour.
    // Keep its deterministic generation packing, but never fall through to
    // the pedigree barycentric/direct-ancestor solvers.
    if (!descendantLayoutPlan) {
      descendantLayoutPlan = packDescendantFallbackLayers(
        scene,
        bundles,
        layers,
        bundleByOccurrenceId,
        settings,
      );
    }
  } else {
    solveBundlePositions(
      scene,
      bundles,
      bundleByOccurrenceId,
      layers,
      settings,
      structuralFamilies,
    );
  }
  const structuralNodes = positionNodes(bundles, settings);
  if (mode === "family-graph") {
    descendantLayoutPlan = applyDirectAncestorGrid(
      scene,
      structuralNodes,
      settings,
      personsById,
    );
  }
  const structuralNodesById = new Map(
    structuralNodes.map(node => [node.occurrenceId, node]),
  );
  const siblingBusLanePlan = createSiblingBusLanePlan(
    structuralFamilies,
    structuralNodesById,
    descendantLayoutPlan,
  );
  positionGenerationRows(
    structuralNodes,
    settings,
    requiredGenerationGapByCorridor(
      siblingBusLanePlan,
      settings.generationGap,
    ),
  );
  const nodes = positionAuxiliaryNodes(scene, structuralNodes);
  applyConfiguredDirectLineage(nodes, configuredLineage);
  const routed = routeEdges(
    scene,
    nodes,
    settings,
    structuralFamilies,
    siblingBusLanePlan,
    descendantLayoutPlan,
  );
  const bounds = computeBounds(nodes, routed.unions, routed.edges);
  const generationBands = buildGenerationBands(nodes, settings);
  const warnings = [...scene.warnings];
  if (!allCoordinatesFinite(nodes, routed.unions, routed.edges)) {
    warnings.push({
      code: "INVALID_COORDINATE",
      message: "Розкладка повернула некоректну координату.",
    });
  }

  return {
    nodes,
    unions: routed.unions,
    edges: routed.edges,
    bounds,
    generationBands,
    warnings,
    ...(scene.focusOccurrenceId
      ? { focusOccurrenceId: scene.focusOccurrenceId }
      : {}),
  };
}
