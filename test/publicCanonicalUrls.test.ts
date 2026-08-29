import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const origin = "https://trekerrodu.com.ua";

test("static public pages use their final trailing-slash URL for canonical and Open Graph metadata", () => {
  for (const route of ["features", "pricing", "faq", "privacy", "terms"]) {
    const html = readFileSync(resolve(root, "public", route, "index.html"), "utf8");
    const url = `${origin}/${route}/`;

    assert.match(html, new RegExp(`<link rel="canonical" href="${url}" \\/>`));
    assert.match(html, new RegExp(`<meta property="og:url" content="${url}" \\/>`));
  }
});

test("every public sitemap location is already a final trailing-slash URL", () => {
  const sitemap = readFileSync(resolve(root, "public", "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);

  assert.ok(urls.length > 0);
  for (const value of urls) {
    const url = new URL(value);
    assert.equal(url.origin, origin);
    assert.ok(url.pathname.endsWith("/"), `Expected a final trailing slash in ${value}`);
  }
});

test("client-side public SEO emits the same trailing-slash canonical URLs", () => {
  const app = readFileSync(resolve(root, "src", "App.tsx"), "utf8");

  for (const route of ["features", "pricing", "faq", "privacy", "terms"]) {
    assert.ok(app.includes('canonical: `${SITE_ORIGIN}/' + route + '/`'));
  }
  assert.ok(app.includes('const canonical = `${SITE_ORIGIN}${canonicalPath}/`;'));
});
