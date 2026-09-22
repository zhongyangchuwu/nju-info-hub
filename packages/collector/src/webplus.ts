import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type {
  Attachment,
  DiscoveredItem,
  DiscoveryPage,
  ParsedNotice,
  RawDocument,
  WebPlusSourceConfig,
} from "@nju-info/core";

const DATE_RE = /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/;
const DEFAULT_LIST_LINK_SELECTOR = [
  ".news_list a[href]",
  ".wp_article_list a[href]",
  ".listcon a[href]",
].join(", ");
const DEFAULT_TITLE_SELECTOR = ".arti_title, .Article_Title, .news_title, h1";
const DEFAULT_PUBLISHED_AT_SELECTOR =
  ".arti_update, .Article_PublishDate, .article-date, .news_meta";
const DEFAULT_CONTENT_SELECTOR =
  ".wp_articlecontent, #vsb_content, .article_content, .arti_content";

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(baseUrl: string, href: string): string {
  return new URL(href, baseUrl).toString();
}

function sameOriginUrl(baseUrl: string, href: string): string | undefined {
  const base = new URL(baseUrl);
  const target = new URL(href, base);
  return target.origin === base.origin ? target.toString() : undefined;
}

function looksLikeArticleUrl(url: URL): boolean {
  return /\/page(?:m)?\.htm$/i.test(url.pathname);
}

function publishedDateNearAnchor(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  listItemSelector?: string,
): string | undefined {
  const container = $(element).closest(
    listItemSelector ?? "li, tr, .news, .list_item, .list-item, .item",
  );
  const text = normalizeText(
    container.length ? container.text() : $(element).parent().text(),
  );
  return text.match(DATE_RE)?.[0];
}

export function discoverWebPlusPage(
  raw: RawDocument,
  source: WebPlusSourceConfig,
): DiscoveryPage {
  const $ = cheerio.load(raw.body);
  const listItemSelector = source.adapter.selectors?.listItem;
  const selector =
    source.adapter.selectors?.listLink ??
    (listItemSelector
      ? `${listItemSelector} a[href]`
      : DEFAULT_LIST_LINK_SELECTOR);
  const items = new Map<string, DiscoveredItem>();

  $(selector).each((_, element) => {
    const href = $(element).attr("href");
    if (!href || href.startsWith("javascript:")) return;

    const absolute = new URL(href, raw.url);
    if (!looksLikeArticleUrl(absolute)) return;

    const title = normalizeText($(element).attr("title") ?? $(element).text());
    if (!title) return;

    const url = absolute.toString();
    if (items.has(url)) return;

    const publishedAtRaw = publishedDateNearAnchor(
      $,
      element,
      listItemSelector,
    );
    items.set(url, {
      sourceId: source.id,
      url,
      title,
      ...(publishedAtRaw ? { publishedAtRaw } : {}),
    });
  });

  // Some WebPlus themes omit the common list classes. Fall back to all links,
  // but retain the page.htm heuristic so navigation links are not emitted.
  if (items.size === 0) {
    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      if (!href || href.startsWith("javascript:")) return;
      const absolute = new URL(href, raw.url);
      if (!looksLikeArticleUrl(absolute)) return;
      const title = normalizeText(
        $(element).attr("title") ?? $(element).text(),
      );
      if (!title) return;
      const url = absolute.toString();
      if (items.has(url)) return;
      const publishedAtRaw = publishedDateNearAnchor(
        $,
        element,
        listItemSelector,
      );
      items.set(url, {
        sourceId: source.id,
        url,
        title,
        ...(publishedAtRaw ? { publishedAtRaw } : {}),
      });
    });
  }

  const nextHref = $(".wp_paging a.next[href], .page_nav a.next[href]")
    .first()
    .attr("href");
  const lastHref = $(".wp_paging a.last[href], .page_nav a.last[href]")
    .first()
    .attr("href");
  const currentPage = Number.parseInt(
    normalizeText($(".wp_paging .curr_page").first().text()),
    10,
  );
  const totalPages = Number.parseInt(
    normalizeText($(".wp_paging .all_pages").first().text()),
    10,
  );

  const nextPageUrl =
    nextHref && !nextHref.startsWith("javascript:")
      ? sameOriginUrl(raw.url, nextHref)
      : undefined;
  const lastPageUrl =
    lastHref && !lastHref.startsWith("javascript:")
      ? sameOriginUrl(raw.url, lastHref)
      : undefined;

  return {
    items: [...items.values()],
    ...(nextPageUrl ? { nextPageUrl } : {}),
    ...(lastPageUrl ? { lastPageUrl } : {}),
    ...(Number.isFinite(currentPage) ? { currentPage } : {}),
    ...(Number.isFinite(totalPages) ? { totalPages } : {}),
  };
}

export function discoverWebPlusItems(
  raw: RawDocument,
  source: WebPlusSourceConfig,
): DiscoveredItem[] {
  return discoverWebPlusPage(raw, source).items;
}

function collectAttachments(
  $: cheerio.CheerioAPI,
  baseUrl: string,
): Attachment[] {
  const attachments = new Map<string, Attachment>();

  $('a[href*="/_upload/article/files/"]').each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = absolutize(baseUrl, href);
    const title =
      normalizeText($(element).attr("title") ?? $(element).text()) || url;
    attachments.set(url, { url, title });
  });

  $('[pdfsrc*="/_upload/article/files/"]').each((_, element) => {
    const pdfsrc = $(element).attr("pdfsrc");
    if (!pdfsrc) return;
    const url = absolutize(baseUrl, pdfsrc);
    const title =
      normalizeText($(element).attr("id") ?? $(element).attr("title") ?? "") ||
      url;
    attachments.set(url, { url, title, mediaType: "application/pdf" });
  });

  return [...attachments.values()];
}

export function parseWebPlusNotice(
  raw: RawDocument,
  source: WebPlusSourceConfig,
  discovered?: DiscoveredItem,
): ParsedNotice {
  const $ = cheerio.load(raw.body);
  const titleSelector =
    source.adapter.selectors?.title ?? DEFAULT_TITLE_SELECTOR;
  const publishedSelector =
    source.adapter.selectors?.publishedAt ?? DEFAULT_PUBLISHED_AT_SELECTOR;
  const contentSelector =
    source.adapter.selectors?.content ?? DEFAULT_CONTENT_SELECTOR;

  const title =
    normalizeText($(titleSelector).first().text()) ||
    discovered?.title ||
    "Untitled notice";
  const publishedText = normalizeText($(publishedSelector).first().text());
  const publishedAtRaw =
    publishedText.match(DATE_RE)?.[0] ?? discovered?.publishedAtRaw;

  const content = $(contentSelector).first();
  const bodyHtml = content.length ? (content.html() ?? "") : "";
  const bodyText = normalizeText(content.text());
  const sourceItemId = createHash("sha256")
    .update(raw.url)
    .digest("hex")
    .slice(0, 24);

  return {
    sourceId: source.id,
    sourceItemId,
    url: raw.url,
    title,
    ...(publishedAtRaw ? { publishedAtRaw } : {}),
    bodyText,
    bodyHtml,
    attachments: collectAttachments($, raw.url),
    provenance: {
      fetchedAt: raw.fetchedAt,
      contentSha256: raw.sha256,
    },
  };
}
