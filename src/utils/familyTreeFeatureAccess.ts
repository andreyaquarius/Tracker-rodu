export function resolveFamilyTreeFeatureAccess(input: {
  isAppAdmin: boolean;
  serverAllowed: boolean;
  serverLoading: boolean;
}): boolean {
  return input.isAppAdmin || (input.serverAllowed && !input.serverLoading);
}

interface FamilyTreeAccessSearchUser {
  displayName: string;
  email: string;
}

interface FamilyTreeAccessCandidate extends FamilyTreeAccessSearchUser {
  isAdmin: boolean;
  isEnabled: boolean;
}

function normalizeFamilyTreeAccessSearch(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("uk-UA");
}

export function matchesFamilyTreeAccessSearch(
  user: FamilyTreeAccessSearchUser,
  query: string,
): boolean {
  const normalizedQuery = normalizeFamilyTreeAccessSearch(query);
  if (!normalizedQuery) return true;

  const searchableText = normalizeFamilyTreeAccessSearch(
    `${user.displayName} ${user.email}`,
  );

  return normalizedQuery
    .split(/\s+/u)
    .every((part) => searchableText.includes(part));
}

export function filterFamilyTreeAccessCandidates<
  T extends FamilyTreeAccessCandidate,
>(users: readonly T[], query: string): T[] {
  if (!normalizeFamilyTreeAccessSearch(query)) return [];

  return users.filter(
    (user) => !user.isAdmin
      && !user.isEnabled
      && matchesFamilyTreeAccessSearch(user, query),
  );
}
