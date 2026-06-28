import type { FindingParticipant } from "../types";

const commonRoles = ["Свідок", "Священник", "Інша особа"];

const rolesByType: Record<string, string[]> = {
  народження: [
    "Дитина",
    "Батько",
    "Мати",
    "Хрещений батько",
    "Хрещена мати",
    "Повитуха",
    ...commonRoles,
  ],
  шлюб: [
    "Наречений",
    "Наречена",
    "Батько нареченого",
    "Мати нареченого",
    "Батько нареченої",
    "Мати нареченої",
    "Поручитель",
    ...commonRoles,
  ],
  смерть: [
    "Померла особа",
    "Батько",
    "Мати",
    "Чоловік або дружина",
    "Особа, яка повідомила",
    ...commonRoles,
  ],
  згадка: ["Згадана особа", "Родич", "Автор або укладач", ...commonRoles],
  "посімейний список": [
    "Голова господарства",
    "Чоловік або дружина",
    "Син",
    "Донька",
    "Батько або мати",
    "Брат або сестра",
    "Інший родич",
    "Наймит або служник",
    "Інша особа",
  ],
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
    "Інша особа",
  ],
  інвентар: [
    "Власник",
    "Орендар",
    "Мешканець",
    "Кріпак або підданий",
    "Голова господарства",
    "Член господарства",
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
  інше: ["Основна особа", "Родич", "Свідок", "Укладач", "Інша особа"],
};

export function participantRoles(findingType: string): string[] {
  return rolesByType[findingType] ?? rolesByType.інше;
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

function findingKind(findingType: string): "birth" | "death" | "marriage" | "other" {
  const type = normalizeText(findingType);
  if (hasAny(type, ["народ", "хрещ", "birth", "bapt"])) return "birth";
  if (hasAny(type, ["смерт", "помер", "похов", "death", "burial"])) return "death";
  if (hasAny(type, ["шлюб", "вінчан", "marriage"])) return "marriage";
  return "other";
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
