/**
 * Splits participant import rows around their self-referential target FK.
 *
 * Large imports are sent in concurrent chunks, so a source row can arrive
 * before a target in another request. The first pass creates every
 * participant with a null target; the second pass links only rows that have a
 * validated explicit target after every referenced row exists.
 */
export function prepareFindingParticipantImportPasses<
  Row extends { context_target_participant_id: string | null },
>(rows: readonly Row[]): { baseRows: Row[]; targetRows: Row[] } {
  return {
    baseRows: rows.map((row) => ({ ...row, context_target_participant_id: null })),
    targetRows: rows.filter((row) => Boolean(row.context_target_participant_id)),
  };
}
