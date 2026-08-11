import type {
  FamilyTreeAppearancePreferences,
  MarriedSurnameDisplay,
} from "../../../utils/familyTreeAppearance.ts";
import type {
  FamilyGraphData,
  TreePerson,
  TreeUnion,
} from "../types.ts";

export interface FamilyTreeNameProfile {
  id: string;
  surname?: string;
  maidenSurname?: string;
  givenName?: string;
  patronymic?: string;
  gender?: string;
}

export type FamilyTreeNameDisplayPreferences = Pick<
  FamilyTreeAppearancePreferences,
  "marriedSurnameDisplay" | "inferMarriedSurnameFromHusband"
>;

interface StructuredName {
  baseSurname: string;
  maidenSurname: string;
  marriedSurname: string;
  givenName: string;
  patronymic: string;
}

/**
 * Applies a display-only surname rule to women in a renderer graph.
 * Canonical profile values and relationship records are never mutated.
 */
export function applyFamilyTreeNameDisplay(
  graph: FamilyGraphData,
  preferences: FamilyTreeNameDisplayPreferences,
  profiles: readonly FamilyTreeNameProfile[] = [],
): FamilyGraphData {
  if (!graph.persons.length) return graph;

  const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
  const peopleById = new Map(graph.persons.map(person => [person.id, person]));
  const husbandSurnameByPerson = preferences.inferMarriedSurnameFromHusband
    ? inferHusbandSurnames(graph, peopleById, profilesById)
    : new Map<string, string>();
  let changed = false;
  const persons = graph.persons.map(person => {
    if (isMasked(person) || !isFemale(person, profilesById.get(person.id))) {
      return person;
    }
    const structured = structuredName(person, profilesById.get(person.id));
    const marriedSurname = structured.marriedSurname ||
      husbandSurnameByPerson.get(person.id) || "";
    const surnameLabel = displaySurname(
      preferences.marriedSurnameDisplay,
      structured.baseSurname,
      structured.maidenSurname,
      marriedSurname,
    );
    const displayName = [
      surnameLabel,
      displayNameSuffix(person, structured),
    ].filter(Boolean).join(" ");
    if (!displayName || displayName === person.displayName) return person;
    changed = true;
    return { ...person, displayName };
  });

  return changed ? { ...graph, persons } : graph;
}

function inferHusbandSurnames(
  graph: FamilyGraphData,
  peopleById: ReadonlyMap<string, TreePerson>,
  profilesById: ReadonlyMap<string, FamilyTreeNameProfile>,
): Map<string, string> {
  const result = new Map<string, string>();
  const partnerships = graph.unions
    .filter(union => union.kind === "partnership")
    .map((union, index) => ({ union, index }))
    .sort((left, right) =>
      partnershipRank(left.union) - partnershipRank(right.union) ||
      compareOrder(left.union.displayOrder, right.union.displayOrder) ||
      left.index - right.index
    );

  for (const { union } of partnerships) {
    for (const personId of union.memberIds) {
      if (result.has(personId)) continue;
      const person = peopleById.get(personId);
      if (!person || isMasked(person) || !isFemale(person, profilesById.get(personId))) {
        continue;
      }
      const husband = union.memberIds
        .filter(memberId => memberId !== personId)
        .map(memberId => ({
          person: peopleById.get(memberId),
          profile: profilesById.get(memberId),
        }))
        .find(candidate =>
          candidate.person &&
          !isMasked(candidate.person) &&
          isMale(candidate.person, candidate.profile)
        );
      if (!husband?.person) continue;
      const surname = structuredName(husband.person, husband.profile).baseSurname;
      if (surname) result.set(personId, surname);
    }
  }
  return result;
}

function structuredName(
  person: TreePerson,
  profile?: FamilyTreeNameProfile,
): StructuredName {
  const baseSurname = clean(profile?.surname) || clean(person.surname);
  const maidenSurname = clean(profile?.maidenSurname) ||
    clean(person.maidenSurname);
  const explicitMarriedSurname = clean(person.marriedSurname) || (
    maidenSurname && baseSurname && !sameName(maidenSurname, baseSurname)
      ? baseSurname
      : ""
  );
  return {
    baseSurname,
    maidenSurname,
    marriedSurname: explicitMarriedSurname,
    givenName: clean(profile?.givenName) || clean(person.givenName),
    patronymic: clean(profile?.patronymic) || clean(person.patronymic),
  };
}

function displaySurname(
  mode: MarriedSurnameDisplay,
  baseSurname: string,
  maidenSurname: string,
  marriedSurname: string,
): string {
  const married = marriedSurname || baseSurname || maidenSurname;
  const maiden = maidenSurname || baseSurname || marriedSurname;
  switch (mode) {
    case "married-with-maiden":
      return surnamePair(married, maiden);
    case "maiden-with-married":
      return surnamePair(maiden, married);
    case "maiden-only":
      return maiden;
    case "married-only":
    default:
      return married;
  }
}

function displayNameSuffix(
  person: TreePerson,
  structured: StructuredName,
): string {
  const canonical = [structured.givenName, structured.patronymic]
    .filter(Boolean)
    .join(" ");
  if (structured.patronymic) return canonical;

  const original = clean(person.displayName);
  const surnameCandidates = [
    structured.marriedSurname,
    structured.maidenSurname,
    structured.baseSurname,
  ].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const surname of surnameCandidates) {
    if (!original.toLocaleLowerCase("uk").startsWith(
      `${surname.toLocaleLowerCase("uk")} `,
    )) continue;
    const suffix = clean(original.slice(surname.length));
    if (suffix) return suffix;
  }
  return canonical;
}

function surnamePair(primary: string, secondary: string): string {
  if (!primary) return secondary;
  if (!secondary || sameName(primary, secondary)) return primary;
  return `${primary} (${secondary})`;
}

function partnershipRank(union: TreeUnion): number {
  if (union.isPreferredForDisplay) return 0;
  if (union.status === "married" || union.status === "current" || union.status === "active") {
    return 1;
  }
  return 2;
}

function compareOrder(left?: string, right?: string): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right, "uk");
}

function isFemale(
  person: TreePerson,
  profile?: FamilyTreeNameProfile,
): boolean {
  return person.sex === "female" || normalizedGender(profile?.gender) === "female";
}

function isMale(
  person: TreePerson,
  profile?: FamilyTreeNameProfile,
): boolean {
  return person.sex === "male" || normalizedGender(profile?.gender) === "male";
}

function normalizedGender(value: unknown): "female" | "male" | "unknown" {
  const normalized = clean(value).toLocaleLowerCase("uk");
  if (["female", "f", "жінка", "жіноча"].includes(normalized)) return "female";
  if (["male", "m", "чоловік", "чоловіча"].includes(normalized)) return "male";
  return "unknown";
}

function isMasked(person: TreePerson): boolean {
  return person.badges?.privacy === "masked";
}

function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, "uk", { sensitivity: "base" }) === 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}
