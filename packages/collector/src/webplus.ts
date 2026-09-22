import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type {
  Attachment,
  DiscoveredItem,
  ParsedNotice,
  RawDocument,
  WebPlusSourceConfig,
} from '@nju-info/core';

const DATE_RE = /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/;
const DEFAULT_LIST_LINK_SELECTOR = [
  '.news_list a[href]',
  '.wp_article_list a[href]',
  '.listcon a[href]',
].join(', ');
const DEFAULT_TITLE_SELECTOR = '.arti_title, .Article_Title, .news_title, h1';
const DEFAULT_PUBLISHED_AT_SELECTOR =
  '.arti_update, .Article_PublishDate, .article-date, .news_meta';
const DEFAULT_CONTENT_SELECTOR =
  '.wp_articlecontent, #vsb_content, .article_content, .arti_content';

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function absolutize(baseUrl: string, href: string): string {
  return new URL(href, baseUrl).toString();
}

function looksLikeArticleUrl(url: URL): boolean {
  return /\/page(?:m)?\.htm$/i.test(url.pathname);
}

function publishedDateNearAnchor($: cheerio.CheerioAPI, element: AnyNode): string | undefined {
  const container = $(element).closest('li, tr, .news, .list_item, .list-item, .item');
  const text = normalizeText(container.length ? container.text() : $(element).parent().text());
  return text.match(DATE_RE)?.[0];
}

export function discoverWebPlusItems(
  raw: RawDocument,
  source: WebPlusSourceConfig,
): DiscoveredItem[] {
  const $ = cheerio.load(raw.body);
  const selector = source.adapter.selectors?.listLink ?? DEFAULT_LIST_LINK_SELECTOR;
  const items = new Map<string, DiscoveredItem>();

  $(selector).each((_, element) => {
    const href = $(element).attr('href');
    if (!href || href.startsWith('javascript:')) return;

    const absolute = new URL(href, raw.url);
    if (!looksLikeArticleUrl(absolute)) return;

    const title = normalizeText($(element).attr('title') ?? $(element).text());
    if (!title) return;

    const url = absolute.toString();
    if (items.has(url)) return;

    const publishedAtRaw = publishedDateNearAnchor($, element);
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
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href || href.startsWith('javascript:')) return;
      const absolute = new URL(href, raw.url);
      if (!looksLikeArticleUrl(absolute)) return;
      const title = normalizeText($(element).attr('title') ?? $(element).text());
      if (!title) return;
      const url = absolute.toString();
      if (items.has(url)) return;
      const publishedAtRaw = publishedDateNearAnchor($, element);
      items.set(url, {
        sourceId: source.id,
        url,
        title,
        ...(publishedAtRaw ? { publishedAtRaw } : {}),
      });
    });
  }

  return [...items.values()];
}

function collectAttachments($: cheerio.CheerioAPI, baseUrl: string): Attachment[] {
  const attachments = new Map<string, Attachment>();

  $('a[href*="/_upload/article/files/"]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const url = absolutize(baseUrl, href);
    const title = normalizeText($(element).attr('title') ?? $(element).text()) || url;
    attachments.set(url, { url, title });
  });

  $('[pdfsrc*="/_upload/article/files/"]').each((_, element) => {
    const pdfsrc = $(element).attr('pdfsrc');
    if (!pdfsrc) return;
    const url = absolutize(baseUrl, pdfsrc);
    const title =
      normalizeText($(element).attr('id') ?? $(element).attr('title') ?? '') || url;
    attachments.set(url, { url, title, mediaType: 'application/pdf' });
  });

  return [...attachments.values()];
}

export function parseWebPlusNotice(
  raw: RawDocument,
  source: WebPlusSourceConfig,
  discovered?: DiscoveredItem,
): ParsedNotice {
  const $ = cheerio.load(raw.body);
  const titleSelector = source.adapter.selectors?.title ?? DEFAULT_TITLE_SELECTOR;
  const publishedSelector =
    source.adapter.selectors?.publishedAt ?? DEFAULT_PUBLISHED_AT_SELECTOR;
  const contentSelector = source.adapter.selectors?.content ?? DEFAULT_CONTENT_SELECTOR;

  const title =
    normalizeText($(titleSelector).first().text()) || discovered?.title || 'Untitled notice';
  const publishedText = normalizeText($(publishedSelector).first().text());
  const publishedAtRaw = publishedText.match(DATE_RE)?.[0] ?? discovered?.publishedAtRaw;

  const content = $(contentSelector).first();
  const bodyHtml = content.length ? content.html() ?? '' : '';
  const bodyText = normalizeText(content.text());
  const sourceItemId = createHash('sha256').update(raw.url).digest('hex').slice(0, 24);

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

