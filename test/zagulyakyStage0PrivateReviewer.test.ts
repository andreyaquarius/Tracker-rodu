import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190008_zagulyaky_stage0_private_reviewer.sql", import.meta.url),
  "utf8",
);

function functionBody(functionName: string): string {
  const start = migration.indexOf(`create or replace function security_private.${functionName}`);
  assert.ok(start >= 0, `private ${functionName} must exist`);
  const end = migration.indexOf("$function$;", start);
  assert.ok(end > start, `private ${functionName} must have a complete body`);
  return migration.slice(start, end);
}

function assertRevokedThenGranted(signature: string): void {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    migration,
    new RegExp(`revoke all on function ${escaped}\\s+from public, anon, authenticated, service_role;`, "i"),
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function ${escaped}\\s+to authenticated, service_role;`, "i"),
  );
  assert.doesNotMatch(
    migration,
    new RegExp(`grant execute on function ${escaped}\\s+to anon`, "i"),
  );
}

test("private Stage 0 reviewer adds only exact-import-gated browser facades", () => {
  for (const name of [
    "admin_list_zagulyaky_ingestion_batches_v1",
    "admin_list_zagulyaky_ingestion_items_v1",
    "admin_get_zagulyaky_ingestion_item_v1",
  ]) {
    assert.match(
      migration,
      new RegExp(`create or replace function security_private\\.${name}[\\s\\S]*?security definer`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.${name}[\\s\\S]*?security invoker`, "i"),
    );
  }

  const privateBodies = [
    functionBody("admin_list_zagulyaky_ingestion_batches_v1"),
    functionBody("admin_list_zagulyaky_ingestion_items_v1"),
    functionBody("admin_get_zagulyaky_ingestion_item_v1"),
  ];
  for (const body of privateBodies) {
    assert.match(body, /has_admin_permission_v1\('zagulyaky\.import'\)/);
    assert.match(body, /ADMIN_PERMISSION_REQUIRED/);
  }

  assertRevokedThenGranted("public.admin_list_zagulyaky_ingestion_batches_v1(text,integer,integer)");
  assertRevokedThenGranted("public.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)");
  assertRevokedThenGranted("public.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)");
});

test("Stage 0 reviewer uses bounded, stable private browse projections without a public write path", () => {
  const listBody = functionBody("admin_list_zagulyaky_ingestion_items_v1");
  const detailBody = functionBody("admin_get_zagulyaky_ingestion_item_v1");

  assert.match(listBody, /least\(greatest\(coalesce\(p_limit, 25\), 1\), 100\)/);
  assert.match(listBody, /char_length\(safe_query\) > 160/);
  assert.match(listBody, /order by source_item_index asc, item_id asc/);
  assert.match(listBody, /'has_attachments', 'requires_ocr', 'requires_source_refetch'/);
  assert.match(listBody, /'textPreview'/);
  assert.ok(
    listBody.includes("'((https?|ftp)://|www[.]|mailto:)[^[:space:]]+'"),
    "list previews must redact URL-looking source text",
  );
  assert.match(listBody, /\[посилання приховано\]/);
  assert.doesNotMatch(listBody, /'sourceUrl'|'rawText'|'rawPayload'/);

  assert.match(detailBody, /left\(item_row\.raw_text, 16000\)/);
  assert.match(detailBody, /'rawTextTruncatedForReview'/);
  assert.match(detailBody, /'attachments'/);
  assert.match(detailBody, /'links'/);
  assert.match(detailBody, /'recordLinks'/);
  assert.doesNotMatch(detailBody, /raw_payload/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.zagulyaky_records/i);
  assert.doesNotMatch(migration, /insert\s+into\s+storage\.objects/i);
});

test("selected private item detail is audit-recorded and has executable contract coverage", () => {
  const detailBody = functionBody("admin_get_zagulyaky_ingestion_item_v1");
  const auditStart = detailBody.indexOf("insert into public.admin_audit_log");
  const responseStart = detailBody.indexOf("  select jsonb_build_object(", auditStart);
  assert.ok(auditStart >= 0 && responseStart > auditStart, "detail must audit before constructing its response");
  const auditBlock = detailBody.slice(auditStart, responseStart);
  assert.match(detailBody, /insert into public\.admin_audit_log/);
  assert.match(detailBody, /'zagulyaky\.ingestion_item\.view'/);
  assert.match(detailBody, /'rawTextCharactersReturned'/);
  assert.doesNotMatch(auditBlock, /item_row\.raw_text/i);
  assert.match(migration, /notify pgrst, 'reload schema';/i);
  assert.ok(existsSync(new URL("../supabase/tests/zagulyaky_stage0_private_reviewer_test.sql", import.meta.url)));
});
