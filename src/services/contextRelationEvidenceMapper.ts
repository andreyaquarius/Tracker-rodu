import type {
  ContextRelationEvidenceV2,
  ResearchGraphEntityType,
} from "../types/contextGraph.ts";

type JsonRecord = Record<string, unknown>;

export interface ContextRelationEvidenceMapContext {
  projectId: string;
  relationId: string;
}

/**
 * Maps the bounded evidence-list payload while pinning every row to the
 * project/relation requested by the caller. The list RPC intentionally omits
 * those repeated ids, while write RPCs return them on the saved row.
 */
export function mapContextRelationEvidencePage(
  value: unknown,
  context: ContextRelationEvidenceMapContext,
): ContextRelationEvidenceV2[] {
  const payload = record(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(payload.items) ? payload.items : [];
  return items
    .map((item) => mapContextRelationEvidenceV2(item, context))
    .filter((item): item is ContextRelationEvidenceV2 => item !== null && item.deletedAt === null);
}

export function mapContextRelationEvidenceV2(
  value: unknown,
  context?: ContextRelationEvidenceMapContext,
): ContextRelationEvidenceV2 | null {
  const row = record(value);
  const id = text(row.id).trim();
  const returnedProjectId = text(row.projectId ?? row.project_id).trim();
  const returnedRelationId = text(row.relationId ?? row.relation_id).trim();
  if (
    !id
    || (returnedProjectId && context && returnedProjectId !== context.projectId)
    || (returnedRelationId && context && returnedRelationId !== context.relationId)
  ) return null;
  const projectId = returnedProjectId || context?.projectId || "";
  const relationId = returnedRelationId || context?.relationId || "";
  if (!projectId || !relationId) return null;
  return {
    id,
    projectId,
    relationId,
    evidenceSource: evidenceSource(row.evidenceSource ?? row.evidence_source, Boolean(context)),
    evidenceEntityType: researchEntityType(row.evidenceEntityType ?? row.evidence_entity_type),
    evidenceEntityId: nullableText(row.evidenceEntityId ?? row.evidence_entity_id),
    citationId: nullableText(row.citationId ?? row.citation_id),
    documentFragmentId: nullableText(row.documentFragmentId ?? row.document_fragment_id),
    sourceLocator: text(row.sourceLocator ?? row.source_locator).trim(),
    excerpt: text(row.excerpt).trim(),
    notes: text(row.notes).trim(),
    metadata: record(row.metadata),
    lockVersion: positiveInteger(row.lockVersion ?? row.lock_version),
    createdAt: text(row.createdAt ?? row.created_at),
    updatedAt: text(row.updatedAt ?? row.updated_at),
    deletedAt: nullableText(row.deletedAt ?? row.deleted_at),
  };
}

function evidenceSource(
  value: unknown,
  missingIsUnknown: boolean,
): ContextRelationEvidenceV2["evidenceSource"] {
  if (value === "generic" || value === "person_v1") return value;
  return missingIsUnknown ? "unknown" : "generic";
}

function researchEntityType(value: unknown): ResearchGraphEntityType | null {
  return value === "person" || value === "family" || value === "place"
    || value === "event" || value === "document" || value === "finding"
    || value === "source" || value === "repository" || value === "hypothesis"
    ? value
    : null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim();
  return result || null;
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
