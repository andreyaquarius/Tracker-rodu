import { getSupabaseClient } from "./supabaseAuth";

export class ProjectRecordConflictError extends Error {
  constructor() {
    super(
      "Цей запис уже змінив інший учасник. Дані оновлено з бази; відкрийте запис повторно та внесіть зміни ще раз.",
    );
    this.name = "ProjectRecordConflictError";
  }
}

export async function assertProjectRecordUnchanged(
  table: string,
  projectId: string,
  recordId: string,
  expectedUpdatedAt?: string,
): Promise<void> {
  if (!expectedUpdatedAt) return;
  const { data, error } = await getSupabaseClient()
    .from(table)
    .select("updated_at")
    .eq("project_id", projectId)
    .eq("id", recordId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.updated_at !== expectedUpdatedAt) {
    throw new ProjectRecordConflictError();
  }
}
