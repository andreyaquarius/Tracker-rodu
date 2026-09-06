import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Runs the real migration in PostgreSQL/WASM. The minimal dependency schema
// mirrors the existing project membership + owner RLS contracts; it does not
// claim to replace a complete Supabase migration rehearsal.
const id = (n: number) => `06000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("photo tagging migration: persistence, project/person/source RLS and lifecycle", async (t) => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema security_private; create schema private;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to authenticated;
    create table public.projects(id uuid primary key);
    create table public.project_members(project_id uuid references projects, user_id uuid, role text);
    create function public.is_project_member(p uuid) returns boolean language sql stable security definer as $$
      select exists(select 1 from public.project_members where project_id = p and user_id = auth.uid());
    $$;
    create function public.can_edit_project(p uuid) returns boolean language sql stable security definer as $$
      select exists(select 1 from public.project_members where project_id = p and user_id = auth.uid() and role in ('owner', 'editor'));
    $$;
    create table public.persons(id uuid primary key, project_id uuid references projects,
      full_name text default '', surname text default '', given_name text default '', patronymic text default '',
      name_variants text default '', surname_variants text default '', birth_date text default '', birth_place text default '',
      privacy_status text default 'project', custom_fields jsonb default '{}', unique(id, project_id));
    create table public.documents(id uuid primary key, project_id uuid references projects, custom_fields jsonb default '{}', hidden boolean default false);
    create table public.findings(id uuid primary key, project_id uuid references projects, custom_fields jsonb default '{}');
    create table public.attachments(id uuid primary key, project_id uuid references projects,
      owner_type text, owner_id uuid, field_key text, storage_bucket text, storage_path text,
      file_name text default 'Synthetic.png', mime_type text default 'image/png', size_bytes bigint default 100,
      created_at timestamptz default now());
    grant select, insert, update, delete on public.persons, public.documents, public.findings, public.attachments to authenticated;
    do $$ declare tbl text; begin
      foreach tbl in array array['persons','documents','findings','attachments'] loop
        execute format('alter table public.%I enable row level security', tbl);
        execute format('create policy members on public.%I for select to authenticated using (public.is_project_member(project_id))', tbl);
        execute format('create policy editors on public.%I for all to authenticated using (public.can_edit_project(project_id)) with check (public.can_edit_project(project_id))', tbl);
      end loop;
    end $$;
    -- A stricter owner policy demonstrates tags cannot bypass owner visibility.
    create policy hidden_document on public.documents as restrictive for select to authenticated
      using (not hidden or public.can_edit_project(project_id));
    insert into projects values ('${id(10)}'), ('${id(20)}');
    insert into project_members values ('${id(10)}', '${id(1)}', 'owner'), ('${id(20)}', '${id(1)}', 'owner'),
      ('${id(10)}', '${id(2)}', 'editor'), ('${id(10)}', '${id(3)}', 'viewer');
    insert into persons(id,project_id,full_name,privacy_status) values
      ('${id(101)}','${id(10)}','Тестова Анна','project'),
      ('${id(102)}','${id(10)}','Тестовий Богдан','public'),
      ('${id(103)}','${id(10)}','Тестова Приватна','private'),
      ('${id(104)}','${id(20)}','Тестова Чужа','project');
    insert into documents(id,project_id) values ('${id(201)}','${id(10)}'), ('${id(202)}','${id(20)}');
    insert into attachments(id,project_id,owner_type,owner_id,field_key,storage_bucket,storage_path) values
      ('${id(301)}','${id(10)}','documents','${id(201)}','scans','google-drive','synthetic-drive-1'),
      ('${id(302)}','${id(20)}','documents','${id(202)}','scans','google-drive','synthetic-drive-2');
    update documents d set custom_fields = jsonb_build_object('__trackerRoduDocumentScans',
      jsonb_build_array(jsonb_build_object('id', a.id, 'storage', 'google-drive', 'storagePath', a.storage_path, 'driveResourceKey', 'synthetic-key')))
      from attachments a where a.owner_id = d.id;
  `);
  await db.exec(readFileSync(new URL("../../supabase/migrations/202609060001_photo_person_tags.sql", import.meta.url), "utf8"));
  const asUser = async (user: number, role = "authenticated") => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id(user)]);
    await db.exec(`set role ${role}`);
  };
  const value = async (sql: string, params: unknown[] = []) => (await db.query<{ result: any }>(sql, params)).rows[0]?.result;
  const save = (person = 101, photo = 301, project = 10, tag: string | null = null, version: number | null = null, x = 0.1, width = 0.3) =>
    value("select public.save_photo_person_tag_v1($1,$2,$3,$4,0.2,$5,0.4,$6,$7) as result", [id(project), id(photo), id(person), x, width, tag, version]);
  const list = (person?: number) => value("select public.list_photo_person_tags_v1($1,$2,$3) as result", [id(10), person ? null : id(301), person ? id(person) : null]);
  const remove = (tag: string, version: number) => value("select public.delete_photo_person_tag_v1($1,$2,$3) as result", [id(10), tag, version]);
  const rejectsCode = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: any) => error.code === code);
  let anna: string; let bogdan: string;
  try {
    await asUser(1);
    await t.test("stores multiple tags and projects one original into each person's album", async () => {
      anna = await save(); bogdan = await save(102); await save(103);
      const result = await list();
      assert.equal(result.tags.length, 3); assert.equal(result.canEdit, true);
      assert.equal(result.photo.storagePath, "synthetic-drive-1");
      assert.equal(result.photo.driveResourceKey, "synthetic-key");
      assert.equal((await list(101)).tags[0].id, anna);
      assert.equal((await list(102)).tags[0].photo.id, id(301));
      assert.equal(await value("select count(*)::int as result from attachments"), 2);
    });
    await t.test("rejects duplicates, invalid coordinates and cross-project links even for an owner of both projects", async () => {
      await rejectsCode(save(), "23505");
      await rejectsCode(save(104), "42501");
      await rejectsCode(save(104, 301, 20), "42501");
      await rejectsCode(save(101, 302, 10), "42501");
      await rejectsCode(save(101, 301, 10, anna, 1, -0.1), "23514");
      await rejectsCode(save(101, 301, 10, anna, 1, 0.9), "23514");
      await rejectsCode(save(101, 301, 10, anna, 1, 0.1, 0), "23514");
      await rejectsCode(value("select public.list_photo_person_tags_v1($1) as result", [id(10)]), "22023");
      await db.exec("reset role");
      await rejectsCode(db.query("insert into photo_person_tags(project_id,attachment_id,person_id,x,y,width,height) values($1,$2,$3,0,0,1,1)", [id(10), id(301), id(104)]), "23503");
      await rejectsCode(db.query("insert into photo_person_tags(project_id,attachment_id,person_id,x,y,width,height) values($1,$2,$3,0,0,1,1)", [id(10), id(302), id(101)]), "23503");
      await asUser(1);
    });
    await t.test("optimistic revisions prevent lost edits/deletes and source reparenting", async () => {
      await save(101, 301, 10, anna, 1, 0.2);
      const result = await list(101); assert.equal(result.tags[0].version, 2); assert.equal(result.tags[0].x, 0.2);
      await rejectsCode(save(101, 301, 10, anna, 1), "40001");
      await rejectsCode(remove(anna, 1), "40001");
      await rejectsCode(db.query("update photo_person_tags set attachment_id=$1, project_id=$2 where id=$3", [id(302), id(20), anna]), "23514");
    });
    await t.test("viewers see accessible people only and cannot mutate through RPC or table", async () => {
      await asUser(3);
      assert.equal((await list()).tags.length, 2); assert.equal((await list()).canEdit, false);
      const found = await db.query("select * from public.search_photo_tag_persons_v1($1,'Тест')", [id(10)]);
      assert.equal(found.rows.length, 2);
      await rejectsCode(list(103), "42501");
      await rejectsCode(save(), "42501");
      await rejectsCode(remove(anna, 2), "40001");
      assert.equal((await db.query("update photo_person_tags set x=0.1 returning id")).rows.length, 0);
      assert.equal((await db.query("delete from photo_person_tags returning id")).rows.length, 0);
    });
    await t.test("anonymous and nonmembers cannot read metadata, search results or tags", async () => {
      await asUser(4);
      await rejectsCode(list(), "42501");
      assert.equal((await db.query("select * from photo_person_tags")).rows.length, 0);
      assert.equal((await db.query("select * from public.search_photo_tag_persons_v1($1,'Тест')", [id(10)])).rows.length, 0);
      await asUser(4, "anon");
      await rejectsCode(list(), "42501");
      await rejectsCode(db.query("select * from photo_person_tags"), "42501");
    });
    await t.test("owner RLS and removed source JSON hide tags and album entries", async () => {
      await asUser(1); await db.query("update documents set hidden=true where id=$1", [id(201)]);
      await asUser(3); await rejectsCode(list(), "42501"); assert.equal((await list(101)).tags.length, 0);
      await asUser(1); await db.query("update documents set hidden=false where id=$1", [id(201)]);
      const original = await value("select custom_fields as result from documents where id=$1", [id(201)]);
      await db.query("update documents set custom_fields='{}' where id=$1", [id(201)]);
      await rejectsCode(list(), "42501"); assert.equal((await list(101)).tags.length, 0);
      await db.query("update documents set custom_fields=$1 where id=$2", [original, id(201)]);
      assert.equal((await list()).tags.length, 3);
    });
    await t.test("person photos and finding scans work; private source-person photos stay hidden from viewers", async () => {
      await asUser(1);
      await db.query("insert into findings(id,project_id) values($1,$2)", [id(501), id(10)]);
      for (const [attachment, ownerType, owner] of [[303, "persons", 103], [304, "findings", 501]] as const) {
        await db.query("insert into attachments(id,project_id,owner_type,owner_id,field_key,storage_bucket,storage_path) values($1,$2,$3,$4,'photos','google-drive',$5)",
          [id(attachment), id(10), ownerType, id(owner), `synthetic-${attachment}`]);
        await db.query(`update ${ownerType} set custom_fields=$1 where id=$2`, [
          { nested: { photos: [{ id: id(attachment), storage: "google-drive", storagePath: `synthetic-${attachment}` }] } }, id(owner),
        ]);
        await save(101, attachment);
      }
      assert.equal((await list(101)).tags.length, 3);
      await asUser(3);
      assert.equal((await list(101)).tags.length, 2);
      assert.equal((await db.query("select * from photo_person_tags where attachment_id=$1", [id(303)])).rows.length, 0);
      await asUser(1);
      await db.query("delete from attachments where id in ($1,$2)", [id(303), id(304)]);
    });
    await t.test("editors may change the chosen person and deleting a tag preserves person and original", async () => {
      await asUser(2); await remove(bogdan, 1);
      assert.equal((await list(102)).tags.length, 0);
      await save(102, 301, 10, anna, 2);
      assert.equal((await list(101)).tags.length, 0); assert.equal((await list(102)).tags[0].id, anna);
      assert.equal(await value("select count(*)::int as result from persons where id=$1", [id(102)]), 1);
      assert.equal(await value("select count(*)::int as result from attachments where id=$1", [id(301)]), 1);
    });
    await t.test("membership revocation immediately removes reads", async () => {
      await db.exec("reset role"); await db.query("delete from project_members where user_id=$1", [id(2)]);
      await asUser(2); await rejectsCode(list(), "42501");
    });
    await t.test("replacement clears rectangles, person/attachment deletion cascades", async () => {
      await asUser(1);
      await db.query("update attachments set storage_path='replacement' where id=$1", [id(301)]);
      assert.equal(await value("select count(*)::int as result from photo_person_tags"), 0);
      await db.query("update attachments set storage_path='synthetic-drive-1' where id=$1", [id(301)]);
      await save(); await save(102);
      await db.query("delete from persons where id=$1", [id(101)]);
      assert.equal((await list()).tags.length, 1);
      await db.query("delete from attachments where id=$1", [id(301)]);
      assert.equal(await value("select count(*)::int as result from photo_person_tags"), 0);
    });
  } finally { await db.close(); }
});
