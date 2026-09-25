import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { normalizePublicationDate } from "@nju-info/core";
import type {
  Attachment,
  DiscoveredItem,
  DiscoveryPage,
  ParsedNotice,
  RawDocument,
  WebPlusSourceConfig,
} from "@nju-info/core";

export class RestrictedDetailError extends Error {
  constructor(readonly restrictionClass: "campus-network" | "authentication") {
    super(`restricted WebPlus detail: ${restrictionClass}`);
    this.name = "RestrictedDetailError";
  }
}

function isCampusNetworkRestriction($: cheerio.CheerioAPI): boolean {
  const hasPromptTitle =
    normalizeText($("title").first().text()) === "提示信息" ||
    normalizeText($("h1, h2").first().text()) === "提示信息";
  const pageText = normalizeText($.root().text());
  return (
    hasPromptTitle &&
    (/IP\s*非校内地址/i.test(pageText) ||
      pageText.includes("仅允许校内地址访问"))
  );
}

function isUnifiedIdentityRedirect(raw: RawDocument, discovered?: DiscoveredItem): boolean {
  if (!discovered || raw.url === discovered.url) return false;
  try {
    const finalUrl = new URL(raw.url);
    return (
      finalUrl.hostname.toLowerCase() === "authserver.nju.edu.cn" &&
      /^\/authserver\/(?:login|oauth2\/authorize)(?:\/|$)/i.test(finalUrl.pathname)
    );
  } catch {
    return false;
  }
}

const DATE_RE =
  /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?|\d{1,2}[-/.]\d{1,2}\s+20\d{2}/;
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
  const publishedText = normalizeText(
    scope.find(DEFAULT_PUBLISHED_AT_SELECTOR).first().text(),
  );
  return (
    publishedText.match(DATE_RE)?.[0] ??
    textWithElementBoundaries($, scope).match(DATE_RE)?.[0]
  );
}

function acquisitionKind(url: URL): DiscoveredItem["acquisitionKind"] {
  if (looksLikeArticleUrl(url)) return "webplus-detail";
  if (
    url.hostname === "mp.weixin.qq.com" &&
    (url.pathname === "/s" || url.pathname.startsWith("/s/"))
  ) {
    return "public-wechat";
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
      );
      items.set(url, {
        sourceId: source.id,
        url,
        acquisitionKind: acquisitionKind(absolute),
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
  if (isUnifiedIdentityRedirect(raw, discovered)) {
    throw new RestrictedDetailError("authentication");
  }
  if (isCampusNetworkRestriction($)) {
    throw new RestrictedDetailError("campus-network");
  }
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
  const url = discovered?.url ?? raw.url;
  const sourceItemId = createHash("sha256")
    .update(url)
    .digest("hex")
    .slice(0, 24);

  return {
    sourceId: source.id,
    sourceItemId,
    url,
    title,
    ...(publishedAtRaw ? { publishedAtRaw } : {}),
    publishedOn: normalizePublicationDate(publishedAtRaw),
    bodyText,
    bodyHtml,
    attachments: collectAttachments($, content, raw.url),
    provenance: {
      fetchedAt: raw.fetchedAt,
      contentSha256: raw.sha256,
    },
  };
}
