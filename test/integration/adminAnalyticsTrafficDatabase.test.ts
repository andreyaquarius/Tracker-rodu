import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PRODUCT_ANALYTICS_PAGE_CODES } from "../../src/utils/productAnalyticsRegistry.ts";

const migration = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");
function fn(source: string, name: string) {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, name);
  const body = source.slice(start).match(/as (\$[a-z_]*\$)/i)!;
  assert.ok(body, name);
  const end = source.indexOf(body[1] + ";", start + body.index! + body[0].length);
  assert.ok(end > start, name);
  return source.slice(start, end + body[1].length + 1);
}

test("admin analytics runs against real PostgreSQL DDL, RLS, ingestion and report functions", { timeout: 60_000 }, async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema security_private;
      grant usage on schema security_private, auth to authenticated, service_role;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table app_admins(user_id uuid primary key);
      create table admin_role_assignments(user_id uuid, role_code text);
      create table admin_role_permissions(role_code text, permission_code text);
      insert into app_admins values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
      insert into admin_role_assignments values ('00000000-0000-4000-8000-000000000001','analytics'),('00000000-0000-4000-8000-000000000002','support');
      insert into admin_role_permissions values ('analytics','analytics.view'),('support','support.manage');
      create function public.is_app_admin(id uuid) returns boolean language sql stable security definer as $$
        select exists(select 1 from app_admins where user_id = id) $$;
      select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001', false);
    `);
    const foundation = migration("202608150001_product_analytics_foundation");
    const actions = migration("202608150002_product_analytics_actions_reports");
    await db.exec(foundation.slice(foundation.indexOf("create table if not exists public.product_analytics_sessions"), foundation.indexOf("create index if not exists admin_role_assignments_role_idx")));
    await db.exec(actions.slice(actions.indexOf("alter table public.product_analytics_events"), actions.indexOf("create table if not exists public.admin_analytics_preferences")));
    await db.exec(fn(actions, "security_private.has_admin_permission_v1"));
    for (const name of ["product_analytics_sessions", "product_analytics_events", "product_analytics_ingest_limits"]) {
      await db.exec(`alter table public.${name} enable row level security; revoke all on table public.${name} from public,anon,authenticated; grant all on public.${name} to service_role;`);
    }
    for (const name of ["admin_get_product_analytics_overview", "admin_get_product_analytics_pages", "ingest_product_analytics_batch"]) {
      await db.exec(fn(foundation, `security_private.${name}_v1`));
      await db.exec(fn(foundation, `public.${name}`));
    }
    const sql = migration("202609070003_admin_analytics_traffic");
    await db.exec(sql);
    // Existing grants retained when the overview and page functions are replaced.
    await db.exec(`
      revoke all on function public.ingest_product_analytics_batch(text,uuid,boolean,text,text,text,text,smallint,jsonb) from public,anon,authenticated;
      grant execute on function public.ingest_product_analytics_batch(text,uuid,boolean,text,text,text,text,smallint,jsonb) to service_role;
      revoke all on function public.admin_get_product_analytics_overview(timestamptz,timestamptz), public.admin_get_product_analytics_pages(timestamptz,timestamptz),
        security_private.admin_get_product_analytics_overview_v1(timestamptz,timestamptz), security_private.admin_get_product_analytics_pages_v1(timestamptz,timestamptz) from public,anon;
      grant execute on function public.admin_get_product_analytics_overview(timestamptz,timestamptz), public.admin_get_product_analytics_pages(timestamptz,timestamptz),
        security_private.admin_get_product_analytics_overview_v1(timestamptz,timestamptz), security_private.admin_get_product_analytics_pages_v1(timestamptz,timestamptz) to authenticated;
    `);
    const query = async (name: string, args = "") => (await db.query<{value: any}>(`select public.${name}(${args}) as value`)).rows[0].value;
    const reset = () => db.exec("reset role; truncate product_analytics_events, product_analytics_sessions, product_analytics_ingest_limits;");
    const seed = async (count: number, timestamp: string, page = "places", internal = false, start = 1) => {
      for (let i = start; i < start + count; i++) {
        const actor = i.toString(16).padStart(64,"0"), session = randomUUID();
        await db.query(`insert into product_analytics_sessions(id,actor_key,is_internal,started_at,last_seen_at,entry_page_code,exit_page_code,device_class,viewport_bucket,consent_version)
          values($1,decode($2,'hex'),$3,$4::timestamptz - interval '1 day',$4,'places','places','desktop','lg',2)`, [session,actor,internal,timestamp]);
        for (const [event, seconds] of [["page_viewed",0],["page_active_time",60]]) {
          await db.query(`insert into product_analytics_events(event_id,session_id,actor_key,occurred_at,event_name,page_code,active_seconds)
            values($1,$2,decode($3,'hex'),$4,$5,$6,$7)`, [randomUUID(),session,actor,timestamp,event,page,seconds]);
        }
      }
    };
    const range = "'2026-09-05T00:00:00Z','2026-09-08T00:00:00Z'";

    await t.test("zero days are filled; small cohorts are redacted per section, day, hour and device", async () => {
      let data = await query("admin_get_product_analytics_traffic", range);
      assert.equal(data.daily.length, 4); // rolling interval includes partial first/last Kyiv days
      assert.equal(data.hourly.length, 24);
      assert.ok(data.daily.every((row) => row.users === 0 && !row.suppressed));
      await seed(1, "2026-09-06T12:00:00Z");
      data = await query("admin_get_product_analytics_traffic", range);
      const day = data.daily.find((row) => row.day === "2026-09-06");
      assert.equal(day.suppressed, true);
      for (const key of ["users","sessions","pageViews","activeSeconds","averageSessionSeconds","averageUserSeconds"]) assert.equal(day[key], null);
      assert.equal(data.hourly[15].users, null);
      assert.equal(data.devices.find((row) => row.device === "desktop").users, null);
      const pages = await query("admin_get_product_analytics_pages", range);
      assert.equal(pages.length, PRODUCT_ANALYTICS_PAGE_CODES.length);
      assert.equal(pages.find((row) => row.page_code === "places").users, null);
      assert.equal(pages.find((row) => row.page_code === "notes").users, 0);
      await reset();
    });

    await t.test("period metrics include older sessions, exclude outside activity and internal actors", async () => {
      await seed(5, "2026-09-06T12:00:00Z");
      await seed(5, "2026-09-04T12:00:00Z");
      await seed(8, "2026-09-06T12:00:00Z", "places", true, 10);
      const data = await query("admin_get_product_analytics_overview", range);
      assert.equal(data.users, 5); assert.equal(data.sessions, 5);
      assert.equal(data.pageViews, 5); assert.equal(data.activeSeconds, 300);
      assert.equal(data.averageSessionSeconds, 60);
      assert.equal(data.averageUserSeconds, 60);
      const traffic = await query("admin_get_product_analytics_traffic", range);
      assert.equal(traffic.daily.reduce((sum, row) => sum + row.activeSeconds, 0), 300);
      assert.doesNotMatch(JSON.stringify(traffic), /actor_key|session_id|project_id/);
      await reset();
    });

    await t.test("Kyiv buckets cross midnight and daylight-saving boundaries correctly", async () => {
      await seed(5, "2026-03-28T22:30:00Z");
      await seed(5, "2026-03-29T01:30:00Z");
      const data = await query("admin_get_product_analytics_traffic", "'2026-03-28T22:00:00Z','2026-03-29T21:00:00Z'");
      assert.deepEqual(data.daily.map((r) => r.day), ["2026-03-29"]);
      assert.equal(data.daily[0].users, 5);
      assert.equal(data.hourly[0].users, 5); assert.equal(data.hourly[4].users, 5);
      assert.equal(data.hourly[3].users, 0);
      await reset();
    });

    await t.test("online deduplicates tabs; excludes stale, future and internal activity", async () => {
      const now = Date.now();
      await seed(5, new Date(now - 10_000).toISOString());
      await seed(2, new Date(now - 20_000).toISOString()); // same actors, additional tabs
      await seed(6, new Date(now - 180_000).toISOString(), "places", false, 20);
      await seed(6, new Date(now + 240_000).toISOString(), "places", false, 30);
      await seed(6, new Date(now - 10_000).toISOString(), "places", true, 40);
      const data = await query("admin_get_product_analytics_online");
      assert.equal(data.users, 5); assert.equal(data.windowSeconds, 120);
      await reset();
      await seed(1, new Date(now - 10_000).toISOString());
      assert.equal((await query("admin_get_product_analytics_online")).users, null);
      await reset();
      assert.equal((await query("admin_get_product_analytics_online")).users, 0);
    });

    await t.test("all new sections ingest successfully and retries do not duplicate events", async () => {
      const events = PRODUCT_ANALYTICS_PAGE_CODES.map((pageCode) => ({
        eventId: randomUUID(), name: "page_viewed", occurredAt: new Date().toISOString(), pageCode,
        activeSeconds: 0, actionCode: null, outcome: null, durationBucket: null, countBucket: null,
      }));
      const session = randomUUID();
      const ingest = () => db.query<{ value: { accepted: number } }>(`select public.ingest_product_analytics_batch($1,$2,false,'free','desktop','lg','test',2::smallint,$3::jsonb) as value`, ["a".repeat(64),session,JSON.stringify(events)]);
      await db.exec("set role service_role");
      assert.equal((await ingest()).rows[0].value.accepted, events.length);
      assert.equal((await ingest()).rows[0].value.accepted, 0);
      await db.exec("reset role");
      assert.equal((await db.query<{ page_views: number }>("select page_views from product_analytics_sessions")).rows[0].page_views, events.length);
      events[0].pageCode = "private-person-url" as any;
      await assert.rejects(ingest(), /INVALID/);
      await reset();
    });

    await t.test("permissions stay server-enforced; users cannot read raw rows or forge ingestion", async () => {
      await db.exec("set role authenticated");
      assert.equal((await query("admin_get_product_analytics_online")).users, 0);
      for (const rpc of ["admin_get_product_analytics_traffic", "admin_get_product_analytics_overview", "admin_get_product_analytics_pages"]) await query(rpc, range);
      await assert.rejects(db.query("select * from product_analytics_events"), /permission denied/);
      await assert.rejects(db.query("select * from product_analytics_sessions"), /permission denied/);
      await assert.rejects(db.query("select public.ingest_product_analytics_batch(null,null,false,null,null,null,null,2::smallint,'[]'::jsonb)"), /permission denied/);
      await db.exec("select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false)");
      await assert.rejects(query("admin_get_product_analytics_online"), /ADMIN_PERMISSION_REQUIRED/);
      await assert.rejects(query("admin_get_product_analytics_traffic", range), /ADMIN_PERMISSION_REQUIRED/);
      await db.exec("select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',false)");
      await assert.rejects(query("admin_get_product_analytics_online"), /ADMIN_PERMISSION_REQUIRED/);
      await db.exec("reset role; set role anon");
      await assert.rejects(query("admin_get_product_analytics_online"), /permission denied/);
      await assert.rejects(query("admin_get_product_analytics_traffic", range), /permission denied/);
      await db.exec("reset role; select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false)");
    });

    await t.test("bounded ranges reject null, reversed, infinite or oversized requests", async () => {
      for (const args of ["null,now()", "now(),now() - interval '1 day'", "'-infinity','infinity'", "now() - interval '92 days',now()"]) {
        await assert.rejects(query("admin_get_product_analytics_traffic", args), /INVALID_DATE_RANGE/);
      }
    });

    await t.test("large synthetic history uses the recent-activity index and bounded reports", async () => {
      await db.exec(`
        insert into product_analytics_sessions(id,actor_key,started_at,last_seen_at,entry_page_code,exit_page_code,device_class,viewport_bucket,consent_version)
        select ('07090000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid, decode(lpad(to_hex(i),64,'0'),'hex'),
          now()-interval '90 days',now(),'places','places','desktop','lg',2 from generate_series(1,1000) i;
        insert into product_analytics_events(event_id,session_id,actor_key,occurred_at,event_name,page_code,active_seconds)
        select gen_random_uuid(),('07090000-0000-4000-8000-'||lpad((i%1000+1)::text,12,'0'))::uuid,
          decode(lpad(to_hex(i%1000+1),64,'0'),'hex'),now() - ((i%129600)||' minutes')::interval,
          'page_active_time','places',60 from generate_series(1,80000) i;
        analyze product_analytics_events; analyze product_analytics_sessions;
      `);
      const plan = await db.query("explain select actor_key,session_id from product_analytics_events where event_name='page_active_time' and occurred_at >= now()-interval '2 minutes' and occurred_at<=now()");
      assert.match(JSON.stringify(plan.rows), /product_analytics_events_(presence|occurred)_idx/);
      assert.equal((await db.query("select 1 from pg_indexes where indexname='product_analytics_events_presence_idx'")).rows.length, 1);
      const start = performance.now();
      const report = await query("admin_get_product_analytics_traffic", "now()-interval '90 days',now()");
      t.diagnostic(`80,000 events / 1,000 actors / 90-day traffic: ${Math.round(performance.now()-start)} ms (local PGlite)`);
      assert.ok(report.daily.length >= 90 && report.daily.length <= 91);
      const onlineStart = performance.now();
      await query("admin_get_product_analytics_online");
      t.diagnostic(`Indexed online query: ${Math.round(performance.now()-onlineStart)} ms (local PGlite)`);
    });
  } finally { await db.close(); }
});
