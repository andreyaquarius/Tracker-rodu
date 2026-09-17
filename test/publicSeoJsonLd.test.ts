import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { appendPublicPageJsonLd } from "../scripts/generate-public-seo.mjs";

const previousJsonLd = JSON.stringify({ "@type": "WebPage", name: "Previous page" });
const previousScript = `<script type="application/ld+json">${previousJsonLd}</script>`;
const nextJsonLd = JSON.stringify({ "@type": "WebPage", name: "Current page" });
const analyticsScript = '<script type="module" src="/site-analytics.js"></script>';
const scriptHash = (source: string) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
const template = (head: string) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self' ${scriptHash(previousJsonLd)}; object-src 'none'">${head}</head><body>${analyticsScript}</body></html>`;
const jsonLdScripts = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

test("public JSON-LD insertion and replacement preserve analytics and stay idempotent with a matching CSP hash", () => {
  for (const head of ["", previousScript]) {
    const result = appendPublicPageJsonLd(template(head), nextJsonLd);
    const scripts = jsonLdScripts(result);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0][1], nextJsonLd);
    assert.ok(result.includes(scriptHash(nextJsonLd)));
    assert.ok(!result.includes(scriptHash(previousJsonLd)));
    assert.ok(result.includes(analyticsScript));
    assert.equal(appendPublicPageJsonLd(result, nextJsonLd), result);
  }
});

test("public JSON-LD replacement cannot join split script tags into executable markup", () => {
  for (const tag of ["script", "ScRiPt"]) {
    const opening = `<${tag}`;
    for (let split = 1; split <= opening.length; split += 1) {
      const malformed = `${opening.slice(0, split)}${previousScript}${opening.slice(split)}>alert(1)</${tag}>`;
      const result = appendPublicPageJsonLd(template(malformed), nextJsonLd);
      assert.doesNotMatch(result, /<script\b[^>]*>\s*alert\(1\)/i, `split ${split} of ${tag}`);
      assert.ok(result.includes(nextJsonLd));
      assert.ok(result.includes(analyticsScript));
    }
  }
});

test("public JSON-LD replacement preserves dollar sequences and encodes HTML delimiters before hashing", () => {
  const data = { "@type": "WebPage", name: "</script><script>alert(1)</script> $& $` $'" };
  for (const head of ["", previousScript]) {
    const result = appendPublicPageJsonLd(template(head), JSON.stringify(data));
    const scripts = jsonLdScripts(result);
    assert.equal(scripts.length, 1);
    const serialized = scripts[0][1];
    assert.deepEqual(JSON.parse(serialized), data);
    assert.ok(!serialized.includes("<"));
    assert.ok(result.includes(scriptHash(serialized)));
    assert.doesNotMatch(result, /<script>alert\(1\)<\/script>/i);
  }
});

test("public JSON-LD replacement rejects duplicate blocks and missing insertion or CSP targets", () => {
  assert.throws(() => appendPublicPageJsonLd(template(previousScript + previousScript), nextJsonLd), /multiple JSON-LD/);
  assert.throws(() => appendPublicPageJsonLd(template("").replace("</head>", ""), nextJsonLd), /head closing tag/);
  assert.throws(() => appendPublicPageJsonLd("<html><head></head></html>", nextJsonLd), /Content-Security-Policy/);
});
