import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const migration = (name: string) => readFileSync(
  new URL("../../supabase/migrations/" + name + ".sql", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");
const oldSearch = migration("202608270004_zagulyaky_search_and_my_records_performance");
const privacy = migration("202608190003_zagulyaky_privacy_integrity_and_public_redaction");
const fix = migration("202609070001_zagulyaky_search_timeout_fix");
const id = (n: number) => "70090000-0000-4000-8000-" + String(n).padStart(12, "0");
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const fn = (source: string, name: string, delimiter = "$function$;") => {
  const start = source.search(new RegExp("create(?: or replace)? function " + name.replaceAll(".", "\\.") + "\\("));
  assert.ok(start >= 0, name);
  const end = source.indexOf(delimiter, start);
  assert.ok(end >= start, name + " ending");
  return source.slice(start, end + delimiter.length);
};
const privateWrapper = (kind: string) => fn(privacy, "public.search_zagulyaky_" + kind + "_v1")
  .replace("function public.", "function security_private.");

type SearchPage = { items: Array<{ id: string; [key: string]: unknown }>; nextCursor: null | { publishedAt: string; id: string } };
type SearchCase = { kind?: "people" | "documents"; query?: string | null; filters?: Record<string, unknown>; limit?: number; cursor?: SearchPage["nextCursor"] };

test("Zagulyaky search: actual SQL, privacy, paging and large-catalogue query plans", async (t) => {
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
  const search = async ({ kind = "people", query = null, filters = {}, limit = 20, cursor = null }: SearchCase = {}) => {
    const result = await db.query<{ result: SearchPage }>(
      "select public.search_zagulyaky_" + kind + "_v1($1,$2,$3,$4,$5) as result",
      [query, JSON.stringify(filters), limit, cursor?.publishedAt ?? null, cursor?.id ?? null],
    );
    return result.rows[0].result;
  };
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role; " +
      "create schema auth; create schema security_private; create schema extensions; " +
      "create extension pg_trgm schema extensions; create extension pgcrypto schema extensions; " +
      "create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$; " +
      "create table profiles(user_id uuid primary key);",
    );
    // Real catalogue DDL and indexes; no production data or connection.
    const foundation = migration("202608180002_zagulyaky_foundation");
    await db.exec(foundation.slice(foundation.indexOf("create table if not exists public.zagulyaky_records"),
      foundation.indexOf("create table if not exists public.zagulyaky_claims")));
    await db.exec(
      "alter table zagulyaky_records add origin_geo jsonb, add found_geo jsonb; " +
      "alter table zagulyaky_participants add event_role_code text, add event_role_custom text, " +
      "add social_estate_text text, add occupation_or_rank_text text, add marital_status_text text, " +
      "add relation_original text, add evidence_excerpt text;",
    );
    const consent = migration("202608190001_zagulyaky_privacy_and_attachment_delivery");
    await db.exec(consent.slice(consent.indexOf("create table if not exists"), consent.indexOf("create or replace function")));
    await db.exec("alter table zagulyaky_privacy_clearances add reviewed_content_fingerprint text");
    const coordinates = migration("202608230003_zagulyaky_map_coordinates");
    await db.exec(fn(coordinates, "security_private.normalize_zagulyaky_geo_point_v1"));
    await db.exec(fn(coordinates, "security_private.zagulyaky_living_person_content_fingerprint_v1"));
    await db.exec(fn(privacy, "security_private.zagulyaky_has_living_person_clearance_v1"));
    const places = migration("202608250008_zagulyaky_public_place_connections");
    await db.exec(fn(places, "security_private.zagulyaky_public_place_key_v1"));
    await db.exec(places.slice(places.indexOf("create index if not exists"), places.indexOf("create or replace function security_private.list_public")));
    await db.exec(oldSearch);
    await db.exec(privateWrapper("people") + privateWrapper("documents"));
    const isolation = migration("202608250005_zagulyaky_security_definer_api_isolation");
    for (const kind of ["people", "documents"]) {
      await db.exec(fn(isolation, "public.search_zagulyaky_" + kind + "_v1", "$wrapper$;"));
    }
    await db.exec("grant usage on schema security_private to anon, authenticated, service_role");

    await db.exec(
      "insert into zagulyaky_records(id,kind,status,privacy_status,public_slug,title,summary,published_at,event_type," +
      "event_year_from,event_year_to,source_location_text,found_location_text,verification_status) " +
      "select ('70090000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, " +
      "case when n > 160 then 'document' else 'person' end, 'published','cleared','demo-' || n," +
      "'Спільний запис ' || n, 'Пошукова транскрипція', '2026-09-01'::timestamptz - (n / 3) * interval '1 second'," +
      "case when n % 2 = 0 then 'marriage' else 'baptism' end, 1850 + n % 100, 1855 + n % 100," +
      "'Вербівка', 'Київ', case when n % 3 = 0 then 'verified' else 'unverified' end " +
      "from generate_series(1,220) n; " +
      "insert into zagulyaky_participants(record_id,normalized_uk_full_name,event_role_code) " +
      "select id,'Тестова особа ' || title,case when event_type='marriage' then 'witness' else 'godparent' end from zagulyaky_records; " +
      "insert into zagulyaky_sources(id,title,archive_name,citation) values " +
      "(" + quote(id(901)) + ",'Рідкісне джерело','Архів 50%_А','Архівний опис')," +
      "(" + quote(id(902)) + ",'Спільний запис','Інший архів','Спільний запис'); " +
      "insert into zagulyaky_record_sources(record_id,source_id,is_primary) " +
      "select id," + quote(id(901)) + "::uuid,true from zagulyaky_records where event_type='marriage'; " +
      "insert into zagulyaky_record_sources(record_id,source_id) select id," + quote(id(902)) + "::uuid from zagulyaky_records; " +
      "insert into zagulyaky_document_discoveries(record_id,notes,record_types,official_location_text) " +
      "select id,'Рідкіснийдокумент',array['Перепис'],'Львів' from zagulyaky_records where kind='document'; " +
      "update zagulyaky_records set title='Унікальнийзаголовок', original_text='Тількиповнийтекст' where id=" + quote(id(1)) + "; " +
      "update zagulyaky_records set classification_reason='Унікальніметадані' where id=" + quote(id(2)) + "; " +
      "update zagulyaky_participants set evidence_excerpt='Рідкіснийучасник' where record_id=" + quote(id(3)) + "; " +
      "update zagulyaky_records set title='Ян', source_location_text='50%_А' where id=" + quote(id(4)) + "; " +
      "update zagulyaky_records set title=" + quote("Джерело \\ А") + " where id=" + quote(id(5)) + "; " +
      "update zagulyaky_records set title='Приватнапозначка', privacy_status='blocked' where id=" + quote(id(6)) + "; " +
      "update zagulyaky_records set title='Приватнапозначка', status='draft' where id=" + quote(id(7)) + "; " +
      "update zagulyaky_records set title='Приватнапозначка', possible_living_person=true where id=" + quote(id(8)) + "; " +
      "update zagulyaky_records set title='Погодженаживаособа', possible_living_person=true where id=" + quote(id(9)) + "; " +
      "insert into zagulyaky_privacy_clearances(record_id,review_status,consent_obtained_at,evidence_reference,reviewed_content_fingerprint) " +
      "values(" + quote(id(9)) + ",'approved',now(),'private test evidence',security_private.zagulyaky_living_person_content_fingerprint_v1(" + quote(id(9)) + ")); " +
      "update zagulyaky_records set origin_geo='{\"displayName\":\"Вербівка\",\"latitude\":49.5,\"longitude\":28.6}'," +
      "found_geo='{\"displayName\":\"Київ\",\"latitude\":50.45,\"longitude\":30.52}' where id=" + quote(id(10)) + ";",
    );
    const geoKeys = (await db.query<{ origin: string; found: string }>(
      "select security_private.zagulyaky_public_place_key_v1(origin_geo) origin, " +
      "security_private.zagulyaky_public_place_key_v1(found_geo) found from zagulyaky_records where id=$1", [id(10)],
    )).rows[0];
    const cases: SearchCase[] = [
      {}, { kind: "documents" }, { query: "Спільний", limit: 1 }, { query: "Спільний", limit: 50 },
      { query: "унікальнийзаг" }, { query: "Тількиповнийтекст" }, { query: "Унікальніметадані" },
      { query: "Рідкіснийучасник" }, { query: "Рідкісне джерело" }, { query: "Ян" },
      { query: "Рідкіснийдокумент", kind: "documents" }, { query: "Немаєтакогозапису" },
      { query: '"Пошукова транскрипція"' }, { query: "Спільний -унікальнийзаголовок" },
      { query: "%" }, { query: "_" }, { query: "\\" }, { query: "Приватнапозначка" },
      { query: "Спільний", filters: { eventRole: "WITNESS", eventType: "marriage", yearFrom: 1880, yearTo: 1895 } },
      { filters: { archiveName: "50%_А" } }, { query: "Спільний", filters: { archiveName: "50%_А" } },
      { filters: { archiveName: "Немаєтакогоархіву" } }, { filters: { sourceLocation: "50%_А" } },
      { query: "Спільний", filters: { foundLocation: "Київ", verificationStatus: "verified" } },
      { filters: { originPlaceKey: geoKeys.origin, sourceLocation: "unused wording" } },
      { query: "Спільний", filters: { foundPlaceKey: geoKeys.found } },
      { query: "Спільний", filters: { eventRole: "", eventType: null, archiveName: null } },
    ];
    const baseline: SearchPage[] = [];
    for (const item of [...cases]) {
      const page = await search(item);
      baseline.push(page);
      if (page.nextCursor) cases.push({ ...item, cursor: page.nextCursor });
    }
    for (const item of cases.slice(baseline.length)) baseline.push(await search(item));

    const callCount = async (kind: string, definition: string) => {
      await db.exec("begin");
      try {
        await db.exec(definition.replace("\nbegin\n", "\nbegin\n  raise notice 'CATALOG_SEARCH_EXECUTED';\n"));
        const notices: string[] = [];
        await db.query("select public.search_zagulyaky_" + kind + "_v1(null,'{}',1)", [], {
          onNotice: (notice) => notices.push(notice.message),
        });
        return notices.filter((notice) => notice === "CATALOG_SEARCH_EXECUTED").length;
      } finally { await db.exec("rollback"); }
    };
    await t.test("reproduces double execution before the migration", async () => {
      assert.equal(await callCount("people", fn(oldSearch, "security_private.search_zagulyaky_v1")), 2);
      assert.equal(await callCount("documents", fn(oldSearch, "security_private.search_zagulyaky_v1")), 2);
    });
    await db.exec(fix);
    await db.exec(fix); // safe to retry a migration whose commit result was uncertain

    await t.test("one internal search per people/document RPC after the migration", async () => {
      assert.equal(await callCount("people", fn(fix, "security_private.search_zagulyaky_v1")), 1);
      assert.equal(await callCount("documents", fn(fix, "security_private.search_zagulyaky_v1")), 1);
    });
    await t.test("search fields, literal wildcards, filters and cursor pages keep exactly the same results", async () => {
      for (const [index, item] of cases.entries()) assert.deepEqual(await search(item), baseline[index], JSON.stringify(item));
    });
    await t.test("all pages are deterministic, duplicate-free and complete", async () => {
      for (const kind of ["people", "documents"] as const) {
        const seen: string[] = [];
        let cursor: SearchPage["nextCursor"] = null;
        do {
          const page = await search({ kind, query: "Спільний", limit: 7, cursor });
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
          assert.ok(seen.length <= 220, "cursor must progress");
        } while (cursor);
        assert.equal(new Set(seen).size, seen.length);
        // Every public record except unsafe living people matches the shared source.
        const expected = (await db.query<{ id: string }>(
          "select id from zagulyaky_records where kind=$1 and status='published' and privacy_status='cleared' " +
          "and (not possible_living_person or security_private.zagulyaky_has_living_person_clearance_v1(id)) " +
          "order by published_at desc,id desc", [kind === "people" ? "person" : "document"],
        )).rows.map((row) => row.id);
        assert.deepEqual(seen, expected);
      }
    });
    await t.test("current consent remains mandatory; a content edit immediately hides the living person", async () => {
      assert.equal((await search({ query: "Приватнапозначка" })).items.length, 0);
      assert.deepEqual((await search({ query: "Погодженаживаособа" })).items.map((item) => item.id), [id(9)]);
      await db.query("update zagulyaky_records set summary='Edited after consent' where id=$1", [id(9)]);
      assert.equal((await search({ query: "Погодженаживаособа" })).items.length, 0);
    });
    await t.test("anonymous callers can only use the existing bounded facades, not tables or the inner engine", async () => {
      await db.exec("set role anon");
      try {
        assert.ok((await search({ limit: 1 })).items.length === 1);
        await assert.rejects(db.query("select * from zagulyaky_records"), (e: { code: string }) => e.code === "42501");
        await assert.rejects(db.query("select security_private.search_zagulyaky_v1('person')"), (e: { code: string }) => e.code === "42501");
      } finally { await db.exec("reset role"); }
    });
    await t.test("input validation is unchanged", async () => {
      await assert.rejects(search({ query: "x".repeat(201) }), /SEARCH_QUERY_TOO_LONG/);
      await assert.rejects(search({ filters: { yearFrom: "bad" } }), /INVALID_YEAR_FILTER/);
      await assert.rejects(search({ filters: { originPlaceKey: "bad" } }), /INVALID_ZAGULYAKY_PLACE_KEY_FILTER/);
      await assert.rejects(search({ filters: { verificationStatus: "bad" } }), /INVALID_ZAGULYAKY_VERIFICATION_FILTER/);
      await assert.rejects(db.query("select public.search_zagulyaky_people_v1(null,'{}',20,now(),null)"), /INCOMPLETE_SEARCH_CURSOR/);
    });

    await t.test("50,000 additional records: indexes replace all-catalogue eligibility scans", async () => {
      await db.exec(
        "insert into zagulyaky_records(id,kind,status,privacy_status,public_slug,title,original_text,published_at,event_type) " +
        "select ('70090000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'person','published','cleared','scale-' || n," +
        "'Scale ' || md5(n::text),repeat('Synthetic archive transcription ',20) || md5((n*13)::text)," +
        "'2025-01-01'::timestamptz - n * interval '1 second','baptism' from generate_series(10000,59999) n; " +
        "insert into zagulyaky_participants(record_id,normalized_uk_full_name,event_role_code) " +
        "select id,'Synthetic ' || md5(id::text),'godparent' from zagulyaky_records where public_slug like 'scale-%'; " +
        "analyze zagulyaky_records; analyze zagulyaky_participants; analyze zagulyaky_sources; " +
        "analyze zagulyaky_record_sources; analyze zagulyaky_document_discoveries;",
      );
      // EXPLAIN the exact explicit-search SELECT from the production function.
      // Constants stand in for PL/pgSQL custom-plan parameters; no planner switches.
      const plan = async (source: string, query: string | null, cursor: SearchPage["nextCursor"] = null) => {
        let sql = fn(source, "security_private.search_zagulyaky_v1");
        const start = sql.indexOf(query === null ? "with candidate_rows" : "with eligible_rows");
        sql = sql.slice(start, sql.indexOf("from candidate_rows candidate;", start) + "from candidate_rows candidate".length);
        sql = sql.replace("into candidate_ids", "");
        const values: Record<string, string> = {
          p_kind: "'person'", p_filters: "'{}'::jsonb", normalized_query: quote(query ?? ""),
          search_pattern: quote("%" + (query ?? "").toLowerCase() + "%"), safe_limit: "20",
          p_cursor_published_at: cursor ? quote(cursor.publishedAt) + "::timestamptz" : "null::timestamptz",
          p_cursor_id: cursor ? quote(cursor.id) + "::uuid" : "null::uuid",
          event_type_filter: "null::text", event_role_filter: "null::text", verification_status_filter: "null::text",
          source_location_pattern: "null::text", found_location_pattern: "null::text",
          archive_name_filter: "null::text", archive_name_pattern: "null::text",
        };
        for (const [name, value] of Object.entries(values)) sql = sql.replace(new RegExp("\\b" + name + "\\b", "g"), value);
        return (await db.query("explain (analyze, buffers, format json) " + sql)).rows[0]["QUERY PLAN"] as Array<Record<string, any>>;
      };
      const nodes = (node: Record<string, any>): Array<Record<string, any>> => [node, ...(node.Plans ?? []).flatMap(nodes)];
      for (const query of ["унікальнийзаг", "Рідкіснийучасник", "Немаєтакогозапису"]) {
        const before = (await plan(oldSearch, query))[0];
        const after = (await plan(fix, query))[0];
        const afterNodes = nodes(after.Plan);
        assert.ok(!afterNodes.some((node) => node["CTE Name"] === "eligible_rows"), "no full-catalogue CTE scan");
        const scanned = afterNodes.filter((node) => node["Relation Name"] === "zagulyaky_records").reduce(
          (sum, node) => sum + ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 0), 0,
        );
        assert.ok(scanned < 1000, "selective search must not scan all 50,000 records: " + scanned);
        assert.ok(afterNodes.some((node) => /_search_idx|_trgm_idx/.test(node["Index Name"] ?? "")), "search indexes participate");
        t.diagnostic(JSON.stringify({ query, oldMs: before["Execution Time"], optimizedMs: after["Execution Time"], recordsVisited: scanned }));
        const started = performance.now();
        const page = await search({ query });
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 5000, "RPC stays within the unchanged 5s budget");
        t.diagnostic(JSON.stringify({ query, rpcMs: Math.round(elapsed), items: page.items.length }));
      }
      for (const item of [{}, { query: "а" }, { query: "Ян" }, { query: "Synthetic" }, { filters: { eventRole: "witness", archiveName: "50%_А" } }]) {
        const started = performance.now();
        const page = await search(item);
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 5000, "broad/short/filter search stays within the unchanged 5s budget");
        t.diagnostic(JSON.stringify({ smoke: item, rpcMs: Math.round(elapsed), items: page.items.length }));
      }
      const deepCursor = (await db.query<{ publishedAt: string; id: string }>(
        'select published_at::text as "publishedAt", id from zagulyaky_records where id=$1', [id(59000)],
      )).rows[0];
      const deepPlan = (await plan(fix, null, deepCursor))[0];
      const deepScans = nodes(deepPlan.Plan).filter((node) => node["Relation Name"] === "zagulyaky_records");
      assert.ok(deepScans.some((node) => node["Index Name"] === "zagulyaky_records_public_feed_idx"));
      assert.ok(deepScans.every((node) => (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) <= 21),
        "deep cursor seeks directly, instead of reading earlier pages");
      assert.equal((await search({ cursor: deepCursor })).items.length, 20);
      t.diagnostic(JSON.stringify({ deepCursorMs: deepPlan["Execution Time"] }));
    });
  } finally { await db.close(); }
});
