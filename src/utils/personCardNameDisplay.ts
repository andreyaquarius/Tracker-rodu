import type { Person, PersonName } from "../types/index.ts";
import type { ProjectPersonMarriage } from "../services/projectPersonMarriages.ts";
import {
  applyFamilyTreeNameDisplay,
  type FamilyTreeNameDisplayPreferences,
} from "../features/family-tree-view/adapters/familyTreeNameDisplay.ts";
import type { TreePerson } from "../features/family-tree-view/types.ts";
import { personTreeNameFields } from "./personTreeName.ts";
import { resolvePersonNameDisplay, type PersonNameDisplayOptions, type ResolvedPersonNameDisplay } from "./personNameDisplay.ts";

/** Build once per catalogue update, not once per row or sort comparison. */
export function resolvePersonCatalogNameDisplays(
  persons: readonly Person[],
  names: readonly PersonName[] = [],
  options: PersonNameDisplayOptions = {},
  treePreferences?: FamilyTreeNameDisplayPreferences,
  marriages: readonly ProjectPersonMarriage[] = [],
): ReadonlyMap<string, ResolvedPersonNameDisplay & { searchText: string }> {
  const peopleById = new Map(persons.map(person => [person.id, person]));
  const namesByPerson = new Map<string, PersonName[]>();
  for (const name of names) {
    if (!peopleById.has(name.personId)) continue;
    const group = namesByPerson.get(name.personId) ?? [];
    group.push(name);
    namesByPerson.set(name.personId, group);
  }
  const marriagesByPerson = new Map<string, ProjectPersonMarriage[]>();
  if (treePreferences?.inferMarriedSurnameFromHusband) {
    for (const marriage of marriages) {
      for (const id of new Set([marriage.personAId, marriage.personBId])) {
        const group = marriagesByPerson.get(id) ?? [];
        group.push(marriage);
        marriagesByPerson.set(id, group);
      }
    }
  }
  return new Map(persons.map(person => {
    const personNames = (namesByPerson.get(person.id) ?? []).sort((a, b) => (
      Number(b.isPrimary) - Number(a.isPrimary) || Number(b.isPreferred) - Number(a.isPreferred)
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
    ));
    const related = marriagesByPerson.get(person.id) ?? [];
    const spouseIds = new Set(related.flatMap(marriage => [marriage.personAId, marriage.personBId]));
    const spouses = [...spouseIds].flatMap(id => peopleById.has(id) ? [peopleById.get(id)!] : []);
    const display = resolvePersonCardNameDisplay(person, personNames, options, treePreferences, spouses, related);
    const searchText = personNames.filter(name => name.isSearchable !== false).flatMap(name => [
      name.surname, name.maidenSurname, name.givenName, name.patronymic, name.fullName,
      name.fullNormalized, name.originalText,
    ]).filter(Boolean).join(" ");
    return [person.id, { ...display, searchText }];
  }));
}

/** Presentation only: canonical fields and documentary spellings remain untouched. */
export function resolvePersonCardNameDisplay(
  person: Person,
  names: readonly PersonName[],
  options: PersonNameDisplayOptions = {},
  treePreferences?: FamilyTreeNameDisplayPreferences,
  persons: readonly Person[] = [],
  marriages: readonly ProjectPersonMarriage[] = [],
): ResolvedPersonNameDisplay {
  const personNames = names.filter(name => name.personId === person.id);
  const resolved = resolvePersonNameDisplay(person, personNames, options);
  // The explicit documentary mode is verbatim, not a modernized display name.
  if (!treePreferences || resolved.mode === "original" || !isFemale(person)) return resolved;

  const relatedMarriages = treePreferences.inferMarriedSurnameFromHusband
    ? marriages.filter(marriage => marriage.personAId === person.id || marriage.personBId === person.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    : [];
  const spouseIds = new Set(relatedMarriages.flatMap(marriage => [marriage.personAId, marriage.personBId]));
  const profiles = [person, ...persons.filter(candidate => candidate.id !== person.id && spouseIds.has(candidate.id))];
  const graphPersons: TreePerson[] = profiles.map(profile => ({
    id: profile.id,
    ...personTreeNameFields(profile, profile.id === person.id ? personNames : []),
    sex: isFemale(profile) ? "female" : isMale(profile) ? "male" : "unknown",
  }));
  // Do not replace a free-text-only name with a generated person ID.
  if (!graphPersons[0].surname && !graphPersons[0].maidenSurname && !graphPersons[0].marriedSurname) return resolved;
  const graph = applyFamilyTreeNameDisplay({
    persons: graphPersons,
    unions: relatedMarriages.map(marriage => ({
      id: marriage.id,
      kind: "partnership",
      memberIds: [marriage.personAId, marriage.personBId],
      status: marriage.status,
      displayOrder: marriage.nameDisplayOrder,
    })),
    parentChildRelations: [],
  }, treePreferences, profiles);
  const label = graph.persons[0].displayName;
  return {
    ...resolved,
    label,
    inlineLabel: resolved.variantLabels.length
      ? `${label} · Варіанти: ${resolved.variantLabels.join("; ")}`
      : label,
  };
}

function isFemale(person: Person): boolean {
  return ["жінка", "жіноча", "female", "f"].includes((person.gender ?? "").trim().toLocaleLowerCase("uk"));
}
function isMale(person: Person): boolean {
  return ["чоловік", "чоловіча", "male", "m"].includes((person.gender ?? "").trim().toLocaleLowerCase("uk"));
}
