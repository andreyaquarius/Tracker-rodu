import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const requiredMigrations = [
  "202607300001_external_pdf_viewer_foundation.sql",
  "202607300002_pdf_gateway_sessions.sql",
  "202607300003_external_pdf_viewer_hardening.sql",
  "202607300004_external_pdf_observability.sql",
  "202607300005_external_pdf_source_revalidation.sql",
  "202607300006_google_drive_pdf_gateway_sessions.sql",
  "202607300007_external_pdf_pending_resolved_metadata.sql",
  "202608030001_public_google_drive_pdf_sessions.sql",
  "202608030002_external_pdf_export_rate_limit.sql",
];

for (const name of requiredMigrations) {
  const path = resolve(root, "supabase", "migrations", name);
  if (!existsSync(path)) fail(`Required PDF migration is missing: ${name}`);
}

const foundation = readFileSync(
  resolve(root, "supabase", "migrations", requiredMigrations[0]),
  "utf8",
);
const flagInsert = /insert into public\.app_feature_flags[\s\S]*?'external_pdf_viewer_v2'[\s\S]*?false[\s\S]*?on conflict \(key\) do update[\s\S]*?description = excluded\.description;/iu
  .exec(foundation)?.[0];
if (!flagInsert || /is_enabled\s*=\s*excluded\.is_enabled/iu.test(flagInsert)) {
  fail("The database rollout flag must start disabled and preserve the administrator's current choice.");
}

if (process.argv.includes("--deployment")) {
  const appOrigin = deploymentOrigin("APP_URL");
  const allowedOrigin = deploymentOrigin("ALLOWED_ORIGIN");
  if (appOrigin !== allowedOrigin) {
    fail(`APP_URL (${appOrigin}) and ALLOWED_ORIGIN (${allowedOrigin}) must identify the same origin.`);
  }
  deploymentWorkerUrl();
  const workerSecret = process.env.PDF_EXPORT_WORKER_SECRET?.trim() ?? "";
  if (workerSecret.length < 32) {
    fail("PDF_EXPORT_WORKER_SECRET must contain at least 32 characters.");
  }
}

console.log(
  `External PDF rollout preflight passed (${requiredMigrations.length} ordered migrations${
    process.argv.includes("--deployment") ? ", production origin verified" : ""
  }).`,
);

function deploymentOrigin(name) {
  const raw = process.env[name]?.trim() ?? "";
  if (!raw) fail(`${name} is required.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} must be an absolute HTTPS origin.`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || raw.includes("*")
  ) {
    fail(`${name} must be one exact HTTPS origin without credentials, wildcard, path, query or fragment.`);
  }
  return url.origin;
}

function deploymentWorkerUrl() {
  const raw = process.env.PDF_EXPORT_WORKER_URL?.trim() ?? "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("PDF_EXPORT_WORKER_URL must be an absolute HTTPS URL.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    fail("PDF_EXPORT_WORKER_URL must be a clean HTTPS URL without credentials, query or fragment.");
  }
  return url.href;
}

function fail(message) {
  console.error(`External PDF rollout preflight failed: ${message}`);
  process.exit(1);
}
