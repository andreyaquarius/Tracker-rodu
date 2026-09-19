// Explicit local-only rehearsal. Creates and removes one synthetic database
// and one loopback-only PostgREST container; never resets an existing database.
// Usage: node scripts/verify-zagulyaky-conflict-local.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  conflictFixtureSql, conflictMigration, conflictOwner, conflictOther, conflictRecord,
} from "../test/helpers/zagulyakyConflictFixture.ts";

const dbContainer = "supabase_db_ppiymmsurabwxnzpdasl";
const restTemplate = "supabase_rest_ppiymmsurabwxnzpdasl";
const suffix = randomBytes(6).toString("hex");
const database = `zagulyaky_conflict_${suffix}`;
const restContainer = `tracker-zagulyaky-conflict-${suffix}`;
const jwtSecret = randomBytes(32).toString("hex");
let password = "";
let databaseCreated = false;
let containerCreated = false;

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 4_000_000 });
  if (result.status !== 0) {
    const safe = (result.stderr || result.error?.message || "Docker command failed")
      .replaceAll(jwtSecret, "[redacted]");
    throw new Error(password ? safe.replaceAll(password, "[redacted]") : safe);
  }
  return result.stdout.trim();
}
const sql = (input: string) => docker(["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", database, "-XAt", "-v", "ON_ERROR_STOP=1"], input);
const calls = () => Number(sql("select case when is_called then last_value else 0 end from test_calls;"));
const token = (sub: string) => {
  const enc = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ role: "authenticated", sub, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${data}.${createHmac("sha256", jwtSecret).update(data).digest("base64url")}`;
};
let base = "";
async function ready() {
  const port = docker(["port", restContainer, "3000/tcp"]);
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  base = `http://${port}`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Local synthetic PostgREST did not start");
}
async function save(version: number, title: string, user: string | null = conflictOwner, timeout = 3_000) {
  const response = await fetch(`${base}/rpc/update_my_zagulyaka_draft_v1`, {
    method: "POST", signal: AbortSignal.timeout(timeout),
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
    body: JSON.stringify({ p_record_id: conflictRecord, p_expected_lock_version: version, p_patch: { title } }),
  });
  return { status: response.status, body: await response.json() };
}
try {
  const dbInfo = JSON.parse(docker(["inspect", dbContainer]))[0];
  const image = docker(["inspect", "--format", "{{.Config.Image}}", restTemplate]);
  const network = Object.keys(dbInfo.NetworkSettings.Networks)[0];
  assert.ok(network && dbInfo.State.Running, "Local database must be running");
  password = (dbInfo.Config.Env as string[]).find(value => value.startsWith("POSTGRES_PASSWORD="))?.slice("POSTGRES_PASSWORD=".length) ?? "";
  assert.ok(password, "Local database password must be present in its container configuration");
  docker(["exec", dbContainer, "createdb", "-U", "postgres", "--template=template0", database]);
  databaseCreated = true;
  sql(conflictFixtureSql());
  docker(["run", "--detach", "--pull=never", "--name", restContainer, "--network", network,
    "--publish", "127.0.0.1::3000", "--memory", "256m", "--cpus", "1",
    "--env", `PGRST_DB_URI=postgresql://postgres:${encodeURIComponent(password)}@${dbContainer}:5432/${database}`,
    "--env", "PGRST_DB_SCHEMAS=public", "--env", "PGRST_DB_ANON_ROLE=anon",
    "--env", `PGRST_JWT_SECRET=${jwtSecret}`, "--env", "PGRST_LOG_LEVEL=crit", image]);
  containerCreated = true;
  await ready();
  assert.equal((await save(1, "First committed edit")).body.lock_version, 2);
  const before = calls();
  let legacyStatus: number | string;
  try { legacyStatus = (await save(1, "Stale edit", conflictOwner, 750)).status; }
  catch (error) {
    if (!(error instanceof Error) || !/TimeoutError|AbortError/.test(error.name)) throw error;
    legacyStatus = "client timeout (750ms)";
  }
  // Bound the legacy retry reproduction; stop only the temporary API instance.
  docker(["stop", "--time", "1", restContainer]);
  const legacyCalls = calls() - before;
  console.log(JSON.stringify({ phase: "before", image, response: legacyStatus, sqlInvocations: legacyCalls }));

  sql(conflictMigration);
  docker(["start", restContainer]);
  await ready();
  const after = calls();
  const start = performance.now();
  const stale = await save(1, "Must not overwrite");
  const elapsedMs = Math.round(performance.now() - start);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "PT409");
  assert.equal(stale.body.message, "ZAGULYAKA_VERSION_CONFLICT");
  assert.equal(calls() - after, 1);
  assert.equal(sql(`select title from zagulyaky_records where id='${conflictRecord}';`), "First committed edit");
  assert.equal((await save(2, "Fresh edit")).body.lock_version, 3);
  const concurrent = await Promise.all([save(3, "Concurrent A"), save(3, "Concurrent B")]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  assert.equal(sql(`select lock_version from zagulyaky_records where id='${conflictRecord}';`), "4");
  assert.equal((await save(4, "Other owner", conflictOther)).body.code, "P0002");
  assert.equal((await save(4, "Anonymous", null)).status, 401);
  console.log(JSON.stringify({ phase: "after", status: stale.status, code: stale.body.code, sqlInvocations: 1, elapsedMs,
    checks: "fresh save, stale rejection, simultaneous edits, ownership, anonymous denial passed" }));
} finally {
  // These targets were created by this invocation, not pre-existing resources.
  assert.match(database, /^zagulyaky_conflict_[0-9a-f]{12}$/);
  assert.match(restContainer, /^tracker-zagulyaky-conflict-[0-9a-f]{12}$/);
  if (containerCreated) docker(["rm", "--force", restContainer]);
  if (databaseCreated) docker(["exec", dbContainer, "dropdb", "-U", "postgres", "--force", database]);
  if (containerCreated || databaseCreated) console.log("Removed only this run's temporary API container and synthetic database.");
}
