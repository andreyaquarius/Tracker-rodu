import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { helpArticles, helpArticleFor, searchHelpArticles, parseHelpContextProgress, HELP_CONTEXT_PROGRESS_KEY } from "../src/help/helpArticles.ts";
import { helpGuideForPage, helpGuides, HELP_STORAGE_KEYS } from "../src/help/helpGuides.ts";
import { createScopedHelpStorage, type HelpProgressStorage } from "../src/help/helpProgress.ts";

const contexts = {
  persons: ["overview", "timeline", "family", "album", "documents", "findings", "notes", ...["main", "photos", "names", "birth", "marriage", "death", "status", "places", "notes", "events", "custom"].map((key) => `edit-${key}`)],
  places: ["overview", "names", "history", "boundaries", "related", "parishes", "archives", "documents", "people", "events", "audit"],
  zagulyaky: ["people", "documents", "places", "mine"],
  "tree-statistics": ["overview", "ancestry", "demography", "families", "names", "geography", "research", "quality"],
  settings: ["appearance", "general", "custom", "ai", "telegram", "privacy"],
  familyTree: ["classic", "direct-ancestors", "tools"], findings: ["edit", "view"], viewer: ["photos"],
} as const;

test("every sidebar section has its own detailed manual, not an intro fallback", () => {
  for (const key of ["dashboard", "map", "places", "familyTree", "persons", "findings", "documents", "researches", "tasks", "hypotheses", "archiveRequests", "yearMatrix", "backup", "feedback", "subscription", "settings"] as const) {
    assert.equal(helpGuideForPage(key).key, key);
    assert.ok(helpGuideForPage(key).steps.length >= 4, key);
  }
  assert.equal(helpGuideForPage("custom:example").key, "custom");
  for (const key of ["projects", "notes", "zagulyaky", "viewer", "team", "gedcom", "tree-statistics"] as const) assert.ok(helpGuides[key].steps.length >= 4, key);
});
test("all profile, editor, places and statistics tabs resolve to specific articles", () => {
  for (const [parent, topics] of Object.entries(contexts)) for (const topic of topics) {
    const article = helpArticleFor(parent as keyof typeof contexts, topic);
    assert.equal(article.key, `${parent}:${topic}`);
    assert.ok(article.steps.length >= 3, article.key);
  }
  const editor = readFileSync(new URL("../src/features/persons-v2/PersonEditorV2.tsx", import.meta.url), "utf8");
  for (const topic of contexts.persons.filter((key) => key.startsWith("edit-"))) assert.ok(editor.includes(`helpTopic="${topic.slice(5)}"`), topic);
  assert.match(editor, /automatic=\{helpActive\}/);
});
test("manual keys are unique and steps have meaningful non-empty Ukrainian instructions", () => {
  assert.equal(new Set(helpArticles.map((item) => item.key)).size, helpArticles.length);
  for (const item of helpArticles) {
    assert.ok(item.title.length >= 3 && item.intro.length > 20, item.key);
    for (const step of item.steps) assert.ok(step.title.length > 3 && step.text.length > 25, item.key);
  }
});
test("search covers detailed text, ignores case and whitespace, and has no administration instructions", () => {
  assert.ok(searchHelpArticles("  gEdCoM ").some((item) => item.key === "gedcom"));
  assert.ok(searchHelpArticles("дата смерті").some((item) => item.key === "persons:timeline"));
  assert.ok(searchHelpArticles("ctrl+v").some((item) => item.key === "findings:edit"));
  assert.equal(searchHelpArticles("несуществующий-тест-123").length, 0);
  assert.equal(searchHelpArticles("адміністрування").length, 0);
  assert.equal(helpArticles.some((item) => item.key.startsWith("admin")), false);
  for (const path of ["../src/pages/AdminPanelPage.tsx", "../src/components/admin/ZagulyakyModerationPanel.tsx"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /SectionHelp|HelpManualDialog/);
  }
});
test("unknown and inherited object keys cannot select a manual entry", () => {
  assert.equal(helpArticleFor("persons", "missing").key, "persons");
  for (const value of ["missing", "constructor", "toString", "__proto__"]) assert.equal(helpGuideForPage(value as never).key, "workspace-intro");
});
test("context progress accepts only known keys explicitly marked as seen", () => {
  for (const raw of [null, "broken", "[]", "true", "42", "null"]) assert.deepEqual(parseHelpContextProgress(raw), {});
  assert.deepEqual(parseHelpContextProgress('{"persons:timeline":true,"findings":true,"admin":false,"unknown":true,"settings":"true","__proto__":true}'), { "persons:timeline": true, findings: true });
});
test("first-visit progress is scoped per account and can be reset without touching project data", () => {
  const values = new Map<string, string>();
  const memory: HelpProgressStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  const a = createScopedHelpStorage("account-a", memory)!;
  const b = createScopedHelpStorage("account-b", memory)!;
  a.setItem(HELP_CONTEXT_PROGRESS_KEY, '{"persons:timeline":true}');
  assert.deepEqual(parseHelpContextProgress(b.getItem(HELP_CONTEXT_PROGRESS_KEY)), {});
  assert.deepEqual(parseHelpContextProgress(a.getItem(HELP_CONTEXT_PROGRESS_KEY)), { "persons:timeline": true });
  a.setItem(HELP_CONTEXT_PROGRESS_KEY, "{}");
  assert.deepEqual(parseHelpContextProgress(a.getItem(HELP_CONTEXT_PROGRESS_KEY)), {});
});
test("an anonymous public visit does not consume a signed-in user's legacy opt-out", () => {
  const values = new Map([[HELP_STORAGE_KEYS.autoTipsDisabled, "1"]]);
  const memory: HelpProgressStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  assert.equal(createScopedHelpStorage("anonymous", memory)!.getItem(HELP_STORAGE_KEYS.autoTipsDisabled), null);
  assert.equal(values.get(HELP_STORAGE_KEYS.autoTipsDisabled), "1");
  assert.equal(createScopedHelpStorage("signed-in", memory)!.getItem(HELP_STORAGE_KEYS.autoTipsDisabled), "1");
});
test("help uses a compact toolbar slot and temporary overlay, never a full-width page banner", () => {
  const layout = readFileSync(new URL("../src/components/Layout.tsx", import.meta.url), "utf8");
  const context = readFileSync(new URL("../src/help/ContextHelp.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/help/contextHelp.css", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /<SectionHelp/);
  assert.match(layout, /<HelpCenter/);
  assert.match(css, /width: 32px; height: 32px/);
  assert.match(css, /context-help-tip \{ position: fixed/);
  assert.doesNotMatch(css, /context-help__bar/);
  assert.match(context, /popover="manual"/);
  assert.match(context, /window\.setTimeout\(onClose, 14000\)/);
  assert.match(context, /aria-haspopup="dialog"/);
  assert.match(context, /opener\?\.isConnected/);
  assert.match(context, /IntersectionObserver/);
  assert.match(context, /!preferences\.manualOpen/);
  assert.match(context, /event\.key === "Tab"/);
  assert.doesNotMatch(context, /supabase|analytics\.track|fetch\(/);
});
