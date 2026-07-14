import type { ScanAttachment } from "../../types/index.ts";

export type EntityId = string;
export type PersonId = EntityId;
export type UnionId = EntityId;
export type RelationshipId = EntityId;
export type OccurrenceId = string;

export type Sex = "male" | "female" | "other" | "unknown";

export type ParentRelationshipKind =
  | "biological"
  | "genetic_father"
  | "genetic_mother"
  | "gestational_parent"
  | "birth_parent"
  | "adoptive"
  | "foster"
  | "step"
  | "guardian"
  | "social_parent"
  | "legal_parent"
  | "donor"
  | "surrogate"
  | "presumed"
  | "unknown"
  | "other";

export type ParentRole =
  | "father"
  | "mother"
  | "parent"
  | "guardian"
  | "stepfather"
  | "stepmother"
  | "adoptive_father"
  | "adoptive_mother"
  | "custom"
  | "donor"
  | "surrogate"
  | "unknown";

export type UnionKind = "partnership" | "parent-set";

export type PartnershipStatus =
  | "active"
  | "current"
  | "married"
  | "separated"
  | "divorced"
  | "ended"
  | "unknown";

export interface SortableGenealogyDate {
  /** ISO date, partial date, or original human-readable value. */
  display?: string;
  /** Stable sortable representation: YYYY, YYYY-MM, or YYYY-MM-DD. */
  sort?: string;
}

export interface TreePerson {
  id: PersonId;
  displayName: string;
  givenName?: string;
  surname?: string;
  sex?: Sex;
  birth?: SortableGenealogyDate;
  death?: SortableGenealogyDate;
  /**
   * Metadata for the primary portrait. The file bytes stay in Google Drive (or
   * at the external source) and are resolved only for mounted, readable cards.
   */
  photo?: ScanAttachment;
  photoUrl?: string;
  isLiving?: boolean;
  isPrivate?: boolean;
  /** Stable user-defined order. A lexical fractional key is recommended. */
  displayOrder?: string;
  /** Application-specific badge counters that can be rendered by a card. */
  badges?: Readonly<Record<string, number | boolean | string>>;
}

/**
 * A visual family junction. A partnership is an explicit relationship between
 * people. A parent-set only groups parents of a child and must not imply that
 * donors, guardians, or surrogates were partners.
 */
export interface TreeUnion {
  id: UnionId;
  kind: UnionKind;
  memberIds: readonly PersonId[];
  /** Domain family group shared by a couple and its per-child parent sets. */
  familyGroupId?: EntityId;
  status?: PartnershipStatus;
  /** Exact domain relationship type, retained for application adapters/UI. */
  relationshipType?: string;
  /** Exact domain parent-set type; does not imply a partnership. */
  parentSetType?: string;
  isPreferredForDisplay?: boolean;
  isDefaultForPedigree?: boolean;
  startDate?: SortableGenealogyDate;
  endDate?: SortableGenealogyDate;
  displayOrder?: string;
  /** Used only to render optional "add parent" placeholders. */
  expectedParentSlots?: number;
}

export interface ParentChildRelation {
  id: RelationshipId;
  parentId: PersonId;
  childId: PersonId;
  unionId?: UnionId;
  kind: ParentRelationshipKind;
  role?: ParentRole;
  displayOrder?: string;
  isPreferred?: boolean;
  /** Client-only provenance for a relationship introduced by a branch page. */
  ownerBranchKey?: string;
}

export type ContinuationDirection =
  | "parents"
  | "children"
  | "partners"
  | "siblings";

/**
 * Canonical identity of a parent family whose children can be expanded as one
 * branch. The server owns `id`; parent and union ids are descriptive anchors
 * that let the UI mirror the same family action below its visible parent cards.
 */
export interface FamilyScope {
  id: EntityId;
  parentIds: readonly PersonId[];
  unionIds?: readonly UnionId[];
  familyGroupId?: EntityId;
}

/**
 * A continuation for one family scope. Unlike a legacy person continuation it
 * belongs to the parent set. The renderer may mirror that single action under
 * both parent cards while closed; it is still one token, cache entry and load.
 */
export interface FamilyContinuation {
  id: string;
  scope: FamilyScope;
  token: string;
  hiddenCount?: number;
  /** Client-only state for a loaded family branch kept in the layer cache. */
  expanded?: boolean;
  /** Client-only provenance used to hide nested layers with their owner. */
  ownerBranchKey?: string;
}

/**
 * Returned by the neighborhood endpoint when the domain graph continues past
 * the loaded page. This is not a limit on the stored tree.
 */
export interface TreeContinuation {
  id: string;
  personId: PersonId;
  direction: ContinuationDirection;
  token: string;
  hiddenCount?: number;
  unionId?: UnionId;
  /** Client-only state for a loaded branch that can be hidden without refetching. */
  expanded?: boolean;
  /** Client-only provenance used to hide nested branch layers with their owner. */
  ownerBranchKey?: string;
}

export interface FamilyGraphData {
  persons: readonly TreePerson[];
  unions: readonly TreeUnion[];
  parentChildRelations: readonly ParentChildRelation[];
  continuations?: readonly TreeContinuation[];
  /** Family-owned child controls; one authoritative item per scope id. */
  familyContinuations?: readonly FamilyContinuation[];
  graphVersion?: string | number;
  /** Opaque server-computed permission/RLS scope used only for safe caching. */
  permissionFingerprint?: string;
}

export interface PreviousNodePosition {
  occurrenceId: OccurrenceId;
  x: number;
  y: number;
}

export type FamilyTreeLayoutMode = "family-graph" | "descendant-forest";
export type FamilyTreeLineageGroupDepth = 0 | 1 | 2 | 3;

export interface FamilyTreeLayoutOptions {
  focusPersonId: PersonId;
  /** Selects one coordinate solver. Descendant mode never runs the pedigree solver. */
  layoutMode?: FamilyTreeLayoutMode;
  /** Initial view policy only. Increase or re-root without a schema limit. */
  ancestorDepth?: number;
  descendantDepth?: number;
  collateralDepth?: number;
  maxVisibleNodes?: number;
  showAllParentSets?: boolean;
  showUnknownParentPlaceholders?: boolean;
  /** child person id -> selected parent-set/union id */
  activeParentSetByChild?: Readonly<Record<PersonId, UnionId>>;
  /** Direct root-to-focus lineage used to keep its partnership visually primary. */
  primaryLineagePersonIds?: readonly PersonId[];
  /** Person relative to whom highlighted cards are direct ancestors. */
  lineageTargetPersonId?: PersonId;
  /** 0 = one fill; 1/2/3 = branches split at parents/grandparents/great-grandparents. */
  lineageGroupDepth?: FamilyTreeLineageGroupDepth;
  collapsedPersonIds?: readonly PersonId[];
  previousPositions?: readonly PreviousNodePosition[];
  cardWidth?: number;
  cardHeight?: number;
  horizontalGap?: number;
  /** Additional gap for every lineage level at which adjacent sectors diverge. */
  branchGapStep?: number;
  partnerGap?: number;
  generationGap?: number;
}

export type LayoutNodeKind =
  | "person"
  | "reference"
  | "convergence"
  | "continuation"
  | "placeholder";

export type LayoutLineageRole = "focus" | "direct-ancestor";

export interface LayoutNode {
  occurrenceId: OccurrenceId;
  personId?: PersonId;
  kind: LayoutNodeKind;
  generation: number;
  x: number;
  y: number;
  width: number;
  height: number;
  orderKey: string;
  /** Occurrence-level role; the same person may be direct in one branch and collateral in another. */
  lineageRole?: LayoutLineageRole;
  /** Zero-based palette slot for a direct ancestral sector. */
  lineageGroup?: number;
  referenceToOccurrenceId?: OccurrenceId;
  referenceReason?: "pedigree-collapse" | "already-visible" | "cycle";
  continuation?: TreeContinuation;
  placeholderLabel?: string;
  actionPersonId?: PersonId;
}

export interface LayoutUnion {
  occurrenceId: OccurrenceId;
  unionId: UnionId;
  kind: UnionKind;
  status?: PartnershipStatus;
  generation: number;
  x: number;
  y: number;
  memberOccurrenceIds: readonly OccurrenceId[];
  childOccurrenceIds: readonly OccurrenceId[];
}

export type LayoutEdgeKind =
  | "partnership"
  | "separated-partnership"
  | "union-stem"
  | "siblings-bus"
  | "biological"
  | "genetic_father"
  | "genetic_mother"
  | "gestational_parent"
  | "birth_parent"
  | "adoptive"
  | "foster"
  | "step"
  | "guardian"
  | "social_parent"
  | "legal_parent"
  | "donor"
  | "surrogate"
  | "presumed"
  | "unknown"
  | "other"
  | "continuation";

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutEdge {
  id: string;
  sourceId: OccurrenceId;
  targetId: OccurrenceId;
  unionOccurrenceId?: OccurrenceId;
  relationId?: RelationshipId;
  relationIds?: readonly RelationshipId[];
  relationshipKinds?: readonly ParentRelationshipKind[];
  kind: LayoutEdgeKind;
  points: readonly LayoutPoint[];
  label?: string;
}

export interface LayoutBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GenerationBand {
  generation: number;
  top: number;
  bottom: number;
  label: string;
}

export type LayoutWarningCode =
  | "MISSING_FOCUS"
  | "MISSING_PERSON"
  | "MISSING_UNION"
  | "CYCLE_DETECTED"
  | "GENERATION_CONFLICT"
  | "VISIBLE_BUDGET_REACHED"
  | "INVALID_COORDINATE";

export interface LayoutWarning {
  code: LayoutWarningCode;
  message: string;
  personIds?: readonly PersonId[];
  relationIds?: readonly RelationshipId[];
  unionIds?: readonly UnionId[];
}

export interface LayoutResult {
  nodes: readonly LayoutNode[];
  unions: readonly LayoutUnion[];
  edges: readonly LayoutEdge[];
  bounds: LayoutBounds;
  generationBands: readonly GenerationBand[];
  warnings: readonly LayoutWarning[];
  focusOccurrenceId?: OccurrenceId;
}

export interface FamilyTreeLayoutInput {
  graph: FamilyGraphData;
  options: FamilyTreeLayoutOptions;
}

export interface WorldViewport {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}
