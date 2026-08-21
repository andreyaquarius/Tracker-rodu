import type { ZagulyakaEventRoleCode, ZagulyakaEventType } from "../types/zagulyaky";

export interface ZagulyakaEventRoleOption {
  code: ZagulyakaEventRoleCode;
  label: string;
  requiresCustomText: boolean;
}

const missingRoleLabel = "Роль у події не вказана";

/**
 * Labels are deliberately independent from the stored codes so that changing
 * wording later does not change previously saved data. In particular, there
 * is one gender-neutral `witness` role for all people: «Свідок».
 */
export const zagulyakaEventRoleLabels: Readonly<Record<ZagulyakaEventRoleCode, string>> = {
  subject: "Основна особа",
  newborn: "Новонароджений",
  baptized: "Охрещений",
  groom: "Наречений",
  bride: "Наречена",
  pledger: "Поручитель / шафер",
  groom_father: "Батько нареченого",
  groom_mother: "Мати нареченого",
  bride_father: "Батько нареченої",
  bride_mother: "Мати нареченої",
  deceased: "Померлий",
  resident: "Мешканець",
  household_head: "Голова господарства",
  household_member: "Член господарства",
  military_person: "Військовослужбовець",
  migrant: "Переселенець",
  godparent: "Хрещений батько або мати",
  godchild: "Хрещеник",
  father: "Батько",
  mother: "Мати",
  parent: "Один із батьків",
  child: "Дитина",
  spouse: "Чоловік або дружина",
  witness: "Свідок",
  officiant: "Священнослужитель",
  registrar: "Реєстратор",
  midwife: "Повитуха",
  informant: "Повідомник",
  owner: "Власник",
  commander: "Командир",
  official: "Посадова особа",
  other: "Інша роль",
};

const role = (code: ZagulyakaEventRoleCode): ZagulyakaEventRoleOption => ({
  code,
  label: zagulyakaEventRoleLabels[code],
  requiresCustomText: code === "other",
});

const roles = (...codes: ZagulyakaEventRoleCode[]): readonly ZagulyakaEventRoleOption[] => codes.map(role);

/**
 * The selector is event-specific, while `subject` remains available everywhere
 * to keep legacy records editable without exposing the raw stored code.
 */
export const zagulyakaEventRoleOptionsByEvent: Readonly<
  Record<ZagulyakaEventType, readonly ZagulyakaEventRoleOption[]>
> = {
  birth: roles("subject", "newborn", "father", "mother", "midwife", "informant", "registrar", "witness", "other"),
  baptism: roles("subject", "baptized", "father", "mother", "godparent", "officiant", "witness", "other"),
  marriage: roles(
    "subject",
    "groom",
    "bride",
    "pledger",
    "groom_father",
    "groom_mother",
    "bride_father",
    "bride_mother",
    "father",
    "mother",
    "parent",
    "witness",
    "officiant",
    "registrar",
    "other",
  ),
  death: roles("subject", "deceased", "spouse", "father", "mother", "parent", "child", "informant", "officiant", "witness", "other"),
  burial: roles("subject", "deceased", "spouse", "parent", "child", "informant", "officiant", "witness", "other"),
  residence: roles("subject", "resident", "household_head", "household_member", "owner", "official", "witness", "other"),
  census: roles("subject", "household_head", "household_member", "owner", "official", "witness", "other"),
  military: roles("subject", "military_person", "commander", "official", "witness", "other"),
  migration: roles("subject", "migrant", "spouse", "parent", "child", "official", "witness", "other"),
  witness: roles("subject", "witness", "official", "other"),
  godparent: roles("subject", "godparent", "godchild", "father", "mother", "officiant", "witness", "other"),
  other: roles("subject", "parent", "child", "spouse", "witness", "official", "other"),
};

/**
 * Maps prior structural and display-style role values to the stable catalogue
 * where that can be done without guessing. Unknown values intentionally fall
 * back to an empty code rather than leaking a raw implementation value to UI.
 */
const legacyRoleAliases: Readonly<Record<string, ZagulyakaEventRoleCode>> = {
  subject: "subject",
  primary: "subject",
  main: "subject",
  person: "subject",
  participant: "subject",
  custom: "other",
  "свідок": "witness",
  "наречений": "groom",
  "наречена": "bride",
};

export function normalizeZagulyakaEventRoleCode(
  input: string | null | undefined,
): ZagulyakaEventRoleCode | "" {
  const candidate = String(input ?? "").trim().toLocaleLowerCase("uk");
  if (!candidate) return "";

  if (Object.prototype.hasOwnProperty.call(zagulyakaEventRoleLabels, candidate)) {
    return candidate as ZagulyakaEventRoleCode;
  }

  return legacyRoleAliases[candidate] ?? "";
}

/** Returns the supported roles for an event, or the safe generic set before an event is selected. */
export function zagulyakaEventRoleOptions(
  eventType: ZagulyakaEventType | string | null | undefined,
): readonly ZagulyakaEventRoleOption[] {
  const candidate = String(eventType ?? "").trim();
  if (Object.prototype.hasOwnProperty.call(zagulyakaEventRoleOptionsByEvent, candidate)) {
    return zagulyakaEventRoleOptionsByEvent[candidate as ZagulyakaEventType];
  }

  return zagulyakaEventRoleOptionsByEvent.other;
}

export function isZagulyakaEventRoleAllowed(
  eventType: ZagulyakaEventType | string | null | undefined,
  eventRoleCode: ZagulyakaEventRoleCode | string | null | undefined,
): boolean {
  const code = normalizeZagulyakaEventRoleCode(eventRoleCode);
  return Boolean(code) && zagulyakaEventRoleOptions(eventType).some((option) => option.code === code);
}

/**
 * Converts a persisted role into user-facing copy. An unrecognised or absent
 * legacy role never reaches the public UI as a raw database value.
 */
export function zagulyakaEventRoleLabel(
  eventRoleCode: ZagulyakaEventRoleCode | string | null | undefined,
  eventRoleCustomText?: string | null,
): string {
  const code = normalizeZagulyakaEventRoleCode(eventRoleCode);
  const customText = String(eventRoleCustomText ?? "").trim();

  if (code === "other") return customText || zagulyakaEventRoleLabels.other;
  if (code) return zagulyakaEventRoleLabels[code];
  return customText || missingRoleLabel;
}

export const zagulyakaMissingEventRoleLabel = missingRoleLabel;
