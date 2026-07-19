import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GEDCOM_PHOTO_ALLOWED_HOSTNAME,
  GEDCOM_PHOTO_MAX_BYTES,
  GEDCOM_PHOTO_MAX_REDIRECTS,
  resolveGedcomPhotoRedirect,
  validateGedcomPhotoSource,
} from "../supabase/functions/fetch-gedcom-photo/security.ts";

test("GEDCOM photo proxy accepts only the exact HTTPS MyHeritage CDN host", () => {
  const accepted = validateGedcomPhotoSource(
    "https://sites-cf.mhcache.com/photo.jpg?token=test#ignored",
  );
  assert.equal(accepted.hostname, GEDCOM_PHOTO_ALLOWED_HOSTNAME);
  assert.equal(accepted.protocol, "https:");
  assert.equal(accepted.hash, "");

  for (const rejected of [
    "http://sites-cf.mhcache.com/photo.jpg",
    "https://sites-cf.mhcache.com:444/photo.jpg",
    "https://user@sites-cf.mhcache.com/photo.jpg",
    "https://sites-cf.mhcache.com.evil.example/photo.jpg",
    "https://evil.example/photo.jpg",
    "https://127.0.0.1/photo.jpg",
    "not-a-url",
  ]) {
    assert.throws(() => validateGedcomPhotoSource(rejected), /не дозволене/u);
  }
});

test("GEDCOM photo proxy revalidates every redirect target", () => {
  const current = validateGedcomPhotoSource(
    "https://sites-cf.mhcache.com/folder/photo.jpg",
  );
  assert.equal(
    resolveGedcomPhotoRedirect(current, "/fresh/photo.jpg").hostname,
    GEDCOM_PHOTO_ALLOWED_HOSTNAME,
  );
  assert.throws(
    () => resolveGedcomPhotoRedirect(current, "https://example.com/photo.jpg"),
    /не дозволене/u,
  );
  assert.equal(GEDCOM_PHOTO_MAX_REDIRECTS, 3);
  assert.equal(GEDCOM_PHOTO_MAX_BYTES, 25 * 1024 * 1024);
});

test("GEDCOM photo Edge entrypoint keeps auth, CORS, redirect and body limits explicit", () => {
  const source = readFileSync(
    new URL("../supabase/functions/fetch-gedcom-photo/index.ts", import.meta.url),
    "utf8",
  );
  const config = readFileSync(
    new URL("../supabase/config.toml", import.meta.url),
    "utf8",
  );

  assert.match(source, /Deno\.env\.get\("APP_URL"\)/u);
  assert.match(source, /auth\.getUser\(accessToken\)/u);
  assert.match(source, /redirect:\s*"manual"/u);
  assert.match(source, /resolveGedcomPhotoRedirect\(currentUrl, location\)/u);
  assert.match(source, /GEDCOM_PHOTO_MAX_REDIRECTS/u);
  assert.match(source, /contentType\.startsWith\("image\/"\)/u);
  assert.match(source, /response\.body\.getReader\(\)/u);
  assert.match(source, /GEDCOM_PHOTO_MAX_BYTES/u);
  assert.match(source, /url\.hostname === "localhost"/u);
  assert.match(source, /url\.hostname === "127\.0\.0\.1"/u);
  assert.match(source, /"Content-Type": "application\/octet-stream"/u);
  assert.match(source, /"X-Gedcom-Photo-Content-Type"/u);
  assert.match(source, /Access-Control-Expose-Headers/u);
  assert.doesNotMatch(source, /console\./u);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin"\]\s*=\s*"\*"/u);
  assert.match(
    config,
    /\[functions\.fetch-gedcom-photo\]\s*\r?\nverify_jwt = true/u,
  );
});
