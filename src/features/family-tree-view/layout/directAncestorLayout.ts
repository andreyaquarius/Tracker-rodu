import type { OccurrenceId } from "../types.ts";

export interface DirectAncestorGridItem {
  occurrenceId: OccurrenceId;
  width: number;
  /** Occupied width to the left/right of the direct person's center. */
  leftExtent?: number;
  rightExtent?: number;
  /**
   * Occupied horizontal contour per absolute generation. The contour contains
   * the direct card and every collateral card owned by this ancestor sector.
   */
  contourByGeneration?: ReadonlyMap<
    number,
    { readonly left: number; readonly right: number }
  >;
  /** Side of this parent relative to the direct child at the previous path. */
  side?: "paternal" | "maternal";
  /** Stable semantic path: paternal token first, maternal token second. */
  path: readonly number[];
}

export interface DirectAncestorGridOptions {
  sectorGap: number;
}

export interface DirectAncestorGridResult {
  centerByOccurrenceId: ReadonlyMap<OccurrenceId, number>;
  left: number;
  right: number;
}

interface TrieNode {
  item?: DirectAncestorGridItem;
  children: Map<number, TrieNode>;
}

interface RelativeLayout {
  centers: Map<OccurrenceId, number>;
  left: number;
  right: number;
  contourByGeneration: Map<number, { left: number; right: number }>;
}

function comparePaths(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function translated(
  layout: RelativeLayout,
  shift: number,
): RelativeLayout {
  return {
    centers: new Map(
      [...layout.centers].map(([occurrenceId, center]) => [
        occurrenceId,
        center + shift,
      ]),
    ),
    left: layout.left + shift,
    right: layout.right + shift,
    contourByGeneration: new Map(
      [...layout.contourByGeneration].map(([generation, contour]) => [
        generation,
        { left: contour.left + shift, right: contour.right + shift },
      ]),
    ),
  };
}

function mergeInto(
  target: RelativeLayout,
  source: RelativeLayout,
): void {
  for (const [occurrenceId, center] of source.centers) {
    target.centers.set(occurrenceId, center);
  }
  target.left = Math.min(target.left, source.left);
  target.right = Math.max(target.right, source.right);
  for (const [generation, contour] of source.contourByGeneration) {
    const current = target.contourByGeneration.get(generation);
    if (current) {
      current.left = Math.min(current.left, contour.left);
      current.right = Math.max(current.right, contour.right);
    } else {
      target.contourByGeneration.set(generation, { ...contour });
    }
  }
}

function requiredLeftShift(
  leftLayout: RelativeLayout,
  rightLayout: RelativeLayout,
  gap: number,
): number {
  let shift = 0;
  for (const [generation, leftContour] of leftLayout.contourByGeneration) {
    const rightContour = rightLayout.contourByGeneration.get(generation);
    if (!rightContour) continue;
    shift = Math.max(
      shift,
      leftContour.right + gap - rightContour.left,
    );
  }
  return Math.max(0, shift);
}

function requiredSymmetricShift(
  leftLayout: RelativeLayout,
  centerLayout: RelativeLayout,
  rightLayout: RelativeLayout,
  gap: number,
): number {
  let shift = 0;
  for (const [generation, leftContour] of leftLayout.contourByGeneration) {
    const centerContour = centerLayout.contourByGeneration.get(generation);
    if (centerContour) {
      shift = Math.max(
        shift,
        leftContour.right + gap - centerContour.left,
      );
    }
    const rightContour = rightLayout.contourByGeneration.get(generation);
    if (rightContour) {
      shift = Math.max(
        shift,
        (leftContour.right + gap - rightContour.left) / 2,
      );
    }
  }
  for (const [generation, centerContour] of centerLayout.contourByGeneration) {
    const rightContour = rightLayout.contourByGeneration.get(generation);
    if (!rightContour) continue;
    shift = Math.max(
      shift,
      centerContour.right + gap - rightContour.left,
    );
  }
  return Math.max(0, shift);
}

function layoutTrie(
  node: TrieNode,
  sectorGap: number,
): RelativeLayout | undefined {
  if (!node.item || node.children.size > 2) return undefined;
  const leftExtent = node.item.leftExtent ?? node.item.width / 2;
  const rightExtent = node.item.rightExtent ?? node.item.width / 2;
  const contourByGeneration = new Map(
    [...(node.item.contourByGeneration ?? new Map())].map(
      ([generation, contour]) => [generation, { ...contour }],
    ),
  );
  const cardGeneration = node.item.path.length;
  const cardContour = contourByGeneration.get(cardGeneration);
  if (cardContour) {
    cardContour.left = Math.min(cardContour.left, -node.item.width / 2);
    cardContour.right = Math.max(cardContour.right, node.item.width / 2);
  } else {
    contourByGeneration.set(cardGeneration, {
      left: -node.item.width / 2,
      right: node.item.width / 2,
    });
  }
  const result: RelativeLayout = {
    centers: new Map([[node.item.occurrenceId, 0]]),
    left: -leftExtent,
    right: rightExtent,
    contourByGeneration,
  };
  const childLayouts = [...node.children]
    .sort(([leftToken], [rightToken]) => leftToken - rightToken)
    .map(([token, child]) => ({
      token,
      side: child.item?.side,
      layout: layoutTrie(child, sectorGap),
    }));
  if (childLayouts.some(entry => !entry.layout)) return undefined;

  if (childLayouts.length === 1) {
    // A missing parent never reserves an empty half-tree. The known ancestor
    // stays directly above the child unless one of its collateral cards uses
    // the child's row. In that case the whole parent branch moves outward.
    const childEntry = childLayouts[0]!;
    const child = childEntry.layout!;
    const inferredMaternal =
      childEntry.token === 1 ||
      Math.floor(childEntry.token / 1_000_000) > 3;
    const maternal =
      childEntry.side === "maternal" ||
      (childEntry.side === undefined && inferredMaternal);
    const shift =
      maternal
        ? requiredLeftShift(result, child, sectorGap)
        : requiredLeftShift(child, result, sectorGap);
    mergeInto(result, translated(child, maternal ? shift : -shift));
    return result;
  }
  if (childLayouts.length === 2) {
    const paternal = childLayouts[0]!.layout!;
    const maternal = childLayouts[1]!.layout!;
    const halfGap = sectorGap / 2;
    // Symmetric placement is the hard pedigree constraint: the current person
    // is exactly below the midpoint of both parents. Considering whole subtree
    // extents additionally keeps every paternal occurrence left of the local
    // axis and every maternal occurrence right of it.
    const halfDistance = Math.max(
      1,
      paternal.right + halfGap,
      halfGap - maternal.left,
      requiredSymmetricShift(paternal, result, maternal, sectorGap),
    );
    mergeInto(result, translated(paternal, -halfDistance));
    mergeInto(result, translated(maternal, halfDistance));
  }
  return result;
}

/**
 * Deterministic compact grid for a pure direct pedigree. It reserves space
 * only for ancestors that actually exist and deliberately ignores continuation
 * controls and missing-parent actions.
 */
export function layoutDirectAncestors(
  items: readonly DirectAncestorGridItem[],
  options: DirectAncestorGridOptions,
): DirectAncestorGridResult | undefined {
  const ordered = [...items].sort(
    (left, right) =>
      comparePaths(left.path, right.path) ||
      left.occurrenceId.localeCompare(right.occurrenceId),
  );
  if (
    ordered.length === 0 ||
    ordered.some(
      item => {
        const leftExtent = item.leftExtent ?? item.width / 2;
        const rightExtent = item.rightExtent ?? item.width / 2;
        return (
          !Number.isFinite(item.width) ||
          item.width <= 0 ||
          !Number.isFinite(leftExtent) ||
          !Number.isFinite(rightExtent) ||
          leftExtent < item.width / 2 ||
          rightExtent < item.width / 2 ||
          [...(item.contourByGeneration ?? new Map())].some(
            ([generation, contour]) =>
              !Number.isFinite(generation) ||
              !Number.isFinite(contour.left) ||
              !Number.isFinite(contour.right) ||
              contour.left > contour.right,
          ) ||
          item.path.some(token => !Number.isFinite(token))
        );
      },
    )
  ) {
    return undefined;
  }

  const root: TrieNode = { children: new Map() };
  for (const item of ordered) {
    let cursor = root;
    for (const token of item.path) {
      let child = cursor.children.get(token);
      if (!child) {
        child = { children: new Map() };
        cursor.children.set(token, child);
      }
      cursor = child;
    }
    if (cursor.item) return undefined;
    cursor.item = item;
  }

  const layout = layoutTrie(
    root,
    Math.max(1, Number.isFinite(options.sectorGap) ? options.sectorGap : 1),
  );
  if (!layout || layout.centers.size !== ordered.length) return undefined;
  return {
    centerByOccurrenceId: layout.centers,
    left: layout.left,
    right: layout.right,
  };
}
