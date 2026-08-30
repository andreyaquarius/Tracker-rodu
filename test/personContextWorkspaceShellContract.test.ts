import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/PersonContextWorkspaceV1.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/features/context-graph/PersonContextWorkspaceV1.css", import.meta.url),
  "utf8",
);
const layout = readFileSync(new URL("../src/components/Layout.tsx", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("person context workspace uses one compact person-centred navigation panel", () => {
  assert.match(component, /Зв’язки та оточення/u);
  assert.match(component, /person-context-workspace-v1__shell/u);
  assert.match(component, /\{center\.fullName\}/u);
  assert.match(component, /← Назад/u);

  for (const [label, route] of [
    ["Люди", "social"],
    ["Роди", "ritual"],
    ["Документи", "documentary"],
  ] as const) {
    assert.match(
      component,
      new RegExp(`onChangeView\\("${route}"\\)[\\s\\S]*?>\\s*${label}\\s*</button>`, "u"),
    );
  }

  const mainNavigation = sourceBlock(
    component,
    '<nav className="person-context-workspace-v1__views"',
    "</nav>",
  );
  assert.doesNotMatch(mainNavigation, /<small|<p|<h2/u);
  assert.doesNotMatch(component, /Оточення конкретної людини|Переглядайте людей/u);
});

test("research graph is separated into an accessible advanced disclosure", () => {
  assert.match(component, /<details[\s\S]*?className="person-context-workspace-v1__advanced"/u);
  assert.match(component, /open=\{contextView === "research"\}/u);
  assert.match(component, /<summary title="Інструменти для досвідчених дослідників">/u);
  assert.match(component, /<strong>Розширені<\/strong>/u);
  assert.match(component, /onChangeView\("research"\)/u);

  const mainNavigation = sourceBlock(
    component,
    '<nav className="person-context-workspace-v1__views"',
    "</nav>",
  );
  assert.doesNotMatch(mainNavigation, /research|Дослідницький граф/u);
});

test("shell stays low on desktop and keeps three compact controls on mobile", () => {
  assert.match(styles, /grid-template-columns:\s*auto minmax\(8rem, 1fr\) auto auto/u);
  assert.match(styles, /person-context-workspace-v1__toolbar\s*\{[\s\S]*?padding:\s*0\.55rem 0\.65rem/u);
  assert.match(styles, /min-height:\s*2\.25rem/u);
  assert.match(styles, /person-context-workspace-v1__advanced summary\s*\{[\s\S]*?min-height:\s*2rem/u);
  assert.match(styles, /person-context-workspace-v1__advanced-content\s*\{[\s\S]*?position:\s*absolute/u);
  assert.doesNotMatch(styles, /font-size:\s*clamp\(/u);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /person-context-workspace-v1__advanced summary:focus-visible/u);
  assert.match(styles, /outline:\s*2px solid/u);
});

test("focused person context compacts the surrounding application chrome", () => {
  assert.match(layout, /focusedPersonContext\?: boolean/u);
  assert.match(layout, /main-shell main-shell-person-context/u);
  assert.match(layout, /person-context-page/u);
  assert.match(appStyles, /\.main-shell-person-context \.topbar\s*\{[\s\S]*?min-height:\s*54px/u);
  assert.match(appStyles, /\.person-context-page\s*\{[\s\S]*?padding-top:\s*10px/u);
  assert.match(appStyles, /\.person-context-page > \.subscription-notice/u);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
