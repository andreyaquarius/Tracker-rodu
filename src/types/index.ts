export type EntityId = string;

export interface BaseEntity {
  id: EntityId;
  createdAt: string;
  updatedAt: string;
}

export interface PersonAvatarCrop {
  x: number;
  y: number;
  zoom: number;
}

export interface ScanAttachment {
  id: EntityId;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  storage: "google-drive" | "external-url";
  storagePath: string;
  webViewLink?: string;
  driveMd5Checksum?: string;
  driveModifiedTime?: string;
  driveRevisionId?: string;
  /** Resource key required by Google Drive for some link-shared files. */
  driveResourceKey?: string;
  deleteOnRemove?: boolean;
  /** Imported GEDCOM can reference a local file that the browser cannot read. */
  availability?: "available" | "missing-local";
  sourceKind?: "gedcom";
  sourceReference?: string;
  /** Provider-side identifier such as GEDCOM _PHOTO_RIN. */
  sourceExternalId?: string;
  /** Exact expiry encoded by the original URL; never a guessed provider TTL. */
  sourceExpiresAt?: string;
  sourceDurability?: "temporary" | "unknown";
  statusMessage?: string;
  /** Presentation-only focal point and zoom used when this photo is an avatar. */
  avatarCrop?: PersonAvatarCrop;
}

export type GeoSource = "search" | "map_click" | "import" | "unknown";
export type GeoPrecision = "exact" | "approximate" | "settlement" | "unknown";

export interface GeoPoint {
  displayName: string | null;
  latitude: number | null;
  longitude: number | null;
  source: GeoSource;
  precision?: GeoPrecision;
  provider?: string | null;
  externalId?: string | null;
  markerColor?: string | null;
}

export interface DocumentFragmentSelection {
  documentId: EntityId;
  sourceFileId: EntityId;
  pageNumber: number;
  rotation: number;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  createdAt: string;
}

export type PersonEventType =
  | "birth"
  | "baptism"
  | "christening"
  | "marriage"
  | "divorce"
  | "residence"
  | "census"
  | "revision_list"
  | "confession_list"
  | "household_register"
  | "immigration"
  | "emigration"
  | "military"
  | "occupation"
  | "education"
  | "nationality"
  | "death"
  | "burial"
  | "cremation"
  | "probate"
  | "mention"
  | "other";

export interface PersonEvent {
  id: EntityId;
  personId: EntityId;
  type: PersonEventType;
  title?: string;
  date?: string | null;
  placeName?: string | null;
  /** Original fact value, for example an occupation, military unit or book number. */
  value?: string | null;
  /** Age written in the source at the time of the event. */
  age?: string | null;
  /** Cause recorded for death or another event. */
  cause?: string | null;
  /** Detailed address when it is more precise than the event place. */
  address?: string | null;
  geo?: GeoPoint | null;
  notes?: string | null;
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

export type SectionParentKey =
  | CustomFieldModule
  | `custom:${EntityId}`;

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

export type CustomSectionFieldType = CustomFieldType;

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
  parentKey: SectionParentKey | null;
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
  reminderAt: string;
  reminderInApp: boolean;
  reminderEmail: boolean;
  reminderSentAt: string;
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
  sourceUrl: string;
  summary: string;
  transcription: string;
  conclusion: string;
  reliability: string;
  needsReview: boolean;
  notes: string;
  scans: ScanAttachment[];
  fragmentSelection?: DocumentFragmentSelection;
  geo: GeoPoint | null;
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
  | "record_deleted"
  | "relation_created"
  | "relation_updated"
  | "relation_deleted"
  | "section_created"
  | "section_updated"
  | "section_deleted"
  | "field_created"
  | "field_deleted"
  | "settings_updated"
  | "invitation_created"
  | "invitation_updated"
  | "invitation_deleted"
  | "invitation_accepted"
  | "member_updated"
  | "member_deleted"
  | "backup_created"
  | "backup_restored"
  | "backup_deleted";

export type ActivityModule =
  | CollectionKey
  | `custom:${EntityId}`
  | "settings"
  | "backup";

export interface ActivityLogEntry {
  id: EntityId;
  createdAt: string;
  actionType: ActivityActionType;
  text: string;
  module: ActivityModule;
  relatedId: EntityId;
  mutationEntityId?: EntityId;
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
  | "відома особисто"
  | "відома з переказів"
  | "відома документально"
  | "гіпотетична"
  | "сумнівна"
  | "спростована";
export type PersonPrivacyStatus = "private" | "project" | "public" | "confidential";

export interface Person extends BaseEntity {
  researchId: EntityId;
  surname: string;
  maidenSurname: string;
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
  isLiving: boolean;
  privacyStatus: PersonPrivacyStatus;
  notes: string;
  birthScans: ScanAttachment[];
  marriageScans: ScanAttachment[];
  deathScans: ScanAttachment[];
  mentionScans: ScanAttachment[];
  /** Photo metadata only; image bytes remain in Google Drive or at an external URL. */
  photos?: ScanAttachment[];
  primaryPhotoId?: EntityId;
  events: PersonEvent[];
  customFields: CustomFieldValues;
}

export type PersonRelationType =
  | "батько"
  | "мати"
  | "батько або мати"
  | "чоловік"
  | "дружина"
  | "подружжя"
  | "дитина"
  | "син"
  | "донька"
  | "брат"
  | "сестра"
  | "брат або сестра"
  | "хрещений"
  | "хрещена"
  | "хрещеник"
  | "хрещениця"
  | "вітчим"
  | "мачуха"
  | "пасинок"
  | "падчерка"
  | "опікун"
  | "підопічний"
  | "усиновлювач"
  | "усиновлена дитина"
  | "свідок"
  | "поручитель"
  | "священник"
  | "духовна особа"
  | "посадова особа"
  | "повитуха"
  | "особа, яка повідомила"
  | "голова господарства"
  | "член господарства"
  | "наймит або служник"
  | "родич"
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
  /** Import-only structured metadata; canonical graph creation persists it. */
  gedcomMetadata?: {
    familyXref: string;
    importSourceKey?: string;
    importFileName?: string;
    startDate?: string;
    startPlace?: string;
    endDate?: string;
    endPlace?: string;
    eventType?: string;
    pedigree?: string | null;
    rawNotes?: string;
  };
}

export interface AppSettings {
  researcherName: string;
  compactTables: boolean;
  lastAutomaticBackupAt: string | null;
  customFields: CustomFieldDefinition[];
}

export type BackupType = "automatic" | "manual";

export interface BackupFile {
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
