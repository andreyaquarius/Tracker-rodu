export type EntityId = string;
export type SyncStatus = "local" | "synced" | "pending" | "error" | "offline";

export interface BaseEntity {
  id: EntityId;
  createdAt: string;
  updatedAt: string;
}

export interface ScanAttachment {
  id: EntityId;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  storage: "local" | "drive" | "supabase";
  driveFileId?: string;
  storagePath?: string;
}

export type CustomFieldModule =
  | "researches"
  | "documents"
  | "persons"
  | "findings"
  | "tasks"
  | "hypotheses"
  | "archiveRequests"
  | "yearMatrix";

export type CustomFieldType =
  | "text"
  | "textarea"
  | "number"
  | "year"
  | "date"
  | "time"
  | "approximate-date"
  | "place"
  | "select"
  | "multiselect"
  | "boolean"
  | "url"
  | "email"
  | "tel"
  | "attachments"
  | "relation";

export interface CustomFieldDefinition {
  id: EntityId;
  module: CustomFieldModule;
  label: string;
  type: CustomFieldType;
  options: string[];
  relationTarget?: CustomSectionRelationTarget;
}

export type CustomFieldValue = string | boolean | string[] | ScanAttachment[];
export type CustomFieldValues = Record<EntityId, CustomFieldValue>;

export type CustomSectionFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "boolean"
  | "url"
  | "attachments"
  | "relation";

export type CustomSectionRelationTarget =
  | "all"
  | CollectionKey
  | `custom:${EntityId}`;

export interface CustomSectionField {
  id: EntityId;
  label: string;
  type: CustomSectionFieldType;
  required: boolean;
  options: string[];
  relationTarget?: CustomSectionRelationTarget;
}

export interface CustomSectionDefinition {
  id: EntityId;
  name: string;
  singularName: string;
  description: string;
  icon: string;
  titleFieldId: EntityId;
  fields: CustomSectionField[];
  createdAt: string;
  updatedAt: string;
}

export type CustomSectionRecordValue =
  | string
  | boolean
  | string[]
  | ScanAttachment[];

export interface CustomSectionRecord extends BaseEntity {
  sectionId: EntityId;
  values: Record<EntityId, CustomSectionRecordValue>;
}

export interface Research extends BaseEntity {
  title: string;
  goal: string;
  surnames: string;
  places: string;
  periodFrom: string;
  periodTo: string;
  archives: string;
  status: "активне" | "призупинене" | "завершене";
  notes: string;
  customFields: CustomFieldValues;
}

export interface DocumentRecord extends BaseEntity {
  researchId: EntityId;
  title: string;
  documentType: string;
  archive: string;
  fund: string;
  description: string;
  file: string;
  yearFrom: string;
  yearTo: string;
  place: string;
  url: string;
  pagesCount: string;
  lastPage: string;
  reviewStatus: string;
  notes: string;
  scans: ScanAttachment[];
  customFields: CustomFieldValues;
}

export interface YearMatrixRecord extends BaseEntity {
  researchId: EntityId;
  documentId: EntityId;
  year: string;
  place: string;
  documentType: string;
  status: string;
  notes: string;
  customFields: CustomFieldValues;
}

export interface TaskRecord extends BaseEntity {
  researchId: EntityId;
  personName: string;
  personIds: EntityId[];
  title: string;
  description: string;
  place: string;
  yearFrom: string;
  yearTo: string;
  documentType: string;
  documentId: EntityId;
  status: string;
  priority: string;
  deadline: string;
  notes: string;
  customFields: CustomFieldValues;
}

export interface Finding extends BaseEntity {
  researchId: EntityId;
  documentId: EntityId;
  findingType: string;
  eventDate: string;
  people: string;
  personsText: string;
  personIds: EntityId[];
  participants: FindingParticipant[];
  place: string;
  archive: string;
  fund: string;
  description: string;
  file: string;
  page: string;
  summary: string;
  transcription: string;
  conclusion: string;
  reliability: string;
  needsReview: boolean;
  notes: string;
  scans: ScanAttachment[];
  customFields: CustomFieldValues;
}

export interface FindingParticipant {
  id: EntityId;
  role: string;
  name: string;
  notes: string;
}

export type ActivityActionType =
  | "research_created"
  | "research_updated"
  | "document_created"
  | "document_status_changed"
  | "document_last_page_updated"
  | "task_created"
  | "task_status_changed"
  | "finding_created"
  | "hypothesis_created"
  | "year_status_changed"
  | "archive_request_created"
  | "archive_request_status_changed"
  | "person_created"
  | "person_updated"
  | "record_created"
  | "record_updated"
  | "record_deleted";

export interface ActivityLogEntry {
  id: EntityId;
  createdAt: string;
  actionType: ActivityActionType;
  text: string;
  module: CollectionKey;
  relatedId: EntityId;
}

export interface Hypothesis extends BaseEntity {
  researchId: EntityId;
  title: string;
  description: string;
  argumentsFor: string;
  argumentsAgainst: string;
  toVerify: string;
  relatedPeople: string;
  personIds: EntityId[];
  documentIds: EntityId[];
  findingIds: EntityId[];
  status: string;
  probability: string;
  notes: string;
  customFields: CustomFieldValues;
}

export interface ArchiveRequest extends BaseEntity {
  researchId: EntityId;
  personIds: EntityId[];
  archive: string;
  archiveDetails: string;
  requestDate: string;
  responseDate: string;
  subject: string;
  status: string;
  notes: string;
  requestScans: ScanAttachment[];
  responseScans: ScanAttachment[];
  customFields: CustomFieldValues;
}

export type PersonGender = "чоловік" | "жінка" | "невідомо";
export type PersonStatus =
  | "доведена"
  | "частково доведена"
  | "гіпотетична"
  | "сумнівна"
  | "спростована";

export interface Person extends BaseEntity {
  researchId: EntityId;
  surname: string;
  givenName: string;
  patronymic: string;
  fullName: string;
  gender: PersonGender;
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
  status: PersonStatus;
  notes: string;
  birthScans: ScanAttachment[];
  marriageScans: ScanAttachment[];
  deathScans: ScanAttachment[];
  mentionScans: ScanAttachment[];
  customFields: CustomFieldValues;
}

export type PersonRelationType =
  | "батько"
  | "мати"
  | "чоловік"
  | "дружина"
  | "дитина"
  | "брат"
  | "сестра"
  | "інше";

export type PersonRelationStatus =
  | "доведено"
  | "імовірно"
  | "гіпотеза"
  | "сумнівно"
  | "спростовано";

export interface PersonRelation extends BaseEntity {
  personId: EntityId;
  relatedPersonId: EntityId;
  relationType: PersonRelationType;
  status: PersonRelationStatus;
  evidenceText: string;
  notes: string;
}

export interface AppSettings {
  researcherName: string;
  compactTables: boolean;
  lastAutomaticBackupAt: string | null;
  customFields: CustomFieldDefinition[];
}

export type BackupType = "automatic" | "manual" | "pre-import" | "pre-clear";

export interface DriveBackupFile {
  id: string;
  name: string;
  createdTime: string;
  modifiedTime: string;
  size: number;
  type: BackupType;
}

export interface AppDatabase {
  version: 5;
  appName: "Трекер Роду";
  tagline: "Не губи сліди свого роду";
  updatedAt: string;
  researches: Research[];
  documents: DocumentRecord[];
  yearMatrix: YearMatrixRecord[];
  tasks: TaskRecord[];
  findings: Finding[];
  hypotheses: Hypothesis[];
  archiveRequests: ArchiveRequest[];
  persons: Person[];
  personRelations: PersonRelation[];
  customSections: CustomSectionDefinition[];
  customSectionRecords: CustomSectionRecord[];
  activityLog: ActivityLogEntry[];
  settings: AppSettings;
}

export type CollectionKey =
  | "researches"
  | "documents"
  | "yearMatrix"
  | "tasks"
  | "findings"
  | "hypotheses"
  | "archiveRequests"
  | "persons";

export type AppEntity =
  | Research
  | DocumentRecord
  | YearMatrixRecord
  | TaskRecord
  | Finding
  | Hypothesis
  | ArchiveRequest
  | Person;

export interface GoogleUser {
  name: string;
  email: string;
  picture?: string;
}

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt: string | null;
  message?: string;
}
