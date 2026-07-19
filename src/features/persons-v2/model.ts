import type {
  Person,
  PersonEvent,
  PersonGender,
  PersonRelation,
  PersonRelationType,
  PersonStatus,
  ScanAttachment,
} from "../../types/index.ts";
import { personEventLabel } from "../../utils/geo.ts";
import {
  isPhotoReferenceAvailable,
  primaryPersonPhoto,
} from "../../utils/personPhotos.ts";
import { normalizePersonStatus } from "../../utils/personStatus.ts";

export type PersonsSavedSegment = "all" | "confirmed" | "hypotheses" | "direct";
export type PersonLifeStatusFilter = "all" | "living" | "deceased";
export type PersonCatalogSortBy = "family" | "name" | "birth" | "death" | "updated";
export type PersonCatalogSortDirection = "asc" | "desc";

export interface PersonFamilyParentLink {
  parentId: string;
  childId: string;
  parentRoleLabel?: string | null;
}

export interface PersonCatalogOptions {
  query?: string;
  status?: PersonStatus | readonly PersonStatus[] | "all";
  gender?: PersonGender | readonly PersonGender[] | "all";
  lifeStatus?: PersonLifeStatusFilter;
  segment?: PersonsSavedSegment;
  directPersonIds?: ReadonlySet<string>;
  sortBy?: PersonCatalogSortBy;
  sortDirection?: PersonCatalogSortDirection;
  /** Zero-based pedigree rank, starting with the central person. */
  familyOrder?: ReadonlyMap<string, number>;
}

export interface PersonMainPlaces {
  birth: string;
  marriage: string;
  death: string;
  residences: string[];
  eventPlaces: string[];
  all: string[];
  primary: string;
}

export type PersonAvatarModel =
  | {
      kind: "photo";
      initials: string;
      photo: ScanAttachment;
    }
  | {
      kind: "initials";
      initials: string;
      photo?: undefined;
    };

export interface PersonProfileCompletenessCheck {
  id: string;
  label: string;
  complete: boolean;
}

export interface PersonProfileCompletenessSection {
  id: "identity" | "vital" | "life" | "evidence" | "biography";
  label: string;
  applicable: boolean;
  completed: number;
  total: number;
  percent: number;
  checks: PersonProfileCompletenessCheck[];
  missing: string[];
}

export interface PersonProfileCompleteness {
  percent: number;
  completed: number;
  total: number;
  sections: PersonProfileCompletenessSection[];
  missing: string[];
}

export type PersonTimelineDatePrecision =
  | "exact"
  | "month"
  | "year"
  | "range"
  | "approximate"
  | "unknown";

export interface PersonTimelineItem extends PersonEvent {
  source: "core" | "event";
  datePrecision: PersonTimelineDatePrecision;
  /** UTC timestamp used only for deterministic chronological ordering. */
  sortTimestamp: number | null;
  /** IDs of legacy/synthetic events folded into this canonical timeline item. */
  deduplicatedEventIds: string[];
}

const CORE_EVENT_TYPES = new Set<PersonEvent["type"]>([
  "birth",
  "marriage",
  "death",
  "residence",
]);
const CONFIRMED_STATUSES = new Set<PersonStatus>(["доведена", "частково доведена"]);
const HYPOTHESIS_STATUSES = new Set<PersonStatus>(["гіпотетична"]);
const UKRAINIAN_COLLATOR = new Intl.Collator("uk-UA", {
  sensitivity: "base",
  numeric: true,
});

/** Returns a stable, human-readable name without persisting a second display value. */
export function personDisplayName(person: Person): string {
  const stored = collapseWhitespace(person.fullName);
  if (stored) return stored;
  const structured = [person.surname || person.maidenSurname, person.givenName, person.patronymic]
    .map(collapseWhitespace)
    .filter(Boolean)
    .join(" ");
  return structured || "Особа без імені";
}

/** Preserves genealogical year ranges instead of inventing exact dates. */
export function personLifeYears(person: Person): string {
  const birth = lifeYearValue(person.birthDate, person.birthYearFrom, person.birthYearTo);
  const death = lifeYearValue(person.deathDate, person.deathYearFrom, person.deathYearTo);
  if (birth && death) return `${birth}–${death}`;
  if (birth) return `${birth}–`;
  if (death) return `–${death}`;
  return "";
}

/** Collects the places useful to profile summaries and map tabs, deduplicated in source order. */
export function personMainPlaces(person: Person): PersonMainPlaces {
  const birth = collapseWhitespace(person.birthPlace);
  const marriage = collapseWhitespace(person.marriagePlace);
  const death = collapseWhitespace(person.deathPlace);
  const residences = splitList(person.residencePlaces);
  const eventPlaces = uniqueText(
    (person.events ?? []).map((event) => collapseWhitespace(event.placeName ?? "")),
  );
  const all = uniqueText([birth, marriage, ...residences, death, ...eventPlaces]);
  return {
    birth,
    marriage,
    death,
    residences,
    eventPlaces,
    all,
    primary: birth || residences[0] || marriage || death || eventPlaces[0] || "",
  };
}

/** Returns the relation label as seen from the currently opened person's side. */
export function personRelationLabel(
  relation: PersonRelation,
  currentPersonId: string,
  otherPerson?: Person | null,
): string {
  if (isSpouseRelationType(relation.relationType)) {
    return spouseRelationTypeForRelatedPerson(otherPerson?.gender, relation.relationType);
  }
  if (relation.personId === currentPersonId) {
    return directParentRelationTypeForRelatedPerson(relation.relationType, otherPerson?.gender)
      ?? relation.relationType;
  }

  switch (relation.relationType) {
    case "чоловік": return "дружина";
    case "дружина": return "чоловік";
    case "подружжя": return "подружжя";
    case "батько":
    case "мати":
    case "батько або мати":
      if (otherPerson?.gender === "чоловік") return "син";
      if (otherPerson?.gender === "жінка") return "донька";
      return "дитина";
    case "дитина":
    case "син":
    case "донька":
      if (otherPerson?.gender === "чоловік") return "батько";
      if (otherPerson?.gender === "жінка") return "мати";
      return "батько або мати";
    case "брат":
    case "сестра":
    case "брат або сестра":
      if (otherPerson?.gender === "чоловік") return "брат";
      if (otherPerson?.gender === "жінка") return "сестра";
      return "брат або сестра";
    case "хрещений":
    case "хрещена":
      if (otherPerson?.gender === "чоловік") return "хрещеник";
      if (otherPerson?.gender === "жінка") return "хрещениця";
      return "хрещеник";
    case "хрещеник":
    case "хрещениця":
      return otherPerson?.gender === "жінка" ? "хрещена" : "хрещений";
    case "вітчим":
    case "мачуха":
      return otherPerson?.gender === "жінка" ? "падчерка" : "пасинок";
    case "пасинок":
    case "падчерка":
      return otherPerson?.gender === "жінка" ? "мачуха" : "вітчим";
    case "опікун": return "підопічний";
    case "підопічний": return "опікун";
    case "усиновлювач": return "усиновлена дитина";
    case "усиновлена дитина": return "усиновлювач";
    case "голова господарства": return "член господарства";
    case "член господарства": return "голова господарства";
    case "наймит або служник": return "господар";
    case "свідок":
    case "поручитель":
    case "священник":
    case "духовна особа":
    case "посадова особа":
    case "повитуха":
    case "особа, яка повідомила":
      return "особа у записі";
    default:
      return relation.relationType;
  }
}

/** Uses structured surname/given-name initials when available, matching genealogy card labels. */
export function personInitials(person: Person): string {
  const structured = [person.surname || person.maidenSurname, person.givenName]
    .map(firstLetter)
    .filter(Boolean)
    .join("");
  if (structured) return structured.slice(0, 2).toLocaleUpperCase("uk-UA");

  const displayName = personDisplayName(person);
  if (displayName === "Особа без імені") return "?";
  return displayName
    .split(/\s+/u)
    .map(firstLetter)
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase("uk-UA") || "?";
}

/** Selects photo metadata only. Resolving Drive bytes remains an explicit UI concern. */
export function personAvatar(person: Person): PersonAvatarModel {
  const initials = personInitials(person);
  const preferred = primaryPersonPhoto(person.photos, person.primaryPhotoId);
  const photo = isPhotoReferenceAvailable(preferred)
    ? preferred
    : person.photos?.find(isPhotoReferenceAvailable);
  return photo
    ? { kind: "photo", initials, photo }
    : { kind: "initials", initials };
}

/**
 * Computes transparent profile completeness from facts currently supported by Person.
 * Death checks are not applicable to living people and therefore never lower their score.
 */
export function calculatePersonProfileCompleteness(person: Person): PersonProfileCompleteness {
  const hasName = personDisplayName(person) !== "Особа без імені";
  const hasBirthDate = hasLifeDate(person.birthDate, person.birthYearFrom, person.birthYearTo);
  const hasDeathDate = hasLifeDate(person.deathDate, person.deathYearFrom, person.deathYearTo);
  const hasAnyScan = [
    ...(person.birthScans ?? []),
    ...(person.marriageScans ?? []),
    ...(person.deathScans ?? []),
    ...(person.mentionScans ?? []),
  ].length > 0;
  const sections = [
    completenessSection("identity", "Основне", [
      check("display-name", "Ім’я особи", hasName),
      check("structured-name", "Ім’я та прізвище", hasText(person.givenName) && hasText(person.surname)),
      check("gender", "Стать", person.gender !== "невідомо"),
    ]),
    completenessSection("vital", "Життєві дати", [
      check("birth-date", "Дата або період народження", hasBirthDate),
      check("birth-place", "Місце народження", hasText(person.birthPlace)),
      ...(!person.isLiving
        ? [
            check("death-date", "Дата або період смерті", hasDeathDate),
            check("death-place", "Місце смерті", hasText(person.deathPlace)),
          ]
        : []),
    ]),
    completenessSection("life", "Життєвий контекст", [
      check("residence", "Місце проживання", splitList(person.residencePlaces).length > 0),
      check("occupation", "Професія або заняття", hasText(person.occupation)),
      check("events", "Додаткові життєві події", (person.events ?? []).some(isMeaningfulEvent)),
    ]),
    completenessSection("evidence", "Матеріали", [
      check("sources", "Прикріплені матеріали", hasAnyScan),
      check("photo", "Фото", personAvatar(person).kind === "photo"),
    ]),
    completenessSection("biography", "Біографія", [
      check("notes", "Біографічна нотатка", hasText(person.notes)),
    ]),
  ];
  const completed = sections.reduce((sum, section) => sum + section.completed, 0);
  const total = sections.reduce((sum, section) => sum + section.total, 0);
  return {
    percent: percentage(completed, total),
    completed,
    total,
    sections,
    missing: sections.flatMap((section) => section.missing),
  };
}

/**
 * Builds a single chronological feed from scalar vital fields and saved PersonEvent values.
 * Synthetic copies created by the legacy editor are folded into their corresponding core item.
 */
export function buildPersonTimeline(person: Person): PersonTimelineItem[] {
  const staged: Array<PersonTimelineItem & { sourceIndex: number }> = [];
  let sourceIndex = 0;

  for (const event of coreTimelineEvents(person)) {
    staged.push(withTimelineSort(event, "core", sourceIndex++));
  }

  for (const event of person.events ?? []) {
    const duplicateIndex = CORE_EVENT_TYPES.has(event.type)
      ? staged.findIndex((candidate) => (
          candidate.source === "core"
          && candidate.type === event.type
          && (event.id === event.type || eventSignature(candidate) === eventSignature(event))
        ))
      : -1;

    if (duplicateIndex >= 0) {
      const previous = staged[duplicateIndex];
      staged[duplicateIndex] = withTimelineSort({
        ...event,
        ...previous,
        title: previous.title || event.title,
        value: previous.value || event.value,
        age: previous.age || event.age,
        cause: previous.cause || event.cause,
        address: previous.address || event.address,
        geo: previous.geo || event.geo,
        notes: previous.notes || event.notes,
        deduplicatedEventIds: uniqueText([
          ...previous.deduplicatedEventIds,
          event.id,
        ]),
      }, "core", previous.sourceIndex);
      continue;
    }

    staged.push(withTimelineSort(event, "event", sourceIndex++));
  }

  return staged
    .sort(compareTimelineItems)
    .map(({ sourceIndex: _sourceIndex, ...event }) => event);
}

/**
 * Builds a cycle-safe pedigree order from the central person towards older
 * generations. Every person receives at most one rank, at their nearest
 * generation; within a generation fathers precede mothers and other parents.
 */
export function buildPersonFamilyOrder(
  people: readonly Person[],
  rootPersonId: string | null | undefined,
  parentLinks: readonly PersonFamilyParentLink[],
): Map<string, number> {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  if (!rootPersonId || !peopleById.has(rootPersonId)) return new Map();

  const parentsByChild = new Map<string, PersonFamilyParentLink[]>();
  for (const link of parentLinks) {
    if (
      link.parentId === link.childId
      || !peopleById.has(link.parentId)
      || !peopleById.has(link.childId)
    ) continue;
    const links = parentsByChild.get(link.childId) ?? [];
    links.push(link);
    parentsByChild.set(link.childId, links);
  }

  const order = new Map<string, number>([[rootPersonId, 0]]);
  const visited = new Set<string>([rootPersonId]);
  let frontier = [rootPersonId];

  while (frontier.length) {
    const candidates = new Map<string, number>();
    for (const childId of frontier) {
      for (const link of parentsByChild.get(childId) ?? []) {
        if (visited.has(link.parentId)) continue;
        const roleRank = familyParentRoleRank(
          link.parentRoleLabel,
          peopleById.get(link.parentId),
        );
        const currentRank = candidates.get(link.parentId);
        if (currentRank === undefined || roleRank < currentRank) {
          candidates.set(link.parentId, roleRank);
        }
      }
    }

    const generation = [...candidates]
      .sort(([firstId, firstRole], [secondId, secondRole]) => (
        firstRole - secondRole
        || comparePersonNamesAndIds(peopleById.get(firstId), peopleById.get(secondId), firstId, secondId)
      ))
      .map(([personId]) => personId);
    for (const personId of generation) {
      visited.add(personId);
      order.set(personId, order.size);
    }
    frontier = generation;
  }

  return order;
}

/** Applies all catalogue filters in one pass and always returns a stable sorted copy. */
export function filterAndSortPersons(
  people: readonly Person[],
  options: PersonCatalogOptions = {},
): Person[] {
  const queryTokens = normalizeSearchText(options.query ?? "").split(" ").filter(Boolean);
  const statuses = filterSet(options.status);
  const genders = filterSet(options.gender);
  const lifeStatus = options.lifeStatus ?? "all";
  const segment = options.segment ?? "all";
  const sortBy = options.sortBy ?? "name";
  const direction = options.sortDirection ?? "asc";

  return people
    .map((person, sourceIndex) => ({ person, sourceIndex }))
    .filter(({ person }) => {
      const normalizedStatus = normalizePersonStatus(person.status);
      if (statuses && !statuses.has(normalizedStatus)) return false;
      if (genders && !genders.has(person.gender)) return false;
      if (lifeStatus === "living" && !person.isLiving) return false;
      if (lifeStatus === "deceased" && person.isLiving) return false;
      if (!matchesSegment(person, normalizedStatus, segment, options.directPersonIds)) return false;
      if (!queryTokens.length) return true;
      const haystack = personSearchText(person);
      return queryTokens.every((token) => haystack.includes(token));
    })
    .sort((first, second) => (
      compareCatalogPersons(first.person, second.person, sortBy, direction, options.familyOrder)
      || first.sourceIndex - second.sourceIndex
    ))
    .map(({ person }) => person);
}

function coreTimelineEvents(person: Person): PersonEvent[] {
  const events: PersonEvent[] = [];
  const add = (
    type: PersonEvent["type"],
    date: string,
    placeName: string,
    rangeFrom = "",
    rangeTo = "",
  ) => {
    const dateValue = collapseWhitespace(date) || yearRange(rangeFrom, rangeTo);
    const place = collapseWhitespace(placeName);
    if (!dateValue && !place) return;
    events.push({
      id: `${person.id}:core:${type}`,
      personId: person.id,
      type,
      title: personEventLabel(type),
      date: dateValue || null,
      placeName: place || null,
      geo: null,
      notes: null,
    });
  };

  add("birth", person.birthDate, person.birthPlace, person.birthYearFrom, person.birthYearTo);
  add("marriage", person.marriageDate, person.marriagePlace);
  add("death", person.deathDate, person.deathPlace, person.deathYearFrom, person.deathYearTo);
  const residenceEvents = (person.events ?? []).filter((event) => event.type === "residence");
  if (!residenceEvents.length || residenceEvents.some((event) => event.id === "residence")) {
    add("residence", "", person.residencePlaces);
  }
  return events;
}

function withTimelineSort(
  event: PersonEvent & Partial<Pick<PersonTimelineItem, "deduplicatedEventIds">>,
  source: PersonTimelineItem["source"],
  sourceIndex: number,
): PersonTimelineItem & { sourceIndex: number } {
  const parsed = parseTimelineDate(event.date);
  return {
    ...event,
    personId: event.personId,
    source,
    datePrecision: parsed.precision,
    sortTimestamp: parsed.timestamp,
    deduplicatedEventIds: event.deduplicatedEventIds ?? [],
    sourceIndex,
  };
}

function compareTimelineItems(
  first: PersonTimelineItem & { sourceIndex: number },
  second: PersonTimelineItem & { sourceIndex: number },
): number {
  if (first.sortTimestamp === null && second.sortTimestamp !== null) return 1;
  if (first.sortTimestamp !== null && second.sortTimestamp === null) return -1;
  if (first.sortTimestamp !== null && second.sortTimestamp !== null) {
    const timestampOrder = first.sortTimestamp - second.sortTimestamp;
    if (timestampOrder) return timestampOrder;
    const precisionOrder = precisionRank(first.datePrecision) - precisionRank(second.datePrecision);
    if (precisionOrder) return precisionOrder;
  }
  return first.sourceIndex - second.sourceIndex;
}

function parseTimelineDate(value?: string | null): {
  timestamp: number | null;
  precision: PersonTimelineDatePrecision;
} {
  const date = collapseWhitespace(value ?? "");
  if (!date) return { timestamp: null, precision: "unknown" };

  let match = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u);
  if (match && validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return parsedDate(Number(match[1]), Number(match[2]), Number(match[3]), "exact");
  }
  match = date.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/u);
  if (match && validCalendarDate(Number(match[3]), Number(match[2]), Number(match[1]))) {
    return parsedDate(Number(match[3]), Number(match[2]), Number(match[1]), "exact");
  }
  match = date.match(/^(\d{4})-(\d{1,2})$/u);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
    return parsedDate(Number(match[1]), Number(match[2]), 1, "month");
  }
  match = date.match(/^(\d{4})$/u);
  if (match) return parsedDate(Number(match[1]), 1, 1, "year");
  match = date.match(/^(\d{4})\s*[–—-]\s*(\d{4})$/u);
  if (match) return parsedDate(Number(match[1]), 1, 1, "range");
  match = date.match(/\b(\d{4})\b/u);
  if (match) return parsedDate(Number(match[1]), 1, 1, "approximate");
  return { timestamp: null, precision: "unknown" };
}

function parsedDate(
  year: number,
  month: number,
  day: number,
  precision: PersonTimelineDatePrecision,
): { timestamp: number | null; precision: PersonTimelineDatePrecision } {
  if (year < 1 || year > 9999) return { timestamp: null, precision: "unknown" };
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return { timestamp: date.getTime(), precision };
}

function precisionRank(precision: PersonTimelineDatePrecision): number {
  return ["exact", "month", "year", "range", "approximate", "unknown"].indexOf(precision);
}

function eventSignature(event: Pick<PersonEvent, "type" | "date" | "placeName">): string {
  return [
    event.type,
    normalizeSearchText(event.date ?? ""),
    normalizeSearchText(event.placeName ?? ""),
  ].join("|");
}

function matchesSegment(
  person: Person,
  status: PersonStatus,
  segment: PersonsSavedSegment,
  directPersonIds: ReadonlySet<string> | undefined,
): boolean {
  if (segment === "confirmed") return CONFIRMED_STATUSES.has(status);
  if (segment === "hypotheses") return HYPOTHESIS_STATUSES.has(status);
  if (segment === "direct") return directPersonIds?.has(person.id) ?? false;
  return true;
}

function isSpouseRelationType(value: PersonRelationType): boolean {
  return value === "чоловік" || value === "дружина" || value === "подружжя";
}

function directParentRelationTypeForRelatedPerson(
  relationType: PersonRelationType,
  relatedGender: PersonGender | undefined,
): string | null {
  if (relationType === "батько") return "Батько";
  if (relationType === "мати") return "Мати";
  if (relationType !== "батько або мати") return null;
  if (relatedGender === "чоловік") return "Батько";
  if (relatedGender === "жінка") return "Мати";
  return "Батько або мати";
}

function spouseRelationTypeForRelatedPerson(
  relatedGender: PersonGender | undefined,
  fallback: PersonRelationType,
): string {
  if (relatedGender === "чоловік") return "чоловік";
  if (relatedGender === "жінка") return "дружина";
  return fallback === "чоловік" || fallback === "дружина" ? fallback : "подружжя";
}

function compareCatalogPersons(
  first: Person,
  second: Person,
  sortBy: PersonCatalogSortBy,
  direction: PersonCatalogSortDirection,
  familyOrder?: ReadonlyMap<string, number>,
): number {
  if (sortBy === "family") {
    const firstRank = finiteFamilyRank(familyOrder?.get(first.id));
    const secondRank = finiteFamilyRank(familyOrder?.get(second.id));
    if (firstRank !== null && secondRank === null) return -1;
    if (firstRank === null && secondRank !== null) return 1;
    if (firstRank !== null && secondRank !== null && firstRank !== secondRank) {
      return firstRank - secondRank;
    }
    return comparePersonNamesAndIds(first, second, first.id, second.id);
  }
  if (sortBy === "name") {
    const order = UKRAINIAN_COLLATOR.compare(personDisplayName(first), personDisplayName(second));
    return direction === "desc" ? -order : order;
  }
  if (sortBy === "updated") {
    return compareNullableNumbers(
      safeTimestamp(first.updatedAt),
      safeTimestamp(second.updatedAt),
      direction,
    );
  }
  const firstDate = catalogLifeTimestamp(first, sortBy);
  const secondDate = catalogLifeTimestamp(second, sortBy);
  return compareNullableNumbers(firstDate, secondDate, direction);
}

function finiteFamilyRank(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function familyParentRoleRank(label: string | null | undefined, person?: Person): number {
  const normalized = collapseWhitespace(label ?? "").toLocaleLowerCase("uk-UA");
  if (normalized.includes("father")) return 0;
  if (normalized.includes("mother")) return 1;
  if (person?.gender === "чоловік") return 0;
  if (person?.gender === "жінка") return 1;
  return 2;
}

function comparePersonNamesAndIds(
  first: Person | undefined,
  second: Person | undefined,
  firstId: string,
  secondId: string,
): number {
  const nameOrder = UKRAINIAN_COLLATOR.compare(
    first ? personDisplayName(first) : "",
    second ? personDisplayName(second) : "",
  );
  return nameOrder || firstId.localeCompare(secondId, "uk-UA");
}

function compareNullableNumbers(
  first: number | null,
  second: number | null,
  direction: PersonCatalogSortDirection,
): number {
  if (first === null && second !== null) return 1;
  if (first !== null && second === null) return -1;
  if (first === null || second === null) return 0;
  return direction === "desc" ? second - first : first - second;
}

function catalogLifeTimestamp(person: Person, kind: "birth" | "death"): number | null {
  const exact = kind === "birth" ? person.birthDate : person.deathDate;
  const from = kind === "birth" ? person.birthYearFrom : person.deathYearFrom;
  const to = kind === "birth" ? person.birthYearTo : person.deathYearTo;
  return parseTimelineDate(collapseWhitespace(exact) || yearRange(from, to)).timestamp;
}

function personSearchText(person: Person): string {
  const places = personMainPlaces(person);
  return normalizeSearchText([
    personDisplayName(person),
    person.fullName,
    person.surname,
    person.maidenSurname,
    person.givenName,
    person.patronymic,
    person.nameVariants,
    person.surnameVariants,
    personLifeYears(person),
    ...places.all,
    person.occupation,
    person.socialStatus,
    person.religion,
    person.notes,
    normalizePersonStatus(person.status),
    ...(person.events ?? []).flatMap(personEventSearchValues),
  ].join(" "));
}

function personEventSearchValues(event: PersonEvent): Array<string | number | null | undefined> {
  return [
    event.id,
    event.type,
    event.title,
    event.date,
    event.placeName,
    event.value,
    event.age,
    event.cause,
    event.address,
    event.notes,
    event.geo?.displayName,
    event.geo?.latitude,
    event.geo?.longitude,
    event.geo?.source,
    event.geo?.precision,
    event.geo?.provider,
    event.geo?.externalId,
  ];
}

function completenessSection(
  id: PersonProfileCompletenessSection["id"],
  label: string,
  checks: PersonProfileCompletenessCheck[],
): PersonProfileCompletenessSection {
  const completed = checks.filter((item) => item.complete).length;
  return {
    id,
    label,
    applicable: checks.length > 0,
    completed,
    total: checks.length,
    percent: percentage(completed, checks.length),
    checks,
    missing: checks.filter((item) => !item.complete).map((item) => item.label),
  };
}

function check(id: string, label: string, complete: boolean): PersonProfileCompletenessCheck {
  return { id, label, complete };
}

function percentage(completed: number, total: number): number {
  return total ? Math.round((completed / total) * 100) : 100;
}

function isMeaningfulEvent(event: PersonEvent): boolean {
  return Boolean(
    collapseWhitespace(event.date ?? "")
    || collapseWhitespace(event.placeName ?? "")
    || collapseWhitespace(event.value ?? "")
    || collapseWhitespace(event.notes ?? ""),
  );
}

function hasLifeDate(exact: string, from: string, to: string): boolean {
  return Boolean(collapseWhitespace(exact) || collapseWhitespace(from) || collapseWhitespace(to));
}

function lifeYearValue(exact: string, from: string, to: string): string {
  const exactYear = collapseWhitespace(exact).match(/\b(\d{4})\b/u)?.[1] ?? "";
  return exactYear || yearRange(from, to);
}

function yearRange(from: string, to: string): string {
  const start = collapseWhitespace(from);
  const end = collapseWhitespace(to);
  if (start && end && start !== end) return `${start}–${end}`;
  return start || end;
}

function filterSet<T extends string>(value: T | readonly T[] | "all" | undefined): Set<T> | null {
  if (!value || value === "all") return null;
  return new Set(Array.isArray(value) ? value : [value as T]);
}

function splitList(value: string): string[] {
  return uniqueText(value.split(/[;|\n\r]+/u).map(collapseWhitespace));
}

function uniqueText(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = collapseWhitespace(value);
    const key = normalizeSearchText(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[\u2018\u2019\u02bc`]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function firstLetter(value: string): string {
  return Array.from(collapseWhitespace(value))[0] ?? "";
}

function hasText(value: string): boolean {
  return Boolean(collapseWhitespace(value));
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = month === 2
    ? (leap ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

function safeTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
