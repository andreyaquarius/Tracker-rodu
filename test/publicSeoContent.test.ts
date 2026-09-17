import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HOME_SEO, genealogyHandbook, publicSeoRegistry, researchGuides } from "../src/utils/publicSeoContent.ts";
import { renderZagulyakySeoPage } from "../scripts/generate-zagulyaky-public-pages.mjs";
import { publicAnalyticsContext } from "../public/site-analytics.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const home = read("index.html");

test("homepage exposes keyword content and guide links in initial HTML with one React replacement boundary", () => {
  assert.ok(home.includes(`<title>${HOME_SEO.title}</title>`));
  assert.ok(home.includes(`<h1>${HOME_SEO.heading}</h1>`));
  assert.equal((home.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.match(home, /<div id="root"><!-- public-home:start -->[\s\S]*<main[\s\S]*<!-- public-home:end --><\/div>/);
  assert.doesNotMatch(home, /<noscript>[\s\S]*<h1>/);
  for (const guide of researchGuides) assert.ok(home.includes(`href="/${guide.slug}/"`));
});

test("every research page is indexable without JavaScript, has matching metadata, and is in sitemap once", () => {
  const sitemap = read("public/sitemap-guides.xml");
  const titles = new Set();
  for (const guide of researchGuides) {
    const html = read(`public/${guide.slug}/index.html`);
    const url = `https://trekerrodu.com.ua/${guide.slug}/`;
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, guide.slug);
    assert.ok(html.includes(`<h1>${guide.heading}</h1>`));
    assert.ok(html.includes(`<title>${guide.title}</title>`));
    assert.ok(html.includes(`rel="canonical" href="${url}"`));
    assert.ok(html.includes(`property="og:url" content="${url}"`));
    assert.ok(html.includes('property="og:type" content="article"'));
    assert.ok(html.includes('name="twitter:image:alt" content="Трекер Роду"'));
    assert.doesNotMatch(html, /<meta\s+name="keywords"/i);
    const registry = publicSeoRegistry.find((record) => record.path === `/${guide.slug}/`);
    assert.ok(registry);
    for (const tag of registry.editorialTags) assert.ok(html.includes(`<li>${tag}</li>`));
    assert.ok(html.includes('name="robots" content="index, follow"'));
    assert.doesNotMatch(html, /<noscript>|src="\/src\/main|noindex/);
    assert.equal(sitemap.split(`<loc>${url}</loc>`).length - 1, 1);
    assert.ok(publicAnalyticsContext(`/${guide.slug}/?private-search=discard#discard`));
    assert.equal(publicAnalyticsContext(`/${guide.slug}/?private-search=discard#discard`)?.pageLocation, url.slice(0, -1));
    const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(jsonLd);
    const schema = JSON.parse(jsonLd);
    assert.equal(schema["@graph"][0].url, url);
    assert.ok(html.includes(`'sha256-${createHash("sha256").update(jsonLd).digest("base64")}'`));
    assert.equal(schema["@graph"][1]["@type"], "Article");
    assert.equal(schema["@graph"][1].mainEntityOfPage["@id"], url);
    assert.equal(schema["@graph"][2].itemListElement[1].item, url);
    titles.add(guide.title);
  }
  assert.equal(titles.size, researchGuides.length);
  assert.equal(publicAnalyticsContext("/projects/private-id"), null);
});

test("SEO registry keeps one intent, keyword cluster, editorial tags and publication state per indexed page", () => {
  assert.equal(publicSeoRegistry.length, 13);
  for (const record of publicSeoRegistry) {
    assert.match(record.path, /^\/(?:[^/]+\/)*$/);
    assert.ok(record.title.length >= 20);
    assert.ok(record.description.length >= 80);
    assert.ok(record.primaryQuery.length > 0);
    assert.ok(record.secondaryQueries.length >= 2);
    assert.ok(record.editorialTags.length >= 2);
    assert.match(record.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(record.contentUpdatedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(record.publicationStatus, "published");
    assert.equal(record.indexable, true);
  }
});

test("handbook page attributes the source and offers the exact public PDF with safe new-tab access", () => {
  const html = read(`public/${genealogyHandbook.slug}/index.html`);
  assert.ok(html.includes(genealogyHandbook.author));
  assert.ok(html.includes(`href="${genealogyHandbook.url}" target="_blank" rel="noopener noreferrer"`));
  assert.match(html, /стислий виклад/);
  assert.match(html, /Оформлення і збереження результатів/);
  assert.match(html, /"author":\{"@type":"Person","name":"Андрій Каленський"\}/);
});

test("catalogue generation removes the entire new homepage fallback and authorizes only the catalogue schema", () => {
  const homepageJson = JSON.stringify({ "@type": "WebSite" });
  const hash = createHash("sha256").update(homepageJson).digest("base64");
  const template = home.replace("</head>", `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-${hash}'"><script type="application/ld+json">${homepageJson}</script></head>`);
  const page = {
    title: "Тестовий каталог", heading: "Каталог", description: "Опубліковані записи", url: "https://trekerrodu.com.ua/zahuliaky/",
    kind: "catalogue", collectionUrl: "https://trekerrodu.com.ua/zahuliaky/", collectionTitle: "Каталог", eyebrow: "Каталог",
    structuredData: { "@type": "CollectionPage" }, facts: [], links: [], cards: [],
  };
  const html = renderZagulyakySeoPage(template, page);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.doesNotMatch(html, /public-home:start|home-research|Посібник для самостійного/);
  assert.ok(!html.includes(HOME_SEO.heading));
  assert.ok(!html.includes(`'sha256-${hash}'`));
});
