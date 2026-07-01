import type { Person } from "../types";
import type {
  FamilyTreeGraphIssue,
  GedcomExportOptions,
  GedcomExportResult,
  GedcomLine,
  GedcomParseResult,
  GedcomRecord,
  GedcomSummary,
} from "../types/familyTree";
import type {
  FamilyTreeProjection,
  FamilyTreeProjectionEdge,
  FamilyTreeProjectionNode,
} from "./familyTreeProjection.ts";

type GedcomFamily = {
  key: string;
  partnerIds: string[];
  childIds: string[];
  childPedigree: Record<string, "birth" | "adopted" | "foster" | "other">;
  marriageDate: string;
  marriagePlace: string;
  sourceEdgeIds: string[];
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

export function exportFamilyTreeProjectionToGedcom(
  projection: FamilyTreeProjection,
  options: GedcomExportOptions = {},
): GedcomExportResult {
  const warnings: FamilyTreeGraphIssue[] = [];
  const individualXrefs = buildIndividualXrefs(projection.nodes);
  const families = buildGedcomFamilies(projection, warnings);
  const familyXrefs = Object.fromEntries(families.map((family, index) => [family.key, `@F${index + 1}@`]));
  const familyPointersByPerson = buildFamilyPointersByPerson(families, familyXrefs);
  const lines: string[] = [];
  const sourceName = options.sourceName || "Treker Rodu";
  const submitterXref = "@SUB1@";
  const createdAt = options.createdAt ? new Date(options.createdAt) : new Date();

  addLine(lines, 0, "HEAD");
  addLine(lines, 1, "SOUR", sanitizeGedcomValue(sourceName));
  addLine(lines, 1, "DEST", "ANY");
  addLine(lines, 1, "DATE", formatGedcomDate(createdAt.toISOString().slice(0, 10)));
  addLine(lines, 1, "CHAR", "UTF-8");
  addLine(lines, 1, "GEDC");
  addLine(lines, 2, "VERS", options.gedcomVersion ?? "5.5.1");
  addLine(lines, 2, "FORM", "LINEAGE-LINKED");
  addLine(lines, 1, "SUBM", submitterXref);

  for (const node of projection.nodes) {
    addIndividual(lines, node, individualXrefs, familyPointersByPerson, projection.associationEdges, options);
  }

  for (const family of families) {
    addFamily(lines, family, familyXrefs[family.key], individualXrefs, warnings);
  }

  addLine(lines, 0, "SUBM", "", submitterXref);
  addLine(lines, 1, "NAME", sanitizeGedcomValue(options.submitterName || sourceName));
  addLine(lines, 0, "TRLR");

  return {
    text: `${lines.join("\n")}\n`,
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
  const trimmed = value.trim();
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

function addIndividual(
  lines: string[],
  node: FamilyTreeProjectionNode,
  individualXrefs: Record<string, string>,
  familyPointersByPerson: Map<string, { fams: string[]; famc: Array<{ xref: string; pedi: string | null }> }>,
  associationEdges: FamilyTreeProjectionEdge[],
  options: GedcomExportOptions,
): void {
  const personXref = individualXrefs[node.personId];
  const pointers = familyPointersByPerson.get(node.personId);

  addLine(lines, 0, "INDI", "", personXref);
  addName(lines, node);
  const privacyRestriction = gedcomPrivacyRestriction(node);
  if (privacyRestriction) addLine(lines, 1, "RESN", privacyRestriction);

  for (const name of node.names.filter((name) => !name.isPrimary)) {
    addLine(lines, 1, "NAME", formatGedcomName(name.givenName, name.patronymic, name.surname, name.fullName));
    addLine(lines, 2, "TYPE", gedcomNameType(name.nameType));
    if (name.originalText && name.originalText !== name.fullName) {
      addMultiline(lines, 2, "NOTE", `Original spelling: ${name.originalText}`);
    }
  }

  const sex = genderToGedcomSex(node.gender);
  if (sex) addLine(lines, 1, "SEX", sex);

  for (const event of node.events) {
    addEvent(lines, event.eventType, event.eventDate || event.dateText, event.placeName, event.title || event.notes);
  }

  for (const fams of pointers?.fams ?? []) {
    addLine(lines, 1, "FAMS", fams);
  }
  for (const famc of pointers?.famc ?? []) {
    addLine(lines, 1, "FAMC", famc.xref);
    if (famc.pedi) addLine(lines, 2, "PEDI", famc.pedi);
  }

  if (options.includeAssociations ?? true) {
    for (const edge of associationEdges.filter((edge) => edge.fromPersonId === node.personId)) {
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
  if (node.isLiving || node.privacyStatus === "private") return "privacy";
  return "";
}

function addName(lines: string[], node: FamilyTreeProjectionNode): void {
  const name = node.primaryName;
  addLine(lines, 1, "NAME", formatGedcomName(name.givenName, name.patronymic, name.surname, name.fullName));
  if (name.givenName) addLine(lines, 2, "GIVN", sanitizeGedcomValue(name.givenName));
  if (name.surname) addLine(lines, 2, "SURN", sanitizeGedcomValue(name.surname));
  if (name.patronymic) addLine(lines, 2, "_PATR", sanitizeGedcomValue(name.patronymic));
}

function addEvent(
  lines: string[],
  eventType: string,
  dateText: string,
  placeName: string,
  note: string,
): void {
  const tag = eventTypeToGedcomTag(eventType);
  if (!tag) return;
  addLine(lines, 1, tag);
  if (dateText) addLine(lines, 2, "DATE", formatGedcomDate(dateText));
  if (placeName) addLine(lines, 2, "PLAC", sanitizeGedcomValue(placeName));
  if (tag === "EVEN" && eventType !== "other") addLine(lines, 2, "TYPE", sanitizeGedcomValue(eventType));
  if (note) addMultiline(lines, 2, "NOTE", note);
}

function addFamily(
  lines: string[],
  family: GedcomFamily,
  familyXref: string,
  individualXrefs: Record<string, string>,
  warnings: FamilyTreeGraphIssue[],
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

  if (partners[0]) addLine(lines, 1, "HUSB", individualXrefs[partners[0]]);
  if (partners[1]) addLine(lines, 1, "WIFE", individualXrefs[partners[1]]);
  if (family.marriageDate || family.marriagePlace) {
    addLine(lines, 1, "MARR");
    if (family.marriageDate) addLine(lines, 2, "DATE", formatGedcomDate(family.marriageDate));
    if (family.marriagePlace) addLine(lines, 2, "PLAC", sanitizeGedcomValue(family.marriagePlace));
  }
  for (const childId of family.childIds) {
    const childXref = individualXrefs[childId];
    if (childXref) addLine(lines, 1, "CHIL", childXref);
  }
}

function buildIndividualXrefs(nodes: FamilyTreeProjectionNode[]): Record<string, string> {
  return Object.fromEntries(nodes.map((node, index) => [node.personId, `@I${index + 1}@`]));
}

function buildGedcomFamilies(
  projection: FamilyTreeProjection,
  warnings: FamilyTreeGraphIssue[],
): GedcomFamily[] {
  const families = new Map<string, GedcomFamily>();
  const partnerFamilyByPair = new Map<string, string>();

  for (const edge of projection.partnerEdges) {
    const pair = sortedPairKey(edge.fromPersonId, edge.toPersonId);
    const key = `partner:${pair}`;
    partnerFamilyByPair.set(pair, key);
    const family = getFamily(families, key);
    family.partnerIds = sortPartnerIds([edge.fromPersonId, edge.toPersonId], projection);
    family.sourceEdgeIds.push(edge.id);
  }

  const parentEdgesByChild = new Map<string, FamilyTreeProjectionEdge[]>();
  for (const edge of projection.parentChildEdges) {
    const edges = parentEdgesByChild.get(edge.toPersonId) ?? [];
    edges.push(edge);
    parentEdgesByChild.set(edge.toPersonId, edges);
  }

  for (const [childId, edges] of parentEdgesByChild.entries()) {
    const parentIds = unique(edges.map((edge) => edge.fromPersonId));
    if (!parentIds.length) continue;
    const pair = parentIds.length === 2 ? sortedPairKey(parentIds[0], parentIds[1]) : "";
    const key = pair && partnerFamilyByPair.has(pair)
      ? partnerFamilyByPair.get(pair)!
      : `parents:${parentIds.slice().sort().join("+")}:${edges[0].parentSetType ?? "unknown"}`;
    const family = getFamily(families, key);
    family.partnerIds = sortPartnerIds(unique([...family.partnerIds, ...parentIds]), projection);
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
  };
  families.set(key, created);
  return created;
}

function buildFamilyPointersByPerson(
  families: GedcomFamily[],
  familyXrefs: Record<string, string>,
): Map<string, { fams: string[]; famc: Array<{ xref: string; pedi: string | null }> }> {
  const result = new Map<string, { fams: string[]; famc: Array<{ xref: string; pedi: string | null }> }>();
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
      if (!person.fams.includes(xref)) person.fams.push(xref);
    }
    for (const childId of family.childIds) {
      const person = ensure(childId);
      if (!person.famc.some((entry) => entry.xref === xref)) {
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
  if (value) parts.push(sanitizeGedcomValue(value));
  lines.push(parts.join(" "));
}

function addMultiline(lines: string[], level: number, tag: string, value: string): void {
  const normalized = sanitizeGedcomValue(value).split("\n");
  addLine(lines, level, tag, normalized[0] ?? "");
  for (const continuation of normalized.slice(1)) {
    addLine(lines, level + 1, "CONT", continuation);
  }
}

function sanitizeGedcomValue(value: string): string {
  return value.replace(/\r/g, "").replace(/[^\S\n]+/g, " ").trim();
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
  if (value.includes("чолов") || value.includes("male") || value.includes("С‡РѕР»".toLocaleLowerCase("uk"))) return "M";
  if (value.includes("жін") || value.includes("female") || value.includes("Р¶С–РЅ".toLocaleLowerCase("uk"))) return "F";
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
    case "military":
    case "census":
    case "revision_list":
    case "confession_list":
    case "mention":
    case "other":
      return "EVEN";
    case "marriage":
    case "divorce":
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

function sortPartnerIds(personIds: string[], projection: FamilyTreeProjection): string[] {
  const nodesById = new Map(projection.nodes.map((node) => [node.personId, node]));
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
