import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const functions = [
  {
    name: "hypothesis review",
    path: "../supabase/functions/review-hypothesis/index.ts",
    feature: "hypothesis_review",
    selectCall: "await readGeminiAccess(",
    reserveCall: "await reserveHypothesisReviewCredit(",
    geminiCall: "await callGemini(",
  },
  {
    name: "finding fragment indexing",
    path: "../supabase/functions/index-finding-fragment/index.ts",
    feature: "finding_indexing",
    selectCall: "await readGeminiAccess(",
    reserveCall: "await reserveFindingIndexingCredit(",
    geminiCall: "await callGeminiWithInlineImage(",
  },
] as const;

for (const contract of functions) {
  test(`${contract.name} reserves exactly one tariff credit before Gemini for every key source`, () => {
    const edge = source(contract.path);
    const handler = edge.slice(edge.indexOf("Deno.serve"));
    const selectPosition = handler.indexOf(contract.selectCall);
    const reservePosition = handler.indexOf(contract.reserveCall);
    const geminiPosition = handler.indexOf(contract.geminiCall);

    assert.ok(selectPosition >= 0, "an available Gemini key is selected");
    assert.ok(reservePosition > selectPosition, "credit reservation follows key selection");
    assert.ok(geminiPosition > reservePosition, "Gemini is called only after the credit reservation");
    assert.equal(edge.match(/"begin_ai_credit_usage"/gu)?.length, 1);
    assert.match(edge, new RegExp(`feature_key:\\s*"${contract.feature}"`, "u"));
    assert.match(edge, /credits_requested:\s*1/u);
    assert.match(edge, /throw new RequestError\(402, "Використано всі доступні ШІ-кредити цього місяця\."\)/u);
    assert.doesNotMatch(
      edge,
      /Використано всі ШІ-кредити[\s\S]{0,240}Додайте власний API-ключ/u,
    );
  });
}

test("AI documentation no longer presents BYOK as a post-quota fallback", () => {
  const supabaseReadme = source("../supabase/README.md");
  const setup = source("../docs/AI_AGENT_SETUP.md");
  const tariffs = source("../docs/TREE_CENTERED_TARIFFS.md");

  assert.doesNotMatch(
    supabaseReadme,
    /Після вичерпання включеного пулу[\s\S]{0,160}власний API-ключ/u,
  );
  assert.match(supabaseReadme, /Власний ключ не додає кредитів/u);
  assert.match(setup, /запит\s+до Gemini не надсилається навіть за наявності власного ключа/u);
  assert.match(tariffs, /Власний ключ не є fallback після вичерпання місячного пулу/u);
});
