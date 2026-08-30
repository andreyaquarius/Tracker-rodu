import type { FindingParticipant } from "../types";

/**
 * Exact participant roles that can be projected into the separate social
 * circle when both the role holder and the event's principal participant are
 * linked to canonical person cards. The Ukrainian label is intentionally part
 * of the persisted finding contract: legacy free-text roles remain readable,
 * but automatic projection only uses an unambiguous label from this list.
 */
export const findingAutoSocialRoleDefinitions = [
  { role: "Хрещений батько", relationTypeCode: "godfather" },
  { role: "Хрещена мати", relationTypeCode: "godmother" },
  { role: "Поручитель по нареченій", relationTypeCode: "sponsor_for_bride" },
  { role: "Поручитель по нареченому", relationTypeCode: "sponsor_for_groom" },
  { role: "Свідок по нареченій", relationTypeCode: "witness_for_bride" },
  { role: "Свідок по нареченому", relationTypeCode: "witness_for_groom" },
  { role: "Свідок", relationTypeCode: "event_witness" },
  { role: "Повитуха", relationTypeCode: "midwife" },
  { role: "Поручитель", relationTypeCode: "sponsor" },
  { role: "Священник", relationTypeCode: "clergy" },
  { role: "Духовна особа", relationTypeCode: "clergy" },
  { role: "Рабин", relationTypeCode: "clergy" },
  { role: "Пастор", relationTypeCode: "clergy" },
  { role: "Посадова особа", relationTypeCode: "official" },
  { role: "Автор або укладач", relationTypeCode: "official" },
  { role: "Укладач", relationTypeCode: "official" },
  { role: "Командир", relationTypeCode: "official" },
  { role: "Суддя", relationTypeCode: "official" },
  { role: "Представник", relationTypeCode: "official" },
  { role: "Особа, яка повідомила", relationTypeCode: "informant" },
  { role: "Опікун", relationTypeCode: "guardian_non_parent" },
  { role: "Наймит або служник", relationTypeCode: "servant" },
  { role: "Сусід", relationTypeCode: "neighbor" },
  { role: "Член господарства", relationTypeCode: "household_member" },
  { role: "Голова господарства", relationTypeCode: "household_head" },
  { role: "Голова двору", relationTypeCode: "household_head" },
  { role: "Голова родини", relationTypeCode: "household_head" },
] as const;

export type FindingAutoSocialRole =
  (typeof findingAutoSocialRoleDefinitions)[number]["role"];
export type FindingAutoSocialRelationTypeCode =
  (typeof findingAutoSocialRoleDefinitions)[number]["relationTypeCode"];

export interface FindingAutoSocialRoleDefinition {
  role: FindingAutoSocialRole;
  relationTypeCode: FindingAutoSocialRelationTypeCode;
}

const autoSocialRoleByLabel = new Map<string, FindingAutoSocialRoleDefinition>(
  findingAutoSocialRoleDefinitions.map((definition) => [
    normalizeText(definition.role),
    definition,
  ]),
);

/**
 * Exact legacy/source spellings accepted by the database contract. They map
 * to a canonical definition for target semantics without rewriting the role
 * text stored in the finding.
 */
const exactAutoSocialRoleAliases: Readonly<Record<string, FindingAutoSocialRole>> = {
  "хресний батько": "Хрещений батько",
  godfather: "Хрещений батько",
  "хресна мати": "Хрещена мати",
  godmother: "Хрещена мати",
  "свідок нареченої": "Свідок по нареченій",
  "свідок зі сторони нареченої": "Свідок по нареченій",
  "свідок з боку нареченої": "Свідок по нареченій",
  "witness for bride": "Свідок по нареченій",
  "bride witness": "Свідок по нареченій",
  "свідок нареченого": "Свідок по нареченому",
  "свідок зі сторони нареченого": "Свідок по нареченому",
  "свідок з боку нареченого": "Свідок по нареченому",
  "witness for groom": "Свідок по нареченому",
  "groom witness": "Свідок по нареченому",
  "поручитель нареченої": "Поручитель по нареченій",
  "поручитель зі сторони нареченої": "Поручитель по нареченій",
  "поручитель з боку нареченої": "Поручитель по нареченій",
  "sponsor for bride": "Поручитель по нареченій",
  "bride sponsor": "Поручитель по нареченій",
  "поручитель нареченого": "Поручитель по нареченому",
  "поручитель зі сторони нареченого": "Поручитель по нареченому",
  "поручитель з боку нареченого": "Поручитель по нареченому",
  "sponsor for groom": "Поручитель по нареченому",
  "groom sponsor": "Поручитель по нареченому",
};

const commonRoles = [
  "Свідок",
  "Священник",
  "Духовна особа",
  "Рабин",
  "Пастор",
  "Посадова особа",
  "Інша особа",
];

const birthRoles = [
  "Дитина",
  "Батько",
  "Мати",
  "Хрещений батько",
  "Хрещена мати",
  "Повитуха",
  ...commonRoles,
];

const marriageRoles = [
  "Наречений",
  "Наречена",
  "Батько нареченого",
  "Мати нареченого",
  "Батько нареченої",
  "Мати нареченої",
  "Поручитель по нареченій",
  "Поручитель по нареченому",
  "Свідок по нареченій",
  "Свідок по нареченому",
  "Священник",
  "Духовна особа",
  "Рабин",
  "Пастор",
  "Посадова особа",
  "Інша особа",
];

const deathRoles = [
  "Померла особа",
  "Батько",
  "Мати",
  "Чоловік або дружина",
  "Особа, яка повідомила",
  ...commonRoles,
];

const householdRoles = [
  "Голова господарства",
  "Член господарства",
  "Чоловік або дружина",
  "Син",
  "Донька",
  "Батько або мати",
  "Брат або сестра",
  "Інший родич",
  "Опікун",
  "Підопічний",
  "Наймит або служник",
  "Сусід",
  "Інша особа",
];

const rolesByType: Record<string, string[]> = {
  народження: birthRoles,
  хрещення: birthRoles,
  шлюб: marriageRoles,
  смерть: deathRoles,
  поховання: deathRoles,
  згадка: ["Згадана особа", "Родич", "Сусід", "Автор або укладач", ...commonRoles],
  "посімейний список": householdRoles,
  "погосподарська книга": householdRoles,
  ревізія: [
    "Голова двору",
    "Чоловік або дружина",
    "Син",
    "Донька",
    "Батько або мати",
    "Брат або сестра",
    "Інший родич",
    "Вибула особа",
    "Прибула особа",
    "Інша особа",
  ],
  перепис: [
    "Голова господарства",
    "Чоловік або дружина",
    "Син",
    "Донька",
    "Батько або мати",
    "Брат або сестра",
    "Опікун",
    "Підопічний",
    "Інший родич",
    "Наймит або служник",
    "Сусід",
    "Інша особа",
  ],
  інвентар: [
    "Власник",
    "Орендар",
    "Мешканець",
    "Кріпак або підданий",
    "Голова господарства",
    "Член господарства",
    "Сусід",
    "Укладач",
    "Свідок",
    "Інша особа",
  ],
  "сповідний розпис": [
    "Голова родини",
    "Чоловік або дружина",
    "Син",
    "Донька",
    "Батько або мати",
    "Брат або сестра",
    "Інший родич",
    "Духовна особа",
    "Інша особа",
  ],
  "військовий документ": [
    "Військовослужбовець",
    "Батько",
    "Мати",
    "Чоловік або дружина",
    "Командир",
    "Свідок",
    "Посадова особа",
    "Інша особа",
  ],
  "судова справа": [
    "Позивач",
    "Відповідач",
    "Потерпілий",
    "Обвинувачений",
    "Свідок",
    "Суддя",
    "Представник",
    "Інша особа",
  ],
  інше: ["Основна особа", "Родич", "Сусід", "Свідок", "Укладач", "Інша особа"],
};

export function participantRoles(findingType: string): string[] {
  return rolesByType[normalizeText(findingType)] ?? rolesByType.інше;
}

/** Returns the exact generated social relation represented by a role label. */
export function autoSocialRelationForParticipantRole(
  role: string,
): FindingAutoSocialRoleDefinition | null {
  const normalizedRole = normalizeText(role);
  const canonicalRole = exactAutoSocialRoleAliases[normalizedRole];
  return autoSocialRoleByLabel.get(
    canonicalRole ? normalizeText(canonicalRole) : normalizedRole,
  ) ?? null;
}

/**
 * Flags legacy labels that cannot safely choose one of the exact social roles.
 * Existing values are preserved, while the editor asks the user to clarify
 * them before expecting an automatic social-circle link.
 */
export function participantSocialRoleNeedsClarification(
  role: string,
  findingType = "",
): boolean {
  const normalizedRole = normalizeText(role);
  if ([
    "хрещений",
    "хресний",
    "хрещена",
    "хресна",
    "хрещений батько або мати",
    "хресний батько або мати",
    "хрещена особа",
    "хресна особа",
    "godparent",
  ].includes(normalizedRole)) {
    return true;
  }
  return findingKind(findingType) === "marriage"
    && (normalizedRole === "свідок" || normalizedRole === "поручитель");
}

/**
 * Infers an exact target only when the finding contains one unambiguous
 * participant for the selected role. Returning undefined is deliberate: the
 * UI then asks the user to choose instead of silently creating a false edge.
 */
export function suggestedContextTargetParticipantId(
  source: FindingParticipant,
  participants: readonly FindingParticipant[],
  findingType = "",
): string | undefined {
  const exact = contextTargetParticipantsForRole(source, participants, findingType);
  return exact.length === 1 ? exact[0].id : undefined;
}

/** Lists only role-compatible targets; exact roles never offer a semantically wrong person. */
export function contextTargetParticipantsForRole(
  source: FindingParticipant,
  participants: readonly FindingParticipant[],
  findingType = "",
): FindingParticipant[] {
  if (participantSocialRoleNeedsClarification(source.role, findingType)) return [];
  const definition = autoSocialRelationForParticipantRole(source.role);
  if (!definition) return [];
  return contextTargetCandidates(
    definition.relationTypeCode,
    participants.filter((participant) =>
      participant.id !== source.id &&
      (!source.personId || !participant.personId || participant.personId !== source.personId)
    ),
    findingType,
  );
}

/**
 * Validates a stored explicit target without inferring a replacement.
 *
 * Inference happens while the user selects a structured role (or accepts an AI
 * candidate) and is then stored explicitly. Serialization must remain
 * fail-closed: deleting child A may never silently retarget a godparent to
 * child B just because B became the only remaining candidate.
 */
export function resolvedContextTargetParticipantId(
  source: FindingParticipant,
  participants: readonly FindingParticipant[],
  findingType = "",
): string | undefined {
  const requested = source.contextTargetParticipantId?.trim() ?? "";
  if (!requested || requested === source.id) return undefined;
  const validTargets = contextTargetParticipantsForRole(source, participants, findingType);
  return validTargets.some((participant) => participant.id === requested)
    ? requested
    : undefined;
}

export function participantSummary(participants: FindingParticipant[], findingType = ""): string {
  return sortFindingParticipants(participants, findingType)
    .filter((participant) => participant.name.trim())
    .map((participant) => `${participant.role}: ${participant.name}`)
    .join("; ");
}

export function primaryParticipantName(participants: FindingParticipant[], findingType = ""): string {
  const primary = primaryParticipants(participants, findingType);
  return primary.map((participant) => participant.name.trim()).filter(Boolean).join(" і ");
}

export function sortFindingParticipants(
  participants: FindingParticipant[],
  findingType = "",
): FindingParticipant[] {
  return participants
    .map((participant, index) => ({ participant, index }))
    .sort((first, second) => {
      const byPriority = participantPriority(first.participant, findingType) -
        participantPriority(second.participant, findingType);
      return byPriority || first.index - second.index;
    })
    .map((item) => item.participant);
}

function primaryParticipants(
  participants: FindingParticipant[],
  findingType = "",
): FindingParticipant[] {
  const sorted = sortFindingParticipants(participants, findingType)
    .filter((participant) => participant.name.trim());
  if (!sorted.length) return [];

  if (findingKind(findingType) === "marriage") {
    const spouses = sorted.filter((participant) =>
      participantPriority(participant, findingType) <= 1
    );
    if (spouses.length) return spouses;
  }

  return [sorted[0]];
}

function participantPriority(participant: FindingParticipant, findingType: string): number {
  const role = normalizeText(participant.role);
  const kind = findingKind(findingType);
  if (!participant.name.trim()) return 1000;

  if (kind === "birth") {
    if (hasAny(role, ["дитина", "новонарод", "народжен", "охрещен"])) return 0;
    if (hasAny(role, ["батько"]) && !hasAny(role, ["хрещ", "назван", "прийом"])) return 10;
    if (hasAny(role, ["мати"]) && !hasAny(role, ["хрещ", "назван", "прийом"])) return 11;
    if (hasAny(role, ["хрещений", "хресний"])) return 20;
    if (hasAny(role, ["хрещена", "хресна"])) return 21;
    if (hasAny(role, ["повитуха"])) return 30;
    if (isOfficiantRole(role)) return 90;
    if (hasAny(role, ["свідок"])) return 80;
    return 60;
  }

  if (kind === "death") {
    if (hasAny(role, ["помер", "покійн", "похован", "померла особа"])) return 0;
    if (hasAny(role, ["чоловік", "дружина", "вдівець", "вдова"])) return 10;
    if (hasAny(role, ["батько", "мати"])) return 20;
    if (hasAny(role, ["повідом"])) return 30;
    if (isOfficiantRole(role)) return 90;
    if (hasAny(role, ["свідок"])) return 80;
    return 60;
  }

  if (kind === "marriage") {
    if (hasAny(role, ["наречений", "молодий"])) return 0;
    if (hasAny(role, ["наречена", "молода"])) return 1;
    if (hasAny(role, ["батько нареченого", "мати нареченого"])) return 20;
    if (hasAny(role, ["батько нареченої", "мати нареченої"])) return 21;
    if (hasAny(role, ["поручитель", "свідок"])) return 40;
    if (isOfficiantRole(role)) return 90;
    return 60;
  }

  if (hasAny(role, ["голова", "власник", "військовослужбовець", "позивач", "відповідач", "потерпілий", "обвинувачений", "основна особа", "згадана особа"])) return 0;
  if (hasAny(role, ["чоловік або дружина", "син", "донька", "батько або мати", "брат або сестра", "інший родич"])) return 20;
  if (isOfficiantRole(role)) return 90;
  if (hasAny(role, ["свідок"])) return 80;
  return 50;
}

function findingKind(
  findingType: string,
): "birth" | "death" | "marriage" | "household" | "other" {
  const type = normalizeText(findingType);
  if (hasAny(type, ["народ", "хрещ", "birth", "bapt"])) return "birth";
  if (hasAny(type, ["смерт", "помер", "похов", "death", "burial"])) return "death";
  if (hasAny(type, ["шлюб", "вінчан", "marriage"])) return "marriage";
  if (hasAny(type, [
    "посімейн",
    "погосподар",
    "сповід",
    "ревіз",
    "перепис",
    "інвентар",
    "household",
    "census",
    "revision",
  ])) return "household";
  return "other";
}

function contextTargetCandidates(
  relationTypeCode: FindingAutoSocialRelationTypeCode,
  participants: readonly FindingParticipant[],
  findingType: string,
): FindingParticipant[] {
  const byExactRole = (...allowedRoles: string[]) => participants.filter((participant) => {
    const role = normalizeText(participant.role);
    return allowedRoles.includes(role);
  });

  if (relationTypeCode === "godfather" || relationTypeCode === "godmother" || relationTypeCode === "midwife") {
    return byExactRole(
      "дитина",
      "новонароджений",
      "новонароджена",
      "охрещений",
      "охрещена",
      "народжений",
      "народжена",
      "child",
      "newborn",
      "baptized",
    );
  }
  if (relationTypeCode === "witness_for_bride") return byExactRole("наречена", "молода", "bride");
  if (relationTypeCode === "witness_for_groom") return byExactRole("наречений", "молодий", "groom");
  if (relationTypeCode === "sponsor_for_bride") return byExactRole("наречена", "молода", "bride");
  if (relationTypeCode === "sponsor_for_groom") return byExactRole("наречений", "молодий", "groom");
  if (relationTypeCode === "informant") {
    return byExactRole(
      "померла особа",
      "померлий",
      "померла",
      "покійний",
      "покійна",
      "похований",
      "похована",
      "deceased",
      "buried person",
    );
  }
  if (relationTypeCode === "guardian_non_parent") {
    const wards = byExactRole("підопічний", "підопічна", "ward");
    return wards.length ? wards : byExactRole("основна особа", "згадана особа", "subject");
  }
  if (relationTypeCode === "servant" || relationTypeCode === "household_member") {
    return byExactRole("голова господарства", "голова двору", "голова родини", "household head");
  }
  if (relationTypeCode === "household_head") {
    return byExactRole(
      "член господарства",
      "мешканець",
      "наймит",
      "наймит або служник",
      "служник",
      "слуга",
      "орендар",
      "household member",
      "resident",
      "servant",
      "tenant",
    );
  }

  // Clergy, officials, sponsors, generic witnesses and neighbours can apply to
  // every semantically principal person in the record. Return all of them and
  // let the caller infer only when the result contains exactly one candidate.
  // This prevents source ordering from silently selecting a plaintiff over a
  // defendant, one spouse over another, or one child over a twin.
  const kind = findingKind(findingType);
  if (kind === "birth") {
    return byExactRole(
      "дитина",
      "новонароджений",
      "новонароджена",
      "охрещений",
      "охрещена",
      "народжений",
      "народжена",
      "child",
      "newborn",
      "baptized",
    );
  }
  if (kind === "marriage") {
    return byExactRole("наречений", "молодий", "groom", "наречена", "молода", "bride");
  }
  if (kind === "death") {
    return byExactRole(
      "померла особа",
      "померлий",
      "померла",
      "покійний",
      "покійна",
      "похований",
      "похована",
      "deceased",
      "buried person",
    );
  }
  if (kind === "household") {
    return byExactRole("голова господарства", "голова двору", "голова родини", "household head");
  }
  return byExactRole(
    "основна особа",
    "згадана особа",
    "військовослужбовець",
    "позивач",
    "відповідач",
    "потерпілий",
    "обвинувачений",
    "власник",
    "орендар",
    "subject",
    "primary person",
  );
}

function isOfficiantRole(role: string): boolean {
  return hasAny(role, ["священ", "духов", "посадова", "укладач", "реєстратор", "псалом", "дяків", "суддя"]);
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase("uk").replace(/\s+/g, " ");
}
