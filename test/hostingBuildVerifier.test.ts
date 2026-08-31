import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  PUBLIC_PAGES,
  ZAGULYAKY_CATALOGUE_PAGES,
  verifyHostingBuild,
} from "../scripts/verify-hosting-build.mjs";
import {
  verifyGitHubPagesHandoff,
  verifyPagesBuild,
} from "../scripts/verify-pages-build.mjs";

function writeFixtureFile(root: string, relativePath: string, contents: string) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function createHostingFixture() {
  const root = mkdtempSync(join(tmpdir(), "tracker-rodu-hosting-verifier-"));

  writeFixtureFile(
    root,
    "robots.txt",
    [
      "User-agent: *",
      "Allow: /",
      "",
      "Disallow: /projects",
      "Disallow: /settings",
      "Disallow: /admin",
      "Disallow: /account",
      "Disallow: /subscription",
      "Disallow: /auth",
      "",
      "Sitemap: https://trekerrodu.com.ua/sitemap.xml",
      "Sitemap: https://trekerrodu.com.ua/sitemap-zagulyaky.xml",
      "",
    ].join("\n"),
  );

  const sitemapUrls = [
    ...PUBLIC_PAGES.slice(0, 4).map((page) => page.url),
    "https://trekerrodu.com.ua/zahuliaky/",
    "https://trekerrodu.com.ua/zahuliaky/documents/",
    "https://trekerrodu.com.ua/zahuliaky/places/",
    ...PUBLIC_PAGES.slice(4).map((page) => page.url),
  ];
  writeFixtureFile(
    root,
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><urlset>${sitemapUrls
      .map((url) => `<url><loc>${url}</loc></url>`)
      .join("")}</urlset>`,
  );
  writeFixtureFile(
    root,
    "sitemap-zagulyaky.xml",
    '<?xml version="1.0" encoding="UTF-8"?><urlset></urlset>',
  );

  for (const page of PUBLIC_PAGES) {
    const mode = page.path === "index.html" ? "managed" : "auto-public";
    const privacyDisclosures = page.path === "privacy/index.html"
      ? "Google Analytics успішних авторизацій активної авторизованої сесії приватні маршрути _ga Google Signals"
      : "";
    const indexJsonLd = page.path === "index.html"
      ? '<script type="application/ld+json">{"@type":"WebSite"}</script><script type="application/ld+json">{"@type":"WebApplication"}</script>'
      : "";
    writeFixtureFile(
      root,
      page.path,
      `<!doctype html><html><head>
        <title>${page.title}</title>
        <link rel="canonical" href="${page.url}">
        <meta name="robots" content="index, follow">
        <meta property="og:site_name" content="Трекер Роду">
        <meta property="og:type" content="website">
        <meta property="og:locale" content="uk_UA">
        <meta property="og:url" content="${page.url}">
        <meta property="og:image" content="https://trekerrodu.com.ua/tracker-rodu-logo.png">
        <meta name="twitter:card" content="summary">
        <meta name="twitter:image" content="https://trekerrodu.com.ua/tracker-rodu-logo.png">
        <meta http-equiv="Content-Security-Policy" content="script-src 'self' https://www.googletagmanager.com https://www.google-analytics.com">
        <meta name="referrer" content="strict-origin-when-cross-origin">
        <script src="/site-analytics.js" data-analytics-mode="${mode}"></script>
        ${indexJsonLd}
      </head><body><h1>${page.text}</h1>${privacyDisclosures}</body></html>`,
    );
  }

  for (const page of ZAGULYAKY_CATALOGUE_PAGES) {
    const jsonLd = '{"@type":"CollectionPage"}';
    const jsonLdHash = `'sha256-${createHash("sha256").update(jsonLd).digest("base64")}'`;
    writeFixtureFile(
      root,
      page.path,
      `<!doctype html><html><head>
        <title>${page.title}</title>
        <link rel="canonical" href="${page.url}">
        <meta name="robots" content="index, follow">
        <meta name="zagulyaky-static-seo" content="${page.url}">
        <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' ${jsonLdHash}">
        <script type="application/ld+json">${jsonLd}</script>
      </head><body><main class="zagulyaky-static-seo"><h1>${page.heading}</h1></main></body></html>`,
    );
  }

  writeFixtureFile(
    root,
    "site-analytics.js",
    `const measurementId = "G-SF2725LS4P";
     const consentKey = "tracker-rodu-analytics-consent-v1";
     gtag("consent", "default", { analytics_storage: "denied" });
     const options = { send_page_view: false };`,
  );
  writeFixtureFile(root, "tracker-rodu-logo.png", "fixture");
  return root;
}

const github404 = `<!doctype html><html><head>
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
  <title>Сторінку не знайдено — Трекер Роду</title>
</head><body><h1>Сторінку не знайдено</h1><a href="/">Повернутися на головну</a></body></html>`;

test("host-neutral verifier accepts a valid build without GitHub Pages handoff files", () => {
  const root = createHostingFixture();
  try {
    const result = verifyHostingBuild({ distDirectory: root });
    assert.deepEqual(result, { ok: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub Pages verifier keeps CNAME and privacy-safe 404 requirements", () => {
  const root = createHostingFixture();
  try {
    const missing = verifyGitHubPagesHandoff({ distDirectory: root });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((error) => error === "Missing dist/CNAME"));
    assert.ok(missing.errors.some((error) => error === "Missing dist/404.html"));

    writeFixtureFile(root, "CNAME", "trekerrodu.com.ua\n");
    writeFixtureFile(root, "404.html", github404);

    assert.deepEqual(verifyGitHubPagesHandoff({ distDirectory: root }), {
      ok: true,
      errors: [],
    });
    assert.deepEqual(verifyPagesBuild({ distDirectory: root }), {
      ok: true,
      errors: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
