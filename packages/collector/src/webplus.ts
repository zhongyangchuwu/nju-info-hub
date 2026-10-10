import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { normalizePublicationDate, sourceItemIdFromUrl } from "@nju-info/core";
import type {
  DiscoveredItem,
  DiscoveryPage,
  ParsedNotice,
  RawDocument,
  WebPlusSourceConfig,
} from "@nju-info/core";
import {
  DATE_RE,
  assertUnrestrictedDetail,
  normalizeText,
  parseHtmlNotice,
  resolveHttpUrl,
  sameOriginUrl,
  textWithElementBoundaries,
} from "./html-notice.js";

export { RestrictedDetailError } from "./html-notice.js";

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

function looksLikeArticleUrl(url: URL): boolean {
  return /\/page(?:m)?\.htm$/i.test(url.pathname);
}

function publishedDateNearAnchor(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  listItemSelector?: string,
  publishedAtSelector?: string,
): string | undefined {
  const container = $(element).closest(
    listItemSelector ?? "li, tr, .news, .list_item, .list-item, .item",
  );
  const scope = container.length ? container : $(element).parent();
  const publishedText = normalizeText(
    scope.find(publishedAtSelector ?? DEFAULT_PUBLISHED_AT_SELECTOR).first().text(),
  );
  const publishedDate = publishedText.match(DATE_RE)?.[0];
  if (publishedAtSelector !== undefined) return publishedDate;
  return publishedDate ?? textWithElementBoundaries($, scope).match(DATE_RE)?.[0];
}

function acquisitionKind(
  url: URL,
  sourceUrl: string,
  explicitlyScoped: boolean,
): DiscoveredItem["acquisitionKind"] {
  if (looksLikeArticleUrl(url)) return "webplus-detail";
  if (
    url.hostname === "mp.weixin.qq.com" &&
    (url.pathname === "/s" || url.pathname.startsWith("/s/"))
  ) {
    return "public-wechat";
  }
  if (explicitlyScoped) {
    const source = resolveHttpUrl(sourceUrl, sourceUrl);
    if (source && url.origin === source.origin) return "webplus-detail";
  }
  return "external-public";
}

/** Discovers one list page without changing its source/DOM item order. */
export function discoverWebPlusPage(
  raw: RawDocument,
  source: WebPlusSourceConfig,
): DiscoveryPage {
  const $ = cheerio.load(raw.body);
  const listItemSelector = source.adapter.selectors?.listItem;
  const explicitListLink = source.adapter.selectors?.listLink;
  const listPublishedAtSelector = source.adapter.selectors?.listPublishedAt;
  const items = new Map<string, DiscoveredItem>();

  const scanLinks = (selector: string): void => {
    $(selector).each((_, element) => {
      const href = $(element).attr("href");
      if (!href) return;

      const absolute = resolveHttpUrl(raw.url, href);
      if (!absolute) return;
      if (
        !explicitListLink &&
        !listItemSelector &&
        !looksLikeArticleUrl(absolute)
      ) {
        return;
      }

      const titleFromAttribute = normalizeText($(element).attr("title") ?? "");
      const title = titleFromAttribute || normalizeText($(element).text());
      if (!title) return;

      const url = absolute.toString();
      if (items.has(url)) return;

      const publishedAtRaw = publishedDateNearAnchor(
        $,
        element,
        listItemSelector,
        listPublishedAtSelector,
      );
      items.set(url, {
        sourceId: source.id,
        sourceItemId: sourceItemIdFromUrl(url),
        url,
        acquisitionKind: acquisitionKind(
          absolute,
          source.url,
          Boolean(explicitListLink || listItemSelector),
        ),
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

  const nextHref = $(
    ".wp_paging a.next[href], .page_nav a.next[href], .pb_sys_common .p_next a[href]",
  )
    .first()
    .attr("href");
  const lastHref = $(
    ".wp_paging a.last[href], .page_nav a.last[href], .pb_sys_common .p_last a[href]",
  )
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
      publishedOn: normalizePublicationDate(item.publishedAtRaw),
    }))
    .sort((left, right) => {
      if (left.publishedOn === null && right.publishedOn === null) {
        return left.sourceIndex - right.sourceIndex;
      }
      if (left.publishedOn === null) return 1;
      if (right.publishedOn === null) return -1;
      return (
        right.publishedOn.localeCompare(left.publishedOn) ||
        left.sourceIndex - right.sourceIndex
      );
    })
    .map(({ item }) => item);
}

export function parseWebPlusNotice(
  raw: RawDocument,
  source: WebPlusSourceConfig,
  discovered?: DiscoveredItem,
): ParsedNotice {
  const $ = cheerio.load(raw.body);
  assertUnrestrictedDetail($, raw, discovered);
  const titleSelector =
    source.adapter.selectors?.title ?? DEFAULT_TITLE_SELECTOR;
  const publishedSelector =
    source.adapter.selectors?.publishedAt ?? DEFAULT_PUBLISHED_AT_SELECTOR;
  const contentSelector =
    source.adapter.selectors?.content ?? DEFAULT_CONTENT_SELECTOR;

  const publishedText = normalizeText($(publishedSelector).first().text());
  const publishedAtRaw =
    publishedText.match(DATE_RE)?.[0] ?? discovered?.publishedAtRaw;
  return parseHtmlNotice({
    $,
    raw,
    sourceId: source.id,
    ...(discovered ? { discovered } : {}),
    title: normalizeText($(titleSelector).first().text()),
    ...(publishedAtRaw ? { publishedAtRaw } : {}),
    content: $(contentSelector).first(),
    attachmentLinkSelector: 'a[href*="/_upload/article/files/"]',
    embeddedPdfSelector: '[pdfsrc*="/_upload/article/files/"]',
  });
}
