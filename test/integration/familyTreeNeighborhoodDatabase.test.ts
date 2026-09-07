import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const id = (n: number) => `07090000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migration = (name: string) => readFileSync(
  new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8",
);
function functionSql(source: string, name: string): string {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, name);
  const body = source.indexOf("as $$", start);
  assert.ok(body > start, name);
  const end = source.indexOf("$$;", body + 5);
  assert.ok(end > body, name);
  return source.slice(start, end + 3);
}

// Run the real neighborhood SQL and graph DDL. Only unrelated app/auth
// infrastructure is reduced to a project membership fixture; no live data.
async function setup(db: PGlite) {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table projects(id uuid primary key);
    create table profiles(user_id uuid primary key);
    create table researches(id uuid primary key);
    create table documents(id uuid primary key);
    create table findings(id uuid primary key);
    create table project_members(project_id uuid, user_id uuid, role text,
      primary key(project_id, user_id));
    create function public.is_project_member(p uuid) returns boolean language sql stable security definer as $$
      select exists(select 1 from project_members where project_id=p and user_id=auth.uid()) $$;
    create function public.can_edit_project(p uuid) returns boolean language sql stable security definer as $$
      select exists(select 1 from project_members where project_id=p and user_id=auth.uid() and role in ('owner','editor')) $$;
    create table persons(id uuid primary key, project_id uuid, full_name text default '',
      given_name text default '', surname text default '', patronymic text default '',
      gender text default '', is_living boolean default false, privacy_status text default 'project',
      birth_date text default '', birth_year_from text default '', birth_year_to text default '',
      death_date text default '', death_year_from text default '', death_year_to text default '',
      unique(id, project_id));
    create function test_id(n integer) returns uuid language sql immutable as $$
      select ('07090000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
    insert into projects values('${id(10)}');
    insert into profiles values('${id(1)}'),('${id(2)}'),('${id(3)}');
    insert into project_members values('${id(10)}','${id(1)}','owner'),('${id(10)}','${id(2)}','viewer');
    select set_config('request.jwt.claim.sub','${id(1)}', false);
  `);
  const foundation = migration("202606290003_family_tree_graph_foundation");
  await db.exec(foundation.slice(
    foundation.indexOf("create table if not exists public.family_trees"),
    foundation.indexOf("create table if not exists public.tree_layout_positions"),
  ));
  await db.exec("alter table family_trees add graph_version bigint not null default 1;");
  const scope = migration("202607110002_family_tree_family_scope");
  await db.exec(scope.slice(scope.indexOf("create index"), scope.indexOf("-- Internal helper")));
  const original = migration("202607100001_family_tree_neighborhood");
  for (const name of ["family_tree_cursor_encode", "family_tree_cursor_decode", "family_tree_neighbor_page"]) {
    await db.exec(functionSql(original, `public.${name}`));
  }
  const performance = migration("202607100002_family_tree_neighborhood_performance");
  await db.exec(functionSql(performance, "public.family_tree_populate_continuations_v2"));
  await db.exec(functionSql(performance, "public.get_family_tree_neighborhood_v1"));
  await db.exec(`
    alter function public.get_family_tree_neighborhood_v1(jsonb) rename to get_family_tree_neighborhood_v1_feature_impl;
    revoke execute on function public.get_family_tree_neighborhood_v1_feature_impl(jsonb) from public,anon,authenticated;
    revoke execute on function public.family_tree_populate_continuations_v2(uuid,bigint) from public,anon,authenticated;
    create function public.get_family_tree_neighborhood_v1(p_request jsonb) returns jsonb language sql security definer set search_path=public as $$
      select public.get_family_tree_neighborhood_v1_feature_impl(p_request) $$;
    revoke execute on function public.get_family_tree_neighborhood_v1(jsonb) from public,anon;
    grant execute on function public.get_family_tree_neighborhood_v1(jsonb) to authenticated;
  `);
  await db.exec(`
    insert into family_trees(id, project_id, title, privacy_status) values('${id(100)}','${id(10)}','Synthetic pedigree','project');
    insert into persons(id, project_id, full_name)
      select test_id(1000+i),'${id(10)}','Ancestor '||i from generate_series(1,255) s(i);
    insert into family_tree_persons(project_id,tree_id,person_id,display_order)
      select '${id(10)}','${id(100)}',id,row_number() over(order by id) from persons;
    update family_trees set root_person_id='${id(1001)}' where id='${id(100)}';
    insert into parent_sets(id,project_id,tree_id,child_id,display_order)
      select test_id(200000+i),'${id(10)}','${id(100)}',test_id(1000+i),i from generate_series(1,127) s(i);
    insert into parent_child_relationships(id,project_id,tree_id,parent_id,child_id,parent_set_id,evidence_status,privacy_status)
      select test_id(300000+i),'${id(10)}','${id(100)}',test_id(1000+i),test_id(1000+i/2),test_id(200000+i/2),'proven','project'
      from generate_series(2,255) s(i);
    analyze;
  `);
}

type Payload = {
  persons: { id: string; displayName: string }[];
  unions: unknown[];
  parentChildRelations: unknown[];
  continuations: { personId: string; direction: string; hiddenCount: number; token: string }[];
  graphVersion: string;
  permissionFingerprint: string;
};

async function load(db: PGlite, extra: Record<string, unknown> = {}) {
  const started = performance.now();
  const result = await db.query<{ payload: Payload }>(
    "select public.get_family_tree_neighborhood_v1($1::jsonb) as payload",
    [JSON.stringify({ treeId: id(100), focusPersonId: id(1001), ancestorDepth: 7,
      descendantDepth: 0, collateralDepth: 0, maxNodes: 400, ...extra })],
  );
  return { payload: result.rows[0]!.payload, ms: Math.round(performance.now() - started) };
}

test("neighborhood SQL: real migration preserves results, cursors and permissions on deep and wide trees", async (t) => {
  const db = new PGlite();
  const fix = migration("202609070002_family_tree_neighborhood_timeout_fix");
  const oldHelper = functionSql(migration("202607100002_family_tree_neighborhood_performance"),
    "public.family_tree_populate_continuations_v2");
  const installBaseline = async () => {
    await db.exec(oldHelper);
    await db.exec("alter function public.get_family_tree_neighborhood_v1_feature_impl(jsonb) reset plan_cache_mode;");
  };
  try {
    await setup(db);
    const small = await load(db);
    assert.equal(small.payload.persons.length, 255);
    await db.exec(`
      insert into persons(id,project_id,full_name)
        select test_id(500000+i),'${id(10)}','Unrelated '||i from generate_series(1,50000) s(i);
      insert into family_tree_persons(project_id,tree_id,person_id)
        select '${id(10)}','${id(100)}',test_id(500000+i) from generate_series(1,50000) s(i);
      insert into parent_sets(id,project_id,tree_id,child_id)
        select test_id(1000000+i),'${id(10)}','${id(100)}',test_id(500000+i) from generate_series(1,49999) s(i);
      insert into parent_child_relationships(id,project_id,tree_id,parent_id,child_id,parent_set_id,evidence_status,privacy_status)
        select test_id(2000000+i),'${id(10)}','${id(100)}',test_id(500001+i),test_id(500000+i),test_id(1000000+i),'proven','project'
        from generate_series(1,49999) s(i);
      analyze;
    `);
    const before = await load(db);
    assert.deepEqual(before.payload, small.payload);
    await db.exec(fix);
    const after = await load(db);
    assert.deepEqual(after.payload, before.payload);
    assert.ok(after.ms < 4000, `bounded pedigree exceeded 4s regression budget: ${after.ms}ms`);
    t.diagnostic(`50,255-person tree, identical 255 cards: before=${before.ms}ms, after=${after.ms}ms`);

    // Mixed biological/adoptive sets, a shared parent, a hidden person, a
    // disproven edge and a confidential edge all exercise the actual SQL.
    await db.exec(`
      insert into parent_sets(id,project_id,tree_id,child_id,set_type,display_order)
        values('${id(250000)}','${id(10)}','${id(100)}','${id(1001)}','adoptive',2);
      insert into parent_child_relationships(id,project_id,tree_id,parent_id,child_id,parent_set_id,relationship_type,evidence_status,privacy_status)
        values
        ('${id(350001)}','${id(10)}','${id(100)}','${id(500001)}','${id(1001)}','${id(250000)}','adoptive','proven','project'),
        ('${id(350002)}','${id(10)}','${id(100)}','${id(1002)}','${id(1001)}','${id(250000)}','adoptive','proven','project'),
        ('${id(350003)}','${id(10)}','${id(100)}','${id(500020)}','${id(1001)}','${id(250000)}','adoptive','disproven','project'),
        ('${id(350004)}','${id(10)}','${id(100)}','${id(500030)}','${id(1001)}','${id(250000)}','adoptive','proven','confidential'),
        ('${id(350005)}','${id(10)}','${id(100)}','${id(500040)}','${id(1001)}','${id(250000)}','adoptive','proven','project');
      update family_tree_persons set member_role='hidden' where tree_id='${id(100)}' and person_id='${id(500040)}';
      update persons set is_living=true,privacy_status='private' where id='${id(1002)}';
      insert into partner_relationships(id,project_id,tree_id,person_a_id,person_b_id,relationship_type,evidence_status,privacy_status)
        values('${id(360000)}','${id(10)}','${id(100)}','${id(1001)}','${id(500100)}','marriage','proven','project');
      analyze;
    `);
    const cases: Record<string, unknown>[] = [
      {}, { maxNodes: 20 }, { ancestorDepth: 1 },
      { focusPersonId: id(1008), ancestorDepth: 1, descendantDepth: 3, collateralDepth: 1, maxNodes: 45 },
      { focusPersonId: id(500050), ancestorDepth: 7, descendantDepth: 2, collateralDepth: 0 },
    ];
    for (const user of [1, 2]) {
      await db.exec(`select set_config('request.jwt.claim.sub','${id(user)}',false)`);
      await installBaseline();
      const expected = [];
      for (const request of cases) expected.push((await load(db, request)).payload);
      const continuation = expected[2]!.continuations.find(item => item.direction === "parents")!;
      assert.ok(continuation, "shallow scope exposes ancestor continuation");
      const branch = { branches: [{ personId: continuation.personId, directions: [continuation.direction],
        cursors: { [continuation.direction]: continuation.token } }], maxNodes: 20 };
      const expectedBranch = (await load(db, branch)).payload;
      await db.exec(fix);
      await db.exec("set role authenticated");
      for (const [index, request] of cases.entries()) {
        assert.deepEqual((await load(db, request)).payload, expected[index], `user=${user}, case=${index}`);
      }
      assert.deepEqual((await load(db, branch)).payload, expectedBranch, "pre-upgrade cursor still resumes exactly");
      for (const showAllParentSets of [true, false, true, false]) {
        assert.deepEqual((await load(db, { showAllParentSets })).payload, expected[0]);
      }
      if (user === 2) {
        const persons = expected[0]!.persons;
        assert.equal(persons.find(person => person.id === id(1002))?.displayName, "Приватна особа");
        for (const excluded of [500020, 500030, 500040]) {
          assert.ok(!persons.some(person => person.id === id(excluded)), `private/hidden/disproven ${excluded}`);
        }
      }
      await db.exec("reset role");
    }
    await db.exec(`select set_config('request.jwt.claim.sub','${id(1)}',false);
      insert into persons(id,project_id,full_name)
        select test_id(3000000+i),'${id(10)}','Wide family '||i from generate_series(1,2480) s(i);
      insert into family_tree_persons(project_id,tree_id,person_id)
        select '${id(10)}','${id(100)}',test_id(3000000+i) from generate_series(1,2480) s(i);
      insert into parent_sets(id,project_id,tree_id,child_id,display_order)
        select test_id(4000000+i),'${id(10)}','${id(100)}',test_id(3000000+i),i from generate_series(2,2480) s(i);
      insert into parent_child_relationships(id,project_id,tree_id,parent_id,child_id,parent_set_id,evidence_status,privacy_status)
        select test_id(5000000+i),'${id(10)}','${id(100)}',test_id(3000001),test_id(3000000+i),test_id(4000000+i),'proven','project'
        from generate_series(2,2480) s(i);
      analyze;`);
    const wideRequest = { focusPersonId: id(3000001), ancestorDepth: 0, descendantDepth: 1, maxNodes: 600 };
    await installBaseline();
    const wideBefore = await load(db, wideRequest);
    await db.exec(fix);
    const wideAfter = await load(db, wideRequest);
    assert.deepEqual(wideAfter.payload, wideBefore.payload);
    assert.equal(wideAfter.payload.persons.length, 600);
    assert.equal(wideAfter.payload.continuations.find(item => item.personId === id(3000001) && item.direction === "children")?.hiddenCount, 1880);
    assert.ok(wideAfter.ms < 4000, `wide family exceeded 4s regression budget: ${wideAfter.ms}ms`);
    t.diagnostic(`2,480-person wide branch inside 52k tree: before=${wideBefore.ms}ms, after=${wideAfter.ms}ms`);
    assert.equal((await db.query("show plan_cache_mode")).rows[0]!.plan_cache_mode, "auto", "function settings must not leak to the session");
    for (const fn of ["get_family_tree_neighborhood_v1_feature_impl(jsonb)", "family_tree_populate_continuations_v2(uuid,bigint)"]) {
      assert.equal((await db.query<{ allowed: boolean }>("select has_function_privilege('authenticated',$1,'EXECUTE') allowed", [`public.${fn}`])).rows[0]!.allowed, false);
    }
    await db.exec(`select set_config('request.jwt.claim.sub','${id(3)}',false); set role authenticated;`);
    await assert.rejects(() => load(db), (error: { code?: string }) => error.code === "42501");
    await db.exec("reset role; set role anon;");
    await assert.rejects(() => load(db), (error: { code?: string }) => error.code === "42501");
    await db.exec("reset role;");
  } finally {
    await db.close();
  }
});
