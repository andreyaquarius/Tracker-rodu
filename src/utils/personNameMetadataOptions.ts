export interface PersonNameMetadataOption {
  value: string;
  label: string;
}

/**
 * Frequently encountered languages in Ukrainian and neighbouring historical
 * records. Values use stable ISO 639 / BCP 47 language codes so existing data
 * and GEDCOM imports remain interoperable.
 */
export const PERSON_NAME_LANGUAGE_OPTIONS: readonly PersonNameMetadataOption[] = [
  { value: "uk", label: "Українська" },
  { value: "cu", label: "Церковнослов’янська" },
  { value: "ru", label: "Російська" },
  { value: "pl", label: "Польська" },
  { value: "la", label: "Латинська" },
  { value: "be", label: "Білоруська" },
  { value: "de", label: "Німецька" },
  { value: "yi", label: "Їдиш" },
  { value: "he", label: "Іврит" },
  { value: "ro", label: "Румунська" },
  { value: "hu", label: "Угорська" },
  { value: "cs", label: "Чеська" },
  { value: "sk", label: "Словацька" },
  { value: "bg", label: "Болгарська" },
  { value: "el", label: "Грецька" },
  { value: "lt", label: "Литовська" },
];

export function personNameLanguageLabel(code: string): string {
  return metadataLabel(PERSON_NAME_LANGUAGE_OPTIONS, code);
}

export function isKnownPersonNameLanguageCode(code: string): boolean {
  return hasMetadataCode(PERSON_NAME_LANGUAGE_OPTIONS, code);
}

function metadataLabel(options: readonly PersonNameMetadataOption[], code: string): string {
  if (!code) return "";
  return options.find((option) => option.value === code)?.label ?? code;
}

function hasMetadataCode(options: readonly PersonNameMetadataOption[], code: string): boolean {
  return options.some((option) => option.value === code);
}
