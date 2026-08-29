import type { Finding, FindingParticipant } from "../types/index.ts";

export interface StoredFindingParticipant {
  id: string;
  person_id: string | null;
  name: string;
  role: string;
  notes: string;
}

/** Restores the optional canonical-person link without breaking legacy rows. */
export function findingParticipantFromStorage(
  row: StoredFindingParticipant,
): FindingParticipant {
  return {
    id: row.id,
    personId: row.person_id ?? undefined,
    name: row.name,
    role: row.role,
    notes: row.notes,
  };
}

/**
 * Persists only links that belong to the current project snapshot. A stale or
 * missing link is safely downgraded to the existing text-only participant.
 */
export function findingParticipantPersonIdForStorage(
  participant: Pick<FindingParticipant, "personId">,
  validPersonIds?: ReadonlySet<string>,
): string | null {
  const personId = participant.personId?.trim() ?? "";
  if (!personId) return null;
  if (validPersonIds && !validPersonIds.has(personId)) return null;
  return personId;
}

/**
 * Returns every person linked to a finding, regardless of whether the link
 * comes from the legacy general-person list or a structured participant.
 * This is a read projection only: it must not be copied back into personIds.
 */
export function findingLinkedPersonIds(
  finding: Pick<Finding, "personIds" | "participants">,
): string[] {
  const result = new Set<string>();
  for (const rawId of finding.personIds ?? []) {
    const personId = rawId.trim();
    if (personId) result.add(personId);
  }
  for (const participant of finding.participants ?? []) {
    const personId = participant.personId?.trim() ?? "";
    if (personId) result.add(personId);
  }
  return [...result];
}

export function findingLinksPerson(
  finding: Pick<Finding, "personIds" | "participants">,
  personId: string,
): boolean {
  const normalized = personId.trim();
  if (!normalized) return false;
  return (finding.personIds ?? []).some((id) => id.trim() === normalized) ||
    (finding.participants ?? []).some((participant) => participant.personId?.trim() === normalized);
}

export function findingLinksAnyPerson(
  finding: Pick<Finding, "personIds" | "participants">,
  personIds: ReadonlySet<string>,
): boolean {
  return (finding.personIds ?? []).some((personId) => personIds.has(personId.trim())) ||
    (finding.participants ?? []).some((participant) => {
      const personId = participant.personId?.trim() ?? "";
      return Boolean(personId) && personIds.has(personId);
    });
}

/**
 * Keeps legacy general links only when they are not already represented by a
 * structured participant. This prevents a later participant unlink from
 * leaving an invisible duplicate link behind.
 */
export function findingStandalonePersonIds(
  finding: Pick<Finding, "personIds" | "participants">,
): string[] {
  const participantPersonIds = new Set(
    (finding.participants ?? [])
      .map((participant) => participant.personId?.trim() ?? "")
      .filter(Boolean),
  );
  return [...new Set(
    (finding.personIds ?? [])
      .map((personId) => personId.trim())
      .filter((personId) => personId && !participantPersonIds.has(personId)),
  )];
}
