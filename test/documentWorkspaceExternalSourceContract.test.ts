import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getScanBlob, getScanPreviewSource } from "../src/services/scanStorage.ts";
import type { ScanAttachment } from "../src/types/index.ts";

const viewerSource = readFileSync(
  new URL("../src/components/DocumentWorkspaceViewer.tsx", import.meta.url),
  "utf8",
);
const attachmentSource = readFileSync(
  new URL("../src/components/ScanAttachments.tsx", import.meta.url),
  "utf8",
);
const viteConfigSource = readFileSync(
  new URL("../vite.config.mjs", import.meta.url),
  "utf8",
);

test("public external PDF bytes stay in the in-app PDF workspace", async () => {
  const sourceUrl = "https://archive.example.org/cases/register-2026.pdf";
  const scan = externalScan(sourceUrl, "register-2026.pdf", "application/pdf");
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), {
      status: 200,
      headers: {
        "content-length": "8",
        "content-type": "application/pdf",
      },
    });
  }) as typeof fetch;

  try {
    const blob = await getScanBlob(scan);
    assert.equal(blob.type, "application/pdf");
    assert.equal(requestedUrl, sourceUrl);
    assert.equal(requestedInit?.credentials, "omit");
    assert.equal(requestedInit?.mode, "cors");
    assert.equal(requestedInit?.referrerPolicy, "no-referrer");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }

  assert.match(viewerSource, /getScanBlob\(scan\)[\s\S]*?normalizeScanPreviewBlob\(scan, blob\)[\s\S]*?previewKind\(scan, previewBlob\)/u);
  assert.match(viewerSource, /kind === "pdf" && blobUrl[\s\S]*?workspace-pdf-fast-preview/u);
  assert.match(viewerSource, /workspace-pdf-fast-preview[\s\S]*?<canvas[\s\S]*?ref=\{pdfCanvasRef\}/u);
});

test("a Wikisource file page resolves to original PDF bytes for the same workspace", async () => {
  const sourceUrl = "https://uk.wikisource.org/wiki/File:ДАЖО_1-77-297.pdf";
  const fileUrl = "https://upload.wikimedia.org/wikipedia/commons/a/a1/ДАЖО_1-77-297.pdf";
  const scan = externalScan(sourceUrl, "File:ДАЖО 1-77-297.pdf", "application/pdf");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/w/api.php?")) {
      return new Response(JSON.stringify({
        query: {
          pages: [{
            title: "File:ДАЖО 1-77-297.pdf",
            imageinfo: [{ url: fileUrl, mime: "application/pdf" }],
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === new URL(fileUrl).href) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: {
          "content-length": "4",
          "content-type": "application/pdf",
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    const blob = await getScanBlob(scan);
    assert.equal(blob.type, "application/pdf");
    assert.deepEqual(calls.length, 2);
    assert.match(calls[0] ?? "", /\/w\/api\.php\?/u);
    assert.equal(calls[1], new URL(fileUrl).href);
    assert.equal(calls.includes(sourceUrl), false, "the HTML file page must not be treated as PDF bytes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 555 MiB Wikisource PDF stays remote until PDF.js requests byte ranges", async () => {
  const sourceUrl = "https://uk.wikisource.org/wiki/File:ДАЖО_1-77-297.pdf";
  const fileUrl = "https://upload.wikimedia.org/wikipedia/commons/a/a3/ДАЖО_1-77-297.pdf";
  const scan = externalScan(sourceUrl, "File:ДАЖО 1-77-297.pdf", "application/pdf");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/w/api.php?")) {
      return new Response(JSON.stringify({
        query: {
          pages: [{
            title: "File:ДАЖО 1-77-297.pdf",
            missing: true,
            known: true,
            imagerepository: "shared",
            imageinfo: [{
              url: fileUrl,
              mime: "application/pdf",
              size: 581_530_245,
              pagecount: 372,
            }],
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`The full 555 MiB file must not be fetched before PDF.js requests a range: ${url}`);
  }) as typeof fetch;

  try {
    const preview = await getScanPreviewSource(scan);
    assert.deepEqual(preview, {
      kind: "pdf",
      url: new URL(fileUrl).href,
      revokeOnClose: false,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /\/w\/api\.php\?/u);
    assert.equal(calls.includes(new URL(fileUrl).href), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the document workspace streams remote PDFs with bounded PDF.js range requests", () => {
  const resolverStart = viewerSource.indexOf("async function resolveStreamablePdfPreview");
  const resolverEnd = viewerSource.indexOf("type PdfJsModule", resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
  const resolverSource = viewerSource.slice(resolverStart, resolverEnd);
  assert.match(resolverSource, /getScanPreviewSource\(scan\)/u);
  assert.doesNotMatch(resolverSource, /getScanBlob\(scan\)/u);

  const loaderStart = viewerSource.indexOf("const loadPdfDocument");
  const loaderEnd = viewerSource.indexOf("const preloadPage", loaderStart);
  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
  const loaderSource = viewerSource.slice(loaderStart, loaderEnd);
  assert.match(loaderSource, /preview\.blob[\s\S]*?data:\s*new Uint8Array/u);
  assert.match(loaderSource, /:\s*pdfJs\.getDocument\(\{[\s\S]*?url:\s*preview\.url/u);
  assert.match(loaderSource, /const document = await loadingTask\.promise/u);
  assert.match(loaderSource, /withCredentials:\s*false/u);
  assert.match(loaderSource, /disableRange:\s*false/u);
  assert.match(loaderSource, /disableStream:\s*true/u);
  assert.match(loaderSource, /disableAutoFetch:\s*true/u);
  assert.match(loaderSource, /rangeChunkSize:\s*PDF_VIEWER_RANGE_CHUNK_SIZE/u);
});

test("the viewer honors an initial page resolved from a Wikisource Page link", () => {
  assert.match(
    viewerSource,
    /\(viewerV2Enabled \? viewer\.restore\?\.pageIndex : undefined\) \?\? viewer\.scan\.initialPage \?\? 1/u,
  );
  assert.match(
    viewerSource,
    /setPdfPageNumber\(Math\.max\(1, restoredPage \?\? currentScan\?\.initialPage \?\? 1\)\)/u,
  );
});

test("production CSP permits MediaWiki API ranges and sandboxed HTTPS source frames", () => {
  assert.match(viteConfigSource, /connect-src[^\n]*https:\/\/\*\.wikisource\.org/u);
  assert.match(viteConfigSource, /connect-src[^\n]*https:\/\/\*\.wikimedia\.org/u);
  assert.match(viteConfigSource, /frame-src blob:[^\n]*https:/u);
});

test("a concrete external preview error is not masked as embedded-blocked", () => {
  const catchStart = viewerSource.indexOf(".catch((loadError)");
  const catchEnd = viewerSource.indexOf(".finally(() =>", catchStart);
  assert.ok(catchStart >= 0 && catchEnd > catchStart);
  const catchSource = viewerSource.slice(catchStart, catchEnd);

  assert.match(catchSource, /currentScan\.storage === "external-url"/u);
  assert.match(catchSource, /setExternalSourceReason\(null\)/u);
  assert.match(catchSource, /loadError instanceof Error[\s\S]*?loadError\.message/u);
  assert.doesNotMatch(catchSource, /setError\(""\)/u);
  assert.doesNotMatch(catchSource, /setExternalSourceReason\("embedded-blocked"\)/u);
});

test("the document workspace keeps finding and fragment tools for resolved PDF pages", () => {
  assert.match(viewerSource, /const canSelectFragment\s*=[\s\S]*?kind === "pdf"/u);
  assert.match(viewerSource, /onClick=\{\(\) => \{[\s\S]*?setSelectionMode/u);
  assert.match(viewerSource, /createFindingFromCrop\("google-drive"\)/u);
  assert.match(viewerSource, /createFindingFromCrop\(cropSnapshotDestination, findingCaptureMode\)/u);
  assert.match(viewerSource, /setFindingCaptureMode\("full-page"\)/u);
  assert.match(viewerSource, /Знахідка зі сторінки/u);
  assert.match(viewerSource, /rect:\s*\{\s*x:\s*0,\s*y:\s*0,\s*width:\s*1,\s*height:\s*1\s*\}/u);
  assert.match(viewerSource, /onClick=\{\(\) => void createFinding\(\)\}/u);
  assert.match(viewerSource, /Створити знахідку/u);
});

test("source pages enter the document workspace instead of bypassing it from the attachment row", () => {
  const scanRowStart = attachmentSource.indexOf("function ScanRow(");
  const scanPreviewStart = attachmentSource.indexOf("type ScanPreview", scanRowStart);
  assert.ok(scanRowStart >= 0 && scanPreviewStart > scanRowStart);
  const scanRowSource = attachmentSource.slice(scanRowStart, scanPreviewStart);

  assert.match(scanRowSource, /if \(onPreview\)[\s\S]*?onPreview\(scan, scanGroup\)/u);
  const workspacePreviewIndex = scanRowSource.indexOf("if (onPreview)");
  const sourceSiteFallbackIndex = scanRowSource.indexOf("if (opensOnSourceSite)");
  assert.ok(workspacePreviewIndex >= 0);
  assert.ok(
    sourceSiteFallbackIndex < 0 || workspacePreviewIndex < sourceSiteFallbackIndex,
    "the Tracker workspace must win before the stand-alone source-site fallback",
  );
});

test("a generic public source page is wrapped in a sandboxed in-app iframe", async () => {
  const sourceUrl = "https://archive.example.org/view/case-77?page=12&lang=uk";
  const scan = externalScan(sourceUrl, "Архівна справа 77", "text/html");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("the outer HTML page must be loaded only by the sandboxed iframe");
  }) as typeof fetch;

  try {
    const wrapper = await getScanBlob(scan);
    const html = await wrapper.text();
    assert.equal(wrapper.type, "text/html");
    assert.equal(fetchCalls, 0);
    assert.match(html, /<iframe[\s\S]*?class="source-frame"/u);
    assert.match(html, /src="https:\/\/archive\.example\.org\/view\/case-77\?page=12&amp;lang=uk"/u);
    assert.match(
      html,
      /sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts"/u,
    );
    assert.doesNotMatch(html, /sandbox="[^"]*allow-same-origin/u);
    assert.match(html, /<iframe[\s\S]*?referrerpolicy="no-referrer"/u);
    assert.match(
      html,
      /<a[^>]*class="source-fallback"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*referrerpolicy="no-referrer"/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(
    viewerSource,
    /strategy\.mode === "source-page" && strategy\.reason === "authenticated-source"/u,
  );
  assert.match(viewerSource, /kind === "web" && blobUrl[\s\S]*?<iframe title=\{activeScan\.name\} src=\{blobUrl\}/u);
});

test("authenticated sources expose a distinct connect or import state inside the viewer", () => {
  assert.match(viewerSource, /externalSourceReason === "authenticated-source"/u);
  assert.match(viewerSource, /Увійти на FamilySearch/u);
  assert.match(viewerSource, /(?:OAuth|офіційн\w*\s+підключ|копі\w*\s+(?:файлу\s+)?(?:у|до)\s+Google Drive)/iu);

  const authStateStart = viewerSource.indexOf("{externalSourceReason ? (");
  const loadingStateStart = viewerSource.indexOf(") : loading && !blobUrl ? (", authStateStart);
  assert.ok(authStateStart >= 0 && loadingStateStart > authStateStart);
  const authStateSource = viewerSource.slice(authStateStart, loadingStateStart);
  assert.doesNotMatch(
    authStateSource,
    />\s*Відкрити на сайті джерела\s*</u,
    "an authenticated source needs an explicit connect/import workflow, not the old open-only fallback",
  );
});

function externalScan(storagePath: string, name: string, mimeType: string): ScanAttachment {
  return {
    id: `${storagePath}#workspace-contract`,
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
