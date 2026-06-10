import type {
  CustomFieldDefinition,
  CustomSectionDefinition,
  CustomSectionField,
  CustomSectionRecord,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";

type DefinitionRow = {
  id: string;
  module_key: string;
  label: string;
  field_type: string;
  options: unknown;
  relation_target: string | null;
};

type SectionRow = {
  id: string;
  parent_key: string | null;
  name: string;
  singular_name: string;
  description: string;
  icon: string;
  title_field_id: string | null;
  created_at: string;
  updated_at: string;
};

type FieldRow = {
  id: string;
  section_id: string;
  label: string;
  field_type: string;
  options: unknown;
  relation_target: string | null;
  required: boolean;
  position: number;
};

type RecordRow = {
  id: string;
  section_id: string;
  values: unknown;
  created_at: string;
  updated_at: string;
};

function asOptions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asValues(value: unknown): CustomSectionRecord["values"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as CustomSectionRecord["values"];
}

function definitionFromRow(row: DefinitionRow): CustomFieldDefinition {
  return {
    id: row.id,
    module: row.module_key as CustomFieldDefinition["module"],
    label: row.label,
    type: row.field_type as CustomFieldDefinition["type"],
    options: asOptions(row.options),
    relationTarget:
      (row.relation_target as CustomFieldDefinition["relationTarget"]) ?? undefined,
  };
}

function fieldFromRow(row: FieldRow): CustomSectionField {
  return {
    id: row.id,
    label: row.label,
    type: row.field_type as CustomSectionField["type"],
    options: asOptions(row.options),
    relationTarget:
      (row.relation_target as CustomSectionField["relationTarget"]) ?? undefined,
    required: row.required,
  };
}

function sectionFromRow(row: SectionRow, fields: CustomSectionField[]): CustomSectionDefinition {
  return {
    id: row.id,
    parentKey: row.parent_key as CustomSectionDefinition["parentKey"],
    name: row.name,
    singularName: row.singular_name,
    description: row.description,
    icon: row.icon,
    titleFieldId: row.title_field_id ?? fields[0]?.id ?? "",
    fields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordFromRow(row: RecordRow): CustomSectionRecord {
  return {
    id: row.id,
    sectionId: row.section_id,
    values: asValues(row.values),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProjectCustomStructure(projectId: string): Promise<{
  definitions: CustomFieldDefinition[];
  sections: CustomSectionDefinition[];
  records: CustomSectionRecord[];
}> {
  const client = getSupabaseClient();
  const [definitionsResult, sectionsResult, fieldsResult, recordsResult] =
    await Promise.all([
      client
        .from("custom_field_definitions")
        .select("id, module_key, label, field_type, options, relation_target")
        .eq("project_id", projectId)
        .order("position", { ascending: true }),
      client
        .from("custom_sections")
        .select("id, parent_key, name, singular_name, description, icon, title_field_id, created_at, updated_at")
        .eq("project_id", projectId)
        .order("position", { ascending: true }),
      client
        .from("custom_section_fields")
        .select("id, section_id, label, field_type, options, relation_target, required, position")
        .eq("project_id", projectId)
        .order("position", { ascending: true }),
      client
        .from("custom_records")
        .select("id, section_id, values, created_at, updated_at")
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false }),
    ]);
  if (definitionsResult.error) throw definitionsResult.error;
  if (sectionsResult.error) throw sectionsResult.error;
  if (fieldsResult.error) throw fieldsResult.error;
  if (recordsResult.error) throw recordsResult.error;

  const fieldsBySection = new Map<string, CustomSectionField[]>();
  for (const row of fieldsResult.data as FieldRow[]) {
    fieldsBySection.set(row.section_id, [
      ...(fieldsBySection.get(row.section_id) ?? []),
      fieldFromRow(row),
    ]);
  }
  return {
    definitions: (definitionsResult.data as DefinitionRow[]).map(definitionFromRow),
    sections: (sectionsResult.data as SectionRow[]).map((row) =>
      sectionFromRow(row, fieldsBySection.get(row.id) ?? []),
    ),
    records: (recordsResult.data as RecordRow[]).map(recordFromRow),
  };
}

export async function saveProjectCustomFieldDefinition(
  projectId: string,
  definition: CustomFieldDefinition,
  position = 0,
): Promise<void> {
  const { error } = await getSupabaseClient().from("custom_field_definitions").upsert(
    {
      id: definition.id,
      project_id: projectId,
      module_key: definition.module,
      label: definition.label,
      field_type: definition.type,
      options: definition.options,
      relation_target: definition.relationTarget ?? null,
      required: false,
      position,
    },
    { onConflict: "id" },
  );
  if (error) throw error;
}

export async function saveProjectCustomSection(
  projectId: string,
  section: CustomSectionDefinition,
  position = 0,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from("custom_sections").upsert(
    {
      id: section.id,
      project_id: projectId,
      parent_key: section.parentKey,
      name: section.name,
      singular_name: section.singularName,
      description: section.description,
      icon: section.icon,
      title_field_id: section.titleFieldId || null,
      position,
      created_at: section.createdAt,
      updated_at: section.updatedAt,
    },
    { onConflict: "id" },
  );
  if (error) throw error;

  const fieldIds = section.fields.map((field) => field.id);
  const existing = await client
    .from("custom_section_fields")
    .select("id")
    .eq("project_id", projectId)
    .eq("section_id", section.id);
  if (existing.error) throw existing.error;
  const removedIds = (existing.data as Array<{ id: string }>)
    .map((item) => item.id)
    .filter((id) => !fieldIds.includes(id));
  if (removedIds.length) {
    const removed = await client
      .from("custom_section_fields")
      .delete()
      .eq("project_id", projectId)
      .in("id", removedIds);
    if (removed.error) throw removed.error;
  }
  if (section.fields.length) {
    const fields = await client.from("custom_section_fields").upsert(
      section.fields.map((field, index) => ({
        id: field.id,
        project_id: projectId,
        section_id: section.id,
        label: field.label,
        field_type: field.type,
        options: field.options,
        relation_target: field.relationTarget ?? null,
        required: field.required,
        position: index,
      })),
      { onConflict: "id" },
    );
    if (fields.error) throw fields.error;
  }
}

export async function deleteProjectCustomSection(
  projectId: string,
  sectionId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("custom_sections")
    .delete()
    .eq("project_id", projectId)
    .eq("id", sectionId);
  if (error) throw error;
}

export async function saveProjectCustomRecord(
  projectId: string,
  record: CustomSectionRecord,
  title: string,
): Promise<void> {
  const { error } = await getSupabaseClient().from("custom_records").upsert(
    {
      id: record.id,
      project_id: projectId,
      section_id: record.sectionId,
      title,
      values: record.values,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
    { onConflict: "id" },
  );
  if (error) throw error;
}

export async function deleteProjectCustomRecord(
  projectId: string,
  recordId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("custom_records")
    .delete()
    .eq("project_id", projectId)
    .eq("id", recordId);
  if (error) throw error;
}

export async function importProjectCustomStructure(
  projectId: string,
  definitions: CustomFieldDefinition[],
  sections: CustomSectionDefinition[],
  records: CustomSectionRecord[],
): Promise<void> {
  for (const [index, definition] of definitions.entries()) {
    await saveProjectCustomFieldDefinition(projectId, definition, index);
  }
  for (const [index, section] of sections.entries()) {
    await saveProjectCustomSection(projectId, section, index);
  }
  const sectionMap = new Map(sections.map((section) => [section.id, section]));
  for (const record of records) {
    const section = sectionMap.get(record.sectionId);
    const value = section ? record.values[section.titleFieldId] : "";
    const title = typeof value === "string" ? value : section?.singularName ?? "Запис";
    await saveProjectCustomRecord(projectId, record, title || "Запис");
  }
}

const CACHE_PREFIX = "tracker-rodu-project-custom-structure:";

export function loadProjectCustomStructureCache(projectId: string) {
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${projectId}`);
    if (!stored) return { definitions: [], sections: [], records: [] };
    return JSON.parse(stored) as {
      definitions: CustomFieldDefinition[];
      sections: CustomSectionDefinition[];
      records: CustomSectionRecord[];
    };
  } catch {
    return { definitions: [], sections: [], records: [] };
  }
}

export function saveProjectCustomStructureCache(
  projectId: string,
  definitions: CustomFieldDefinition[],
  sections: CustomSectionDefinition[],
  records: CustomSectionRecord[],
): void {
  localStorage.setItem(
    `${CACHE_PREFIX}${projectId}`,
    JSON.stringify({ definitions, sections, records }),
  );
}

export function clearProjectCustomStructureCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
