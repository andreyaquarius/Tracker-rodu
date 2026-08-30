import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const styles = source("../src/styles.css");
const circular = source(
  "../src/components/familyTree/CircularAncestorChartWindow.tsx",
);
const fan = source(
  "../src/components/familyTree/FanGenealogyChartWindow.tsx",
);

function balancedBlockAt(input: string, markerIndex: number): string {
  const openIndex = input.indexOf("{", markerIndex);
  assert.notEqual(openIndex, -1, "Expected an opening brace");

  let depth = 0;
  for (let index = openIndex; index < input.length; index += 1) {
    if (input[index] === "{") depth += 1;
    if (input[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return input.slice(markerIndex, index + 1);
  }

  assert.fail("Expected a closing brace");
}

function cssRule(selector: string): string {
  const marker = `${selector} {`;
  const markerIndex = styles.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected CSS rule ${selector}`);
  return balancedBlockAt(styles, markerIndex);
}

interface ContainerBlock {
  name: string;
  maxWidth: number;
  source: string;
}

function containerBlocks(): ContainerBlock[] {
  const result: ContainerBlock[] = [];
  const pattern = /@container\s+([\w-]+)\s+\(max-width:\s*(\d+)px\)\s*\{/gu;
  for (const match of styles.matchAll(pattern)) {
    result.push({
      name: match[1]!,
      maxWidth: Number(match[2]),
      source: balancedBlockAt(styles, match.index!),
    });
  }
  return result;
}

function chartContainer(
  description: string,
  predicate: (block: ContainerBlock) => boolean,
): ContainerBlock {
  const block = containerBlocks().find(candidate =>
    candidate.source.includes(".circular-ancestor-toolbar") && predicate(candidate),
  );
  assert.ok(block, `Expected ${description} ancestor-chart container query`);
  return block;
}

function selectorHasDeclaration(
  input: string,
  selector: string,
  declaration: RegExp,
): boolean {
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  for (const match of input.matchAll(pattern)) {
    const selectors = match[1]!.split(",").map(value => value.trim());
    if (selectors.includes(selector) && declaration.test(match[2]!)) return true;
  }
  return false;
}

test("both ancestor chart windows expose the same responsive toolbar groups", () => {
  for (const component of [circular, fan]) {
    const intro = component.indexOf('className="circular-ancestor-intro"');
    const build = component.indexOf('className="circular-ancestor-build-controls"');
    const navigation = component.indexOf('className="circular-ancestor-navigation"');
    const camera = component.indexOf('className="circular-ancestor-camera-controls"');
    const list = component.indexOf("circular-ancestor-list-toggle");

    assert.ok(intro >= 0, "Expected the central-person group");
    assert.ok(build > intro, "Expected build controls after the central person");
    assert.ok(navigation > build, "Expected one navigation group after build controls");
    assert.ok(camera > navigation, "Expected camera controls inside navigation");
    assert.ok(list > camera, "Expected the accessible-list control inside navigation");
    assert.match(component, /circular-ancestor-build-button/u);
  }
});

test("ancestor chart window fills the available workspace instead of using a fixed desktop box", () => {
  const modal = cssRule(".modal.circular-ancestor-modal");

  assert.match(modal, /width:\s*(?:100%|calc\([^;]*100vw|min\(\s*100%)/u);
  assert.match(modal, /height:[^;]*100dvh/u);
  assert.doesNotMatch(modal, /(?:width|height):[^;]*(?:1120|850)px/u);
  assert.match(cssRule(".modal"), /container-name:\s*app-modal/u);
  assert.match(cssRule(".modal"), /container-type:\s*inline-size/u);
});

test("ancestor chart toolbar compacts from its modal width, not the monitor width", () => {
  const medium = chartContainer(
    "medium-width",
    block => block.maxWidth >= 900 && block.maxWidth <= 1300,
  );

  assert.equal(
    selectorHasDeclaration(
      medium.source,
      ".circular-ancestor-navigation",
      /grid-column:\s*1\s*\/\s*-1/u,
    ),
    true,
  );
  assert.equal(
    selectorHasDeclaration(
      medium.source,
      ".circular-ancestor-camera-controls",
      /flex-wrap:\s*wrap/u,
    ),
    true,
  );

  const obsoleteViewportRule = styles.match(
    /@media\s*\(max-width:\s*1350px\)\s*and\s*\(min-width:\s*851px\)\s*\{[\s\S]*?\n\}/u,
  )?.[0] ?? "";
  assert.doesNotMatch(obsoleteViewportRule, /\.circular-ancestor-toolbar/u);
});

test("a narrow chart modal gives controls and content non-overlapping full rows", () => {
  const compact = chartContainer(
    "compact",
    block => block.maxWidth >= 560 && block.maxWidth <= 850,
  );

  assert.equal(
    selectorHasDeclaration(
      compact.source,
      ".circular-ancestor-toolbar",
      /grid-template-columns:\s*(?:minmax\(0,\s*1fr\)|1fr)/u,
    ),
    true,
  );
  for (const selector of [
    ".circular-ancestor-intro",
    ".circular-ancestor-build-controls",
    ".circular-ancestor-navigation",
  ]) {
    assert.equal(
      selectorHasDeclaration(
        compact.source,
        selector,
        /grid-column:\s*1\s*\/\s*-1/u,
      ),
      true,
    );
  }
  assert.equal(
    selectorHasDeclaration(
      compact.source,
      ".circular-ancestor-list-toggle",
      /width:\s*100%/u,
    ),
    true,
  );
  assert.equal(
    selectorHasDeclaration(
      compact.source,
      ".circular-ancestor-content",
      /grid-template-columns:\s*1fr/u,
    ),
    true,
  );

  assert.doesNotMatch(
    styles,
    /\.circular-ancestor-toolbar\s*\{[^}]*max-height:\s*168px/u,
  );
  assert.doesNotMatch(
    styles,
    /\.circular-ancestor-toolbar\s*\{[^}]*overflow-y:\s*auto/u,
  );
});
