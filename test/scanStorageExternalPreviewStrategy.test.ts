import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  attachAttachmentReference,
  getExternalScanPreviewStrategy,
  getScanBlob,
  getScanPreviewSource,
  inspectAttachmentReference,
  resolveMediaWikiFilePage,
} from "../src/services/scanStorage.ts";
import type { ScanAttachment } from "../src/types/index.ts";

test("a Wikisource File page resolves through imageinfo and remains inside the document viewer", async () => {
  const sourceUrl = "https://uk.wikisource.org/wiki/Файл:ДАЖО_1-77-297.pdf";
  const rawUrl = "https://upload.wikimedia.org/wikipedia/commons/7/70/ДАЖО_1-77-297.pdf";
  // This reproduces an already-saved attachment whose source-page MIME was
  // persisted before MediaWiki file-page resolution existed.
  const scan = externalScan(sourceUrl, "File:ДАЖО 1-77-297.pdf", "text/html");
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input) => {
    const requestedUrl = String(input);
    requestedUrls.push(requestedUrl);
    const url = new URL(requestedUrl);
    if (url.hostname === "uk.wikisource.org") {
      assert.equal(url.pathname, "/w/api.php");
      assert.equal(url.searchParams.get("action"), "query");
      assert.equal(url.searchParams.get("prop"), "imageinfo");
      assert.equal(url.searchParams.get("iiprop"), "url|size|mime|sha1|timestamp");
      assert.equal(url.searchParams.get("titles"), "File:ДАЖО 1-77-297.pdf");
      assert.equal(url.searchParams.get("origin"), "*");
      return new Response(JSON.stringify({
        query: {
          pages: [{
            pageid: 297,
            title: "Файл:ДАЖО 1-77-297.pdf",
            missing: true,
            known: true,
            imagerepository: "shared",
            imageinfo: [{ url: rawUrl, mime: "application/pdf" }],
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.hostname === "upload.wikimedia.org") {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    throw new Error(`Unexpected URL: ${requestedUrl}`);
  }) as typeof fetch;

  try {
    assert.deepEqual(getExternalScanPreviewStrategy(scan), {
      mode: "mediawiki-file",
      sourceUrl: new URL(sourceUrl).href,
      pageTitle: "File:ДАЖО 1-77-297.pdf",
    });

    const blob = await getScanBlob(scan);
    assert.equal(blob.type, "application/pdf");
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x25, 0x50, 0x44, 0x46]);
    assert.equal(requestedUrls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MediaWiki resolver accepts index.php links and returns trusted image metadata", async () => {
  const sourceUrl = "https://commons.wikimedia.org/w/index.php?title=File:Archive_scan.jpg&oldid=42";
  const rawUrl = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Archive_scan.jpg";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://commons.wikimedia.org/w/api.php");
    assert.equal(url.searchParams.get("titles"), "File:Archive scan.jpg");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    return new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:Archive scan.jpg",
          imageinfo: [{ url: rawUrl, mime: "image/jpeg" }],
        }],
      },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    assert.deepEqual(await resolveMediaWikiFilePage(sourceUrl), {
      sourceUrl,
      sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Archive_scan.jpg",
      fileUrl: rawUrl,
      fileName: "Archive scan.jpg",
      mimeType: "image/jpeg",
      providerFileTitle: "File:Archive scan.jpg",
    });

    const preview = await getScanPreviewSource(externalScan(sourceUrl, "Saved web page", "text/html"));
    assert.deepEqual(preview, {
      kind: "image",
      url: rawUrl,
      revokeOnClose: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Wikisource Page reference resolves the base PDF and persists its initial page provenance", async () => {
  const sourceUrl = "https://uk.wikisource.org/wiki/Сторінка:ДАЖО_1-77-297.pdf/25";
  const rawUrl = "https://upload.wikimedia.org/wikipedia/commons/7/70/ДАЖО_1-77-297.pdf";
  const canonicalRawUrl = new URL(rawUrl).href;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/w/api.php");
    assert.equal(url.searchParams.get("titles"), "File:ДАЖО 1-77-297.pdf");
    return new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:ДАЖО 1-77-297.pdf",
          imageinfo: [{
            url: rawUrl,
            mime: "application/pdf",
            size: 581_530_245,
            pagecount: 372,
            sha1: "sha1-version",
            timestamp: "2026-07-30T08:00:00Z",
          }],
        }],
      },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const preview = await inspectAttachmentReference(sourceUrl, "document");
    assert.equal(preview.provider, "wikimedia");
    assert.equal(preview.initialPage, 25);
    assert.equal(preview.pageCount, 372);
    assert.equal(preview.canonicalUrl, canonicalRawUrl);

    const [scan] = await attachAttachmentReference(sourceUrl, "document");
    assert.ok(scan);
    assert.equal(scan.name, "ДАЖО 1-77-297.pdf");
    assert.equal(scan.sourceProvider, "wikimedia");
    assert.equal(scan.initialPage, 25);
    assert.equal(scan.canonicalSourceUrl, canonicalRawUrl);
    assert.equal(scan.providerFileTitle, "File:ДАЖО 1-77-297.pdf");
    assert.deepEqual(scan.sourceFingerprint, {
      sha1: "sha1-version",
      modifiedTime: "2026-07-30T08:00:00Z",
      contentLength: 581_530_245,
    });
    assert.deepEqual(getExternalScanPreviewStrategy(scan), {
      mode: "mediawiki-file",
      sourceUrl: new URL(sourceUrl).href,
      pageTitle: "File:ДАЖО 1-77-297.pdf",
      initialPage: 25,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signed external URLs are rejected before they can be stored in attachment JSON", async () => {
  const signedUrl = "https://archive.example.org/file.pdf?X-Amz-Signature=secret&X-Amz-Expires=60";
  await assert.rejects(
    inspectAttachmentReference(signedUrl, "document"),
    (error) => (
      error instanceof Error
      && "code" in error
      && error.code === "SENSITIVE_URL_NOT_PERSISTABLE"
    ),
  );
  await assert.rejects(
    attachAttachmentReference(signedUrl, "document"),
    /тимчасовий токен або цифровий підпис/u,
  );
});

test("explicit public PDF and image file URLs remain eligible for embedded preview", () => {
  const pdfUrl = "https://upload.wikimedia.org/wikipedia/commons/7/70/archive-register.pdf";
  const imageUrl = "https://cdn.example.org/scans/page-001.jpg";

  assert.deepEqual(
    getExternalScanPreviewStrategy(externalScan(pdfUrl, "archive-register.pdf", "application/pdf")),
    { mode: "embedded", sourceUrl: pdfUrl },
  );
  assert.deepEqual(
    getExternalScanPreviewStrategy(externalScan(imageUrl, "page-001.jpg", "image/jpeg")),
    { mode: "embedded", sourceUrl: imageUrl },
  );
  assert.deepEqual(
    getExternalScanPreviewStrategy(externalScan(
      "https://archive.example.org/view/case.pdf",
      "case.pdf",
      "text/html",
    )),
    {
      mode: "source-page",
      sourceUrl: "https://archive.example.org/view/case.pdf",
      reason: "web-page",
    },
  );
});

test("an authenticated FamilySearch record opens the original source without proxying credentials", async () => {
  const sourceUrl = "https://www.familysearch.org/ark:/61903/3:1:3Q9M-CSM7-9Q2G?i=114&cc=1910265";
  const scan = externalScan(sourceUrl, "FamilySearch", "text/html");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("Authenticated sources must be opened by the user's browser session");
  }) as typeof fetch;

  try {
    assert.deepEqual(getExternalScanPreviewStrategy(scan), {
      mode: "source-page",
      sourceUrl: new URL(sourceUrl).href,
      reason: "authenticated-source",
    });

    const preview = await getScanBlob(scan);
    const html = await preview.text();
    assert.equal(fetchCalls, 0);
    assert.match(html, /www\.familysearch\.org\/ark:/u);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/u);
    assert.doesNotMatch(html, /gedcom-photo|proxy|authorization|credentials/iu);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("external source URLs reject embedded credentials and do not trust lookalike FamilySearch hosts", () => {
  assert.throws(
    () => getExternalScanPreviewStrategy(externalScan(
      "https://researcher:secret@example.org/archive.pdf",
      "archive.pdf",
      "application/pdf",
    )),
    /Не вставляйте логін або пароль/u,
  );

  assert.deepEqual(
    getExternalScanPreviewStrategy(externalScan(
      "https://familysearch.org.evil.example/record",
      "FamilySearch copy",
      "text/html",
    )),
    {
      mode: "source-page",
      sourceUrl: "https://familysearch.org.evil.example/record",
      reason: "web-page",
    },
  );
});

test("direct external fetches omit credentials and referrer while new tabs isolate their opener", () => {
  const source = readFileSync(
    new URL("../src/services/scanStorage.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /credentials:\s*"omit"[\s\S]*?referrerPolicy:\s*"no-referrer"/u);
  assert.match(source, /anchor\.target\s*=\s*"_blank"[\s\S]*?anchor\.rel\s*=\s*"noopener noreferrer"/u);
  assert.match(source, /anchor\.referrerPolicy\s*=\s*"no-referrer"/u);
  assert.doesNotMatch(source, /headers:\s*\{[\s\S]*?Authorization\s*:/u);
});

function externalScan(storagePath: string, name: string, mimeType: string): ScanAttachment {
  return {
    id: storagePath,
    name,
    mimeType,
    size: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    storage: "external-url",
    storagePath,
    webViewLink: storagePath,
    deleteOnRemove: false,
  };
}
