import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = (source: string, name: string) => {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("$function$;", start);
  assert.ok(end > start, name);
  return source.slice(start, end + "$function$;".length);
};
const id = (n: number) => `70912000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("archival approval and photo publication: real SQL privacy, permissions and retries", async (t) => {
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
  const moderator = id(1);
  const foundation = migration("202608180002_zagulyaky_foundation");
  const consent = migration("202608190001_zagulyaky_privacy_and_attachment_delivery");
  const privacy = migration("202608190003_zagulyaky_privacy_integrity_and_public_redaction");
  const coordinates = migration("202608230003_zagulyaky_map_coordinates");
  const attachments = migration("202608290004_zagulyaky_attachment_row_assignment_fix");
  const scalar = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await db.query<{ result: T }>(sql, params)).rows[0].result;
  const publish = (recordId: string, sourceId = recordId, version = 1, verification = "verified") => scalar<Record<string, unknown>>(
    "select public.admin_publish_archival_zagulyaka_v1($1, $2, $3, '', $4) as result", [recordId, version, sourceId, verification]);
  const current = (recordId: string) => scalar<boolean>("select security_private.zagulyaky_has_living_person_clearance_v1($1) as result", [recordId]);
  const fixture = async (n: number, status = "pending_review", privacyStatus = "requires_consent") => {
    const key = id(n);
    await db.query("insert into zagulyaky_records(id, kind, title, possible_living_person, status, privacy_status) values ($1, 'person', 'Історичний запис', true, $2, $3)", [key, status, privacyStatus]);
    await db.query("insert into zagulyaky_sources(id, source_type, title, citation) values ($1, 'archive', 'Опублікований архів', 'Ф. 1, оп. 2, спр. 3, арк. 4')", [key]);
    await db.query("insert into zagulyaky_record_sources(record_id, source_id) values ($1, $1)", [key]);
    return key;
  };
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create schema security_private; create schema extensions; create schema storage;
      create extension pg_trgm schema extensions; create extension pgcrypto schema extensions;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function security_private.has_admin_permission_v1(text) returns boolean language sql stable as $$ select auth.uid() = '${moderator}'::uuid $$;
      create table profiles(user_id uuid primary key);
      insert into profiles values ('${moderator}'), ('${id(2)}');
      select set_config('request.jwt.claim.sub', '${moderator}', false);
      grant usage on schema auth, security_private to authenticated;
      create table admin_audit_log(admin_actor_id uuid, action_code text, target_type text, target_id text, outcome text, sanitized_diff jsonb);
      create table storage.objects(bucket_id text, name text, primary key(bucket_id, name));
      create table zagulyaky_storage_cleanup_queue(storage_bucket text, storage_path text, status text);`);
    await db.exec(foundation.slice(foundation.indexOf("create table if not exists public.zagulyaky_records"), foundation.indexOf("create table if not exists public.zagulyaky_claims")));
    await db.exec(foundation.slice(foundation.indexOf("create table if not exists public.zagulyaky_moderation_actions"), foundation.indexOf("-- Keep global public contributions"))
      .replace("'privacy_block', 'privacy_clear'", "'privacy_block', 'privacy_clear', 'attachment_publish'"));
    await db.exec(`alter table zagulyaky_records add origin_geo jsonb, add found_geo jsonb;
      alter table zagulyaky_participants add event_role_code text, add event_role_custom text,
        add social_estate_text text, add occupation_or_rank_text text, add marital_status_text text,
        add relation_original text, add evidence_excerpt text;
      alter table zagulyaky_attachments add public_derivative_generation uuid;`);
    await db.exec(consent.slice(consent.indexOf("create table if not exists"), consent.indexOf("create or replace function")));
    await db.exec("alter table zagulyaky_privacy_clearances add reviewed_content_fingerprint text");
    for (const name of ["security_private.normalize_zagulyaky_geo_point_v1", "security_private.zagulyaky_living_person_content_fingerprint_v1"]) await db.exec(fn(coordinates, name));
    for (const name of ["zagulyaky_has_living_person_clearance_v1", "stamp_zagulyaky_privacy_clearance_fingerprint_v1", "enforce_zagulyaky_living_person_privacy_v1", "revoke_zagulyaky_living_clearance_on_privacy_block_v1", "admin_get_zagulyaka_privacy_clearance_v1"]) await db.exec(fn(privacy, `security_private.${name}`));
    await db.exec(fn(consent, "security_private.admin_record_zagulyaka_living_consent_v1"));
    await db.exec(fn(foundation, "security_private.touch_zagulyaky_record_v1"));
    await db.exec(fn(foundation, "public.admin_review_zagulyaka_v1").replace("function public.", "function security_private."));
    await db.exec(`create trigger zagulyaky_records_touch before update on zagulyaky_records for each row execute function security_private.touch_zagulyaky_record_v1();
      create trigger zagulyaky_records_living_privacy before insert or update on zagulyaky_records for each row execute function security_private.enforce_zagulyaky_living_person_privacy_v1();
      create trigger zagulyaky_clearance_stamp before insert or update on zagulyaky_privacy_clearances for each row execute function security_private.stamp_zagulyaky_privacy_clearance_fingerprint_v1();
      create trigger zagulyaky_clearance_revoke after update on zagulyaky_records for each row execute function security_private.revoke_zagulyaky_living_clearance_on_privacy_block_v1();`);
    await db.exec(fn(migration("202608190002_zagulyaky_storage_cleanup"), "security_private.zagulyaky_public_attachment_path_v2"));
    await db.exec(fn(attachments, "security_private.admin_prepare_zagulyaka_attachment_publication_v2"));
    await db.exec(fn(attachments, "security_private.admin_complete_zagulyaka_attachment_publication_v2"));
    await db.exec(migration("202609120001_zagulyaky_archival_publication"));

    await t.test("unconfirmed historical record publishes without fabricated consent", async () => {
      const recordId = await fixture(10);
      assert.equal(await current(recordId), false);
      await db.exec("set role authenticated");
      const published = await publish(recordId);
      await db.exec("reset role");
      assert.equal(published.status, "published");
      assert.equal(published.privacy_status, "cleared");
      assert.equal(published.possible_living_person, true, "do not erase the privacy flag");
      assert.equal(await current(recordId), true);
      const clearance = await scalar<Record<string, unknown>>("select to_jsonb(c) as result from zagulyaky_privacy_clearances c where record_id=$1", [recordId]);
      assert.equal(clearance.publication_basis, "historical_archive");
      assert.equal(clearance.consent_obtained_at, null);
      assert.equal(clearance.evidence_reference, `archival-source:${recordId}`);
      assert.equal(await scalar("select count(*)::int as result from admin_audit_log where target_id=$1 and action_code='zagulyaky.archival_publication'", [recordId]), 1);
    });

    await t.test("non-moderators and anonymous callers cannot attest or publish", async () => {
      const recordId = await fixture(11);
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id(2)]);
      await assert.rejects(publish(recordId), /ADMIN_PERMISSION_REQUIRED/);
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
      await assert.rejects(publish(recordId), /ADMIN_PERMISSION_REQUIRED/);
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [moderator]);
      await db.exec("set role anon");
      await assert.rejects(publish(recordId), /permission denied/);
      await db.exec("reset role");
      assert.equal(await current(recordId), false);
      assert.equal(await scalar("select count(*)::int as result from zagulyaky_privacy_clearances where record_id=$1", [recordId]), 0);
    });

    await t.test("stale version, unrelated/restricted sources and invalid states do not leave approval behind", async () => {
      const recordId = await fixture(12);
      await assert.rejects(publish(recordId, recordId, 999), /ZAGULYAKA_VERSION_CONFLICT/);
      await assert.rejects(publish(recordId, id(10)), /ARCHIVAL_PUBLICATION_SOURCE_REQUIRED/);
      await assert.rejects(publish(recordId, recordId, 1, "invalid"), /INVALID_VERIFICATION_STATUS/);
      await db.query("update zagulyaky_sources set permission_status='restricted' where id=$1", [recordId]);
      await assert.rejects(publish(recordId), /ARCHIVAL_PUBLICATION_SOURCE_REQUIRED/);
      assert.equal(await scalar("select count(*)::int as result from zagulyaky_privacy_clearances where record_id=$1", [recordId]), 0);
      await assert.rejects(publish(await fixture(13, "pending_review", "blocked")), /ARCHIVAL_PUBLICATION_BLOCKED/);
      await assert.rejects(publish(await fixture(14, "draft")), /INVALID_MODERATION_TRANSITION/);
    });

    await t.test("record/source edits invalidate archive approval; fresh approval binds updated content", async () => {
      const recordId = await fixture(15);
      await publish(recordId);
      await db.query("update zagulyaky_sources set citation='Виправлений опис' where id=$1", [recordId]);
      assert.equal(await current(recordId), false);
      await db.query("update zagulyaky_records set status='pending_review', privacy_status='requires_consent' where id=$1", [recordId]);
      const version = await scalar<number>("select lock_version as result from zagulyaky_records where id=$1", [recordId]);
      await publish(recordId, recordId, version);
      assert.equal(await current(recordId), true);
      await db.query("update zagulyaky_records set original_text='Нові дані' where id=$1", [recordId]);
      assert.equal(await current(recordId), false);
    });

    await t.test("privacy block revokes archival approval; living-person consent flow still works", async () => {
      const archived = await fixture(16);
      await publish(archived);
      await db.query("update zagulyaky_records set privacy_status='blocked' where id=$1", [archived]);
      assert.equal(await current(archived), false);
      assert.equal(await scalar("select review_status as result from zagulyaky_privacy_clearances where record_id=$1", [archived]), "revoked");
      const living = await fixture(17);
      await assert.rejects(scalar("select security_private.admin_review_zagulyaka_v1($1,1,'publish','','verified','cleared') as result", [living]), /LIVING_PERSON_DOCUMENTED_CONSENT_REQUIRED/);
      await scalar("select security_private.admin_record_zagulyaka_living_consent_v1($1, now(), 'private-consent-proof') as result", [living]);
      assert.equal(await current(living), true);
      const result = await scalar<Record<string, unknown>>("select security_private.admin_review_zagulyaka_v1($1,1,'publish','','verified','cleared') as result", [living]);
      assert.equal(result.status, "published");
    });

    await t.test("reproduce premature-photo error, then approve first and complete/retry without duplicates", async () => {
      const recordId = await fixture(18);
      await db.query("insert into zagulyaky_attachments(id, record_id, storage_bucket, storage_path, file_name, mime_type, byte_size, sha256) values ($1,$1,'zagulyaky-private','original/scan.png','scan.png','image/png',100,repeat('a',64))", [recordId]);
      const prepare = () => scalar<Record<string, unknown>>("select security_private.admin_prepare_zagulyaka_attachment_publication_v2($1) as result", [recordId]);
      await assert.rejects(prepare(), /ATTACHMENT_RECORD_NOT_PUBLIC/);
      await publish(recordId);
      const prepared = await prepare();
      assert.equal(prepared.publicationState, "ready");
      await db.query("insert into storage.objects(bucket_id,name) values ('zagulyaky-public',$1)", [prepared.publicPath]);
      const complete = () => scalar<Record<string, unknown>>("select security_private.admin_complete_zagulyaka_attachment_publication_v2($1,$2) as result", [recordId, prepared.publicPath]);
      assert.equal((await complete()).alreadyPublished, false);
      assert.equal((await complete()).alreadyPublished, true);
      assert.equal((await prepare()).publicationState, "published");
      assert.equal(await current(recordId), true, "derivative metadata must not invalidate approval");
      assert.equal(await scalar("select count(*)::int as result from storage.objects where bucket_id='zagulyaky-public' and name=$1", [prepared.publicPath]), 1);
      assert.equal(await scalar("select count(*)::int as result from admin_audit_log where target_id=$1 and action_code='zagulyaky.attachment.publish'", [recordId]), 1);
    });
  } finally {
    await db.close();
  }
});
