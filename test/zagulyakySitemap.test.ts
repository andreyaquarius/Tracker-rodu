import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  assertPublishableSupabaseKey,
  generateZagulyakySitemap,
  publicZagulyakaUrl,
  requestPublicZagulyakyRpc,
} from "../scripts/generate-zagulyaky-sitemap.mjs";

test("static sitemap exposes only the two public Zagulyaky catalogue URLs", () => {
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);

  assert.ok(urls.includes("https://trekerrodu.com.ua/zahuliaky/"));
  assert.ok(urls.includes("https://trekerrodu.com.ua/zahuliaky/documents/"));
  assert.equal(urls.includes("https://trekerrodu.com.ua/zahuliaky/my/"), false);
  assert.ok(urls.every((url) => new URL(url).pathname.endsWith("/")));
  assert.match(robots, /^Sitemap: https:\/\/trekerrodu\.com\.ua\/sitemap-zagulyaky\.xml$/m);
});

test("dynamic sitemap uses only public search RPCs, walks cursors, and emits only canonical URLs", async () => {
  const calls: Array<{ rpcName: string; parameters: Record<string, unknown> }> = [];
  const directory = mkdtempSync(join(tmpdir(), "zagulyaky-sitemap-"));
  const outputPath = join(directory, "sitemap-zagulyaky.xml");

  try {
    const result = await generateZagulyakySitemap({
      outputPath,
      requestRpc: async (rpcName: string, parameters: Record<string, unknown>) => {
        calls.push({ rpcName, parameters });
        if (rpcName === "search_zagulyaky_people_v1" && parameters.p_cursor_id === null) {
          return {
            items: [{ slug: "ivan-kalenskyi", title: "Private title must not leak", id: "private-id" }],
            nextCursor: { publishedAt: "2026-08-18T12:00:00Z", id: "cursor-person" },
          };
        }
        if (rpcName === "search_zagulyaky_people_v1") {
          return { items: [{ slug: "petro-koval" }], nextCursor: null };
        }
        if (rpcName === "search_zagulyaky_documents_v1") {
          return { items: [{ slug: "dako-127" }], nextCursor: null };
        }
        throw new Error(`Unexpected RPC: ${rpcName}`);
      },
    });

    assert.equal(result.count, 3);
    assert.deepEqual(calls.map((call) => call.rpcName), [
      "search_zagulyaky_people_v1",
      "search_zagulyaky_people_v1",
      "search_zagulyaky_documents_v1",
    ]);
    assert.deepEqual(calls[0]?.parameters, {
      p_query: null,
      p_filters: {},
      p_limit: 50,
      p_cursor_published_at: null,
      p_cursor_id: null,
    });
    assert.deepEqual(calls[1]?.parameters, {
      p_query: null,
      p_filters: {},
      p_limit: 50,
      p_cursor_published_at: "2026-08-18T12:00:00Z",
      p_cursor_id: "cursor-person",
    });

    const xml = readFileSync(outputPath, "utf8");
    assert.match(xml, /https:\/\/trekerrodu\.com\.ua\/zahuliaky\/people\/ivan-kalenskyi\//);
    assert.match(xml, /https:\/\/trekerrodu\.com\.ua\/zahuliaky\/people\/petro-koval\//);
    assert.match(xml, /https:\/\/trekerrodu\.com\.ua\/zahuliaky\/documents\/dako-127\//);
    assert.doesNotMatch(xml, /Private title must not leak|private-id/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detail URL construction encodes slug input and the generator refuses server keys", () => {
  assert.equal(
    publicZagulyakaUrl("document", "ДАКО 127"),
    "https://trekerrodu.com.ua/zahuliaky/documents/%D0%94%D0%90%D0%9A%D0%9E%20127/",
  );
  assert.equal(assertPublishableSupabaseKey("sb_publishable_fixture"), "sb_publishable_fixture");
  assert.throws(
    () => assertPublishableSupabaseKey("sb_secret_must-not-be-used"),
    /secret or service-role/i,
  );
  const serviceRoleJwt = `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.x`;
  assert.throws(
    () => assertPublishableSupabaseKey(serviceRoleJwt),
    /non-anon/i,
  );
});

test("build-time public requester permits the bounded indexing facade, not arbitrary detail RPCs", async () => {
  let requestedUrl = "";
  const payload = await requestPublicZagulyakyRpc({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "sb_publishable_fixture",
    rpcName: "list_public_zagulyaky_indexing_v1",
    parameters: { p_kind: "person", p_limit: 100, p_cursor_slug: null },
    fetchImpl: async (input: string | URL) => {
      requestedUrl = String(input);
      return { ok: true, json: async () => ({ items: [], nextCursor: null }) } as Response;
    },
  });

  assert.equal(requestedUrl, "https://example.supabase.co/rest/v1/rpc/list_public_zagulyaky_indexing_v1");
  assert.deepEqual(payload, { items: [], nextCursor: null });
  await assert.rejects(
    requestPublicZagulyakyRpc({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_fixture",
      rpcName: "get_public_zagulyaka_v1",
      parameters: { p_slug: "not-allowed-here" },
    }),
    /only approved public Zagulyaky RPCs/i,
  );
});

test("build-time public requester retries PGRST002 schema-cache failures with bounded backoff", async () => {
  const delays: number[] = [];
  const retryEvents: Array<{ attempt: number; maxAttempts: number; delayMs: number; reason: string }> = [];
  const requestBodies: string[] = [];
  let calls = 0;

  const payload = await requestPublicZagulyakyRpc({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "sb_publishable_fixture",
    rpcName: "list_public_zagulyaky_indexing_v1",
    parameters: { p_kind: "person", p_limit: 100, p_cursor_slug: null },
    fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      requestBodies.push(String(init?.body));
      if (calls < 3) {
        return new Response(JSON.stringify({
          code: "PGRST002",
          message: "Could not query the database for the schema cache. Retrying.",
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.json({ items: [], nextCursor: null });
    },
    retryOptions: {
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 1_000,
      random: () => 0.5,
      sleep: async (delayMs: number) => { delays.push(delayMs); },
      onRetry: (event: { attempt: number; maxAttempts: number; delayMs: number; reason: string }) => {
        retryEvents.push(event);
      },
    },
  });

  assert.deepEqual(payload, { items: [], nextCursor: null });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [200, 400]);
  assert.deepEqual(retryEvents.map(({ attempt, maxAttempts, delayMs }) => ({ attempt, maxAttempts, delayMs })), [
    { attempt: 1, maxAttempts: 3, delayMs: 200 },
    { attempt: 2, maxAttempts: 3, delayMs: 400 },
  ]);
  assert.match(retryEvents[0]?.reason ?? "", /HTTP 503.*PGRST002/i);
  assert.equal(new Set(requestBodies).size, 1, "Every safe retry must replay the same read-only RPC parameters.");
});

test("build-time public requester does not replay a deterministic database statement timeout", async () => {
  let calls = 0;
  await assert.rejects(
    requestPublicZagulyakyRpc({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_fixture",
      rpcName: "list_public_zagulyaky_indexing_v1",
      parameters: { p_kind: "person", p_limit: 100, p_cursor_slug: null },
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          code: "57014",
          message: "canceling statement due to statement timeout",
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      },
      retryOptions: {
        maxAttempts: 6,
        sleep: async () => { throw new Error("A deterministic SQL timeout must not be replayed."); },
      },
    }),
    /HTTP 500.*57014.*statement timeout/i,
  );
  assert.equal(calls, 1);
});

test("build-time public requester does not retry permanent responses and preserves diagnostics", async () => {
  let calls = 0;
  await assert.rejects(
    requestPublicZagulyakyRpc({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_fixture",
      rpcName: "search_zagulyaky_people_v1",
      parameters: { p_query: null, p_filters: {}, p_limit: 50 },
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ code: "PGRST301", message: "Invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
      retryOptions: {
        sleep: async () => { throw new Error("Permanent responses must not sleep or retry."); },
      },
    }),
    /HTTP 401.*PGRST301.*Invalid JWT/i,
  );
  assert.equal(calls, 1);
});

test("build-time public requester retries network failures but stops at the attempt cap", async () => {
  const recoveryDelays: number[] = [];
  let recoveryCalls = 0;
  const recovered = await requestPublicZagulyakyRpc({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "sb_publishable_fixture",
    rpcName: "search_zagulyaky_documents_v1",
    parameters: { p_query: null, p_filters: {}, p_limit: 50 },
    fetchImpl: async () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) throw new TypeError("temporary connection reset");
      return Response.json({ items: [], nextCursor: null });
    },
    retryOptions: {
      maxAttempts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      random: () => 0.5,
      sleep: async (delayMs: number) => { recoveryDelays.push(delayMs); },
    },
  });
  assert.deepEqual(recovered, { items: [], nextCursor: null });
  assert.equal(recoveryCalls, 2);
  assert.deepEqual(recoveryDelays, [50]);

  let unavailableCalls = 0;
  await assert.rejects(
    requestPublicZagulyakyRpc({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_fixture",
      rpcName: "search_zagulyaky_documents_v1",
      parameters: { p_query: null, p_filters: {}, p_limit: 50 },
      fetchImpl: async () => {
        unavailableCalls += 1;
        return new Response(JSON.stringify({ code: "PGRST002", message: "Schema cache unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      },
      retryOptions: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        sleep: async () => undefined,
      },
    }),
    /HTTP 503 after 3 attempts.*PGRST002/i,
  );
  assert.equal(unavailableCalls, 3);
});
