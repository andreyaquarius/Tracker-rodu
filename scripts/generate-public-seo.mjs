import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_SEO,
  genealogyHandbook,
  publicSeoRegistry,
  researchGuides,
} from "../src/utils/publicSeoContent.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://trekerrodu.com.ua";
const modified = "2026-09-16"; // Change only when public content changes, never on each build.
const sitemapNamespace = "http://www.sitemaps.org/schemas/sitemap/0.9";
const logoUrl = `${origin}/tracker-rodu-logo.png`;
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const read = (path) => readFileSync(resolve(root, path), "utf8").replaceAll("\r\n", "\n");
const guideLinks = researchGuides.map((guide) => `<a href="/${guide.slug}/">${escape(guide.heading)}</a>`).join("\n          ");
const cards = researchGuides.map((guide) => `<article><h3><a href="/${guide.slug}/">${escape(guide.heading)}</a></h3><p>${escape(guide.summary)}</p></article>`).join("\n          ");

function meta(html, key, value) {
  const pattern = new RegExp(`(<meta\\b(?=[^>]*(?:name|property)="${key}")[^>]*content=")[^"]*(")`, "i");
  if (!pattern.test(html)) throw new Error(`Missing meta ${key}`);
  return html.replace(pattern, (_, before, after) => `${before}${escape(value)}${after}`);
}

function replaceTitle(html, title) {
  if (!/<title>[\s\S]*?<\/title>/i.test(html)) throw new Error("Missing page title");
  return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escape(title)}</title>`);
}

function upsertMeta(html, attribute, key, value) {
  const pattern = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}="${key}")[^>]*>`, "i");
  const replacement = `<meta ${attribute}="${escape(key)}" content="${escape(value)}" />`;
  if (pattern.test(html)) return html.replace(pattern, replacement);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `    ${replacement}\n  </head>`);
  return `${html}\n    ${replacement}`;
}

function upsertLanguageLink(html, href) {
  const pattern = /<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhreflang="uk-UA")[^>]*>/i;
  const replacement = `<link rel="alternate" hreflang="uk-UA" href="${escape(href)}" />`;
  if (pattern.test(html)) return html.replace(pattern, replacement);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `    ${replacement}\n  </head>`);
  return `${html}\n    ${replacement}`;
}

function upsertPublicSocialMetadata(html, { title, description, url, type = "website" }) {
  let next = html;
  next = upsertMeta(next, "name", "description", description);
  next = upsertMeta(next, "name", "robots", "index, follow");
  next = upsertMeta(next, "property", "og:title", title);
  next = upsertMeta(next, "property", "og:description", description);
  next = upsertMeta(next, "property", "og:type", type);
  next = upsertMeta(next, "property", "og:url", url);
  next = upsertMeta(next, "property", "og:site_name", "Трекер Роду");
  next = upsertMeta(next, "property", "og:locale", "uk_UA");
  next = upsertMeta(next, "property", "og:image", logoUrl);
  next = upsertMeta(next, "property", "og:image:alt", "Трекер Роду");
  next = upsertMeta(next, "name", "twitter:card", "summary");
  next = upsertMeta(next, "name", "twitter:title", title);
  next = upsertMeta(next, "name", "twitter:description", description);
  next = upsertMeta(next, "name", "twitter:image", logoUrl);
  next = upsertMeta(next, "name", "twitter:image:alt", "Трекер Роду");
  next = upsertLanguageLink(next, url);
  return next;
}

function normalizePublicInternalLinks(html) {
  return [
    "features",
    "pricing",
    "faq",
    "privacy",
    "terms",
    "zahuliaky",
    "zahuliaky/documents",
    "zahuliaky/places",
  ].reduce(
    (next, path) => next.replace(new RegExp(`href="/${path}"(?=[\\s>])`, "g"), `href="/${path}/"`),
    html,
  );
}

function renderUrlset(entries) {
  const urls = entries.map(({ url, lastmod }) => `  <url>\n    <loc>${escape(url)}</loc>${lastmod ? `\n    <lastmod>${escape(lastmod)}</lastmod>` : ""}\n  </url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${sitemapNamespace}">`,
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

function renderSitemapIndex(entries) {
  const maps = entries.map(({ url, lastmod }) => `  <sitemap>\n    <loc>${escape(url)}</loc>${lastmod ? `\n    <lastmod>${escape(lastmod)}</lastmod>` : ""}\n  </sitemap>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sitemapindex xmlns="${sitemapNamespace}">`,
    ...maps,
    "</sitemapindex>",
    "",
  ].join("\n");
}

function publicPageJsonLd(record) {
  const url = `${origin}${record.path}`;
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url,
        url,
        name: record.h1,
        description: record.description,
        inLanguage: "uk",
        isPartOf: { "@id": `${origin}/#website` },
        breadcrumb: { "@id": `${url}#breadcrumb` },
        keywords: [record.primaryQuery, ...record.secondaryQueries],
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Головна", item: `${origin}/` },
          { "@type": "ListItem", position: 2, name: record.h1, item: url },
        ],
      },
    ],
  }).replaceAll("<", "\\u003c");
}

export function appendPublicPageJsonLd(html, jsonLd) {
  const scriptPattern = /\s*<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>\s*/gi;
  const scriptCount = [...html.matchAll(scriptPattern)].length;
  if (scriptCount > 1) throw new Error("Public page contains multiple JSON-LD scripts.");
  if (!/<\/head>/i.test(html)) throw new Error("Public page is missing the head closing tag.");
  const safeJsonLd = jsonLd.replaceAll("<", "\\u003c");
  const replacement = `\n    <script type="application/ld+json">${safeJsonLd}</script>\n  `;
  // Replace the block in place: deleting it can join surrounding fragments
  // into a new HTML tag. This edits repository templates, not untrusted HTML.
  // Callbacks also keep JSON values such as $& literal during replacement.
  const next = scriptCount === 1
    ? html.replace(scriptPattern, () => replacement)
    : html.replace(/<\/head>/i, () => `${replacement}</head>`);
  const cspPattern = /<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*>/i;
  const cspMeta = next.match(cspPattern)?.[0];
  if (!cspMeta) throw new Error("Public page is missing the Content-Security-Policy meta tag.");
  const contentMatch = cspMeta.match(/\bcontent=(['"])([\s\S]*?)\1/i);
  if (!contentMatch) throw new Error("Public page CSP meta tag is missing its content attribute.");
  const scriptSrcPattern = /\bscript-src(?=\s|$)[^;]*/i;
  const scriptSrc = contentMatch[2].match(scriptSrcPattern)?.[0];
  if (!scriptSrc) throw new Error("Public page CSP is missing the script-src directive.");
  const tokens = scriptSrc.trim().split(/\s+/).filter((token) => !/^'sha256-[^']+'$/.test(token));
  tokens.push(`'sha256-${createHash("sha256").update(safeJsonLd).digest("base64")}'`);
  const nextContent = contentMatch[2].replace(scriptSrcPattern, tokens.join(" "));
  const nextCspMeta = cspMeta.replace(contentMatch[0], `content=${contentMatch[1]}${nextContent}${contentMatch[1]}`);
  return next.replace(cspPattern, () => nextCspMeta);
}

const registryByPath = new Map(publicSeoRegistry.map((record) => [record.path, record]));
if (registryByPath.size !== publicSeoRegistry.length) {
  throw new Error("SEO registry contains duplicate public paths.");
}
for (const record of publicSeoRegistry) {
  if (!/^\/(?:[^/]+\/)*$/.test(record.path)) {
    throw new Error(`SEO registry path is not normalized: ${record.path}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.publishedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(record.contentUpdatedAt)) {
    throw new Error(`SEO registry dates are invalid for ${record.path}.`);
  }
  for (const relatedPath of record.relatedPaths) {
    if (!registryByPath.has(relatedPath)) throw new Error(`SEO registry link ${relatedPath} is missing for ${record.path}.`);
  }
}

function registrySitemapEntry(path) {
  const record = registryByPath.get(path);
  if (!record || record.publicationStatus !== "published" || !record.indexable) {
    throw new Error(`Sitemap path ${path} has no published, indexable SEO registry record.`);
  }
  if (!/^\/(?:[^/]+\/)*$/.test(path)) throw new Error(`SEO registry path is not normalized: ${path}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.contentUpdatedAt)) {
    throw new Error(`SEO registry date is invalid for ${path}: ${record.contentUpdatedAt}`);
  }
  return { url: `${origin}${path}`, lastmod: record.contentUpdatedAt };
}

const pageSitemapEntries = [
  "/",
  "/features/",
  "/pricing/",
  "/faq/",
  "/zahuliaky/",
  "/zahuliaky/documents/",
  "/zahuliaky/places/",
  "/privacy/",
  "/terms/",
].map(registrySitemapEntry);

const guideSitemapEntries = researchGuides.map((guide) => registrySitemapEntry(`/${guide.slug}/`));

const zagulyakyCatalogueSitemapEntries = [
  "/zahuliaky/",
  "/zahuliaky/documents/",
  "/zahuliaky/places/",
].map(registrySitemapEntry);

function homepage() {
  let html = read("index.html").replace(/<title>.*?<\/title>/, `<title>${escape(HOME_SEO.title)}</title>`);
  for (const key of ["description", "og:description", "twitter:description"]) html = meta(html, key, HOME_SEO.description);
  for (const key of ["og:title", "twitter:title"]) html = meta(html, key, HOME_SEO.title);
  html = upsertPublicSocialMetadata(html, {
    title: HOME_SEO.title,
    description: HOME_SEO.description,
    url: HOME_SEO.canonical,
  });
  html = html.replace(/<h1>.*?<\/h1>/, `<h1>${escape(HOME_SEO.heading)}</h1>`)
    .replace(/(<h1>.*?<\/h1>\s*)<p>.*?<\/p>/, `$1<p>${escape(HOME_SEO.intro)}</p>`);
  if (!html.includes('href="/zahuliaky/"')) {
    html = html.replace('<a href="/features">Можливості</a>', '<a href="/zahuliaky/">Загуляки</a>\n              <a href="/features">Можливості</a>');
  }
  if (!html.includes('href="/faq/"')) {
    html = html.replace('<a href="/pricing">Тарифи</a>', '<a href="/pricing">Тарифи</a>\n              <a href="/faq/">FAQ</a>');
  }
  if (!html.includes('href="/posibnyk-z-henealohii/">Посібник</a>')) {
    html = html.replace('<a href="/faq/">FAQ</a>', '<a href="/faq/">FAQ</a>\n              <a href="/posibnyk-z-henealohii/">Посібник</a>');
  }
  const section = `<!-- research-topics:start -->
        <section class="home-research" aria-labelledby="home-research-heading">
          <span class="eyebrow">Практичні матеріали</span>
          <h2 id="home-research-heading">Із чого почати дослідження родоводу</h2>
          <p>Практичні кроки для тих, хто хоче дізнатися історію своєї сім’ї та зберегти її для наступних поколінь.</p>
          <div class="home-research-grid">${cards}</div>
          <p>Шукаєте згадки про родичів у чужих дослідженнях? Перегляньте <a href="/zahuliaky/">публічний генеалогічний каталог «Загуляки»</a> та <a href="/zahuliaky/documents/">каталог документів</a>.</p>
        </section>
        <!-- research-topics:end -->`;
  html = html.includes("<!-- research-topics:start -->")
    ? html.replace(/<!-- research-topics:start -->[\s\S]*?<!-- research-topics:end -->/, section)
    : html.replace("</main>", `${section}\n      </main>`);
  return normalizePublicInternalLinks(html);
}

function guidePage(guide) {
  const url = `${origin}/${guide.slug}/`;
  const isHandbook = guide.slug === genealogyHandbook.slug;
  const seoRecord = publicSeoRegistry.find((record) => record.path === `/${guide.slug}/`);
  if (!seoRecord || seoRecord.publicationStatus !== "published" || !seoRecord.indexable) {
    throw new Error(`Missing published SEO registry record for ${guide.slug}.`);
  }
  const handbookSchema = { "@type": "CreativeWork", name: genealogyHandbook.title, url: genealogyHandbook.url, inLanguage: "uk", author: { "@type": "Person", name: genealogyHandbook.author } };
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", "@id": url, url, name: guide.heading, description: guide.description, inLanguage: "uk", isPartOf: { "@id": `${origin}/#website` }, breadcrumb: { "@id": `${url}#breadcrumb` }, mainEntity: { "@id": `${url}#article` }, ...(isHandbook ? { about: handbookSchema } : {}) },
      { "@type": "Article", "@id": `${url}#article`, headline: guide.title, description: guide.description, url, inLanguage: "uk", datePublished: seoRecord.publishedAt, dateModified: seoRecord.contentUpdatedAt, author: { "@type": "Person", name: seoRecord.author }, mainEntityOfPage: { "@id": url }, keywords: [seoRecord.primaryQuery, ...seoRecord.secondaryQueries] },
      { "@type": "BreadcrumbList", "@id": `${url}#breadcrumb`, itemListElement: [
        { "@type": "ListItem", position: 1, name: "Головна", item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: guide.heading, item: url },
      ] },
    ],
  }).replaceAll("<", "\\u003c");
  const hash = createHash("sha256").update(jsonLd).digest("base64");
  const templateHead = read("public/features/index.html").match(/<head>([\s\S]*?)<style>/)?.[1];
  if (!templateHead) throw new Error("Missing public page head template");
  let head = templateHead.replace(/<title>.*?<\/title>/, `<title>${escape(guide.title)}</title>`)
    .replace(/rel="canonical" href="[^"]*"/, `rel="canonical" href="${url}"`)
    .replace(/(script-src\s+)([^;]*)/i, (_, prefix, sources) => {
      const withoutHashes = sources.split(/\s+/).filter((token) => !/^'sha256-[^']+'$/.test(token));
      withoutHashes.splice(Math.min(1, withoutHashes.length), 0, `'sha256-${hash}'`);
      return `${prefix}${withoutHashes.join(" ")}`;
    });
  for (const key of ["description", "og:description", "twitter:description"]) head = meta(head, key, guide.description);
  for (const key of ["og:title", "twitter:title"]) head = meta(head, key, guide.title);
  head = meta(head, "og:url", url);
  head = upsertPublicSocialMetadata(head, {
    title: guide.title,
    description: guide.description,
    url,
    type: "article",
  });
  const sections = guide.sections.map((section, i) => `<section id="step-${i + 1}"><h2>${escape(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("\n")}</section>`).join("\n");
  return `<!doctype html>
<!-- Generated by scripts/generate-public-seo.mjs; edit src/utils/publicSeoContent.ts. -->
<html lang="uk"><head>${head}
    <link rel="stylesheet" href="/research-guides.css" />
    <script type="application/ld+json">${jsonLd}</script>
  </head><body>
    <a class="skip-link" href="#content">До змісту</a>
    <header class="site-header"><a class="brand" href="/">Трекер Роду</a><nav aria-label="Публічна навігація"><a href="/features/">Можливості</a><a href="/zahuliaky/">Загуляки</a><a href="/faq/">FAQ</a><a href="/">Увійти</a></nav></header>
    <main id="content">
      <nav class="breadcrumbs" aria-label="Навігаційний ланцюжок"><a href="/">Головна</a><span aria-hidden="true"> / </span><span aria-current="page">${escape(guide.heading)}</span></nav>
      <article><header class="hero"><span class="eyebrow">Досліджуйте історію сім’ї</span><h1>${escape(guide.heading)}</h1><p>${escape(guide.intro)}</p>${isHandbook ? `<div class="handbook-source"><p>Автор посібника: <strong>${escape(genealogyHandbook.author)}</strong><br />Проєкт: «${escape(genealogyHandbook.project)}»</p><a class="cta" href="${genealogyHandbook.url}" target="_blank" rel="noopener noreferrer">Відкрити повний посібник (PDF, нова вкладка)</a></div>` : ""}</header>
      <ul class="topic-tags" aria-label="Теми матеріалу">${seoRecord.editorialTags.map((tag) => `<li>${escape(tag)}</li>`).join("")}</ul>
      <nav class="contents" aria-label="Зміст статті">${guide.sections.map((section, i) => `<a href="#step-${i + 1}">${escape(section.heading)}</a>`).join("\n")}</nav>
      ${sections}
      </article>
      <aside class="next-step"><h2>Продовжіть дослідження у Трекері Роду</h2><p>Особи, родове дерево, документи, знахідки та гіпотези — в одному робочому просторі. <a href="/pricing/">Переглянути тарифи й ліміти</a>.</p><a class="cta" href="/">${escape(guide.cta)}</a></aside>
      <section class="related"><h2>Корисні матеріали та джерела</h2><nav aria-label="Дослідження родоводу">${guideLinks}<a href="/zahuliaky/">Пошук у каталозі «Загуляки»</a><a href="/zahuliaky/documents/">Публічний каталог документів</a></nav><p><a href="${genealogyHandbook.url}">Повна методичка Андрія Каленського (PDF)</a></p></section>
    </main>
    <footer><a href="/">Трекер Роду</a><a href="/privacy/">Політика конфіденційності</a><a href="/terms/">Умови користування</a></footer>
    <script type="module" src="/site-analytics.js" data-analytics-mode="auto-public"></script>
  </body></html>
`;
}

export function publicSeoOutputs() {
  const outputs = new Map([["index.html", homepage()]]);
  outputs.set("src/utils/publicResearchLinks.ts", `// Generated by scripts/generate-public-seo.mjs. Keep article bodies out of the app bundle.\nexport const publicResearchLinks = ${JSON.stringify(researchGuides.map(({ slug, heading, summary }) => ({ slug, heading, summary })), null, 2)};\n`);
  for (const guide of researchGuides) outputs.set(`public/${guide.slug}/index.html`, guidePage(guide));
  for (const page of ["features", "pricing", "faq", "privacy", "terms"]) {
    let html = read(`public/${page}/index.html`);
    const pageUrl = `${origin}/${page}/`;
    const seoRecord = registryByPath.get(pageUrl.replace(origin, ""));
    if (!seoRecord || seoRecord.publicationStatus !== "published" || !seoRecord.indexable) {
      throw new Error(`Missing published SEO registry record for ${pageUrl}.`);
    }
    html = replaceTitle(html, seoRecord.title);
    if (["features", "pricing", "faq"].includes(page)) {
      const links = `<!-- research-links:start -->\n          ${guideLinks}\n        <!-- research-links:end -->`;
      html = html.includes("<!-- research-links:start -->")
        ? html.replace(/<!-- research-links:start -->[\s\S]*?<!-- research-links:end -->/, links)
        : html.replace("</footer>", `${links}\n      </footer>`);
    }
    html = upsertPublicSocialMetadata(html, {
      title: seoRecord.title,
      description: seoRecord.description,
      url: pageUrl,
    });
    html = appendPublicPageJsonLd(html, publicPageJsonLd(seoRecord));
    outputs.set(`public/${page}/index.html`, normalizePublicInternalLinks(html));
  }
  outputs.set("public/sitemap-pages.xml", renderUrlset(pageSitemapEntries));
  outputs.set("public/sitemap-guides.xml", renderUrlset(guideSitemapEntries));
  outputs.set("public/sitemap-zagulyaky.xml", renderUrlset(zagulyakyCatalogueSitemapEntries));
  outputs.set("public/sitemap.xml", renderSitemapIndex([
    { url: `${origin}/sitemap-pages.xml`, lastmod: modified },
    { url: `${origin}/sitemap-guides.xml`, lastmod: modified },
    { url: `${origin}/sitemap-zagulyaky.xml`, lastmod: "2026-08-25" },
  ]));
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [path, contents] of publicSeoOutputs()) {
    if (check) {
      try { if (read(path) !== contents) stale.push(path); } catch { stale.push(path); }
    } else {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), contents, "utf8");
    }
  }
  if (stale.length) throw new Error(`Public SEO output is stale. Run npm run generate:seo: ${stale.join(", ")}`);
  console.log(check ? "Public SEO content is in sync." : "Generated public SEO pages, homepage content and sitemap.");
}
