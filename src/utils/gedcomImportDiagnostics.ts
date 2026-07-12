export type GedcomImportStage =
  | "read-file"
  | "parse-file"
  | "prepare-records"
  | "people-relations"
  | "documents"
  | "findings"
  | "create-tree"
  | "archive";

const GEDCOM_IMPORT_STAGE_LABELS: Record<GedcomImportStage, string> = {
  "read-file": "читання файлу",
  "parse-file": "розбір структури GEDCOM",
  "prepare-records": "підготовка записів",
  "people-relations": "збереження осіб і родинних зв’язків",
  documents: "збереження джерел і документів",
  findings: "збереження подій і знахідок",
  "create-tree": "формування родового дерева",
  archive: "збереження сирого GEDCOM-архіву",
};

export class GedcomImportStageError extends Error {
  readonly stage: GedcomImportStage;

  constructor(stage: GedcomImportStage, detail: string, cause?: unknown) {
    const normalizedDetail = detail.trim() || "Сталася невідома помилка.";
    super(
      `GEDCOM-імпорт зупинено на етапі «${gedcomImportStageLabel(stage)}». ${normalizedDetail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "GedcomImportStageError";
    this.stage = stage;
  }
}

export function gedcomImportStageLabel(stage: GedcomImportStage): string {
  return GEDCOM_IMPORT_STAGE_LABELS[stage];
}

export function toGedcomImportStageError(
  stage: GedcomImportStage,
  error: unknown,
  describedError?: string,
): GedcomImportStageError {
  if (error instanceof GedcomImportStageError) return error;
  return new GedcomImportStageError(
    stage,
    describedError ?? errorText(error) ?? "Не вдалося завершити цей етап.",
    error,
  );
}

function errorText(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  const combined = [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim())
    .join(" ");
  return combined || null;
}
