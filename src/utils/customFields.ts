import type {
  CustomFieldDefinition,
  CustomFieldModule,
  CustomFieldValue,
  CustomFieldValues,
} from "../types";

export const customFieldModuleLabels: Record<CustomFieldModule, string> = {
  researches: "Дослідження",
  documents: "Документи",
  persons: "Особи",
  findings: "Знахідки",
  tasks: "Завдання",
  hypotheses: "Гіпотези",
  archiveRequests: "Запити в архів",
  yearMatrix: "Матриця років",
};

export function definitionsForModule(
  definitions: CustomFieldDefinition[],
  module: CustomFieldModule | string,
): CustomFieldDefinition[] {
  return definitions.filter((definition) => definition.module === module);
}

export function supportsCustomFields(module: string): module is CustomFieldModule {
  return module in customFieldModuleLabels;
}

export function normalizeCustomFieldValues(value: unknown): CustomFieldValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) =>
        typeof item === "string" ||
        typeof item === "boolean" ||
        (Array.isArray(item) && item.every((entry) =>
          typeof entry === "string" ||
          Boolean(entry && typeof entry === "object" && "id" in entry),
        )),
      )
      .map(([key, item]) => [key, item as CustomFieldValue]),
  );
}
