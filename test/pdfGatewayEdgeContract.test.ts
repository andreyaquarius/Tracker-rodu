import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edgeSource = readFileSync(
  new URL("../supabase/functions/pdf-gateway/index.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../supabase/migrations/202607300002_pdf_gateway_sessions.sql", import.meta.url),
  "utf8",
);
const hardeningMigration = readFileSync(
  new URL(
    "../supabase/migrations/202607300003_external_pdf_viewer_hardening.sql",
    import.meta.url,
  ),
  "utf8",
);
const driveGatewayMigration = readFileSync(
  new URL(
    "../supabase/migrations/202607300006_google_drive_pdf_gateway_sessions.sql",
    import.meta.url,
  ),
  "utf8",
);
const publicDriveMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608030001_public_google_drive_pdf_sessions.sql",
    import.meta.url,
  ),
  "utf8",
);
const exportRateLimitMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608030002_external_pdf_export_rate_limit.sql",
    import.meta.url,
  ),
  "utf8",
);
const exportWorker = readFileSync(
  new URL("../services/pdf-export-worker/server.mjs", import.meta.url),
  "utf8",
);
const config = readFileSync(
  new URL("../supabase/config.toml", import.meta.url),
  "utf8",
);

test("PDF gateway binds open-session to authenticated project/document/source rows", () => {
  assert.match(edgeSource, /auth\.getUser\(accessToken\)/u);
  assert.match(edgeSource, /\.from\("document_sources"\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.eq\("document_id", documentId\)/u);
  assert.match(edgeSource, /\.eq\("id", sourceId\)/u);
  assert.match(edgeSource, /\.in\("status", \["active", "changed"\]\)/u);
  assert.match(edgeSource, /\.from\("project_members"\)[\s\S]*?\.eq\("user_id", userId\)/u);
  assert.match(edgeSource, /input\.projectId/u);
  const openSessionBody = /async function openSession[\s\S]*?\n\}\n\nasync function requireProjectDocument/u
    .exec(edgeSource)?.[0] ?? "";
  assert.doesNotMatch(openSessionBody, /input\.url/u);
  assert.match(openSessionBody, /source\.provider !== "wikimedia"[\s\S]*?source\.provider !== "direct_pdf"[\s\S]*?source\.provider !== "google_drive"/u);
  assert.match(openSessionBody, /encryptApiKey\(googleDriveAccessToken, encryptionKey\)/u);
  assert.match(openSessionBody, /target_upstream_authorization_ciphertext: upstreamAuthorizationCiphertext/u);
  assert.doesNotMatch(openSessionBody, /streamUrl:[^\n]*googleDriveAccessToken/u);
  assert.match(openSessionBody, /requireCurrentProjectMembership\(admin, source\.project_id, user\.id\)/u);
  assert.match(openSessionBody, /requireExternalPdfViewerEnabled\(admin\)/u);
  assert.match(edgeSource, /source\.status !== "active" && source\.status !== "changed"/u);
  assert.doesNotMatch(openSessionBody, /requireCurrentProjectEditor/u);
  assert.match(config, /\[functions\.pdf-gateway\]\s*\r?\nverify_jwt = true/u);
});

test("metadata probe is project-authorized and reads at most the PDF signature range", () => {
  assert.match(edgeSource, /async function probeSource/u);
  assert.match(edgeSource, /\.from\("documents"\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.eq\("id", documentId\)/u);
  assert.match(edgeSource, /validatePublicPdfUrl\(input\.url\)/u);
  assert.match(edgeSource, /method: "HEAD"/u);
  assert.match(edgeSource, /Range: "bytes=0-4"/u);
  assert.match(edgeSource, /reader\.cancel\("probe-magic-complete"\)/u);
  assert.match(edgeSource, /canonicalUrl: probe\.finalUrl\.href/u);
  assert.match(edgeSource, /mimeType: "application\/pdf"/u);
  assert.match(edgeSource, /acceptsRanges:/u);
  assert.match(edgeSource, /fingerprint:/u);
  const probeBody = /async function probeSource[\s\S]*?\n\}\n\nfunction displayNameFromUrl/u
    .exec(edgeSource)?.[0] ?? "";
  assert.match(probeBody, /requireCurrentProjectEditor\(admin, projectId, user\.id\)/u);
  assert.match(probeBody, /requireExternalPdfViewerEnabled\(admin\)/u);
  assert.match(probeBody, /reserveSourceProbe\(admin, projectId, user\.id, limits\)/u);
  assert.match(edgeSource, /admin\.rpc\("reserve_external_pdf_probe"/u);
  assert.match(edgeSource, /PROBE_RATE_LIMIT/u);
  assert.match(edgeSource, /PDF_PROBE_MAX_REQUESTS_PER_WINDOW/u);
  assert.match(edgeSource, /PDF_PROBE_WINDOW_SECONDS/u);
  assert.match(edgeSource, /role !== "owner" && role !== "editor"/u);
});

test("PDF gateway has explicit Range, CORS, redirect and streaming boundaries", () => {
  assert.match(edgeSource, /"Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS"/u);
  assert.match(edgeSource, /authorization, apikey, x-client-info, content-type, range, if-range/u);
  assert.match(edgeSource, /Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag, Last-Modified/u);
  assert.match(edgeSource, /"Cache-Control": "private, no-store"/u);
  assert.match(edgeSource, /"X-Content-Type-Options": "nosniff"/u);
  assert.match(edgeSource, /fetchPublicPdfWithRedirects/u);
  assert.match(edgeSource, /createBoundedPdfStream\(upstream\.response\.body/u);
  assert.match(edgeSource, /idleTimeoutMs: limits\.streamIdleTimeoutMs/u);
  assert.match(edgeSource, /PDF_PROXY_STREAM_IDLE_TIMEOUT_MS/u);
  assert.doesNotMatch(edgeSource, /\.arrayBuffer\(/u);
  assert.doesNotMatch(edgeSource, /console\./u);
  assert.doesNotMatch(edgeSource, /Access-Control-Allow-Origin"\]\s*=\s*"\*"/u);
  assert.doesNotMatch(edgeSource, /Р[”—°]/u, "user-facing Ukrainian messages must not be mojibake");
});

test("database rollout flag is also a server-side kill switch for every gateway route", () => {
  assert.match(
    edgeSource,
    /from\("app_feature_flags"\)[\s\S]*?eq\("key", "external_pdf_viewer_v2"\)/u,
  );
  assert.match(edgeSource, /FEATURE_DISABLED/u);
  const streamBody = /async function streamPdf[\s\S]*?\n\}\n\nfunction route/u
    .exec(edgeSource)?.[0] ?? "";
  assert.match(streamBody, /requireExternalPdfViewerEnabled\(admin\)/u);
});

test("gateway sessions persist only a hash and are inaccessible to browser roles", () => {
  assert.match(migration, /create table if not exists public\.pdf_access_sessions/u);
  assert.match(migration, /token_hash text not null unique/u);
  assert.doesNotMatch(migration, /\bupstream_url\b/u);
  assert.doesNotMatch(migration, /\braw_token\b/u);
  assert.match(migration, /alter table public\.pdf_access_sessions enable row level security/u);
  assert.match(migration, /revoke all on public\.pdf_access_sessions from public, anon, authenticated/u);
  assert.match(migration, /consume_pdf_access_session/u);
  assert.match(migration, /session\.expires_at > pg_catalog\.now\(\)/u);
  assert.match(migration, /session\.request_count < session\.max_requests/u);
  assert.match(migration, /'pdf_access_sessions'/u);
});

test("gateway creates sessions atomically under a bounded per-user/project cap", () => {
  const openSessionBody = /async function openSession[\s\S]*?\n\}\n\nasync function requireProjectDocument/u
    .exec(edgeSource)?.[0] ?? "";
  assert.match(openSessionBody, /admin\.rpc\("create_pdf_access_session"/u);
  assert.match(openSessionBody, /target_max_active_sessions: limits\.maxActiveSessionsPerUserProject/u);
  assert.match(openSessionBody, /ACTIVE_SESSION_LIMIT/u);
  assert.doesNotMatch(openSessionBody, /\.from\("pdf_access_sessions"\)\.delete\(\)/u);
  assert.match(edgeSource, /PDF_PROXY_MAX_ACTIVE_SESSIONS_PER_USER_PROJECT/u);

  assert.match(hardeningMigration, /create or replace function public\.create_pdf_access_session/u);
  assert.match(hardeningMigration, /pg_advisory_xact_lock/u);
  assert.match(
    hardeningMigration,
    /where session\.user_id = target_user_id[\s\S]*?session\.project_id = target_project_id[\s\S]*?session\.expires_at <= pg_catalog\.now\(\)/u,
  );
  assert.match(hardeningMigration, /active_session_count >= target_max_active_sessions/u);
  assert.match(hardeningMigration, /target_max_active_sessions is null/u);
  assert.match(
    hardeningMigration,
    /session\.expires_at <= pg_catalog\.now\(\)[\s\S]*?session\.request_count >= session\.max_requests/u,
  );
  assert.match(
    hardeningMigration,
    /session\.expires_at > pg_catalog\.now\(\)[\s\S]*?session\.request_count < session\.max_requests/u,
  );
  assert.match(hardeningMigration, /message = 'PDF_ACTIVE_SESSION_LIMIT'/u);
  assert.match(
    hardeningMigration,
    /revoke all on function public\.create_pdf_access_session[\s\S]*?from public, anon, authenticated/u,
  );
  assert.match(
    hardeningMigration,
    /grant execute on function public\.create_pdf_access_session[\s\S]*?to service_role/u,
  );
});

test("private Drive sessions retain only encrypted short-lived upstream authorization", () => {
  assert.match(driveGatewayMigration, /add column if not exists upstream_authorization_ciphertext text/u);
  assert.match(driveGatewayMigration, /provider in \('wikimedia', 'direct_pdf', 'google_drive'\)/u);
  assert.match(driveGatewayMigration, /provider = 'google_drive'[\s\S]*?upstream_authorization_ciphertext is not null/u);
  assert.match(driveGatewayMigration, /provider <> 'google_drive'[\s\S]*?upstream_authorization_ciphertext is null/u);
  assert.match(driveGatewayMigration, /PDF_UPSTREAM_AUTHORIZATION_INVALID/u);
  assert.match(driveGatewayMigration, /revoke all on function public\.create_pdf_access_session[\s\S]*?from public, anon, authenticated/u);
  assert.match(driveGatewayMigration, /grant execute on function public\.create_pdf_access_session[\s\S]*?to service_role/u);
  assert.doesNotMatch(driveGatewayMigration, /\baccess_token\b/u);

  const streamBody = /async function streamPdf[\s\S]*?\n\}\n\nfunction pdfResponse/u
    .exec(edgeSource)?.[0] ?? "";
  assert.match(streamBody, /upstreamAuthorizationForSession\(source, session, env\)/u);
  assert.match(streamBody, /authorization: upstreamAuthorization/u);
  assert.match(edgeSource, /decryptApiKey\(ciphertext, encryptionKey\)/u);
  assert.match(edgeSource, /"www\.googleapis\.com"[\s\S]*?"content\.googleapis\.com"[\s\S]*?"drive\.usercontent\.google\.com"/u);
});

test("public Drive shares use a keyless opaque session while the API key remains server-only", () => {
  assert.match(edgeSource, /async function probePublicGoogleDrive/u);
  assert.match(edgeSource, /GOOGLE_DRIVE_PUBLIC_API_KEY/u);
  assert.match(edgeSource, /googleDrivePublicMetadataUrl/u);
  assert.match(edgeSource, /googleDrivePublicMediaUrl/u);
  assert.match(edgeSource, /remainder\[0\] === "probe-google-drive-public"/u);
  assert.match(edgeSource, /target_upstream_access_mode: source\.access_mode/u);
  assert.match(publicDriveMigration, /add column if not exists upstream_access_mode text/u);
  assert.match(publicDriveMigration, /upstream_access_mode = 'google_drive_api'[\s\S]*?upstream_authorization_ciphertext is not null/u);
  assert.match(publicDriveMigration, /upstream_access_mode = 'secure_proxy'[\s\S]*?upstream_authorization_ciphertext is null/u);
  assert.match(publicDriveMigration, /target_upstream_access_mode/u);
  assert.doesNotMatch(publicDriveMigration, /GOOGLE_DRIVE_PUBLIC_API_KEY/u);
});

test("gateway reserves each outbound metadata probe in an atomic server-side rate bucket", () => {
  assert.match(hardeningMigration, /create table if not exists private\.external_pdf_probe_rate_limits/u);
  assert.match(hardeningMigration, /primary key \(user_id, project_id\)/u);
  assert.match(hardeningMigration, /create or replace function public\.reserve_external_pdf_probe/u);
  assert.match(hardeningMigration, /on conflict \(user_id, project_id\) do update/u);
  assert.match(hardeningMigration, /return resulting_count <= target_max_requests/u);
  assert.match(
    hardeningMigration,
    /revoke all on function public\.reserve_external_pdf_probe[\s\S]*?from public, anon, authenticated/u,
  );
  assert.match(
    hardeningMigration,
    /grant execute on function public\.reserve_external_pdf_probe[\s\S]*?to service_role/u,
  );
});

test("privacy-safe client events are authenticated, membership scoped, and independently rate limited", () => {
  const clientEventBody = /async function clientEvent[\s\S]*?\n\}\n\nasync function probeSource/u
    .exec(edgeSource)?.[0] ?? "";
  assert.match(clientEventBody, /authenticatedContext\(request\)/u);
  assert.match(clientEventBody, /requireExternalPdfViewerEnabled\(admin\)/u);
  assert.match(clientEventBody, /parseClientPdfOperationalEvent\(input\)/u);
  assert.match(clientEventBody, /requireCurrentProjectMembership\(admin, parsed\.projectId, user\.id\)/u);
  assert.match(clientEventBody, /reserveTelemetryEvent\(admin, parsed\.projectId, user\.id, limits\)/u);
  assert.match(edgeSource, /admin\.rpc\("reserve_external_pdf_telemetry_event"/u);
  assert.match(edgeSource, /PDF_TELEMETRY_MAX_EVENTS_PER_WINDOW/u);
  assert.match(edgeSource, /PDF_TELEMETRY_WINDOW_SECONDS/u);
  assert.match(edgeSource, /PDF_TELEMETRY_SUCCESS_SAMPLE_PERCENT/u);
  assert.match(edgeSource, /"X-Request-Id": requestId\(request\)/u);
  assert.match(edgeSource, /remainder\[0\] === "client-event"/u);
});

test("large PDF subsets use an authenticated, bounded, ephemeral qpdf worker", () => {
  const exportBody = /async function exportPdfPages[\s\S]*?\n\}\n\nasync function probeSource/u
    .exec(edgeSource)?.[0] ?? "";
  assert.match(exportBody, /authenticatedContext\(request\)/u);
  assert.match(exportBody, /requireExternalPdfViewerEnabled\(admin\)/u);
  assert.match(exportBody, /requireCurrentProjectMembership\(admin, projectId, user\.id\)/u);
  assert.match(exportBody, /reserveServerExport\(admin, projectId, user\.id, limits\)/u);
  assert.match(exportBody, /sourceForSession\(admin, session, env\)/u);
  assert.match(exportBody, /X-Tracker-Timestamp/u);
  assert.match(exportBody, /X-Tracker-Signature/u);
  assert.match(exportBody, /createBoundedPdfStream\(workerResponse\.body/u);
  assert.doesNotMatch(exportBody, /input\.sourceUrl/u);
  assert.match(edgeSource, /remainder\[0\] === "export-pages"/u);

  assert.match(exportRateLimitMigration, /create table if not exists private\.external_pdf_export_rate_limits/u);
  assert.match(exportRateLimitMigration, /create or replace function public\.reserve_external_pdf_export/u);
  assert.match(exportRateLimitMigration, /on conflict \(user_id, project_id\) do update/u);
  assert.match(exportRateLimitMigration, /revoke all on function public\.reserve_external_pdf_export[\s\S]*?from public, anon, authenticated/u);
  assert.match(exportRateLimitMigration, /grant execute on function public\.reserve_external_pdf_export[\s\S]*?to service_role/u);

  assert.match(exportWorker, /mkdtemp\(join\(tmpdir\(\), "tracker-pdf-export-"\)\)/u);
  assert.match(exportWorker, /spawn\(binary, \[[\s\S]*?"--pages"/u);
  assert.match(exportWorker, /rm\(temporaryDirectory, \{ recursive: true, force: true \}\)/u);
  assert.doesNotMatch(exportWorker, /supabase|storage\.from|console\./iu);
});

test("production proxy streaming is HMAC authenticated and DNS-pinned by the worker", () => {
  const streamBody = /async function streamPdf[\s\S]*?\n\}\n\nfunction pdfResponse/u
    .exec(edgeSource)?.[0] ?? "";
  assert.match(streamBody, /optionalConfiguredPdfStreamWorker\(env\)/u);
  assert.match(streamBody, /fetchPdfThroughPinnedWorker/u);
  assert.match(edgeSource, /worker\.url\.pathname = "\/v1\/stream"/u);
  assert.match(edgeSource, /X-Tracker-Timestamp/u);
  assert.match(edgeSource, /X-Tracker-Signature/u);
  assert.match(exportWorker, /request\.url === "\/v1\/stream"/u);
  assert.match(exportWorker, /resolveAndPinPublicAddress\(currentUrl\.hostname\)/u);
  assert.match(exportWorker, /lookup: \(_hostname, _options, callback\) => callback\(null, pinned\.address, pinned\.family\)/u);
  assert.match(exportWorker, /records\.some\(\(record\) => !isPublicIpAddress\(record\.address\)\)/u);
  assert.match(exportWorker, /REDIRECT_HOST_BLOCKED/u);
});
