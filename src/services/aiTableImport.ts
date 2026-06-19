import type { CollectionKey } from "../types";
import { getSupabaseClient } from "./supabaseAuth";

export interface AiImportFieldSchema {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
}

export interface AiSourceRow {
  sourceRowNumber: number;
  values: Record<string, unknown>;
}

export interface AiTableImportRequest {
  projectId?: string;
  collection: CollectionKey;
  title: string;
  fileName?: string;
  sourceHeaders: string[];
  fields: AiImportFieldSchema[];
  rows: AiSourceRow[];
  mode?: "fast" | "detailed";
}

export interface AiImportRowResult {
  sourceRowNumber: number;
  data: Record<string, unknown>;
  warnings: string[];
  confidence?: number;
}

export interface AiTableImportResult {
  rows: AiImportRowResult[];
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
    throw new Error(readableAiImportFunctionError(error));
  }
  if (data?.error) throw new Error(String(data.error));
  const rows: AiImportRowResult[] = Array.isArray(data?.rows)
    ? data.rows.map((row: unknown) => normalizeImportRow(row))
    : [];
  const records = rows.length
    ? rows.map((row) => row.data)
    : Array.isArray(data?.records) ? data.records : [];
  return {
    rows,
    records,
    warnings: Array.isArray(data?.warnings) ? data.warnings.map(String) : [],
    summary: String(data?.summary ?? ""),
  };
}

function normalizeImportRow(value: unknown): AiImportRowResult {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : {};
  const sourceRowNumber = Number(record.sourceRowNumber);
  return {
    sourceRowNumber: Number.isFinite(sourceRowNumber) ? sourceRowNumber : 0,
    data,
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
    confidence: typeof record.confidence === "number" ? record.confidence : undefined,
  };
}

function readableAiImportFunctionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("Failed to send a request to the Edge Function")) {
    return "Не вдалося під’єднатися до Edge Function analyze-table-import. Перевірте, що вона задеплоєна в Supabase, а в GitHub Actions задані SUPABASE_ACCESS_TOKEN і SUPABASE_PROJECT_REF. Після деплою оновіть сторінку та спробуйте ще раз.";
  }
  return message || "Не вдалося викликати Edge Function analyze-table-import.";
}
