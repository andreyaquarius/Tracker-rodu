import type {
  CustomFieldValues,
  Person,
  PersonRelation,
  ScanAttachment,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import {
  asProjectPage,
  pageRange,
  type ProjectPage,
} from "./projectPagination";

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
};

const PERSON_SELECT =
  "id, project_id, research_id, status, gender, surname, given_name, patronymic, full_name, name_variants, surname_variants, birth_date, birth_year_from, birth_year_to, birth_place, marriage_date, marriage_place, death_date, death_year_from, death_year_to, death_place, residence_places, social_status, religion, occupation, notes, custom_fields, created_at, updated_at";
const RELATION_SELECT =
  "id, project_id, person_id, related_person_id, relation_type, status, evidence_text, notes, created_at, updated_at";
const SCANS_KEY = "__trackerRoduPersonScans";
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
} {
  const record = asRecord(value);
  const scanRecord = asRecord(record[SCANS_KEY]);
  const customFields = { ...record };
  delete customFields[SCANS_KEY];
  return {
    customFields: customFields as CustomFieldValues,
    scans: {
      birthScans: asScans(scanRecord.birthScans),
      marriageScans: asScans(scanRecord.marriageScans),
      deathScans: asScans(scanRecord.deathScans),
      mentionScans: asScans(scanRecord.mentionScans),
    },
  };
}

function personFromRow(row: PersonRow): Person {
  const { customFields, scans } = splitCustomFields(row.custom_fields);
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    status: row.status as Person["status"],
    gender: row.gender as Person["gender"],
    surname: row.surname,
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
    notes: row.notes,
    ...scans,
    customFields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function personToRow(projectId: string, person: Person, _researchIds: Set<string>) {
  return {
    id: person.id,
    project_id: projectId,
    research_id: person.researchId || null,
    status: person.status,
    gender: person.gender,
    surname: person.surname,
    given_name: person.givenName,
    patronymic: person.patronymic,
    full_name: person.fullName,
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
    notes: person.notes,
    custom_fields: {
      ...(person.customFields ?? {}),
      [SCANS_KEY]: {
        birthScans: person.birthScans ?? [],
        marriageScans: person.marriageScans ?? [],
        deathScans: person.deathScans ?? [],
        mentionScans: person.mentionScans ?? [],
      },
    },
    created_at: person.createdAt,
    updated_at: person.updatedAt,
  };
}

function relationFromRow(row: RelationRow): PersonRelation {
  return {
    id: row.id,
    personId: row.person_id,
    relatedPersonId: row.related_person_id,
    relationType: row.relation_type as PersonRelation["relationType"],
    status: row.status as PersonRelation["status"],
    evidenceText: row.evidence_text,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function relationToRow(projectId: string, relation: PersonRelation) {
  return {
    id: relation.id,
    project_id: projectId,
    person_id: relation.personId,
    related_person_id: relation.relatedPersonId,
    relation_type: relation.relationType,
    status: relation.status,
    evidence_text: relation.evidenceText,
    notes: relation.notes,
    created_at: relation.createdAt,
    updated_at: relation.updatedAt,
  };
}

export async function listProjectPeople(
  projectId: string,
  page = 0,
): Promise<{
  persons: Person[];
  relations: PersonRelation[];
  hasMore: boolean;
}> {
  const client = getSupabaseClient();
  const { from, to } = pageRange(page);
  const personsResult = await client
    .from("persons")
    .select(PERSON_SELECT)
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .range(from, to);
  if (personsResult.error) throw personsResult.error;
  const persons = (personsResult.data as PersonRow[]).map(personFromRow);
  const personIds = persons.map((person) => person.id);
  const relationsResult = personIds.length
    ? await client
        .from("person_relations")
        .select(RELATION_SELECT)
        .eq("project_id", projectId)
        .or(`person_id.in.(${personIds.join(",")}),related_person_id.in.(${personIds.join(",")})`)
        .limit(500)
    : { data: [], error: null };
  if (relationsResult.error) throw relationsResult.error;
  return {
    persons,
    relations: (relationsResult.data as RelationRow[]).map(relationFromRow),
    hasMore: asProjectPage(persons).hasMore,
  };
}

export async function importProjectPeople(
  projectId: string,
  persons: Person[],
  relations: PersonRelation[],
  researchIds: Set<string>,
): Promise<void> {
  const client = getSupabaseClient();
  if (persons.length) {
    const { error } = await client
      .from("persons")
      .upsert(persons.map((person) => personToRow(projectId, person, researchIds)), { onConflict: "id" });
    if (error) throw error;
  }
  if (relations.length) {
    const { error } = await client
      .from("person_relations")
      .upsert(relations.map((relation) => relationToRow(projectId, relation)), { onConflict: "id" });
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
      persons: Array.isArray(parsed.persons) ? (parsed.persons as Person[]) : [],
      relations: Array.isArray(parsed.relations) ? (parsed.relations as PersonRelation[]) : [],
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
  localStorage.setItem(`${CACHE_PREFIX}${projectId}`, JSON.stringify({ persons, relations }));
}

export function clearProjectPeopleCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
