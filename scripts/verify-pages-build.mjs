import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");

const publicPages = [
  {
    path: "index.html",
    url: "https://trekerrodu.com.ua/",
    title: "Трекер Роду — Не губи сліди свого роду",
    text: "Не губи сліди свого роду",
  },
  {
    path: "features/index.html",
    url: "https://trekerrodu.com.ua/features",
    title: "Можливості Трекера Роду — інструменти генеалогічного дослідження",
    text: "Інструменти для генеалогічного дослідження",
  },
  {
    path: "pricing/index.html",
    url: "https://trekerrodu.com.ua/pricing",
    title: "Тарифи Трекера Роду — Старт, Дослідник і Професійний",
    text: "Тарифи Трекера Роду",
  },
  {
    path: "privacy/index.html",
    url: "https://trekerrodu.com.ua/privacy",
    title: "Політика конфіденційності — Трекер Роду",
    text: "Політика конфіденційності",
  },
  {
    path: "terms/index.html",
    url: "https://trekerrodu.com.ua/terms",
    title: "Умови користування — Трекер Роду",
    text: "Умови користування",
  },
];

const privatePatterns = [
  "/projects",
  "/settings",
  "/documents",
  "/persons",
  "/findings",
  "/hypotheses",
  "/archive-requests",
  "/year-matrix",
  "/tasks",
];

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function readDistFile(relativePath) {
  const filePath = join(dist, relativePath);
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

const cname = readDistFile("CNAME").trim();
if (cname !== "trekerrodu.com.ua") {
  fail(`dist/CNAME must be trekerrodu.com.ua, got ${JSON.stringify(cname)}`);
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
expectNotIncludes(robots, "Disallow: /\n", "robots.txt");

const sitemap = readDistFile("sitemap.xml");
const sitemapUrls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
const expectedUrls = publicPages.map((page) => page.url);
if (JSON.stringify(sitemapUrls) !== JSON.stringify(expectedUrls)) {
  fail(`Unexpected sitemap URLs: ${JSON.stringify(sitemapUrls)}`);
}
for (const pattern of privatePatterns) {
  expectNotIncludes(sitemap, pattern, "sitemap.xml");
}

for (const page of publicPages) {
  const html = readDistFile(page.path);
  expectIncludes(html, `<title>${page.title}</title>`, page.path);
  expectIncludes(html, `rel="canonical" href="${page.url}"`, page.path);
  expectIncludes(html, 'name="robots" content="index, follow"', page.path);
  expectIncludes(html, 'property="og:site_name" content="Трекер Роду"', page.path);
  expectIncludes(html, 'property="og:type" content="website"', page.path);
  expectIncludes(html, 'property="og:locale" content="uk_UA"', page.path);
  expectIncludes(html, `property="og:url" content="${page.url}"`, page.path);
  expectIncludes(html, 'property="og:image" content="https://trekerrodu.com.ua/tracker-rodu-logo.png"', page.path);
  expectIncludes(html, 'name="twitter:card" content="summary"', page.path);
  expectIncludes(html, 'name="twitter:image" content="https://trekerrodu.com.ua/tracker-rodu-logo.png"', page.path);
  expectIncludes(html, page.text, page.path);
  expectIncludes(html, 'http-equiv="Content-Security-Policy"', page.path);
  expectIncludes(html, "script-src 'self'", `${page.path} CSP`);
  expectIncludes(html, "https://www.googletagmanager.com", `${page.path} CSP`);
  expectIncludes(html, "https://www.google-analytics.com", `${page.path} CSP`);
  expectIncludes(
    html,
    'name="referrer" content="strict-origin-when-cross-origin"',
    page.path,
  );
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

const notFound = readDistFile("404.html");
expectIncludes(
  notFound,
  'name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex"',
  "404.html",
);
expectIncludes(notFound, "Сторінку не знайдено", "404.html");
expectIncludes(notFound, "Повернутися на головну", "404.html");
expectNotIncludes(notFound, 'rel="canonical"', "404.html");
expectNotMatches(
  notFound,
  /site-analytics|G-SF2725LS4P|googletagmanager|google-analytics|tracker-rodu-analytics/i,
  "404.html analytics isolation",
);

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

if (!existsSync(join(dist, "tracker-rodu-logo.png"))) {
  fail("Missing dist/tracker-rodu-logo.png");
}

if (!process.exitCode) {
  console.log("Pages build verification passed.");
}
