import type { Person, PersonRelation } from "../../types/index.ts";
import type { ProjectPersonMarriage } from "../../services/projectPersonMarriages.ts";
import {
  buildPersonTimeline,
  personDisplayName,
  personTimelineAttachments,
  sortPersonTimelineItems,
  type PersonTimelineItem,
} from "./model.ts";
import { personTimelineEventDisplaySubtitle } from "./presentation.ts";

type RelativeKind = NonNullable<PersonTimelineItem["relative"]>["kind"];
type RelationStatus = PersonRelation["status"];
interface RelativeLink {
  personId: string;
  kind: RelativeKind;
  status: RelationStatus;
  adopted?: boolean;
}

const parentTypes = new Set(["батько", "мати", "батько або мати", "усиновлювач"]);
const childTypes = new Set(["дитина", "син", "донька", "усиновлена дитина"]);
const siblingTypes = new Set(["брат", "сестра", "брат або сестра"]);
const statusRank: Record<RelationStatus, number> = {
  "доведено": 4, "імовірно": 3, "гіпотеза": 2, "сумнівно": 1, "спростовано": 0,
};

/**
 * A view of durable, already-authorized project records, never a second copy
 * in persons.events. Source edits, deletions and unlinking are reflected on
 * the next render, including old records; no backfill or per-relative RPCs.
 */
export function buildPersonFamilyTimeline(person: Person, options: {
  persons: readonly Person[];
  relations: readonly PersonRelation[];
  marriages?: readonly ProjectPersonMarriage[];
}): PersonTimelineItem[] {
  const people = new Map(options.persons.map((value) => [value.id, value]));
  people.set(person.id, person);
  const marriagesByPerson = new Map<string, ProjectPersonMarriage[]>();
  const disprovenMarriageFacts = new Set<string>();
  for (const marriage of options.marriages ?? []) {
    for (const id of new Set([marriage.personAId, marriage.personBId])) {
      if (marriage.evidenceStatus === "disproven") disprovenMarriageFacts.add(`${id}:marriage:${marriage.id}`);
      const values = marriagesByPerson.get(id) ?? [];
      // Repeated rows/tree snapshots must not duplicate the same relationship.
      if (!values.some((value) => value.id === marriage.id)) values.push(marriage);
      marriagesByPerson.set(id, values);
    }
  }
  const timelineFor = (subject: Person) => buildPersonTimeline(subject, {
    marriages: (marriagesByPerson.get(subject.id) ?? []).map((marriage) => {
      const partnerId = marriage.personAId === subject.id ? marriage.personBId : marriage.personAId;
      const partner = people.get(partnerId);
      return {
        id: marriage.id, partnerId, partnerName: partner ? personDisplayName(partner) : "",
        date: marriage.date, place: marriage.place, address: marriage.address,
      };
    }),
  });
  const own = timelineFor(person);
  const relatives = closeRelatives(person.id, people, options.relations);
  // Only exclude events definitely later than all known death facts. An
  // uncertain/unknown date is not permission to invent a lifetime boundary.
  const deaths = own.filter((event) => event.type === "death").map((event) => dateBounds(event.date));
  const lastPossibleDeath = deaths.length && deaths.every((value) => value !== null)
    ? Math.max(...deaths.map((value) => value!.to)) : null;
  const projected: PersonTimelineItem[] = [];
  for (const link of relatives) {
    const relative = people.get(link.personId)!;
    for (const event of timelineFor(relative)) {
      // Preserve the existing own-card view, but do not propagate a refuted
      // shared marriage to relatives or resurrect its legacy scalar fallback.
      if (disprovenMarriageFacts.has(event.id)) continue;
      if (event.type !== "death" && !(link.kind === "child" && (event.type === "birth" || event.type === "marriage"))) continue;
      const bounds = dateBounds(event.date);
      if (lastPossibleDeath !== null && bounds && bounds.from > lastPossibleDeath) continue;
      // A parent may already be a witness/participant in the very same saved
      // finding. Keep that explicit role and provenance instead of adding a copy.
      if (event.sourceFindingId && own.some((value) => (
        value.type === "mention" && value.sourceFindingId === event.sourceFindingId
        && value.relatedPersonIds?.includes(relative.id)
      ))) continue;
      const title = relativeEventTitle(event.type, link, relative);
      projected.push({
        ...event,
        id: `${person.id}:relative:${relative.id}:${event.id}`,
        personId: person.id,
        source: "relative",
        title: `${title} · ${personDisplayName(relative)}`,
        value: [personTimelineEventDisplaySubtitle(event), event.value]
          .filter(Boolean).join(" · ") || null,
        // Keep original scans, never resolve them against the receiving card.
        scans: personTimelineAttachments(relative, event).map((scan) => ({ ...scan, deleteOnRemove: false })),
        relative: {
          personId: relative.id, personName: personDisplayName(relative), kind: link.kind,
          sourceEventId: event.id, relationStatus: link.status,
        },
      });
    }
  }
  return sortPersonTimelineItems([...own, ...projected]);
}

function closeRelatives(personId: string, people: ReadonlyMap<string, Person>, relations: readonly PersonRelation[]): RelativeLink[] {
  const result = new Map<string, RelativeLink>();
  const parentsOf = new Map<string, Map<string, { status: RelationStatus; adopted: boolean }>>();
  const childrenOf = new Map<string, Set<string>>();
  const add = (link: RelativeLink) => {
    if (link.personId === personId || !people.has(link.personId)) return;
    const previous = result.get(link.personId);
    if (!previous || (previous.kind === "sibling" && link.kind !== "sibling")
      || (previous.kind === link.kind && statusRank[link.status] > statusRank[previous.status])) {
      result.set(link.personId, link);
    }
  };
  for (const relation of relations) {
    if (relation.status === "спростовано" || relation.personId === relation.relatedPersonId
      || !people.has(relation.personId) || !people.has(relation.relatedPersonId)) continue;
    const isParent = parentTypes.has(relation.relationType);
    if (isParent || childTypes.has(relation.relationType)) {
      const parentId = isParent ? relation.relatedPersonId : relation.personId;
      const childId = isParent ? relation.personId : relation.relatedPersonId;
      const adopted = relation.relationType === "усиновлювач" || relation.relationType === "усиновлена дитина";
      const parents = parentsOf.get(childId) ?? new Map<string, { status: RelationStatus; adopted: boolean }>();
      const previous = parents.get(parentId);
      if (!previous || statusRank[relation.status] > statusRank[previous.status]) {
        parents.set(parentId, { status: relation.status, adopted });
      }
      parentsOf.set(childId, parents);
      const children = childrenOf.get(parentId) ?? new Set();
      children.add(childId);
      childrenOf.set(parentId, children);
      if (parentId === personId) add({ personId: childId, kind: "child", status: relation.status, adopted });
      if (childId === personId) add({ personId: parentId, kind: "parent", status: relation.status, adopted });
    } else if (siblingTypes.has(relation.relationType)) {
      if (relation.personId === personId) add({ personId: relation.relatedPersonId, kind: "sibling", status: relation.status });
      if (relation.relatedPersonId === personId) add({ personId: relation.personId, kind: "sibling", status: relation.status });
    }
  }
  // One common saved parent is enough for siblings (including half-siblings).
  // No recursive graph traversal and no inference from names or patronymics.
  for (const [parentId, first] of parentsOf.get(personId) ?? []) {
    for (const siblingId of childrenOf.get(parentId) ?? []) {
      const second = parentsOf.get(siblingId)!.get(parentId)!;
      const status = statusRank[first.status] <= statusRank[second.status] ? first.status : second.status;
      add({ personId: siblingId, kind: "sibling", status });
    }
  }
  return [...result.values()].sort((a, b) => a.personId.localeCompare(b.personId));
}

function relativeEventTitle(type: PersonTimelineItem["type"], link: RelativeLink, person: Person): string {
  const noun = link.kind === "child"
    ? link.adopted ? "усиновленої дитини" : person.gender === "чоловік" ? "сина" : person.gender === "жінка" ? "доньки" : "дитини"
    : link.kind === "parent"
      ? link.adopted ? "усиновлювача" : person.gender === "чоловік" ? "батька" : person.gender === "жінка" ? "матері" : "когось із батьків"
      : person.gender === "чоловік" ? "брата" : person.gender === "жінка" ? "сестри" : "брата або сестри";
  return `${type === "birth" ? "Народження" : type === "marriage" ? "Шлюб" : "Смерть"} ${noun}`;
}

/** Conservative bounds: approximate/GEDCOM wording stays visible for review. */
function dateBounds(value?: string | null): { from: number; to: number } | null {
  const text = value?.trim() ?? "";
  const range = /^(\d{4})\s*[–—-]\s*(\d{4})$/u.exec(text);
  if (range) return Number(range[1]) <= Number(range[2])
    ? { from: Number(range[1]) * 10000 + 101, to: Number(range[2]) * 10000 + 1231 } : null;
  const local = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/u.exec(text);
  const iso = local ? [local[0], local[3], local[2], local[1]] : /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/u.exec(text);
  if (!iso) return null;
  const year = Number(iso[1]);
  const month = iso[2] ? Number(iso[2]) : null;
  const day = iso[3] ? Number(iso[3]) : null;
  if (year < 1 || (month !== null && (month < 1 || month > 12))) return null;
  const monthDays = month === null ? 31 : [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day !== null && (day < 1 || day > monthDays)) return null;
  return {
    from: year * 10000 + (month ?? 1) * 100 + (day ?? 1),
    to: year * 10000 + (month ?? 12) * 100 + (day ?? monthDays),
  };
}
