import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMediaWikiArticlePdfCandidatesApiUrl,
  buildMediaWikiImageInfoApiUrl,
  isSupportedMediaWikiHost,
  mediaWikiArticleContinuation,
  mediaWikiImageInfoApiCandidates,
  parseMediaWikiArticleUrl,
  parseMediaWikiDocumentUrl,
  parseMediaWikiImageInfoResponse,
  parseMediaWikiImageInfoResponses,
  resolveMediaWikiPdfCandidate,
} from "../src/services/mediaWikiPdfSource.ts";

test("parses a Commons File URL and keeps File behavior compatible", () => {
  const parsed = parseMediaWikiDocumentUrl(
    "https://commons.wikimedia.org/wiki/File:Archive_register_1901.pdf?uselang=uk#page=3",
  );

  assert.ok(parsed);
  assert.equal(parsed.namespace, "file");
  assert.equal(parsed.originalPageTitle, "File:Archive register 1901.pdf");
  assert.equal(parsed.canonicalPageTitle, "File:Archive register 1901.pdf");
  assert.equal(parsed.baseFileName, "Archive register 1901.pdf");
  assert.equal(parsed.baseFileTitle, "File:Archive register 1901.pdf");
  assert.equal(parsed.initialPage, undefined);
  assert.equal(parsed.sourceUrl, "https://commons.wikimedia.org/wiki/File:Archive_register_1901.pdf");
});

test("canonicalizes the Ukrainian File namespace", () => {
  const parsed = parseMediaWikiDocumentUrl(
    "https://uk.wikisource.org/wiki/%D0%A4%D0%B0%D0%B9%D0%BB:%D0%94%D0%90%D0%96%D0%9E_1-77-297.pdf",
  );

  assert.ok(parsed);
  assert.equal(parsed.namespace, "file");
  assert.equal(parsed.namespaceAlias, "Файл");
  assert.equal(parsed.canonicalPageTitle, "File:ДАЖО 1-77-297.pdf");
  assert.equal(parsed.baseFileTitle, "File:ДАЖО 1-77-297.pdf");
});

test("parses English and Ukrainian Wikisource Index URLs", () => {
  const english = parseMediaWikiDocumentUrl("https://en.wikisource.org/wiki/Index:Book_scan.pdf");
  const ukrainian = parseMediaWikiDocumentUrl(
    "https://uk.wikisource.org/w/index.php?title=%D0%86%D0%BD%D0%B4%D0%B5%D0%BA%D1%81:%D0%9C%D0%B5%D1%82%D1%80%D0%B8%D1%87%D0%BD%D0%B0_%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0.pdf&oldid=42",
  );

  assert.ok(english);
  assert.equal(english.namespace, "index");
  assert.equal(english.canonicalPageTitle, "Index:Book scan.pdf");
  assert.equal(english.baseFileTitle, "File:Book scan.pdf");
  assert.ok(ukrainian);
  assert.equal(ukrainian.namespace, "index");
  assert.equal(ukrainian.canonicalPageTitle, "Index:Метрична книга.pdf");
  assert.equal(ukrainian.baseFileTitle, "File:Метрична книга.pdf");
});

test("extracts numeric initialPage and preserves the Page subpage label", () => {
  const parsed = parseMediaWikiDocumentUrl(
    "https://uk.wikisource.org/wiki/%D0%A1%D1%82%D0%BE%D1%80%D1%96%D0%BD%D0%BA%D0%B0:%D0%94%D0%90%D0%96%D0%9E_1-77-297.pdf/025",
  );

  assert.ok(parsed);
  assert.equal(parsed.namespace, "page");
  assert.equal(parsed.canonicalPageTitle, "Page:ДАЖО 1-77-297.pdf/025");
  assert.equal(parsed.baseFileTitle, "File:ДАЖО 1-77-297.pdf");
  assert.equal(parsed.initialPage, 25);
  assert.equal(parsed.initialPageLabel, "025");
});

test("preserves a non-numeric Page label without inventing a physical page", () => {
  const parsed = parseMediaWikiDocumentUrl("https://fr.wikisource.org/wiki/Page:Registre.pdf/Couverture");

  assert.ok(parsed);
  assert.equal(parsed.namespace, "page");
  assert.equal(parsed.baseFileTitle, "File:Registre.pdf");
  assert.equal(parsed.initialPage, undefined);
  assert.equal(parsed.initialPageLabel, "Couverture");
});

test("keeps document namespaces separate while accepting an ordinary Wikisource article", () => {
  assert.equal(parseMediaWikiDocumentUrl("https://example.org/wiki/File:book.pdf"), null);
  assert.equal(parseMediaWikiDocumentUrl("http://uk.wikisource.org/wiki/Index:book.pdf"), null);
  assert.equal(parseMediaWikiDocumentUrl("https://user:secret@uk.wikisource.org/wiki/Index:book.pdf"), null);
  assert.equal(parseMediaWikiDocumentUrl("https://uk.wikisource.org/wiki/Archive_register"), null);
  const article = parseMediaWikiArticleUrl("https://uk.wikisource.org/wiki/Archive_register?oldid=42#section");
  assert.ok(article);
  assert.equal(article.pageTitle, "Archive register");
  assert.equal(article.canonicalPageUrl, "https://uk.wikisource.org/wiki/Archive_register");
  assert.equal(parseMediaWikiArticleUrl("https://uk.wikisource.org/wiki/Page:book.pdf/1"), null);
  assert.equal(parseMediaWikiArticleUrl("http://uk.wikisource.org/wiki/Archive_register"), null);
  assert.equal(isSupportedMediaWikiHost("evilwikisource.org"), false);
  assert.equal(isSupportedMediaWikiHost("UK.WIKISOURCE.ORG."), true);
});

test("builds and continues an article image-generator request", () => {
  const article = parseMediaWikiArticleUrl("https://en.wikisource.org/wiki/Archive_register");
  assert.ok(article);
  const url = new URL(buildMediaWikiArticlePdfCandidatesApiUrl(article, "File:next.pdf"));
  assert.equal(url.origin, "https://en.wikisource.org");
  assert.equal(url.searchParams.get("generator"), "images");
  assert.equal(url.searchParams.get("titles"), "Archive register");
  assert.equal(url.searchParams.get("gimcontinue"), "File:next.pdf");
  assert.equal(mediaWikiArticleContinuation({ continue: { gimcontinue: "File:next.pdf" } }), "File:next.pdf");
});

test("collects every trusted article imageinfo entry for adapter-side PDF filtering", () => {
  const candidates = parseMediaWikiImageInfoResponses({
    query: {
      pages: [
        {
          title: "File:Register A.pdf",
          imageinfo: [{
            url: "https://upload.wikimedia.org/a/Register_A.pdf",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Register_A.pdf",
            mime: "application/pdf",
            size: 100,
          }],
        },
        {
          title: "File:Register B.pdf",
          imageinfo: [{
            url: "https://upload.wikimedia.org/b/Register_B.pdf",
            mime: "application/pdf",
            size: 200,
          }],
        },
        {
          title: "File:Cover.jpg",
          imageinfo: [{ url: "https://upload.wikimedia.org/c/Cover.jpg", mime: "image/jpeg" }],
        },
      ],
    },
  });
  assert.deepEqual(candidates.map((candidate) => candidate.canonicalFileTitle), [
    "File:Register A.pdf",
    "File:Register B.pdf",
    "File:Cover.jpg",
  ]);
});

test("builds imageinfo requests for the base PDF and Commons fallback", () => {
  const parsed = parseMediaWikiDocumentUrl("https://uk.wikisource.org/wiki/Page:Book_scan.pdf/25");
  assert.ok(parsed);

  const candidates = mediaWikiImageInfoApiCandidates(parsed);
  assert.equal(candidates.length, 2);
  const primary = new URL(candidates[0] ?? "");
  const fallback = new URL(candidates[1] ?? "");
  assert.equal(primary.origin, "https://uk.wikisource.org");
  assert.equal(fallback.origin, "https://commons.wikimedia.org");
  assert.equal(primary.searchParams.get("titles"), "File:Book scan.pdf");
  assert.equal(primary.searchParams.get("prop"), "imageinfo");
  assert.equal(primary.searchParams.get("origin"), "*");
  assert.equal(buildMediaWikiImageInfoApiUrl(parsed), primary.href);
});

test("parses shared-repository imageinfo even when the local page is missing", () => {
  const parsed = parseMediaWikiImageInfoResponse({
    query: {
      pages: [{
        title: "Файл:ДАЖО 1-77-297.pdf",
        missing: true,
        known: true,
        imagerepository: "shared",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/a/a3/DAZO.pdf",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:DAZO.pdf",
          mime: "application/pdf",
          size: 581_530_245,
          pagecount: 372,
          sha1: "abc123",
          timestamp: "2026-07-29T12:00:00Z",
        }],
      }],
    },
  });

  assert.deepEqual(parsed, {
    canonicalFileTitle: "File:ДАЖО 1-77-297.pdf",
    fileName: "ДАЖО 1-77-297.pdf",
    fileUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a3/DAZO.pdf",
    descriptionUrl: "https://commons.wikimedia.org/wiki/File:DAZO.pdf",
    mimeType: "application/pdf",
    size: 581_530_245,
    pageCount: 372,
    sha1: "abc123",
    timestamp: "2026-07-29T12:00:00Z",
  });
});

test("parses the legacy query.pages object and rejects untrusted asset hosts", () => {
  assert.equal(parseMediaWikiImageInfoResponse({
    query: {
      pages: {
        "1": {
          title: "File:Book.pdf",
          imageinfo: [{ url: "https://files.example.org/Book.pdf", mime: "application/pdf" }],
        },
      },
    },
  }), null);

  const parsed = parseMediaWikiImageInfoResponse({
    query: {
      pages: {
        "1": {
          title: "File:Book.pdf",
          imageinfo: [{ url: "https://upload.wikimedia.org/a/Book.pdf", mime: "application/pdf" }],
        },
      },
    },
  });
  assert.equal(parsed?.canonicalFileTitle, "File:Book.pdf");
});

test("joins a Page reference, base PDF metadata, and initialPage", () => {
  const source = parseMediaWikiDocumentUrl("https://en.wikisource.org/wiki/Page:Book.pdf/900");
  assert.ok(source);
  const resolved = resolveMediaWikiPdfCandidate(source, {
    query: {
      pages: [{
        title: "File:Book.pdf",
        imageinfo: [{
          url: "https://upload.wikimedia.org/a/Book.pdf",
          mime: "application/pdf",
          pagecount: 1000,
        }],
      }],
    },
  });

  assert.ok(resolved);
  assert.equal(resolved.provider, "wikimedia");
  assert.equal(resolved.baseFileTitle, "File:Book.pdf");
  assert.equal(resolved.initialPage, 900);
  assert.equal(resolved.initialPageLabel, "900");
  assert.equal(resolved.file.pageCount, 1000);
});
