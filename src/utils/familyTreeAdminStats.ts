export type FamilyTreeAdminVitalStatusPerson = {
  is_living: boolean | null;
  death_date: string | null;
};

export function isLivingAdminPerson(person: FamilyTreeAdminVitalStatusPerson): boolean {
  return person.is_living === true && !hasText(person.death_date);
}

export function isDeceasedAdminPerson(person: FamilyTreeAdminVitalStatusPerson): boolean {
  return person.is_living === false || hasText(person.death_date);
}

export function isUnknownVitalStatusAdminPerson(person: FamilyTreeAdminVitalStatusPerson): boolean {
  return !isLivingAdminPerson(person) && !isDeceasedAdminPerson(person);
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}
