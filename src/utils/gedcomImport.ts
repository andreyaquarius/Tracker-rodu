import type {
  FamilyTreeGraphIssue,
  FamilyTreePersonNameType,
  FamilyTreePersonTimelineEventType,
  GedcomImportDraft,
  GedcomImportEventDraft,
  GedcomImportFamilyDraft,
  GedcomImportGender,
  GedcomImportMediaDraft,
  GedcomImportNameDraft,
  GedcomImportParentChildDraft,
  GedcomImportPartnerDraft,
  GedcomImportCitationDraft,
  GedcomImportSourceDraft,
  GedcomLine,
  GedcomParseResult,
  GedcomRecord,
  ParentChildRelationshipType,
  ParentRoleLabel,
  PartnerRelationshipType,
} from "../types/familyTree";
import { normalizeGedcomDisplayText } from "./gedcomText.ts";
import { parseGedcom, summarizeGedcom } from "./gedcom.ts";

const KNOWN_TOP_LEVEL_RECORDS = new Set(["HEAD", "TRLR", "INDI", "FAM", "SOUR", "NOTE", "REPO", "SUBM", "OBJE"]);

type GedcomLineLookup = {
  lines: GedcomLine[];
  childrenByParentIndex: Map<number, GedcomLine[]>;
  lineIndexByLine: Map<GedcomLine, number>;
};

const NO_GEDCOM_CHILDREN: GedcomLine[] = [];

export function buildGedcomImportDraft(input: string | GedcomParseResult): GedcomImportDraft {
  const parseResult = typeof input === "string" ? parseGedcom(input) : input;
  const lineLookup = buildGedcomLineLookup(parseResult.lines);
  const warnings: FamilyTreeGraphIssue[] = [...parseResult.warnings];
  const people = parseResult.records
    .filter((record) => record.tag === "INDI" && record.pointer)
    .map((record) => personDraftFromRecord(record, lineLookup));
  const families = parseResult.records
    .filter((record) => record.tag === "FAM" && record.pointer)
    .map((record) => familyDraftFromRecord(record, lineLookup));
  const sources = parseResult.records
    .filter((record) => record.tag === "SOUR" && record.pointer)
    .map((record) => sourceDraftFromRecord(record, lineLookup));

  const peopleByXref = new Map(people.map((person) => [person.xref, person]));
  const parentChildRelationships: GedcomImportParentChildDraft[] = [];
  const partnerRelationships: GedcomImportPartnerDraft[] = [];

  for (const family of families) {
    if (!family.partnerXrefs.length && family.childXrefs.length) {
      warnings.push({
        severity: "needs_review",
        code: "gedcom_family_children_without_parents",
        message: "GEDCOM family has children but no parent links.",
        personIds: family.childXrefs,
      });
    }

    const partners = family.partnerXrefs.filter((xref) => {
      const exists = peopleByXref.has(xref);
      if (!exists) {
        warnings.push({
          severity: "warning",
          code: "gedcom_family_missing_partner",
          message: "GEDCOM family references a partner record that is not present.",
        });
      }
      return exists;
    });

    const children = family.childXrefs.filter((xref) => {
      const exists = peopleByXref.has(xref);
      if (!exists) {
        warnings.push({
          severity: "warning",
          code: "gedcom_family_missing_child",
          message: "GEDCOM family references a child record that is not present.",
        });
      }
      return exists;
    });

    if (partners.length > 2) {
      warnings.push({
        severity: "needs_review",
        code: "gedcom_family_more_than_two_partners",
        message: "GEDCOM family has more than two partner candidates.",
        personIds: partners,
      });
    }

    if (partners.length >= 2) {
      partnerRelationships.push(partnerDraftFromFamily(family, partners[0], partners[1]));
    }

    for (const childXref of children) {
      const child = peopleByXref.get(childXref);
      const famc = child?.famc.find((entry) => entry.familyXref === family.xref);
      for (const parentXref of partners.slice(0, 2)) {
        parentChildRelationships.push({
          familyXref: family.xref,
          parentXref,
          childXref,
          relationshipType: pedigreeToParentChildType(famc?.pedigree ?? null),
          parentRoleLabel: parentRoleForFamilyPosition(family.partnerXrefs.indexOf(parentXref)),
          pedigree: famc?.pedigree ?? null,
          notes: family.notes,
        });
      }
    }
  }

  const familyByXref = new Map(families.map((family) => [family.xref, family]));
  for (const child of people) {
    for (const familyLink of child.famc) {
      const family = familyByXref.get(familyLink.familyXref);
      if (!family || family.childXrefs.includes(child.xref)) continue;
      warnings.push({
        severity: "needs_review",
        code: "gedcom_famc_missing_reciprocal_child",
        message: `GEDCOM person ${child.xref} references ${family.xref} as a child family, but the family has no reciprocal CHIL link. The parent link was recovered from FAMC.`,
        personIds: [child.xref, ...family.partnerXrefs],
      });
      for (const parentXref of family.partnerXrefs.filter((xref) => peopleByXref.has(xref)).slice(0, 2)) {
        parentChildRelationships.push({
          familyXref: family.xref,
          parentXref,
          childXref: child.xref,
          relationshipType: pedigreeToParentChildType(familyLink.pedigree),
          parentRoleLabel: parentRoleForFamilyPosition(family.partnerXrefs.indexOf(parentXref)),
          pedigree: familyLink.pedigree,
          notes: family.notes,
        });
      }
    }
  }

  return {
    rootPersonXref: rootPersonXrefFromHead(parseResult, lineLookup),
    people,
    families,
    parentChildRelationships,
    partnerRelationships,
    sources,
    preservedRecords: parseResult.records.map((record, order) => preservedRecordFromRecord(parseResult, record, order)),
    unmappedRecords: parseResult.records.filter((record) => !KNOWN_TOP_LEVEL_RECORDS.has(record.tag)),
    summary: summarizeGedcom(parseResult),
    warnings,
  };
}

function rootPersonXrefFromHead(parseResult: GedcomParseResult, lineLookup: GedcomLineLookup): string {
  const head = parseResult.records.find((record) => record.tag === "HEAD");
  if (!head) return "";
  const rootLine = childrenOf(lineLookup, head.lineIndex)
    .find((line) => ["_TRK_ROOT", "_ROOT", "_TRK_CENTRAL", "_PRIMARY"].includes(line.tag) && line.value);
  return rootLine?.value ?? "";
}

function personDraftFromRecord(
  record: GedcomRecord,
  lineLookup: GedcomLineLookup,
) {
  const childLines = childrenOf(lineLookup, record.lineIndex);
  const names: GedcomImportNameDraft[] = [];
  for (const nameLine of childLines.filter((line) => line.tag === "NAME")) {
    const name = nameDraftFromLine(lineLookup, nameLine);
    names.push(name);
    for (const marriedNameLine of childrenOfLine(lineLookup, nameLine)
      .filter((line) => line.tag === "_MARNM" && line.value)) {
      names.push(marriedNameDraftFromLine(lineLookup, marriedNameLine, name));
    }
  }
  for (const marriedNameLine of childLines.filter((line) => line.tag === "_MARNM" && line.value)) {
    names.push(marriedNameDraftFromLine(lineLookup, marriedNameLine));
  }
  const events = childLines
    .map((line) => eventDraftFromLine(lineLookup, line))
    .filter((event): event is GedcomImportEventDraft => Boolean(event));
  const fams = childLines.filter((line) => line.tag === "FAMS" && line.value).map((line) => line.value);
  const famc = childLines
    .filter((line) => line.tag === "FAMC" && line.value)
    .map((line) => ({
      familyXref: line.value,
      pedigree: normalizePedigree(childValue(lineLookup, line, "PEDI")),
    }));
  const privacyRestriction = childValueByTag(childLines, "RESN");
  const trackerPrivacy = childValueByTag(childLines, "_TRK_PRIVACY");
  const privacyStatus = gedcomTrackerPrivacyStatus(trackerPrivacy) ?? gedcomResnToPrivacyStatus(privacyRestriction);
  const explicitLiving = gedcomLivingValue(childValueByTag(childLines, "LIVING") || childValueByTag(childLines, "_LIVING") || childValueByTag(childLines, "LIVN"));
  const isLiving = inferGedcomLivingStatus({
    explicitLiving,
    privacyRestriction,
    hasDeathEvent: events.some((event) => event.eventType === "death" || event.eventType === "burial" || event.eventType === "cremation"),
  });
  const hasDeathEvent = events.some((event) => event.eventType === "death" || event.eventType === "burial" || event.eventType === "cremation");
  const vitalStatus: "living" | "deceased" | "unknown" = hasDeathEvent
    ? "deceased"
    : explicitLiving === true || gedcomPrivacySuggestsLiving(privacyRestriction)
      ? "living"
      : "unknown";

  return {
    xref: record.pointer ?? "",
    gender: gedcomSexToGender(childValueByTag(childLines, "SEX")),
    isLiving,
    privacyStatus,
    names: names.length ? names : [blankNameDraft()],
    events,
    fams,
    famc,
    notes: collectNotes(lineLookup, recordLine(lineLookup, record)),
    nationality: collectDirectValues(lineLookup, childLines, "NATI").join("; "),
    religion: collectDirectValues(lineLookup, childLines, "RELI").join("; "),
    education: childLines
      .filter((line) => line.tag === "EDUC")
      .map((line) => eventSummary(lineLookup, line))
      .filter(Boolean),
    rin: decodeGedcomAtSigns(childValueByTag(childLines, "RIN")),
    uid: decodeGedcomAtSigns(childValueByTag(childLines, "_UID")),
    vitalStatus,
    citations: childLines.filter((line) => line.tag === "SOUR").map((line) => citationDraftFromLine(lineLookup, line)),
    media: childLines.filter((line) => line.tag === "OBJE").map((line) => mediaDraftFromLine(lineLookup, line)),
    rawLineNumber: record.lineNumber,
  };
}

function gedcomResnToPrivacyStatus(value: string): "private" | "project" | "public" | "confidential" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "confidential" || normalized === "locked") return "confidential";
  if (normalized === "privacy") return "private";
  return "project";
}

function gedcomTrackerPrivacyStatus(value: string): "private" | "project" | "public" | "confidential" | null {
  const normalized = value.trim().toLowerCase();
  return normalized === "private" || normalized === "project" || normalized === "public" || normalized === "confidential"
    ? normalized
    : null;
}

function gedcomLivingValue(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes" || normalized === "true" || normalized === "1") return true;
  if (normalized === "n" || normalized === "no" || normalized === "false" || normalized === "0") return false;
  return null;
}

function inferGedcomLivingStatus(input: {
  explicitLiving: boolean | null;
  privacyRestriction: string;
  hasDeathEvent: boolean;
}): boolean {
  if (input.hasDeathEvent) return false;
  if (input.explicitLiving !== null) return input.explicitLiving;
  return gedcomPrivacySuggestsLiving(input.privacyRestriction);
}

function gedcomPrivacySuggestsLiving(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "privacy" || normalized === "confidential";
}

function familyDraftFromRecord(
  record: GedcomRecord,
  lineLookup: GedcomLineLookup,
): GedcomImportFamilyDraft {
  const childLines = childrenOf(lineLookup, record.lineIndex);
  const husb = childLines.filter((line) => line.tag === "HUSB" && line.value).map((line) => line.value);
  const wife = childLines.filter((line) => line.tag === "WIFE" && line.value).map((line) => line.value);
  const otherPartners = childLines.filter((line) => line.tag === "PARTNER" && line.value).map((line) => line.value);
  const childXrefs = childLines.filter((line) => line.tag === "CHIL" && line.value).map((line) => line.value);
  const events = childLines
    .map((line) => eventDraftFromLine(lineLookup, line))
    .filter((event): event is GedcomImportEventDraft => Boolean(event));

  return {
    xref: record.pointer ?? "",
    partnerXrefs: unique([...husb, ...wife, ...otherPartners]),
    childXrefs: unique(childXrefs),
    events,
    notes: collectNotes(lineLookup, recordLine(lineLookup, record)),
    rin: decodeGedcomAtSigns(childValueByTag(childLines, "RIN")),
    uid: decodeGedcomAtSigns(childValueByTag(childLines, "_UID")),
    citations: childLines.filter((line) => line.tag === "SOUR").map((line) => citationDraftFromLine(lineLookup, line)),
    rawLineNumber: record.lineNumber,
  };
}

function partnerDraftFromFamily(
  family: GedcomImportFamilyDraft,
  personAXref: string,
  personBXref: string,
): GedcomImportPartnerDraft {
  const marriage = family.events.find((event) => event.eventType === "marriage");
  const divorce = family.events.find((event) => event.eventType === "divorce");
  const event = marriage ?? divorce;
  return {
    familyXref: family.xref,
    personAXref,
    personBXref,
    relationshipType: partnerTypeFromFamilyEvent(marriage, divorce),
    eventDate: marriage?.eventDate || marriage?.dateText || "",
    placeName: marriage?.placeName ?? "",
    endDate: divorce?.eventDate || divorce?.dateText || "",
    endPlaceName: divorce?.placeName ?? "",
    notes: unique([marriage?.notes ?? "", divorce?.notes ?? "", family.notes ?? ""].filter(Boolean)).join("\n\n"),
  };
}

function nameDraftFromLine(lineLookup: GedcomLineLookup, line: GedcomLine): GedcomImportNameDraft {
  const givenFromChild = childValue(lineLookup, line, "GIVN");
  const surnameFromChild = childValue(lineLookup, line, "SURN");
  const patronymicFromChild = childValue(lineLookup, line, "_PATR") || childValue(lineLookup, line, "PATR");
  const parsed = parseGedcomNameValue(line.value);
  const type = gedcomNameTypeToDraft(childValue(lineLookup, line, "TYPE"));
  return {
    nameType: type,
    surname: surnameFromChild || parsed.surname,
    givenName: givenFromChild || parsed.givenName,
    patronymic: patronymicFromChild,
    fullName: parsed.fullName,
    originalText: line.value,
  };
}

function marriedNameDraftFromLine(
  lineLookup: GedcomLineLookup,
  line: GedcomLine,
  baseName?: GedcomImportNameDraft,
): GedcomImportNameDraft {
  const givenFromChild = childValue(lineLookup, line, "GIVN");
  const surnameFromChild = childValue(lineLookup, line, "SURN");
  const patronymicFromChild = childValue(lineLookup, line, "_PATR") || childValue(lineLookup, line, "PATR");
  const parsed = parseGedcomNameValue(line.value);
  const isSurnameOnlyExtension = !line.value.includes("/") && !surnameFromChild;
  const surname = surnameFromChild || parsed.surname || (isSurnameOnlyExtension ? line.value.trim() : "");
  const givenName = givenFromChild || (isSurnameOnlyExtension ? baseName?.givenName ?? "" : parsed.givenName);
  const patronymic = patronymicFromChild || baseName?.patronymic || "";
  const fullName = [givenName, patronymic, surname].filter(Boolean).join(" ").trim() || parsed.fullName;
  return {
    nameType: "married",
    surname,
    givenName,
    patronymic,
    fullName,
    originalText: line.value,
  };
}

function blankNameDraft(): GedcomImportNameDraft {
  return {
    nameType: "primary",
    surname: "",
    givenName: "",
    patronymic: "",
    fullName: "",
    originalText: "",
  };
}

function eventDraftFromLine(lineLookup: GedcomLineLookup, line: GedcomLine): GedcomImportEventDraft | null {
  if (line.tag === "DEAT" && line.value.trim().toLowerCase() === "n") return null;
  const typeValue = childValue(lineLookup, line, "TYPE");
  const eventValue = decodeGedcomAtSigns(line.value);
  const notes = collectEventDescription(lineLookup, line);
  const eventType = gedcomTagToEventType(line.tag, typeValue, eventValue, notes);
  if (!eventType) return null;
  const eventDate = childValue(lineLookup, line, "DATE");
  const placeLine = childLine(lineLookup, line, "PLAC");
  const address = collectAddress(lineLookup, line);
  const placeName = decodeGedcomAtSigns(placeLine?.value ?? "") || address;
  return {
    eventType,
    tag: line.tag,
    value: eventValue,
    title: decodeGedcomAtSigns(typeValue) || eventTitleFromTag(line.tag),
    eventDate: decodeGedcomAtSigns(eventDate),
    dateText: decodeGedcomAtSigns(eventDate),
    placeName,
    geo: placeLine ? gedcomGeoFromPlace(lineLookup, placeLine, placeName) : null,
    notes,
    age: decodeGedcomAtSigns(childValue(lineLookup, line, "AGE")),
    cause: decodeGedcomAtSigns(childValue(lineLookup, line, "CAUS")),
    address,
    citations: childrenOfLine(lineLookup, line)
      .filter((child) => child.tag === "SOUR")
      .map((child) => citationDraftFromLine(lineLookup, child)),
    media: childrenOfLine(lineLookup, line)
      .filter((child) => child.tag === "OBJE")
      .map((child) => mediaDraftFromLine(lineLookup, child)),
  };
}

function sourceDraftFromRecord(record: GedcomRecord, lineLookup: GedcomLineLookup): GedcomImportSourceDraft {
  const children = childrenOf(lineLookup, record.lineIndex);
  return {
    xref: record.pointer ?? "",
    title: multilineChildValue(lineLookup, children, "TITL"),
    author: multilineChildValue(lineLookup, children, "AUTH"),
    publication: multilineChildValue(lineLookup, children, "PUBL"),
    text: multilineChildValue(lineLookup, children, "TEXT"),
    sourceType: decodeGedcomAtSigns(childValueByTag(children, "_TYPE")),
    mediaType: decodeGedcomAtSigns(childValueByTag(children, "_MEDI")),
    rin: decodeGedcomAtSigns(childValueByTag(children, "RIN")),
  };
}

function citationDraftFromLine(lineLookup: GedcomLineLookup, line: GedcomLine): GedcomImportCitationDraft {
  const children = childrenOfLine(lineLookup, line);
  const eventLine = children.find((child) => child.tag === "EVEN");
  const dataLine = children.find((child) => child.tag === "DATA");
  const dataChildren = dataLine ? childrenOfLine(lineLookup, dataLine) : NO_GEDCOM_CHILDREN;
  return {
    sourceXref: line.value,
    page: multilineChildValue(lineLookup, children, "PAGE"),
    eventType: eventLine ? collectGedcomMultilineValue(lineLookup, eventLine) : "",
    role: eventLine ? multilineChildValue(lineLookup, childrenOfLine(lineLookup, eventLine), "ROLE") : "",
    quality: decodeGedcomAtSigns(childValueByTag(children, "QUAY")),
    dataDate: decodeGedcomAtSigns(childValueByTag(dataChildren, "DATE")),
    text: multilineChildValue(lineLookup, dataChildren, "TEXT"),
    notes: collectNotes(lineLookup, line),
  };
}

function mediaDraftFromLine(lineLookup: GedcomLineLookup, line: GedcomLine): GedcomImportMediaDraft {
  const children = childrenOfLine(lineLookup, line);
  return {
    file: multilineChildValue(lineLookup, children, "FILE"),
    format: decodeGedcomAtSigns(childValueByTag(children, "FORM")),
    title: multilineChildValue(lineLookup, children, "TITL"),
    fileSize: decodeGedcomAtSigns(childValueByTag(children, "_FILESIZE")),
    photoRin: decodeGedcomAtSigns(childValueByTag(children, "_PHOTO_RIN")),
    isPrimary: yesValue(childValueByTag(children, "_PRIM_CUTOUT")),
    isPersonalPhoto: yesValue(childValueByTag(children, "_PERSONALPHOTO")),
  };
}

function preservedRecordFromRecord(parseResult: GedcomParseResult, record: GedcomRecord, order: number) {
  const nextRecord = parseResult.records[order + 1];
  const end = nextRecord?.lineIndex ?? parseResult.lines.length;
  return {
    order,
    pointer: record.pointer,
    tag: record.tag,
    value: record.value,
    lines: parseResult.lines.slice(record.lineIndex, end).map((line) => ({
      level: line.level,
      pointer: line.pointer,
      tag: line.tag,
      value: line.value,
    })),
  };
}

function recordLine(lineLookup: GedcomLineLookup, record: GedcomRecord): GedcomLine {
  const line = lineLookup.lines[record.lineIndex];
  if (line) return line;
  throw new Error(`GEDCOM record line ${record.lineNumber} is missing.`);
}

function buildGedcomLineLookup(lines: GedcomLine[]): GedcomLineLookup {
  const childrenByParentIndex = new Map<number, GedcomLine[]>();
  const lineIndexByLine = new Map<GedcomLine, number>();
  for (const [lineIndex, line] of lines.entries()) {
    lineIndexByLine.set(line, lineIndex);
    if (line.parentIndex === null) continue;
    const children = childrenByParentIndex.get(line.parentIndex) ?? [];
    children.push(line);
    childrenByParentIndex.set(line.parentIndex, children);
  }
  return { lines, childrenByParentIndex, lineIndexByLine };
}

function childrenOf(lineLookup: GedcomLineLookup, parentIndex: number): GedcomLine[] {
  return lineLookup.childrenByParentIndex.get(parentIndex) ?? NO_GEDCOM_CHILDREN;
}

function childrenOfLine(lineLookup: GedcomLineLookup, parent: GedcomLine): GedcomLine[] {
  const parentIndex = lineLookup.lineIndexByLine.get(parent);
  return parentIndex === undefined ? NO_GEDCOM_CHILDREN : childrenOf(lineLookup, parentIndex);
}

function childValue(lineLookup: GedcomLineLookup, parent: GedcomLine, tag: string): string {
  return childValueByTag(childrenOfLine(lineLookup, parent), tag);
}

function childLine(lineLookup: GedcomLineLookup, parent: GedcomLine, tag: string): GedcomLine | undefined {
  return childrenOfLine(lineLookup, parent).find((line) => line.tag === tag);
}

function childValueByTag(lines: GedcomLine[], tag: string): string {
  return lines.find((line) => line.tag === tag)?.value ?? "";
}

function gedcomGeoFromPlace(
  lineLookup: GedcomLineLookup,
  placeLine: GedcomLine,
  placeName: string,
): GedcomImportEventDraft["geo"] {
  const placeChildren = childrenOfLine(lineLookup, placeLine);
  const mapLine = placeChildren.find((line) => line.tag === "MAP");
  const coordinateLines = mapLine ? childrenOfLine(lineLookup, mapLine) : placeChildren;
  const latitude = gedcomCoordinateToNumber(childValueByTag(coordinateLines, "LATI"));
  const longitude = gedcomCoordinateToNumber(childValueByTag(coordinateLines, "LONG"));
  if (latitude === null || longitude === null) return null;
  return {
    displayName: placeName || null,
    latitude,
    longitude,
    source: "import",
    precision: "settlement",
    provider: "GEDCOM",
    externalId: null,
    markerColor: null,
  };
}

function gedcomCoordinateToNumber(value: string): number | null {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  const direction = normalized.match(/[NSEW]$/)?.[0] ?? normalized.match(/^[NSEW]/)?.[0] ?? "";
  const numeric = Number(normalized.replace(/[NSEW]/g, "").replace(",", "."));
  if (!Number.isFinite(numeric)) return null;
  if (direction === "S" || direction === "W") return -Math.abs(numeric);
  return numeric;
}

function collectNotes(lineLookup: GedcomLineLookup, parent: GedcomLine): string {
  return childrenOfLine(lineLookup, parent)
    .filter((line) => line.tag === "NOTE")
    .map((line) => collectGedcomMultilineValue(lineLookup, line))
    .filter(Boolean)
    .join("\n\n");
}

function collectEventDescription(lineLookup: GedcomLineLookup, parent: GedcomLine): string {
  const directDescriptions = childrenOfLine(lineLookup, parent)
    .filter((line) => ["NOTE", "DESC", "TEXT", "_DESC", "_DESCRIPTION", "_TEXT"].includes(line.tag))
    .map((line) => collectGedcomMultilineValue(lineLookup, line))
    .filter(Boolean);
  return unique(directDescriptions).join("\n\n");
}

function collectGedcomMultilineValue(lineLookup: GedcomLineLookup, line: GedcomLine): string {
  let value = line.value;
  for (const child of childrenOfLine(lineLookup, line)) {
    if (child.tag === "CONT") value += `\n${child.value}`;
    if (child.tag === "CONC") value += child.value;
  }
  return decodeGedcomAtSigns(value.trim());
}

function multilineChildValue(lineLookup: GedcomLineLookup, children: GedcomLine[], tag: string): string {
  const line = children.find((child) => child.tag === tag);
  return line ? collectGedcomMultilineValue(lineLookup, line) : "";
}

function collectDirectValues(lineLookup: GedcomLineLookup, children: GedcomLine[], tag: string): string[] {
  return children
    .filter((line) => line.tag === tag)
    .map((line) => collectGedcomMultilineValue(lineLookup, line))
    .filter(Boolean);
}

function collectAddress(lineLookup: GedcomLineLookup, eventLine: GedcomLine): string {
  const eventChildren = childrenOfLine(lineLookup, eventLine);
  const addressLine = eventChildren.find((line) => line.tag === "ADDR");
  const addressChildren = addressLine ? childrenOfLine(lineLookup, addressLine) : NO_GEDCOM_CHILDREN;
  const values = [
    addressLine ? collectGedcomMultilineValue(lineLookup, addressLine) : "",
    ...["ADR1", "ADR2", "CITY", "STAE", "POST", "CTRY", "EMAIL", "PHON"]
      .flatMap((tag) => [
        ...collectDirectValues(lineLookup, addressChildren, tag),
        ...collectDirectValues(lineLookup, eventChildren, tag),
      ]),
  ];
  return unique(values.map((value) => value.trim()).filter(Boolean)).join(", ");
}

function eventSummary(lineLookup: GedcomLineLookup, line: GedcomLine): string {
  const parts = [
    decodeGedcomAtSigns(line.value),
    decodeGedcomAtSigns(childValue(lineLookup, line, "DATE")),
    decodeGedcomAtSigns(childValue(lineLookup, line, "PLAC")),
    collectAddress(lineLookup, line),
    collectEventDescription(lineLookup, line),
  ].filter(Boolean);
  return unique(parts).join(" · ");
}

function yesValue(value: string): boolean {
  return ["y", "yes", "true", "1"].includes(value.trim().toLowerCase());
}

function decodeGedcomAtSigns(value: string): string {
  return normalizeGedcomDisplayText(value);
}

function eventTitleFromTag(tag: string): string {
  const labels: Record<string, string> = {
    BIRT: "Народження",
    BAPM: "Хрещення",
    CHR: "Хрещення",
    MARR: "Шлюб",
    DIV: "Розлучення",
    DEAT: "Смерть",
    BURI: "Поховання",
    CREM: "Кремація",
    RESI: "Проживання",
    CENS: "Перепис",
    OCCU: "Професія",
    EDUC: "Освіта",
    IMMI: "Імміграція",
    EMIG: "Еміграція",
    PROB: "Спадкова справа",
    EVEN: "Подія",
  };
  return labels[tag] ?? tag;
}

function parseGedcomNameValue(value: string): { givenName: string; surname: string; fullName: string } {
  const surnameMatch = value.match(/\/([^/]*)\//);
  const surname = surnameMatch?.[1]?.trim() ?? "";
  const withoutSurname = value.replace(/\/[^/]*\//, " ").replace(/\s+/g, " ").trim();
  const fullName = [withoutSurname, surname].filter(Boolean).join(" ").trim();
  return {
    givenName: withoutSurname,
    surname,
    fullName: fullName || value.trim(),
  };
}

function gedcomSexToGender(value: string): GedcomImportGender {
  switch (value.trim().toUpperCase()) {
    case "M":
      return "male";
    case "F":
      return "female";
    default:
      return "unknown";
  }
}

function gedcomNameTypeToDraft(value: string): FamilyTreePersonNameType {
  switch (value.trim().toLowerCase()) {
    case "birth":
    case "maiden":
    case "birth name":
    case "maiden name":
      return "birth";
    case "married":
      return "married";
    case "original":
      return "original";
    case "transliteration":
      return "transliteration";
    case "variant":
      return "alias";
    case "aka":
      return "alias";
    default:
      return "primary";
  }
}

function gedcomTagToEventType(
  tag: string,
  typeValue: string,
  eventValue = "",
  notes = "",
): FamilyTreePersonTimelineEventType | null {
  switch (tag) {
    case "BIRT":
      return "birth";
    case "BAPM":
      return "baptism";
    case "CHR":
      return "christening";
    case "MARR":
      return "marriage";
    case "DIV":
      return "divorce";
    case "DEAT":
      return "death";
    case "BURI":
      return "burial";
    case "RESI":
      return "residence";
    case "CENS":
      return "census";
    case "OCCU":
      return "occupation";
    case "EDUC":
      return "education";
    case "IMMI":
      return "immigration";
    case "EMIG":
      return "emigration";
    case "CREM":
      return "cremation";
    case "PROB":
      return "probate";
    case "EVEN":
      return customEventType(typeValue, eventValue, notes);
    default:
      return null;
  }
}

function customEventType(typeValue: string, eventValue = "", notes = ""): FamilyTreePersonTimelineEventType {
  const normalizedType = normalizeEventClassificationText(typeValue);
  const normalized = normalizeEventClassificationText([typeValue, eventValue, notes].filter(Boolean).join(" "));
  if (hasEventClassificationToken(normalizedType, [
    "погосподар", "посімейн", "посемейн", "household book", "household register", "family register",
  ])) return "household_register";
  if (hasEventClassificationToken(normalizedType, [
    "confession", "сповід", "исповед", "список християнської общини", "список христианской общины",
  ])) return "confession_list";
  if (hasEventClassificationToken(normalizedType, [
    "military", "військ", "военн", "рекрут", "солдат", "військова служба", "военная служба",
  ])) return "military";
  if (hasEventClassificationToken(normalizedType, ["census", "перепис", "перепись", "список виборц", "список избирател", "electoral roll"])) {
    return "census";
  }
  if (hasEventClassificationToken(normalizedType, ["акт про народження", "birth record", "birth act"])) return "birth";
  if (/^(marriage|шлюб|брак)(\s|$)/u.test(normalizedType)) return "marriage";

  if (hasEventClassificationToken(normalized, [
    "погосподар", "посімейн", "посемейн", "household book", "household register", "family register",
  ])) return "household_register";
  if (hasEventClassificationToken(normalized, ["revision", "ревіз", "ревиз", "ревізійна казка", "ревизская сказка"])) {
    return "revision_list";
  }
  if (hasEventClassificationToken(normalized, [
    "confession", "сповід", "исповед", "список християнської общини", "список христианской общины",
  ])) return "confession_list";
  if (hasEventClassificationToken(normalized, [
    "military", "військ", "военн", "рекрут", "солдат", "військова служба", "военная служба",
  ])) return "military";
  if (hasEventClassificationToken(normalized, ["census", "перепис", "перепись", "список виборц", "список избирател", "electoral roll"])) {
    return "census";
  }
  if (hasEventClassificationToken(normalized, ["mention", "згад"])) return "mention";
  return "other";
}

function normalizeEventClassificationText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("uk")
    .replace(/[’'`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasEventClassificationToken(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function normalizePedigree(value: string): "birth" | "adopted" | "foster" | "sealing" | "other" | null {
  switch (value.trim().toLowerCase()) {
    case "birth":
    case "biological":
      return "birth";
    case "adopted":
    case "adoptive":
      return "adopted";
    case "foster":
      return "foster";
    case "sealing":
      return "sealing";
    case "other":
      return "other";
    default:
      return null;
  }
}

function pedigreeToParentChildType(
  pedigree: "birth" | "adopted" | "foster" | "sealing" | "other" | null,
): ParentChildRelationshipType {
  switch (pedigree) {
    case "adopted":
      return "adoptive";
    case "foster":
      return "foster";
    case "sealing":
    case "other":
      return "other";
    case "birth":
    case null:
    default:
      return "biological";
  }
}

function parentRoleForFamilyPosition(index: number): ParentRoleLabel {
  if (index === 0) return "father";
  if (index === 1) return "mother";
  return "parent";
}

function partnerTypeFromFamilyEvent(
  marriage: GedcomImportEventDraft | undefined,
  divorce: GedcomImportEventDraft | undefined,
): PartnerRelationshipType {
  if (divorce) return "divorced";
  if (marriage) return "marriage";
  return "unknown";
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
