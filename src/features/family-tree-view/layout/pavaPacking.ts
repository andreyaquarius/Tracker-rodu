export interface PackItem {
  id: string;
  width: number;
  desiredX: number;
  weight: number;
  /** Optional hierarchical gap from the previous item in semantic order. */
  gapBefore?: number;
}

interface PavaBlock {
  start: number;
  end: number;
  weight: number;
  weightedSum: number;
}

/**
 * Weighted isotonic regression with per-item widths. It solves the layer's
 * no-overlap constraints in O(n) once semantic order is fixed.
 */
export function packLayer(
  items: readonly PackItem[],
  gap: number,
): ReadonlyMap<string, number> {
  if (items.length === 0) return new Map();

  const offsets = new Array<number>(items.length).fill(0);
  for (let index = 1; index < items.length; index += 1) {
    offsets[index] =
      offsets[index - 1]! +
      items[index - 1]!.width / 2 +
      (items[index]!.gapBefore ?? gap) +
      items[index]!.width / 2;
  }

  const targets = items.map(
    (item, index) => item.desiredX - offsets[index]!,
  );
  const blocks: PavaBlock[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const weight = Math.max(Number.EPSILON, items[index]!.weight);
    blocks.push({
      start: index,
      end: index,
      weight,
      weightedSum: weight * targets[index]!,
    });

    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1]!;
      const left = blocks[blocks.length - 2]!;
      const leftMean = left.weightedSum / left.weight;
      const rightMean = right.weightedSum / right.weight;
      if (leftMean <= rightMean) break;
      blocks.splice(blocks.length - 2, 2, {
        start: left.start,
        end: right.end,
        weight: left.weight + right.weight,
        weightedSum: left.weightedSum + right.weightedSum,
      });
    }
  }

  const result = new Map<string, number>();
  for (const block of blocks) {
    const base = block.weightedSum / block.weight;
    for (let index = block.start; index <= block.end; index += 1) {
      result.set(items[index]!.id, base + offsets[index]!);
    }
  }
  return result;
}
