import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { parseAdminSubscriptionsPage, type AdminSubscriptionsQuery } from "../../src/utils/adminSubscriptions.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hardening = readFileSync("supabase/migrations/202606220001_security_definer_rpc_hardening.sql", "utf8");
function legacyFunction(name: string) {
  const start = hardening.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0);
  return hardening.slice(start, hardening.indexOf("\n$$;", start) + 4);
}

test("admin subscription pages use exact counts, stable order and existing RLS/entitlements", { timeout: 60_000 }, async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      grant usage on schema auth to authenticated, anon;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select current_user::text $$;
      create table public.profiles(user_id uuid primary key, email text not null, display_name text, created_at timestamptz not null);
      create table public.app_admins(user_id uuid primary key);
      create table public.subscription_plans(id uuid primary key, code text not null);
      create table public.user_subscriptions(user_id uuid primary key references profiles(user_id) on delete cascade,
        plan_id uuid references subscription_plans(id), status text, trial_ends_at timestamptz, current_period_end timestamptz);
      grant select on public.profiles, public.user_subscriptions, public.subscription_plans to authenticated;
      alter table public.profiles enable row level security;
      alter table public.user_subscriptions enable row level security;
      alter table public.subscription_plans enable row level security;
      create policy plans_read on public.subscription_plans for select to authenticated using (true);
    `);
    await db.exec(legacyFunction("is_app_admin"));
    await db.exec(`
      create policy profiles_read on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_app_admin(auth.uid()));
      create policy subscriptions_read on public.user_subscriptions for select to authenticated using (user_id = auth.uid() or public.is_app_admin(auth.uid()));
      insert into profiles select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
        'person' || i || '@example.test', 'Користувач ' || i, '2020-01-01'::timestamptz from generate_series(1,1027) i;
      update profiles set display_name='Олена КОРЗУН' where user_id='${id(1026)}';
      update profiles set display_name='100%_точний\\збіг' where user_id='${id(1025)}';
      insert into app_admins values ('${id(1027)}');
      insert into subscription_plans values ('${id(1)}','free'),('${id(2)}','researcher'),('${id(3)}','professional');
      insert into user_subscriptions
      select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
        ('00000000-0000-4000-8000-' || lpad((i%3+1)::text, 12, '0'))::uuid,
        case i%7 when 2 then 'trialing' when 3 then 'trialing' when 4 then 'past_due' when 5 then 'cancelled' else 'active' end,
        case i%7 when 2 then now()+interval '10 days' when 3 then now()-interval '10 days' else null end,
        case i%7 when 0 then now()-interval '10 days' when 1 then now()+interval '10 days' else null end
      from generate_series(1,1027) i where i <> 1024;
      select set_config('request.jwt.claim.sub','${id(1027)}',false);
    `);
    await db.exec(legacyFunction("admin_list_subscriptions"));
    const migration = readFileSync("supabase/migrations/202609100000_admin_subscriptions_pagination.sql", "utf8");
    await db.exec(migration);
    // Repeat application is safe and does not change data or permissions.
    await db.exec(migration);
    await db.exec("set role authenticated");
    const call = async (input: AdminSubscriptionsQuery = {}) => {
      const result = await db.query<{ value: unknown }>("select public.admin_list_subscriptions_page_v1($1,$2,$3,$4) as value",
        [input.page ?? 1, input.query ?? "", input.plan ?? "all", input.status ?? "all"]);
      return parseAdminSubscriptionsPage(result.rows[0].value);
    };
    const legacy = (await db.query<Record<string, any>>("select * from public.admin_list_subscriptions()" )).rows;

    await t.test("1027 profiles produce 21 pages with 50/27 rows and no missing or duplicated users", async () => {
      const start = performance.now();
      const first = await call();
      t.diagnostic(`First page of 1,027 profiles: ${Math.round(performance.now() - start)} ms (local PGlite)`);
      assert.equal(first.totalCount, 1027);
      assert.equal(first.filteredCount, 1027);
      assert.equal(first.rows.length, 50);
      assert.equal(first.rows[0].userId, id(1027));
      const ids = first.rows.map((row) => row.userId);
      for (let page = 2; page <= 21; page++) {
        const next = await call({ page });
        assert.equal(next.page, page);
        assert.equal(next.totalCount, 1027);
        assert.equal(next.rows.length, page === 21 ? 27 : 50);
        ids.push(...next.rows.map((row) => row.userId));
      }
      assert.equal(new Set(ids).size, 1027);
      assert.deepEqual(ids, [id(1027), ...Array.from({ length: 1026 }, (_, i) => id(i + 1))]);
      assert.deepEqual((await call({ page: 2 })).rows.map((row) => row.userId), ids.slice(50,100));
      // Plain SQL emulates the outer Data API row cap: one JSON row still retains full totals.
      const capped = await db.query<{ value: any }>("select public.admin_list_subscriptions_page_v1() value limit 1000");
      assert.equal(capped.rows[0].value.total_count, 1027);
    });

    await t.test("search finds users outside the old 1000 rows, with literal special characters", async () => {
      for (const query of ["person1026@example.test", "олена корзун", "КОРЗУН"]) {
        const page = await call({ query, page: 21 });
        assert.equal(page.totalCount, 1027);
        assert.equal(page.filteredCount, 1);
        assert.equal(page.page, 1);
        assert.equal(page.rows[0].userId, id(1026));
      }
      assert.equal((await call({ query: "%_" })).rows[0].userId, id(1025));
      assert.equal((await call({ query: "\\" })).filteredCount, 1);
      const empty = await call({ query: "no-match' OR 1=1--", page: 999 });
      assert.equal(empty.totalCount, 1027);
      assert.equal(empty.filteredCount, 0);
      assert.equal(empty.page, 1);
      assert.deepEqual(empty.rows, []);
    });

    await t.test("plan/status combinations retain the legacy effective subscription rules", async () => {
      for (const plan of ["all", "admin", "free", "researcher", "professional"] as const) {
        for (const status of ["all", "active", "trialing", "past_due", "cancelled", "expired"] as const) {
          const expected = legacy.filter((row) => (plan === "all" || (plan === "admin" ? row.is_admin : !row.is_admin && row.plan_code === plan))
            && (status === "all" || row.status === status));
          const actual = await call({ plan, status });
          assert.equal(actual.filteredCount, expected.length, `${plan}/${status}`);
          assert.equal(actual.totalCount, 1027);
          for (const row of actual.rows) {
            const old = expected.find((entry) => entry.user_id === row.userId)!;
            assert.ok(old);
            assert.equal(row.planCode, old.plan_code);
            assert.equal(row.status, old.status);
            assert.equal(row.trialEndsAt == null, old.trial_ends_at == null);
            assert.equal(row.currentPeriodEnd == null, old.current_period_end == null);
          }
        }
      }
      const admin = (await call({ plan: "admin" })).rows[0];
      assert.equal(admin.planCode, "professional");
      assert.equal(admin.status, "active");
      assert.equal(admin.currentPeriodEnd, null);
      assert.equal(admin.trialEndsAt, null);
      const noSubscription = (await call({ query: "person1024@" })).rows[0];
      assert.equal(noSubscription.planCode, "free");
      assert.equal(noSubscription.status, "active");
    });

    await t.test("out-of-range pages clamp, invalid filters fail and changed rows refresh without cached totals", async () => {
      assert.equal((await call({ page: -1 })).page, 1);
      assert.equal((await call({ page: 2_147_483_647 })).page, 21);
      for (const args of [[1, "x".repeat(201), "all", "all"], [1,"", "wrong", "all"], [1,"", "all", "wrong"]]) {
        await assert.rejects(db.query("select public.admin_list_subscriptions_page_v1($1,$2,$3,$4)", args), /Invalid subscription filters/);
      }
      await db.exec("reset role");
      await db.exec(`update user_subscriptions set plan_id='${id(2)}', status='active', current_period_end=null, trial_ends_at=null where user_id='${id(1026)}'`);
      await db.exec("set role authenticated");
      assert.equal((await call({ query: "person1026@" })).rows[0].planCode, "researcher");
      await db.exec("reset role");
      await db.exec(`delete from profiles where user_id >= '${id(1000)}' and user_id < '${id(1027)}'`);
      await db.exec("set role authenticated");
      const clamped = await call({ page: 21 });
      assert.equal(clamped.totalCount, 1000);
      assert.equal(clamped.page, 20);
      assert.equal(clamped.rows.length, 50);
    });

    await t.test("anonymous and ordinary users cannot read subscriptions or totals", async () => {
      const fn = (await db.query<{ prosecdef: boolean }>("select prosecdef from pg_proc where oid='public.admin_list_subscriptions_page_v1(integer,text,text,text)'::regprocedure")).rows[0];
      assert.equal(fn.prosecdef, false);
      await db.exec(`select set_config('request.jwt.claim.sub','${id(1)}',false)`);
      assert.equal((await db.query("select * from public.profiles")).rows.length, 1, "RLS remains enabled");
      await assert.rejects(call(), /Administrator access required/);
      await db.exec("select set_config('request.jwt.claim.sub','',false)");
      await assert.rejects(call(), /Administrator access required/);
      await db.exec("reset role; set role anon");
      await assert.rejects(call(), /permission denied/);
    });
  } finally { await db.close(); }
});
