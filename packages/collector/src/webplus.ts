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

const DATE_RE =
  /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?|\d{1,2}[-/.]\d{1,2}\s+20\d{2}/;
const YEAR_FIRST_DATE_PARTS_RE =
  /^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?$/;
const MONTH_FIRST_DATE_PARTS_RE = /^(\d{1,2})[-/.](\d{1,2})\s+(20\d{2})$/;
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

function textWithElementBoundaries(
  $: cheerio.CheerioAPI,
  selection: cheerio.Cheerio<AnyNode>,
): string {
  const text = selection
    .find("*")
    .addBack()
    .contents()
    .filter((_, node) => node.type === "text")
    .map((_, node) => $(node).text())
    .get()
    .join(" ");
  return normalizeText(text);
}

function publicationDateTimestamp(value: string): number | undefined {
  const yearFirst = value.match(YEAR_FIRST_DATE_PARTS_RE);
  const monthFirst = value.match(MONTH_FIRST_DATE_PARTS_RE);
  if (!yearFirst && !monthFirst) return undefined;

  const year = Number(yearFirst?.[1] ?? monthFirst?.[3]);
  const month = Number(yearFirst?.[2] ?? monthFirst?.[1]);
  const day = Number(yearFirst?.[3] ?? monthFirst?.[2]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return timestamp;
}

function resolveHttpUrl(baseUrl: string, href: string): URL | undefined {
  try {
    const target = new URL(href, baseUrl);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target
      : undefined;
  } catch {
    return undefined;
  }
}

function sameOriginUrl(baseUrl: string, href: string): string | undefined {
  const base = resolveHttpUrl(baseUrl, baseUrl);
  const target = resolveHttpUrl(baseUrl, href);
  return base && target && target.origin === base.origin
    ? target.toString()
    : undefined;
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
  const scope = container.length ? container : $(element).parent();
  const text = textWithElementBoundaries($, scope);
  return text.match(DATE_RE)?.[0];
}

/** Discovers one list page without changing its source/DOM item order. */
export function discoverWebPlusPage(
  raw: RawDocument,
  source: WebPlusSourceConfig,
): DiscoveryPage {
  const $ = cheerio.load(raw.body);
  const listItemSelector = source.adapter.selectors?.listItem;
  const explicitListLink = source.adapter.selectors?.listLink;
  const items = new Map<string, DiscoveredItem>();

  const scanLinks = (selector: string): void => {
    $(selector).each((_, element) => {
      const href = $(element).attr("href");
      if (!href) return;

      const absolute = resolveHttpUrl(raw.url, href);
      if (!absolute || !looksLikeArticleUrl(absolute)) return;

      const titleFromAttribute = normalizeText($(element).attr("title") ?? "");
      const title = titleFromAttribute || normalizeText($(element).text());
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
  };

  if (explicitListLink) {
    scanLinks(explicitListLink);
  } else if (listItemSelector) {
    scanLinks(`${listItemSelector} a[href]`);
  } else {
    scanLinks(DEFAULT_LIST_LINK_SELECTOR);
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
  const perPage = Number.parseInt(
    normalizeText($(".wp_paging .per_count").first().text()),
    10,
  );

  const likelyPartialPage =
    Number.isFinite(perPage) &&
    Number.isFinite(currentPage) &&
    Number.isFinite(totalPages) &&
    currentPage < totalPages &&
    items.size < perPage;

  if (
    !explicitListLink &&
    !listItemSelector &&
    (items.size === 0 || likelyPartialPage)
  ) {
    scanLinks("a[href]");
  }

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

/** Returns list items in the same source/DOM order as the page. */
export function discoverWebPlusItems(
  raw: RawDocument,
  source: WebPlusSourceConfig,
): DiscoveredItem[] {
  return discoverWebPlusPage(raw, source).items;
}

/**
 * Orders parseable dated items newest-first. Equal dates and items without a
 * parseable date retain source order; undated items follow dated items.
 */
export function orderDiscoveredItemsByPublicationRecency(
  items: readonly DiscoveredItem[],
): DiscoveredItem[] {
  return items
    .map((item, sourceIndex) => ({
      item,
      sourceIndex,
      timestamp:
        item.publishedAtRaw === undefined
          ? undefined
          : publicationDateTimestamp(item.publishedAtRaw),
    }))
    .sort((left, right) => {
      if (left.timestamp === undefined && right.timestamp === undefined) {
        return left.sourceIndex - right.sourceIndex;
      }
      if (left.timestamp === undefined) return 1;
      if (right.timestamp === undefined) return -1;
      return (
        right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
      );
    })
    .map(({ item }) => item);
}

function collectAttachments(
  $: cheerio.CheerioAPI,
  content: cheerio.Cheerio<AnyNode>,
  baseUrl: string,
): Attachment[] {
  const attachments = new Map<string, Attachment>();

  content.find('a[href*="/_upload/article/files/"]').each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const target = resolveHttpUrl(baseUrl, href);
    if (!target) return;

    const url = target.toString();
    const titleFromAttribute = normalizeText($(element).attr("title") ?? "");
    const title = titleFromAttribute || normalizeText($(element).text()) || url;
    attachments.set(url, { url, title });
  });

  content.find('[pdfsrc*="/_upload/article/files/"]').each((_, element) => {
    const pdfsrc = $(element).attr("pdfsrc");
    if (!pdfsrc) return;
    const target = resolveHttpUrl(baseUrl, pdfsrc);
    if (!target) return;

    const url = target.toString();
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
    normalizeText($(titleSelector).first().text()) || discovered?.title;
  if (!title) {
    throw new Error(`missing notice title for ${source.id}: ${raw.url}`);
  }

  const publishedText = normalizeText($(publishedSelector).first().text());
  const publishedAtRaw =
    publishedText.match(DATE_RE)?.[0] ?? discovered?.publishedAtRaw;

  const content = $(contentSelector).first();
  if (!content.length) {
    throw new Error(`missing notice content for ${source.id}: ${raw.url}`);
  }

  const bodyHtml = content.html() ?? "";
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
    attachments: collectAttachments($, content, raw.url),
    provenance: {
      fetchedAt: raw.fetchedAt,
      contentSha256: raw.sha256,
    },
  };
}
