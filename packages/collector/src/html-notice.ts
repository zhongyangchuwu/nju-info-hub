import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { normalizePublicationDate, sourceItemIdFromUrl } from "@nju-info/core";
import type {
  Attachment,
  DiscoveredItem,
  ParsedNotice,
  RawDocument,
} from "@nju-info/core";

export const DATE_RE =
  /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?|\d{1,2}[-/.]\d{1,2}\s+20\d{2}/;

export class RestrictedDetailError extends Error {
  constructor(readonly restrictionClass: "campus-network" | "authentication") {
    super(`restricted public detail: ${restrictionClass}`);
    this.name = "RestrictedDetailError";
  }
}

export function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function textWithElementBoundaries(
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

export function resolveHttpUrl(baseUrl: string, href: string): URL | undefined {
  try {
    const target = new URL(href, baseUrl);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target
      : undefined;
  } catch {
    return undefined;
  }
}

export function sameOriginUrl(baseUrl: string, href: string): string | undefined {
  const base = resolveHttpUrl(baseUrl, baseUrl);
  const target = resolveHttpUrl(baseUrl, href);
  return base && target && target.origin === base.origin
    ? target.toString()
    : undefined;
}

export function assertUnrestrictedDetail(
  $: cheerio.CheerioAPI,
  raw: RawDocument,
  discovered?: DiscoveredItem,
): void {
  if (discovered && raw.url !== discovered.url) {
    try {
      const finalUrl = new URL(raw.url);
      if (
        finalUrl.hostname.toLowerCase() === "authserver.nju.edu.cn" &&
        /^\/authserver\/(?:login|oauth2\/authorize)(?:\/|$)/i.test(finalUrl.pathname)
      ) {
        throw new RestrictedDetailError("authentication");
      }
    } catch (error) {
      if (error instanceof RestrictedDetailError) throw error;
    }
  }

  const hasPromptTitle =
    normalizeText($("title").first().text()) === "提示信息" ||
    normalizeText($("h1, h2").first().text()) === "提示信息";
  const pageText = normalizeText($.root().text());
  if (
    hasPromptTitle &&
    (/IP\s*非校内地址/i.test(pageText) || pageText.includes("仅允许校内地址访问"))
  ) {
    throw new RestrictedDetailError("campus-network");
  }
}

interface HtmlNoticeInput {
  $: cheerio.CheerioAPI;
  raw: RawDocument;
  sourceId: string;
  discovered?: DiscoveredItem;
  title: string;
  publishedAtRaw?: string;
  content: cheerio.Cheerio<AnyNode>;
  attachmentLinkSelector?: string;
  embeddedPdfSelector?: string;
}

export function parseHtmlNotice(input: HtmlNoticeInput): ParsedNotice {
  const {
    $,
    raw,
    sourceId,
    discovered,
    publishedAtRaw,
    content,
    attachmentLinkSelector,
    embeddedPdfSelector,
  } = input;
  const title = normalizeText(input.title) || discovered?.title;
  if (!title) throw new Error(`missing notice title for ${sourceId}: ${raw.url}`);
  if (!content.length) {
    throw new Error(`missing notice content for ${sourceId}: ${raw.url}`);
  }

  for (const attribute of [
    "href",
    "src",
    "poster",
    "original-src",
    "pdfsrc",
    "swsrc",
  ] as const) {
    content.find(`[${attribute}]`).each((_, element) => {
      const value = $(element).attr(attribute);
      if (!value || value.startsWith("#")) return;
      const absolute = resolveHttpUrl(raw.url, value);
      if (absolute) $(element).attr(attribute, absolute.toString());
    });
  }

  const attachments = new Map<string, Attachment>();
  if (attachmentLinkSelector) {
    content.find(attachmentLinkSelector).each((_, element) => {
      const href = $(element).attr("href");
      if (!href) return;
      const target = resolveHttpUrl(raw.url, href);
      if (!target) return;
      const url = target.toString();
      const titleFromAttribute = normalizeText($(element).attr("title") ?? "");
      const attachmentTitle = titleFromAttribute || normalizeText($(element).text()) || url;
      attachments.set(url, { url, title: attachmentTitle });
    });
  }
  if (embeddedPdfSelector) {
    content.find(embeddedPdfSelector).each((_, element) => {
      const pdfsrc = $(element).attr("pdfsrc");
      if (!pdfsrc) return;
      const target = resolveHttpUrl(raw.url, pdfsrc);
      if (!target) return;
      const url = target.toString();
      const attachmentTitle =
        normalizeText($(element).attr("id") ?? $(element).attr("title") ?? "") ||
        url;
      attachments.set(url, {
        url,
        title: attachmentTitle,
        mediaType: "application/pdf",
      });
    });
  }

  const url = discovered?.url ?? raw.url;
  return {
    sourceId,
    sourceItemId: discovered?.sourceItemId ?? sourceItemIdFromUrl(url),
    url,
    title,
    ...(publishedAtRaw ? { publishedAtRaw } : {}),
    publishedOn: normalizePublicationDate(publishedAtRaw),
    bodyText: normalizeText(content.text()),
    bodyHtml: content.html() ?? "",
    attachments: [...attachments.values()],
    provenance: {
      fetchedAt: raw.fetchedAt,
      contentSha256: raw.sha256,
    },
  };
}
