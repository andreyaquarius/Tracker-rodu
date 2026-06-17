import type { CollectionKey } from "../types";
import { getSupabaseClient } from "./supabaseAuth";

export interface AiImportFieldSchema {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
}

export interface AiTableImportRequest {
  projectId?: string;
  collection: CollectionKey;
  title: string;
  fields: AiImportFieldSchema[];
  rows: Record<string, unknown>[];
  mode?: "fast" | "detailed";
}

export interface AiTableImportResult {
  records: Record<string, unknown>[];
  warnings: string[];
  summary: string;
}

export async function analyzeTableImportWithAi(
  input: AiTableImportRequest,
): Promise<AiTableImportResult> {
  const { data, error } = await getSupabaseClient().functions.invoke("analyze-table-import", {
    body: input,
  });
  if (error) {
    const context = "context" in error ? error.context : null;
    if (context instanceof Response) {
      try {
        const payload = await context.clone().json() as { error?: string };
        if (payload.error) throw new Error(payload.error);
      } catch (contextError) {
        if (contextError instanceof Error && contextError.message !== "Unexpected end of JSON input") {
          throw contextError;
        }
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(String(data.error));
  return {
    records: Array.isArray(data?.records) ? data.records : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings.map(String) : [],
    summary: String(data?.summary ?? ""),
  };
}
