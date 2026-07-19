import type { DocumentRecord, Finding, Person } from "../types";
import type {
  FamilyTreeGraphDto,
  FamilyTreeGraphIssue,
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
  GedcomExportOptions,
  GedcomExportResult,
  GedcomLine,
  GedcomParseResult,
  GedcomPreservedLine,
  GedcomPreservedRecord,
  GedcomRecord,
  GedcomSummary,
} from "../types/familyTree";
import type {
  FamilyTreeProjection,
  FamilyTreeProjectionEdge,
  FamilyTreeProjectionNode,
} from "./familyTreeProjection.ts";
import { familyTreeKinshipLabel } from "./familyTreeKinship.ts";
import {
  GEDCOM_CITATIONS_CUSTOM_FIELD,
  GEDCOM_EDUCATION_CUSTOM_FIELD,
  GEDCOM_MEDIA_CUSTOM_FIELD,
  GEDCOM_NATIONALITY_CUSTOM_FIELD,
  GEDCOM_RAW_RECORD_CUSTOM_FIELD,
  GEDCOM_RIN_CUSTOM_FIELD,
  GEDCOM_UID_CUSTOM_FIELD,
  GEDCOM_VITAL_STATUS_CUSTOM_FIELD,
  GEDCOM_XREF_CUSTOM_FIELD,
  parseGedcomMetadata,
} from "./gedcomMetadata.ts";
import { resolvedFindingSourceUrl } from "./findingSourceUrl.ts";

type GedcomFamily = {
  key: string;
  partnerIds: string[];
  childIds: string[];
  childPedigree: Record<string, "birth" | "adopted" | "foster" | "other">;
  marriageDate: string;
  marriagePlace: string;
  sourceEdgeIds: string[];
  familyGroupId: string | null;
  relationshipType: string;
  endDate: string;
  endPlace: string;
  notes: string;
  evidenceStatus: string;
  confidence: number;
};

type IndexedPreservedRecord = {
  record: GedcomPreservedRecord;
  index: number;
};

type PreservedRecordIndex = {
  head?: GedcomPreservedRecord;
  individualByInternalId: Map<string, IndexedPreservedRecord>;
  individualByPointer: Map<string, IndexedPreservedRecord>;
  familyByPointer: Map<string, GedcomPreservedRecord>;
};

type RawFamilyDescriptor = {
  record: GedcomPreservedRecord;
  children: string[];
};

const GEDCOM_MONTHS: Record<string, string> = {
  "01": "JAN",
  "02": "FEB",
  "03": "MAR",
  "04": "APR",
  "05": "MAY",
  "06": "JUN",
  "07": "JUL",
  "08": "AUG",
  "09": "SEP",
  "10": "OCT",
  "11": "NOV",
  "12": "DEC",
};

export function exportFamilyTreeGraphToGedcom(
  graph: FamilyTreeGraphDto,
  options: GedcomExportOptions = {},
): GedcomExportResult {
  return exportFamilyTreeProjectionToGedcom(graphToProjection(graph), {
    ...options,
    rootPersonId: options.rootPersonId ?? graph.rootPersonId ?? undefined,
  });
}

export function exportFamilyTreeProjectionToGedcom(
  projection: FamilyTreeProjection,
  options: GedcomExportOptions = {},
): GedcomExportResult {
  const warnings: FamilyTreeGraphIssue[] = [];
  const preservedRecords = collectPreservedRecords(projection.nodes, options.preservedRecords ?? []);
  const preservedRecordIndex = indexPreservedRecords(preservedRecords);
  const individualXrefs = buildIndividualXrefs(
    projection.nodes,
    preservedRecords,
    preservedRecordIndex.individualByInternalId,
  );
  const documentSourceXrefs = buildDocumentSourceXrefs(options.documents ?? [], preservedRecords);
  const findingSourceXrefs = buildFindingSourceXrefs(
    options.findings ?? [],
    preservedRecords,
    documentSourceXrefs,
  );
  const families = buildGedcomFamilies(projection, warnings);
  const familyXrefs = buildFamilyXrefs(families, preservedRecords, individualXrefs);
  const familyPointersByPerson = buildFamilyPointersByPerson(families, familyXrefs);
  const associationsByPerson = indexAssociationsByPerson(projection.associationEdges);
  const findingsByPerson = indexFindingsByPerson(options.findings ?? []);
  const lines: string[] = [];
  const sourceName = options.sourceName || "Treker Rodu";
  const submitterXref = "@SUB1@";
  const createdAt = options.createdAt ? new Date(options.createdAt) : new Date();
  const rootPersonId = options.rootPersonId && individualXrefs[options.rootPersonId]
    ? options.rootPersonId
    : projection.nodes[0]?.personId;
  const rootXref = rootPersonId ? individualXrefs[rootPersonId] : "";

  addLine(lines, 0, "HEAD");
  addLine(lines, 1, "SOUR", sanitizeGedcomValue(sourceName));
  addPreservedOriginalHeaderSource(lines, preservedRecordIndex.head);
  addLine(lines, 1, "DEST", "ANY");
  addLine(lines, 1, "DATE", formatGedcomDate(createdAt.toISOString().slice(0, 10)));
  addLine(lines, 1, "CHAR", "UTF-8");
  addLine(lines, 1, "GEDC");
  addLine(lines, 2, "VERS", options.gedcomVersion ?? "5.5.1");
  addLine(lines, 2, "FORM", "LINEAGE-LINKED");
  addLine(lines, 1, "SUBM", submitterXref);
  if (rootXref) {
    addLine(lines, 1, "_ROOT", rootXref);
    addLine(lines, 1, "_TRK_ROOT", rootXref);
  }
  addPreservedHeaderExtensions(lines, preservedRecordIndex.head);

  for (const node of projection.nodes) {
    addIndividual(
      lines,
      node,
      individualXrefs,
      familyPointersByPerson,
      associationsByPerson.get(node.personId) ?? [],
      findingsByPerson.get(node.personId) ?? [],
      options,
      preservedPersonRecord(
        node.personId,
        individualXrefs,
        preservedRecordIndex,
      ),
      documentSourceXrefs,
      findingSourceXrefs,
    );
  }

  for (const family of families) {
    addFamily(
      lines,
      family,
      familyXrefs[family.key],
      individualXrefs,
      warnings,
      preservedRecordIndex.familyByPointer.get(familyXrefs[family.key]),
    );
  }

  addPreservedTopLevelRecords(lines, preservedRecords, new Set([
    ...Object.values(individualXrefs),
    ...Object.values(familyXrefs),
    submitterXref,
  ]));
  addDocumentSourceRecords(lines, options.documents ?? [], documentSourceXrefs, preservedRecords);
  addFindingSourceRecords(
    lines,
    options.findings ?? [],
    findingSourceXrefs,
    documentSourceXrefs,
    preservedRecords,
  );

  addLine(lines, 0, "SUBM", "", submitterXref);
  addLine(lines, 1, "NAME", sanitizeGedcomValue(options.submitterName || sourceName));
  addLine(lines, 0, "TRLR");

  return {
    text: `${lines.join("\r\n")}\r\n`,
    individualXrefs,
    familyXrefs,
    warnings,
  };
}

export function parseGedcom(text: string): GedcomParseResult {
  const lines: GedcomLine[] = [];
  const records: GedcomRecord[] = [];
  const warnings: FamilyTreeGraphIssue[] = [];
  const stack: Array<{ level: number; index: number }> = [];
  const sourceLines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  sourceLines.forEach((raw, sourceIndex) => {
    if (!raw.trim()) return;
    const lineNumber = sourceIndex + 1;
    const parsed = parseGedcomLine(raw, lineNumber);
    if (!parsed) {
      warnings.push({
        severity: "warning",
        code: "gedcom_invalid_line",
        message: `GEDCOM line ${lineNumber} could not be parsed.`,
      });
      return;
    }

    while (stack.length && stack[stack.length - 1].level >= parsed.level) {
      stack.pop();
    }
    const parentIndex = stack.length ? stack[stack.length - 1].index : null;
    const line: GedcomLine = {
      ...parsed,
      parentIndex,
    };
    const lineIndex = lines.push(line) - 1;
    stack.push({ level: line.level, index: lineIndex });

    if (line.level === 0) {
      records.push({
        pointer: line.pointer,
        tag: line.tag,
        value: line.value,
        lineIndex,
        lineNumber: line.lineNumber,
      });
    }
  });

  return {
    lines,
    records,
    warnings,
  };
}

export function summarizeGedcom(parseResult: GedcomParseResult): GedcomSummary {
  const summary: GedcomSummary = {
    individuals: countRecords(parseResult.records, "INDI"),
    families: countRecords(parseResult.records, "FAM"),
    sources: countRecords(parseResult.records, "SOUR"),
    notes: countRecords(parseResult.records, "NOTE"),
    repositories: countRecords(parseResult.records, "REPO"),
    submitters: countRecords(parseResult.records, "SUBM"),
    characterEncoding: firstChildValue(parseResult.lines, "HEAD", "CHAR"),
    gedcomVersion: firstGrandchildValue(parseResult.lines, "HEAD", "GEDC", "VERS"),
  };
  return summary;
}

export function formatGedcomDate(value: string): string {
  const original = value.trim();
  if (/^\d{4}-(?:xx|\d{2})(?:-(?:xx|\d{2}))?$/i.test(original) && /xx/i.test(original)) {
    return sanitizeGedcomValue(original);
  }
  const trimmed = normalizeGedcomTextDate(original);
  if (!trimmed) return "";

  const exact = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exact && exact[2] !== "xx" && exact[3] !== "xx") {
    return `${Number(exact[3])} ${GEDCOM_MONTHS[exact[2]] ?? exact[2]} ${exact[1]}`;
  }

  const yearMonth = trimmed.match(/^(\d{4})-(\d{2})$/);
  if (yearMonth && yearMonth[2] !== "xx") {
    return `${GEDCOM_MONTHS[yearMonth[2]] ?? yearMonth[2]} ${yearMonth[1]}`;
  }

  const yearOnly = trimmed.match(/^\d{4}$/);
  if (yearOnly) return trimmed;

  const yearRange = trimmed.match(/^(\d{4})-(\d{4})$/);
  if (yearRange) return `BET ${yearRange[1]} AND ${yearRange[2]}`;

  return sanitizeGedcomValue(trimmed);
}

function normalizeGedcomTextDate(value: string): string {
  const months: Record<string, string> = {
    СІЧ: "JAN", ЯНВ: "JAN", ЛЮТ: "FEB", ФЕВ: "FEB", БЕР: "MAR", МАР: "MAR",
    КВІ: "APR", АПР: "APR", ТРА: "MAY", МАЙ: "MAY", ЧЕР: "JUN", ИЮН: "JUN",
    ЛИП: "JUL", ИЮЛ: "JUL", СЕР: "AUG", АВГ: "AUG", ВЕР: "SEP", СЕН: "SEP",
    ЖОВ: "OCT", ОКТ: "OCT", ЛИС: "NOV", НОЯ: "NOV", ГРУ: "DEC", ДЕК: "DEC",
  };
  return value
    .toLocaleUpperCase("uk")
    .replace(/\b(СІЧ|ЯНВ|ЛЮТ|ФЕВ|БЕР|МАР|КВІ|АПР|ТРА|МАЙ|ЧЕР|ИЮН|ЛИП|ИЮЛ|СЕР|АВГ|ВЕР|СЕН|ЖОВ|ОКТ|ЛИС|НОЯ|ГРУ|ДЕК)\b/gu, (month) => months[month] ?? month)
    .replace(/\s+(?:І|И)\s+/gu, " AND ")
    .replace(/\s+/g, " ")
    .trim();
}

function graphToProjection(graph: FamilyTreeGraphDto): FamilyTreeProjection {
  const graphNodes = graph.rootPersonId
    ? [...graph.nodes].sort((left, right) => {
      if (left.personId === graph.rootPersonId) return -1;
      if (right.personId === graph.rootPersonId) return 1;
      return 0;
    })
    : graph.nodes;
  const occurrenceByPersonId = new Map<string, FamilyTreeGraphDto["occurrences"][number]>();
  for (const occurrence of graph.occurrences) {
    const current = occurrenceByPersonId.get(occurrence.personId);
    if (!current || occurrence.personId === graph.rootPersonId || Math.abs(occurrence.generation) < Math.abs(current.generation)) {
      occurrenceByPersonId.set(occurrence.personId, occurrence);
    }
  }
  const kinshipEdgesByPair = indexKinshipEdgesByPair(graph);
  const nodes: FamilyTreeProjectionNode[] = graphNodes.map((node) => {
    const primaryName = node.primaryName ?? node.names[0] ?? fallbackName(graph.projectId, node.personId, node.displayName);
    const occurrence = occurrenceByPersonId.get(node.personId);
    const events = mergeProfileEvents(graph.projectId, node.personId, node.events, node.metadata);
    return {
      personId: node.personId,
      researchId: "",
      displayName: node.displayName,
      primaryName,
      names: node.names.length ? node.names : [primaryName],
      events,
      gender: node.gender as Person["gender"],
      status: node.status as Person["status"],
      isLiving: node.isLiving,
      privacyStatus: node.privacyStatus,
      rootRelationshipLabel: occurrence
        ? familyTreeKinshipLabelForExport(
            graph,
            occurrence,
            node,
            kinshipEdgesByPair,
          )
        : undefined,
      hasDates: events.some((event) => event.eventDate || event.dateFrom || event.dateTo || event.dateText),
      hasPlaces: events.some((event) => event.placeName),
      metadata: node.metadata,
    };
  });
  const personIds = new Set(nodes.map((node) => node.personId));
  const edges: FamilyTreeProjectionEdge[] = graph.edges
    .filter((edge) => personIds.has(edge.fromPersonId) && personIds.has(edge.toPersonId))
    .map((edge) => ({
      id: edge.id,
      source: "graph_edge",
      kind: edge.kind,
      fromPersonId: edge.fromPersonId,
      toPersonId: edge.toPersonId,
      relationshipType: edge.relationshipType as FamilyTreeProjectionEdge["relationshipType"],
      parentRoleLabel: edge.parentRoleLabel,
      parentSetId: edge.parentSetId,
      familyGroupId: edge.familyGroupId,
      parentSetType: edge.metadata?.parentSetType as FamilyTreeProjectionEdge["parentSetType"] ?? parentSetTypeFromRelationship(edge.relationshipType),
      evidenceStatus: edge.evidenceStatus,
      confidence: edge.confidence,
      isBloodline: edge.isBloodline,
      lineStyle: edge.style.lineStyle,
      legacyRelationId: edge.relationshipId,
      metadata: edge.metadata,
    }));
  const connectedPersonIds = new Set<string>();
  for (const edge of edges) {
    connectedPersonIds.add(edge.fromPersonId);
    connectedPersonIds.add(edge.toPersonId);
  }
  return {
    projectId: graph.projectId,
    treeId: graph.treeId,
    nodes,
    edges,
    parentChildEdges: edges.filter((edge) => edge.kind === "parent_child"),
    partnerEdges: edges.filter((edge) => edge.kind === "partner"),
    associationEdges: edges.filter((edge) => edge.kind === "association"),
    issues: graph.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      personIds: issue.personIds,
      relationshipIds: issue.relationshipIds,
    })),
    stats: {
      persons: nodes.length,
      connectedPersons: connectedPersonIds.size,
      isolatedPersons: nodes.filter((node) => !connectedPersonIds.has(node.personId)).length,
      parentChildEdges: edges.filter((edge) => edge.kind === "parent_child").length,
      partnerEdges: edges.filter((edge) => edge.kind === "partner").length,
      associationEdges: edges.filter((edge) => edge.kind === "association").length,
      skippedLegacyRelations: 0,
    },
  };
}

function indexKinshipEdgesByPair(
  graph: FamilyTreeGraphDto,
): Map<string, FamilyTreeGraphDto["edges"][number]> {
  const result = new Map<string, FamilyTreeGraphDto["edges"][number]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "parent_child" && edge.kind !== "partner") continue;
    const key = undirectedPersonPairKey(edge.fromPersonId, edge.toPersonId);
    // familyTreeKinshipLabel historically used Array.prototype.find, so the
    // first matching edge in graph order is authoritative.
    if (!result.has(key)) result.set(key, edge);
  }
  return result;
}

function familyTreeKinshipLabelForExport(
  graph: FamilyTreeGraphDto,
  occurrence: FamilyTreeGraphDto["occurrences"][number],
  person: FamilyTreeGraphDto["nodes"][number],
  edgesByPair: Map<string, FamilyTreeGraphDto["edges"][number]>,
): string {
  const pathEdges: FamilyTreeGraphDto["edges"] = [];
  const includedPairs = new Set<string>();
  for (let index = 0; index < occurrence.path.length - 1; index += 1) {
    const key = undirectedPersonPairKey(
      occurrence.path[index],
      occurrence.path[index + 1],
    );
    if (includedPairs.has(key)) continue;
    const edge = edgesByPair.get(key);
    if (!edge) continue;
    includedPairs.add(key);
    pathEdges.push(edge);
  }
  return familyTreeKinshipLabel({ ...graph, edges: pathEdges }, occurrence, person);
}

function undirectedPersonPairKey(first: string, second: string): string {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
}

function fallbackName(projectId: string, personId: string, displayName: string): FamilyTreePersonName {
  return {
    id: `gedcom-name-${personId}`,
    projectId,
    personId,
    nameType: "primary",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: "",
    givenName: "",
    patronymic: "",
    fullName: displayName,
    originalText: displayName,
    isPrimary: true,
    isPreferred: true,
    evidenceStatus: "unknown",
    confidence: 0,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: "",
    updatedAt: "",
  };
}

function addIndividual(
  lines: string[],
  node: FamilyTreeProjectionNode,
  individualXrefs: Record<string, string>,
  familyPointersByPerson: Map<string, { fams: string[]; famc: Array<{ xref: string; pedi: string | null }> }>,
  associationEdges: FamilyTreeProjectionEdge[],
  findings: Finding[],
  options: GedcomExportOptions,
  preservedRecord?: GedcomPreservedRecord,
  documentSourceXrefs: Record<string, string> = {},
  findingSourceXrefs: Record<string, string> = {},
): void {
  const personXref = individualXrefs[node.personId];
  const pointers = familyPointersByPerson.get(node.personId);
  const profile = personProfile(node);

  addLine(lines, 0, "INDI", "", personXref);
  const primaryExportName = primaryGedcomNameForExport(node);
  const preservedNames = directSubtrees(preservedRecord).filter((subtree) => subtree[0]?.tag === "NAME");
  if (preservedNames.length) {
    for (const subtree of preservedNames) addPreservedSubtree(lines, subtree);
  } else {
    addName(lines, primaryExportName);
    if (primaryExportName.nameType !== "primary") {
      addLine(lines, 2, "TYPE", gedcomNameType(primaryExportName.nameType));
    }
    addNameMetadata(lines, primaryExportName);
  }
  const privacyRestriction = gedcomPrivacyRestriction(node);
  if (privacyRestriction) addLine(lines, 1, "RESN", privacyRestriction);
  if (!preservedRecord) {
    addLine(lines, 1, "_TRK_PRIVACY", node.privacyStatus);
    const explicitVitalStatus = customFieldString(profile, GEDCOM_VITAL_STATUS_CUSTOM_FIELD);
    if (explicitVitalStatus === "living" || (!explicitVitalStatus && node.isLiving)) addLine(lines, 1, "_LIVING", "Y");
    if (explicitVitalStatus === "deceased") addLine(lines, 1, "_LIVING", "N");
  }
  if (node.rootRelationshipLabel) {
    addLine(lines, 1, "_RELTOROOT", node.rootRelationshipLabel);
    addLine(lines, 1, "NOTE", `Спорідненість до центральної особи: ${node.rootRelationshipLabel}`);
  }

  if (!preservedNames.length) {
    for (const name of node.names.filter((name) => name.id !== primaryExportName.id && !name.isPrimary)) {
      addName(lines, name);
      addLine(lines, 2, "TYPE", gedcomNameType(name.nameType));
      addNameMetadata(lines, name);
      if (name.originalText && name.originalText !== name.fullName) {
        addMultiline(lines, 2, "NOTE", `Original spelling: ${name.originalText}`);
      }
    }
  }

  const sex = genderToGedcomSex(node.gender);
  if (sex) addLine(lines, 1, "SEX", sex);
  if (sex === "F" && !preservedNames.length) addMarriedName(lines, node, Boolean(pointers?.fams.length));

  const rawEventCounts = directSubtrees(preservedRecord)
    .filter((subtree) => GEDCOM_INDIVIDUAL_EVENT_TAGS.has(subtree[0]?.tag ?? ""))
    .reduce((counts, subtree) => counts.set(subtree[0].tag, (counts.get(subtree[0].tag) ?? 0) + 1), new Map<string, number>());
  const skippedRawEventCounts = new Map<string, number>();
  for (const event of node.events) {
    const tag = eventTypeToGedcomTag(event.eventType);
    const alreadySkipped = skippedRawEventCounts.get(tag) ?? 0;
    if (tag && alreadySkipped < (rawEventCounts.get(tag) ?? 0)) {
      skippedRawEventCounts.set(tag, alreadySkipped + 1);
      continue;
    }
    addEvent(
      lines,
      event.eventType,
      event.eventDate || event.dateText,
      event.placeName,
      [event.title, event.notes].filter(Boolean).join("\n"),
      event.geo,
      event,
    );
  }
  const vitalStatus = customFieldString(profile, GEDCOM_VITAL_STATUS_CUSTOM_FIELD);
  if (
    !node.isLiving
    && vitalStatus !== "unknown"
    && !node.events.some((event) => event.eventType === "death")
    && !hasDirectTag(preservedRecord, "DEAT")
  ) {
    addLine(lines, 1, "DEAT", "Y");
  }

  addMappedPersonProfile(lines, profile, preservedRecord);
  addPreservedIndividualExtensions(lines, preservedRecord, currentPrimaryPersonPhotoPath(profile));
  addFindingCitations(lines, findings, documentSourceXrefs, findingSourceXrefs, preservedRecord);

  const rawFams = new Set(rawDirectValues(preservedRecord, "FAMS"));
  const rawFamc = new Set(rawDirectValues(preservedRecord, "FAMC"));
  for (const subtree of directSubtrees(preservedRecord).filter((subtree) => ["FAMS", "FAMC"].includes(subtree[0]?.tag ?? ""))) {
    addPreservedSubtree(lines, subtree);
  }
  for (const fams of pointers?.fams ?? []) {
    if (!rawFams.has(fams)) addLine(lines, 1, "FAMS", fams);
  }
  for (const famc of pointers?.famc ?? []) {
    if (rawFamc.has(famc.xref)) continue;
    addLine(lines, 1, "FAMC", famc.xref);
    if (famc.pedi) addLine(lines, 2, "PEDI", famc.pedi);
  }

  if (options.includeAssociations ?? true) {
    for (const edge of associationEdges) {
      const targetXref = individualXrefs[edge.toPersonId];
      if (!targetXref) continue;
      addLine(lines, 1, "ASSO", targetXref);
      addLine(lines, 2, "RELA", String(edge.relationshipType));
      if (edge.evidenceStatus !== "unknown") addLine(lines, 2, "NOTE", `Evidence: ${edge.evidenceStatus}`);
    }
  }
}

function gedcomPrivacyRestriction(node: FamilyTreeProjectionNode): "privacy" | "confidential" | "" {
  if (node.privacyStatus === "confidential") return "confidential";
  if (node.isLiving) return "privacy";
  return "";
}

function primaryGedcomNameForExport(node: FamilyTreeProjectionNode): FamilyTreePersonName {
  if (genderToGedcomSex(node.gender) !== "F") return node.primaryName;
  return node.names.find((name) => name.nameType === "birth" && name.surname.trim()) ?? node.primaryName;
}

function addName(lines: string[], name: FamilyTreePersonName): void {
  addLine(lines, 1, "NAME", formatGedcomName(name.givenName, name.patronymic, name.surname, name.fullName));
  if (name.givenName) addLine(lines, 2, "GIVN", sanitizeGedcomValue(name.givenName));
  if (name.surname) addLine(lines, 2, "SURN", sanitizeGedcomValue(name.surname));
  if (name.patronymic) addLine(lines, 2, "_PATR", sanitizeGedcomValue(name.patronymic));
}

function addNameMetadata(lines: string[], name: FamilyTreePersonName): void {
  if (name.languageCode) addLine(lines, 2, "_LANG", name.languageCode);
  if (name.scriptCode) addLine(lines, 2, "_SCRIPT", name.scriptCode);
  if (name.isPreferred) addLine(lines, 2, "_PREFERRED", "Y");
  if (name.evidenceStatus !== "unknown") addLine(lines, 2, "_EVIDENCE", name.evidenceStatus);
  if (Number.isFinite(name.confidence) && name.confidence > 0) addLine(lines, 2, "_CONFIDENCE", String(name.confidence));
  if (name.sourceDocumentId) addLine(lines, 2, "_TRK_SOURCE_DOCUMENT", name.sourceDocumentId);
  if (name.sourceFindingId) addLine(lines, 2, "_TRK_SOURCE_FINDING", name.sourceFindingId);
  if (name.notes) addMultiline(lines, 2, "NOTE", name.notes);
}

function addMarriedName(lines: string[], node: FamilyTreeProjectionNode, hasSpouseFamily: boolean): void {
  const marriedName = node.names.find((name) => name.nameType === "married") ?? node.primaryName;
  const marriedSurname = marriedName.surname.trim();
  if (!marriedSurname) return;
  const hasMaidenName = node.names.some((name) => name.nameType === "birth" && name.surname.trim());
  if (!hasSpouseFamily && !hasMaidenName && marriedName.nameType !== "married") return;
  addLine(lines, 1, "_MARNM", formatGedcomName(
    marriedName.givenName,
    marriedName.patronymic,
    marriedName.surname,
    marriedName.fullName,
  ));
  if (marriedName.givenName) addLine(lines, 2, "GIVN", sanitizeGedcomValue(marriedName.givenName));
  if (marriedName.surname) addLine(lines, 2, "SURN", sanitizeGedcomValue(marriedName.surname));
  if (marriedName.patronymic) addLine(lines, 2, "_PATR", sanitizeGedcomValue(marriedName.patronymic));
}

function addEvent(
  lines: string[],
  eventType: string,
  dateText: string,
  placeName: string,
  note: string,
  geo?: FamilyTreePersonTimelineEvent["geo"],
  eventMetadata?: FamilyTreePersonTimelineEvent,
): void {
  const tag = eventTypeToGedcomTag(eventType);
  if (!tag) return;
  const originalValue = stringValue(eventMetadata?.metadata?.gedcomValue);
  addLine(lines, 1, tag, originalValue);
  if (dateText) addLine(lines, 2, "DATE", formatGedcomDate(dateText));
  if (placeName) addLine(lines, 2, "PLAC", sanitizeGedcomValue(placeName));
  if (placeName && geo?.latitude != null && geo.longitude != null) {
    addLine(lines, 3, "MAP");
    addLine(lines, 4, "LATI", formatGedcomCoordinate(geo.latitude, "N", "S"));
    addLine(lines, 4, "LONG", formatGedcomCoordinate(geo.longitude, "E", "W"));
  }
  if (tag === "EVEN") {
    const eventTitle = eventMetadata?.title?.trim();
    if (eventTitle || eventType !== "other") {
      addLine(lines, 2, "TYPE", sanitizeGedcomValue(eventTitle || eventType));
    }
  }
  const eventAge = stringValue(eventMetadata?.metadata?.age);
  const eventCause = stringValue(eventMetadata?.metadata?.cause);
  const eventAddress = stringValue(eventMetadata?.metadata?.address);
  if (eventAge) addLine(lines, 2, "AGE", sanitizeGedcomValue(eventAge));
  if (eventCause) addLine(lines, 2, "CAUS", sanitizeGedcomValue(eventCause));
  if (eventAddress && eventAddress !== placeName) addLine(lines, 2, "ADDR", sanitizeGedcomValue(eventAddress));
  if (note) addMultiline(lines, 2, "NOTE", note);
  if (eventMetadata?.eventRole) addLine(lines, 2, "_ROLE", eventMetadata.eventRole);
  if (eventMetadata && eventMetadata.evidenceStatus !== "unknown") addLine(lines, 2, "_EVIDENCE", eventMetadata.evidenceStatus);
  if (eventMetadata && Number.isFinite(eventMetadata.confidence) && eventMetadata.confidence > 0) {
    addLine(lines, 2, "_CONFIDENCE", String(eventMetadata.confidence));
  }
  if (eventMetadata?.sourceDocumentId) addLine(lines, 2, "_TRK_SOURCE_DOCUMENT", eventMetadata.sourceDocumentId);
  if (eventMetadata?.sourceFindingId) addLine(lines, 2, "_TRK_SOURCE_FINDING", eventMetadata.sourceFindingId);
}

function addFamily(
  lines: string[],
  family: GedcomFamily,
  familyXref: string,
  individualXrefs: Record<string, string>,
  warnings: FamilyTreeGraphIssue[],
  preservedRecord?: GedcomPreservedRecord,
): void {
  addLine(lines, 0, "FAM", "", familyXref);
  const partners = family.partnerIds.filter((personId) => individualXrefs[personId]);
  if (partners.length > 2) {
    warnings.push({
      severity: "needs_review",
      code: "gedcom_family_more_than_two_partners",
      message: "GEDCOM family has more than two partner candidates; only first two are exported as HUSB/WIFE.",
      personIds: partners,
    });
  }

  const rawHusb = new Set(rawDirectValues(preservedRecord, "HUSB"));
  const rawWife = new Set(rawDirectValues(preservedRecord, "WIFE"));
  const rawPartner = new Set(rawDirectValues(preservedRecord, "PARTNER"));
  for (const subtree of directSubtrees(preservedRecord).filter((subtree) => ["HUSB", "WIFE", "PARTNER"].includes(subtree[0]?.tag ?? ""))) {
    addPreservedSubtree(lines, subtree);
  }
  if (partners[0] && !rawHusb.has(individualXrefs[partners[0]]) && !rawPartner.has(individualXrefs[partners[0]])) {
    addLine(lines, 1, "HUSB", individualXrefs[partners[0]]);
  }
  if (partners[1] && !rawWife.has(individualXrefs[partners[1]]) && !rawPartner.has(individualXrefs[partners[1]])) {
    addLine(lines, 1, "WIFE", individualXrefs[partners[1]]);
  }
  if ((family.marriageDate || family.marriagePlace) && !hasDirectTag(preservedRecord, "MARR")) {
    addLine(lines, 1, "MARR");
    if (family.marriageDate) addLine(lines, 2, "DATE", formatGedcomDate(family.marriageDate));
    if (family.marriagePlace) addLine(lines, 2, "PLAC", sanitizeGedcomValue(family.marriagePlace));
  }
  if ((family.endDate || family.endPlace || family.relationshipType === "divorced") && !hasDirectTag(preservedRecord, "DIV")) {
    addLine(lines, 1, "DIV", family.relationshipType === "divorced" && !family.endDate && !family.endPlace ? "Y" : "");
    if (family.endDate) addLine(lines, 2, "DATE", formatGedcomDate(family.endDate));
    if (family.endPlace) addLine(lines, 2, "PLAC", family.endPlace);
  }
  if (family.notes && !hasDirectTag(preservedRecord, "NOTE")) addMultiline(lines, 1, "NOTE", family.notes);
  if (!preservedRecord) {
    if (family.relationshipType && family.relationshipType !== "unknown") addLine(lines, 1, "_TRK_RELATIONSHIP_TYPE", family.relationshipType);
    if (family.evidenceStatus && family.evidenceStatus !== "unknown") addLine(lines, 1, "_EVIDENCE", family.evidenceStatus);
    if (Number.isFinite(family.confidence) && family.confidence > 0) addLine(lines, 1, "_CONFIDENCE", String(family.confidence));
    if (family.familyGroupId) addLine(lines, 1, "_TRK_FAMILY_GROUP", family.familyGroupId);
  }
  const rawChildren = new Set(rawDirectValues(preservedRecord, "CHIL"));
  for (const subtree of directSubtrees(preservedRecord).filter((subtree) => subtree[0]?.tag === "CHIL")) {
    addPreservedSubtree(lines, subtree);
  }
  for (const childId of family.childIds) {
    const childXref = individualXrefs[childId];
    if (childXref && !rawChildren.has(childXref)) addLine(lines, 1, "CHIL", childXref);
  }
  addPreservedFamilyExtensions(lines, preservedRecord);
}

function indexPreservedRecords(records: GedcomPreservedRecord[]): PreservedRecordIndex {
  const result: PreservedRecordIndex = {
    individualByInternalId: new Map(),
    individualByPointer: new Map(),
    familyByPointer: new Map(),
  };
  records.forEach((record, index) => {
    if (record.tag === "HEAD" && !result.head) result.head = record;
    if (record.tag === "INDI") {
      const indexed = { record, index };
      if (record.internalId && !result.individualByInternalId.has(record.internalId)) {
        result.individualByInternalId.set(record.internalId, indexed);
      }
      if (record.pointer && !result.individualByPointer.has(record.pointer)) {
        result.individualByPointer.set(record.pointer, indexed);
      }
    }
    if (record.tag === "FAM" && record.pointer && !result.familyByPointer.has(record.pointer)) {
      result.familyByPointer.set(record.pointer, record);
    }
  });
  return result;
}

function indexAssociationsByPerson(
  edges: FamilyTreeProjectionEdge[],
): Map<string, FamilyTreeProjectionEdge[]> {
  const result = new Map<string, FamilyTreeProjectionEdge[]>();
  for (const edge of edges) {
    const existing = result.get(edge.fromPersonId);
    if (existing) existing.push(edge);
    else result.set(edge.fromPersonId, [edge]);
  }
  return result;
}

function indexFindingsByPerson(findings: Finding[]): Map<string, Finding[]> {
  const result = new Map<string, Finding[]>();
  for (const finding of findings) {
    // A malformed source row may repeat one person id. The previous `.filter`
    // emitted that finding once, so keep the same output contract here.
    for (const personId of new Set(finding.personIds ?? [])) {
      const existing = result.get(personId);
      if (existing) existing.push(finding);
      else result.set(personId, [finding]);
    }
  }
  return result;
}

function buildIndividualXrefs(
  nodes: FamilyTreeProjectionNode[],
  preservedRecords: GedcomPreservedRecord[],
  individualByInternalId: Map<string, IndexedPreservedRecord>,
): Record<string, string> {
  const reserved = new Set(preservedRecords.map((record) => record.pointer).filter((value): value is string => Boolean(value)));
  const assigned = new Set<string>();
  const result: Record<string, string> = {};
  let next = 1;
  for (const node of nodes) {
    const profile = personProfile(node);
    const candidate = [
      individualByInternalId.get(node.personId)?.record.pointer,
      customFieldString(profile, GEDCOM_XREF_CUSTOM_FIELD),
      parseGedcomMetadata<GedcomPreservedRecord | null>(
        customFieldString(profile, GEDCOM_RAW_RECORD_CUSTOM_FIELD),
        null,
      )?.pointer,
    ].find((value) => validGedcomXref(value) && !assigned.has(value!));
    if (candidate) {
      result[node.personId] = candidate;
      assigned.add(candidate);
      continue;
    }
    let generated = `@I${next++}@`;
    while (reserved.has(generated) || assigned.has(generated)) generated = `@I${next++}@`;
    result[node.personId] = generated;
    assigned.add(generated);
  }
  return result;
}

function buildFamilyXrefs(
  families: GedcomFamily[],
  preservedRecords: GedcomPreservedRecord[],
  individualXrefs: Record<string, string>,
): Record<string, string> {
  const rawFamiliesByPartners = new Map<string, RawFamilyDescriptor[]>();
  for (const record of preservedRecords) {
    if (record.tag !== "FAM" || !validGedcomXref(record.pointer)) continue;
    const partners = rawFamilyValues(record, ["HUSB", "WIFE", "PARTNER"]).sort();
    const descriptor = {
      record,
      children: rawFamilyValues(record, ["CHIL"]).sort(),
    };
    const signature = stringArraySignature(partners);
    const existing = rawFamiliesByPartners.get(signature);
    if (existing) existing.push(descriptor);
    else rawFamiliesByPartners.set(signature, [descriptor]);
  }
  const reserved = new Set(preservedRecords.map((record) => record.pointer).filter((value): value is string => Boolean(value)));
  const used = new Set<string>();
  const result: Record<string, string> = {};
  let next = 1;
  for (const family of families) {
    const partnerXrefs = family.partnerIds.map((id) => individualXrefs[id]).filter(Boolean).sort();
    const childXrefs = family.childIds.map((id) => individualXrefs[id]).filter(Boolean).sort();
    let matched: RawFamilyDescriptor | undefined;
    let matchedScore = Number.NEGATIVE_INFINITY;
    for (const candidate of rawFamiliesByPartners.get(stringArraySignature(partnerXrefs)) ?? []) {
      if (!candidate.record.pointer || used.has(candidate.record.pointer)) continue;
      const score = familyMatchScore(candidate.children, childXrefs);
      // Array.prototype.sort is stable. Replacing it with a single pass must
      // therefore keep the first archive record when scores are equal.
      if (!matched || score > matchedScore) {
        matched = candidate;
        matchedScore = score;
      }
    }
    if (matched?.record.pointer) {
      result[family.key] = matched.record.pointer;
      used.add(matched.record.pointer);
      continue;
    }
    let generated = `@F${next++}@`;
    while (reserved.has(generated) || used.has(generated)) generated = `@F${next++}@`;
    result[family.key] = generated;
    used.add(generated);
  }
  return result;
}

function stringArraySignature(values: string[]): string {
  return JSON.stringify(values);
}

function buildDocumentSourceXrefs(
  documents: DocumentRecord[],
  preservedRecords: GedcomPreservedRecord[],
): Record<string, string> {
  const reserved = new Set(preservedRecords.map((record) => record.pointer).filter((value): value is string => Boolean(value)));
  const assigned = new Set<string>();
  const result: Record<string, string> = {};
  let next = 1;
  for (const document of documents) {
    const importedXref = typeof document.customFields?.__gedcomSourceXref === "string"
      ? document.customFields.__gedcomSourceXref
      : "";
    if (validGedcomXref(importedXref) && !assigned.has(importedXref)) {
      result[document.id] = importedXref;
      assigned.add(importedXref);
      continue;
    }
    let generated = `@S_TRK${next++}@`;
    while (reserved.has(generated) || assigned.has(generated)) generated = `@S_TRK${next++}@`;
    result[document.id] = generated;
    assigned.add(generated);
  }
  return result;
}

function buildFindingSourceXrefs(
  findings: Finding[],
  preservedRecords: GedcomPreservedRecord[],
  documentSourceXrefs: Record<string, string>,
): Record<string, string> {
  const reserved = new Set(preservedRecords
    .map((record) => record.pointer)
    .filter((value): value is string => Boolean(value)));
  const assigned = new Set(Object.values(documentSourceXrefs));
  const logicalSourceXrefs = new Map<string, string>();
  const result: Record<string, string> = {};
  let next = 1;

  for (const finding of findings) {
    const documentXref = documentSourceXrefs[finding.documentId];
    if (documentXref) {
      result[finding.id] = documentXref;
      continue;
    }
    const custom = finding.customFields ?? {};
    const sourceMetadata = typeof custom.__gedcomSource === "string"
      ? custom.__gedcomSource
      : "";
    const hasGedcomSourceRecord = Boolean(
      custom.__gedcomCitation
      || custom.__gedcomStandaloneSource
      || sourceMetadata,
    );
    const isGedcomEventFinding = Boolean(
      custom.__gedcomEventDescription
      || custom.__gedcomEventTag
      || custom.__gedcomEventType,
    );
    if (isGedcomEventFinding && !hasGedcomSourceRecord) continue;
    // Event findings historically store their INDI/FAM owner pointer in the
    // same metadata key. Never reuse that pointer for a top-level SOUR record.
    const importedXref = hasGedcomSourceRecord && typeof custom.__gedcomSourceXref === "string"
      ? custom.__gedcomSourceXref.trim()
      : "";
    const importSourceKey = typeof custom.__gedcomImportSourceKey === "string"
      ? custom.__gedcomImportSourceKey.trim()
      : "";
    const sourceUrl = resolvedFindingSourceUrl(finding);
    if (!importedXref && !sourceUrl && !sourceMetadata) continue;

    // Citation URLs may differ for two records that point at the same GEDCOM
    // source. Reuse the source record by import namespace/xref and keep the
    // record-specific address on the citation itself.
    const logicalKey = importedXref || sourceMetadata
      ? [importSourceKey, importedXref, sourceMetadata].join("|")
      : `manual-url|${sourceUrl}`;
    const reused = logicalSourceXrefs.get(logicalKey);
    if (reused) {
      result[finding.id] = reused;
      continue;
    }

    let xref = "";
    if (validGedcomXref(importedXref) && !assigned.has(importedXref)) {
      xref = importedXref;
    } else {
      xref = `@S_TRK_FINDING${next++}@`;
      while (reserved.has(xref) || assigned.has(xref)) {
        xref = `@S_TRK_FINDING${next++}@`;
      }
    }
    logicalSourceXrefs.set(logicalKey, xref);
    assigned.add(xref);
    result[finding.id] = xref;
  }
  return result;
}

function addDocumentSourceRecords(
  lines: string[],
  documents: DocumentRecord[],
  sourceXrefs: Record<string, string>,
  preservedRecords: GedcomPreservedRecord[],
): void {
  const preservedSourcePointers = new Set(preservedRecords
    .filter((record) => record.tag === "SOUR")
    .map((record) => record.pointer)
    .filter((value): value is string => Boolean(value)));
  for (const document of documents) {
    const xref = sourceXrefs[document.id];
    if (!xref || preservedSourcePointers.has(xref)) continue;
    addLine(lines, 0, "SOUR", "", xref);
    addLine(lines, 1, "TITL", document.title || `Документ ${document.id}`);
    if (document.archive) addLine(lines, 1, "AUTH", document.archive);
    if (document.notes) addMultiline(lines, 1, "PUBL", document.notes);
    if (document.description) addMultiline(lines, 1, "TEXT", document.description);
    if (document.documentType) addLine(lines, 1, "_TYPE", document.documentType);
    if (document.url || document.file) addLine(lines, 1, "_URL", document.url || document.file);
    if (document.fund) addLine(lines, 1, "_ARCHIVE_REF", document.fund);
    addLine(lines, 1, "_TRK_ID", document.id);
    for (const scan of document.scans ?? []) {
      addLine(lines, 1, "OBJE");
      addLine(lines, 2, "FILE", scan.storagePath || scan.webViewLink || scan.name);
      if (scan.mimeType) addLine(lines, 2, "FORM", scan.mimeType.split("/").at(-1) ?? scan.mimeType);
      if (scan.name) addLine(lines, 2, "TITL", scan.name);
    }
  }
}

function addFindingSourceRecords(
  lines: string[],
  findings: Finding[],
  findingSourceXrefs: Record<string, string>,
  documentSourceXrefs: Record<string, string>,
  preservedRecords: GedcomPreservedRecord[],
): void {
  const alreadyWritten = new Set([
    ...preservedRecords
      .filter((record) => record.tag === "SOUR")
      .map((record) => record.pointer)
      .filter((value): value is string => Boolean(value)),
    ...Object.values(documentSourceXrefs),
  ]);
  for (const finding of findings) {
    const xref = findingSourceXrefs[finding.id];
    if (!xref || alreadyWritten.has(xref)) continue;
    alreadyWritten.add(xref);
    const custom = finding.customFields ?? {};
    const source = parseGedcomMetadata<Record<string, unknown> | null>(
      typeof custom.__gedcomSource === "string" ? custom.__gedcomSource : "",
      null,
    );
    const title = stringValue(source?.title)
      || finding.summary
      || finding.findingType
      || `Знахідка ${finding.id}`;
    const author = stringValue(source?.author) || finding.archive;
    const publication = stringValue(source?.publication);
    const text = stringValue(source?.text);
    const sourceType = stringValue(source?.sourceType) || stringValue(source?.mediaType);
    const sourceUrl = stringValue(source?.url)
      || (!source ? resolvedFindingSourceUrl(finding) : "");
    const rin = stringValue(source?.rin);

    addLine(lines, 0, "SOUR", "", xref);
    addLine(lines, 1, "TITL", title);
    if (author) addLine(lines, 1, "AUTH", author);
    if (publication) addMultiline(lines, 1, "PUBL", publication);
    if (text) addMultiline(lines, 1, "TEXT", text);
    if (sourceType) addLine(lines, 1, "_TYPE", sourceType);
    if (sourceUrl) addLine(lines, 1, "_URL", sourceUrl);
    if (rin) addLine(lines, 1, "RIN", rin);
    addLine(lines, 1, "_TRK_FINDING_ID", finding.id);
  }
}

function addFindingCitations(
  lines: string[],
  findings: Finding[],
  documentSourceXrefs: Record<string, string>,
  findingSourceXrefs: Record<string, string>,
  preservedRecord?: GedcomPreservedRecord,
): void {
  const rawCitationKeys = new Set(directSubtrees(preservedRecord)
    .filter((subtree) => subtree[0]?.tag === "SOUR")
    .map((subtree) => `${subtree[0]?.value ?? ""}|${subtree.find((line) => line.level === 2 && line.tag === "PAGE")?.value ?? ""}`));
  for (const finding of findings) {
    const sourceXref = documentSourceXrefs[finding.documentId] || findingSourceXrefs[finding.id];
    const custom = finding.customFields ?? {};
    const importedCitation = parseGedcomMetadata<{ quality?: string; url?: string } | null>(
      typeof custom.__gedcomCitation === "string" ? custom.__gedcomCitation : "",
      null,
    );
    if (preservedRecord && (custom.__gedcomCitation || custom.__gedcomEventDescription)) continue;
    if (sourceXref) {
      const page = finding.page;
      const citationUrl = resolvedFindingSourceUrl(finding)
        || stringValue(importedCitation?.url);
      if (rawCitationKeys.has(`${sourceXref}|${page}`)) continue;
      addLine(lines, 1, "SOUR", sourceXref);
      if (page) addLine(lines, 2, "PAGE", page);
      if (citationUrl) addLine(lines, 2, "_URL", citationUrl);
      const eventType = finding.findingType || finding.summary;
      if (eventType) addLine(lines, 2, "EVEN", eventType);
      if (finding.eventDate || finding.transcription || finding.description) {
        addLine(lines, 2, "DATA");
        if (finding.eventDate) addLine(lines, 3, "DATE", formatGedcomDate(finding.eventDate));
        if (finding.transcription || finding.description) addMultiline(lines, 3, "TEXT", finding.transcription || finding.description);
      }
      const quality = importedCitation?.quality || findingReliabilityToQuay(finding.reliability);
      if (quality) addLine(lines, 2, "QUAY", quality);
      if (finding.notes) addMultiline(lines, 2, "NOTE", finding.notes);
      continue;
    }
    const description = finding.transcription || finding.description || finding.summary;
    if (!description) continue;
    addLine(lines, 1, "EVEN");
    addLine(lines, 2, "TYPE", finding.findingType || "Research finding");
    if (finding.eventDate) addLine(lines, 2, "DATE", formatGedcomDate(finding.eventDate));
    if (finding.place) addLine(lines, 2, "PLAC", finding.place);
    addMultiline(lines, 2, "NOTE", description);
    const sourceUrl = resolvedFindingSourceUrl(finding);
    if (sourceUrl && !description.includes(sourceUrl)) addLine(lines, 2, "NOTE", sourceUrl);
    addLine(lines, 2, "_TRK_FINDING_ID", finding.id);
  }
}

function findingReliabilityToQuay(value: string): string {
  const normalized = value.toLocaleLowerCase("uk");
  if (normalized.includes("первин") || normalized.includes("надійн")) return "3";
  if (normalized.includes("вторин") || normalized.includes("імовір")) return "2";
  if (normalized.includes("сумнів")) return "1";
  if (normalized.includes("ненадійн")) return "0";
  return "";
}

function preservedPersonRecord(
  personId: string,
  individualXrefs: Record<string, string>,
  records: PreservedRecordIndex,
): GedcomPreservedRecord | undefined {
  const byInternalId = records.individualByInternalId.get(personId);
  const byPointer = records.individualByPointer.get(individualXrefs[personId]);
  if (!byInternalId) return byPointer?.record;
  if (!byPointer) return byInternalId.record;
  // Preserve Array.prototype.find semantics when two different archive rows
  // happen to match the internal id and the chosen pointer.
  return byInternalId.index <= byPointer.index
    ? byInternalId.record
    : byPointer.record;
}

function rawFamilyValues(record: GedcomPreservedRecord, tags: string[]): string[] {
  const accepted = new Set(tags);
  return directSubtrees(record)
    .filter((subtree) => accepted.has(subtree[0]?.tag ?? ""))
    .map((subtree) => subtree[0]?.value ?? "")
    .filter(Boolean);
}

function rawDirectValues(record: GedcomPreservedRecord | undefined, tag: string): string[] {
  return directSubtrees(record)
    .filter((subtree) => subtree[0]?.tag === tag)
    .map((subtree) => subtree[0]?.value ?? "")
    .filter(Boolean);
}

function familyMatchScore(left: string[], right: string[]): number {
  const matches = left.filter((value) => right.includes(value)).length;
  return matches * 10 - Math.abs(left.length - right.length) + (arrayEquals(left, right) ? 1000 : 0);
}

function arrayEquals(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validGedcomXref(value: unknown): boolean {
  return typeof value === "string" && /^@[^@\s]+@$/.test(value);
}

const GEDCOM_INDIVIDUAL_EVENT_TAGS = new Set([
  "BIRT", "BAPM", "CHR", "DEAT", "BURI", "CREM", "RESI", "CENS", "OCCU", "EDUC", "IMMI", "EMIG", "PROB", "EVEN",
]);

function collectPreservedRecords(
  nodes: FamilyTreeProjectionNode[],
  archived: GedcomPreservedRecord[],
): GedcomPreservedRecord[] {
  const records = archived.map((record) => ({ ...record, lines: record.lines.map((line) => ({ ...line })) }));
  const existingPersonIds = new Set(records
    .filter((record) => record.tag === "INDI" && record.internalId)
    .map((record) => record.internalId));
  const existingPointers = new Set(records.map((record) => record.pointer).filter(Boolean));
  for (const node of nodes) {
    if (existingPersonIds.has(node.personId)) continue;
    const raw = parseGedcomMetadata<GedcomPreservedRecord | null>(
      customFieldString(personProfile(node), GEDCOM_RAW_RECORD_CUSTOM_FIELD),
      null,
    );
    if (!raw?.lines?.length || raw.tag !== "INDI") continue;
    if (raw.pointer && existingPointers.has(raw.pointer)) continue;
    records.push({ ...raw, internalId: node.personId, internalTable: "persons" });
    if (raw.pointer) existingPointers.add(raw.pointer);
  }
  return records.sort((left, right) => left.order - right.order);
}

function directSubtrees(record?: GedcomPreservedRecord): GedcomPreservedLine[][] {
  if (!record?.lines?.length) return [];
  const result: GedcomPreservedLine[][] = [];
  let current: GedcomPreservedLine[] = [];
  for (const line of record.lines.slice(1)) {
    if (line.level === 1) {
      if (current.length) result.push(current);
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) result.push(current);
  return result;
}

function hasDirectTag(record: GedcomPreservedRecord | undefined, tag: string): boolean {
  return directSubtrees(record).some((subtree) => subtree[0]?.tag === tag);
}

function addPreservedIndividualExtensions(
  lines: string[],
  record?: GedcomPreservedRecord,
  currentPrimaryPhotoPath = "",
): void {
  const regenerated = new Set([
    "NAME", "_MARNM", "SEX", "RESN", "LIVING", "_LIVING", "LIVN", "FAMS", "FAMC", "ASSO", "_RELTOROOT",
  ]);
  for (const subtree of directSubtrees(record)) {
    if (regenerated.has(subtree[0]?.tag ?? "")) continue;
    if (subtree[0]?.tag === "OBJE" && currentPrimaryPhotoPath) {
      addReconciledPreservedMediaSubtree(lines, subtree, currentPrimaryPhotoPath);
    } else {
      addPreservedSubtree(lines, subtree);
    }
  }
}

function addReconciledPreservedMediaSubtree(
  lines: string[],
  subtree: GedcomPreservedLine[],
  currentPrimaryPhotoPath: string,
): void {
  const baseLevel = subtree[0]?.level ?? 1;
  let skippedMarkerLevel: number | null = null;
  for (const line of subtree) {
    if (skippedMarkerLevel !== null) {
      if (line.level > skippedMarkerLevel) continue;
      skippedMarkerLevel = null;
    }
    if (line.level === baseLevel + 1 && line.tag === "_PRIM_CUTOUT") {
      skippedMarkerLevel = line.level;
      continue;
    }
    addPreservedLine(lines, line);
  }
  if (preservedMediaSubtreePath(subtree) === currentPrimaryPhotoPath) {
    addLine(lines, baseLevel + 1, "_PRIM_CUTOUT", "Y");
  }
}

function addPreservedFamilyExtensions(lines: string[], record?: GedcomPreservedRecord): void {
  const regenerated = new Set(["HUSB", "WIFE", "PARTNER", "CHIL"]);
  for (const subtree of directSubtrees(record)) {
    if (regenerated.has(subtree[0]?.tag ?? "")) continue;
    addPreservedSubtree(lines, subtree);
  }
}

function addPreservedHeaderExtensions(lines: string[], record?: GedcomPreservedRecord): void {
  const regenerated = new Set(["SOUR", "DEST", "DATE", "CHAR", "GEDC", "SUBM", "_ROOT", "_TRK_ROOT"]);
  for (const subtree of directSubtrees(record)) {
    if (regenerated.has(subtree[0]?.tag ?? "")) continue;
    addPreservedSubtree(lines, subtree);
  }
}

function addPreservedOriginalHeaderSource(lines: string[], record?: GedcomPreservedRecord): void {
  const source = directSubtrees(record).find((subtree) => subtree[0]?.tag === "SOUR");
  if (!source?.length) return;
  addLine(lines, 1, "_TRK_ORIGINAL_SOUR", source[0].value);
  for (const line of source.slice(1)) addPreservedLine(lines, line);
}

function addPreservedTopLevelRecords(
  lines: string[],
  records: GedcomPreservedRecord[],
  usedPointers: Set<string>,
): void {
  const regenerated = new Set(["HEAD", "SUBM", "TRLR"]);
  for (const record of records) {
    if (regenerated.has(record.tag)) continue;
    if (record.pointer && usedPointers.has(record.pointer)) continue;
    for (const line of record.lines) addPreservedLine(lines, line);
  }
}

function addPreservedSubtree(lines: string[], subtree: GedcomPreservedLine[]): void {
  for (const line of subtree) addPreservedLine(lines, line);
}

function addPreservedLine(lines: string[], line: GedcomPreservedLine): void {
  addLine(lines, line.level, line.tag, line.value, line.pointer ?? "");
}

function personProfile(node: FamilyTreeProjectionNode): Record<string, unknown> {
  return asRecord(asRecord(node.metadata).personProfile);
}

function customFields(profile: Record<string, unknown>): Record<string, unknown> {
  return asRecord(profile.customFields);
}

function customFieldString(profile: Record<string, unknown>, key: string): string {
  const value = customFields(profile)[key];
  return typeof value === "string" ? value : "";
}

function addMappedPersonProfile(
  lines: string[],
  profile: Record<string, unknown>,
  preservedRecord?: GedcomPreservedRecord,
): void {
  if (!Object.keys(profile).length) return;
  const note = profileNoteForExport(stringValue(profile.notes));
  if (note && !hasDirectTag(preservedRecord, "NOTE")) addMultiline(lines, 1, "NOTE", note);
  if (stringValue(profile.religion) && !hasDirectTag(preservedRecord, "RELI")) addLine(lines, 1, "RELI", stringValue(profile.religion));
  if (stringValue(profile.occupation) && !hasDirectTag(preservedRecord, "OCCU")) addLine(lines, 1, "OCCU", stringValue(profile.occupation));
  if (stringValue(profile.socialStatus) && !hasDirectTag(preservedRecord, "CAST")) addLine(lines, 1, "CAST", stringValue(profile.socialStatus));

  const nationality = customFieldString(profile, GEDCOM_NATIONALITY_CUSTOM_FIELD);
  if (nationality && !hasDirectTag(preservedRecord, "NATI")) addLine(lines, 1, "NATI", nationality);
  const education = parseGedcomMetadata<string[]>(customFieldString(profile, GEDCOM_EDUCATION_CUSTOM_FIELD), []);
  if (!hasDirectTag(preservedRecord, "EDUC")) {
    for (const item of education) if (item) addLine(lines, 1, "EDUC", item);
  }
  const rin = customFieldString(profile, GEDCOM_RIN_CUSTOM_FIELD);
  const uid = customFieldString(profile, GEDCOM_UID_CUSTOM_FIELD);
  if (rin && !hasDirectTag(preservedRecord, "RIN")) addLine(lines, 1, "RIN", rin);
  if (uid && !hasDirectTag(preservedRecord, "_UID")) addLine(lines, 1, "_UID", uid);

  addProfileMedia(lines, profile, preservedRecord);
  addTrackerCustomFields(lines, profile);
}

function addProfileMedia(
  lines: string[],
  profile: Record<string, unknown>,
  preservedRecord?: GedcomPreservedRecord,
): void {
  const scans = asRecord(customFields(profile).__trackerRoduPersonScans);
  const collections = [
    ...Object.values(scans),
    profile.birthScans,
    profile.marriageScans,
    profile.deathScans,
    profile.mentionScans,
    profile.photos,
  ];
  const primaryPhotoId = stringValue(profile.primaryPhotoId);
  const seenIds = new Set<string>();
  const seenPaths = preservedPersonMediaPaths(preservedRecord);
  for (const value of collections) {
    if (!Array.isArray(value)) continue;
    for (const raw of value) {
      const scan = asRecord(raw);
      const path = scanExportPath(scan);
      const identity = stringValue(scan.id);
      if (!path || seenPaths.has(path) || (identity && seenIds.has(identity))) continue;
      seenPaths.add(path);
      if (identity) seenIds.add(identity);
      addLine(lines, 1, "OBJE");
      addLine(lines, 2, "FILE", path);
      const mimeType = stringValue(scan.mimeType);
      if (mimeType) addLine(lines, 2, "FORM", mimeType.split("/").at(-1) ?? mimeType);
      if (stringValue(scan.name)) addLine(lines, 2, "TITL", stringValue(scan.name));
      if (Number.isFinite(Number(scan.size)) && Number(scan.size) > 0) addLine(lines, 2, "_FILESIZE", String(scan.size));
      if (primaryPhotoId && stringValue(scan.id) === primaryPhotoId) addLine(lines, 2, "_PRIM_CUTOUT", "Y");
    }
  }
}

function currentPrimaryPersonPhotoPath(profile: Record<string, unknown>): string {
  const photos = Array.isArray(profile.photos) ? profile.photos : [];
  const primaryPhotoId = stringValue(profile.primaryPhotoId);
  const primary = photos
    .map(asRecord)
    .find((scan) => stringValue(scan.id) === primaryPhotoId);
  return primary ? scanExportPath(primary) : "";
}

function scanExportPath(scan: Record<string, unknown>): string {
  return stringValue(scan.storage) === "google-drive"
    ? stringValue(scan.webViewLink) || stringValue(scan.storagePath)
    : stringValue(scan.sourceReference)
      || stringValue(scan.webViewLink)
      || stringValue(scan.storagePath);
}

function preservedPersonMediaPaths(record?: GedcomPreservedRecord): Set<string> {
  const paths = new Set<string>();
  for (const subtree of directSubtrees(record)) {
    if (subtree[0]?.tag !== "OBJE") continue;
    const baseLevel = subtree[0].level;
    for (let index = 1; index < subtree.length; index += 1) {
      const line = subtree[index];
      if (line.level !== baseLevel + 1 || line.tag !== "FILE") continue;
      const path = preservedMediaSubtreePath(subtree, index);
      if (path) paths.add(path);
    }
  }
  return paths;
}

function preservedMediaSubtreePath(subtree: GedcomPreservedLine[], fileIndex?: number): string {
  const baseLevel = subtree[0]?.level ?? 1;
  const index = fileIndex ?? subtree.findIndex((line) => line.level === baseLevel + 1 && line.tag === "FILE");
  if (index < 0) return "";
  const fileLine = subtree[index];
  let path = fileLine.value;
  for (let continuation = index + 1; continuation < subtree.length; continuation += 1) {
    const next = subtree[continuation];
    if (next.level !== fileLine.level + 1 || next.tag !== "CONC") break;
    path += next.value;
  }
  return path;
}

function addTrackerCustomFields(lines: string[], profile: Record<string, unknown>): void {
  const ignored = new Set([
    "__trackerRoduPersonScans", "__trackerRoduPersonEvents", "__trackerRoduMaidenSurname",
    GEDCOM_XREF_CUSTOM_FIELD, GEDCOM_RAW_RECORD_CUSTOM_FIELD, GEDCOM_RIN_CUSTOM_FIELD,
    GEDCOM_UID_CUSTOM_FIELD, GEDCOM_VITAL_STATUS_CUSTOM_FIELD, GEDCOM_NATIONALITY_CUSTOM_FIELD,
    GEDCOM_EDUCATION_CUSTOM_FIELD, GEDCOM_CITATIONS_CUSTOM_FIELD, GEDCOM_MEDIA_CUSTOM_FIELD,
  ]);
  for (const [key, value] of Object.entries(customFields(profile))) {
    if (
      ignored.has(key)
      || key.startsWith("__gedcom")
      || value === ""
      || value === null
      || value === undefined
    ) continue;
    addLine(lines, 1, "EVEN");
    addLine(lines, 2, "TYPE", `Tracker field: ${key}`);
    addMultiline(lines, 2, "NOTE", typeof value === "string" ? value : JSON.stringify(value));
    addLine(lines, 2, "_TRK_FIELD_KEY", key);
  }
}

function profileNoteForExport(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^Імпортовано з GEDCOM\. Початковий ідентифікатор:/u.test(line.trim()))
    .join("\n")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string {
  return stringValue(metadata?.[key]);
}

function formatGedcomCoordinate(value: number, positive: string, negative: string): string {
  return `${value < 0 ? negative : positive}${Math.abs(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function mergeProfileEvents(
  projectId: string,
  personId: string,
  canonical: FamilyTreePersonTimelineEvent[],
  nodeMetadata: Record<string, unknown> | undefined,
): FamilyTreePersonTimelineEvent[] {
  const profile = asRecord(asRecord(nodeMetadata).personProfile);
  const saved = customFields(profile).__trackerRoduPersonEvents;
  if (!Array.isArray(saved)) return canonical;
  const result = [...canonical];
  const seen = new Set(result.map(eventIdentity));
  for (const [index, value] of saved.entries()) {
    const event = asRecord(value);
    const type = timelineEventType(stringValue(event.type), stringValue(event.title));
    const mapped: FamilyTreePersonTimelineEvent = {
      id: stringValue(event.id) || `profile-event-${personId}-${index}`,
      projectId,
      personId,
      eventType: type,
      title: stringValue(event.title),
      eventDate: stringValue(event.date),
      dateFrom: "",
      dateTo: "",
      dateText: stringValue(event.date),
      placeName: stringValue(event.placeName),
      geo: asRecord(event.geo) as unknown as FamilyTreePersonTimelineEvent["geo"],
      eventRole: "subject",
      evidenceStatus: "unknown",
      confidence: 0,
      sourceDocumentId: null,
      sourceFindingId: null,
      notes: stringValue(event.notes),
      metadata: { source: "persons.custom_fields.__trackerRoduPersonEvents" },
      createdAt: "",
      updatedAt: "",
    };
    const identity = eventIdentity(mapped);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(mapped);
  }
  return result;
}

function timelineEventType(type: string, title: string): FamilyTreePersonTimelineEvent["eventType"] {
  const supported = new Set<FamilyTreePersonTimelineEvent["eventType"]>([
    "birth", "baptism", "christening", "marriage", "divorce", "residence", "census", "revision_list",
    "confession_list", "household_register", "immigration", "emigration", "military", "occupation",
    "education", "nationality", "death", "burial", "cremation", "probate", "mention", "other",
  ]);
  if (supported.has(type as FamilyTreePersonTimelineEvent["eventType"])) return type as FamilyTreePersonTimelineEvent["eventType"];
  const normalizedTitle = title.toLocaleLowerCase("uk");
  if (normalizedTitle.includes("перепис")) return "census";
  if (normalizedTitle.includes("освіт")) return "other";
  if (normalizedTitle.includes("профес")) return "occupation";
  return "other";
}

function eventIdentity(event: FamilyTreePersonTimelineEvent): string {
  return [event.eventType, event.eventDate || event.dateText, event.placeName, event.notes].join("|");
}

function buildGedcomFamilies(
  projection: FamilyTreeProjection,
  warnings: FamilyTreeGraphIssue[],
): GedcomFamily[] {
  const families = new Map<string, GedcomFamily>();
  const partnerFamilyByPair = new Map<string, string>();
  const partnerFamilyByGroup = new Map<string, string>();
  const nodesById = new Map(projection.nodes.map((node) => [node.personId, node]));

  for (const edge of projection.partnerEdges) {
    const pair = sortedPairKey(edge.fromPersonId, edge.toPersonId);
    const key = edge.familyGroupId ? `group:${edge.familyGroupId}` : `partner:${pair}`;
    partnerFamilyByPair.set(pair, key);
    if (edge.familyGroupId) partnerFamilyByGroup.set(edge.familyGroupId, key);
    const family = getFamily(families, key);
    family.partnerIds = sortPartnerIds([edge.fromPersonId, edge.toPersonId], nodesById);
    family.familyGroupId = edge.familyGroupId ?? null;
    family.relationshipType = String(edge.relationshipType);
    family.evidenceStatus = edge.evidenceStatus;
    family.confidence = edge.confidence;
    family.marriageDate = stringMetadata(edge.metadata, "startDate");
    family.marriagePlace = stringMetadata(edge.metadata, "startPlace");
    family.endDate = stringMetadata(edge.metadata, "endDate");
    family.endPlace = stringMetadata(edge.metadata, "endPlace");
    family.notes = stringMetadata(edge.metadata, "notes");
    family.sourceEdgeIds.push(edge.id);
  }

  const parentEdgesBySet = new Map<string, FamilyTreeProjectionEdge[]>();
  for (const edge of projection.parentChildEdges) {
    const setKey = parentFamilySetKey(edge);
    const edges = parentEdgesBySet.get(setKey) ?? [];
    edges.push(edge);
    parentEdgesBySet.set(setKey, edges);
  }

  for (const edges of parentEdgesBySet.values()) {
    const childId = edges[0]?.toPersonId;
    if (!childId) continue;
    const parentIds = unique(edges.map((edge) => edge.fromPersonId));
    if (!parentIds.length) continue;
    const pair = parentIds.length === 2 ? sortedPairKey(parentIds[0], parentIds[1]) : "";
    const groupKey = edges[0].familyGroupId ? partnerFamilyByGroup.get(edges[0].familyGroupId) : undefined;
    const key = groupKey
      ?? (pair && partnerFamilyByPair.has(pair)
        ? partnerFamilyByPair.get(pair)!
        : `parents:${edges[0].parentSetType ?? edges[0].relationshipType ?? "unknown"}:${parentIds.slice().sort().join("+")}`);
    const family = getFamily(families, key);
    family.partnerIds = sortPartnerIds(unique([...family.partnerIds, ...parentIds]), nodesById);
    family.familyGroupId = family.familyGroupId ?? edges[0].familyGroupId ?? null;
    if (family.evidenceStatus === "unknown") family.evidenceStatus = edges[0].evidenceStatus;
    if (!family.confidence) family.confidence = edges[0].confidence;
    family.childIds = unique([...family.childIds, childId]);
    family.childPedigree[childId] = relationTypeToPedigree(String(edges[0].relationshipType));
    family.sourceEdgeIds.push(...edges.map((edge) => edge.id));

    if (parentIds.length > 2) {
      warnings.push({
        severity: "needs_review",
        code: "gedcom_parent_set_more_than_two_parents",
        message: "A child has more than two parent links in one GEDCOM family projection.",
        personIds: [childId, ...parentIds],
      });
    }
  }

  return Array.from(families.values());
}

function getFamily(families: Map<string, GedcomFamily>, key: string): GedcomFamily {
  const existing = families.get(key);
  if (existing) return existing;
  const created: GedcomFamily = {
    key,
    partnerIds: [],
    childIds: [],
    childPedigree: {},
    marriageDate: "",
    marriagePlace: "",
    sourceEdgeIds: [],
    familyGroupId: null,
    relationshipType: "unknown",
    endDate: "",
    endPlace: "",
    notes: "",
    evidenceStatus: "unknown",
    confidence: 0,
  };
  families.set(key, created);
  return created;
}

function buildFamilyPointersByPerson(
  families: GedcomFamily[],
  familyXrefs: Record<string, string>,
): Map<string, { fams: string[]; famc: Array<{ xref: string; pedi: string | null }> }> {
  const result = new Map<string, { fams: string[]; famc: Array<{ xref: string; pedi: string | null }> }>();
  const famsSeenByPerson = new Map<string, Set<string>>();
  const famcSeenByPerson = new Map<string, Set<string>>();
  const ensure = (personId: string) => {
    const existing = result.get(personId);
    if (existing) return existing;
    const created = { fams: [], famc: [] };
    result.set(personId, created);
    return created;
  };

  for (const family of families) {
    const xref = familyXrefs[family.key];
    for (const partnerId of family.partnerIds) {
      const person = ensure(partnerId);
      const seen = famsSeenByPerson.get(partnerId) ?? new Set<string>();
      if (!famsSeenByPerson.has(partnerId)) famsSeenByPerson.set(partnerId, seen);
      if (!seen.has(xref)) {
        seen.add(xref);
        person.fams.push(xref);
      }
    }
    for (const childId of family.childIds) {
      const person = ensure(childId);
      const seen = famcSeenByPerson.get(childId) ?? new Set<string>();
      if (!famcSeenByPerson.has(childId)) famcSeenByPerson.set(childId, seen);
      if (!seen.has(xref)) {
        seen.add(xref);
        person.famc.push({ xref, pedi: family.childPedigree[childId] ?? null });
      }
    }
  }

  return result;
}

function parseGedcomLine(raw: string, lineNumber: number): Omit<GedcomLine, "parentIndex"> | null {
  const match = raw.match(/^(\d+)(?:\s+(@[^@\s]+@))?\s+([A-Za-z0-9_]+)(?:\s+(.*))?$/);
  if (!match) return null;
  return {
    level: Number(match[1]),
    pointer: match[2] ?? null,
    tag: match[3].toUpperCase(),
    value: match[4] ?? "",
    raw,
    lineNumber,
  };
}

function countRecords(records: GedcomRecord[], tag: string): number {
  return records.filter((record) => record.tag === tag).length;
}

function firstChildValue(lines: GedcomLine[], recordTag: string, childTag: string): string | null {
  const recordIndex = lines.findIndex((line) => line.level === 0 && line.tag === recordTag);
  if (recordIndex < 0) return null;
  return lines.find((line) => line.parentIndex === recordIndex && line.tag === childTag)?.value ?? null;
}

function firstGrandchildValue(
  lines: GedcomLine[],
  recordTag: string,
  childTag: string,
  grandchildTag: string,
): string | null {
  const recordIndex = lines.findIndex((line) => line.level === 0 && line.tag === recordTag);
  if (recordIndex < 0) return null;
  const childIndex = lines.findIndex((line) => line.parentIndex === recordIndex && line.tag === childTag);
  if (childIndex < 0) return null;
  return lines.find((line) => line.parentIndex === childIndex && line.tag === grandchildTag)?.value ?? null;
}

function addLine(lines: string[], level: number, tag: string, value = "", pointer = ""): void {
  const parts = [String(level)];
  if (pointer) parts.push(pointer);
  parts.push(tag);
  const prefix = parts.join(" ");
  const sanitized = value ? sanitizeGedcomValue(value) : "";
  const chunks = splitGedcomValue(sanitized, Math.max(40, 240 - prefix.length - 1));
  lines.push(chunks[0] ? `${prefix} ${chunks[0]}` : prefix);
  for (const continuation of chunks.slice(1)) {
    lines.push(`${level + 1} CONC ${continuation}`);
  }
}

function addMultiline(lines: string[], level: number, tag: string, value: string): void {
  const normalized = sanitizeGedcomValue(value).split("\n");
  addLine(lines, level, tag, normalized[0] ?? "");
  for (const continuation of normalized.slice(1)) {
    addLine(lines, level + 1, "CONT", continuation);
  }
}

function sanitizeGedcomValue(value: string): string {
  const normalized = value.replace(/\r/g, "").replace(/[^\S\n]+/g, " ").trim();
  if (validGedcomXref(normalized)) return normalized;
  return normalized.replace(/(?<!@)@(?!@)/g, "@@");
}

function splitGedcomValue(value: string, maxBytes: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let chunk = "";
  let chunkBytes = 0;
  for (const codePoint of value.replace(/\n/g, " ")) {
    const bytes = encoder.encode(codePoint).length;
    if (chunk && chunkBytes + bytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += codePoint;
    chunkBytes += bytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [""];
}

function formatGedcomName(givenName: string, patronymic: string, surname: string, fallback: string): string {
  const givenParts = [givenName, patronymic].map((part) => part.trim()).filter(Boolean).join(" ");
  const cleanSurname = surname.trim();
  if (cleanSurname) return `${givenParts} /${cleanSurname}/`.trim();
  return sanitizeGedcomValue(fallback || givenParts || "Без імені");
}

function gedcomNameType(nameType: string): string {
  switch (nameType) {
    case "birth":
      return "birth";
    case "married":
      return "married";
    case "original":
      return "original";
    case "transliteration":
      return "transliteration";
    case "surname_variant":
    case "patronymic_variant":
      return "variant";
    case "alias":
    default:
      return "aka";
  }
}

function genderToGedcomSex(gender: Person["gender"]): "M" | "F" | "U" | "" {
  const value = String(gender).toLocaleLowerCase("uk");
  if (value.includes("жін") || value.includes("female") || value.includes("Р¶С–РЅ".toLocaleLowerCase("uk"))) return "F";
  if (value.includes("чолов") || value.includes("male") || value.includes("С‡РѕР»".toLocaleLowerCase("uk"))) return "M";
  if (value.includes("невідом") || value.includes("unknown")) return "U";
  return "";
}

function eventTypeToGedcomTag(eventType: string): string {
  switch (eventType) {
    case "birth":
      return "BIRT";
    case "baptism":
      return "BAPM";
    case "christening":
      return "CHR";
    case "death":
      return "DEAT";
    case "burial":
      return "BURI";
    case "residence":
      return "RESI";
    case "occupation":
      return "OCCU";
    case "education":
      return "EDUC";
    case "nationality":
      return "NATI";
    case "census":
      return "CENS";
    case "immigration":
      return "IMMI";
    case "emigration":
      return "EMIG";
    case "cremation":
      return "CREM";
    case "probate":
      return "PROB";
    case "military":
    case "revision_list":
    case "confession_list":
    case "household_register":
    case "mention":
    case "other":
      return "EVEN";
    case "marriage":
    case "divorce":
      return "EVEN";
    default:
      return "";
  }
}

function relationTypeToPedigree(relationshipType: string): "birth" | "adopted" | "foster" | "other" {
  switch (relationshipType) {
    case "biological":
    case "birth_parent":
    case "genetic_father":
    case "genetic_mother":
      return "birth";
    case "adoptive":
      return "adopted";
    case "foster":
      return "foster";
    default:
      return "other";
  }
}

function parentSetTypeFromRelationship(relationshipType: string): FamilyTreeProjectionEdge["parentSetType"] {
  switch (relationshipType) {
    case "biological":
    case "birth_parent":
      return "biological";
    case "genetic_father":
    case "genetic_mother":
      return "genetic";
    case "adoptive":
      return "adoptive";
    case "foster":
      return "foster";
    case "step":
      return "step";
    case "guardian":
      return "guardian";
    case "social_parent":
      return "social";
    case "legal_parent":
      return "legal";
    case "presumed":
    case "unknown":
      return "unknown";
    case "other":
      return "other";
    default:
      return undefined;
  }
}

function parentFamilySetKey(edge: FamilyTreeProjectionEdge): string {
  return [
    edge.toPersonId,
    edge.parentSetId || edge.parentSetType || edge.relationshipType || "unknown",
  ].join(":");
}

function sortPartnerIds(
  personIds: string[],
  nodesById: Map<string, FamilyTreeProjectionNode>,
): string[] {
  return personIds.slice().sort((first, second) => {
    const firstSex = genderToGedcomSex(nodesById.get(first)?.gender ?? ("" as Person["gender"]));
    const secondSex = genderToGedcomSex(nodesById.get(second)?.gender ?? ("" as Person["gender"]));
    if (firstSex === "M" && secondSex !== "M") return -1;
    if (secondSex === "M" && firstSex !== "M") return 1;
    if (firstSex === "F" && secondSex !== "F") return 1;
    if (secondSex === "F" && firstSex !== "F") return -1;
    return first.localeCompare(second);
  });
}

function sortedPairKey(first: string, second: string): string {
  return [first, second].sort().join("+");
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
