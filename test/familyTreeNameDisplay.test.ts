import assert from "node:assert/strict";
import test from "node:test";
import { applyFamilyTreeNameDisplay } from "../src/features/family-tree-view/adapters/familyTreeNameDisplay.ts";
import type { FamilyGraphData } from "../src/features/family-tree-view/types.ts";
import type { MarriedSurnameDisplay } from "../src/utils/familyTreeAppearance.ts";

const modes: readonly [MarriedSurnameDisplay, string][] = [
  ["married-with-maiden", "Коваленко (Петренко) Олена Іванівна"],
  ["maiden-with-married", "Петренко (Коваленко) Олена Іванівна"],
  ["married-only", "Коваленко Олена Іванівна"],
  ["maiden-only", "Петренко Олена Іванівна"],
];

function graph(): FamilyGraphData {
  return {
    persons: [
      {
        id: "wife",
        displayName: "Коваленко Олена Іванівна",
        givenName: "Олена",
        surname: "Коваленко",
        sex: "female",
      },
      {
        id: "husband",
        displayName: "Коваленко Андрій Петрович",
        givenName: "Андрій",
        surname: "Коваленко",
        sex: "male",
      },
    ],
    unions: [
      {
        id: "partnership:one",
        kind: "partnership",
        memberIds: ["wife", "husband"],
        status: "married",
      },
    ],
    parentChildRelations: [],
  };
}

const profiles = [
  {
    id: "wife",
    surname: "Коваленко",
    maidenSurname: "Петренко",
    givenName: "Олена",
    patronymic: "Іванівна",
    gender: "жінка",
  },
  {
    id: "husband",
    surname: "Коваленко",
    maidenSurname: "",
    givenName: "Андрій",
    patronymic: "Петрович",
    gender: "чоловік",
  },
] as const;

test("tree name display supports all four married and maiden surname formats", () => {
  for (const [marriedSurnameDisplay, expected] of modes) {
    const source = graph();
    const result = applyFamilyTreeNameDisplay(
      source,
      {
        marriedSurnameDisplay,
        inferMarriedSurnameFromHusband: false,
      },
      profiles,
    );
    assert.equal(
      result.persons.find(person => person.id === "wife")?.displayName,
      expected,
    );
    assert.equal(
      result.persons.find(person => person.id === "husband")?.displayName,
      "Коваленко Андрій Петрович",
    );
    assert.equal(source.persons[0]?.displayName, "Коваленко Олена Іванівна");
  }
});

test("missing married surname can be inferred from the active husband only when enabled", () => {
  const source: FamilyGraphData = {
    persons: [
      { id: "wife", displayName: "Петренко Олена", sex: "female", surname: "Петренко" },
      { id: "former", displayName: "Сидоренко Петро", sex: "male", surname: "Сидоренко" },
      { id: "current", displayName: "Коваль Андрій", sex: "male", surname: "Коваль" },
    ],
    unions: [
      {
        id: "former-union",
        kind: "partnership",
        memberIds: ["wife", "former"],
        status: "ended",
      },
      {
        id: "current-union",
        kind: "partnership",
        memberIds: ["wife", "current"],
        status: "married",
      },
    ],
    parentChildRelations: [],
  };
  const nameProfiles = [
    {
      id: "wife",
      surname: "Петренко",
      maidenSurname: "Петренко",
      givenName: "Олена",
      patronymic: "Іванівна",
    },
  ];
  const withoutFallback = applyFamilyTreeNameDisplay(
    source,
    {
      marriedSurnameDisplay: "married-only",
      inferMarriedSurnameFromHusband: false,
    },
    nameProfiles,
  );
  const withFallback = applyFamilyTreeNameDisplay(
    source,
    {
      marriedSurnameDisplay: "married-only",
      inferMarriedSurnameFromHusband: true,
    },
    nameProfiles,
  );
  assert.equal(withoutFallback.persons[0]?.displayName, "Петренко Олена Іванівна");
  assert.equal(withFallback.persons[0]?.displayName, "Коваль Олена Іванівна");
});

test("masked private people never receive profile-derived names", () => {
  const source: FamilyGraphData = {
    persons: [{
      id: "private",
      displayName: "Приватна особа",
      sex: "unknown",
      badges: { privacy: "masked" },
    }],
    unions: [],
    parentChildRelations: [],
  };
  const result = applyFamilyTreeNameDisplay(
    source,
    {
      marriedSurnameDisplay: "maiden-only",
      inferMarriedSurnameFromHusband: true,
    },
    [{
      id: "private",
      surname: "Таємна",
      maidenSurname: "Приватна",
      givenName: "Особа",
      gender: "жінка",
    }],
  );
  assert.strictEqual(result, source);
  assert.equal(result.persons[0]?.displayName, "Приватна особа");
});

test("renderer-only graphs keep the original patronymic when profiles are unavailable", () => {
  const source: FamilyGraphData = {
    persons: [{
      id: "wife",
      displayName: "Коваленко Олена Іванівна",
      givenName: "Олена",
      surname: "Коваленко",
      maidenSurname: "Петренко",
      sex: "female",
    }],
    unions: [],
    parentChildRelations: [],
  };
  const result = applyFamilyTreeNameDisplay(
    source,
    {
      marriedSurnameDisplay: "maiden-only",
      inferMarriedSurnameFromHusband: false,
    },
  );
  assert.equal(result.persons[0]?.displayName, "Петренко Олена Іванівна");
});
