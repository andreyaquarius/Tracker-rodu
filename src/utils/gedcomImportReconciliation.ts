import type {
  AppEntity,
  DocumentRecord,
  Finding,
  Person,
  PersonRelation,
} from "../types";
import type { GedcomImportDraft } from "../types/familyTree";
import {
  GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD,
  GEDCOM_RAW_RECORD_CUSTOM_FIELD,
  GEDCOM_RIN_CUSTOM_FIELD,
  GEDCOM_UID_CUSTOM_FIELD,
  GEDCOM_XREF_CUSTOM_FIELD,
  parseGedcomMetadata,
} from "./gedcomMetadata.ts";
import { extractFindingSourceUrl, stripFindingSourceUrls } from "./findingSourceUrl.ts";

export interface GedcomImportReconciliationPayload {
  people: Person[];
  personRecords: AppEntity[];
  documents: DocumentRecord[];
  relations: PersonRelation[];
  findings: Finding[];
  rootPersonId: string;
  personIdByXref: Record<string, string>;
  importSourceKey: string;
}

export interface GedcomImportReconciliationExisting {
  people: readonly Person[];
  documents: readonly DocumentRecord[];
  relations: readonly PersonRelation[];
  findings: readonly Finding[];
}

export interface GedcomImportReconciliationResult extends GedcomImportReconciliationPayload {
  personIdRemap: Record<string, string>;
  documentIdRemap: Record<string, string>;
  findingIdRemap: Record<string, string>;
  /** Durable rollback journal kept open until the family tree is committed. */
  importOperationId?: string;
}

export interface GedcomImportExecutionProgress {
  step: string;
  percent: number;
  detail: string;
}

export interface GedcomImportExecutionOptions {
  onProgress?: (progress: GedcomImportExecutionProgress) => void;
}

/** Uses a vendor tree identifier when available; otherwise fingerprints the exact GEDCOM content. */
export function deriveGedcomImportSourceKey(draft: GedcomImportDraft): string {
  const head = (draft.preservedRecords ?? []).find((record) => record.tag.toUpperCase() === "HEAD");
  const projectGuid = head?.lines.find((line) => line.tag.toUpperCase() === "_PROJECT_GUID")?.value.trim();
  if (projectGuid) return `myheritage-project:${normalizeKeyPart(projectGuid)}`;
  const siteId = head?.lines.find((line) => line.tag.toUpperCase() === "_EXPORTED_FROM_SITE_ID")?.value.trim();
  if (siteId) return `myheritage-site:${normalizeKeyPart(siteId)}`;
  const canonical = (draft.preservedRecords ?? []).flatMap((record) =>
    record.lines.map((line) => [line.level, line.pointer ?? "", line.tag, line.value].join("\u001f")),
  ).join("\u001e");
  return `gedcom-content:${hash128(canonical)}`;
}

/**
 * Reuses committed IDs and rewrites every dependent reference before retry
 * persistence. A matched Tracker record remains canonical: GEDCOM retries do
 * not overwrite it implicitly. Besides protecting user edits, this means a
 * failed import only has to roll back records created by that operation.
 */
export function reconcileGedcomImportForRetry(
  incoming: GedcomImportReconciliationPayload,
  existing: GedcomImportReconciliationExisting,
): GedcomImportReconciliationResult {
  const claimedPeople = new Set<string>();
  const existingPeopleByKey = uniqueIdentityIndex(existing.people, (person) =>
    personIdentityKeys(person, !entitySourceKey(person.customFields)),
  );
  const personIdRemap = new Map<string, string>();
  const people = incoming.people.map((person) => {
    const match = firstUnclaimedMatch(personIdentityKeys(person), existingPeopleByKey, claimedPeople);
    const id = match?.id ?? person.id;
    personIdRemap.set(person.id, id);
    if (!match) return person;
    claimedPeople.add(match.id);
    return match;
  });

  const claimedDocuments = new Set<string>();
  const existingDocumentsByKey = uniqueIdentityIndex(existing.documents, (document) =>
    documentIdentityKeys(document, !entitySourceKey(document.customFields)),
  );
  const documentIdRemap = new Map<string, string>();
  const documents = incoming.documents.map((document) => {
    const match = firstUnclaimedMatch(documentIdentityKeys(document), existingDocumentsByKey, claimedDocuments);
    const id = match?.id ?? document.id;
    documentIdRemap.set(document.id, id);
    if (!match) return document;
    claimedDocuments.add(match.id);
    return match;
  });

  const remappedRelations = incoming.relations.map((relation) => ({
    ...relation,
    personId: personIdRemap.get(relation.personId) ?? relation.personId,
    relatedPersonId: personIdRemap.get(relation.relatedPersonId) ?? relation.relatedPersonId,
  }));
  const relationBuckets = bucketBy(existing.relations, relationIdentityKey);
  const relations = remappedRelations.map((relation) => {
    const match = shiftBucket(relationBuckets, relationIdentityKey(relation));
    return match ?? relation;
  });

  const remappedFindings = incoming.findings.map((finding) => remapFinding(
    finding,
    personIdRemap,
    documentIdRemap,
  ));
  const findingBuckets = bucketByMany(existing.findings, (finding) =>
    findingIdentityKeys(finding, !findingSourceKey(finding))
  );
  const claimedFindings = new Set<string>();
  const findingIdRemap = new Map<string, string>();
  const findings = remappedFindings.map((finding) => {
    const match = shiftFirstBucket(findingBuckets, findingIdentityKeys(finding), claimedFindings);
    const id = match?.id ?? finding.id;
    findingIdRemap.set(finding.id, id);
    if (match) claimedFindings.add(match.id);
    return match ?? finding;
  });

  return {
    ...incoming,
    people,
    personRecords: people as AppEntity[],
    documents,
    relations,
    findings,
    rootPersonId: personIdRemap.get(incoming.rootPersonId) ?? incoming.rootPersonId,
    personIdByXref: Object.fromEntries(Object.entries(incoming.personIdByXref).map(([xref, id]) => [
      xref,
      personIdRemap.get(id) ?? id,
    ])),
    personIdRemap: Object.fromEntries(personIdRemap),
    documentIdRemap: Object.fromEntries(documentIdRemap),
    findingIdRemap: Object.fromEntries(findingIdRemap),
  };
}

function remapFinding(
  finding: Finding,
  personIds: ReadonlyMap<string, string>,
  documentIds: ReadonlyMap<string, string>,
): Finding {
  const documentId = documentIds.get(finding.documentId) ?? finding.documentId;
  return {
    ...finding,
    documentId,
    personIds: finding.personIds.map((id) => personIds.get(id) ?? id),
    fragmentSelection: finding.fragmentSelection
      ? {
          ...finding.fragmentSelection,
          documentId: documentIds.get(finding.fragmentSelection.documentId)
            ?? finding.fragmentSelection.documentId,
        }
      : undefined,
  };
}

function personIdentityKeys(person: Person, includeLegacy = true): string[] {
  const custom = person.customFields ?? {};
  const source = stringValue(custom[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]);
  const xref = stringValue(custom[GEDCOM_XREF_CUSTOM_FIELD]);
  const uid = stringValue(custom[GEDCOM_UID_CUSTOM_FIELD]);
  const rin = stringValue(custom[GEDCOM_RIN_CUSTOM_FIELD]);
  const raw = stringValue(custom[GEDCOM_RAW_RECORD_CUSTOM_FIELD]);
  return compact([
    source && xref ? `source-xref:${source}|${xref}` : "",
    uid ? `uid:${uid}` : "",
    source && rin ? `source-rin:${source}|${rin}` : "",
    includeLegacy && xref && raw ? `legacy-raw:${xref}|${hash128(raw)}` : "",
  ]);
}

function documentIdentityKeys(document: DocumentRecord, includeLegacy = true): string[] {
  const custom = document.customFields ?? {};
  const sourceKey = stringValue(custom[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]);
  const xref = stringValue(custom.__gedcomSourceXref);
  const raw = stringValue(custom.__gedcomRawRecord);
  const source = parseGedcomMetadata<Record<string, unknown>>(custom.__gedcomSource, {});
  const rin = stringValue(source.rin) || stringValue(document.fund);
  return compact([
    sourceKey && xref ? `source-xref:${sourceKey}|${xref}` : "",
    sourceKey && rin ? `source-rin:${sourceKey}|${rin}` : "",
    includeLegacy && xref && rin && raw ? `legacy-source:${xref}|${rin}|${hash128(raw)}` : "",
  ]);
}

function relationIdentityKey(relation: PersonRelation): string {
  return JSON.stringify([
    relation.personId,
    relation.relatedPersonId,
    relation.relationType,
    relation.status,
    relation.evidenceText,
    relation.notes,
  ]);
}

function findingIdentityKeys(finding: Finding, includeLegacy = true): string[] {
  const custom = finding.customFields ?? {};
  const sourceKey = findingSourceKey(finding);
  const citation = stringValue(custom.__gedcomCitation);
  const source = stringValue(custom.__gedcomSource);
  const sourceXref = stringValue(custom.__gedcomSourceXref);
  const event = gedcomEventIdentity(custom);
  const sourceUrl = extractFindingSourceUrl(
    finding.sourceUrl,
    citation,
    source,
    finding.file,
    finding.page,
    finding.summary,
    finding.description,
    finding.transcription,
    finding.notes,
    finding.archive,
    finding.fund,
  );
  const people = [...finding.personIds].sort();
  let body: string;

  if (citation) {
    body = JSON.stringify([
      "gedcom-citation",
      people,
      sourceXref,
      gedcomCitationIdentity(citation),
      event,
    ]);
  } else if (custom.__gedcomStandaloneSource || (source && !people.length && !event)) {
    body = JSON.stringify([
      "gedcom-source",
      sourceXref,
      gedcomSourceIdentity(source),
    ]);
  } else if (event) {
    body = JSON.stringify([
      "gedcom-event",
      people,
      sourceXref,
      event,
      finding.eventDate,
      finding.place,
    ]);
  } else {
    body = JSON.stringify([
      "tracker-finding",
      people,
      finding.documentId,
      finding.findingType,
      finding.eventDate,
      finding.place,
      finding.page,
      finding.description,
      sourceUrl,
    ]);
  }

  return compact([
    sourceKey ? `source:${sourceKey}|${body}` : "",
    includeLegacy ? `legacy:${body}` : "",
  ]);
}

function findingSourceKey(finding: Finding): string {
  return entitySourceKey(finding.customFields ?? {});
}

function gedcomCitationIdentity(serialized: string): unknown[] {
  const citation = parseGedcomMetadata<Record<string, unknown>>(serialized, {});
  return [
    stringValue(citation.sourceXref),
    stripFindingSourceUrls(stringValue(citation.page)),
    stringValue(citation.eventType),
    stringValue(citation.role),
    stringValue(citation.quality),
    stringValue(citation.dataDate),
    stripFindingSourceUrls(stringValue(citation.text)),
    stripFindingSourceUrls(stringValue(citation.notes)),
    extractFindingSourceUrl(serialized),
  ];
}

function gedcomSourceIdentity(serialized: string): unknown[] {
  const source = parseGedcomMetadata<Record<string, unknown>>(serialized, {});
  return [
    stringValue(source.xref),
    stripFindingSourceUrls(stringValue(source.title)),
    stripFindingSourceUrls(stringValue(source.author)),
    stripFindingSourceUrls(stringValue(source.publication)),
    stripFindingSourceUrls(stringValue(source.text)),
    stringValue(source.sourceType),
    stringValue(source.mediaType),
    stringValue(source.rin),
    extractFindingSourceUrl(serialized),
  ];
}

function gedcomEventIdentity(custom: Record<string, unknown>): unknown[] | null {
  const rawDescription = stringValue(custom.__gedcomEventDescription);
  const identity = [
    stringValue(custom.__gedcomEventTag),
    stringValue(custom.__gedcomEventType),
    stringValue(custom.__gedcomEventRawType),
    stringValue(custom.__gedcomEventValue),
    stripFindingSourceUrls(rawDescription),
    extractFindingSourceUrl(rawDescription),
  ];
  return identity.some(Boolean) ? identity : null;
}

function uniqueIdentityIndex<T>(
  items: readonly T[],
  keysFor: (item: T) => string[],
): Map<string, T | null> {
  const index = new Map<string, T | null>();
  for (const item of items) {
    for (const key of keysFor(item)) {
      index.set(key, index.has(key) ? null : item);
    }
  }
  return index;
}

function firstUnclaimedMatch<T extends { id: string }>(
  keys: string[],
  index: ReadonlyMap<string, T | null>,
  claimed: ReadonlySet<string>,
): T | undefined {
  for (const key of keys) {
    const candidate = index.get(key);
    if (candidate && !claimed.has(candidate.id)) return candidate;
  }
  return undefined;
}

function bucketBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) buckets.set(keyFor(item), [...(buckets.get(keyFor(item)) ?? []), item]);
  return buckets;
}

function bucketByMany<T>(items: readonly T[], keysFor: (item: T) => string[]): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    for (const key of keysFor(item)) {
      buckets.set(key, [...(buckets.get(key) ?? []), item]);
    }
  }
  return buckets;
}

function shiftFirstBucket<T extends { id: string }>(
  buckets: Map<string, T[]>,
  keys: readonly string[],
  claimed: ReadonlySet<string>,
): T | undefined {
  for (const key of keys) {
    const bucket = buckets.get(key);
    while (bucket?.length && claimed.has(bucket[0].id)) bucket.shift();
    const candidate = bucket?.shift();
    if (candidate) return candidate;
  }
  return undefined;
}

function shiftBucket<T>(buckets: Map<string, T[]>, key: string): T | undefined {
  return buckets.get(key)?.shift();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function entitySourceKey(customFields: Record<string, unknown> | undefined): string {
  return stringValue(customFields?.[GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD]);
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function compact(values: string[]): string[] {
  return values.filter(Boolean);
}

function hash128(value: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}
