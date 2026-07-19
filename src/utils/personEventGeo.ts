import type { PersonEvent, PersonEventType } from "../types/index.ts";
import { personEventLabel } from "./geo.ts";
import { createId } from "./id.ts";

/** Updates exactly one event, which is essential when a person has repeated events of one type. */
export function updatePersonEventById(
  events: readonly PersonEvent[],
  eventId: string,
  patch: Partial<PersonEvent>,
): PersonEvent[] {
  return events.map((event) => (
    event.id === eventId ? { ...event, ...patch } : event
  ));
}

export function createPersonMapEvent(
  personId: string,
  type: PersonEventType = "other",
): PersonEvent {
  return {
    id: createId(),
    personId,
    type,
    title: personEventLabel(type),
    date: null,
    placeName: null,
    geo: null,
    notes: null,
  };
}
