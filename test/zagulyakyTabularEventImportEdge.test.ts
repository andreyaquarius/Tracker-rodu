import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const edgePath = new URL(
  "../supabase/functions/zagulyaky-tabular-event-import/index.ts",
  import.meta.url,
);
const edge = readFileSync(edgePath, "utf8");
const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");

test("tabular event Edge endpoint is a bounded JSON relay, never an XLSX parser", () => {
  assert.ok(existsSync(edgePath));
  assert.match(edge, /const MAX_JSON_REQUEST_BYTES = 8 \* 1024 \* 1024/u);
  assert.match(edge, /const MAX_CHUNK_JSON_BYTES = 7 \* 1024 \* 1024/u);
  assert.match(edge, /const MAX_CHUNK_TOTAL_ROWS = 250/u);
  assert.match(edge, /function validateJsonContentType/u);
  assert.match(edge, /value !== "application\/json"/u);
  assert.match(edge, /async function readRelayBody/u);
  assert.match(edge, /const reader = request\.body\.getReader\(\);/u);
  assert.match(edge, /if \(length > MAX_JSON_REQUEST_BYTES\)/u);
  assert.match(edge, /function parseAction/u);
  assert.match(edge, /type RelayAction = "begin" \| "chunk" \| "finalize"/u);
  assert.doesNotMatch(edge, /npm:xlsx/u);
  assert.doesNotMatch(edge, /preflightXlsxZip/u);
  assert.doesNotMatch(edge, /XLSX_CONTENT_TYPES/u);
  assert.doesNotMatch(edge, /request\.arrayBuffer\(\)/u);
  assert.doesNotMatch(edge, /x-zagulyaky-source-file-name/u);
});

test("relay has a closed, bounded action contract that matches the three SQL facades", () => {
  assert.match(edge, /sourcePosts[\s\S]*events[\s\S]*participants[\s\S]*eventSources[\s\S]*cards[\s\S]*qc/u);
  assert.match(edge, /eventsWithoutCards: 200_000/u);
  assert.match(edge, /function expectedCounts/u);
  assert.match(edge, /function requiredChunk/u);
  assert.match(edge, /requireClosedKeys\(value, CHUNK_BUCKETS/u);
  assert.match(edge, /if \(rowCount < 1 \|\| rowCount > MAX_CHUNK_TOTAL_ROWS\)/u);
  assert.match(edge, /if \(value\.importMode !== "dry_run"\) throw new RequestProblem\("INVALID_CHUNK_IMPORT_MODE", 422\)/u);
  assert.match(edge, /materializeLimit: value\.materializeLimit === undefined/u);
  assert.match(edge, /requiredInteger\(value\.materializeLimit, 1, MAX_MATERIALIZE_LIMIT/u);
});

test("every protected action authenticates the caller and rechecks zagulyaky.import before service-role work", () => {
  assert.match(edge, /callerClient\.auth\.getUser\(accessToken\)/u);
  assert.match(edge, /admin_begin_zagulyaky_tabular_event_import_v1/u);
  assert.match(edge, /admin_get_zagulyaky_tabular_event_import_v1/u);
  assert.match(edge, /This caller-scoped facade enforces both auth\.uid\(\) and the exact[\s\S]*zagulyaky\.import/u);
  assert.match(edge, /const serverClient = createServerClient\(supabaseUrl, serverKey, request\.signal\);/u);
  assert.match(edge, /resolveSupabaseSecretKey/u);
  assert.match(edge, /supabaseServerKeyHeaders\(serverKey\)/u);
  assert.match(edge, /service_ingest_zagulyaky_tabular_event_import_chunk_v1/u);
  assert.match(edge, /service_finalize_zagulyaky_tabular_event_import_v1/u);
});

test("relay derives the receipt checksum from canonical chunk JSON before invoking the idempotent service facade", () => {
  assert.match(edge, /function canonicalJson/u);
  assert.match(edge, /Object\.keys\(value\)\s*\.sort\(\)/u);
  assert.match(edge, /const canonicalChunk = canonicalJson\(input\.chunk\);/u);
  assert.match(edge, /const calculatedChecksum = await sha256Text\(canonicalChunk\);/u);
  assert.match(edge, /p_chunk_checksum: calculatedChecksum/u);
  assert.doesNotMatch(edge, /chunkChecksum: requiredChecksum/u);
});

test("finalize is one bounded server call, so commit resume remains observable and deterministic", () => {
  assert.match(edge, /Exactly one bounded materialization call per browser request/u);
  assert.match(edge, /p_materialize_limit: input\.materializeLimit/u);
  assert.match(edge, /remainingCardCount/u);
  assert.doesNotMatch(edge, /maximumFinalizeCalls/u);
  assert.doesNotMatch(edge, /for \(let attempt = 0; attempt < maximumFinalizeCalls/u);
});

test("relay retains CORS-only public preflight and emits safe diagnostics without source data", () => {
  assert.match(
    config,
    /\[functions\.zagulyaky-tabular-event-import\]\s*\r?\n[\s\S]*?verify_jwt = false/u,
  );
  assert.match(edge, /if \(request\.method === "OPTIONS"\) return new Response\("ok", \{ headers: corsHeaders\(request\) \}\);/u);
  assert.match(edge, /IMPORT_PERMISSION_REQUIRED/u);
  assert.match(edge, /return json\(request, \{ error: problem\.code \}, problem\.status\)/u);
  assert.match(edge, /Never log JSON action data, raw post text, Facebook\/private URLs/u);
  assert.match(edge, /console\.error\(\{ code: problem\.code, phase, errorName: safeErrorName\(error\) \}\)/u);
  assert.doesNotMatch(edge, /console\.error\([^\n]*(?:error\.(?:message|stack|cause|data)|userError)/u);
});

test("relay cannot write public catalogue tables or expose private provenance in responses", () => {
  assert.doesNotMatch(edge, /from\(["']zagulyaky_records/u);
  assert.doesNotMatch(edge, /from\(["']zagulyaky_sources/u);
  assert.doesNotMatch(edge, /zagulyaky_attachments/u);
  assert.doesNotMatch(edge, /facebook_post_url_private/u);
  assert.doesNotMatch(edge, /post_original_text/u);
  assert.match(edge, /function safeBatchSummary/u);
  assert.match(edge, /const allowed = new Set\(\[/u);
});
