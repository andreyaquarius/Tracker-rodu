import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

test("root uses the local managed analytics bootstrap and no unconditional remote tag", () => {
  const html = read("index.html");

  assert.match(
    html,
    /<script\s+type="module"\s+src="\/site-analytics\.js"\s+data-analytics-mode="managed"><\/script>/,
  );
  assert.doesNotMatch(html, /<script[^>]+src=["']https:\/\/(?:www\.)?googletagmanager\.com/i);
  assert.doesNotMatch(html, /<script[^>]+src=["']https:\/\/(?:www\.)?google-analytics\.com/i);
});

test("every standalone public page uses one local auto-public bootstrap and analytics CSP", () => {
  for (const page of ["features", "pricing", "privacy", "terms"]) {
    const html = read(`public/${page}/index.html`);
    assert.equal(
      count(html, /src="\/site-analytics\.js"\s+data-analytics-mode="auto-public"/g),
      1,
      page,
    );
    assert.doesNotMatch(
      html,
      /<script[^>]+src=["']https:\/\/(?:www\.)?(?:googletagmanager|google-analytics)\.com/i,
      page,
    );
    assert.match(html, /http-equiv="Content-Security-Policy"/i, page);
    assert.match(html, /script-src 'self' https:\/\/www\.googletagmanager\.com/i, page);
    assert.match(html, /connect-src[^">]*https:\/\/www\.google-analytics\.com/i, page);
    assert.match(html, /name="referrer" content="strict-origin-when-cross-origin"/i, page);
  }
});

test("404 stays analytics-free, including its restrictive CSP", () => {
  const html = read("public/404.html");

  assert.doesNotMatch(
    html,
    /site-analytics|G-SF2725LS4P|googletagmanager|google-analytics|tracker-rodu-analytics/i,
  );
  assert.match(html, /script-src 'self'/i);
  assert.doesNotMatch(html, /script-src[^">]*https:/i);
});

test("both privacy-policy renderings disclose the narrow GA4 scope and consent controls", () => {
  for (const file of ["public/privacy/index.html", "src/pages/LegalPages.tsx"]) {
    const source = read(file).replace(/\s+/g, " ");
    assert.match(source, /Google Analytics/i, file);
    assert.match(source, /згод/i, file);
    assert.match(source, /публічн[^\s<]* сторін/i, file);
    assert.match(source, /успішн[^\s<]* авторизац/i, file);
    assert.match(source, /активн[^\s<]* авторизован[^\s<]* сесі/i, file);
    assert.match(source, /приватні маршрути/i, file);
    assert.match(source, /_ga/i, file);
    assert.match(source, /Google Signals/i, file);
  }
});
