import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const gateway = readFileSync(
  new URL("../supabase/functions/pdf-gateway/index.ts", import.meta.url),
  "utf8",
);
const foundation = readFileSync(
  new URL(
    "../supabase/migrations/202607300001_external_pdf_viewer_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/deploy-supabase-functions.yml", import.meta.url),
  "utf8",
);
const preflight = readFileSync(
  new URL("../scripts/verify-external-pdf-rollout.mjs", import.meta.url),
  "utf8",
);

test("the rollout remains fail-closed at both frontend and gateway boundaries", () => {
  assert.match(
    app,
    /VITE_EXTERNAL_PDF_VIEWER_V2[\s\S]*?isExternalPdfViewerV2Enabled\(featureFlags\)/u,
  );
  assert.match(
    gateway,
    /from\("app_feature_flags"\)[\s\S]*?eq\("key", "external_pdf_viewer_v2"\)[\s\S]*?data\?\.is_enabled !== true/u,
  );
  assert.match(gateway, /FEATURE_DISABLED/u);

  const flagInsert = /insert into public\.app_feature_flags[\s\S]*?'external_pdf_viewer_v2'[\s\S]*?on conflict \(key\) do update[\s\S]*?description = excluded\.description;/iu
    .exec(foundation)?.[0] ?? "";
  assert.match(flagInsert, /false/u);
  assert.doesNotMatch(flagInsert, /is_enabled\s*=\s*excluded\.is_enabled/iu);
});

test("deployment validates migrations, exact origins, Drive secrets, pinned worker and gateway", () => {
  assert.match(workflow, /node scripts\/verify-external-pdf-rollout\.mjs --deployment/u);
  assert.match(workflow, /supabase secrets list[\s\S]*?ENCRYPTION_KEY/u);
  assert.match(workflow, /supabase secrets list[\s\S]*?GOOGLE_DRIVE_PUBLIC_API_KEY/u);
  assert.match(workflow, /supabase functions list[\s\S]*?pdf-gateway/u);
  assert.match(workflow, /docker build --tag tracker-rodu-pdf-worker:test services\/pdf-export-worker/u);
  assert.match(workflow, /Repository secret PDF_EXPORT_WORKER_URL is required/u);
  assert.match(workflow, /PDF_EXPORT_WORKER_SECRET must contain at least 32 characters/u);
  assert.match(workflow, /PDF_EXPORT_WORKER_URL="\$PDF_EXPORT_WORKER_URL"/u);
  assert.match(workflow, /PDF_EXPORT_WORKER_SECRET="\$PDF_EXPORT_WORKER_SECRET"/u);
  assert.match(workflow, /supabase secrets list[\s\S]*?PDF_EXPORT_WORKER_URL/u);
  assert.match(workflow, /supabase secrets list[\s\S]*?PDF_EXPORT_WORKER_SECRET/u);

  const migrationApply = workflow.indexOf("supabase db push --linked --yes");
  const functionDeploy = workflow.indexOf("supabase functions deploy");
  const deploymentVerify = workflow.indexOf("supabase functions list");
  assert.ok(migrationApply >= 0 && functionDeploy > migrationApply);
  assert.ok(deploymentVerify > functionDeploy);

  assert.match(preflight, /requiredMigrations/u);
  assert.match(preflight, /APP_URL/u);
  assert.match(preflight, /ALLOWED_ORIGIN/u);
  assert.match(preflight, /url\.protocol !== "https:"/u);
  assert.match(preflight, /raw\.includes\("\*"\)/u);
  assert.match(preflight, /PDF_EXPORT_WORKER_URL/u);
  assert.match(preflight, /PDF_EXPORT_WORKER_SECRET must contain at least 32 characters/u);
});
