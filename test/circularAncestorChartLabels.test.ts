import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCircularAncestorLife,
  formatCircularAncestorName,
  planCircularAncestorLabel,
  recommendCircularAncestorLabelZoom,
} from "../src/features/family-tree-view/circular/circularAncestorChartLabels.ts";
import {
  CIRCULAR_ANCESTOR_FOCUS_RADIUS,
  CIRCULAR_ANCESTOR_RING_WIDTH,
  type CircularAncestorOccurrence,
} from "../src/features/family-tree-view/circular/circularAncestorChartLayout.ts";
import type { TreePerson } from "../src/features/family-tree-view/types.ts";

function person(overrides: Partial<TreePerson> = {}): TreePerson {
  return {
    id: "person",
    displayName: "Каленський Андрій Васильович",
    ...overrides,
  };
}

function occurrence(
  generation: number,
  personValue: TreePerson = person(),
): CircularAncestorOccurrence {
  const count = 2 ** generation;
  return {
    occurrenceId: `circular-ancestor:${count}`,
    personId: personValue.id,
    person: personValue,
    slot: count,
    generation,
    index: 0,
    branch: generation === 0 ? "focus" : "paternal",
    startAngle: -90,
    endAngle: generation === 0 ? 270 : -90 + 360 / count,
    innerRadius: generation === 0
      ? 0
      : CIRCULAR_ANCESTOR_FOCUS_RADIUS +
        (generation - 1) * CIRCULAR_ANCESTOR_RING_WIDTH,
    outerRadius: generation === 0
      ? CIRCULAR_ANCESTOR_FOCUS_RADIUS
      : CIRCULAR_ANCESTOR_FOCUS_RADIUS +
        generation * CIRCULAR_ANCESTOR_RING_WIDTH,
    duplicate: false,
  };
}

test("keeps the complete stored name and exact date/year display values", () => {
  const value = person({
    displayName: "  Каленський   Андрій  Васильович ",
    birth: { display: "бл. 17 листопада 1777", sort: "1777-11-17" },
    death: { display: "після 1840", sort: "1840" },
  });

  assert.equal(
    formatCircularAncestorName(value),
    "Каленський Андрій Васильович",
  );
  assert.equal(
    formatCircularAncestorLife(value),
    "бл. 17 листопада 1777 — після 1840",
  );
});

test("formats partial life data without inventing date precision", () => {
  assert.equal(
    formatCircularAncestorLife(person({
      birth: { display: "1777-11-17" },
      death: { display: "1840-03-12" },
    })),
    "17.11.1777 — 12.03.1840",
  );
  assert.equal(
    formatCircularAncestorLife(person({ birth: { sort: "1777" } })),
    "нар. 1777",
  );
  assert.equal(
    formatCircularAncestorLife(person({ death: { display: "між 1840 і 1842" } })),
    "пом. між 1840 і 1842",
  );
  assert.equal(formatCircularAncestorLife(person()), "Дати не вказані");
});

test("uses curved labels through generation four and radial labels afterwards", () => {
  const generationFour = planCircularAncestorLabel(occurrence(4), 0.08);
  const generationFive = planCircularAncestorLabel(occurrence(5), 0.08);

  assert.equal(generationFour.mode, "curved");
  assert.equal(generationFour.preferredMode, "curved");
  assert.equal(generationFive.mode, "radial");
  assert.equal(generationFive.preferredMode, "radial");
  assert.equal(
    generationFour.requiredLength <= generationFour.availableLength + 1e-9,
    true,
  );
  assert.equal(
    generationFive.requiredLength <= generationFive.availableLength + 1e-9,
    true,
  );
});

test("keeps fitted world typography fixed across zoom and viewport scales", () => {
  const value = occurrence(2, person({
    displayName: "Іван Коваль",
    birth: { sort: "1900" },
    death: { sort: "1980" },
  }));
  const normal = planCircularAncestorLabel(value, 1);
  const fourTimesMorePixelsPerWorld = planCircularAncestorLabel(value, 0.25);

  assert.equal(normal.mode, "curved");
  assert.equal(fourTimesMorePixelsPerWorld.mode, "curved");
  assert.deepEqual(fourTimesMorePixelsPerWorld, normal);
});

test("shrinks in world geometry rather than truncating or overlapping", () => {
  const fullName = "Каленський Олександр Михайлович-Дмитрович";
  const value = occurrence(5, person({
    displayName: fullName,
    birth: { display: "17 листопада 1777" },
    death: { display: "після 12 березня 1840" },
  }));
  const overview = planCircularAncestorLabel(value, 1);
  const zoomedOrFullscreen = planCircularAncestorLabel(value, 0.08);

  assert.equal(overview.mode, "radial");
  assert.equal(overview.preferredMode, "radial");
  assert.equal(overview.name, fullName);
  assert.equal(
    overview.life,
    "17 листопада 1777 — після 12 березня 1840",
  );
  assert.deepEqual(zoomedOrFullscreen, overview);
  assert.equal(overview.requiredLength <= overview.availableLength + 1e-9, true);
  assert.equal(overview.requiredCrossSize <= overview.availableCrossSize + 1e-9, true);
  assert.equal(overview.fitScale < 1, true);
});

test("recommends zoom that keeps every known label through generation eight readable", () => {
  const values = Array.from({ length: 10 }, (_, generation) =>
    occurrence(generation, person({
      id: `person-${generation}`,
      displayName: `Каленський Олександр Михайлович ${generation}`,
      birth: { sort: `${1800 + generation}` },
      death: { sort: `${1870 + generation}` },
    })));
  const fitPixelsPerWorld = 0.6;
  const result = recommendCircularAncestorLabelZoom(
    values,
    fitPixelsPerWorld,
  );

  assert.equal(result.consideredOccurrenceCount, 9);
  assert.equal(result.maxGeneration, 8);
  assert.equal(result.recommendedZoom >= 1, true);
  assert.equal(
    result.minimumWorldFontSize * result.recommendedScale + 1e-9 >= 7,
    true,
  );
  assert.equal(
    result.recommendedScale,
    result.fitScale * result.recommendedZoom,
  );
  const consideredMinimum = Math.min(...values.slice(0, 9).map((item) => {
    const plan = planCircularAncestorLabel(item);
    return Math.min(plan.fontSize, plan.lifeFontSize);
  }));
  assert.equal(result.minimumWorldFontSize, consideredMinimum);
  assert.equal(
    values.slice(0, 9).some(
      item => item.occurrenceId === result.limitingOccurrenceId,
    ),
    true,
  );
});

test("supports a custom readability target and generation boundary", () => {
  const values = [occurrence(4), occurrence(5), occurrence(8)];
  const result = recommendCircularAncestorLabelZoom(values, 0.5, {
    targetScreenFontSize: 9,
    maxGeneration: 5,
  });

  assert.equal(result.targetScreenFontSize, 9);
  assert.equal(result.maxGeneration, 5);
  assert.equal(result.consideredOccurrenceCount, 2);
  assert.equal(
    result.minimumWorldFontSize * result.recommendedScale + 1e-9 >= 9,
    true,
  );
});

test("label planning remains one-to-one with sparse known occurrences", () => {
  const sparseKnownOccurrences = [occurrence(1), occurrence(8), occurrence(16)];
  const plans = sparseKnownOccurrences.map((item) =>
    planCircularAncestorLabel(item, 0.05));

  assert.equal(plans.length, sparseKnownOccurrences.length);
  assert.equal(plans.some((plan) => plan.name.includes("…")), false);
});
