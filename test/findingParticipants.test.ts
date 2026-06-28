import test from "node:test";
import assert from "node:assert/strict";
import {
  participantSummary,
  primaryParticipantName,
  sortFindingParticipants,
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
