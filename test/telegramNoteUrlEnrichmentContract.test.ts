import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  directExternalUrlForPreview,
} from "../supabase/functions/_shared/publicWebPreview.ts";

const migrationSource = readFileSync(
  resolve(process.cwd(), "supabase/migrations/202608270003_telegram_note_external_link_preview.sql"),
  "utf8",
);
const webhookSource = readFileSync(
  resolve(process.cwd(), "supabase/functions/telegram-webhook/index.ts"),
  "utf8",
);

function sqlFunction(source: string, qualifiedName: string): string {
  const start = source.toLocaleLowerCase("en-US").indexOf(
    `create or replace function ${qualifiedName.toLocaleLowerCase("en-US")}`,
  );
  assert.notEqual(start, -1, `Missing SQL function ${qualifiedName}.`);
  const bodyStart = source.indexOf("as $function$", start);
  assert.notEqual(bodyStart, -1, `Missing function body for ${qualifiedName}.`);
  const end = source.indexOf("$function$;", bodyStart);
  assert.notEqual(end, -1, `Missing function terminator for ${qualifiedName}.`);
  return source.slice(start, end + "$function$;".length);
}

function typescriptFunction(source: string, functionName: string): string {
  const start = source.indexOf(`async function ${functionName}(`);
  assert.notEqual(start, -1, `Missing TypeScript function ${functionName}.`);
  const nextFunction = source.indexOf("\nfunction ", start + 1);
  const nextAsyncFunction = source.indexOf("\nasync function ", start + 1);
  const candidates = [nextFunction, nextAsyncFunction].filter((value) => value >= 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("Telegram note preview RPC keeps the privileged write private and service-role only", () => {
  const privateFunction = sqlFunction(
    migrationSource,
    "security_private.service_apply_telegram_note_preview_v1",
  );
  const publicFunction = sqlFunction(
    migrationSource,
    "public.service_apply_telegram_note_preview_v1",
  );

  assert.match(privateFunction, /language\s+plpgsql[\s\S]*?security\s+definer/i);
  assert.match(
    privateFunction,
    /set\s+search_path\s*=\s*pg_catalog,\s*public,\s*security_private,\s*pg_temp/i,
  );
  assert.match(publicFunction, /language\s+sql[\s\S]*?security\s+invoker/i);
  assert.match(publicFunction, /set\s+search_path\s*=\s*pg_catalog/i);
  assert.match(
    publicFunction,
    /select\s+security_private\.service_apply_telegram_note_preview_v1\s*\(/i,
  );

  for (const schema of ["security_private", "public"]) {
    const signature = `${schema}\\.service_apply_telegram_note_preview_v1\\(uuid,text,text,text\\)`;
    assert.match(
      migrationSource,
      new RegExp(`revoke all on function ${signature}\\s+from public, anon, authenticated, service_role`, "i"),
    );
    assert.match(
      migrationSource,
      new RegExp(`grant execute on function ${signature}\\s+to service_role`, "i"),
    );
    assert.doesNotMatch(
      migrationSource,
      new RegExp(`grant execute on function ${signature}\\s+to (?:public|anon|authenticated)`, "i"),
    );
  }
});

test("preview update is fenced to the exact note, its stored intake, and its source URL", () => {
  const privateFunction = sqlFunction(
    migrationSource,
    "security_private.service_apply_telegram_note_preview_v1",
  );

  assert.match(privateFunction, /where\s+note\.id\s*=\s*p_note_id/i);
  assert.match(privateFunction, /note\.intake_id\s*=\s*intake\.id/i);
  assert.match(privateFunction, /note\.owner_id\s*=\s*intake\.owner_id/i);
  assert.match(privateFunction, /intake\.intent\s*=\s*'note'/i);
  assert.match(privateFunction, /intake\.status\s*=\s*'completed'/i);
  assert.match(privateFunction, /note\.source_url\s*=\s*normalized_url/i);
  assert.match(privateFunction, /note\.source_platform\s+in\s*\(\s*'web'\s*,\s*'facebook'\s*\)/i);
  assert.match(privateFunction, /note\.source_metadata\s*=\s*'\{\}'::jsonb/i);

  // A delayed network response must lose the race to any owner edit.
  assert.match(privateFunction, /note\.body_text\s*=\s*intake\.message_text/i);
  assert.match(
    privateFunction,
    /note\.title\s*=\s*left\s*\(\s*coalesce\s*\([\s\S]*?intake\.message_text/i,
  );

  const updateClause = /update\s+public\.telegram_saved_notes\s+as\s+note([\s\S]*?)from\s+public\.telegram_intakes/i
    .exec(privateFunction)?.[1] ?? "";
  assert.match(updateClause, /set\s+title\s*=\s*normalized_title/i);
  assert.match(updateClause, /body_text\s*=\s*normalized_body/i);
  assert.doesNotMatch(updateClause, /source_url\s*=/i, "Preview enrichment must preserve the saved source URL.");
});

test("only a direct non-forwarded URL is eligible for an external preview", () => {
  const webUrl = "https://example.org/archive/item-42";
  const facebookUrl = "https://www.facebook.com/share/p/example";

  assert.equal(directExternalUrlForPreview(webUrl, false), webUrl);
  assert.equal(directExternalUrlForPreview(facebookUrl, false), facebookUrl);
  assert.equal(
    directExternalUrlForPreview("https://t.me/public_channel/42", false),
    null,
    "A Telegram permalink is not an external web preview target.",
  );
  assert.equal(directExternalUrlForPreview(webUrl, true), null, "Telegram forwards retain Telegram provenance.");
  assert.equal(
    directExternalUrlForPreview(`Власний коментар ${webUrl}`, false),
    null,
    "A text note containing a URL must retain the user's title and body.",
  );
});

test("webhook enriches only after durable materialization and keeps enrichment best-effort", () => {
  assert.match(
    webhookSource,
    /import\s*\{[\s\S]*?directExternalUrlForPreview[\s\S]*?fetchPublicWebPreview[\s\S]*?\}\s*from\s*["']\.\.\/_shared\/publicWebPreview\.ts["']/i,
  );

  const enrichment = typescriptFunction(webhookSource, "enrichMaterializedExternalNote");
  assert.match(enrichment, /directExternalUrlForPreview\(message\.text,\s*message\.forwardSource\s*!==\s*null\)/i);
  assert.match(enrichment, /noteResult\.noteId/i);
  assert.match(enrichment, /await\s+fetchPublicWebPreview\(sourceUrl,/i);
  assert.match(enrichment, /client\.rpc\(["']service_apply_telegram_note_preview_v1["']/i);
  assert.match(enrichment, /p_note_id:\s*noteId/i);
  assert.match(enrichment, /p_source_url:\s*sourceUrl/i);
  assert.match(enrichment, /p_title:\s*preview\.title/i);
  assert.match(enrichment, /p_body_text:\s*preview\.bodyText/i);
  assert.doesNotMatch(enrichment, /\bfetch\s*\(/i, "The webhook must use the hardened shared fetcher.");
  assert.match(enrichment, /try\s*\{[\s\S]*?fetchPublicWebPreview[\s\S]*?\}\s*catch\s*\{/i);
  assert.match(
    enrichment,
    /const\s*\{\s*error\s*\}\s*=\s*await\s+client\.rpc[\s\S]*?if\s*\(error\)\s*return/i,
    "A Supabase RPC error is returned as data and must remain a best-effort no-op.",
  );

  const materialized = webhookSource.indexOf("if (noteResult.materialized === true)");
  const enrichmentCall = webhookSource.indexOf("await enrichMaterializedExternalNote", materialized);
  const successReply = webhookSource.indexOf("Нотатку збережено у вашому приватному списку", enrichmentCall);
  assert.ok(materialized >= 0 && enrichmentCall > materialized, "Preview must run only after materialization.");
  assert.ok(successReply > enrichmentCall, "The saved-note success response must remain after optional enrichment.");
});
