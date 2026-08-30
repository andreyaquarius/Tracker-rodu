import test from "node:test";
import assert from "node:assert/strict";
import {
  autoSocialRelationForParticipantRole,
  contextTargetParticipantsForRole,
  participantRoles,
  participantSocialRoleNeedsClarification,
  participantSummary,
  primaryParticipantName,
  resolvedContextTargetParticipantId,
  sortFindingParticipants,
  suggestedContextTargetParticipantId,
} from "../src/utils/findingParticipants.ts";
import type { FindingParticipant } from "../src/types/index.ts";

const birthParticipants: FindingParticipant[] = [
  { id: "priest", role: "Священник", name: "Петро Компаневич", notes: "" },
  { id: "father", role: "Батько", name: "Іван Гурський", notes: "" },
  { id: "mother", role: "Мати", name: "Євдокія Гурська", notes: "" },
  { id: "child", role: "Дитина", name: "Григорій Гурський", notes: "" },
];

test("uses newborn as primary participant in birth findings", () => {
  assert.equal(primaryParticipantName(birthParticipants, "народження"), "Григорій Гурський");
  assert.deepEqual(
    sortFindingParticipants(birthParticipants, "народження").map((participant) => participant.id),
    ["child", "father", "mother", "priest"],
  );
  assert.match(participantSummary(birthParticipants, "народження"), /^Дитина: Григорій Гурський/);
});

test("uses deceased person as primary participant in death findings", () => {
  const participants: FindingParticipant[] = [
    { id: "priest", role: "Священник", name: "Отець Іван", notes: "" },
    { id: "deceased", role: "Померла особа", name: "Марія Коваль", notes: "" },
  ];
  assert.equal(primaryParticipantName(participants, "смерть"), "Марія Коваль");
});

test("uses both spouses as primary participants in marriage findings", () => {
  const participants: FindingParticipant[] = [
    { id: "witness", role: "Свідок", name: "Петро Свідок", notes: "" },
    { id: "bride", role: "Наречена", name: "Анна Коваль", notes: "" },
    { id: "groom", role: "Наречений", name: "Іван Шевченко", notes: "" },
  ];
  assert.equal(primaryParticipantName(participants, "шлюб"), "Іван Шевченко і Анна Коваль");
});

test("finding roles expose exact social roles instead of an ambiguous wedding witness", () => {
  const marriageRoles = participantRoles(" ШЛЮБ ");
  assert.equal(marriageRoles.includes("Свідок по нареченій"), true);
  assert.equal(marriageRoles.includes("Свідок по нареченому"), true);
  assert.equal(marriageRoles.includes("Поручитель по нареченій"), true);
  assert.equal(marriageRoles.includes("Поручитель по нареченому"), true);
  assert.equal(marriageRoles.includes("Поручитель"), false);
  assert.equal(marriageRoles.includes("Свідок"), false);
  assert.deepEqual(
    autoSocialRelationForParticipantRole(" Хрещена мати "),
    { role: "Хрещена мати", relationTypeCode: "godmother" },
  );
  assert.equal(autoSocialRelationForParticipantRole("Свідок")?.relationTypeCode, "event_witness");
  assert.equal(autoSocialRelationForParticipantRole("Рабин")?.relationTypeCode, "clergy");
  assert.equal(autoSocialRelationForParticipantRole("Пастор")?.relationTypeCode, "clergy");
  assert.equal(participantSocialRoleNeedsClarification("Свідок", "шлюб"), true);
  assert.equal(participantSocialRoleNeedsClarification("Поручитель", "шлюб"), true);
  assert.equal(participantSocialRoleNeedsClarification("Свідок", "народження"), false);
  for (const legacyGodparent of [
    "Хрещений",
    "Хресний",
    "Хрещена",
    "Хресна",
    "Хрещена особа",
    "godparent",
  ]) {
    assert.equal(participantSocialRoleNeedsClarification(legacyGodparent, "хрещення"), true);
  }
});

test("exact finding roles infer only one safe social-circle target", () => {
  const participants: FindingParticipant[] = [
    { id: "child", personId: "person-child", role: "Дитина", name: "Петро", notes: "" },
    { id: "godmother", personId: "person-godmother", role: "Хрещена мати", name: "Ганна", notes: "" },
  ];
  assert.equal(
    suggestedContextTargetParticipantId(participants[1], participants, "хрещення"),
    "child",
  );
  assert.equal(
    resolvedContextTargetParticipantId(participants[1], participants, "хрещення"),
    undefined,
  );

  const ambiguous = [
    ...participants,
    { id: "child-2", personId: "person-child-2", role: "Дитина", name: "Марія", notes: "" },
  ];
  assert.equal(
    suggestedContextTargetParticipantId(ambiguous[1], ambiguous, "хрещення"),
    undefined,
  );
  assert.equal(
    resolvedContextTargetParticipantId(
      { ...ambiguous[1], contextTargetParticipantId: "child-2" },
      ambiguous,
      "хрещення",
    ),
    "child-2",
  );
});

test("exact witness roles never offer the wrong spouse as a target", () => {
  const participants: FindingParticipant[] = [
    { id: "groom", personId: "person-groom", role: "Наречений", name: "Іван", notes: "" },
    { id: "bride", personId: "person-bride", role: "Наречена", name: "Ганна", notes: "" },
    {
      id: "bride-witness",
      personId: "person-witness",
      contextTargetParticipantId: "groom",
      role: "Свідок по нареченій",
      name: "Олена",
      notes: "",
    },
  ];
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[2], participants, "шлюб").map((item) => item.id),
    ["bride"],
  );
  assert.equal(
    resolvedContextTargetParticipantId(participants[2], participants, "шлюб"),
    undefined,
  );
});

test("exact sponsor roles never offer the wrong spouse as a target", () => {
  const participants: FindingParticipant[] = [
    { id: "groom", personId: "person-groom", role: "Наречений", name: "Іван", notes: "" },
    { id: "bride", personId: "person-bride", role: "Наречена", name: "Ганна", notes: "" },
    {
      id: "bride-sponsor",
      personId: "person-sponsor-a",
      contextTargetParticipantId: "groom",
      role: "Поручитель по нареченій",
      name: "Олена",
      notes: "",
    },
    {
      id: "groom-sponsor",
      personId: "person-sponsor-b",
      contextTargetParticipantId: "bride",
      role: "Поручитель по нареченому",
      name: "Петро",
      notes: "",
    },
  ];

  assert.equal(
    autoSocialRelationForParticipantRole("Поручитель по нареченій")?.relationTypeCode,
    "sponsor_for_bride",
  );
  assert.equal(
    autoSocialRelationForParticipantRole("Поручитель по нареченому")?.relationTypeCode,
    "sponsor_for_groom",
  );
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[2], participants, "шлюб").map((item) => item.id),
    ["bride"],
  );
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[3], participants, "шлюб").map((item) => item.id),
    ["groom"],
  );
  assert.equal(resolvedContextTargetParticipantId(participants[2], participants, "шлюб"), undefined);
  assert.equal(resolvedContextTargetParticipantId(participants[3], participants, "шлюб"), undefined);
});

test("a social role cannot target another participant row linked to the same person card", () => {
  const participants: FindingParticipant[] = [
    { id: "child", personId: "person-shared", role: "Дитина", name: "Марія", notes: "" },
    {
      id: "godmother",
      personId: "person-shared",
      role: "Хрещена мати",
      name: "Марія в іншому рядку",
      notes: "",
      contextTargetParticipantId: "child",
    },
  ];
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[1], participants, "хрещення"),
    [],
  );
  assert.equal(
    resolvedContextTargetParticipantId(participants[1], participants, "хрещення"),
    undefined,
  );
});

test("generic event witnesses stay fail-closed for marriage but target non-marriage principals", () => {
  const participants: FindingParticipant[] = [
    { id: "plaintiff", role: "Позивач", name: "Іван", notes: "" },
    { id: "witness", role: "Свідок", name: "Петро", notes: "" },
  ];
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[1], participants, "судова справа")
      .map((participant) => participant.id),
    ["plaintiff"],
  );
  assert.deepEqual(
    contextTargetParticipantsForRole(
      { ...participants[1], contextTargetParticipantId: "plaintiff" },
      [
        { id: "bride", role: "Наречена", name: "Ганна", notes: "" },
        { ...participants[1], contextTargetParticipantId: "bride" },
      ],
      "шлюб",
    ),
    [],
  );
});

test("context target inference fails closed when a record has several principal people", () => {
  const participants: FindingParticipant[] = [
    { id: "plaintiff", personId: "person-plaintiff", role: "Позивач", name: "Іван", notes: "" },
    { id: "defendant", personId: "person-defendant", role: "Відповідач", name: "Петро", notes: "" },
    { id: "official", personId: "person-official", role: "Посадова особа", name: "Суддя", notes: "" },
  ];
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[2], participants, "судова справа")
      .map((participant) => participant.id),
    ["plaintiff", "defendant"],
  );
  assert.equal(
    suggestedContextTargetParticipantId(participants[2], participants, "судова справа"),
    undefined,
  );
});

test("household head targets only explicit household-context roles", () => {
  const participants: FindingParticipant[] = [
    { id: "head", role: "Голова господарства", name: "Іван", notes: "" },
    { id: "member", role: "Член господарства", name: "Петро", notes: "" },
    { id: "servant", role: "Наймит або служник", name: "Михайло", notes: "" },
    { id: "son", role: "Син", name: "Степан", notes: "" },
  ];
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[0], participants, "погосподарська книга")
      .map((participant) => participant.id),
    ["member", "servant"],
  );
});

test("every structured dropdown role projected by the database has a UI definition", () => {
  const expectedOfficialRoles = [
    "Посадова особа",
    "Автор або укладач",
    "Укладач",
    "Командир",
    "Суддя",
    "Представник",
  ];
  for (const role of expectedOfficialRoles) {
    assert.equal(autoSocialRelationForParticipantRole(role)?.relationTypeCode, "official");
  }
  assert.equal(
    autoSocialRelationForParticipantRole("Голова родини")?.relationTypeCode,
    "household_head",
  );
  for (const familyOrCatchAllRole of ["Батько", "Мати", "Дитина", "Інша особа"]) {
    assert.equal(autoSocialRelationForParticipantRole(familyOrCatchAllRole), null);
  }
});

test("exact legacy social-role aliases reuse canonical semantics without rewriting labels", () => {
  const fixtures = [
    ["Хресний батько", "godfather", "Хрещений батько"],
    ["godfather", "godfather", "Хрещений батько"],
    ["Хресна мати", "godmother", "Хрещена мати"],
    ["godmother", "godmother", "Хрещена мати"],
    ["Свідок нареченої", "witness_for_bride", "Свідок по нареченій"],
    ["Свідок зі сторони нареченої", "witness_for_bride", "Свідок по нареченій"],
    ["Свідок з боку нареченої", "witness_for_bride", "Свідок по нареченій"],
    ["witness for bride", "witness_for_bride", "Свідок по нареченій"],
    ["bride witness", "witness_for_bride", "Свідок по нареченій"],
    ["Свідок нареченого", "witness_for_groom", "Свідок по нареченому"],
    ["Свідок зі сторони нареченого", "witness_for_groom", "Свідок по нареченому"],
    ["Свідок з боку нареченого", "witness_for_groom", "Свідок по нареченому"],
    ["witness for groom", "witness_for_groom", "Свідок по нареченому"],
    ["groom witness", "witness_for_groom", "Свідок по нареченому"],
    ["Поручитель нареченої", "sponsor_for_bride", "Поручитель по нареченій"],
    ["Поручитель зі сторони нареченої", "sponsor_for_bride", "Поручитель по нареченій"],
    ["sponsor for bride", "sponsor_for_bride", "Поручитель по нареченій"],
    ["Поручитель нареченого", "sponsor_for_groom", "Поручитель по нареченому"],
    ["Поручитель зі сторони нареченого", "sponsor_for_groom", "Поручитель по нареченому"],
    ["sponsor for groom", "sponsor_for_groom", "Поручитель по нареченому"],
  ] as const;

  for (const [sourceRole, expectedCode, canonicalRole] of fixtures) {
    const definition = autoSocialRelationForParticipantRole(sourceRole);
    assert.equal(definition?.relationTypeCode, expectedCode);
    assert.equal(definition?.role, canonicalRole);
    assert.equal(participantSocialRoleNeedsClarification(sourceRole, "шлюб"), false);
  }

  for (const genericRole of ["Хрещений", "Хресний", "Хрещена", "Хресна"]) {
    assert.equal(autoSocialRelationForParticipantRole(genericRole), null);
    assert.equal(participantSocialRoleNeedsClarification(genericRole, "хрещення"), true);
  }
});

test("an exact legacy godparent alias gets the same child target candidates", () => {
  const participants: FindingParticipant[] = [
    { id: "child-a", role: "Дитина", name: "Марія", notes: "" },
    { id: "child-b", role: "Дитина", name: "Олена", notes: "" },
    { id: "godfather", role: "Хресний батько", name: "Петро", notes: "" },
  ];
  assert.deepEqual(
    contextTargetParticipantsForRole(participants[2], participants, "хрещення")
      .map((participant) => participant.id),
    ["child-a", "child-b"],
  );
  assert.equal(
    suggestedContextTargetParticipantId(participants[2], participants, "хрещення"),
    undefined,
  );
});

test("household finding aliases use the same target semantics", () => {
  const participants: FindingParticipant[] = [
    { id: "head", role: "Голова господарства", name: "Іван", notes: "" },
    { id: "member", role: "Член господарства", name: "Петро", notes: "" },
  ];
  for (const findingType of [
    "погосподарська книга",
    "сповідний розпис",
    "ревізія",
    "revision",
  ]) {
    assert.deepEqual(
      contextTargetParticipantsForRole(participants[1], participants, findingType)
        .map((participant) => participant.id),
      ["head"],
    );
  }
});
