import type { Person, PersonEvent, PersonRelation } from "../types";
import type {
  EvidenceStatus,
  FamilyTreeGraphEdgeIntent,
  FamilyTreeGraphIssue,
  FamilyTreePersonName,
  FamilyTreePersonNameType,
  FamilyTreePersonTimelineEvent,
  FamilyTreePersonTimelineEventType,
  ParentChildRelationship,
} from "../types/familyTree";
import { legacyRelationToGraphIntent, validateFamilyGraph } from "./familyTreeGraph.ts";

export interface FamilyTreeProjectionNode {
  personId: string;
  researchId: string;
  displayName: string;
  primaryName: FamilyTreePersonName;
  names: FamilyTreePersonName[];
  events: FamilyTreePersonTimelineEvent[];
  gender: Person["gender"];
  status: Person["status"];
  isLiving: boolean;
  privacyStatus: Person["privacyStatus"];
  rootRelationshipLabel?: string;
  hasDates: boolean;
  hasPlaces: boolean;
  metadata?: Record<string, unknown>;
}

export interface FamilyTreeProjectionEdge extends FamilyTreeGraphEdgeIntent {
  id: string;
  source: "legacy_relation" | "graph_edge";
  parentSetId?: string | null;
  familyGroupId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FamilyTreeProjection {
  projectId: string;
  treeId: string;
  nodes: FamilyTreeProjectionNode[];
  edges: FamilyTreeProjectionEdge[];
  parentChildEdges: FamilyTreeProjectionEdge[];
  partnerEdges: FamilyTreeProjectionEdge[];
  associationEdges: FamilyTreeProjectionEdge[];
  issues: FamilyTreeGraphIssue[];
  stats: {
    persons: number;
    connectedPersons: number;
    isolatedPersons: number;
    parentChildEdges: number;
    partnerEdges: number;
    associationEdges: number;
    skippedLegacyRelations: number;
  };
}

export function buildFamilyTreeProjection(input: {
  projectId: string;
  treeId?: string;
  persons: Person[];
  legacyRelations: PersonRelation[];
  includeIsolatedPersons?: boolean;
}): FamilyTreeProjection {
  const treeId = input.treeId ?? "projection";
  const personIds = new Set(input.persons.map((person) => person.id));
  const issues: FamilyTreeGraphIssue[] = [];
  const edges: FamilyTreeProjectionEdge[] = [];
  const edgeKeys = new Set<string>();
  let skippedLegacyRelations = 0;

  for (const relation of input.legacyRelations) {
    if (!personIds.has(relation.personId)) {
      skippedLegacyRelations += 1;
      issues.push({
        severity: "warning",
        code: "legacy_relation_missing_person",
        message: "Legacy relation points from a person that is not present in this projection.",
        personIds: [relation.personId],
        relationshipIds: [relation.id],
      });
      continue;
    }
    if (!personIds.has(relation.relatedPersonId)) {
      skippedLegacyRelations += 1;
      issues.push({
        severity: "warning",
        code: "legacy_relation_missing_related_person",
        message: "Legacy relation points to a related person that is not present in this projection.",
        personIds: [relation.personId, relation.relatedPersonId],
        relationshipIds: [relation.id],
      });
      continue;
    }

    const intent = legacyRelationToGraphIntent(relation);
    if (!intent) {
      skippedLegacyRelations += 1;
      issues.push({
        severity: "needs_review",
        code: "legacy_relation_unknown_type",
        message: "Legacy relation type cannot be projected into the family tree graph automatically.",
        personIds: [relation.personId, relation.relatedPersonId],
        relationshipIds: [relation.id],
      });
      continue;
    }

    const key = edgeKey(intent);
    if (edgeKeys.has(key)) {
      issues.push({
        severity: "info",
        code: "duplicate_legacy_edge",
        message: "Equivalent legacy relation is already represented in this projection.",
        personIds: [intent.fromPersonId, intent.toPersonId],
        relationshipIds: [relation.id],
      });
      continue;
    }

    edgeKeys.add(key);
    edges.push({
      ...intent,
      id: `legacy:${relation.id}`,
      source: "legacy_relation",
    });
  }

  const connectedPersonIds = new Set<string>();
  for (const edge of edges) {
    connectedPersonIds.add(edge.fromPersonId);
    connectedPersonIds.add(edge.toPersonId);
  }

  const includeIsolatedPersons = input.includeIsolatedPersons ?? true;
  const nodes = input.persons
    .filter((person) => includeIsolatedPersons || connectedPersonIds.has(person.id))
    .map((person) => personToProjectionNode(input.projectId, person))
    .sort((first, second) => first.displayName.localeCompare(second.displayName, "uk"));

  const parentChildEdges = edges.filter((edge) => edge.kind === "parent_child");
  const parentChildRelationships = parentChildEdges.map((edge) =>
    projectionEdgeToParentChildRelationship(input.projectId, treeId, edge),
  );

  issues.push(...validateFamilyGraph({ parentChildRelationships }));

  return {
    projectId: input.projectId,
    treeId,
    nodes,
    edges,
    parentChildEdges,
    partnerEdges: edges.filter((edge) => edge.kind === "partner"),
    associationEdges: edges.filter((edge) => edge.kind === "association"),
    issues,
    stats: {
      persons: input.persons.length,
      connectedPersons: connectedPersonIds.size,
      isolatedPersons: input.persons.filter((person) => !connectedPersonIds.has(person.id)).length,
      parentChildEdges: parentChildEdges.length,
      partnerEdges: edges.filter((edge) => edge.kind === "partner").length,
      associationEdges: edges.filter((edge) => edge.kind === "association").length,
      skippedLegacyRelations,
    },
  };
}

export function personToProjectionNode(projectId: string, person: Person): FamilyTreeProjectionNode {
  const names = deriveFamilyTreePersonNames(projectId, person);
  const events = deriveFamilyTreePersonTimelineEvents(projectId, person);
  const primaryName = names.find((name) => name.isPrimary) ?? names[0];
  const hasDates = events.some((event) => event.eventDate || event.dateFrom || event.dateTo || event.dateText);
  const hasPlaces = events.some((event) => event.placeName);

  return {
    personId: person.id,
    researchId: person.researchId,
    displayName: primaryName?.fullName || person.id,
    primaryName,
    names,
    events,
    gender: person.gender,
    status: person.status,
    isLiving: person.isLiving ?? false,
    privacyStatus: person.privacyStatus ?? "private",
    hasDates,
    hasPlaces,
    metadata: {
      personProfile: person,
    },
  };
}

export function deriveFamilyTreePersonNames(projectId: string, person: Person): FamilyTreePersonName[] {
  const createdAt = person.createdAt;
  const updatedAt = person.updatedAt;
  const primaryFullName = composePersonName(person);
  const names: FamilyTreePersonName[] = [
    nameRecord(projectId, person, "primary", "primary", {
      surname: person.surname,
      givenName: person.givenName,
      patronymic: person.patronymic,
      fullName: primaryFullName,
      originalText: primaryFullName,
      isPrimary: true,
      isPreferred: true,
      evidenceStatus: statusToEvidence(person.status),
      createdAt,
      updatedAt,
    }),
  ];

  for (const [index, value] of splitVariantValues(person.nameVariants).entries()) {
    names.push(nameRecord(projectId, person, `alias-name-${index}`, "alias", {
      fullName: value,
      originalText: value,
      evidenceStatus: "unknown",
      createdAt,
      updatedAt,
    }));
  }

  const maidenSurname = person.maidenSurname?.trim() ?? "";
  if (maidenSurname && maidenSurname !== person.surname.trim()) {
    const fullName = [maidenSurname, person.givenName, person.patronymic].filter(Boolean).join(" ");
    names.push(nameRecord(projectId, person, "maiden-surname", "birth", {
      surname: maidenSurname,
      givenName: person.givenName,
      patronymic: person.patronymic,
      fullName,
      originalText: fullName || maidenSurname,
      evidenceStatus: statusToEvidence(person.status),
      createdAt,
      updatedAt,
    }));
  }

  for (const [index, value] of splitVariantValues(person.surnameVariants).entries()) {
    names.push(nameRecord(projectId, person, `alias-surname-${index}`, "surname_variant", {
      surname: value,
      fullName: [value, person.givenName, person.patronymic].filter(Boolean).join(" "),
      originalText: value,
      evidenceStatus: "unknown",
      createdAt,
      updatedAt,
    }));
  }

  return dedupeNames(names);
}

export function deriveFamilyTreePersonTimelineEvents(
  projectId: string,
  person: Person,
): FamilyTreePersonTimelineEvent[] {
  const events: FamilyTreePersonTimelineEvent[] = [];
  const pushFieldEvent = (
    eventType: FamilyTreePersonTimelineEventType,
    eventDate: string,
    dateFrom: string,
    dateTo: string,
    placeName: string,
    idSuffix: string,
  ) => {
    const dateText = eventDate || formatDateRange(dateFrom, dateTo);
    if (!dateText && !placeName) return;
    events.push(eventRecord(projectId, person, idSuffix, eventType, {
      eventDate,
      dateFrom,
      dateTo,
      dateText,
      placeName,
      evidenceStatus: statusToEvidence(person.status),
    }));
  };

  pushFieldEvent("birth", person.birthDate, person.birthYearFrom, person.birthYearTo, person.birthPlace, "birth");
  pushFieldEvent("marriage", person.marriageDate, "", "", person.marriagePlace, "marriage");
  pushFieldEvent("death", person.deathDate, person.deathYearFrom, person.deathYearTo, person.deathPlace, "death");

  for (const [index, placeName] of splitVariantValues(person.residencePlaces).entries()) {
    events.push(eventRecord(projectId, person, `residence-${index}`, "residence", {
      placeName,
      evidenceStatus: statusToEvidence(person.status),
    }));
  }

  for (const event of person.events ?? []) {
    events.push(eventFromPersonEvent(projectId, person, event));
  }

  return dedupeEvents(events);
}

function nameRecord(
  projectId: string,
  person: Person,
  idSuffix: string,
  nameType: FamilyTreePersonNameType,
  overrides: Partial<FamilyTreePersonName>,
): FamilyTreePersonName {
  return {
    id: `derived-name:${person.id}:${idSuffix}`,
    projectId,
    personId: person.id,
    nameType,
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: "",
    givenName: "",
    patronymic: "",
    fullName: "",
    originalText: "",
    isPrimary: false,
    isPreferred: false,
    evidenceStatus: "unknown",
    confidence: 50,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: { source: "legacy_person_fields" },
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
    ...overrides,
  };
}

function eventRecord(
  projectId: string,
  person: Person,
  idSuffix: string,
  eventType: FamilyTreePersonTimelineEventType,
  overrides: Partial<FamilyTreePersonTimelineEvent>,
): FamilyTreePersonTimelineEvent {
  return {
    id: `derived-event:${person.id}:${idSuffix}`,
    projectId,
    personId: person.id,
    eventType,
    title: "",
    eventDate: "",
    dateFrom: "",
    dateTo: "",
    dateText: "",
    placeName: "",
    geo: null,
    eventRole: "subject",
    evidenceStatus: "unknown",
    confidence: 50,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: { source: "legacy_person_fields" },
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
    ...overrides,
  };
}

function eventFromPersonEvent(
  projectId: string,
  person: Person,
  event: PersonEvent,
): FamilyTreePersonTimelineEvent {
  const eventType = mapPersonEventType(event.type);
  const eventDate = event.date ?? "";
  return eventRecord(projectId, person, `custom-${event.id}`, eventType, {
    title: event.title ?? "",
    eventDate,
    dateText: eventDate,
    placeName: event.placeName ?? "",
    geo: event.geo ?? null,
    notes: event.notes ?? "",
    metadata: {
      source: "person_events",
      sourceEventId: event.id,
      gedcomValue: event.value ?? "",
      age: event.age ?? "",
      cause: event.cause ?? "",
      address: event.address ?? "",
    },
  });
}

function projectionEdgeToParentChildRelationship(
  projectId: string,
  treeId: string,
  edge: FamilyTreeProjectionEdge,
): ParentChildRelationship {
  return {
    id: edge.id,
    projectId,
    treeId,
    parentId: edge.fromPersonId,
    childId: edge.toPersonId,
    parentSetId: `projection-parent-set:${edge.toPersonId}:${edge.parentSetType ?? "unknown"}`,
    familyGroupId: null,
    relationshipType: edge.relationshipType as ParentChildRelationship["relationshipType"],
    parentRoleLabel: edge.parentRoleLabel ?? "parent",
    startDate: "",
    endDate: "",
    evidenceStatus: edge.evidenceStatus,
    confidence: edge.confidence,
    isPrimaryForDisplay: false,
    isBloodline: edge.isBloodline ?? false,
    isLegal: edge.isLegal ?? false,
    isSocial: edge.isSocial ?? false,
    privacyStatus: "private",
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {
      source: edge.source,
      legacyRelationId: edge.legacyRelationId,
    },
    createdAt: "",
    updatedAt: "",
  };
}

function composePersonName(person: Person): string {
  return [person.surname, person.givenName, person.patronymic]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ") || person.fullName.trim();
}

function splitVariantValues(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function dedupeNames(names: FamilyTreePersonName[]): FamilyTreePersonName[] {
  const seen = new Set<string>();
  const result: FamilyTreePersonName[] = [];
  for (const name of names) {
    const key = [name.nameType, name.fullName, name.surname, name.originalText].join("|").toLocaleLowerCase("uk");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function dedupeEvents(events: FamilyTreePersonTimelineEvent[]): FamilyTreePersonTimelineEvent[] {
  const seen = new Set<string>();
  const result: FamilyTreePersonTimelineEvent[] = [];
  for (const event of events) {
    const key = [
      event.eventType,
      event.eventDate,
      event.dateFrom,
      event.dateTo,
      event.placeName,
      event.sourceFindingId ?? "",
      event.sourceDocumentId ?? "",
    ].join("|").toLocaleLowerCase("uk");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result;
}

function formatDateRange(dateFrom: string, dateTo: string): string {
  if (dateFrom && dateTo) return `${dateFrom}-${dateTo}`;
  return dateFrom || dateTo;
}

function mapPersonEventType(type: PersonEvent["type"]): FamilyTreePersonTimelineEventType {
  switch (type) {
    case "birth":
    case "baptism":
    case "christening":
    case "marriage":
    case "divorce":
    case "residence":
    case "census":
    case "revision_list":
    case "confession_list":
    case "household_register":
    case "immigration":
    case "emigration":
    case "military":
    case "occupation":
    case "education":
    case "nationality":
    case "death":
    case "burial":
    case "cremation":
    case "probate":
    case "mention":
      return type;
    case "other":
    default:
      return "other";
  }
}

function statusToEvidence(status: Person["status"]): EvidenceStatus {
  switch (String(status)) {
    case "доведена":
      return "proven";
    case "частково доведена":
      return "likely";
    case "сумнівна":
      return "disputed";
    case "спростована":
      return "disproven";
    case "гіпотетична":
    default:
      return "unknown";
  }
}

function edgeKey(edge: FamilyTreeGraphEdgeIntent): string {
  if (edge.kind === "partner") {
    const [first, second] = [edge.fromPersonId, edge.toPersonId].sort();
    return [edge.kind, first, second, edge.relationshipType, edge.evidenceStatus].join("|");
  }
  return [
    edge.kind,
    edge.fromPersonId,
    edge.toPersonId,
    edge.relationshipType,
    edge.parentRoleLabel ?? "",
    edge.evidenceStatus,
  ].join("|");
}
