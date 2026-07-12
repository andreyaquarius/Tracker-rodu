import type { PersonGender } from "../types";
import { repairMojibakeText } from "./mojibake.ts";

const GENDER_ALIASES: Readonly<Record<string, PersonGender>> = {
  "чоловік": "чоловік",
  "чоловіча": "чоловік",
  male: "чоловік",
  man: "чоловік",
  m: "чоловік",
  "жінка": "жінка",
  "жіноча": "жінка",
  female: "жінка",
  woman: "жінка",
  f: "жінка",
  "невідомо": "невідомо",
  unknown: "невідомо",
  other: "невідомо",
  u: "невідомо",
};

export function normalizePersonGender(value: unknown): PersonGender {
  const normalized = repairMojibakeText(value).trim().toLocaleLowerCase("uk");
  return GENDER_ALIASES[normalized] ?? "невідомо";
}
