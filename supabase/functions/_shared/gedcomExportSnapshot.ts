import type { Person } from "../../../src/types/index.ts";
import type {
  EvidenceStatus,
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
  FamilyTreePrivacyStatus,
} from "../../../src/types/familyTree.ts";
import type {
  FamilyTreeProjection,
  FamilyTreeProjectionEdge,
  FamilyTreeProjectionNode,
} from "../../../src/utils/familyTreeProjection.ts";

export type GedcomExportPersonRow = {
  id: string;
  project_id: string;
  research_id?: string | null;
  gender?: string | null;
  status?: string | null;
  surname?: string | null;
  given_name?: string | null;
  patronymic?: string | null;
  full_name?: string | null;
  name_variants?: string | null;
  surname_variants?: string | null;
  birth_date?: string | null;
  birth_year_from?: string | null;
  birth_year_to?: string | null;
  birth_place?: string | null;
  marriage_date?: string | null;
  marriage_place?: string | null;
  death_date?: string | null;
  death_year_from?: string | null;
  death_year_to?: string | null;
  death_place?: string | null;
  residence_places?: string | null;
  social_status?: string | null;
  religion?: string | null;
  occupation?: string | null;
  notes?: string | null;
  custom_fields?: unknown;
  is_living?: boolean | null;
  privacy_status?: string | null;
};

export type GedcomExportNameRow = {
  id: string;
  project_id: string;
  person_id: string;
  name_type?: string | null;
  language_code?: string | null;
  script_code?: string | null;
  surname?: string | null;
  given_name?: string | null;
  patronymic?: string | null;
  full_name?: string | null;
  original_text?: string | null;
  is_primary?: boolean | null;
  is_preferred?: boolean | null;
  evidence_status?: string | null;
  confidence?: number | null;
  source_document_id?: string | null;
  source_finding_id?: string | null;
  notes?: string | null;
  metadata?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

export type GedcomExportEventRow = {
  id: string;
  project_id: string;
  person_id: string;
  event_type?: string | null;
  title?: string | null;
  event_date?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  date_text?: string | null;
  place_name?: string | null;
  geo?: unknown;
  event_role?: string | null;
  evidence_status?: string | null;
  confidence?: number | null;
  source_document_id?: string | null;
  source_finding_id?: string | null;
  notes?: string | null;
  metadata?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

export type GedcomExportPartnerRow = {
  id: string;
  person_a_id: string;
  person_b_id: string;
  family_group_id?: string | null;
  relationship_type?: string | null;
  start_date?: string | null;
  start_place?: string | null;
  end_date?: string | null;
  end_place?: string | null;
  evidence_status?: string | null;
  confidence?: number | null;
  source_document_id?: string | null;
  source_finding_id?: string | null;
  notes?: string | null;
  metadata?: unknown;
};

export type GedcomExportParentChildRow = {
  id: string;
  parent_id: string;
  child_id: string;
  parent_set_id?: string | null;
  family_group_id?: string | null;
  relationship_type?: string | null;
  parent_role_label?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  evidence_status?: string | null;
  confidence?: number | null;
  is_bloodline?: boolean | null;
  source_document_id?: string | null;
  source_finding_id?: string | null;
  notes?: string | null;
  metadata?: unknown;
};

export type GedcomExportAssociationRow = {
  id: string;
  person_a_id: string;
  person_b_id: string;
  association_type?: string | null;
  evidence_status?: string | null;
  confidence?: number | null;
  source_document_id?: string | null;
  source_finding_id?: string | null;
  notes?: string | null;
  metadata?: unknown;
};

export type GedcomExportParentSetRow = {
  id: string;
  set_type?: string | null;
};

export type GedcomExportSnapshot = {
  projectId: string;
  treeId: string;
  rootPersonId?: string | null;
  people: GedcomExportPersonRow[];
  names: GedcomExportNameRow[];
  events: GedcomExportEventRow[];
  partnerRelationships: GedcomExportPartnerRow[];
  parentChildRelationships: GedcomExportParentChildRow[];
  associationRelationships: GedcomExportAssociationRow[];
  parentSets: GedcomExportParentSetRow[];
};

const PERSON_EVENTS_KEY = "__trackerRoduPersonEvents";
const MAIDEN_SURNAME_KEY = "__trackerRoduMaidenSurname";
const SUPPORTED_EVENT_TYPES = new Set<FamilyTreePersonTimelineEvent["eventType"]>([
  "birth", "baptism", "christening", "marriage", "divorce", "residence", "census",
  "revision_list", "confession_list", "household_register", "immigration", "emigration",
  "military", "occupation", "education", "nationality", "death", "burial", "cremation",
  "probate", "mention", "other",
]);

export function buildGedcomExportProjection(snapshot: GedcomExportSnapshot): FamilyTreeProjection {
  const namesByPerson = groupBy(snapshot.names, (row) => row.person_id);
  const eventsByPerson = groupBy(snapshot.events, (row) => row.person_id);
  const nodes = snapshot.people.map((person) => buildNode(
    snapshot.projectId,
    person,
    namesByPerson.get(person.id) ?? [],
    eventsByPerson.get(person.id) ?? [],
  ));
  const knownPeople = new Set(nodes.map((node) => node.personId));
  const parentSetTypes = new Map(snapshot.parentSets.map((row) => [row.id, text(row.set_type)]));
  const partnerEdges = snapshot.partnerRelationships
    .filter((row) => knownPeople.has(row.person_a_id) && knownPeople.has(row.person_b_id))
    .map(partnerEdge);
  const parentChildEdges = snapshot.parentChildRelationships
    .filter((row) => knownPeople.has(row.parent_id) && knownPeople.has(row.child_id))
    .map((row) => parentChildEdge(row, parentSetTypes.get(text(row.parent_set_id))));
  const associationEdges = snapshot.associationRelationships
    .filter((row) => knownPeople.has(row.person_a_id) && knownPeople.has(row.person_b_id))
    .map(associationEdge);
  const edges = [...parentChildEdges, ...partnerEdges, ...associationEdges];
  const connected = new Set(edges.flatMap((edge) => [edge.fromPersonId, edge.toPersonId]));

  return {
    projectId: snapshot.projectId,
    treeId: snapshot.treeId,
    nodes,
    edges,
    parentChildEdges,
    partnerEdges,
    associationEdges,
    issues: [],
    stats: {
      persons: nodes.length,
      connectedPersons: connected.size,
      isolatedPersons: nodes.length - connected.size,
      parentChildEdges: parentChildEdges.length,
      partnerEdges: partnerEdges.length,
      associationEdges: associationEdges.length,
      skippedLegacyRelations: 0,
    },
  };
}

function buildNode(
  projectId: string,
  person: GedcomExportPersonRow,
  nameRows: GedcomExportNameRow[],
  eventRows: GedcomExportEventRow[],
): FamilyTreeProjectionNode {
  const customFields = record(person.custom_fields);
  const names = nameRows.map(mapName);
  addMaidenName(projectId, person, names, customFields);
  if (!names.length) names.push(fallbackName(projectId, person));
  const primaryName = names.find((name) => name.isPrimary)
    ?? names.find((name) => name.isPreferred)
    ?? names[0];
  const events = eventRows.map(mapEvent);
  addSavedProfileEvents(projectId, person.id, events, customFields);
  addCoreProfileEvents(projectId, person, events);

  return {
    personId: person.id,
    researchId: text(person.research_id),
    displayName: primaryName.fullName || primaryName.originalText || person.id,
    primaryName,
    names,
    events,
    gender: text(person.gender) as Person["gender"],
    status: text(person.status) as Person["status"],
    isLiving: person.is_living === true,
    privacyStatus: privacyStatus(person.privacy_status),
    hasDates: events.some((event) => Boolean(event.eventDate || event.dateFrom || event.dateTo || event.dateText)),
    hasPlaces: events.some((event) => Boolean(event.placeName)),
    metadata: {
      personProfile: {
        id: person.id,
        projectId,
        researchId: text(person.research_id),
        gender: text(person.gender),
        status: text(person.status),
        surname: text(person.surname),
        givenName: text(person.given_name),
        patronymic: text(person.patronymic),
        fullName: text(person.full_name),
        maidenSurname: text(customFields[MAIDEN_SURNAME_KEY]),
        isLiving: person.is_living === true,
        privacyStatus: privacyStatus(person.privacy_status),
        nameVariants: text(person.name_variants),
        surnameVariants: text(person.surname_variants),
        birthDate: text(person.birth_date),
        birthYearFrom: text(person.birth_year_from),
        birthYearTo: text(person.birth_year_to),
        birthPlace: text(person.birth_place),
        marriageDate: text(person.marriage_date),
        marriagePlace: text(person.marriage_place),
        deathDate: text(person.death_date),
        deathYearFrom: text(person.death_year_from),
        deathYearTo: text(person.death_year_to),
        deathPlace: text(person.death_place),
        residencePlaces: text(person.residence_places),
        socialStatus: text(person.social_status),
        religion: text(person.religion),
        occupation: text(person.occupation),
        notes: text(person.notes),
        customFields,
      },
    },
  };
}

function mapName(row: GedcomExportNameRow): FamilyTreePersonName {
  const fullName = text(row.full_name) || [row.surname, row.given_name, row.patronymic]
    .map(text)
    .filter(Boolean)
    .join(" ");
  return {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id,
    nameType: (text(row.name_type) || "primary") as FamilyTreePersonName["nameType"],
    languageCode: text(row.language_code),
    scriptCode: text(row.script_code),
    surname: text(row.surname),
    givenName: text(row.given_name),
    patronymic: text(row.patronymic),
    fullName,
    originalText: text(row.original_text) || fullName,
    isPrimary: row.is_primary === true,
    isPreferred: row.is_preferred === true,
    evidenceStatus: evidenceStatus(row.evidence_status),
    confidence: number(row.confidence),
    sourceDocumentId: nullableText(row.source_document_id),
    sourceFindingId: nullableText(row.source_finding_id),
    notes: text(row.notes),
    metadata: record(row.metadata),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function fallbackName(projectId: string, person: GedcomExportPersonRow): FamilyTreePersonName {
  const surname = text(person.surname);
  const givenName = text(person.given_name);
  const patronymic = text(person.patronymic);
  const fullName = text(person.full_name) || [surname, givenName, patronymic].filter(Boolean).join(" ") || person.id;
  return {
    id: `export-name:${person.id}`,
    projectId,
    personId: person.id,
    nameType: "primary",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname,
    givenName,
    patronymic,
    fullName,
    originalText: fullName,
    isPrimary: true,
    isPreferred: true,
    evidenceStatus: "unknown",
    confidence: 0,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: { source: "persons" },
    createdAt: "",
    updatedAt: "",
  };
}

function addMaidenName(
  projectId: string,
  person: GedcomExportPersonRow,
  names: FamilyTreePersonName[],
  customFields: Record<string, unknown>,
): void {
  const maidenSurname = text(customFields[MAIDEN_SURNAME_KEY]).trim();
  if (!maidenSurname || names.some((name) => name.nameType === "birth" && name.surname === maidenSurname)) return;
  const fullName = [maidenSurname, text(person.given_name), text(person.patronymic)].filter(Boolean).join(" ");
  names.push({
    ...fallbackName(projectId, { ...person, surname: maidenSurname, full_name: fullName }),
    id: `export-maiden-name:${person.id}`,
    nameType: "birth",
    isPrimary: false,
    isPreferred: false,
  });
}

function mapEvent(row: GedcomExportEventRow): FamilyTreePersonTimelineEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id,
    eventType: eventType(row.event_type, row.title),
    title: text(row.title),
    eventDate: text(row.event_date),
    dateFrom: text(row.date_from),
    dateTo: text(row.date_to),
    dateText: text(row.date_text),
    placeName: text(row.place_name),
    geo: record(row.geo) as unknown as FamilyTreePersonTimelineEvent["geo"],
    eventRole: (text(row.event_role) || "subject") as FamilyTreePersonTimelineEvent["eventRole"],
    evidenceStatus: evidenceStatus(row.evidence_status),
    confidence: number(row.confidence),
    sourceDocumentId: nullableText(row.source_document_id),
    sourceFindingId: nullableText(row.source_finding_id),
    notes: text(row.notes),
    metadata: record(row.metadata),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function addSavedProfileEvents(
  projectId: string,
  personId: string,
  events: FamilyTreePersonTimelineEvent[],
  customFields: Record<string, unknown>,
): void {
  const saved = customFields[PERSON_EVENTS_KEY];
  if (!Array.isArray(saved)) return;
  const seen = new Set(events.map(eventIdentity));
  for (const [index, candidate] of saved.entries()) {
    const value = record(candidate);
    const mapped: FamilyTreePersonTimelineEvent = {
      id: text(value.id) || `profile-event:${personId}:${index}`,
      projectId,
      personId,
      eventType: eventType(value.type, value.title),
      title: text(value.title),
      eventDate: text(value.date),
      dateFrom: "",
      dateTo: "",
      dateText: text(value.date),
      placeName: text(value.placeName),
      geo: record(value.geo) as unknown as FamilyTreePersonTimelineEvent["geo"],
      eventRole: "subject",
      evidenceStatus: "unknown",
      confidence: 0,
      sourceDocumentId: null,
      sourceFindingId: null,
      notes: text(value.notes),
      metadata: { source: PERSON_EVENTS_KEY },
      createdAt: "",
      updatedAt: "",
    };
    const identity = eventIdentity(mapped);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(mapped);
  }
}

function addCoreProfileEvents(
  projectId: string,
  person: GedcomExportPersonRow,
  events: FamilyTreePersonTimelineEvent[],
): void {
  addCoreEvent(projectId, person.id, events, "birth", person.birth_date, person.birth_year_from, person.birth_year_to, person.birth_place);
  addCoreEvent(projectId, person.id, events, "marriage", person.marriage_date, "", "", person.marriage_place);
  addCoreEvent(projectId, person.id, events, "death", person.death_date, person.death_year_from, person.death_year_to, person.death_place);
  if (text(person.residence_places) && !events.some((event) => event.eventType === "residence")) {
    addCoreEvent(projectId, person.id, events, "residence", "", "", "", person.residence_places);
  }
}

function addCoreEvent(
  projectId: string,
  personId: string,
  events: FamilyTreePersonTimelineEvent[],
  type: FamilyTreePersonTimelineEvent["eventType"],
  exactValue: unknown,
  fromValue: unknown,
  toValue: unknown,
  placeValue: unknown,
): void {
  if (events.some((event) => event.eventType === type)) return;
  const exact = text(exactValue);
  const from = text(fromValue);
  const to = text(toValue);
  const place = text(placeValue);
  if (!exact && !from && !to && !place) return;
  events.push({
    id: `profile-${type}:${personId}`,
    projectId,
    personId,
    eventType: type,
    title: "",
    eventDate: exact,
    dateFrom: from,
    dateTo: to,
    dateText: exact || dateRange(from, to),
    placeName: place,
    geo: null,
    eventRole: "subject",
    evidenceStatus: "unknown",
    confidence: 0,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: { source: "persons" },
    createdAt: "",
    updatedAt: "",
  });
}

function partnerEdge(row: GedcomExportPartnerRow): FamilyTreeProjectionEdge {
  return {
    id: row.id,
    source: "graph_edge",
    kind: "partner",
    fromPersonId: row.person_a_id,
    toPersonId: row.person_b_id,
    relationshipType: (text(row.relationship_type) || "unknown") as FamilyTreeProjectionEdge["relationshipType"],
    familyGroupId: nullableText(row.family_group_id),
    evidenceStatus: evidenceStatus(row.evidence_status),
    confidence: number(row.confidence),
    isBloodline: false,
    lineStyle: "solid",
    legacyRelationId: null,
    metadata: {
      ...record(row.metadata),
      startDate: text(row.start_date),
      startPlace: text(row.start_place),
      endDate: text(row.end_date),
      endPlace: text(row.end_place),
      notes: text(row.notes),
      sourceDocumentId: nullableText(row.source_document_id),
      sourceFindingId: nullableText(row.source_finding_id),
    },
  };
}

function parentChildEdge(
  row: GedcomExportParentChildRow,
  parentSetType?: string,
): FamilyTreeProjectionEdge {
  return {
    id: row.id,
    source: "graph_edge",
    kind: "parent_child",
    fromPersonId: row.parent_id,
    toPersonId: row.child_id,
    relationshipType: (text(row.relationship_type) || "unknown") as FamilyTreeProjectionEdge["relationshipType"],
    parentRoleLabel: text(row.parent_role_label) as FamilyTreeProjectionEdge["parentRoleLabel"],
    parentSetId: nullableText(row.parent_set_id),
    parentSetType: (parentSetType || undefined) as FamilyTreeProjectionEdge["parentSetType"],
    familyGroupId: nullableText(row.family_group_id),
    evidenceStatus: evidenceStatus(row.evidence_status),
    confidence: number(row.confidence),
    isBloodline: row.is_bloodline === true,
    lineStyle: row.is_bloodline === false ? "dashed" : "solid",
    legacyRelationId: null,
    metadata: {
      ...record(row.metadata),
      startDate: text(row.start_date),
      endDate: text(row.end_date),
      notes: text(row.notes),
      sourceDocumentId: nullableText(row.source_document_id),
      sourceFindingId: nullableText(row.source_finding_id),
    },
  };
}

function associationEdge(row: GedcomExportAssociationRow): FamilyTreeProjectionEdge {
  return {
    id: row.id,
    source: "graph_edge",
    kind: "association",
    fromPersonId: row.person_a_id,
    toPersonId: row.person_b_id,
    relationshipType: (text(row.association_type) || "other") as FamilyTreeProjectionEdge["relationshipType"],
    evidenceStatus: evidenceStatus(row.evidence_status),
    confidence: number(row.confidence),
    isBloodline: false,
    lineStyle: "dotted",
    legacyRelationId: null,
    metadata: {
      ...record(row.metadata),
      notes: text(row.notes),
      sourceDocumentId: nullableText(row.source_document_id),
      sourceFindingId: nullableText(row.source_finding_id),
    },
  };
}

function eventType(typeValue: unknown, titleValue: unknown): FamilyTreePersonTimelineEvent["eventType"] {
  const type = text(typeValue) as FamilyTreePersonTimelineEvent["eventType"];
  if (SUPPORTED_EVENT_TYPES.has(type)) return type;
  const title = text(titleValue).toLocaleLowerCase("uk");
  if (title.includes("перепис")) return "census";
  if (title.includes("військ")) return "military";
  if (title.includes("профес") || title.includes("робот")) return "occupation";
  return "other";
}

function eventIdentity(event: FamilyTreePersonTimelineEvent): string {
  return [event.eventType, event.eventDate || event.dateText, event.placeName, event.notes].join("|");
}

function dateRange(from: string, to: string): string {
  if (from && to) return from === to ? from : `${from}-${to}`;
  return from || to;
}

function evidenceStatus(value: unknown): EvidenceStatus {
  return value === "proven" || value === "likely" || value === "disputed" || value === "disproven"
    ? value
    : "unknown";
}

function privacyStatus(value: unknown): FamilyTreePrivacyStatus {
  return value === "project" || value === "public" || value === "confidential" ? value : "private";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const itemKey = key(item);
    const values = result.get(itemKey) ?? [];
    values.push(item);
    result.set(itemKey, values);
  }
  return result;
}
