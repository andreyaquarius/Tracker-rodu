import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { appAppearanceKey, normalizeAppAppearance, parseAppAppearance, readAppAppearance, writeAppAppearance } from "../src/utils/appAppearance.ts";
import { skyStars, skyStarPoint } from "../src/features/family-tree-view/appearance/skyStars.ts";
import { chartColorContrastRatio } from "../src/features/family-tree-view/appearance/familyTreeChartColorScheme.ts";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
test("standard is opt-in safe default and appearance ignores malformed/unknown data", () => {
  for (const value of [null, undefined, [], "dark", { theme: "dark" }, { theme: true }, { skyMotion: "false" }]) {
    assert.deepEqual(normalizeAppAppearance(value), { theme: "standard", skyMotion: true });
  }
  assert.deepEqual(normalizeAppAppearance({ theme: "starry-dark", skyMotion: false, projectId: "private" }), { theme: "starry-dark", skyMotion: false });
  assert.deepEqual(parseAppAppearance("{broken"), { theme: "standard", skyMotion: true });
});
test("theme and motion survive refresh, isolated by account and from guest/project preferences", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const night = { theme: "starry-dark" as const, skyMotion: false };
  assert.equal(writeAppAppearance("alice", night, storage), true);
  assert.deepEqual(readAppAppearance("alice", storage), night);
  assert.equal(readAppAppearance("bob", storage).theme, "standard");
  assert.equal(readAppAppearance(null, storage).theme, "standard");
  assert.notEqual(appAppearanceKey("guest"), appAppearanceKey(null));
  assert.notEqual(appAppearanceKey("account:x"), appAppearanceKey("x"));
  writeAppAppearance("alice", { theme: "standard", skyMotion: true }, storage);
  assert.equal(readAppAppearance("alice", storage).theme, "standard");
  assert.equal(data.size, 1);
});
test("blocked storage/quota/corrupt values cannot stop the application", () => {
  const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(readAppAppearance("alice", blocked).theme, "standard");
  assert.equal(writeAppAppearance("alice", { theme: "starry-dark", skyMotion: false }, blocked), false);
});
test("night semantic text is readable across panels, controls and status surfaces", () => {
  const css = read("components/appearance/appAppearance.css");
  const values = new Map([...css.matchAll(/--app-([\w-]+):\s*(#[\da-f]{6});/g)].map(m => [m[1]!, m[2]!]));
  for (const foreground of ["ink", "ink-muted", "link", "warning", "danger", "info", "violet"]) {
    for (const surface of ["surface", "surface-soft", "surface-hover", "success-surface", "warning-surface", "danger-surface", "info-surface", "violet-surface"]) {
      assert.ok(chartColorContrastRatio(values.get(foreground)!, values.get(surface)!) >= 4.5, `${foreground} on ${surface}`);
    }
  }
});

test("primary actions and selected controls have paired high-contrast night colors", () => {
  const css = read("components/appearance/appAppearance.css");
  const values = new Map([...css.matchAll(/--app-([\w-]+):\s*(#[\da-f]{6});/g)].map(m => [m[1]!, m[2]!]));
  for (const background of ["action-bg", "action-hover", "action-pressed"]) {
    assert.ok(chartColorContrastRatio(values.get("action-ink")!, values.get(background)!) >= 7, background);
  }
  assert.ok(chartColorContrastRatio(values.get("selected-ink")!, values.get("selected-bg")!) >= 7);
  assert.ok(chartColorContrastRatio(values.get("danger-action-ink")!, values.get("danger-action-bg")!) >= 7);
  const styles = read("styles.css");
  assert.match(styles, /\.button-primary\s*\{[^}]*color: var\(--app-action-ink, white\);[^}]*background: var\(--app-action-bg, var\(--green-900\)\)/);
  assert.match(styles, /\.button-primary:hover\s*\{[^}]*var\(--app-action-hover, var\(--green-800\)\)/);
  assert.match(css, /\.button-primary:disabled\s*\{ background: var\(--app-action-bg\)/);
  for (const name of ["action-bg", "action-ink", "action-hover", "action-pressed", "selected-bg", "selected-ink"]) {
    assert.match(css.slice(css.indexOf("@media print")), new RegExp(`--app-${name}: initial`));
  }
});

test("analytics and formerly light status panels use theme tokens with unchanged standard fallbacks", () => {
  const styles = read("styles.css");
  const rules = [
    ["product-analytics-preferences", "var(--app-surface, var(--panel, #fffdf8))"],
    ["source-add-checking", "var(--app-success-surface, var(--green-50, #edf5f1))"],
    ["is-verified", "var(--app-success-surface, #b9ddcf)"],
    ["is-found", "var(--app-info-surface, #d6e8b8)"],
    ["is-unchecked", "var(--app-warning-surface, #f5dfab)"],
    ["subscription-notice", "var(--app-warning-surface, #f5dfb2)"],
  ];
  for (const [selector, background] of rules) {
    const blocks = [...styles.matchAll(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`, "g"))];
    assert.ok(blocks.some(block => block[1]?.includes(`background: ${background}`)), selector);
  }
  // Root brand colors are not a theme switch: they also color portraits and maps.
  const nightRoot = read("components/appearance/appAppearance.css").split("}")[0]!;
  assert.doesNotMatch(nightRoot, /--green-(?:800|900|950):/);
});

test("night palette also covers module-specific primary actions and selected tabs", () => {
  const css = read("components/appearance/appAppearance.css");
  for (const selector of [".context-social-v1__button.is-primary", ".documentary-graph-v1__button.is-primary", ".research-graph-v1__button.is-primary", ".church-role-network-v1 button.is-primary", ".historical-place-tabs button.active", ".feedback-filters button.active", ".zagulyaky-moderation-tabs button.active"]) {
    assert.ok(css.includes(selector), selector);
  }
  for (const path of ["components/notes/TelegramNotesPanel.tsx", "pages/HistoricalPlacesPage.tsx", "pages/YearMatrixPage.tsx", "components/ProductAnalyticsPreferences.tsx"]) {
    assert.match(read(path), /className="button button-primary"/);
  }
});
test("all three canvas views share pixel-sized stars; zoom cannot enlarge the sky", () => {
  const viewport = read("features/family-tree-view/react/FamilyTreeViewport.tsx");
  const constellation = read("features/family-tree-view/constellation/ConstellationStarfield.tsx");
  const canvas = read("components/appearance/StarrySkyCanvas.tsx");
  assert.match(viewport, /<StarrySkyCanvas/);
  assert.match(viewport, /width=\{camera.viewportSize.width\} height=\{camera.viewportSize.height\}/);
  assert.doesNotMatch(canvas, /viewBox|camera\.zoom|devicePixelRatio\s*\*/);
  assert.match(constellation, /<StarrySkyCanvas/);
  assert.match(canvas, /3_000_000/); assert.match(canvas, /cancelAnimationFrame/);
  for (const [width, height] of [[320, 568], [1440, 900], [3840, 2160]]) {
    const stars = skyStars(width!, height!); assert.ok(stars.length <= 220);
    assert.ok(stars.every(star => star.radius <= 1.85 && star.radius >= .55));
    assert.equal(stars[0]!.radius, skyStars(320, 568)[0]!.radius);
    assert.ok(Number.isFinite(skyStarPoint(stars[0]!, 100, width!, height!).x));
  }
});
test("appearance updates do not reload, replace the router, write project data or use another auth client", () => {
  const provider = read("components/appearance/AppAppearanceProvider.tsx");
  assert.doesNotMatch(provider, /location\.reload|location\.assign|createClient|updateUser|supabase\.from|key=\{/);
  assert.match(provider, /addEventListener\("storage"/);
  assert.match(provider, /removeEventListener\("storage"/);
  assert.match(read("App.tsx"), /useAppAppearanceAccount\(account\?\.id \?\? null, authReady\)/);
  assert.match(read("main.tsx"), /<AppAppearanceProvider><RouterProvider/);
  assert.match(read("pages/SettingsPage.tsx"), /<AppAppearanceSettings \/>/);
  assert.match(read("components/TopBar.tsx"), /<AppAppearanceSettings compact \/>/);
});
test("personal theme is available to read-only collaborators and has explicit storage feedback", () => {
  const settings = read("components/appearance/AppAppearanceSettings.tsx");
  assert.doesNotMatch(settings, /readOnly|onChange\(db|updateProject/);
  assert.match(settings, /в цьому браузері/);
  assert.match(settings, /role="status"/);
  assert.match(settings, /aria-label=\{option.title\}/);
});

test("editing chart colors cannot accidentally persist the global sky override", () => {
  for (const name of ["CircularAncestorChartWindow", "FanGenealogyChartWindow"]) {
    const source = read(`components/familyTree/${name}.tsx`);
    assert.match(source, /const chartAppearance = useTreeSkyAppearance\(localChartAppearance\)/);
    assert.match(source, /<AncestorChartColorControls\s+appearance=\{localChartAppearance\}/);
  }
});
