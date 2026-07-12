import type {
  PersonRelation,
  PersonRelationStatus,
  PersonRelationType,
} from "../types";
import { repairMojibakeText } from "./mojibake.ts";

export const PERSON_RELATION_TYPES: readonly PersonRelationType[] = [
  "батько",
  "мати",
  "батько або мати",
  "чоловік",
  "дружина",
  "подружжя",
  "дитина",
  "син",
  "донька",
  "брат",
  "сестра",
  "брат або сестра",
  "хрещений",
  "хрещена",
  "хрещеник",
  "хрещениця",
  "вітчим",
  "мачуха",
  "пасинок",
  "падчерка",
  "опікун",
  "підопічний",
  "усиновлювач",
  "усиновлена дитина",
  "свідок",
  "поручитель",
  "священник",
  "духовна особа",
  "посадова особа",
  "повитуха",
  "особа, яка повідомила",
  "голова господарства",
  "член господарства",
  "наймит або служник",
  "родич",
  "інше",
];

const RELATION_TYPE_SET = new Set<string>(PERSON_RELATION_TYPES);
const RELATION_STATUS_ALIASES: Readonly<Record<string, PersonRelationStatus>> = {
  "доведено": "доведено",
  "доведена": "доведено",
  proven: "доведено",
  "імовірно": "імовірно",
  "частково доведена": "імовірно",
  likely: "імовірно",
  "гіпотеза": "гіпотеза",
  "гіпотетична": "гіпотеза",
  hypothetical: "гіпотеза",
  "сумнівно": "сумнівно",
  "сумнівна": "сумнівно",
  disputed: "сумнівно",
  "спростовано": "спростовано",
  "спростована": "спростовано",
  disproven: "спростовано",
};

export function normalizePersonRelationType(value: unknown): PersonRelationType {
  const normalized = repairMojibakeText(value).trim().toLocaleLowerCase("uk");
  return RELATION_TYPE_SET.has(normalized)
    ? (normalized as PersonRelationType)
    : "інше";
}

export function normalizePersonRelationStatus(
  value: unknown,
): PersonRelationStatus {
  const normalized = repairMojibakeText(value).trim().toLocaleLowerCase("uk");
  return RELATION_STATUS_ALIASES[normalized] ?? "гіпотеза";
}

export function normalizePersonRelation(
  relation: PersonRelation,
): PersonRelation {
  return {
    ...relation,
    relationType: normalizePersonRelationType(relation.relationType),
    status: normalizePersonRelationStatus(relation.status),
    evidenceText: repairMojibakeText(relation.evidenceText),
    notes: repairMojibakeText(relation.notes),
  };
}
