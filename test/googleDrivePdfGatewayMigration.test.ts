import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607300006_google_drive_pdf_gateway_sessions.sql",
    import.meta.url,
  ),
  "utf8",
);

test("Drive gateway migration stores only bounded AES-GCM ciphertext in service-only sessions", () => {
  assert.match(migration, /add column if not exists upstream_authorization_ciphertext text/u);
  assert.match(migration, /provider in \('wikimedia', 'direct_pdf', 'google_drive'\)/u);
  assert.match(migration, /provider = 'google_drive'[\s\S]*?upstream_authorization_ciphertext is not null/u);
  assert.match(migration, /pg_catalog\.left\(upstream_authorization_ciphertext, 3\) = 'v1\.'/u);
  assert.match(migration, /pg_catalog\.length\(upstream_authorization_ciphertext\) between 20 and 12000/u);
  assert.match(migration, /provider <> 'google_drive'[\s\S]*?upstream_authorization_ciphertext is null/u);
  assert.doesNotMatch(migration, /\b(?:access_token|refresh_token|bearer_token)\b/iu);
});

test("Drive session creation validates credential/provider alignment and stays service-role only", () => {
  const body = functionBody("create_pdf_access_session");
  assert.match(body, /target_provider = 'google_drive'[\s\S]*?target_upstream_authorization_ciphertext/u);
  assert.match(body, /target_provider <> 'google_drive'[\s\S]*?target_upstream_authorization_ciphertext is not null/u);
  assert.match(body, /message = 'PDF_UPSTREAM_AUTHORIZATION_INVALID'/u);
  assert.match(body, /pg_advisory_xact_lock/u);
  assert.match(body, /upstream_authorization_ciphertext[\s\S]*?target_upstream_authorization_ciphertext/u);
  assert.match(
    migration,
    /revoke all on function public\.create_pdf_access_session\([\s\S]*?\) from public, anon, authenticated/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.create_pdf_access_session\([\s\S]*?\) to service_role/u,
  );
});

function functionBody(name: string): string {
  const expression = new RegExp(
    `create function public\\.${name}\\([\\s\\S]*?\\nas \\$\\$([\\s\\S]*?)\\$\\$;`,
    "u",
  );
  const match = expression.exec(migration);
  assert.ok(match, `migration must define public.${name}`);
  return match[1] ?? "";
}
