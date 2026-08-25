import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectPublishedZagulyakyEntries,
  publicZagulyakaUrl,
  readSitemapEnvironment,
  renderZagulyakySitemap,
  requestPublicZagulyakyRpc,
  writeSitemapAtomically,
  ZAGULYAKY_SITEMAP_ORIGIN,
} from "./generate-zagulyaky-sitemap.mjs";

export const DEFAULT_ZAGULYAKY_SEO_OUTPUT_DIR = "dist";
export const ZAGULYAKY_SEO_CATALOGUE_PREVIEW_LIMIT = 50;
export const ZAGULYAKY_INDEXING_RPC = "list_public_zagulyaky_indexing_v1";
export const ZAGULYAKY_INDEXING_PAGE_SIZE = 100;
const MAX_INDEXING_PAGES_PER_KIND = 20_000;

const SITE_NAME = "Трекер Роду";
const STATIC_SEO_MARKER_NAME = "zagulyaky-static-seo";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringList(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function firstText(...values) {
  return values.map(text).find(Boolean) ?? "";
}

function field(row, ...keys) {
  const source = record(row);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shorten(value, maximum = 230) {
  const normalized = text(value).replace(/\s+/g, " ");
  if (normalized.length <= maximum) return normalized;
  const boundary = normalized.lastIndexOf(" ", maximum - 1);
  return `${normalized.slice(0, boundary > 80 ? boundary : maximum - 1).trimEnd()}…`;
}

function eventLabel(eventType) {
  const labels = {
    birth: "народження",
    baptism: "хрещення",
    marriage: "шлюб",
    death: "смерть",
    burial: "поховання",
    residence: "проживання",
    census: "перепис",
    military: "військова служба",
    migration: "переселення",
    witness: "свідчення",
    godparent: "хрещені батьки",
    other: "інша подія",
  };
  return labels[text(eventType)] ?? "";
}

function yearRange(from, to) {
  const first = Number.isInteger(from) ? String(from) : "";
  const last = Number.isInteger(to) ? String(to) : "";
  if (first && last && first !== last) return `${first}–${last}`;
  return first || last;
}

function relativeDetailPath(kind, slug) {
  const typePath = kind === "document" ? "documents" : "people";
  return join("zahuliaky", typePath, encodeURIComponent(slug), "index.html");
}

function pageFact(label, value) {
  const normalized = shorten(value, 500);
  return normalized ? { label, value: normalized } : null;
}

function publicText(value, maximum = 14_000) {
  const normalized = text(value).replace(/\r\n?/g, "\n");
  if (normalized.length <= maximum) return normalized;
  const boundary = normalized.lastIndexOf("\n", maximum - 1);
  return `${normalized.slice(0, boundary > 100 ? boundary : maximum - 1).trimEnd()}…`;
}

function safePublicUrl(value) {
  try {
    const parsed = new URL(text(value));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function indexingPayload(rawPayload) {
  const payload = record(rawPayload);
  const items = Array.isArray(field(payload, "items", "records"))
    ? field(payload, "items", "records").map(record)
    : null;
  if (!items) throw new Error("The public Zagulyaky indexing RPC returned an invalid payload.");

  const nextCursor = text(field(payload, "nextCursor", "next_cursor"));
  return { items, nextCursor: nextCursor || null };
}

function missingIndexingRpc(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\bPGRST202\b|\b42883\b|could not find the function|function .* does not exist|HTTP 404/i.test(message);
}

/**
 * Reads all public SEO rows through one paginated, redacted endpoint. This is
 * intentionally separate from the interactive card RPC: generating thousands
 * of files must not make one slow request per card.
 */
export async function collectPublicZagulyakyIndexingEntries({
  requestRpc,
  siteOrigin = ZAGULYAKY_SITEMAP_ORIGIN,
}) {
  if (typeof requestRpc !== "function") throw new Error("A public RPC requester is required.");

  const entriesByUrl = new Map();
  for (const kind of ["person", "document"]) {
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_INDEXING_PAGES_PER_KIND; page += 1) {
      const payload = indexingPayload(await requestRpc(ZAGULYAKY_INDEXING_RPC, {
        p_kind: kind,
        p_limit: ZAGULYAKY_INDEXING_PAGE_SIZE,
        p_cursor_slug: cursor,
      }));
      for (const item of payload.items) {
        const slug = text(field(item, "slug"));
        const itemKind = text(field(item, "kind"));
        if (itemKind !== kind) throw new Error("The public Zagulyaky indexing RPC returned a record of the wrong kind.");
        const url = publicZagulyakaUrl(kind, slug, siteOrigin);
        entriesByUrl.set(url, { kind, slug, url, item });
      }
      if (!payload.nextCursor) break;
      const cursorKey = payload.nextCursor;
      if (seenCursors.has(cursorKey)) throw new Error("The public Zagulyaky indexing RPC repeated its cursor.");
      seenCursors.add(cursorKey);
      cursor = payload.nextCursor;
    }
    if (cursor && seenCursors.size >= MAX_INDEXING_PAGES_PER_KIND) {
      throw new Error("The public Zagulyaky indexing RPC exceeded the safe pagination limit.");
    }
  }
  return [...entriesByUrl.values()].sort((left, right) => left.url.localeCompare(right.url, "en"));
}

export async function collectStaticZagulyakyEntries(options) {
  try {
    const entries = await collectPublicZagulyakyIndexingEntries(options);
    return { entries, indexingMode: "full" };
  } catch (error) {
    if (!missingIndexingRpc(error)) throw error;
    // The code can safely deploy before the accompanying database migration is
    // applied. It still publishes names/places from the existing public
    // catalogue; the next deploy gains the public transcription automatically.
    const entries = await collectPublishedZagulyakyEntries(options);
    return { entries, indexingMode: "catalogue-fallback" };
  }
}

function breadcrumbList({ title, url, collectionUrl, collectionTitle }) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Головна",
        item: `${ZAGULYAKY_SITEMAP_ORIGIN}/`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: collectionTitle,
        item: collectionUrl,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: title,
        item: url,
      },
    ],
  };
}

/**
 * Converts a public list/indexing row into a textual SEO page. Intentionally
 * do not include record IDs, contributors,
 * source URLs, raw private payloads, or non-public attachment metadata here.
 */
export function publicEntrySeoData(entry) {
  const item = record(entry.item);
  const kind = entry.kind === "document" ? "document" : "person";
  const publicField = (...keys) => field(item, ...keys);
  const source = record(field(item, "primarySource", "primary_source"));
  const subject = record(field(item, "subject"));
  const discovery = record(field(item, "documentDiscovery", "document_discovery"));
  const siteOrigin = new URL(entry.url).origin;
  const collectionUrl = `${siteOrigin}/zahuliaky${kind === "document" ? "/documents" : ""}`;
  const collectionTitle = kind === "document" ? "Загуляки документів" : "Загуляки людей";
  const sourceCitation = firstText(field(source, "citation"), field(source, "title"), field(source, "archiveName", "archive_name"));
  const sourceLocation = firstText(
    field(subject, "originText", "origin_text"),
    publicField("sourceLocationNormalized", "source_location_normalized"),
    publicField("sourceLocationText", "source_location_text"),
    publicField("sourceLocation", "source_location"),
  );
  const foundLocation = firstText(
    publicField("foundLocationNormalized", "found_location_normalized"),
    publicField("foundLocationText", "found_location_text"),
    publicField("foundLocation", "found_location"),
  );
  const recordSummary = publicText(publicField("summary"), 2_000);
  const originalText = publicText(publicField("originalText", "original_text"));
  const normalizedText = publicText(publicField("normalizedText", "normalized_text"));
  const transcription = originalText || normalizedText;
  const transcriptionLabel = originalText ? "Оригінальний текст запису" : "Текст запису";
  const originalPostUrl = safePublicUrl(publicField("originalPostUrl", "original_post_url"));
  const eventDate = firstText(
    publicField("eventDateText", "event_date_text"),
    yearRange(publicField("eventYearFrom", "event_year_from"), publicField("eventYearTo", "event_year_to")),
  );

  if (kind === "person") {
    const name = firstText(
      field(subject, "normalizedUkFullName", "normalized_uk_full_name"),
      field(subject, "originalFullName", "original_full_name"),
      publicField("title"),
      "Запис про особу",
    );
    const originalName = text(field(subject, "originalFullName", "original_full_name"));
    const event = eventLabel(publicField("eventType", "event_type"));
    const description = shorten([
      `Публічна генеалогічна картка: ${name}.`,
      event ? `Подія: ${event}.` : "",
      eventDate ? `Дата: ${eventDate}.` : "",
      sourceLocation ? `Походження: ${sourceLocation}.` : "",
      foundLocation ? `Запис знайдено: ${foundLocation}.` : "",
      recordSummary,
    ].filter(Boolean).join(" "));
    const facts = [
      originalName && originalName !== name ? pageFact("Написання в джерелі", originalName) : null,
      pageFact("Подія", event),
      pageFact("Дата", eventDate),
      pageFact("Походження", sourceLocation),
      pageFact("Де знайдено запис", foundLocation),
      pageFact("Джерело", sourceCitation),
    ].filter(Boolean);

    return {
      kind,
      url: entry.url,
      relativePath: relativeDetailPath(kind, entry.slug),
      title: `${name} — загуляка | ${SITE_NAME}`,
      heading: name,
      eyebrow: "Публічна картка загуляки",
      collectionUrl,
      collectionTitle,
      description,
      summary: recordSummary,
      facts,
      transcription,
      transcriptionLabel,
      links: originalPostUrl ? [{ label: "Оригінальний допис Facebook", url: originalPostUrl }] : [],
      structuredData: {
        "@context": "https://schema.org",
        "@graph": [
          breadcrumbList({ title: name, url: entry.url, collectionUrl, collectionTitle }),
          {
            "@type": "ProfilePage",
            name,
            url: entry.url,
            description,
            inLanguage: "uk",
            isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${siteOrigin}/` },
            mainEntity: {
              "@type": "Person",
              name,
              description: shorten(transcription || description, 1_000),
            },
          },
        ],
      },
    };
  }

  const title = firstText(publicField("title"), "Загуляка документа");
  const documentType = firstText(field(discovery, "notes"), publicField("summary"));
  const officialPlace = firstText(field(discovery, "officialLocationText", "official_location_text"), sourceLocation);
  const discoveredPlace = firstText(field(discovery, "discoveredLocationText", "discovered_location_text"), foundLocation);
  const recordTypes = stringList(field(discovery, "recordTypes", "record_types")).join(", ");
  const description = shorten([
    `Публічна картка документа: ${title}.`,
    documentType ? `Тип: ${documentType}.` : "",
    officialPlace ? `Місце: ${officialPlace}.` : "",
    eventDate ? `Роки: ${eventDate}.` : "",
    recordSummary && recordSummary !== documentType ? recordSummary : "",
  ].filter(Boolean).join(" "));
  const facts = [
    pageFact("Тип документа", documentType),
    pageFact("Місце в офіційному описі", officialPlace),
    pageFact("Додатково знайдено", discoveredPlace),
    pageFact("Роки", eventDate),
    pageFact("Типи записів", recordTypes),
    pageFact("Джерело", sourceCitation),
  ].filter(Boolean);

  return {
    kind,
    url: entry.url,
    relativePath: relativeDetailPath(kind, entry.slug),
    title: `${title} — загуляка документа | ${SITE_NAME}`,
    heading: title,
    eyebrow: "Публічна картка документа",
    collectionUrl,
    collectionTitle,
    description,
    summary: recordSummary,
    facts,
    transcription,
    transcriptionLabel,
    links: originalPostUrl ? [{ label: "Оригінальний допис Facebook", url: originalPostUrl }] : [],
    structuredData: {
      "@context": "https://schema.org",
      "@graph": [
        breadcrumbList({ title, url: entry.url, collectionUrl, collectionTitle }),
        {
          "@type": "CreativeWork",
          name: title,
          url: entry.url,
          description,
          inLanguage: "uk",
          isPartOf: { "@type": "CollectionPage", name: collectionTitle, url: collectionUrl },
        },
      ],
    },
  };
}

function catalogueSeoData(kind, entries) {
  const isDocument = kind === "document";
  const url = `${ZAGULYAKY_SITEMAP_ORIGIN}/zahuliaky${isDocument ? "/documents" : ""}`;
  const heading = isDocument ? "Загуляки документів" : "Загуляки людей";
  const description = isDocument
    ? "Публічний генеалогічний каталог документів і справ, у яких знайдено записи з інших населених пунктів або неочікуваних періодів."
    : "Публічний генеалогічний каталог людей, знайдених у документах поза очікуваним місцем пошуку, з відомостями про події, місця та джерела.";
  const selected = entries
    .filter((entry) => entry.kind === kind)
    .slice(0, ZAGULYAKY_SEO_CATALOGUE_PREVIEW_LIMIT)
    .map(publicEntrySeoData);
  const total = entries.filter((entry) => entry.kind === kind).length;

  return {
    kind: "catalogue",
    url,
    relativePath: join("zahuliaky", ...(isDocument ? ["documents"] : []), "index.html"),
    title: `${heading} — публічний генеалогічний каталог | ${SITE_NAME}`,
    heading,
    eyebrow: "Публічний генеалогічний каталог",
    collectionUrl: url,
    collectionTitle: heading,
    description,
    summary: total
      ? `У каталозі опубліковано ${total} ${isDocument ? "документів і справ" : "записів про людей"}.`
      : "Опублікованих записів у цьому розділі поки немає.",
    facts: [],
    cards: selected,
    structuredData: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: heading,
      url,
      description,
      inLanguage: "uk",
      isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${ZAGULYAKY_SITEMAP_ORIGIN}/` },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: total,
        itemListElement: selected.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: item.url,
          name: item.heading,
        })),
      },
    },
  };
}

function placesSeoData() {
  const url = `${ZAGULYAKY_SITEMAP_ORIGIN}/zahuliaky/places`;
  const heading = "Загуляки за населеними пунктами";
  const description = "Публічна карта зв’язків між населеними пунктами у загуляках: походження людини та місце, де знайдено запис. Лінії показують лише підтверджений зв’язок, а не маршрут.";

  return {
    kind: "catalogue",
    url,
    relativePath: join("zahuliaky", "places", "index.html"),
    title: `${heading} — карта зв’язків | ${SITE_NAME}`,
    heading,
    eyebrow: "Публічна карта зв’язків",
    collectionUrl: url,
    collectionTitle: heading,
    description,
    summary: "Оберіть населений пункт, щоб побачити місця походження людей, чиї записи знайдено там, і місця, де знайдено записи про вихідців із нього.",
    facts: [
      pageFact("У вибірці", "Лише опубліковані картки з підтвердженими точками походження та місця знахідки."),
      pageFact("Значення ліній", "Географічний зв’язок між двома місцями, а не маршрут або доказ переміщення людини."),
    ].filter(Boolean),
    cards: [],
    structuredData: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: heading,
      url,
      description,
      inLanguage: "uk",
      isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${ZAGULYAKY_SITEMAP_ORIGIN}/` },
    },
  };
}

function styleBlock() {
  return `<style data-zagulyaky-static-seo>
    .zagulyaky-static-seo{box-sizing:border-box;min-height:100vh;padding:clamp(24px,5vw,60px);color:#20312d;background:#f4f2ea;font-family:Arial,system-ui,sans-serif}
    .zagulyaky-static-seo *{box-sizing:border-box}.zagulyaky-static-seo__inner{width:min(100%,1024px);margin:0 auto}
    .zagulyaky-static-seo a{color:#174b41;font-weight:700}.zagulyaky-static-seo nav{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:38px}
    .zagulyaky-static-seo nav a{padding:8px 11px;border:1px solid #d7ddd8;border-radius:999px;background:#fffdf8;text-decoration:none}
    .zagulyaky-static-seo__eyebrow{margin:0 0 10px;color:#8d6128;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    .zagulyaky-static-seo h1{max-width:850px;margin:0;color:#102f2a;font-family:Georgia,serif;font-size:clamp(2rem,5vw,3.25rem);line-height:1.08}
    .zagulyaky-static-seo__description{max-width:850px;margin:16px 0 0;color:#4f5f5a;font-size:17px;line-height:1.6}
    .zagulyaky-static-seo__summary{max-width:850px;margin:14px 0 0;color:#40524c;line-height:1.65;white-space:pre-wrap}
    .zagulyaky-static-seo dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:28px 0 0}.zagulyaky-static-seo dl div,.zagulyaky-static-seo article{min-width:0;padding:16px;background:#fffdf8;border:1px solid #deddd5;border-radius:12px;box-shadow:0 8px 22px rgba(25,53,46,.05)}
    .zagulyaky-static-seo dt{color:#5c6f67;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}.zagulyaky-static-seo dd{margin:7px 0 0;color:#183b34;font-weight:700;line-height:1.45;overflow-wrap:anywhere}
    .zagulyaky-static-seo__cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:28px 0 0;padding:0;list-style:none}.zagulyaky-static-seo__cards h2{margin:0;color:#123a32;font-family:Georgia,serif;font-size:20px;line-height:1.25}.zagulyaky-static-seo__cards p{margin:9px 0 0;color:#52635d;line-height:1.5}
    .zagulyaky-static-seo__transcription{margin-top:28px;padding:20px;background:#fffdf8;border:1px solid #deddd5;border-radius:12px;box-shadow:0 8px 22px rgba(25,53,46,.05)}.zagulyaky-static-seo__transcription h2{margin:0;color:#123a32;font-family:Georgia,serif;font-size:23px}.zagulyaky-static-seo__transcription p{margin:12px 0 0;color:#334b44;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
    .zagulyaky-static-seo__links{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.zagulyaky-static-seo__links a{padding:9px 12px;border:1px solid #b4cbbf;border-radius:9px;background:#edf7f1;text-decoration:none}
    .zagulyaky-static-seo__back{display:inline-block;margin-top:30px}@media(max-width:680px){.zagulyaky-static-seo dl,.zagulyaky-static-seo__cards{grid-template-columns:1fr}}
  </style>`;
}

function renderFacts(facts) {
  if (!facts.length) return "";
  return `<dl>${facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`).join("")}</dl>`;
}

function renderCards(cards) {
  if (!cards?.length) return "";
  return `<ol class="zagulyaky-static-seo__cards">${cards.map((card) => `<li><article><h2><a href="${escapeHtml(new URL(card.url).pathname)}">${escapeHtml(card.heading)}</a></h2>${card.summary ? `<p>${escapeHtml(card.summary)}</p>` : ""}</article></li>`).join("")}</ol>`;
}

function renderTranscription(page) {
  if (!page.transcription) return "";
  return `<section class="zagulyaky-static-seo__transcription" aria-labelledby="zagulyaky-transcription"><h2 id="zagulyaky-transcription">${escapeHtml(page.transcriptionLabel || "Текст запису")}</h2><p>${escapeHtml(page.transcription)}</p></section>`;
}

function renderLinks(links) {
  if (!links?.length) return "";
  return `<nav class="zagulyaky-static-seo__links" aria-label="Пов'язані публічні посилання">${links.map((link) => `<a href="${escapeHtml(link.url)}" rel="noopener noreferrer external">${escapeHtml(link.label)}</a>`).join("")}</nav>`;
}

export function renderZagulyakyStaticFallback(page) {
  const collectionHref = new URL(page.collectionUrl).pathname;
  const backHref = page.kind === "catalogue" ? "/" : collectionHref;
  const backLabel = page.kind === "catalogue" ? "Перейти на головну" : `До розділу «${page.collectionTitle}»`;
  return `${styleBlock()}<main class="zagulyaky-static-seo"><div class="zagulyaky-static-seo__inner"><nav aria-label="Публічна навігація"><a href="/">Головна</a><a href="/zahuliaky">Загуляки людей</a><a href="/zahuliaky/documents">Загуляки документів</a><a href="/zahuliaky/places">Місцевості</a><a href="/features">Можливості</a><a href="/faq">FAQ</a></nav><p class="zagulyaky-static-seo__eyebrow">${escapeHtml(page.eyebrow)}</p><h1>${escapeHtml(page.heading)}</h1><p class="zagulyaky-static-seo__description">${escapeHtml(page.description)}</p>${page.summary ? `<p class="zagulyaky-static-seo__summary">${escapeHtml(page.summary)}</p>` : ""}${renderFacts(page.facts)}${renderTranscription(page)}${renderLinks(page.links)}${renderCards(page.cards)}<a class="zagulyaky-static-seo__back" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></div></main>`;
}

function replaceRequired(html, pattern, replacement, label) {
  if (!pattern.test(html)) throw new Error(`The public page template is missing ${label}.`);
  return html.replace(pattern, replacement);
}

function replaceMeta(html, attribute, name, content) {
  const pattern = new RegExp(`<meta\\b(?=[^>]*\\b${escapeRegExp(attribute)}=["']${escapeRegExp(name)}["'])[^>]*>`, "i");
  return replaceRequired(
    html,
    pattern,
    `<meta ${attribute}="${escapeHtml(name)}" content="${escapeHtml(content)}" />`,
    `${attribute}=${name}`,
  );
}

function replaceCanonical(html, canonical) {
  return replaceRequired(
    html,
    /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/i,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    "canonical link",
  );
}

function renderJsonLd(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** Builds a real HTTP-200 document from Vite's built HTML template. */
export function renderZagulyakySeoPage(template, page) {
  // `index.html` has a homepage-oriented <noscript> fallback and JSON-LD.
  // A generated catalogue/card must have one meaningful H1 and one matching
  // structured-data payload instead of carrying those homepage fragments.
  let html = template
    .replace(/<noscript>[\s\S]*?<\/noscript>\s*/i, "")
    .replace(/<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>\s*/gi, "")
    .replace(new RegExp(`<meta\\b(?=[^>]*\\bname=["']${STATIC_SEO_MARKER_NAME}["'])[^>]*>\\s*`, "gi"), "");
  html = replaceRequired(html, /<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(page.title)}</title>`, "title");
  html = replaceMeta(html, "name", "description", page.description);
  html = replaceMeta(html, "name", "robots", "index, follow");
  html = replaceCanonical(html, page.url);
  html = replaceMeta(html, "property", "og:title", page.title);
  html = replaceMeta(html, "property", "og:description", page.description);
  html = replaceMeta(html, "property", "og:url", page.url);
  html = replaceMeta(html, "name", "twitter:title", page.title);
  html = replaceMeta(html, "name", "twitter:description", page.description);
  html = replaceRequired(
    html,
    /<\/head>/i,
    `<meta name="${STATIC_SEO_MARKER_NAME}" content="${escapeHtml(page.url)}" />\n    <script type="application/ld+json">${renderJsonLd(page.structuredData)}</script>\n  </head>`,
    "head closing tag",
  );
  return replaceRequired(
    html,
    /<div\b(?=[^>]*\bid=["']root["'])[^>]*>\s*<\/div>/i,
    `<div id="root">${renderZagulyakyStaticFallback(page)}</div>`,
    "React root",
  );
}

function readBuiltTemplate(outputDirectory) {
  const path = join(resolve(outputDirectory), "index.html");
  if (!existsSync(path)) {
    throw new Error(`Build output is missing ${path}. Run the Vite build before generating public Zagulyaky pages.`);
  }
  return readFileSync(path, "utf8");
}

function clearPreviousGeneratedZagulyakyPages(outputDirectory) {
  const target = resolve(outputDirectory, "zahuliaky");
  const targetRelativePath = relative(outputDirectory, target);
  if (!targetRelativePath || targetRelativePath.startsWith("..") || isAbsolute(targetRelativePath)) {
    throw new Error("Refusing to clear an unsafe Zagulyaky static output path.");
  }
  if (!existsSync(target)) return;

  // `dist` may contain unrelated hand-authored files. Delete only a directory
  // that was previously created by this generator; otherwise stale public
  // cards could remain after unpublishing a record, but no unrelated output is
  // ever removed.
  const markerPath = join(target, "index.html");
  const marker = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : "";
  if (!marker.includes(`name="${STATIC_SEO_MARKER_NAME}"`)) {
    throw new Error(`Refusing to clear an unmarked static output directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

export async function generateZagulyakySeoPages({
  requestRpc,
  outputDirectory = DEFAULT_ZAGULYAKY_SEO_OUTPUT_DIR,
  templateHtml,
  siteOrigin = ZAGULYAKY_SITEMAP_ORIGIN,
}) {
  const resolvedOutputDirectory = resolve(outputDirectory);
  const template = typeof templateHtml === "string" ? templateHtml : readBuiltTemplate(resolvedOutputDirectory);
  const { entries, indexingMode } = await collectStaticZagulyakyEntries({ requestRpc, siteOrigin });
  const pages = [
    catalogueSeoData("person", entries),
    catalogueSeoData("document", entries),
    placesSeoData(),
    ...entries.map(publicEntrySeoData),
  ];

  clearPreviousGeneratedZagulyakyPages(resolvedOutputDirectory);
  for (const page of pages) {
    writeSitemapAtomically(join(resolvedOutputDirectory, page.relativePath), renderZagulyakySeoPage(template, page));
  }
  const sitemapPath = writeSitemapAtomically(
    join(resolvedOutputDirectory, "sitemap-zagulyaky.xml"),
    renderZagulyakySitemap(entries.map((entry) => entry.url)),
  );

  return {
    outputDirectory: resolvedOutputDirectory,
    sitemapPath,
    entries,
    pages,
    indexingMode,
  };
}

export function parseSeoPageArguments(argumentsList) {
  let outputDirectory = DEFAULT_ZAGULYAKY_SEO_OUTPUT_DIR;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--output-dir") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-dir requires a directory path.");
      outputDirectory = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true, outputDirectory };
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, outputDirectory };
}

export async function main({ argumentsList = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const options = parseSeoPageArguments(argumentsList);
  if (options.help) {
    log("Usage: node scripts/generate-zagulyaky-public-pages.mjs [--output-dir dist]");
    return null;
  }
  const config = readSitemapEnvironment(env);
  const result = await generateZagulyakySeoPages({
    outputDirectory: options.outputDirectory,
    requestRpc: (rpcName, parameters) => requestPublicZagulyakyRpc({
      ...config,
      rpcName,
      parameters,
    }),
  });
  log(
    `Generated ${result.entries.length} public Zagulyaky detail page(s), 3 catalogue page(s), and ${result.sitemapPath} (${result.indexingMode} indexing data).`,
  );
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown public Zagulyaky page generation error.";
    console.error(`Public Zagulyaky page generation failed: ${message}`);
    process.exitCode = 1;
  });
}
