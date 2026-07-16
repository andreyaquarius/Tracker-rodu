import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const productionPage = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);

function componentKeyExpression(componentName: string): string {
  const openingTag = productionPage.match(
    new RegExp(`<${componentName}\\b[\\s\\S]*?\\/>`),
  );
  assert.ok(openingTag, `${componentName} must declare an explicit stable key`);
  const keyAttribute = openingTag[0].match(/\bkey=\{([^\r\n]+)\}/);
  assert.ok(keyAttribute, `${componentName} must declare an explicit stable key`);
  return keyAttribute[1]!.trim();
}

test("the tree workspace and circular chart keep distinct stable sibling identities", () => {
  const workspaceKey = componentKeyExpression("LoadedFamilyTree");
  const chartKey = componentKeyExpression("CircularAncestorChartWindow");

  assert.equal(workspaceKey, "`family-tree:${selectedEntry.id}`");
  assert.equal(chartKey, "`circular-ancestor-chart:${selectedEntry.id}`");
  assert.notEqual(workspaceKey, chartKey);

  // Changing the chart's central person rebuilds data inside the same window.
  // Including that state in the key would remount a second window/viewport.
  assert.doesNotMatch(chartKey, /circularChartFocusPersonId|focusPersonId/);
});
