import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyHostingBuild } from "./verify-hosting-build.mjs";

/**
 * GitHub Pages needs two handoff artifacts that are intentionally not part of
 * the host-neutral Vercel/Pages contract: a custom-domain CNAME and a static
 * 404 document used for the SPA deep-link recovery flow.
 */
export function verifyGitHubPagesHandoff({
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

  function expectNotMatches(source, pattern, label) {
    if (pattern.test(source)) fail(`${label} must not match: ${pattern}`);
  }

  const cname = readDistFile("CNAME").trim();
  if (cname !== "trekerrodu.com.ua") {
    fail(`dist/CNAME must be trekerrodu.com.ua, got ${JSON.stringify(cname)}`);
  }

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

  return { ok: errors.length === 0, errors };
}

export function verifyPagesBuild(options = {}) {
  const hostingResult = verifyHostingBuild(options);
  const pagesResult = verifyGitHubPagesHandoff(options);
  const errors = [...hostingResult.errors, ...pagesResult.errors];
  return { ok: errors.length === 0, errors };
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  const result = verifyPagesBuild({
    onError: (message) => console.error(`::error::${message}`),
  });
  if (!result.ok) {
    process.exitCode = 1;
  } else {
    console.log("Pages build verification passed.");
  }
}
