import type {
  CustomFieldValues,
  Person,
  PersonRelation,
  ScanAttachment,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import {
  PERSON_EVENTS_META_KEY,
  normalizePersonEvents,
  stripInternalGeoFields,
  syncPersonEventsFromFields,
} from "../utils/geo";
import { normalizePersonStatus } from "../utils/personStatus.ts";
import { normalizePersonGender } from "../utils/personGender.ts";
import { normalizePersonRelation } from "../utils/personRelation.ts";
import { saveOptionalProjectCache } from "../utils/projectCache.ts";
import { selectRowsInParallel } from "../utils/pagedRows.ts";
import { chunkImportRows } from "../utils/importBatches.ts";
import {
  PERSON_SCANS_METADATA_KEY,
  personPhotoMetadataForStorage,
  personPhotoStateFromMetadata,
} from "../utils/personPhotos.ts";

type PersonRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  status: string;
  gender: string;
  surname: string;
  given_name: string;
  patronymic: string;
  full_name: string;
  name_variants: string;
  surname_variants: string;
  birth_date: string;
  birth_year_from: string;
  birth_year_to: string;
  birth_place: string;
  marriage_date: string;
  marriage_place: string;
  death_date: string;
  death_year_from: string;
  death_year_to: string;
  death_place: string;
  residence_places: string;
  social_status: string;
  religion: string;
  occupation: string;
  is_living: boolean;
  privacy_status: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type RelationRow = {
  id: string;
  project_id: string;
  person_id: string;
  related_person_id: string;
  relation_type: string;
  status: string;
  evidence_text: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

type PersonScanGroups = {
  birthScans: ScanAttachment[];
  marriageScans: ScanAttachment[];
  deathScans: ScanAttachment[];
  mentionScans: ScanAttachment[];
  photos: ScanAttachment[];
};

const PERSON_SELECT =
  "id, project_id, research_id, status, gender, surname, given_name, patronymic, full_name, name_variants, surname_variants, birth_date, birth_year_from, birth_year_to, birth_place, marriage_date, marriage_place, death_date, death_year_from, death_year_to, death_place, residence_places, social_status, religion, occupation, is_living, privacy_status, notes, custom_fields, created_at, updated_at";
const RELATION_SELECT =
  "id, project_id, person_id, related_person_id, relation_type, status, evidence_text, notes, created_at, updated_at";
const SCANS_KEY = PERSON_SCANS_METADATA_KEY;
const MAIDEN_SURNAME_KEY = "__trackerRoduMaidenSurname";
const SELECT_BATCH_SIZE = 1000;
// Persons and relations are fetched together. One range at a time per table
// keeps the aggregate at two database statements instead of six competing
// offset scans, while still allowing both independent tables to load together.
const SELECT_CONCURRENCY_PER_TABLE = 1;
const PEOPLE_CACHE_MAX_CHARS = 3_500_000;
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asScans(value: unknown): ScanAttachment[] {
  return Array.isArray(value) ? (value as ScanAttachment[]) : [];
}

function splitCustomFields(value: unknown): {
  customFields: CustomFieldValues;
  scans: PersonScanGroups;
  eventsRaw: unknown;
  maidenSurname: string;
  primaryPhotoId: string;
} {
  const record = asRecord(value);
  const scanRecord = asRecord(record[SCANS_KEY]);
  const photoState = personPhotoStateFromMetadata(scanRecord);
  const eventsRaw = record[PERSON_EVENTS_META_KEY];
  const maidenSurname = typeof record[MAIDEN_SURNAME_KEY] === "string" ? record[MAIDEN_SURNAME_KEY] : "";
  const customFields = { ...record };
  delete customFields[SCANS_KEY];
  delete customFields[PERSON_EVENTS_META_KEY];
  delete customFields[MAIDEN_SURNAME_KEY];
  return {
    customFields: stripInternalGeoFields(customFields as CustomFieldValues),
    scans: {
      birthScans: asScans(scanRecord.birthScans),
      marriageScans: asScans(scanRecord.marriageScans),
      deathScans: asScans(scanRecord.deathScans),
      mentionScans: asScans(scanRecord.mentionScans),
      photos: photoState.photos,
    },
    eventsRaw,
    maidenSurname,
    primaryPhotoId: photoState.primaryPhotoId,
  };
}

function personFromRow(row: PersonRow): Person {
  const { customFields, scans, eventsRaw, maidenSurname, primaryPhotoId } = splitCustomFields(row.custom_fields);
  const person = {
    id: row.id,
    researchId: row.research_id ?? "",
    status: normalizePersonStatus(row.status),
    gender: normalizePersonGender(row.gender),
    surname: row.surname,
    maidenSurname,
    givenName: row.given_name,
    patronymic: row.patronymic,
    fullName: row.full_name,
    nameVariants: row.name_variants,
    surnameVariants: row.surname_variants,
    birthDate: row.birth_date,
    birthYearFrom: row.birth_year_from,
    birthYearTo: row.birth_year_to,
    birthPlace: row.birth_place,
    marriageDate: row.marriage_date,
    marriagePlace: row.marriage_place,
    deathDate: row.death_date,
    deathYearFrom: row.death_year_from,
    deathYearTo: row.death_year_to,
    deathPlace: row.death_place,
    residencePlaces: row.residence_places,
    socialStatus: row.social_status,
    religion: row.religion,
    occupation: row.occupation,
    isLiving: row.is_living ?? false,
    privacyStatus: normalizePersonPrivacyStatus(row.privacy_status),
    notes: row.notes,
    ...scans,
    primaryPhotoId: scans.photos.some((photo) => photo.id === primaryPhotoId)
      ? primaryPhotoId
      : scans.photos[0]?.id ?? "",
    customFields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return {
    ...person,
    events: normalizePersonEvents(eventsRaw, person),
  };
}

function personToRow(projectId: string, person: Person, researchIds: Set<string>) {
  const composedFullName = [person.surname, person.givenName, person.patronymic]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return {
    id: person.id,
    project_id: projectId,
    research_id: researchIds.has(person.researchId) ? person.researchId : null,
    status: normalizePersonStatus(person.status),
    gender: normalizePersonGender(person.gender),
    surname: person.surname,
    given_name: person.givenName,
    patronymic: person.patronymic,
    full_name: composedFullName || person.fullName.trim(),
    name_variants: person.nameVariants,
    surname_variants: person.surnameVariants,
    birth_date: person.birthDate,
    birth_year_from: person.birthYearFrom,
    birth_year_to: person.birthYearTo,
    birth_place: person.birthPlace,
    marriage_date: person.marriageDate,
    marriage_place: person.marriagePlace,
    death_date: person.deathDate,
    death_year_from: person.deathYearFrom,
    death_year_to: person.deathYearTo,
    death_place: person.deathPlace,
    residence_places: person.residencePlaces,
    social_status: person.socialStatus,
    religion: person.religion,
    occupation: person.occupation,
    is_living: person.isLiving ?? false,
    privacy_status: normalizePersonPrivacyStatus(person.privacyStatus),
    notes: person.notes,
    custom_fields: {
      ...stripInternalGeoFields(person.customFields ?? {}),
      [MAIDEN_SURNAME_KEY]: person.maidenSurname?.trim() ?? "",
      [SCANS_KEY]: {
        birthScans: person.birthScans ?? [],
        marriageScans: person.marriageScans ?? [],
        deathScans: person.deathScans ?? [],
        mentionScans: person.mentionScans ?? [],
        ...personPhotoMetadataForStorage(person),
      },
      [PERSON_EVENTS_META_KEY]: syncPersonEventsFromFields(person),
    },
    created_at: person.createdAt,
    updated_at: person.updatedAt,
  };
}

function normalizePersonPrivacyStatus(value: unknown): Person["privacyStatus"] {
  return value === "project" || value === "public" || value === "confidential" ? value : "private";
}

function relationFromRow(row: RelationRow): PersonRelation {
  return normalizePersonRelation({
    id: row.id,
    personId: row.person_id,
    relatedPersonId: row.related_person_id,
    relationType: row.relation_type as PersonRelation["relationType"],
    status: row.status as PersonRelation["status"],
    evidenceText: row.evidence_text,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function relationToRow(projectId: string, relation: PersonRelation) {
  const normalized = normalizePersonRelation(relation);
  return {
    id: normalized.id,
    project_id: projectId,
    person_id: normalized.personId,
    related_person_id: normalized.relatedPersonId,
    relation_type: normalized.relationType,
    status: normalized.status,
    evidence_text: normalized.evidenceText,
    notes: normalized.notes,
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt,
  };
}

export async function listProjectPeople(projectId: string): Promise<{
  persons: Person[];
  relations: PersonRelation[];
}> {
  const client = getSupabaseClient();
  const [personRows, relationRows] = await Promise.all([
    selectRowsInParallel<PersonRow>(
      () => client
        .from("persons")
        .select(PERSON_SELECT)
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true }),
      SELECT_BATCH_SIZE,
      SELECT_CONCURRENCY_PER_TABLE,
    ),
    selectRowsInParallel<RelationRow>(
      () => client
        .from("person_relations")
        .select(RELATION_SELECT)
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true }),
      SELECT_BATCH_SIZE,
      SELECT_CONCURRENCY_PER_TABLE,
    ),
  ]);
  return {
    persons: personRows.map(personFromRow),
    relations: relationRows.map(relationFromRow),
  };
}

export async function importProjectPeople(
  projectId: string,
  persons: Person[],
  relations: PersonRelation[],
  researchIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  const personRows = persons.map((person) => personToRow(projectId, person, researchIds));
  for (const batch of chunkImportRows(personRows)) {
    const { error } = await client
      .from("persons")
      .upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }
  const relationRows = relations.map((relation) => relationToRow(projectId, relation));
  for (const batch of chunkImportRows(relationRows)) {
    const { error } = await client
      .from("person_relations")
      .upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }
}

export async function saveProjectPerson(
  projectId: string,
  person: Person,
  researchIds: Set<string>,
): Promise<Person> {
  const { data, error } = await getSupabaseClient()
    .from("persons")
    .upsert(personToRow(projectId, person, researchIds), { onConflict: "id" })
    .select(PERSON_SELECT)
    .single();
  if (error) throw error;
  return personFromRow(data as PersonRow);
}

export async function deleteProjectPerson(projectId: string, personId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("persons")
    .delete()
    .eq("project_id", projectId)
    .eq("id", personId);
  if (error) throw error;
}

export async function saveProjectPersonRelation(
  projectId: string,
  relation: PersonRelation,
): Promise<PersonRelation> {
  const { data, error } = await getSupabaseClient()
    .from("person_relations")
    .upsert(relationToRow(projectId, relation), { onConflict: "id" })
    .select(RELATION_SELECT)
    .single();
  if (error) throw error;
  return relationFromRow(data as RelationRow);
}

export async function deleteProjectPersonRelation(
  projectId: string,
  relationId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("person_relations")
    .delete()
    .eq("project_id", projectId)
    .eq("id", relationId);
  if (error) throw error;
}

const CACHE_PREFIX = "tracker-rodu-project-people:";

export function loadProjectPeopleCache(projectId: string): {
  persons: Person[];
  relations: PersonRelation[];
} {
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${projectId}`);
    if (!stored) return { persons: [], relations: [] };
    const parsed = JSON.parse(stored) as { persons?: unknown; relations?: unknown };
    return {
      persons: Array.isArray(parsed.persons)
        ? (parsed.persons as Person[]).map((person) => ({
            ...person,
            status: normalizePersonStatus(person.status),
            gender: normalizePersonGender(person.gender),
          }))
        : [],
      relations: Array.isArray(parsed.relations)
        ? (parsed.relations as PersonRelation[]).map(normalizePersonRelation)
        : [],
    };
  } catch {
    return { persons: [], relations: [] };
  }
}

export function saveProjectPeopleCache(
  projectId: string,
  persons: Person[],
  relations: PersonRelation[],
): void {
  const key = `${CACHE_PREFIX}${projectId}`;
  const normalizedPersons = persons.map((person) => ({
    ...person,
    status: normalizePersonStatus(person.status),
    gender: normalizePersonGender(person.gender),
  }));
  const normalizedRelations = relations.map(normalizePersonRelation);
  saveOptionalProjectCache(
    key,
    { persons: normalizedPersons, relations: normalizedRelations },
    PEOPLE_CACHE_MAX_CHARS,
  );
}

export function clearProjectPeopleCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
