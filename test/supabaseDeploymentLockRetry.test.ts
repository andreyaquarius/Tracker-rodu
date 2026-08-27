import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy-supabase-functions.yml", import.meta.url),
  "utf8",
);

test("Supabase production deploys never overlap an active database migration", () => {
  assert.match(workflow, /concurrency:\s*[\s\S]*?group:\s*deploy-supabase-production/u);
  assert.match(workflow, /concurrency:\s*[\s\S]*?cancel-in-progress:\s*false/u);
});

test("database push retries only bounded PostgreSQL lock timeouts", () => {
  const applyStep = workflow.slice(
    workflow.indexOf("- name: Apply database migrations"),
    workflow.indexOf("- name: Deploy Edge Functions"),
  );

  assert.match(applyStep, /max_attempts=3/u);
  assert.match(applyStep, /supabase db push --linked --yes 2>&1 \| tee/u);
  assert.match(applyStep, /push_status=\$\{PIPESTATUS\[0\]\}/u);
  assert.match(applyStep, /grep -Eq 'ERROR:\.\*\\\(SQLSTATE 55P03\\\)'/u);
  assert.match(applyStep, /attempt" -ge "\$max_attempts/u);
  assert.match(applyStep, /exit "\$push_status"/u);
  assert.match(applyStep, /retry_delay=\$\(\(attempt \* 15\)\)/u);
  assert.doesNotMatch(applyStep, /SQLSTATE (?!55P03)[0-9A-Z]{5}/u);
});
