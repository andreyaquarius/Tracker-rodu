export interface PersonPedigreeOccurrenceRank {
  personId: string;
  slot: number;
}

export interface PersonPedigreeRanks {
  familyOrder: ReadonlyMap<string, number>;
  directAncestorIds: ReadonlySet<string>;
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
