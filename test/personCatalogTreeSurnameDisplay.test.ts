import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Person, PersonName } from "../src/types/index.ts";
import type { ProjectPersonMarriage } from "../src/services/projectPersonMarriages.ts";
import { resolvePersonCardNameDisplay, resolvePersonCatalogNameDisplays } from "../src/utils/personCardNameDisplay.ts";
import { filterAndSortPersons, personInitials } from "../src/features/persons-v2/model.ts";
import type { MarriedSurnameDisplay } from "../src/utils/familyTreeAppearance.ts";

function person(patch: Partial<Person> = {}): Person {
  return {
    id: "woman", surname: "Коваленко", maidenSurname: "Петренко", givenName: "Олена", patronymic: "Іванівна",
    fullName: "Коваленко Олена Іванівна", gender: "жінка", status: "доведена", isLiving: false,
    nameVariants: "", surnameVariants: "", birthDate: "1880", deathDate: "1950", birthPlace: "", deathPlace: "",
    marriagePlace: "", residencePlaces: "", occupation: "", socialStatus: "", religion: "", notes: "", events: [],
    createdAt: "", updatedAt: "", ...patch,
  } as Person;
}
function name(patch: Partial<PersonName> = {}): PersonName {
  return { id: "birth", personId: "woman", nameType: "birth", surname: "Петренко", givenName: "Олена", patronymic: "Іванівна",
    fullName: "Петренко Олена Іванівна", maidenSurname: "", originalText: "", isPrimary: false, isPreferred: false,
    isSearchable: true, updatedAt: "2026-01-01", createdAt: "2026-01-01", ...patch } as PersonName;
}
function prefs(marriedSurnameDisplay: MarriedSurnameDisplay, inferMarriedSurnameFromHusband = false) {
  return { marriedSurnameDisplay, inferMarriedSurnameFromHusband };
}

for (const mode of ["maiden-only", "married-only", "maiden-with-married", "married-with-maiden"] as const) {
  test(`catalogue and opened card use the same ${mode} label`, () => {
    const woman = person();
    const names = [name()];
    const before = structuredClone({ woman, names });
    const display = resolvePersonCatalogNameDisplays([woman], names, {}, prefs(mode)).get(woman.id)!;
    assert.equal(display.label, resolvePersonCardNameDisplay(woman, names, {}, prefs(mode)).label);
    assert.deepEqual({ woman, names }, before);
  });
}

test("catalogue finds both surnames including birth names stored only in person_names", () => {
  const woman = person({ maidenSurname: "" });
  const nameDisplays = resolvePersonCatalogNameDisplays([woman], [name()], {}, prefs("married-only"));
  for (const query of ["Петренко", "Коваленко", "петренко олена"]) {
    assert.deepEqual(filterAndSortPersons([woman], { query, nameDisplays }), [woman]);
  }
  assert.equal(resolvePersonCatalogNameDisplays([woman], [name()], {}, prefs("maiden-only")).get(woman.id)?.label, "Петренко Олена Іванівна");
});

test("alphabetic sort follows visible surnames while family rank and original records are preserved", () => {
  const woman = person({ surname: "Яценко", fullName: "Яценко Олена Іванівна", maidenSurname: "Антоненко" });
  const man = person({ id: "man", gender: "чоловік", surname: "Коваль", fullName: "Коваль Іван", givenName: "Іван" });
  const people = [man, woman];
  const nameDisplays = resolvePersonCatalogNameDisplays(people, [], {}, prefs("maiden-only"));
  const result = filterAndSortPersons(people, { sortBy: "name", nameDisplays });
  assert.deepEqual(result.map(p => p.id), [woman.id, man.id]);
  assert.equal(result[0], woman); // All row actions/exports receive the real record.
  assert.deepEqual(filterAndSortPersons(people, { sortBy: "name", sortDirection: "desc", nameDisplays }).map(p => p.id), [man.id, woman.id]);
  assert.deepEqual(filterAndSortPersons(people, { sortBy: "family", nameDisplays }).map(p => p.id), [woman.id, man.id]);
  assert.deepEqual(filterAndSortPersons(people, { sortBy: "family", familyOrder: new Map([[man.id, 0], [woman.id, 1]]), nameDisplays }).map(p => p.id), [man.id, woman.id]);
  assert.deepEqual(people, [man, woman]);
});

test("catalogue spouse inference matches card and remains searchable", () => {
  const woman = person({ surname: "Петренко", fullName: "Петренко Олена Іванівна" });
  const husband = person({ id: "husband", surname: "Яремчук", fullName: "Яремчук Петро", gender: "чоловік" });
  const marriages = [{ id: "m", personAId: woman.id, personBId: husband.id, createdAt: "1900", status: "active" }] as ProjectPersonMarriage[];
  const people = [woman, husband];
  const nameDisplays = resolvePersonCatalogNameDisplays(people, [], {}, prefs("married-only", true), marriages);
  assert.equal(nameDisplays.get(woman.id)?.label, resolvePersonCardNameDisplay(woman, [], {}, prefs("married-only", true), people, marriages).label);
  assert.equal(filterAndSortPersons(people, { query: "Яремчук Олена", nameDisplays })[0], woman);
});

test("latest name variants win consistently and non-searchable aliases stay out of the search extension", () => {
  const woman = person({ maidenSurname: "" });
  const names = [name({ surname: "Старе", fullName: "Старе Олена" }), name({ id: "latest", surname: "Нове", fullName: "Нове Олена", updatedAt: "2026-09-12" }),
    name({ id: "hidden", surname: "Секретне", fullName: "Секретне Олена", nameType: "alias", isSearchable: false })];
  const nameDisplays = resolvePersonCatalogNameDisplays([woman], names, {}, prefs("maiden-only"));
  assert.equal(nameDisplays.get(woman.id)?.label, "Нове Олена Іванівна");
  assert.equal(filterAndSortPersons([woman], { query: "секретне", nameDisplays }).length, 0);
});

test("initials follow displayed surname and ignore the surname inside parentheses", () => {
  assert.equal(personInitials(person(), "Петренко (Коваленко) Олена Іванівна"), "ПО");
  assert.equal(personInitials(person()), "КО");
});

test("catalogue projection indexes people once instead of scanning the entire catalogue per woman", () => {
  let idReads = 0;
  const people = Array.from({ length: 2500 }, (_, index) => {
    const result = person();
    Object.defineProperty(result, "id", { get() { idReads++; return `person-${index}`; } });
    return result;
  });
  const result = resolvePersonCatalogNameDisplays(people, [], {}, prefs("maiden-only"));
  assert.equal(result.size, 2500);
  assert.ok(idReads < 2500 * 50, `expected indexed access, got ${idReads} ID reads`);
});

test("list/grid names and accessible controls receive the shared presentation map", () => {
  const catalog = readFileSync(new URL("../src/features/persons-v2/PersonsCatalogV2.tsx", import.meta.url), "utf8");
  assert.equal((catalog.match(/nameDisplays=\{nameDisplays\}/g) ?? []).length, 2);
  assert.equal((catalog.match(/displayName=\{nameDisplays\?\.get\(person.id\)\?\.label\}/g) ?? []).length, 2);
  assert.equal((catalog.match(/aria-label=\{`(?:Вибрати|Видалити) \$\{nameDisplays/g) ?? []).length, 4);
  assert.match(catalog, /<strong>\{displayName \?\? personDisplayNameV2\(person\)\}/);
  const module = readFileSync(new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url), "utf8");
  assert.match(module, /nameDisplays=\{catalogNameDisplays\}/);
  assert.match(module, /catalogNames.replacePersonNames\(detailPersonId, personNames\)/);
});

test("catalogue names load in cancellable project-scoped pages, not one request per person", () => {
  const service = readFileSync(new URL("../src/services/projectPersonNames.ts", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/hooks/usePersonCatalogNames.ts", import.meta.url), "utf8");
  assert.match(service, /listProjectPersonCatalogNames[\s\S]*?listAllProjectPersonNameRows\(projectId,/);
  assert.match(service, /\.eq\("project_id", projectId\)[\s\S]*?\.range\(from, from \+ PERSON_NAME_BACKUP_PAGE_SIZE - 1\)/);
  assert.match(service, /query = query.abortSignal\(signal\)/);
  const projection = service.slice(service.indexOf("export async function listProjectPersonCatalogNames"), service.indexOf("export async function listAllProjectPersonNames"));
  const omissions = projection.match(/const omitted = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  assert.doesNotMatch(omissions, /"(?:confidence|evidence_status|prefix|suffix|nickname|citation_id|document_fragment_id)"/);
  assert.match(hook, /loadedKey === key/);
  assert.match(hook, /if \(!controller.signal.aborted\) setSnapshot/);
  assert.match(hook, /snapshot\?\.key === key \? snapshot.names : EMPTY_NAMES/);
  assert.match(hook, /return \(\) => controller.abort\(\)/);
});
