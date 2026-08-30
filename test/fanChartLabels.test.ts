import assert from "node:assert/strict";
import test from "node:test";
import {
  planFanChartSectorLabel,
  uprightFanChartLabelRotation,
} from "../src/features/family-tree-view/fan/fanChartLabels.ts";
import type { FanChartOccurrence } from "../src/features/family-tree-view/fan/fanChartLayout.ts";
import type { TreePerson } from "../src/features/family-tree-view/types.ts";

function occurrence(
  overrides: Partial<FanChartOccurrence> = {},
  personOverrides: Partial<TreePerson> = {},
): FanChartOccurrence {
  const person: TreePerson = {
    id: "person",
    displayName: "Каленський Олександр Михайлович",
    birth: { sort: "1819" },
    death: { display: "після 1871" },
    ...personOverrides,
  };
  return {
    occurrenceId: "fan-ancestor:32",
    personId: person.id,
    generation: 5,
    index: 0,
    branch: "paternal",
    startAngle: -5.625,
    endAngle: 0,
    innerRadius: 376,
    outerRadius: 452,
    person,
    duplicate: false,
    pathKey: "ahnentafel:32",
    subtreeWeight: 1,
    ...overrides,
  };
}

test("balances a complete PІB only at word boundaries", () => {
  const plan = planFanChartSectorLabel(occurrence({}, {
    displayName: "  Каленський   Олександр  Михайлович-Дмитрович ",
  }));

  assert.equal(plan.mode, "visible");
  const visibleName = plan.lines
    .filter(line => line.kind === "name")
    .map(line => line.text)
    .join(" ");
  assert.equal(
    visibleName,
    "Каленський Олександр Михайлович-Дмитрович",
  );
  assert.equal(plan.lines.length <= 4, true);
  assert.equal(
    plan.lines.every(line => !/^\S+\s*$/u.test(line.text) || line.text.length > 0),
    true,
  );
  assert.equal(plan.accessibleText.includes("Михайлович-Дмитрович"), true);
});

test("visible labels fit both the radial and tangential sector bounds", () => {
  const plan = planFanChartSectorLabel(occurrence());

  assert.equal(plan.mode, "visible");
  assert.equal(
    plan.requiredRadialLength <= plan.availableRadialLength + 1e-9,
    true,
  );
  assert.equal(
    plan.requiredTangentialSize <= plan.availableTangentialSize + 1e-9,
    true,
  );
  assert.equal(plan.renderedNameFontSize > 0, true);
});

test("keeps the complete life row together with the complete name", () => {
  const plan = planFanChartSectorLabel(occurrence({
    startAngle: -2.8125,
    endAngle: 0,
    innerRadius: 604,
    outerRadius: 680,
  }, {
    displayName: "Меньков Феліп Олексійович",
    birth: { display: "17 листопада 1665" },
    death: { display: "після 3 лютого 1731" },
  }));

  assert.equal(plan.mode, "visible");
  assert.equal(plan.lines.some(line => line.kind === "life"), true);
  assert.equal(
    plan.lines.filter(line => line.kind === "name").map(line => line.text).join(" "),
    "Меньков Феліп Олексійович",
  );
  assert.equal(
    plan.lines.find(line => line.kind === "life")?.text,
    "17 листопада 1665 — після 3 лютого 1731",
  );
  assert.match(plan.accessibleText, /17 листопада 1665/u);
});

test("vector-scales a very narrow valid label instead of hiding it", () => {
  const fullName = "Надзвичайно-Довге-Неподільне-Прізвище Олександр Михайлович";
  const plan = planFanChartSectorLabel(occurrence({
    startAngle: -0.02,
    endAngle: 0,
    innerRadius: 1200,
    outerRadius: 1276,
  }, {
    displayName: fullName,
    birth: { sort: "1701" },
    death: { sort: "1779" },
  }));

  assert.equal(plan.mode, "visible");
  assert.equal(plan.glyphScale > 0, true);
  assert.equal(plan.glyphScale < 1, true);
  assert.equal(
    plan.lines.filter(line => line.kind === "name").map(line => line.text).join(" "),
    fullName,
  );
  assert.equal(plan.lines.some(line => line.kind === "life"), true);
  assert.match(plan.accessibleText, new RegExp(fullName));
  assert.match(plan.accessibleText, /1701/u);
  assert.match(plan.accessibleText, /1779/u);
});

function deepAncestorOccurrence(generation: number): FanChartOccurrence {
  const sweep = 180 / 2 ** generation;
  return occurrence({
    occurrenceId: `fan-ancestor:${2 ** generation}`,
    generation,
    startAngle: -sweep,
    endAngle: 0,
    innerRadius: 72 + (generation - 1) * 76,
    outerRadius: 72 + generation * 76,
    pathKey: `ahnentafel:${2 ** generation}`,
  }, {
    id: `deep-${generation}`,
    displayName: "Меньков Феліп Олексійович",
    birth: { display: "17 листопада 1665" },
    death: { display: "після 3 лютого 1731" },
  });
}

test("generations 10, 11, 14 and 16 keep complete vector-scaled labels", () => {
  const fullName = "Меньков Феліп Олексійович";
  const fullLife = "17 листопада 1665 — після 3 лютого 1731";

  for (const generation of [10, 11, 14, 16]) {
    const plan = planFanChartSectorLabel(deepAncestorOccurrence(generation));
    const visibleName = plan.lines
      .filter(line => line.kind === "name")
      .map(line => line.text)
      .join(" ");
    const visibleLife = plan.lines.find(line => line.kind === "life")?.text;

    assert.equal(plan.mode, "visible", `generation ${generation}`);
    assert.equal(visibleName, fullName, `generation ${generation}: name`);
    assert.equal(visibleLife, fullLife, `generation ${generation}: life`);
    assert.equal(
      plan.accessibleText,
      `${fullName}, ${fullLife}`,
      `generation ${generation}: accessible text`,
    );
    assert.equal(
      plan.requiredRadialLength <= plan.availableRadialLength + 1e-9,
      true,
      `generation ${generation}: radial fit`,
    );
    assert.equal(
      plan.requiredTangentialSize <= plan.availableTangentialSize + 1e-9,
      true,
      `generation ${generation}: tangential fit`,
    );
    assert.equal(plan.glyphScale > 0, true, `generation ${generation}: scale`);
    assert.equal(
      plan.lines.every(line => line.glyphFontSize >= 8),
      true,
      `generation ${generation}: stable glyph sizes`,
    );
    assert.equal(
      plan.rotation >= -90 && plan.rotation <= 90,
      true,
      `generation ${generation}: upright`,
    );
  }
});

test("normalizes every ancestor and descendant radial orientation to upright", () => {
  for (const angle of [-179, -135, -90, -45, 0, 45, 90, 135, 179]) {
    const rotation = uprightFanChartLabelRotation(angle);
    assert.equal(Number.isFinite(rotation), true, `angle ${angle}`);
    assert.equal(rotation >= -90 && rotation <= 90, true, `angle ${angle}`);
  }

  assert.equal(uprightFanChartLabelRotation(-90), -90);
  assert.equal(uprightFanChartLabelRotation(90), 90);
  assert.equal(uprightFanChartLabelRotation(0), 0);
});

test("invalid sector geometry returns a hidden accessible label", () => {
  const plan = planFanChartSectorLabel(occurrence({
    innerRadius: 452,
    outerRadius: 376,
  }));

  assert.equal(plan.mode, "hidden");
  assert.equal(plan.hiddenReason, "invalid-geometry");
  assert.match(plan.accessibleText, /Каленський Олександр Михайлович/u);
});
