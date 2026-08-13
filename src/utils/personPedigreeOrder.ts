export interface PersonPedigreeOccurrenceRank {
  personId: string;
  slot: number;
}

export interface PersonPedigreeRanks {
  familyOrder: ReadonlyMap<string, number>;
  directAncestorIds: ReadonlySet<string>;
}

export interface PersonPedigreeAncestorOrderRow {
  person_id: string;
  generation: number | string;
  order_path: string;
}

export interface PedigreeKinshipRank {
  kind: "root" | "ancestor" | "descendant" | "collateral" | "affinal";
  upSteps: number;
  downSteps: number;
  partnerSteps: number;
  orderPath: string;
  viaPersonId?: string;
}

/** Converts sparse Ahnentafel occurrences into one stable rank per person. */
export function pedigreeRanksFromOccurrences(
  centralPersonId: string,
  occurrences: readonly PersonPedigreeOccurrenceRank[],
): PersonPedigreeRanks {
  const firstSlotByPerson = new Map<string, number>();
  for (const occurrence of occurrences) {
    const currentSlot = firstSlotByPerson.get(occurrence.personId);
    if (currentSlot === undefined || occurrence.slot < currentSlot) {
      firstSlotByPerson.set(occurrence.personId, occurrence.slot);
    }
  }

  const orderedIds = [...firstSlotByPerson]
    .sort(([firstId, firstSlot], [secondId, secondSlot]) => (
      firstSlot - secondSlot || firstId.localeCompare(secondId)
    ))
    .map(([personId]) => personId);
  return {
    familyOrder: new Map(orderedIds.map((personId, index) => [personId, index])),
    directAncestorIds: new Set(orderedIds.filter((personId) => personId !== centralPersonId)),
  };
}

/**
 * Converts the complete server-side ancestor traversal into one stable rank
 * per person. Unlike Ahnentafel occurrences this representation is not tied
 * to the 16-generation visualisation limit and therefore remains complete for
 * the persons catalogue.
 */
export function pedigreeRanksFromAncestorOrderRows(
  centralPersonId: string,
  rows: readonly PersonPedigreeAncestorOrderRow[],
): PersonPedigreeRanks {
  const bestRowByPerson = new Map<string, {
    generation: number;
    orderPath: string;
  }>();
  for (const row of rows) {
    const personId = row.person_id?.trim();
    const generation = Number(row.generation);
    if (!personId || !Number.isInteger(generation) || generation < 0) continue;
    const orderPath = typeof row.order_path === "string" ? row.order_path : "";
    const current = bestRowByPerson.get(personId);
    if (
      !current ||
      generation < current.generation ||
      (generation === current.generation && orderPath < current.orderPath)
    ) {
      bestRowByPerson.set(personId, { generation, orderPath });
    }
  }

  // The persisted root is authoritative even while an older database version
  // is being upgraded and has not returned the generation-zero row yet.
  bestRowByPerson.set(centralPersonId, { generation: 0, orderPath: "" });
  const orderedIds = [...bestRowByPerson]
    .sort(([firstId, first], [secondId, second]) => (
      first.generation - second.generation ||
      compareCodePoints(first.orderPath, second.orderPath) ||
      compareCodePoints(firstId, secondId)
    ))
    .map(([personId]) => personId);
  return {
    familyOrder: new Map(orderedIds.map((personId, index) => [personId, index])),
    directAncestorIds: new Set(
      orderedIds.filter((personId) => personId !== centralPersonId),
    ),
  };
}

/** Direct-ancestor results are authoritative over broader kinship labels. */
export function mergeCanonicalAncestorKinship<T extends PedigreeKinshipRank>(
  broaderKinship: ReadonlyMap<string, T>,
  canonicalKinship: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  const result = new Map(broaderKinship);
  for (const [personId, kinship] of canonicalKinship) {
    result.set(personId, kinship);
  }
  return result;
}

/** Keeps Ahnentafel people first and appends other relatives once. */
export function mergeCanonicalFamilyOrder(
  canonicalAncestorOrder: ReadonlyMap<string, number>,
  broaderFamilyOrder: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const orderedIds = [...canonicalAncestorOrder.keys()];
  for (const personId of broaderFamilyOrder.keys()) {
    if (!canonicalAncestorOrder.has(personId)) orderedIds.push(personId);
  }
  return new Map(orderedIds.map((personId, index) => [personId, index]));
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
