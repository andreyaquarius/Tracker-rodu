import type { FindingParticipant } from "../types/index.ts";

export interface ParsedFindingParticipantTableCell {
  participant: FindingParticipant | null;
  rejectedPersonId?: string;
}

/**
 * Parses one participant column from the module XLSX/CSV format. A card id is
 * accepted only when it exists in the current project snapshot; the text role
 * and name remain importable when an old or foreign card id is rejected.
 */
export function parseFindingParticipantTableCell(
  value: string | undefined,
  participantId: string,
  validPersonIds?: ReadonlySet<string>,
): ParsedFindingParticipantTableCell {
  const text = String(value ?? "").trim();
  if (!text) return { participant: null };

  let requestedPersonId: string | undefined;
  const contentLines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => {
      const match = line.match(/^ID картки особи\s*:\s*(.+)$/iu);
      if (!match) return Boolean(line);
      requestedPersonId = match[1]?.trim() || undefined;
      return false;
    });
  const parts = (contentLines.length === 1 ? contentLines[0].split(":") : contentLines)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return { participant: null };

  const personId = requestedPersonId && (!validPersonIds || validPersonIds.has(requestedPersonId))
    ? requestedPersonId
    : undefined;
  const rejectedPersonId = requestedPersonId && !personId ? requestedPersonId : undefined;
  const participant = parts.length === 1
    ? { id: participantId, personId, role: "основна особа", name: parts[0], notes: "" }
    : {
        id: participantId,
        personId,
        role: parts[0] || "основна особа",
        name: parts[1] || parts[0],
        notes: parts.slice(2).join("; "),
      };

  return { participant, rejectedPersonId };
}
