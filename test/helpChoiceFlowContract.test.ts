import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const app = source("../src/App.tsx");
const layout = source("../src/components/Layout.tsx");
const sidebar = source("../src/components/Sidebar.tsx");
const chooser = source("../src/components/HelpChoiceModal.tsx");
const feedback = source("../src/pages/FeedbackPage.tsx");
const geneHelp = source("../src/components/GeneHelpRequestModal.tsx");

test("sidebar exposes one unambiguous Help entry and keeps the unread badge", () => {
  assert.equal(
    (sidebar.match(/>\s*Допомога\s*</gu) ?? []).length,
    1,
    "Sidebar must contain exactly one visible Help label",
  );
  assert.doesNotMatch(sidebar, /Попросити допомоги в GeneHelp/u);
  assert.doesNotMatch(sidebar, /Зворотний зв’язок/u);
  assert.match(sidebar, /onOpenHelp:\s*\(\)\s*=>\s*void/u);
  assert.match(sidebar, /onClick=\{openHelp\}/u);
  assert.match(sidebar, /<FeedbackNavBadge accountId=\{accountId\}/u);

  assert.match(layout, /onOpenHelp:\s*\(\)\s*=>\s*void/u);
  assert.match(layout, /onOpenHelp=\{props\.onOpenHelp\}/u);
});

test("Help chooser clearly separates Tracker support from GeneHelp research help", () => {
  for (const prop of [
    "onClose",
    "onOpenTrackerSupport",
    "onOpenGeneHelp",
    "showGeneHelp",
  ]) {
    assert.match(chooser, new RegExp(`\\b${prop}\\b`));
  }

  assert.match(chooser, /<Modal[^>]*title="Допомога"/u);
  assert.match(chooser, /Підтримка Трекера Роду/u);
  assert.match(chooser, /Допомога з дослідженням[\s\S]{0,100}GeneHelp/u);
  assert.match(chooser, /onAction=\{onOpenTrackerSupport\}/u);
  assert.match(chooser, /onAction=\{onOpenGeneHelp\}/u);
  assert.match(chooser, /onClick=\{onAction\}/u);
  assert.match(chooser, /\{showGeneHelp\s*\?\s*\(/u);
});

test("Help chooser routes to a new Tracker support request or the existing GeneHelp modal", () => {
  assert.match(app, /import \{ HelpChoiceModal \} from "\.\/components\/HelpChoiceModal"/u);
  assert.match(app, /const \[helpChoiceOpen, setHelpChoiceOpen\] = useState\(false\)/u);
  assert.match(app, /onOpenHelp=\{\(\) => setHelpChoiceOpen\(true\)\}/u);
  assert.match(app, /\{helpChoiceOpen \? \([\s\S]*?<HelpChoiceModal/u);
  assert.match(
    app,
    /onOpenTrackerSupport=\{\(\) => \{[\s\S]{0,240}?setHelpChoiceOpen\(false\);[\s\S]{0,240}?routerNavigate\("\/feedback\?new=1"\);[\s\S]{0,120}?\}\}/u,
  );
  assert.match(
    app,
    /onOpenGeneHelp=\{\(\) => \{[\s\S]{0,240}?setHelpChoiceOpen\(false\);[\s\S]{0,240}?setGeneHelpOpen\(true\);[\s\S]{0,120}?\}\}/u,
  );
  assert.match(app, /showGeneHelp=\{canOpenGeneHelp\}/u);
  assert.match(app, /<GeneHelpRequestModal onClose=\{\(\) => setGeneHelpOpen\(false\)\}/u);
});

test("Tracker support opens its composer and GeneHelp warns against technical requests", () => {
  assert.match(feedback, /startComposer\?:\s*boolean/u);
  assert.match(feedback, /Підтримка Трекера Роду/u);
  assert.match(feedback, /useState\([^\n]*startComposer/u);
  assert.match(geneHelp, /GeneHelp не вирішує технічні питання/u);
  assert.match(geneHelp, /платформи Трекера Роду/u);
  assert.match(geneHelp, /скористайтеся підтримкою Трекера Роду/u);
});
