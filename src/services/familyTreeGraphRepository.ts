import type {
  AssociationRelationship,
  EvidenceStatus,
  FamilyGroup,
  FamilyGroupMember,
  FamilyTree,
  FamilyTreePerson,
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
  FamilyTreePrivacyStatus,
  ParentChildRelationship,
  ParentSet,
  PartnerRelationship,
} from "../types/familyTree";
import type { EntityId, GeoPoint } from "../types";
import { getSupabaseClient } from "./supabaseAuth.ts";

export interface FamilyTreePersonProfile {
  id: EntityId;
  projectId: EntityId;
  researchId: EntityId | null;
  gender: string;
  status: string;
  surname: string;
  givenName: string;
  patronymic: string;
  fullName: string;
  maidenSurname: string;
  isLiving: boolean;
  privacyStatus: FamilyTreePrivacyStatus;
  nameVariants: string;
  surnameVariants: string;
  birthDate: string;
  birthYearFrom: string;
  birthYearTo: string;
  birthPlace: string;
  marriageDate: string;
  marriagePlace: string;
  deathDate: string;
  deathYearFrom: string;
  deathYearTo: string;
  deathPlace: string;
  residencePlaces: string;
  socialStatus: string;
  religion: string;
  occupation: string;
  notes: string;
  customFields: Record<string, unknown>;
}

export interface TreeLayoutPosition {
  id: EntityId;
  projectId: EntityId;
  treeId: EntityId;
  viewKey: string;
  personId: EntityId;
  occurrenceKey: string;
  x: number;
  y: number;
  isCollapsed: boolean;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface FamilyTreeResearchIssueRecord {
  id: EntityId;
  projectId: EntityId;
  treeId: EntityId | null;
  personId: EntityId | null;
  relationshipTable: string;
  relationshipId: EntityId | null;
  issueType: string;
  severity: "info" | "warning" | "critical" | "needs_review";
  title: string;
  description: string;
  status: "open" | "ignored" | "resolved";
  metadata: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

export interface FamilyTreeGraphRepositoryData {
  tree: FamilyTree | null;
  treePersons: FamilyTreePerson[];
  personProfiles: FamilyTreePersonProfile[];
  groups: FamilyGroup[];
  groupMembers: FamilyGroupMember[];
  partnerRelationships: PartnerRelationship[];
  parentSets: ParentSet[];
  parentChildRelationships: ParentChildRelationship[];
  associationRelationships: AssociationRelationship[];
  layoutPositions: TreeLayoutPosition[];
  researchIssues: FamilyTreeResearchIssueRecord[];
  personNames: FamilyTreePersonName[];
  personTimelineEvents: FamilyTreePersonTimelineEvent[];
}

type FamilyTreeRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  title: string;
  description: string;
  root_person_id: string | null;
  is_default: boolean;
  privacy_status: string;
  settings: unknown;
  created_at: string;
  updated_at: string;
};

type FamilyTreePersonRow = {
  project_id: string;
  tree_id: string;
  person_id: string;
  member_role: string;
  display_order: number;
  notes: string;
  created_at: string;
};

type PersonProfileRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  gender: string;
  status: string;
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
  is_living: boolean | null;
  privacy_status: string | null;
};

type FamilyGroupRow = {
  id: string;
  project_id: string;
  tree_id: string;
  group_type: string;
  display_label: string;
  primary_partner_1_id: string | null;
  primary_partner_2_id: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type FamilyGroupMemberRow = {
  project_id: string;
  family_group_id: string;
  person_id: string;
  member_role: string;
  display_order: number;
  notes: string;
  created_at: string;
};

type PartnerRelationshipRow = {
  id: string;
  project_id: string;
  tree_id: string;
  family_group_id: string | null;
  person_a_id: string;
  person_b_id: string;
  relationship_type: string;
  status: string;
  start_date: string;
  start_place: string;
  end_date: string;
  end_place: string;
  evidence_status: string;
  confidence: number;
  is_primary_for_display: boolean;
  privacy_status: string;
  source_document_id: string | null;
  source_finding_id: string | null;
  notes: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type ParentSetRow = {
  id: string;
  project_id: string;
  tree_id: string;
  child_id: string;
  family_group_id: string | null;
  set_type: string;
  is_preferred_for_display: boolean;
  is_default_for_pedigree: boolean;
  display_order: number;
  notes: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type ParentChildRelationshipRow = {
  id: string;
  project_id: string;
  tree_id: string;
  parent_id: string;
  child_id: string;
  parent_set_id: string;
  family_group_id: string | null;
  relationship_type: string;
  parent_role_label: string;
  start_date: string;
  end_date: string;
  evidence_status: string;
  confidence: number;
  is_primary_for_display: boolean;
  is_bloodline: boolean;
  is_legal: boolean;
  is_social: boolean;
  privacy_status: string;
  source_document_id: string | null;
  source_finding_id: string | null;
  notes: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type AssociationRelationshipRow = {
  id: string;
  project_id: string;
  tree_id: string;
  person_a_id: string;
  person_b_id: string;
  association_type: string;
  person_a_role_label: string;
  person_b_role_label: string;
  evidence_status: string;
  confidence: number;
  privacy_status: string;
  source_document_id: string | null;
  source_finding_id: string | null;
  notes: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type TreeLayoutPositionRow = {
  id: string;
  project_id: string;
  tree_id: string;
  view_key: string;
  person_id: string;
  occurrence_key: string;
  x: number | string;
  y: number | string;
  is_collapsed: boolean;
  metadata: unknown;
  updated_at: string;
};

type ResearchIssueRow = {
  id: string;
  project_id: string;
  tree_id: string | null;
  person_id: string | null;
  relationship_table: string;
  relationship_id: string | null;
  issue_type: string;
  severity: string;
  title: string;
  description: string;
  status: string;
  metadata: unknown;
  created_at: string;
  resolved_at: string | null;
};

type PersonNameRow = {
  id: string;
  project_id: string;
  person_id: string;
  name_type: string;
  language_code: string;
  script_code: string;
  surname: string;
  given_name: string;
  patronymic: string;
  full_name: string;
  original_text: string;
  is_primary: boolean;
  is_preferred: boolean;
  evidence_status: string;
  confidence: number;
  source_document_id: string | null;
  source_finding_id: string | null;
  notes: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type PersonTimelineEventRow = {
  id: string;
  project_id: string;
  person_id: string;
  event_type: string;
  title: string;
  event_date: string;
  date_from: string;
  date_to: string;
  date_text: string;
  place_name: string;
  geo: unknown;
  event_role: string;
  evidence_status: string;
  confidence: number;
  source_document_id: string | null;
  source_finding_id: string | null;
  notes: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

const FAMILY_TREE_SELECT =
  "id, project_id, research_id, title, description, root_person_id, is_default, privacy_status, settings, created_at, updated_at";
const FAMILY_TREE_PERSON_SELECT =
  "project_id, tree_id, person_id, member_role, display_order, notes, created_at";
const PERSON_PROFILE_SELECT =
  "id, project_id, research_id, gender, status, surname, given_name, patronymic, full_name, name_variants, surname_variants, birth_date, birth_year_from, birth_year_to, birth_place, marriage_date, marriage_place, death_date, death_year_from, death_year_to, death_place, residence_places, social_status, religion, occupation, notes, custom_fields, is_living, privacy_status";
const FAMILY_GROUP_SELECT =
  "id, project_id, tree_id, group_type, display_label, primary_partner_1_id, primary_partner_2_id, metadata, created_at, updated_at";
const FAMILY_GROUP_MEMBER_SELECT =
  "project_id, family_group_id, person_id, member_role, display_order, notes, created_at";
const PARTNER_RELATIONSHIP_SELECT =
  "id, project_id, tree_id, family_group_id, person_a_id, person_b_id, relationship_type, status, start_date, start_place, end_date, end_place, evidence_status, confidence, is_primary_for_display, privacy_status, source_document_id, source_finding_id, notes, metadata, created_at, updated_at";
const PARENT_SET_SELECT =
  "id, project_id, tree_id, child_id, family_group_id, set_type, is_preferred_for_display, is_default_for_pedigree, display_order, notes, metadata, created_at, updated_at";
const PARENT_CHILD_RELATIONSHIP_SELECT =
  "id, project_id, tree_id, parent_id, child_id, parent_set_id, family_group_id, relationship_type, parent_role_label, start_date, end_date, evidence_status, confidence, is_primary_for_display, is_bloodline, is_legal, is_social, privacy_status, source_document_id, source_finding_id, notes, metadata, created_at, updated_at";
const ASSOCIATION_RELATIONSHIP_SELECT =
  "id, project_id, tree_id, person_a_id, person_b_id, association_type, person_a_role_label, person_b_role_label, evidence_status, confidence, privacy_status, source_document_id, source_finding_id, notes, metadata, created_at, updated_at";
const TREE_LAYOUT_POSITION_SELECT =
  "id, project_id, tree_id, view_key, person_id, occurrence_key, x, y, is_collapsed, metadata, updated_at";
const RESEARCH_ISSUE_SELECT =
  "id, project_id, tree_id, person_id, relationship_table, relationship_id, issue_type, severity, title, description, status, metadata, created_at, resolved_at";
const PERSON_NAME_SELECT =
  "id, project_id, person_id, name_type, language_code, script_code, surname, given_name, patronymic, full_name, original_text, is_primary, is_preferred, evidence_status, confidence, source_document_id, source_finding_id, notes, metadata, created_at, updated_at";
const PERSON_TIMELINE_EVENT_SELECT =
  "id, project_id, person_id, event_type, title, event_date, date_from, date_to, date_text, place_name, geo, event_role, evidence_status, confidence, source_document_id, source_finding_id, notes, metadata, created_at, updated_at";
const MAIDEN_SURNAME_KEY = "__trackerRoduMaidenSurname";
const SELECT_BATCH_SIZE = 1000;
const IN_FILTER_BATCH_SIZE = 400;

type RangeRequest<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

export async function readFamilyTreeGraphData(query: {
  projectId: EntityId;
  treeId?: EntityId;
}): Promise<FamilyTreeGraphRepositoryData> {
  const client = getSupabaseClient();
  const treeResult = query.treeId
    ? await client
        .from("family_trees")
        .select(FAMILY_TREE_SELECT)
        .eq("project_id", query.projectId)
        .eq("id", query.treeId)
        .maybeSingle()
    : await client
        .from("family_trees")
        .select(FAMILY_TREE_SELECT)
        .eq("project_id", query.projectId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
  if (treeResult.error) {
    if (isMissingFamilyTreeTableError(treeResult.error)) return emptyRepositoryData();
    throw treeResult.error;
  }
  const tree = treeResult.data ? treeFromRow(treeResult.data as FamilyTreeRow) : null;
  if (!tree) return emptyRepositoryData();

  const treeId = tree.id;
  const [
    treePersonRows,
    groupRows,
    groupMemberRows,
    partnerRelationshipRows,
    parentSetRows,
    parentChildRelationshipRows,
    associationRelationshipRows,
    layoutPositionRows,
    researchIssueRows,
  ] = await Promise.all([
    selectAllRows<FamilyTreePersonRow>(
      client
        .from("family_tree_persons")
        .select(FAMILY_TREE_PERSON_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId)
        .order("display_order", { ascending: true })
        .order("created_at", { ascending: true }),
    ),
    selectAllRows<FamilyGroupRow>(
      client
        .from("family_groups")
        .select(FAMILY_GROUP_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId)
        .order("created_at", { ascending: true }),
    ),
    selectAllRows<FamilyGroupMemberRow>(
      client
        .from("family_group_members")
        .select(FAMILY_GROUP_MEMBER_SELECT)
        .eq("project_id", query.projectId)
        .order("display_order", { ascending: true }),
    ),
    selectAllRows<PartnerRelationshipRow>(
      client
        .from("partner_relationships")
        .select(PARTNER_RELATIONSHIP_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId),
    ),
    selectAllRows<ParentSetRow>(
      client
        .from("parent_sets")
        .select(PARENT_SET_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId)
        .order("display_order", { ascending: true }),
    ),
    selectAllRows<ParentChildRelationshipRow>(
      client
        .from("parent_child_relationships")
        .select(PARENT_CHILD_RELATIONSHIP_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId),
    ),
    selectAllRows<AssociationRelationshipRow>(
      client
        .from("association_relationships")
        .select(ASSOCIATION_RELATIONSHIP_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId),
    ),
    selectAllRows<TreeLayoutPositionRow>(
      client
        .from("tree_layout_positions")
        .select(TREE_LAYOUT_POSITION_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId),
    ),
    selectAllRows<ResearchIssueRow>(
      client
        .from("family_tree_research_issues")
        .select(RESEARCH_ISSUE_SELECT)
        .eq("project_id", query.projectId)
        .eq("tree_id", treeId)
        .neq("status", "resolved")
        .order("created_at", { ascending: false }),
    ),
  ]);

  const treePersons = treePersonRows.map(treePersonFromRow);
  const groups = groupRows.map(familyGroupFromRow);
  const groupMembers = groupMemberRows
    .filter((member) => groups.some((group) => group.id === member.family_group_id))
    .map(familyGroupMemberFromRow);
  const partnerRelationships = partnerRelationshipRows
    .map(partnerRelationshipFromRow);
  const parentSets = parentSetRows.map(parentSetFromRow);
  const parentChildRelationships = parentChildRelationshipRows
    .map(parentChildRelationshipFromRow);
  const associationRelationships = associationRelationshipRows
    .map(associationRelationshipFromRow);
  const layoutPositions = layoutPositionRows.map(layoutPositionFromRow);
  const researchIssues = researchIssueRows.map(researchIssueFromRow);

  const personIds = collectPersonIds({
    tree,
    treePersons,
    groups,
    groupMembers,
    partnerRelationships,
    parentSets,
    parentChildRelationships,
    associationRelationships,
    layoutPositions,
    researchIssues,
  });
  const personProfiles = await readPersonProfiles(query.projectId);
  const allPersonIds = personProfiles.map((profile) => profile.id);
  const relatedPersonIds = mergePersonIds(personIds, allPersonIds);
  const [personNames, personTimelineEvents] = await Promise.all([
    readPersonNames(query.projectId, relatedPersonIds),
    readPersonTimelineEvents(query.projectId, relatedPersonIds),
  ]);

  return {
    tree,
    treePersons,
    personProfiles,
    groups,
    groupMembers,
    partnerRelationships,
    parentSets,
    parentChildRelationships,
    associationRelationships,
    layoutPositions,
    researchIssues,
    personNames,
    personTimelineEvents,
  };
}

function emptyRepositoryData(): FamilyTreeGraphRepositoryData {
  return {
    tree: null,
    treePersons: [],
    personProfiles: [],
    groups: [],
    groupMembers: [],
    partnerRelationships: [],
    parentSets: [],
    parentChildRelationships: [],
    associationRelationships: [],
    layoutPositions: [],
    researchIssues: [],
    personNames: [],
    personTimelineEvents: [],
  };
}

async function readPersonProfiles(projectId: EntityId, personIds?: EntityId[]): Promise<FamilyTreePersonProfile[]> {
  const client = getSupabaseClient();
  const chunks = personIds?.length ? chunkArray(personIds, IN_FILTER_BATCH_SIZE) : [null];
  const rows = (await Promise.all(chunks.map((chunk) => {
    let request = client
      .from("persons")
      .select(PERSON_PROFILE_SELECT)
      .eq("project_id", projectId)
      .order("surname", { ascending: true })
      .order("given_name", { ascending: true })
      .order("patronymic", { ascending: true });
    if (chunk) request = request.in("id", chunk);
    return selectAllRows<PersonProfileRow>(request);
  }))).flat();
  return rows.map(personProfileFromRow);
}

function mergePersonIds(primary: EntityId[], secondary: EntityId[]): EntityId[] {
  return Array.from(new Set([...primary, ...secondary]));
}

async function readPersonNames(projectId: EntityId, personIds: EntityId[]): Promise<FamilyTreePersonName[]> {
  if (!personIds.length) return [];
  const client = getSupabaseClient();
  const rows = (await Promise.all(chunkArray(personIds, IN_FILTER_BATCH_SIZE).map((chunk) =>
    selectAllRows<PersonNameRow>(
      client
        .from("person_names")
        .select(PERSON_NAME_SELECT)
        .eq("project_id", projectId)
        .in("person_id", chunk)
        .order("is_primary", { ascending: false })
        .order("is_preferred", { ascending: false })
        .order("created_at", { ascending: true }),
    ),
  ))).flat();
  return rows.map(personNameFromRow);
}

async function readPersonTimelineEvents(
  projectId: EntityId,
  personIds: EntityId[],
): Promise<FamilyTreePersonTimelineEvent[]> {
  if (!personIds.length) return [];
  const client = getSupabaseClient();
  const rows = (await Promise.all(chunkArray(personIds, IN_FILTER_BATCH_SIZE).map((chunk) =>
    selectAllRows<PersonTimelineEventRow>(
      client
        .from("person_timeline_events")
        .select(PERSON_TIMELINE_EVENT_SELECT)
        .eq("project_id", projectId)
        .in("person_id", chunk)
        .order("event_date", { ascending: true })
        .order("created_at", { ascending: true }),
    ),
  ))).flat();
  return rows.map(personTimelineEventFromRow);
}

async function selectAllRows<T>(request: RangeRequest<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += SELECT_BATCH_SIZE) {
    const to = from + SELECT_BATCH_SIZE - 1;
    const { data, error } = await request.range(from, to);
    if (error) {
      if (isMissingFamilyTreeTableError(error)) return [];
      throw error;
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < SELECT_BATCH_SIZE) break;
  }
  return rows;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isMissingFamilyTreeTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code ?? "") : "";
  const message = "message" in error ? String(error.message ?? "") : "";
  const details = "details" in error ? String(error.details ?? "") : "";
  const text = `${message} ${details}`.toLowerCase();
  return code === "42P01" ||
    code === "PGRST205" ||
    text.includes("family_trees") ||
    text.includes("family_tree_persons") ||
    text.includes("family_groups") ||
    text.includes("family_group_members") ||
    text.includes("partner_relationships") ||
    text.includes("parent_sets") ||
    text.includes("parent_child_relationships") ||
    text.includes("association_relationships") ||
    text.includes("tree_layout_positions") ||
    text.includes("family_tree_research_issues") ||
    text.includes("person_names") ||
    text.includes("person_timeline_events");
}

function collectPersonIds(input: {
  tree: FamilyTree;
  treePersons: FamilyTreePerson[];
  groups: FamilyGroup[];
  groupMembers: FamilyGroupMember[];
  partnerRelationships: PartnerRelationship[];
  parentSets: ParentSet[];
  parentChildRelationships: ParentChildRelationship[];
  associationRelationships: AssociationRelationship[];
  layoutPositions: TreeLayoutPosition[];
  researchIssues: FamilyTreeResearchIssueRecord[];
}): EntityId[] {
  const ids = new Set<EntityId>();
  if (input.tree.rootPersonId) ids.add(input.tree.rootPersonId);
  input.treePersons.forEach((row) => ids.add(row.personId));
  input.groups.forEach((row) => {
    if (row.primaryPartner1Id) ids.add(row.primaryPartner1Id);
    if (row.primaryPartner2Id) ids.add(row.primaryPartner2Id);
  });
  input.groupMembers.forEach((row) => ids.add(row.personId));
  input.partnerRelationships.forEach((row) => {
    ids.add(row.personAId);
    ids.add(row.personBId);
  });
  input.parentSets.forEach((row) => ids.add(row.childId));
  input.parentChildRelationships.forEach((row) => {
    ids.add(row.parentId);
    ids.add(row.childId);
  });
  input.associationRelationships.forEach((row) => {
    ids.add(row.personAId);
    ids.add(row.personBId);
  });
  input.layoutPositions.forEach((row) => ids.add(row.personId));
  input.researchIssues.forEach((row) => {
    if (row.personId) ids.add(row.personId);
  });
  return Array.from(ids);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asPrivacyStatus(value: unknown): FamilyTreePrivacyStatus {
  return value === "project" || value === "public" || value === "confidential" ? value : "private";
}

function asEvidenceStatus(value: unknown): EvidenceStatus {
  return value === "proven" ||
    value === "likely" ||
    value === "disputed" ||
    value === "disproven"
    ? value
    : "unknown";
}

function asIssueSeverity(value: unknown): FamilyTreeResearchIssueRecord["severity"] {
  return value === "info" || value === "critical" || value === "needs_review" ? value : "warning";
}

function asIssueStatus(value: unknown): FamilyTreeResearchIssueRecord["status"] {
  return value === "ignored" || value === "resolved" ? value : "open";
}

function asNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function treeFromRow(row: FamilyTreeRow): FamilyTree {
  return {
    id: row.id,
    projectId: row.project_id,
    researchId: row.research_id,
    title: row.title,
    description: row.description,
    rootPersonId: row.root_person_id,
    isDefault: row.is_default,
    privacyStatus: asPrivacyStatus(row.privacy_status),
    settings: asRecord(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function treePersonFromRow(row: FamilyTreePersonRow): FamilyTreePerson {
  return {
    projectId: row.project_id,
    treeId: row.tree_id,
    personId: row.person_id,
    memberRole: row.member_role as FamilyTreePerson["memberRole"],
    displayOrder: row.display_order,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function personProfileFromRow(row: PersonProfileRow): FamilyTreePersonProfile {
  const customFields = asRecord(row.custom_fields);
  return {
    id: row.id,
    projectId: row.project_id,
    researchId: row.research_id,
    gender: row.gender,
    status: row.status,
    surname: row.surname,
    givenName: row.given_name,
    patronymic: row.patronymic,
    fullName: row.full_name,
    maidenSurname: typeof customFields[MAIDEN_SURNAME_KEY] === "string" ? customFields[MAIDEN_SURNAME_KEY] : "",
    isLiving: row.is_living ?? false,
    privacyStatus: asPrivacyStatus(row.privacy_status),
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
    customFields,
  };
}

function familyGroupFromRow(row: FamilyGroupRow): FamilyGroup {
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    groupType: row.group_type as FamilyGroup["groupType"],
    displayLabel: row.display_label,
    primaryPartner1Id: row.primary_partner_1_id,
    primaryPartner2Id: row.primary_partner_2_id,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function familyGroupMemberFromRow(row: FamilyGroupMemberRow): FamilyGroupMember {
  return {
    projectId: row.project_id,
    familyGroupId: row.family_group_id,
    personId: row.person_id,
    memberRole: row.member_role as FamilyGroupMember["memberRole"],
    displayOrder: row.display_order,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function partnerRelationshipFromRow(row: PartnerRelationshipRow): PartnerRelationship {
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    familyGroupId: row.family_group_id,
    personAId: row.person_a_id,
    personBId: row.person_b_id,
    relationshipType: row.relationship_type as PartnerRelationship["relationshipType"],
    status: row.status as PartnerRelationship["status"],
    startDate: row.start_date,
    startPlace: row.start_place,
    endDate: row.end_date,
    endPlace: row.end_place,
    evidenceStatus: asEvidenceStatus(row.evidence_status),
    confidence: row.confidence,
    isPrimaryForDisplay: row.is_primary_for_display,
    privacyStatus: asPrivacyStatus(row.privacy_status),
    sourceDocumentId: row.source_document_id,
    sourceFindingId: row.source_finding_id,
    notes: row.notes,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parentSetFromRow(row: ParentSetRow): ParentSet {
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    childId: row.child_id,
    familyGroupId: row.family_group_id,
    setType: row.set_type as ParentSet["setType"],
    isPreferredForDisplay: row.is_preferred_for_display,
    isDefaultForPedigree: row.is_default_for_pedigree,
    displayOrder: row.display_order,
    notes: row.notes,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parentChildRelationshipFromRow(row: ParentChildRelationshipRow): ParentChildRelationship {
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    parentId: row.parent_id,
    childId: row.child_id,
    parentSetId: row.parent_set_id,
    familyGroupId: row.family_group_id,
    relationshipType: row.relationship_type as ParentChildRelationship["relationshipType"],
    parentRoleLabel: row.parent_role_label as ParentChildRelationship["parentRoleLabel"],
    startDate: row.start_date,
    endDate: row.end_date,
    evidenceStatus: asEvidenceStatus(row.evidence_status),
    confidence: row.confidence,
    isPrimaryForDisplay: row.is_primary_for_display,
    isBloodline: row.is_bloodline,
    isLegal: row.is_legal,
    isSocial: row.is_social,
    privacyStatus: asPrivacyStatus(row.privacy_status),
    sourceDocumentId: row.source_document_id,
    sourceFindingId: row.source_finding_id,
    notes: row.notes,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function associationRelationshipFromRow(row: AssociationRelationshipRow): AssociationRelationship {
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    personAId: row.person_a_id,
    personBId: row.person_b_id,
    associationType: row.association_type as AssociationRelationship["associationType"],
    personARoleLabel: row.person_a_role_label,
    personBRoleLabel: row.person_b_role_label,
    evidenceStatus: asEvidenceStatus(row.evidence_status),
    confidence: row.confidence,
    privacyStatus: asPrivacyStatus(row.privacy_status),
    sourceDocumentId: row.source_document_id,
    sourceFindingId: row.source_finding_id,
    notes: row.notes,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function layoutPositionFromRow(row: TreeLayoutPositionRow): TreeLayoutPosition {
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    viewKey: row.view_key,
    personId: row.person_id,
    occurrenceKey: row.occurrence_key,
    x: asNumber(row.x),
    y: asNumber(row.y),
    isCollapsed: row.is_collapsed,
    metadata: asRecord(row.metadata),
    updatedAt: row.updated_at,
  };
}

function researchIssueFromRow(row: ResearchIssueRow): FamilyTreeResearchIssueRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    treeId: row.tree_id,
    personId: row.person_id,
    relationshipTable: row.relationship_table,
    relationshipId: row.relationship_id,
    issueType: row.issue_type,
    severity: asIssueSeverity(row.severity),
    title: row.title,
    description: row.description,
    status: asIssueStatus(row.status),
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function personNameFromRow(row: PersonNameRow): FamilyTreePersonName {
  return {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id,
    nameType: row.name_type as FamilyTreePersonName["nameType"],
    languageCode: row.language_code,
    scriptCode: row.script_code,
    surname: row.surname,
    givenName: row.given_name,
    patronymic: row.patronymic,
    fullName: row.full_name,
    originalText: row.original_text,
    isPrimary: row.is_primary,
    isPreferred: row.is_preferred,
    evidenceStatus: asEvidenceStatus(row.evidence_status),
    confidence: row.confidence,
    sourceDocumentId: row.source_document_id,
    sourceFindingId: row.source_finding_id,
    notes: row.notes,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function personTimelineEventFromRow(row: PersonTimelineEventRow): FamilyTreePersonTimelineEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id,
    eventType: row.event_type as FamilyTreePersonTimelineEvent["eventType"],
    title: row.title,
    eventDate: row.event_date,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    dateText: row.date_text,
    placeName: row.place_name,
    geo: (row.geo ?? null) as GeoPoint | null,
    eventRole: row.event_role,
    evidenceStatus: asEvidenceStatus(row.evidence_status),
    confidence: row.confidence,
    sourceDocumentId: row.source_document_id,
    sourceFindingId: row.source_finding_id,
    notes: row.notes,
    metadata: asRecord(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
