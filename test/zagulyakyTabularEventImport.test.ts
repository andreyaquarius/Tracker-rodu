import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608200006_zagulyaky_tabular_event_import.sql", import.meta.url),
  "utf8",
);

const privateTables = [
  "zagulyaky_tabular_import_batches",
  "zagulyaky_tabular_import_source_posts",
  "zagulyaky_tabular_import_events",
  "zagulyaky_tabular_import_participants",
  "zagulyaky_tabular_import_event_sources",
  "zagulyaky_tabular_import_cards",
  "zagulyaky_tabular_import_qc",
  "zagulyaky_tabular_import_chunks",
];

const adminFunctions = [
  "admin_begin_zagulyaky_tabular_event_import_v1",
  "admin_get_zagulyaky_tabular_event_import_v1",
  "admin_list_zagulyaky_tabular_event_imports_v1",
];

const serviceFunctions = [
  "service_ingest_zagulyaky_tabular_event_import_chunk_v1",
  "service_finalize_zagulyaky_tabular_event_import_v1",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function privateFunctionBody(functionName: string): string {
  const marker = `create or replace function security_private.${functionName}`;
  const start = migration.indexOf(marker);
  const end = migration.indexOf("$function$;", start);
  assert.ok(start >= 0, `private ${functionName} must exist`);
  assert.ok(end > start, `private ${functionName} must have a complete body`);
  return migration.slice(start, end);
}

function publicFunctionBody(functionName: string): string {
  const marker = `create or replace function public.${functionName}`;
  const start = migration.indexOf(marker);
  const end = migration.indexOf("$function$;", start);
  assert.ok(start >= 0, `public ${functionName} must exist`);
  assert.ok(end > start, `public ${functionName} must have a complete body`);
  return migration.slice(start, end);
}

function tableDefinition(tableName: string): string {
  const marker = `create table if not exists public.${tableName}`;
  const start = migration.indexOf(marker);
  const tail = migration.slice(start);
  const endMatch = /\r?\n\);\r?\n/.exec(tail);
  const end = endMatch === null ? -1 : start + endMatch.index;
  assert.ok(start >= 0, `${tableName} must exist`);
  assert.ok(end > start, `${tableName} must have a complete definition`);
  return migration.slice(start, end);
}

function assertPrivateTable(tableName: string): void {
  const escapedTable = escapeRegExp(tableName);

  assert.match(
    migration,
    new RegExp(`create table if not exists public\\.${escapedTable}\\b`, "i"),
    `${tableName} must be a first-class private import table`,
  );
  assert.match(
    migration,
    new RegExp(`alter table public\\.${escapedTable} enable row level security;`, "i"),
    `${tableName} must have RLS enabled`,
  );
  assert.match(
    migration,
    new RegExp(`revoke all on table public\\.${escapedTable} from public, anon, authenticated;`, "i"),
    `${tableName} must never be browser-readable directly`,
  );
  assert.match(
    migration,
    new RegExp(`grant all on table public\\.${escapedTable} to service_role;`, "i"),
    `${tableName} must be writable only by the server role`,
  );
  assert.doesNotMatch(
    migration,
    new RegExp(`grant (?:all|select|insert|update|delete)[^;]*on table public\\.${escapedTable}[^;]*to[^;]*\\bauthenticated\\b`, "i"),
    `${tableName} must not receive a direct authenticated-table grant`,
  );
}

function assertExactFunctionAcl(functionName: string, roles: string): void {
  const signature = `public\\.${escapeRegExp(functionName)}\\([^)]*\\)`;

  assert.match(
    migration,
    new RegExp(
      `revoke all on function ${signature}\\s+from public, anon, authenticated, service_role;`,
      "i",
    ),
    `${functionName} must remove inherited and direct API execution before its intended grant is restored`,
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function ${signature}\\s+to ${escapeRegExp(roles)};`, "i"),
    `${functionName} must restore only ${roles}`,
  );
}

test("tabular event import stores every workbook layer in private RLS tables", () => {
  for (const table of privateTables) assertPrivateTable(table);

  const sourcePosts = tableDefinition("zagulyaky_tabular_import_source_posts");
  const events = tableDefinition("zagulyaky_tabular_import_events");
  const participants = tableDefinition("zagulyaky_tabular_import_participants");
  const eventSources = tableDefinition("zagulyaky_tabular_import_event_sources");
  const cards = tableDefinition("zagulyaky_tabular_import_cards");
  const qc = tableDefinition("zagulyaky_tabular_import_qc");

  assert.match(sourcePosts, /post_key text not null/i);
  assert.match(sourcePosts, /post_original_text text not null/i);
  assert.match(sourcePosts, /(?:facebook_post|source_post)_url_private text/i);
  assert.match(events, /event_key text not null/i);
  assert.match(events, /post_key text not null/i);
  assert.match(events, /event_original_text text/i);
  assert.match(participants, /participant_key text not null/i);
  assert.match(participants, /person_card_key text not null/i);
  assert.match(participants, /event_key text not null/i);
  assert.match(participants, /participant_original_text text/i);
  assert.match(eventSources, /event_source_key text not null/i);
  assert.match(eventSources, /event_key text not null/i);
  assert.match(cards, /card_key text not null/i);
  assert.match(cards, /primary_participant_key text not null/i);
  assert.match(cards, /event_key text not null/i);
  assert.match(qc, /qc_code text not null/i);
  assert.match(qc, /(?:source|original)_excerpt text/i);

  for (const table of [sourcePosts, events, participants, eventSources, cards, qc]) {
    assert.match(
      table,
      /workbook_row_private jsonb not null/i,
      "each workbook layer must retain the complete source row privately",
    );
  }
  assert.match(events, /event_year_from integer/i);
  assert.match(events, /event_year_to integer/i);
  assert.match(events, /event_place_normalized text/i);
  assert.match(participants, /structural_role_code text/i);
  assert.match(participants, /event_role_custom text/i);
  assert.match(participants, /maiden_name_original text/i);
  assert.match(eventSources, /permission_status text not null default 'not_reviewed'/i);
  assert.match(cards, /copy_event_participants boolean not null default true/i);
  assert.match(qc, /review_status text/i);
});

test("tabular event import keeps caller-facing RPCs bounded by capability and server-only workers", () => {
  for (const functionName of adminFunctions) {
    const privateBody = privateFunctionBody(functionName);
    const publicBody = publicFunctionBody(functionName);

    assert.match(privateBody, /has_admin_permission_v1\('zagulyaky\.import'\)/);
    assert.match(publicBody, /security invoker/i);
    assert.match(publicBody, /set search_path = pg_catalog/i);
    assert.match(publicBody, new RegExp(`security_private\\.${escapeRegExp(functionName)}`));
    assertExactFunctionAcl(functionName, "authenticated, service_role");
  }

  for (const functionName of serviceFunctions) {
    const privateBody = privateFunctionBody(functionName);
    const publicBody = publicFunctionBody(functionName);

    assert.match(
      privateBody,
      /if not security_private\.zagulyaky_import_server_request_v1\(\) then\s+raise exception 'SERVER_IMPORT_REQUIRED'/s,
      `${functionName} must reject browser-originated service calls`,
    );
    assert.match(publicBody, /security invoker/i);
    assert.match(publicBody, /set search_path = pg_catalog/i);
    assert.match(publicBody, new RegExp(`security_private\\.${escapeRegExp(functionName)}`));
    assertExactFunctionAcl(functionName, "service_role");
  }
});

test("workbook rows are idempotent and a commit cannot silently replace a checked import", () => {
  const batches = tableDefinition("zagulyaky_tabular_import_batches");
  const chunks = tableDefinition("zagulyaky_tabular_import_chunks");
  const cards = tableDefinition("zagulyaky_tabular_import_cards");
  const begin = privateFunctionBody("admin_begin_zagulyaky_tabular_event_import_v1");
  const ingest = privateFunctionBody("service_ingest_zagulyaky_tabular_event_import_chunk_v1");
  const finalize = privateFunctionBody("service_finalize_zagulyaky_tabular_event_import_v1");

  assert.match(batches, /source_(?:checksum|sha256) text not null/i);
  assert.match(batches, /unique\s*\(\s*source_(?:checksum|sha256)\s*\)/i);
  assert.match(chunks, /import_mode text not null check \(import_mode in \('dry_run', 'commit'\)\)/i);
  assert.match(chunks, /payload_checksum text not null/i);
  assert.match(chunks, /unique\s*\(\s*batch_id\s*,\s*import_mode\s*,\s*chunk_index\s*\)/i);
  assert.match(cards, /unique\s*\(\s*card_key\s*\)/i);

  assert.match(begin, /on conflict\s*\(\s*source_(?:checksum|sha256)\s*\)/i);
  assert.match(ingest, /payload_checksum/i);
  assert.match(ingest, /is distinct from/i);
  assert.match(ingest, /CHUNK_(?:CHECKSUM|REPLAY)_MISMATCH/i);
  assert.match(
    ingest,
    /zagulyaky_tabular_import_raw_text_v1\(row_value, 'event_date_original', 4000, false\)/i,
    "a full archival date description must not be limited to a short display-date length",
  );
  assert.match(
    finalize,
    /zagulyaky_tabular_import_public_text_v1\(event_row\.event_date_original, 4000\)/i,
    "materializing a reviewed draft must retain the accepted date-description bound",
  );
  assert.match(finalize, /DRY_RUN_(?:REQUIRED|NOT_COMPLETE)/i);
});

test("materialization creates reviewable drafts only, preserves primary-person meaning, and never promotes private Facebook provenance", () => {
  const finalize = privateFunctionBody("service_finalize_zagulyaky_tabular_event_import_v1");

  assert.match(finalize, /insert into public\.zagulyaky_records/i);
  assert.match(finalize, /'draft'/i);
  assert.match(finalize, /'unverified'/i);
  assert.match(finalize, /zagulyaky_tabular_import_catalogue_event_type_v1\(event_row\.event_type_code\)/i);
  assert.match(finalize, /event_row\.event_year_from/i);
  assert.match(finalize, /event_row\.event_year_to/i);
  assert.match(finalize, /card_row\.copy_event_participants/i);
  assert.match(finalize, /primary_participant_key/i);
  assert.match(
    finalize,
    /materialized_possible_living := card_row\.possible_living_person\s+or exists \([\s\S]*?participant_candidate\.possible_living_person[\s\S]*?card_row\.copy_event_participants[\s\S]*?participant_candidate\.participant_key = card_row\.primary_participant_key/i,
    "privacy must include every potentially living participant actually copied onto a card",
  );
  assert.match(
    finalize,
    /case when materialized_possible_living then 'requires_consent' else 'pending' end/i,
    "a copied potentially living participant must move the draft into requires_consent",
  );
  assert.match(
    finalize,
    /insert into public\.zagulyaky_participants[\s\S]*?insert into public\.zagulyaky_document_discoveries[\s\S]*?update public\.zagulyaky_records\s+set updated_at = updated_at/i,
    "the established record-version trigger must be touched after all materialized children exist",
  );
  assert.match(
    finalize,
    /existing AFTER UPDATE trigger writes revision 2 with the complete[\s\S]*?snapshot/i,
    "the final audit touch must document why the lock version is incremented",
  );
  assert.match(
    finalize,
    /case\s+when[\s\S]*?participant_key[\s\S]*?=[\s\S]*?primary_participant_key[\s\S]*?then\s+'subject'[\s\S]*?else[\s\S]*?role_code[\s\S]*?end/i,
    "the card's primary participant must become the subject while all other event roles are retained",
  );
  assert.doesNotMatch(
    migration,
    /insert\s+into\s+public\.zagulyaky_sources/i,
    "private Facebook/document candidates must not become public catalogue sources automatically",
  );
  assert.doesNotMatch(migration, /insert\s+into\s+public\.zagulyaky_attachments/i);
  assert.doesNotMatch(migration, /admin_merge_zagulyaka_duplicate|merge_zagulyaka_duplicate/i);
  assert.doesNotMatch(
    finalize,
    /'published'|published_at|public_slug/i,
    "the importer must never publish a card or assign a public slug",
  );
  assert.match(migration, /notify pgrst, 'reload schema';/i);
});

test("the moderator review bundle exposes bounded tabular provenance without widening public APIs", () => {
  const reviewBundle = privateFunctionBody("admin_get_zagulyaka_review_bundle_v1");
  const reviewFacade = publicFunctionBody("admin_get_zagulyaka_review_bundle_v1");
  const search = privateFunctionBody("search_zagulyaky_v1");

  assert.match(reviewBundle, /has_admin_permission_v1\('zagulyaky\.moderate'\)/i);
  assert.match(reviewBundle, /'privateImportOrigins'/i);
  assert.match(reviewBundle, /zagulyaky_tabular_import_card_records/i);
  assert.match(reviewBundle, /zagulyaky_tabular_import_cards/i);
  assert.match(reviewBundle, /zagulyaky_tabular_import_events/i);
  assert.match(reviewBundle, /zagulyaky_tabular_import_source_posts/i);
  assert.match(reviewBundle, /'facebookPostUrl'/i);
  assert.match(reviewBundle, /'sourceCollectionUrl'/i);
  assert.match(reviewBundle, /'postOriginalText'/i);
  assert.match(reviewBundle, /'eventOriginalText'/i);
  assert.match(reviewBundle, /left\(import_post\.post_original_text, 12000\)/i);
  assert.match(reviewBundle, /left\(import_event\.event_original_text, 12000\)/i);
  assert.doesNotMatch(
    reviewBundle,
    /workbook_row_private|to_jsonb\(import_(?:map|card|event|post)\)/i,
    "the reviewer projection must not leak the unbounded workbook envelope",
  );
  assert.match(reviewFacade, /security invoker/i);
  assert.match(reviewFacade, /security_private\.admin_get_zagulyaka_review_bundle_v1/i);
  assertExactFunctionAcl("admin_get_zagulyaka_review_bundle_v1", "authenticated, service_role");
  assert.doesNotMatch(
    search,
    /privateImportOrigins|zagulyaky_tabular_import_card_records|facebook_post_url_private/i,
    "public search must not acquire private provenance",
  );
});

test("published catalogue search includes only the new safe participant fields", () => {
  const search = privateFunctionBody("search_zagulyaky_v1");

  for (const field of [
    "social_estate_text",
    "occupation_or_rank_text",
    "marital_status_text",
    "relation_original",
    "evidence_excerpt",
  ]) {
    assert.match(search, new RegExp(`participant\\.${field}`, "i"));
  }
  assert.match(search, /r\.status = 'published'/i);
  assert.match(search, /r\.privacy_status = 'cleared'/i);
  assert.match(search, /zagulyaky_has_living_person_clearance_v1/i);
  assert.doesNotMatch(search, /zagulyaky_tabular_import_/i);
  assert.doesNotMatch(search, /facebook_post_url_private|post_original_text|document_url_private/i);
});
