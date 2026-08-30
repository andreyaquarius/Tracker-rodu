import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSocialCircleRadialLayout,
  compactSocialCircleLabel,
  isLegacyAmbiguousSocialRelationTypeCode,
  isSpecificSocialRelationTypeCode,
  relatedPersonSocialRoleLabel,
  relationTypeEditorLabel,
  specificReplacementCodesForLegacyRole,
  specificSocialRelationDefinition,
  type SocialCircleRelationSeed,
} from "../src/features/context-graph/socialCircleModel.ts";

const relations: SocialCircleRelationSeed[] = [
  {
    relationId: "relation-3",
    personId: "person-b",
    personLabel: "Яків Бондар",
    relationLabel: "Свідок",
    category: "social",
    isHypothesis: true,
  },
  {
    relationId: "relation-2",
    personId: "person-a",
    personLabel: "Анна Гнатюк",
    relationLabel: "Хрещена мати",
    category: "church",
  },
  {
    relationId: "relation-1",
    personId: "person-a",
    personLabel: "Анна Гнатюк",
    relationLabel: "Сусідка",
    category: "social",
  },
];

test("social-circle radial layout is deterministic and groups parallel relations by person", () => {
  const first = buildSocialCircleRadialLayout(relations);
  const reversed = buildSocialCircleRadialLayout([...relations].reverse());

  assert.deepEqual(first, reversed);
  assert.equal(first.nodes.length, 2);
  assert.equal(first.nodes[0]?.personId, "person-a");
  assert.deepEqual(first.nodes[0]?.relationIds, ["relation-1", "relation-2"]);
  assert.deepEqual(first.nodes[0]?.relationLabels, ["Сусідка", "Хрещена мати"]);
  assert.equal(first.nodes[1]?.hasHypothesis, true);
});

test("social-circle radial layout stays depth-one and inside the declared SVG", () => {
  const layout = buildSocialCircleRadialLayout(relations, { width: 640, height: 480 });

  assert.equal(layout.centerX, 320);
  assert.equal(layout.centerY, 240);
  for (const node of layout.nodes) {
    assert.ok(node.x >= layout.nodeRadius);
    assert.ok(node.x <= layout.width - layout.nodeRadius);
    assert.ok(node.y >= layout.nodeRadius);
    assert.ok(node.y <= layout.height - layout.nodeRadius);
  }
});

test("social-circle labels are compacted without returning an empty name", () => {
  assert.equal(compactSocialCircleLabel("", 10), "Особа без…");
  assert.equal(compactSocialCircleLabel("Іван Петренко", 32), "Іван Петренко");
  assert.equal(compactSocialCircleLabel("Дуже довге історичне ім’я", 12), "Дуже довге…");
});

test("social-circle exposes concrete church, wedding-side and event-witness roles", () => {
  assert.equal(specificSocialRelationDefinition("godfather")?.label, "Хрещений батько");
  assert.equal(specificSocialRelationDefinition("godmother")?.label, "Хрещена мати");
  assert.equal(specificSocialRelationDefinition("sponsor_for_bride")?.label, "Поручитель по нареченій");
  assert.equal(specificSocialRelationDefinition("sponsor_for_groom")?.label, "Поручитель по нареченому");
  assert.equal(specificSocialRelationDefinition("witness_for_bride")?.label, "Свідок по нареченій");
  assert.equal(specificSocialRelationDefinition("witness_for_groom")?.label, "Свідок по нареченому");
  assert.equal(specificSocialRelationDefinition("event_witness")?.label, "Свідок при події");
  assert.equal(isSpecificSocialRelationTypeCode("godfather"), true);
  assert.equal(isSpecificSocialRelationTypeCode("witness"), false);
  assert.deepEqual(specificReplacementCodesForLegacyRole("godparent"), ["godfather", "godmother"]);
  assert.deepEqual(specificReplacementCodesForLegacyRole("sponsor"), [
    "sponsor_for_bride",
    "sponsor_for_groom",
  ]);
  assert.deepEqual(specificReplacementCodesForLegacyRole("witness"), [
    "witness_for_bride",
    "witness_for_groom",
  ]);
});

test("generic non-marriage witnesses use an event label, not a wedding-side warning", () => {
  assert.equal(relatedPersonSocialRoleLabel({
    relationTypeCode: "event_witness",
    relatedIsSource: true,
  }), "Свідок при події");
  assert.equal(relatedPersonSocialRoleLabel({
    relationTypeCode: "event_witness",
    relatedIsSource: false,
  }), "Учасник події");
});

test("social-circle labels the related endpoint rather than repeating the center role", () => {
  assert.equal(relatedPersonSocialRoleLabel({
    relationTypeCode: "godfather",
    relatedIsSource: true,
    sourceRoleLabel: "Хрещений батько",
    targetRoleLabel: "Хрещеник або хрещениця",
  }), "Хрещений батько");
  assert.equal(relatedPersonSocialRoleLabel({
    relationTypeCode: "godfather",
    relatedIsSource: false,
    sourceRoleLabel: "Хрещений батько",
    targetRoleLabel: "Хрещеник або хрещениця",
  }), "Хрещеник або хрещениця");
  assert.equal(relatedPersonSocialRoleLabel({
    relationTypeCode: "witness_for_bride",
    relatedIsSource: true,
  }), "Свідок по нареченій");
  assert.equal(relatedPersonSocialRoleLabel({
    relationTypeCode: "witness_for_groom",
    relatedIsSource: false,
  }), "Учасник шлюбу");
});

test("legacy generic roles remain readable but explicitly require clarification", () => {
  assert.equal(isLegacyAmbiguousSocialRelationTypeCode("godparent"), true);
  assert.equal(isLegacyAmbiguousSocialRelationTypeCode("witness"), true);
  assert.equal(isLegacyAmbiguousSocialRelationTypeCode("sponsor"), true);
  assert.match(relatedPersonSocialRoleLabel({
    relationTypeCode: "godparent",
    relatedIsSource: true,
  }), /потребує уточнення/u);
  assert.match(relatedPersonSocialRoleLabel({
    relationTypeCode: "witness",
    relatedIsSource: true,
  }), /по нареченій чи по нареченому/u);
  assert.match(relatedPersonSocialRoleLabel({
    relationTypeCode: "sponsor",
    relatedIsSource: true,
  }), /поручитель по нареченій чи по нареченому/u);
  assert.equal(
    relationTypeEditorLabel("godparent", "Хрещений батько або мати"),
    "Хрещений зв’язок — роль потребує уточнення",
  );
});

test("caregiver and legal guardian stay distinct even when catalogue labels are equal", () => {
  const duplicatedCatalogueLabel = "Опікун без батьківства";
  assert.equal(
    relationTypeEditorLabel("caregiver", duplicatedCatalogueLabel),
    "Доглядач",
  );
  assert.equal(
    relationTypeEditorLabel("guardian_non_parent", duplicatedCatalogueLabel),
    "Опікун без батьківства",
  );
  assert.notEqual(
    relationTypeEditorLabel("caregiver", duplicatedCatalogueLabel),
    relationTypeEditorLabel("guardian_non_parent", duplicatedCatalogueLabel),
  );
});

test("social-circle layout uses adaptive non-overlapping rings for one hundred people", () => {
  const denseRelations: SocialCircleRelationSeed[] = Array.from({ length: 100 }, (_, index) => ({
    relationId: `relation-${String(index).padStart(3, "0")}`,
    personId: `person-${String(index).padStart(3, "0")}`,
    personLabel: `Особа ${String(index).padStart(3, "0")}`,
    relationLabel: "Свідок",
    category: "social",
  }));
  const layout = buildSocialCircleRadialLayout(denseRelations);

  assert.equal(layout.nodes.length, 100);
  assert.ok(layout.ringCount >= 3);
  assert.ok(layout.nodeRadius <= 22);
  assert.equal(new Set(layout.nodes.map((node) => node.ringIndex)).size, layout.ringCount);

  for (const node of layout.nodes) {
    assert.ok(node.x >= layout.nodeRadius);
    assert.ok(node.x <= layout.width - layout.nodeRadius);
    assert.ok(node.y >= layout.nodeRadius);
    assert.ok(node.y <= layout.height - layout.nodeRadius);
  }

  for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
    const left = layout.nodes[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
      const right = layout.nodes[rightIndex];
      if (!right || left.ringIndex !== right.ringIndex) continue;
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      assert.ok(distance >= layout.nodeRadius * 2 - 0.1);
    }
  }
});
