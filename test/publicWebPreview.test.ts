import assert from "node:assert/strict";
import test from "node:test";
import {
  directExternalUrlForPreview,
  fetchPublicWebPreview,
  parsePublicWebPreviewHtml,
} from "../supabase/functions/_shared/publicWebPreview.ts";

const PUBLIC_ADDRESSES = ["8.8.8.8"] as const;
const publicResolver = async (): Promise<readonly string[]> => PUBLIC_ADDRESSES;

function assertFallback(
  result: Awaited<ReturnType<typeof fetchPublicWebPreview>>,
  sourceUrl: string,
  expectedTitle: string,
): void {
  assert.equal(result.fetched, false);
  assert.equal(result.title, expectedTitle);
  assert.match(result.bodyText, /Збережене посилання з ресурсу/u);
  assert.match(result.bodyText, new RegExp(`${escapeRegExp(sourceUrl)}$`));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("preview candidate accepts only a direct non-Telegram link-only message", () => {
  assert.equal(
    directExternalUrlForPreview("  https://example.org/archive/record?lang=uk  ", false),
    "https://example.org/archive/record?lang=uk",
  );
  assert.equal(
    directExternalUrlForPreview("https://www.facebook.com/share/p/example", false),
    "https://www.facebook.com/share/p/example",
  );
  assert.equal(
    directExternalUrlForPreview("https://example.org/archive?q=(record)", false),
    "https://example.org/archive?q=(record",
    "preview extraction must match the SQL intake trailing-punctuation cleanup",
  );

  assert.equal(
    directExternalUrlForPreview("Корисне джерело: https://example.org/archive/record", false),
    null,
    "user-authored text must not be replaced by an unfurled page",
  );
  assert.equal(
    directExternalUrlForPreview("https://example.org/archive/record", true),
    null,
    "a forwarded Telegram post must retain Telegram provenance",
  );
  assert.equal(directExternalUrlForPreview("https://t.me/public_channel/42", false), null);
  assert.equal(directExternalUrlForPreview("https://telegram.me/public_channel/42", false), null);
});

test("HTML preview prefers Open Graph metadata and handles reversed attributes and entities", () => {
  const preview = parsePublicWebPreviewHtml(`
    <!doctype html>
    <html lang="uk">
      <head>
        <title>Резервна назва</title>
        <meta content="Звичайний опис" name="description">
        <meta content="Архівний запис &amp; родовід" property="og:title">
        <meta content='Короткий опис про сім\u2019ю &amp; документ.' property='og:description'>
      </head>
      <body><article><p>Текст сторінки, який має нижчий пріоритет.</p></article></body>
    </html>
  `, "https://example.org/post");

  assert.deepEqual(preview, {
    title: "Архівний запис & родовід",
    description: "Короткий опис про сім\u2019ю & документ.",
  });
});

test("HTML preview falls back to document title and meaningful article text", () => {
  const preview = parsePublicWebPreviewHtml(`
    <html>
      <head>
        <title>  Метрична книга&nbsp;1902 року  </title>
        <style>.secret { display: none }</style>
        <script>window.privateToken = "must-not-leak";</script>
      </head>
      <body>
        <nav>Головна Каталог Увійти</nav>
        <main>
          <article>
            <p>У фонді зберігаються записи про народження, шлюби та смерті.</p>
            <p>Матеріали охоплюють кілька населених пунктів.</p>
          </article>
        </main>
        <form action="/login">Увійти</form>
      </body>
    </html>
  `, new URL("https://archive.example.org/catalogue"));

  assert.equal(preview.title, "Метрична книга 1902 року");
  assert.match(preview.description ?? "", /записи про народження, шлюби та смерті/u);
  assert.doesNotMatch(preview.description ?? "", /privateToken|Головна Каталог|Увійти/u);
});

test("generic Facebook login and access-denied pages are not treated as source content", () => {
  for (const html of [
    `
      <html><head>
        <title>Facebook - log in or sign up</title>
        <meta property="og:title" content="Facebook">
        <meta name="description" content="Log into Facebook to start sharing and connecting.">
      </head><body><form action="/login">Log into Facebook</form></body></html>
    `,
    `
      <html><head><title>Access Denied</title></head>
      <body><p>Access denied: you don't have permission to access this page.</p></body></html>
    `,
  ]) {
    assert.deepEqual(
      parsePublicWebPreviewHtml(html, "https://www.facebook.com/share/p/example"),
      { title: null, description: null },
    );
  }
});

test("HTTP sources are retained as a domain fallback but are never fetched", async () => {
  const sourceUrl = "http://www.example.org/archive/record";
  let resolveCalls = 0;
  let fetchCalls = 0;
  const result = await fetchPublicWebPreview(sourceUrl, {
    resolver: async () => {
      resolveCalls += 1;
      return PUBLIC_ADDRESSES;
    },
    fetcher: async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    },
  });

  assert.equal(resolveCalls, 0);
  assert.equal(fetchCalls, 0);
  assertFallback(result, sourceUrl, "example.org");
});

test("the overall timeout also bounds a stalled DNS resolver", async () => {
  const sourceUrl = "https://example.org/stalled-dns";
  let fetchCalls = 0;
  const result = await fetchPublicWebPreview(sourceUrl, {
    resolver: async () => await new Promise<readonly string[]>(() => undefined),
    fetcher: async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    },
    timeoutMs: 10,
  });

  assert.equal(fetchCalls, 0);
  assertFallback(result, sourceUrl, "example.org");
});

test("HTTPS redirects are followed manually and every target is revalidated", async () => {
  const sourceUrl = "https://www.example.org/start";
  const requested: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const resolvedHosts: string[] = [];

  const result = await fetchPublicWebPreview(sourceUrl, {
    resolver: async (hostname) => {
      resolvedHosts.push(hostname);
      return PUBLIC_ADDRESSES;
    },
    fetcher: async (input, init) => {
      const url = String(input);
      requested.push({ url, redirect: init?.redirect });
      if (url === sourceUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://content.example.org/final" },
        });
      }
      assert.equal(url, "https://content.example.org/final");
      return new Response(`
        <meta property="og:title" content="Знайдений запис">
        <meta name="description" content="Короткий зміст сторінки.">
      `, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });

  assert.equal(result.fetched, true);
  assert.equal(result.title, "Знайдений запис");
  assert.match(result.bodyText, /Короткий зміст сторінки\./u);
  assert.match(result.bodyText, new RegExp(`${escapeRegExp(sourceUrl)}$`));
  assert.deepEqual(requested.map(({ url }) => url), [sourceUrl, "https://content.example.org/final"]);
  assert.ok(requested.every(({ redirect }) => redirect === "manual"));
  assert.ok(resolvedHosts.includes("www.example.org"));
  assert.ok(resolvedHosts.includes("content.example.org"));
});

test("localhost, private DNS and redirects to private addresses never reach a private fetch", async () => {
  let localhostFetches = 0;
  const localhostUrl = "https://localhost/private";
  const localhost = await fetchPublicWebPreview(localhostUrl, {
    resolver: publicResolver,
    fetcher: async () => {
      localhostFetches += 1;
      return new Response("unexpected");
    },
  });
  assert.equal(localhostFetches, 0);
  assertFallback(localhost, localhostUrl, "localhost");

  let privateDnsFetches = 0;
  const privateDnsUrl = "https://private.example.org/page";
  const privateDns = await fetchPublicWebPreview(privateDnsUrl, {
    resolver: async () => ["8.8.8.8", "10.20.30.40"],
    fetcher: async () => {
      privateDnsFetches += 1;
      return new Response("unexpected");
    },
  });
  assert.equal(privateDnsFetches, 0);
  assertFallback(privateDns, privateDnsUrl, "private.example.org");

  let redirectFetches = 0;
  const redirectUrl = "https://example.org/redirect";
  const redirect = await fetchPublicWebPreview(redirectUrl, {
    resolver: publicResolver,
    fetcher: async () => {
      redirectFetches += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://169.254.169.254/latest/meta-data" },
      });
    },
  });
  assert.equal(redirectFetches, 1, "the private redirect target must not be fetched");
  assertFallback(redirect, redirectUrl, "example.org");
});

test("non-HTML, oversized, timed-out and failed fetches preserve a useful fallback", async (t) => {
  const cases: Array<{
    name: string;
    fetcher: NonNullable<Parameters<typeof fetchPublicWebPreview>[1]["fetcher"]>;
    options?: { timeoutMs?: number; maxBytes?: number };
  }> = [
    {
      name: "non-html",
      fetcher: async () => new Response("%PDF-1.7", {
        headers: { "Content-Type": "application/pdf" },
      }),
    },
    {
      name: "declared oversized",
      fetcher: async () => new Response("<title>BAD</title>", {
        headers: { "Content-Type": "text/html", "Content-Length": "4096" },
      }),
      options: { maxBytes: 64 },
    },
    {
      name: "streamed oversized",
      fetcher: async () => new Response(
        "<title>Не використовувати</title>" + "x".repeat(4096),
        {
        headers: { "Content-Type": "text/html" },
        },
      ),
      options: { maxBytes: 64 },
    },
    {
      name: "network failure",
      fetcher: async () => {
        throw new TypeError("network unavailable");
      },
    },
    {
      name: "timeout",
      fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, "preview requests must always carry an AbortSignal");
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
      options: { timeoutMs: 10 },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const sourceUrl = `https://example.org/${fixture.name.replace(/\s+/gu, "-")}`;
      const result = await fetchPublicWebPreview(sourceUrl, {
        resolver: publicResolver,
        fetcher: fixture.fetcher,
        ...fixture.options,
      });
      assertFallback(result, sourceUrl, "example.org");
    });
  }
});

test("preview output respects database limits and always retains the original URL", async () => {
  const sourceUrl = "https://example.org/very-important-source";
  const result = await fetchPublicWebPreview(sourceUrl, {
    resolver: publicResolver,
    fetcher: async () => new Response(`
      <meta property="og:title" content="${"😀".repeat(500)}">
      <meta name="description" content="${"опис ".repeat(5_000)}">
    `, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  });

  assert.equal(result.fetched, true);
  assert.ok(Array.from(result.title).length <= 240, "title must fit telegram_saved_notes.title");
  assert.ok(Array.from(result.bodyText).length <= 12_000, "body must fit telegram_saved_notes.body_text");
  assert.match(result.bodyText, new RegExp(`${escapeRegExp(sourceUrl)}$`));
});
