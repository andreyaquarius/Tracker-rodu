import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spreadsheetCsvCell } from "../src/utils/spreadsheetSafe.ts";
import { missingSecurityHeaders } from "../scripts/verify-security-headers.mjs";
const source = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
test("hosting verification fails closed on absent real HTTP protections", () => {
  assert.equal(missingSecurityHeaders(new Headers()).length, 5);
  const config = JSON.parse(source("vercel.json"));
  const headers = new Headers(config.headers[0].headers.map((v: {key: string; value: string}) => [v.key, v.value]));
  assert.deepEqual(missingSecurityHeaders(headers), []);
});

test("all formula/control prefixes are neutralized only in the CSV export copy", () => {
  for (const value of ["=1+1", "\n=1", "\t=1", "\r=1", " \t@SUM(A1)", "\u0000+1", "- Джерело", "+1", " \r\n-2"]) {
    assert.equal(spreadsheetCsvCell(value), `"'${value}"`);
  }
  assert.equal(spreadsheetCsvCell('Мар’яна "ѣ"'), '"Мар’яна ""ѣ"""');
});
test("XLSX inline strings and imported source fields are not CSV-escaped or trimmed", () => {
  const writer = source("src/utils/excelExport.ts");
  assert.doesNotMatch(writer, /neutralizeSpreadsheetValue/);
  assert.match(writer, /t="inlineStr"/);
  const reader = source("src/utils/tableDataImport.ts");
  assert.doesNotMatch(reader, /cells\[columnIndex\]\?\.trim\(\)|const value = rawValue.trim\(\)/);
});
test("untrusted HTML preview always has an empty sandbox", () => {
  const viewer = source("src/components/DocumentWorkspaceViewer.tsx");
  const frames = viewer.match(/<iframe\b[^>]*>/g) ?? [];
  assert.ok(frames.length);
  for (const frame of frames) { assert.match(frame, /sandbox=""/); assert.doesNotMatch(frame, /allow-same-origin|allow-scripts/); }
});
test("activity UI uses protected projection and minimal Realtime rows", () => {
  assert.match(source("src/services/projectMetadata.ts"), /rpc\("list_project_activity_v1"/);
  const realtime = source("src/services/projectRealtime.ts");
  assert.match(realtime, /table: "project_change_events"/);
  assert.doesNotMatch(realtime, /table: "activity_log"/);
});
test("invitation provider call requires an atomic server claim and stable key", () => {
  const handler = source("supabase/functions/send-project-invitation/index.ts");
  assert.ok(handler.indexOf('rpc("claim_invitation_email_v1"') < handler.indexOf('fetch("https://api.resend.com'));
  assert.match(handler, /"Idempotency-Key": `project-invitation\/\$\{claim.id\}`/);
  assert.match(handler, /AbortSignal.timeout\(30_000\)/);
});
test("deployment secrets are separate from dependency/test jobs and actions are immutable", () => {
  const workflow = source(".github/workflows/deploy-supabase-functions.yml");
  const verify = workflow.split("  deploy-edge-functions:")[0];
  assert.doesNotMatch(verify, /secrets\./);
  assert.match(verify, /aquasec\/trivy@sha256:[0-9a-f]{64}/);
  assert.match(verify, /--ignore-unfixed --exit-code 1/);
  const deploy = workflow.split("  deploy-edge-functions:")[1];
  assert.match(deploy, /needs: verify/);
  assert.doesNotMatch(deploy, /run: npm ci/);
  const configStep = deploy.split('- name: Verify Supabase deployment configuration')[1].split('- name: Set up Supabase CLI')[0];
  for (const key of ['PDF_EXPORT_WORKER_SECRET', 'TELEGRAM_WORKER_SECRET']) assert.ok(configStep.includes(`${key}: `), `configuration check needs scoped ${key}`);
  for (const file of ["deploy-supabase-functions.yml", "deploy.yml", "gedcom-exports.yml"]) {
    for (const [, ref] of source(".github/workflows/" + file).matchAll(/uses: ([^\s]+)/g)) assert.match(ref, /@[0-9a-f]{40}$/);
  }
});
