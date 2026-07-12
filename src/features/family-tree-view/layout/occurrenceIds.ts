import type { OccurrenceId } from "../types.ts";

function segment(value: string): string {
  return `${value.length}:${value}`;
}

/** FNV-1a 64-bit. Deterministic and dependency-free; not a security hash. */
export function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(36);
}

export function rootPath(personId: string): string {
  return `root|${segment(personId)}`;
}

export function extendPath(
  parentPath: string,
  direction: string,
  relationshipId: string,
  personId: string,
): string {
  return [
    parentPath,
    segment(direction),
    segment(relationshipId),
    segment(personId),
  ].join("|");
}

export function personOccurrenceId(
  personId: string,
  path: string,
  reference: boolean,
): OccurrenceId {
  return `${reference ? "ref" : "person"}:${personId}:${stableHash(path)}`;
}

export function unionOccurrenceId(unionId: string, generation: number): OccurrenceId {
  return `union:${unionId}:g${String(generation).replace("-", "m")}`;
}

export function continuationOccurrenceId(
  sourceOccurrenceId: OccurrenceId,
  continuationId: string,
): OccurrenceId {
  return `continuation:${stableHash(`${sourceOccurrenceId}|${continuationId}`)}`;
}

export function placeholderOccurrenceId(
  unionOccurrence: OccurrenceId,
  slot: number,
): OccurrenceId {
  return `placeholder:${stableHash(`${unionOccurrence}|${slot}`)}`;
}
