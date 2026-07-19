import type { Person } from "../../types";

export type PersonsModuleV2Mode = "list" | "profile" | "edit" | "new";

export type PersonSaveHandler = (
  person: Person,
) => Promise<Person | null | void> | Person | null | void;

export interface PersonRouteTarget {
  mode: PersonsModuleV2Mode;
  personId?: string;
}

export async function savePersonAndClose(
  onSave: PersonSaveHandler,
  person: Person,
  onClose: () => void,
): Promise<Person | null | void> {
  const result = await onSave(person);
  if (result !== null) onClose();
  return result;
}
