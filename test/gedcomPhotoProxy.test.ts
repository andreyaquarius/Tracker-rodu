import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GEDCOM_PHOTO_PROXY_HOSTNAME,
  gedcomPhotoProxyErrorMessage,
  isGedcomPhotoProxyUrl,
  normalizeGedcomPhotoMime,
} from "../src/services/gedcomPhotoProxy.ts";

test("client proxy allowlist accepts only the exact HTTPS GEDCOM photo host", () => {
  assert.equal(GEDCOM_PHOTO_PROXY_HOSTNAME, "sites-cf.mhcache.com");
  assert.equal(
    isGedcomPhotoProxyUrl("https://sites-cf.mhcache.com/photo.jpg?token=test"),
    true,
  );

  for (const rejected of [
    "http://sites-cf.mhcache.com/photo.jpg",
    "https://sites-cf.mhcache.com:444/photo.jpg",
    "https://user@sites-cf.mhcache.com/photo.jpg",
    "https://child.sites-cf.mhcache.com/photo.jpg",
    "https://sites-cf.mhcache.com.evil.example/photo.jpg",
    "https://127.0.0.1/photo.jpg",
    "not-a-url",
  ]) {
    assert.equal(isGedcomPhotoProxyUrl(rejected), false, rejected);
  }
});

test("client accepts only a simple validated image MIME from the exposed header", () => {
  assert.equal(normalizeGedcomPhotoMime(" IMAGE/JPEG "), "image/jpeg");
  assert.equal(normalizeGedcomPhotoMime("image/svg+xml"), "image/svg+xml");
  assert.equal(normalizeGedcomPhotoMime("image/jpeg; charset=utf-8"), "");
  assert.equal(normalizeGedcomPhotoMime("text/html"), "");
  assert.equal(normalizeGedcomPhotoMime("image/jpeg\r\nx-test: injected"), "");
});

test("client reads the structured Supabase function error response", async () => {
  const error = {
    message: "generic SDK error",
    context: new Response(JSON.stringify({
      error: "PHOTO_SOURCE_EXPIRED",
      message: "Посилання на фотографію вже недоступне.",
    }), {
      status: 410,
      headers: { "content-type": "application/json" },
    }),
  };

  assert.equal(
    await gedcomPhotoProxyErrorMessage(error),
    "Зовнішнє посилання на фотографію більше недоступне. Виберіть оригінал у пакетному вікні або додайте фото вручну кнопкою «Додати файли».",
  );
});

test("client invokes the Blob Edge contract and restores its validated image MIME", () => {
  const source = readFileSync(
    new URL("../src/services/gedcomPhotoProxy.ts", import.meta.url),
    "utf8",
  );
  const scanStorage = readFileSync(
    new URL("../src/services/scanStorage.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /functions\.invoke<Blob>\(/u);
  assert.match(source, /"fetch-gedcom-photo"/u);
  assert.match(source, /response\?\.headers\.get\(GEDCOM_PHOTO_CONTENT_TYPE_HEADER\)/u);
  assert.match(source, /new Blob\(\[data\], \{ type: originalMime \}\)/u);
  assert.match(
    scanStorage,
    /kind === "image" && isGedcomPhotoProxyUrl\(target\)/u,
  );
  assert.match(scanStorage, /return fetchGedcomPhotoViaProxy\(target\)/u);

  const proxyBranch = scanStorage.indexOf("isGedcomPhotoProxyUrl(target)");
  const directFetch = scanStorage.indexOf("response = await fetch(target");
  assert.ok(proxyBranch >= 0 && directFetch > proxyBranch);
});
