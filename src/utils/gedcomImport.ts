import type {
  FamilyTreeGraphIssue,
  FamilyTreePersonNameType,
  FamilyTreePersonTimelineEventType,
  GedcomImportDraft,
  GedcomImportEventDraft,
  GedcomImportFamilyDraft,
  GedcomImportGender,
  GedcomImportNameDraft,
  GedcomImportParentChildDraft,
  GedcomImportPartnerDraft,
  GedcomLine,
  GedcomParseResult,
  GedcomRecord,
  ParentChildRelationshipType,
  ParentRoleLabel,
  PartnerRelationshipType,
} from "../types/familyTree";
import { parseGedcom, summarizeGedcom } from "./gedcom.ts";

const KNOWN_TOP_LEVEL_RECORDS = new Set(["HEAD", "TRLR", "INDI", "FAM", "SOUR", "NOTE", "REPO", "SUBM", "OBJE"]);

export function buildGedcomImportDraft(input: string | GedcomParseResult): GedcomImportDraft {
  const parseResult = typeof input === "string" ? parseGedcom(input) : input;
  const warnings: FamilyTreeGraphIssue[] = [...parseResult.warnings];
  const people = parseResult.records
    .filter((record) => record.tag === "INDI" && record.pointer)
    .map((record) => personDraftFromRecord(parseResult, record));
  const families = parseResult.records
    .filter((record) => record.tag === "FAM" && record.pointer)
    .map((record) => familyDraftFromRecord(parseResult, record));

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
        });
      }
    }
  }

  return {
    people,
    families,
    parentChildRelationships,
    partnerRelationships,
    unmappedRecords: parseResult.records.filter((record) => !KNOWN_TOP_LEVEL_RECORDS.has(record.tag)),
    summary: summarizeGedcom(parseResult),
    warnings,
  };
}

function personDraftFromRecord(parseResult: GedcomParseResult, record: GedcomRecord) {
  const childLines = childrenOf(parseResult.lines, record.lineIndex);
  const names = childLines
    .filter((line) => line.tag === "NAME")
    .map((line) => nameDraftFromLine(parseResult.lines, line));
  const events = childLines
    .map((line) => eventDraftFromLine(parseResult.lines, line))
    .filter((event): event is GedcomImportEventDraft => Boolean(event));
  const fams = childLines.filter((line) => line.tag === "FAMS" && line.value).map((line) => line.value);
  const famc = childLines
    .filter((line) => line.tag === "FAMC" && line.value)
    .map((line) => ({
      familyXref: line.value,
      pedigree: normalizePedigree(childValue(parseResult.lines, line, "PEDI")),
    }));
  const privacyStatus = gedcomResnToPrivacyStatus(childValueByTag(childLines, "RESN"));
  const isLiving = gedcomLivingValue(childValueByTag(childLines, "LIVING") || childValueByTag(childLines, "_LIVING") || childValueByTag(childLines, "LIVN"));

  return {
    xref: record.pointer ?? "",
    gender: gedcomSexToGender(childValueByTag(childLines, "SEX")),
    isLiving,
    privacyStatus,
    names: names.length ? names : [blankNameDraft()],
    events,
    fams,
    famc,
    rawLineNumber: record.lineNumber,
  };
}

function gedcomResnToPrivacyStatus(value: string): "private" | "project" | "public" | "confidential" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "confidential" || normalized === "locked") return "confidential";
  if (normalized === "privacy") return "private";
  return "project";
}

function gedcomLivingValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "y" || normalized === "yes" || normalized === "true" || normalized === "1";
}

function familyDraftFromRecord(parseResult: GedcomParseResult, record: GedcomRecord): GedcomImportFamilyDraft {
  const childLines = childrenOf(parseResult.lines, record.lineIndex);
  const husb = childLines.filter((line) => line.tag === "HUSB" && line.value).map((line) => line.value);
  const wife = childLines.filter((line) => line.tag === "WIFE" && line.value).map((line) => line.value);
  const otherPartners = childLines.filter((line) => line.tag === "PARTNER" && line.value).map((line) => line.value);
  const childXrefs = childLines.filter((line) => line.tag === "CHIL" && line.value).map((line) => line.value);
  const events = childLines
    .map((line) => eventDraftFromLine(parseResult.lines, line))
    .filter((event): event is GedcomImportEventDraft => Boolean(event));

  return {
    xref: record.pointer ?? "",
    partnerXrefs: unique([...husb, ...wife, ...otherPartners]),
    childXrefs: unique(childXrefs),
    events,
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
    eventDate: event?.eventDate || event?.dateText || "",
    placeName: event?.placeName ?? "",
  };
}

function nameDraftFromLine(lines: GedcomLine[], line: GedcomLine): GedcomImportNameDraft {
  const givenFromChild = childValue(lines, line, "GIVN");
  const surnameFromChild = childValue(lines, line, "SURN");
  const patronymicFromChild = childValue(lines, line, "_PATR") || childValue(lines, line, "PATR");
  const parsed = parseGedcomNameValue(line.value);
  const type = gedcomNameTypeToDraft(childValue(lines, line, "TYPE"));
  return {
    nameType: type,
    surname: surnameFromChild || parsed.surname,
    givenName: givenFromChild || parsed.givenName,
    patronymic: patronymicFromChild,
    fullName: parsed.fullName,
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

function eventDraftFromLine(lines: GedcomLine[], line: GedcomLine): GedcomImportEventDraft | null {
  const eventType = gedcomTagToEventType(line.tag, childValue(lines, line, "TYPE"));
  if (!eventType) return null;
  const eventDate = childValue(lines, line, "DATE");
  return {
    eventType,
    eventDate,
    dateText: eventDate,
    placeName: childValue(lines, line, "PLAC"),
    notes: collectNotes(lines, line),
  };
}

function childrenOf(lines: GedcomLine[], parentIndex: number): GedcomLine[] {
  return lines.filter((line) => line.parentIndex === parentIndex);
}

function childValue(lines: GedcomLine[], parent: GedcomLine, tag: string): string {
  return childValueByTag(childrenOf(lines, lines.indexOf(parent)), tag);
}

function childValueByTag(lines: GedcomLine[], tag: string): string {
  return lines.find((line) => line.tag === tag)?.value ?? "";
}

function collectNotes(lines: GedcomLine[], parent: GedcomLine): string {
  const parentIndex = lines.indexOf(parent);
  return childrenOf(lines, parentIndex)
    .filter((line) => line.tag === "NOTE")
    .map((line) => [line.value, ...childrenOf(lines, lines.indexOf(line))
      .filter((child) => child.tag === "CONT" || child.tag === "CONC")
      .map((child) => child.value)]
      .filter(Boolean)
      .join("\n"))
    .filter(Boolean)
    .join("\n\n");
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
    case "EVEN":
      return customEventType(typeValue);
    default:
      return null;
  }
}

function customEventType(value: string): FamilyTreePersonTimelineEventType {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("revision") || normalized.includes("ревіз")) return "revision_list";
  if (normalized.includes("confession") || normalized.includes("сповід")) return "confession_list";
  if (normalized.includes("military") || normalized.includes("війсь")) return "military";
  if (normalized.includes("mention") || normalized.includes("згад")) return "mention";
  return "other";
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
