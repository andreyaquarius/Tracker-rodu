import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicPricingPlans } from "../src/utils/publicSiteContent.ts";

function limitsFor(code: "free" | "researcher" | "professional") {
  const plan = publicPricingPlans.find((item) => item.code === code);
  assert.ok(plan, `missing public plan: ${code}`);
  return Object.fromEntries(plan.limits.map((limit) => [limit.label, limit.value]));
}

test("public tariffs are centered on trees, people, editors and AI credits", () => {
  assert.deepEqual(limitsFor("free"), {
    "Робочі простори": "1",
    "Родові дерева": "1",
    "Особи": "До 500",
    "Редактори, крім власника": "0",
    "Глядачі": "Без тарифного ліміту",
    "ШІ-кредити": "5 на місяць",
    "Основні модулі": "Включено",
    "GEDCOM імпорт та експорт": "У межах 500 осіб",
  });

  assert.equal(limitsFor("researcher")["Особи"], "До 15 000");
  assert.equal(limitsFor("researcher")["Редактори, крім власника"], "2");
  assert.equal(limitsFor("professional")["Особи"], "Без тарифного ліміту");
  assert.equal(limitsFor("professional")["Редактори, крім власника"], "5");
});

test("static pricing page matches the tree-centered model and omits obsolete headline quotas", () => {
  const source = readFileSync(
    new URL("../public/pricing/index.html", import.meta.url),
    "utf8",
  );
  assert.match(source, /<span>Особи<\/span><strong>До 500<\/strong>/);
  assert.match(source, /<span>Особи<\/span><strong>До 15 000<\/strong>/);
  assert.match(source, /<span>Редактори, крім власника<\/span><strong>5<\/strong>/);
  assert.match(source, /Без тарифного ліміту/);
  assert.doesNotMatch(source, /Записи в розділах/);
  assert.doesNotMatch(source, /Імпорти за місяць/);
});
