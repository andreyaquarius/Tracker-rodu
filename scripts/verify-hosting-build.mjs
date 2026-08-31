import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_PAGES = [
  {
    path: "index.html",
    url: "https://trekerrodu.com.ua/",
    title: "Трекер Роду — Не губи сліди свого роду",
    text: "Не губи сліди свого роду",
  },
  {
    path: "features/index.html",
    url: "https://trekerrodu.com.ua/features/",
    title: "Можливості Трекера Роду — інструменти генеалогічного дослідження",
    text: "Інструменти для генеалогічного дослідження",
  },
  {
    path: "pricing/index.html",
    url: "https://trekerrodu.com.ua/pricing/",
    title: "Тарифи Трекера Роду — Старт, Дослідник і Професійний",
    text: "Тарифи Трекера Роду",
  },
  {
    path: "faq/index.html",
    url: "https://trekerrodu.com.ua/faq/",
    title: "Часті запитання про Трекер Роду",
    text: "Часті запитання про Трекер Роду",
  },
  {
    path: "privacy/index.html",
    url: "https://trekerrodu.com.ua/privacy/",
    title: "Політика конфіденційності — Трекер Роду",
    text: "Політика конфіденційності",
  },
  {
    path: "terms/index.html",
    url: "https://trekerrodu.com.ua/terms/",
    title: "Умови користування — Трекер Роду",
    text: "Умови користування",
  },
];

export const ZAGULYAKY_CATALOGUE_PAGES = [
  {
    path: "zahuliaky/index.html",
    url: "https://trekerrodu.com.ua/zahuliaky/",
    title: "Загуляки людей — публічний генеалогічний каталог | Трекер Роду",
    heading: "Загуляки людей",
  },
  {
    path: "zahuliaky/documents/index.html",
    url: "https://trekerrodu.com.ua/zahuliaky/documents/",
    title: "Загуляки документів — публічний генеалогічний каталог | Трекер Роду",
    heading: "Загуляки документів",
  },
  {
    path: "zahuliaky/places/index.html",
    url: "https://trekerrodu.com.ua/zahuliaky/places/",
    title: "Загуляки за населеними пунктами — карта зв’язків | Трекер Роду",
    heading: "Загуляки за населеними пунктами",
  },
];

const privateSitemapUrls = [
  "https://trekerrodu.com.ua/projects/",
  "https://trekerrodu.com.ua/settings/",
  "https://trekerrodu.com.ua/documents/",
  "https://trekerrodu.com.ua/persons/",
  "https://trekerrodu.com.ua/findings/",
  "https://trekerrodu.com.ua/hypotheses/",
  "https://trekerrodu.com.ua/archive-requests/",
  "https://trekerrodu.com.ua/year-matrix/",
  "https://trekerrodu.com.ua/tasks/",
  "https://trekerrodu.com.ua/zahuliaky/my/",
  "https://trekerrodu.com.ua/admin/zagulyaky/",
];

/**
 * Verify the host-independent production output. These checks intentionally do
 * not know about GitHub Pages handoff files such as CNAME or 404.html, so the
 * same privacy and SEO contract can run on GitHub Pages and Vercel.
 */
export function verifyHostingBuild({
  distDirectory = join(process.cwd(), "dist"),
  onError = () => {},
} = {}) {
  const errors = [];

  function fail(message) {
    errors.push(message);
    onError(message);
  }

  function readDistFile(relativePath) {
    const filePath = join(distDirectory, relativePath);
    if (!existsSync(filePath)) {
      fail(`Missing dist/${relativePath}`);
      return "";
    }
    return readFileSync(filePath, "utf8");
  }

  function expectIncludes(source, needle, label) {
    if (!source.includes(needle)) fail(`${label} is missing: ${needle}`);
  }

  function expectNotIncludes(source, needle, label) {
    if (source.includes(needle)) fail(`${label} must not include: ${needle}`);
  }

  function expectMatches(source, pattern, label) {
    if (!pattern.test(source)) fail(`${label} does not match: ${pattern}`);
  }

  function expectNotMatches(source, pattern, label) {
    if (pattern.test(source)) fail(`${label} must not match: ${pattern}`);
  }

  function expectJsonLdAllowedByCsp(html, label) {
    const jsonLdScripts = [
      ...html.matchAll(
        /<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi,
      ),
    ];
    if (jsonLdScripts.length !== 1) {
      fail(`${label} must contain exactly one JSON-LD script, got ${jsonLdScripts.length}`);
      return;
    }
    const jsonLd = jsonLdScripts[0]?.[1] ?? "";
    const csp = html.match(
      /<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*\bcontent="([^"]*)"[^>]*>/i,
    )?.[1];
    const scriptSrc = csp
      ?.split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src "));
    if (!scriptSrc) {
      fail(`${label} is missing the CSP script-src directive`);
      return;
    }
    const expectedHash = `'sha256-${createHash("sha256").update(jsonLd).digest("base64")}'`;
    expectIncludes(scriptSrc, expectedHash, `${label} CSP`);
    expectNotIncludes(scriptSrc, "'unsafe-inline'", `${label} CSP`);
  }

  const robots = readDistFile("robots.txt");
  expectIncludes(robots, "User-agent: *", "robots.txt");
  expectIncludes(robots, "Allow: /", "robots.txt");
  for (const path of [
    "/projects",
    "/settings",
    "/admin",
    "/account",
    "/subscription",
    "/auth",
  ]) {
    expectIncludes(robots, `Disallow: ${path}\n`, "robots.txt");
  }
  expectIncludes(robots, "Sitemap: https://trekerrodu.com.ua/sitemap.xml", "robots.txt");
  expectIncludes(robots, "Sitemap: https://trekerrodu.com.ua/sitemap-zagulyaky.xml", "robots.txt");
  expectNotIncludes(robots, "Disallow: /\n", "robots.txt");

  const sitemap = readDistFile("sitemap.xml");
  const sitemapUrls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  const expectedUrls = [
    ...PUBLIC_PAGES.slice(0, 4).map((page) => page.url),
    "https://trekerrodu.com.ua/zahuliaky/",
    "https://trekerrodu.com.ua/zahuliaky/documents/",
    "https://trekerrodu.com.ua/zahuliaky/places/",
    ...PUBLIC_PAGES.slice(4).map((page) => page.url),
  ];
  if (JSON.stringify(sitemapUrls) !== JSON.stringify(expectedUrls)) {
    fail(`Unexpected sitemap URLs: ${JSON.stringify(sitemapUrls)}`);
  }
  for (const url of privateSitemapUrls) {
    expectNotIncludes(sitemap, `<loc>${url}</loc>`, "sitemap.xml");
  }

  const zagulyakySitemap = readDistFile("sitemap-zagulyaky.xml");
  const zagulyakyDetailUrls = [...zagulyakySitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(
    (match) => match[1],
  );
  expectMatches(
    zagulyakySitemap,
    /^<\?xml version="1\.0" encoding="UTF-8"\?>/i,
    "sitemap-zagulyaky.xml",
  );
  for (const url of zagulyakyDetailUrls) {
    if (!/^https:\/\/trekerrodu\.com\.ua\/zahuliaky\/(?:people|documents)\/[^/?#]+\/$/.test(url)) {
      fail(`sitemap-zagulyaky.xml contains an invalid public detail URL: ${url}`);
      continue;
    }
    const pathname = new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "");
    const html = readDistFile(`${pathname}/index.html`);
    expectIncludes(html, `<link rel="canonical" href="${url}"`, `${pathname}/index.html`);
    expectIncludes(html, 'name="robots" content="index, follow"', `${pathname}/index.html`);
    expectIncludes(html, `name="zagulyaky-static-seo" content="${url}"`, `${pathname}/index.html`);
    expectIncludes(html, 'type="application/ld+json"', `${pathname}/index.html JSON-LD`);
    expectIncludes(html, 'class="zagulyaky-static-seo"', `${pathname}/index.html static fallback`);
    expectJsonLdAllowedByCsp(html, `${pathname}/index.html`);
    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
    if (h1Count !== 1) fail(`${pathname}/index.html must contain exactly one h1, got ${h1Count}`);
  }
  if (new Set(zagulyakyDetailUrls).size !== zagulyakyDetailUrls.length) {
    fail("sitemap-zagulyaky.xml contains duplicate detail URLs.");
  }

  for (const page of ZAGULYAKY_CATALOGUE_PAGES) {
    const html = readDistFile(page.path);
    expectIncludes(html, `<title>${page.title}</title>`, page.path);
    expectIncludes(html, `<link rel="canonical" href="${page.url}"`, page.path);
    expectIncludes(html, 'name="robots" content="index, follow"', page.path);
    expectIncludes(html, `name="zagulyaky-static-seo" content="${page.url}"`, page.path);
    expectIncludes(html, 'type="application/ld+json"', `${page.path} JSON-LD`);
    expectIncludes(html, `<h1>${page.heading}</h1>`, page.path);
    expectIncludes(html, 'class="zagulyaky-static-seo"', `${page.path} static fallback`);
    expectJsonLdAllowedByCsp(html, page.path);
  }

  for (const page of PUBLIC_PAGES) {
    const html = readDistFile(page.path);
    expectIncludes(html, `<title>${page.title}</title>`, page.path);
    expectIncludes(html, `rel="canonical" href="${page.url}"`, page.path);
    expectIncludes(html, 'name="robots" content="index, follow"', page.path);
    expectIncludes(html, 'property="og:site_name" content="Трекер Роду"', page.path);
    expectIncludes(html, 'property="og:type" content="website"', page.path);
    expectIncludes(html, 'property="og:locale" content="uk_UA"', page.path);
    expectIncludes(html, `property="og:url" content="${page.url}"`, page.path);
    expectIncludes(
      html,
      'property="og:image" content="https://trekerrodu.com.ua/tracker-rodu-logo.png"',
      page.path,
    );
    expectIncludes(html, 'name="twitter:card" content="summary"', page.path);
    expectIncludes(
      html,
      'name="twitter:image" content="https://trekerrodu.com.ua/tracker-rodu-logo.png"',
      page.path,
    );
    expectIncludes(html, page.text, page.path);
    expectIncludes(html, 'http-equiv="Content-Security-Policy"', page.path);
    expectIncludes(html, "script-src 'self'", `${page.path} CSP`);
    expectIncludes(html, "https://www.googletagmanager.com", `${page.path} CSP`);
    expectIncludes(html, "https://www.google-analytics.com", `${page.path} CSP`);
    expectIncludes(html, 'name="referrer" content="strict-origin-when-cross-origin"', page.path);
    expectNotMatches(
      html,
      /<script[^>]+src=["']https:\/\/(?:www\.)?(?:googletagmanager|google-analytics)\.com/i,
      page.path,
    );

    const expectedMode = page.path === "index.html" ? "managed" : "auto-public";
    expectMatches(
      html,
      new RegExp(
        `src=["']/site-analytics\\.js["'][^>]*data-analytics-mode=["']${expectedMode}["']`,
        "i",
      ),
      `${page.path} analytics bootstrap`,
    );

    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
    if (h1Count !== 1) fail(`${page.path} must contain exactly one h1, got ${h1Count}`);
  }

  const index = readDistFile("index.html");
  expectIncludes(index, 'type="application/ld+json"', "index.html");
  expectIncludes(index, '"@type":"WebSite"', "index.html JSON-LD");
  expectIncludes(index, '"@type":"WebApplication"', "index.html JSON-LD");

  const analyticsBootstrap = readDistFile("site-analytics.js");
  expectIncludes(analyticsBootstrap, "G-SF2725LS4P", "site-analytics.js");
  expectIncludes(
    analyticsBootstrap,
    "tracker-rodu-analytics-consent-v1",
    "site-analytics.js",
  );
  expectMatches(
    analyticsBootstrap,
    /gtag\("consent",\s*"default",\s*\{[\s\S]*?analytics_storage:\s*"denied"/,
    "site-analytics.js consent default",
  );
  expectMatches(
    analyticsBootstrap,
    /send_page_view:\s*false/,
    "site-analytics.js manual page views",
  );
  expectNotMatches(
    analyticsBootstrap,
    /\buser_id\b|\buser_properties\b|project_id|person_id|document_id/i,
    "site-analytics.js private identifiers",
  );

  const privacy = readDistFile("privacy/index.html");
  for (const disclosure of [
    "Google Analytics",
    "успішних авторизацій",
    "активної авторизованої сесії",
    "приватні маршрути",
    "_ga",
    "Google Signals",
  ]) {
    expectIncludes(privacy, disclosure, "privacy/index.html analytics disclosure");
  }

  if (!existsSync(join(distDirectory, "tracker-rodu-logo.png"))) {
    fail("Missing dist/tracker-rodu-logo.png");
  }

  return { ok: errors.length === 0, errors };
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  const result = verifyHostingBuild({
    onError: (message) => console.error(`::error::${message}`),
  });
  if (!result.ok) {
    process.exitCode = 1;
  } else {
    console.log("Hosting build verification passed.");
  }
}
