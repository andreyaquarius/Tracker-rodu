import type {
  GedcomImportDraft,
  GedcomImportEventDraft,
  GedcomImportGender,
  GedcomImportNameDraft,
  GedcomImportParentChildDraft,
  GedcomImportPartnerDraft,
} from "../types/familyTree";
import type {
  AppEntity,
  DocumentRecord,
  Finding,
  FindingParticipant,
  GeoPoint,
  Person,
  PersonEvent,
  PersonEventType,
  PersonGender,
  PersonRelation,
  PersonRelationType,
} from "../types";
import { createId } from "./id.ts";
import { nowIso } from "./dateHelpers.ts";
import { parseGedcomArchiveReference } from "./gedcomArchiveReference.ts";
import {
  GEDCOM_ARCHIVE_ACT_RECORD_CUSTOM_FIELD,
  GEDCOM_ARCHIVE_REFERENCE_CUSTOM_FIELD,
  GEDCOM_CITATIONS_CUSTOM_FIELD,
  GEDCOM_EDUCATION_CUSTOM_FIELD,
  GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD,
  GEDCOM_MEDIA_CUSTOM_FIELD,
  GEDCOM_NATIONALITY_CUSTOM_FIELD,
  GEDCOM_RAW_RECORD_CUSTOM_FIELD,
  GEDCOM_RIN_CUSTOM_FIELD,
  GEDCOM_UID_CUSTOM_FIELD,
  GEDCOM_VITAL_STATUS_CUSTOM_FIELD,
  GEDCOM_XREF_CUSTOM_FIELD,
  stringifyGedcomMetadata,
} from "./gedcomMetadata.ts";
import { deriveGedcomImportSourceKey } from "./gedcomImportReconciliation.ts";
import { isGedcomPersonPhotoMedia, personPhotosFromGedcomMedia } from "./personPhotos.ts";

export interface GedcomAppImportBuildOptions {
  defaultResearchId?: string;
  importSourceKey?: string;
  idFactory?: () => string;
  nowFactory?: () => string;
}

export interface GedcomAppImportBuildResult {
  people: Person[];
  documents: DocumentRecord[];
  personRecords: AppEntity[];
  relations: PersonRelation[];
  findings: Finding[];
  warnings: string[];
  rootPersonId?: string;
  personIdByXref: Record<string, string>;
  preservedRecords: NonNullable<GedcomImportDraft["preservedRecords"]>;
  importSourceKey: string;
}

export function buildGedcomAppImport(
  draft: GedcomImportDraft,
  options: GedcomAppImportBuildOptions = {},
): GedcomAppImportBuildResult {
  const idFactory = options.idFactory ?? createId;
  const nowFactory = options.nowFactory ?? nowIso;
  const createdAt = nowFactory();
  const importSourceKey = options.importSourceKey?.trim() || deriveGedcomImportSourceKey(draft);
  const personIdByXref = new Map(draft.people.map((person) => [person.xref, idFactory()]));
  const preservedPersonByXref = new Map((draft.preservedRecords ?? [])
    .filter((record) => record.tag === "INDI" && record.pointer)
    .map((record) => [record.pointer ?? "", record]));
  const people = draft.people.map((person) =>
    personFromGedcomDraft(
      person,
      personIdByXref.get(person.xref) ?? idFactory(),
      createdAt,
      options.defaultResearchId ?? "",
      idFactory,
      preservedPersonByXref.get(person.xref),
      importSourceKey,
    ),
  );
  const peopleByXref = new Map(draft.people.map((person) => [person.xref, person]));
  const documents = documentsFromGedcomSources(
    draft,
    createdAt,
    options.defaultResearchId ?? "",
    idFactory,
    importSourceKey,
  );
  const documentIdBySourceXref = new Map(documents.map((document) => [
    String(document.customFields.__gedcomSourceXref ?? ""),
    document.id,
  ]));
  const relations = uniqueImportedRelations([
    ...draft.parentChildRelationships
      .map((relationship) => parentRelationFromGedcom(relationship, peopleByXref, personIdByXref, createdAt, idFactory))
      .filter((relation): relation is PersonRelation => Boolean(relation)),
    ...draft.partnerRelationships
      .map((relationship) => partnerRelationFromGedcom(relationship, peopleByXref, personIdByXref, createdAt, idFactory))
      .filter((relation): relation is PersonRelation => Boolean(relation)),
  ]);
  const findings = findingsFromGedcomDraft(
    draft,
    personIdByXref,
    people,
    createdAt,
    options.defaultResearchId ?? "",
    idFactory,
    documentIdBySourceXref,
  ).map((finding) => ({
    ...finding,
    customFields: {
      ...finding.customFields,
      [GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]: importSourceKey,
    },
  }));
  const externalMediaCount = draft.people.flatMap((person) => person.media ?? [])
    .filter((media) => isGedcomPersonPhotoMedia(media) && /^https?:\/\//i.test(media.file)).length;
  const missingLocalMediaCount = draft.people.flatMap((person) => person.media ?? [])
    .filter((media) => isGedcomPersonPhotoMedia(media) && !/^https?:\/\//i.test(media.file)).length;

  return {
    people,
    documents,
    personRecords: people as AppEntity[],
    relations,
    findings,
    warnings: [
      ...draft.warnings.map(gedcomImportWarningLabel),
      ...(externalMediaCount
        ? [`Імпортовано ${externalMediaCount} зовнішніх медіафайлів. Їхні початкові URL збережено, але віддалений сервіс може обмежувати строк дії посилань.`]
        : []),
      ...(missingLocalMediaCount
        ? [`Збережено ${missingLocalMediaCount} посилань на локальні фото з GEDCOM. Файли не завантажувалися автоматично: їх потрібно вибрати вручну для копіювання у Google Drive.`]
        : []),
    ],
    rootPersonId: draft.rootPersonXref ? personIdByXref.get(draft.rootPersonXref) : undefined,
    personIdByXref: Object.fromEntries(personIdByXref),
    preservedRecords: draft.preservedRecords ?? [],
    importSourceKey,
  };
}

function uniqueImportedRelations(relations: PersonRelation[]): PersonRelation[] {
  const seen = new Set<string>();
  const result: PersonRelation[] = [];
  for (const relation of relations) {
    const key = [
      relation.personId,
      relation.relatedPersonId,
      relation.relationType,
      relation.evidenceText,
      relation.gedcomMetadata && [
        relation.gedcomMetadata.startDate,
        relation.gedcomMetadata.startPlace,
        relation.gedcomMetadata.endDate,
        relation.gedcomMetadata.endPlace,
        relation.gedcomMetadata.rawNotes,
      ].some(Boolean)
        ? relation.gedcomMetadata.familyXref
        : "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(relation);
  }
  return result;
}

function uniqueImportedFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const custom = finding.customFields ?? {};
    const key = JSON.stringify([
      custom.__gedcomCitation ? "citation" : "event",
      [...(finding.personIds ?? [])].sort(),
      finding.documentId,
      finding.findingType,
      finding.eventDate,
      finding.place,
      finding.archive,
      finding.fund,
      finding.description,
      finding.file,
      finding.page,
      finding.transcription,
      String(custom.__gedcomSourceXref ?? ""),
      String(custom.__gedcomCitation ?? ""),
      String(custom.__gedcomEventTag ?? ""),
      String(custom.__gedcomEventRawType ?? ""),
      String(custom.__gedcomEventValue ?? ""),
      String(custom.__gedcomEventDescription ?? ""),
      (finding.participants ?? []).map((participant) => [participant.role, participant.name, participant.notes]),
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function gedcomImportWarningLabel(warning: GedcomImportDraft["warnings"][number]): string {
  const labels: Record<string, string> = {
    gedcom_invalid_line: "У файлі є рядок GEDCOM, який не вдалося розпізнати.",
    gedcom_family_children_without_parents: "У файлі є родина з дітьми, але без вказаних батьків.",
    gedcom_family_missing_partner: "У файлі є родина з посиланням на партнера, запис якого відсутній.",
    gedcom_family_missing_child: "У файлі є родина з посиланням на дитину, запис якої відсутній.",
    gedcom_family_more_than_two_partners: "У файлі є родина з більш ніж двома партнерами. Перевірте її після імпорту.",
    gedcom_parent_set_more_than_two_parents: "Для однієї дитини в GEDCOM знайдено більше двох батьків. Перевірте зв’язки після імпорту.",
    gedcom_famc_missing_reciprocal_child: "Зв’язок дитини відновлено з FAMC, хоча у записі сім’ї не було зворотного CHIL.",
  };
  return labels[warning.code] ?? warning.message ?? "Попередження GEDCOM, яке потрібно перевірити після імпорту.";
}

function personFromGedcomDraft(
  person: GedcomImportDraft["people"][number],
  id: string,
  timestamp: string,
  defaultResearchId: string,
  idFactory: () => string,
  preservedRecord?: NonNullable<GedcomImportDraft["preservedRecords"]>[number],
  importSourceKey = "",
): Person {
  const name = choosePrimaryName(person.names);
  const marriedName = person.names.find((item) => item.nameType === "married");
  const birthName = birthNameForImportedPerson(person.names, marriedName);
  const birth = person.events.find((event) => event.eventType === "birth");
  const marriage = person.events.find((event) => event.eventType === "marriage");
  const death = person.events.find((event) => event.eventType === "death");
  const birthDate = gedcomDateDetails(birth?.eventDate || birth?.dateText || "");
  const deathDate = gedcomDateDetails(death?.eventDate || death?.dateText || "");
  const isLiving = person.isLiving && !death;
  const events = person.events
    .map((event) => personEventFromGedcom(event, id, idFactory))
    .filter((event): event is PersonEvent => Boolean(event));
  const surnameVariants = person.names
    .map((item) => item.surname)
    .filter((value, index, values) => value && values.indexOf(value) === index && value !== name.surname)
    .join("; ");
  const nameVariants = person.names
    .map((item) => item.fullName || [item.surname, item.givenName, item.patronymic].filter(Boolean).join(" "))
    .filter((value, index, values) => value && values.indexOf(value) === index && value !== displayNameFromName(name))
    .join("; ");
  const photoState = personPhotosFromGedcomMedia(person.media ?? [], timestamp, idFactory);

  return {
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    researchId: defaultResearchId,
    surname: marriedName?.surname || name.surname,
    maidenSurname: birthName?.surname && birthName.surname !== (marriedName?.surname || name.surname) ? birthName.surname : "",
    givenName: name.givenName,
    patronymic: name.patronymic,
    fullName: displayNameFromName({
      ...name,
      surname: marriedName?.surname || name.surname,
    }),
    gender: genderFromGedcom(person.gender),
    nameVariants,
    surnameVariants,
    birthDate: birthDate.normalized,
    birthYearFrom: birthDate.from,
    birthYearTo: birthDate.to,
    birthPlace: birth?.placeName ?? "",
    marriageDate: gedcomDateToAppDate(marriage?.eventDate || marriage?.dateText || ""),
    marriagePlace: marriage?.placeName ?? "",
    deathDate: deathDate.normalized,
    deathYearFrom: deathDate.from,
    deathYearTo: deathDate.to,
    deathPlace: death?.placeName ?? "",
    residencePlaces: residencePlaces(person.events),
    socialStatus: "",
    religion: person.religion ?? "",
    occupation: occupationFromEvents(person.events),
    status: "доведена",
    isLiving,
    privacyStatus: person.privacyStatus,
    notes: personNotes(person),
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    photos: photoState.photos,
    primaryPhotoId: photoState.primaryPhotoId,
    events,
    customFields: {
      [GEDCOM_XREF_CUSTOM_FIELD]: person.xref,
      [GEDCOM_RIN_CUSTOM_FIELD]: person.rin ?? "",
      [GEDCOM_UID_CUSTOM_FIELD]: person.uid ?? "",
      [GEDCOM_VITAL_STATUS_CUSTOM_FIELD]: person.vitalStatus ?? "unknown",
      [GEDCOM_NATIONALITY_CUSTOM_FIELD]: person.nationality ?? "",
      [GEDCOM_EDUCATION_CUSTOM_FIELD]: stringifyGedcomMetadata(person.education ?? []),
      [GEDCOM_CITATIONS_CUSTOM_FIELD]: stringifyGedcomMetadata(person.citations ?? []),
      [GEDCOM_MEDIA_CUSTOM_FIELD]: stringifyGedcomMetadata(person.media ?? []),
      [GEDCOM_RAW_RECORD_CUSTOM_FIELD]: stringifyGedcomMetadata(preservedRecord ?? null),
      [GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]: importSourceKey,
    },
  };
}

function birthNameForImportedPerson(
  names: GedcomImportNameDraft[],
  marriedName: GedcomImportNameDraft | undefined,
): GedcomImportNameDraft | undefined {
  return (
    names.find((item) => item.nameType === "birth" || item.nameType === "original") ??
    (marriedName ? names.find((item) => item !== marriedName && item.nameType !== "married" && item.surname) : undefined)
  );
}

function choosePrimaryName(names: GedcomImportNameDraft[]): GedcomImportNameDraft {
  return (
    names.find((item) => item.nameType === "primary") ??
    names.find((item) => item.nameType === "married") ??
    names.find((item) => item.nameType === "birth") ??
    names[0] ?? {
      nameType: "primary",
      surname: "",
      givenName: "",
      patronymic: "",
      fullName: "",
      originalText: "",
    }
  );
}

function documentsFromGedcomSources(
  draft: GedcomImportDraft,
  timestamp: string,
  defaultResearchId: string,
  idFactory: () => string,
  importSourceKey: string,
): DocumentRecord[] {
  const preservedSourceByXref = new Map((draft.preservedRecords ?? [])
    .filter((record) => record.tag === "SOUR" && record.pointer)
    .map((record) => [record.pointer ?? "", record]));
  return (draft.sources ?? []).map((source) => {
    const combinedText = [source.publication, source.text].filter(Boolean).join("\n\n");
    const url = firstUrl([source.publication, source.text, source.title].join("\n"));
    return {
      id: idFactory(),
      createdAt: timestamp,
      updatedAt: timestamp,
      researchId: defaultResearchId,
      title: source.title || `GEDCOM source ${source.xref}`,
      documentType: source.sourceType || source.mediaType || "GEDCOM source",
      archive: source.author,
      fund: source.rin,
      description: combinedText,
      file: url,
      yearFrom: "",
      yearTo: "",
      place: "",
      url,
      pagesCount: "",
      lastPage: "",
      reviewStatus: "імпортовано",
      notes: source.publication,
      scans: [],
      customFields: {
        __gedcomSourceXref: source.xref,
        __gedcomSource: stringifyGedcomMetadata(source),
        __gedcomRawRecord: stringifyGedcomMetadata(preservedSourceByXref.get(source.xref) ?? null),
        [GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]: importSourceKey,
      },
    };
  });
}

function firstUrl(value: string): string {
  return value.match(/https?:\/\/[^\s<>]+/i)?.[0] ?? "";
}

function findingsFromGedcomDraft(
  draft: GedcomImportDraft,
  personIdByXref: Map<string, string>,
  people: Person[],
  timestamp: string,
  defaultResearchId: string,
  idFactory: () => string,
  documentIdBySourceXref: Map<string, string>,
): Finding[] {
  const appPersonById = new Map(people.map((person) => [person.id, person]));
  const result: Finding[] = [];
  for (const person of draft.people) {
    const personId = personIdByXref.get(person.xref);
    const appPerson = personId ? appPersonById.get(personId) : undefined;
    if (!personId || !appPerson) continue;
    for (const event of person.events) {
      const finding = findingFromGedcomEvent({
        event,
        personIds: [personId],
        peopleNames: [personDisplayName(appPerson)],
        sourceXref: person.xref,
        timestamp,
        defaultResearchId,
        idFactory,
      });
      if (finding) result.push(finding);
      for (const citation of event.citations ?? []) {
        result.push(findingFromGedcomCitation({
          citation,
          event,
          personId,
          personName: personDisplayName(appPerson),
          sources: draft.sources ?? [],
          timestamp,
          defaultResearchId,
          idFactory,
          documentIdBySourceXref,
        }));
      }
    }
    for (const citation of person.citations ?? []) {
      result.push(findingFromGedcomCitation({
        citation,
        personId,
        personName: personDisplayName(appPerson),
        sources: draft.sources ?? [],
        timestamp,
        defaultResearchId,
        idFactory,
        documentIdBySourceXref,
      }));
    }
  }

  for (const family of draft.families) {
    const partnerIds = family.partnerXrefs
      .map((xref) => personIdByXref.get(xref))
      .filter((id): id is string => Boolean(id));
    if (!partnerIds.length) continue;
    const partnerNames = partnerIds
      .map((id) => appPersonById.get(id))
      .filter((person): person is Person => Boolean(person))
      .map(personDisplayName);
    for (const event of family.events) {
      const finding = findingFromGedcomEvent({
        event,
        personIds: partnerIds,
        peopleNames: partnerNames,
        sourceXref: family.xref,
        timestamp,
        defaultResearchId,
        idFactory,
      });
      if (finding) result.push(finding);
    }
  }

  return uniqueImportedFindings(result);
}

function findingFromGedcomCitation(input: {
  citation: NonNullable<GedcomImportDraft["people"][number]["citations"]>[number];
  event?: GedcomImportEventDraft;
  personId: string;
  personName: string;
  sources: NonNullable<GedcomImportDraft["sources"]>;
  timestamp: string;
  defaultResearchId: string;
  idFactory: () => string;
  documentIdBySourceXref: Map<string, string>;
}): Finding {
  const source = input.sources.find((item) => item.xref === input.citation.sourceXref);
  const sourceTitle = source?.title || input.citation.sourceXref || "Джерело GEDCOM";
  const description = input.citation.text || input.citation.notes || input.citation.page || source?.text || sourceTitle;
  const archiveReference = parseGedcomArchiveReference(description);
  const eventDate = gedcomDateToAppDate(input.event?.eventDate || input.citation.dataDate || "");
  const pageOrUrl = input.citation.page.trim();
  const participantRole = humanGedcomCitationRole(input.citation.role);
  const participants: FindingParticipant[] = [{
    id: input.idFactory(),
    role: participantRole || "Основна особа",
    name: input.personName,
    notes: [
      `GEDCOM: ${input.citation.sourceXref}`,
      input.citation.role && !participantRole ? `Зовнішній ідентифікатор ролі: ${input.citation.role}` : "",
    ].filter(Boolean).join("\n"),
  }];
  return {
    id: input.idFactory(),
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    researchId: input.defaultResearchId,
    documentId: input.documentIdBySourceXref.get(input.citation.sourceXref) ?? "",
    findingType: input.event ? findingTypeFromGedcomEvent(input.event) : "джерело",
    eventDate,
    people: input.personName,
    personsText: input.personName,
    personIds: [input.personId],
    participants,
    place: input.event?.placeName ?? "",
    archive: archiveReference?.archive || sourceTitle,
    fund: archiveReference?.fund || source?.author || "",
    description: archiveReference ? archiveReference.inventory : description,
    file: archiveReference?.file || pageOrUrl,
    page: findingPageWithActRecord(archiveReference, pageOrUrl),
    summary: [sourceTitle, input.citation.eventType, input.citation.page].filter(Boolean).join(" · "),
    transcription: archiveReference ? description : input.citation.text,
    conclusion: "",
    reliability: gedcomQualityLabel(input.citation.quality),
    needsReview: Number(input.citation.quality) > 3,
    notes: [
      source?.publication ?? "",
      input.citation.notes,
      participantRole ? `Роль: ${participantRole}` : "",
      archiveReference?.actRecord ? `Актовий запис: ${archiveReference.actRecord}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    scans: [],
    geo: input.event?.geo ?? null,
    customFields: {
      __gedcomSourceXref: input.citation.sourceXref,
      __gedcomCitation: stringifyGedcomMetadata(input.citation),
      __gedcomSource: stringifyGedcomMetadata(source ?? null),
      ...(input.event ? gedcomEventCustomFields(input.event, eventEvidenceText(input.event)) : {}),
      ...gedcomArchiveCustomFields(archiveReference),
    },
  };
}

function humanGedcomCitationRole(value: string): string {
  const role = value.trim();
  if (!role) return "";
  // MyHeritage often writes internal numeric identifiers into EVEN/ROLE.
  if (/^\d+(?::\d+)*:?$/u.test(role)) return "";
  return role;
}

function gedcomQualityLabel(value: string): string {
  const labels: Record<string, string> = {
    "0": "ненадійне",
    "1": "сумнівне",
    "2": "вторинне",
    "3": "первинне",
    "4": "MyHeritage: 4 (поза стандартом GEDCOM 5.5.1)",
  };
  return labels[value.trim()] ?? (value ? `GEDCOM QUAY ${value}` : "імпортовано");
}

function findingFromGedcomEvent(input: {
  event: GedcomImportEventDraft;
  personIds: string[];
  peopleNames: string[];
  sourceXref: string;
  timestamp: string;
  defaultResearchId: string;
  idFactory: () => string;
}): Finding | null {
  const description = eventEvidenceText(input.event);
  if (!description) return null;
  const effectiveEventType = effectiveGedcomEventType(input.event);
  const findingType = findingTypeFromGedcomEvent(input.event);
  const eventDate = gedcomDateToAppDate(input.event.eventDate || input.event.dateText);
  const people = input.peopleNames.filter(Boolean).join("; ");
  const participants: FindingParticipant[] = input.personIds.map((personId, index) => ({
    id: input.idFactory(),
    role: participantRoleFromGedcomEvent(effectiveEventType, index),
    name: input.peopleNames[index] ?? personId,
    notes: `GEDCOM: ${input.sourceXref}`,
  }));
  const place = input.event.placeName.trim();
  const archiveReference = parseGedcomArchiveReference(description);
  return {
    id: input.idFactory(),
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    researchId: input.defaultResearchId,
    documentId: "",
    findingType,
    eventDate,
    people,
    personsText: people,
    personIds: input.personIds,
    participants,
    place,
    archive: archiveReference?.archive ?? "",
    fund: archiveReference?.fund ?? "",
    description: archiveReference ? archiveReference.inventory : description,
    file: archiveReference?.file ?? "",
    page: findingPageWithActRecord(archiveReference),
    summary: [findingType, eventDate, place, people].filter(Boolean).join(" · "),
    transcription: description,
    conclusion: "",
    reliability: "імпортовано",
    needsReview: false,
    notes: [
      "Створено автоматично з опису події GEDCOM/MyHeritage.",
      input.event.title?.trim() ? `Оригінальний тип MyHeritage/GEDCOM: ${input.event.title.trim()}` : "",
      input.event.age?.trim() ? `Вік: ${input.event.age.trim()}` : "",
      input.event.cause?.trim() ? `Причина: ${input.event.cause.trim()}` : "",
      input.event.address?.trim() && input.event.address.trim() !== place ? `Адреса: ${input.event.address.trim()}` : "",
      archiveReference?.actRecord ? `Актовий запис: ${archiveReference.actRecord}` : "",
    ].filter(Boolean).join("\n"),
    scans: [],
    geo: input.event.geo ?? (place ? importedPlaceGeo(place) : null),
    customFields: {
      __gedcomSourceXref: input.sourceXref,
      ...gedcomEventCustomFields(input.event, description),
      ...gedcomArchiveCustomFields(archiveReference),
    },
  };
}

function findingTypeFromGedcomEvent(event: GedcomImportEventDraft): string {
  const eventType = effectiveGedcomEventType(event);
  switch (eventType) {
    case "birth":
      return "народження";
    case "baptism":
    case "christening":
      return "хрещення";
    case "marriage":
      return "шлюб";
    case "death":
      return "смерть";
    case "burial":
    case "cremation":
      return "поховання";
    case "residence":
      return "згадка";
    case "census":
      return "перепис";
    case "revision_list":
      return "ревізія";
    case "confession_list":
      return "сповідний розпис";
    case "household_register":
      return "погосподарська книга";
    case "military":
      return "військовий документ";
    case "occupation":
      return "професія";
    case "education":
      return "освіта";
    case "nationality":
      return "національність";
    case "immigration":
      return "імміграція";
    case "emigration":
      return "еміграція";
    case "divorce":
      return "розлучення";
    case "probate":
      return "спадкова справа";
    default:
      return "згадка";
  }
}

function eventEvidenceText(event: GedcomImportEventDraft): string {
  const value = meaningfulGedcomEventValue(event.value ?? "");
  const notes = event.notes.trim();
  const directEvidence = uniqueNonEmptyText([value, notes]).join("\n");
  if (directEvidence) return directEvidence;

  const eventType = effectiveGedcomEventType(event);
  if (!metadataOnlyFindingEventTypes.has(eventType)) return "";
  const rawType = event.title?.trim() ?? "";
  if (rawType && !genericGedcomEventTitles.has(normalizeGedcomEventClassification(rawType))) return rawType;
  return [rawType, event.placeName.trim(), event.eventDate.trim() || event.dateText.trim()]
    .filter(Boolean)
    .join(" · ");
}

const metadataOnlyFindingEventTypes = new Set<GedcomImportEventDraft["eventType"]>([
  "census",
  "revision_list",
  "confession_list",
  "household_register",
  "military",
  "immigration",
  "emigration",
  "probate",
  "mention",
  "other",
]);

const genericGedcomEventTitles = new Set(["", "event", "подія", "событие", "fact", "факт"]);

function meaningfulGedcomEventValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(?:y|yes|true|n|no|false)$/iu.test(trimmed)) return "";
  return trimmed;
}

function uniqueNonEmptyText(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function effectiveGedcomEventType(event: GedcomImportEventDraft): GedcomImportEventDraft["eventType"] {
  if (event.eventType !== "other" && event.eventType !== "mention") return event.eventType;
  const normalized = normalizeGedcomEventClassification([
    event.title ?? "",
    event.value ?? "",
    event.notes,
  ].filter(Boolean).join(" "));
  if (hasGedcomEventToken(normalized, ["погосподар", "посімейн", "посемейн", "household book", "household register", "family register"])) {
    return "household_register";
  }
  if (hasGedcomEventToken(normalized, ["revision", "ревіз", "ревиз", "ревізійна казка", "ревизская сказка"])) {
    return "revision_list";
  }
  if (hasGedcomEventToken(normalized, ["confession", "сповід", "исповед", "список християнської общини", "список христианской общины"])) {
    return "confession_list";
  }
  if (hasGedcomEventToken(normalized, ["military", "військ", "военн", "рекрут", "солдат"])) return "military";
  if (hasGedcomEventToken(normalized, ["census", "перепис", "перепись", "список виборц", "список избирател", "electoral roll"])) {
    return "census";
  }
  return event.eventType;
}

function normalizeGedcomEventClassification(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("uk").replace(/\s+/g, " ").trim();
}

function hasGedcomEventToken(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function gedcomEventCustomFields(event: GedcomImportEventDraft, description: string): Record<string, string> {
  return {
    __gedcomEventType: effectiveGedcomEventType(event),
    __gedcomEventTag: event.tag?.trim() ?? "",
    __gedcomEventRawType: event.title?.trim() ?? "",
    __gedcomEventValue: event.value?.trim() ?? "",
    __gedcomEventDescription: description,
  };
}

function participantRoleFromGedcomEvent(eventType: GedcomImportEventDraft["eventType"], index: number): string {
  if (eventType === "birth") return "Дитина";
  if (eventType === "death") return "Померла особа";
  if (eventType === "marriage") return index === 0 ? "Наречений" : "Наречена";
  return "Основна особа";
}

function importedPlaceGeo(placeName: string): GeoPoint {
  return {
    displayName: placeName,
    latitude: null,
    longitude: null,
    source: "import",
    precision: "unknown",
    provider: "GEDCOM",
    externalId: null,
    markerColor: null,
  };
}

function gedcomArchiveCustomFields(
  reference: ReturnType<typeof parseGedcomArchiveReference>,
): Record<string, string> {
  if (!reference) return {};
  return {
    [GEDCOM_ARCHIVE_REFERENCE_CUSTOM_FIELD]: stringifyGedcomMetadata(reference),
    [GEDCOM_ARCHIVE_ACT_RECORD_CUSTOM_FIELD]: reference.actRecord,
  };
}

function findingPageWithActRecord(
  reference: ReturnType<typeof parseGedcomArchiveReference>,
  fallbackPage = "",
): string {
  const page = reference?.page.trim() || fallbackPage.trim();
  const actRecord = reference?.actRecord.trim() ?? "";
  const actLabel = actRecord ? `актовий запис №${actRecord}` : "";
  return [page, actLabel].filter(Boolean).join(" · ");
}

function personDisplayName(person: Person): string {
  return person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ").trim() || person.id;
}

function displayNameFromName(name: Pick<GedcomImportNameDraft, "surname" | "givenName" | "patronymic" | "fullName">): string {
  return [name.surname, name.givenName, name.patronymic].filter(Boolean).join(" ").trim() || name.fullName.trim();
}

function genderFromGedcom(gender: GedcomImportGender): PersonGender {
  if (gender === "male") return "чоловік";
  if (gender === "female") return "жінка";
  return "невідомо";
}

function personEventFromGedcom(
  event: GedcomImportEventDraft,
  personId: string,
  idFactory: () => string,
): PersonEvent | null {
  const type = personEventTypeFromGedcom(event.eventType);
  if (!type) return null;
  return {
    id: idFactory(),
    personId,
    type,
    title: event.title || (type === "other" ? event.eventType : undefined),
    date: gedcomDateForEvent(event.eventDate || event.dateText),
    placeName: event.placeName || null,
    value: meaningfulGedcomEventValue(event.value ?? "") || null,
    age: event.age?.trim() || null,
    cause: event.cause?.trim() || null,
    address: event.address?.trim() || null,
    geo: event.geo,
    notes: gedcomEventNotes(event) || null,
  };
}

function personEventTypeFromGedcom(eventType: GedcomImportEventDraft["eventType"]): PersonEventType | null {
  return eventType;
}

function parentRelationFromGedcom(
  relationship: GedcomImportParentChildDraft,
  peopleByXref: Map<string, GedcomImportDraft["people"][number]>,
  personIdByXref: Map<string, string>,
  timestamp: string,
  idFactory: () => string,
): PersonRelation | null {
  const childId = personIdByXref.get(relationship.childXref);
  const parentId = personIdByXref.get(relationship.parentXref);
  if (!childId || !parentId) return null;
  const parent = peopleByXref.get(relationship.parentXref);
  return {
    id: idFactory(),
    createdAt: timestamp,
    updatedAt: timestamp,
    personId: childId,
    relatedPersonId: parentId,
    relationType: parentRelationType(relationship, parent?.gender ?? "unknown"),
    status: "доведено",
    evidenceText: parentEvidenceText(relationship),
    notes: `Імпортовано з GEDCOM. Сім’я: ${relationship.familyXref}.`,
    gedcomMetadata: {
      familyXref: relationship.familyXref,
      pedigree: relationship.pedigree,
      rawNotes: relationship.notes,
    },
  };
}

function partnerRelationFromGedcom(
  relationship: GedcomImportPartnerDraft,
  peopleByXref: Map<string, GedcomImportDraft["people"][number]>,
  personIdByXref: Map<string, string>,
  timestamp: string,
  idFactory: () => string,
): PersonRelation | null {
  const firstId = personIdByXref.get(relationship.personAXref);
  const secondId = personIdByXref.get(relationship.personBXref);
  if (!firstId || !secondId) return null;
  const second = peopleByXref.get(relationship.personBXref);
  return {
    id: idFactory(),
    createdAt: timestamp,
    updatedAt: timestamp,
    personId: firstId,
    relatedPersonId: secondId,
    relationType: spouseRelationType(second?.gender ?? "unknown"),
    status: "доведено",
    evidenceText: relationship.eventDate
      ? `Імпортовано з GEDCOM. Дата події: ${relationship.eventDate}.`
      : "Імпортовано з GEDCOM.",
    notes: relationship.placeName
      ? `Сім’я: ${relationship.familyXref}. Місце події: ${relationship.placeName}.`
      : `Сім’я: ${relationship.familyXref}.`,
    gedcomMetadata: {
      familyXref: relationship.familyXref,
      startDate: relationship.eventDate,
      startPlace: relationship.placeName,
      endDate: relationship.endDate,
      endPlace: relationship.endPlaceName,
      eventType: relationship.relationshipType,
      rawNotes: relationship.notes,
    },
  };
}

function parentRelationType(
  relationship: GedcomImportParentChildDraft,
  parentGender: GedcomImportGender,
): PersonRelationType {
  if (relationship.relationshipType === "adoptive") return "усиновлювач";
  if (relationship.relationshipType === "step") return parentGender === "female" ? "мачуха" : "вітчим";
  if (relationship.parentRoleLabel === "father" || parentGender === "male") return "батько";
  if (relationship.parentRoleLabel === "mother" || parentGender === "female") return "мати";
  return "батько або мати";
}

function spouseRelationType(gender: GedcomImportGender): PersonRelationType {
  if (gender === "male") return "чоловік";
  if (gender === "female") return "дружина";
  return "подружжя";
}

function parentEvidenceText(relationship: GedcomImportParentChildDraft): string {
  const typeLabels: Partial<Record<GedcomImportParentChildDraft["relationshipType"], string>> = {
    biological: "біологічний зв’язок",
    genetic_father: "генетичний батько",
    genetic_mother: "генетична мати",
    gestational_parent: "гестаційний батько/мати",
    birth_parent: "батько/мати від народження",
    adoptive: "прийомний/усиновлений зв’язок",
    foster: "виховання",
    step: "нерідний батько/мати",
    guardian: "опікунство",
    social_parent: "соціальний батько/мати",
    legal_parent: "юридичний батько/мати",
    donor: "донор",
    surrogate: "сурогатний батько/мати",
    presumed: "ймовірний зв’язок",
    unknown: "невідомий тип зв’язку",
    other: "інший тип зв’язку",
  };
  return `Імпортовано з GEDCOM: ${typeLabels[relationship.relationshipType] ?? "інший тип зв’язку"}.`;
}

function residencePlaces(events: GedcomImportEventDraft[]): string {
  return events
    .filter((event) => event.eventType === "residence" && event.placeName)
    .map((event) => event.placeName)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("; ");
}

function personNotes(person: GedcomImportDraft["people"][number]): string {
  return [
    `Імпортовано з GEDCOM. Початковий ідентифікатор: ${person.xref}.`,
    person.notes?.trim() ?? "",
    person.nationality ? `Національність: ${person.nationality}` : "",
    person.vitalStatus === "unknown" ? "Статус життя/смерті в GEDCOM: невідомий." : "",
    ...(person.education ?? []).map((value) => `Освіта: ${value}`),
  ].filter(Boolean).join("\n\n");
}

function gedcomEventNotes(event: GedcomImportEventDraft): string {
  const citationSummary = (event.citations ?? [])
    .map((citation) => [citation.sourceXref, citation.page].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ");
  return [
    event.notes,
    citationSummary ? `Джерела: ${citationSummary}` : "",
  ].filter(Boolean).join("\n");
}

function occupationFromEvents(events: GedcomImportEventDraft[]): string {
  return events
    .filter((event) => event.eventType === "occupation")
    .map((event) => event.value || event.notes)
    .filter(Boolean)
    .join("; ");
}

function gedcomDateToAppDate(value: string): string {
  const details = gedcomDateDetails(value);
  return details.normalized || details.from || value.trim();
}

function gedcomDateForEvent(value: string): string {
  const details = gedcomDateDetails(value);
  return details.exact ? details.normalized : value.trim();
}

function gedcomDateDetails(value: string): { normalized: string; from: string; to: string; exact: boolean } {
  const raw = value.trim();
  const normalized = raw.toLocaleUpperCase("uk").replace(/\s+/g, " ");
  if (!normalized) return { normalized: "", from: "", to: "", exact: false };
  if (/^\d{4}$/.test(normalized) || /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return { normalized, from: "", to: "", exact: true };
  }
  const dayMonthYear = normalized.match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4})$/u);
  if (dayMonthYear) {
    const month = GEDCOM_MONTHS[dayMonthYear[2]];
    if (month) {
      return {
        normalized: `${dayMonthYear[3]}-${month}-${dayMonthYear[1].padStart(2, "0")}`,
        from: "",
        to: "",
        exact: true,
      };
    }
  }
  const monthYear = normalized.match(/^([^\s]+)\s+(\d{4})$/u);
  if (monthYear && GEDCOM_MONTHS[monthYear[1]]) {
    return { normalized: `${monthYear[2]}-${GEDCOM_MONTHS[monthYear[1]]}`, from: "", to: "", exact: true };
  }
  const range = normalized.match(/^(?:BET|FROM)\s+(\d{4})(?:\s+(?:AND|TO|І|И)\s+(\d{4}))?/u);
  if (range) return { normalized: "", from: range[1], to: range[2] ?? "", exact: false };
  const qualified = normalized.match(/^(ABT|EST|CAL|BEF|AFT)\s+.*?\b(\d{4})\b/u);
  if (qualified) {
    return {
      normalized: "",
      from: qualified[1] === "BEF" ? "" : qualified[2],
      to: qualified[1] === "AFT" ? "" : qualified[2],
      exact: false,
    };
  }
  const years = [...normalized.matchAll(/\b(\d{4})\b/g)].map((match) => match[1]);
  return { normalized: "", from: years[0] ?? "", to: years[1] ?? "", exact: false };
}

const GEDCOM_MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
  СІЧ: "01",
  ЯНВ: "01",
  ЛЮТ: "02",
  ФЕВ: "02",
  БЕР: "03",
  МАР: "03",
  КВІ: "04",
  АПР: "04",
  ТРА: "05",
  МАЙ: "05",
  ЧЕР: "06",
  ИЮН: "06",
  ЛИП: "07",
  ИЮЛ: "07",
  СЕР: "08",
  АВГ: "08",
  ВЕР: "09",
  СЕН: "09",
  ЖОВ: "10",
  ОКТ: "10",
  ЛИС: "11",
  НОЯ: "11",
  ГРУ: "12",
  ДЕК: "12",
};
