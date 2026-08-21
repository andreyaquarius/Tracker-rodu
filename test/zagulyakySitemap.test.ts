import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  assertPublishableSupabaseKey,
  generateZagulyakySitemap,
  publicZagulyakaUrl,
} from "../scripts/generate-zagulyaky-sitemap.mjs";

test("static sitemap exposes only the two public Zagulyaky catalogue URLs", () => {
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);

  assert.ok(urls.includes("https://trekerrodu.com.ua/zahuliaky"));
  assert.ok(urls.includes("https://trekerrodu.com.ua/zahuliaky/documents"));
  assert.equal(urls.includes("https://trekerrodu.com.ua/zahuliaky/my"), false);
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
    assert.match(xml, /https:\/\/trekerrodu\.com\.ua\/zahuliaky\/people\/ivan-kalenskyi/);
    assert.match(xml, /https:\/\/trekerrodu\.com\.ua\/zahuliaky\/people\/petro-koval/);
    assert.match(xml, /https:\/\/trekerrodu\.com\.ua\/zahuliaky\/documents\/dako-127/);
    assert.doesNotMatch(xml, /Private title must not leak|private-id/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detail URL construction encodes slug input and the generator refuses server keys", () => {
  assert.equal(
    publicZagulyakaUrl("document", "ДАКО 127"),
    "https://trekerrodu.com.ua/zahuliaky/documents/%D0%94%D0%90%D0%9A%D0%9E%20127",
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
