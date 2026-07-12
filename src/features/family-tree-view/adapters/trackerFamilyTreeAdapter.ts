import type {
  FamilyGroup,
  FamilyGroupMember,
  FamilyTreePerson,
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
  ParentChildRelationship,
  ParentRoleLabel,
  ParentSet,
  PartnerRelationship,
} from "../../../types/familyTree.ts";
import type { FamilyTreePersonProfile } from "../../../services/familyTreeGraphRepository.ts";
import type {
  FamilyGraphData,
  SortableGenealogyDate,
  TreePerson,
  TreeUnion,
} from "../types.ts";
import { createTrackerFamilyTreeAdapter } from "./createTrackerAdapter.ts";
import {
  isPhotoReferenceAvailable,
  primaryPersonPhotoFromCustomFields,
} from "../../../utils/personPhotos.ts";

const PARTNERSHIP_UNION_PREFIX = "partnership:";
const PARENT_SET_UNION_PREFIX = "parent-set:";
const ORDER_OFFSET = 9_007_199_254_740_991n;

/**
 * The concrete adapter accepts the repository DTO instead of introducing a
 * second person or relationship model. All arrays below are fields already
 * returned by `readFamilyTreeGraphData`.
 */
export interface TrackerFamilyTreeSnapshot {
  personProfiles: readonly FamilyTreePersonProfile[];
  treePersons: readonly FamilyTreePerson[];
  groups: readonly FamilyGroup[];
  groupMembers: readonly FamilyGroupMember[];
  partnerRelationships: readonly PartnerRelationship[];
  parentSets: readonly ParentSet[];
  parentChildRelationships: readonly ParentChildRelationship[];
  personNames: readonly FamilyTreePersonName[];
  personTimelineEvents: readonly FamilyTreePersonTimelineEvent[];
  graphVersion?: string | number;
}

interface PersonAdapterInput {
  profile: FamilyTreePersonProfile;
  treePerson?: FamilyTreePerson;
  names: readonly FamilyTreePersonName[];
  events: readonly FamilyTreePersonTimelineEvent[];
}

interface FamilyGroupAdapterInput {
  group: FamilyGroup;
  members: readonly FamilyGroupMember[];
}

interface PartnerAdapterInput {
  relationship: PartnerRelationship;
}

interface ParentSetAdapterInput {
  parentSet: ParentSet;
  parentIds: readonly string[];
}

interface ParentChildAdapterInput {
  relationship: ParentChildRelationship;
  parentSet?: ParentSet;
  displayOrder?: string;
}

export function partnershipUnionId(relationshipId: string): string {
  return `${PARTNERSHIP_UNION_PREFIX}${relationshipId}`;
}

export function parentSetUnionId(parentSetId: string): string {
  return `${PARENT_SET_UNION_PREFIX}${parentSetId}`;
}

const concreteAdapter = createTrackerFamilyTreeAdapter<
  PersonAdapterInput,
  FamilyGroupAdapterInput,
  PartnerAdapterInput,
  ParentSetAdapterInput,
  ParentChildAdapterInput
>({
  mapPerson: mapPerson,
  mapPartnerRelationship: (input, familyGroups) => {
    const relationship = input.relationship;
    const familyGroup = relationship.familyGroupId
      ? familyGroups.get(relationship.familyGroupId)
      : undefined;
    const displayOrder =
      metadataDisplayOrder(relationship.metadata) ??
      (relationship.isPrimaryForDisplay ? numericOrderKey(-1) : undefined);
    const union: TreeUnion = {
      id: partnershipUnionId(relationship.id),
      kind: "partnership",
      memberIds: orderedPartnerIds(relationship, familyGroup),
      ...(relationship.familyGroupId
        ? { familyGroupId: relationship.familyGroupId }
        : {}),
      status: relationship.status,
      relationshipType: relationship.relationshipType,
      ...(sortableDate(relationship.startDate)
        ? { startDate: sortableDate(relationship.startDate) }
        : {}),
      ...(sortableDate(relationship.endDate)
        ? { endDate: sortableDate(relationship.endDate) }
        : {}),
      ...(displayOrder ? { displayOrder } : {}),
    };
    return union;
  },
  mapParentSet: (input) => {
    const parentSet = input.parentSet;
    const expectedParentSlots = metadataExpectedParentSlots(
      parentSet.metadata,
      input.parentIds.length,
    );
    const union: TreeUnion = {
      id: parentSetUnionId(parentSet.id),
      kind: "parent-set",
      memberIds: input.parentIds,
      ...(parentSet.familyGroupId
        ? { familyGroupId: parentSet.familyGroupId }
        : {}),
      parentSetType: parentSet.setType,
      isPreferredForDisplay: parentSet.isPreferredForDisplay,
      isDefaultForPedigree: parentSet.isDefaultForPedigree,
      displayOrder: numericOrderKey(parentSet.displayOrder),
      ...(expectedParentSlots === undefined ? {} : { expectedParentSlots }),
    };
    return union;
  },
  mapParentChildRelationship: (input) => ({
    id: input.relationship.id,
    parentId: input.relationship.parentId,
    childId: input.relationship.childId,
    unionId: parentSetUnionId(input.relationship.parentSetId),
    kind: input.relationship.relationshipType,
    role: input.relationship.parentRoleLabel,
    ...(input.displayOrder ? { displayOrder: input.displayOrder } : {}),
    isPreferred:
      input.parentSet?.isPreferredForDisplay === true ||
      input.parentSet?.isDefaultForPedigree === true,
  }),
  getFamilyGroupId: (input) => input.group.id,
});

/**
 * Converts current Tracker Rodu repository data into the renderer graph.
 * Canonical person and relationship IDs are passed through unchanged. Only
 * visual union IDs are namespaced because two domain tables can contain the
 * same ID and represent deliberately different concepts.
 */
export function adaptTrackerFamilyTreeSnapshot(
  snapshot: TrackerFamilyTreeSnapshot,
): FamilyGraphData {
  const treePersonById = firstBy(snapshot.treePersons, item => item.personId);
  const namesByPerson = groupBy(snapshot.personNames, item => item.personId);
  const eventsByPerson = groupBy(
    snapshot.personTimelineEvents,
    item => item.personId,
  );
  const membersByGroup = groupBy(
    snapshot.groupMembers,
    item => item.familyGroupId,
  );
  const groupById = firstBy(snapshot.groups, item => item.id);
  const parentSetById = firstBy(snapshot.parentSets, item => item.id);
  const relationshipsByParentSet = groupBy(
    snapshot.parentChildRelationships,
    item => item.parentSetId,
  );

  const persons: PersonAdapterInput[] = uniqueBy(
    snapshot.personProfiles,
    item => item.id,
  ).map(profile => ({
    profile,
    treePerson: treePersonById.get(profile.id),
    names: namesByPerson.get(profile.id) ?? [],
    events: eventsByPerson.get(profile.id) ?? [],
  }));

  const familyGroups: FamilyGroupAdapterInput[] = snapshot.groups.map(group => ({
    group,
    members: sortGroupMembers(membersByGroup.get(group.id) ?? []),
  }));

  const parentSets: ParentSetAdapterInput[] = snapshot.parentSets.map(parentSet => {
    const familyGroup = parentSet.familyGroupId
      ? groupById.get(parentSet.familyGroupId)
      : undefined;
    const familyGroupMembers = familyGroup
      ? membersByGroup.get(familyGroup.id) ?? []
      : [];
    const relationships = relationshipsByParentSet.get(parentSet.id) ?? [];
    return {
      parentSet,
      parentIds: orderedParentIds(relationships, familyGroupMembers),
    };
  });

  const parentChildRelationships: ParentChildAdapterInput[] =
    snapshot.parentChildRelationships.map(relationship => {
      const parentSet = parentSetById.get(relationship.parentSetId);
      const familyGroupId = relationship.familyGroupId ?? parentSet?.familyGroupId;
      const members = familyGroupId
        ? membersByGroup.get(familyGroupId) ?? []
        : [];
      const childMember = members.find(
        member =>
          member.personId === relationship.childId &&
          member.memberRole === "child",
      );
      const displayOrder =
        (childMember ? numericOrderKey(childMember.displayOrder) : undefined) ??
        metadataDisplayOrder(relationship.metadata) ??
        (parentSet ? numericOrderKey(parentSet.displayOrder) : undefined);
      return {
        relationship,
        parentSet,
        ...(displayOrder ? { displayOrder } : {}),
      };
    });

  return concreteAdapter({
    persons,
    familyGroups,
    partnerRelationships: snapshot.partnerRelationships.map(relationship => ({
      relationship,
    })),
    parentSets,
    parentChildRelationships,
    ...(snapshot.graphVersion === undefined
      ? {}
      : { graphVersion: snapshot.graphVersion }),
  });
}

/** Short alias for callers that prefer the adapter-style name. */
export const trackerFamilyTreeAdapter = adaptTrackerFamilyTreeSnapshot;

function mapPerson(input: PersonAdapterInput): TreePerson {
  const preferredName =
    input.names.find(name => name.isPrimary) ??
    input.names.find(name => name.isPreferred) ??
    input.names[0];
  const givenName = preferredName?.givenName || input.profile.givenName;
  const surname = preferredName?.surname || input.profile.surname;
  const displayName =
    preferredName?.fullName ||
    preferredName?.originalText ||
    [input.profile.surname, input.profile.givenName, input.profile.patronymic]
      .map(part => part.trim())
      .filter(Boolean)
      .join(" ") ||
    input.profile.fullName ||
    input.profile.id;
  const birth = lifeDate(input.events, ["birth", "baptism", "christening"]);
  const death = lifeDate(input.events, ["death", "burial", "cremation"]);
  const photo = primaryPersonPhotoFromCustomFields(input.profile.customFields);

  return {
    id: input.profile.id,
    displayName,
    ...(givenName ? { givenName } : {}),
    ...(surname ? { surname } : {}),
    sex: normalizeSex(input.profile.gender),
    ...(birth ? { birth } : {}),
    ...(death ? { death } : {}),
    ...(photo && isPhotoReferenceAvailable(photo) ? { photo } : {}),
    isLiving: input.profile.isLiving,
    isPrivate:
      input.profile.isLiving &&
      (input.profile.privacyStatus === "private" ||
        input.profile.privacyStatus === "confidential"),
    ...(input.treePerson
      ? { displayOrder: numericOrderKey(input.treePerson.displayOrder) }
      : {}),
  };
}

function orderedPartnerIds(
  relationship: PartnerRelationship,
  familyGroup: FamilyGroupAdapterInput | undefined,
): readonly string[] {
  const original = [relationship.personAId, relationship.personBId];
  if (!familyGroup) return original;
  const memberOrder = new Map(
    familyGroup.members.map(member => [member.personId, member.displayOrder]),
  );
  return [...original].sort((a, b) => {
    const aOrder = memberOrder.get(a);
    const bOrder = memberOrder.get(b);
    return (
      compareOptionalNumber(aOrder, bOrder) ||
      original.indexOf(a) - original.indexOf(b)
    );
  });
}

function orderedParentIds(
  relationships: readonly ParentChildRelationship[],
  familyGroupMembers: readonly FamilyGroupMember[],
): readonly string[] {
  const memberOrder = new Map(
    familyGroupMembers
      .filter(member => member.memberRole === "parent" || member.memberRole === "partner")
      .map(member => [member.personId, member.displayOrder]),
  );
  const sorted = [...relationships].sort((a, b) => {
    return (
      compareOptionalNumber(memberOrder.get(a.parentId), memberOrder.get(b.parentId)) ||
      parentRoleOrder(a.parentRoleLabel) - parentRoleOrder(b.parentRoleLabel) ||
      compareStrings(a.id, b.id)
    );
  });
  return uniqueBy(sorted.map(item => item.parentId), item => item);
}

function parentRoleOrder(role: ParentRoleLabel): number {
  const order: Record<ParentRoleLabel, number> = {
    father: 0,
    stepfather: 1,
    adoptive_father: 2,
    parent: 3,
    guardian: 4,
    custom: 5,
    adoptive_mother: 6,
    stepmother: 7,
    mother: 8,
  };
  return order[role];
}

function sortGroupMembers(
  members: readonly FamilyGroupMember[],
): readonly FamilyGroupMember[] {
  return [...members].sort(
    (a, b) =>
      a.displayOrder - b.displayOrder ||
      compareStrings(a.personId, b.personId) ||
      compareStrings(a.memberRole, b.memberRole),
  );
}

function normalizeSex(value: string): TreePerson["sex"] {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("uk-UA");
  if (["male", "m", "man", "чоловік", "чоловіча"].includes(normalized)) {
    return "male";
  }
  if (["female", "f", "woman", "жінка", "жіноча"].includes(normalized)) {
    return "female";
  }
  if (["other", "nonbinary", "non-binary", "інше", "інша"].includes(normalized)) {
    return "other";
  }
  return "unknown";
}

function lifeDate(
  events: readonly FamilyTreePersonTimelineEvent[],
  eventTypes: readonly FamilyTreePersonTimelineEvent["eventType"][],
): SortableGenealogyDate | undefined {
  for (const event of events) {
    if (!eventTypes.includes(event.eventType)) continue;
    const display =
      event.dateText.trim() ||
      event.eventDate.trim() ||
      dateRangeDisplay(event.dateFrom, event.dateTo);
    if (!display) continue;
    return sortableDate(
      display,
      event.eventDate || event.dateFrom || event.dateText,
    );
  }
  return undefined;
}

function dateRangeDisplay(from: string, to: string): string {
  const start = from.trim();
  const end = to.trim();
  if (start && end) return `${start}–${end}`;
  return start || end;
}

function sortableDate(
  displayValue: string,
  sortValue = displayValue,
): SortableGenealogyDate | undefined {
  const display = displayValue.trim();
  if (!display) return undefined;
  const sort = normalizedDateSort(sortValue);
  return sort ? { display, sort } : { display };
}

function normalizedDateSort(value: string): string | undefined {
  const raw = value.trim();
  const fullIso = raw.match(
    /\b(1[0-9]{3}|20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\b/,
  );
  if (fullIso) return `${fullIso[1]}-${fullIso[2]}-${fullIso[3]}`;
  const dotted = raw.match(
    /\b(0?[1-9]|[12][0-9]|3[01])[./](0?[1-9]|1[0-2])[./](1[0-9]{3}|20[0-9]{2})\b/,
  );
  if (dotted) {
    return `${dotted[3]}-${dotted[2]!.padStart(2, "0")}-${dotted[1]!.padStart(2, "0")}`;
  }
  const partialIso = raw.match(
    /\b(1[0-9]{3}|20[0-9]{2})-(0[1-9]|1[0-2])\b/,
  );
  if (partialIso) return `${partialIso[1]}-${partialIso[2]}`;
  const year = raw.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return year?.[1];
}

function numericOrderKey(value: number): string {
  if (!Number.isSafeInteger(value)) return `number:${String(value)}`;
  const shifted = BigInt(value) + ORDER_OFFSET;
  return `number:${shifted.toString().padStart(17, "0")}`;
}

function metadataDisplayOrder(
  metadata: Readonly<Record<string, unknown>>,
): string | undefined {
  const value =
    metadata.displayOrder ??
    metadata.display_order ??
    metadata.sortOrder ??
    metadata.sort_order;
  if (typeof value === "number" && Number.isFinite(value)) {
    return numericOrderKey(value);
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    return Number.isSafeInteger(numeric) && String(numeric) === trimmed
      ? numericOrderKey(numeric)
      : `string:${trimmed}`;
  }
  return undefined;
}

function metadataExpectedParentSlots(
  metadata: Readonly<Record<string, unknown>>,
  actualParentCount: number,
): number | undefined {
  const value = metadata.expectedParentSlots ?? metadata.expected_parent_slots;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < actualParentCount ||
    value < 0
  ) {
    return undefined;
  }
  return value;
}

function firstBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (!result.has(id)) result.set(id, value);
  }
  return result;
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const grouped = result.get(id);
    if (grouped) grouped.push(value);
    else result.set(id, [value]);
  }
  return result;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...firstBy(values, key).values()];
}

function compareOptionalNumber(
  a: number | undefined,
  b: number | undefined,
): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
