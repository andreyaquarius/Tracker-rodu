import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const id = (n: number) => `06090000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),"utf8");
const functionSql = (source: string, name: string) => {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start,source.indexOf("$function$;",start)+"$function$;".length);
};

test("finding facts: real SQL, existing person-save bridge, role-safe events and shared marriages", async (t) => {
  const db = new PGlite({ extensions: { pg_trgm } });
  try {
    await db.exec(`
      create role authenticated; create role anon; create role service_role;
      create schema auth; create schema security_private; create schema extensions;
      create extension pg_trgm schema extensions;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
      grant usage on schema auth to authenticated;
      create table projects(id uuid primary key); create table profiles(user_id uuid primary key);
      create table researches(id uuid primary key); create table documents(id uuid primary key,project_id uuid);
      create table project_members(project_id uuid, user_id uuid, role text);
      create function public.is_project_member(p uuid) returns boolean language sql stable security definer as $$
        select exists(select 1 from project_members where project_id=p and user_id=auth.uid()) $$;
      create function public.can_edit_project(p uuid) returns boolean language sql stable security definer as $$
        select exists(select 1 from project_members where project_id=p and user_id=auth.uid() and role in ('owner','editor')) $$;
      create table persons(id uuid primary key,project_id uuid,full_name text default '',is_living boolean default false,privacy_status text default 'project',
        birth_date text default '',birth_place text default '',birth_year_from text default '',birth_year_to text default '',
        marriage_date text default '',marriage_place text default '',death_date text default '',death_place text default '',death_year_from text default '',death_year_to text default '',
        residence_places text default '',custom_fields jsonb default '{}',updated_at timestamptz default now(),unique(id,project_id));
      create table findings(id uuid primary key,project_id uuid,document_id uuid,finding_type text,event_date text default '',place text default '',archive text default '',fund text default '',
        description text default '',file_reference text default '',page text default '',source_url text default '',summary text default '',transcription text default '',
        conclusion text default '',notes text default '',custom_fields jsonb default '{}');
      create table finding_participants(id uuid primary key,project_id uuid,finding_id uuid references findings,person_id uuid,
        role text default '',name text default '',notes text default '',context_target_participant_id uuid);
    `);
    const foundation = migration("202606290003_family_tree_graph_foundation");
    await db.exec(foundation.slice(foundation.indexOf("create table if not exists public.family_trees"), foundation.indexOf("create table if not exists public.tree_layout_positions")));
    const timeline = migration("202606290004_family_tree_person_facts");
    await db.exec(timeline.slice(timeline.indexOf("create table if not exists public.person_timeline_events"), timeline.indexOf("do $$")));
    await db.exec(`alter table person_timeline_events add place_id uuid,add place_original_text text,add place_resolution_status text;
      create function security_private.lock_historical_place_ids_v1(uuid[],boolean) returns void language sql as $$ select $$;
      grant select,insert,update,delete on all tables in schema public to authenticated;
      alter table persons enable row level security;
      create policy persons_read on persons for select to authenticated using(public.is_project_member(project_id) and
        (public.can_edit_project(project_id) or not (is_living and privacy_status in ('private','confidential'))));
      insert into projects values('${id(10)}'),('${id(20)}');
      insert into profiles values('${id(1)}'),('${id(2)}'),('${id(3)}');
      insert into project_members values('${id(10)}','${id(1)}','owner'),('${id(10)}','${id(2)}','viewer'),('${id(20)}','${id(3)}','owner');
      insert into persons(id,project_id,full_name) values
        ('${id(101)}','${id(10)}','Захарій Корзун'),('${id(102)}','${id(10)}','Васса Кучинська'),
        ('${id(103)}','${id(10)}','Свідок Іван'),('${id(104)}','${id(10)}','Батько нареченого'),
        ('${id(105)}','${id(10)}','Дитина Марія'),('${id(106)}','${id(10)}','Хрещена Ганна'),('${id(107)}','${id(20)}','Чужа особа');
    `);
    // Actual production bridge, with only unrelated historical-place lock infrastructure stubbed.
    await db.exec(migration("202608280005_historical_places_person_save_bridge"));
    // Exercise the older core-date projection too (the historical-name half
    // is unrelated). This detects duplicates between the two person bridges.
    const legacy = migration("202607010001_family_tree_legacy_sync");
    // The real expression/partial couple index is essential: without it the
    // old delete -> relink duplicate error was invisible to this fixture.
    await db.exec(`create table person_relations(id uuid primary key);`);
    await db.exec(legacy.slice(legacy.indexOf("create table if not exists public.legacy_person_relation_graph_edges"),legacy.indexOf("create or replace function public.family_tree_evidence_status_from_legacy")));
    const eventProjection = legacy.slice(legacy.indexOf("  delete from public.person_timeline_events"),legacy.indexOf("create or replace function public.family_tree_sync_legacy_relation"));
    await db.exec(`create function public.family_tree_confidence_for_evidence(text) returns integer language sql as $$ select 50 $$;
      create function public.test_legacy_core_projection() returns trigger language plpgsql security definer as $$
      declare person_evidence_status text := 'unknown'; begin ${eventProjection}
      create trigger persons_family_tree_projection_sync after update on persons for each row execute function public.test_legacy_core_projection();`);
    await db.exec(migration("202609060003_finding_person_facts"));
    const query = async (sql: string, args: unknown[] = []) => (await db.query<any>(sql,args)).rows;
    const asUser = async (n: number) => { await db.exec("reset role"); await query("select set_config('request.jwt.claim.sub',$1,false)",[id(n)]); await db.exec("set role authenticated"); };
    const sync = async (finding = 201, project = 10) => (await query("select public.sync_finding_person_facts_v1($1,$2) as result",[id(project),id(finding)]))[0].result;
    const readPerson = async (n: number) => (await query("select * from persons where id=$1",[id(n)]))[0];
    const events = async (n: number) => (await readPerson(n)).custom_fields.__trackerRoduPersonEvents;
    await db.exec(`insert into findings(id,project_id,finding_type,event_date,place,summary,transcription,custom_fields) values
      ('${id(201)}','${id(10)}','шлюб','1892-01-24','Вербівка','Архівний запис','Точне написання джерела',
      '{"__trackerRoduFindingMeta":{"scans":[{"id":"scan-1","name":"Шлюб.jpg","storage":"google-drive","storagePath":"file-1"}]}}');
      insert into finding_participants(id,project_id,finding_id,person_id,role,name) values
      ('${id(301)}','${id(10)}','${id(201)}','${id(101)}','Наречений','Захарій Корзун'),
      ('${id(302)}','${id(10)}','${id(201)}','${id(102)}','Наречена','Васса Кучинська'),
      ('${id(303)}','${id(10)}','${id(201)}','${id(103)}','Свідок','Свідок Іван'),
      ('${id(304)}','${id(10)}','${id(201)}','${id(104)}','Батько нареченого','Батько');`);
    await asUser(1);
    await t.test("marriage dates for couple, participation with names for witness and father", async () => {
      const result = await sync(); assert.equal(result.personIds.length,4); assert.deepEqual(result.conflicts,[]);
      assert.equal((await readPerson(101)).marriage_date,'1892-01-24');
      assert.equal((await readPerson(102)).marriage_date,'1892-01-24');
      assert.equal((await readPerson(103)).marriage_date,'');
      assert.equal((await readPerson(104)).marriage_date,'');
      const witness = (await events(103))[0]; assert.equal(witness.type,'mention');
      assert.match(witness.title,/Свідок.*шлюб.*Захарій Корзун.*Васса Кучинська/);
      assert.match(witness.notes,/Точне написання джерела/); assert.equal(witness.scans[0].id,'scan-1');
      assert.deepEqual(witness.relatedPersonIds,[id(101),id(102)]);
      const marriage = (await query("select * from partner_relationships"))[0];
      assert.equal(marriage.start_date,'1892-01-24'); assert.equal(marriage.start_place,'Вербівка');
      const canonical = await query("select source_finding_id from person_timeline_events");
      assert.equal(canonical.length,4); assert.ok(canonical.every((row) => row.source_finding_id===id(201)));
    });
    await t.test("reproduces production 23505 after marriage deletion, then relinks using the existing group", async () => {
      const group = (await query("select family_group_id from partner_relationships"))[0].family_group_id;
      await query("delete from partner_relationships");
      await assert.rejects(sync(), (error: any) => error.code==='23505' && error.message.includes('family_groups_couple_pair_uq'));
      await db.exec("reset role");
      await db.exec(migration("202609060004_finding_fact_unlink_and_relink"));
      await asUser(1);
      await sync();
      assert.equal((await query("select family_group_id from partner_relationships"))[0].family_group_id, group);
      assert.equal((await query("select * from family_groups")).length, 1);
    });
    await t.test("repeat saves do not duplicate events or relationships; corrections update owned facts", async () => {
      await sync(); assert.equal((await events(101)).length,1);
      assert.equal((await query("select * from partner_relationships")).length,1);
      await query("update findings set event_date='1892-01-25' where id=$1",[id(201)]); await sync();
      assert.equal((await readPerson(101)).marriage_date,'1892-01-25');
      assert.equal((await query("select start_date from partner_relationships"))[0].start_date,'1892-01-25');
    });
    await t.test("manual profile/date edits are retained and conflict reported", async () => {
      await db.exec("reset role"); await query("update persons set marriage_date='1891' where id=$1",[id(101)]); await asUser(1);
      const result = await sync(); assert.ok(result.conflicts.some((entry: any) => entry.kind==='profile'));
      assert.equal((await readPerson(101)).marriage_date,'1891');
      assert.equal((await events(101))[0].date,'1892-01-25');
    });
    await t.test("existing empty shared marriage gets date without a second relationship", async () => {
      await query("update partner_relationships set start_date='',start_place='',metadata='{}'",[]);
      await sync(); const rows = await query("select * from partner_relationships");
      assert.equal(rows.length,1); assert.equal(rows[0].start_date,'1892-01-25');
    });
    await t.test("baptism belongs to child; godmother timeline states whose baptism, not her birth", async () => {
      await db.exec(`insert into findings(id,project_id,finding_type,event_date,place) values('${id(202)}','${id(10)}','хрещення','1900-02-02','Вербівка');
        insert into finding_participants(id,project_id,finding_id,person_id,role,name) values
        ('${id(305)}','${id(10)}','${id(202)}','${id(105)}','Дитина','Марія'),
        ('${id(306)}','${id(10)}','${id(202)}','${id(106)}','Хрещена мати','Ганна');`);
      await sync(202); assert.equal((await events(105))[0].type,'baptism'); assert.equal((await readPerson(105)).birth_date,'');
      assert.equal((await events(106))[0].type,'mention'); assert.match((await events(106))[0].title,/Хрещена мати.*Марія/);
      assert.equal((await readPerson(106)).birth_date,'');
    });
    await t.test("exact context target limits participation to specified child", async () => {
      await query("update finding_participants set context_target_participant_id=$1 where id=$2",[id(305),id(306)]);
      await sync(202); assert.deepEqual((await events(106))[0].relatedPersonIds,[id(105)]);
    });
    await t.test("birth, death, burial and divorce have distinct facts", async () => {
      await query("update findings set finding_type='народження' where id=$1",[id(202)]); await sync(202);
      assert.equal((await readPerson(105)).birth_date,'1900-02-02');
      await query("update finding_participants set role='Померла особа' where id=$1",[id(305)]);
      await query("update findings set finding_type='поховання',event_date='1980-03-04' where id=$1",[id(202)]); await sync(202);
      assert.equal((await readPerson(105)).death_date,''); assert.equal((await events(105))[0].type,'burial');
      await query("update findings set finding_type='смерть' where id=$1",[id(202)]); await sync(202);
      assert.equal((await readPerson(105)).death_date,'1980-03-04');
      await query("update findings set finding_type='розлучення',event_date='1901-02-03' where id=$1",[id(201)]); await sync();
      const marriage = (await query("select * from partner_relationships"))[0];
      assert.equal(marriage.end_date,'1901-02-03'); assert.equal(marriage.start_date,'1892-01-25');
      assert.equal((await events(102))[0].type,'divorce'); assert.equal((await readPerson(102)).marriage_date,'1892-01-25');
    });
    const isolated = async (name: string, check: () => Promise<void>) => t.test(name, async () => {
      await db.exec("begin");
      try { await check(); } finally { await db.exec("rollback"); }
    });
    const newPair = async () => {
      await db.exec("reset role");
      await query(`insert into persons(id,project_id,full_name,birth_date) values
        ($1,$3,'Новий наречений','1860'),($2,$3,'Нова наречена','1865')`,[id(108),id(109),id(10)]);
      await query(`insert into findings(id,project_id,finding_type,event_date,place)
        values($1,$2,'шлюб','1890-02-03','Тестове місце')`,[id(203),id(10)]);
      await query(`insert into finding_participants(id,project_id,finding_id,person_id,role,name) values
        ($1,$3,$4,$5,'Наречений','Наречений'),($2,$3,$4,$6,'Наречена','Наречена')`,[id(311),id(312),id(10),id(203),id(108),id(109)]);
      await asUser(1);
      await sync(203);
      return (await query("select * from partner_relationships where person_a_id=$1 or person_b_id=$1",[id(108)]))[0];
    };
    const unlink = async (finding=203) => {
      await query("update finding_participants set person_id=null where finding_id=$1",[id(finding)]);
      return sync(finding);
    };
    await isolated("unlink last participants removes owned profile/timeline/marriage facts and permits fresh reattachment", async () => {
      const old = await newPair();
      const result = await unlink();
      assert.ok(result.personIds.includes(id(108)) && result.personIds.includes(id(109)));
      assert.deepEqual(result.conflicts,[]);
      assert.equal((await readPerson(108)).marriage_date,'');
      assert.equal((await readPerson(109)).marriage_place,'');
      assert.equal((await readPerson(108)).birth_date,'1860');
      assert.deepEqual(await events(108),[]);
      assert.equal((await query("select * from person_timeline_events where source_finding_id=$1",[id(203)])).length,0);
      assert.equal((await query("select * from partner_relationships where id=$1",[old.id])).length,0);
      assert.equal((await readPerson(108)).custom_fields.__trackerRoduFindingFacts[id(203)],undefined);
      await query("update finding_participants set person_id=case when id=$1 then $2::uuid else $3::uuid end where finding_id=$4",[id(311),id(108),id(109),id(203)]);
      await sync(203); await sync(203);
      const rows = await query("select * from partner_relationships where person_a_id=$1 or person_b_id=$1",[id(108)]);
      assert.equal(rows.length,1); assert.equal(rows[0].family_group_id,old.family_group_id);
      assert.equal((await readPerson(108)).marriage_date,'1890-02-03'); assert.equal((await events(108)).length,1);
    });
    await isolated("marriage deletion plus unlink/relink preserves the couple group, children and parent sets", async () => {
      const old = await newPair();
      await query("insert into parent_sets(id,project_id,tree_id,child_id,family_group_id) values($1,$2,$3,$4,$5)",[id(501),id(10),old.tree_id,id(105),old.family_group_id]);
      await query("insert into parent_child_relationships(project_id,tree_id,parent_id,child_id,parent_set_id,family_group_id) values($1,$2,$3,$4,$5,$6)",[id(10),old.tree_id,id(108),id(105),id(501),old.family_group_id]);
      await query("insert into family_group_members(project_id,family_group_id,person_id,member_role) values($1,$2,$3,'child')",[id(10),old.family_group_id,id(105)]);
      await query("delete from partner_relationships where id=$1",[old.id]);
      await unlink();
      await query("update finding_participants set person_id=case when id=$1 then $2::uuid else $3::uuid end where finding_id=$4",[id(311),id(108),id(109),id(203)]);
      await sync(203);
      assert.equal((await query("select * from parent_sets where id=$1",[id(501)]))[0].family_group_id,old.family_group_id);
      assert.equal((await query("select * from parent_child_relationships where parent_set_id=$1",[id(501)])).length,1);
      assert.equal((await query("select * from family_group_members where family_group_id=$1 and member_role='child'",[old.family_group_id])).length,1);
      assert.equal((await query("select * from partner_relationships where source_finding_id=$1",[id(203)]))[0].family_group_id,old.family_group_id);
    });
    await isolated("switching a participant cleans the former person's facts and the obsolete couple only", async () => {
      const old = await newPair();
      await query("update finding_participants set person_id=$1 where id=$2",[id(105),id(311)]);
      const result = await sync(203);
      assert.ok(result.personIds.includes(id(108)));
      assert.equal((await readPerson(108)).marriage_date,''); assert.deepEqual(await events(108),[]);
      assert.equal((await readPerson(105)).marriage_date,'1890-02-03');
      assert.equal((await query("select * from partner_relationships where id=$1",[old.id])).length,0);
      assert.equal((await query("select * from partner_relationships where source_finding_id=$1",[id(203)])).length,1);
      assert.equal((await query("select * from partner_relationships where source_finding_id=$1",[id(201)])).length,1);
    });
    await isolated("manual dates and manually accepted marriages survive unlinking their source", async () => {
      const old = await newPair();
      await db.exec("reset role");
      await query("update persons set marriage_date='1889' where id=$1",[id(108)]);
      await asUser(1);
      await query(`update partner_relationships set start_date='1888',metadata=metadata||'{"source":"person_marriage_editor"}' where id=$1`,[old.id]);
      await unlink();
      assert.equal((await readPerson(108)).marriage_date,'1889'); assert.deepEqual(await events(108),[]);
      const row = (await query("select * from partner_relationships where id=$1",[old.id]))[0];
      assert.equal(row.start_date,'1888'); assert.equal(row.source_finding_id,null);
      assert.deepEqual(row.metadata.findingFacts,{});
    });
    await isolated("corroborating sources retain the fact until the last source is unlinked", async () => {
      const old = await newPair();
      await query("insert into findings(id,project_id,finding_type,event_date,place) values($1,$2,'шлюб','1890-02-03','Тестове місце')",[id(204),id(10)]);
      await query(`insert into finding_participants(id,project_id,finding_id,person_id,role,name) values
        ($1,$3,$4,$5,'Наречений','Наречений'),($2,$3,$4,$6,'Наречена','Наречена')`,[id(313),id(314),id(10),id(204),id(108),id(109)]);
      await sync(204); await unlink(203);
      assert.equal((await readPerson(108)).marriage_date,'1890-02-03');
      let row=(await query("select * from partner_relationships where id=$1",[old.id]))[0];
      assert.equal(row.start_date,'1890-02-03'); assert.equal(row.source_finding_id,id(204));
      assert.equal((await events(108)).length,1);
      await unlink(204);
      assert.equal((await readPerson(108)).marriage_date,''); assert.deepEqual(await events(108),[]);
      assert.equal((await query("select * from partner_relationships where id=$1",[old.id])).length,0);
    });
    await isolated("couple reuse works with reversed stored partner order", async () => {
      const old = await newPair();
      await query("delete from partner_relationships where id=$1",[old.id]);
      await query("update family_groups set primary_partner_1_id=$1,primary_partner_2_id=$2 where id=$3",[id(109),id(108),old.family_group_id]);
      await sync(203);
      assert.equal((await query("select * from partner_relationships where source_finding_id=$1",[id(203)]))[0].family_group_id,old.family_group_id);
    });
    await isolated("private cleanup cannot be called directly to bypass the public edit guard", async () => {
      await assert.rejects(query("select security_private.detach_obsolete_finding_facts_v1($1,$2,'{}','{}')",[id(10),id(201)]),(e:any)=>e.code==='42501');
    });
    await t.test("viewer, anonymous and cross-project calls cannot modify people", async () => {
      await asUser(2); await assert.rejects(sync(),(e: any) => e.code==='42501');
      await asUser(3); await assert.rejects(sync(),(e: any) => e.code==='42501');
      await asUser(1); await assert.rejects(sync(201,20),(e: any) => e.code==='42501');
      await db.exec("reset role; set role anon"); await assert.rejects(sync(),(e: any) => e.code==='42501');
    });

    await db.exec("reset role");
    await t.test("indexed name search preserves visibility, limits and ranking with 20k names", async () => {
      const old = migration("202608270005_historical_person_names");
      await db.exec(functionSql(old,"public.person_name_search_normalize_v1"));
      await db.exec(functionSql(old,"public.person_name_search_transliterate_v1"));
      await db.exec(`create table person_names(id uuid primary key default gen_random_uuid(),project_id uuid,person_id uuid,
        name_type text default 'primary',language_code text default 'uk',script_code text default '',orthography text default '',
        surname text default '',maiden_surname text default '',given_name text default '',patronymic text default '',nickname text default '',
        full_name text default '',original_text text default '',full_normalized text default '',search_text text default '',is_primary boolean default true,is_searchable boolean default true,
        source_type text default '',source_id uuid,source_document_id uuid,source_finding_id uuid,citation_id uuid,document_fragment_id uuid,
        confidence integer default 50,valid_from text default '',valid_to text default '',date_precision text default '',updated_at timestamptz default now());
        create index person_names_search_text_trgm_idx on person_names using gin(search_text extensions.gin_trgm_ops) where is_searchable;
        create index person_names_project_person_idx on person_names(project_id,person_id);
        alter table person_names enable row level security;
        create policy names_read on person_names for select to authenticated using(public.is_project_member(project_id));
        grant select on person_names to authenticated;
        insert into persons(id,project_id,full_name) select gen_random_uuid(),'${id(10)}','Іван Коваленко '||n from generate_series(1,20000) n;
        insert into person_names(project_id,person_id,original_text,full_normalized,search_text)
          select project_id,id,full_name,full_name,public.person_name_search_normalize_v1(full_name) from persons;
        update persons set is_living=true,privacy_status='private' where id='${id(103)}';
        analyze persons; analyze person_names;`);
      await db.exec(migration("202609060002_person_name_search_timeout"));
      await asUser(1);
      const search = async (q: string, limit=20, project=10) => (await query("select public.search_project_person_names_v1($1,$2,$3) as value",[id(project),q,limit]))[0].value;
      const start = performance.now(); const rows = await search('Іван Коваленко',5);
      t.diagnostic(`20k historical names, broad query: ${Math.round(performance.now()-start)} ms`);
      assert.equal(rows.length,5); assert.equal((await search('Захарій Корзун'))[0].matchType,'exact');
      assert.equal((await search('Свідок Іван'))[0].personId,id(103));
      await asUser(2); assert.ok(!(await search('Свідок Іван')).some((row: any) => row.personId===id(103)));
      assert.equal((await search('Чужа особа')).length,0);
      await assert.rejects(search('Іван',5,20),(e: any) => e.code==='42501');
      await assert.rejects(search('x'.repeat(201)),(e: any) => e.code==='22023');
      assert.deepEqual(await search('a'),[]);
      await db.exec("reset role; set role anon"); await assert.rejects(search('Іван'),(e: any) => e.code==='42501');
    });
  } finally { await db.close(); }
});
