import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  conflictFixtureSql, conflictMigration, conflictOwner, conflictOther,
  conflictRecord, versionedRpcNames,
} from "../helpers/zagulyakyConflictFixture.ts";

test("Zagulyaky conflict facades: real SQL, no retryable business error or privilege widening", async t => {
  const db = new PGlite();
  const scalar = async <T>(sql: string, args: unknown[] = []): Promise<T> =>
    (await db.query<{ result: T }>(sql, args)).rows[0].result;
  const user = (id: string | null) => db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: id })]);
  const save = (version: number | null, patch = { title: "Updated safely" }) =>
    scalar<Record<string, unknown>>("select public.update_my_zagulyaka_draft_v1($1,$2,$3) as result", [conflictRecord, version, patch]);
  const code = (expected: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;
  try {
    await db.exec(conflictFixtureSql());
    await user(conflictOwner);
    await t.test("reproduces the retryable 40001 before the forward migration", async () => {
      await assert.rejects(save(0), code("40001"));
    });
    const aclSql = `select jsonb_agg(jsonb_build_object('oid',p.oid,'name',p.proname,'owner',p.proowner,
      'acl',p.proacl,'args',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid)) order by p.proname) as result
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1)`;
    const before = await scalar(aclSql, [versionedRpcNames]);
    await db.exec(conflictMigration);
    await t.test("preserves OIDs, owners, ACLs, named parameters, defaults and result types", async () => {
      assert.deepEqual(await scalar(aclSql, [versionedRpcNames]), before);
      assert.equal(await scalar(`select count(*)::int as result from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any($1) and (p.prosecdef or p.provolatile<>'v' or not 'search_path=pg_catalog'=any(p.proconfig))`, [versionedRpcNames]), 0);
    });
    await t.test("fresh saves succeed; stale and null versions return PT409 without overwriting", async () => {
      await db.exec("set role authenticated");
      const saved = await save(1);
      assert.equal(saved.lock_version, 2);
      assert.equal(saved.title, "Updated safely");
      await assert.rejects(save(1, { title: "Stale overwrite" }), code("PT409"));
      await assert.rejects(save(null), code("PT409"));
      const refreshed = await save(2, { title: "Fresh next edit" });
      assert.equal(refreshed.lock_version, 3);
      await db.exec("reset role");
      assert.equal(await scalar("select title as result from zagulyaky_records where id=$1", [conflictRecord]), "Fresh next edit");
    });
    await t.test("unauthenticated, other-user, direct table writes and invalid workflow remain denied", async () => {
      await user(null);
      await assert.rejects(save(3), code("42501"));
      await user(conflictOther);
      await assert.rejects(save(3), code("P0002"));
      await user(conflictOwner);
      await db.exec("set role anon");
      await assert.rejects(save(3), code("42501"));
      await db.exec("set role authenticated");
      await assert.rejects(db.exec("update zagulyaky_records set title='bypass'"), code("42501"));
      await db.exec("reset role; update zagulyaky_records set status='pending_review'");
      await assert.rejects(save(4), code("55000"));
    });
    await t.test("every other versioned facade translates only its business conflict and rolls back", async () => {
      for (const name of versionedRpcNames.filter(n => n !== "update_my_zagulyaka_draft_v1")) {
        const types = await scalar<string[]>(`select array(select format_type(typ,null) from unnest(p.proargtypes) typ) as result
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name]);
        const params = types.map((type, i) => `$${i + 1}::${type}`).join(",");
        const values = types.map(type => type === "uuid" ? conflictRecord : type === "integer" || type === "bigint" ? 1 : type === "jsonb" ? [] : "fixture");
        const call = () => scalar(`select public.${name}(${params}) as result`, values);
        await db.exec("select set_config('test.failure_code','40001',false); select set_config('test.failure_message','',false)");
        await assert.rejects(call(), error => code("PT409")(error) && (error as Error).message === "ZAGULYAKA_VERSION_CONFLICT", name);
        assert.equal(await scalar("select count(*)::int as result from probe_writes"), 0, `${name} must roll back`);
        await db.exec("select set_config('test.failure_message','REAL_SERIALIZATION_FAILURE',false)");
        await assert.rejects(call(), code("40001"), `${name} must not reclassify real serialization errors`);
        await db.exec("select set_config('test.failure_code','23514',false)");
        await assert.rejects(call(), code("23514"), `${name} must preserve validation errors`);
        await db.exec("select set_config('test.failure_code','',false)");
        assert.deepEqual(await call(), values, `${name} must forward all parameters unchanged`);
        await db.exec("delete from probe_writes where true");
      }
    });
    await t.test("migration is repeatable without changing the function contracts", async () => {
      await db.exec(conflictMigration);
      assert.deepEqual(await scalar(aclSql, [versionedRpcNames]), before);
    });
    await t.test("a missing prerequisite aborts instead of creating an RPC with default PUBLIC access", async () => {
      await db.exec("drop function public.submit_zagulyaka_v1(uuid,integer)");
      await assert.rejects(db.exec(conflictMigration), code("42883"));
      await db.exec("rollback");
      assert.equal(await scalar("select to_regprocedure('public.submit_zagulyaka_v1(uuid,integer)') as result"), null);
    });
  } finally { await db.close(); }
});
