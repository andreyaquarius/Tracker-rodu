import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  collectStaticZagulyakyEntries,
  generateZagulyakySeoPages,
  publicEntrySeoData,
  renderZagulyakySeoPage,
} from "../scripts/generate-zagulyaky-public-pages.mjs";

const PUBLIC_ORIGIN = "https://trekerrodu.com.ua";

const viteTemplate = `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Base description" />
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="${PUBLIC_ORIGIN}/" />
    <meta property="og:title" content="Base title" />
    <meta property="og:description" content="Base description" />
    <meta property="og:url" content="${PUBLIC_ORIGIN}/" />
    <meta name="twitter:title" content="Base title" />
    <meta name="twitter:description" content="Base description" />
    <title>Base title</title>
  </head>
  <body><div id="root"></div><script type="module" src="/assets/app.js"></script></body>
</html>`;

function publicPersonIndexingEntry() {
  const slug = "Іван & Петро";
  return {
    kind: "person",
    slug,
    url: `${PUBLIC_ORIGIN}/zahuliaky/people/${encodeURIComponent(slug)}/`,
    item: {
      slug,
      kind: "person",
      id: "private-record-id-do-not-render",
      title: "Непублічна резервна назва",
      summary: "Запис & <script>alert('not executable')</script> з метричної книги.",
      originalText: "Повний оригінальний текст запису про Івана Коваленка.",
      normalizedText: "Повний нормалізований текст запису про Івана Коваленка.",
      eventType: "marriage",
      eventYearFrom: 1902,
      eventYearTo: 1903,
      sourceLocation: "Київська губернія",
      foundLocation: "с. Трипілля",
      subject: {
        normalizedUkFullName: "Іван <Коваленко>",
        originalFullName: "Иванъ Коваленко",
      },
      primarySource: {
        citation: "ЦДІАК, ф. 127",
        sourceUrl: "https://private.example.test/archive/secret",
        storagePath: "private/zagulyaky/file.png",
      },
      createdBy: "private-user-id",
      rawPayload: "private raw payload",
    },
  };
}

function publicDocumentIndexingEntry() {
  const slug = "dako-127-1902";
  return {
    kind: "document",
    slug,
    url: `${PUBLIC_ORIGIN}/zahuliaky/documents/${slug}/`,
    item: {
      slug,
      kind: "document",
      id: "private-document-id-do-not-render",
      title: "Метрична книга 1902",
      summary: "Метрична книга народжень, шлюбів і смертей.",
      originalText: "Повний текст опису документа.",
      eventDateText: "1902",
      sourceLocation: "Київський повіт",
      foundLocation: "с. Трипілля",
      documentDiscovery: {
        officialLocationText: "Київський повіт",
        discoveredLocationText: "с. Трипілля",
        recordTypes: ["народження", "шлюб"],
      },
      primarySource: {
        title: "Державний архів",
        sourceUrl: "https://private.example.test/document/secret",
      },
      createdBy: "private-user-id",
      rawPayload: "private raw document payload",
    },
  };
}

function publicCataloguePersonItem() {
  const { item } = publicPersonIndexingEntry();
  const { kind: _kind, originalText: _originalText, normalizedText: _normalizedText, ...catalogueItem } = item;
  return catalogueItem;
}

function publicCatalogueDocumentItem() {
  const { item } = publicDocumentIndexingEntry();
  const { kind: _kind, originalText: _originalText, ...catalogueItem } = item;
  return catalogueItem;
}

test("public Zagulyaky static pages contain only escaped public SEO fields", () => {
  const page = publicEntrySeoData(publicPersonIndexingEntry());
  const html = renderZagulyakySeoPage(viteTemplate, page);

  assert.match(html, /<title>Іван &lt;Коваленко&gt; — загуляка \| Трекер Роду<\/title>/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${PUBLIC_ORIGIN}/zahuliaky/people/${encodeURIComponent("Іван & Петро")}/"`));
  assert.match(html, new RegExp(`<meta property="og:url" content="${PUBLIC_ORIGIN}/zahuliaky/people/${encodeURIComponent("Іван & Петро")}/"`));
  assert.match(html, /<meta name="robots" content="index, follow" \/>/);
  assert.match(html, /<meta name="zagulyaky-static-seo" content="https:\/\/trekerrodu\.com\.ua\/zahuliaky\/people\//);
  assert.match(html, /"@type":"ProfilePage"/);
  assert.match(html, /"@type":"Person"/);
  assert.match(html, /Іван &lt;Коваленко&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&#39;not executable&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\('not executable'\)<\/script>/);
  assert.doesNotMatch(html, /private-record-id-do-not-render|private-user-id|private raw payload/);
  assert.doesNotMatch(html, /https:\/\/private\.example\.test|private\/zagulyaky\/file\.png/);
});

test("static SEO generation uses the enriched public indexing RPC and writes private-safe canonical pages", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "zagulyaky-public-pages-"));
  const calls: Array<{ rpcName: string; parameters: Record<string, unknown> }> = [];

  try {
    const result = await generateZagulyakySeoPages({
      outputDirectory,
      templateHtml: viteTemplate,
      requestRpc: async (rpcName: string, parameters: Record<string, unknown>) => {
        calls.push({ rpcName, parameters });
        if (rpcName === "list_public_zagulyaky_indexing_v1" && parameters.p_kind === "person") {
          return { items: [publicPersonIndexingEntry().item], nextCursor: null };
        }
        if (rpcName === "list_public_zagulyaky_indexing_v1" && parameters.p_kind === "document") {
          return { items: [publicDocumentIndexingEntry().item], nextCursor: null };
        }
        throw new Error(`Unexpected RPC: ${rpcName}`);
      },
    });

    assert.equal(result.entries.length, 2);
    assert.equal(result.pages.length, 5);
    assert.equal(result.indexingMode, "full");
    assert.deepEqual(calls.map((call) => call.rpcName), [
      "list_public_zagulyaky_indexing_v1",
      "list_public_zagulyaky_indexing_v1",
    ]);
    assert.deepEqual(calls[0]?.parameters, {
      p_kind: "person",
      p_limit: 100,
      p_cursor_slug: null,
    });
    assert.deepEqual(calls[1]?.parameters, {
      p_kind: "document",
      p_limit: 100,
      p_cursor_slug: null,
    });

    const encodedPersonSlug = encodeURIComponent("Іван & Петро");
    const personPath = join(outputDirectory, "zahuliaky", "people", encodedPersonSlug, "index.html");
    const documentPath = join(outputDirectory, "zahuliaky", "documents", "dako-127-1902", "index.html");
    const peopleCataloguePath = join(outputDirectory, "zahuliaky", "index.html");
    const documentsCataloguePath = join(outputDirectory, "zahuliaky", "documents", "index.html");
    const placesCataloguePath = join(outputDirectory, "zahuliaky", "places", "index.html");
    const sitemapPath = join(outputDirectory, "sitemap-zagulyaky.xml");

    for (const path of [personPath, documentPath, peopleCataloguePath, documentsCataloguePath, placesCataloguePath, sitemapPath]) {
      assert.equal(existsSync(path), true, `Expected static output at ${path}`);
    }

    const personHtml = readFileSync(personPath, "utf8");
    const peopleCatalogueHtml = readFileSync(peopleCataloguePath, "utf8");
    const documentHtml = readFileSync(documentPath, "utf8");
    const placesCatalogueHtml = readFileSync(placesCataloguePath, "utf8");
    const sitemap = readFileSync(sitemapPath, "utf8");

    assert.match(personHtml, new RegExp(`<link rel="canonical" href="${PUBLIC_ORIGIN}/zahuliaky/people/${encodedPersonSlug}/"`));
    assert.match(personHtml, /Повний оригінальний текст запису про Івана Коваленка\./);
    assert.match(documentHtml, new RegExp(`<link rel="canonical" href="${PUBLIC_ORIGIN}/zahuliaky/documents/dako-127-1902/"`));
    assert.match(documentHtml, /Повний текст опису документа\./);
    assert.match(peopleCatalogueHtml, /<h1>Загуляки людей<\/h1>/);
    assert.match(peopleCatalogueHtml, new RegExp(`href="/zahuliaky/people/${encodedPersonSlug}/"`));
    assert.match(placesCatalogueHtml, /<title>Загуляки за населеними пунктами — карта зв’язків \| Трекер Роду<\/title>/);
    assert.match(placesCatalogueHtml, new RegExp(`<link rel="canonical" href="${PUBLIC_ORIGIN}/zahuliaky/places/"`));
    assert.match(placesCatalogueHtml, new RegExp(`<meta property="og:url" content="${PUBLIC_ORIGIN}/zahuliaky/places/"`));
    assert.match(placesCatalogueHtml, /<h1>Загуляки за населеними пунктами<\/h1>/);
    assert.match(placesCatalogueHtml, /Географічний зв’язок між двома місцями, а не маршрут/);
    assert.match(placesCatalogueHtml, /href="\/zahuliaky\/places">Місцевості<\/a>/);
    assert.match(documentHtml, /<h1>Метрична книга 1902<\/h1>/);
    assert.match(documentHtml, /"@type":"CreativeWork"/);
    assert.match(sitemap, new RegExp(`<loc>${PUBLIC_ORIGIN}/zahuliaky/people/${encodedPersonSlug}/<\/loc>`));
    assert.match(sitemap, new RegExp(`<loc>${PUBLIC_ORIGIN}/zahuliaky/documents/dako-127-1902/<\/loc>`));
    assert.doesNotMatch(sitemap, /private-record-id-do-not-render|private-document-id-do-not-render|private\.example/);
    assert.doesNotMatch(personHtml + peopleCatalogueHtml + documentHtml + placesCatalogueHtml, /private-record-id-do-not-render|private-document-id-do-not-render|private-user-id|private raw payload|private raw document payload|private\.example|storagePath/);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("static SEO generation falls back to catalogue rows only when the bulk indexing RPC is unavailable", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "zagulyaky-public-pages-fallback-"));
  const calls: Array<{ rpcName: string; parameters: Record<string, unknown> }> = [];

  try {
    const result = await generateZagulyakySeoPages({
      outputDirectory,
      templateHtml: viteTemplate,
      requestRpc: async (rpcName: string, parameters: Record<string, unknown>) => {
        calls.push({ rpcName, parameters });
        if (rpcName === "list_public_zagulyaky_indexing_v1") {
          throw new Error("PGRST202: Could not find the function public.list_public_zagulyaky_indexing_v1");
        }
        if (rpcName === "search_zagulyaky_people_v1") {
          return { items: [publicCataloguePersonItem()], nextCursor: null };
        }
        if (rpcName === "search_zagulyaky_documents_v1") {
          return { items: [publicCatalogueDocumentItem()], nextCursor: null };
        }
        throw new Error(`Unexpected fallback RPC: ${rpcName}`);
      },
    });

    assert.equal(result.indexingMode, "catalogue-fallback");
    assert.deepEqual(calls.map((call) => call.rpcName), [
      "list_public_zagulyaky_indexing_v1",
      "search_zagulyaky_people_v1",
      "search_zagulyaky_documents_v1",
    ]);
    assert.deepEqual(calls[0]?.parameters, {
      p_kind: "person",
      p_limit: 100,
      p_cursor_slug: null,
    });

    const personHtml = readFileSync(join(outputDirectory, "zahuliaky", "people", encodeURIComponent("Іван & Петро"), "index.html"), "utf8");
    assert.doesNotMatch(personHtml, /Повний оригінальний текст запису про Івана Коваленка/);
    assert.doesNotMatch(personHtml, /private-record-id-do-not-render|private-user-id|private\.example/);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("static SEO generation may use the public catalogue after exhausted PGRST002 retries", async () => {
  const calls: string[] = [];
  const result = await collectStaticZagulyakyEntries({
    requestRpc: async (rpcName: string) => {
      calls.push(rpcName);
      if (rpcName === "list_public_zagulyaky_indexing_v1") {
        throw new Error(
          "The public list_public_zagulyaky_indexing_v1 RPC returned HTTP 503 after 6 attempts: PGRST002 — Could not query the database for the schema cache. Retrying.",
        );
      }
      return { items: [], nextCursor: null };
    },
  });

  assert.equal(result.indexingMode, "catalogue-fallback");
  assert.deepEqual(result.entries, []);
  assert.deepEqual(calls, [
    "list_public_zagulyaky_indexing_v1",
    "search_zagulyaky_people_v1",
    "search_zagulyaky_documents_v1",
  ]);
});

test("static SEO generation falls back immediately after an indexing statement timeout", async () => {
  const calls: string[] = [];
  const result = await collectStaticZagulyakyEntries({
    requestRpc: async (rpcName: string) => {
      calls.push(rpcName);
      if (rpcName === "list_public_zagulyaky_indexing_v1") {
        throw new Error(
          "The public list_public_zagulyaky_indexing_v1 RPC returned HTTP 500: 57014 — canceling statement due to statement timeout.",
        );
      }
      return { items: [], nextCursor: null };
    },
  });

  assert.equal(result.indexingMode, "catalogue-fallback");
  assert.deepEqual(result.entries, []);
  assert.deepEqual(calls, [
    "list_public_zagulyaky_indexing_v1",
    "search_zagulyaky_people_v1",
    "search_zagulyaky_documents_v1",
  ]);
});

test("static SEO generation still fails when the public catalogue fallback is unavailable", async () => {
  const calls: string[] = [];
  await assert.rejects(
    collectStaticZagulyakyEntries({
      requestRpc: async (rpcName: string) => {
        calls.push(rpcName);
        if (rpcName === "list_public_zagulyaky_indexing_v1") {
          throw new Error("HTTP 503: PGRST002 — Could not query the database for the schema cache.");
        }
        throw new Error("HTTP 503: upstream service unavailable after retries");
      },
    }),
    /upstream service unavailable after retries/i,
  );
  assert.deepEqual(calls, [
    "list_public_zagulyaky_indexing_v1",
    "search_zagulyaky_people_v1",
  ]);
});

test("static SEO generation does not downgrade on unrelated indexing failures", async () => {
  const calls: string[] = [];
  await assert.rejects(
    collectStaticZagulyakyEntries({
      requestRpc: async (rpcName: string) => {
        calls.push(rpcName);
        throw new Error("The public indexing RPC returned a record of the wrong kind.");
      },
    }),
    /wrong kind/i,
  );
  assert.deepEqual(calls, ["list_public_zagulyaky_indexing_v1"]);
});
