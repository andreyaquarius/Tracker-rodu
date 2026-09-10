import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const id = (n: number) => `a0910000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = id(999999);
const tableColumns: Record<string, string> = {
  persons: "id uuid primary key, updated_at timestamptz default now()",
  person_relations: "id uuid primary key, person_id uuid, related_person_id uuid",
  task_persons: "person_id uuid, task_id uuid",
  tasks: "id uuid primary key, document_id uuid",
  hypothesis_links: "hypothesis_id uuid, target_id uuid, target_type text",
  archive_request_persons: "person_id uuid, archive_request_id uuid",
  findings: "id uuid primary key, document_id uuid, custom_fields jsonb default '{}'",
  finding_participants: "id uuid primary key, finding_id uuid, person_id uuid",
  documents: "id uuid primary key",
  person_timeline_events: "id uuid primary key, person_id uuid, event_type text, event_date text, date_to text, date_from text, date_text text, updated_at timestamptz default now()",
};

test("scoped summary SQL matches legacy results, enforces RLS/project bounds, and indexes normalized JSON links", async (t) => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role;");
    for (const [table, columns] of Object.entries(tableColumns)) {
      await db.exec(`create table ${table} (${columns}, project_id uuid, allowed boolean default true);
        alter table ${table} enable row level security;
        create policy visible on ${table} for select to authenticated using (allowed);
        grant select on ${table} to authenticated; create index on ${table}(project_id);`);
    }
    await db.exec(migration("202607180001_persons_module_v2_summary"));
    await db.exec(migration("202609100001_scoped_person_summaries"));
    await db.exec(`
      insert into persons(id, project_id) select ('a0910000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'${project}' from generate_series(1,1500) n;
      insert into documents(id,project_id) select id,project_id from persons;
      insert into findings(id,project_id,document_id,custom_fields) select id,project_id,id,
        jsonb_build_object('__trackerRoduFindingMeta',jsonb_build_object('personIds',jsonb_build_array('  ' || upper(id::text) || '  ', id::text, 'bad-uuid',null))) from persons;
      insert into finding_participants(id,project_id,finding_id,person_id) select id,project_id,id,id from persons;
      insert into tasks(id,project_id,document_id) select id,project_id,id from persons;
      insert into task_persons(project_id,person_id,task_id) select project_id,id,id from persons;
      insert into hypothesis_links(project_id,hypothesis_id,target_id,target_type) select project_id,id,id,'person' from persons;
      insert into hypothesis_links(project_id,hypothesis_id,target_id,target_type) select project_id,id,id,'document' from persons;
      insert into archive_request_persons(project_id,person_id,archive_request_id) select project_id,id,id from persons;
      insert into person_relations(id,project_id,person_id,related_person_id) select id,project_id,id,'${id(1)}' from persons;
      insert into person_timeline_events(id,project_id,person_id,event_type,event_date,date_text)
        select id,project_id,id,'marriage','1901-01-01','1901' from persons;
      update documents set allowed=false where id='${id(2)}';
      update persons set allowed=false where id='${id(3)}';
      update findings set allowed=false where id='${id(4)}';
      update finding_participants set allowed=false where id='${id(5)}';
      update findings set custom_fields='{"__trackerRoduFindingMeta":{"personIds":"invalid"}}' where id='${id(6)}';
      update persons set project_id='${id(999998)}' where id='${id(7)}';
      analyze findings;
    `);
    await db.exec("set role authenticated");
    const legacy = await db.query<{ person_id: string }>("select * from list_person_summaries($1)", [project]);
    const requested = Array.from({ length: 25 }, (_, n) => id(n + 1));
    const scoped = await db.query<{ person_id: string; document_count: number; finding_count: number }>(
      "select * from list_person_summaries_v2($1,$2)", [project, requested]);
    assert.deepEqual(scoped.rows, legacy.rows.filter((row) => requested.includes(row.person_id)));
    assert.equal(scoped.rows.find((row) => row.person_id === id(2))?.document_count, 0);
    assert.equal(scoped.rows.find((row) => row.person_id === id(5))?.finding_count, 1, "legacy metadata still links with a hidden participant");
    assert.equal(scoped.rows.some((row) => row.person_id === id(3) || row.person_id === id(7)), false);
    const startFull = performance.now();
    for (let n = 0; n < 5; n++) await db.query("select * from list_person_summaries($1)", [project]);
    const fullMs = (performance.now() - startFull) / 5;
    const startScoped = performance.now();
    for (let n = 0; n < 5; n++) await db.query("select * from list_person_summaries_v2($1,$2)", [project, requested]);
    t.diagnostic(`1,500 synthetic persons: full RPC ${fullMs.toFixed(1)} ms / ${legacy.rows.length} rows; visible-page RPC ${((performance.now() - startScoped) / 5).toFixed(1)} ms / ${scoped.rows.length} rows (local PGlite, not production).`);
    for (const ids of [[], null, Array(201).fill(id(1))]) {
      assert.equal((await db.query("select * from list_person_summaries_v2($1,$2)", [project, ids])).rows.length, 0);
    }
    await db.exec("reset role");
    const plan = await db.query("explain (format json) select id from findings where public.finding_summary_person_ids_v1(custom_fields) && $1::text[]", [[id(5)]]);
    assert.match(JSON.stringify(plan.rows), /findings_summary_person_ids_gin_idx/);
    await db.exec("set role anon");
    await assert.rejects(db.query("select * from list_person_summaries_v2($1,$2)", [project, [id(1)]]), /permission denied/);
  } finally { await db.close(); }
});

test("public statistics cache executes the exact SQL, invalidates all privacy dependencies and denies direct cache access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema security_private;
      grant usage on schema security_private to anon,authenticated,service_role;
      create table zagulyaky_records(id uuid primary key, kind text, status text, privacy_status text, possible_living_person boolean default false,
        verification_status text, created_by uuid, published_at timestamptz, event_year_from integer,event_year_to integer,
        source_location_normalized text,source_location_text text,found_location_normalized text,found_location_text text);
      create table zagulyaky_privacy_clearances(record_id uuid, approved boolean);
      create table zagulyaky_participants(record_id uuid, name text);
      create table zagulyaky_sources(id uuid,archive_name text);
      create table zagulyaky_record_sources(record_id uuid,source_id uuid);
      create table zagulyaky_document_discoveries(record_id uuid,official_location_text text,discovered_location_text text);
      create function security_private.zagulyaky_has_living_person_clearance_v1(p_id uuid) returns boolean language sql stable as $$
        select exists(select 1 from zagulyaky_privacy_clearances where record_id=p_id and approved) $$;`);
    await db.exec(migration("202609050002_zagulyaky_public_stats_timeout_fix"));
    await db.exec(migration("202609100002_zagulyaky_public_stats_cache"));
    await db.exec(`insert into zagulyaky_records(id,kind,status,privacy_status,published_at)
      values ('${id(1)}','person','published','cleared',now()),('${id(2)}','document','published','cleared',now()),
        ('${id(3)}','person','draft','cleared',now());`);
    const stats = async () => (await db.query<{ value: { people: number; documents: number; archives: number } }>(
      "select public.get_zagulyaky_public_stats_v1() as value")).rows[0].value;
    await db.exec("set role anon");
    assert.equal((await stats()).people, 1);
    assert.equal((await stats()).documents, 1);
    await assert.rejects(db.query("select * from security_private.zagulyaky_public_stats_cache"), /permission denied/);
    await assert.rejects(db.query("select security_private.compute_zagulyaky_public_stats_v1()"), /permission denied/);
    await db.exec("reset role");
    const firstExpiry = (await db.query("select expires_at from security_private.zagulyaky_public_stats_cache")).rows;
    for (let n = 0; n < 10; n++) await stats();
    assert.deepEqual((await db.query("select expires_at from security_private.zagulyaky_public_stats_cache")).rows, firstExpiry, "warm requests must not refresh or write");
    await db.exec(`update zagulyaky_records set privacy_status='blocked' where id='${id(1)}'`);
    assert.equal((await stats()).people, 0);
    await db.exec(`update zagulyaky_records set privacy_status='cleared',possible_living_person=true where id='${id(1)}'`);
    assert.equal((await stats()).people, 0);
    await db.exec(`insert into zagulyaky_privacy_clearances values('${id(1)}',true)`);
    assert.equal((await stats()).people, 1);
    await db.exec(`delete from zagulyaky_privacy_clearances`);
    assert.equal((await stats()).people, 0);
    await db.exec(`insert into zagulyaky_sources values('${id(9)}','Архів'); insert into zagulyaky_record_sources values('${id(2)}','${id(9)}')`);
    assert.equal((await stats()).archives, 1);
    for (const table of ["zagulyaky_participants", "zagulyaky_document_discoveries", "zagulyaky_sources", "zagulyaky_record_sources"]) {
      await stats();
      await db.exec(`delete from ${table} where false`);
      assert.equal((await db.query<{ dirty: boolean }>("select exists(select 1 from security_private.zagulyaky_stats_invalidations) as dirty")).rows[0].dirty, true, table);
    }
    await db.exec("update security_private.zagulyaky_public_stats_cache set payload='{}',expires_at=now()-interval '1 minute'");
    await db.exec("begin read only");
    assert.equal((await stats()).documents, 1, "read-only callers receive correct uncached data");
    await db.exec("commit");
    assert.equal((await stats()).documents, 1, "expired result is recomputed");
    await db.exec(migration("202609100002_zagulyaky_public_stats_cache"));
    assert.equal((await stats()).documents, 1, "migration is repeatable");
  } finally { await db.close(); }
});

test("no-op finding replay skips context rebuild but links, roles and source edits still synchronize once per finding", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema security_private;
      create table findings(id uuid primary key, project_id uuid, note text, updated_at timestamptz default now());
      create table finding_participants(id uuid primary key, finding_id uuid,project_id uuid,person_id uuid,role text,updated_at timestamptz default now());
      create table sync_calls(finding_id uuid,project_id uuid);
      create function security_private.sync_finding_context_relations_v1(finding_id uuid,project_id uuid) returns void language sql as $$insert into sync_calls values($1,$2)$$;`);
    await db.exec(migration("202609100003_skip_unchanged_finding_context_sync"));
    await db.exec(`create trigger finding_participants_80_context_sync_update after update on finding_participants
      referencing old table as old_rows new table as new_rows for each statement execute function security_private.sync_finding_context_after_update_v1();
      insert into findings(id,project_id,note) values('${id(1)}','${project}','old');
      insert into finding_participants(id,finding_id,project_id,person_id,role) values('${id(11)}','${id(1)}','${project}','${id(2)}','witness'),('${id(12)}','${id(1)}','${project}','${id(3)}','witness');
      update findings set updated_at=now(); update finding_participants set updated_at=now();`);
    const calls = async () => (await db.query("select * from sync_calls")).rows;
    assert.equal((await calls()).length, 0);
    await db.exec("update finding_participants set role='godparent'");
    assert.equal((await calls()).length, 1);
    await db.exec("truncate sync_calls; update finding_participants set person_id=null");
    assert.equal((await calls()).length, 1, "unlink still synchronizes");
    await db.exec(`truncate sync_calls; update finding_participants set finding_id='${id(4)}'`);
    assert.equal((await calls()).length, 2, "both old and new finding are synchronized");
    await db.exec("truncate sync_calls; update findings set note='changed'");
    assert.equal((await calls()).length, 1);
    assert.equal((await db.query("update findings set updated_at=now() returning id")).rows.length, 1, "RETURNING semantics stay intact");
  } finally { await db.close(); }
});
