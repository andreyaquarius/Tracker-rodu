/** Shared structured name inputs for tree nodes and full person cards. */
export interface PersonTreeNameSource {
  id: string;
  surname?: string;
  maidenSurname?: string;
  givenName?: string;
  patronymic?: string;
  fullName?: string;
}

export interface PersonTreeNameVariant {
  nameType: string;
  surname: string;
  givenName: string;
  patronymic: string;
  fullName: string;
  originalText: string;
  isPrimary: boolean;
  isPreferred: boolean;
}

export function personTreeNameFields(profile: PersonTreeNameSource, names: readonly PersonTreeNameVariant[] = []) {
  const preferredName = names.find(name => name.isPrimary) ?? names.find(name => name.isPreferred) ?? names[0];
  const givenName = preferredName?.givenName || profile.givenName;
  const surname = preferredName?.surname || profile.surname;
  const patronymic = preferredName?.patronymic || profile.patronymic;
  const birthName = names.find(name => name.nameType === "birth" || name.nameType === "maiden");
  const marriedName = names.find(name => name.nameType === "married");
  const maidenSurname = birthName?.surname || profile.maidenSurname;
  const marriedSurname = marriedName?.surname || (
    maidenSurname && profile.surname !== maidenSurname ? profile.surname : ""
  );
  const structured = [profile.surname, profile.givenName, profile.patronymic].map(part => part?.trim()).filter(Boolean).join(" ");
  const storedFullName = profile.fullName?.trim().replace(/\s+/g, " ") || "";
  // Legacy imports can keep the patronymic only in fullName. Retain that
  // suffix, but do not let an unrelated/stale fullName overwrite edited fields.
  const legacyLabel = !patronymic && structured && storedFullName.toLocaleLowerCase("uk").startsWith(`${structured.toLocaleLowerCase("uk")} `)
    ? storedFullName : structured;
  const displayName = preferredName?.fullName || preferredName?.originalText || legacyLabel || profile.fullName || profile.id;
  return {
    displayName,
    ...(givenName ? { givenName } : {}),
    ...(surname ? { surname } : {}),
    ...(patronymic ? { patronymic } : {}),
    ...(maidenSurname ? { maidenSurname } : {}),
    ...(marriedSurname ? { marriedSurname } : {}),
  };
}
